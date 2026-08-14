package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var createYoutrackTicketToolSchema = map[string]interface{}{
	"name": "create_youtrack_ticket",
	"description": "Creates a new ticket in YouTrack. Call this only after the user has confirmed the ticket details. " +
		"Returns the created ticket ID (e.g. ARD-123) and its URL.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"summary": map[string]string{
				"type":        "string",
				"description": "Ticket title. Format: '<Subsystem>: <Action Verb> <What>'. Max 80 chars.",
			},
			"description": map[string]string{
				"type":        "string",
				"description": "Full ticket description (markdown supported).",
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
	}
	if err := json.Unmarshal(args, &a); err != nil || a.Summary == "" {
		return rpcErr(id, -32602, "invalid arguments: summary is required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}

	req := youtrack.CreateIssueRequest{Summary: a.Summary, Description: a.Description}
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
	return toolOK(id, result)
}
