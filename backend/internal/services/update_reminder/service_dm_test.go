package update_reminder

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

// fakeDMLog stands in for the Slack DM chat store.
type fakeDMLog struct {
	mu      sync.Mutex
	relays  []relayCall // BeginRelay: a send opens a relay
	extends []relayCall // ExtendRelay: a successful send confirms the full window
	aborts  []relayCall // AbortRelay: a failed send rolls the relay back
	msgs    []database.SlackDMMessage
}

type relayCall struct {
	channel, person, owner string
	until                  time.Time
}

func (l *fakeDMLog) BeginRelay(_ context.Context, ch, person, owner string, until time.Time) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.relays = append(l.relays, relayCall{ch, person, owner, until})
	return nil
}
func (l *fakeDMLog) ExtendRelay(_ context.Context, ch, owner string, until time.Time) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.extends = append(l.extends, relayCall{channel: ch, owner: owner, until: until})
	return nil
}
func (l *fakeDMLog) AbortRelay(_ context.Context, ch, owner string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.aborts = append(l.aborts, relayCall{channel: ch, owner: owner})
	return nil
}
func (l *fakeDMLog) RecordMessage(_ context.Context, m database.SlackDMMessage) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.msgs = append(l.msgs, m)
	return true, nil
}

// The Harpreet case, send side: a DM sent for a user must open a relay (so the bot stays quiet
// when the person answers) BEFORE it is posted, then confirm the full window once it is out,
// and the message must join the conversation log as sent through Claude.
func TestQuickSendDMOpensRelayAndRecordsMessage(t *testing.T) {
	svc, _, _, _ := newTestService(t)
	dm := &fakeDMLog{}
	svc.dmLog = dm

	ts, ch, err := svc.QuickSend(context.Background(), "user-simran", "", "Harpreet, what is the status of ARD-3033?", "UHARPREET", "claude_queue")
	if err != nil {
		t.Fatal(err)
	}
	if len(dm.relays) != 1 || len(dm.extends) != 1 {
		t.Fatalf("want a placeholder relay before the post and the full window confirmed after: %d begin, %d extend", len(dm.relays), len(dm.extends))
	}
	pending, full := dm.relays[0], dm.extends[0]
	if full.owner != "user-simran" || full.channel != ch {
		t.Errorf("the confirmation must be for the same owner and channel: %+v", full)
	}
	if pending.channel != ch || pending.person != "UHARPREET" || pending.owner != "user-simran" {
		t.Errorf("relay should be for Harpreet's DM, owned by the sender: %+v", pending)
	}
	if d := time.Until(pending.until); d <= 0 || d > 5*time.Minute {
		t.Errorf("the pre-post window is a short placeholder, got %v", d)
	}
	if d := time.Until(full.until); d < 23*time.Hour || d > 25*time.Hour {
		t.Errorf("after a successful send the relay lasts about 24h, got %v", d)
	}
	if len(dm.msgs) != 1 {
		t.Fatalf("the sent DM should be recorded once: %+v", dm.msgs)
	}
	m := dm.msgs[0]
	if m.SlackTS != ts || m.ChannelID != ch || m.Direction != "out" || m.Kind != "claude" || m.SentByUserID != "user-simran" || !strings.Contains(m.Text, "ARD-3033") {
		t.Errorf("recorded message wrong: %+v", m)
	}
}

func TestQuickSendFromTheDashboardIsRecordedAsDashboard(t *testing.T) {
	svc, _, _, _ := newTestService(t)
	dm := &fakeDMLog{}
	svc.dmLog = dm
	if _, _, err := svc.QuickSend(context.Background(), "user-simran", "", "hi", "UHARPREET", "quick_send"); err != nil {
		t.Fatal(err)
	}
	if len(dm.msgs) != 1 || dm.msgs[0].Kind != "dashboard" {
		t.Errorf("a message typed in the dashboard is kind dashboard: %+v", dm.msgs)
	}
}

// Channel posts are not DMs: no relay, nothing in the DM chat log.
func TestQuickSendToAChannelStartsNoRelay(t *testing.T) {
	svc, _, _, _ := newTestService(t)
	dm := &fakeDMLog{}
	svc.dmLog = dm
	if _, _, err := svc.QuickSend(context.Background(), "user-simran", "C0VELAPP", "standup at 11", "", "claude_queue"); err != nil {
		t.Fatal(err)
	}
	if len(dm.relays) != 0 || len(dm.msgs) != 0 {
		t.Errorf("a channel post must not open a relay or enter the DM log: %+v %+v", dm.relays, dm.msgs)
	}
}

// A long DM is several Slack messages: every part is recorded, the full relay window is
// confirmed once (for the first part), not once per part.
func TestQuickSendLongDMRecordsEveryPartAndConfirmsOnce(t *testing.T) {
	svc, f, _, _ := newTestService(t)
	dm := &fakeDMLog{}
	svc.dmLog = dm
	var b strings.Builder
	for i := 0; i < 400; i++ {
		b.WriteString("line of the long status request with some detail\n")
	}
	if _, _, err := svc.QuickSend(context.Background(), "user-simran", "", b.String(), "UHARPREET", "claude_queue"); err != nil {
		t.Fatal(err)
	}
	if len(dm.msgs) != len(f.posts) || len(f.posts) < 2 {
		t.Fatalf("every part must be recorded: %d recorded, %d posted", len(dm.msgs), len(f.posts))
	}
	if len(dm.relays) != 1 || len(dm.extends) != 1 {
		t.Errorf("placeholder + one confirmation, not one per part: %d begin, %d extend", len(dm.relays), len(dm.extends))
	}
}

// A service without the chat store must still send.
func TestQuickSendDMWithoutChatStoreStillSends(t *testing.T) {
	svc, _, log, _ := newTestService(t) // dmLog is nil here
	ts, ch, err := svc.QuickSend(context.Background(), "u1", "", "hello", "UHARPREET", "claude_queue")
	if err != nil || log.find(ch, ts) == nil {
		t.Fatalf("the DM must still be sent and logged: err=%v", err)
	}
}

// If the DM cannot be sent at all, the placeholder relay is rolled back: the person's next
// messages must not be silenced and forwarded for a message that never went out.
func TestQuickSendFailedDMRollsTheRelayBack(t *testing.T) {
	svc, f, _, _ := newTestService(t)
	dm := &fakeDMLog{}
	svc.dmLog = dm
	f.failPost = true

	if _, _, err := svc.QuickSend(context.Background(), "user-simran", "", "status?", "UHARPREET", "claude_queue"); err == nil {
		t.Fatal("the send should report Slack's failure")
	}
	if len(dm.relays) != 1 || len(dm.aborts) != 1 || len(dm.extends) != 0 || len(dm.msgs) != 0 {
		t.Errorf("expected open then abort, nothing confirmed or recorded: relays=%d aborts=%d extends=%d msgs=%d",
			len(dm.relays), len(dm.aborts), len(dm.extends), len(dm.msgs))
	}
	if a := dm.aborts[0]; a.owner != "user-simran" || a.channel != dm.relays[0].channel {
		t.Errorf("abort must target the relay that was opened: %+v", a)
	}
}
