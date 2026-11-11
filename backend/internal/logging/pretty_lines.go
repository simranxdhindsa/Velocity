package logging

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// describe picks the icon, sentence and detail lines for one record.
func describe(p *painter, r slog.Record, f *fields) (icon, body string, detail []string) {
	switch r.Message {
	case "request":
		return describeRequest(p, f)
	case "mcp tool call":
		return describeMCP(p, f)
	case "job started":
		return "▶️ ", "Job " + p.bold(f.take("job")) + " started", nil
	case "job finished":
		job := p.bold(f.take("job"))
		d := humanDuration(f.take("duration_ms"))
		if f.take("slow") == "true" {
			return "🐢", "Job " + job + " was slow, took " + p.yellow(d), nil
		}
		return "⏱️ ", "Job " + job + " done in " + d, nil
	case "job panicked":
		f.take("duration_ms")
		return "💥", p.red("Job " + p.bold(f.take("job")) + " crashed: " + f.take("panic")), stackLines(f.take("stack"))
	case "goroutine panicked":
		return "💥", p.red("Background task " + p.bold(f.take("name")) + " crashed: " + f.take("panic")), stackLines(f.take("stack"))
	case "panic recovered":
		where := f.take("method") + " " + f.take("path")
		f.take("user_id")
		body := p.red("Crash while handling " + p.bold(where) + ": " + f.take("panic"))
		if id := f.take("request_id"); id != "" {
			body += "  ·  " + p.dim("🔖 "+id)
		}
		return "💥", body, stackLines(f.take("stack"))
	case "outbound request", "outbound request failed", "outbound request canceled":
		return describeOutbound(p, r.Message, f)
	case "db query failed":
		f.take("duration_ms")
		return "🗄️ ", p.yellow("Database query failed: " + f.take("error")), []string{"SQL: " + f.take("sql")}
	case "db query canceled":
		f.take("duration_ms")
		return "🗄️ ", "Database query canceled", []string{"SQL: " + f.take("sql")}
	case "slow db query":
		return "🐢", "Slow database query, took " + p.yellow(humanDuration(f.take("duration_ms"))), []string{"SQL: " + f.take("sql")}
	}
	if f.get("source") == "legacy" {
		f.take("source")
		if startsWithEmoji(r.Message) {
			return "", colourByLevel(p, r.Level, r.Message), nil
		}
		return levelIcon(r.Level), colourByLevel(p, r.Level, r.Message), nil
	}
	return levelIcon(r.Level), colourByLevel(p, r.Level, r.Message), nil
}

func describeRequest(p *painter, f *fields) (string, string, []string) {
	status, _ := strconv.Atoi(f.take("status"))
	method := f.take("method")
	path := f.take("path")
	if route := f.take("route"); route != "" {
		path = route
	}
	icon := "✅"
	statusText := fmt.Sprintf("%d %s", status, http.StatusText(status))
	switch {
	case f.take("panic") == "true":
		icon, statusText = "💥", p.red(statusText)
	case status >= 500:
		icon, statusText = "🔥", p.red(statusText)
	case status == 401 || status == 403:
		icon, statusText = "🔒", p.yellow(statusText)
	case status >= 400:
		icon, statusText = "⚠️ ", p.yellow(statusText)
	case status >= 300:
		icon, statusText = "↪️ ", p.cyan(statusText)
	default:
		statusText = p.green(statusText)
	}
	d := humanDuration(f.take("duration_ms"))
	if f.take("slow") == "true" {
		icon, d = "🐢", p.yellow(d+" (slow)")
	}
	parts := []string{p.cyan(p.bold(method)) + " " + path + " → " + statusText, d}
	if tool := f.take("mcp_tool"); tool != "" {
		parts = append(parts, "🤖 "+tool)
	} else if m := f.take("mcp_method"); m != "" {
		parts = append(parts, "🤖 "+m)
	}
	f.take("mcp_method")
	if n := f.take("outbound_calls"); n != "" {
		parts = append(parts, "🌐 "+plural(n, "outside call")+" "+humanDuration(f.take("outbound_ms")))
	}
	if n := f.take("db_queries"); n != "" {
		parts = append(parts, "🗄️ "+plural(n, "query", "queries")+" "+humanDuration(f.take("db_ms")))
	}
	if who := userLabel(f); who != "" {
		parts = append(parts, "👤 "+who)
	}
	if id := f.take("request_id"); id != "" {
		parts = append(parts, p.dim("🔖 "+id))
	}
	f.take("bytes")
	f.take("ip")
	var detail []string
	if e := f.take("error"); e != "" {
		detail = append(detail, p.yellow(readableError(e)))
	}
	return icon, strings.Join(parts, "  ·  "), detail
}

func describeMCP(p *painter, f *fields) (string, string, []string) {
	tool := f.take("tool")
	label := f.take("label")
	ok := f.take("ok") == "true"
	mark := p.green("✓ worked")
	if !ok {
		mark = p.red("✗ failed")
	}
	parts := []string{"Connected tool " + p.bold(tool), mark, humanDuration(f.take("duration_ms"))}
	if who := userLabel(f); who != "" {
		parts = append(parts, "👤 "+who)
	}
	if id := f.take("request_id"); id != "" {
		parts = append(parts, p.dim("🔖 "+id))
	}
	var detail []string
	if s := f.take("summary"); s != "" && s != label {
		detail = append(detail, s)
	} else if label != "" {
		detail = append(detail, label)
	}
	if k := f.take("arg_keys"); k != "" && k != "[]" {
		detail = append(detail, p.dim("fields sent: "+strings.ReplaceAll(strings.Trim(k, "[]"), " ", ", ")))
	}
	return "🤖", strings.Join(parts, "  ·  "), detail
}

func describeOutbound(p *painter, msg string, f *fields) (string, string, []string) {
	svc := serviceName(f.take("service"))
	call := f.take("method") + " " + f.take("path")
	d := humanDuration(f.take("duration_ms"))
	if msg == "outbound request failed" {
		return "🔌", p.red("Could not reach "+p.bold(svc)) + "  ·  " + call + "  ·  " + d, []string{p.red(f.take("error"))}
	}
	if msg == "outbound request canceled" {
		f.take("error")
		return "🌐", svc + " call canceled  ·  " + call, nil
	}
	status, _ := strconv.Atoi(f.take("status"))
	st := fmt.Sprintf("%d %s", status, http.StatusText(status))
	switch {
	case status >= 400:
		st = p.yellow(st)
	default:
		st = p.green(st)
	}
	if f.take("slow") == "true" {
		d = p.yellow(d + " (slow)")
	}
	return "🌐", p.bold(svc) + "  ·  " + call + " → " + st + "  ·  " + d, nil
}

// serviceName gives an outside host a name people recognise.
func serviceName(host string) string {
	h := strings.ToLower(host)
	known := []struct{ part, name string }{
		{"youtrack", "YouTrack"}, {"slack.com", "Slack"}, {"asana.com", "Asana"},
		{"generativelanguage.googleapis", "Gemini"}, {"oauth2.googleapis", "Google sign-in"},
		{"googleapis.com", "Google"}, {"groq.com", "Groq"}, {"openai.com", "OpenAI"},
		{"anthropic.com", "Anthropic"}, {"amazonaws.com", "AWS S3"},
	}
	for _, k := range known {
		if strings.Contains(h, k.part) {
			return k.name
		}
	}
	return host
}

func userLabel(f *fields) string {
	name := f.take("user_name")
	id := f.take("user_id")
	if name != "" {
		return name
	}
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// readableError pulls the message out of a JSON error body.
func readableError(s string) string {
	var m map[string]any
	if json.Unmarshal([]byte(s), &m) == nil {
		for _, k := range []string{"message", "error", "detail"} {
			if v, ok := m[k].(string); ok && v != "" {
				return v
			}
		}
	}
	return truncate(s, 200)
}

// stackLines keeps only this project's frames so a crash is quick to read.
func stackLines(stack string) []string {
	var out []string
	lines := strings.Split(stack, "\n")
	for i := 0; i+1 < len(lines); i++ {
		fn := strings.TrimSpace(lines[i])
		loc := strings.TrimSpace(lines[i+1])
		ours := strings.Contains(fn, "project-management/") || strings.HasPrefix(fn, "main.")
		// Skip the logging package's own frames (by file, since Go may inline
		// Middleware into its caller and rename the function).
		inLogging := strings.Contains(loc, "/internal/logging/") && !strings.Contains(loc, "_test.go")
		if ours && !inLogging && strings.HasPrefix(lines[i+1], "\t") {
			if j := strings.LastIndex(loc, " +0x"); j > 0 {
				loc = loc[:j]
			}
			if j := strings.Index(loc, "/internal/"); j >= 0 {
				loc = loc[j+1:]
			} else if j := strings.LastIndex(loc, "/"); j >= 0 {
				loc = loc[j+1:]
			}
			name := fn[strings.LastIndex(fn, "/")+1:]
			if j := strings.Index(name, "("); j > 0 {
				name = name[:j]
			}
			out = append(out, "at "+name+"  "+loc)
			i++
		}
		if len(out) == 6 {
			break
		}
	}
	return out
}

func levelIcon(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "❌"
	case l >= slog.LevelWarn:
		return "⚠️ "
	case l >= slog.LevelInfo:
		return "ℹ️ "
	}
	return "🔍"
}

func colourByLevel(p *painter, l slog.Level, s string) string {
	switch {
	case l >= slog.LevelError:
		return p.red(s)
	case l >= slog.LevelWarn:
		return p.yellow(s)
	}
	return s
}

func plural(n, one string, many ...string) string {
	if n == "1" {
		return n + " " + one
	}
	if len(many) > 0 {
		return n + " " + many[0]
	}
	return n + " " + one + "s"
}
