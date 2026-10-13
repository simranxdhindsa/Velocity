package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// sprint_tickets_by_status: the Slack bot's answer to "how many tickets are
// blocked / in progress / done". search_tickets passed the model's words to
// YouTrack as free text, so "blocked" matched titles containing "block"
// (all Verified tickets) and the bot said nothing was blocked, with at most
// 5 results and no count. This counts the way the app does (navbar "7
// blocked"): the board's current sprint, with each status resolved through
// the workflow config (statesForRole), minus the sender's parked tickets.

const slackBotSprintListMax = 15

func init() { slackBotTools = append(slackBotTools, slackBotSprintTool) }

var slackBotSprintTool = map[string]interface{}{
	"type": "function",
	"function": map[string]interface{}{
		"name": "sprint_tickets_by_status",
		"description": "Count and list tickets in a sprint by workflow status: blocked, active (in progress), dev_done, verified, deployed, backlog or findings. " +
			"Use for any 'how many / which tickets are blocked / in progress / done' question. Defaults to the current sprint.",
		"parameters": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"status": map[string]interface{}{
					"type":        "string",
					"enum":        mcpWorkflowRoles,
					"description": "Workflow status to count, e.g. blocked",
				},
				"sprint": map[string]interface{}{
					"type":        "string",
					"description": "'current' (default), 'next' or an exact sprint name",
				},
				"assignee": map[string]interface{}{
					"type":        "string",
					"description": "Optional: only this person's tickets (name or login)",
				},
			},
			"required": []string{"status"},
		},
	},
}

func runSlackBotSprintTool(ctx context.Context, client *youtrack.Client, argsJSON string) (string, bool) {
	var a struct {
		Status   string `json:"status"`
		Sprint   string `json:"sprint"`
		Assignee string `json:"assignee"`
	}
	_ = json.Unmarshal([]byte(argsJSON), &a)
	userID, _ := ctx.Value(slackBotUserKey{}).(string)

	bc, err := loadMCPBoardContext(ctx, client, userID)
	if err != nil {
		return "Could not load the sprint board: " + err.Error(), false
	}
	ref := strings.TrimSpace(a.Sprint)
	if ref == "" {
		ref = "current"
	}
	sprint, err := bc.findSprint(ref)
	if err != nil {
		return err.Error(), false
	}
	states, err := bc.statesForRole(a.Status)
	if err != nil {
		return err.Error(), false
	}
	want := map[string]bool{}
	for _, s := range states {
		want[strings.ToLower(s)] = true
	}
	issues, err := client.GetAllSprintIssues(ctx, sprint.ID)
	if err != nil {
		return fmt.Sprintf("Could not fetch tickets of sprint %s: %v", sprint.Name, err), false
	}

	// Parked tickets are hidden from every blocked view for that user (CLAUDE.md RULE #2).
	parked := map[string]bool{}
	if userID != "" && strings.EqualFold(a.Status, "blocked") {
		if ids, err := database.NewIgnoredBlockedRepository().GetIgnoredIDs(ctx, userID); err == nil {
			for _, id := range ids {
				parked[strings.ToUpper(id)] = true
			}
		}
	}

	var matched []youtrack.Issue
	skippedParked := 0
	for _, is := range issues {
		if !want[strings.ToLower(youtrack.GetStatus(is))] {
			continue
		}
		if a.Assignee != "" {
			au := youtrack.GetAssignee(is)
			if au == nil || !(strings.Contains(strings.ToLower(au.FullName), strings.ToLower(a.Assignee)) || strings.EqualFold(au.Login, a.Assignee)) {
				continue
			}
		}
		if parked[strings.ToUpper(is.IDReadable)] {
			skippedParked++
			continue
		}
		matched = append(matched, is)
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "%s: %d %s ticket(s) (states: %s)", sprint.Name, len(matched), a.Status, strings.Join(states, ", "))
	if a.Assignee != "" {
		fmt.Fprintf(&sb, " for %s", a.Assignee)
	}
	if skippedParked > 0 {
		fmt.Fprintf(&sb, ", not counting %d you parked", skippedParked)
	}
	sb.WriteString(".\n")
	for i, is := range matched {
		if i == slackBotSprintListMax {
			fmt.Fprintf(&sb, "...and %d more.\n", len(matched)-slackBotSprintListMax)
			break
		}
		who := "unassigned"
		if au := youtrack.GetAssignee(is); au != nil {
			who = au.FullName
		}
		fmt.Fprintf(&sb, "%s: %s (priority: %s, assignee: %s)\n", is.IDReadable, is.Summary, youtrack.GetPriority(is), who)
	}
	return sb.String(), true
}
