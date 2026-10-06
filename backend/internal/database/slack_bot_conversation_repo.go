package database

import (
	"context"
	"time"
)

type SlackBotConversation struct {
	ID             string    `json:"id"`
	UserID         string    `json:"user_id"`
	SlackUserID    string    `json:"slack_user_id"`
	SlackUserEmail string    `json:"slack_user_email"`
	ChannelID      string    `json:"channel_id"`
	ChannelLabel   string    `json:"channel_label"`
	EventType      string    `json:"event_type"`
	IncomingText   string    `json:"incoming_text"`
	ReplyText      string    `json:"reply_text"`
	Success        bool      `json:"success"`
	ErrorMessage   string    `json:"error_message"`
	CreatedAt      time.Time `json:"created_at"`
}

type SlackBotConversationRepository struct{}

func NewSlackBotConversationRepository() *SlackBotConversationRepository {
	return &SlackBotConversationRepository{}
}

// Log records one full DM/mention <-> reply round trip. Best-effort — a
// logging failure must never break the actual Slack reply, so callers
// should log-and-continue on error, not fail the reply.
func (r *SlackBotConversationRepository) Log(ctx context.Context, c SlackBotConversation) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO slack_bot_conversations
			(user_id, slack_user_id, slack_user_email, channel_id, channel_label, event_type, incoming_text, reply_text, success, error_message)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`, c.UserID, c.SlackUserID, c.SlackUserEmail, c.ChannelID, c.ChannelLabel, c.EventType, c.IncomingText, c.ReplyText, c.Success, c.ErrorMessage)
	return err
}

// List returns recent conversations, newest first. userIDFilter == "" means
// no filter (every conversation, for admins); a non-empty value restricts to
// that one Velocity user's own conversations. THIS IS THE SECURITY BOUNDARY
// for this feature — the caller (handler) decides whether to pass a filter
// based on the authenticated user's role, this method just applies it.
func (r *SlackBotConversationRepository) List(ctx context.Context, userIDFilter string, limit int) ([]SlackBotConversation, error) {
	pool := GetPool()
	if pool == nil {
		return []SlackBotConversation{}, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text, user_id, slack_user_id, slack_user_email, channel_id, channel_label,
		       event_type, incoming_text, reply_text, success, error_message, created_at
		FROM slack_bot_conversations
		WHERE ($1 = '' OR user_id = $1)
		ORDER BY created_at DESC
		LIMIT $2
	`, userIDFilter, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	entries := []SlackBotConversation{}
	for rows.Next() {
		var e SlackBotConversation
		if err := rows.Scan(&e.ID, &e.UserID, &e.SlackUserID, &e.SlackUserEmail, &e.ChannelID, &e.ChannelLabel,
			&e.EventType, &e.IncomingText, &e.ReplyText, &e.Success, &e.ErrorMessage, &e.CreatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// PruneOlderThan30Days deletes rows older than 30 days (longer retention than
// the 7-day mcp_activity_log since this is a user-facing chat history, not
// just a technical debug log).
func (r *SlackBotConversationRepository) PruneOlderThan30Days(ctx context.Context) (int64, error) {
	pool := GetPool()
	if pool == nil {
		return 0, nil
	}
	tag, err := pool.Exec(ctx, `DELETE FROM slack_bot_conversations WHERE created_at < NOW() - INTERVAL '30 days'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
