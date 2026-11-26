package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/models"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// carryRoles are the workflow roles whose tickets are suggested for moving into
// a new sprint: the to-do (backlog), in progress (active) and blocked columns.
var carryRoles = map[string]bool{"": true, "backlog": true, "active": true, "blocked": true}

type sprintPlanTicket struct {
	ID      string `json:"id"`
	Summary string `json:"summary"`
}

type sprintPlanColumn struct {
	Column    string             `json:"column"`
	Role      string             `json:"role"`
	Suggested bool               `json:"suggested_to_move"`
	Count     int                `json:"count"`
	Tickets   []sprintPlanTicket `json:"tickets"`
}

// suggestSprintDates returns Monday of week 1, and Friday of week 2 and of
// week 1, for a sprint that starts after the last one ends and never in the past.
func suggestSprintDates(lastFinishMS int64, now time.Time) (start, twoWeekEnd, oneWeekEnd time.Time) {
	base := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if lastFinishMS > 0 {
		f := time.UnixMilli(lastFinishMS).UTC()
		if day := time.Date(f.Year(), f.Month(), f.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1); day.After(base) {
			base = day
		}
	}
	start = base.AddDate(0, 0, (int(time.Monday)-int(base.Weekday())+7)%7)
	return start, start.AddDate(0, 0, 11), start.AddDate(0, 0, 4)
}

// groupByColumn puts the sprint's tickets (feature epics left out) under their
// workflow column, in board order, then the report config's blocked states. A
// state the workflow config doesn't know gets its own column named after it.
// Empty columns are dropped unless they are suggested to move.
func groupByColumn(issues []youtrack.Issue, wf *models.WorkflowConfig) []sprintPlanColumn {
	var cols []sprintPlanColumn
	index := map[string]int{} // lowercase state or alias → position in cols
	if wf != nil {
		for _, c := range wf.ColumnHierarchy {
			index[strings.ToLower(c.State)] = len(cols)
			for _, a := range c.Aliases {
				if _, taken := index[strings.ToLower(a)]; !taken {
					index[strings.ToLower(a)] = len(cols)
				}
			}
			cols = append(cols, sprintPlanColumn{Column: c.State, Role: c.Role, Suggested: carryRoles[strings.ToLower(c.Role)], Tickets: []sprintPlanTicket{}})
		}
		// Report config blocked_states count as blocked too, like statesForRole.
		for _, st := range wf.ReportConfig.BlockedStates {
			if i, ok := index[strings.ToLower(st)]; ok {
				cols[i].Role, cols[i].Suggested = "blocked", true
			} else {
				index[strings.ToLower(st)] = len(cols)
				cols = append(cols, sprintPlanColumn{Column: st, Role: "blocked", Suggested: true, Tickets: []sprintPlanTicket{}})
			}
		}
	}
	for _, iss := range youtrack.WithoutEpics(issues) {
		state := youtrack.IssueStateName(iss)
		i, ok := index[strings.ToLower(state)]
		if !ok {
			i = len(cols)
			index[strings.ToLower(state)] = i
			cols = append(cols, sprintPlanColumn{Column: state, Tickets: []sprintPlanTicket{}})
		}
		cols[i].Count++
		cols[i].Tickets = append(cols[i].Tickets, sprintPlanTicket{iss.IDReadable, iss.Summary})
	}
	out := []sprintPlanColumn{}
	for _, c := range cols {
		if c.Count > 0 || c.Suggested {
			out = append(out, c)
		}
	}
	return out
}

// mcpPlanSprint answers create_sprint with plan: true. It changes nothing and
// returns what the assistant needs to ask the user about the new sprint.
func mcpPlanSprint(ctx context.Context, userID string, id interface{}) rpcResponse {
	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return toolError(id, "YouTrack not configured. Add your YouTrack integration in Velocity → Integrations")
	}
	bc, err := loadMCPBoardContext(ctx, yt, userID)
	if err != nil {
		return toolError(id, err.Error())
	}
	var last *youtrack.Sprint // the most recently starting sprint, which the new one follows
	for i := range bc.Sprints {
		if last == nil || bc.Sprints[i].Start > last.Start {
			last = &bc.Sprints[i]
		}
	}
	plan := map[string]interface{}{
		"suggested_name":    nextNumberedSprintName(bc.Sprints),
		"default_swimlanes": bucketEpicOrder,
	}
	var lastFinish int64
	columns := []sprintPlanColumn{}
	if last != nil {
		lastFinish = last.Finish
		plan["last_sprint"] = map[string]string{"name": last.Name, "start": msToISO(last.Start), "finish": msToISO(last.Finish)}
		issues, err := yt.GetAllSprintIssuesWithEpics(ctx, last.ID)
		if err != nil {
			slog.WarnContext(ctx, "Could not read the last sprint's tickets for the sprint plan", "sprint", last.Name, "error", err)
			plan["columns_warning"] = "could not read " + last.Name + "'s tickets, so ask which columns to move without counts: " + err.Error()
		} else {
			columns = groupByColumn(issues, bc.Workflow)
		}
	}
	start, twoWeekEnd, oneWeekEnd := suggestSprintDates(lastFinish, time.Now())
	plan["columns"] = columns
	plan["suggested_dates"] = map[string]interface{}{
		"two_weeks": map[string]string{"start_date": start.Format("2006-01-02"), "finish_date": twoWeekEnd.Format("2006-01-02")},
		"one_week":  map[string]string{"start_date": start.Format("2006-01-02"), "finish_date": oneWeekEnd.Format("2006-01-02")},
	}
	slog.InfoContext(ctx, "Sprint plan prepared", "sprint", plan["suggested_name"], "columns", len(columns))
	data, _ := json.Marshal(plan)
	return toolOK(id, string(data))
}
