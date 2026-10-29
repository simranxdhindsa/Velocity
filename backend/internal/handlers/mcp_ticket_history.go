package handlers

import (
	"context"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

const (
	ticketDefaultHistoryLimit = 50
	ticketMaxHistoryLimit     = 300
)

// ticketHistoryPayload turns a ticket's issue_state_log rows (oldest first) into the
// get_youtrack_ticket `history` fields: every column move with who made it and when,
// keeping the newest `limit` moves (still listed oldest first), plus a summary of the
// latest move. With nothing recorded it returns an empty list and a note saying why.
func ticketHistoryPayload(logs []database.IssueStateLog, limit int) map[string]interface{} {
	if len(logs) == 0 {
		return map[string]interface{}{
			"history":      []interface{}{},
			"history_note": "No status changes recorded in Velocity for this ticket (Velocity's history starts July 2025 and only covers moves it saw).",
		}
	}
	dropped := 0
	if limit > 0 && len(logs) > limit {
		dropped = len(logs) - limit
		logs = logs[dropped:]
	}
	moves := make([]map[string]interface{}, 0, len(logs))
	for _, l := range logs {
		m := map[string]interface{}{
			"from":     l.FromState,
			"to":       l.ToState,
			"moved_by": l.MovedBy,
			"at":       l.TransitionedAt.UTC().Format(time.RFC3339),
		}
		if l.FromState == "" {
			m["from"] = nil // first recorded state, no previous column
		}
		if l.DurationInPrevStateHours != nil {
			m["hours_in_previous"] = math.Round(*l.DurationInPrevStateHours*10) / 10
		}
		// The log's comment holds YouTrack activity IDs, not text; only surface the
		// "reconciled" marker, which means the move was recorded late (time approximate)
		if strings.Contains(strings.ToLower(l.Comment), "reconciled") {
			m["recorded_late"] = true
		}
		moves = append(moves, m)
	}
	last := logs[len(logs)-1]
	out := map[string]interface{}{
		"history":           moves,
		"status_changed_by": last.MovedBy,
		"status_changed_at": last.TransitionedAt.UTC().Format(time.RFC3339),
	}
	if dropped > 0 {
		out["history_note"] = "Older moves omitted: " + strconv.Itoa(dropped) + " earlier status changes not shown (raise history_limit to see them)."
	}
	return out
}

// loadTicketHistory fetches the recorded moves for a readable ticket ID. Errors and a
// missing database both yield an explanatory note instead of failing the whole tool.
func loadTicketHistory(ctx context.Context, issueID string, limit int) map[string]interface{} {
	if database.GetPool() == nil {
		return map[string]interface{}{"history_note": "Status history unavailable (no database)."}
	}
	logs, err := database.NewReportRepository().GetStateLogForIssue(ctx, issueID)
	if err != nil {
		return map[string]interface{}{"history_note": "Status history unavailable: " + err.Error()}
	}
	return ticketHistoryPayload(logs, limit)
}
