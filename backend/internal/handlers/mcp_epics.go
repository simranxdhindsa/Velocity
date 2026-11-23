package handlers

import (
	"context"
	"fmt"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// Feature epics: a parent ticket with Type Epic and Subsystem Epic, with the
// feature's tickets linked to it as "subtask of". Filtering on Subsystem Epic
// keeps out the old per-sprint deployment checklists that also used Type Epic.

// openEpics returns the project's unresolved feature epics, oldest first.
// shortcut: capped at 100 open epics, page through results if a project ever has more.
func openEpics(ctx context.Context, yt *youtrack.Client) ([]youtrack.Issue, error) {
	q := fmt.Sprintf("project: %s Type: {Epic} Subsystem: {Epic} #Unresolved sort by: created asc", yt.GetProjectID())
	return yt.SearchIssues(ctx, q, 100)
}

// epicRequirement says why a ticket can't be created yet, or "" when it can.
// Features and enhancements need an epic or an explicit standalone choice;
// bugs, regressions and hotfixes may skip it.
func epicRequirement(typeName, epic string, standalone bool) string {
	switch strings.ToLower(strings.TrimSpace(typeName)) {
	case "feature", "enhancement":
		if strings.TrimSpace(epic) == "" && !standalone {
			return "A " + typeName + " must belong to an epic. Ask the user which epic it is part of and pass epic, or confirm it is a small standalone change and pass standalone: true."
		}
	}
	return ""
}

// epicChoices lists open epics as "ARD-1 Composer, ARD-2 Search" for prompts.
func epicChoices(epics []youtrack.Issue) string {
	if len(epics) == 0 {
		return "none yet"
	}
	names := make([]string, len(epics))
	for i, e := range epics {
		names[i] = e.IDReadable + " " + e.Summary
	}
	return strings.Join(names, ", ")
}

// findEpic returns the open epic with this readable ID, matched case-insensitively.
func findEpic(epics []youtrack.Issue, id string) *youtrack.Issue {
	for i := range epics {
		if strings.EqualFold(epics[i].IDReadable, strings.TrimSpace(id)) {
			return &epics[i]
		}
	}
	return nil
}
