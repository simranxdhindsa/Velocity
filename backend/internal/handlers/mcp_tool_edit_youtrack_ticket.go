package handlers

import (
	"context"
	"encoding/json"
	"fmt"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var editYoutrackTicketToolSchema = map[string]interface{}{
	"name":        "edit_youtrack_ticket",
	"description": "Updates one or more fields of an existing YouTrack ticket. Only pass the fields you want to change — omitted fields are left untouched.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"issue_id": map[string]string{
				"type":        "string",
				"description": "Readable ticket ID, e.g. ARD-123.",
			},
			"summary": map[string]string{
				"type":        "string",
				"description": "New title. Omit to leave unchanged.",
			},
			"description": map[string]string{
				"type":        "string",
				"description": "New description (markdown). Omit to leave unchanged.",
			},
			"type_name": map[string]string{
				"type":        "string",
				"description": "New type: Bug, Feature, Enhancement, Hotfix, or Regression. Omit to leave unchanged.",
			},
			"priority": map[string]string{
				"type":        "string",
				"description": "New priority: Show-stopper, P0, P1, P2, P3, A0, A1, A2, A3, or Normal. Omit to leave unchanged.",
			},
			"subsystem": map[string]string{
				"type":        "string",
				"description": "New subsystem name. Omit to leave unchanged.",
			},
			"assignee_login": map[string]string{
				"type":        "string",
				"description": "New assignee YouTrack login. Omit to leave the assignee unchanged.",
			},
			"state": map[string]string{
				"type":        "string",
				"description": "New state name, e.g. 'In Progress', 'To Do', 'Closed'. Omit to leave unchanged.",
			},
		},
		"required": []string{"issue_id"},
	},
}

func mcpEditYoutrackTicket(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		IssueID       string `json:"issue_id"`
		Summary       string `json:"summary"`
		Description   string `json:"description"`
		TypeName      string `json:"type_name"`
		Priority      string `json:"priority"`
		Subsystem     string `json:"subsystem"`
		AssigneeLogin string `json:"assignee_login"`
		State         string `json:"state"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.IssueID == "" {
		return rpcErr(id, -32602, "invalid arguments: issue_id is required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}
	// Only set top-level fields if the caller actually provided them;
	// omitempty on the struct handles zero values but we guard here too.
	req := youtrack.UpdateIssueRequest{}
	if a.Summary != "" {
		req.Summary = a.Summary
	}
	if a.Description != "" {
		req.Description = a.Description
	}
	if a.TypeName != "" {
		req.CustomFields = append(req.CustomFields, youtrack.CustomField{
			Type:  "SingleEnumIssueCustomField",
			Name:  "Type",
			Value: map[string]string{"name": a.TypeName},
		})
	}
	if a.Priority != "" {
		req.CustomFields = append(req.CustomFields, youtrack.CustomField{
			Type:  "SingleEnumIssueCustomField",
			Name:  "Priority",
			Value: map[string]string{"name": a.Priority},
		})
	}
	if a.Subsystem != "" {
		req.CustomFields = append(req.CustomFields, youtrack.CustomField{
			Type:  "SingleOwnedIssueCustomField",
			Name:  "Subsystem",
			Value: map[string]string{"name": a.Subsystem},
		})
	}
	if a.AssigneeLogin != "" {
		req.CustomFields = append(req.CustomFields, youtrack.CustomField{
			Type:  "SingleUserIssueCustomField",
			Name:  "Assignee",
			Value: map[string]string{"login": a.AssigneeLogin},
		})
	}
	if a.State != "" {
		req.CustomFields = append(req.CustomFields, youtrack.CustomField{
			Type:  "StateIssueCustomField",
			Name:  "State",
			Value: map[string]string{"name": a.State},
		})
	}
	issue, err := ytClient.UpdateIssue(ctx, a.IssueID, req)
	if err != nil {
		return toolError(id, "failed to update "+a.IssueID+": "+err.Error())
	}
	return toolOK(id, fmt.Sprintf("Updated %s — %s", a.IssueID, issue.Summary))
}
