package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// ── fakes ────────────────────────────────────────────────────────────────────

// fakeDMStore behaves like database.SlackDMRepository, in memory.
type fakeDMStore struct {
	mu        sync.Mutex
	convs     map[string]*database.SlackDMConversation
	msgs      []database.SlackDMMessage
	failGet   bool
	failWrite bool
}

func newFakeDMStore() *fakeDMStore {
	return &fakeDMStore{convs: map[string]*database.SlackDMConversation{}}
}

func (f *fakeDMStore) conv(ch string) *database.SlackDMConversation {
	if f.convs[ch] == nil {
		f.convs[ch] = &database.SlackDMConversation{ChannelID: ch, Mode: database.DMModeSmart}
	}
	return f.convs[ch]
}
func (f *fakeDMStore) EnsureConversation(_ context.Context, c database.SlackDMConversation) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur := f.conv(c.ChannelID)
	if c.SlackUserName != "" {
		cur.SlackUserName = c.SlackUserName
	}
	if c.SlackUserID != "" {
		cur.SlackUserID = c.SlackUserID
	}
	return nil
}
func (f *fakeDMStore) GetConversation(_ context.Context, ch string) (*database.SlackDMConversation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failGet {
		return nil, errors.New("db down")
	}
	if f.convs[ch] == nil {
		return nil, nil
	}
	cp := *f.convs[ch]
	return &cp, nil
}
func (f *fakeDMStore) RecordMessage(_ context.Context, m database.SlackDMMessage) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWrite {
		return false, errors.New("db down")
	}
	for _, e := range f.msgs {
		if e.ChannelID == m.ChannelID && e.SlackTS == m.SlackTS {
			return false, nil
		}
	}
	f.msgs = append(f.msgs, m)
	f.conv(m.ChannelID)
	return true, nil
}
func (f *fakeDMStore) ReleaseAck(_ context.Context, ch string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.conv(ch).RelayAcked = false
	return nil
}
func (f *fakeDMStore) CountInboundSince(_ context.Context, ch string, _ time.Time) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, m := range f.msgs {
		if m.ChannelID == ch && m.Direction == "in" {
			n++
		}
	}
	return n, nil
}
func (f *fakeDMStore) ClaimAck(_ context.Context, ch string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.conv(ch); !c.RelayAcked {
		c.RelayAcked = true
		return true, nil
	}
	return false, nil
}
func (f *fakeDMStore) MarkNeedsAttention(_ context.Context, ch string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.conv(ch).NeedsAttention = true
	return nil
}
func (f *fakeDMStore) kinds(ch string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.msgs {
		if m.ChannelID == ch {
			out = append(out, m.Direction+":"+m.Kind)
		}
	}
	return out
}

type slackPost struct{ channel, text, threadTS string }

// fakeDMSlack answers the three Slack calls the relay makes.
type fakeDMSlack struct {
	mu          sync.Mutex
	next        int
	posts       []slackPost
	failChannel string // chat.postMessage to this channel answers with an error
}

func newFakeDMSlack(t *testing.T) *fakeDMSlack {
	f := &fakeDMSlack{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		str := func(k string) string { s, _ := body[k].(string); return s }
		f.mu.Lock()
		defer f.mu.Unlock()
		out := map[string]interface{}{"ok": true}
		switch r.URL.Path {
		case "/users.lookupByEmail":
			out["user"] = map[string]string{"id": "U_" + strings.Split(r.URL.Query().Get("email"), "@")[0]}
		case "/conversations.open":
			out["channel"] = map[string]string{"id": "D_" + str("users")}
		case "/chat.postMessage":
			if f.failChannel != "" && str("channel") == f.failChannel {
				out = map[string]interface{}{"ok": false, "error": "channel_not_found"}
				break
			}
			f.next++
			f.posts = append(f.posts, slackPost{str("channel"), str("text"), str("thread_ts")})
			out["ts"] = fmt.Sprintf("%d.%06d", time.Now().Unix(), f.next)
		default:
			out = map[string]interface{}{"ok": false, "error": "unknown " + r.URL.Path}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	old := slacksvc.BaseURL
	slacksvc.BaseURL = srv.URL
	t.Cleanup(func() { slacksvc.BaseURL = old; srv.Close() })
	return f
}

func (f *fakeDMSlack) postsTo(ch string) []slackPost {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []slackPost
	for _, p := range f.posts {
		if p.channel == ch {
			out = append(out, p)
		}
	}
	return out
}

func newTestRelay(store *fakeDMStore, now *time.Time) *dmRelay {
	return &dmRelay{
		store: store,
		owner: func(_ context.Context, id string) (string, string) {
			if id == "user-simran" {
				return "Simran", "simran@apyhub.com"
			}
			return "", "" // an owner whose email we cannot find
		},
		now: func() time.Time { return *now },
	}
}

var harpreet = dmSender{SlackID: "UHARPREET", Name: "Harpreet", Email: "harpreet@apyhub.com", VelocityUserID: "user-harpreet"}

func relayedConv(until time.Time) *database.SlackDMConversation {
	return &database.SlackDMConversation{ChannelID: "D_H", Mode: database.DMModeSmart, RelayOwnerID: "user-simran", RelayUntil: &until}
}

// ── the decision ─────────────────────────────────────────────────────────────

func TestDecideDMReply(t *testing.T) {
	now := time.Now()
	open, past := now.Add(time.Hour), now.Add(-time.Hour)
	mk := func(mode, owner string, until *time.Time, acked bool) *database.SlackDMConversation {
		return &database.SlackDMConversation{Mode: mode, RelayOwnerID: owner, RelayUntil: until, RelayAcked: acked}
	}
	cases := []struct {
		name    string
		c       *database.SlackDMConversation
		sender  string
		want    dmDecision
		wantTel bool
	}{
		{"first ever DM", nil, "u1", dmAnswer, false},
		{"open relay, first reply gets one ack", mk("smart", "user-simran", &open, false), "u1", dmAck, true},
		{"open relay, already acked stays quiet", mk("smart", "user-simran", &open, true), "u1", dmQuiet, true},
		{"relay timed out, the bot answers again", mk("smart", "user-simran", &past, false), "u1", dmAnswer, false},
		{"smart with no relay ever, the bot answers", mk("smart", "", nil, false), "u1", dmAnswer, false},
		{"the relay owner chatting with the bot themselves", mk("smart", "user-simran", &open, false), "user-simran", dmAnswer, false},
		{"auto mode always answers, even in a relay", mk("auto", "user-simran", &open, false), "u1", dmAnswer, false},
		{"muted in a relay stays quiet and tells the owner", mk("muted", "user-simran", &open, false), "u1", dmQuiet, true},
		{"muted without a relay stays quiet, nobody to tell", mk("muted", "", nil, false), "u1", dmQuiet, false},
	}
	for _, tc := range cases {
		got, tel := decideDMReply(tc.c, tc.sender, now)
		if got != tc.want || tel != tc.wantTel {
			t.Errorf("%s: got (%v, notify=%v), want (%v, notify=%v)", tc.name, got, tel, tc.want, tc.wantTel)
		}
	}
}

// ── the Harpreet scenario ────────────────────────────────────────────────────

// Simran asks Harpreet for a status through Claude. Harpreet replies to the bot. The bot must
// not joke back: it says one short line, Harpreet's answer is stored, and Simran is DMed it.
func TestHarpreetReplyIsRelayedNotAnsweredByTheBot(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	r := newTestRelay(store, &now)
	store.convs["D_H"] = relayedConv(now.Add(24 * time.Hour)) // 24h from Simran's last message
	client := slacksvc.NewClient("xoxb-test")
	ctx := context.Background()

	first := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000100.000001", User: "UHARPREET", Text: "ARD-3033 is blocked on the API change, ETA tomorrow"}
	if r.handleInbound(ctx, client, first, harpreet) {
		t.Fatal("the bot must NOT answer a reply to a relayed message")
	}
	toHarpreet := slack.postsTo("D_H")
	if len(toHarpreet) != 1 || toHarpreet[0].text != "Thanks, I have passed this on to Simran." {
		t.Fatalf("Harpreet should get exactly one short ack, got %+v", toHarpreet)
	}
	toSimran := slack.postsTo("D_U_simran")
	if len(toSimran) != 1 || !strings.Contains(toSimran[0].text, "*Harpreet* replied") || !strings.Contains(toSimran[0].text, "> ARD-3033 is blocked on the API change") {
		t.Fatalf("Simran should be told what Harpreet said, got %+v", toSimran)
	}

	// He sends a second message, in a thread this time: no second ack, but Simran hears it too.
	second := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000200.000001", ThreadTS: "1700000100.000001", User: "UHARPREET", Text: "can we talk at 4?"}
	if r.handleInbound(ctx, client, second, harpreet) {
		t.Fatal("still a relayed conversation, the bot must stay quiet")
	}
	if n := len(slack.postsTo("D_H")); n != 1 {
		t.Errorf("the ack is sent once per relay, Harpreet got %d bot messages", n)
	}
	if n := len(slack.postsTo("D_U_simran")); n != 2 {
		t.Errorf("Simran should be told about every reply, got %d notices", n)
	}

	// Everything is in the transcript, and the conversation is flagged for Simran.
	if got := strings.Join(store.kinds("D_H"), ","); got != "in:human,out:ack,in:human" {
		t.Errorf("Harpreet's DM transcript wrong: %s", got)
	}
	if got := strings.Join(store.kinds("D_U_simran"), ","); got != "out:notice,out:notice" {
		t.Errorf("Simran's DM should hold the two notices: %s", got)
	}
	if !store.convs["D_H"].NeedsAttention {
		t.Error("the conversation should be flagged as needing the owner")
	}

	// His replies do NOT keep the relay open: it ends 24h after Simran's last message, so a
	// person chatting on can never keep the bot silenced (or their messages forwarded) forever.
	now = now.Add(23 * time.Hour)
	third := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000300.000001", User: "UHARPREET", Text: "still here"}
	if r.handleInbound(ctx, client, third, harpreet) {
		t.Error("23h in, the relay is still open, the bot must stay quiet")
	}
	now = now.Add(2 * time.Hour)
	later := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000400.000001", User: "UHARPREET", Text: "hey, new question"}
	if !r.handleInbound(ctx, client, later, harpreet) {
		t.Error("25h in, his own messages must not have extended the relay, the bot answers again")
	}
}

func TestAckGoesIntoTheThreadTheyRepliedIn(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	store.convs["D_H"] = relayedConv(now.Add(time.Hour))
	ev := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000200.000001", ThreadTS: "1700000100.000001", User: "UHARPREET", Text: "on it"}
	newTestRelay(store, &now).handleInbound(context.Background(), slacksvc.NewClient("xoxb-test"), ev, harpreet)
	if p := slack.postsTo("D_H"); len(p) != 1 || p[0].threadTS != "1700000100.000001" {
		t.Errorf("the ack belongs in the thread he replied in: %+v", p)
	}
}

// ── edge cases ───────────────────────────────────────────────────────────────

func TestRedeliveredSlackEventIsNotHandledTwice(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	r := newTestRelay(store, &now)
	store.convs["D_H"] = relayedConv(now.Add(time.Hour))
	ev := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000100.000001", User: "UHARPREET", Text: "hi"}
	client, ctx := slacksvc.NewClient("xoxb-test"), context.Background()

	r.handleInbound(ctx, client, ev, harpreet)
	before := len(slack.posts)
	if r.handleInbound(ctx, client, ev, harpreet) {
		t.Error("a redelivered event must not trigger a bot reply")
	}
	if len(slack.posts) != before || len(store.msgs) != 3 { // in, ack, notice: once
		t.Errorf("redelivery must change nothing: posts %d->%d, stored %d", before, len(slack.posts), len(store.msgs))
	}

	// Same for a cold DM: the bot answers the first delivery only.
	cold := slackInnerEvent{Type: "message", Channel: "D_NEW", TS: "1700000500.000001", User: "UNEW", Text: "hello"}
	who := dmSender{SlackID: "UNEW"}
	if !r.handleInbound(ctx, client, cold, who) || r.handleInbound(ctx, client, cold, who) {
		t.Error("a cold DM is answered once, its redelivery is dropped")
	}
}

func TestColdDMIsAnsweredAndRecorded(t *testing.T) {
	newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	ev := slackInnerEvent{Type: "message", Channel: "D_C", TS: "1700000100.000001", User: "UC", Text: "who are you"}
	if !newTestRelay(store, &now).handleInbound(context.Background(), slacksvc.NewClient("xoxb-test"), ev, dmSender{SlackID: "UC"}) {
		t.Error("nobody asked Velocity to message this person, the bot answers as before")
	}
	if got := strings.Join(store.kinds("D_C"), ","); got != "in:human" {
		t.Errorf("the message should still be recorded: %s", got)
	}
}

func TestOwnerChattingWithTheBotIsNotRelayed(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	store.convs["D_S"] = relayedConv(now.Add(time.Hour)) // Simran messaged herself through Claude once
	ev := slackInnerEvent{Type: "message", Channel: "D_S", TS: "1700000100.000001", User: "USIMRAN", Text: "what is on my plate"}
	me := dmSender{SlackID: "USIMRAN", Name: "Simran", VelocityUserID: "user-simran"}
	if !newTestRelay(store, &now).handleInbound(context.Background(), slacksvc.NewClient("xoxb-test"), ev, me) {
		t.Error("the owner talking to the bot is a normal chat, the bot answers")
	}
	if len(slack.posts) != 0 {
		t.Errorf("no ack or notice for the owner's own messages: %+v", slack.posts)
	}
}

func TestStoreOutageFailsOpenSoTheBotStillAnswers(t *testing.T) {
	newFakeDMSlack(t)
	now := time.Now()
	ev := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000100.000001", User: "UHARPREET", Text: "hi"}
	client := slacksvc.NewClient("xoxb-test")

	reads := newFakeDMStore()
	reads.failGet = true
	if !newTestRelay(reads, &now).handleInbound(context.Background(), client, ev, harpreet) {
		t.Error("if the conversation cannot be read the bot answers as it always did")
	}
	writes := newFakeDMStore()
	writes.failWrite = true
	if !newTestRelay(writes, &now).handleInbound(context.Background(), client, ev, harpreet) {
		t.Error("if the message cannot be stored the bot answers as it always did")
	}
}

// If the user who asked cannot be told (no email, Slack lookup or DM fails), the person must not
// be left with silence and the answer lost: the bot answers normally and says nothing false
// about passing it on.
func TestOwnerThatCannotBeAlertedMeansTheBotAnswersNotSilence(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	c := relayedConv(now.Add(time.Hour))
	c.RelayOwnerID = "user-unknown" // the owner() lookup finds no email for this one
	store.convs["D_H"] = c
	ev := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000100.000001", User: "UHARPREET", Text: "status: done"}
	if !newTestRelay(store, &now).handleInbound(context.Background(), slacksvc.NewClient("xoxb-test"), ev, harpreet) {
		t.Error("nobody could be told, so the bot must answer instead of going silent")
	}
	if len(slack.posts) != 0 {
		t.Errorf("no ack that claims it was passed on when it was not: %+v", slack.posts)
	}
	if !store.convs["D_H"].NeedsAttention || len(store.msgs) != 1 {
		t.Error("the message must still be stored and flagged for the dashboard")
	}
}

// A chat the admin muted on purpose stays quiet even if nobody can be alerted.
func TestMutedChatStaysQuietEvenWhenTheOwnerCannotBeAlerted(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	c := relayedConv(now.Add(time.Hour))
	c.RelayOwnerID, c.Mode = "user-unknown", database.DMModeMuted
	store.convs["D_H"] = c
	ev := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000100.000001", User: "UHARPREET", Text: "hello?"}
	if newTestRelay(store, &now).handleInbound(context.Background(), slacksvc.NewClient("xoxb-test"), ev, harpreet) || len(slack.posts) != 0 {
		t.Error("muted means the bot never answers")
	}
}

// A flood of messages must not become a flood of Slack DMs to the owner: alerts stop at the
// hourly cap, every message is still stored, and the bot stays quiet throughout.
func TestAlertsAreCappedSoAFloodDoesNotSpamTheOwner(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	r := newTestRelay(store, &now)
	store.convs["D_H"] = relayedConv(now.Add(24 * time.Hour))
	client, ctx := slacksvc.NewClient("xoxb-test"), context.Background()
	for i := 1; i <= 30; i++ {
		ev := slackInnerEvent{Type: "message", Channel: "D_H", TS: fmt.Sprintf("1700001000.%06d", i), User: "UHARPREET", Text: fmt.Sprintf("msg %d", i)}
		if r.handleInbound(ctx, client, ev, harpreet) {
			t.Fatalf("message %d: the bot must stay quiet during the flood", i)
		}
	}
	if n := len(slack.postsTo("D_U_simran")); n != dmMaxAlertsPerHour {
		t.Errorf("owner should get exactly %d alerts, got %d", dmMaxAlertsPerHour, n)
	}
	if n := len(store.kinds("D_H")); n != 31 { // 30 from the person + the single ack
		t.Errorf("every message must still be stored, got %d entries", n)
	}
}

// If posting the ack fails the right to send it is given back, so the next message tries again.
func TestFailedAckIsRetriedOnTheNextMessage(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	r := newTestRelay(store, &now)
	store.convs["D_H"] = relayedConv(now.Add(time.Hour))
	client, ctx := slacksvc.NewClient("xoxb-test"), context.Background()

	slack.failChannel = "D_H" // Slack refuses posts to Harpreet, Simran's DM still works
	first := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000100.000001", User: "UHARPREET", Text: "one"}
	if r.handleInbound(ctx, client, first, harpreet) {
		t.Fatal("still quiet, the alert to Simran went out")
	}
	if store.convs["D_H"].RelayAcked {
		t.Fatal("the ack failed to post, so the claim must be given back")
	}
	slack.failChannel = ""
	second := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000200.000001", User: "UHARPREET", Text: "two"}
	r.handleInbound(ctx, client, second, harpreet)
	if p := slack.postsTo("D_H"); len(p) != 1 || !strings.Contains(p[0].text, "passed this on") {
		t.Errorf("the ack should go out on the retry: %+v", p)
	}
}

// What a person types must arrive in the owner's DM as plain text: no link, mention or markup
// coming from the trusted Velocity bot.
func TestForwardedMessageCannotBecomeALinkMentionOrFakeLabel(t *testing.T) {
	slack := newFakeDMSlack(t)
	store := newFakeDMStore()
	now := time.Now()
	store.convs["D_H"] = relayedConv(now.Add(time.Hour))
	evil := dmSender{SlackID: "UEVIL", Name: "*Velocity Admin*_`<!here>", VelocityUserID: "user-evil"}
	ev := slackInnerEvent{Type: "message", Channel: "D_H", TS: "1700000100.000001", User: "UEVIL",
		Text: "<https://evil.example|Session expired, click to re-login> <!channel> <@U123> a&b"}
	newTestRelay(store, &now).handleInbound(context.Background(), slacksvc.NewClient("xoxb-test"), ev, evil)

	n := slack.postsTo("D_U_simran")
	if len(n) != 1 {
		t.Fatalf("want one alert, got %+v", n)
	}
	text := n[0].text
	for _, bad := range []string{"<https", "<!channel>", "<@U123>", "<!here>"} {
		if strings.Contains(text, bad) {
			t.Errorf("alert contains live markup %q: %s", bad, text)
		}
	}
	for _, want := range []string{"&lt;https://evil.example|Session expired, click to re-login&gt;", "&lt;!channel&gt;", "a&amp;b", "*Velocity Admin!here* replied"} {
		if !strings.Contains(text, want) {
			t.Errorf("alert should contain the escaped text %q: %s", want, text)
		}
	}
}

func TestCleanLabel(t *testing.T) {
	cases := map[string]string{
		"Harpreet":               "Harpreet",
		"*Velocity Admin*":       "Velocity Admin",
		"a_b~c`d<e>f&g|h":        "abcdefgh",
		"line\nbreak\t":          "linebreak",
		"":                       "Someone",
		"***":                    "Someone",
		strings.Repeat("x", 100): strings.Repeat("x", 60),
	}
	for in, want := range cases {
		if got := cleanLabel(in); got != want {
			t.Errorf("cleanLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestQuoteForSlack(t *testing.T) {
	if got := quoteForSlack("line one\nline two", 100); got != "> line one\n> line two" {
		t.Errorf("multi-line quote wrong: %q", got)
	}
	if got := quoteForSlack("héllo wörld", 5); got != "> héllo..." {
		t.Errorf("must cut on characters, not bytes: %q", got)
	}
}
