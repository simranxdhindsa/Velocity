package logging

import (
	"context"
	"errors"
	"log"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeSink struct {
	mu      sync.Mutex
	recs    []Record
	err     error
	delay   time.Duration
	pruned  []time.Duration
	noTrace bool
}

func (f *fakeSink) InsertLogs(ctx context.Context, recs []Record) error {
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.noTrace = isNoTrace(ctx)
	if f.err != nil {
		// would loop if the sink logged its failure through slog
		return f.err
	}
	f.recs = append(f.recs, recs...)
	return nil
}

func (f *fakeSink) PruneLogs(ctx context.Context, d time.Duration) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pruned = append(f.pruned, d)
	return 3, nil
}

func (f *fakeSink) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.recs)
}

func TestStoreCapturesWarnAndAbove(t *testing.T) {
	setup(t, slog.LevelError) // base level hides WARN, store must still get it
	s := &fakeSink{}
	w := startStore(s, time.Hour)
	defer w.close()
	in := &info{id: "reqid-1234", userID: "u1", route: "/api/x"}
	ctx := WithJob(context.WithValue(context.Background(), infoKey, in), "jb", "r1")
	slog.InfoContext(ctx, "info line")
	slog.WarnContext(ctx, "warn line", "n", 5, "e", errors.New("bad"))
	if err := Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.count() != 1 {
		t.Fatalf("count %d", s.count())
	}
	r := s.recs[0]
	if r.Level != "WARN" || r.Message != "warn line" || r.RequestID != "reqid-1234" || r.UserID != "u1" ||
		r.Route != "/api/x" || r.Job != "jb" || r.Attrs["n"] != int64(5) || r.Attrs["e"] != "bad" {
		t.Errorf("%+v", r)
	}
	if !s.noTrace {
		t.Error("insert ctx should be NoTrace")
	}
}

func TestStoreNonBlockingUnderSlowSink(t *testing.T) {
	setup(t, slog.LevelInfo)
	s := &fakeSink{delay: 300 * time.Millisecond}
	w := startStore(s, time.Hour)
	defer w.close()
	start := time.Now()
	for i := 0; i < 5000; i++ {
		slog.Warn("spam")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("logging blocked: %v", d)
	}
	if w.dropped.Load() == 0 {
		t.Error("expected drops")
	}
}

func TestStoreNoRecursionOnSinkError(t *testing.T) {
	setup(t, slog.LevelInfo)
	s := &fakeSink{err: errors.New("db down")}
	w := startStore(s, time.Hour)
	defer w.close()
	slog.Error("one")
	if err := Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if len(w.ch) != 0 {
		t.Errorf("sink failure re-enqueued %d records", len(w.ch))
	}
}

func TestStoreBatchFlushBySize(t *testing.T) {
	setup(t, slog.LevelInfo)
	s := &fakeSink{}
	w := startStore(s, time.Hour)
	defer w.close()
	for i := 0; i < storeBatchSize; i++ {
		slog.Warn("x")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && s.count() < storeBatchSize {
		time.Sleep(10 * time.Millisecond)
	}
	if s.count() != storeBatchSize {
		t.Errorf("count %d", s.count())
	}
}

func TestMessageCapAndNoStore(t *testing.T) {
	setup(t, slog.LevelInfo)
	if err := Flush(context.Background()); err != nil {
		t.Error(err)
	}
	s := &fakeSink{}
	w := startStore(s, time.Hour)
	defer w.close()
	slog.Warn(string(make([]rune, 5000)) + "")
	long := make([]byte, 5000)
	for i := range long {
		long[i] = 'a'
	}
	slog.Warn(string(long))
	Flush(context.Background())
	for _, r := range s.recs {
		if len([]rune(r.Message)) > maxMessageLen {
			t.Error("message not capped")
		}
	}
}

func TestEnableStoreOff(t *testing.T) {
	t.Setenv("LOG_STORE", "off")
	EnableStore(&fakeSink{})
	if currentStore() != nil {
		t.Error("store should be off")
	}
}

func TestStorePruner(t *testing.T) {
	setup(t, slog.LevelInfo)
	t.Setenv("LOG_RETENTION_DAYS", "7")
	StartStorePruner() // no-op without store
	s := &fakeSink{}
	w := startStore(s, time.Hour)
	defer w.close()
	StartStorePruner()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		n := len(s.pruned)
		s.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pruned) != 1 || s.pruned[0] != 7*24*time.Hour {
		t.Errorf("%v", s.pruned)
	}
}

func TestLegacyMessageTruncatedInStore(t *testing.T) {
	setup(t, slog.LevelInfo)
	sink := &fakeSink{}
	w := startStore(sink, time.Hour)
	defer w.close()
	log.Print("request failed " + strings.Repeat("secret ", 200))
	_ = Flush(context.Background())
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.recs) != 1 || len([]rune(sink.recs[0].Message)) > maxLegacyStored {
		t.Fatalf("%+v", sink.recs)
	}
}
