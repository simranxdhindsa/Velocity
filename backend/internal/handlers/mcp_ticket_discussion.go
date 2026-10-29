package handlers

import (
	"context"
	"encoding/base64"
	"fmt"
	"path"
	"strings"
	"time"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// Helpers for get_youtrack_ticket: comment thread, attachment ownership,
// inline markdown image mapping, and image content blocks. Kept out of the
// tool file so mcp_tool_get_youtrack_ticket.go stays a thin schema + handler.

const (
	ticketImageMaxBytes    = 1 << 20  // ~1MB raw per returned image (after downscale)
	ticketImageMaxDim      = 1568     // longest side; larger images are downscaled
	ticketImageMaxDownload = 20 << 20 // never download more than this for one attachment
)

type ticketAttEntry struct {
	att          youtrack.IssueAttachment
	source       string // "description", "comment", "older_comment_not_included", "deleted_comment", "unknown"
	commentIndex int    // 1-based index in the returned comments; 0 when not applicable
	isImage      bool
	status       string // image handling outcome, shown per attachment
}

type ticketImage struct {
	base64   string
	mimeType string
	label    string
}

type ticketDiscussion struct {
	issue         *youtrack.Issue
	comments      []youtrack.DiscussionComment // returned (possibly truncated), oldest first
	totalComments int
	commentsErr   string
	atts          []*ticketAttEntry
	attsErr       string
	skipped       []string // "name (reason)" for images not returned
}

func ticketUserMap(u *youtrack.User) map[string]string {
	if u == nil {
		return nil
	}
	return map[string]string{"login": u.Login, "full_name": u.FullName}
}

func msToISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

func buildTicketDiscussion(ctx context.Context, yt *youtrack.Client, issue *youtrack.Issue, commentsLimit int) *ticketDiscussion {
	d := &ticketDiscussion{issue: issue}

	all, err := yt.GetIssueDiscussion(ctx, issue.ID)
	if err != nil {
		d.commentsErr = err.Error()
	}
	d.totalComments = len(all)
	returnedIdx := map[string]int{}
	omitted := map[string]bool{}
	if len(all) > commentsLimit {
		for _, c := range all[:len(all)-commentsLimit] {
			omitted[c.ID] = true
		}
		all = all[len(all)-commentsLimit:]
	}
	d.comments = all
	for i, c := range all {
		returnedIdx[c.ID] = i + 1
	}

	atts, err := yt.GetIssueAttachmentsDetailed(ctx, issue.ID)
	if err != nil {
		// Fall back to the issue's own attachment list (no ownership info).
		d.attsErr = err.Error()
		for _, a := range issue.Attachments {
			atts = append(atts, youtrack.IssueAttachment{ID: a.ID, Name: a.Name, MimeType: a.MimeType, Size: a.Size, URL: a.URL})
		}
	}
	for _, a := range atts {
		e := &ticketAttEntry{att: a, isImage: youtrack.IsImageMime(a.MimeType)}
		switch cid := a.CommentID(); {
		case d.attsErr != "":
			e.source = "unknown"
		case cid == "":
			e.source = "description"
		case returnedIdx[cid] > 0:
			e.source, e.commentIndex = "comment", returnedIdx[cid]
		case omitted[cid]:
			e.source = "older_comment_not_included"
		default:
			e.source = "deleted_comment"
		}
		d.atts = append(d.atts, e)
	}
	return d
}

// findAttachment maps a markdown image target to an attachment: exact name,
// then case-insensitive name, then the last path segment of a URL target.
func (d *ticketDiscussion) findAttachment(ref string) *ticketAttEntry {
	for _, e := range d.atts {
		if e.att.Name == ref {
			return e
		}
	}
	for _, e := range d.atts {
		if strings.EqualFold(e.att.Name, ref) {
			return e
		}
	}
	base := path.Base(strings.SplitN(ref, "?", 2)[0])
	for _, e := range d.atts {
		if strings.EqualFold(e.att.Name, base) || (e.att.URL != "" && strings.Contains(ref, strings.SplitN(e.att.URL, "?", 2)[0])) {
			return e
		}
	}
	return nil
}

func (d *ticketDiscussion) inlineImages(text string) []map[string]interface{} {
	refs := youtrack.InlineImageRefs(text)
	out := make([]map[string]interface{}, 0, len(refs))
	for _, ref := range refs {
		m := map[string]interface{}{"ref": ref, "attachment": nil}
		if e := d.findAttachment(ref); e != nil {
			m["attachment"] = e.att.Name
		}
		out = append(out, m)
	}
	return out
}

func (d *ticketDiscussion) payloadFields() map[string]interface{} {
	comments := make([]map[string]interface{}, 0, len(d.comments))
	for i, c := range d.comments {
		names := make([]string, 0, len(c.Attachments))
		for _, a := range c.Attachments {
			names = append(names, a.Name)
		}
		cm := map[string]interface{}{
			"index":       i + 1,
			"id":          c.ID,
			"author":      ticketUserMap(c.Author),
			"created":     c.Created,
			"created_at":  msToISO(c.Created),
			"text":        c.Text,
			"attachments": names,
		}
		if c.Updated > c.Created {
			cm["updated"] = c.Updated
			cm["updated_at"] = msToISO(c.Updated)
		}
		if inl := d.inlineImages(c.Text); len(inl) > 0 {
			cm["inline_images"] = inl
		}
		comments = append(comments, cm)
	}
	out := map[string]interface{}{
		"comments":           comments,
		"comments_total":     d.totalComments,
		"comments_returned":  len(d.comments),
		"comments_truncated": len(d.comments) < d.totalComments,
	}
	if len(d.comments) < d.totalComments {
		out["comments_note"] = fmt.Sprintf("Only the newest %d of %d comments are included. Pass a larger comments_limit to see older ones.", len(d.comments), d.totalComments)
	}
	if d.commentsErr != "" {
		out["comments_error"] = "could not load comments: " + d.commentsErr
	}
	if d.attsErr != "" {
		out["attachments_error"] = "could not load attachment details (ownership unknown): " + d.attsErr
	}
	if inl := d.inlineImages(d.issue.Description); len(inl) > 0 {
		out["description_inline_images"] = inl
	}
	return out
}

func (d *ticketDiscussion) markImagesNotRequested() {
	for _, e := range d.atts {
		if e.isImage {
			e.status = "not requested (include_images=false)"
		}
	}
}

// collectImages downloads and prepares image attachments in chronological
// order, up to maxImages. When names is non-empty only those are considered.
func (d *ticketDiscussion) collectImages(ctx context.Context, yt *youtrack.Client, maxImages int, names []string) []ticketImage {
	want := map[string]bool{}
	for _, n := range names {
		want[strings.ToLower(strings.TrimSpace(n))] = true
	}
	var images []ticketImage
	for _, e := range d.atts {
		if !e.isImage {
			continue
		}
		name := e.att.Name
		if len(want) > 0 && !want[strings.ToLower(name)] {
			e.status = "not requested (not in image_names)"
			continue
		}
		if e.source == "deleted_comment" {
			e.status = "skipped: belongs to a deleted comment"
			continue
		}
		if e.source == "older_comment_not_included" && len(want) == 0 {
			e.skip(d, "belongs to an older comment outside comments_limit")
			continue
		}
		if len(images) >= maxImages {
			e.skip(d, fmt.Sprintf("max_images cap of %d reached", maxImages))
			continue
		}
		if e.att.URL == "" {
			e.skip(d, "no download URL")
			continue
		}
		if e.att.Size > ticketImageMaxDownload {
			e.skip(d, fmt.Sprintf("%d bytes, too large to download", e.att.Size))
			continue
		}
		raw, ctype, err := yt.DownloadAttachment(ctx, e.att.URL, ticketImageMaxDownload)
		if err != nil {
			e.skip(d, err.Error())
			continue
		}
		mime := e.att.MimeType
		if mime == "" {
			mime = ctype
		}
		prep, err := youtrack.PrepareImageForLLM(raw, mime, ticketImageMaxBytes, ticketImageMaxDim)
		if err != nil {
			e.skip(d, err.Error())
			continue
		}
		n := len(images) + 1
		e.status = fmt.Sprintf("returned as image %d", n)
		if prep.Downscaled {
			e.status += fmt.Sprintf(" (downscaled to %dx%d JPEG, %d bytes)", prep.Width, prep.Height, len(prep.Data))
		}
		images = append(images, ticketImage{
			base64:   base64.StdEncoding.EncodeToString(prep.Data),
			mimeType: prep.MimeType,
			label:    d.imageLabel(e, prep),
		})
	}
	return images
}

func (e *ticketAttEntry) skip(d *ticketDiscussion, reason string) {
	e.status = "skipped: " + reason
	d.skipped = append(d.skipped, fmt.Sprintf("%s (%s)", e.att.Name, reason))
}

func (d *ticketDiscussion) imageLabel(e *ticketAttEntry, p *youtrack.PreparedImage) string {
	where := "attached to the description"
	switch e.source {
	case "comment":
		c := d.comments[e.commentIndex-1]
		who := ""
		if c.Author != nil {
			who = " by " + c.Author.FullName
		}
		where = fmt.Sprintf("attached to comment #%d%s at %s", e.commentIndex, who, msToISO(c.Created))
	case "older_comment_not_included":
		where = "attached to an older comment not included above"
	case "unknown":
		where = "attachment owner unknown"
	}
	dims := ""
	if p.Width > 0 {
		dims = fmt.Sprintf(", %dx%d", p.Width, p.Height)
	}
	return fmt.Sprintf("%s (%s%s)", e.att.Name, where, dims)
}

func (d *ticketDiscussion) attachmentsPayload() []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(d.atts))
	for _, e := range d.atts {
		m := map[string]interface{}{
			"id":         e.att.ID,
			"name":       e.att.Name,
			"mime_type":  e.att.MimeType,
			"size":       e.att.Size,
			"created":    e.att.Created,
			"created_at": msToISO(e.att.Created),
			"author":     ticketUserMap(e.att.Author),
			"source":     e.source,
			"is_image":   e.isImage,
		}
		if cid := e.att.CommentID(); cid != "" {
			m["comment_id"] = cid
		}
		if e.commentIndex > 0 {
			m["comment_index"] = e.commentIndex
		}
		if e.status != "" {
			m["image"] = e.status
		}
		out = append(out, m)
	}
	return out
}

func (d *ticketDiscussion) imagesNote(includeImages bool, returned int) string {
	if !includeImages {
		return "Images were not requested (include_images=false)."
	}
	if len(d.skipped) == 0 {
		return ""
	}
	return fmt.Sprintf("%d image(s) returned, %d not returned: %s. Call again with image_names to fetch specific ones.",
		returned, len(d.skipped), strings.Join(d.skipped, "; "))
}
