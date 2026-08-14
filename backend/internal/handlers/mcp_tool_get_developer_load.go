package handlers

import (
	"context"
	"encoding/json"
)

var getDeveloperLoadToolSchema = map[string]interface{}{
	"name": "get_developer_load",
	"description": "Returns the open ticket count for one or more YouTrack developer logins. " +
		"Use this after get_developer_configs to decide who to auto-assign a ticket to — pick the developer with the lowest count. " +
		"Pass a list of logins (e.g. [\"parv\", \"harpreet\"]) and get back {login: count} pairs.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"logins": map[string]interface{}{
				"type":        "array",
				"items":       map[string]string{"type": "string"},
				"description": "List of YouTrack developer login names to check workload for.",
			},
		},
		"required": []string{"logins"},
	},
}

func mcpGetDeveloperLoad(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Logins []string `json:"logins"`
	}
	if err := json.Unmarshal(args, &a); err != nil || len(a.Logins) == 0 {
		return rpcErr(id, -32602, "invalid arguments: logins array is required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}
	sprintName, err := ytClient.GetLatestSprintName(ctx)
	if err != nil || sprintName == "" {
		return toolError(id, "could not determine current sprint: "+err.Error())
	}
	load := map[string]int{}
	for _, login := range a.Logins {
		count, err := ytClient.CountActiveIssuesByAssigneeInSprint(ctx, login, sprintName)
		if err != nil {
			load[login] = -1
		} else {
			load[login] = count
		}
	}
	data, _ := json.Marshal(map[string]interface{}{
		"sprint": sprintName,
		"load":   load,
	})
	return toolOK(id, string(data))
}
