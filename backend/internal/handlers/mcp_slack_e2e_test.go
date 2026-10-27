package handlers

// End-to-end regression for the MCP Slack tools: five simulated users at once, each
// running a different task through the real tool handlers, the dev database and REAL
// Slack. It only ever posts to #velocity-app and the DM with Simran Dhindsa (agreed as
// safe demo destinations) and deletes everything it posts.
//
// Opt-in only, it posts to Slack:
//   VELOCITY_E2E_SLACK=1 go test ./internal/handlers -run TestMCPSlackE2E -v -count=1
// Reads DATABASE_URL from backend/.env. No schedulers are started.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

const (
	e2eChannel = "velocity-app"
	e2eDMUser  = "Simran Dhindsa"
)

func loadDotEnv(t *testing.T, path string) {
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("no %s: %v", path, err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		kv := strings.SplitN(line, "=", 2)
		if os.Getenv(kv[0]) == "" {
			_ = os.Setenv(kv[0], strings.Trim(strings.TrimSpace(kv[1]), `"'`))
		}
	}
}

type e2eEnv struct {
	h      *MCPHandler
	userID string
	run    string
}

// call runs one MCP tool through callTool (so the Claude actions log is written too)
// and returns its text result and whether it succeeded.
func (e *e2eEnv) call(t *testing.T, tool string, args map[string]any) (string, bool) {
	t.Helper()
	argJSON, _ := json.Marshal(args)
	params, _ := json.Marshal(map[string]any{"name": tool, "arguments": json.RawMessage(argJSON)})
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	resp := e.h.callTool(req, 1, params, e.userID)
	return mcpResultSummary(resp)
}

// live returns the text of the Velocity-owned message containing tag in a conversation.
func (e *e2eEnv) live(t *testing.T, channelID, tag string) (text, ts string, isVelocity, found bool) {
	t.Helper()
	msgs, err := e.h.slackSvc.GetLiveChannelMessages(context.Background(), e.userID, channelID, "")
	if err != nil {
		t.Fatalf("read %s: %v", channelID, err)
	}
	for _, m := range msgs {
		if strings.Contains(m.Text, tag) {
			return m.Text, m.TS, m.IsVelocity, true
		}
	}
	return "", "", false, false
}

func (e *e2eEnv) dmChannel(t *testing.T) string {
	t.Helper()
	slackUser := e.h.resolveSlackUser(context.Background(), e.userID, e2eDMUser)
	if slackUser == "" {
		t.Fatalf("Slack user %q not found", e2eDMUser)
	}
	st, err := e.h.slackSvc.GetStatus(context.Background(), e.userID)
	if err != nil || !st.Connected {
		t.Fatalf("slack not connected: %v", err)
	}
	// Same lookup the tools use
	id, err := slacksvc.NewClient(st.BotToken).OpenDirectMessageChannel(context.Background(), slackUser)
	if err != nil {
		t.Fatalf("open DM: %v", err)
	}
	return id
}

func (e *e2eEnv) queueRow(t *testing.T, tag string) *database.PendingSlackMessage {
	t.Helper()
	rows, err := e.h.msgRepo.ListByUser(context.Background(), e.userID)
	if err != nil {
		t.Fatal(err)
	}
	for i := range rows {
		if strings.Contains(rows[i].Message, tag) {
			return &rows[i]
		}
	}
	return nil
}

func TestMCPSlackE2E(t *testing.T) {
	if os.Getenv("VELOCITY_E2E_SLACK") != "1" {
		t.Skip("posts to real Slack; set VELOCITY_E2E_SLACK=1 to run")
	}
	loadDotEnv(t, "../../.env")
	if err := database.Connect(); err != nil {
		t.Fatalf("db: %v", err)
	}
	var userID string
	if err := database.GetPool().QueryRow(context.Background(),
		`SELECT u.id FROM users u JOIN slack_integrations si ON si.user_id = u.id WHERE si.connected LIMIT 1`).Scan(&userID); err != nil {
		t.Fatalf("no Slack-connected user in this database: %v", err)
	}
	env := &e2eEnv{h: NewMCPHandler(), userID: userID, run: time.Now().Format("150405")}
	chID, _ := env.h.resolveChannel(context.Background(), userID, e2eChannel)
	if chID == "" {
		t.Fatalf("#%s not found", e2eChannel)
	}
	dmID := env.dmChannel(t)
	t.Logf("run %s: #%s=%s, DM=%s", env.run, e2eChannel, chID, dmID)

	// Safety net: delete anything this run posted that a failing step left behind
	t.Cleanup(func() {
		ctx := context.Background()
		for _, ch := range []string{chID, dmID} {
			msgs, _ := env.h.slackSvc.GetLiveChannelMessages(ctx, userID, ch, "")
			for _, m := range msgs {
				if m.IsVelocity && strings.Contains(m.Text, "[UAT "+env.run) {
					_ = env.h.updateSvc.DeleteSlackMessage(ctx, userID, ch, m.TS)
				}
			}
		}
	})

	users := []struct {
		name string
		fn   func(t *testing.T, tag string)
	}{
		{"user1_dm_send_edit_delete", func(t *testing.T, tag string) {
			out, ok := env.call(t, "send_slack_message_now", map[string]any{"dm_user": e2eDMUser, "message": tag + " hello from the DM test"})
			if !ok {
				t.Fatalf("send DM: %s", out)
			}
			text, ts, isV, found := env.live(t, dmID, tag)
			if !found || !isV {
				t.Fatalf("DM in Slack: found=%v isVelocity=%v (DMs must be logged so they can be edited/deleted)", found, isV)
			}
			if row := env.queueRow(t, tag); row == nil || row.SlackTs != ts || row.ChannelID != dmID {
				t.Errorf("Claude Queue row for DM: %+v, want ts=%s channel=%s", row, ts, dmID)
			}
			out, ok = env.call(t, "edit_slack_message", map[string]any{"dm_user": e2eDMUser, "contains": tag, "message": tag + " edited in the DM"})
			if !ok {
				t.Fatalf("edit DM: %s", out)
			}
			if text, _, _, _ = env.live(t, dmID, tag); !strings.Contains(text, "edited in the DM") {
				t.Errorf("DM text after edit: %q", text)
			}
			if row := env.queueRow(t, tag); row == nil || !strings.Contains(row.Message, "edited in the DM") {
				t.Errorf("Claude Queue text not synced after edit: %+v", row)
			}
			out, ok = env.call(t, "delete_slack_message", map[string]any{"dm_user": e2eDMUser, "contains": tag})
			if !ok {
				t.Fatalf("delete DM: %s", out)
			}
			if _, _, _, found = env.live(t, dmID, tag); found {
				t.Error("DM still in Slack after delete")
			}
		}},
		{"user2_channel_edit_and_delete_by_link", func(t *testing.T, tag string) {
			if out, ok := env.call(t, "send_slack_message_now", map[string]any{"channel": e2eChannel, "message": tag + " channel post"}); !ok {
				t.Fatalf("send: %s", out)
			}
			_, ts, isV, found := env.live(t, chID, tag)
			if !found || !isV {
				t.Fatalf("channel post: found=%v isVelocity=%v", found, isV)
			}
			link := fmt.Sprintf("https://apyhub.slack.com/archives/%s/p%s", chID, strings.ReplaceAll(ts, ".", ""))
			if out, ok := env.call(t, "edit_slack_message", map[string]any{"link": link, "message": tag + " edited by link"}); !ok {
				t.Fatalf("edit by link: %s", out)
			}
			if text, _, _, _ := env.live(t, chID, tag); !strings.Contains(text, "edited by link") {
				t.Errorf("after edit by link: %q", text)
			}
			if out, ok := env.call(t, "delete_slack_message", map[string]any{"link": link}); !ok {
				t.Fatalf("delete by link: %s", out)
			}
			if _, _, _, found := env.live(t, chID, tag); found {
				t.Error("still in channel after delete by link")
			}
		}},
		{"user3_queue_dm_then_send_and_delete_from_queue", func(t *testing.T, tag string) {
			if out, ok := env.call(t, "queue_slack_message", map[string]any{"dm_user": e2eDMUser, "message": tag + " queued DM", "send_time": time.Now().Add(2 * time.Hour).Format("15:04")}); !ok {
				t.Fatalf("queue: %s", out)
			}
			row := env.queueRow(t, tag)
			if row == nil || row.Status != "pending" {
				t.Fatalf("queued row: %+v", row)
			}
			// The scheduler and "Send now" both use this
			ts, ch, err := sendQueuedMessage(context.Background(), env.h.updateSvc, env.h.msgRepo, *row)
			if err != nil {
				t.Fatalf("send queued: %v", err)
			}
			row = env.queueRow(t, tag)
			if row.Status != "sent" || !strings.Contains(row.SlackTs, ".") || row.SlackTs != ts || row.ChannelID != dmID || ch != dmID {
				t.Fatalf("queued DM after send: status=%s slack_ts=%q channel_id=%q (ts must be a message ts, channel the DM)", row.Status, row.SlackTs, row.ChannelID)
			}
			// Claude Queue "Delete from Slack" calls this with the row's channel_id + slack_ts
			if err := env.h.updateSvc.DeleteSlackMessage(context.Background(), env.userID, row.ChannelID, row.SlackTs); err != nil {
				t.Fatalf("delete from Slack (queue card): %v", err)
			}
			if _, _, _, found := env.live(t, dmID, tag); found {
				t.Error("queued DM still in Slack after Delete from Slack")
			}
		}},
		{"user4_long_message_split_parts", func(t *testing.T, tag string) {
			var b strings.Builder
			b.WriteString(tag + " long report\n")
			for i := 0; b.Len() < 9000; i++ {
				fmt.Fprintf(&b, "%s line %03d: regression text so the message has to be split into parts\n", tag, i)
			}
			if out, ok := env.call(t, "send_slack_message_now", map[string]any{"channel": e2eChannel, "message": b.String()}); !ok {
				t.Fatalf("send long: %s", out)
			}
			msgs, err := env.h.slackSvc.GetLiveChannelMessages(context.Background(), env.userID, chID, "")
			if err != nil {
				t.Fatal(err)
			}
			var parts []string
			for _, m := range msgs {
				if strings.Contains(m.Text, tag) {
					if !m.IsVelocity {
						t.Errorf("split part %s is not recorded as Velocity's, so it can't be deleted", m.TS)
					}
					parts = append(parts, m.TS)
				}
			}
			if len(parts) < 2 {
				t.Fatalf("expected a split message, got %d part(s)", len(parts))
			}
			for _, ts := range parts {
				if err := env.h.updateSvc.DeleteSlackMessage(context.Background(), env.userID, chID, ts); err != nil {
					t.Errorf("delete part %s: %v", ts, err)
				}
			}
		}},
		{"user5_wrong_place_hint_reads_and_activity_log", func(t *testing.T, tag string) {
			out, ok := env.call(t, "delete_slack_message", map[string]any{"dm_user": e2eDMUser, "contains": "no such message " + tag})
			if ok {
				t.Fatalf("delete of a missing message succeeded: %s", out)
			}
			if !strings.Contains(out, "Slack link") || !strings.Contains(out, "Do not tell the user it was never sent") {
				t.Errorf("not-found error lacks the link guidance: %s", out)
			}
			for _, c := range []struct {
				tool string
				args map[string]any
			}{
				{"whoami", map[string]any{}},
				{"get_sprints", map[string]any{}},
				{"read_slack_messages", map[string]any{"channel": e2eChannel, "limit": 3}},
				{"read_slack_messages", map[string]any{"my_dm": true, "limit": 3}},
				{"search_youtrack_tickets", map[string]any{"query": "login", "limit": 3}},
				{"get_youtrack_ticket", map[string]any{"issue_id": "ARD-3113"}},
				{"get_developer_configs", map[string]any{}},
				{"get_daytrack", map[string]any{}},
				{"search_knowledge_base", map[string]any{"query": "leave policy"}},
				{"get_slack_mentions", map[string]any{}},
				{"get_slack_reply_config", map[string]any{}},
				{"generate_deployment_report", map[string]any{"list_columns": true}},
				{"generate_deployment_report", map[string]any{"columns": []string{"Stage"}}},
			} {
				out, ok := env.call(t, c.tool, c.args)
				if !ok {
					t.Errorf("%s failed: %.300s", c.tool, out)
				} else if strings.TrimSpace(out) == "" {
					t.Errorf("%s returned nothing", c.tool)
				}
			}
			// get_developer_load needs real logins: take one from the developer configs
			if out, ok := env.call(t, "get_developer_configs", map[string]any{}); ok {
				var cfg any
				_ = json.Unmarshal([]byte(out), &cfg)
				login := firstStringField(cfg, "developer_login")
				if login == "" {
					t.Logf("no developer login found in get_developer_configs, skipping get_developer_load")
				} else if out, ok := env.call(t, "get_developer_load", map[string]any{"logins": []string{login}}); !ok {
					t.Errorf("get_developer_load(%s) failed: %.300s", login, out)
				}
			}
			// The send preview must be the whole message, line breaks kept
			msg := tag + " activity preview line 1\nline 2\n• bullet"
			if out, ok := env.call(t, "send_slack_message_now", map[string]any{"channel": e2eChannel, "message": msg}); !ok {
				t.Fatalf("send: %s", out)
			}
			var detail string
			_ = database.GetPool().QueryRow(context.Background(),
				`SELECT detail FROM mcp_activity_log WHERE user_id = $1 AND detail LIKE '%' || $2 || '%' ORDER BY created_at DESC LIMIT 1`, env.userID, tag).Scan(&detail)
			if detail != msg {
				t.Errorf("Claude actions detail = %q, want the full message", detail)
			}
			if out, ok := env.call(t, "delete_slack_message", map[string]any{"channel": e2eChannel, "contains": tag}); !ok {
				t.Errorf("cleanup delete: %s", out)
			}
		}},
	}

	var wg sync.WaitGroup
	results := make([]string, len(users))
	for i, u := range users {
		wg.Add(1)
		go func(i int, name string, fn func(*testing.T, string)) {
			defer wg.Done()
			tag := fmt.Sprintf("[UAT %s u%d]", env.run, i+1)
			ok := t.Run(name, func(t *testing.T) { fn(t, tag) })
			results[i] = fmt.Sprintf("%-50s %v", name, map[bool]string{true: "PASS", false: "FAIL"}[ok])
		}(i, u.name, u.fn)
	}
	wg.Wait()
	for _, r := range results {
		t.Log(r)
	}
}

// firstStringField finds the first non-empty string value under any of keys, anywhere in v.
func firstStringField(v any, keys ...string) string {
	switch x := v.(type) {
	case map[string]any:
		for _, k := range keys {
			if s, ok := x[k].(string); ok && s != "" {
				return s
			}
		}
		for _, child := range x {
			if s := firstStringField(child, keys...); s != "" {
				return s
			}
		}
	case []any:
		for _, child := range x {
			if s := firstStringField(child, keys...); s != "" {
				return s
			}
		}
	}
	return ""
}
