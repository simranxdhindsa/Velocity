package handlers

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/dhindsa/project-management/internal/services/s3storage"
)

// mcpAttachmentSource is one file given to an MCP tool by exactly one of
// file_url, file_base64 or s3_object_key. Shared by upload_youtrack_attachment
// and add_youtrack_comment.
type mcpAttachmentSource struct {
	FileURL     string `json:"file_url"`
	FileBase64  string `json:"file_base64"`
	S3ObjectKey string `json:"s3_object_key"`
	MimeType    string `json:"mime_type"`
	Filename    string `json:"filename"`
}

func (s mcpAttachmentSource) empty() bool {
	return s.FileURL == "" && s.FileBase64 == "" && s.S3ObjectKey == ""
}

// mcpLoadedAttachment is a source resolved to bytes. Call cleanup only after
// the file was pushed to YouTrack successfully, so a failed push can be
// retried with the same s3_object_key.
type mcpLoadedAttachment struct {
	Content  []byte
	Filename string
	MimeType string
	s3Client *s3storage.Client
	s3Key    string
}

func (l *mcpLoadedAttachment) cleanup(ctx context.Context) {
	if l.s3Client == nil {
		return
	}
	if err := l.s3Client.DeleteObject(ctx, l.s3Key); err != nil {
		// The YouTrack push already succeeded; the 3-day lifecycle rule catches it.
		fmt.Printf("[mcp] warning: failed to delete S3 object %s after successful upload: %v\n", l.s3Key, err)
	}
}

// load fetches the file bytes and fills in filename and mime type defaults.
func (s mcpAttachmentSource) load(ctx context.Context) (*mcpLoadedAttachment, error) {
	l := &mcpLoadedAttachment{Filename: s.Filename, MimeType: s.MimeType}
	switch {
	case s.S3ObjectKey != "":
		s3Client, err := mcpS3Client(ctx)
		if err != nil {
			return nil, err
		}
		content, fetchedMime, err := s3Client.GetObject(ctx, s.S3ObjectKey)
		if err != nil {
			if errors.Is(err, s3storage.ErrObjectTooLarge) {
				return nil, errors.New("attachment is too large, delete it and re-upload a smaller file")
			}
			return nil, errors.New("failed to fetch uploaded file from S3: " + err.Error())
		}
		l.Content, l.s3Client, l.s3Key = content, s3Client, s.S3ObjectKey
		if l.MimeType == "" {
			l.MimeType = fetchedMime
		}

	case s.FileBase64 != "":
		decoded, err := base64.StdEncoding.DecodeString(s.FileBase64)
		if err != nil {
			return nil, errors.New("invalid file_base64: " + err.Error())
		}
		l.Content = decoded

	case s.FileURL != "":
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.FileURL, nil)
		if err != nil {
			return nil, errors.New("invalid file_url: " + err.Error())
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, errors.New("failed to download file: " + err.Error())
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return nil, fmt.Errorf("download failed with status %d", resp.StatusCode)
		}
		if l.Content, err = io.ReadAll(resp.Body); err != nil {
			return nil, errors.New("failed to read file content: " + err.Error())
		}
		if l.Filename == "" {
			parts := strings.Split(strings.Split(s.FileURL, "?")[0], "/")
			l.Filename = parts[len(parts)-1]
		}
		if l.MimeType == "" {
			l.MimeType = strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
		}

	default:
		return nil, errors.New("one of file_url, file_base64 or s3_object_key is required")
	}
	if l.Filename == "" {
		l.Filename = "attachment"
	}
	if l.MimeType == "" {
		l.MimeType = "application/octet-stream"
	}
	return l, nil
}
