package database

import (
	"context"
	"time"
)

// ActivityDayRow is one (day, target state, people) bucket of the state log:
// how many distinct tickets moved into ToState on Date.
type ActivityDayRow struct {
	Date     string `json:"date"` // YYYY-MM-DD in the requested time zone
	ToState  string `json:"to_state"`
	Assignee string `json:"assignee"`
	MovedBy  string `json:"moved_by"`
	Count    int    `json:"count"`
}

// GetActivityByDay groups issue_state_log moves in [since, until) by local day,
// target state, assignee and mover. The client maps states to workflow roles
// (dev_done / verified / deployed) so the workflow config stays the source of truth.
func (r *ReportRepository) GetActivityByDay(ctx context.Context, since, until time.Time, tz string) ([]ActivityDayRow, error) {
	pool := GetPool()
	if pool == nil {
		return []ActivityDayRow{}, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT to_char((transitioned_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day,
		       to_state,
		       COALESCE(assignee, ''),
		       COALESCE(moved_by, ''),
		       COUNT(DISTINCT issue_id)
		FROM issue_state_log
		WHERE transitioned_at >= $1 AND transitioned_at < $2
		GROUP BY 1, 2, 3, 4
		ORDER BY 1`, since, until, tz)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ActivityDayRow{}
	for rows.Next() {
		var a ActivityDayRow
		if err := rows.Scan(&a.Date, &a.ToState, &a.Assignee, &a.MovedBy, &a.Count); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ActivityMove is one ticket move on a given day, for the skyline's day drill-down.
type ActivityMove struct {
	IssueID        string    `json:"issue_id"`
	IssueSummary   string    `json:"issue_summary"`
	ToState        string    `json:"to_state"`
	Assignee       string    `json:"assignee"`
	MovedBy        string    `json:"moved_by"`
	TransitionedAt time.Time `json:"transitioned_at"`
}

// GetActivityDayMoves lists every move on one local day (YYYY-MM-DD in tz), newest first.
func (r *ReportRepository) GetActivityDayMoves(ctx context.Context, day, tz string) ([]ActivityMove, error) {
	pool := GetPool()
	if pool == nil {
		return []ActivityMove{}, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT issue_id, issue_summary, to_state, COALESCE(assignee, ''), COALESCE(moved_by, ''), transitioned_at
		FROM issue_state_log
		WHERE (transitioned_at AT TIME ZONE $2)::date = $1::date
		ORDER BY transitioned_at DESC`, day, tz)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ActivityMove{}
	for rows.Next() {
		var m ActivityMove
		if err := rows.Scan(&m.IssueID, &m.IssueSummary, &m.ToState, &m.Assignee, &m.MovedBy, &m.TransitionedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
