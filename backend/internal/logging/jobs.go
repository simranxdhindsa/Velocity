package logging

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"runtime/debug"
	"time"
)

var tickSlow = 30 * time.Second

func newRunID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func runJob(name string, tick bool, fn func(ctx context.Context)) {
	runID := newRunID()
	ctx := WithJob(context.Background(), name, runID)
	start := time.Now()
	slog.DebugContext(ctx, "job started")
	defer func() {
		if v := recover(); v != nil {
			slog.ErrorContext(ctx, "job panicked", "panic", fmt.Sprint(v),
				"stack", string(debug.Stack()), "duration_ms", time.Since(start).Milliseconds())
		}
	}()
	fn(ctx)
	d := time.Since(start)
	switch {
	case tick && d > tickSlow:
		slog.WarnContext(ctx, "job finished", "duration_ms", d.Milliseconds(), "slow", true)
	case tick:
		slog.DebugContext(ctx, "job finished", "duration_ms", d.Milliseconds())
	default:
		slog.InfoContext(ctx, "job finished", "duration_ms", d.Milliseconds())
	}
}

// Job runs fn synchronously as a named background job, logging start, finish
// and any panic. A panic is logged and swallowed so a loop keeps running.
func Job(name string, fn func(ctx context.Context)) { runJob(name, false, fn) }

// Tick is Job for very frequent loops: the finish line is DEBUG unless slow.
func Tick(name string, fn func(ctx context.Context)) { runJob(name, true, fn) }

// Go starts fn in a goroutine that logs a panic instead of crashing the server.
func Go(ctx context.Context, name string, fn func()) {
	go func() {
		defer Recover(ctx, name)
		fn()
	}()
}

// Recover logs a recovered panic. It must be deferred directly
// (`defer logging.Recover(ctx, "name")`) because recover only works when called
// by the deferred function itself.
func Recover(ctx context.Context, name string) {
	if v := recover(); v != nil {
		if ctx == nil {
			ctx = context.Background()
		}
		slog.ErrorContext(ctx, "goroutine panicked", "name", name,
			"panic", fmt.Sprint(v), "stack", string(debug.Stack()))
	}
}
