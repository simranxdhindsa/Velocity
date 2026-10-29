package database

import (
	"context"
)

type IgnoredBlockedRepository struct{}

func NewIgnoredBlockedRepository() *IgnoredBlockedRepository {
	return &IgnoredBlockedRepository{}
}

// IgnoreTicket parks a blocked ticket for a user (idempotent).
func (r *IgnoredBlockedRepository) IgnoreTicket(ctx context.Context, userID, issueID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO user_ignored_blocked_tickets (user_id, issue_id)
		VALUES ($1, $2)
		ON CONFLICT (user_id, issue_id) DO NOTHING
	`, userID, issueID)
	return err
}

// UnignoreTicket restores a parked ticket.
func (r *IgnoredBlockedRepository) UnignoreTicket(ctx context.Context, userID, issueID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		DELETE FROM user_ignored_blocked_tickets
		WHERE user_id = $1 AND issue_id = $2
	`, userID, issueID)
	return err
}

// GetIgnoredIDs returns all parked issue IDs for a user.
func (r *IgnoredBlockedRepository) GetIgnoredIDs(ctx context.Context, userID string) ([]string, error) {
	pool := GetPool()
	if pool == nil {
		return []string{}, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT issue_id FROM user_ignored_blocked_tickets
		WHERE user_id = $1
		ORDER BY ignored_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if ids == nil {
		ids = []string{}
	}
	return ids, nil
}
