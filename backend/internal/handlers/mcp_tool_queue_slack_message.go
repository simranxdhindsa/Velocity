package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

var queueSlackMessageToolSchema = map[string]interface{}{
	"name": "queue_slack_message",
	"description": "Queue a Slack message to be reviewed and sent by the Velocity bot. " +
		"Only `message` is required — channel/dm_user and time are optional. " +
		"Use `channel` for a channel post, or `dm_user` to send a direct message to a specific person. " +
		"If neither is given, the user will pick a destination in Velocity before sending. " +
		"Include @mentions by display name (e.g. @Suryansh) and they will resolve to Slack mentions automatically. " +
		"Do NOT call list_slack_channels first — just pass the channel name the user mentioned, or omit it.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"message": map[string]string{
				"type":        "string",
				"description": "The message text. Use @DisplayName for mentions (e.g. @Suryansh).",
			},
			"channel": map[string]string{
				"type": "string",
				"description": "Optional. Channel name as the user mentioned it, e.g. 'ardoise-pm', '#general'. Also accepts a raw Slack " +
					"conversation ID (e.g. 'C0B30MXMDHQ') for destinations with no name to look up, such as a group DM — pass the " +
					"ID directly here, not in dm_user. Omit if sending a 1:1 DM or if not specified.",
			},
			"dm_user": map[string]string{
				"type":        "string",
				"description": "Optional. Display name or real name of the person to DM (e.g. 'Suryansh', 'Simran Dhindsa'). Use instead of channel for direct messages.",
			},
			"send_time": map[string]string{
				"type": "string",
				"description": "Optional. Accepts a time-of-day today/tomorrow ('3:00 PM', '15:30', '9am') or a full ISO 8601 datetime ('2026-07-21T11:00:00'). " +
					"Does NOT understand relative phrases like 'next Monday' or 'tomorrow' as raw text — if the user says something like " +
					"'next Monday at 11am', compute the actual calendar date yourself (you know today's date) and pass the resolved ISO 8601 datetime instead. " +
					"Omit to use the user's saved default send time.",
			},
		},
		"required": []string{"message"},
	},
}

func mcpQueueSlackMessage(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Message  string `json:"message"`
		Channel  string `json:"channel"`   // optional channel name
		DmUser   string `json:"dm_user"`   // optional: DM recipient display name
		SendTime string `json:"send_time"` // optional: "3pm", "15:30", ISO 8601
	}
	if err := json.Unmarshal(args, &a); err != nil || a.Message == "" {
		return rpcErr(id, -32602, "invalid arguments: message is required")
	}

	// Resolve channel name → ID (best-effort; user can fix in Velocity if wrong)
	channelID, channelLabel := h.resolveChannel(ctx, userID, a.Channel)

	// Resolve dm_user display name → Slack user ID
	dmUserID := h.resolveSlackUser(ctx, userID, a.DmUser)

	// Resolve @DisplayName → <@UXXX> mentions in message text
	message := resolveSlackMentions(ctx, h.slackSvc, userID, a.Message)

	// Fetch user's default settings once — timezone used for both explicit and default paths
	defaultHHMM, tzName := h.settingsRepo.GetDefaultSendSettings(ctx, userID)
	userLoc, locErr := time.LoadLocation(tzName)
	if locErr != nil {
		userLoc = time.UTC
	}

	// Determine scheduled time — parse flexible natural time or fall back to user default
	var scheduledAt *time.Time
	if a.SendTime != "" {
		t, err := parseFlexTime(a.SendTime, userLoc)
		if err != nil {
			return toolError(id, "couldn't parse send_time '"+a.SendTime+"' — try '3:00 PM', '15:30', or '9am'")
		}
		scheduledAt = &t
	} else {
		now := time.Now().In(userLoc)
		var hh, mm int
		fmt.Sscanf(defaultHHMM, "%d:%d", &hh, &mm)
		candidate := time.Date(now.Year(), now.Month(), now.Day(), hh, mm, 0, 0, userLoc)
		if !candidate.After(now) {
			candidate = candidate.Add(24 * time.Hour)
		}
		scheduledAt = &candidate
	}

	msg, err := h.msgRepo.Create(ctx, userID, message, channelID, channelLabel, dmUserID, scheduledAt)
	if err != nil {
		return toolError(id, "Failed to queue message: "+err.Error())
	}

	result := "Queued (id: " + msg.ID + ")."
	if channelLabel != "" {
		result += " Channel: " + channelLabel + "."
	} else if dmUserID != "" {
		result += " DM to user ID: " + dmUserID + "."
	} else {
		result += " No destination set — user will pick one in Velocity."
	}
	if scheduledAt != nil {
		result += " Scheduled for " + scheduledAt.Format("02 Jan 15:04 MST") + "."
	}
	return toolOK(id, result)
}
