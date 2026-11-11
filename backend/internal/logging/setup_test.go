package logging

import (
	"context"
	"log"
	"log/slog"
	"strings"
	"testing"
)

func TestLegacyLevel(t *testing.T) {
	cases := map[string]slog.Level{
		"Error connecting":            slog.LevelError,
		"upload FAILED":               slog.LevelError,
		"❌ nope":                      slog.LevelError,
		"panic: x":                    slog.LevelError,
		"⚠ heads up":                  slog.LevelWarn,
		"skipping item":               slog.LevelWarn,
		"could not find":              slog.LevelWarn,
		"invalid token":               slog.LevelWarn,
		"server started on :8080":     slog.LevelInfo,
		"error and warn both present": slog.LevelError,
		"⚠️  pending-messages scheduler: query error: x": slog.LevelWarn,
		"✅ Database connected, 0 failed migrations":      slog.LevelInfo,
		"[MCP] ✗ unknown tool":                           slog.LevelWarn,
		"[slack] warning: failed to log sent message":    slog.LevelWarn,
		"🔥 crash in sync":                                slog.LevelError,
	}
	for msg, want := range cases {
		if got := legacyLevel(msg); got != want {
			t.Errorf("%q: got %v want %v", msg, got, want)
		}
	}
}

func TestLegacyBridge(t *testing.T) {
	buf := setup(t, slog.LevelDebug)
	log.Printf("sync failed for %s\n", "abc")
	l := find(buf.lines(t), "sync failed for abc")
	if l == nil {
		t.Fatalf("missing line: %s", buf.raw())
	}
	if l["source"] != "legacy" || l["level"] != "ERROR" {
		t.Errorf("bad line %v", l)
	}
}

func TestInitIdempotentAndLevel(t *testing.T) {
	setup(t, slog.LevelWarn)
	buf := setup(t, slog.LevelWarn)
	slog.Info("hidden")
	slog.Warn("shown")
	if strings.Contains(buf.raw(), "hidden") {
		t.Error("info should be filtered")
	}
	if !strings.Contains(buf.raw(), "shown") {
		t.Error("warn missing")
	}
}

func TestContextAttrsAndGroups(t *testing.T) {
	buf := setup(t, slog.LevelDebug)
	in := &info{id: "req-12345678"}
	ctx := context.WithValue(context.Background(), infoKey, in)
	SetUser(ctx, "u1")
	ctx = WithJob(ctx, "myjob", "run1")
	slog.Default().With("a", 1).InfoContext(ctx, "hello", "k", "v")
	line := find(buf.lines(t), "hello")
	if line["request_id"] != "req-12345678" || line["job"] != "myjob" || line["run_id"] != "run1" || line["user_id"] != "u1" {
		t.Errorf("missing ctx attrs: %v", line)
	}
	if line["a"].(float64) != 1 {
		t.Errorf("WithAttrs lost: %v", line)
	}
	slog.Default().WithGroup("g").With("b", 2).InfoContext(ctx, "grouped", "k", "v")
	g := find(buf.lines(t), "grouped")["g"].(map[string]any)
	if g["k"] != "v" || g["b"].(float64) != 2 {
		t.Errorf("group lost: %v", g)
	}
}

func TestEnvParsing(t *testing.T) {
	t.Setenv("LOG_LEVEL", "debug")
	t.Setenv("LOG_FORMAT", "")
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("LOG_SLOW_REQUEST_MS", "123")
	o := optionsFromEnv()
	if o.level != slog.LevelDebug || o.json || !o.pretty || o.slowRq != 123 || o.slowQ != 500 {
		t.Errorf("%+v", o)
	}
	t.Setenv("LOG_FORMAT", "json")
	if o := optionsFromEnv(); !o.json || o.pretty {
		t.Error("expected json")
	}
	t.Setenv("LOG_FORMAT", "text")
	if o := optionsFromEnv(); o.json || o.pretty {
		t.Error("expected plain text")
	}
	t.Setenv("LOG_COLOR", "off")
	if optionsFromEnv().color {
		t.Error("LOG_COLOR=off should disable colours")
	}
	t.Setenv("LOG_COLOR", "on")
	if !optionsFromEnv().color {
		t.Error("LOG_COLOR=on should force colours")
	}
}
