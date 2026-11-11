package logging

import (
	"context"
	"errors"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func prettySetup(t *testing.T, color bool) *syncBuf {
	t.Helper()
	buf := &syncBuf{}
	initWith(buf, options{level: slog.LevelDebug, pretty: true, color: color, slowRq: 3000, slowQ: 500})
	t.Cleanup(func() { initWith(&syncBuf{}, options{level: slog.LevelInfo, json: true, slowRq: 3000, slowQ: 500}) })
	return buf
}

func TestPrettyRequestLine(t *testing.T) {
	buf := prettySetup(t, false)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SetUser(r.Context(), "08938fa6-27b4-446f-a9aa-b8fe5c7b97c4")
		AddField(r.Context(), "user_name", "Simran Dhindsa")
		SetRoute(r.Context(), "/api/tasks/{id}")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"success":false,"message":"Task not found"}`))
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/tasks/42?token=SECRET", nil)
	req.Header.Set("X-Request-ID", "req-abcdef123")
	h.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.raw()
	for _, want := range []string{"WARN", "⚠️", "GET /api/tasks/{id} → 404 Not Found", "👤 Simran Dhindsa", "🔖 req-abcdef123", "└ Task not found", " PM "} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "SECRET") || strings.Contains(out, "\x1b[") {
		t.Errorf("leaked token or colour codes:\n%s", out)
	}
}

func TestPrettyColoursOnlyWhenEnabled(t *testing.T) {
	buf := prettySetup(t, true)
	slog.Error("boom")
	if !strings.Contains(buf.raw(), "\x1b[") {
		t.Fatalf("expected colour codes: %q", buf.raw())
	}
}

func TestPrettyMCPJobOutboundDBAndLegacy(t *testing.T) {
	buf := prettySetup(t, false)
	ctx := context.Background()
	slog.InfoContext(ctx, "mcp tool call", "tool", "create_youtrack_ticket", "label", "Created ticket",
		"ok", true, "duration_ms", 1234, "summary", "Created A3-123", "arg_keys", []string{"summary", "title"})
	Job("daily_cleanup", func(ctx context.Context) { log.Printf("pruned 3 rows") })
	slog.WarnContext(ctx, "outbound request", "service", "api.slack.com", "method", "POST",
		"path", "/api/chat.postMessage", "status", 500, "duration_ms", 80)
	slog.WarnContext(ctx, "db query failed", "sql", "SELECT 1", "error", errors.New("relation missing"), "duration_ms", 3)
	log.Printf("⚠️ YouTrack sync failed: timeout")
	Job("explode", func(ctx context.Context) { panic("nil map") })

	out := buf.raw()
	for _, want := range []string{
		"🤖 Connected tool create_youtrack_ticket  ·  ✓ worked  ·  1.2s", "└ Created A3-123", "fields sent: summary, title",
		"Job daily_cleanup done in",
		"🌐 Slack  ·  POST /api/chat.postMessage → 500 Internal Server Error",
		"Database query failed: relation missing", "└ SQL: SELECT 1",
		"⚠️ YouTrack sync failed: timeout",
		"💥 Job explode crashed: nil map", "└ at logging.TestPrettyMCPJobOutboundDBAndLegacy.func2  internal/logging/pretty_test.go:",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "run_id=") || strings.Contains(out, "source=legacy") {
		t.Errorf("internal fields shown:\n%s", out)
	}
}

func TestHumanDuration(t *testing.T) {
	for in, want := range map[string]string{"34": "34ms", "1234": "1.2s", "125000": "2m 5s", "x": "x"} {
		if got := humanDuration(in); got != want {
			t.Errorf("%s: got %s want %s", in, got, want)
		}
	}
}

func TestPrettyNoForgedLinesOrTerminalCodes(t *testing.T) {
	buf := prettySetup(t, false)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("bad\nJan 01 00:00:00 AM  INFO   ✅ forged line\x1b[2J"))
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.URL.Path = "/api/x\r\nJan 01 FAKE\x1b]0;pwned\x07"
	h.ServeHTTP(httptest.NewRecorder(), req)
	log.Printf("legacy\nsecond line \x1b[31mred")

	out := buf.raw()
	if strings.ContainsAny(out, "\x1b\r\x07") {
		t.Fatalf("control characters reached the output: %q", out)
	}
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		if !strings.HasPrefix(l, "Nov") && !strings.HasPrefix(l, time.Now().Format("Jan")) && !strings.HasPrefix(strings.TrimSpace(l), "└") {
			t.Errorf("forged or broken line %q in:\n%s", l, out)
		}
	}
}

func TestPrettyPanicStackSkipsMiddlewareFrames(t *testing.T) {
	buf := prettySetup(t, false)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { panic("boom") }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/boom", nil))
	out := buf.raw()
	if strings.Contains(out, "internal/logging/middleware.go") {
		t.Errorf("middleware frames shown:\n%s", out)
	}
	if !strings.Contains(out, "└ at logging.TestPrettyPanicStackSkipsMiddlewareFrames") {
		t.Errorf("panic site missing:\n%s", out)
	}
}
