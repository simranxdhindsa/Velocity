package youtrack

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
)

// Comment write helpers used by the add/edit/delete_youtrack_comment MCP
// tools. Unlike the older AddIssueComment (plain text, no response), these
// always post with usesMarkdown=true and return the stored comment.
//
// YouTrack Cloud has retired the per-comment usesMarkdown flag: it is ignored
// on write, never returned on read, and every comment renders as Markdown.
// It is still sent so older/self-hosted servers that default to wiki markup
// store Markdown too. Use RendersAsMarkdown to check the stored result.

// UserGroup is a YouTrack user group, used for restricted comment visibility.
type UserGroup struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// CommentVisibility is the visibility block YouTrack returns for a comment.
// Type is "UnlimitedVisibility" or "LimitedVisibility".
type CommentVisibility struct {
	Type            string      `json:"$type"`
	PermittedGroups []UserGroup `json:"permittedGroups,omitempty"`
	PermittedUsers  []User      `json:"permittedUsers,omitempty"`
}

// PostedComment is a comment as stored by YouTrack after a write.
type PostedComment struct {
	ID           string             `json:"id"`
	Text         string             `json:"text"`
	TextPreview  string             `json:"textPreview"`            // rendered HTML
	UsesMarkdown *bool              `json:"usesMarkdown,omitempty"` // nil on YouTrack Cloud (field retired)
	Created      int64              `json:"created"`
	Updated      int64              `json:"updated"`
	Deleted      bool               `json:"deleted"`
	Author       *User              `json:"author,omitempty"`
	Attachments  []Attachment       `json:"attachments,omitempty"`
	Visibility   *CommentVisibility `json:"visibility,omitempty"`
}

const postedCommentFields = "id,text,textPreview,usesMarkdown,created,updated,deleted," +
	"author(id,login,fullName),attachments(id,name,mimeType,size,url)," +
	"visibility($type,permittedGroups(id,name),permittedUsers(id,login,fullName))"

// limitedVisibility builds the request body block that restricts a comment
// to the given group IDs. Nil when no groups are given (visible to everyone
// who can see the issue).
func limitedVisibility(groupIDs []string) map[string]interface{} {
	if len(groupIDs) == 0 {
		return nil
	}
	groups := make([]map[string]string, 0, len(groupIDs))
	for _, g := range groupIDs {
		groups = append(groups, map[string]string{"id": g})
	}
	return map[string]interface{}{"$type": "LimitedVisibility", "permittedGroups": groups}
}

// AddMarkdownComment posts a YouTrack Markdown comment on an issue and
// returns it. groupIDs, when set, restricts visibility to those groups.
func (c *Client) AddMarkdownComment(ctx context.Context, issueID, text string, groupIDs []string) (*PostedComment, error) {
	body := map[string]interface{}{"text": text, "usesMarkdown": true}
	if v := limitedVisibility(groupIDs); v != nil {
		body["visibility"] = v
	}
	path := fmt.Sprintf("/api/issues/%s/comments?fields=%s", url.PathEscape(issueID), postedCommentFields)
	return c.decodeComment(c.doRequest(ctx, http.MethodPost, path, body))
}

// UpdateMarkdownComment replaces a comment's text (keeping usesMarkdown=true).
// When setVisibility is true the visibility is replaced too; an empty
// groupIDs then makes the comment visible to everyone again.
func (c *Client) UpdateMarkdownComment(ctx context.Context, issueID, commentID, text string, setVisibility bool, groupIDs []string) (*PostedComment, error) {
	body := map[string]interface{}{"text": text, "usesMarkdown": true}
	if setVisibility {
		if v := limitedVisibility(groupIDs); v != nil {
			body["visibility"] = v
		} else {
			body["visibility"] = map[string]interface{}{"$type": "UnlimitedVisibility"}
		}
	}
	path := fmt.Sprintf("/api/issues/%s/comments/%s?fields=%s",
		url.PathEscape(issueID), url.PathEscape(commentID), postedCommentFields)
	return c.decodeComment(c.doRequest(ctx, http.MethodPost, path, body))
}

// GetComment returns one comment with author, attachments and visibility.
func (c *Client) GetComment(ctx context.Context, issueID, commentID string) (*PostedComment, error) {
	path := fmt.Sprintf("/api/issues/%s/comments/%s?fields=%s",
		url.PathEscape(issueID), url.PathEscape(commentID), postedCommentFields)
	return c.decodeComment(c.doRequest(ctx, http.MethodGet, path, nil))
}

// DeleteComment permanently deletes a comment.
func (c *Client) DeleteComment(ctx context.Context, issueID, commentID string) error {
	path := fmt.Sprintf("/api/issues/%s/comments/%s", url.PathEscape(issueID), url.PathEscape(commentID))
	_, err := c.doRequest(ctx, http.MethodDelete, path, nil)
	return err
}

func (c *Client) decodeComment(body []byte, err error) (*PostedComment, error) {
	if err != nil {
		return nil, err
	}
	var pc PostedComment
	if err := json.Unmarshal(body, &pc); err != nil {
		return nil, fmt.Errorf("failed to unmarshal comment: %w", err)
	}
	return &pc, nil
}

// UploadCommentAttachment attaches a file to an existing comment (it shows
// under that comment, not under the description) and returns the stored
// attachment. YouTrack may rename it on a name clash, so callers should use
// the returned Name when referencing it as `![](name)`.
func (c *Client) UploadCommentAttachment(ctx context.Context, issueID, commentID, filename, mimeType string, content []byte) (*Attachment, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filename))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	h.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(h)
	if err != nil {
		return nil, fmt.Errorf("failed to create form file: %w", err)
	}
	if _, err = part.Write(content); err != nil {
		return nil, fmt.Errorf("failed to write file content: %w", err)
	}
	writer.Close()

	path := fmt.Sprintf("/api/issues/%s/comments/%s/attachments?fields=id,name,mimeType,size,url",
		url.PathEscape(issueID), url.PathEscape(commentID))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, &body)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upload request failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read upload response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("YouTrack comment attachment upload error: status %d - %s", resp.StatusCode, string(respBody))
	}
	// Both a bare object and a single-element array have been seen.
	var list []Attachment
	if err := json.Unmarshal(respBody, &list); err == nil && len(list) > 0 {
		return &list[0], nil
	}
	var single Attachment
	if err := json.Unmarshal(respBody, &single); err == nil && single.ID != "" {
		return &single, nil
	}
	return &Attachment{Name: filename, MimeType: mimeType, Size: int64(len(content))}, nil
}

// GetUserGroups lists YouTrack user groups (id + name).
func (c *Client) GetUserGroups(ctx context.Context) ([]UserGroup, error) {
	body, err := c.doRequest(ctx, http.MethodGet, "/api/groups?fields=id,name&$top=500", nil)
	if err != nil {
		return nil, err
	}
	var groups []UserGroup
	if err := json.Unmarshal(body, &groups); err != nil {
		return nil, fmt.Errorf("failed to unmarshal groups: %w", err)
	}
	return groups, nil
}

// CommentPermalink is the YouTrack web link that opens an issue scrolled to
// and highlighting a comment.
// RendersAsMarkdown reports whether YouTrack rendered the comment with its
// Markdown renderer (textPreview carries the common-markdown class), or the
// stored flag when an older server still returns it.
func (pc *PostedComment) RendersAsMarkdown() bool {
	if pc.UsesMarkdown != nil {
		return *pc.UsesMarkdown
	}
	return strings.Contains(pc.TextPreview, "common-markdown")
}

func (c *Client) CommentPermalink(issueReadableID, commentID string) string {
	return fmt.Sprintf("%s/issue/%s#focus=Comments-%s.0-0", strings.TrimRight(c.baseURL, "/"), issueReadableID, commentID)
}
