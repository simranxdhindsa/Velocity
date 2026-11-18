package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var createYoutrackTicketToolSchema = map[string]interface{}{
	"name": "create_youtrack_ticket",
	"description": "Creates a new ticket in YouTrack. Call this only after the user has confirmed the ticket details. " +
		"Who must fill what depends on the caller's ticket role (whoami youtrack.ticket_role): a developer (owns a subsystem) must pass testing_scenarios, " +
		"QA (or anyone with no subsystem) must pass acceptance_criteria. Ask the user for the missing one before calling; the tool refuses without it. " +
		"When a developer files a ticket without acceptance criteria, Velocity comments on it asking the QA team to add them. " +
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
				"description": "Issue type: Bug, Feature, Enhancement, Hotfix, or Regression.",
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
	}
	if err := json.Unmarshal(args, &a); err != nil || a.Summary == "" {
		return rpcErr(id, -32602, "invalid arguments: summary is required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}

	a.Testing, a.Acceptance = strings.TrimSpace(a.Testing), strings.TrimSpace(a.Acceptance)
	role := mcpCallerTicketRole(ctx, ytClient, userID)
	if role == ticketRoleDeveloper && a.Testing == "" {
		return toolError(id, "Testing scenarios are required when a developer creates a ticket. Ask the user how to test this change and what else it could affect, then call again with testing_scenarios.")
	}
	if role == ticketRoleQA && a.Acceptance == "" {
		return toolError(id, "Acceptance criteria are required when QA creates a ticket. Ask the user what must be true for this ticket to count as done, then call again with acceptance_criteria.")
	}

	summary := buildTicketTitle(a.Priority, a.Subsystem, a.Summary)
	desc := withTestingSections(a.Description, a.Testing, a.Acceptance)
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

	// Assign to sprint — use provided sprint_id or auto-pick the latest active sprint
	sprintID := a.SprintID
	if sprintID == "" {
		if sprints, sErr := ytClient.GetSprints(ctx); sErr == nil {
			for i := len(sprints) - 1; i >= 0; i-- {
				if !sprints[i].IsCompleted {
					sprintID = sprints[i].ID
					break
				}
			}
		}
	}
	if sprintID != "" && issue != nil && issue.ID != "" {
		_ = ytClient.AddIssueToSprint(ctx, sprintID, issue.ID)
	}

	displayID := issue.IDReadable
	if displayID == "" {
		displayID = issue.ID
	}
	ytBaseURL := strings.TrimRight(ytClient.GetBaseURL(), "/")
	ticketURL := fmt.Sprintf("%s/issue/%s", ytBaseURL, displayID)
	result := fmt.Sprintf("Created %s — %s\n%s", displayID, issue.Summary, ticketURL)
	if a.Acceptance == "" {
		result += "\n" + requestAcceptanceCriteria(ctx, ytClient, displayID)
	}
	return toolOK(id, result)
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
