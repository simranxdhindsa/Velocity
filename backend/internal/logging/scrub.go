package logging

import (
	"log/slog"
	"regexp"
	"strings"
)

// Secrets can reach a log line by accident: a Go network error prints the full
// URL (Gemini puts its API key in ?key=), a 500 body can echo an upstream
// error, and old log.Printf lines print whatever they were given. Every
// message and string attribute is scrubbed here before it is written to stdout
// or saved to app_logs.
var scrubRules = []struct {
	re   *regexp.Regexp
	repl string
}{
	// Sensitive query parameters, in URLs inside error text.
	{regexp.MustCompile(`(?i)([?&](?:key|api_key|apikey|token|access_token|refresh_token|id_token|client_secret|secret|password|pass|signature|sig|code|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s"'<>]+`), "${1}[redacted]"},
	// Credentials embedded in a connection URL (postgres://user:pass@host).
	{regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://[^:/\s@]+:)[^@\s/]+@`), "${1}[redacted]@"},
	{regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}`), "${1}[redacted]"},
	{regexp.MustCompile(`hooks\.slack\.com/services/[^\s"'<>]+`), "hooks.slack.com/services/[redacted]"},
	{regexp.MustCompile(`\bxox[a-z]-[A-Za-z0-9-]{8,}`), "[redacted]"},
	{regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{30,}`), "[redacted]"},
	{regexp.MustCompile(`\b(?:sk|gsk|ghp|gho|glpat)[-_][A-Za-z0-9_-]{16,}`), "[redacted]"},
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), "[redacted]"},
}

// scrubHints are cheap substring checks so ordinary lines skip the regexes.
var scrubHints = []string{"=", "://", "earer", "hooks.slack", "xox", "AIza", "sk-", "sk_", "ghp_", "gho_", "glpat", "eyJ"}

// Scrub removes credentials from s. Exported so other packages can clean text
// they put in an API response or a stored record.
func Scrub(s string) string {
	hit := false
	for _, h := range scrubHints {
		if strings.Contains(s, h) {
			hit = true
			break
		}
	}
	if !hit {
		return s
	}
	for _, r := range scrubRules {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return s
}

// scrubAttr scrubs string and error values, recursing into groups.
func scrubAttr(a slog.Attr) slog.Attr {
	v := a.Value.Resolve()
	switch v.Kind() {
	case slog.KindString:
		if s := v.String(); Scrub(s) != s {
			return slog.String(a.Key, Scrub(s))
		}
	case slog.KindGroup:
		g := v.Group()
		out := make([]slog.Attr, len(g))
		for i, ga := range g {
			out[i] = scrubAttr(ga)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(out...)}
	case slog.KindAny:
		if err, ok := v.Any().(error); ok && err != nil {
			return slog.String(a.Key, Scrub(err.Error()))
		}
	}
	return slog.Attr{Key: a.Key, Value: v}
}

// scrubRecord returns a copy of r with its message and attributes scrubbed.
func scrubRecord(r slog.Record) slog.Record {
	n := slog.NewRecord(r.Time, r.Level, Scrub(r.Message), r.PC)
	r.Attrs(func(a slog.Attr) bool {
		n.AddAttrs(scrubAttr(a))
		return true
	})
	return n
}

func scrubAttrs(as []slog.Attr) []slog.Attr {
	out := make([]slog.Attr, len(as))
	for i, a := range as {
		out[i] = scrubAttr(a)
	}
	return out
}
