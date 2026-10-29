package handlers

import (
	"context"
	"encoding/json"
	"fmt"
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
		IssueID string `json:"issue_id"`
		mcpAttachmentSource
	}
	if err := json.Unmarshal(args, &a); err != nil || a.IssueID == "" || a.empty() {
		return rpcErr(id, -32602, "invalid arguments: issue_id and one of file_url/file_base64/s3_object_key are required")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}

	file, err := a.load(ctx)
	if err != nil {
		return toolError(id, err.Error())
	}
	if err := ytClient.UploadAttachment(ctx, a.IssueID, file.Filename, file.MimeType, file.Content); err != nil {
		// The S3 object stays in place on failure so the caller can retry
		// upload_youtrack_attachment with the same s3_object_key.
		return toolError(id, "failed to upload attachment: "+err.Error())
	}
	file.cleanup(ctx)
	return toolOK(id, fmt.Sprintf("Uploaded '%s' to %s (%d bytes)", file.Filename, a.IssueID, len(file.Content)))
}
