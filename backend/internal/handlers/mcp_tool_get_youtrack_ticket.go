package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var getYoutrackTicketToolSchema = map[string]interface{}{
	"name": "get_youtrack_ticket",
	"description": "Fetches a YouTrack ticket by readable ID (e.g. ARD-123). " +
		"Returns summary, description, status, subsystem, priority, type, assignee, reporter, " +
		"created/updated timestamps, attachment names, and URL. " +
		"Use this before editing a ticket when you need current field values, or whenever the user asks what a ticket says.",
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

func mcpGetYoutrackTicket(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
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
	issue, err := ytClient.GetIssue(ctx, a.IssueID)
	if err != nil {
		return toolError(id, "failed to get "+a.IssueID+": "+err.Error())
	}

	displayID := issue.IDReadable
	if displayID == "" {
		displayID = issue.ID
	}
	ytBaseURL := strings.TrimRight(ytClient.GetBaseURL(), "/")

	var assignee map[string]string
	if aUser := youtrack.GetAssignee(*issue); aUser != nil {
		assignee = map[string]string{
			"login":     aUser.Login,
			"full_name": aUser.FullName,
		}
	}
	var reporter map[string]string
	if issue.Reporter != nil {
		reporter = map[string]string{
			"login":     issue.Reporter.Login,
			"full_name": issue.Reporter.FullName,
		}
	}
	attachments := make([]map[string]interface{}, 0, len(issue.Attachments))
	for _, att := range issue.Attachments {
		attachments = append(attachments, map[string]interface{}{
			"name":      att.Name,
			"mime_type": att.MimeType,
			"size":      att.Size,
		})
	}

	payload := map[string]interface{}{
		"id":          issue.ID,
		"id_readable": displayID,
		"summary":     issue.Summary,
		"description": issue.Description,
		"status":      youtrack.GetStatus(*issue),
		"subsystem":   youtrack.GetSubsystem(*issue),
		"priority":    youtrack.GetPriority(*issue),
		"type":        youtrack.GetCustomFieldValue(*issue, "Type"),
		"assignee":    assignee,
		"reporter":    reporter,
		"created":     issue.Created,
		"updated":     issue.Updated,
		"attachments": attachments,
		"url":         fmt.Sprintf("%s/issue/%s", ytBaseURL, displayID),
	}
	data, _ := json.Marshal(payload)
	return toolOK(id, string(data))
}
