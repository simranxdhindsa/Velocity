package handlers

import (
	"context"
	"encoding/json"
)

var getDeveloperConfigsToolSchema = map[string]interface{}{
	"name": "get_developer_configs",
	"description": "Returns the developer→subsystem mapping configured in Velocity (Integrations → Developers tab). " +
		"Use this when creating a YouTrack ticket to find which developers own a given subsystem, " +
		"so you can auto-assign the ticket to the developer with the lowest current workload. " +
		"Each entry has: developer_login (YouTrack login), developer_name (display name), subsystems (list of subsystems they own), is_qa (true if QA role).",
	"inputSchema": map[string]interface{}{
		"type":       "object",
		"properties": map[string]interface{}{},
		"required":   []string{},
	},
}

func mcpGetDeveloperConfigs(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	configs, err := devConfigRepo.GetAll(ctx)
	if err != nil {
		return toolError(id, "Failed to fetch developer configs: "+err.Error())
	}
	data, _ := json.Marshal(configs)
	return toolOK(id, string(data))
}
