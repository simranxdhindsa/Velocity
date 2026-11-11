package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

func TestLogMCPToolCallLogsKeysNeverValues(t *testing.T) {
	buf := captureSlog(t)
	args := json.RawMessage(`{"message":"top secret text","channel":"C123","zeta":1}`)
	logMCPToolCall(context.Background(), "queue_slack_message", "Scheduled Slack message", true,
		120*time.Millisecond, strings.Repeat("x", 500), args)

	out := buf.String()
	if strings.Contains(out, "top secret text") || strings.Contains(out, "C123") {
		t.Fatalf("argument values leaked: %s", out)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatal(err)
	}
	if m["msg"] != "mcp tool call" || m["tool"] != "queue_slack_message" || m["ok"] != true || m["level"] != "INFO" {
		t.Fatalf("unexpected line: %v", m)
	}
	keys, _ := m["arg_keys"].([]any)
	if len(keys) != 3 || keys[0] != "channel" || keys[1] != "message" || keys[2] != "zeta" {
		t.Fatalf("arg_keys = %v", m["arg_keys"])
	}
	if s, _ := m["summary"].(string); len([]rune(s)) > 301 {
		t.Fatalf("summary not truncated: %d", len([]rune(s)))
	}
}

func TestLogMCPToolCallFailureIsWarn(t *testing.T) {
	buf := captureSlog(t)
	logMCPToolCall(context.Background(), "whoami", "Who am I", false, time.Millisecond, "nope", nil)
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	if m["level"] != "WARN" || m["ok"] != false {
		t.Fatalf("unexpected line: %v", m)
	}
}

func TestCallToolUnknownToolWarns(t *testing.T) {
	buf := captureSlog(t)
	h := &MCPHandler{}
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	resp := h.callTool(req, 1, json.RawMessage(`{"name":"no_such_tool","arguments":{"a":"b"}}`), "user-1")
	if resp.Error == nil {
		t.Fatal("expected an error response")
	}
	if !strings.Contains(buf.String(), `"level":"WARN"`) || !strings.Contains(buf.String(), "no_such_tool") {
		t.Fatalf("missing warning: %s", buf.String())
	}
}
