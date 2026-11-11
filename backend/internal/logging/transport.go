package logging

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
)

var installOnce sync.Once

// InstallHTTPTransport wraps http.DefaultTransport once so every outbound call
// made with the default transport is timed and logged.
func InstallHTTPTransport() {
	installOnce.Do(func() {
		http.DefaultTransport = &loggingTransport{base: http.DefaultTransport}
	})
}

type loggingTransport struct{ base http.RoundTripper }

const slowOutbound = 5 * time.Second

func (t *loggingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	resp, err := t.base.RoundTrip(req)
	d := time.Since(start)
	ctx := req.Context()
	addOutbound(ctx, d)
	attrs := []any{
		"service", req.URL.Host, "method", req.Method,
		"path", redactPath(req.URL.Host, req.URL.Path), "duration_ms", d.Milliseconds(),
	}
	switch {
	case err != nil:
		attrs = append(attrs, "error", cleanErr(err))
		if errors.Is(err, context.Canceled) {
			slog.DebugContext(ctx, "outbound request canceled", attrs...)
		} else {
			slog.ErrorContext(ctx, "outbound request failed", attrs...)
		}
	case resp.StatusCode >= 400:
		slog.WarnContext(ctx, "outbound request", append(attrs, "status", resp.StatusCode)...)
	case d > slowOutbound:
		slog.WarnContext(ctx, "outbound request", append(attrs, "status", resp.StatusCode, "slow", true)...)
	default:
		slog.DebugContext(ctx, "outbound request", append(attrs, "status", resp.StatusCode)...)
	}
	return resp, err
}

// cleanErr drops the URL that net/http embeds in its errors, since it can
// carry a query string.
func cleanErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return ue.Err.Error()
	}
	return err.Error()
}

func redactPath(host, path string) string {
	if host == "hooks.slack.com" {
		return "/services/[redacted]"
	}
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if strings.HasPrefix(p, "xox") || (len(p) >= 20 && hasLetterAndDigit(p)) {
			parts[i] = "[redacted]"
		}
	}
	return strings.Join(parts, "/")
}

func hasLetterAndDigit(s string) bool {
	var l, d bool
	for _, r := range s {
		if unicode.IsLetter(r) {
			l = true
		} else if unicode.IsDigit(r) {
			d = true
		}
	}
	return l && d
}
