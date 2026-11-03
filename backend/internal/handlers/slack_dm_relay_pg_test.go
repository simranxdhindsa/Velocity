package handlers

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// Opt-in (TEST_DATABASE_URL, a throwaway Postgres): the Harpreet flow through the REAL
// SlackDMRepository, so the SQL the relay depends on (relay window, atomic one-time ack,
// needs-attention flag, redelivery) is exercised, not just the fakes.
func TestHarpreetFlowAgainstRealPostgres(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres to run")
	}
	t.Setenv("DATABASE_URL", url)
	if err := database.Connect(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	database.RunSlackDMMigrations(ctx)
	pool := database.GetPool()
	// Clean only this test's rows (ids with an underscore); the database package's tests share
	// this Postgres in parallel with ids like D1.
	for _, q := range []string{
		`DELETE FROM slack_dm_messages WHERE channel_id LIKE '%\_%'`,
		`DELETE FROM slack_dm_conversations WHERE channel_id LIKE '%\_%'`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}

	// Current timestamps: messages older than the retention period are (rightly) pruned, and the
	// database package's prune test runs against this same database in parallel.
	base := time.Now().Unix()
	tsAt := func(offsetSeconds int64) string { return fmt.Sprintf("%d.%06d", base+offsetSeconds, 1) }

	slack := newFakeDMSlack(t)
	repo := database.NewSlackDMRepository()
	now := time.Now()
	r := newTestRelay(newFakeDMStore(), &now)
	r.store = repo
	client := slacksvc.NewClient("xoxb-test")

	// Simran's DM to Harpreet goes out through Claude: this is what QuickSend does.
	if err := repo.BeginRelay(ctx, "D_H", "UHARPREET", "user-simran", now.Add(database.DMRelayWindow)); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RecordMessage(ctx, database.SlackDMMessage{ChannelID: "D_H", SlackTS: tsAt(-50), Direction: "out", Kind: "claude", SentByUserID: "user-simran", Text: "status of ARD-3033?"}); err != nil {
		t.Fatal(err)
	}

	ev := func(ts, text string) slackInnerEvent {
		return slackInnerEvent{Type: "message", Channel: "D_H", TS: ts, User: "UHARPREET", Text: text}
	}
	if r.handleInbound(ctx, client, ev(tsAt(-40), "blocked on the API change"), harpreet) {
		t.Fatal("the bot must stay quiet when Harpreet answers Simran's question")
	}
	if r.handleInbound(ctx, client, ev(tsAt(-40), "blocked on the API change"), harpreet) {
		t.Fatal("a redelivered event must not make the bot answer")
	}
	if r.handleInbound(ctx, client, ev(tsAt(-30), "ETA tomorrow"), harpreet) {
		t.Fatal("his follow-up is still part of the relay")
	}

	if n := len(slack.postsTo("D_H")); n != 1 {
		t.Errorf("Harpreet should get exactly one ack, got %d bot messages", n)
	}
	if n := len(slack.postsTo("D_U_simran")); n != 2 {
		t.Errorf("Simran should be told about each distinct reply once (not the redelivery), got %d", n)
	}
	c, _ := repo.GetConversation(ctx, "D_H")
	if c == nil || !c.NeedsAttention || !c.RelayAcked || c.RelayOwnerID != "user-simran" || c.SlackUserName != "Harpreet" {
		t.Errorf("conversation state wrong: %+v", c)
	}
	var kinds []string
	// Messages are dated by their Slack ts, and the fake Slack hands out ts values that do not
	// interleave with the made-up event ts, so compare what is stored, not the order.
	rows, _ := pool.Query(ctx, `SELECT direction||':'||kind FROM slack_dm_messages WHERE channel_id='D_H' ORDER BY 1`)
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		kinds = append(kinds, k)
	}
	rows.Close()
	if got := strings.Join(kinds, ","); got != "in:human,in:human,out:ack,out:claude" {
		t.Errorf("transcript wrong (want 2 from Harpreet, the ack, and Simran's message once each): %s", got)
	}

	// The relay lapses on its own; and an admin switching the mode back to auto ends it at once.
	if _, err := pool.Exec(ctx, `UPDATE slack_dm_conversations SET mode='auto' WHERE channel_id='D_H'`); err != nil {
		t.Fatal(err)
	}
	if !r.handleInbound(ctx, client, ev(tsAt(-20), "hey bot"), harpreet) {
		t.Error("in auto mode the bot answers even during a relay")
	}
	_, _ = pool.Exec(ctx, `UPDATE slack_dm_conversations SET mode='smart', relay_until = NOW() - INTERVAL '1 hour' WHERE channel_id='D_H'`)
	if !r.handleInbound(ctx, client, ev(tsAt(-10), "new question"), harpreet) {
		t.Error("after the relay lapsed the bot answers a new message")
	}

	// A person Velocity never messaged is a normal DM.
	cold := slackInnerEvent{Type: "message", Channel: "D_NEW", TS: tsAt(-5), User: "UNEW", Text: "hello"}
	if !r.handleInbound(ctx, client, cold, dmSender{SlackID: "UNEW"}) {
		t.Error("a cold DM is answered by the bot")
	}
}
