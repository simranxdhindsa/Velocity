package handlers

import (
	"encoding/json"
	"testing"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

func TestEpicFor(t *testing.T) {
	epics := []youtrack.Issue{{IDReadable: "ARD-3233", Summary: "Composer"}, {IDReadable: "ARD-1", Summary: "Bugs"}, {IDReadable: "ARD-2", Summary: "Enhancements"}}
	cases := []struct {
		typ, epic, want string // want "" means refused
	}{
		{"Feature", "ARD-3233", "ARD-3233"},
		{"Feature", "", "ARD-2"}, // no feature epic: Enhancements
		{"task", "", "ARD-2"},
		{"Bug", "", "ARD-1"},            // falls back to its type's epic
		{"Bug", "ard-3233", "ARD-3233"}, // found while testing a feature
		{"Regression", "", ""},          // the Regressions epic does not exist yet
		{"Bug", "ARD-999", ""},          // not an open epic
		{"", "", ""},                    // no type and no epic
	}
	for _, c := range cases {
		e, reason := epicFor(epics, c.typ, c.epic)
		got := ""
		if e != nil {
			got = e.IDReadable
		}
		if got != c.want || (got == "") != (reason != "") {
			t.Errorf("epicFor(%q, %q) = %q, %q; want %q", c.typ, c.epic, got, reason, c.want)
		}
	}
	if !isBucketEpic(youtrack.Issue{Summary: " hotfixes "}) || isBucketEpic(youtrack.Issue{Summary: "Composer"}) {
		t.Fatal("isBucketEpic misclassified")
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
