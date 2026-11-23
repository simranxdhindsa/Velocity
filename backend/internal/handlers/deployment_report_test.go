package handlers

import (
	"strings"
	"testing"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

func TestBuildDeploymentReportText_GroupsByEpicFirst(t *testing.T) {
	lines := []deployReportLine{
		{IDReadable: "ARD-1", IssueType: "Bug", Subsystem: "FE UI", FixStatement: "Fixed the login button."},
		{IDReadable: "ARD-2", IssueType: "Bug", Subsystem: "BE UI", FixStatement: "Fixed voice defaults.", EpicID: "ARD-9", EpicName: "Realtime Voice"},
		{IDReadable: "ARD-3", IssueType: "Feature", Subsystem: "FE MC", FixStatement: "Added a voice test session.", EpicID: "ARD-9", EpicName: "Realtime Voice"},
		{IDReadable: "ARD-4", IssueType: "Enhancement", Subsystem: "BE MC", FixStatement: "Set token limits.", EpicID: "ARD-8", EpicName: "Token Limits"},
		{IDReadable: "ARD-5", IssueType: "Feature", Subsystem: "BE UI", FixStatement: "", EpicID: "ARD-7", EpicName: "Skipped"},
	}
	got := buildDeploymentReportText(lines)
	want := strings.Join([]string{
		"Hey team 👋 here is the list of changes in this deployment:",
		"Features in this release\n\nRealtime Voice (ARD-9)\nARD-3 FE MC: Added a voice test session.\nARD-2 BE UI: Fixed voice defaults.\n\nToken Limits (ARD-8)\nARD-4 BE MC: Set token limits.",
		"Bug Fixes\nARD-1 FE UI: Fixed the login button.",
	}, "\n\n")
	if got != want {
		t.Fatalf("report text mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestBuildDeploymentReportText_NoEpicsKeepsOldLayout(t *testing.T) {
	got := buildDeploymentReportText([]deployReportLine{{IDReadable: "ARD-1", IssueType: "Feature", Subsystem: "FE UI", FixStatement: "Added X."}})
	if strings.Contains(got, deployEpicTitle) || !strings.Contains(got, "Features\nARD-1 FE UI: Added X.") {
		t.Fatalf("unexpected layout without epics: %q", got)
	}
}

func TestWithoutEpicsDropsEpicTickets(t *testing.T) {
	typed := func(id, typ string) youtrack.Issue {
		return youtrack.Issue{IDReadable: id, CustomFields: []youtrack.CustomField{{Name: "Type", Value: map[string]interface{}{"name": typ}}}}
	}
	got := withoutEpics([]youtrack.Issue{typed("ARD-1", "Epic"), typed("ARD-2", "Bug"), typed("ARD-3", "epic")})
	if len(got) != 1 || got[0].IDReadable != "ARD-2" {
		t.Fatalf("withoutEpics kept %v", got)
	}
}

func TestParseRetryAfterFromGroq_Units(t *testing.T) {
	cases := map[string]int{
		"Please try again in 26.224s.": 28,
		"try again in 500ms":           2,
		"try again in 2m":              121,
		"try again in 1h12m":           3601,
		"no hint here":                 30,
	}
	for msg, want := range cases {
		if got := parseRetryAfterFromGroq(msg); got != want {
			t.Errorf("parseRetryAfterFromGroq(%q) = %d, want %d", msg, got, want)
		}
	}
}
