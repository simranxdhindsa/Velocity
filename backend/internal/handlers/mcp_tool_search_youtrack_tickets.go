package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var searchYoutrackTicketsToolSchema = map[string]interface{}{
	"name": "search_youtrack_tickets",
	"description": "Searches YouTrack tickets by free text and/or filters — use this when the user does NOT give an exact ticket ID " +
		"(e.g. 'find the cost tracking ticket assigned to Suryansh in the current sprint'). For an exact ID like ARD-123, use get_youtrack_ticket instead, it's faster. " +
		"'query' matches against summary/description text. To filter by assignee, first resolve the person's name to a YouTrack login via get_developer_configs, then pass assignee_login. " +
		"To scope to a sprint, pass sprint_name exactly as returned by get_sprints, or the literal string 'current' for the active sprint. " +
		"Also filters by priority, type, subsystem, reporter, created/updated date (e.g. updated_since '7d' or '2026-10-01'), and unresolved_only. " +
		"For anything the filters don't cover, pass a raw YouTrack query fragment in 'yql' (e.g. 'has: comments', 'tag: Hotfix', 'commented: {Last week}'); it is combined with the other filters. " +
		"Returns matching tickets (id_readable, summary, status, priority, type, subsystem, assignee, reporter, created, updated, url), sorted by sort_by (default: most recently updated first), up to `limit` results.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"query": map[string]string{
				"type":        "string",
				"description": "Free text keywords to match in the ticket summary/description, e.g. 'cost tracking'. Omit to list tickets matching only the other filters.",
			},
			"assignee_login": map[string]string{
				"type":        "string",
				"description": "YouTrack login of the assignee to filter by. Resolve display names via get_developer_configs first.",
			},
			"sprint_name": map[string]string{
				"type":        "string",
				"description": "Exact sprint name from get_sprints, or 'current' for the active sprint. Omit to search across all sprints.",
			},
			"state": map[string]string{
				"type":        "string",
				"description": "Filter by workflow state, e.g. 'In Progress', 'To Do', 'Closed'. Omit to include all states.",
			},
			"priority": map[string]string{
				"type":        "string",
				"description": "Filter by priority, using the exact value as it appears in this YouTrack project (copy it from a ticket's 'priority' in get_youtrack_ticket/search results; values are project-specific, don't guess).",
			},
			"type": map[string]string{
				"type":        "string",
				"description": "Filter by ticket type, using the exact value from this project (e.g. a ticket's 'type' in search results; values are project-specific).",
			},
			"subsystem": map[string]string{
				"type":        "string",
				"description": "Filter by subsystem, using the exact value from this project (e.g. a ticket's 'subsystem' in search results; values are project-specific).",
			},
			"reporter_login": map[string]string{
				"type":        "string",
				"description": "YouTrack login of the person who created the ticket.",
			},
			"updated_since": map[string]string{
				"type":        "string",
				"description": "Only tickets updated on/after this point. Either a date 'YYYY-MM-DD' or a relative 'Nd' (e.g. '7d' = last 7 days).",
			},
			"created_since": map[string]string{
				"type":        "string",
				"description": "Only tickets created on/after this point. Either 'YYYY-MM-DD' or a relative 'Nd'.",
			},
			"unresolved_only": map[string]string{
				"type":        "boolean",
				"description": "true to exclude resolved tickets and any state the Velocity workflow config marks as closed.",
			},
			"yql": map[string]string{
				"type":        "string",
				"description": "Raw YouTrack query fragment appended to the other filters, for anything not covered above, e.g. 'has: comments', 'tag: Hotfix', 'commented: {Last week}'.",
			},
			"sort_by": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"updated", "created", "priority"},
				"description": "Sort order, newest/highest first. Default 'updated'.",
			},
			"limit": map[string]interface{}{
				"type":        "integer",
				"description": "Max results to return. Default 20, max 50.",
			},
		},
		"required": []string{},
	},
}

func mcpSearchYoutrackTickets(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Query         string `json:"query"`
		AssigneeLogin string `json:"assignee_login"`
		SprintName    string `json:"sprint_name"`
		State         string `json:"state"`
		Priority      string `json:"priority"`
		Type          string `json:"type"`
		Subsystem     string `json:"subsystem"`
		ReporterLogin string `json:"reporter_login"`
		UpdatedSince  string `json:"updated_since"`
		CreatedSince  string `json:"created_since"`
		Unresolved    bool   `json:"unresolved_only"`
		YQL           string `json:"yql"`
		SortBy        string `json:"sort_by"`
		Limit         int    `json:"limit"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return rpcErr(id, -32602, "invalid arguments")
	}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient == nil {
		return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
	}

	limit := a.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}

	var parts []string
	if pid := ytClient.GetProjectID(); pid != "" {
		parts = append(parts, fmt.Sprintf("project: %s", pid))
	}
	if q := strings.TrimSpace(a.Query); q != "" {
		parts = append(parts, q)
	}
	if a.AssigneeLogin != "" {
		parts = append(parts, "Assignee: "+a.AssigneeLogin)
	}
	if a.State != "" {
		parts = append(parts, fmt.Sprintf("State: {%s}", a.State))
	}
	if sn := strings.TrimSpace(a.SprintName); sn != "" {
		if strings.EqualFold(sn, "current") || strings.EqualFold(sn, "latest") {
			resolved, err := ytClient.GetLatestSprintName(ctx)
			if err != nil {
				return toolError(id, "could not determine current sprint: "+err.Error())
			}
			if resolved == "" {
				return toolError(id, "could not determine current sprint")
			}
			sn = resolved
		}
		parts = append(parts, fmt.Sprintf("#{%s}", sn))
	}

	for _, f := range []struct{ field, value string }{
		{"Priority", a.Priority}, {"Type", a.Type}, {"Subsystem", a.Subsystem},
	} {
		if v := strings.TrimSpace(f.value); v != "" {
			parts = append(parts, fmt.Sprintf("%s: {%s}", f.field, v))
		}
	}
	if r := strings.TrimSpace(a.ReporterLogin); r != "" {
		parts = append(parts, "reporter: "+r)
	}
	for _, f := range []struct{ field, param, value string }{
		{"updated", "updated_since", a.UpdatedSince}, {"created", "created_since", a.CreatedSince},
	} {
		if strings.TrimSpace(f.value) == "" {
			continue
		}
		from, err := parseSinceDate(f.value, time.Now())
		if err != nil {
			return toolError(id, fmt.Sprintf("invalid %s %q: %s", f.param, f.value, err))
		}
		parts = append(parts, fmt.Sprintf("%s: %s .. Today", f.field, from))
	}
	if a.Unresolved {
		// YouTrack's #Unresolved only drops states flagged "resolved" in the
		// project, which may not include Closed, so also exclude every state the
		// user's workflow config gives the "closed" role.
		parts = append(parts, "#Unresolved")
		for _, st := range mcpClosedStates(ctx, ytClient, userID) {
			parts = append(parts, fmt.Sprintf("State: -{%s}", st))
		}
	}
	if raw := strings.TrimSpace(a.YQL); raw != "" {
		parts = append(parts, raw)
	}

	// Only the project scope means no real filter was given.
	if len(parts) == 0 || (len(parts) == 1 && strings.HasPrefix(parts[0], "project: ")) {
		return rpcErr(id, -32602, "invalid arguments: provide at least one filter (query, assignee_login, sprint_name, state, priority, type, subsystem, reporter_login, updated_since, created_since, unresolved_only, or yql)")
	}

	// Priority sorts in its enum order (A1 before A3), so "highest first" is asc.
	sortClause := "updated desc"
	switch strings.ToLower(strings.TrimSpace(a.SortBy)) {
	case "", "updated":
	case "created":
		sortClause = "created desc"
	case "priority":
		sortClause = "Priority asc"
	default:
		return toolError(id, fmt.Sprintf("invalid sort_by %q: use updated, created, or priority", a.SortBy))
	}
	parts = append(parts, "sort by: "+sortClause)

	yql := strings.Join(parts, " ")
	issues, err := ytClient.SearchIssues(ctx, yql, limit)
	if err != nil {
		hint := ""
		if strings.Contains(err.Error(), "invalid_query") {
			switch {
			case a.AssigneeLogin != "" && strings.Contains(err.Error(), a.AssigneeLogin):
				hint = fmt.Sprintf(" — assignee_login %q may not be a real YouTrack login; verify it via get_developer_configs first", a.AssigneeLogin)
			case a.Priority != "" || a.Type != "" || a.Subsystem != "":
				hint = " — a priority/type/subsystem value isn't used in this project; run a search without that filter and copy the exact value from a returned ticket"
			case a.AssigneeLogin != "":
				hint = fmt.Sprintf(" — assignee_login %q may not be a real YouTrack login; verify it via get_developer_configs first", a.AssigneeLogin)
			}
		}
		return toolError(id, "search failed: "+err.Error()+hint)
	}

	ytBaseURL := strings.TrimRight(ytClient.GetBaseURL(), "/")
	results := make([]map[string]interface{}, 0, len(issues))
	for _, issue := range issues {
		displayID := issue.IDReadable
		if displayID == "" {
			displayID = issue.ID
		}
		var assignee map[string]string
		if au := youtrack.GetAssignee(issue); au != nil {
			assignee = map[string]string{"login": au.Login, "full_name": au.FullName}
		}
		var reporter map[string]string
		if issue.Reporter != nil {
			reporter = map[string]string{"login": issue.Reporter.Login, "full_name": issue.Reporter.FullName}
		}
		results = append(results, map[string]interface{}{
			"id_readable": displayID,
			"summary":     issue.Summary,
			"status":      youtrack.GetStatus(issue),
			"priority":    youtrack.GetPriority(issue),
			"type":        youtrack.GetCustomFieldValue(issue, "Type"),
			"subsystem":   youtrack.GetSubsystem(issue),
			"assignee":    assignee,
			"reporter":    reporter,
			"created":     msToISO(issue.Created),
			"updated":     msToISO(issue.Updated),
			"url":         fmt.Sprintf("%s/issue/%s", ytBaseURL, displayID),
		})
	}
	data, _ := json.Marshal(map[string]interface{}{
		"query":   yql,
		"count":   len(results),
		"tickets": results,
	})
	return toolOK(id, string(data))
}

// parseSinceDate turns "YYYY-MM-DD" or a relative "Nd" into a YouTrack date
// literal (YYYY-MM-DD) for range queries like "updated: 2026-10-01 .. Today".
func parseSinceDate(v string, now time.Time) (string, error) {
	v = strings.ToLower(strings.TrimSpace(v))
	if strings.HasSuffix(v, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(v, "d"))
		if err != nil || n < 0 || n > 3650 {
			return "", fmt.Errorf("use 'Nd' with N between 0 and 3650, e.g. '7d'")
		}
		return now.AddDate(0, 0, -n).Format("2006-01-02"), nil
	}
	t, err := time.Parse("2006-01-02", v)
	if err != nil {
		return "", fmt.Errorf("use 'YYYY-MM-DD' or 'Nd'")
	}
	return t.Format("2006-01-02"), nil
}

// mcpClosedStates returns the states (and their aliases) that the user's
// YouTrack workflow config assigns the "closed" role.
// Only names that are real states in the YouTrack project are returned, since
// YouTrack rejects a query that mentions an unknown state value.
func mcpClosedStates(ctx context.Context, yt *youtrack.Client, userID string) []string {
	cfg, err := database.NewWorkflowConfigRepository().GetEffective(ctx, userID, "youtrack")
	if err != nil || cfg == nil {
		return nil
	}
	states, err := yt.GetStates(ctx)
	if err != nil {
		return nil
	}
	real := make(map[string]string, len(states))
	for _, st := range states {
		real[strings.ToLower(st.Name)] = st.Name
	}
	seen := map[string]bool{}
	var out []string
	for _, col := range cfg.ColumnHierarchy {
		if col.Role != "closed" {
			continue
		}
		for _, name := range append([]string{col.State}, col.Aliases...) {
			if actual, ok := real[strings.ToLower(name)]; ok && !seen[actual] {
				seen[actual] = true
				out = append(out, actual)
			}
		}
	}
	return out
}
