package middleware

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dhindsa/project-management/internal/logging"
)

// The request log line must carry the user that AuthMiddleware resolved.
func TestAuthMiddlewareSetsUserOnRequestLog(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)

	h := logging.Middleware(AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})))

	req := httptest.NewRequest("GET", "/api/anything?token=secret-value", nil)
	req.Header.Set("Authorization", "Bearer dev-mode-token-abc")
	h.ServeHTTP(httptest.NewRecorder(), req)

	var access map[string]any
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		m := map[string]any{}
		if json.Unmarshal([]byte(l), &m) == nil && m["msg"] == "request" {
			access = m
		}
	}
	if access == nil {
		t.Fatalf("no access line in %q", buf.String())
	}
	if access["user_id"] != "08938fa6-27b4-446f-a9aa-b8fe5c7b97c4" {
		t.Fatalf("user_id = %v", access["user_id"])
	}
	if strings.Contains(buf.String(), "secret-value") {
		t.Fatal("query string token leaked into the log")
	}
}
