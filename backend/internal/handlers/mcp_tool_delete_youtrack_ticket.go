package handlers

import (
	"context"
	"encoding/json"
)

var deleteYoutrackTicketToolSchema = map[string]interface{}{
	"name":        "delete_youtrack_ticket",
	"description": "Permanently deletes a YouTrack ticket by its readable ID (e.g. ARD-123). Always confirm with the user before calling this.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"issue_id": map[string]string{
				"type":        "string",
				"description": "Readable ticket ID, e.g. ARD-123.",
			},
		},
		"required": []string{"issue_id"},
	},
}

func mcpDeleteYoutrackTicket(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		IssueID string `json:"issue_id"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.IssueID == "" {
		return rpcErr(id, -32602, "invalid arguments: issue_id is required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}
	if err := ytClient.DeleteIssue(ctx, a.IssueID); err != nil {
		return toolError(id, "failed to delete "+a.IssueID+": "+err.Error())
	}
	return toolOK(id, "Deleted "+a.IssueID)
}
