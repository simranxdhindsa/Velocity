package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

const (
	ticketDefaultCommentsLimit = 50
	ticketMaxCommentsLimit     = 500
	ticketDefaultMaxImages     = 5
	ticketHardMaxImages        = 10
)

var getYoutrackTicketToolSchema = map[string]interface{}{
	"name": "get_youtrack_ticket",
	"description": "Fetches a YouTrack ticket by readable ID (e.g. ARD-123). " +
		"Returns summary, description, status, subsystem, priority, type, assignee, reporter, " +
		"created/updated timestamps, URL, the full comment thread (oldest first, each with author, " +
		"created/updated time, text and its own attachments), and every attachment with whether it belongs " +
		"to the description or to a specific comment. Image attachments (png/jpeg/gif/webp) are returned as " +
		"image content so you can see them; markdown image references like ![](image.png) are mapped to " +
		"their attachments. Comments are often where a ticket is concluded, so read them to judge whether " +
		"it's resolved, what was done, and who (PM, QA, developer) still owes a reply. " +
		"Use this before editing a ticket when you need current field values, or whenever the user asks what a ticket says.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"issue_id": map[string]string{
				"type":        "string",
				"description": "Readable ticket ID, e.g. ARD-123.",
			},
			"comments_limit": map[string]interface{}{
				"type":        "integer",
				"description": fmt.Sprintf("Max comments to return, newest kept (still listed oldest first). Default %d, max %d. The response says when older comments were dropped.", ticketDefaultCommentsLimit, ticketMaxCommentsLimit),
			},
			"include_images": map[string]interface{}{
				"type":        "boolean",
				"description": "Return image attachments as image content blocks. Default true. Set false for a text-only answer.",
			},
			"max_images": map[string]interface{}{
				"type":        "integer",
				"description": fmt.Sprintf("Max images to return. Default %d, max %d. Images over ~1MB or 1568px are downscaled; any that can't fit are listed as skipped.", ticketDefaultMaxImages, ticketHardMaxImages),
			},
			"image_names": map[string]interface{}{
				"type":        "array",
				"items":       map[string]string{"type": "string"},
				"description": "Optional. Only return these image attachments (by exact attachment name). Use to fetch images that were skipped by the max_images cap on a previous call.",
			},
		},
		"required": []string{"issue_id"},
	},
}

type getTicketArgs struct {
	IssueID       string   `json:"issue_id"`
	CommentsLimit *int     `json:"comments_limit"`
	IncludeImages *bool    `json:"include_images"`
	MaxImages     *int     `json:"max_images"`
	ImageNames    []string `json:"image_names"`
}

func mcpGetYoutrackTicket(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a getTicketArgs
	if err := json.Unmarshal(args, &a); err != nil || strings.TrimSpace(a.IssueID) == "" {
		return rpcErr(id, -32602, "invalid arguments: issue_id is required")
	}
	a.IssueID = strings.TrimSpace(a.IssueID)

	commentsLimit := ticketDefaultCommentsLimit
	if a.CommentsLimit != nil && *a.CommentsLimit > 0 {
		commentsLimit = min(*a.CommentsLimit, ticketMaxCommentsLimit)
	}
	includeImages := a.IncludeImages == nil || *a.IncludeImages
	maxImages := ticketDefaultMaxImages
	if a.MaxImages != nil && *a.MaxImages >= 0 {
		maxImages = min(*a.MaxImages, ticketHardMaxImages)
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
		assignee = ticketUserMap(aUser)
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
		"reporter":    ticketUserMap(issue.Reporter),
		"created":     issue.Created,
		"created_at":  msToISO(issue.Created),
		"updated":     issue.Updated,
		"updated_at":  msToISO(issue.Updated),
		"url":         fmt.Sprintf("%s/issue/%s", ytBaseURL, displayID),
	}

	d := buildTicketDiscussion(ctx, ytClient, issue, commentsLimit)
	for k, v := range d.payloadFields() {
		payload[k] = v
	}

	var images []ticketImage
	if includeImages {
		images = d.collectImages(ctx, ytClient, maxImages, a.ImageNames)
	} else {
		d.markImagesNotRequested()
	}
	payload["attachments"] = d.attachmentsPayload()
	payload["images_returned"] = len(images)
	if note := d.imagesNote(includeImages, len(images)); note != "" {
		payload["images_note"] = note
	}

	data, _ := json.Marshal(payload)
	blocks := []map[string]interface{}{mcpTextBlock(string(data))}
	for i, img := range images {
		blocks = append(blocks, mcpTextBlock(fmt.Sprintf("Image %d of %d: %s", i+1, len(images), img.label)))
		blocks = append(blocks, mcpImageBlock(img.base64, img.mimeType))
	}
	return toolOKContent(id, blocks)
}
