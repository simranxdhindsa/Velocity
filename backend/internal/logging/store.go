package logging

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// Record is one log line destined for the app_logs table.
type Record struct {
	Time      time.Time
	Level     string
	Message   string
	RequestID string
	UserID    string
	Route     string
	Job       string
	Attrs     map[string]any
}

// Sink persists records. It is implemented by the database package.
type Sink interface {
	InsertLogs(ctx context.Context, recs []Record) error
	PruneLogs(ctx context.Context, olderThan time.Duration) (int64, error)
}

const (
	storeQueueSize  = 1000
	storeBatchSize  = 100
	maxMessageLen   = 2000
	maxLegacyStored = 200
	maxAttrLen      = 4000
)

type storeWorker struct {
	sink       Sink
	ch         chan Record
	flushReq   chan chan struct{}
	stop       chan struct{}
	dropped    atomic.Int64
	flushEvery time.Duration
}

var activeStore atomic.Pointer[storeWorker]

func currentStore() *storeWorker { return activeStore.Load() }

// EnableStore starts saving WARN and above to s. No-op when LOG_STORE=off or
// when a store is already running.
func EnableStore(s Sink) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("LOG_STORE")), "off") || s == nil {
		return
	}
	startStore(s, 2*time.Second)
}

func startStore(s Sink, every time.Duration) *storeWorker {
	w := &storeWorker{
		sink: s, ch: make(chan Record, storeQueueSize),
		flushReq: make(chan chan struct{}), stop: make(chan struct{}), flushEvery: every,
	}
	if !activeStore.CompareAndSwap(nil, w) {
		return activeStore.Load()
	}
	go w.run()
	return w
}

// stopStore detaches and stops the worker (used by tests).
func (w *storeWorker) close() {
	if activeStore.CompareAndSwap(w, nil) {
		close(w.stop)
	}
}

// enqueue never blocks: a full queue drops the record and counts it.
func (w *storeWorker) enqueue(r Record) {
	select {
	case w.ch <- r:
	default:
		w.dropped.Add(1)
	}
}

// safeInsert turns a sink panic into an error, so the worker keeps running.
func (w *storeWorker) safeInsert(ctx context.Context, batch []Record) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("sink panic: %v", p)
		}
	}()
	return w.sink.InsertLogs(ctx, batch)
}

func (w *storeWorker) run() {
	var batch []Record
	tick := time.NewTicker(w.flushEvery)
	defer tick.Stop()
	lastReport := time.Now()
	flush := func() {
		if len(batch) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(NoTrace(context.Background()), 5*time.Second)
		defer cancel()
		if err := w.safeInsert(ctx, batch); err != nil {
			// Written to stderr directly: logging here could loop back into the store.
			fmt.Fprintf(os.Stderr, "logging: could not save %d log lines: %v\n", len(batch), err)
		}
		batch = nil
	}
	for {
		select {
		case rec := <-w.ch:
			batch = append(batch, rec)
			if len(batch) >= storeBatchSize {
				flush()
			}
		case <-tick.C:
			flush()
			if time.Since(lastReport) >= 30*time.Second {
				lastReport = time.Now()
				if n := w.dropped.Swap(0); n > 0 {
					fmt.Fprintf(os.Stderr, "logging: dropped %d log lines because the save queue was full\n", n)
				}
			}
		case done := <-w.flushReq:
			for drained := false; !drained; {
				select {
				case rec := <-w.ch:
					batch = append(batch, rec)
				default:
					drained = true
				}
			}
			flush()
			close(done)
		case <-w.stop:
			return
		}
	}
}

// Flush writes everything queued so far. No-op when the store is not running.
func Flush(ctx context.Context) error {
	w := currentStore()
	if w == nil {
		return nil
	}
	done := make(chan struct{})
	select {
	case w.flushReq <- done:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// StartStorePruner deletes saved lines older than LOG_RETENTION_DAYS, once now
// and then every 24 hours. No-op when the store is not running.
func StartStorePruner() {
	w := currentStore()
	if w == nil {
		return
	}
	days := envInt("LOG_RETENTION_DAYS", 14)
	if days > 36500 { // avoid Duration overflow, which would wipe the table
		days = 36500
	}
	go func() {
		defer Recover(context.Background(), "app_logs_prune_loop")
		for {
			w.prune(time.Duration(days) * 24 * time.Hour)
			select {
			case <-time.After(24 * time.Hour):
			case <-w.stop:
				return
			}
		}
	}()
}

func (w *storeWorker) prune(age time.Duration) {
	Job("app_logs_prune", func(ctx context.Context) {
		ctx, cancel := context.WithTimeout(NoTrace(ctx), 30*time.Second)
		defer cancel()
		n, err := w.sink.PruneLogs(ctx, age)
		if err != nil {
			slog.WarnContext(ctx, "app logs prune failed", "error", err.Error())
			return
		}
		slog.InfoContext(ctx, "app logs pruned", "deleted", n)
	})
}

func (h *rootHandler) toRecord(ctx context.Context, r slog.Record) Record {
	msg := truncate(r.Message, maxMessageLen)
	rec := Record{Time: r.Time, Level: r.Level.String(), Message: msg, Attrs: map[string]any{}}
	if rec.Time.IsZero() {
		rec.Time = time.Now()
	}
	for _, a := range h.attrs {
		addRecordAttr(rec.Attrs, "", a)
	}
	r.Attrs(func(a slog.Attr) bool {
		addRecordAttr(rec.Attrs, strings.Join(h.groups, "."), a)
		return true
	})
	if in := getInfo(ctx); in != nil {
		s := in.snapshot()
		rec.RequestID, rec.UserID, rec.Route = s.id, s.userID, s.route
	}
	if j := getJob(ctx); j != nil {
		rec.Job = j.name
		rec.Attrs["run_id"] = j.runID
	}
	if rec.Attrs["source"] == "legacy" {
		// Old log lines can echo tickets, comments or payloads, so only the
		// start is kept in the database.
		rec.Message = truncate(rec.Message, maxLegacyStored)
	}
	if rec.UserID == "" {
		if v, ok := rec.Attrs["user_id"].(string); ok {
			rec.UserID = v
		}
	}
	if rec.Route == "" {
		if v, ok := rec.Attrs["route"].(string); ok {
			rec.Route = v
		}
	}
	return rec
}

func addRecordAttr(m map[string]any, prefix string, a slog.Attr) {
	v := a.Value.Resolve()
	key := a.Key
	if prefix != "" && key != "" {
		key = prefix + "." + key
	}
	switch v.Kind() {
	case slog.KindGroup:
		p := key
		if a.Key == "" {
			p = prefix
		}
		for _, g := range v.Group() {
			addRecordAttr(m, p, g)
		}
	case slog.KindString:
		m[key] = truncate(v.String(), maxAttrLen)
	case slog.KindInt64:
		m[key] = v.Int64()
	case slog.KindUint64:
		m[key] = v.Uint64()
	case slog.KindFloat64:
		m[key] = v.Float64()
	case slog.KindBool:
		m[key] = v.Bool()
	case slog.KindDuration:
		m[key] = v.Duration().String()
	case slog.KindTime:
		m[key] = v.Time().Format(time.RFC3339)
	default:
		if err, ok := v.Any().(error); ok && err != nil {
			m[key] = truncate(err.Error(), maxAttrLen)
		} else {
			m[key] = truncate(fmt.Sprint(v.Any()), maxAttrLen)
		}
	}
}
