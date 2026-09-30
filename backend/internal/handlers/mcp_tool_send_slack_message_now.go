package handlers

import (
	"context"
	"encoding/json"
	"time"
)

var sendSlackMessageNowToolSchema = map[string]interface{}{
	"name": "send_slack_message_now",
	"description": "Send a Slack message immediately, bypassing the review queue. " +
		"Use this when the user explicitly wants the message sent right now, not staged for later review. " +
		"For anything the user wants scheduled, reviewed first, or sent at a specific/default time, use " +
		"queue_slack_message instead. Only `message` is required, plus one of `channel`/`dm_user`. " +
		"Include @mentions by display name (e.g. @Suryansh) and they will resolve to Slack mentions automatically. " +
		"Do NOT call list_slack_channels first — just pass the channel name the user mentioned.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"message": map[string]string{
				"type":        "string",
				"description": "The message text. Use @DisplayName for mentions (e.g. @Suryansh).",
			},
			"channel": map[string]string{
				"type":        "string",
				"description": "Channel name as the user mentioned it, e.g. 'ardoise-pm', '#general'. Omit if sending a DM.",
			},
			"dm_user": map[string]string{
				"type":        "string",
				"description": "Display name or real name of the person to DM (e.g. 'Suryansh', 'Simran Dhindsa'). Use instead of channel for direct messages.",
			},
		},
		"required": []string{"message"},
	},
}

func mcpSendSlackMessageNow(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Message string `json:"message"`
		Channel string `json:"channel"`
		DmUser  string `json:"dm_user"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.Message == "" {
		return rpcErr(id, -32602, "invalid arguments: message is required")
	}
	if a.Channel == "" && a.DmUser == "" {
		return toolError(id, "either channel or dm_user is required to send immediately")
	}

	channelID, channelLabel := h.resolveChannel(ctx, userID, a.Channel)
	dmUserID := h.resolveSlackUser(ctx, userID, a.DmUser)
	if a.DmUser != "" && dmUserID == "" {
		return toolError(id, "couldn't find a Slack user matching '"+a.DmUser+"'")
	}
	if a.Channel != "" && channelID == "" {
		return toolError(id, "couldn't find a Slack channel matching '"+a.Channel+"' — check the name in Velocity")
	}

	message := resolveSlackMentions(ctx, h.slackSvc, userID, a.Message)

	// Record it in the same queue table Claude Queue reads from, so an instant
	// send still shows up in Update Reminders (KPI, Recent list, "Delete from
	// Slack") instead of vanishing once sent. Mirrors the manual "Send now"
	// flow in pending_messages.go, just without the pending window.
	now := time.Now()
	queued, qerr := h.msgRepo.Create(ctx, userID, message, channelID, channelLabel, dmUserID, &now)

	ts, resolvedChannelID, err := h.updateSvc.QuickSend(ctx, userID, channelID, message, dmUserID, "claude_queue")
	if err != nil {
		if qerr == nil {
			_ = h.msgRepo.MarkFailed(ctx, queued.ID, err.Error())
		}
		return toolError(id, "Failed to send message: "+err.Error())
	}
	if qerr == nil {
		_ = h.msgRepo.MarkSent(ctx, queued.ID, ts)
	}

	result := "Sent."
	if channelLabel != "" {
		result += " Channel: " + channelLabel + "."
	} else if dmUserID != "" {
		result += " DM sent to " + a.DmUser + "."
	} else if resolvedChannelID != "" {
		result += " Channel ID: " + resolvedChannelID + "."
	}
	return toolOK(id, result)
}
