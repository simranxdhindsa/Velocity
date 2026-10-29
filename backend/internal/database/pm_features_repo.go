package database

import (
	"context"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type BurndownSnapshot struct {
	SprintID   string `json:"sprint_id"`
	SprintName string `json:"sprint_name"`
	Date       string `json:"date"`
	Total      int    `json:"total"`
	Completed  int    `json:"completed"`
}

type CapacityRow struct {
	ID            string  `json:"id"`
	SprintID      string  `json:"sprint_id"`
	SprintName    string  `json:"sprint_name"`
	AssigneeName  string  `json:"assignee_name"`
	AvailableDays float64 `json:"available_days"`
	Notes         string  `json:"notes"`
}

type BlockerRecord struct {
	IssueID      string    `json:"issue_id"`
	Summary      string    `json:"summary"`
	Assignee     string    `json:"assignee"`
	BlockedSince time.Time `json:"blocked_since"`
	Reason       string    `json:"reason"`
}

type EscalationConfig struct {
	SLAHours           float64 `json:"sla_hours"`
	NotifySlackChannel string  `json:"notify_slack_channel"`
	AutoNotify         bool    `json:"auto_notify"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository
// ─────────────────────────────────────────────────────────────────────────────

type PMFeaturesRepository struct{}

func NewPMFeaturesRepository() *PMFeaturesRepository {
	return &PMFeaturesRepository{}
}

// ── Burndown snapshots ────────────────────────────────────────────────────────

func (r *PMFeaturesRepository) UpsertBurndownSnapshot(ctx context.Context, sprintID, sprintName, date string, total, completed int) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO pm_burndown_snapshots (sprint_id, sprint_name, date, total, completed)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (sprint_id, date) DO UPDATE
		  SET total=$4, completed=$5, sprint_name=$2`,
		sprintID, sprintName, date, total, completed)
	return err
}

func (r *PMFeaturesRepository) GetBurndownSnapshots(ctx context.Context, sprintID string) ([]BurndownSnapshot, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	rows, err := pool.Query(ctx,
		`SELECT sprint_id, sprint_name, date, total, completed
		 FROM pm_burndown_snapshots
		 WHERE sprint_id=$1
		 ORDER BY date ASC`,
		sprintID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []BurndownSnapshot
	for rows.Next() {
		var s BurndownSnapshot
		var dateVal time.Time
		if err := rows.Scan(&s.SprintID, &s.SprintName, &dateVal, &s.Total, &s.Completed); err != nil {
			return nil, err
		}
		s.Date = dateVal.Format("2006-01-02")
		result = append(result, s)
	}
	return result, rows.Err()
}

// ── Capacity planner ──────────────────────────────────────────────────────────

func (r *PMFeaturesRepository) UpsertCapacity(ctx context.Context, userID, sprintID, sprintName, assigneeName string, availableDays float64, notes string) (string, error) {
	pool := GetPool()
	if pool == nil {
		return "", nil
	}
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO pm_sprint_capacity (user_id, sprint_id, sprint_name, assignee_name, available_days, notes)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (user_id, sprint_id, assignee_name) DO UPDATE
		  SET available_days=$5, notes=$6, sprint_name=$3
		RETURNING id`,
		userID, sprintID, sprintName, assigneeName, availableDays, notes).Scan(&id)
	return id, err
}

func (r *PMFeaturesRepository) GetCapacity(ctx context.Context, userID, sprintID string) ([]CapacityRow, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	query := `SELECT id, sprint_id, sprint_name, assignee_name, available_days, COALESCE(notes,'')
	          FROM pm_sprint_capacity WHERE user_id=$1`
	args := []interface{}{userID}
	if sprintID != "" {
		query += ` AND sprint_id=$2`
		args = append(args, sprintID)
	}
	query += ` ORDER BY assignee_name`

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []CapacityRow
	for rows.Next() {
		var cr CapacityRow
		if err := rows.Scan(&cr.ID, &cr.SprintID, &cr.SprintName, &cr.AssigneeName, &cr.AvailableDays, &cr.Notes); err != nil {
			return nil, err
		}
		result = append(result, cr)
	}
	return result, rows.Err()
}

func (r *PMFeaturesRepository) DeleteCapacity(ctx context.Context, userID, id string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `DELETE FROM pm_sprint_capacity WHERE id=$1 AND user_id=$2`, id, userID)
	return err
}

// ── Active blockers (fed by the existing blocker detection background job) ────

func (r *PMFeaturesRepository) GetActiveBlockers(ctx context.Context, userID string) ([]BlockerRecord, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	// Read from issue_state_log: issues currently in a blocked state.
	// "Currently blocked" = their latest transition is a blocked state.
	rows, err := pool.Query(ctx, `
		WITH latest AS (
		  SELECT DISTINCT ON (issue_id)
		    issue_id, issue_summary, assignee, transitioned_at,
		    COALESCE(comment, '') AS reason, to_state
		  FROM issue_state_log
		  ORDER BY issue_id, transitioned_at DESC
		)
		SELECT issue_id, issue_summary, COALESCE(assignee,''), transitioned_at, reason
		FROM latest
		WHERE LOWER(to_state) LIKE '%block%'
		ORDER BY transitioned_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []BlockerRecord
	for rows.Next() {
		var b BlockerRecord
		if err := rows.Scan(&b.IssueID, &b.Summary, &b.Assignee, &b.BlockedSince, &b.Reason); err != nil {
			return nil, err
		}
		result = append(result, b)
	}
	return result, rows.Err()
}

// ── Escalation config ─────────────────────────────────────────────────────────

func (r *PMFeaturesRepository) GetEscalationConfig(ctx context.Context, userID string) (*EscalationConfig, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	var cfg EscalationConfig
	err := pool.QueryRow(ctx,
		`SELECT sla_hours, COALESCE(notify_slack_channel,''), auto_notify
		 FROM pm_escalation_config WHERE user_id=$1`, userID).
		Scan(&cfg.SLAHours, &cfg.NotifySlackChannel, &cfg.AutoNotify)
	if err != nil {
		return nil, nil // row not found → caller uses defaults
	}
	return &cfg, nil
}

func (r *PMFeaturesRepository) UpsertEscalationConfig(ctx context.Context, userID string, slaHours float64, channel string, autoNotify bool) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO pm_escalation_config (user_id, sla_hours, notify_slack_channel, auto_notify)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (user_id) DO UPDATE
		  SET sla_hours=$2, notify_slack_channel=$3, auto_notify=$4`,
		userID, slaHours, channel, autoNotify)
	return err
}
