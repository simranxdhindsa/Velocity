package update_reminder

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// ── fakes ────────────────────────────────────────────────────────────────────

// fakeSlack is a tiny Slack Web API: conversations.open gives a D-channel,
// chat.postMessage returns increasing ts values, update/delete need a known ts.
type fakeSlack struct {
	mu    sync.Mutex
	next  int
	msgs  map[string]string // channel|ts -> text
	posts []string          // channel|ts in post order
}

func newFakeSlack(t *testing.T) *fakeSlack {
	f := &fakeSlack{msgs: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	old := slacksvc.BaseURL
	slacksvc.BaseURL = srv.URL
	t.Cleanup(func() { slacksvc.BaseURL = old; srv.Close() })
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
	case "/conversations.open":
		out["channel"] = map[string]string{"id": "D" + strings.ToUpper(str("users"))}
	case "/chat.postMessage":
		f.next++
		ts := fmt.Sprintf("1700000000.%06d", f.next)
		text := str("text")
		if text == "" {
			text = "(blocks)"
		}
		f.msgs[str("channel")+"|"+ts] = text
		f.posts = append(f.posts, str("channel")+"|"+ts)
		out["ts"] = ts
	case "/chat.update", "/chat.delete":
		key := str("channel") + "|" + str("ts")
		if _, ok := f.msgs[key]; !ok {
			out = map[string]interface{}{"ok": false, "error": "message_not_found"}
		} else if r.URL.Path == "/chat.update" {
			f.msgs[key] = str("text")
		} else {
			delete(f.msgs, key)
		}
	default:
		out = map[string]interface{}{"ok": false, "error": "unknown_method " + r.URL.Path}
	}
	_ = json.NewEncoder(w).Encode(out)
}

type fakeIntegrations struct{}

func (fakeIntegrations) GetSlackIntegration(context.Context, string) (*models.SlackIntegration, error) {
	return &models.SlackIntegration{Connected: true, BotToken: "xoxb-test"}, nil
}

type logRow struct{ user, source, channel, text, ts string }

// fakeSentLog stands in for sent_slack_messages.
type fakeSentLog struct {
	mu   sync.Mutex
	rows []logRow
}

func (l *fakeSentLog) Log(_ context.Context, userID, source, channelID, _ string, message, slackTs string) (*database.SentSlackMessage, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rows = append(l.rows, logRow{userID, source, channelID, message, slackTs})
	return &database.SentSlackMessage{}, nil
}
func (l *fakeSentLog) UpdateTextByTs(_ context.Context, userID, channelID, ts, message string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range l.rows {
		if l.rows[i].user == userID && l.rows[i].channel == channelID && l.rows[i].ts == ts {
			l.rows[i].text = message
		}
	}
	return nil
}
func (l *fakeSentLog) DeleteByTs(_ context.Context, userID, channelID, ts string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	kept := l.rows[:0]
	for _, r := range l.rows {
		if !(r.user == userID && r.channel == channelID && r.ts == ts) {
			kept = append(kept, r)
		}
	}
	l.rows = kept
	return nil
}
func (l *fakeSentLog) find(channel, ts string) *logRow {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range l.rows {
		if l.rows[i].channel == channel && l.rows[i].ts == ts {
			return &l.rows[i]
		}
	}
	return nil
}

type fakeQueue struct {
	mu     sync.Mutex
	edited map[string]string // ts -> text
}

func (q *fakeQueue) UpdateSentText(_ context.Context, _, ts, message string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.edited[ts] = message
	return nil
}

func newTestService(t *testing.T) (*Service, *fakeSlack, *fakeSentLog, *fakeQueue) {
	f := newFakeSlack(t)
	log := &fakeSentLog{}
	q := &fakeQueue{edited: map[string]string{}}
	return &Service{integrationRepo: fakeIntegrations{}, sentRepo: log, queueRepo: q}, f, log, q
}

// ── tests ────────────────────────────────────────────────────────────────────

// A DM must be logged, or edit/delete can never find it again (the 26-27 Oct bug:
// "couldn't find a Velocity-sent message in DM with Rohit/suryansh").
func TestQuickSendLogsDMs(t *testing.T) {
	svc, _, log, _ := newTestService(t)
	ts, ch, err := svc.QuickSend(context.Background(), "u1", "", "hey Suryansh", "U0SURYA", "claude_queue")
	if err != nil {
		t.Fatal(err)
	}
	if ch != "DU0SURYA" || !strings.HasPrefix(ts, "1700000000.") {
		t.Fatalf("QuickSend returned (ts=%q, channel=%q); want a message ts and the DM channel", ts, ch)
	}
	if row := log.find("DU0SURYA", ts); row == nil || row.text != "hey Suryansh" || row.source != "claude_queue" {
		t.Fatalf("DM not logged in sent_slack_messages: %+v", log.rows)
	}
}

func TestQuickSendLogsChannelSends(t *testing.T) {
	svc, _, log, _ := newTestService(t)
	ts, ch, err := svc.QuickSend(context.Background(), "u1", "C0VELAPP", "standup at 11", "", "quick_send")
	if err != nil || ch != "C0VELAPP" {
		t.Fatalf("send: ch=%q err=%v", ch, err)
	}
	if log.find("C0VELAPP", ts) == nil {
		t.Fatal("channel send not logged")
	}
}

// Long messages are split; every part must be logged so each one can be edited or
// deleted, not just the first.
func TestQuickSendLogsEverySplitPart(t *testing.T) {
	svc, f, log, _ := newTestService(t)
	var b strings.Builder
	for i := 0; i < 400; i++ {
		fmt.Fprintf(&b, "line %d of the weekly report with some detail\n", i)
	}
	if _, _, err := svc.QuickSend(context.Background(), "u1", "C0VELAPP", b.String(), "", "claude_queue"); err != nil {
		t.Fatal(err)
	}
	if len(f.posts) < 2 {
		t.Fatalf("expected the message to be split, got %d post(s)", len(f.posts))
	}
	for _, key := range f.posts {
		parts := strings.SplitN(key, "|", 2)
		if log.find(parts[0], parts[1]) == nil {
			t.Errorf("split part %s was posted but not logged", key)
		}
	}
}

// Edits must update both logs, so Claude Queue and the bot's memory show the new text.
func TestUpdateSlackMessageSyncsLogs(t *testing.T) {
	svc, f, log, q := newTestService(t)
	ctx := context.Background()
	ts, ch, _ := svc.QuickSend(ctx, "u1", "", "old text", "U0SIMRAN", "claude_queue")
	if err := svc.UpdateSlackMessage(ctx, "u1", ch, ts, "new text"); err != nil {
		t.Fatal(err)
	}
	if f.msgs[ch+"|"+ts] != "new text" {
		t.Errorf("Slack not updated: %q", f.msgs[ch+"|"+ts])
	}
	if row := log.find(ch, ts); row == nil || row.text != "new text" {
		t.Errorf("sent log not updated: %+v", row)
	}
	if q.edited[ts] != "new text" {
		t.Errorf("queue row not updated: %q", q.edited[ts])
	}
}

func TestDeleteSlackMessageDropsLogRow(t *testing.T) {
	svc, f, log, _ := newTestService(t)
	ctx := context.Background()
	ts, ch, _ := svc.QuickSend(ctx, "u1", "C0VELAPP", "to be deleted", "", "claude_queue")
	if err := svc.DeleteSlackMessage(ctx, "u1", ch, ts); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.msgs[ch+"|"+ts]; ok {
		t.Error("message still in Slack")
	}
	if log.find(ch, ts) != nil {
		t.Error("log row kept for a deleted message")
	}
}

// A failed Slack delete must not drop the log row (the message is still there).
func TestDeleteFailureKeepsLog(t *testing.T) {
	svc, _, log, _ := newTestService(t)
	ctx := context.Background()
	ts, ch, _ := svc.QuickSend(ctx, "u1", "C0VELAPP", "keep me", "", "claude_queue")
	if err := svc.DeleteSlackMessage(ctx, "u1", ch, "1699999999.000001"); err == nil {
		t.Fatal("expected an error deleting an unknown ts")
	}
	if log.find(ch, ts) == nil {
		t.Error("log row lost after a failed delete of a different message")
	}
}

// Five users sending, editing and deleting at once: every send is logged, nothing
// crosses between users.
func TestConcurrentUsersSendEditDelete(t *testing.T) {
	svc, f, log, _ := newTestService(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 50)
	for u := 0; u < 5; u++ {
		wg.Add(1)
		go func(u int) {
			defer wg.Done()
			user := fmt.Sprintf("user%d", u)
			for i := 0; i < 5; i++ {
				dm := ""
				ch := "C0VELAPP"
				if i%2 == 0 {
					dm, ch = fmt.Sprintf("U0PEER%d", u), ""
				}
				ts, sent, err := svc.QuickSend(ctx, user, ch, fmt.Sprintf("%s msg %d", user, i), dm, "claude_queue")
				if err != nil {
					errs <- err
					return
				}
				if err := svc.UpdateSlackMessage(ctx, user, sent, ts, fmt.Sprintf("%s msg %d edited", user, i)); err != nil {
					errs <- fmt.Errorf("%s edit: %w", user, err)
				}
				if i == 4 {
					if err := svc.DeleteSlackMessage(ctx, user, sent, ts); err != nil {
						errs <- fmt.Errorf("%s delete: %w", user, err)
					}
				}
			}
		}(u)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if len(f.posts) != 25 {
		t.Fatalf("posts = %d, want 25", len(f.posts))
	}
	if len(log.rows) != 20 { // 25 sent, 5 deleted
		t.Fatalf("log rows = %d, want 20", len(log.rows))
	}
	for _, r := range log.rows {
		if !strings.HasPrefix(r.text, r.user+" ") || !strings.HasSuffix(r.text, "edited") {
			t.Errorf("row mixed up or not edited: %+v", r)
		}
	}
}
