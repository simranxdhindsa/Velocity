package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// Feature epics: a parent ticket with Type Epic and Subsystem Epic, with the
// feature's tickets linked to it as "subtask of". Filtering on Subsystem Epic
// keeps out the old per-sprint deployment checklists that also used Type Epic.

// openEpics returns the project's unresolved feature epics, oldest first.
// shortcut: capped at 100 open epics, page through results if a project ever has more.
const openEpicsLimit = 100

func openEpics(ctx context.Context, yt *youtrack.Client) ([]youtrack.Issue, error) {
	q := fmt.Sprintf("project: %s Type: {Epic} Subsystem: {Epic} #Unresolved sort by: created asc", yt.GetProjectID())
	return yt.SearchIssues(ctx, q, openEpicsLimit)
}

// bucketEpicNames are the catch-all epics for work outside any feature, so no
// ticket lands in the board's "Uncategorized" row. Kept to four rows on
// purpose: features and tasks with no feature epic go under Enhancements.
var bucketEpicNames = map[string]string{
	"bug": "Bugs", "enhancement": "Enhancements", "regression": "Regressions", "hotfix": "Hotfixes",
	"feature": "Enhancements", "task": "Enhancements",
}

// bucketEpicOrder is every catch-all epic once. Each sprint gets all four rows.
var bucketEpicOrder = []string{"Bugs", "Regressions", "Hotfixes", "Enhancements"}

func isBucketEpic(e youtrack.Issue) bool {
	for _, name := range bucketEpicOrder {
		if strings.EqualFold(strings.TrimSpace(e.Summary), name) {
			return true
		}
	}
	return false
}

// epicFor picks the epic a ticket must go under: the one asked for, or else
// its type's catch-all epic. It returns why the ticket can't be filed when
// there is no valid epic, so no ticket is ever left without one.
func epicFor(epics []youtrack.Issue, typeName, epic string) (*youtrack.Issue, string) {
	if strings.TrimSpace(epic) != "" {
		if e := findEpic(epics, epic); e != nil {
			return e, ""
		}
		return nil, fmt.Sprintf("%s is not an open epic. Open epics: %s.", strings.TrimSpace(epic), epicChoices(epics))
	}
	name := bucketEpicNames[strings.ToLower(strings.TrimSpace(typeName))]
	if name == "" {
		return nil, "Every ticket must belong to an epic. Pass epic, or use type Bug, Enhancement, Regression, Hotfix, Feature or Task. Open epics: " + epicChoices(epics) + "."
	}
	for i := range epics {
		if strings.EqualFold(strings.TrimSpace(epics[i].Summary), name) {
			return &epics[i], ""
		}
	}
	return nil, fmt.Sprintf("The %s epic does not exist yet, so this ticket has no row to go in. Create it first with type_name Epic and summary %q.", name, name)
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

// withBucketEpics makes sure all four catch-all epics are open, so a new sprint
// always gets all four rows. A closed one (YouTrack's Subtasks workflow marks a
// parent Fixed once every subtask is resolved) is reopened to Backlog rather
// than duplicated; only a missing one is created. It returns the open epics
// with those added, and the ones it reopened or created.
func withBucketEpics(ctx context.Context, yt *youtrack.Client, epics []youtrack.Issue) ([]youtrack.Issue, []youtrack.Issue, error) {
	var created []youtrack.Issue
	for _, name := range bucketEpicOrder {
		found := false
		for _, e := range epics {
			if strings.EqualFold(strings.TrimSpace(e.Summary), name) {
				found = true
				break
			}
		}
		if found {
			continue
		}
		if closed := closedBucketEpic(ctx, yt, name); closed != nil {
			if _, err := yt.UpdateIssue(ctx, closed.IDReadable, youtrack.UpdateIssueRequest{CustomFields: []youtrack.CustomField{
				{Type: "StateIssueCustomField", Name: "State", Value: map[string]string{"name": "Backlog"}},
			}}); err != nil {
				slog.ErrorContext(ctx, "Could not reopen a catch-all epic, its board row will be missing", "epic", closed.IDReadable, "epic_name", name, "error", err)
				return epics, created, fmt.Errorf("could not reopen the %s epic %s: %w", name, closed.IDReadable, err)
			}
			slog.InfoContext(ctx, "Catch-all epic reopened", "epic", closed.IDReadable, "epic_name", name)
			epics = append(epics, *closed)
			created = append(created, *closed)
			continue
		}
		issue, err := yt.CreateIssue(ctx, youtrack.CreateIssueRequest{
			Summary:     name,
			Description: youtrack.WithVelocityFooter("Catch-all epic for " + strings.ToLower(name) + " that belong to no feature epic, so they get their own board row instead of Uncategorized."),
			CustomFields: []youtrack.CustomField{
				{Type: "StateIssueCustomField", Name: "State", Value: map[string]string{"name": "Backlog"}},
				{Type: "SingleEnumIssueCustomField", Name: "Type", Value: map[string]string{"name": "Epic"}},
				{Type: "SingleEnumIssueCustomField", Name: "Priority", Value: map[string]string{"name": "Normal"}},
				{Type: "SingleOwnedIssueCustomField", Name: "Subsystem", Value: map[string]interface{}{"$type": "OwnedBundleElement", "name": "Epic"}},
			},
		})
		if err != nil {
			slog.ErrorContext(ctx, "Could not recreate a catch-all epic, its board row will be missing", "epic_name", name, "error", err)
			return epics, created, fmt.Errorf("could not create the %s epic: %w", name, err)
		}
		slog.InfoContext(ctx, "Catch-all epic recreated", "epic", issue.IDReadable, "epic_name", name)
		epics = append(epics, *issue)
		created = append(created, *issue)
	}
	return epics, created, nil
}

// closedBucketEpic finds a resolved catch-all epic with exactly this name, or nil.
func closedBucketEpic(ctx context.Context, yt *youtrack.Client, name string) *youtrack.Issue {
	q := fmt.Sprintf("project: %s Type: {Epic} Subsystem: {Epic} #Resolved summary: %s sort by: created asc", yt.GetProjectID(), name)
	found, err := yt.SearchIssues(ctx, q, 20)
	if err != nil {
		slog.WarnContext(ctx, "Could not look for a closed catch-all epic, a new one will be made", "epic_name", name, "error", err)
		return nil
	}
	for i := range found {
		if strings.EqualFold(strings.TrimSpace(found[i].Summary), name) {
			return &found[i]
		}
	}
	return nil
}

// openEpicsWithBuckets is openEpics plus any catch-all epic it had to reopen or
// create, for the ticket tools: a closed Bugs epic must never block filing a bug.
func openEpicsWithBuckets(ctx context.Context, yt *youtrack.Client) ([]youtrack.Issue, error) {
	epics, err := openEpics(ctx, yt)
	if err != nil {
		return nil, err
	}
	epics, fixed, err := withBucketEpics(ctx, yt, epics)
	if len(fixed) > 0 {
		// Same sprints a new epic goes into, so its row shows on the board now.
		if sprints, sErr := yt.GetSprints(ctx); sErr == nil {
			for _, sid := range newTicketSprints(sprints, true, time.Now()) {
				for _, e := range fixed {
					if aErr := yt.AddIssueToSprint(ctx, sid, e.ID); aErr != nil {
						slog.WarnContext(ctx, "Could not add a catch-all epic to a sprint, its row will be missing", "epic", e.IDReadable, "sprint_id", sid, "error", aErr)
					}
				}
			}
		}
	}
	return epics, err
}
