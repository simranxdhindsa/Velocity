package database

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Slack DM chats: every message between a person and the Velocity bot, and whether the
// bot should answer or stay out of a conversation Velocity started for someone (a "relay").

const (
	DMModeSmart = "smart" // quiet while a relayed conversation is open, otherwise the bot answers
	DMModeAuto  = "auto"  // the bot always answers
	DMModeMuted = "muted" // the bot never answers

	DMKindHuman     = "human"      // what the person wrote
	DMKindClaude    = "claude"     // sent through Claude / the Claude Queue for a Velocity user
	DMKindDashboard = "dashboard"  // typed in the Velocity dashboard
	DMKindAutoReply = "auto_reply" // the bot's own answer
	DMKindAck       = "ack"        // the bot's one short "passed this on" line
	DMKindNotice    = "notice"     // Velocity telling a user that someone replied

	DMDirIn  = "in"
	DMDirOut = "out"
)

// DMRelayWindow is how long a relay stays open after the last message Velocity sent in it.
const DMRelayWindow = 24 * time.Hour

// DMMaxTextRunes caps the text stored for one message.
const DMMaxTextRunes = 8000

type SlackDMConversation struct {
	ChannelID      string     `json:"channel_id"`
	SlackUserID    string     `json:"slack_user_id"`
	SlackUserName  string     `json:"slack_user_name"`
	SlackUserEmail string     `json:"slack_user_email"`
	Mode           string     `json:"mode"`
	RelayOwnerID   string     `json:"relay_owner_id"`
	RelayUntil     *time.Time `json:"relay_until"`
	RelayAcked     bool       `json:"relay_acked"`
	NeedsAttention bool       `json:"needs_attention"`
	LastMessageAt  time.Time  `json:"last_message_at"`
}

type SlackDMMessage struct {
	ID            int64     `json:"id"`
	ChannelID     string    `json:"channel_id"`
	SlackTS       string    `json:"slack_ts"`
	ThreadTS      string    `json:"thread_ts"`
	Direction     string    `json:"direction"`
	Kind          string    `json:"kind"`
	AuthorSlackID string    `json:"author_slack_id"`
	SentByUserID  string    `json:"sent_by_user_id"`
	Text          string    `json:"text"`
	CreatedAt     time.Time `json:"created_at"`
}

type SlackDMRepository struct{}

func NewSlackDMRepository() *SlackDMRepository { return &SlackDMRepository{} }

// slackTSTime turns a Slack ts ("1700000000.000100") into a time, so a message is dated
// when Slack says it was posted rather than when we got round to storing it.
func slackTSTime(ts string) time.Time {
	secs, _, _ := strings.Cut(ts, ".")
	n, err := strconv.ParseInt(secs, 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	return time.Unix(n, 0).UTC()
}

// EnsureConversation creates the conversation row if it is missing and fills in who the
// person is, without ever overwriting a known name or email with an empty one.
func (r *SlackDMRepository) EnsureConversation(ctx context.Context, c SlackDMConversation) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO slack_dm_conversations (channel_id, slack_user_id, slack_user_name, slack_user_email)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (channel_id) DO UPDATE SET
			slack_user_id    = COALESCE(NULLIF(EXCLUDED.slack_user_id, ''), slack_dm_conversations.slack_user_id),
			slack_user_name  = COALESCE(NULLIF(EXCLUDED.slack_user_name, ''), slack_dm_conversations.slack_user_name),
			slack_user_email = COALESCE(NULLIF(EXCLUDED.slack_user_email, ''), slack_dm_conversations.slack_user_email)`,
		c.ChannelID, c.SlackUserID, c.SlackUserName, c.SlackUserEmail)
	return err
}

// GetConversation returns the conversation, or nil when there is none (or no database).
func (r *SlackDMRepository) GetConversation(ctx context.Context, channelID string) (*SlackDMConversation, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	var c SlackDMConversation
	err := pool.QueryRow(ctx, `
		SELECT channel_id, slack_user_id, slack_user_name, slack_user_email, mode, relay_owner_id,
		       relay_until, relay_acked, needs_attention, last_message_at
		FROM slack_dm_conversations WHERE channel_id = $1`, channelID,
	).Scan(&c.ChannelID, &c.SlackUserID, &c.SlackUserName, &c.SlackUserEmail, &c.Mode, &c.RelayOwnerID,
		&c.RelayUntil, &c.RelayAcked, &c.NeedsAttention, &c.LastMessageAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// RecordMessage stores one message and reports whether it was new. A message already stored
// (Slack redelivering an event, or the same ts recorded twice) returns false, so callers can
// act exactly once per message. Without a database it reports true and stores nothing.
func (r *SlackDMRepository) RecordMessage(ctx context.Context, m SlackDMMessage) (bool, error) {
	pool := GetPool()
	if pool == nil {
		return true, nil
	}
	at := slackTSTime(m.SlackTS)
	if at.IsZero() {
		at = time.Now()
	}
	// Slack allows ~40k characters a message; keep what a chat view needs and no more.
	if r := []rune(m.Text); len(r) > DMMaxTextRunes {
		m.Text = string(r[:DMMaxTextRunes]) + "..."
	}
	tag, err := pool.Exec(ctx, `
		INSERT INTO slack_dm_messages
			(channel_id, slack_ts, thread_ts, direction, kind, author_slack_id, sent_by_user_id, text, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (channel_id, slack_ts) DO NOTHING`,
		m.ChannelID, m.SlackTS, m.ThreadTS, m.Direction, m.Kind, m.AuthorSlackID, m.SentByUserID, m.Text, at)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	// Keep the list ordered by the latest activity (and create a bare row if none exists yet).
	_, err = pool.Exec(ctx, `
		INSERT INTO slack_dm_conversations (channel_id, last_message_at) VALUES ($1, $2)
		ON CONFLICT (channel_id) DO UPDATE
		SET last_message_at = GREATEST(slack_dm_conversations.last_message_at, EXCLUDED.last_message_at)`,
		m.ChannelID, at)
	return true, err
}

// BeginRelay marks the conversation as one Velocity started for ownerID: the bot stays quiet
// until `until`, and gets one fresh "passed this on" line. It never shortens a relay that is
// already open for longer, so a short placeholder window set before a send can't cut a real one.
func (r *SlackDMRepository) BeginRelay(ctx context.Context, channelID, slackUserID, ownerID string, until time.Time) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO slack_dm_conversations (channel_id, slack_user_id, relay_owner_id, relay_until)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (channel_id) DO UPDATE SET
			slack_user_id  = COALESCE(NULLIF(EXCLUDED.slack_user_id, ''), slack_dm_conversations.slack_user_id),
			relay_owner_id = EXCLUDED.relay_owner_id,
			relay_until    = GREATEST(COALESCE(slack_dm_conversations.relay_until, EXCLUDED.relay_until), EXCLUDED.relay_until),
			relay_acked    = false`,
		channelID, slackUserID, ownerID, until)
	return err
}

// ExtendRelay pushes ownerID's open relay out to `until` (never earlier) without touching the
// ack, used to confirm the full window once a send succeeded. It only ever applies to the
// relay ownerID holds, so it can't prolong somebody else's. The window is deliberately NOT
// extended by the person's replies: it runs 24h from the last message Velocity sent, so a
// relay always ends and the user decides whether to keep it open by messaging again.
func (r *SlackDMRepository) ExtendRelay(ctx context.Context, channelID, ownerID string, until time.Time) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE slack_dm_conversations SET relay_until = GREATEST(COALESCE(relay_until, $3), $3)
		WHERE channel_id = $1 AND relay_owner_id = $2`, channelID, ownerID, until)
	return err
}

// AbortRelay undoes the short placeholder relay set before a send that then failed, so the
// person's next messages are not silenced for a message that never went out. It only clears a
// relay that is still just a placeholder (ends within 3 minutes), never a real 24h one.
func (r *SlackDMRepository) AbortRelay(ctx context.Context, channelID, ownerID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE slack_dm_conversations SET relay_owner_id = '', relay_until = NULL, relay_acked = false
		WHERE channel_id = $1 AND relay_owner_id = $2 AND relay_until <= NOW() + INTERVAL '3 minutes'`,
		channelID, ownerID)
	return err
}

// ClaimAck atomically takes the right to send the one "passed this on" line for the current
// relay. Exactly one caller gets true, however many messages arrive at once.
func (r *SlackDMRepository) ClaimAck(ctx context.Context, channelID string) (bool, error) {
	pool := GetPool()
	if pool == nil {
		return true, nil
	}
	var claimed bool
	err := pool.QueryRow(ctx, `
		UPDATE slack_dm_conversations SET relay_acked = true
		WHERE channel_id = $1 AND relay_acked = false RETURNING true`, channelID).Scan(&claimed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return claimed, err
}

// ReleaseAck gives the ack back when posting it failed, so the next message tries again.
func (r *SlackDMRepository) ReleaseAck(ctx context.Context, channelID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `UPDATE slack_dm_conversations SET relay_acked = false WHERE channel_id = $1`, channelID)
	return err
}

// CountInboundSince counts the messages the person sent in this conversation since `since`,
// used to stop a flood of messages becoming a flood of alerts.
func (r *SlackDMRepository) CountInboundSince(ctx context.Context, channelID string, since time.Time) (int, error) {
	pool := GetPool()
	if pool == nil {
		return 0, nil
	}
	var n int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM slack_dm_messages
		WHERE channel_id = $1 AND direction = 'in' AND created_at >= $2`, channelID, since).Scan(&n)
	return n, err
}

// MarkNeedsAttention flags a conversation where the person wrote and the bot stayed quiet.
func (r *SlackDMRepository) MarkNeedsAttention(ctx context.Context, channelID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `UPDATE slack_dm_conversations SET needs_attention = true WHERE channel_id = $1`, channelID)
	return err
}

// PruneMessagesOlderThan deletes messages older than the retention period (90 days), so
// private DMs are not kept longer than that.
func (r *SlackDMRepository) PruneMessagesOlderThan(ctx context.Context, days int) (int64, error) {
	pool := GetPool()
	if pool == nil {
		return 0, nil
	}
	tag, err := pool.Exec(ctx, `DELETE FROM slack_dm_messages WHERE created_at < NOW() - make_interval(days => $1)`, days)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ── Admin Chats page ────────────────────────────────────────────────────────

// SlackDMListItem is one row of the Chats people list: the conversation plus its last message.
type SlackDMListItem struct {
	SlackDMConversation
	LastPreview   string `json:"last_preview"`
	LastKind      string `json:"last_kind"`
	LastDirection string `json:"last_direction"`
}

// ListConversations returns conversations that have at least one message: those that need
// the admin first, then by latest activity.
func (r *SlackDMRepository) ListConversations(ctx context.Context, limit int) ([]SlackDMListItem, error) {
	pool := GetPool()
	if pool == nil {
		return []SlackDMListItem{}, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := pool.Query(ctx, `
		SELECT c.channel_id, c.slack_user_id, c.slack_user_name, c.slack_user_email, c.mode, c.relay_owner_id,
		       c.relay_until, c.relay_acked, c.needs_attention, c.last_message_at, m.text, m.kind, m.direction
		FROM slack_dm_conversations c
		JOIN LATERAL (
			SELECT text, kind, direction FROM slack_dm_messages
			WHERE channel_id = c.channel_id ORDER BY created_at DESC, id DESC LIMIT 1
		) m ON true
		ORDER BY c.needs_attention DESC, c.last_message_at DESC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SlackDMListItem{}
	for rows.Next() {
		var it SlackDMListItem
		if err := rows.Scan(&it.ChannelID, &it.SlackUserID, &it.SlackUserName, &it.SlackUserEmail, &it.Mode, &it.RelayOwnerID,
			&it.RelayUntil, &it.RelayAcked, &it.NeedsAttention, &it.LastMessageAt, &it.LastPreview, &it.LastKind, &it.LastDirection); err != nil {
			return nil, err
		}
		if rs := []rune(it.LastPreview); len(rs) > 140 {
			it.LastPreview = string(rs[:140]) + "..."
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// LatestInboundAt returns when the newest message from a person arrived, or nil if there is none.
func (r *SlackDMRepository) LatestInboundAt(ctx context.Context) (*time.Time, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	var at *time.Time
	err := pool.QueryRow(ctx, `SELECT MAX(created_at) FROM slack_dm_messages WHERE direction = $1`, DMDirIn).Scan(&at)
	return at, err
}

// ListMessages returns a conversation's messages oldest first. With afterID > 0 it returns only
// newer ones (for polling); otherwise the latest `limit` messages.
func (r *SlackDMRepository) ListMessages(ctx context.Context, channelID string, afterID int64, limit int) ([]SlackDMMessage, error) {
	pool := GetPool()
	if pool == nil {
		return []SlackDMMessage{}, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	const cols = `id, channel_id, slack_ts, thread_ts, direction, kind, author_slack_id, sent_by_user_id, text, created_at`
	var q string
	args := []interface{}{channelID, limit}
	if afterID > 0 {
		q = `SELECT ` + cols + ` FROM slack_dm_messages WHERE channel_id = $1 AND id > $3 ORDER BY created_at, id LIMIT $2`
		args = append(args, afterID)
	} else {
		q = `SELECT * FROM (SELECT ` + cols + ` FROM slack_dm_messages WHERE channel_id = $1
		     ORDER BY created_at DESC, id DESC LIMIT $2) t ORDER BY created_at, id`
	}
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SlackDMMessage{}
	for rows.Next() {
		var m SlackDMMessage
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.SlackTS, &m.ThreadTS, &m.Direction, &m.Kind, &m.AuthorSlackID,
			&m.SentByUserID, &m.Text, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SetMode changes how the bot treats this conversation (smart, auto or muted). It reports
// whether the conversation exists.
func (r *SlackDMRepository) SetMode(ctx context.Context, channelID, mode string) (bool, error) {
	if mode != DMModeSmart && mode != DMModeAuto && mode != DMModeMuted {
		return false, errors.New("invalid mode")
	}
	pool := GetPool()
	if pool == nil {
		return false, nil
	}
	tag, err := pool.Exec(ctx, `UPDATE slack_dm_conversations SET mode = $2 WHERE channel_id = $1`, channelID, mode)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ClearAttention marks the conversation as seen by the admin.
func (r *SlackDMRepository) ClearAttention(ctx context.Context, channelID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `UPDATE slack_dm_conversations SET needs_attention = false WHERE channel_id = $1`, channelID)
	return err
}

// ResolveRelay ends the relay and clears the flag, so the bot answers this person again.
func (r *SlackDMRepository) ResolveRelay(ctx context.Context, channelID string) (bool, error) {
	pool := GetPool()
	if pool == nil {
		return false, nil
	}
	tag, err := pool.Exec(ctx, `
		UPDATE slack_dm_conversations
		SET relay_owner_id = '', relay_until = NULL, relay_acked = false, needs_attention = false
		WHERE channel_id = $1`, channelID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// CountNeedingAttention is the number behind the Chats badge.
func (r *SlackDMRepository) CountNeedingAttention(ctx context.Context) (int, error) {
	pool := GetPool()
	if pool == nil {
		return 0, nil
	}
	var n int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM slack_dm_conversations c
		WHERE c.needs_attention AND EXISTS (SELECT 1 FROM slack_dm_messages m WHERE m.channel_id = c.channel_id)`).Scan(&n)
	return n, err
}

// PruneIdleConversations deletes conversation rows that have no messages left and have been
// quiet for the retention period, so a person's name, email and relay owner don't outlive
// their chat history.
func (r *SlackDMRepository) PruneIdleConversations(ctx context.Context, days int) (int64, error) {
	pool := GetPool()
	if pool == nil {
		return 0, nil
	}
	tag, err := pool.Exec(ctx, `
		DELETE FROM slack_dm_conversations c
		WHERE c.last_message_at < NOW() - make_interval(days => $1)
		  AND NOT EXISTS (SELECT 1 FROM slack_dm_messages m WHERE m.channel_id = c.channel_id)`, days)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
