package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var createSprintToolSchema = map[string]interface{}{
	"name": "create_sprint",
	"description": "Creates a new sprint on the YouTrack board selected in the user's Velocity integration. " +
		"start_date and finish_date are REQUIRED. If the user did not say the sprint period, ASK them first (for example 'next two weeks', 'Monday to Friday', or specific dates) and convert their answer to YYYY-MM-DD dates. Never invent a period. " +
		"name is optional: if omitted it defaults to the next number after the latest numbered sprint on the board (e.g. 'Sprint 13' gives 'Sprint 14'). Duplicate names are rejected. " +
		"There is no 'make current' option: Velocity treats the most recently started, not completed sprint as current, so a sprint becomes current once its start date arrives. " +
		"Returns the created sprint's id, name and dates.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"name": map[string]string{
				"type":        "string",
				"description": "Sprint name. Omit to use the next number after the latest numbered sprint.",
			},
			"start_date": map[string]string{
				"type":        "string",
				"description": "First day of the sprint, YYYY-MM-DD. Ask the user if they didn't give a period.",
			},
			"finish_date": map[string]string{
				"type":        "string",
				"description": "Last day of the sprint (inclusive), YYYY-MM-DD. Must not be before start_date.",
			},
			"goal": map[string]string{
				"type":        "string",
				"description": "Optional sprint goal.",
			},
		},
		"required": []string{"start_date", "finish_date"},
	},
}

func mcpCreateSprint(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Name       string `json:"name"`
		StartDate  string `json:"start_date"`
		FinishDate string `json:"finish_date"`
		Goal       string `json:"goal"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return rpcErr(id, -32602, "invalid arguments")
	}
	if strings.TrimSpace(a.StartDate) == "" || strings.TrimSpace(a.FinishDate) == "" {
		return toolError(id, "start_date and finish_date are required. Ask the user for the sprint period (e.g. 'next two weeks' or specific dates) and pass them as YYYY-MM-DD")
	}
	// Existing sprints on the board run from 00:00 UTC on the first day to
	// 23:59:59.999 UTC on the last day, so match that.
	start, err := time.Parse("2006-01-02", strings.TrimSpace(a.StartDate))
	if err != nil {
		return toolError(id, fmt.Sprintf("invalid start_date %q, use YYYY-MM-DD", a.StartDate))
	}
	finishDay, err := time.Parse("2006-01-02", strings.TrimSpace(a.FinishDate))
	if err != nil {
		return toolError(id, fmt.Sprintf("invalid finish_date %q, use YYYY-MM-DD", a.FinishDate))
	}
	if finishDay.Before(start) {
		return toolError(id, fmt.Sprintf("finish_date %s is before start_date %s", a.FinishDate, a.StartDate))
	}
	finish := finishDay.Add(24*time.Hour - time.Millisecond)

	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return toolError(id, "YouTrack not configured. Add your YouTrack integration in Velocity → Integrations")
	}
	sprints, boardID, err := yt.GetAllBoardSprints(ctx)
	if err != nil {
		return toolError(id, "failed to fetch board sprints: "+err.Error())
	}

	name := strings.TrimSpace(a.Name)
	if name == "" {
		name = nextNumberedSprintName(sprints)
		if name == "" {
			return toolError(id, "none of the board's sprints have a numbered name, so a default can't be picked. Ask the user what to name the sprint and pass it as name")
		}
	}
	for _, s := range sprints {
		if strings.EqualFold(strings.TrimSpace(s.Name), name) {
			return toolError(id, fmt.Sprintf("a sprint named %q already exists on board %s (id %s). Pick a different name", s.Name, boardID, s.ID))
		}
	}

	created, err := yt.CreateSprint(ctx, name, strings.TrimSpace(a.Goal), start.UnixMilli(), finish.UnixMilli())
	if err != nil {
		return toolError(id, "failed to create sprint: "+err.Error())
	}
	data, _ := json.Marshal(map[string]interface{}{
		"id":          created.ID,
		"name":        created.Name,
		"goal":        created.Goal,
		"start":       msToISO(created.Start),
		"finish":      msToISO(created.Finish),
		"start_date":  start.Format("2006-01-02"),
		"finish_date": finishDay.Format("2006-01-02"),
		"board_id":    boardID,
	})
	return toolOK(id, string(data))
}

var sprintNumberRe = regexp.MustCompile(`^(.*?)(\d+)\s*$`)

// nextNumberedSprintName returns the name after the highest-numbered sprint
// ("Sprint 13" gives "Sprint 14"), keeping that sprint's prefix. Returns ""
// when no sprint name ends in a number.
func nextNumberedSprintName(sprints []youtrack.Sprint) string {
	best, prefix := -1, ""
	for _, s := range sprints {
		m := sprintNumberRe.FindStringSubmatch(strings.TrimSpace(s.Name))
		if m == nil {
			continue
		}
		n, err := strconv.Atoi(m[2])
		if err != nil {
			continue
		}
		if n > best {
			best, prefix = n, m[1]
		}
	}
	if best < 0 {
		return ""
	}
	return fmt.Sprintf("%s%d", prefix, best+1)
}
