package handlers

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// Slack DM relay. When Velocity DMs someone for a user (through Claude, the queue or the
// dashboard) and the person answers, the answer is for that user, not for the bot. Without
// this the bot jokes back at the person, and the user never sees the answer. So in a relayed
// conversation the bot stays quiet (apart from one short "passed this on" line), the message
// is stored for the dashboard, and the user who asked gets a Slack DM with what was said.

// dmMaxAlertsPerHour caps how many "someone replied" alerts one conversation can send its
// owner in an hour, so a flood of messages is not a flood of Slack DMs. Messages over the cap
// are still stored for the dashboard and the bot still stays quiet.
const dmMaxAlertsPerHour = 20

// dmStore is the slice of database.SlackDMRepository the relay uses, as an interface so
// tests can swap in an in-memory fake.
type dmStore interface {
	EnsureConversation(ctx context.Context, c database.SlackDMConversation) error
	GetConversation(ctx context.Context, channelID string) (*database.SlackDMConversation, error)
	RecordMessage(ctx context.Context, m database.SlackDMMessage) (bool, error)
	ClaimAck(ctx context.Context, channelID string) (bool, error)
	ReleaseAck(ctx context.Context, channelID string) error
	MarkNeedsAttention(ctx context.Context, channelID string) error
	CountInboundSince(ctx context.Context, channelID string, since time.Time) (int, error)
}

// dmSender is who wrote the incoming DM.
type dmSender struct {
	SlackID        string
	Name           string
	Email          string
	VelocityUserID string // "" when the person is not a Velocity user
}

type dmDecision int

const (
	dmAnswer dmDecision = iota // the normal bot reply goes ahead
	dmAck                      // relay: one short "passed this on" line, then quiet
	dmQuiet                    // relay or muted: the bot says nothing
)

// decideDMReply says what the bot does with a new message in this conversation, and whether
// the user who started the relay should be told about it. c is nil for a first-ever DM.
func decideDMReply(c *database.SlackDMConversation, senderVelocityID string, now time.Time) (dmDecision, bool) {
	if c == nil {
		return dmAnswer, false
	}
	// A relay only counts while it is open, and never when the person writing is the user who
	// started it (a user messaging the bot themselves is just chatting with the bot).
	active := c.RelayOwnerID != "" && c.RelayUntil != nil && now.Before(*c.RelayUntil) &&
		c.RelayOwnerID != senderVelocityID
	switch c.Mode {
	case database.DMModeAuto:
		return dmAnswer, false
	case database.DMModeMuted:
		return dmQuiet, active
	default: // smart
		if !active {
			return dmAnswer, false
		}
		if c.RelayAcked {
			return dmQuiet, true
		}
		return dmAck, true
	}
}

type dmRelay struct {
	store dmStore
	owner func(ctx context.Context, velocityUserID string) (name, email string)
	now   func() time.Time
}

func newDMRelay() *dmRelay {
	users := database.NewUserRepository()
	return &dmRelay{
		store: database.NewSlackDMRepository(),
		owner: func(ctx context.Context, id string) (string, string) {
			u, err := users.GetByID(ctx, id)
			if err != nil || u == nil {
				return "", ""
			}
			return u.Name, u.Email
		},
		now: time.Now,
	}
}

// handleInbound records a DM the bot received and reports whether the normal bot reply should
// go ahead. It fails open: if the store is unavailable the bot answers as it always did.
func (d *dmRelay) handleInbound(ctx context.Context, client *slacksvc.Client, ev slackInnerEvent, who dmSender) bool {
	if err := d.store.EnsureConversation(ctx, database.SlackDMConversation{
		ChannelID: ev.Channel, SlackUserID: who.SlackID, SlackUserName: who.Name, SlackUserEmail: who.Email,
	}); err != nil {
		log.Printf("[slack-dm] ensure conversation %s: %v", ev.Channel, err)
	}
	isNew, err := d.store.RecordMessage(ctx, database.SlackDMMessage{
		ChannelID: ev.Channel, SlackTS: ev.TS, ThreadTS: ev.ThreadTS, Direction: database.DMDirIn,
		Kind: database.DMKindHuman, AuthorSlackID: who.SlackID, Text: ev.Text,
	})
	if err != nil {
		log.Printf("[slack-dm] record inbound %s/%s: %v", ev.Channel, ev.TS, err)
		return true
	}
	if !isNew {
		return false // Slack redelivered an event that was already handled
	}
	c, err := d.store.GetConversation(ctx, ev.Channel)
	if err != nil {
		log.Printf("[slack-dm] load conversation %s: %v", ev.Channel, err)
		return true
	}
	now := d.now()
	decision, notify := decideDMReply(c, who.VelocityUserID, now)
	if decision == dmAnswer {
		return true
	}

	if err := d.store.MarkNeedsAttention(ctx, ev.Channel); err != nil {
		log.Printf("[slack-dm] mark needs attention %s: %v", ev.Channel, err)
	}
	// The user who asked hears what was said first. If they cannot be told, the person must
	// not be left with silence and the answer lost: the bot answers normally instead. (A chat
	// muted on purpose stays quiet either way, the dashboard has the message.)
	if notify && !d.alertOwner(ctx, client, ev.Channel, c.RelayOwnerID, who, ev.Text) && c.Mode != database.DMModeMuted {
		return true
	}
	if decision == dmAck {
		d.ackOnce(ctx, client, ev, c.RelayOwnerID)
	}
	return false
}

// ackOnce sends the one short line telling the person their message was passed on. The right
// to send it is claimed atomically first, and given back if posting fails so the next message
// tries again.
func (d *dmRelay) ackOnce(ctx context.Context, client *slacksvc.Client, ev slackInnerEvent, ownerID string) {
	ok, err := d.store.ClaimAck(ctx, ev.Channel)
	if err != nil {
		log.Printf("[slack-dm] claim ack %s: %v", ev.Channel, err)
		return
	}
	if !ok {
		return
	}
	name, _ := d.owner(ctx, ownerID)
	text := "Thanks, I have passed this on."
	if name != "" {
		text = "Thanks, I have passed this on to " + name + "."
	}
	ts, err := client.PostInThread(ctx, ev.Channel, ev.ThreadTS, text)
	if err != nil {
		log.Printf("[slack-dm] post ack %s: %v", ev.Channel, err)
		if rerr := d.store.ReleaseAck(ctx, ev.Channel); rerr != nil {
			log.Printf("[slack-dm] release ack %s: %v", ev.Channel, rerr)
		}
		return
	}
	d.record(ctx, ev.Channel, ts, ev.ThreadTS, database.DMKindAck, text)
}

// alertOwner tells the user who started the relay what the person said, and reports whether
// that is taken care of: true when the alert was delivered or deliberately held back by the
// hourly cap, false when it could not be delivered.
func (d *dmRelay) alertOwner(ctx context.Context, client *slacksvc.Client, channelID, ownerID string, who dmSender, text string) bool {
	if n, err := d.store.CountInboundSince(ctx, channelID, d.now().Add(-time.Hour)); err == nil && n > dmMaxAlertsPerHour {
		log.Printf("[slack-dm] %s sent %d messages in an hour, holding back alerts to %s", channelID, n, ownerID)
		return true
	}
	return d.notifyOwner(ctx, client, ownerID, who, text)
}

// notifyOwner DMs the user with the person's message. Everything that came from the person
// (name and text) is escaped so it can't become a link, mention or formatting in a message
// from the trusted Velocity bot.
func (d *dmRelay) notifyOwner(ctx context.Context, client *slacksvc.Client, ownerID string, who dmSender, text string) bool {
	ownerName, ownerEmail := d.owner(ctx, ownerID)
	if ownerEmail == "" {
		log.Printf("[slack-dm] cannot notify relay owner %s: no email", ownerID)
		return false
	}
	u, err := client.GetUserByEmail(ctx, ownerEmail)
	if err != nil {
		log.Printf("[slack-dm] cannot notify relay owner %s: %v", ownerID, err)
		return false
	}
	notice := fmt.Sprintf("*%s* replied to your message:\n%s", cleanLabel(who.Name), quoteForSlack(text, 1500))
	channelID, ts, err := client.PostDirectMessage(ctx, u.ID, notice)
	if err != nil {
		log.Printf("[slack-dm] notice to %s failed: %v", ownerID, err)
		return false
	}
	if err := d.store.EnsureConversation(ctx, database.SlackDMConversation{
		ChannelID: channelID, SlackUserID: u.ID, SlackUserName: ownerName, SlackUserEmail: ownerEmail,
	}); err != nil {
		log.Printf("[slack-dm] ensure conversation %s: %v", channelID, err)
	}
	d.record(ctx, channelID, ts, "", database.DMKindNotice, notice)
	return true
}

// record stores a message the bot itself posted. Best effort: never fails a reply.
func (d *dmRelay) record(ctx context.Context, channelID, ts, threadTS, kind, text string) {
	if ts == "" {
		return
	}
	if _, err := d.store.RecordMessage(ctx, database.SlackDMMessage{
		ChannelID: channelID, SlackTS: ts, ThreadTS: threadTS, Direction: database.DMDirOut, Kind: kind, Text: text,
	}); err != nil {
		log.Printf("[slack-dm] record %s %s/%s: %v", kind, channelID, ts, err)
	}
}

// slackEscaper escapes the three characters Slack treats as markup in message text, so
// <https://x|label>, <@U123> and <!channel> from a person arrive as plain text.
var slackEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// quoteForSlack renders a person's text as a Slack block quote, escaped and cut to max
// characters.
func quoteForSlack(text string, max int) string {
	text = strings.TrimSpace(text)
	if r := []rune(text); len(r) > max {
		text = string(r[:max]) + "..."
	}
	lines := strings.Split(slackEscaper.Replace(text), "\n")
	for i, l := range lines {
		lines[i] = "> " + l
	}
	return strings.Join(lines, "\n")
}

// cleanLabel makes a person's display name safe to put inside a bold label: no markup or
// control characters, at most 60 characters, and "Someone" when nothing is left.
func cleanLabel(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20 || r == 0x7f, strings.ContainsRune("*_~`<>&|", r):
			continue
		}
		b.WriteRune(r)
	}
	s := strings.TrimSpace(b.String())
	if rs := []rune(s); len(rs) > 60 {
		s = string(rs[:60])
	}
	if s == "" {
		return "Someone"
	}
	return s
}
