package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// mcpBulkUpdateCap is the max number of tickets one bulk_update_tickets call may change.
const mcpBulkUpdateCap = 100

var bulkUpdateTicketsToolSchema = map[string]interface{}{
	"name": "bulk_update_tickets",
	"description": "Moves many YouTrack tickets at once: change their State (column) and/or move them to another sprint, " +
		"e.g. 'move all tickets in Dev to next sprint', 'move blocked tickets to next sprint', 'move everything in Ready for Stage to Stage'. " +
		"Works on the board selected in the user's Velocity YouTrack integration. Scope: sprint_name, and if the user did not name a sprint ALWAYS leave it out, which scopes to the CURRENT sprint of that board (never project-wide). " +
		"Select tickets with from_state (a column/state name), from_role (a workflow role from the Velocity workflow config, e.g. 'blocked' for blocked tickets; use this instead of guessing state names), and/or ticket_ids. " +
		"Narrow with exclude_ids, assignee_login, subsystem. Actions: to_state and/or to_sprint ('next' = the sprint after the current one, or a sprint name). " +
		"SAFETY: dry_run defaults to true and changes nothing; it returns the exact tickets that would change (id, summary, current state and sprint, target). " +
		"ALWAYS show that preview to the user and ask them to confirm. Only after the user explicitly confirms, call again with the same arguments plus dry_run=false and ticket_ids set to the previewed IDs, so nothing outside the preview is touched. " +
		"If there is no next sprint, the tool says so: ask the user if they want one created with create_sprint. Max 100 tickets per call. The real run reports success or failure per ticket and keeps going past failures.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"sprint_name": map[string]string{
				"type":        "string",
				"description": "Sprint to select tickets from: an exact sprint name from get_sprints, or 'current'. Omit unless the user named a sprint; the default is the current sprint of the user's selected board.",
			},
			"from_state": map[string]string{
				"type":        "string",
				"description": "Only tickets currently in this state/column, e.g. the column the user named. Validated against the project's real states.",
			},
			"from_role": map[string]interface{}{
				"type":        "string",
				"enum":        mcpWorkflowRoles,
				"description": "Only tickets whose state has this role in the user's workflow config. Use 'blocked' for 'blocked tickets'.",
			},
			"ticket_ids": map[string]interface{}{
				"type":        "array",
				"items":       map[string]string{"type": "string"},
				"description": "Explicit readable ticket IDs, e.g. ['ARD-123']. Combined with from_state/from_role, a ticket must match both. On the confirmed real run, pass the IDs from the dry-run preview.",
			},
			"exclude_ids": map[string]interface{}{
				"type":        "array",
				"items":       map[string]string{"type": "string"},
				"description": "Readable ticket IDs to leave out.",
			},
			"assignee_login": map[string]string{
				"type":        "string",
				"description": "Only tickets assigned to this YouTrack login (resolve names via get_developer_configs).",
			},
			"subsystem": map[string]string{
				"type":        "string",
				"description": "Only tickets with this subsystem (exact project value).",
			},
			"to_state": map[string]string{
				"type":        "string",
				"description": "New state/column for every selected ticket. Validated against the project's real states.",
			},
			"to_sprint": map[string]string{
				"type":        "string",
				"description": "Move selected tickets to this sprint: 'next' (the sprint after the current one) or an exact sprint name. Tickets are added to it and removed from the source sprint.",
			},
			"dry_run": map[string]interface{}{
				"type":        "boolean",
				"description": "Default true: only preview. Set false ONLY after the user confirmed the preview.",
			},
		},
		"required": []string{},
	},
}

type bulkTicketPlan struct {
	issue       youtrack.Issue
	readable    string
	state       string
	changeState bool
}

func mcpBulkUpdateTickets(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		SprintName    string   `json:"sprint_name"`
		FromState     string   `json:"from_state"`
		FromRole      string   `json:"from_role"`
		TicketIDs     []string `json:"ticket_ids"`
		ExcludeIDs    []string `json:"exclude_ids"`
		AssigneeLogin string   `json:"assignee_login"`
		Subsystem     string   `json:"subsystem"`
		ToState       string   `json:"to_state"`
		ToSprint      string   `json:"to_sprint"`
		DryRun        *bool    `json:"dry_run"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return rpcErr(id, -32602, "invalid arguments")
	}
	dryRun := a.DryRun == nil || *a.DryRun
	a.ToState, a.ToSprint = strings.TrimSpace(a.ToState), strings.TrimSpace(a.ToSprint)
	if strings.TrimSpace(a.FromState) == "" && strings.TrimSpace(a.FromRole) == "" && len(a.TicketIDs) == 0 {
		return toolError(id, "select tickets with from_state, from_role and/or ticket_ids")
	}
	if a.ToState == "" && a.ToSprint == "" {
		return toolError(id, "nothing to do: give to_state and/or to_sprint")
	}

	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return toolError(id, "YouTrack not configured. Add your YouTrack integration in Velocity → Integrations")
	}
	bc, err := loadMCPBoardContext(ctx, yt, userID)
	if err != nil {
		return toolError(id, err.Error())
	}

	// Scope sprint: the named one, else the current sprint of the selected board.
	scopeRef := strings.TrimSpace(a.SprintName)
	if scopeRef == "" {
		scopeRef = "current"
	}
	source, err := bc.findSprint(scopeRef)
	if err != nil {
		return toolError(id, err.Error())
	}

	// Selection states (union of from_state and from_role).
	fromStates := map[string]bool{}
	var fromList []string
	if fs := strings.TrimSpace(a.FromState); fs != "" {
		st, err := bc.resolveState(fs)
		if err != nil {
			return toolError(id, "from_state: "+err.Error())
		}
		fromStates[strings.ToLower(st)] = true
		fromList = append(fromList, st)
	}
	if fr := strings.TrimSpace(a.FromRole); fr != "" {
		sts, err := bc.statesForRole(fr)
		if err != nil {
			return toolError(id, err.Error())
		}
		for _, st := range sts {
			if !fromStates[strings.ToLower(st)] {
				fromStates[strings.ToLower(st)] = true
				fromList = append(fromList, st)
			}
		}
	}

	toState := ""
	if a.ToState != "" {
		if toState, err = bc.resolveState(a.ToState); err != nil {
			return toolError(id, "to_state: "+err.Error())
		}
	}
	var target *youtrack.Sprint
	if a.ToSprint != "" {
		if target, err = bc.findSprint(a.ToSprint); err != nil {
			return toolError(id, "to_sprint: "+err.Error())
		}
		if target.ID == source.ID {
			return toolError(id, fmt.Sprintf("to_sprint %q is the same sprint the tickets are selected from", target.Name))
		}
	}

	// Board-scoped sprint membership via the agile endpoint (the YQL
	// "sprint:" attribute doesn't reliably match board sprints).
	issues, err := yt.GetAllSprintIssues(ctx, source.ID)
	if err != nil {
		return toolError(id, fmt.Sprintf("failed to fetch issues of sprint %q: %s", source.Name, err))
	}

	wanted := upperSet(a.TicketIDs)
	excluded := upperSet(a.ExcludeIDs)
	found := map[string]bool{}
	var plans []bulkTicketPlan
	for _, is := range issues {
		readable := is.IDReadable
		if readable == "" {
			readable = is.ID
		}
		key := strings.ToUpper(readable)
		if len(wanted) > 0 {
			if !wanted[key] {
				continue
			}
			found[key] = true
		}
		if excluded[key] {
			continue
		}
		state := youtrack.GetStatus(is)
		if len(fromStates) > 0 && !fromStates[strings.ToLower(state)] {
			continue
		}
		if a.AssigneeLogin != "" {
			au := youtrack.GetAssignee(is)
			if au == nil || !(strings.EqualFold(au.Login, a.AssigneeLogin) || strings.EqualFold(au.FullName, a.AssigneeLogin)) {
				continue
			}
		}
		if a.Subsystem != "" && !strings.EqualFold(youtrack.GetSubsystem(is), strings.TrimSpace(a.Subsystem)) {
			continue
		}
		p := bulkTicketPlan{issue: is, readable: readable, state: state}
		p.changeState = toState != "" && !strings.EqualFold(state, toState)
		if !p.changeState && target == nil {
			continue // already in the target state and no sprint move
		}
		plans = append(plans, p)
	}
	var notInSprint []string
	for _, tid := range a.TicketIDs {
		if !found[strings.ToUpper(strings.TrimSpace(tid))] {
			notInSprint = append(notInSprint, strings.TrimSpace(tid))
		}
	}

	if len(plans) > mcpBulkUpdateCap {
		return toolError(id, fmt.Sprintf("%d tickets match, more than the %d per call limit. Narrow the selection (assignee_login, subsystem, exclude_ids, ticket_ids) and run in batches", len(plans), mcpBulkUpdateCap))
	}

	ytBaseURL := strings.TrimRight(yt.GetBaseURL(), "/")
	result := map[string]interface{}{
		"dry_run":       dryRun,
		"board":         map[string]string{"id": bc.BoardID, "name": bc.BoardName},
		"source_sprint": source.Name,
		"selected_by":   map[string]interface{}{"states": fromList, "ticket_ids": a.TicketIDs, "exclude_ids": a.ExcludeIDs, "assignee_login": a.AssigneeLogin, "subsystem": a.Subsystem},
		"target_state":  toState,
		"target_sprint": "",
		"count":         len(plans),
		"not_in_sprint": notInSprint,
		"sprint_issues": len(issues),
	}
	if target != nil {
		result["target_sprint"] = target.Name
		if w := finishedSprintWarning(target, time.Now()); w != "" {
			result["warning"] = w
		}
	}
	if len(notInSprint) > 0 {
		result["not_in_sprint_note"] = fmt.Sprintf("These ticket_ids are not in sprint %q on this board, so they are skipped. Pass sprint_name if they live in another sprint.", source.Name)
	}

	rows := make([]map[string]interface{}, 0, len(plans))
	succeeded, failed := 0, 0
	for _, p := range plans {
		row := map[string]interface{}{
			"id":             p.readable,
			"summary":        p.issue.Summary,
			"current_state":  p.state,
			"current_sprint": source.Name,
			"url":            fmt.Sprintf("%s/issue/%s", ytBaseURL, p.readable),
		}
		if au := youtrack.GetAssignee(p.issue); au != nil {
			row["assignee"] = au.Login
		}
		if p.changeState {
			row["new_state"] = toState
		} else if toState != "" {
			row["new_state"] = toState + " (already)"
		}
		if target != nil {
			row["new_sprint"] = target.Name
		}
		if !dryRun {
			if errs := applyBulkPlan(ctx, yt, p, toState, source, target); len(errs) > 0 {
				failed++
				row["ok"] = false
				row["errors"] = errs
			} else {
				succeeded++
				row["ok"] = true
			}
		}
		rows = append(rows, row)
	}
	result["tickets"] = rows
	if dryRun {
		if len(plans) == 0 {
			result["message"] = "No tickets match, nothing would change."
		} else {
			result["message"] = fmt.Sprintf("Preview only, nothing changed. Show these %d ticket(s) to the user and ask for confirmation. Then call again with dry_run=false and ticket_ids set to these IDs.", len(plans))
			if w, ok := result["warning"].(string); ok {
				result["message"] = result["message"].(string) + " Show this warning to the user too: " + w
			}
		}
	} else {
		result["succeeded"] = succeeded
		result["failed"] = failed
		result["message"] = fmt.Sprintf("Updated %d of %d tickets, %d failed.", succeeded, len(plans), failed)
	}
	data, _ := json.Marshal(result)
	return toolOK(id, string(data))
}

// applyBulkPlan performs one ticket's changes: state first, then the sprint
// move (add to target before removing from source, so a failed add never
// leaves the ticket in no sprint). Returns the errors of each failed step.
func applyBulkPlan(ctx context.Context, yt *youtrack.Client, p bulkTicketPlan, toState string, source, target *youtrack.Sprint) []string {
	var errs []string
	if p.changeState {
		if err := yt.UpdateIssueState(ctx, p.readable, toState); err != nil {
			errs = append(errs, "state change failed: "+err.Error())
		}
	}
	if target != nil {
		if err := yt.AddIssueToSprint(ctx, target.ID, p.issue.ID); err != nil {
			errs = append(errs, fmt.Sprintf("adding to sprint %q failed: %s", target.Name, err))
		} else if stillInSource(ctx, yt, p.issue.ID, source.ID) {
			// Boards that allow a card on several sprints keep the old sprint, so
			// remove it explicitly. Boards that don't already moved it on add.
			if err := yt.RemoveIssueFromSprint(ctx, source.ID, p.issue.ID); err != nil {
				errs = append(errs, fmt.Sprintf("added to %q but removing from %q failed: %s", target.Name, source.Name, err))
			}
		}
	}
	return errs
}

// stillInSource reports whether the issue is still in the source sprint. On a
// lookup error it returns true so the removal is attempted anyway.
func stillInSource(ctx context.Context, yt *youtrack.Client, issueID, sourceID string) bool {
	sprints, err := yt.GetIssueSprints(ctx, issueID)
	if err != nil {
		return true
	}
	for _, s := range sprints {
		if s.ID == sourceID {
			return true
		}
	}
	return false
}

func upperSet(ids []string) map[string]bool {
	out := make(map[string]bool, len(ids))
	for _, s := range ids {
		if s = strings.ToUpper(strings.TrimSpace(s)); s != "" {
			out[s] = true
		}
	}
	return out
}

// finishedSprintWarning flags a target sprint that is already completed or
// whose finish date has passed, since moving open tickets there is usually a
// mistake. The move is still allowed once the user confirms.
func finishedSprintWarning(sp *youtrack.Sprint, now time.Time) string {
	switch {
	case sp.IsCompleted:
		return fmt.Sprintf("⚠️ %s is marked completed. Moving open tickets into a finished sprint is usually a mistake.", sp.Name)
	case sp.Finish > 0 && time.UnixMilli(sp.Finish).Before(now):
		return fmt.Sprintf("⚠️ %s already ended on %s. Moving open tickets into a finished sprint is usually a mistake.", sp.Name, time.UnixMilli(sp.Finish).UTC().Format("Jan 2, 2006"))
	}
	return ""
}
