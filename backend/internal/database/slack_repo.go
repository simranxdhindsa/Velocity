package database

import (
	"context"
	"time"

	"github.com/dhindsa/project-management/internal/models"
)

// SlackRepository handles Slack intelligence database operations
type SlackRepository struct{}

// NewSlackRepository creates a new SlackRepository
func NewSlackRepository() *SlackRepository {
	return &SlackRepository{}
}

// --- Mentions ---

// SaveMention saves or ignores a Slack @mention (idempotent by user_id+message_ts)
func (r *SlackRepository) SaveMention(ctx context.Context, mention *models.SlackMention) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		INSERT INTO slack_mentions (user_id, slack_user_id, message_ts, thread_ts, channel_id, message_text, sender_name, sender_avatar, requires_reply, replied, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
		ON CONFLICT (user_id, message_ts) DO UPDATE SET
			message_text = EXCLUDED.message_text,
			sender_name = EXCLUDED.sender_name,
			sender_avatar = EXCLUDED.sender_avatar
	`, mention.UserID, mention.SlackUserID, mention.MessageTS, mention.ThreadTS,
		mention.ChannelID, mention.MessageText, mention.SenderName, mention.SenderAvatar,
		mention.RequiresReply, mention.Replied)

	return err
}

// GetUnrepliedMentions returns all unreplied @mentions for a user, newest first
func (r *SlackRepository) GetUnrepliedMentions(ctx context.Context, userID string) ([]models.SlackMention, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, user_id, slack_user_id, message_ts, thread_ts, channel_id, message_text,
		       sender_name, COALESCE(sender_avatar, ''), requires_reply, replied, reply_checked_at, snoozed_until, created_at
		FROM slack_mentions
		WHERE user_id = $1 AND replied = FALSE
		ORDER BY created_at DESC
		LIMIT 100
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var mentions []models.SlackMention
	for rows.Next() {
		var m models.SlackMention
		err := rows.Scan(&m.ID, &m.UserID, &m.SlackUserID, &m.MessageTS, &m.ThreadTS,
			&m.ChannelID, &m.MessageText, &m.SenderName, &m.SenderAvatar, &m.RequiresReply,
			&m.Replied, &m.ReplyCheckedAt, &m.SnoozedUntil, &m.CreatedAt)
		if err != nil {
			return nil, err
		}
		mentions = append(mentions, m)
	}
	return mentions, nil
}

// GetAllMentions returns all mentions for a user (for full inbox view), newest first
func (r *SlackRepository) GetAllMentions(ctx context.Context, userID string, limit int) ([]models.SlackMention, error) {
	pool := GetPool()

	if limit <= 0 {
		limit = 50
	}

	rows, err := pool.Query(ctx, `
		SELECT id, user_id, slack_user_id, message_ts, thread_ts, channel_id, message_text,
		       sender_name, COALESCE(sender_avatar, ''), requires_reply, replied, reply_checked_at, snoozed_until, COALESCE(pinned, false), created_at
		FROM slack_mentions
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var mentions []models.SlackMention
	for rows.Next() {
		var m models.SlackMention
		err := rows.Scan(&m.ID, &m.UserID, &m.SlackUserID, &m.MessageTS, &m.ThreadTS,
			&m.ChannelID, &m.MessageText, &m.SenderName, &m.SenderAvatar, &m.RequiresReply,
			&m.Replied, &m.ReplyCheckedAt, &m.SnoozedUntil, &m.Pinned, &m.CreatedAt)
		if err != nil {
			return nil, err
		}
		mentions = append(mentions, m)
	}
	return mentions, nil
}

// GetPinnedMentions returns only pinned mentions for a user, newest first.
func (r *SlackRepository) GetPinnedMentions(ctx context.Context, userID string) ([]models.SlackMention, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx, `
		SELECT id, user_id, slack_user_id, message_ts, thread_ts, channel_id, message_text,
		       sender_name, COALESCE(sender_avatar, ''), requires_reply, replied, reply_checked_at, snoozed_until, COALESCE(pinned, false), created_at
		FROM slack_mentions
		WHERE user_id = $1 AND pinned = true
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var mentions []models.SlackMention
	for rows.Next() {
		var m models.SlackMention
		err := rows.Scan(&m.ID, &m.UserID, &m.SlackUserID, &m.MessageTS, &m.ThreadTS,
			&m.ChannelID, &m.MessageText, &m.SenderName, &m.SenderAvatar, &m.RequiresReply,
			&m.Replied, &m.ReplyCheckedAt, &m.SnoozedUntil, &m.Pinned, &m.CreatedAt)
		if err != nil {
			return nil, err
		}
		mentions = append(mentions, m)
	}
	return mentions, nil
}

// SnoozeMention sets a snooze time on a mention (hides it from inbox until the time passes)
func (r *SlackRepository) SnoozeMention(ctx context.Context, userID, messageTS string, until time.Time) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `
		UPDATE slack_mentions SET snoozed_until = $3
		WHERE user_id = $1 AND message_ts = $2
	`, userID, messageTS, until)
	return err
}

// MarkMentionReplied marks a mention as replied/dismissed
func (r *SlackRepository) MarkMentionReplied(ctx context.Context, userID, messageTS string) error {
	pool := GetPool()

	now := time.Now()
	_, err := pool.Exec(ctx, `
		UPDATE slack_mentions SET replied = TRUE, reply_checked_at = $3
		WHERE user_id = $1 AND message_ts = $2
	`, userID, messageTS, now)

	return err
}

// CountUnrepliedMentions returns the count of unreplied mentions for a user
func (r *SlackRepository) CountUnrepliedMentions(ctx context.Context, userID string) (int, error) {
	pool := GetPool()

	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM slack_mentions WHERE user_id = $1 AND replied = FALSE
	`, userID).Scan(&count)

	return count, err
}

// --- User Threads ---

// SaveUserThread saves or updates a thread the user started
func (r *SlackRepository) SaveUserThread(ctx context.Context, thread *models.SlackUserThread) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		INSERT INTO slack_user_threads (user_id, channel_id, thread_ts, message_text, reply_count, has_reply, reminder_sent, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
		ON CONFLICT (user_id, thread_ts) DO UPDATE SET
			reply_count = $5,
			has_reply = $6,
			last_checked_at = NOW()
	`, thread.UserID, thread.ChannelID, thread.ThreadTS, thread.MessageText,
		thread.ReplyCount, thread.HasReply, thread.ReminderSent)

	return err
}

// GetUnansweredThreads returns threads with no replies, newest first
func (r *SlackRepository) GetUnansweredThreads(ctx context.Context, userID string) ([]models.SlackUserThread, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, user_id, channel_id, thread_ts, message_text, reply_count,
		       last_checked_at, has_reply, reminder_sent, snoozed_until, created_at
		FROM slack_user_threads
		WHERE user_id = $1 AND has_reply = FALSE
		ORDER BY created_at DESC
		LIMIT 100
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []models.SlackUserThread
	for rows.Next() {
		var t models.SlackUserThread
		err := rows.Scan(&t.ID, &t.UserID, &t.ChannelID, &t.ThreadTS, &t.MessageText,
			&t.ReplyCount, &t.LastCheckedAt, &t.HasReply, &t.ReminderSent, &t.SnoozedUntil, &t.CreatedAt)
		if err != nil {
			return nil, err
		}
		threads = append(threads, t)
	}
	return threads, nil
}

// GetAllUserThreads returns all threads for a user (with and without replies), newest first
func (r *SlackRepository) GetAllUserThreads(ctx context.Context, userID string, limit int) ([]models.SlackUserThread, error) {
	pool := GetPool()

	if limit <= 0 {
		limit = 50
	}

	rows, err := pool.Query(ctx, `
		SELECT id, user_id, channel_id, thread_ts, message_text, reply_count,
		       last_checked_at, has_reply, reminder_sent, snoozed_until, created_at
		FROM slack_user_threads
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []models.SlackUserThread
	for rows.Next() {
		var t models.SlackUserThread
		err := rows.Scan(&t.ID, &t.UserID, &t.ChannelID, &t.ThreadTS, &t.MessageText,
			&t.ReplyCount, &t.LastCheckedAt, &t.HasReply, &t.ReminderSent, &t.SnoozedUntil, &t.CreatedAt)
		if err != nil {
			return nil, err
		}
		threads = append(threads, t)
	}
	return threads, nil
}

// SnoozeThread sets a snooze time on a user thread
func (r *SlackRepository) SnoozeThread(ctx context.Context, userID, threadTS string, until time.Time) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `
		UPDATE slack_user_threads SET snoozed_until = $3
		WHERE user_id = $1 AND thread_ts = $2
	`, userID, threadTS, until)
	return err
}

// UpdateThreadReplyCount updates reply count and has_reply status for a thread
func (r *SlackRepository) UpdateThreadReplyCount(ctx context.Context, userID, threadTS string, count int, hasReply bool) error {
	pool := GetPool()

	now := time.Now()
	_, err := pool.Exec(ctx, `
		UPDATE slack_user_threads SET reply_count = $3, has_reply = $4, last_checked_at = $5
		WHERE user_id = $1 AND thread_ts = $2
	`, userID, threadTS, count, hasReply, now)

	return err
}

// MarkThreadReminderSent marks a thread as having had a reminder sent
func (r *SlackRepository) MarkThreadReminderSent(ctx context.Context, userID, threadTS string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE slack_user_threads SET reminder_sent = TRUE WHERE user_id = $1 AND thread_ts = $2
	`, userID, threadTS)

	return err
}

// --- Connected Users (for background scanner) ---

// GetAllConnectedSlackUsers returns all user IDs that have an active Slack connection
func (r *SlackRepository) GetAllConnectedSlackUsers(ctx context.Context) ([]string, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT u.id
		FROM users u
		JOIN slack_integrations si ON si.user_id = u.id
		WHERE si.connected = TRUE
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var userIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		userIDs = append(userIDs, id)
	}
	return userIDs, nil
}
