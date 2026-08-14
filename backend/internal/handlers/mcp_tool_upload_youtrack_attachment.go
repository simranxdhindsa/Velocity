package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/dhindsa/project-management/internal/services/s3storage"
)

var uploadYoutrackAttachmentToolSchema = map[string]interface{}{
	"name":        "upload_youtrack_attachment",
	"description": "Uploads a file attachment to a YouTrack ticket. Provide exactly one of: file_url (a publicly accessible URL to download from), file_base64 (raw file bytes, base64-encoded — use for small local/pasted files), or s3_object_key (from create_attachment_upload_url — use for large files or videos).",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"issue_id": map[string]string{
				"type":        "string",
				"description": "Readable ticket ID, e.g. ARD-123.",
			},
			"file_url": map[string]string{
				"type":        "string",
				"description": "Publicly accessible URL of the file to upload. Omit if using file_base64 or s3_object_key.",
			},
			"file_base64": map[string]string{
				"type":        "string",
				"description": "Base64-encoded file content. Use for small local/pasted files with no public URL. Omit if using file_url or s3_object_key.",
			},
			"s3_object_key": map[string]string{
				"type":        "string",
				"description": "object_key returned by create_attachment_upload_url, after the file has been PUT to its upload_url. Omit if using file_url or file_base64.",
			},
			"mime_type": map[string]string{
				"type":        "string",
				"description": "MIME type of the file, e.g. 'image/png'. Used with file_base64/s3_object_key; inferred from the response when using file_url.",
			},
			"filename": map[string]string{
				"type":        "string",
				"description": "Filename to use in YouTrack, e.g. 'screenshot.png'. Infer from URL if not provided when using file_url; recommended otherwise.",
			},
		},
		"required": []string{"issue_id"},
	},
}

func mcpUploadYoutrackAttachment(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		IssueID     string `json:"issue_id"`
		FileURL     string `json:"file_url"`
		FileBase64  string `json:"file_base64"`
		S3ObjectKey string `json:"s3_object_key"`
		MimeType    string `json:"mime_type"`
		Filename    string `json:"filename"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.IssueID == "" ||
		(a.FileURL == "" && a.FileBase64 == "" && a.S3ObjectKey == "") {
		return rpcErr(id, -32602, "invalid arguments: issue_id and one of file_url/file_base64/s3_object_key are required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}

	var content []byte
	var err error
	filename := a.Filename
	mimeType := a.MimeType
	var s3Client *s3storage.Client

	switch {
	case a.S3ObjectKey != "":
		s3Client, err = mcpS3Client(ctx)
		if err != nil {
			return toolError(id, err.Error())
		}
		var fetchedMime string
		content, fetchedMime, err = s3Client.GetObject(ctx, a.S3ObjectKey)
		if err != nil {
			if errors.Is(err, s3storage.ErrObjectTooLarge) {
				return toolError(id, "attachment is too large — delete it and re-upload a smaller file")
			}
			return toolError(id, "failed to fetch uploaded file from S3: "+err.Error())
		}
		if filename == "" {
			filename = "attachment"
		}
		if mimeType == "" {
			mimeType = fetchedMime
		}
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}

	case a.FileBase64 != "":
		decoded, decErr := base64.StdEncoding.DecodeString(a.FileBase64)
		if decErr != nil {
			return toolError(id, "invalid file_base64: "+decErr.Error())
		}
		content = decoded
		if filename == "" {
			filename = "attachment"
		}
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}

	default:
		// Download the file from the provided URL
		httpResp, getErr := http.Get(a.FileURL) //nolint:noctx
		if getErr != nil {
			return toolError(id, "failed to download file: "+getErr.Error())
		}
		defer httpResp.Body.Close()
		if httpResp.StatusCode >= 400 {
			return toolError(id, fmt.Sprintf("download failed with status %d", httpResp.StatusCode))
		}
		content, err = io.ReadAll(httpResp.Body)
		if err != nil {
			return toolError(id, "failed to read file content: "+err.Error())
		}
		if filename == "" {
			// Infer filename from URL path
			parts := strings.Split(strings.Split(a.FileURL, "?")[0], "/")
			filename = parts[len(parts)-1]
			if filename == "" {
				filename = "attachment"
			}
		}
		if mimeType == "" {
			mimeType = strings.Split(httpResp.Header.Get("Content-Type"), ";")[0]
			mimeType = strings.TrimSpace(mimeType)
		}
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
	}

	if err := ytClient.UploadAttachment(ctx, a.IssueID, filename, mimeType, content); err != nil {
		// Leave the S3 object in place on failure so the file isn't lost — the
		// caller can retry upload_youtrack_attachment with the same s3_object_key.
		return toolError(id, "failed to upload attachment: "+err.Error())
	}
	if s3Client != nil {
		if delErr := s3Client.DeleteObject(ctx, a.S3ObjectKey); delErr != nil {
			// The YouTrack push already succeeded — a cleanup failure shouldn't
			// surface as a tool error. The 3-day lifecycle rule catches it.
			fmt.Printf("[mcp] warning: failed to delete S3 object %s after successful upload: %v\n", a.S3ObjectKey, delErr)
		}
	}
	return toolOK(id, fmt.Sprintf("Uploaded '%s' to %s (%d bytes)", filename, a.IssueID, len(content)))
}
