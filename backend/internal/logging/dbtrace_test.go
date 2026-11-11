package logging

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestDBTracer(t *testing.T) {
	buf := setup(t, -4)
	tr := DBTracer{}
	in := &info{id: "reqid-1234"}
	ctx := context.WithValue(context.Background(), infoKey, in)

	run := func(ctx context.Context, sql string, err error) {
		c := tr.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: sql, Args: []any{"SECRETARG"}})
		tr.TraceQueryEnd(c, nil, pgx.TraceQueryEndData{Err: err})
	}
	run(ctx, "SELECT 1", nil)
	run(ctx, "SELECT\n  *   FROM t", errors.New("boom"))
	run(ctx, "SELECT 2", pgx.ErrNoRows)
	run(ctx, "SELECT 3", context.Canceled)
	run(NoTrace(ctx), "SELECT 4", errors.New("hidden"))
	run(ctx, strings.Repeat("x", 1000), errors.New("long"))

	if in.dbCount != 5 {
		t.Errorf("dbCount %d", in.dbCount)
	}
	if strings.Contains(buf.raw(), "SECRETARG") || strings.Contains(buf.raw(), "hidden") {
		t.Error("leak or traced NoTrace")
	}
	ls := buf.lines(t)
	f := find(ls, "db query failed")
	if f == nil || f["sql"] != "SELECT * FROM t" || f["error"] != "boom" || f["level"] != "WARN" {
		t.Errorf("%v", f)
	}
	if len(ls) != 4 { // failed, canceled(debug), long failed ... check count below
		// failed, canceled, long failed = 3 lines
		if len(ls) != 3 {
			t.Errorf("unexpected line count %d: %s", len(ls), buf.raw())
		}
	}
	for _, l := range ls {
		if s, ok := l["sql"].(string); ok && len(s) > 300 {
			t.Error("sql not truncated")
		}
	}
}

func TestDBTracerSlow(t *testing.T) {
	buf := setup(t, -4)
	slowQueryMS.Store(1)
	tr := DBTracer{}
	c := tr.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "SELECT pg_sleep(1)"})
	time.Sleep(5 * time.Millisecond)
	tr.TraceQueryEnd(c, nil, pgx.TraceQueryEndData{})
	if find(buf.lines(t), "slow db query") == nil {
		t.Errorf("no slow line: %s", buf.raw())
	}
}
