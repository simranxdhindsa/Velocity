package logging

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"github.com/gorilla/mux"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)

const (
	maxErrBody = 300
	maxPathLen = 200
)

func newRequestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// responseRecorder tracks status, size and the start of an error body while
// passing everything through to the real writer.
type responseRecorder struct {
	http.ResponseWriter
	status  int
	bytes   int
	wrote   bool
	errBody []byte
}

func (rw *responseRecorder) WriteHeader(code int) {
	if rw.wrote {
		return
	}
	rw.wrote = true
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseRecorder) Write(p []byte) (int, error) {
	if !rw.wrote {
		rw.wrote = true
		rw.status = http.StatusOK
	}
	if rw.status >= 400 && len(rw.errBody) < maxErrBody &&
		!isEventStream(rw.Header().Get("Content-Type")) {
		n := maxErrBody - len(rw.errBody)
		if n > len(p) {
			n = len(p)
		}
		rw.errBody = append(rw.errBody, p[:n]...)
	}
	n, err := rw.ResponseWriter.Write(p)
	rw.bytes += n
	return n, err
}

func (rw *responseRecorder) Flush() {
	if !rw.wrote {
		rw.wrote = true
		rw.status = http.StatusOK
	}
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (rw *responseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := rw.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("hijack not supported")
}

func (rw *responseRecorder) Unwrap() http.ResponseWriter { return rw.ResponseWriter }

func isEventStream(ct string) bool { return strings.HasPrefix(ct, "text/event-stream") }

// Middleware is the outermost handler: request id, panic recovery and the
// access line. It never logs headers, request bodies or query strings.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := r.Header.Get("X-Request-ID")
		if !requestIDPattern.MatchString(id) {
			id = newRequestID()
		}
		in := &info{id: id}
		ctx := context.WithValue(r.Context(), infoKey, in)
		r = r.WithContext(ctx)
		w.Header().Set("X-Request-ID", id)
		rw := &responseRecorder{ResponseWriter: w}
		panicked := false

		func() {
			defer func() {
				v := recover()
				if v == nil {
					return
				}
				if v == http.ErrAbortHandler {
					panic(v)
				}
				panicked = true
				slog.ErrorContext(ctx, "panic recovered", "panic", fmt.Sprint(v),
					"stack", string(debug.Stack()), "method", r.Method, "path", r.URL.Path)
				if !rw.wrote {
					rw.Header().Set("Content-Type", "application/json")
					rw.WriteHeader(http.StatusInternalServerError)
					_, _ = rw.Write([]byte(`{"success":false,"message":"Internal server error","request_id":"` + id + `"}`))
				}
			}()
			next.ServeHTTP(rw, r)
		}()

		logAccess(ctx, r, rw, in, time.Since(start), panicked)
	})
}

func logAccess(ctx context.Context, r *http.Request, rw *responseRecorder, in *info, d time.Duration, panicked bool) {
	status := rw.status
	if panicked && !rw.wrote {
		status = http.StatusInternalServerError
	} else if !rw.wrote {
		status = http.StatusOK
	}
	s := in.snapshot()
	path := truncate(r.URL.Path, maxPathLen)
	attrs := []any{
		"method", r.Method, "path", path, "route", s.route, "status", status,
		"duration_ms", d.Milliseconds(), "bytes", rw.bytes, "ip", clientIP(r),
	}
	if s.userID != "" {
		attrs = append(attrs, "user_id", s.userID)
	}
	for _, k := range s.fieldKeys {
		attrs = append(attrs, k, s.fields[k])
	}
	if s.outCount > 0 {
		attrs = append(attrs, "outbound_calls", s.outCount, "outbound_ms", s.outDur.Milliseconds())
	}
	if s.dbCount > 0 {
		attrs = append(attrs, "db_queries", s.dbCount, "db_ms", s.dbDur.Milliseconds())
	}
	if status >= 400 && len(rw.errBody) > 0 {
		attrs = append(attrs, "error", collapseSpace(string(rw.errBody)))
	}
	if panicked {
		attrs = append(attrs, "panic", true)
	}

	level := slog.LevelInfo
	sse := isEventStream(rw.Header().Get("Content-Type"))
	switch {
	case status >= 500:
		level = slog.LevelError
	case status >= 400 && s.userID != "":
		level = slog.LevelWarn
	case status >= 400:
		// Unauthenticated 4xx (scans, bad tokens) stays on stdout only so
		// outside traffic cannot grow the stored log table.
		level = slog.LevelInfo
	default:
		if d.Milliseconds() > slowRequestMS.Load() && !sse {
			level = slog.LevelWarn
			attrs = append(attrs, "slow", true)
		}
		if quietPath(r.Method, path) {
			level = slog.LevelDebug
		}
	}
	slog.Log(ctx, level, "request", attrs...)
}

func quietPath(method, path string) bool {
	if path == "/api/health" || method == http.MethodOptions {
		return true
	}
	for _, p := range []string{"/api", "/oauth", "/.well-known"} {
		if strings.HasPrefix(path, p) {
			return false
		}
	}
	return true
}

func clientIP(r *http.Request) string {
	raw := ""
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		raw = strings.TrimSpace(first)
	}
	if raw == "" {
		raw = strings.TrimSpace(r.Header.Get("X-Real-IP"))
	}
	if raw == "" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		raw = host
	}
	if net.ParseIP(raw) == nil {
		return truncate(raw, 45)
	}
	return raw
}

// RouteTagger is a gorilla/mux middleware (register with Use on the root
// router) that records the matched route template for the access line.
func RouteTagger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if route := mux.CurrentRoute(r); route != nil {
			if tmpl, err := route.GetPathTemplate(); err == nil {
				SetRoute(r.Context(), tmpl)
			}
		}
		next.ServeHTTP(w, r)
	})
}
