package youtrack

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// DiscussionComment is a comment with its author, timestamps, deleted flag and
// its own attachments. Used by the get_youtrack_ticket MCP tool and the Slack
// bot's get_ticket tool, which need the full thread to judge whether a ticket
// is resolved or who still owes a reply.
type DiscussionComment struct {
	ID          string       `json:"id"`
	Text        string       `json:"text"`
	Created     int64        `json:"created"`
	Updated     int64        `json:"updated"`
	Deleted     bool         `json:"deleted"`
	Author      *User        `json:"author,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
}

// IssueAttachment is an attachment with its author, creation time and the
// comment it belongs to (nil Comment means it's attached to the issue itself,
// i.e. the description).
type IssueAttachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	URL      string `json:"url"`
	Created  int64  `json:"created"`
	Removed  bool   `json:"removed"`
	Author   *User  `json:"author,omitempty"`
	Comment  *struct {
		ID string `json:"id"`
	} `json:"comment,omitempty"`
}

// CommentID returns the owning comment's ID, or "" for description/issue-level attachments.
func (a IssueAttachment) CommentID() string {
	if a.Comment == nil {
		return ""
	}
	return a.Comment.ID
}

const discussionPageSize = 200

// GetIssueDiscussion returns every non-deleted comment on an issue, oldest
// first, paginating past YouTrack's default page size.
func (c *Client) GetIssueDiscussion(ctx context.Context, issueID string) ([]DiscussionComment, error) {
	fields := "id,text,created,updated,deleted,author(login,fullName),attachments(id,name,mimeType,size,url)"
	var out []DiscussionComment
	for skip := 0; ; skip += discussionPageSize {
		path := fmt.Sprintf("/api/issues/%s/comments?fields=%s&$skip=%d&$top=%d",
			url.PathEscape(issueID), fields, skip, discussionPageSize)
		body, err := c.doRequest(ctx, http.MethodGet, path, nil)
		if err != nil {
			return nil, err
		}
		var page []DiscussionComment
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("failed to unmarshal comments: %w", err)
		}
		for _, cm := range page {
			if !cm.Deleted {
				out = append(out, cm)
			}
		}
		if len(page) < discussionPageSize {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	return out, nil
}

// GetIssueAttachmentsDetailed returns every non-removed attachment on an issue
// (both description-level and comment-level), oldest first.
func (c *Client) GetIssueAttachmentsDetailed(ctx context.Context, issueID string) ([]IssueAttachment, error) {
	fields := "id,name,mimeType,size,url,created,removed,author(login,fullName),comment(id)"
	var out []IssueAttachment
	for skip := 0; ; skip += discussionPageSize {
		path := fmt.Sprintf("/api/issues/%s/attachments?fields=%s&$skip=%d&$top=%d",
			url.PathEscape(issueID), fields, skip, discussionPageSize)
		body, err := c.doRequest(ctx, http.MethodGet, path, nil)
		if err != nil {
			return nil, err
		}
		var page []IssueAttachment
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("failed to unmarshal attachments: %w", err)
		}
		for _, a := range page {
			if !a.Removed {
				out = append(out, a)
			}
		}
		if len(page) < discussionPageSize {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	return out, nil
}

// DownloadAttachment fetches an attachment's bytes. attURL is the `url` field
// YouTrack returns, which is relative to the instance (it already includes
// any context path such as /youtrack, so it's resolved against the host, not
// appended to baseURL). Downloads larger than maxBytes are rejected without
// reading the whole body.
func (c *Client) DownloadAttachment(ctx context.Context, attURL string, maxBytes int64) ([]byte, string, error) {
	base, err := url.Parse(c.baseURL + "/")
	if err != nil {
		return nil, "", fmt.Errorf("invalid base URL: %w", err)
	}
	ref, err := url.Parse(attURL)
	if err != nil {
		return nil, "", fmt.Errorf("invalid attachment URL: %w", err)
	}
	full := base.ResolveReference(ref)
	if full.Host != base.Host {
		return nil, "", fmt.Errorf("attachment URL points outside the YouTrack instance")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, full.String(), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("download failed: status %d", resp.StatusCode)
	}
	if resp.ContentLength > maxBytes {
		return nil, "", fmt.Errorf("attachment is %d bytes, over the %d byte download limit", resp.ContentLength, maxBytes)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("failed to read attachment: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, "", fmt.Errorf("attachment is over the %d byte download limit", maxBytes)
	}
	return data, resp.Header.Get("Content-Type"), nil
}

// markdownImageRe matches `![alt](target)` and `![alt](target "title")`.
// YouTrack may append `{width=70%}` after the closing paren, which is ignored.
var markdownImageRe = regexp.MustCompile(`!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)`)

// InlineImageRefs returns the targets of markdown image references in text,
// in order of appearance, de-duplicated. Targets are URL-decoded so
// `my%20shot.png` matches an attachment named `my shot.png`.
func InlineImageRefs(text string) []string {
	matches := markdownImageRe.FindAllStringSubmatch(text, -1)
	seen := map[string]bool{}
	var refs []string
	for _, m := range matches {
		ref := m[1]
		if dec, err := url.PathUnescape(ref); err == nil {
			ref = dec
		}
		if !seen[ref] {
			seen[ref] = true
			refs = append(refs, ref)
		}
	}
	return refs
}

// markdownImageWithAttrsRe also swallows YouTrack's trailing `{width=70%}`.
var markdownImageWithAttrsRe = regexp.MustCompile(markdownImageRe.String() + `(?:\{[^}]*\})?`)

// ReplaceInlineImageRefs swaps markdown image embeds for a short
// "[image: name]" placeholder, for text-only consumers like the Slack bot.
func ReplaceInlineImageRefs(text string) string {
	return markdownImageWithAttrsRe.ReplaceAllStringFunc(text, func(m string) string {
		sub := markdownImageRe.FindStringSubmatch(m)
		if len(sub) < 2 {
			return "[image]"
		}
		name := sub[1]
		if dec, err := url.PathUnescape(name); err == nil {
			name = dec
		}
		return "[image: " + name + "]"
	})
}

// IsImageMime reports whether a mime type is one we can hand back as an
// MCP image content block.
func IsImageMime(mime string) bool {
	switch strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0])) {
	case "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp":
		return true
	}
	return false
}
