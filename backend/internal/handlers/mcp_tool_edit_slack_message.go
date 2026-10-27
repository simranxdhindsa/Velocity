package handlers

import (
	"context"
	"encoding/json"
	"strings"

	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

var editSlackMessageToolSchema = map[string]interface{}{
	"name": "edit_slack_message",
	"description": "Edit a Slack message that Velocity itself posted (via queue_slack_message or send_slack_message_now), " +
		"replacing its text in place. Only ever targets Velocity's own messages, never other people's — Slack doesn't " +
		"allow bot edits of user messages anyway. Pass `link` (the message's Slack permalink, from Slack's \"Copy link\") " +
		"to edit that exact message, or `channel`/`dm_user` to know where to look. Without " +
		"`contains`, edits the most recently sent Velocity message in that destination; pass `contains` to match a " +
		"specific one by a snippet of its current text. Do NOT call list_slack_channels first — just pass the channel " +
		"name the user mentioned. Note: this replaces plain message text only — it does not support editing a message " +
		"that was sent as a Markdown table (those keep their original table content).",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"message": map[string]string{
				"type":        "string",
				"description": "The new message text to replace the existing message with. Use @DisplayName for mentions (e.g. @Suryansh).",
			},
			"link": map[string]string{
				"type": "string",
				"description": "A Slack message permalink, e.g. 'https://workspace.slack.com/archives/C0XXXXXXXXX/p1700000000000000'. " +
					"Targets that exact message directly; when given, channel/dm_user/contains are not needed.",
			},
			"channel": map[string]string{
				"type": "string",
				"description": "Channel name as the user mentioned it, e.g. 'ardoise-pm', '#general'. Also accepts a raw Slack " +
					"conversation ID (e.g. 'C0XXXXXXXXX') for destinations with no name, such as a group DM. Omit if it was a 1:1 DM.",
			},
			"dm_user": map[string]string{
				"type":        "string",
				"description": "Display name or real name of the DM recipient (e.g. 'Suryansh'). Use instead of channel for a DM.",
			},
			"contains": map[string]string{
				"type":        "string",
				"description": "Optional. A snippet of the message's current text to identify which message to edit, if not the most recent one.",
			},
		},
		"required": []string{"message"},
	},
}

func mcpEditSlackMessage(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Message  string `json:"message"`
		Link     string `json:"link"`
		Channel  string `json:"channel"`
		DmUser   string `json:"dm_user"`
		Contains string `json:"contains"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.Message == "" {
		return rpcErr(id, -32602, "invalid arguments: message is required")
	}
	if a.Link != "" {
		return mcpEditSlackMessageByLink(ctx, h, userID, id, a.Link, a.Message)
	}
	if a.Channel == "" && a.DmUser == "" {
		return toolError(id, "either link, channel, or dm_user is required")
	}

	var channelID, label, dmUserID string
	if a.DmUser != "" {
		dmUserID = h.resolveSlackUser(ctx, userID, a.DmUser)
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
			continue // only Velocity's own sends are eligible for editing
		}
		if needle != "" && !strings.Contains(strings.ToLower(m.Text), needle) {
			continue
		}
		targetTS = m.TS
		break // GetLiveChannelMessages returns newest-first
	}
	if targetTS == "" {
		hint := h.sentElsewhereHint(ctx, userID, "edit", a.Contains, channelID, dmUserID, label)
		if a.Contains != "" {
			return toolError(id, "couldn't find a Velocity message containing '"+a.Contains+"' in "+label+"."+hint)
		}
		return toolError(id, "couldn't find a Velocity-sent message to edit in "+label+"."+hint)
	}

	message := resolveSlackMentions(ctx, h.slackSvc, userID, a.Message)
	if err := h.updateSvc.UpdateSlackMessage(ctx, userID, channelID, targetTS, message); err != nil {
		return toolError(id, "Failed to edit: "+err.Error())
	}

	return toolOK(id, "Edited the message in "+label+".")
}

// mcpEditSlackMessageByLink edits the exact message a Slack permalink points to, after
// checking it is one of Velocity's own (same guarantee as the channel/dm_user path).
func mcpEditSlackMessageByLink(ctx context.Context, h *MCPHandler, userID string, id interface{}, link, text string) rpcResponse {
	channelID, targetTS, ok := parseSlackPermalink(link)
	if !ok {
		return toolError(id, "that doesn't look like a Slack message link. Expected something like https://workspace.slack.com/archives/C0XXXXXXXXX/p1700000000000000")
	}
	live, err := h.slackSvc.GetLiveChannelMessages(ctx, userID, channelID, "")
	if err != nil {
		return toolError(id, "Failed to load messages: "+err.Error())
	}
	found, isVelocity := false, false
	for _, m := range live {
		if m.TS == targetTS {
			found, isVelocity = true, m.IsVelocity
			break
		}
	}
	if !found {
		return toolError(id, "couldn't find that message, it may have been deleted or be too old to load")
	}
	if !isVelocity {
		return toolError(id, "that message wasn't sent by Velocity (or was sent before Velocity recorded DMs), so it can't be edited through this tool")
	}
	message := resolveSlackMentions(ctx, h.slackSvc, userID, text)
	if err := h.updateSvc.UpdateSlackMessage(ctx, userID, channelID, targetTS, message); err != nil {
		return toolError(id, "Failed to edit: "+err.Error())
	}
	return toolOK(id, "Edited the message.")
}
