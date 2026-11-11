// Package logging is the single place the backend sets up structured logging:
// the root slog handler, request middleware, job wrappers, outbound HTTP and DB
// tracing, and the optional app_logs store. It imports no internal package.
package logging

import (
	"context"
	"io"
	"log"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
)

var (
	slowRequestMS atomic.Int64
	slowQueryMS   atomic.Int64
)

func init() {
	slowRequestMS.Store(3000)
	slowQueryMS.Store(500)
}

type options struct {
	level  slog.Level
	json   bool
	pretty bool // easy-to-read lines with emojis (the default)
	color  bool // ANSI colours in pretty mode
	slowRq int64
	slowQ  int64
}

func envInt(key string, def int64) int64 {
	if v, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(key)), 10, 64); err == nil && v > 0 {
		return v
	}
	return def
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}

func optionsFromEnv() options {
	// LOG_FORMAT: pretty (default, easy to read), json (for log tools) or text.
	format := strings.ToLower(strings.TrimSpace(os.Getenv("LOG_FORMAT")))
	return options{
		level:  parseLevel(os.Getenv("LOG_LEVEL")),
		json:   format == "json",
		pretty: format == "" || format == "pretty",
		color:  colorEnabled(),
		slowRq: envInt("LOG_SLOW_REQUEST_MS", 3000),
		slowQ:  envInt("LOG_SLOW_QUERY_MS", 500),
	}
}

// colorEnabled: LOG_COLOR=on/off wins, then NO_COLOR, then colours only when
// stdout is a terminal, so log viewers never see raw colour codes.
func colorEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("LOG_COLOR"))) {
	case "on", "true", "1", "always":
		return true
	case "off", "false", "0", "never":
		return false
	}
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	return isTerminal(os.Stdout)
}

// Init configures logging from the environment and installs it as the slog
// default and as the output of the standard log package. Safe to call again.
func Init() { initWith(os.Stdout, optionsFromEnv()) }

func initWith(w io.Writer, o options) {
	slowRequestMS.Store(o.slowRq)
	slowQueryMS.Store(o.slowQ)
	hopts := &slog.HandlerOptions{Level: o.level}
	var base slog.Handler
	switch {
	case o.json:
		base = slog.NewJSONHandler(w, hopts)
	case o.pretty:
		base = newPrettyHandler(w, o.level, o.color)
	default:
		base = slog.NewTextHandler(w, hopts)
	}
	logger := slog.New(&rootHandler{base: base})
	slog.SetDefault(logger)
	// slog.SetDefault rewires the log package, so the bridge goes on after it.
	log.SetFlags(0)
	log.SetOutput(legacyWriter{logger: logger})
}

// legacyWriter routes standard log package lines through the root logger.
type legacyWriter struct{ logger *slog.Logger }

func (l legacyWriter) Write(p []byte) (int, error) {
	msg := strings.TrimRight(string(p), "\r\n")
	l.logger.Log(context.Background(), legacyLevel(msg), msg, "source", "legacy")
	return len(p), nil
}

var (
	legacyErrorIcons = []string{"❌", "🔥", "💥"}
	legacyWarnIcons  = []string{"⚠", "✗"}
	legacyInfoIcons  = []string{"✅", "✓", "🚀", "📍", "📦", "📡", "🗑"}
	legacyErrorWords = []string{"error", "failed", "fail:", "panic", "fatal", "❌"}
	legacyWarnWords  = []string{"⚠", "warn", "✗", "could not", "couldn't", "unable", "skipp", "denied", "invalid", "timeout", "retry"}
)

// legacyLevel guesses a level for an old log.Printf line from its text.
func legacyLevel(msg string) slog.Level {
	// A leading icon is the author's own choice of severity, so it wins.
	lead := strings.TrimLeft(msg, " [")
	for _, w := range legacyErrorIcons {
		if strings.HasPrefix(lead, w) {
			return slog.LevelError
		}
	}
	for _, w := range legacyWarnIcons {
		if strings.HasPrefix(lead, w) {
			return slog.LevelWarn
		}
	}
	for _, w := range legacyInfoIcons {
		if strings.HasPrefix(lead, w) {
			return slog.LevelInfo
		}
	}
	m := strings.ToLower(msg)
	// "warning: failed to ..." is the author calling it a warning.
	if strings.Contains(m, "warning") {
		return slog.LevelWarn
	}
	for _, w := range legacyErrorWords {
		if strings.Contains(m, w) {
			return slog.LevelError
		}
	}
	for _, w := range legacyWarnWords {
		if strings.Contains(m, w) {
			return slog.LevelWarn
		}
	}
	return slog.LevelInfo
}

// rootHandler wraps the base handler: it adds request and job attributes from
// the context and copies WARN and above to the store.
type rootHandler struct {
	base   slog.Handler
	groups []string
	attrs  []slog.Attr // already prefixed with open groups, kept for the store
}

func (h *rootHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.base.Enabled(ctx, l) || (l >= slog.LevelWarn && currentStore() != nil)
}

func (h *rootHandler) Handle(ctx context.Context, r slog.Record) error {
	if ctx == nil {
		ctx = context.Background()
	}
	r = scrubRecord(r)
	present := map[string]bool{}
	r.Attrs(func(a slog.Attr) bool { present[a.Key] = true; return true })
	add := func(k, v string) {
		if v != "" && !present[k] {
			present[k] = true
			r.AddAttrs(slog.String(k, v))
		}
	}
	if in := getInfo(ctx); in != nil {
		s := in.snapshot()
		add("request_id", s.id)
		add("user_id", s.userID)
	}
	if j := getJob(ctx); j != nil {
		add("job", j.name)
		add("run_id", j.runID)
	}
	var err error
	if h.base.Enabled(ctx, r.Level) {
		err = h.base.Handle(ctx, r)
	}
	if r.Level >= slog.LevelWarn {
		if w := currentStore(); w != nil {
			w.enqueue(h.toRecord(ctx, r))
		}
	}
	return err
}

func (h *rootHandler) WithAttrs(as []slog.Attr) slog.Handler {
	if len(as) == 0 {
		return h
	}
	as = scrubAttrs(as)
	n := &rootHandler{base: h.base.WithAttrs(as), groups: h.groups}
	n.attrs = append(append([]slog.Attr{}, h.attrs...), prefixAttrs(h.groups, as)...)
	return n
}

func (h *rootHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	return &rootHandler{base: h.base.WithGroup(name), groups: append(append([]string{}, h.groups...), name), attrs: h.attrs}
}

func prefixAttrs(groups []string, as []slog.Attr) []slog.Attr {
	if len(groups) == 0 {
		return as
	}
	p := strings.Join(groups, ".") + "."
	out := make([]slog.Attr, len(as))
	for i, a := range as {
		a.Key = p + a.Key
		out[i] = a
	}
	return out
}
