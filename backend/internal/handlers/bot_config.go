package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	ai "github.com/dhindsa/project-management/internal/services/ai"
	"github.com/dhindsa/project-management/internal/services/youtrack"
	"github.com/gorilla/mux"
)

// BotConfigHandler handles bot configuration API requests
type BotConfigHandler struct {
	botRepo      *database.BotConfigRepository
	settingsRepo *database.SettingsRepository
}

// NewBotConfigHandler creates a new BotConfigHandler
func NewBotConfigHandler() *BotConfigHandler {
	return &BotConfigHandler{
		botRepo:      database.NewBotConfigRepository(),
		settingsRepo: database.NewSettingsRepository(),
	}
}

// ListBots returns all bot configurations from DB.
// All default configs are seeded at startup via migrations, so this always reads from DB.
func (h *BotConfigHandler) ListBots(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	if database.GetPool() == nil {
		sendJSON(w, http.StatusOK, Response{Success: true, Data: []interface{}{}})
		return
	}

	configs, err := h.botRepo.List(r.Context())
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: "Failed to fetch bot configs"})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    configs,
	})
}

// GetBot returns a single bot configuration
func (h *BotConfigHandler) GetBot(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	botID := vars["id"]

	config, err := h.botRepo.GetByID(r.Context(), botID)
	if err != nil {
		sendJSON(w, http.StatusNotFound, Response{Success: false, Message: "Bot not found"})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    config,
	})
}

// CreateBot creates a new bot configuration
func (h *BotConfigHandler) CreateBot(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	var req models.CreateBotConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "Invalid request body"})
		return
	}

	if req.Name == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "Name is required"})
		return
	}

	if req.BotType == "" {
		req.BotType = models.BotTypeCustom
	}
	if req.Variables == "" {
		req.Variables = "[]"
	}

	config := &models.BotConfig{
		Name:        req.Name,
		Description: req.Description,
		BotType:     req.BotType,
		Prompt:      req.Prompt,
		Variables:   req.Variables,
		IsActive:    true,
		CreatedBy:   user.ID,
	}

	if err := h.botRepo.Create(r.Context(), config); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to create bot: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusCreated, Response{
		Success: true,
		Data:    config,
		Message: "Bot created successfully",
	})
}

// UpdateBot updates a bot configuration
func (h *BotConfigHandler) UpdateBot(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	botID := vars["id"]

	config, err := h.botRepo.GetByID(r.Context(), botID)
	if err != nil {
		sendJSON(w, http.StatusNotFound, Response{Success: false, Message: "Bot not found"})
		return
	}

	var req models.UpdateBotConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "Invalid request body"})
		return
	}

	if req.Name != nil {
		config.Name = *req.Name
	}
	if req.Description != nil {
		config.Description = *req.Description
	}
	if req.Prompt != nil {
		config.Prompt = *req.Prompt
	}
	if req.Variables != nil {
		config.Variables = *req.Variables
	}
	if req.IsActive != nil {
		config.IsActive = *req.IsActive
	}

	if err := h.botRepo.Update(r.Context(), config); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to update bot",
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    config,
		Message: "Bot updated successfully",
	})
}

// DeleteBot deletes a bot configuration
func (h *BotConfigHandler) DeleteBot(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	botID := vars["id"]

	if err := h.botRepo.Delete(r.Context(), botID); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to delete bot",
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Bot deleted successfully",
	})
}

// GetTemplates returns available bot templates
func (h *BotConfigHandler) GetTemplates(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    getDefaultTemplates(),
	})
}

// getYouTrackClientForBots creates a YouTrack client using per-user integration → env vars.
func (h *BotConfigHandler) getYouTrackClientForBots(r *http.Request) (*youtrack.Client, error) {
	ctx := r.Context()
	var baseURL, token, projectID, boardID string

	// 1. Per-user integration
	if userID := middleware.GetUserID(ctx); userID != "" {
		if integ, err := h.settingsRepo.GetYouTrackIntegration(ctx, userID); err == nil && integ != nil && integ.Connected {
			baseURL = integ.BaseURL
			token = integ.Token
			projectID = integ.ProjectID
			boardID = integ.BoardID
		}
	}

	// 2. Env vars as last resort
	if baseURL == "" {
		baseURL = os.Getenv("YOUTRACK_BASE_URL")
	}
	if token == "" {
		token = os.Getenv("YOUTRACK_TOKEN")
	}
	if projectID == "" {
		projectID = os.Getenv("YOUTRACK_PROJECT_ID")
	}
	if boardID == "" {
		boardID = os.Getenv("YOUTRACK_BOARD_ID")
	}

	if baseURL == "" || token == "" || projectID == "" {
		return nil, fmt.Errorf("YouTrack not configured")
	}
	client := youtrack.NewClient(baseURL, token, projectID)
	if boardID != "" {
		client.SetBoardID(boardID)
	}
	return client, nil
}

// GetStageColumns returns available YouTrack states/columns for the stage report
func (h *BotConfigHandler) GetStageColumns(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	client, err := h.getYouTrackClientForBots(r)
	if err != nil || client == nil {
		sendJSON(w, http.StatusOK, Response{Success: true, Data: []string{}})
		return
	}

	names, err := deploymentColumnNames(r.Context(), client)
	if err != nil {
		sendJSON(w, http.StatusOK, Response{Success: true, Data: []string{}})
		return
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: names})
}

// stageReportRequest is the request body for GenerateStageReport
type stageReportRequest struct {
	Columns []string `json:"columns"`
}

// GenerateStageReport fetches tickets from selected columns and generates a Slack-style deployment report
func (h *BotConfigHandler) GenerateStageReport(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	var req stageReportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Columns) == 0 {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "Provide at least one column"})
		return
	}

	client, err := h.getYouTrackClientForBots(r)
	if err != nil || client == nil {
		sendJSON(w, http.StatusServiceUnavailable, Response{Success: false, Message: "YouTrack not configured"})
		return
	}

	issues, err := client.GetIssuesByState(r.Context(), req.Columns)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: "Failed to fetch issues: " + err.Error()})
		return
	}

	if len(issues) == 0 {
		sendJSON(w, http.StatusOK, Response{
			Success: true,
			Data:    map[string]interface{}{"report": "", "issue_count": 0},
		})
		return
	}

	// Load system prompt from active stage_report bot config, fall back to default
	systemPrompt := `You are writing bullet points for a Slack deployment update.
Write ONE short sentence (max 15 words) describing what was fixed, in past tense, from the user's perspective.
- Be specific and direct — name the exact feature or interaction that changed
- Vary your sentence starts naturally (can use "Fixed", "Mic no longer...", "Users can now...", etc.)
- No internal jargon, no ticket IDs, no padding
- Output ONLY the single sentence, nothing else`

	bots, _ := h.botRepo.GetByType(r.Context(), models.BotTypeStageReport)
	for _, b := range bots {
		if b.IsActive && strings.TrimSpace(b.Prompt) != "" {
			systemPrompt = b.Prompt
			break
		}
	}

	// Group issues by subsystem, generating AI fix descriptions
	type fixItem struct {
		subsystem string
		fix       string
	}
	var fixes []fixItem

	for _, issue := range issues {
		subsystem := youtrack.GetSubsystem(issue)
		if subsystem == "" {
			subsystem = "General"
		}

		// Extract expected behavior from description, fall back to full description
		context := extractExpectedBehavior(issue.Description)
		if context == "" {
			context = issue.Description
		}
		if len(context) > 800 {
			context = context[:800]
		}

		userMsg := fmt.Sprintf("Ticket: %s\nContext: %s", issue.Summary, context)
		fixText, err := ai.QueryWithContext(r.Context(), systemPrompt, userMsg)
		if err != nil || strings.TrimSpace(fixText) == "" {
			fixText = issue.Summary
		}
		fixText = strings.TrimSpace(fixText)

		fixes = append(fixes, fixItem{subsystem: subsystem, fix: fixText})
	}

	// Group by subsystem preserving insertion order
	subsystemOrder := []string{}
	subsystemMap := map[string][]string{}
	for _, f := range fixes {
		if _, exists := subsystemMap[f.subsystem]; !exists {
			subsystemOrder = append(subsystemOrder, f.subsystem)
		}
		subsystemMap[f.subsystem] = append(subsystemMap[f.subsystem], f.fix)
	}

	// Build Slack-style report
	var sb strings.Builder
	sb.WriteString("Hey team :wave: here is the list of fixes which have been deployed to STAGE today:\n")
	for _, sub := range subsystemOrder {
		sb.WriteString(fmt.Sprintf("\n%s\n", sub))
		for _, fix := range subsystemMap[sub] {
			sb.WriteString(fmt.Sprintf("• %s\n", fix))
		}
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"report":      strings.TrimRight(sb.String(), "\n"),
			"issue_count": len(issues),
		},
	})
}

// extractExpectedBehavior parses a YouTrack description for an "Expected Behavior" section
func extractExpectedBehavior(description string) string {
	if description == "" {
		return ""
	}
	lower := strings.ToLower(description)
	headings := []string{
		"## expected behavior",
		"**expected behavior**",
		"expected behavior:",
		"expected behaviour:",
		"## expected behaviour",
	}
	for _, h := range headings {
		idx := strings.Index(lower, h)
		if idx == -1 {
			continue
		}
		// Start after the heading line
		start := idx + len(h)
		// Skip whitespace/newline
		for start < len(description) && (description[start] == '\n' || description[start] == '\r' || description[start] == ' ') {
			start++
		}
		// Find the next heading (##, **) or end of string
		rest := description[start:]
		end := len(rest)
		for _, stopMarker := range []string{"\n##", "\n**", "\n---"} {
			if i := strings.Index(rest, stopMarker); i != -1 && i < end {
				end = i
			}
		}
		extracted := strings.TrimSpace(rest[:end])
		if extracted != "" {
			return extracted
		}
	}
	return ""
}

// getDefaultTemplates returns the built-in bot templates
func getDefaultTemplates() []map[string]interface{} {
	return []map[string]interface{}{
		{
			"id":          "template-slack-analysis",
			"name":        "Slack Task Analysis",
			"description": "Analyzes Slack messages to determine task completion status",
			"bot_type":    "slack_analysis",
			"is_active":   true,
			"prompt": `Analyze the following Slack messages from channel {{$CHANNEL$}} for date {{$DATE$}}.

Morning task assignments:
{{$MORNING_MESSAGES$}}

Evening status updates:
{{$EVENING_MESSAGES$}}

For each team member, determine:
1. Which tasks were assigned in the morning
2. Which tasks were reported as completed in the evening
3. Which tasks are still pending
4. Any new tasks that were added during the day

Return a JSON response with team_members array containing name, assigned_tasks, completed_tasks, pending_tasks, new_tasks, and notes.`,
			"variables": `[{"name":"CHANNEL","label":"Slack Channel","type":"text","default":"#ardoise-platform","required":true},{"name":"DATE","label":"Date","type":"date","default":"today","required":true},{"name":"MORNING_MESSAGES","label":"Morning Messages","type":"text","default":"","required":false,"description":"Auto-filled from Slack"},{"name":"EVENING_MESSAGES","label":"Evening Messages","type":"text","default":"","required":false,"description":"Auto-filled from Slack"}]`,
		},
		{
			"id":          "template-daily-report",
			"name":        "Daily Report Generator",
			"description": "Generates formatted daily task reports for Slack",
			"bot_type":    "daily_report",
			"is_active":   true,
			"prompt": "Generate a daily task report for {{$DATE$}} for team {{$TEAM_NAME$}}.\n\nCurrent tasks by team member:\n{{$TASK_DATA$}}\n\nFormat as a Slack message with backtick headers and bullet points.",
			"variables": `[{"name":"DATE","label":"Date","type":"date","default":"today","required":true},{"name":"TEAM_NAME","label":"Team Name","type":"text","default":"Ardoise Platform","required":true},{"name":"TASK_DATA","label":"Task Data","type":"text","default":"","required":false,"description":"Auto-filled from task database"}]`,
		},
		{
			"id":          "template-custom",
			"name":        "Custom Bot",
			"description": "Create your own bot with custom prompts and variables",
			"bot_type":    "custom",
			"is_active":   true,
			"prompt":      "Your custom prompt here. Use {{$VARIABLE_NAME$}} for variables.",
			"variables":   `[]`,
		},
		{
			"id":          "template-deployment-report",
			"name":        "Asana Deployment Report",
			"description": "Generates client-facing deployment reports from Asana tickets. Rewrites each ticket title into a polished user-facing fix statement, grouped by platform (UI, Studio, Mission Control, Backend).",
			"bot_type":    "deployment_report",
			"is_active":   true,
			"prompt": `You are a technical writer creating client-facing deployment reports.

You will receive a ticket title and description. The description may be a rough internal note written by a developer (e.g. "is now fixed", "added support for X").

Your job is to rewrite it as a single polished, professional fix statement for a client deployment report. Rules:
- Write in past tense, from the user's perspective (what they now experience)
- Be 1-2 sentences. Do not pad or over-explain.
- Remove ALL internal prefixes: priority tags (P0, P1, A2, etc.), platform tags (FE, BE, UI, MC, Studio), ticket IDs, and jargon
- Start with the subject of what changed (e.g. "The restart conversation button...", "Avatar playback...")
- If the description already says what was fixed clearly, use it as the basis — do not invent details
- Sound polished and client-ready

Respond with ONLY the fix statement. No preamble, no labels, no quotes.`,
			"variables": `[]`,
		},
		{
			"id":          "template-stage-report",
			"name":        "Stage Deployment Report",
			"description": "Generates a Slack-ready list of fixes for a stage deployment. The AI rewrites each ticket title into a user-facing past-tense fix description, grouped by subsystem.",
			"bot_type":    "stage_report",
			"is_active":   true,
			"prompt": `You are writing bullet points for a Slack deployment update.
Write ONE short sentence (max 15 words) describing what was fixed, in past tense, from the user's perspective.
- Be specific and direct — name the exact feature or interaction that changed
- Vary your sentence starts naturally (can use "Fixed", "Mic no longer...", "Users can now...", etc.)
- No internal jargon, no ticket IDs, no padding
- Output ONLY the single sentence, nothing else

Example input:
Ticket: FE UI: Fix mic issue when released spacebar the mic still remains activated
Context: When user releases the spacebar the microphone should deactivate

Example output:
Mic no longer stays activated after releasing the spacebar.`,
			"variables": `[]`,
		},
		{
			"id":          "template-pm-assistant",
			"name":        "PM Assistant",
			"description": "Custom instructions for the PM Assistant chat. Live YouTrack + time tracking data is injected automatically.",
			"bot_type":    "pm_assistant",
			"is_active":   true,
			"prompt": `You are a PM Assistant for a software development team.

## Your Role
Answer questions about YouTrack issues and time tracking data provided below. Be concise and accurate.

## Assignee Task Format
When asked for tasks assigned to a specific person, ALWAYS respond in this exact format:

@{assignee_name}

{Status}:
{issueID} {summary}

Group by status (Backlog, In Progress, Blocked, DEV, Done). One ticket per line. No tables, no pipes, no extra metadata.

Example:
@simranjot

In Progress:
3-671 FE Studio: UI theme text issue
ARD-801 API refactor

Blocked:
3-896 FE UI: Mic remains activated when holding spacebar

## General Format
- Use bullet points for lists
- Use tables only for multi-column comparisons
- Bold (**text**) for important flags (OVERDUE, MOVED BACK)
- Group data by assignee when showing team workload

## Key Rules
- OVERDUE = ticket's time in In Progress exceeds its priority threshold (P0:4h P1:24h P2:48h Other:72h)
- MOVED BACK = ticket transitioned to a less-advanced state (e.g. DEV→In Progress, In Progress→Backlog) — treat as regression
- PINNED = PM has manually flagged as important — always mention first
- If a query is ambiguous, make reasonable assumptions and state them

Today's date: {{DATE}}`,
			"variables": `[{"name":"DATE","label":"Today's Date","type":"date","default":"today","required":false,"description":"Auto-substituted with today's date"}]`,
		},
	}
}
