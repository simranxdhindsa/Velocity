package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// Fake YouTrack holding one sprint with epic E1, ticket T1 and the four
// catch-all epics, and open epics E1, E2 and the catch-alls. Records every issue added to a sprint and every YQL query.
func fakeEpicYouTrack(t *testing.T) (*youtrack.Client, *[]string, *[]string) {
	t.Helper()
	var mu sync.Mutex
	var addedToSprint, queries []string
	issue := func(id, readable, typ string) map[string]any {
		sub := "FE UI"
		if typ == "Epic" {
			sub = "Epic"
		}
		return map[string]any{"id": id, "idReadable": readable, "summary": readable,
			"customFields": []map[string]any{{"name": "Type", "value": map[string]any{"name": typ}}, {"name": "Subsystem", "value": map[string]any{"name": sub}}}}
	}
	var catchAll []any
	for i, name := range bucketEpicOrder {
		e := issue(fmt.Sprintf("2-5%d", i), fmt.Sprintf("ARD-5%d", i), "Epic")
		e["summary"] = name
		catchAll = append(catchAll, e)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/sprints/S1/issues"):
			var b struct{ ID string }
			_ = json.NewDecoder(r.Body).Decode(&b)
			addedToSprint = append(addedToSprint, b.ID)
			_, _ = w.Write([]byte(`{}`))
		case strings.HasSuffix(r.URL.Path, "/sprints/S9/issues"):
			w.WriteHeader(http.StatusNotFound)
		case strings.HasSuffix(r.URL.Path, "/sprints/S1/issues"):
			_ = json.NewEncoder(w).Encode(append([]any{issue("2-1", "ARD-1", "Epic"), issue("2-10", "ARD-10", "Bug")}, catchAll...))
		case r.URL.Path == "/api/issues":
			q := r.URL.Query().Get("query")
			queries = append(queries, q)
			if strings.Contains(q, "Type: {Epic}") {
				_ = json.NewEncoder(w).Encode(append([]any{issue("2-1", "ARD-1", "Epic"), issue("2-2", "ARD-2", "Epic")}, catchAll...))
				return
			}
			_ = json.NewEncoder(w).Encode([]any{issue("2-1", "ARD-1", "Epic"), issue("2-10", "ARD-10", "Bug")})
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	t.Cleanup(srv.Close)
	c := youtrack.NewClient(srv.URL, "token", "ARD")
	c.SetBoardID("B1")
	return c, &addedToSprint, &queries
}

func TestSprintFetchesLeaveOutEpics(t *testing.T) {
	c, _, queries := fakeEpicYouTrack(t)
	ctx := context.Background()
	got, err := c.GetAllSprintIssues(ctx, "S1")
	if err != nil || len(got) != 1 || got[0].IDReadable != "ARD-10" {
		t.Fatalf("GetAllSprintIssues = %v, %v; want only ARD-10", got, err)
	}
	if all, _ := c.GetAllSprintIssuesWithEpics(ctx, "S1"); len(all) != 2+len(bucketEpicOrder) {
		t.Fatalf("GetAllSprintIssuesWithEpics kept %d issues, want the ticket and every epic", len(all))
	}
	if got, _ := c.GetIssuesByStateForSprint(ctx, "Sprint 16", nil); len(got) != 1 || got[0].IDReadable != "ARD-10" {
		t.Fatalf("GetIssuesByStateForSprint = %v; want only ARD-10", got)
	}
	// Project-wide fetches drop the epic in Go. A YouTrack "Type: -Epic" query
	// would also drop tickets with no Type, so it must never be used.
	byState, truncated, _ := c.GetIssuesByStateTruncated(ctx, []string{"Backlog"})
	all, _ := c.GetIssues(ctx)
	page, _, _ := c.GetIssuesByStatePaginated(ctx, "Backlog", 0, 10)
	for name, got := range map[string][]youtrack.Issue{"GetIssuesByState": byState, "GetIssues": all, "GetIssuesByStatePaginated": page} {
		if len(got) != 1 || got[0].IDReadable != "ARD-10" {
			t.Fatalf("%s = %v; want only ARD-10", name, got)
		}
	}
	if truncated {
		t.Fatal("2 results reported as truncated")
	}
	for _, q := range *queries {
		if strings.Contains(q, "-Epic") {
			t.Fatalf("query %q filters epics in YouTrack, which also drops tickets with an empty field", q)
		}
	}
}

func TestAddOpenEpicsToSprintWarnsWhenSprintUnreadable(t *testing.T) {
	c, added, _ := fakeEpicYouTrack(t)
	// Sprint S9 does not exist on the fake, so reading it fails.
	names, warn := addOpenEpicsToSprint(context.Background(), c, "S9", "Sprint 99")
	if warn == "" || len(names) != 0 || len(*added) != 0 {
		t.Fatalf("got names %v, warning %q, adds %v; want a warning and no adds", names, warn, *added)
	}
}

func TestAddOpenEpicsToSprintAddsOnlyMissingEpics(t *testing.T) {
	c, added, _ := fakeEpicYouTrack(t)
	names, warn := addOpenEpicsToSprint(context.Background(), c, "S1", "Sprint 17")
	if warn != "" {
		t.Fatalf("unexpected warning %q", warn)
	}
	// ARD-1 is already in the sprint, so only ARD-2 is added, by its internal ID.
	if len(*added) != 1 || (*added)[0] != "2-2" || len(names) != 1 || names[0] != "ARD-2 ARD-2" {
		t.Fatalf("added %v, reported %v; want only 2-2 (ARD-2)", *added, names)
	}
}

// The real Ardoise sprint list on 2026-11-23: no sprint is marked completed,
// so only finish dates tell old sprints apart.
func TestNewTicketSprintsSkipsFinishedSprints(t *testing.T) {
	day := func(d string) int64 {
		tm, _ := time.Parse("2006-01-02", d)
		return tm.UnixMilli()
	}
	sprints := []youtrack.Sprint{
		{ID: "186-40", Name: "Sprint 8", Finish: day("2026-07-24")},
		{ID: "186-64", Name: "Sprint 15", Finish: day("2026-11-21")},
		{ID: "186-66", Name: "Sprint 16", Finish: day("2026-12-05")},
	}
	now, _ := time.Parse("2006-01-02", "2026-11-23")
	if got := newTicketSprints(sprints, true, now); len(got) != 1 || got[0] != "186-66" {
		t.Fatalf("epic sprints = %v, want only Sprint 16", got)
	}
	planned := append(sprints, youtrack.Sprint{ID: "186-70", Name: "Sprint 17", Finish: day("2026-12-19")})
	if got := newTicketSprints(planned, true, now); len(got) != 2 || got[0] != "186-66" || got[1] != "186-70" {
		t.Fatalf("epic sprints with a planned sprint = %v, want Sprint 16 and 17", got)
	}
	if got := newTicketSprints(sprints, false, now); len(got) != 1 || got[0] != "186-66" {
		t.Fatalf("ticket sprint = %v, want Sprint 16", got)
	}
	// Between sprints nothing is running: fall back to the latest.
	late, _ := time.Parse("2006-01-02", "2026-12-10")
	if got := newTicketSprints(sprints, true, late); len(got) != 1 || got[0] != "186-66" {
		t.Fatalf("epic sprints after every sprint ended = %v, want Sprint 16", got)
	}
}

// A new sprint always gets the four catch-all rows: missing ones are created
// as feature epics (Type Epic, Subsystem Epic, Backlog) and added to the sprint.
func TestAddOpenEpicsToSprintRecreatesMissingCatchAllEpics(t *testing.T) {
	var mu sync.Mutex
	var created []map[string]any
	var addedToSprint []string
	epic := func(id, readable, summary string) map[string]any {
		return map[string]any{"id": id, "idReadable": readable, "summary": summary,
			"customFields": []map[string]any{{"name": "Type", "value": map[string]any{"name": "Epic"}}, {"name": "Subsystem", "value": map[string]any{"name": "Epic"}}}}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/issues":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			created = append(created, b)
			n := len(created)
			_ = json.NewEncoder(w).Encode(epic("2-9"+string(rune('0'+n)), "ARD-9"+string(rune('0'+n)), b["summary"].(string)))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/sprints/S1/issues"):
			var b struct{ ID string }
			_ = json.NewDecoder(r.Body).Decode(&b)
			addedToSprint = append(addedToSprint, b.ID)
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/api/issues":
			// Open epics: a feature epic and two catch-alls; Regressions and Hotfixes are missing.
			_ = json.NewEncoder(w).Encode([]any{epic("2-1", "ARD-1", "Composer"), epic("2-2", "ARD-2", "Bugs"), epic("2-3", "ARD-3", "enhancements")})
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	t.Cleanup(srv.Close)
	c := youtrack.NewClient(srv.URL, "token", "0-1")
	c.SetBoardID("B1")

	names, warn := addOpenEpicsToSprint(context.Background(), c, "S1", "Sprint 17")
	if warn != "" {
		t.Fatalf("unexpected warning %q", warn)
	}
	if len(created) != 2 || created[0]["summary"] != "Regressions" || created[1]["summary"] != "Hotfixes" {
		t.Fatalf("created %v; want Regressions then Hotfixes", created)
	}
	fields, _ := json.Marshal(created[0]["customFields"])
	for _, want := range []string{`"Backlog"`, `"Epic"`, `"Subsystem"`} {
		if !strings.Contains(string(fields), want) {
			t.Fatalf("created epic fields %s miss %s", fields, want)
		}
	}
	if len(addedToSprint) != 5 || len(names) != 5 {
		t.Fatalf("added %v (%v); want all 5 epics in the sprint", addedToSprint, names)
	}
}

// A catch-all epic that YouTrack closed (Subtasks workflow) is reopened to
// Backlog, never duplicated; only a truly missing one is created.
func TestWithBucketEpicsReopensClosedInsteadOfDuplicating(t *testing.T) {
	var mu sync.Mutex
	var creates, reopens []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/issues":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			creates = append(creates, b["summary"].(string))
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "2-99", "idReadable": "ARD-99", "summary": b["summary"]})
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/issues/"):
			var b struct {
				CustomFields []struct {
					Name  string
					Value map[string]string
				}
			}
			_ = json.NewDecoder(r.Body).Decode(&b)
			reopens = append(reopens, strings.TrimPrefix(r.URL.Path, "/api/issues/")+"="+b.CustomFields[0].Value["name"])
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/api/issues" && strings.Contains(r.URL.Query().Get("query"), "#Resolved"):
			if strings.Contains(r.URL.Query().Get("query"), "summary: Bugs") {
				// "Bugs report" must not match: only the exact name counts.
				_ = json.NewEncoder(w).Encode([]any{map[string]any{"id": "2-7", "idReadable": "ARD-7", "summary": "Bugs report"}, map[string]any{"id": "2-8", "idReadable": "ARD-8", "summary": "Bugs"}})
				return
			}
			_, _ = w.Write([]byte(`[]`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	t.Cleanup(srv.Close)
	c := youtrack.NewClient(srv.URL, "token", "0-1")
	open := []youtrack.Issue{{IDReadable: "ARD-2", Summary: "Regressions"}, {IDReadable: "ARD-3", Summary: "Enhancements"}}

	epics, fixed, err := withBucketEpics(context.Background(), c, open)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopens) != 1 || reopens[0] != "ARD-8=Backlog" {
		t.Fatalf("reopened %v; want only ARD-8 set to Backlog", reopens)
	}
	if len(creates) != 1 || creates[0] != "Hotfixes" {
		t.Fatalf("created %v; want only Hotfixes (Bugs was reopened)", creates)
	}
	if len(fixed) != 2 || len(epics) != 4 {
		t.Fatalf("fixed %d, epics %d; want 2 fixed and all 4 catch-alls open", len(fixed), len(epics))
	}
}
