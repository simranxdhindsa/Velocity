package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	ai "github.com/dhindsa/project-management/internal/services/ai"
	"github.com/dhindsa/project-management/internal/services/youtrack"
)

// ─── Deployment Report (YouTrack) ────────────────────────────────────────────
//
// Shared core of the PM Reports → Deployment Report flow (YouTrackStageReport
// in PMReportsPage.tsx). The REST handlers below and the MCP tool
// generate_deployment_report (mcp_tool_generate_deployment_report.go) both go
// through these functions so the two paths can't drift apart:
//   deploymentColumnNames         → GET  /bots/stage-report/columns
//   fetchDeploymentIssues         → GET  /bots/deployment/tickets
//   generateDeploymentFixStatement → POST /bots/deployment/generate-ticket
//   buildDeploymentReportText     → Go port of buildDeployReport() in the frontend

type ytDeployTicketItem struct {
	ID          string `json:"id"`
	IDReadable  string `json:"id_readable"`
	Summary     string `json:"summary"`
	Description string `json:"description"`
	IssueType   string `json:"issue_type"`
	Subsystem   string `json:"subsystem"`
	UpdatedAt   int64  `json:"updated_at"`
}

// deploymentColumnNames returns the columns the deployment report can be
// prepared for: the project's live workflow states.
func deploymentColumnNames(ctx context.Context, client *youtrack.Client) ([]string, error) {
	states, err := client.GetStates(ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(states))
	for _, s := range states {
		names = append(names, s.Name)
	}
	return names, nil
}

// fetchDeploymentIssues returns the issues in the given columns. With a
// sprintID it reads the sprint via the agile endpoint and filters by state;
// without one it queries the whole project by state.
func fetchDeploymentIssues(ctx context.Context, client *youtrack.Client, columns []string, sprintID string) ([]youtrack.Issue, error) {
	if sprintID == "" {
		return client.GetIssuesByState(ctx, columns)
	}
	colSet := make(map[string]bool, len(columns))
	for _, c := range columns {
		colSet[strings.TrimSpace(c)] = true
	}
	all, err := client.GetAllSprintIssues(ctx, sprintID)
	if err != nil {
		return nil, err
	}
	var issues []youtrack.Issue
	for _, iss := range all {
		if colSet[youtrack.GetStatus(iss)] {
			issues = append(issues, iss)
		}
	}
	return issues, nil
}

// deployTicketItemFromIssue converts an issue into the ticket shape the
// deployment report works with. Missing Type becomes "Other".
func deployTicketItemFromIssue(issue youtrack.Issue) ytDeployTicketItem {
	issueType := youtrack.GetCustomFieldValue(issue, "Type")
	if issueType == "" {
		issueType = "Other"
	}
	return ytDeployTicketItem{
		ID:          issue.ID,
		IDReadable:  issue.IDReadable,
		Summary:     issue.Summary,
		Description: issue.Description,
		IssueType:   issueType,
		Subsystem:   youtrack.GetSubsystem(issue),
		UpdatedAt:   issue.Updated,
	}
}

const defaultDeploymentFixPrompt = `You are writing bullet points for a deployment update report.
Write ONE short sentence (max 15 words) describing what was fixed or added, in past tense, from the user's perspective.
- Be specific and direct — name the exact feature or interaction that changed
- Vary your sentence starts naturally (can use "Fixed", "Added", "Users can now...", "Resolved", etc.)
- No internal jargon, no ticket IDs, no prefix tags like P0/P1/FE/BE/UI
- Output ONLY the single sentence, nothing else`

// deploymentFixPrompt returns the active stage_report bot prompt, or the default.
func deploymentFixPrompt(ctx context.Context, botRepo *database.BotConfigRepository) string {
	if botRepo != nil {
		bots, _ := botRepo.GetByType(ctx, models.BotTypeStageReport)
		for _, b := range bots {
			if b.IsActive && strings.TrimSpace(b.Prompt) != "" {
				return b.Prompt
			}
		}
	}
	return defaultDeploymentFixPrompt
}

// generateDeploymentFixStatement asks the AI for one user-facing fix sentence.
// On a provider rate limit it returns rateLimited=true and the retry delay.
func generateDeploymentFixStatement(ctx context.Context, systemPrompt string, t ytDeployTicketItem) (fix string, rateLimited bool, retryAfter int, err error) {
	detail := extractExpectedBehavior(t.Description)
	if detail == "" {
		detail = t.Description
	}
	if len(detail) > 800 {
		detail = detail[:800]
	}
	userMsg := fmt.Sprintf("Type: %s\nTicket: %s\nContext: %s", t.IssueType, t.Summary, detail)

	out, err := ai.QueryWithContext(ctx, systemPrompt, userMsg)
	if err != nil {
		if isAIRateLimitError(err.Error()) {
			return "", true, parseRetryAfterFromGroq(err.Error()), err
		}
		return "", false, 0, err
	}
	return strings.TrimSpace(out), false, 0, nil
}

func isAIRateLimitError(errMsg string) bool {
	lower := strings.ToLower(errMsg)
	return strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate_limit") ||
		strings.Contains(lower, "429") || strings.Contains(lower, "too many") ||
		strings.Contains(lower, "tokens per minute") || strings.Contains(lower, "try again in")
}

// parseRetryAfterFromGroq extracts the retry-after duration (in seconds) from a Groq rate-limit error.
// Groq messages look like: "Please try again in 26.224s."
func parseRetryAfterFromGroq(errMsg string) int {
	re := regexp.MustCompile(`(?i)try again in (\d+(?:\.\d+)?)\s*(ms|s|m)`)
	m := re.FindStringSubmatch(errMsg)
	if len(m) < 3 {
		return 30
	}
	val, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 30
	}
	switch strings.ToLower(m[2]) {
	case "ms":
		return int(math.Ceil(val/1000)) + 1
	case "m":
		return int(math.Ceil(val*60)) + 1
	default:
		return int(math.Ceil(val)) + 1
	}
}

// ─── Report text (Go port of the frontend's buildDeployReport) ────────────────
// Keep in sync with TYPE_CATEGORY_ORDER / DR_TYPE_CATEGORIES / SUBSYSTEM_ORDER
// in frontend/src/pages/PMReportsPage.tsx.

var deployTypeCategoryOrder = []string{"Features", "Enhancements", "Bug Fixes", "Hotfixes", "Other"}

var deployTypeCategories = map[string]string{
	"bug":         "Bug Fixes",
	"regression":  "Bug Fixes",
	"feature":     "Features",
	"epic":        "Features",
	"enhancement": "Enhancements",
	"hotfix":      "Hotfixes",
}

var deploySubsystemOrder = []string{"FE UI", "BE UI", "FE Studio", "BE Studio", "FE MC", "BE MC", "BE RAG"}

func deployCategory(issueType string) string {
	if c, ok := deployTypeCategories[strings.ToLower(issueType)]; ok {
		return c
	}
	return "Other"
}

func deploySubsystemRank(subsystem string) int {
	s := strings.TrimSpace(subsystem)
	for i, v := range deploySubsystemOrder {
		if v == s {
			return i
		}
	}
	return len(deploySubsystemOrder)
}

func deploySubsystemLabel(subsystem string) string {
	if s := strings.TrimSpace(subsystem); s != "" {
		return s
	}
	return "Others"
}

// deployReportLine is one ticket that made it into the report.
type deployReportLine struct {
	IDReadable   string
	IssueType    string
	Subsystem    string
	FixStatement string
}

// buildDeploymentReportText renders the Slack-ready report exactly like the
// Deployment Report tab's "Copy" text: type sections in fixed order, tickets
// sorted by subsystem order within each, "ID Subsystem: fix" per line.
func buildDeploymentReportText(lines []deployReportLine) string {
	bySection := map[string][]deployReportLine{}
	for _, l := range lines {
		if strings.TrimSpace(l.FixStatement) == "" {
			continue
		}
		cat := deployCategory(l.IssueType)
		bySection[cat] = append(bySection[cat], l)
	}
	parts := []string{"Hey team 👋 here is the list of changes in this deployment:"}
	for _, label := range deployTypeCategoryOrder {
		items := bySection[label]
		if len(items) == 0 {
			continue
		}
		sort.SliceStable(items, func(i, j int) bool {
			return deploySubsystemRank(items[i].Subsystem) < deploySubsystemRank(items[j].Subsystem)
		})
		rows := make([]string, len(items))
		for i, t := range items {
			rows[i] = fmt.Sprintf("%s %s: %s", t.IDReadable, deploySubsystemLabel(t.Subsystem), t.FixStatement)
		}
		parts = append(parts, label+"\n"+strings.Join(rows, "\n"))
	}
	return strings.Join(parts, "\n\n")
}

// ─── REST handlers ────────────────────────────────────────────────────────────

// GetDeploymentTickets returns issues from the selected YouTrack columns with their Type field.
// GET /api/bots/deployment/tickets?columns=col1,col2
func (h *BotConfigHandler) GetDeploymentTickets(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	columnsStr := r.URL.Query().Get("columns")
	if columnsStr == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "columns parameter required"})
		return
	}
	rawCols := strings.Split(columnsStr, ",")
	sprintID := strings.TrimSpace(r.URL.Query().Get("sprint_id"))

	client, err := h.getYouTrackClientForBots(r)
	if err != nil || client == nil {
		sendJSON(w, http.StatusServiceUnavailable, Response{Success: false, Message: "YouTrack not configured"})
		return
	}

	issues, err := fetchDeploymentIssues(r.Context(), client, rawCols, sprintID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: "Failed to fetch issues: " + err.Error()})
		return
	}

	tickets := make([]ytDeployTicketItem, 0, len(issues))
	for _, issue := range issues {
		tickets = append(tickets, deployTicketItemFromIssue(issue))
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"tickets":  tickets,
			"base_url": client.GetBaseURL(),
		},
	})
}

// GenerateDeploymentTicket generates a single AI fix statement for one ticket.
// Returns rate-limit info (with retry_after seconds) when Groq throttles.
// POST /api/bots/deployment/generate-ticket
func (h *BotConfigHandler) GenerateDeploymentTicket(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	var req ytDeployTicketItem
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Summary) == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "summary required"})
		return
	}

	fix, rateLimited, retryAfter, err := generateDeploymentFixStatement(r.Context(), deploymentFixPrompt(r.Context(), h.botRepo), req)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		if rateLimited {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success":     false,
				"error":       "rate_limited",
				"retry_after": retryAfter,
			})
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "ai_error",
			"message": err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"fix_statement": fix,
		},
	})
}
