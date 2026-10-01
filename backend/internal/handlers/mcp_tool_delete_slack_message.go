package handlers

import (
	"context"
	"encoding/json"
	"strings"

	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

var deleteSlackMessageToolSchema = map[string]interface{}{
	"name": "delete_slack_message",
	"description": "Delete a Slack message that Velocity itself posted (via queue_slack_message or send_slack_message_now). " +
		"Only ever targets Velocity's own messages, never other people's — Slack doesn't allow bot deletion of user " +
		"messages anyway. Requires `channel` or `dm_user` to know where to look. Without `contains`, deletes the " +
		"most recently sent Velocity message in that destination; pass `contains` to match a specific one by a " +
		"snippet of its text. Do NOT call list_slack_channels first — just pass the channel name the user mentioned.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"channel": map[string]string{
				"type": "string",
				"description": "Channel name as the user mentioned it, e.g. 'ardoise-pm', '#general'. Also accepts a raw Slack " +
					"conversation ID (e.g. 'C0B30MXMDHQ') for destinations with no name, such as a group DM. Omit if it was a 1:1 DM.",
			},
			"dm_user": map[string]string{
				"type":        "string",
				"description": "Display name or real name of the DM recipient (e.g. 'Suryansh'). Use instead of channel for a DM.",
			},
			"contains": map[string]string{
				"type":        "string",
				"description": "Optional. A snippet of the message text to identify which message to delete, if not the most recent one.",
			},
		},
	},
}

func mcpDeleteSlackMessage(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Channel  string `json:"channel"`
		DmUser   string `json:"dm_user"`
		Contains string `json:"contains"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return rpcErr(id, -32602, "invalid arguments")
	}
	if a.Channel == "" && a.DmUser == "" {
		return toolError(id, "either channel or dm_user is required")
	}

	var channelID, label string
	if a.DmUser != "" {
		dmUserID := h.resolveSlackUser(ctx, userID, a.DmUser)
		if dmUserID == "" {
			return toolError(id, "couldn't find a Slack user matching '"+a.DmUser+"'")
		}
		status, err := h.slackSvc.GetStatus(ctx, userID)
		if err != nil || !status.Connected {
			return toolError(id, "Slack is not connected for this user")
		}
		chID, err := slacksvc.NewClient(status.BotToken).OpenDirectMessageChannel(ctx, dmUserID)
		if err != nil || chID == "" {
			return toolError(id, "couldn't open DM channel with '"+a.DmUser+"'")
		}
		channelID = chID
		label = "DM with " + a.DmUser
	} else {
		chID, chLabel := h.resolveChannel(ctx, userID, a.Channel)
		if chID == "" {
			return toolError(id, "couldn't find a Slack channel matching '"+a.Channel+"' — check the name in Velocity")
		}
		channelID = chID
		label = chLabel
	}

	live, err := h.slackSvc.GetLiveChannelMessages(ctx, userID, channelID, "")
	if err != nil {
		return toolError(id, "Failed to load messages: "+err.Error())
	}

	needle := strings.ToLower(a.Contains)
	var targetTS string
	for _, m := range live {
		if !m.IsVelocity {
			continue // only Velocity's own sends are eligible for deletion
		}
		if needle != "" && !strings.Contains(strings.ToLower(m.Text), needle) {
			continue
		}
		targetTS = m.TS
		break // GetLiveChannelMessages returns newest-first
	}
	if targetTS == "" {
		if a.Contains != "" {
			return toolError(id, "couldn't find a Velocity message containing '"+a.Contains+"' in "+label)
		}
		return toolError(id, "couldn't find a Velocity-sent message to delete in "+label)
	}

	if err := h.updateSvc.DeleteSlackMessage(ctx, userID, channelID, targetTS); err != nil {
		return toolError(id, "Failed to delete: "+err.Error())
	}
	// Keep the Claude Queue view in sync — the "Recent" list would otherwise
	// still show a card pointing at a now-deleted Slack message. m.ID above is
	// the Slack Messages hub's own row id, a different table, so look the
	// queue row up by slack_ts instead of trusting that cross-reference.
	if queued, qerr := h.msgRepo.ListByUser(ctx, userID); qerr == nil {
		for _, q := range queued {
			if q.SlackTs == targetTS {
				_ = h.msgRepo.Delete(ctx, q.ID, userID)
				break
			}
		}
	}

	return toolOK(id, "Deleted the message in "+label+".")
}
