package handlers

import (
	"context"
	"encoding/json"
	"fmt"
)

var deleteYoutrackCommentToolSchema = map[string]interface{}{
	"name": "delete_youtrack_comment",
	"description": "Permanently deletes a YouTrack comment, together with the files attached to it. Only comments written by the Velocity user's own YouTrack account can be deleted; anyone else's are refused. " +
		"Always confirm with the user before calling this. comment_id comes from add_youtrack_comment or get_youtrack_ticket; a comment permalink also works.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"issue_id":   map[string]string{"type": "string", "description": "Readable ticket ID, e.g. ARD-123."},
			"comment_id": map[string]string{"type": "string", "description": "Comment ID (e.g. 4-12345) or its permalink."},
		},
		"required": []string{"issue_id", "comment_id"},
	},
}

func mcpDeleteYoutrackComment(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		IssueID   string `json:"issue_id"`
		CommentID string `json:"comment_id"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.IssueID == "" || a.CommentID == "" {
		return rpcErr(id, -32602, "invalid arguments: issue_id and comment_id are required")
	}
	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return toolError(id, "YouTrack not configured. Add your YouTrack integration in Velocity > Integrations")
	}
	commentID := parseCommentID(a.CommentID)
	c, errResp := loadOwnComment(ctx, yt, userID, id, a.IssueID, commentID)
	if errResp != nil {
		return *errResp
	}
	if err := yt.DeleteComment(ctx, a.IssueID, commentID); err != nil {
		return toolError(id, "failed to delete comment: "+err.Error())
	}
	return toolOK(id, fmt.Sprintf("Deleted comment %s on %s (%d attachment(s) removed with it)", commentID, a.IssueID, len(c.Attachments)))
}
