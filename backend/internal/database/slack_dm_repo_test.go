package database

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Opt-in: runs against the Postgres in TEST_DATABASE_URL (a throwaway one, never a real
// database). Creates the DM tables with the same migration the app runs.
func newTestDMRepo(t *testing.T) (*SlackDMRepository, context.Context) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres to run")
	}
	ctx := context.Background()
	p, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	old := pool
	pool = p
	t.Cleanup(func() { pool = old; p.Close() })
	RunSlackDMMigrations(ctx)
	// Clean only this package's rows (channel ids without an underscore). The handlers package
	// runs against the same database in parallel and uses ids like D_H, so wiping everything
	// would make both flaky.
	for _, q := range []string{
		`DELETE FROM slack_dm_messages WHERE channel_id NOT LIKE '%\_%'`,
		`DELETE FROM slack_dm_conversations WHERE channel_id NOT LIKE '%\_%'`,
	} {
		if _, err := p.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	return NewSlackDMRepository(), ctx
}

func TestSlackDMRecordMessageIsIdempotentAndDatedFromTheTS(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	m := SlackDMMessage{ChannelID: "D1", SlackTS: "1700000000.000100", Direction: DMDirIn, Kind: DMKindHuman, Text: "status?"}

	first, err := r.RecordMessage(ctx, m)
	if err != nil || !first {
		t.Fatalf("first record: inserted=%v err=%v", first, err)
	}
	again, err := r.RecordMessage(ctx, m)
	if err != nil || again {
		t.Fatalf("a redelivered message must report not-new so the bot answers once: inserted=%v err=%v", again, err)
	}
	var n int
	var at time.Time
	if err := pool.QueryRow(ctx, `SELECT COUNT(*), MIN(created_at) FROM slack_dm_messages WHERE channel_id='D1'`).Scan(&n, &at); err != nil {
		t.Fatal(err)
	}
	if n != 1 || at.Unix() != 1700000000 {
		t.Errorf("want 1 row dated by its Slack ts, got %d rows at %v", n, at)
	}
	c, _ := r.GetConversation(ctx, "D1")
	if c == nil || c.LastMessageAt.Unix() != 1700000000 {
		t.Errorf("conversation should exist and carry the latest message time: %+v", c)
	}
}

func TestSlackDMRelayWindowIsNeverShortenedAndAckResets(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	long := time.Now().Add(24 * time.Hour)
	if err := r.BeginRelay(ctx, "D2", "UHARPREET", "user-simran", long); err != nil {
		t.Fatal(err)
	}
	claimed, _ := r.ClaimAck(ctx, "D2")
	if !claimed {
		t.Fatal("first ack claim should succeed")
	}

	// A second send places a short "pending" window first: it must not cut the 24h one,
	// but it is a new message so the person gets a fresh ack.
	if err := r.BeginRelay(ctx, "D2", "UHARPREET", "user-simran", time.Now().Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	c, _ := r.GetConversation(ctx, "D2")
	if c.RelayUntil == nil || c.RelayUntil.Sub(long).Abs() > time.Second {
		t.Errorf("relay must keep the longer window, got %v want ~%v", c.RelayUntil, long)
	}
	if c.RelayAcked || c.RelayOwnerID != "user-simran" || c.SlackUserID != "UHARPREET" {
		t.Errorf("a new send should reset the ack and keep owner and person: %+v", c)
	}

	// ExtendRelay only moves the end later, never touches the ack, and only for the relay's owner.
	_, _ = r.ClaimAck(ctx, "D2")
	if err := r.ExtendRelay(ctx, "D2", "user-simran", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	c, _ = r.GetConversation(ctx, "D2")
	if c.RelayUntil.Sub(long).Abs() > time.Second {
		t.Errorf("extending to an earlier time must not shorten the relay: %v", c.RelayUntil)
	}
	if !c.RelayAcked {
		t.Error("confirming the window must not reset the ack, or a reply in between gets a second ack")
	}
	later := time.Now().Add(72 * time.Hour)
	_ = r.ExtendRelay(ctx, "D2", "someone-else", later)
	if c, _ = r.GetConversation(ctx, "D2"); c.RelayUntil.After(long.Add(time.Minute)) {
		t.Errorf("a user who does not own the relay must not be able to prolong it: %v", c.RelayUntil)
	}
	_ = r.EnsureConversation(ctx, SlackDMConversation{ChannelID: "D3", SlackUserID: "U3"})
	_ = r.ExtendRelay(ctx, "D3", "user-simran", time.Now().Add(time.Hour))
	if c3, _ := r.GetConversation(ctx, "D3"); c3.RelayUntil != nil {
		t.Errorf("no relay was ever opened for D3, ExtendRelay must not open one: %v", c3.RelayUntil)
	}
}

// A send that fails must not leave the person silenced: only the short placeholder is undone,
// a real 24h relay (from an earlier message that did go out) is left alone.
func TestSlackDMAbortRelayOnlyClearsAPlaceholder(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	_ = r.BeginRelay(ctx, "D7", "U7", "user-simran", time.Now().Add(2*time.Minute))
	if err := r.AbortRelay(ctx, "D7", "user-simran"); err != nil {
		t.Fatal(err)
	}
	if c, _ := r.GetConversation(ctx, "D7"); c.RelayOwnerID != "" || c.RelayUntil != nil {
		t.Errorf("the placeholder should be gone: %+v", c)
	}

	_ = r.BeginRelay(ctx, "D8", "U8", "user-simran", time.Now().Add(24*time.Hour))
	_ = r.BeginRelay(ctx, "D8", "U8", "user-simran", time.Now().Add(2*time.Minute)) // placeholder of a later, failed send
	_ = r.AbortRelay(ctx, "D8", "user-simran")
	if c, _ := r.GetConversation(ctx, "D8"); c.RelayOwnerID != "user-simran" || c.RelayUntil == nil || time.Until(*c.RelayUntil) < 23*time.Hour {
		t.Errorf("an earlier real relay must survive a later failed send: %+v", c)
	}

	_ = r.BeginRelay(ctx, "D9", "U9", "user-simran", time.Now().Add(2*time.Minute))
	_ = r.AbortRelay(ctx, "D9", "someone-else")
	if c, _ := r.GetConversation(ctx, "D9"); c.RelayOwnerID != "user-simran" {
		t.Error("only the owner's own placeholder can be aborted")
	}
}

func TestSlackDMReleaseAckAndCountInbound(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	_ = r.BeginRelay(ctx, "D10", "U10", "user-simran", time.Now().Add(time.Hour))
	if ok, _ := r.ClaimAck(ctx, "D10"); !ok {
		t.Fatal("first claim")
	}
	if ok, _ := r.ClaimAck(ctx, "D10"); ok {
		t.Fatal("second claim must fail")
	}
	if err := r.ReleaseAck(ctx, "D10"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := r.ClaimAck(ctx, "D10"); !ok {
		t.Error("after a release the ack can be claimed again")
	}

	now := time.Now()
	for i, ts := range []time.Time{now.Add(-3 * time.Hour), now.Add(-10 * time.Minute), now.Add(-5 * time.Minute)} {
		_, _ = r.RecordMessage(ctx, SlackDMMessage{ChannelID: "D10", SlackTS: fmt.Sprintf("%d.00000%d", ts.Unix(), i), Direction: DMDirIn, Kind: DMKindHuman, Text: "x"})
	}
	_, _ = r.RecordMessage(ctx, SlackDMMessage{ChannelID: "D10", SlackTS: fmt.Sprintf("%d.000009", now.Unix()), Direction: DMDirOut, Kind: DMKindAck, Text: "ack"})
	if n, err := r.CountInboundSince(ctx, "D10", now.Add(-time.Hour)); err != nil || n != 2 {
		t.Errorf("want the 2 recent inbound messages (not the old one, not the outbound): %d %v", n, err)
	}
}

func TestSlackDMStoredTextIsCapped(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	long := strings.Repeat("é", DMMaxTextRunes+500)
	_, _ = r.RecordMessage(ctx, SlackDMMessage{ChannelID: "D11", SlackTS: "1700000000.000001", Direction: DMDirIn, Kind: DMKindHuman, Text: long})
	var got string
	_ = pool.QueryRow(ctx, `SELECT text FROM slack_dm_messages WHERE channel_id='D11'`).Scan(&got)
	if n := len([]rune(got)); n != DMMaxTextRunes+3 || !strings.HasSuffix(got, "...") {
		t.Errorf("want %d characters plus an ellipsis, cut on characters, got %d", DMMaxTextRunes, n)
	}
}

func TestSlackDMPruneIdleConversationsKeepsOnesWithHistory(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	_ = r.EnsureConversation(ctx, SlackDMConversation{ChannelID: "DOLD", SlackUserID: "U1", SlackUserEmail: "a@b.c"})
	_ = r.EnsureConversation(ctx, SlackDMConversation{ChannelID: "DKEEP", SlackUserID: "U2"})
	_ = r.EnsureConversation(ctx, SlackDMConversation{ChannelID: "DNEW", SlackUserID: "U3"})
	_, _ = r.RecordMessage(ctx, SlackDMMessage{ChannelID: "DKEEP", SlackTS: fmt.Sprintf("%d.000001", time.Now().Unix()), Direction: DMDirIn, Kind: DMKindHuman, Text: "recent"})
	_, _ = pool.Exec(ctx, `UPDATE slack_dm_conversations SET last_message_at = NOW() - INTERVAL '100 days' WHERE channel_id IN ('DOLD','DKEEP')`)

	n, err := r.PruneIdleConversations(ctx, 90)
	if err != nil || n != 1 {
		t.Fatalf("only the idle, message-less, 100-day-old conversation goes: %d %v", n, err)
	}
	if c, _ := r.GetConversation(ctx, "DOLD"); c != nil {
		t.Error("DOLD (name and email, no messages, idle) should be gone")
	}
	for _, ch := range []string{"DKEEP", "DNEW"} {
		if c, _ := r.GetConversation(ctx, ch); c == nil {
			t.Errorf("%s must stay", ch)
		}
	}
}

func TestSlackDMClaimAckHappensExactlyOnceUnderRace(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	if err := r.BeginRelay(ctx, "D4", "U4", "user-simran", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var won atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 25; i++ { // a person sending many messages at once
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, err := r.ClaimAck(ctx, "D4"); err == nil && ok {
				won.Add(1)
			}
		}()
	}
	wg.Wait()
	if won.Load() != 1 {
		t.Errorf("exactly one message may trigger the ack, %d did", won.Load())
	}
}

func TestSlackDMEnsureConversationNeverBlanksAKnownName(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	_ = r.EnsureConversation(ctx, SlackDMConversation{ChannelID: "D5", SlackUserID: "U5", SlackUserName: "Harpreet", SlackUserEmail: "h@apyhub.com"})
	_ = r.EnsureConversation(ctx, SlackDMConversation{ChannelID: "D5", SlackUserID: "U5"}) // a lookup that failed
	c, _ := r.GetConversation(ctx, "D5")
	if c.SlackUserName != "Harpreet" || c.SlackUserEmail != "h@apyhub.com" || c.Mode != DMModeSmart {
		t.Errorf("name/email must survive an empty update, mode default smart: %+v", c)
	}
	if err := r.MarkNeedsAttention(ctx, "D5"); err != nil {
		t.Fatal(err)
	}
	if c, _ = r.GetConversation(ctx, "D5"); !c.NeedsAttention {
		t.Error("needs_attention should be set")
	}
}

func TestSlackDMPruneKeepsRecentAndDropsOld(t *testing.T) {
	r, ctx := newTestDMRepo(t)
	old := fmt.Sprintf("%d.000001", time.Now().Add(-100*24*time.Hour).Unix())
	recent := fmt.Sprintf("%d.000002", time.Now().Add(-10*24*time.Hour).Unix())
	for _, ts := range []string{old, recent} {
		if _, err := r.RecordMessage(ctx, SlackDMMessage{ChannelID: "D6", SlackTS: ts, Direction: DMDirIn, Kind: DMKindHuman, Text: "x"}); err != nil {
			t.Fatal(err)
		}
	}
	// Other tests may share this database, so check this test's own rows, not a global count.
	if n, err := r.PruneMessagesOlderThan(ctx, 90); err != nil || n < 1 {
		t.Fatalf("the 100-day-old message must be pruned, got %d err=%v", n, err)
	}
	var oldLeft, recentLeft int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM slack_dm_messages WHERE channel_id='D6' AND slack_ts=$1`, old).Scan(&oldLeft)
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM slack_dm_messages WHERE channel_id='D6' AND slack_ts=$1`, recent).Scan(&recentLeft)
	if oldLeft != 0 || recentLeft != 1 {
		t.Errorf("the 100-day-old message must go and the 10-day-old one stay: old=%d recent=%d", oldLeft, recentLeft)
	}
}
