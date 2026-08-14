package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

var linkYoutrackTicketsToolSchema = map[string]interface{}{
	"name":        "link_youtrack_tickets",
	"description": "Links two YouTrack tickets together. Supported link types: 'relates to', 'depends on', 'is required for', 'duplicates', 'is duplicated by', 'subtask of', 'parent for'.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"source_id": map[string]string{
				"type":        "string",
				"description": "The ticket to add the link on, e.g. ARD-2213.",
			},
			"target_id": map[string]string{
				"type":        "string",
				"description": "The ticket to link to, e.g. ARD-2344.",
			},
			"link_type": map[string]string{
				"type":        "string",
				"description": "One of: 'relates to', 'depends on', 'is required for', 'duplicates', 'is duplicated by', 'subtask of', 'parent for'.",
			},
		},
		"required": []string{"source_id", "target_id", "link_type"},
	},
}

func mcpLinkYoutrackTickets(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		SourceID string `json:"source_id"`
		TargetID string `json:"target_id"`
		LinkType string `json:"link_type"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.SourceID == "" || a.TargetID == "" || a.LinkType == "" {
		return rpcErr(id, -32602, "invalid arguments: source_id, target_id, and link_type are required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}
	// Use YouTrack Commands API: "relates to ARD-2344" applied to ARD-2213.
	// Validate link type is one of the known values to give a clear error early.
	known := map[string]bool{
		"relates to": true, "depends on": true, "is required for": true,
		"duplicates": true, "is duplicated by": true, "subtask of": true, "parent for": true,
	}
	lt := strings.ToLower(strings.TrimSpace(a.LinkType))
	if !known[lt] {
		return toolError(id, fmt.Sprintf("unknown link_type %q — use one of: relates to, depends on, is required for, duplicates, is duplicated by, subtask of, parent for", a.LinkType))
	}
	command := fmt.Sprintf("%s %s", lt, a.TargetID)
	if err := ytClient.LinkIssues(ctx, a.SourceID, command); err != nil {
		return toolError(id, fmt.Sprintf("failed to link %s → %s: %s", a.SourceID, a.TargetID, err.Error()))
	}
	return toolOK(id, fmt.Sprintf("Linked %s '%s' %s", a.SourceID, lt, a.TargetID))
}
