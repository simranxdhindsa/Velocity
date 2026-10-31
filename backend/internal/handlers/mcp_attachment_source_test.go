package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestMCPAttachmentSources(t *testing.T) {
	const content = "\x89PNG\r\n\x1a\noriginal image bytes"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Query().Get("signature") != "test" {
			t.Errorf("unexpected download: %s %s", r.Method, r.URL)
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte(content))
	}))
	defer server.Close()
	url := server.URL + "/download.png?signature=test"
	cases := []struct {
		name           string
		source         mcpAttachmentSource
		filename, mime string
	}{
		{"native", mcpAttachmentSource{File: &mcpChatGPTFile{DownloadURL: url, FileID: "file-123", FileName: "screenshot.png", MimeType: "image/png"}}, "screenshot.png", "image/png"},
		{"native optional metadata omitted", mcpAttachmentSource{File: &mcpChatGPTFile{DownloadURL: url, FileID: "file-123"}}, "download.png", "image/png"},
		{"explicit metadata", mcpAttachmentSource{File: &mcpChatGPTFile{DownloadURL: url, FileID: "file-123", FileName: "original.png", MimeType: "image/png"}, Filename: "renamed.png", MimeType: "application/octet-stream"}, "renamed.png", "application/octet-stream"},
		{"legacy URL", mcpAttachmentSource{FileURL: url}, "download.png", "image/png"},
		{"legacy base64", mcpAttachmentSource{FileBase64: base64.StdEncoding.EncodeToString([]byte(content)), Filename: "local.png", MimeType: "image/png"}, "local.png", "image/png"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Exercise the JSON boundary used by MCP tools/call.
			raw, err := json.Marshal(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			var source mcpAttachmentSource
			if err := json.Unmarshal(raw, &source); err != nil {
				t.Fatal(err)
			}
			if source.empty() {
				t.Fatal("source considered empty")
			}
			got, err := source.load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if string(got.Content) != content || got.Filename != tc.filename || got.MimeType != tc.mime {
				t.Fatalf("unexpected loaded attachment: %+v", got)
			}
			if got.s3Client != nil || got.s3Key != "" {
				t.Fatal("direct upload should not use S3")
			}
		})
	}
}

func TestMCPNativeAttachmentErrors(t *testing.T) {
	for _, source := range []mcpAttachmentSource{
		{File: &mcpChatGPTFile{}},
		{File: &mcpChatGPTFile{FileID: "file-123"}},
		{File: &mcpChatGPTFile{DownloadURL: "https://example.com/file"}},
		{File: &mcpChatGPTFile{DownloadURL: "https://example.com/file", FileID: "file-123"}, FileBase64: "eA=="},
	} {
		if _, err := source.load(context.Background()); err == nil {
			t.Fatal("invalid native file accepted")
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusForbidden) }))
	defer server.Close()
	source := mcpAttachmentSource{File: &mcpChatGPTFile{DownloadURL: server.URL, FileID: "file-expired"}}
	if _, err := source.load(context.Background()); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("expected expired URL error, got %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := source.load(ctx); err == nil {
		t.Fatal("canceled download succeeded")
	}
}

// Check the serialized descriptors clients actually discover, including the
// required OpenAI metadata and all four file properties (two optional).
func TestMCPNativeFileDescriptors(t *testing.T) {
	data, err := json.Marshal(mcpTools)
	if err != nil {
		t.Fatal(err)
	}
	var descriptors []struct {
		Name  string              `json:"name"`
		Meta  map[string][]string `json:"_meta"`
		Input struct {
			Properties map[string]json.RawMessage `json:"properties"`
		} `json:"inputSchema"`
	}
	if err := json.Unmarshal(data, &descriptors); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, tool := range descriptors {
		field := ""
		switch tool.Name {
		case "upload_youtrack_attachment":
			field = "file"
		case "add_youtrack_comment":
			field = "files"
		default:
			continue
		}
		checked++
		if !reflect.DeepEqual(tool.Meta["openai/fileParams"], []string{field}) {
			t.Fatalf("missing fileParams on %s", tool.Name)
		}
		raw := tool.Input.Properties[field]
		if field == "files" {
			var array struct {
				Type  string          `json:"type"`
				Items json.RawMessage `json:"items"`
			}
			if err := json.Unmarshal(raw, &array); err != nil {
				t.Fatal(err)
			}
			if array.Type != "array" {
				t.Fatal("files must be an array")
			}
			raw = array.Items
		}
		var file struct {
			Type       string                       `json:"type"`
			Properties map[string]map[string]string `json:"properties"`
			Required   []string                     `json:"required"`
		}
		if err := json.Unmarshal(raw, &file); err != nil {
			t.Fatal(err)
		}
		if file.Type != "object" || !reflect.DeepEqual(file.Required, []string{"download_url", "file_id"}) {
			t.Fatalf("invalid native file schema: %s", raw)
		}
		for _, key := range []string{"download_url", "file_id", "mime_type", "file_name"} {
			if file.Properties[key]["type"] != "string" {
				t.Fatalf("missing file property %s", key)
			}
		}
	}
	if checked != 2 {
		t.Fatalf("checked %d tools, want 2", checked)
	}
}
