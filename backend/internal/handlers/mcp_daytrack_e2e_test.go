package handlers

// End-to-end regression for the Day Track MCP tools: real JSON-RPC over HTTP with a real
// Bearer token, the dev database and real Slack. Everything runs as two throwaway users, so no
// real person's Day Track is touched, and the only Slack destination is #velocity-app. The
// users, their rows and every Slack message are removed afterwards.
//
// Opt-in only, it writes to the dev database and posts to Slack:
//   VELOCITY_E2E_DAYTRACK=1 go test -race ./internal/handlers -run TestMCPDayTrackE2E -v -count=1
// No schedulers are started.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

type dtClient struct {
	t      *testing.T
	url    string
	token  string
	userID string
}

// rpc posts one JSON-RPC call the way a connected client does.
func (c *dtClient) rpc(method string, params any) map[string]any {
	c.t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, _ := http.NewRequest("POST", c.url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatalf("%s: %v", method, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		c.t.Fatalf("%s: bad response: %v", method, err)
	}
	return out
}

// tool calls a tool and returns its sentence, its JSON details and whether it succeeded.
func (c *dtClient) tool(name string, args map[string]any) (string, map[string]any, bool) {
	c.t.Helper()
	out := c.rpc("tools/call", map[string]any{"name": name, "arguments": args})
	result, ok := out["result"].(map[string]any)
	if !ok {
		c.t.Fatalf("%s: no result: %v", name, out)
	}
	blocks, _ := result["content"].([]any)
	var texts []string
	for _, b := range blocks {
		m, _ := b.(map[string]any)
		s, _ := m["text"].(string)
		texts = append(texts, s)
	}
	details := map[string]any{}
	if len(texts) > 0 {
		_ = json.Unmarshal([]byte(texts[len(texts)-1]), &details)
	}
	isError, _ := result["isError"].(bool)
	sentence := ""
	if len(texts) > 0 {
		sentence = texts[0]
	}
	return sentence, details, !isError
}

func (c *dtClient) mustTool(name string, args map[string]any) (string, map[string]any) {
	c.t.Helper()
	sentence, details, ok := c.tool(name, args)
	if !ok {
		c.t.Fatalf("%s failed: %s", name, sentence)
	}
	return sentence, details
}

func (c *dtClient) entries(date string) []database.DayTrackEntry {
	c.t.Helper()
	rows, err := mcpDayTrackRepo.GetEntries(context.Background(), c.userID, date)
	if err != nil {
		c.t.Fatal(err)
	}
	return rows
}

func (c *dtClient) planned(date string) []database.DayTrackPlanned {
	c.t.Helper()
	rows, err := mcpDayTrackRepo.GetPlanned(context.Background(), c.userID, date)
	if err != nil {
		c.t.Fatal(err)
	}
	return rows
}

func dtItems(details map[string]any, key string) []map[string]any {
	raw, _ := details[key].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		if m, ok := r.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func dtField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// dtNewUser creates a throwaway user with an MCP token and removes it after the test.
func dtNewUser(t *testing.T, srv *httptest.Server, tag string) *dtClient {
	t.Helper()
	ctx := context.Background()
	pool := database.GetPool()
	id := fmt.Sprintf("e2e-daytrack-%s-%d", tag, time.Now().UnixNano())
	email := id + "@velocity.test"
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, name, picture, role) VALUES ($1, $2, $3, '', 'member')`, id, email, "E2E "+tag); err != nil {
		t.Fatalf("create user: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		for _, q := range []string{
			`DELETE FROM daytrack_entries WHERE user_id=$1`, `DELETE FROM daytrack_planned WHERE user_id=$1`,
			`DELETE FROM daytrack_categories WHERE user_id=$1`, `DELETE FROM daytrack_daily_posts WHERE user_id=$1`,
			`DELETE FROM daytrack_slack_config WHERE user_id=$1`, `DELETE FROM slack_integrations WHERE user_id=$1`,
			`DELETE FROM mcp_activity_log WHERE user_id=$1`, `DELETE FROM user_mcp_tokens WHERE user_id=$1`,
			`DELETE FROM users WHERE id=$1`,
		} {
			if _, err := pool.Exec(ctx, q, id); err != nil {
				t.Logf("cleanup %q: %v", q, err)
			}
		}
	})
	token, err := database.NewMCPTokenRepository().GenerateToken(ctx, id, "e2e-daytrack", "E2E Day Track")
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	return &dtClient{t: t, url: srv.URL, token: token, userID: id}
}

func TestMCPDayTrackE2E(t *testing.T) {
	if os.Getenv("VELOCITY_E2E_DAYTRACK") != "1" {
		t.Skip("writes to the dev database and posts to Slack; set VELOCITY_E2E_DAYTRACK=1 to run")
	}
	loadDotEnv(t, "../../.env")
	if !strings.Contains(os.Getenv("DATABASE_URL"), "dev_velocity") {
		t.Skip("refusing to run anywhere but the dev database")
	}
	if err := database.Connect(); err != nil {
		t.Fatalf("db: %v", err)
	}
	h := NewMCPHandler()
	srv := httptest.NewServer(http.HandlerFunc(h.Handle))
	defer srv.Close()

	me := dtNewUser(t, srv, "owner")
	other := dtNewUser(t, srv, "other")
	today := mcpDayTrackClockFor(context.Background(), me.userID).Today

	t.Run("handshake carries the work log rule and the tools", func(t *testing.T) {
		me.t, other.t = t, t
		init, _ := me.rpc("initialize", map[string]any{})["result"].(map[string]any)
		if s, _ := init["instructions"].(string); !strings.Contains(s, "add_daytrack_entries") || !strings.Contains(s, "• Velocity:") {
			t.Fatalf("instructions missing the rule: %q", s)
		}
		list, _ := me.rpc("tools/list", map[string]any{})["result"].(map[string]any)
		raw, _ := json.Marshal(list)
		for _, name := range []string{"add_daytrack_entries", "update_daytrack_entry", "delete_daytrack_entry", "send_daytrack", "add_daytrack_category"} {
			if !strings.Contains(string(raw), `"`+name+`"`) {
				t.Fatalf("%s not listed", name)
			}
		}
	})

	t.Run("several tasks split 1-1-1 with no invented time", func(t *testing.T) {
		me.t, other.t = t, t
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"entries": []map[string]any{
			{"name": "• Velocity: fixed the login redirect\n• Velocity: tested the signup flow\n• researched pgvector indexes"},
		}})
		created := dtItems(d, "created")
		if len(created) != 3 {
			t.Fatalf("want 3 entries, got %d: %v", len(created), d)
		}
		want := map[string]string{
			"Velocity: fixed the login redirect": "Development",
			"Velocity: tested the signup flow":   "Testing",
			"researched pgvector indexes":        "Research",
		}
		for _, row := range me.entries(today) {
			if want[row.Name] != row.Category {
				t.Errorf("%q: category %q, want %q", row.Name, row.Category, want[row.Name])
			}
			if row.DurationMins != nil || row.StartTime == "" || row.StartTime != row.EndTime {
				t.Errorf("%q: want a stamped time and no duration, got %q to %q, %v", row.Name, row.StartTime, row.EndTime, row.DurationMins)
			}
			if strings.ContainsAny(row.Name, "\n•") {
				t.Errorf("%q is not a clean single line", row.Name)
			}
		}
	})

	t.Run("a retry changes nothing", func(t *testing.T) {
		me.t, other.t = t, t
		before := len(me.entries(today))
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "Velocity: fixed the login redirect"}}})
		if len(dtItems(d, "created")) != 0 || len(dtItems(d, "skipped")) != 1 || len(me.entries(today)) != before {
			t.Fatalf("retry was not skipped: %v", d)
		}
	})

	t.Run("five clients sending the same task at once log it once", func(t *testing.T) {
		me.t, other.t = t, t
		var wg sync.WaitGroup
		for i := 0; i < 5; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				me.tool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "Velocity: concurrent retry check"}}})
			}()
		}
		wg.Wait()
		count := 0
		for _, row := range me.entries(today) {
			if row.Name == "Velocity: concurrent retry check" {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("logged %d times", count)
		}
	})

	t.Run("one bad line saves nothing", func(t *testing.T) {
		me.t, other.t = t, t
		before := len(me.entries(today))
		long := strings.Repeat("x", mcpDayTrackMaxLine+1)
		cases := []map[string]any{
			{"entries": []map[string]any{{"name": "Velocity: good line"}, {"name": long}}},
			{"entries": []map[string]any{{"name": "Velocity: good line"}, {"name": "x", "category": "Nope"}}},
			{"entries": []map[string]any{{"name": "Velocity: good line"}, {"name": "x", "start_time": "10"}}},
			{"entries": []map[string]any{{"name": "a\nb", "duration_mins": 30}}},
			{"date": "2099-01-01", "entries": []map[string]any{{"name": "from the future"}}},
		}
		for _, args := range cases {
			if s, _, ok := me.tool("add_daytrack_entries", args); ok {
				t.Errorf("should fail: %v gave %s", args, s)
			}
		}
		if got := len(me.entries(today)); got != before {
			t.Fatalf("entries went from %d to %d", before, got)
		}
	})

	t.Run("given times are stored in 12 hour form with a duration", func(t *testing.T) {
		me.t, other.t = t, t
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"date": "yesterday", "entries": []map[string]any{
			{"name": "Velocity: past work with times", "start_time": "14:30", "end_time": "4pm"},
			{"name": "Velocity: past work without times"},
		}})
		c := dtItems(d, "created")
		if dtField(c[0], "start_time") != "2:30 PM" || dtField(c[0], "end_time") != "4:00 PM" || c[0]["duration_mins"] != float64(90) {
			t.Fatalf("got %v", c[0])
		}
		if dtField(c[1], "start_time") != "" || dtField(c[1], "time_source") != "blank" {
			t.Fatalf("a past day with no times must stay blank: %v", c[1])
		}
	})

	var inProgressID string
	t.Run("in progress goes to Planned and shows in the report, never Today's Log", func(t *testing.T) {
		me.t, other.t = t, t
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "Velocity: long running task", "status": "in_progress"}}})
		item := dtItems(d, "created")[0]
		inProgressID = dtField(item, "id")
		if dtField(item, "list") != "planned" || dtField(item, "start_time") == "" {
			t.Fatalf("got %v", item)
		}
		for _, row := range me.entries(today) {
			if row.Name == "Velocity: long running task" {
				t.Fatal("in-progress work must not be in Today's Log")
			}
		}
		_, g := me.mustTool("get_daytrack", map[string]any{"date": "today"})
		day := dtItems(g, "days")[0]
		if !strings.Contains(dtField(day, "report_text"), "In Progress") {
			t.Fatalf("report has no In Progress section: %s", dtField(day, "report_text"))
		}
		if len(dtItems(day, "planned")) != 1 || dtField(dtItems(day, "entries")[0], "id") == "" {
			t.Fatalf("get_daytrack must return ids and planned items: %v", day)
		}
		_, dup := me.mustTool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "Velocity: long running task"}}})
		if len(dtItems(dup, "skipped")) != 1 {
			t.Fatalf("the same work must not sit in both lists: %v", dup)
		}
	})

	t.Run("finishing it moves it to Today's Log with a new id", func(t *testing.T) {
		me.t, other.t = t, t
		_, d := me.mustTool("update_daytrack_entry", map[string]any{"entry_id": inProgressID, "status": "done"})
		item, _ := d["item"].(map[string]any)
		if dtField(item, "list") != "todays_log" || dtField(item, "id") == inProgressID {
			t.Fatalf("got %v", d)
		}
		for _, p := range me.planned(today) {
			if p.ID == inProgressID {
				t.Fatal("still in Planned & Carry Over")
			}
		}
	})

	var parentID, subID string
	t.Run("subtasks stretch the parent and carry with it", func(t *testing.T) {
		me.t, other.t = t, t
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"date": "yesterday", "entries": []map[string]any{{"name": "Velocity: parent task", "start_time": "9am", "end_time": "10am"}}})
		parentID = dtField(dtItems(d, "created")[0], "id")
		_, s := me.mustTool("add_daytrack_entries", map[string]any{"date": "yesterday", "entries": []map[string]any{{"name": "child part", "parent_entry_id": parentID, "start_time": "10am", "end_time": "11:30am"}}})
		sub := dtItems(s, "created")[0]
		subID = dtField(sub, "id")
		if dtField(sub, "category") != "Development" || dtField(sub, "category_source") != "parent" {
			t.Fatalf("a subtask follows its parent's category: %v", sub)
		}
		parent, err := mcpDayTrackRepo.FindEntry(context.Background(), parentID, me.userID)
		if err != nil || parent.EndTime != "11:30 AM" || parent.DurationMins == nil || *parent.DurationMins != 150 {
			t.Fatalf("parent not stretched: %+v, %v", parent, err)
		}
		if _, _, ok := me.tool("add_daytrack_entries", map[string]any{"date": "yesterday", "entries": []map[string]any{{"name": "too early", "parent_entry_id": parentID, "start_time": "8am", "end_time": "8:30am"}}}); ok {
			t.Fatal("a subtask can't start before its parent")
		}
		if _, _, ok := me.tool("update_daytrack_entry", map[string]any{"entry_id": subID, "status": "in_progress"}); ok {
			t.Fatal("a subtask can't move on its own")
		}
		_, m := me.mustTool("update_daytrack_entry", map[string]any{"entry_id": parentID, "status": "in_progress"})
		if m["subtasks_moved"] != float64(1) {
			t.Fatalf("got %v", m)
		}
		yesterday := time.Now().In(mcpDayTrackClockFor(context.Background(), me.userID).Loc).AddDate(0, 0, -1).Format("2006-01-02")
		names := map[string]string{}
		for _, p := range me.planned(yesterday) {
			names[p.Name] = p.Notes
		}
		if !strings.HasPrefix(names["child part"], "[subtask of Velocity: parent task]") {
			t.Fatalf("subtask not carried: %v", names)
		}
		for _, row := range me.entries(yesterday) {
			if row.Name == "child part" || row.Name == "Velocity: parent task" {
				t.Fatalf("%q was left behind in Today's Log", row.Name)
			}
		}
	})

	t.Run("update changes only what it is given", func(t *testing.T) {
		me.t, other.t = t, t
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"date": "yesterday", "entries": []map[string]any{{"name": "Velocity: to be edited", "start_time": "1pm", "end_time": "2pm", "notes": "keep this"}}})
		id := dtField(dtItems(d, "created")[0], "id")
		_, u := me.mustTool("update_daytrack_entry", map[string]any{"entry_id": id, "end_time": "3pm"})
		item, _ := u["item"].(map[string]any)
		if item["duration_mins"] != float64(120) || dtField(item, "notes") != "keep this" || dtField(item, "name") != "Velocity: to be edited" {
			t.Fatalf("got %v", item)
		}
		_, r := me.mustTool("update_daytrack_entry", map[string]any{"entry_id": id, "name": "Velocity: renamed", "category": "testing"})
		if item, _ = r["item"].(map[string]any); dtField(item, "category") != "Testing" || item["duration_mins"] != float64(120) {
			t.Fatalf("got %v", item)
		}
		for _, bad := range []map[string]any{
			{"entry_id": id, "name": "one\ntwo"},
			{"entry_id": id, "name": strings.Repeat("y", mcpDayTrackMaxLine+1)},
			{"entry_id": id, "category": "Nope"},
			{"entry_id": id, "start_time": "4pm", "end_time": "9am"},
			{"entry_id": id},
			{"entry_id": "not-an-id", "name": "x"},
		} {
			if s, _, ok := me.tool("update_daytrack_entry", bad); ok {
				t.Errorf("should fail: %v gave %s", bad, s)
			}
		}
	})

	t.Run("custom categories exist only when asked for, then get detected", func(t *testing.T) {
		me.t, other.t = t, t
		if s, _, ok := me.tool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "x", "category": "Website Work"}}}); ok {
			t.Fatalf("an unknown category must not be created silently: %s", s)
		}
		if _, _, ok := me.tool("add_daytrack_category", map[string]any{"name": "Website Work", "icon": "not-an-emoji"}); ok {
			t.Fatal("a bad icon must be refused")
		}
		me.mustTool("add_daytrack_category", map[string]any{"name": "Website Work", "icon": "🌐"})
		if _, _, ok := me.tool("add_daytrack_category", map[string]any{"name": "website work", "icon": "🌐"}); ok {
			t.Fatal("a duplicate must be refused")
		}
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "Website Work: pricing page copy"}}})
		c := dtItems(d, "created")[0]
		if dtField(c, "category") != "Website Work" || dtField(c, "emoji") != "🌐" {
			t.Fatalf("got %v", c)
		}
	})

	t.Run("nobody can reach another user's entries", func(t *testing.T) {
		me.t, other.t = t, t
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "Velocity: private entry"}}})
		id := dtField(dtItems(d, "created")[0], "id")
		if s, _, ok := other.tool("update_daytrack_entry", map[string]any{"entry_id": id, "name": "hacked"}); ok {
			t.Fatalf("update crossed users: %s", s)
		}
		if s, _, ok := other.tool("delete_daytrack_entry", map[string]any{"entry_ids": []string{id}}); ok {
			t.Fatalf("delete crossed users: %s", s)
		}
		if _, _, ok := other.tool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "x", "parent_entry_id": id}}}); ok {
			t.Fatal("a subtask crossed users")
		}
		if e, _ := mcpDayTrackRepo.FindEntry(context.Background(), id, me.userID); e == nil || e.Name != "Velocity: private entry" {
			t.Fatalf("entry was changed: %+v", e)
		}
	})

	t.Run("delete reports what went and takes subtasks with it", func(t *testing.T) {
		me.t, other.t = t, t
		_, d := me.mustTool("add_daytrack_entries", map[string]any{"date": "yesterday", "entries": []map[string]any{{"name": "Velocity: delete me", "start_time": "5pm", "end_time": "6pm"}}})
		parent := dtField(dtItems(d, "created")[0], "id")
		_, s := me.mustTool("add_daytrack_entries", map[string]any{"date": "yesterday", "entries": []map[string]any{{"name": "delete my child", "parent_entry_id": parent, "start_time": "5pm", "end_time": "5:30pm"}}})
		child := dtField(dtItems(s, "created")[0], "id")
		_, r := me.mustTool("delete_daytrack_entry", map[string]any{"entry_ids": []string{parent, child, "00000000-0000-0000-0000-000000000000"}})
		if len(dtItems(r, "deleted")) != 2 {
			t.Fatalf("got %v", r)
		}
		if nf, _ := r["not_found"].([]any); len(nf) != 1 {
			t.Fatalf("got %v", r)
		}
		if _, _, ok := me.tool("delete_daytrack_entry", map[string]any{"entry_ids": []string{parent}}); ok {
			t.Fatal("deleting a gone entry should say so")
		}
	})

	t.Run("finishing a YouTrack item moves its ticket, against a fake YouTrack", func(t *testing.T) {
		me.t, other.t = t, t
		ctx := context.Background()
		// A fake server stands in for YouTrack, so no real ticket can move. The throwaway
		// user's own integration points at it, which is the first place the client looks.
		var mu sync.Mutex
		var reads int
		writes := map[string]string{}
		failWrites := false
		fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			defer mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			if r.Method == http.MethodPost {
				body, _ := io.ReadAll(r.Body)
				writes[r.URL.Path] = string(body)
				if failWrites {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				_, _ = w.Write([]byte(`{"id":"1-1","idReadable":"E2EFAKE-1"}`))
				return
			}
			reads++
			if strings.Contains(r.URL.Path, "/users/me") {
				_, _ = w.Write([]byte(`{"id":"1-1","login":"e2e-fake","fullName":"E2E Fake"}`))
				return
			}
			_, _ = w.Write([]byte(`[]`))
		}))
		defer fake.Close()

		pool := database.GetPool()
		if _, err := pool.Exec(ctx, `INSERT INTO youtrack_integrations (user_id, base_url, token, project_id, connected) VALUES ($1, $2, 'fake', 'E2EFAKE', true)`, other.userID, fake.URL); err != nil {
			t.Fatalf("integration: %v", err)
		}
		t.Cleanup(func() {
			if _, err := pool.Exec(context.Background(), `DELETE FROM youtrack_integrations WHERE user_id=$1`, other.userID); err != nil {
				t.Logf("cleanup: %v", err)
			}
		})
		if err := mcpDayTrackRepo.UpsertSlackConfig(ctx, &database.DayTrackSlackConfig{
			UserID: other.userID, KeywordRules: DefaultKeywordRules(), DestChannelID: "C0XXXXXXXXX", DestChannelName: "not-a-real-channel",
		}); err != nil {
			t.Fatalf("config: %v", err)
		}
		ticket := func(n int) string {
			issue := fmt.Sprintf("E2EFAKE-%d", n)
			item, err := mcpDayTrackRepo.CreatePlanned(ctx, other.userID, today, "E2EFAKE ticket "+issue, "Development", "", "", "",
				"today", "", "in_progress", "youtrack", "yt-inprogress-"+issue, &issue)
			if err != nil {
				t.Fatalf("planned: %v", err)
			}
			return item.ID
		}

		// Preview with the server's real handler runs the sync. The fake reports no open
		// tickets, so the sync must drop the stale in-progress item, and must never write.
		stale := ticket(9)
		other.mustTool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "Velocity: work to report"}}})
		h.UseDayTrack(NewDayTrackHandler(NewYouTrackHandler()))
		defer h.UseDayTrack(nil)
		_, p := other.mustTool("send_daytrack", map[string]any{"preview": true})
		mu.Lock()
		gotReads, gotWrites := reads, len(writes)
		mu.Unlock()
		if gotReads == 0 || gotWrites != 0 {
			t.Fatalf("sync should read and never write: %d reads, %d writes", gotReads, gotWrites)
		}
		if item, _ := mcpDayTrackRepo.FindPlanned(ctx, stale, other.userID); item != nil {
			t.Fatal("the sync should have removed the ticket that is no longer in progress")
		}
		if !strings.Contains(dtField(p, "report_text"), "work to report") {
			t.Fatalf("report: %v", p)
		}

		first := ticket(1)
		sentence, _ := other.mustTool("update_daytrack_entry", map[string]any{"entry_id": first, "status": "done"})
		mu.Lock()
		body := writes["/api/issues/E2EFAKE-1"]
		mu.Unlock()
		if !strings.Contains(sentence, "in YouTrack") || !strings.Contains(body, "StateBundleElement") {
			t.Fatalf("ticket not moved: %q, sent %q, writes %v", sentence, body, writes)
		}

		// When YouTrack refuses, the work is still logged and the user is told.
		second := ticket(2)
		mu.Lock()
		failWrites = true
		mu.Unlock()
		_, d := other.mustTool("update_daytrack_entry", map[string]any{"entry_id": second, "status": "done"})
		if w, _ := d["warnings"].([]any); len(w) == 0 || !strings.Contains(fmt.Sprint(w), "could not be moved") {
			t.Fatalf("a failed ticket move must warn: %v", d)
		}
		if item, _ := d["item"].(map[string]any); dtField(item, "list") != "todays_log" {
			t.Fatalf("the entry should still be done: %v", d)
		}
	})

	t.Run("send needs a channel", func(t *testing.T) {
		me.t, other.t = t, t
		if _, _, ok := me.tool("send_daytrack", map[string]any{}); ok {
			t.Fatal("no channel is set yet")
		}
	})

	if os.Getenv("VELOCITY_E2E_SLACK_SEND") != "1" {
		t.Log("skipping the real Slack send, set VELOCITY_E2E_SLACK_SEND=1 as well")
		return
	}

	t.Run("send posts to #velocity-app once, then edits in place", func(t *testing.T) {
		me.t, other.t = t, t
		ctx := context.Background()
		pool := database.GetPool()
		// The throwaway user borrows a connected workspace's bot, for #velocity-app only.
		if _, err := pool.Exec(ctx, `INSERT INTO slack_integrations (user_id, bot_token, team_id, team_name, connected)
			SELECT $1, bot_token, team_id, team_name, true FROM slack_integrations WHERE connected LIMIT 1`, me.userID); err != nil {
			t.Fatalf("integration: %v", err)
		}
		chID, _ := h.resolveChannel(ctx, me.userID, e2eChannel)
		if chID == "" {
			t.Fatalf("#%s not found", e2eChannel)
		}
		if err := mcpDayTrackRepo.UpsertSlackConfig(ctx, &database.DayTrackSlackConfig{
			UserID: me.userID, KeywordRules: DefaultKeywordRules(), DestChannelID: chID, DestChannelName: e2eChannel,
		}); err != nil {
			t.Fatalf("config: %v", err)
		}
		t.Cleanup(func() {
			ctx := context.Background()
			if post, _ := mcpDayTrackRepo.GetDailyPost(ctx, me.userID, today); post != nil {
				for _, ts := range post.AllTS() {
					if err := h.slackSvc.DeleteMessage(ctx, me.userID, post.ChannelID, ts); err != nil {
						t.Logf("cleanup: %v", err)
					}
				}
			}
		})

		_, p := me.mustTool("send_daytrack", map[string]any{"preview": true})
		if dtField(p, "channel") != "#"+e2eChannel || !strings.Contains(dtField(p, "report_text"), "E2E owner") {
			t.Fatalf("preview: %v", p)
		}
		if post, _ := mcpDayTrackRepo.GetDailyPost(ctx, me.userID, today); post != nil {
			t.Fatal("a preview must not post")
		}

		_, s := me.mustTool("send_daytrack", map[string]any{})
		if dtField(s, "action") != "posted" {
			t.Fatalf("got %v", s)
		}
		post, err := mcpDayTrackRepo.GetDailyPost(ctx, me.userID, today)
		if err != nil || post == nil || post.ChannelID != chID {
			t.Fatalf("post record: %+v, %v", post, err)
		}
		live := func() string {
			msgs, err := h.slackSvc.GetLiveChannelMessages(ctx, me.userID, chID, "")
			if err != nil {
				t.Fatalf("read Slack: %v", err)
			}
			for _, m := range msgs {
				if m.TS == post.SlackTS {
					return m.Text
				}
			}
			t.Fatal("the message is not in Slack")
			return ""
		}
		if text := live(); !strings.Contains(text, "fixed the login redirect") {
			t.Fatalf("Slack text: %s", text)
		}

		_, a := me.mustTool("add_daytrack_entries", map[string]any{"entries": []map[string]any{{"name": "Velocity: added after the post"}}})
		if w, _ := a["warnings"].([]any); len(w) == 0 {
			t.Fatalf("should warn that Slack is out of date: %v", a)
		}
		_, u := me.mustTool("send_daytrack", map[string]any{})
		if dtField(u, "action") != "updated" {
			t.Fatalf("got %v", u)
		}
		again, _ := mcpDayTrackRepo.GetDailyPost(ctx, me.userID, today)
		if again.SlackTS != post.SlackTS {
			t.Fatal("a second send must edit, not post again")
		}
		if text := live(); !strings.Contains(text, "added after the post") {
			t.Fatalf("Slack was not edited: %s", text)
		}
	})
}
