package database

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/dhindsa/project-management/internal/models"
)

// UpdateReminderRepository handles all DB operations for update reminder rules
type UpdateReminderRepository struct{}

func NewUpdateReminderRepository() *UpdateReminderRepository {
	return &UpdateReminderRepository{}
}

// ── Rules ─────────────────────────────────────────────────────────────────────

// ListRules returns all rules for a user. Admins (isAdmin=true) receive all rules.
func (r *UpdateReminderRepository) ListRules(ctx context.Context, userID string, isAdmin bool) ([]*models.UpdateReminderRule, error) {
	pool := GetPool()
	var rows interface{ Close() }

	query := `
		SELECT id, user_id, name, enabled,
		       schedule_time, schedule_days, timezone,
		       source_channel_ids, detection_mode, detection_value,
		       check_day_offset, check_window_start, check_window_end_day_offset, check_window_end,
		       leave_channel_id, leave_channel_name, leave_keywords, leave_action,
		       delivery_channel, delivery_dm, delivery_channel_id, delivery_channel_name,
		       channel_template, dm_template,
		       last_snapshot, last_snapshot_at,
		       created_at, updated_at
		FROM update_reminder_rules`

	var pgRows interface {
		Next() bool
		Scan(...interface{}) error
		Close()
		Err() error
	}

	if isAdmin {
		r2, err := pool.Query(ctx, query+" ORDER BY created_at DESC")
		if err != nil {
			return nil, fmt.Errorf("list all rules: %w", err)
		}
		pgRows = r2
	} else {
		r2, err := pool.Query(ctx, query+" WHERE user_id = $1 ORDER BY created_at DESC", userID)
		if err != nil {
			return nil, fmt.Errorf("list rules: %w", err)
		}
		pgRows = r2
	}
	_ = rows
	defer pgRows.Close()

	var rules []*models.UpdateReminderRule
	for pgRows.Next() {
		rule, err := scanRule(pgRows)
		if err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return rules, pgRows.Err()
}

// GetRule returns a single rule by ID
func (r *UpdateReminderRepository) GetRule(ctx context.Context, id string) (*models.UpdateReminderRule, error) {
	pool := GetPool()
	row := pool.QueryRow(ctx, `
		SELECT id, user_id, name, enabled,
		       schedule_time, schedule_days, timezone,
		       source_channel_ids, detection_mode, detection_value,
		       check_day_offset, check_window_start, check_window_end_day_offset, check_window_end,
		       leave_channel_id, leave_channel_name, leave_keywords, leave_action,
		       delivery_channel, delivery_dm, delivery_channel_id, delivery_channel_name,
		       channel_template, dm_template,
		       last_snapshot, last_snapshot_at,
		       created_at, updated_at
		FROM update_reminder_rules WHERE id = $1`, id)
	return scanRule(row)
}

// GetAllEnabledRules returns all enabled rules across all users (for scheduler)
func (r *UpdateReminderRepository) GetAllEnabledRules(ctx context.Context) ([]*models.UpdateReminderRule, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx, `
		SELECT id, user_id, name, enabled,
		       schedule_time, schedule_days, timezone,
		       source_channel_ids, detection_mode, detection_value,
		       check_day_offset, check_window_start, check_window_end_day_offset, check_window_end,
		       leave_channel_id, leave_channel_name, leave_keywords, leave_action,
		       delivery_channel, delivery_dm, delivery_channel_id, delivery_channel_name,
		       channel_template, dm_template,
		       last_snapshot, last_snapshot_at,
		       created_at, updated_at
		FROM update_reminder_rules WHERE enabled = true`)
	if err != nil {
		return nil, fmt.Errorf("get enabled rules: %w", err)
	}
	defer rows.Close()

	var rules []*models.UpdateReminderRule
	for rows.Next() {
		rule, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

// CreateRule inserts a new rule and returns it with its generated ID
func (r *UpdateReminderRepository) CreateRule(ctx context.Context, userID string, req *models.CreateUpdateReminderRuleRequest) (*models.UpdateReminderRule, error) {
	pool := GetPool()

	scheduleDaysJSON, _ := json.Marshal(req.ScheduleDays)
	sourceChJSON, _ := json.Marshal(req.SourceChannelIDs)
	leaveKWJSON, _ := json.Marshal(req.LeaveKeywords)

	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO update_reminder_rules (
			user_id, name, enabled,
			schedule_time, schedule_days, timezone,
			source_channel_ids, detection_mode, detection_value,
			check_day_offset, check_window_start, check_window_end_day_offset, check_window_end,
			leave_channel_id, leave_channel_name, leave_keywords, leave_action,
			delivery_channel, delivery_dm, delivery_channel_id, delivery_channel_name,
			channel_template, dm_template
		) VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
		) RETURNING id`,
		userID, req.Name, req.Enabled,
		req.ScheduleTime, scheduleDaysJSON, req.Timezone,
		sourceChJSON, string(req.DetectionMode), req.DetectionValue,
		req.CheckDayOffset, req.CheckWindowStart, req.CheckWindowEndDayOffset, req.CheckWindowEnd,
		req.LeaveChannelID, req.LeaveChannelName, leaveKWJSON, string(req.LeaveAction),
		req.DeliveryChannel, req.DeliveryDM, req.DeliveryChannelID, req.DeliveryChannelName,
		req.ChannelTemplate, req.DMTemplate,
	).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("create rule: %w", err)
	}
	return r.GetRule(ctx, id)
}

// UpdateRule replaces all configurable fields on a rule
func (r *UpdateReminderRepository) UpdateRule(ctx context.Context, id string, req *models.CreateUpdateReminderRuleRequest) (*models.UpdateReminderRule, error) {
	pool := GetPool()

	scheduleDaysJSON, _ := json.Marshal(req.ScheduleDays)
	sourceChJSON, _ := json.Marshal(req.SourceChannelIDs)
	leaveKWJSON, _ := json.Marshal(req.LeaveKeywords)

	_, err := pool.Exec(ctx, `
		UPDATE update_reminder_rules SET
			name=$1, enabled=$2,
			schedule_time=$3, schedule_days=$4, timezone=$5,
			source_channel_ids=$6, detection_mode=$7, detection_value=$8,
			check_day_offset=$9, check_window_start=$10, check_window_end_day_offset=$11, check_window_end=$12,
			leave_channel_id=$13, leave_channel_name=$14, leave_keywords=$15, leave_action=$16,
			delivery_channel=$17, delivery_dm=$18, delivery_channel_id=$19, delivery_channel_name=$20,
			channel_template=$21, dm_template=$22,
			updated_at=NOW()
		WHERE id=$23`,
		req.Name, req.Enabled,
		req.ScheduleTime, scheduleDaysJSON, req.Timezone,
		sourceChJSON, string(req.DetectionMode), req.DetectionValue,
		req.CheckDayOffset, req.CheckWindowStart, req.CheckWindowEndDayOffset, req.CheckWindowEnd,
		req.LeaveChannelID, req.LeaveChannelName, leaveKWJSON, string(req.LeaveAction),
		req.DeliveryChannel, req.DeliveryDM, req.DeliveryChannelID, req.DeliveryChannelName,
		req.ChannelTemplate, req.DMTemplate,
		id,
	)
	if err != nil {
		return nil, fmt.Errorf("update rule: %w", err)
	}
	return r.GetRule(ctx, id)
}

// ToggleRule sets enabled=true/false on a rule
func (r *UpdateReminderRepository) ToggleRule(ctx context.Context, id string, enabled bool) error {
	pool := GetPool()
	_, err := pool.Exec(ctx,
		`UPDATE update_reminder_rules SET enabled=$1, updated_at=NOW() WHERE id=$2`,
		enabled, id)
	return err
}

// DeleteRule removes a rule and cascades to roster + runs
func (r *UpdateReminderRepository) DeleteRule(ctx context.Context, id string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `DELETE FROM update_reminder_rules WHERE id=$1`, id)
	return err
}

// SaveSnapshot updates last_snapshot and last_snapshot_at on a rule
func (r *UpdateReminderRepository) SaveSnapshot(ctx context.Context, ruleID string, snap *models.UpdateReminderSnapshot) error {
	pool := GetPool()
	snapJSON, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx,
		`UPDATE update_reminder_rules SET last_snapshot=$1, last_snapshot_at=NOW(), updated_at=NOW() WHERE id=$2`,
		snapJSON, ruleID)
	return err
}

// ── Roster ────────────────────────────────────────────────────────────────────

// ListRoster returns all members for a rule
func (r *UpdateReminderRepository) ListRoster(ctx context.Context, ruleID string) ([]*models.UpdateReminderRosterMember, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT id, rule_id, display_name, slack_user_id, enabled, created_at
		 FROM update_reminder_roster WHERE rule_id=$1 ORDER BY created_at ASC`, ruleID)
	if err != nil {
		return nil, fmt.Errorf("list roster: %w", err)
	}
	defer rows.Close()

	var members []*models.UpdateReminderRosterMember
	for rows.Next() {
		m := &models.UpdateReminderRosterMember{}
		if err := rows.Scan(&m.ID, &m.RuleID, &m.DisplayName, &m.SlackUserID, &m.Enabled, &m.CreatedAt); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

// AddRosterMember inserts one member into a rule's roster
func (r *UpdateReminderRepository) AddRosterMember(ctx context.Context, ruleID string, req *models.AddRosterMemberRequest) (*models.UpdateReminderRosterMember, error) {
	pool := GetPool()
	m := &models.UpdateReminderRosterMember{}
	err := pool.QueryRow(ctx, `
		INSERT INTO update_reminder_roster (rule_id, display_name, slack_user_id, enabled)
		VALUES ($1, $2, $3, $4)
		RETURNING id, rule_id, display_name, slack_user_id, enabled, created_at`,
		ruleID, req.DisplayName, req.SlackUserID, req.Enabled,
	).Scan(&m.ID, &m.RuleID, &m.DisplayName, &m.SlackUserID, &m.Enabled, &m.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("add roster member: %w", err)
	}
	return m, nil
}

// UpdateRosterMember patches display_name and/or enabled on a member
func (r *UpdateReminderRepository) UpdateRosterMember(ctx context.Context, memberID string, req *models.UpdateRosterMemberRequest) (*models.UpdateReminderRosterMember, error) {
	pool := GetPool()
	m := &models.UpdateReminderRosterMember{}
	err := pool.QueryRow(ctx, `
		UPDATE update_reminder_roster
		SET display_name = COALESCE($1, display_name),
		    enabled      = COALESCE($2, enabled)
		WHERE id = $3
		RETURNING id, rule_id, display_name, slack_user_id, enabled, created_at`,
		req.DisplayName, req.Enabled, memberID,
	).Scan(&m.ID, &m.RuleID, &m.DisplayName, &m.SlackUserID, &m.Enabled, &m.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("update roster member: %w", err)
	}
	return m, nil
}

// DeleteRosterMember removes one member from a rule's roster
func (r *UpdateReminderRepository) DeleteRosterMember(ctx context.Context, memberID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `DELETE FROM update_reminder_roster WHERE id=$1`, memberID)
	return err
}

// ── Run history ───────────────────────────────────────────────────────────────

// SaveRun inserts a new run log entry
func (r *UpdateReminderRepository) SaveRun(ctx context.Context, run *models.UpdateReminderRun) (*models.UpdateReminderRun, error) {
	pool := GetPool()

	postedJSON, _ := json.Marshal(run.PostedNames)
	onLeaveJSON, _ := json.Marshal(run.OnLeaveNames)
	skippedJSON, _ := json.Marshal(run.SkippedNames)
	deliveredJSON, _ := json.Marshal(run.DeliveredTo)
	var snapJSON []byte
	if run.SnapshotUsed != nil {
		snapJSON, _ = json.Marshal(run.SnapshotUsed)
	}

	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO update_reminder_runs (
			rule_id, user_id, triggered_by,
			posted_names, on_leave_names, skipped_names, delivered_to,
			error, snapshot_used, expires_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id`,
		run.RuleID, run.UserID, string(run.TriggeredBy),
		postedJSON, onLeaveJSON, skippedJSON, deliveredJSON,
		run.Error, nullableJSON(snapJSON), run.ExpiresAt,
	).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("save run: %w", err)
	}
	run.ID = id
	return run, nil
}

// ListRuns returns run history for a rule (newest first, last 30 days)
func (r *UpdateReminderRepository) ListRuns(ctx context.Context, ruleID string) ([]*models.UpdateReminderRun, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx, `
		SELECT id, rule_id, user_id, triggered_by,
		       ran_at, posted_names, on_leave_names, skipped_names, delivered_to,
		       error, snapshot_used, expires_at
		FROM update_reminder_runs
		WHERE rule_id=$1 AND expires_at > NOW()
		ORDER BY ran_at DESC`, ruleID)
	if err != nil {
		return nil, fmt.Errorf("list runs: %w", err)
	}
	defer rows.Close()

	var runs []*models.UpdateReminderRun
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

// PurgeExpiredRuns deletes run log entries older than 30 days (called by scheduler)
func (r *UpdateReminderRepository) PurgeExpiredRuns(ctx context.Context) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `DELETE FROM update_reminder_runs WHERE expires_at < NOW()`)
	return err
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type scanner interface {
	Scan(...interface{}) error
}

func scanRule(s scanner) (*models.UpdateReminderRule, error) {
	rule := &models.UpdateReminderRule{}
	var (
		scheduleDaysRaw  []byte
		sourceChRaw      []byte
		leaveKWRaw       []byte
		lastSnapRaw      []byte
		detectionMode    string
		leaveAction      string
	)
	err := s.Scan(
		&rule.ID, &rule.UserID, &rule.Name, &rule.Enabled,
		&rule.ScheduleTime, &scheduleDaysRaw, &rule.Timezone,
		&sourceChRaw, &detectionMode, &rule.DetectionValue,
		&rule.CheckDayOffset, &rule.CheckWindowStart, &rule.CheckWindowEndDayOffset, &rule.CheckWindowEnd,
		&rule.LeaveChannelID, &rule.LeaveChannelName, &leaveKWRaw, &leaveAction,
		&rule.DeliveryChannel, &rule.DeliveryDM, &rule.DeliveryChannelID, &rule.DeliveryChannelName,
		&rule.ChannelTemplate, &rule.DMTemplate,
		&lastSnapRaw, &rule.LastSnapshotAt,
		&rule.CreatedAt, &rule.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("scan rule: %w", err)
	}

	rule.DetectionMode = models.UpdateReminderDetectionMode(detectionMode)
	rule.LeaveAction = models.UpdateReminderLeaveAction(leaveAction)

	if err := json.Unmarshal(scheduleDaysRaw, &rule.ScheduleDays); err != nil {
		rule.ScheduleDays = []int{}
	}
	if err := json.Unmarshal(sourceChRaw, &rule.SourceChannelIDs); err != nil {
		rule.SourceChannelIDs = []models.ChannelRef{}
	}
	if err := json.Unmarshal(leaveKWRaw, &rule.LeaveKeywords); err != nil {
		rule.LeaveKeywords = []string{}
	}
	if len(lastSnapRaw) > 0 && string(lastSnapRaw) != "null" {
		rule.LastSnapshot = &models.UpdateReminderSnapshot{}
		_ = json.Unmarshal(lastSnapRaw, rule.LastSnapshot)
	}
	return rule, nil
}

func scanRun(s scanner) (*models.UpdateReminderRun, error) {
	run := &models.UpdateReminderRun{}
	var (
		triggeredBy  string
		postedRaw    []byte
		onLeaveRaw   []byte
		skippedRaw   []byte
		deliveredRaw []byte
		snapRaw      []byte
	)
	err := s.Scan(
		&run.ID, &run.RuleID, &run.UserID, &triggeredBy,
		&run.RanAt, &postedRaw, &onLeaveRaw, &skippedRaw, &deliveredRaw,
		&run.Error, &snapRaw, &run.ExpiresAt,
	)
	if err != nil {
		return nil, fmt.Errorf("scan run: %w", err)
	}
	run.TriggeredBy = models.UpdateReminderTriggeredBy(triggeredBy)
	_ = json.Unmarshal(postedRaw, &run.PostedNames)
	_ = json.Unmarshal(onLeaveRaw, &run.OnLeaveNames)
	_ = json.Unmarshal(skippedRaw, &run.SkippedNames)
	_ = json.Unmarshal(deliveredRaw, &run.DeliveredTo)
	if len(snapRaw) > 0 && string(snapRaw) != "null" {
		run.SnapshotUsed = &models.UpdateReminderSnapshot{}
		_ = json.Unmarshal(snapRaw, run.SnapshotUsed)
	}
	return run, nil
}

// nullableJSON returns nil if the byte slice is empty, otherwise the slice itself
func nullableJSON(b []byte) interface{} {
	if len(b) == 0 {
		return nil
	}
	return b
}

// PurgeExpiredRunsOlderThan30Days is called on each scheduler tick
func PurgeUpdateReminderRuns(ctx context.Context) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	_, err := pool.Exec(ctx, `DELETE FROM update_reminder_runs WHERE expires_at < NOW()`)
	return err
}

// ExpiresAt helper: 30 days from now
func UpdateReminderRunExpiresAt() time.Time {
	return time.Now().AddDate(0, 0, 30)
}
