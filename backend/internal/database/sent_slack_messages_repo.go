package database

import (
	"context"
	"time"
)

type SentSlackMessagesRepository struct{}

func NewSentSlackMessagesRepository() *SentSlackMessagesRepository {
	return &SentSlackMessagesRepository{}
}

type SentSlackMessage struct {
	ID           string     `json:"id"`
	UserID       string     `json:"user_id"`
	Source       string     `json:"source"`
	ChannelID    string     `json:"channel_id"`
	ChannelLabel string     `json:"channel_label"`
	Message      string     `json:"message"`
	SlackTs      string     `json:"slack_ts"`
	SentAt       time.Time  `json:"sent_at"`
	EditedAt     *time.Time `json:"edited_at"`
}

// Log records a message Velocity just sent to Slack, from any source feature.
// Failures to log are non-fatal from the caller's perspective — the message
// already went out — so callers should log-and-continue on error, not fail
// the send.
func (r *SentSlackMessagesRepository) Log(ctx context.Context, userID, source, channelID, channelLabel, message, slackTs string) (*SentSlackMessage, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	m := &SentSlackMessage{}
	err := pool.QueryRow(ctx, `
		INSERT INTO sent_slack_messages
			(user_id, source, channel_id, channel_label, message, slack_ts)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id::text, user_id, source, channel_id, channel_label, message, slack_ts, sent_at, edited_at
	`, userID, source, channelID, channelLabel, message, slackTs).Scan(
		&m.ID, &m.UserID, &m.Source, &m.ChannelID, &m.ChannelLabel, &m.Message, &m.SlackTs, &m.SentAt, &m.EditedAt,
	)
	if err != nil {
		return nil, err
	}
	return m, nil
}

// List returns sent messages for a user, optionally filtered by channel and/or source.
func (r *SentSlackMessagesRepository) List(ctx context.Context, userID, channelID, source string, limit int) ([]SentSlackMessage, error) {
	pool := GetPool()
	if pool == nil {
		return []SentSlackMessage{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text, user_id, source, channel_id, channel_label, message, slack_ts, sent_at, edited_at
		FROM sent_slack_messages
		WHERE user_id = $1
		  AND ($2 = '' OR channel_id = $2)
		  AND ($3 = '' OR source = $3)
		ORDER BY sent_at DESC
		LIMIT $4
	`, userID, channelID, source, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []SentSlackMessage
	for rows.Next() {
		var m SentSlackMessage
		if err := rows.Scan(
			&m.ID, &m.UserID, &m.Source, &m.ChannelID, &m.ChannelLabel, &m.Message, &m.SlackTs, &m.SentAt, &m.EditedAt,
		); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	if msgs == nil {
		msgs = []SentSlackMessage{}
	}
	return msgs, nil
}

// ListRecentAll returns recent sent messages across all users, optionally
// filtered by a case-insensitive text search over the message body or
// channel label. Used by the Slack bot's own check_message_history tool,
// which has no per-user auth context (unlike List, which is scoped to one
// app user for the Slack Messages hub UI) — Velocity's sent history is a
// single system-wide log from the bot's point of view.
func (r *SentSlackMessagesRepository) ListRecentAll(ctx context.Context, query string, limit int) ([]SentSlackMessage, error) {
	pool := GetPool()
	if pool == nil {
		return []SentSlackMessage{}, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 15
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text, user_id, source, channel_id, channel_label, message, slack_ts, sent_at, edited_at
		FROM sent_slack_messages
		WHERE ($1 = '' OR message ILIKE '%' || $1 || '%' OR channel_label ILIKE '%' || $1 || '%')
		ORDER BY sent_at DESC
		LIMIT $2
	`, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []SentSlackMessage
	for rows.Next() {
		var m SentSlackMessage
		if err := rows.Scan(
			&m.ID, &m.UserID, &m.Source, &m.ChannelID, &m.ChannelLabel, &m.Message, &m.SlackTs, &m.SentAt, &m.EditedAt,
		); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	if msgs == nil {
		msgs = []SentSlackMessage{}
	}
	return msgs, nil
}

func (r *SentSlackMessagesRepository) GetByID(ctx context.Context, id, userID string) (*SentSlackMessage, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	m := &SentSlackMessage{}
	err := pool.QueryRow(ctx, `
		SELECT id::text, user_id, source, channel_id, channel_label, message, slack_ts, sent_at, edited_at
		FROM sent_slack_messages
		WHERE id::text = $1 AND user_id = $2
	`, id, userID).Scan(
		&m.ID, &m.UserID, &m.Source, &m.ChannelID, &m.ChannelLabel, &m.Message, &m.SlackTs, &m.SentAt, &m.EditedAt,
	)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func (r *SentSlackMessagesRepository) UpdateText(ctx context.Context, id, userID, message string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE sent_slack_messages
		SET message = $3, edited_at = NOW()
		WHERE id::text = $1 AND user_id = $2
	`, id, userID, message)
	return err
}

func (r *SentSlackMessagesRepository) Delete(ctx context.Context, id, userID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		DELETE FROM sent_slack_messages
		WHERE id::text = $1 AND user_id = $2
	`, id, userID)
	return err
}

// DeleteOld removes log rows older than the given number of days — this only
// prunes the hub's own history log, it does not touch the messages in Slack.
func (r *SentSlackMessagesRepository) DeleteOld(ctx context.Context, days int) (int64, error) {
	pool := GetPool()
	if pool == nil {
		return 0, nil
	}
	result, err := pool.Exec(ctx, `
		DELETE FROM sent_slack_messages
		WHERE sent_at < NOW() - INTERVAL '1 day' * $1
	`, days)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}
