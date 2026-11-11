package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// prettyHandler writes one easy-to-read line per record: time, a coloured
// level, an emoji and a short sentence, with any detail on indented lines
// below. It is the default output (LOG_FORMAT=pretty). JSON is still
// available with LOG_FORMAT=json for log tools.
type prettyHandler struct {
	mu     *sync.Mutex
	w      io.Writer
	level  slog.Leveler
	color  bool
	attrs  []slog.Attr
	prefix string // open groups, "a.b."
}

func newPrettyHandler(w io.Writer, level slog.Leveler, color bool) *prettyHandler {
	return &prettyHandler{mu: &sync.Mutex{}, w: w, level: level, color: color}
}

func (h *prettyHandler) Enabled(_ context.Context, l slog.Level) bool {
	return l >= h.level.Level()
}

func (h *prettyHandler) WithAttrs(as []slog.Attr) slog.Handler {
	n := *h
	n.attrs = append(append([]slog.Attr{}, h.attrs...), prefixAttrs(splitPrefix(h.prefix), as)...)
	return &n
}

func (h *prettyHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	n := *h
	n.prefix = h.prefix + name + "."
	return &n
}

func splitPrefix(p string) []string {
	if p == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(p, "."), ".")
}

// fields is the record's attributes flattened to strings, in order.
type fields struct {
	keys []string
	vals map[string]string
}

func (f *fields) add(key string, v slog.Value) {
	v = v.Resolve()
	if v.Kind() == slog.KindGroup {
		for _, a := range v.Group() {
			f.add(key+"."+a.Key, a.Value)
		}
		return
	}
	if _, ok := f.vals[key]; !ok {
		f.keys = append(f.keys, key)
	}
	if key == "stack" {
		f.vals[key] = v.String() // parsed line by line by stackLines
		return
	}
	f.vals[key] = oneLine(v.String())
}

// oneLine stops a value from forging extra log lines or sending terminal
// codes: line breaks and tabs become spaces, other control characters
// (including ESC) are dropped. The JSON format escapes these on its own.
func oneLine(s string) string {
	if !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) }) {
		return s
	}
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			return ' '
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0):
			return -1
		}
		return r
	}, s)
}

func (f *fields) get(k string) string { return f.vals[k] }

// take returns a field and marks it used so it is not repeated in the extras.
func (f *fields) take(k string) string {
	v := f.vals[k]
	delete(f.vals, k)
	return v
}

func (h *prettyHandler) Handle(_ context.Context, r slog.Record) error {
	f := &fields{vals: map[string]string{}}
	for _, a := range h.attrs {
		f.add(a.Key, a.Value)
	}
	r.Attrs(func(a slog.Attr) bool {
		f.add(h.prefix+a.Key, a.Value)
		return true
	})

	p := &painter{on: h.color}
	jobMsg := r.Message == "job finished" || r.Message == "job started" || r.Message == "job panicked"
	job := ""
	if !jobMsg {
		job = f.take("job")
	}
	f.take("run_id")
	r.Message = oneLine(r.Message)
	icon, body, detail := describe(p, r, f)

	var b strings.Builder
	b.WriteString(p.dim(r.Time.Format("Jan 02 03:04:05 PM")))
	b.WriteString("  ")
	b.WriteString(p.level(r.Level))
	b.WriteString("  ")
	if icon != "" {
		b.WriteString(icon)
		b.WriteString(" ")
	}
	if job != "" {
		b.WriteString(p.magenta(job + " › "))
	}
	b.WriteString(body)
	if rest := extras(f); rest != "" {
		b.WriteString("  ")
		b.WriteString(p.dim(rest))
	}
	b.WriteString("\n")
	for _, d := range detail {
		if d == "" {
			continue
		}
		b.WriteString(p.dim("                            └ "))
		b.WriteString(d)
		b.WriteString("\n")
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := io.WriteString(h.w, b.String())
	return err
}

// extras prints whatever the layout did not use, as short key=value pairs.
func extras(f *fields) string {
	parts := make([]string, 0, len(f.vals))
	for _, k := range f.keys {
		if v, ok := f.vals[k]; ok && k != "source" {
			parts = append(parts, k+"="+truncate(v, 120))
		}
	}
	return strings.Join(parts, " ")
}

// painter applies ANSI colours only when the output is a terminal.
type painter struct{ on bool }

func (p *painter) wrap(code, s string) string {
	if !p.on || s == "" {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (p *painter) dim(s string) string     { return p.wrap("2", s) }
func (p *painter) bold(s string) string    { return p.wrap("1", s) }
func (p *painter) red(s string) string     { return p.wrap("31", s) }
func (p *painter) green(s string) string   { return p.wrap("32", s) }
func (p *painter) yellow(s string) string  { return p.wrap("33", s) }
func (p *painter) cyan(s string) string    { return p.wrap("36", s) }
func (p *painter) magenta(s string) string { return p.wrap("35", s) }

func (p *painter) level(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return p.wrap("1;37;41", "ERROR")
	case l >= slog.LevelWarn:
		return p.wrap("1;30;43", "WARN ")
	case l >= slog.LevelInfo:
		return p.wrap("32", "INFO ")
	}
	return p.wrap("90", "DEBUG")
}

// humanDuration turns milliseconds into "34ms", "1.2s" or "2m 5s".
func humanDuration(ms string) string {
	var n int64
	if _, err := fmt.Sscan(ms, &n); err != nil {
		return ms
	}
	d := time.Duration(n) * time.Millisecond
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", n)
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	return fmt.Sprintf("%dm %ds", int(d.Minutes()), int(d.Seconds())%60)
}

// startsWithEmoji reports whether an old log line already brings its own icon.
func startsWithEmoji(s string) bool {
	r, _ := utf8.DecodeRuneInString(s)
	return (r >= 0x2190 && r <= 0x2BFF) || (r >= 0x1F000 && r <= 0x1FAFF)
}

// isTerminal reports whether f is an interactive terminal (colours allowed).
func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}
