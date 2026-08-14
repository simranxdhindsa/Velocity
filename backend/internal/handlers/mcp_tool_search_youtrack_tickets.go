package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var searchYoutrackTicketsToolSchema = map[string]interface{}{
	"name": "search_youtrack_tickets",
	"description": "Searches YouTrack tickets by free text and/or filters — use this when the user does NOT give an exact ticket ID " +
		"(e.g. 'find the cost tracking ticket assigned to Suryansh in the current sprint'). For an exact ID like ARD-123, use get_youtrack_ticket instead, it's faster. " +
		"'query' matches against summary/description text. To filter by assignee, first resolve the person's name to a YouTrack login via get_developer_configs, then pass assignee_login. " +
		"To scope to a sprint, pass sprint_name exactly as returned by get_sprints, or the literal string 'current' for the active sprint. " +
		"Returns a list of matching tickets (id_readable, summary, status, priority, assignee, url) — up to `limit` results, newest first is not guaranteed, use additional filters to narrow if the list is too broad.",
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

	if len(parts) == 0 {
		return rpcErr(id, -32602, "invalid arguments: provide at least one of query, assignee_login, sprint_name, or state")
	}

	yql := strings.Join(parts, " ")
	issues, err := ytClient.SearchIssues(ctx, yql, limit)
	if err != nil {
		hint := ""
		if a.AssigneeLogin != "" && strings.Contains(err.Error(), "invalid_query") {
			hint = fmt.Sprintf(" — assignee_login %q may not be a real YouTrack login; verify it via get_developer_configs first", a.AssigneeLogin)
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
		results = append(results, map[string]interface{}{
			"id_readable": displayID,
			"summary":     issue.Summary,
			"status":      youtrack.GetStatus(issue),
			"priority":    youtrack.GetPriority(issue),
			"subsystem":   youtrack.GetSubsystem(issue),
			"assignee":    assignee,
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
