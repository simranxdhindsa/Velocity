package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var createYoutrackTicketToolSchema = map[string]interface{}{
	"name": "create_youtrack_ticket",
	"description": "Creates a new ticket in YouTrack. Call this only after the user has confirmed the ticket details. " +
		"Who must fill what depends on the caller's ticket role (whoami youtrack.ticket_role): a developer (owns a subsystem) must pass testing_scenarios, " +
		"QA (or anyone with no subsystem) must pass acceptance_criteria. Ask the user for the missing one before calling; the tool refuses without it. " +
		"When a developer files a ticket without acceptance criteria, Velocity comments on it asking the QA team to add them. " +
		"EPICS: a Feature or Enhancement must be linked to an open epic (pass epic) or confirmed as standalone (standalone: true); call list_youtrack_epics first and suggest the matching epic. " +
		"Bugs, regressions and hotfixes may pass epic when they were found while testing that feature. " +
		"To create an epic itself, use type_name Epic with just a plain feature name as summary (e.g. 'Composer'); it gets Subsystem Epic, is added to the current sprint and any planned ones (not finished yet) so the board shows its swimlane, and needs no testing scenarios or acceptance criteria. " +
		"Returns the created ticket ID (e.g. ARD-123) and its URL.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"summary": map[string]string{
				"type":        "string",
				"description": "Ticket title: '<Action Verb> <What>'. Max 80 chars. Velocity adds the priority and subsystem in front automatically, giving '<Priority> <Subsystem>: <Title>' (e.g. 'A3 FE MC: Fix login button'), so don't add them yourself.",
			},
			"description": map[string]string{
				"type":        "string",
				"description": "Full ticket description (markdown supported). A 'Created by Velocity 🤖' footer is added automatically; don't write it yourself.",
			},
			"testing_scenarios": map[string]string{
				"type":        "string",
				"description": "How to test this and what else the change could affect (markdown list). Required when the caller is a developer. Added as a 'Testing Scenarios' section; don't put it in description too.",
			},
			"acceptance_criteria": map[string]string{
				"type":        "string",
				"description": "What must be true for the ticket to count as done (markdown list). Required when the caller is QA. Added as an 'Acceptance Criteria' section; don't put it in description too.",
			},
			"type_name": map[string]string{
				"type":        "string",
				"description": "Issue type: Bug, Feature, Enhancement, Hotfix, Regression, Task, or Epic.",
			},
			"epic": map[string]string{
				"type":        "string",
				"description": "Readable ID of the open epic this ticket belongs to, e.g. ARD-3233 (from list_youtrack_epics). The ticket is linked to it as a subtask.",
			},
			"standalone": map[string]string{
				"type":        "boolean",
				"description": "true when the user confirmed a Feature or Enhancement is a small change that belongs to no epic.",
			},
			"priority": map[string]string{
				"type":        "string",
				"description": "Priority: Show-stopper, P0, P1, P2, P3, A0, A1, A2, A3, or Normal.",
			},
			"subsystem": map[string]string{
				"type":        "string",
				"description": "Subsystem name exactly as configured in Velocity (e.g. 'FE UI', 'BE MC', 'Mobile').",
			},
			"assignee_login": map[string]string{
				"type":        "string",
				"description": "YouTrack login of the assignee. Omit or pass empty string to leave unassigned.",
			},
			"sprint_id": map[string]string{
				"type":        "string",
				"description": "Optional. YouTrack sprint ID to attach the ticket to.",
			},
		},
		"required": []string{"summary", "type_name", "priority"},
	},
}

func mcpCreateYoutrackTicket(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Summary       string `json:"summary"`
		Description   string `json:"description"`
		TypeName      string `json:"type_name"`
		Priority      string `json:"priority"`
		Subsystem     string `json:"subsystem"`
		AssigneeLogin string `json:"assignee_login"`
		SprintID      string `json:"sprint_id"`
		Testing       string `json:"testing_scenarios"`
		Acceptance    string `json:"acceptance_criteria"`
		Epic          string `json:"epic"`
		Standalone    bool   `json:"standalone"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.Summary == "" {
		return rpcErr(id, -32602, "invalid arguments: summary is required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}

	isEpic := strings.EqualFold(strings.TrimSpace(a.TypeName), "Epic")
	a.Epic = strings.TrimSpace(a.Epic)
	a.Testing, a.Acceptance = strings.TrimSpace(a.Testing), strings.TrimSpace(a.Acceptance)
	if isEpic {
		a.Subsystem = "Epic" // YouTrack requires a Subsystem; this value marks feature epics
		a.Epic = ""          // an epic is never a subtask of another epic
	} else {
		role := mcpCallerTicketRole(ctx, ytClient, userID)
		if role == ticketRoleDeveloper && a.Testing == "" {
			return toolError(id, "Testing scenarios are required when a developer creates a ticket. Ask the user how to test this change and what else it could affect, then call again with testing_scenarios.")
		}
		if role == ticketRoleQA && a.Acceptance == "" {
			return toolError(id, "Acceptance criteria are required when QA creates a ticket. Ask the user what must be true for this ticket to count as done, then call again with acceptance_criteria.")
		}
	}

	var epics []youtrack.Issue // open epics, loaded only when needed
	if !isEpic {
		reason := epicRequirement(a.TypeName, a.Epic, a.Standalone)
		if reason != "" || a.Epic != "" {
			var err error
			if epics, err = openEpics(ctx, ytClient); err != nil {
				return toolError(id, "could not load open epics: "+err.Error())
			}
		}
		if reason != "" {
			return toolError(id, reason+" Open epics: "+epicChoices(epics)+".")
		}
		if a.Epic != "" && findEpic(epics, a.Epic) == nil {
			return toolError(id, fmt.Sprintf("%s is not an open epic. Open epics: %s.", a.Epic, epicChoices(epics)))
		}
	}

	summary := buildTicketTitle(a.Priority, a.Subsystem, a.Summary)
	desc := withTestingSections(a.Description, a.Testing, a.Acceptance)
	if isEpic {
		summary = strings.TrimSpace(a.Summary) // epics are named after the feature, no prefix
		desc = a.Description
	}
	req := youtrack.CreateIssueRequest{Summary: summary, Description: youtrack.WithVelocityFooter(desc)}
	var fields []youtrack.CustomField

	// Always default state to "To Do"
	fields = append(fields, youtrack.CustomField{
		Type:  "StateIssueCustomField",
		Name:  "State",
		Value: map[string]string{"name": "To Do"},
	})
	if a.TypeName != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleEnumIssueCustomField",
			Name:  "Type",
			Value: map[string]string{"name": a.TypeName},
		})
	}
	if a.Priority != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleEnumIssueCustomField",
			Name:  "Priority",
			Value: map[string]string{"name": a.Priority},
		})
	}
	if a.Subsystem != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleOwnedIssueCustomField",
			Name:  "Subsystem",
			Value: map[string]interface{}{"$type": "OwnedBundleElement", "name": a.Subsystem},
		})
	}
	if a.AssigneeLogin != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleUserIssueCustomField",
			Name:  "Assignee",
			Value: map[string]string{"login": a.AssigneeLogin},
		})
	}
	req.CustomFields = fields

	issue, err := ytClient.CreateIssue(ctx, req)
	if err != nil {
		return toolError(id, "Failed to create ticket: "+err.Error())
	}

	displayID := issue.IDReadable
	if displayID == "" {
		displayID = issue.ID
	}

	// Assign to sprint — use provided sprint_id or auto-pick the latest active sprint.
	// An epic goes into the current and planned sprints instead (newTicketSprints): the board draws an epic's
	// swimlane only when the epic is in the sprint shown.
	sprintIDs := []string{}
	if a.SprintID != "" {
		sprintIDs = append(sprintIDs, a.SprintID)
	} else if sprints, sErr := ytClient.GetSprints(ctx); sErr == nil {
		sprintIDs = newTicketSprints(sprints, isEpic, time.Now())
	}
	epicSprintNote := ""
	if issue.ID != "" {
		failed := 0
		for _, sid := range sprintIDs {
			if err := ytClient.AddIssueToSprint(ctx, sid, issue.ID); err != nil {
				failed++
				if isEpic {
					slog.WarnContext(ctx, "Created an epic but could not add it to a sprint, its board row will be missing", "ticket", displayID, "sprint_id", sid, "error", err)
				}
			}
		}
		if isEpic && (len(sprintIDs) == 0 || failed > 0) {
			epicSprintNote = "WARNING: the epic could not be added to the current sprint, so its board row may be missing. Add it to the current sprint in YouTrack (Boards field)."
		}
	}
	ytBaseURL := strings.TrimRight(ytClient.GetBaseURL(), "/")
	ticketURL := fmt.Sprintf("%s/issue/%s", ytBaseURL, displayID)
	result := fmt.Sprintf("Created %s — %s\n%s", displayID, issue.Summary, ticketURL)
	if epicSprintNote != "" {
		result = epicSprintNote + "\n" + result
	}
	if epic := findEpic(epics, a.Epic); epic != nil {
		if note, ok := linkToEpic(ctx, ytClient, displayID, epic); ok {
			result += "\n" + note
		} else {
			result = note + "\n" + result // lead with the failure so it is not missed
		}
	} else if !isEpic && epicRequirement(a.TypeName, "", false) == "" && !a.Standalone {
		// Bugs and the like may skip the epic; show the open ones in case it was found while testing a feature.
		if open, err := openEpics(ctx, ytClient); err == nil && len(open) > 0 {
			result += "\nNot linked to an epic. If this was found while testing one of these features, link it with link_youtrack_tickets (subtask of): " + epicChoices(open)
		}
	}
	if a.Acceptance == "" && !isEpic {
		result += "\n" + requestAcceptanceCriteria(ctx, ytClient, displayID)
	}
	return toolOK(id, result)
}

// linkToEpic links a new ticket under its epic and says how that went. YouTrack
// can't set a parent while creating an issue, so this runs right after create.
func linkToEpic(ctx context.Context, yt *youtrack.Client, ticket string, epic *youtrack.Issue) (string, bool) {
	if err := yt.LinkIssues(ctx, ticket, "subtask of "+epic.IDReadable); err != nil {
		slog.ErrorContext(ctx, "Created a ticket but could not link it to its epic, it will be missing from the epic", "ticket", ticket, "epic", epic.IDReadable, "error", err)
		return fmt.Sprintf("WARNING: %s was created but NOT linked to epic %s (%v). Do not create it again; link it with link_youtrack_tickets (%s subtask of %s).", ticket, epic.IDReadable, err, ticket, epic.IDReadable), false
	}
	slog.InfoContext(ctx, "Ticket added to epic", "ticket", ticket, "epic", epic.IDReadable, "epic_name", epic.Summary)
	return fmt.Sprintf("Added to epic %s %s.", epic.IDReadable, epic.Summary), true
}

// requestAcceptanceCriteria comments on a developer-filed ticket, @mentioning
// every configured QA so YouTrack notifies them to add the acceptance criteria.
func requestAcceptanceCriteria(ctx context.Context, yt *youtrack.Client, ticket string) string {
	qa := qaReviewers(ctx)
	if len(qa) == 0 {
		slog.WarnContext(ctx, "No QA configured to add acceptance criteria", "ticket", ticket)
		return "No QA is marked in Velocity (Integrations > Developers), so nobody was asked for acceptance criteria yet."
	}
	mentions, names := make([]string, len(qa)), make([]string, len(qa))
	for i, q := range qa {
		mentions[i], names[i] = "@"+q.DeveloperLogin, q.DeveloperName
	}
	text := strings.Join(mentions, " ") + " please add the acceptance criteria for this ticket under the Acceptance Criteria section of the description."
	if _, err := yt.AddMarkdownComment(ctx, ticket, text, nil); err != nil {
		slog.ErrorContext(ctx, "Could not ask QA for acceptance criteria, the ticket has no reminder comment", "ticket", ticket, "error", err)
		return "Could not post the comment asking QA for acceptance criteria: " + err.Error()
	}
	slog.InfoContext(ctx, "Asked QA to add acceptance criteria", "ticket", ticket, "qa", strings.Join(names, ", "))
	return "Asked QA (" + strings.Join(names, ", ") + ") in a ticket comment to add the acceptance criteria."
}

// newTicketSprints picks the sprints a new ticket goes into: the latest
// sprint not marked completed, as before. An epic instead goes into every
// sprint that is not completed and has not finished yet (the current one and
// any planned ones), falling back to the latest. Finish dates matter because
// this board never marks old sprints completed.
func newTicketSprints(sprints []youtrack.Sprint, isEpic bool, now time.Time) []string {
	latest := ""
	for i := len(sprints) - 1; i >= 0; i-- {
		if !sprints[i].IsCompleted {
			latest = sprints[i].ID
			break
		}
	}
	if !isEpic {
		if latest == "" {
			return nil
		}
		return []string{latest}
	}
	var open []string
	for _, sp := range sprints {
		if !sp.IsCompleted && (sp.Finish == 0 || sp.Finish >= now.UnixMilli()) {
			open = append(open, sp.ID)
		}
	}
	if len(open) == 0 && latest != "" {
		open = []string{latest}
	}
	return open
}
