package handlers

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestMCPActivityDetail(t *testing.T) {
	long := strings.Repeat("📊 Weekly Summary ", 40)
	cases := []struct {
		name, tool, msg string
		want            string
	}{
		{"send collapses whitespace", "send_slack_message_now", "  hey\n\nRohit,\tthe report  ", "hey Rohit, the report"},
		{"queue", "queue_slack_message", "standup in 5", "standup in 5"},
		{"edit", "edit_slack_message", "fixed typo", "fixed typo"},
		{"other tools have no detail", "get_sprints", "ignored", ""},
	}
	for _, c := range cases {
		args, _ := json.Marshal(map[string]string{"message": c.msg})
		if got := mcpActivityDetail(c.tool, args); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}

	args, _ := json.Marshal(map[string]string{"message": long})
	got := mcpActivityDetail("send_slack_message_now", args)
	if !strings.HasSuffix(got, "…") || utf8.RuneCountInString(got) > 281 || !utf8.ValidString(got) {
		t.Errorf("long message not capped cleanly: %d runes, valid=%v", utf8.RuneCountInString(got), utf8.ValidString(got))
	}
	if mcpActivityDetail("send_slack_message_now", json.RawMessage(`not json`)) != "" {
		t.Error("bad args should give empty detail")
	}
}
