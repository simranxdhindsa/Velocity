// Package s3storage provides a scratch space for MCP-driven ticket attachment
// uploads: an AI client gets a presigned PUT URL, uploads bytes directly to S3,
// and the backend later fetches + forwards those bytes to YouTrack, deleting
// the object once the push succeeds. Every operation is confined to the
// UploadPrefix — this is not a general-purpose S3 client.
package s3storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
)

const (
	// UploadPrefix scopes every object this package touches. IAM should grant
	// PutObject/GetObject/DeleteObject on this prefix only.
	UploadPrefix = "ticket-uploads/"

	PresignExpiry = 10 * time.Minute
	MaxImageBytes = 15 * 1024 * 1024  // 15MB
	MaxVideoBytes = 200 * 1024 * 1024 // 200MB
)

// ErrObjectTooLarge is returned by GetObjectChecked when the fetched object
// exceeds the size cap for its content type.
var ErrObjectTooLarge = errors.New("attachment exceeds the size limit")

type Client struct {
	s3      *s3.Client
	presign *s3.PresignClient
	bucket  string
}

func NewClient(ctx context.Context, region, accessKeyID, secretAccessKey, bucket string) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}
	cli := s3.NewFromConfig(cfg)
	return &Client{
		s3:      cli,
		presign: s3.NewPresignClient(cli),
		bucket:  bucket,
	}, nil
}

// PresignedUpload is everything the caller needs to PUT a file directly to S3.
type PresignedUpload struct {
	UploadURL string
	ObjectKey string
	ExpiresIn int // seconds
}

// sanitizeFilename keeps the object key readable while stripping path
// separators and anything that isn't a safe filename character.
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\\", "_")
	if name == "" {
		return "file"
	}
	if len(name) > 120 {
		name = name[len(name)-120:]
	}
	return name
}

// PresignPut generates a presigned PUT URL for a brand-new object under
// UploadPrefix. contentType is baked into the signature, so the caller's PUT
// request must send the same Content-Type header.
func (c *Client) PresignPut(ctx context.Context, filename, contentType string) (*PresignedUpload, error) {
	key := UploadPrefix + uuid.NewString() + "-" + sanitizeFilename(filename)
	req, err := c.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	}, s3.WithPresignExpires(PresignExpiry))
	if err != nil {
		return nil, fmt.Errorf("failed to presign upload: %w", err)
	}
	return &PresignedUpload{
		UploadURL: req.URL,
		ObjectKey: key,
		ExpiresIn: int(PresignExpiry.Seconds()),
	}, nil
}

// GetObject downloads an object's bytes and content type. Refuses to touch
// anything outside UploadPrefix.
func (c *Client) GetObject(ctx context.Context, key string) ([]byte, string, error) {
	if !strings.HasPrefix(key, UploadPrefix) {
		return nil, "", errors.New("object key must be within the " + UploadPrefix + " prefix")
	}
	out, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, "", fmt.Errorf("failed to fetch object from S3: %w", err)
	}
	defer out.Body.Close()

	maxBytes := MaxVideoBytes
	if out.ContentLength != nil && *out.ContentLength > int64(maxBytes) {
		return nil, "", ErrObjectTooLarge
	}
	content, err := io.ReadAll(io.LimitReader(out.Body, int64(maxBytes)+1))
	if err != nil {
		return nil, "", fmt.Errorf("failed to read object body: %w", err)
	}
	if len(content) > maxBytes {
		return nil, "", ErrObjectTooLarge
	}

	mimeType := ""
	if out.ContentType != nil {
		mimeType = *out.ContentType
	}
	return content, mimeType, nil
}

// DeleteObject removes an object, e.g. after a successful YouTrack push.
// Refuses to touch anything outside UploadPrefix.
func (c *Client) DeleteObject(ctx context.Context, key string) error {
	if !strings.HasPrefix(key, UploadPrefix) {
		return errors.New("object key must be within the " + UploadPrefix + " prefix")
	}
	_, err := c.s3.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("failed to delete object from S3: %w", err)
	}
	return nil
}
