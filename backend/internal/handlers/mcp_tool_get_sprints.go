package handlers

import (
	"context"
	"encoding/json"
)

var getSprintsToolSchema = map[string]interface{}{
	"name": "get_sprints",
	"description": "Returns all sprints for the YouTrack project, with their ID, name, and whether they are completed. " +
		"Use this when the user mentions a specific sprint by name (e.g. 'Sprint 6', 'Sprint 8') to resolve its ID before calling create_youtrack_ticket. " +
		"The latest non-completed sprint is the active sprint.",
	"inputSchema": map[string]interface{}{
		"type":       "object",
		"properties": map[string]interface{}{},
		"required":   []string{},
	},
}

func mcpGetSprints(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}
	sprints, err := ytClient.GetSprints(ctx)
	if err != nil {
		return toolError(id, "Failed to fetch sprints: "+err.Error())
	}
	data, _ := json.Marshal(sprints)
	return toolOK(id, string(data))
}
