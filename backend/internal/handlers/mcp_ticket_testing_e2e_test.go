package handlers

// End-to-end check of the testing scenarios / acceptance criteria rule: throwaway
// users and developer configs on the dev database, the real whoami and
// create_youtrack_ticket handlers, and a fake YouTrack server, so no real ticket
// is created and nobody is notified. Each user's YouTrack token is their fake
// login, so the fake /users/me knows who is calling.
//
//   VELOCITY_E2E_TICKETS=1 go test ./internal/handlers -run TestMCPTicketTestingE2E -v -count=1

import (
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

func TestMCPTicketTestingE2E(t *testing.T) {
	if os.Getenv("VELOCITY_E2E_TICKETS") != "1" {
		t.Skip("writes to the dev database; set VELOCITY_E2E_TICKETS=1 to run")
	}
	loadDotEnv(t, "../../.env")
	if !strings.Contains(os.Getenv("DATABASE_URL"), "dev_velocity") {
		t.Skip("refusing to run anywhere but the dev database")
	}
	if err := database.Connect(); err != nil {
		t.Fatalf("db: %v", err)
	}
	// Idempotent, so this also works against a fresh throwaway database.
	if err := database.RunMigrations(); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	ctx := context.Background()
	pool := database.GetPool()
	run := fmt.Sprint(time.Now().UnixNano())

	// Fake YouTrack: records issue creates and comments.
	var mu sync.Mutex
	var created []string  // descriptions of created issues
	var comments []string // comment texts
	failComments := false
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		login := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/comments"):
			if failComments {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			var b struct{ Text string }
			_ = json.NewDecoder(r.Body).Decode(&b)
			comments = append(comments, b.Text)
			_, _ = w.Write([]byte(`{"id":"4-1","text":""}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/issues":
			var b struct{ Description string }
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &b)
			created = append(created, b.Description)
			_, _ = w.Write([]byte(fmt.Sprintf(`{"id":"2-%d","idReadable":"E2EFAKE-%d","summary":"x"}`, len(created), len(created))))
		case strings.Contains(r.URL.Path, "/users/me"):
			_, _ = w.Write([]byte(fmt.Sprintf(`{"id":"1-1","login":%q,"fullName":%q}`, login, login)))
		case r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{}`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	defer fake.Close()

	// newUser makes a throwaway Velocity user whose YouTrack login is login.
	newUser := func(tag, login string) string {
		id := "e2e-tickets-" + tag + "-" + run
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, name, picture, role) VALUES ($1, $2, $3, '', 'member')`, id, id+"@velocity.test", "E2E "+tag); err != nil {
			t.Fatalf("user: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO youtrack_integrations (user_id, base_url, token, project_id, connected) VALUES ($1, $2, $3, 'E2EFAKE', true)`, id, fake.URL, login); err != nil {
			t.Fatalf("integration: %v", err)
		}
		t.Cleanup(func() {
			for _, q := range []string{`DELETE FROM youtrack_integrations WHERE user_id=$1`, `DELETE FROM mcp_activity_log WHERE user_id=$1`, `DELETE FROM users WHERE id=$1`} {
				if _, err := pool.Exec(context.Background(), q, id); err != nil {
					t.Logf("cleanup %q: %v", q, err)
				}
			}
		})
		return id
	}
	config := func(login, name string, subsystems []string, qa bool) {
		if _, err := pool.Exec(ctx, `INSERT INTO developer_subsystem_configs (developer_login, developer_name, subsystems, is_qa, updated_at) VALUES ($1, $2, $3, $4, NOW())`, login, name, subsystems, qa); err != nil {
			t.Fatalf("config: %v", err)
		}
		t.Cleanup(func() {
			if _, err := pool.Exec(context.Background(), `DELETE FROM developer_subsystem_configs WHERE developer_login=$1`, login); err != nil {
				t.Logf("cleanup config: %v", err)
			}
		})
	}

	devLogin, qaLogin, noSubLogin := "e2e-dev-"+run, "e2e-qa-"+run, "e2e-nosub-"+run
	config(devLogin, "E2E Developer", []string{"FE MC", "BE MC"}, false)
	config(qaLogin, "E2E Tester", []string{}, true)
	config(noSubLogin, "E2E No Subsystem", []string{}, false)
	dev, qa, noSub, stranger := newUser("dev", devLogin), newUser("qa", qaLogin), newUser("nosub", noSubLogin), newUser("stranger", "e2e-stranger-"+run)

	h := NewMCPHandler()
	call := func(userID, tool string, args map[string]any) (string, bool) {
		argJSON, _ := json.Marshal(args)
		params, _ := json.Marshal(map[string]any{"name": tool, "arguments": json.RawMessage(argJSON)})
		return mcpResultSummary(h.callTool(httptest.NewRequest("POST", "/api/mcp", nil), 1, params, userID))
	}
	ticket := map[string]any{"summary": "Render login button", "description": "Login button does nothing.", "type_name": "Bug", "priority": "Normal", "subsystem": "FE MC"}
	with := func(extra map[string]any) map[string]any {
		m := map[string]any{}
		for k, v := range ticket {
			m[k] = v
		}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	reset := func() { mu.Lock(); created, comments = nil, nil; mu.Unlock() }

	t.Run("whoami tells each person their ticket role", func(t *testing.T) {
		for _, c := range []struct{ name, user, want string }{
			{"developer", dev, "developer"}, {"QA", qa, "qa"}, {"no subsystem", noSub, "qa"}, {"not configured", stranger, "qa"},
		} {
			out, ok := call(c.user, "whoami", map[string]any{})
			var r struct {
				Youtrack struct {
					TicketRole string `json:"ticket_role"`
				}
			}
			_ = json.Unmarshal([]byte(out), &r)
			if !ok || r.Youtrack.TicketRole != c.want {
				t.Errorf("%s: ok=%v role=%q want %q (%s)", c.name, ok, r.Youtrack.TicketRole, c.want, out)
			}
		}
	})

	t.Run("developer without testing scenarios is refused", func(t *testing.T) {
		reset()
		out, ok := call(dev, "create_youtrack_ticket", ticket)
		if ok || !strings.Contains(out, "Testing scenarios are required") || len(created) != 0 {
			t.Fatalf("ok=%v created=%d out=%s", ok, len(created), out)
		}
	})

	t.Run("developer ticket gets sections and QA is asked", func(t *testing.T) {
		reset()
		out, ok := call(dev, "create_youtrack_ticket", with(map[string]any{"testing_scenarios": "- Log in with a valid user\n- Check logout still works"}))
		if !ok || len(created) != 1 {
			t.Fatalf("ok=%v created=%d out=%s", ok, len(created), out)
		}
		d := created[0]
		for _, want := range []string{"Login button does nothing.", "## Testing Scenarios\n- Log in with a valid user", "## Acceptance Criteria\n" + acceptancePendingNote} {
			if !strings.Contains(d, want) {
				t.Errorf("description missing %q:\n%s", want, d)
			}
		}
		if len(comments) != 1 || !strings.Contains(comments[0], "@"+qaLogin) || strings.Contains(comments[0], "@"+devLogin) || strings.Contains(comments[0], "@"+noSubLogin) {
			t.Fatalf("QA comment wrong: %q", comments)
		}
		if !strings.Contains(out, "E2E Tester") {
			t.Errorf("result should name the QA asked: %s", out)
		}
		t.Logf("result:\n%s\ndescription:\n%s\ncomment: %s", out, d, comments[0])
	})

	t.Run("QA without acceptance criteria is refused", func(t *testing.T) {
		for _, u := range []string{qa, noSub, stranger} {
			reset()
			out, ok := call(u, "create_youtrack_ticket", ticket)
			if ok || !strings.Contains(out, "Acceptance criteria are required") || len(created) != 0 {
				t.Fatalf("%s: ok=%v created=%d out=%s", u, ok, len(created), out)
			}
		}
	})

	t.Run("QA ticket with acceptance criteria posts no comment", func(t *testing.T) {
		reset()
		out, ok := call(qa, "create_youtrack_ticket", with(map[string]any{"acceptance_criteria": "- User lands on the dashboard"}))
		if !ok || len(created) != 1 || len(comments) != 0 {
			t.Fatalf("ok=%v created=%d comments=%d out=%s", ok, len(created), len(comments), out)
		}
		if !strings.Contains(created[0], "## Testing Scenarios\n"+testingPendingNote) || !strings.Contains(created[0], "## Acceptance Criteria\n- User lands on the dashboard") {
			t.Fatalf("description:\n%s", created[0])
		}
	})

	t.Run("failed QA comment still creates the ticket and says so", func(t *testing.T) {
		reset()
		mu.Lock()
		failComments = true
		mu.Unlock()
		defer func() { mu.Lock(); failComments = false; mu.Unlock() }()
		out, ok := call(dev, "create_youtrack_ticket", with(map[string]any{"testing_scenarios": "- Log in"}))
		if !ok || len(created) != 1 || !strings.Contains(out, "Could not post the comment asking QA") {
			t.Fatalf("ok=%v created=%d out=%s", ok, len(created), out)
		}
	})
}
