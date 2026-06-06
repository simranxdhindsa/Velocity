package database

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/dhindsa/project-management/internal/models"
)

// NotificationRepository handles notification database operations
type NotificationRepository struct{}

// NewNotificationRepository creates a new NotificationRepository
func NewNotificationRepository() *NotificationRepository {
	return &NotificationRepository{}
}

// Create inserts a new notification, suppressing duplicates with the same
// type+title for the same user within 24 hours.
func (r *NotificationRepository) Create(ctx context.Context, notif *models.Notification) error {
	pool := GetPool()

	// user_id is TEXT in the notifications table (migrated from uuid).
	// Use ::text casts throughout to avoid "operator does not exist: text = uuid".
	err := pool.QueryRow(ctx, `
		INSERT INTO notifications (user_id, type, title, message, task_id, read)
		SELECT $1::text, $2::text, $3::text, $4::text, $5::text, false
		WHERE NOT EXISTS (
			SELECT 1 FROM notifications
			WHERE user_id = $1::text AND type = $2::text AND title = $3::text
			  AND created_at > NOW() - INTERVAL '24 hours'
		)
		RETURNING id, created_at
	`, notif.UserID, notif.Type, notif.Title, notif.Message, notif.TaskID).Scan(&notif.ID, &notif.CreatedAt)

	if errors.Is(err, pgx.ErrNoRows) {
		return nil // duplicate within 24 h — silently skip
	}
	return err
}

// GetByUserID retrieves notifications for a user
func (r *NotificationRepository) GetByUserID(ctx context.Context, userID string, limit int) ([]*models.Notification, error) {
	pool := GetPool()

	if limit <= 0 {
		limit = 50
	}

	rows, err := pool.Query(ctx, `
		SELECT id, user_id, type, title, message, task_id, read, created_at
		FROM (
			SELECT DISTINCT ON (type, title, date_trunc('day', created_at))
			       id, user_id, type, title, message, task_id, read, created_at
			FROM notifications
			WHERE user_id = $1
			ORDER BY type, title, date_trunc('day', created_at), created_at DESC
		) deduped
		ORDER BY created_at DESC
		LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var notifications []*models.Notification
	for rows.Next() {
		var notif models.Notification
		err := rows.Scan(&notif.ID, &notif.UserID, &notif.Type, &notif.Title,
			&notif.Message, &notif.TaskID, &notif.Read, &notif.CreatedAt)
		if err != nil {
			return nil, err
		}
		notifications = append(notifications, &notif)
	}

	return notifications, nil
}

// GetUnreadCount returns the count of unread notifications
func (r *NotificationRepository) GetUnreadCount(ctx context.Context, userID string) (int, error) {
	pool := GetPool()

	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM notifications
		WHERE user_id = $1 AND read = false
	`, userID).Scan(&count)

	return count, err
}

// MarkAsRead marks a notification as read
func (r *NotificationRepository) MarkAsRead(ctx context.Context, notifID, userID string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE notifications SET read = true
		WHERE id = $1 AND user_id = $2
	`, notifID, userID)

	return err
}

// MarkAllAsRead marks all notifications as read for a user
func (r *NotificationRepository) MarkAllAsRead(ctx context.Context, userID string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE notifications SET read = true
		WHERE user_id = $1 AND read = false
	`, userID)

	return err
}

// Delete removes a notification
func (r *NotificationRepository) Delete(ctx context.Context, notifID, userID string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		DELETE FROM notifications
		WHERE id = $1 AND user_id = $2
	`, notifID, userID)

	return err
}

// DeleteAll removes all notifications for a user
func (r *NotificationRepository) DeleteAll(ctx context.Context, userID string) (int64, error) {
	pool := GetPool()

	result, err := pool.Exec(ctx, `
		DELETE FROM notifications WHERE user_id = $1
	`, userID)
	if err != nil {
		return 0, err
	}

	return result.RowsAffected(), nil
}

// DeleteOld removes notifications older than specified days
func (r *NotificationRepository) DeleteOld(ctx context.Context, days int) (int64, error) {
	pool := GetPool()

	result, err := pool.Exec(ctx, `
		DELETE FROM notifications
		WHERE created_at < NOW() - INTERVAL '1 day' * $1
	`, days)
	if err != nil {
		return 0, err
	}

	return result.RowsAffected(), nil
}

// CreateBulk creates multiple notifications, suppressing duplicates per user
// with the same type+title within 24 hours.
func (r *NotificationRepository) CreateBulk(ctx context.Context, notifications []*models.Notification) error {
	pool := GetPool()

	for _, notif := range notifications {
		_, err := pool.Exec(ctx, `
			INSERT INTO notifications (user_id, type, title, message, task_id, read)
			SELECT $1, $2, $3, $4, $5, false
			WHERE NOT EXISTS (
				SELECT 1 FROM notifications
				WHERE user_id = $1 AND type = $2 AND title = $3
				  AND created_at > NOW() - INTERVAL '24 hours'
			)
		`, notif.UserID, notif.Type, notif.Title, notif.Message, notif.TaskID)
		if err != nil {
			return err
		}
	}

	return nil
}
