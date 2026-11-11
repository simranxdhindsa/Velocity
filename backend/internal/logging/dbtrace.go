package logging

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// DBTracer logs failed and slow queries. It never logs query arguments.
type DBTracer struct{}

type queryStart struct {
	at  time.Time
	sql string
}

type queryStartKey struct{}

func (DBTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if isNoTrace(ctx) {
		return ctx
	}
	return context.WithValue(ctx, queryStartKey{}, queryStart{at: time.Now(), sql: data.SQL})
}

func (DBTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if isNoTrace(ctx) {
		return
	}
	qs, ok := ctx.Value(queryStartKey{}).(queryStart)
	if !ok {
		return
	}
	d := time.Since(qs.at)
	addDB(ctx, d)
	sql := truncate(collapseSpace(qs.sql), 300)
	if err := data.Err; err != nil && !errors.Is(err, pgx.ErrNoRows) {
		if errors.Is(err, context.Canceled) {
			slog.DebugContext(ctx, "db query canceled", "sql", sql, "duration_ms", d.Milliseconds())
		} else {
			slog.WarnContext(ctx, "db query failed", "sql", sql, "error", err.Error(), "duration_ms", d.Milliseconds())
		}
		return
	}
	if d.Milliseconds() > slowQueryMS.Load() {
		slog.WarnContext(ctx, "slow db query", "sql", sql, "duration_ms", d.Milliseconds())
	}
}

func collapseSpace(s string) string { return strings.Join(strings.Fields(s), " ") }

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
