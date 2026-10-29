package handlers

import (
	"context"
	"encoding/json"
	"fmt"
)

var createAttachmentUploadURLToolSchema = map[string]interface{}{
	"name":        "create_attachment_upload_url",
	"description": "Generates a presigned S3 URL for uploading a large or local file (screenshot, image, video) that will then be attached to a YouTrack ticket via upload_youtrack_attachment's s3_object_key parameter. Use this instead of file_base64 for anything too large to send as base64 (e.g. videos, or when file_base64 has failed/been unreliable). Steps: (1) call this tool, (2) PUT the raw file bytes to upload_url with a Content-Type header exactly matching the content_type you passed here, (3) call upload_youtrack_attachment with s3_object_key set to the returned object_key. The URL expires in expires_in_seconds — upload promptly.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"filename": map[string]string{
				"type":        "string",
				"description": "Original filename, e.g. 'screenshot.png'.",
			},
			"content_type": map[string]string{
				"type":        "string",
				"description": "MIME type of the file, e.g. 'image/png', 'video/mp4'. Must match the Content-Type header sent on the PUT.",
			},
		},
		"required": []string{"filename", "content_type"},
	},
}

func mcpCreateAttachmentUploadURL(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
	}
	if err := json.Unmarshal(args, &a); err != nil || a.Filename == "" || a.ContentType == "" {
		return rpcErr(id, -32602, "invalid arguments: filename and content_type are required")
	}
	s3Client, err := mcpS3Client(ctx)
	if err != nil {
		return toolError(id, err.Error())
	}
	upload, err := s3Client.PresignPut(ctx, a.Filename, a.ContentType)
	if err != nil {
		return toolError(id, "failed to create upload URL: "+err.Error())
	}
	return toolOK(id, fmt.Sprintf(
		"upload_url: %s\nobject_key: %s\nexpires_in_seconds: %d\n\nPUT the raw file bytes to upload_url with header Content-Type: %s, then call upload_youtrack_attachment with s3_object_key=%q.",
		upload.UploadURL, upload.ObjectKey, upload.ExpiresIn, a.ContentType, upload.ObjectKey,
	))
}
