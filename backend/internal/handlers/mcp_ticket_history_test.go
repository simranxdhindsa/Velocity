package handlers

import (
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

func TestTicketHistoryPayload(t *testing.T) {
	h := func(v float64) *float64 { return &v }
	at := func(s string) time.Time { tm, _ := time.Parse(time.RFC3339, s); return tm }
	logs := []database.IssueStateLog{ // ARD-3076 as recorded
		{FromState: "To Do", ToState: "In Progress", MovedBy: "Suryansh", TransitionedAt: at("2026-10-19T08:22:15Z"), Comment: "activity:0-0.14-53836"},
		{FromState: "In Progress", ToState: "Dev", MovedBy: "Suryansh", TransitionedAt: at("2026-10-19T11:31:06Z"), DurationInPrevStateHours: h(3.1512)},
		{FromState: "Dev", ToState: "Ready for Stage", MovedBy: "Jagmeet Singh", TransitionedAt: at("2026-10-21T14:14:37Z"), DurationInPrevStateHours: h(50.73), Comment: "(reconciled — webhook missed)"},
	}
	out := ticketHistoryPayload(logs, 50)
	moves := out["history"].([]map[string]interface{})
	if len(moves) != 3 {
		t.Fatalf("moves = %d", len(moves))
	}
	if moves[1]["from"] != "In Progress" || moves[1]["to"] != "Dev" || moves[1]["moved_by"] != "Suryansh" || moves[1]["at"] != "2026-10-19T11:31:06Z" || moves[1]["hours_in_previous"] != 3.2 {
		t.Errorf("move 2 = %+v", moves[1])
	}
	if _, ok := moves[0]["hours_in_previous"]; ok {
		t.Error("first move has no previous duration")
	}
	if moves[0]["recorded_late"] != nil || moves[2]["recorded_late"] != true {
		t.Errorf("recorded_late flags wrong: %+v / %+v", moves[0], moves[2])
	}
	for _, m := range moves {
		if _, ok := m["comment"]; ok {
			t.Error("activity-ID comments must not be exposed")
		}
	}
	if out["status_changed_by"] != "Jagmeet Singh" || out["status_changed_at"] != "2026-10-21T14:14:37Z" {
		t.Errorf("latest change = %v at %v", out["status_changed_by"], out["status_changed_at"])
	}

	// Limit keeps the newest moves, oldest first, and says how many were dropped
	cut := ticketHistoryPayload(logs, 2)
	cm := cut["history"].([]map[string]interface{})
	if len(cm) != 2 || cm[0]["to"] != "Dev" || cut["history_note"] == nil {
		t.Errorf("limited history = %+v note=%v", cm, cut["history_note"])
	}

	empty := ticketHistoryPayload(nil, 50)
	if empty["history_note"] == nil || len(empty["history"].([]interface{})) != 0 {
		t.Errorf("empty history = %+v", empty)
	}
}
