package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var editYoutrackCommentToolSchema = map[string]interface{}{
	"name": "edit_youtrack_comment",
	"description": "Replaces the text of a YouTrack comment that was written by the Velocity user's own YouTrack account (other people's comments are refused). " +
		"Same YouTrack Markdown rules, @mention resolution and Slack link conversion as add_youtrack_comment. " +
		"Pass visible_to_groups to change visibility ([] makes it visible to everyone again); omit it to keep the current visibility. " +
		"Get comment_id from add_youtrack_comment or get_youtrack_ticket; a comment permalink also works.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"issue_id":   map[string]string{"type": "string", "description": "Readable ticket ID, e.g. ARD-123."},
			"comment_id": map[string]string{"type": "string", "description": "Comment ID (e.g. 4-12345) or its permalink."},
			"text":       map[string]string{"type": "string", "description": "New full comment body in YouTrack Markdown (replaces the old text)."},
			"visible_to_groups": map[string]interface{}{
				"type":        "array",
				"items":       map[string]string{"type": "string"},
				"description": "Optional. Group names or IDs allowed to see the comment. [] means everyone. Omit to keep current visibility.",
			},
			"resolve_mentions":    map[string]string{"type": "boolean", "description": "Resolve @display names to YouTrack logins. Default true."},
			"convert_slack_links": map[string]string{"type": "boolean", "description": "Convert Slack <url|label> links to Markdown. Default true."},
		},
		"required": []string{"issue_id", "comment_id", "text"},
	},
}

// loadOwnComment fetches a comment and checks it was written by the user
// that owns the YouTrack token. Returns a ready tool error otherwise.
func loadOwnComment(ctx context.Context, yt *youtrack.Client, id interface{}, issueID, commentID string) (*youtrack.PostedComment, *rpcResponse) {
	c, err := yt.GetComment(ctx, issueID, commentID)
	if err != nil {
		r := toolError(id, fmt.Sprintf("comment %s on %s not found: %v", commentID, issueID, err))
		return nil, &r
	}
	if c.Deleted {
		r := toolError(id, fmt.Sprintf("comment %s on %s is already deleted", commentID, issueID))
		return nil, &r
	}
	me, err := yt.GetCurrentUser(ctx)
	if err != nil {
		r := toolError(id, "could not identify the YouTrack token user: "+err.Error())
		return nil, &r
	}
	if c.Author == nil || !(c.Author.ID == me.ID || strings.EqualFold(c.Author.Login, me.Login)) {
		who := "unknown"
		if c.Author != nil {
			who = c.Author.Login
		}
		r := toolError(id, fmt.Sprintf("refused: comment %s was written by %s, not by your YouTrack account (%s). Only your own comments can be changed.", commentID, who, me.Login))
		return nil, &r
	}
	return c, nil
}

func mcpEditYoutrackComment(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a commentArgs
	if err := json.Unmarshal(args, &a); err != nil || a.IssueID == "" || a.CommentID == "" || a.Text == nil || strings.TrimSpace(*a.Text) == "" {
		return rpcErr(id, -32602, "invalid arguments: issue_id, comment_id and a non-empty text are required")
	}
	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return toolError(id, "YouTrack not configured. Add your YouTrack integration in Velocity > Integrations")
	}
	commentID := parseCommentID(a.CommentID)
	if _, errResp := loadOwnComment(ctx, yt, id, a.IssueID, commentID); errResp != nil {
		return *errResp
	}
	var groupIDs []string
	if a.VisibleToGroups != nil && len(*a.VisibleToGroups) > 0 {
		var err error
		if groupIDs, err = resolveYTGroups(ctx, yt, *a.VisibleToGroups); err != nil {
			return toolError(id, strings.Replace(err.Error(), "Nothing was posted.", "Nothing was changed.", 1))
		}
	}
	prepared, rep := prepareCommentText(ctx, yt, *a.Text, boolOr(a.ResolveMentions, true), boolOr(a.ConvertSlackLinks, true))
	updated, err := yt.UpdateMarkdownComment(ctx, a.IssueID, commentID, prepared, a.VisibleToGroups != nil, groupIDs)
	if err != nil {
		return toolError(id, "failed to edit comment: "+err.Error())
	}
	readable := strings.ToUpper(a.IssueID)
	if issue, err := yt.GetIssue(ctx, a.IssueID); err == nil && issue.IDReadable != "" {
		readable = issue.IDReadable
	}
	out := commentPayload(yt, readable, updated, rep)
	if missing := missingImageRefs(ctx, yt, a.IssueID, updated.Text); len(missing) > 0 {
		out["unresolved_image_refs"] = missing
	}
	data, _ := json.MarshalIndent(out, "", "  ")
	return toolOK(id, string(data))
}
