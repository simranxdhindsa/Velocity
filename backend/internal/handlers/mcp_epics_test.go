package handlers

import (
	"encoding/json"
	"testing"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

func TestEpicRequirement(t *testing.T) {
	cases := []struct {
		typ, epic  string
		standalone bool
		blocked    bool
	}{
		{"Feature", "", false, true},
		{"enhancement", "", false, true},
		{"Feature", "ARD-3233", false, false},
		{"Enhancement", "", true, false},
		{"Bug", "", false, false},
		{"Regression", "", false, false},
		{"Hotfix", "", false, false},
		{"Epic", "", false, false},
	}
	for _, c := range cases {
		if got := epicRequirement(c.typ, c.epic, c.standalone) != ""; got != c.blocked {
			t.Errorf("epicRequirement(%q, %q, %v) blocked=%v, want %v", c.typ, c.epic, c.standalone, got, c.blocked)
		}
	}
}

func TestFindEpicAndChoices(t *testing.T) {
	epics := []youtrack.Issue{{IDReadable: "ARD-3233", Summary: "Composer"}, {IDReadable: "ARD-3234", Summary: "Universal Search"}}
	if e := findEpic(epics, " ard-3234 "); e == nil || e.Summary != "Universal Search" {
		t.Fatalf("findEpic case-insensitive lookup failed: %+v", e)
	}
	if findEpic(epics, "ARD-1") != nil {
		t.Fatal("findEpic matched a ticket that is not an open epic")
	}
	if got := epicChoices(epics); got != "ARD-3233 Composer, ARD-3234 Universal Search" {
		t.Fatalf("epicChoices = %q", got)
	}
	if got := epicChoices(nil); got != "none yet" {
		t.Fatalf("epicChoices(nil) = %q", got)
	}
}

func TestGetParentFromYouTrackJSON(t *testing.T) {
	var withParent, without youtrack.Issue
	if err := json.Unmarshal([]byte(`{"idReadable":"ARD-3212","parent":{"issues":[{"idReadable":"ARD-3233","summary":"Composer","customFields":[{"name":"Type","value":{"name":"Epic"}}]}]}}`), &withParent); err != nil {
		t.Fatal(err)
	}
	if id, sum := youtrack.GetParent(withParent); id != "ARD-3233" || sum != "Composer" {
		t.Fatalf("GetParent = %q %q", id, sum)
	}
	_ = json.Unmarshal([]byte(`{"idReadable":"ARD-3222","parent":{"issues":[]}}`), &without)
	if id, _ := youtrack.GetParent(without); id != "" {
		t.Fatalf("GetParent on a ticket with no parent = %q", id)
	}
	var taskParent youtrack.Issue
	_ = json.Unmarshal([]byte(`{"idReadable":"ARD-11","parent":{"issues":[{"idReadable":"ARD-10","summary":"Setup","customFields":[{"name":"Type","value":{"name":"Task"}}]}]}}`), &taskParent)
	if id, _ := youtrack.GetParent(taskParent); id != "" {
		t.Fatalf("a Task parent was treated as an epic: %q", id)
	}
}
