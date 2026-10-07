package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/services/youtrack"
)

var generateDeploymentReportToolSchema = map[string]interface{}{
	"name": "generate_deployment_report",
	"description": "Prepares the Velocity deployment report (the PM Reports > Deployment Report tab): takes every ticket in the chosen board column(s), " +
		"rewrites each into a one-line user-facing fix statement with AI, and returns Slack-ready text grouped into Features / Enhancements / Bug Fixes / Hotfixes / Other, " +
		"one line per ticket as \"ID Subsystem: fix\". Also returns the structured ticket list and everything that was excluded and why. " +
		"READ-ONLY: it never posts to Slack or changes tickets. To post the result, show it to the user first and then use queue_slack_message or send_slack_message_now if they ask. " +
		"COLUMNS ARE REQUIRED: if the user did not say which column(s) to prepare the report for (e.g. \"Stage\", \"Ready for Stage\"), do NOT guess. " +
		"Call this tool with list_columns=true, show the user the real column list, and ask which ones to include. " +
		"Scope defaults to the current sprint of the user's board (same as the UI); pass sprint_name to pick another sprint, or \"all\" for every ticket in those columns across the project. " +
		"Exclusions: \"exclude website tickets\" means exclude_subsystems=[\"Website\"] (tickets use the Subsystem field for the product area). " +
		"Use exclude_ids for specific tickets, exclude_keywords for summary text, exclude_types for Type values, exclude_tags for YouTrack tags.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"list_columns": map[string]interface{}{
				"type":        "boolean",
				"description": "Only return the available columns and sprints (with the default sprint) so you can ask the user what to include. No report is generated.",
			},
			"columns": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Board column(s) / states to include, e.g. [\"Stage\", \"Ready for Stage\"]. Matched case-insensitively against the real columns. Required unless list_columns is true.",
			},
			"sprint_name": map[string]interface{}{
				"type":        "string",
				"description": "Sprint to scope to. Omit (or \"current\") for the current sprint, same as the UI default. \"all\" = no sprint filter (whole project).",
			},
			"updated": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"all", "today", "yesterday"},
				"description": "Same as the UI's date pills: only tickets last updated today / yesterday. Default \"all\".",
			},
			"exclude_subsystems": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Exclude tickets whose Subsystem equals one of these (case-insensitive), e.g. [\"Website\"] for website tickets.",
			},
			"exclude_types": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Exclude tickets whose Type equals one of these (case-insensitive). Tickets without a Type count as \"Other\".",
			},
			"exclude_tags": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Exclude tickets carrying one of these YouTrack tags. Unknown tag names are reported as warnings.",
			},
			"exclude_keywords": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Exclude tickets whose summary contains one of these strings (case-insensitive).",
			},
			"exclude_ids": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Readable ticket IDs to leave out, e.g. [\"ARD-123\"].",
			},
			"include_ids": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Readable ticket IDs to always include, even if they are outside the chosen columns/sprint or match an exclusion.",
			},
			"generate_fix_statements": map[string]interface{}{
				"type":        "boolean",
				"description": "Default true: AI rewrites each ticket into a fix statement (as in the UI). false = use the raw ticket summaries, much faster.",
			},
		},
		"required": []string{},
	},
}

type deployReportArgs struct {
	ListColumns       bool     `json:"list_columns"`
	Columns           []string `json:"columns"`
	SprintName        string   `json:"sprint_name"`
	Updated           string   `json:"updated"`
	ExcludeSubsystems []string `json:"exclude_subsystems"`
	ExcludeTypes      []string `json:"exclude_types"`
	ExcludeTags       []string `json:"exclude_tags"`
	ExcludeKeywords   []string `json:"exclude_keywords"`
	ExcludeIDs        []string `json:"exclude_ids"`
	IncludeIDs        []string `json:"include_ids"`
	GenerateFix       *bool    `json:"generate_fix_statements"`
}

// deployReportTicket is one ticket in the tool's structured output.
type deployReportTicket struct {
	IDReadable   string `json:"id_readable"`
	Summary      string `json:"summary"`
	State        string `json:"state"`
	Type         string `json:"type"`
	Section      string `json:"section"`
	Subsystem    string `json:"subsystem"`
	URL          string `json:"url,omitempty"`
	Updated      string `json:"updated,omitempty"`
	FixStatement string `json:"fix_statement"`
	FixSource    string `json:"fix_source"` // ai | summary | summary_fallback
	Forced       bool   `json:"force_included,omitempty"`

	item ytDeployTicketItem
}

type deployExcluded struct {
	IDReadable string `json:"id_readable"`
	Summary    string `json:"summary"`
	State      string `json:"state"`
	Subsystem  string `json:"subsystem"`
	Type       string `json:"type"`
	Reason     string `json:"reason"`
}

func mcpGenerateDeploymentReport(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a deployReportArgs
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return rpcErr(id, -32602, "invalid arguments: "+err.Error())
		}
	}
	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return toolError(id, "YouTrack not configured. Add your YouTrack integration in Velocity > Integrations")
	}

	available, err := deploymentColumnNames(ctx, yt)
	if err != nil || len(available) == 0 {
		return toolError(id, fmt.Sprintf("could not load board columns from YouTrack: %v", err))
	}
	sprints, sprintErr := yt.GetSprints(ctx)
	current := deployCurrentSprint(sprints)

	if a.ListColumns {
		out := map[string]interface{}{"columns": available, "default_sprint": nil, "sprints": deploySprintNames(sprints)}
		if current != nil {
			out["default_sprint"] = current.Name
		}
		data, _ := json.MarshalIndent(out, "", "  ")
		return toolOK(id, string(data))
	}

	columns, unknown := deployResolveColumns(a.Columns, available)
	if len(unknown) > 0 {
		return toolError(id, fmt.Sprintf("unknown column(s): %s. Ask the user to pick from the available columns: %s", strings.Join(unknown, ", "), strings.Join(available, ", ")))
	}
	if len(columns) == 0 {
		return toolError(id, "columns is required: ask the user which column(s) to prepare the deployment report for. Available columns: "+strings.Join(available, ", "))
	}

	updated := strings.ToLower(strings.TrimSpace(a.Updated))
	if updated == "" {
		updated = "all"
	}
	if updated != "all" && updated != "today" && updated != "yesterday" {
		return toolError(id, fmt.Sprintf("invalid updated %q: use all, today, or yesterday", a.Updated))
	}

	// Scope: same default as the UI (current sprint), or a named one, or all.
	var sprintID, sprintLabel string
	var warnings []string
	switch sn := strings.TrimSpace(a.SprintName); strings.ToLower(sn) {
	case "all", "none", "any":
		sprintLabel = "all sprints (whole project)"
	case "", "current", "latest", "active":
		if current != nil {
			sprintID, sprintLabel = current.ID, current.Name
		} else {
			sprintLabel = "all sprints (whole project)"
			warnings = append(warnings, "no active sprint found, so the whole project was used")
		}
	default:
		if sprintErr != nil {
			return toolError(id, "could not load sprints: "+sprintErr.Error())
		}
		for _, s := range sprints {
			if strings.EqualFold(s.Name, sn) {
				sprintID, sprintLabel = s.ID, s.Name
			}
		}
		if sprintID == "" {
			return toolError(id, fmt.Sprintf("unknown sprint %q. Sprints: %s (or \"all\")", sn, strings.Join(deploySprintNames(sprints), ", ")))
		}
	}

	issues, err := fetchDeploymentIssues(ctx, yt, columns, sprintID)
	if err != nil {
		return toolError(id, "failed to fetch tickets: "+err.Error())
	}

	baseURL := strings.TrimRight(yt.GetBaseURL(), "/")
	kept, excluded, w := deployApplyFilters(ctx, yt, issues, a, updated)
	warnings = append(warnings, w...)

	generate := a.GenerateFix == nil || *a.GenerateFix
	var failed []map[string]string
	if generate && len(kept) > 0 {
		failed = deployGenerateFixes(ctx, deploymentFixPrompt(ctx, h.botRepo), kept)
	}

	lines := make([]deployReportLine, 0, len(kept))
	for i := range kept {
		t := &kept[i]
		if !generate {
			t.FixStatement, t.FixSource = deploySummaryLine(t.item.Summary, t.Subsystem), "summary"
		}
		if baseURL != "" {
			t.URL = baseURL + "/issue/" + t.IDReadable
		}
		lines = append(lines, deployReportLine{IDReadable: t.IDReadable, IssueType: t.Type, Subsystem: t.Subsystem, FixStatement: t.FixStatement})
	}

	report := ""
	if len(kept) > 0 {
		report = buildDeploymentReportText(lines)
	}
	out := map[string]interface{}{
		"report":       report,
		"ticket_count": len(kept),
		"scope": map[string]interface{}{
			"columns": columns,
			"sprint":  sprintLabel,
			"updated": updated,
		},
		"tickets":        kept,
		"excluded":       excluded,
		"excluded_count": len(excluded),
	}
	if len(kept) == 0 {
		out["message"] = fmt.Sprintf("No tickets found in %s for columns %s after filters. Nothing to report.", sprintLabel, strings.Join(columns, ", "))
	}
	if len(failed) > 0 {
		out["generation_failed"] = failed
		out["generation_note"] = "AI could not write a fix statement for these tickets, so the report uses their raw summary instead. Rewrite those lines before sharing if needed."
	}
	if len(warnings) > 0 {
		out["warnings"] = warnings
	}
	data, _ := json.MarshalIndent(out, "", "  ")
	return toolOK(id, string(data))
}

// deployCurrentSprint mirrors the PM Reports page: the non-completed sprint
// that hasn't finished yet with the earliest finish date.
func deployCurrentSprint(sprints []youtrack.Sprint) *youtrack.Sprint {
	now := time.Now().UnixMilli()
	var best *youtrack.Sprint
	for i := range sprints {
		s := &sprints[i]
		if s.IsCompleted || s.Finish <= now {
			continue
		}
		if best == nil || s.Finish < best.Finish {
			best = s
		}
	}
	return best
}

func deploySprintNames(sprints []youtrack.Sprint) []string {
	names := make([]string, 0, len(sprints))
	for _, s := range sprints {
		names = append(names, s.Name)
	}
	return names
}

// deployResolveColumns maps requested names onto the real column spelling.
func deployResolveColumns(requested, available []string) (resolved, unknown []string) {
	real := make(map[string]string, len(available))
	for _, c := range available {
		real[strings.ToLower(strings.TrimSpace(c))] = c
	}
	seen := map[string]bool{}
	for _, r := range requested {
		key := strings.ToLower(strings.TrimSpace(r))
		if key == "" {
			continue
		}
		name, ok := real[key]
		if !ok {
			unknown = append(unknown, r)
			continue
		}
		if !seen[name] {
			seen[name] = true
			resolved = append(resolved, name)
		}
	}
	return resolved, unknown
}
