package database

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/logging"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Opt-in: runs against the Postgres in TEST_DATABASE_URL (a throwaway one, never a real database).
func newTestAppLogRepo(t *testing.T) (*AppLogRepository, context.Context) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres to run")
	}
	ctx := context.Background()
	p, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	old := pool
	pool = p
	t.Cleanup(func() { pool = old; p.Close() })
	RunAppLogsMigrations(ctx)
	RunAppLogsMigrations(ctx) // idempotent
	if _, err := p.Exec(ctx, `DELETE FROM app_logs WHERE request_id LIKE 'applogtest-%'`); err != nil {
		t.Fatal(err)
	}
	return NewAppLogRepository(), ctx
}

func TestAppLogsInsertListFilterAndPrune(t *testing.T) {
	r, ctx := newTestAppLogRepo(t)
	t.Cleanup(func() { GetPool().Exec(ctx, `DELETE FROM app_logs WHERE request_id LIKE 'applogtest-%'`) })
	now := time.Now()
	recs := []logging.Record{
		{Time: now.Add(-3 * time.Minute), Level: "WARN", Message: "slow 100% query_x", RequestID: "applogtest-1", UserID: "u1", Route: "/api/a", Attrs: map[string]any{"k": "v"}},
		{Time: now.Add(-2 * time.Minute), Level: "ERROR", Message: "panic recovered", RequestID: "applogtest-2", UserID: "u2", Job: "j"},
		{Time: now.Add(-1 * time.Minute), Level: "INFO", Message: "plain info", RequestID: "applogtest-3"},
		{Time: now.Add(-400 * time.Hour), Level: "WARN", Message: "ancient", RequestID: "applogtest-4"},
		{Time: now, Level: "WARN", Message: "big attrs", RequestID: "applogtest-5", Attrs: map[string]any{"x": strings.Repeat("a", 20000)}},
	}
	if err := r.InsertLogs(ctx, recs); err != nil {
		t.Fatal(err)
	}
	mine := func(f AppLogFilter) []AppLog {
		out, err := r.List(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		var m []AppLog
		for _, l := range out {
			if strings.HasPrefix(l.RequestID, "applogtest-") {
				m = append(m, l)
			}
		}
		return m
	}
	if got := mine(AppLogFilter{Limit: 500}); len(got) != 5 || got[0].RequestID != "applogtest-5" {
		t.Fatalf("all: %+v", got)
	}
	if got := mine(AppLogFilter{RequestID: "applogtest-5"}); len(got) != 1 || got[0].Attrs["truncated"] != true {
		t.Fatalf("oversized attrs should be replaced by a note: %+v", got)
	}
	if got := mine(AppLogFilter{MinLevel: "warn", Limit: 500}); len(got) != 4 {
		t.Fatalf("warn+: %d", len(got))
	}
	if got := mine(AppLogFilter{MinLevel: "error", Limit: 500}); len(got) != 1 || got[0].Job != "j" {
		t.Fatalf("error: %+v", got)
	}
	// % and _ in the search text are literal.
	if got := mine(AppLogFilter{Q: "100% query_x", Limit: 500}); len(got) != 1 || got[0].Attrs["k"] != "v" || got[0].UserID != "u1" {
		t.Fatalf("q: %+v", got)
	}
	if got := mine(AppLogFilter{Q: "100_ query%", Limit: 500}); len(got) != 0 {
		t.Fatalf("wildcards must not match: %+v", got)
	}
	if got := mine(AppLogFilter{RequestID: "applogtest-2", Limit: 500}); len(got) != 1 {
		t.Fatalf("request id: %+v", got)
	}
	if got := mine(AppLogFilter{UserID: "u2", Limit: 500}); len(got) != 1 {
		t.Fatalf("user id: %+v", got)
	}
	since := now.Add(-150 * time.Second)
	if got := mine(AppLogFilter{Since: &since, Limit: 500}); len(got) != 3 {
		t.Fatalf("since: %d", len(got))
	}
	until := now.Add(-150 * time.Second)
	if got := mine(AppLogFilter{Until: &until, Limit: 500}); len(got) != 2 {
		t.Fatalf("until: %d", len(got))
	}
	page1, _ := r.List(ctx, AppLogFilter{Limit: 2})
	if len(page1) != 2 {
		t.Fatalf("page1 %d", len(page1))
	}
	page2, _ := r.List(ctx, AppLogFilter{Limit: 2, BeforeID: page1[1].ID})
	for _, l := range page2 {
		if l.ID >= page1[1].ID {
			t.Fatalf("paging overlap")
		}
	}
	n, err := r.PruneLogs(ctx, 14*24*time.Hour)
	if err != nil || n < 1 {
		t.Fatalf("prune: n=%d err=%v", n, err)
	}
	if got := mine(AppLogFilter{Limit: 500}); len(got) != 4 {
		t.Fatalf("after prune: %d", len(got))
	}
}
