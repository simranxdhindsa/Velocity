package logging

import (
	"context"
	"testing"
	"time"
)

func TestJobLogsAndSurvivesPanic(t *testing.T) {
	buf := setup(t, -4)
	Job("ok_job", func(ctx context.Context) {})
	Job("bad_job", func(ctx context.Context) { panic("x") })
	ls := buf.lines(t)
	f := find(ls, "job finished")
	if f == nil || f["job"] != "ok_job" || f["level"] != "INFO" || f["run_id"] == "" {
		t.Errorf("%v", f)
	}
	p := find(ls, "job panicked")
	if p == nil || p["job"] != "bad_job" || p["panic"] != "x" {
		t.Errorf("%v", p)
	}
}

func TestTickLevels(t *testing.T) {
	buf := setup(t, 0)
	Tick("t", func(ctx context.Context) {})
	if find(buf.lines(t), "job finished") != nil {
		t.Error("tick finish should be debug")
	}
	old := tickSlow
	tickSlow = time.Millisecond
	defer func() { tickSlow = old }()
	Tick("t", func(ctx context.Context) { time.Sleep(5 * time.Millisecond) })
	l := find(buf.lines(t), "job finished")
	if l == nil || l["level"] != "WARN" || l["slow"] != true {
		t.Errorf("%v", l)
	}
}

func TestGoAndRecover(t *testing.T) {
	buf := setup(t, -4)
	done := make(chan struct{})
	Go(context.Background(), "g1", func() { defer close(done); panic("gp") })
	<-done
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && find(buf.lines(t), "goroutine panicked") == nil {
		time.Sleep(5 * time.Millisecond)
	}
	l := find(buf.lines(t), "goroutine panicked")
	if l == nil || l["name"] != "g1" || l["panic"] != "gp" {
		t.Errorf("%v", l)
	}
}
