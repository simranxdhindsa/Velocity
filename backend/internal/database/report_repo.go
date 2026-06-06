package database

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// IssueStateLog represents one state transition for a YouTrack issue (or Asana section transition)
type IssueStateLog struct {
	ID                       string     `json:"id"`
	IssueID                  string     `json:"issue_id"`
	IssueSummary             string     `json:"issue_summary"`
	Assignee                 string     `json:"assignee"`
	MovedBy                  string     `json:"moved_by"`
	FromState                string     `json:"from_state"`
	ToState                  string     `json:"to_state"`
	Priority                 string     `json:"priority"`
	TransitionedAt           time.Time  `json:"transitioned_at"`
	DurationInPrevStateHours *float64   `json:"duration_in_prev_state_hours"`
	Comment                  string     `json:"comment"`            // comment at transition time (backward moves)
	IssueType                string     `json:"issue_type"`         // YouTrack type field value (e.g. "Hotfix", "Regression")
	MovedByMismatch          bool       `json:"moved_by_mismatch"`
	DueDate                  *time.Time `json:"due_date,omitempty"` // Asana: task due date for overdue detection
}

// PMReport represents a saved daily or weekly PM report
type PMReport struct {
	ID           string    `json:"id"`
	Date         string    `json:"date"`
	ReportType   string    `json:"report_type"` // "daily" or "weekly"
	ReportText   string    `json:"report_text"`
	DoneCount    int       `json:"done_count"`
	OpenCount    int       `json:"open_count"`
	BlockedCount int       `json:"blocked_count"`
	GeneratedAt  time.Time `json:"generated_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// AssigneeStat represents aggregated stats for one assignee
type AssigneeStat struct {
	Assignee   string  `json:"assignee"`
	Open       int     `json:"open"`
	InProgress int     `json:"in_progress"`
	Done       int     `json:"done"`
	Blocked    int     `json:"blocked"`
	AvgHoursInProgress *float64 `json:"avg_hours_in_progress"`
}

// ReportRepository handles reporting database operations
type ReportRepository struct{}

// NewReportRepository creates a new ReportRepository
func NewReportRepository() *ReportRepository {
	return &ReportRepository{}
}

// ResetStateLog deletes ALL rows from issue_state_log.
// Used to clear stale backfill data so tracking can start fresh from live webhooks.
func (r *ReportRepository) ResetStateLog(ctx context.Context) (int64, error) {
	pool := GetPool()
	tag, err := pool.Exec(ctx, `DELETE FROM issue_state_log`)
	if err != nil {
		return 0, fmt.Errorf("failed to reset state log: %w", err)
	}
	return tag.RowsAffected(), nil
}

// IsCurrentlyInProgress returns true if the issue has an active In Progress entry
// (entered In Progress but not yet exited). Used for backfill idempotency.
func (r *ReportRepository) IsCurrentlyInProgress(ctx context.Context, issueID string) (bool, error) {
	pool := GetPool()
	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM issue_state_log
		WHERE issue_id = $1
		  AND LOWER(to_state) = 'in progress'
		  AND issue_id NOT IN (
			SELECT issue_id FROM issue_state_log WHERE LOWER(from_state) = 'in progress'
		  )
	`, issueID).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// InsertStateLog inserts a new state transition record
func (r *ReportRepository) InsertStateLog(ctx context.Context, log *IssueStateLog) error {
	pool := GetPool()

	// Compute duration from previous state if there's an existing log entry
	var durationHours *float64
	if log.FromState != "" {
		var lastTransitionedAt *time.Time
		err := pool.QueryRow(ctx, `
			SELECT transitioned_at FROM issue_state_log
			WHERE issue_id = $1 AND to_state = $2
			ORDER BY transitioned_at DESC
			LIMIT 1
		`, log.IssueID, log.FromState).Scan(&lastTransitionedAt)
		if err == nil && lastTransitionedAt != nil {
			d := log.TransitionedAt.Sub(*lastTransitionedAt).Hours()
			durationHours = &d
		}
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO issue_state_log (issue_id, issue_summary, assignee, moved_by, from_state, to_state, priority, transitioned_at, duration_in_prev_state_hours, comment, issue_type)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`, log.IssueID, log.IssueSummary, log.Assignee, log.MovedBy, log.FromState, log.ToState, log.Priority, log.TransitionedAt, durationHours, log.Comment, log.IssueType)
	if err != nil {
		return fmt.Errorf("failed to insert state log: %w", err)
	}
	return nil
}

// InsertStateLogIfNotExists inserts a state transition only if no row with the
// same activityID already exists in the comment field (used as dedup key for
// the history import). Returns an error (without wrapping) if the row exists.
func (r *ReportRepository) InsertStateLogIfNotExists(ctx context.Context, log *IssueStateLog, activityID string) error {
	pool := GetPool()

	// Check whether this activity was already imported
	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM issue_state_log
		WHERE comment = $1
	`, "activity:"+activityID).Scan(&count)
	if err != nil {
		return fmt.Errorf("dedup check failed: %w", err)
	}
	if count > 0 {
		return fmt.Errorf("already exists")
	}

	// Compute duration from the previous In-Progress entry recorded just before this one
	var durationHours *float64
	if log.FromState != "" {
		var lastTransitionedAt *time.Time
		err := pool.QueryRow(ctx, `
			SELECT transitioned_at FROM issue_state_log
			WHERE issue_id = $1 AND to_state = $2
			ORDER BY transitioned_at DESC
			LIMIT 1
		`, log.IssueID, log.FromState).Scan(&lastTransitionedAt)
		if err == nil && lastTransitionedAt != nil {
			d := log.TransitionedAt.Sub(*lastTransitionedAt).Hours()
			durationHours = &d
		}
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO issue_state_log (issue_id, issue_summary, assignee, moved_by, from_state, to_state, priority, transitioned_at, duration_in_prev_state_hours, comment, issue_type)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`, log.IssueID, log.IssueSummary, log.Assignee, log.MovedBy, log.FromState, log.ToState, log.Priority, log.TransitionedAt, durationHours, log.Comment, log.IssueType)
	if err != nil {
		return fmt.Errorf("failed to insert state log: %w", err)
	}
	return nil
}

// scanStateLog scans a row into IssueStateLog and computes MovedByMismatch
// Column order must match all SELECT queries: id, issue_id, issue_summary, assignee, moved_by,
// from_state, to_state, priority, transitioned_at, duration_in_prev_state_hours, comment, issue_type
func scanStateLog(rows interface {
	Scan(dest ...interface{}) error
}) (IssueStateLog, error) {
	var l IssueStateLog
	err := rows.Scan(
		&l.ID, &l.IssueID, &l.IssueSummary,
		&l.Assignee, &l.MovedBy,
		&l.FromState, &l.ToState, &l.Priority,
		&l.TransitionedAt, &l.DurationInPrevStateHours, &l.Comment, &l.IssueType,
	)
	if err == nil && l.Assignee != "" && l.MovedBy != "" && l.Assignee != l.MovedBy {
		l.MovedByMismatch = true
	}
	return l, err
}

// GetStateLogForIssue returns the full state transition history for one issue
func (r *ReportRepository) GetStateLogForIssue(ctx context.Context, issueID string) ([]IssueStateLog, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, issue_id, issue_summary,
		       COALESCE(assignee,''), COALESCE(moved_by,''),
		       COALESCE(from_state,''), to_state, COALESCE(priority,''),
		       transitioned_at, duration_in_prev_state_hours, COALESCE(comment,''), COALESCE(issue_type,'')
		FROM issue_state_log
		WHERE issue_id = $1
		ORDER BY transitioned_at ASC
	`, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IssueStateLog
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// GetStateLogsForIssues batch-fetches the most recent state log entry for each issue in one query.
// Returns a map of issueID → most recent IssueStateLog entry (the one matching current state).
func (r *ReportRepository) GetStateLogsForIssues(ctx context.Context, issueIDs []string) (map[string][]IssueStateLog, error) {
	if len(issueIDs) == 0 {
		return map[string][]IssueStateLog{}, nil
	}
	pool := GetPool()

	// Build $1,$2,... placeholders
	placeholders := make([]string, len(issueIDs))
	args := make([]interface{}, len(issueIDs))
	for i, id := range issueIDs {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT id, issue_id, issue_summary,
		       COALESCE(assignee,''), COALESCE(moved_by,''),
		       COALESCE(from_state,''), to_state, COALESCE(priority,''),
		       transitioned_at, duration_in_prev_state_hours, COALESCE(comment,''), COALESCE(issue_type,'')
		FROM issue_state_log
		WHERE issue_id = ANY(ARRAY[%s]::text[])
		ORDER BY issue_id, transitioned_at ASC
	`, strings.Join(placeholders, ","))

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := map[string][]IssueStateLog{}
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		result[l.IssueID] = append(result[l.IssueID], l)
	}
	return result, nil
}

// GetDoneIssues returns issues that moved to a "done" state on a specific date.
// doneStates is a list of state names that count as "done" (e.g. ["DEV", "dev"]).
// Falls back to ["dev"] if doneStates is empty.
func (r *ReportRepository) GetDoneIssues(ctx context.Context, date string, doneStates []string) ([]IssueStateLog, error) {
	pool := GetPool()

	if len(doneStates) == 0 {
		doneStates = []string{"dev"}
	}

	// Build lowercase version for comparison
	lowerStates := make([]string, len(doneStates))
	for i, s := range doneStates {
		lowerStates[i] = strings.ToLower(s)
	}

	rows, err := pool.Query(ctx, `
		SELECT id, issue_id, issue_summary,
		       COALESCE(assignee,''), COALESCE(moved_by,''),
		       COALESCE(from_state,''), to_state, COALESCE(priority,''),
		       transitioned_at, duration_in_prev_state_hours, COALESCE(comment,''), COALESCE(issue_type,'')
		FROM issue_state_log isl
		WHERE LOWER(to_state) = ANY($2::text[])
		  AND date(transitioned_at) = $1::date
		  AND NOT EXISTS (
		      SELECT 1 FROM issue_state_log later
		      WHERE later.issue_id = isl.issue_id
		        AND LOWER(later.from_state) = ANY($2::text[])
		        AND later.transitioned_at > isl.transitioned_at
		  )
		ORDER BY transitioned_at DESC
	`, date, lowerStates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IssueStateLog
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// GetDoneIssuesForWeek returns issues that moved to a "done" state during a Mon–Sun week,
// sorted by assignee. doneStates defaults to ["dev"] if empty.
func (r *ReportRepository) GetDoneIssuesForWeek(ctx context.Context, weekStart, weekEnd string, doneStates []string) ([]IssueStateLog, error) {
	pool := GetPool()

	if len(doneStates) == 0 {
		doneStates = []string{"dev"}
	}
	lowerStates := make([]string, len(doneStates))
	for i, s := range doneStates {
		lowerStates[i] = strings.ToLower(s)
	}

	rows, err := pool.Query(ctx, `
		SELECT id, issue_id, issue_summary,
		       COALESCE(assignee,''), COALESCE(moved_by,''),
		       COALESCE(from_state,''), to_state, COALESCE(priority,''),
		       transitioned_at, duration_in_prev_state_hours, COALESCE(comment,''), COALESCE(issue_type,'')
		FROM issue_state_log isl
		WHERE LOWER(to_state) = ANY($3::text[])
		  AND date(transitioned_at) >= $1::date
		  AND date(transitioned_at) <= $2::date
		  AND NOT EXISTS (
		      SELECT 1 FROM issue_state_log later
		      WHERE later.issue_id = isl.issue_id
		        AND LOWER(later.from_state) = ANY($3::text[])
		        AND later.transitioned_at > isl.transitioned_at
		  )
		ORDER BY assignee ASC, transitioned_at DESC
	`, weekStart, weekEnd, lowerStates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IssueStateLog
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// GetHotfixIssues returns tickets that jumped directly from fromStates to toStates on a date.
// fromStates defaults to ["backlog","in progress"], toStates to ["ready for stage","stage","ready for prod","prod"].
// hotfixTypeValues are optional issue_type values that also qualify as hotfixes (field-based classification).
func (r *ReportRepository) GetHotfixIssues(ctx context.Context, date string, fromStates, toStates, hotfixTypeValues []string) ([]IssueStateLog, error) {
	pool := GetPool()

	if len(fromStates) == 0 {
		fromStates = []string{"backlog", "in progress"}
	}
	if len(toStates) == 0 {
		toStates = []string{"ready for stage", "stage", "ready for prod", "prod"}
	}
	lowerFrom := make([]string, len(fromStates))
	for i, s := range fromStates {
		lowerFrom[i] = strings.ToLower(s)
	}
	lowerTo := make([]string, len(toStates))
	for i, s := range toStates {
		lowerTo[i] = strings.ToLower(s)
	}
	lowerTypeVals := make([]string, len(hotfixTypeValues))
	for i, s := range hotfixTypeValues {
		lowerTypeVals[i] = strings.ToLower(s)
	}

	// Match by transition (from→to) OR by issue_type field value.
	// When lowerTypeVals is empty, the ANY($4) clause never matches, preserving old behaviour.
	rows, err := pool.Query(ctx, `
		SELECT id, issue_id, issue_summary,
		       COALESCE(assignee,''), COALESCE(moved_by,''),
		       COALESCE(from_state,''), to_state, COALESCE(priority,''),
		       transitioned_at, duration_in_prev_state_hours, COALESCE(comment,''), COALESCE(issue_type,'')
		FROM issue_state_log
		WHERE date(transitioned_at) = $1::date
		  AND (
		    (LOWER(to_state) = ANY($2::text[]) AND LOWER(from_state) = ANY($3::text[]))
		    OR (array_length($4::text[], 1) > 0 AND LOWER(COALESCE(issue_type,'')) = ANY($4::text[]))
		  )
		ORDER BY transitioned_at DESC
	`, date, lowerTo, lowerFrom, lowerTypeVals)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IssueStateLog
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// GetHotfixIssuesForWeek returns hotfix tickets deployed to toStates during a week.
// fromStates/toStates default to backlog/active → stage/prod if empty.
// hotfixTypeValues are optional issue_type values that also qualify as hotfixes.
func (r *ReportRepository) GetHotfixIssuesForWeek(ctx context.Context, weekStart, weekEnd string, fromStates, toStates, hotfixTypeValues []string) ([]IssueStateLog, error) {
	pool := GetPool()

	if len(fromStates) == 0 {
		fromStates = []string{"backlog", "in progress"}
	}
	if len(toStates) == 0 {
		toStates = []string{"ready for stage", "stage", "ready for prod", "prod"}
	}
	lowerFrom := make([]string, len(fromStates))
	for i, s := range fromStates {
		lowerFrom[i] = strings.ToLower(s)
	}
	lowerTo := make([]string, len(toStates))
	for i, s := range toStates {
		lowerTo[i] = strings.ToLower(s)
	}
	lowerTypeVals := make([]string, len(hotfixTypeValues))
	for i, s := range hotfixTypeValues {
		lowerTypeVals[i] = strings.ToLower(s)
	}

	rows, err := pool.Query(ctx, `
		SELECT id, issue_id, issue_summary,
		       COALESCE(assignee,''), COALESCE(moved_by,''),
		       COALESCE(from_state,''), to_state, COALESCE(priority,''),
		       transitioned_at, duration_in_prev_state_hours, COALESCE(comment,''), COALESCE(issue_type,'')
		FROM issue_state_log
		WHERE date(transitioned_at) >= $1::date
		  AND date(transitioned_at) <= $2::date
		  AND (
		    (LOWER(to_state) = ANY($3::text[]) AND LOWER(from_state) = ANY($4::text[]))
		    OR (array_length($5::text[], 1) > 0 AND LOWER(COALESCE(issue_type,'')) = ANY($5::text[]))
		  )
		ORDER BY assignee ASC, transitioned_at DESC
	`, weekStart, weekEnd, lowerTo, lowerFrom, lowerTypeVals)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IssueStateLog
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// TimeTrackingParams holds optional filters for the time tracking query.
// nil/zero values mean "no filter".
type TimeTrackingParams struct {
	WeekStart      *time.Time // Monday 00:00:00 of selected week (nil = no week filter)
	WeekEnd        *time.Time // Sunday 23:59:59 of selected week (nil = no week filter)
	Assignees      []string   // filter to these assignees (empty = all)
	Priorities     []string   // filter to these priorities e.g. ["P0","P1"] (empty = all)
	PinnedIssues   []string   // issue IDs that are pinned — always included regardless of week
	SprintIssueIDs []string   // when set, only include rows for these issue IDs (sprint filter)
}

// GetTimeTracking returns all In Progress activity rows matching the given params.
// When WeekStart/WeekEnd are set it returns every row whose transitioned_at falls
// within that window (or is currently In Progress), plus any pinned tickets.
// When no week is specified it falls back to the legacy "one best row per ticket" view.
func (r *ReportRepository) GetTimeTracking(ctx context.Context, params TimeTrackingParams) ([]IssueStateLog, error) {
	pool := GetPool()

	// Build WHERE clause dynamically
	conditions := []string{
		"(LOWER(to_state) = 'in progress' OR LOWER(from_state) = 'in progress' OR LOWER(to_state) = 'blocked' OR LOWER(from_state) = 'blocked')",
	}
	args := []interface{}{}
	argIdx := 1

	if params.WeekStart != nil && params.WeekEnd != nil {
		// Include rows active within the week window, plus any currently-active In Progress
		// entries whose to_state entry happened before this week (spans across weeks).
		weekCond := fmt.Sprintf(`(
			(transitioned_at >= $%d AND transitioned_at <= $%d)
			OR (duration_in_prev_state_hours IS NULL AND LOWER(to_state) = 'in progress')
			OR (duration_in_prev_state_hours IS NULL AND LOWER(to_state) = 'blocked')
		)`, argIdx, argIdx+1)
		if len(params.PinnedIssues) > 0 {
			// Also include pinned issues regardless of week
			placeholders := ""
			for i, id := range params.PinnedIssues {
				if i > 0 {
					placeholders += ","
				}
				placeholders += fmt.Sprintf("$%d", argIdx+2+i)
				args = append(args, id)
			}
			weekCond = fmt.Sprintf(`(
				(transitioned_at >= $%d AND transitioned_at <= $%d)
				OR (duration_in_prev_state_hours IS NULL AND LOWER(to_state) = 'in progress')
				OR (duration_in_prev_state_hours IS NULL AND LOWER(to_state) = 'blocked')
				OR issue_id IN (%s)
			)`, argIdx, argIdx+1, placeholders)
			argIdx += 2 + len(params.PinnedIssues)
		} else {
			argIdx += 2
		}
		args = append([]interface{}{*params.WeekStart, *params.WeekEnd}, args...)
		conditions = append(conditions, weekCond)
	}

	if len(params.Assignees) > 0 {
		placeholders := ""
		for i, a := range params.Assignees {
			if i > 0 {
				placeholders += ","
			}
			placeholders += fmt.Sprintf("$%d", argIdx)
			args = append(args, a)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("LOWER(COALESCE(assignee,'')) IN (%s)", placeholders))
	}

	if len(params.Priorities) > 0 {
		placeholders := ""
		for i, p := range params.Priorities {
			if i > 0 {
				placeholders += ","
			}
			placeholders += fmt.Sprintf("$%d", argIdx)
			args = append(args, strings.ToUpper(p))
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("UPPER(COALESCE(priority,'')) IN (%s)", placeholders))
	}

	if len(params.SprintIssueIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("issue_id = ANY($%d)", argIdx))
		args = append(args, params.SprintIssueIDs)
		argIdx++
	}

	whereClause := ""
	for i, c := range conditions {
		if i == 0 {
			whereClause = "WHERE " + c
		} else {
			whereClause += " AND " + c
		}
	}

	query := fmt.Sprintf(`
		SELECT
			id, issue_id, issue_summary,
			COALESCE(assignee,'') AS assignee,
			COALESCE(moved_by,'') AS moved_by,
			COALESCE(from_state,'') AS from_state,
			to_state,
			COALESCE(priority,'') AS priority,
			transitioned_at,
			CASE
				WHEN LOWER(to_state) = 'in progress' AND duration_in_prev_state_hours IS NULL
					THEN EXTRACT(EPOCH FROM (NOW() - transitioned_at)) / 3600.0
				ELSE duration_in_prev_state_hours
			END AS duration_in_prev_state_hours,
			COALESCE(comment,'') AS comment, COALESCE(issue_type,'') AS issue_type
		FROM issue_state_log
		%s
		ORDER BY
			CASE WHEN LOWER(from_state) = 'in progress' THEN 0 ELSE 1 END ASC,
			transitioned_at DESC
		LIMIT 500
	`, whereClause)

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IssueStateLog
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// PinIssue marks an issue as pinned for a user (idempotent via ON CONFLICT DO NOTHING)
func (r *ReportRepository) PinIssue(ctx context.Context, userID, issueID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `
		INSERT INTO pinned_issues (user_id, issue_id) VALUES ($1, $2)
		ON CONFLICT (user_id, issue_id) DO NOTHING
	`, userID, issueID)
	return err
}

// UnpinIssue removes a pin for a user+issue
func (r *ReportRepository) UnpinIssue(ctx context.Context, userID, issueID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `
		DELETE FROM pinned_issues WHERE user_id = $1 AND issue_id = $2
	`, userID, issueID)
	return err
}

// GetPinnedIssueIDs returns all pinned issue IDs for a user
func (r *ReportRepository) GetPinnedIssueIDs(ctx context.Context, userID string) ([]string, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx, `
		SELECT issue_id FROM pinned_issues WHERE user_id = $1 ORDER BY created_at DESC
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
	return ids, nil
}

// GetInProgressOlderThan returns issues currently In Progress for longer than given hours
// GetTodayVerifiedMovesByMover returns state log entries for today where the given user
// moved a ticket to a verified/QA column (Ready for Stage, Ready for PROD, Verified, Mobile Done).
func (r *ReportRepository) GetTodayVerifiedMovesByMover(ctx context.Context, moverName, today string) ([]IssueStateLog, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx, `
		SELECT id, issue_id, issue_summary,
		       COALESCE(assignee,''), COALESCE(moved_by,''),
		       COALESCE(from_state,''), to_state, COALESCE(priority,''),
		       transitioned_at, duration_in_prev_state_hours, COALESCE(comment,''), COALESCE(issue_type,'')
		FROM issue_state_log
		WHERE DATE(transitioned_at AT TIME ZONE 'UTC') = $1::date
		  AND LOWER(moved_by) = LOWER($2)
		  AND (
		        LOWER(to_state) LIKE '%ready for stage%'
		     OR LOWER(to_state) LIKE '%ready for prod%'
		     OR LOWER(to_state) = 'verified'
		     OR LOWER(to_state) LIKE '%mobile done%'
		  )
		ORDER BY transitioned_at ASC
	`, today, moverName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var logs []IssueStateLog
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (r *ReportRepository) GetInProgressOlderThan(ctx context.Context, hours float64) ([]IssueStateLog, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (issue_id)
		       id, issue_id, issue_summary,
		       COALESCE(assignee,''), COALESCE(moved_by,''),
		       COALESCE(from_state,''), to_state, COALESCE(priority,''),
		       transitioned_at, duration_in_prev_state_hours, COALESCE(comment,''), COALESCE(issue_type,'')
		FROM issue_state_log
		WHERE LOWER(to_state) = 'in progress'
		  AND issue_id NOT IN (
			SELECT DISTINCT issue_id FROM issue_state_log
			WHERE LOWER(from_state) = 'in progress'
		  )
		  AND EXTRACT(EPOCH FROM (NOW() - transitioned_at))/3600 > $1
		ORDER BY issue_id, transitioned_at ASC
	`, hours)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IssueStateLog
	for rows.Next() {
		l, err := scanStateLog(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// GetAssigneeStats returns per-assignee done count from state log
func (r *ReportRepository) GetAssigneeStats(ctx context.Context) ([]AssigneeStat, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT
			assignee,
			COUNT(*) FILTER (WHERE LOWER(to_state) = 'dev') AS done,
			COALESCE(AVG(duration_in_prev_state_hours) FILTER (WHERE LOWER(from_state) = 'in progress'), NULL) AS avg_hours
		FROM issue_state_log
		WHERE assignee != ''
		GROUP BY assignee
		ORDER BY done DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []AssigneeStat
	for rows.Next() {
		var s AssigneeStat
		if err := rows.Scan(&s.Assignee, &s.Done, &s.AvgHoursInProgress); err != nil {
			return nil, err
		}
		stats = append(stats, s)
	}
	return stats, nil
}

// SavePMReport upserts a PM report by date + report_type
func (r *ReportRepository) SavePMReport(ctx context.Context, date, reportType, reportText string, doneCount, openCount, blockedCount int) (*PMReport, error) {
	pool := GetPool()

	now := time.Now()
	var report PMReport

	err := pool.QueryRow(ctx, `
		INSERT INTO pm_reports (date, report_type, report_text, done_count, open_count, blocked_count, generated_at, updated_at)
		VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (date, report_type) DO UPDATE SET
			report_text = EXCLUDED.report_text,
			done_count = EXCLUDED.done_count,
			open_count = EXCLUDED.open_count,
			blocked_count = EXCLUDED.blocked_count,
			updated_at = EXCLUDED.updated_at
		RETURNING id, date::text, report_type, report_text, done_count, open_count, blocked_count, generated_at, updated_at
	`, date, reportType, reportText, doneCount, openCount, blockedCount, now, now).Scan(
		&report.ID, &report.Date, &report.ReportType, &report.ReportText,
		&report.DoneCount, &report.OpenCount, &report.BlockedCount,
		&report.GeneratedAt, &report.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to save PM report: %w", err)
	}
	return &report, nil
}

// GetPMReport fetches a saved daily report for a specific date
func (r *ReportRepository) GetPMReport(ctx context.Context, date string) (*PMReport, error) {
	pool := GetPool()

	var report PMReport
	err := pool.QueryRow(ctx, `
		SELECT id, date::text, report_type, report_text, done_count, open_count, blocked_count, generated_at, updated_at
		FROM pm_reports
		WHERE date = $1::date AND report_type LIKE 'daily%'
	`, date).Scan(
		&report.ID, &report.Date, &report.ReportType, &report.ReportText,
		&report.DoneCount, &report.OpenCount, &report.BlockedCount,
		&report.GeneratedAt, &report.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &report, nil
}

// ─── Issue Timeline ───────────────────────────────────────────────────────────

// IssueStint represents one contiguous In Progress stint for a ticket.
// Stint starts when the ticket enters "in progress" and ends when it leaves.
type IssueStint struct {
	StintNumber          int      `json:"stint_number"`           // 1-based: 1st time, 2nd time, etc.
	EnteredAt            time.Time `json:"entered_at"`             // when it entered In Progress this stint
	ExitedAt             *time.Time `json:"exited_at,omitempty"`   // when it left (nil = still In Progress)
	ExitedTo             string   `json:"exited_to"`               // the state it moved to ("DEV", "Backlog", "" if live)
	DurationHours        *float64 `json:"duration_hours"`          // hours in this stint (nil = live)
	MovedBack            bool     `json:"moved_back"`              // exited_to is a regression state
	MovedBy              string   `json:"moved_by"`                // who moved it out
	Comment              string   `json:"comment"`                 // reason / comment at time of exit
}

// IssueTimeline represents one ticket's full In Progress history aggregated from issue_state_log.
type IssueTimeline struct {
	IssueID            string       `json:"issue_id"`
	IssueSummary       string       `json:"issue_summary"`
	Assignee           string       `json:"assignee"`
	Priority           string       `json:"priority"`
	Pinned             bool         `json:"pinned"`
	TotalStints        int          `json:"total_stints"`        // how many times entered In Progress
	TotalHours         float64      `json:"total_hours"`         // sum of all completed stints + live elapsed
	IsLive             bool         `json:"is_live"`             // currently In Progress
	LiveHours          float64      `json:"live_hours"`          // elapsed hours for the current open stint (0 if not live)
	MovedBackCount     int          `json:"moved_back_count"`    // times ticket regressed
	IsOverdue          bool         `json:"is_overdue"`          // total_hours > threshold (YouTrack) OR past due_date (Asana)
	ThresholdHours     float64      `json:"threshold_hours"`
	DueDate            *time.Time   `json:"due_date,omitempty"`  // Asana: task due date (nil for YouTrack)
	FirstEnteredAt     time.Time    `json:"first_entered_at"`    // when it FIRST entered In Progress
	LastActivityAt     time.Time    `json:"last_activity_at"`    // most recent transition
	Stints             []IssueStint `json:"stints"`
}

// stateRankForTimeline returns a rank to determine backward moves (lower = earlier)
var timelineStateRank = map[string]int{
	"backlog":     0,
	"open":        0,
	"in progress": 1,
	"findings":    2,
	"dev":         3,
	"stage":       4,
	"prod":        5,
	"done":        6,
	"mobile done": 6,
}

func timelineIsMovedBack(fromState, toState string) bool {
	from := strings.ToLower(strings.TrimSpace(fromState))
	to := strings.ToLower(strings.TrimSpace(toState))
	fromRank, fromOk := timelineStateRank[from]
	toRank, toOk := timelineStateRank[to]
	if !fromOk || !toOk {
		return false
	}
	return toRank < fromRank
}

func overdueThresholdForPriority(priority string) float64 {
	switch strings.ToUpper(priority) {
	case "P0", "CRITICAL":
		return 4
	case "P1":
		return 24
	case "P2":
		return 48
	default:
		return 72
	}
}

// GetIssueTimelines builds a per-issue timeline aggregated from issue_state_log.
// Each IssueTimeline contains every In Progress stint for that ticket, its total
// accumulated time, moved-back count, and live status.
func (r *ReportRepository) GetIssueTimelines(ctx context.Context, pinnedIDs []string, since, until *time.Time) ([]IssueTimeline, error) {
	pool := GetPool()

	// Build sprint date filter for the inner subquery so we only return issues
	// that had an In Progress transition during the selected sprint window.
	sprintFilter := ""
	args := []any{}
	if since != nil {
		args = append(args, *since)
		sprintFilter += fmt.Sprintf(" AND transitioned_at >= $%d", len(args))
	}
	if until != nil {
		args = append(args, *until)
		sprintFilter += fmt.Sprintf(" AND transitioned_at <= $%d", len(args))
	}

	rows, err := pool.Query(ctx, fmt.Sprintf(`
		SELECT
			issue_id,
			COALESCE(issue_summary,'') AS issue_summary,
			COALESCE(assignee,'') AS assignee,
			COALESCE(moved_by,'') AS moved_by,
			COALESCE(from_state,'') AS from_state,
			to_state,
			COALESCE(priority,'') AS priority,
			transitioned_at,
			duration_in_prev_state_hours,
			COALESCE(comment,'') AS comment
		FROM issue_state_log
		WHERE issue_id IN (
			SELECT DISTINCT issue_id FROM issue_state_log
			WHERE LOWER(to_state) = 'in progress'%s
		)
		ORDER BY issue_id, transitioned_at ASC
	`, sprintFilter), args...)
	if err != nil {
		return nil, fmt.Errorf("GetIssueTimelines query failed: %w", err)
	}
	defer rows.Close()

	// Group raw rows by issue_id
	type rawRow struct {
		issueID     string
		summary     string
		assignee    string
		movedBy     string
		fromState   string
		toState     string
		priority    string
		at          time.Time
		durationHrs *float64
		comment     string
	}

	byIssue := map[string][]rawRow{}
	issueOrder := []string{}

	for rows.Next() {
		var rr rawRow
		if err := rows.Scan(
			&rr.issueID, &rr.summary, &rr.assignee, &rr.movedBy,
			&rr.fromState, &rr.toState, &rr.priority,
			&rr.at, &rr.durationHrs, &rr.comment,
		); err != nil {
			return nil, err
		}
		if _, seen := byIssue[rr.issueID]; !seen {
			issueOrder = append(issueOrder, rr.issueID)
		}
		byIssue[rr.issueID] = append(byIssue[rr.issueID], rr)
	}

	pinnedSet := map[string]bool{}
	for _, id := range pinnedIDs {
		pinnedSet[id] = true
	}

	now := time.Now()
	var timelines []IssueTimeline

	for _, issueID := range issueOrder {
		rrows := byIssue[issueID]

		// Use the most recent non-empty summary/assignee/priority
		var summary, assignee, priority string
		for _, rr := range rrows {
			if rr.summary != "" {
				summary = rr.summary
			}
			if rr.assignee != "" {
				assignee = rr.assignee
			}
			if rr.priority != "" {
				priority = rr.priority
			}
		}

		// Build stints by pairing entry rows (to_state='in progress') with
		// subsequent exit rows (from_state='in progress').
		var stints []IssueStint
		stintNum := 0

		// We iterate in chronological order and track open stints.
		var openStintEnteredAt *time.Time

		for _, rr := range rrows {
			toLower := strings.ToLower(rr.toState)
			fromLower := strings.ToLower(rr.fromState)

			if toLower == "in progress" {
				// Ticket entered In Progress — open a new stint
				t := rr.at
				openStintEnteredAt = &t
			} else if fromLower == "in progress" && openStintEnteredAt != nil {
				// Ticket exited In Progress — close the current stint
				stintNum++
				exited := rr.at
				d := rr.durationHrs
				if d == nil {
					// Compute from open timestamp
					hrs := exited.Sub(*openStintEnteredAt).Hours()
					d = &hrs
				}
				movedBack := timelineIsMovedBack("in progress", rr.toState)
				stints = append(stints, IssueStint{
					StintNumber:   stintNum,
					EnteredAt:     *openStintEnteredAt,
					ExitedAt:      &exited,
					ExitedTo:      rr.toState,
					DurationHours: d,
					MovedBack:     movedBack,
					MovedBy:       rr.movedBy,
					Comment:       rr.comment,
				})
				openStintEnteredAt = nil
			}
		}

		// If there's still an open stint, it's currently In Progress
		isLive := openStintEnteredAt != nil
		liveHours := 0.0
		if isLive {
			stintNum++
			liveHours = now.Sub(*openStintEnteredAt).Hours()
			stints = append(stints, IssueStint{
				StintNumber:   stintNum,
				EnteredAt:     *openStintEnteredAt,
				ExitedAt:      nil,
				ExitedTo:      "",
				DurationHours: &liveHours,
				MovedBack:     false,
			})
		}

		// Compute totals
		totalHours := 0.0
		movedBackCount := 0
		for _, s := range stints {
			if s.DurationHours != nil {
				totalHours += *s.DurationHours
			}
			if s.MovedBack {
				movedBackCount++
			}
		}

		threshold := overdueThresholdForPriority(priority)
		isOverdue := totalHours > threshold

		var firstEnteredAt, lastActivityAt time.Time
		if len(rrows) > 0 {
			lastActivityAt = rrows[len(rrows)-1].at
		}
		// First entry into In Progress
		for _, rr := range rrows {
			if strings.ToLower(rr.toState) == "in progress" {
				firstEnteredAt = rr.at
				break
			}
		}

		timelines = append(timelines, IssueTimeline{
			IssueID:        issueID,
			IssueSummary:   summary,
			Assignee:       assignee,
			Priority:       priority,
			Pinned:         pinnedSet[issueID],
			TotalStints:    stintNum,
			TotalHours:     totalHours,
			IsLive:         isLive,
			LiveHours:      liveHours,
			MovedBackCount: movedBackCount,
			IsOverdue:      isOverdue,
			ThresholdHours: threshold,
			FirstEnteredAt: firstEnteredAt,
			LastActivityAt: lastActivityAt,
			Stints:         stints,
		})
	}

	// Sort: pinned first, then live, then by total hours desc
	sort.Slice(timelines, func(i, j int) bool {
		a, b := timelines[i], timelines[j]
		if a.Pinned != b.Pinned {
			return a.Pinned
		}
		if a.IsLive != b.IsLive {
			return a.IsLive
		}
		return a.TotalHours > b.TotalHours
	})

	return timelines, nil
}

// GetDelayedIssues returns issues that are currently In Progress AND overdue
// (total time in In Progress > priority threshold). Used for the daily report.
func (r *ReportRepository) GetDelayedIssues(ctx context.Context) ([]IssueTimeline, error) {
	timelines, err := r.GetIssueTimelines(ctx, nil, nil, nil)
	if err != nil {
		return nil, err
	}
	var delayed []IssueTimeline
	for _, t := range timelines {
		if t.IsLive && t.IsOverdue {
			delayed = append(delayed, t)
		}
	}
	return delayed, nil
}

// DismissAlert records that the user has dismissed the moved-back alert for an issue.
func (r *ReportRepository) DismissAlert(ctx context.Context, userID, issueID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `
		INSERT INTO dismissed_alerts (user_id, issue_id)
		VALUES ($1, $2)
		ON CONFLICT (user_id, issue_id) DO NOTHING
	`, userID, issueID)
	return err
}

// UndismissAlert removes a dismissed alert so it shows again.
func (r *ReportRepository) UndismissAlert(ctx context.Context, userID, issueID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `
		DELETE FROM dismissed_alerts WHERE user_id = $1 AND issue_id = $2
	`, userID, issueID)
	return err
}

// GetDismissedAlertIDs returns the set of issue IDs the user has dismissed.
func (r *ReportRepository) GetDismissedAlertIDs(ctx context.Context, userID string) (map[string]bool, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx, `
		SELECT issue_id FROM dismissed_alerts WHERE user_id = $1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result[id] = true
	}
	return result, nil
}

// ListPMReports returns the most recent saved daily reports (both daily-full and daily-summary)
func (r *ReportRepository) ListPMReports(ctx context.Context) ([]PMReport, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, date::text, report_type, report_text, done_count, open_count, blocked_count, generated_at, updated_at
		FROM pm_reports
		WHERE report_type LIKE 'daily%'
		ORDER BY date DESC, report_type ASC
		LIMIT 60
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reports []PMReport
	for rows.Next() {
		var report PMReport
		if err := rows.Scan(
			&report.ID, &report.Date, &report.ReportType, &report.ReportText,
			&report.DoneCount, &report.OpenCount, &report.BlockedCount,
			&report.GeneratedAt, &report.UpdatedAt,
		); err != nil {
			return nil, err
		}
		reports = append(reports, report)
	}
	return reports, nil
}

// ListWeeklyPMReports returns the most recent saved weekly reports (both weekly-full and weekly-summary)
func (r *ReportRepository) ListWeeklyPMReports(ctx context.Context) ([]PMReport, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, date::text, report_type, report_text, done_count, open_count, blocked_count, generated_at, updated_at
		FROM pm_reports
		WHERE report_type LIKE 'weekly%'
		ORDER BY date DESC, report_type ASC
		LIMIT 40
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reports []PMReport
	for rows.Next() {
		var report PMReport
		if err := rows.Scan(
			&report.ID, &report.Date, &report.ReportType, &report.ReportText,
			&report.DoneCount, &report.OpenCount, &report.BlockedCount,
			&report.GeneratedAt, &report.UpdatedAt,
		); err != nil {
			return nil, err
		}
		reports = append(reports, report)
	}
	return reports, nil
}

// DeletePMReport deletes a saved PM report by ID
func (r *ReportRepository) DeletePMReport(ctx context.Context, id string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `DELETE FROM pm_reports WHERE id = $1`, id)
	return err
}
