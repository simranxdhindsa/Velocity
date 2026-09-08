package database

import (
	"context"
	"time"
)

// MCPActivityEntry is one logged MCP tools/call transaction.
type MCPActivityEntry struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	UserName    string    `json:"user_name"`
	ToolName    string    `json:"tool_name"`
	ActionLabel string    `json:"action_label"`
	Summary     string    `json:"summary"`
	Success     bool      `json:"success"`
	DurationMs  int       `json:"duration_ms"`
	CreatedAt   time.Time `json:"created_at"`
}

type MCPActivityRepository struct{}

func NewMCPActivityRepository() *MCPActivityRepository {
	return &MCPActivityRepository{}
}

// Log records one MCP tool call. Best-effort — a logging failure must never
// break the actual MCP tool response, so callers should ignore the error
// beyond printing it.
func (r *MCPActivityRepository) Log(ctx context.Context, e MCPActivityEntry) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	var userID *string
	if e.UserID != "" {
		userID = &e.UserID
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO mcp_activity_log (user_id, tool_name, action_label, summary, success, duration_ms)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, userID, e.ToolName, e.ActionLabel, e.Summary, e.Success, e.DurationMs)
	return err
}

// List returns the most recent activity entries (latest first), joined with
// the acting user's display name. limit is capped to a sane maximum.
func (r *MCPActivityRepository) List(ctx context.Context, limit int) ([]MCPActivityEntry, error) {
	pool := GetPool()
	if pool == nil {
		return []MCPActivityEntry{}, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := pool.Query(ctx, `
		SELECT l.id, COALESCE(l.user_id, ''), COALESCE(u.name, 'Unknown user'),
		       l.tool_name, l.action_label, l.summary, l.success, l.duration_ms, l.created_at
		FROM mcp_activity_log l
		LEFT JOIN users u ON u.id = l.user_id
		ORDER BY l.created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	entries := []MCPActivityEntry{}
	for rows.Next() {
		var e MCPActivityEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.UserName, &e.ToolName, &e.ActionLabel,
			&e.Summary, &e.Success, &e.DurationMs, &e.CreatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// PruneOlderThanWeek deletes activity log rows older than 7 days. Called
// periodically by RunMCPActivityPruner so the table never grows unbounded.
func (r *MCPActivityRepository) PruneOlderThanWeek(ctx context.Context) (int64, error) {
	pool := GetPool()
	if pool == nil {
		return 0, nil
	}
	tag, err := pool.Exec(ctx, `DELETE FROM mcp_activity_log WHERE created_at < NOW() - INTERVAL '7 days'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
