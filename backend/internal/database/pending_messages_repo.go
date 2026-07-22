package database

import (
	"context"
	"time"
)

type PendingMessagesRepository struct{}

func NewPendingMessagesRepository() *PendingMessagesRepository {
	return &PendingMessagesRepository{}
}

type PendingSlackMessage struct {
	ID           string     `json:"id"`
	UserID       string     `json:"user_id"`
	Message      string     `json:"message"`
	ChannelID    string     `json:"channel_id"`
	ChannelLabel string     `json:"channel_label"`
	DmUserID     string     `json:"dm_user_id"`
	ScheduledAt  *time.Time `json:"scheduled_at"`
	Status       string     `json:"status"`
	SlackTs      string     `json:"slack_ts"`
	ErrorMessage string     `json:"error_message"`
	CreatedAt    time.Time  `json:"created_at"`
	SentAt       *time.Time `json:"sent_at"`
}

func (r *PendingMessagesRepository) Create(ctx context.Context, userID, message, channelID, channelLabel, dmUserID string, scheduledAt *time.Time) (*PendingSlackMessage, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	m := &PendingSlackMessage{}
	err := pool.QueryRow(ctx, `
		INSERT INTO pending_slack_messages
			(user_id, message, channel_id, channel_label, dm_user_id, scheduled_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id::text, user_id, message, channel_id, channel_label, dm_user_id,
		          scheduled_at, status, slack_ts, COALESCE(error_message,''), created_at, sent_at
	`, userID, message, channelID, channelLabel, dmUserID, scheduledAt).Scan(
		&m.ID, &m.UserID, &m.Message, &m.ChannelID, &m.ChannelLabel, &m.DmUserID,
		&m.ScheduledAt, &m.Status, &m.SlackTs, &m.ErrorMessage, &m.CreatedAt, &m.SentAt,
	)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func (r *PendingMessagesRepository) ListByUser(ctx context.Context, userID string) ([]PendingSlackMessage, error) {
	pool := GetPool()
	if pool == nil {
		return []PendingSlackMessage{}, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text, user_id, message, channel_id, channel_label, dm_user_id,
		       scheduled_at, status, slack_ts, COALESCE(error_message,''), created_at, sent_at
		FROM pending_slack_messages
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT 50
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []PendingSlackMessage
	for rows.Next() {
		var m PendingSlackMessage
		if err := rows.Scan(
			&m.ID, &m.UserID, &m.Message, &m.ChannelID, &m.ChannelLabel, &m.DmUserID,
			&m.ScheduledAt, &m.Status, &m.SlackTs, &m.ErrorMessage, &m.CreatedAt, &m.SentAt,
		); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	if msgs == nil {
		msgs = []PendingSlackMessage{}
	}
	return msgs, nil
}

// GetDueMessages atomically claims due pending messages by flipping their status to
// 'processing', preventing race conditions when the scheduler and a delete overlap.
// A message is due when:
//   - It has a scheduled_at in the past AND has a destination (channel or DM user)
//   - OR it has no scheduled_at, has a destination, and the user's default send time has passed today
func (r *PendingMessagesRepository) GetDueMessages(ctx context.Context) ([]PendingSlackMessage, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	rows, err := pool.Query(ctx, `
		UPDATE pending_slack_messages psm
		SET status = 'processing'
		WHERE psm.status = 'pending'
		AND (psm.channel_id != '' OR psm.dm_user_id != '')
		AND (
			-- Explicitly scheduled: send when past due
			(psm.scheduled_at IS NOT NULL AND psm.scheduled_at <= NOW())
			OR
			-- No schedule: send at user's default send time once it has passed today
			(psm.scheduled_at IS NULL
			 AND EXISTS (
			     SELECT 1 FROM user_mcp_tokens mt
			     WHERE mt.user_id = psm.user_id
			       AND mt.default_send_time IS NOT NULL
			       AND mt.default_send_time != ''
			       AND NOW()::time >= mt.default_send_time::time
			 ))
		)
		RETURNING psm.id::text, psm.user_id, psm.message, psm.channel_id, psm.channel_label, psm.dm_user_id,
		          psm.scheduled_at, psm.status, psm.slack_ts, COALESCE(psm.error_message,''), psm.created_at, psm.sent_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []PendingSlackMessage
	for rows.Next() {
		var m PendingSlackMessage
		if err := rows.Scan(
			&m.ID, &m.UserID, &m.Message, &m.ChannelID, &m.ChannelLabel, &m.DmUserID,
			&m.ScheduledAt, &m.Status, &m.SlackTs, &m.ErrorMessage, &m.CreatedAt, &m.SentAt,
		); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	return msgs, nil
}

func (r *PendingMessagesRepository) Update(ctx context.Context, id, userID, message string, scheduledAt *time.Time, channelID, channelLabel, dmUserID string) (*PendingSlackMessage, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	m := &PendingSlackMessage{}
	err := pool.QueryRow(ctx, `
		UPDATE pending_slack_messages
		SET message      = $3,
		    scheduled_at = CASE WHEN $4::timestamptz IS NOT NULL THEN $4::timestamptz ELSE scheduled_at END,
		    channel_id   = CASE WHEN $5 != '' THEN $5 ELSE channel_id END,
		    channel_label= CASE WHEN $6 != '' THEN $6 ELSE channel_label END,
		    dm_user_id   = CASE WHEN $7 != '' THEN $7 ELSE dm_user_id END
		WHERE id::text = $1 AND user_id = $2 AND status = 'pending'
		RETURNING id::text, user_id, message, channel_id, channel_label, dm_user_id,
		          scheduled_at, status, slack_ts, COALESCE(error_message,''), created_at, sent_at
	`, id, userID, message, scheduledAt, channelID, channelLabel, dmUserID).Scan(
		&m.ID, &m.UserID, &m.Message, &m.ChannelID, &m.ChannelLabel, &m.DmUserID,
		&m.ScheduledAt, &m.Status, &m.SlackTs, &m.ErrorMessage, &m.CreatedAt, &m.SentAt,
	)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func (r *PendingMessagesRepository) Delete(ctx context.Context, id, userID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		DELETE FROM pending_slack_messages
		WHERE id::text = $1 AND user_id = $2
	`, id, userID)
	return err
}

func (r *PendingMessagesRepository) MarkSent(ctx context.Context, id, slackTs string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE pending_slack_messages
		SET status = 'sent', slack_ts = $2, sent_at = NOW()
		WHERE id::text = $1
	`, id, slackTs)
	return err
}

func (r *PendingMessagesRepository) MarkFailed(ctx context.Context, id, errMsg string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE pending_slack_messages
		SET status = 'failed', error_message = $2
		WHERE id::text = $1
	`, id, errMsg)
	return err
}
