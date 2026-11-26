package handlers

import (
	"strings"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/models"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

func TestSuggestSprintDates(t *testing.T) {
	day := func(s string) time.Time { d, _ := time.Parse("2006-01-02", s); return d }
	endOf := func(s string) int64 { return day(s).Add(24*time.Hour - time.Millisecond).UnixMilli() }
	cases := []struct {
		name, now       string
		lastFinish      int64
		start, two, one string
	}{
		{"last sprint ends Friday in the future", "2026-11-26", endOf("2026-12-04"), "2026-12-07", "2026-12-18", "2026-12-11"},
		{"last sprint ended long ago", "2026-11-26", endOf("2026-10-02"), "2026-11-30", "2026-12-11", "2026-12-04"},
		{"today is Monday after the last sprint", "2026-11-30", endOf("2026-11-27"), "2026-11-30", "2026-12-11", "2026-12-04"},
		{"last sprint ends on a Sunday", "2026-11-26", endOf("2026-12-06"), "2026-12-07", "2026-12-18", "2026-12-11"},
		{"no sprints yet", "2026-11-26", 0, "2026-11-30", "2026-12-11", "2026-12-04"},
	}
	for _, c := range cases {
		s, two, one := suggestSprintDates(c.lastFinish, day(c.now).Add(15*time.Hour))
		got := s.Format("2006-01-02") + " " + two.Format("2006-01-02") + " " + one.Format("2006-01-02")
		if want := c.start + " " + c.two + " " + c.one; got != want {
			t.Errorf("%s: got %s, want %s", c.name, got, want)
		}
	}
}

func TestGroupByColumn(t *testing.T) {
	issue := func(id, state string, epic bool) youtrack.Issue {
		iss := youtrack.Issue{IDReadable: id, Summary: "t", CustomFields: []youtrack.CustomField{{Name: "State", Value: map[string]interface{}{"name": state}}}}
		if epic {
			iss.CustomFields = append(iss.CustomFields,
				youtrack.CustomField{Name: "Type", Value: map[string]interface{}{"name": "Epic"}},
				youtrack.CustomField{Name: "Subsystem", Value: map[string]interface{}{"name": "Epic"}})
		}
		return iss
	}
	wf := &models.WorkflowConfig{ColumnHierarchy: []models.ColumnState{
		{State: "Open", Role: "", Aliases: []string{"Backlog"}},
		{State: "In Progress", Role: "active"},
		{State: "Blocked", Role: "blocked"},
		{State: "Fixed", Role: "dev_done"},
		{State: "Verified", Role: "verified"},
	}, ReportConfig: models.ReportConfig{BlockedStates: []string{"On Hold"}}}
	cols := groupByColumn([]youtrack.Issue{
		issue("A-1", "Backlog", false), issue("A-2", "Open", false), issue("A-3", "Fixed", false),
		issue("A-4", "Mystery", false), issue("A-5", "Backlog", true), issue("A-6", "On Hold", false),
	}, wf)
	got := map[string]sprintPlanColumn{}
	var order []string
	for _, c := range cols {
		got[c.Column] = c
		order = append(order, c.Column)
	}
	if want := "Open,In Progress,Blocked,Fixed,On Hold,Mystery"; strings.Join(order, ",") != want {
		t.Fatalf("columns %s, want %s (empty Verified dropped, unknown state last)", strings.Join(order, ","), want)
	}
	if got["Open"].Count != 2 || !got["Open"].Suggested {
		t.Errorf("Open should hold A-1 and A-2 (alias) and be suggested, got %+v", got["Open"])
	}
	if got["In Progress"].Count != 0 || !got["In Progress"].Suggested || !got["Blocked"].Suggested {
		t.Errorf("empty to do, in progress and blocked columns stay so the user can still pick them")
	}
	if got["Fixed"].Suggested || got["Mystery"].Suggested || got["Mystery"].Count != 1 {
		t.Errorf("only to do, in progress and blocked are suggested: %+v %+v", got["Fixed"], got["Mystery"])
	}
	if c := got["On Hold"]; !c.Suggested || c.Role != "blocked" || c.Count != 1 || c.Tickets[0].ID != "A-6" {
		t.Errorf("a report config blocked state is a suggested blocked column, got %+v", c)
	}
}
