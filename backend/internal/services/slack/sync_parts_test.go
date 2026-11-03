package slack

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// fakeSlack is a tiny Slack Web API: chat.postMessage hands out increasing ts values and
// chat.update / chat.delete need a known ts, like the real thing.
type fakeSlack struct {
	mu          sync.Mutex
	next        int
	msgs        map[string]string // ts -> text
	rateLimitOn int               // the Nth post attempt (1-based) answers "ratelimited" once
	failFrom    int               // post attempts from the Nth on fail hard; 0 = never
	attempts    int
}

func newFakeSlack(t *testing.T) *fakeSlack {
	f := &fakeSlack{msgs: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	oldURL, oldPause := BaseURL, partPause
	BaseURL, partPause = srv.URL, 0
	t.Cleanup(func() { BaseURL, partPause = oldURL, oldPause; srv.Close() })
	return f
}

func (f *fakeSlack) serve(w http.ResponseWriter, r *http.Request) {
	var body map[string]interface{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	str := func(k string) string { s, _ := body[k].(string); return s }
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]interface{}{"ok": true}
	switch r.URL.Path {
	case "/chat.postMessage":
		f.attempts++
		switch {
		case f.rateLimitOn == f.attempts:
			out = map[string]interface{}{"ok": false, "error": "ratelimited"}
		case f.failFrom > 0 && f.attempts >= f.failFrom:
			out = map[string]interface{}{"ok": false, "error": "internal_error"}
		default:
			f.next++
			ts := fmt.Sprintf("1700000000.%06d", f.next)
			f.msgs[ts] = str("text")
			out["ts"] = ts
		}
	case "/chat.update", "/chat.delete":
		ts := str("ts")
		if _, ok := f.msgs[ts]; !ok {
			out = map[string]interface{}{"ok": false, "error": "message_not_found"}
		} else if r.URL.Path == "/chat.update" {
			f.msgs[ts] = str("text")
		} else {
			delete(f.msgs, ts)
		}
	default:
		out = map[string]interface{}{"ok": false, "error": "unknown_method " + r.URL.Path}
	}
	_ = json.NewEncoder(w).Encode(out)
}

// inChannel returns the texts of the messages left in Slack, oldest first.
func (f *fakeSlack) inChannel() []string {
	keys := make([]string, 0, len(f.msgs))
	for ts := range f.msgs {
		keys = append(keys, ts)
	}
	sort.Strings(keys)
	out := make([]string, len(keys))
	for i, ts := range keys {
		out[i] = f.msgs[ts]
	}
	return out
}

// report builds a Day Track-sized report: n bullet lines, each ~80 chars.
func report(n int) string {
	var sb strings.Builder
	sb.WriteString("*Simran*\nMon, Nov 2\n\n*Development:*\n")
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&sb, "• Worked on ticket APY-%d: reviewed the change and verified it on dev\n", i)
	}
	return strings.TrimRight(sb.String(), "\n")
}

func sameTS(a, b []string) bool { return strings.Join(a, ",") == strings.Join(b, ",") }

func TestSplitLongText_EveryPartFitsAfterContinuedPrefix(t *testing.T) {
	// Lines sized so a chunk can end right at the limit; the "(continued)" prefix must
	// not push a part back over it (PostMessage would truncate it).
	for _, lineLen := range []int{37, 80, 99, 123, 500} {
		text := strings.TrimRight(strings.Repeat(strings.Repeat("x", lineLen)+"\n", 400), "\n")
		for i, p := range SplitLongText(text) {
			if len(p) > plainTextLimit {
				t.Errorf("lineLen=%d part %d is %d chars, over the %d limit", lineLen, i, len(p), plainTextLimit)
			}
		}
	}
}

func TestSplitLongText_HardCutKeepsCharactersWhole(t *testing.T) {
	// One enormous line with no newline forces a hard cut; "é" is 2 bytes and "🙂" is 4,
	// so a cut at a fixed byte offset would land inside a character.
	for _, unit := range []string{"é", "🙂"} {
		text := strings.Repeat(unit, 5000)
		var rebuilt strings.Builder
		for i, p := range SplitLongText(text) {
			if !utf8.ValidString(p) {
				t.Errorf("%q part %d is not valid UTF-8", unit, i)
			}
			rebuilt.WriteString(strings.TrimPrefix(p, continuedPrefix))
		}
		if rebuilt.String() != text {
			t.Errorf("%q text changed by splitting", unit)
		}
	}
}

func TestSyncParts_LongReportIsSplitNotTruncated(t *testing.T) {
	f := newFakeSlack(t)
	text := report(260) // ~19k chars, what a 250+ entry day produces

	tss, err := NewClient("xoxb-test").SyncParts(context.Background(), "C1", nil, text, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tss) < 2 {
		t.Fatalf("expected the report to span several messages, got %d", len(tss))
	}
	var all strings.Builder
	for _, ts := range tss {
		msg := f.msgs[ts]
		if strings.Contains(msg, "truncated") {
			t.Errorf("part %s carries a truncation notice", ts)
		}
		if len(msg) > plainTextLimit {
			t.Errorf("part %s is %d chars, over the limit", ts, len(msg))
		}
		all.WriteString(msg)
	}
	for _, want := range []string{"APY-1:", "APY-130:", "APY-260:"} {
		if !strings.Contains(all.String(), want) {
			t.Errorf("entry %s never reached Slack", want)
		}
	}
	if !strings.Contains(f.msgs[tss[1]], "(continued)") {
		t.Error("continuation messages should be tagged (continued)")
	}
}

func TestSyncParts_ResendEditsInPlaceThenGrowsAndShrinks(t *testing.T) {
	f := newFakeSlack(t)
	c := NewClient("xoxb-test")
	ctx := context.Background()

	first, err := c.SyncParts(ctx, "C1", nil, report(260), nil)
	if err != nil {
		t.Fatal(err)
	}

	// Same report again: every part is edited in place, nothing new is posted.
	var newPosts int
	again, err := c.SyncParts(ctx, "C1", first, report(260), func(string, string) { newPosts++ })
	if err != nil {
		t.Fatal(err)
	}
	if !sameTS(again, first) || newPosts != 0 || len(f.msgs) != len(first) {
		t.Fatalf("re-send should reuse the same messages: first=%v again=%v newPosts=%d", first, again, newPosts)
	}

	// More entries: extra parts are posted after the existing ones.
	grown, err := c.SyncParts(ctx, "C1", again, report(600), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(grown) <= len(again) || !sameTS(grown[:len(again)], again) {
		t.Fatalf("growing should keep existing parts and add more: before=%v after=%v", again, grown)
	}

	// Fewer entries: the parts no longer needed are deleted from Slack.
	shrunk, err := c.SyncParts(ctx, "C1", grown, report(5), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(shrunk) != 1 || shrunk[0] != grown[0] || len(f.msgs) != 1 {
		t.Fatalf("shrinking to one message should keep the first and delete the rest: %v, %d left in Slack", shrunk, len(f.msgs))
	}
}

func TestSyncParts_PartDeletedInSlackIsRepostedInOrder(t *testing.T) {
	f := newFakeSlack(t)
	c := NewClient("xoxb-test")
	ctx := context.Background()

	first, err := c.SyncParts(ctx, "C1", nil, report(260), nil)
	if err != nil || len(first) < 4 {
		t.Fatalf("setup: parts=%v err=%v", first, err)
	}
	delete(f.msgs, first[1]) // someone deletes a middle part by hand

	again, err := c.SyncParts(ctx, "C1", first, report(260), nil)
	if err != nil {
		t.Fatalf("a manually deleted part must not wedge every later send: %v", err)
	}
	if len(again) != len(first) || again[0] != first[0] {
		t.Fatalf("part before the gap should stay: first=%v again=%v", first, again)
	}
	// Everything from the missing part on is re-posted, so the parts read in order.
	if !sort.StringsAreSorted(again) {
		t.Errorf("parts must stay in order in the channel: %v", again)
	}
	if len(f.msgs) != len(again) {
		t.Errorf("old later parts must be removed, not duplicated: %d messages for %d parts", len(f.msgs), len(again))
	}
	var rebuilt strings.Builder
	for _, m := range f.inChannel() {
		rebuilt.WriteString(strings.TrimPrefix(m, continuedPrefix))
	}
	if !strings.Contains(rebuilt.String(), "APY-260:") || strings.Count(rebuilt.String(), "APY-130:") != 1 {
		t.Error("report should read complete, each entry once")
	}
}

func TestSyncParts_RateLimitedPostIsRetried(t *testing.T) {
	f := newFakeSlack(t)
	f.rateLimitOn = 3 // Slack pushes back on the third post
	tss, err := NewClient("xoxb-test").SyncParts(context.Background(), "C1", nil, report(260), nil)
	if err != nil {
		t.Fatalf("a rate-limited post should be retried, not fail the whole send: %v", err)
	}
	if len(f.msgs) != len(tss) {
		t.Errorf("retry must not duplicate: %d messages for %d parts", len(f.msgs), len(tss))
	}
}

func TestSyncParts_FailureMidwayThenRetryCompletesWithoutDuplicates(t *testing.T) {
	f := newFakeSlack(t)
	c := NewClient("xoxb-test")
	ctx := context.Background()

	f.failFrom = 3 // Slack errors from the third post on
	partial, err := c.SyncParts(ctx, "C1", nil, report(260), nil)
	if err == nil {
		t.Fatal("expected the send to report the failure")
	}
	if len(partial) != 2 || len(f.msgs) != 2 {
		t.Fatalf("the two posted parts must be returned so they can be tracked: partial=%v inSlack=%d", partial, len(f.msgs))
	}

	f.failFrom = 0 // Slack recovers; the user presses update again with the saved parts
	done, err := c.SyncParts(ctx, "C1", partial, report(260), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !sameTS(done[:2], partial) || len(f.msgs) != len(done) {
		t.Errorf("retry should edit the two posted parts and add the rest, no duplicates: partial=%v done=%v inSlack=%d", partial, done, len(f.msgs))
	}
}

func TestSyncParts_CancelledContextReturnsWhatWasPosted(t *testing.T) {
	newFakeSlack(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	tss, err := NewClient("xoxb-test").SyncParts(ctx, "C1", []string{"1700000000.000099"}, report(260), nil)
	if err == nil {
		t.Fatal("expected an error from a cancelled context")
	}
	if len(tss) == 0 || tss[0] != "1700000000.000099" {
		t.Errorf("already-posted parts must still be reported so the caller keeps tracking them: %v", tss)
	}
}
