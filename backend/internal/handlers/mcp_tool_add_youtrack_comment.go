package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var addYoutrackCommentToolSchema = map[string]interface{}{
	"name": "add_youtrack_comment",
	"description": "Posts a comment on a YouTrack ticket as the Velocity user's YouTrack account. " +
		"The text is stored with YouTrack Markdown enabled, so write YouTrack Markdown: # headings, **bold**, *italic*, " +
		"- / 1. lists, ```lang fenced code```, `inline code`, [label](url) links, | pipe | tables |, > quotes. " +
		"Slack syntax is NOT Markdown: in YouTrack *x* is italic, not bold, so use **x** for bold. " +
		"Slack links <url|label> are converted to [label](url) automatically (outside code). " +
		"Mentions: write @login, or a display name like @Deepak, @{Deepak Kumar} or @Deepak Kumar. Names are resolved to the real YouTrack login " +
		"(YouTrack users plus Velocity developer configs); real logins are kept, emails and code are never touched, and unknown or ambiguous names are left as written and listed in mention_warnings. " +
		"Files: pass `attachments` to attach files to the comment itself (shown under the comment). To show an image inline, reference it by filename in the text, e.g. ![](screenshot.png); " +
		"this also works for files already attached to the ticket. " +
		"Optional visible_to_groups restricts the comment to YouTrack user groups. " +
		"Returns the comment id, stored text, rendered HTML preview, author, attachments and a permalink. " +
		"Only call this when the user asked for a comment; never comment on tickets on your own.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"issue_id": map[string]string{
				"type":        "string",
				"description": "Readable ticket ID, e.g. ARD-123.",
			},
			"text": map[string]string{
				"type":        "string",
				"description": "Comment body in YouTrack Markdown. May be empty only when attachments are given.",
			},
			"attachments": map[string]interface{}{
				"type":        "array",
				"description": "Files to attach to this comment. Each item takes exactly one of file_url, file_base64 (small files) or s3_object_key (from create_attachment_upload_url, for large files), plus filename and mime_type. Reference images inline in text with ![](filename).",
				"items": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"file_url":      map[string]string{"type": "string", "description": "Publicly accessible URL to download the file from."},
						"file_base64":   map[string]string{"type": "string", "description": "Base64-encoded file content."},
						"s3_object_key": map[string]string{"type": "string", "description": "object_key from create_attachment_upload_url, after the file was PUT to its upload_url."},
						"filename":      map[string]string{"type": "string", "description": "Filename in YouTrack, e.g. 'screenshot.png'. Must match the name used in ![](...) references."},
						"mime_type":     map[string]string{"type": "string", "description": "MIME type, e.g. 'image/png'."},
					},
				},
			},
			"visible_to_groups": map[string]interface{}{
				"type":        "array",
				"items":       map[string]string{"type": "string"},
				"description": "Optional. YouTrack user group names (or IDs) allowed to see the comment. Omit for the default visibility (everyone who can see the ticket).",
			},
			"resolve_mentions": map[string]string{
				"type":        "boolean",
				"description": "Resolve @display names to YouTrack logins. Default true.",
			},
			"convert_slack_links": map[string]string{
				"type":        "boolean",
				"description": "Convert Slack <url|label> links to Markdown. Default true.",
			},
		},
		"required": []string{"issue_id", "text"},
	},
}

type commentArgs struct {
	IssueID           string                `json:"issue_id"`
	CommentID         string                `json:"comment_id"`
	Text              *string               `json:"text"`
	Attachments       []mcpAttachmentSource `json:"attachments"`
	VisibleToGroups   *[]string             `json:"visible_to_groups"`
	ResolveMentions   *bool                 `json:"resolve_mentions"`
	ConvertSlackLinks *bool                 `json:"convert_slack_links"`
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

func mcpAddYoutrackComment(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a commentArgs
	if err := json.Unmarshal(args, &a); err != nil || strings.TrimSpace(a.IssueID) == "" {
		return rpcErr(id, -32602, "invalid arguments: issue_id is required")
	}
	text := ""
	if a.Text != nil {
		text = *a.Text
	}
	if strings.TrimSpace(text) == "" && len(a.Attachments) == 0 {
		return rpcErr(id, -32602, "invalid arguments: text is required (it may be empty only when attachments are given)")
	}
	for i, s := range a.Attachments {
		if s.empty() {
			return rpcErr(id, -32602, fmt.Sprintf("invalid arguments: attachments[%d] needs one of file_url, file_base64 or s3_object_key", i))
		}
	}
	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return toolError(id, "YouTrack not configured. Add your YouTrack integration in Velocity > Integrations")
	}

	issue, err := yt.GetIssue(ctx, strings.TrimSpace(a.IssueID))
	if err != nil {
		return toolError(id, fmt.Sprintf("ticket %s not found or not accessible: %v", a.IssueID, err))
	}
	readable := issue.IDReadable
	if readable == "" {
		readable = a.IssueID
	}

	var groupIDs []string
	if a.VisibleToGroups != nil && len(*a.VisibleToGroups) > 0 {
		if groupIDs, err = resolveYTGroups(ctx, yt, *a.VisibleToGroups); err != nil {
			return toolError(id, err.Error())
		}
	}

	// Load every file before posting so a bad source fails without leaving
	// a half-made comment behind.
	files := make([]*mcpLoadedAttachment, 0, len(a.Attachments))
	for i, s := range a.Attachments {
		f, err := s.load(ctx)
		if err != nil {
			return toolError(id, fmt.Sprintf("attachments[%d]: %v. Nothing was posted.", i, err))
		}
		files = append(files, f)
	}

	var notes []string
	prepared, rep := prepareCommentText(ctx, yt, text, boolOr(a.ResolveMentions, true), boolOr(a.ConvertSlackLinks, true))
	prepared, notes = uniquifyAttachmentNames(ctx, yt, issue.ID, files, prepared)
	if strings.TrimSpace(prepared) == "" {
		// YouTrack rejects an empty comment; list the files instead.
		names := make([]string, 0, len(files))
		for _, f := range files {
			names = append(names, f.Filename)
		}
		prepared = "Attached: " + strings.Join(names, ", ")
	}

	posted, err := yt.AddMarkdownComment(ctx, issue.ID, prepared, groupIDs)
	if err != nil {
		return toolError(id, "failed to post comment: "+err.Error())
	}

	var uploadErrs []string
	finalText := prepared
	for _, f := range files {
		att, err := yt.UploadCommentAttachment(ctx, issue.ID, posted.ID, f.Filename, f.MimeType, f.Content)
		if err != nil {
			uploadErrs = append(uploadErrs, fmt.Sprintf("%s: %v", f.Filename, err))
			continue
		}
		f.cleanup(ctx)
		if att.Name != "" && att.Name != f.Filename && strings.Contains(finalText, "("+f.Filename+")") {
			finalText = strings.ReplaceAll(finalText, "("+f.Filename+")", "("+att.Name+")")
			notes = append(notes, fmt.Sprintf("YouTrack stored %s as %s; references were updated.", f.Filename, att.Name))
		}
	}
	if finalText != prepared {
		if _, err := yt.UpdateMarkdownComment(ctx, issue.ID, posted.ID, finalText, false, nil); err != nil {
			notes = append(notes, "could not update image references after a rename: "+err.Error())
		}
	}

	if final, err := yt.GetComment(ctx, issue.ID, posted.ID); err == nil {
		posted = final
	}
	out := commentPayload(yt, readable, posted, rep)
	if missing := missingImageRefs(ctx, yt, issue.ID, posted.Text); len(missing) > 0 {
		out["unresolved_image_refs"] = missing
		notes = append(notes, "Some ![](...) references don't match any attachment on the ticket and will show as broken images: "+strings.Join(missing, ", "))
	}
	if len(uploadErrs) > 0 {
		out["attachment_errors"] = uploadErrs
		notes = append(notes, "The comment was posted, but some files failed to attach.")
	}
	if len(notes) > 0 {
		out["notes"] = notes
	}
	data, _ := json.MarshalIndent(out, "", "  ")
	if len(uploadErrs) > 0 {
		return toolError(id, string(data))
	}
	return toolOK(id, string(data))
}

// commentPayload is the shared result shape for add/edit_youtrack_comment.
func commentPayload(yt *youtrack.Client, readable string, c *youtrack.PostedComment, rep commentTextReport) map[string]interface{} {
	atts := make([]map[string]interface{}, 0, len(c.Attachments))
	for _, a := range c.Attachments {
		atts = append(atts, map[string]interface{}{"id": a.ID, "name": a.Name, "mime_type": a.MimeType, "size": a.Size})
	}
	visibility := "everyone who can see the ticket"
	if c.Visibility != nil && c.Visibility.Type == "LimitedVisibility" {
		names := []string{}
		for _, g := range c.Visibility.PermittedGroups {
			names = append(names, "group "+g.Name)
		}
		for _, u := range c.Visibility.PermittedUsers {
			names = append(names, "user "+u.Login)
		}
		visibility = "limited to " + strings.Join(names, ", ")
	}
	out := map[string]interface{}{
		"issue_id":          readable,
		"comment_id":        c.ID,
		"permalink":         yt.CommentPermalink(readable, c.ID),
		"author":            ticketUserMap(c.Author),
		"created_at":        msToISO(c.Created),
		"markdown_rendered": c.RendersAsMarkdown(),
		"text":              c.Text,
		"rendered_html":     c.TextPreview,
		"attachments":       atts,
		"visibility":        visibility,
	}
	if c.Updated > c.Created {
		out["updated_at"] = msToISO(c.Updated)
	}
	if len(rep.Mentions) > 0 {
		out["mentions"] = rep.Mentions
	}
	if len(rep.MentionWarnings) > 0 {
		out["mention_warnings"] = rep.MentionWarnings
	}
	if rep.SlackLinks > 0 {
		out["slack_links_converted"] = rep.SlackLinks
	}
	return out
}

// resolveYTGroups maps group names (case-insensitive) or IDs to group IDs.
func resolveYTGroups(ctx context.Context, yt *youtrack.Client, want []string) ([]string, error) {
	groups, err := yt.GetUserGroups(ctx)
	if err != nil {
		return nil, fmt.Errorf("could not list YouTrack groups for visible_to_groups: %v", err)
	}
	var ids, unknown []string
	for _, w := range want {
		w = strings.TrimSpace(w)
		found := ""
		for _, g := range groups {
			if g.ID == w || strings.EqualFold(g.Name, w) {
				found = g.ID
				break
			}
		}
		if found == "" {
			unknown = append(unknown, w)
			continue
		}
		ids = append(ids, found)
	}
	if len(unknown) > 0 {
		names := make([]string, 0, len(groups))
		for _, g := range groups {
			names = append(names, g.Name)
		}
		return nil, fmt.Errorf("unknown YouTrack group(s) %s. Available groups: %s. Nothing was posted.",
			strings.Join(unknown, ", "), strings.Join(names, ", "))
	}
	return ids, nil
}

// uniquifyAttachmentNames renames files whose name is already used on the
// issue (or earlier in the same call). YouTrack keeps duplicate names, and a
// `![](name)` reference resolves issue-wide to the FIRST attachment with that
// name, so a second "screenshot.png" would show the old image. References to
// a renamed file in text are rewritten to the new name.
func uniquifyAttachmentNames(ctx context.Context, yt *youtrack.Client, issueID string, files []*mcpLoadedAttachment, text string) (string, []string) {
	if len(files) == 0 {
		return text, nil
	}
	used := map[string]bool{}
	if atts, err := yt.GetIssueAttachmentsDetailed(ctx, issueID); err == nil {
		for _, a := range atts {
			used[strings.ToLower(a.Name)] = true
		}
	}
	var notes []string
	seenInCall := map[string]bool{}
	for _, f := range files {
		orig := f.Filename
		if used[strings.ToLower(orig)] {
			ext := path.Ext(orig)
			stem := strings.TrimSuffix(orig, ext)
			for n := 2; ; n++ {
				cand := fmt.Sprintf("%s-%d%s", stem, n, ext)
				if !used[strings.ToLower(cand)] {
					f.Filename = cand
					break
				}
			}
			if !seenInCall[strings.ToLower(orig)] {
				// Only the first file of a given name in this call owns the
				// references in the text.
				text = strings.ReplaceAll(text, "]("+orig+")", "]("+f.Filename+")")
				text = strings.ReplaceAll(text, "](<"+orig+">)", "](<"+f.Filename+">)")
			}
			notes = append(notes, fmt.Sprintf("%s already exists on the ticket, so it was attached as %s (references in the text were updated).", orig, f.Filename))
		}
		seenInCall[strings.ToLower(orig)] = true
		used[strings.ToLower(f.Filename)] = true
	}
	return text, notes
}

// missingImageRefs lists ![](name) targets in text that match no attachment
// on the issue. Absolute URLs are ignored.
func missingImageRefs(ctx context.Context, yt *youtrack.Client, issueID, text string) []string {
	refs := youtrack.InlineImageRefs(text)
	if len(refs) == 0 {
		return nil
	}
	atts, err := yt.GetIssueAttachmentsDetailed(ctx, issueID)
	if err != nil {
		return nil
	}
	var missing []string
	for _, r := range refs {
		if strings.Contains(r, "://") {
			continue
		}
		ok := false
		for _, a := range atts {
			if strings.EqualFold(a.Name, r) {
				ok = true
				break
			}
		}
		if !ok {
			missing = append(missing, r)
		}
	}
	return missing
}
