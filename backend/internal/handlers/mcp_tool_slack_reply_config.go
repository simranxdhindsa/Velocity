package handlers

import (
	"context"
	"encoding/json"

	"github.com/dhindsa/project-management/internal/models"
)

var getSlackReplyConfigToolSchema = map[string]interface{}{
	"name": "get_slack_reply_config",
	"description": "Get the current persona/system prompt Velocity uses when it auto-replies to a Slack DM or @mention " +
		"(the funny-reply bot). This is a bot_configs row (bot_type='slack_reply'), editable here or from the Bot " +
		"Config page in Velocity itself — not a hardcoded prompt.",
	"inputSchema": map[string]interface{}{
		"type":       "object",
		"properties": map[string]interface{}{},
	},
}

var updateSlackReplyConfigToolSchema = map[string]interface{}{
	"name": "update_slack_reply_config",
	"description": "Update the persona/system prompt Velocity uses when it auto-replies to a Slack DM or @mention " +
		"(e.g. 'make it more sarcastic', 'stop using puns'). Edits the existing bot_configs row (bot_type='slack_reply') " +
		"in place — call get_slack_reply_config first if you need to see the current prompt before changing it.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"prompt": map[string]string{
				"type":        "string",
				"description": "The new full system prompt text for the Slack reply persona, replacing the existing one.",
			},
		},
		"required": []string{"prompt"},
	},
}

func mcpGetSlackReplyConfig(ctx context.Context, h *MCPHandler, _ string, id interface{}, _ json.RawMessage) rpcResponse {
	configs, err := h.botRepo.GetByType(ctx, models.BotTypeSlackReply)
	if err != nil {
		return toolError(id, "Failed to load config: "+err.Error())
	}
	if len(configs) == 0 {
		return toolError(id, "No slack_reply bot config found — it should have been seeded by migrations; check the deployment.")
	}
	c := configs[0]
	result := "Active: " + boolStr(c.IsActive) + "\n\nPrompt:\n" + c.Prompt
	return toolOK(id, result)
}

func mcpUpdateSlackReplyConfig(ctx context.Context, h *MCPHandler, _ string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.Prompt == "" {
		return rpcErr(id, -32602, "invalid arguments: prompt is required")
	}

	configs, err := h.botRepo.GetByType(ctx, models.BotTypeSlackReply)
	if err != nil {
		return toolError(id, "Failed to load config: "+err.Error())
	}
	if len(configs) == 0 {
		return toolError(id, "No slack_reply bot config found — it should have been seeded by migrations; check the deployment.")
	}

	c := configs[0]
	c.Prompt = a.Prompt
	if err := h.botRepo.Update(ctx, c); err != nil {
		return toolError(id, "Failed to update config: "+err.Error())
	}

	return toolOK(id, "Updated the Slack reply persona. Takes effect on the next DM/mention, no restart needed.")
}

func boolStr(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}
