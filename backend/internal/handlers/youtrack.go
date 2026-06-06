package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	"github.com/dhindsa/project-management/internal/services/ai"
	"github.com/dhindsa/project-management/internal/services/youtrack"
	"github.com/gorilla/mux"
)

// YouTrackHandler handles YouTrack integration API requests
type YouTrackHandler struct {
	taskRepo     *database.TaskRepository
	projectRepo  *database.ProjectRepository
	settingsRepo *database.SettingsRepository
	sectionRepo  *database.SectionRepository
	reportRepo   *database.ReportRepository
	configRepo   *database.WorkflowConfigRepository
	dayTrackRepo *database.DayTrackRepository
	notifHandler *NotificationHandler
	sseHub       *SSEHub
}

// NewYouTrackHandler creates a new YouTrack handler
func NewYouTrackHandler(sseHub ...*SSEHub) *YouTrackHandler {
	h := &YouTrackHandler{
		taskRepo:     database.NewTaskRepository(),
		projectRepo:  database.NewProjectRepository(),
		settingsRepo: database.NewSettingsRepository(),
		sectionRepo:  database.NewSectionRepository(),
		reportRepo:   database.NewReportRepository(),
		configRepo:   database.NewWorkflowConfigRepository(),
		dayTrackRepo: database.NewDayTrackRepository(),
	}
	if len(sseHub) > 0 {
		h.sseHub = sseHub[0]
	}
	return h
}

// SetNotificationHandler wires the notification handler for overdue alerts
func (h *YouTrackHandler) SetNotificationHandler(notifHandler *NotificationHandler) {
	h.notifHandler = notifHandler
}

// getYouTrackClient creates a YouTrack client — checks per-user DB first, then
// global settings DB, then environment variables as last resort.
func (h *YouTrackHandler) getYouTrackClient(ctx context.Context) (*youtrack.Client, error) {
	return h.getYouTrackClientForUser(ctx, middleware.GetUserID(ctx))
}

func (h *YouTrackHandler) getYouTrackClientForUser(ctx context.Context, userID string) (*youtrack.Client, error) {
	var baseURL, token, projectID, boardID string

	// 1. Per-user DB integration
	if userID != "" {
		if integration, err := h.settingsRepo.GetYouTrackIntegration(ctx, userID); err == nil && integration != nil && integration.Connected {
			baseURL = integration.BaseURL
			token = integration.Token
			projectID = integration.ProjectID
			boardID = integration.BoardID
		}
	}

	// 2. Admin fallback for members/viewers
	if baseURL == "" {
		if u := middleware.GetUserFromCtx(ctx); u != nil && (u.Role == models.RoleMember || u.Role == models.RoleViewer) {
			if adminInteg, err := h.settingsRepo.GetAdminYouTrackIntegration(ctx); err == nil && adminInteg != nil && adminInteg.Connected {
				baseURL = adminInteg.BaseURL
				token = adminInteg.Token
				projectID = adminInteg.ProjectID
				boardID = adminInteg.BoardID
			}
		}
	}

	// 3. Global settings DB (org-wide fallback)
	if baseURL == "" {
		if settings, err := h.settingsRepo.GetYouTrackSettings(ctx); err == nil && settings != nil && settings.Configured {
			baseURL = settings.BaseURL
			token = settings.Token
			projectID = settings.ProjectID
			boardID = settings.BoardID
		}
	}

	// 3. Environment variables (last resort)
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
		return nil, nil // Not configured
	}

	client := youtrack.NewClient(baseURL, token, projectID)
	if boardID != "" {
		client.SetBoardID(boardID)
	}
	return client, nil
}

// GetStatus returns the current YouTrack connection status including non-sensitive config
func (h *YouTrackHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Collect the resolved config values (for display, no token)
	var baseURL, projectID, boardID string
	var source string // "user_db" | "global_db" | "env"

	if userID != "" {
		if integration, err := h.settingsRepo.GetYouTrackIntegration(r.Context(), userID); err == nil && integration != nil && integration.Connected {
			baseURL = integration.BaseURL
			projectID = integration.ProjectID
			boardID = integration.BoardID
			source = "user_db"
		}
	}
	if baseURL == "" {
		if settings, err := h.settingsRepo.GetYouTrackSettings(r.Context()); err == nil && settings != nil && settings.Configured {
			baseURL = settings.BaseURL
			projectID = settings.ProjectID
			boardID = settings.BoardID
			source = "global_db"
		}
	}
	if baseURL == "" {
		baseURL = os.Getenv("YOUTRACK_BASE_URL")
		projectID = os.Getenv("YOUTRACK_PROJECT_ID")
		boardID = os.Getenv("YOUTRACK_BOARD_ID")
		if baseURL != "" {
			source = "env"
		}
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"connected":  false,
			"configured": false,
		})
		return
	}

	// Test connection
	err = client.TestConnection(r.Context())
	connected := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"connected":  connected,
		"configured": true,
		"error":      errMsg,
		"base_url":   baseURL,
		"project_id": projectID,
		"board_id":   boardID,
		"source":     source, // "user_db" | "global_db" | "env"
	})
}

// TestConnection tests the YouTrack connection with provided credentials
func (h *YouTrackHandler) TestConnection(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		BaseURL   string `json:"base_url"`
		Token     string `json:"token"`
		ProjectID string `json:"project_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client := youtrack.NewClient(req.BaseURL, req.Token, req.ProjectID)
	err := client.TestConnection(r.Context())
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   err.Error(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Connection successful",
	})
}

// GetProjects returns available YouTrack projects
func (h *YouTrackHandler) GetProjects(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	projects, err := client.GetProjects(r.Context())
	if err != nil {
		http.Error(w, "Failed to get projects: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    projects,
	})
}

// GetSprints returns all sprints for the configured agile board
func (h *YouTrackHandler) GetSprints(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	sprintsCacheKey := "sprints:" + userID
	if cached, ok := apiCache.Get(sprintsCacheKey); ok {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": cached})
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	sprints, err := client.GetSprints(r.Context())
	if err != nil {
		http.Error(w, "Failed to get sprints: "+err.Error(), http.StatusInternalServerError)
		return
	}

	apiCache.Set(sprintsCacheKey, sprints, 10*time.Minute)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    sprints,
	})
}

// GetBoards returns available YouTrack agile boards
func (h *YouTrackHandler) GetBoards(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	boards, err := client.GetBoards(r.Context())
	if err != nil {
		http.Error(w, "Failed to get boards: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    boards,
	})
}

// GetStates returns workflow states for the configured project
func (h *YouTrackHandler) GetStates(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	states, err := client.GetStates(r.Context())
	if err != nil {
		http.Error(w, "Failed to get states: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    states,
	})
}

// GetPriorities returns the Priority field values from YouTrack
func (h *YouTrackHandler) GetPriorities(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	priorities, err := client.GetPriorities(r.Context())
	if err != nil {
		http.Error(w, "Failed to get priorities: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    priorities,
	})
}

// GetBoardColumns returns columns from a specific agile board
func (h *YouTrackHandler) GetBoardColumns(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	boardID := vars["board_id"]

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	columns, err := client.GetBoardColumns(r.Context(), boardID)
	if err != nil {
		http.Error(w, "Failed to get columns: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    columns,
	})
}

// GetTypeFieldValues returns possible enum values for a named custom field (e.g. "Type").
// Used by the Hotfix Rules UI to populate Hotfix/Regression value selectors.
// Query param: ?field_name=Type
func (h *YouTrackHandler) GetTypeFieldValues(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	fieldName := r.URL.Query().Get("field_name")
	if fieldName == "" {
		fieldName = "Type"
	}
	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}
	values, err := client.GetCustomFieldValues(r.Context(), fieldName)
	if err != nil {
		http.Error(w, "Failed to get field values: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    values,
	})
}

// GetDefaultBoardColumns returns columns from the auto-resolved project board (no board ID needed).
func (h *YouTrackHandler) GetDefaultBoardColumns(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}
	boardID, err := client.ResolveBoard(r.Context())
	if err != nil {
		http.Error(w, "Failed to resolve board: "+err.Error(), http.StatusInternalServerError)
		return
	}
	columns, err := client.GetBoardColumns(r.Context(), boardID)
	if err != nil {
		http.Error(w, "Failed to get columns: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    columns,
	})
}

// GetUsers returns all YouTrack users
func (h *YouTrackHandler) GetUsers(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	users, err := client.GetUsers(r.Context())
	if err != nil {
		http.Error(w, "Failed to get users: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Rewrite avatar URLs to go through our proxy (YouTrack Hub requires auth)
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	baseProxyURL := scheme + "://" + r.Host + "/api/youtrack/proxy?url="
	for i := range users {
		if users[i].AvatarUrl != "" {
			users[i].AvatarUrl = baseProxyURL + url.QueryEscape(base64.StdEncoding.EncodeToString([]byte(users[i].AvatarUrl)))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    users,
	})
}

// GetIssues returns issues from the configured project.
// Supports optional query params: state (column name), skip (offset), top (page size, default 20).
// When state is provided, returns paginated results for that column with a hasMore flag.
// Without state, returns all issues (legacy behaviour used by non-board callers).
func (h *YouTrackHandler) GetIssues(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	state := r.URL.Query().Get("state")

	// ── Paginated per-column fetch ────────────────────────────────────────────
	if state != "" {
		skip, _ := strconv.Atoi(r.URL.Query().Get("skip"))
		top, _ := strconv.Atoi(r.URL.Query().Get("top"))
		if top <= 0 {
			top = 20
		}
		sprintID := r.URL.Query().Get("sprint_id")

		var issues []youtrack.Issue
		var hasMore bool
		var err error
		if sprintID != "" {
			issues, hasMore, err = client.GetSprintIssuesByStatePaginated(r.Context(), sprintID, state, skip, top)
		} else {
			issues, hasMore, err = client.GetIssuesByStatePaginated(r.Context(), state, skip, top)
		}
		if err != nil {
			http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
			return
		}

		baseURL := client.GetBaseURL()
		transformed := make([]map[string]interface{}, 0, len(issues))
		for _, issue := range issues {
			assignee := youtrack.GetAssignee(issue)
			if assignee != nil && assignee.AvatarUrl != "" && !strings.HasPrefix(assignee.AvatarUrl, "http") {
				assignee.AvatarUrl = baseURL + assignee.AvatarUrl
			}
			transformed = append(transformed, map[string]interface{}{
				"id":          issue.ID,
				"idReadable":  issue.IDReadable,
				"summary":     issue.Summary,
				"description": issue.Description,
				"status":      youtrack.GetStatus(issue),
				"subsystem":   youtrack.GetSubsystem(issue),
				"priority":    youtrack.GetPriority(issue),
				"assignee":    assignee,
				"created":     issue.Created,
				"updated":     issue.Updated,
				"attachments": issue.Attachments,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"data": map[string]interface{}{
				"issues":  transformed,
				"hasMore": hasMore,
			},
		})
		return
	}

	// ── All issues (optionally filtered by sprint) ────────────────────────────
	sprintIDAll := r.URL.Query().Get("sprint_id")
	var issues []youtrack.Issue
	if sprintIDAll != "" {
		issues, err = client.GetAllSprintIssues(r.Context(), sprintIDAll)
	} else {
		issues, err = client.GetIssues(r.Context())
	}
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	baseURL := client.GetBaseURL()
	var response []map[string]interface{}
	for _, issue := range issues {
		assignee := youtrack.GetAssignee(issue)
		if assignee != nil && assignee.AvatarUrl != "" && !strings.HasPrefix(assignee.AvatarUrl, "http") {
			assignee.AvatarUrl = baseURL + assignee.AvatarUrl
		}
		response = append(response, map[string]interface{}{
			"id":          issue.ID,
			"summary":     issue.Summary,
			"description": issue.Description,
			"status":      youtrack.GetStatus(issue),
			"subsystem":   youtrack.GetSubsystem(issue),
			"priority":    youtrack.GetPriority(issue),
			"assignee":    assignee,
			"created":     issue.Created,
			"updated":     issue.Updated,
			"attachments": issue.Attachments,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    response,
	})
}

// GetIssue returns a single issue by ID
func (h *YouTrackHandler) GetIssue(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	issueID := vars["issue_id"]

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	issue, err := client.GetIssue(r.Context(), issueID)
	if err != nil {
		http.Error(w, "Failed to get issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	assignee := youtrack.GetAssignee(*issue)
	if assignee != nil && assignee.AvatarUrl != "" && !strings.HasPrefix(assignee.AvatarUrl, "http") {
		assignee.AvatarUrl = client.GetBaseURL() + assignee.AvatarUrl
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"id":          issue.ID,
			"idReadable":  issue.IDReadable,
			"summary":     issue.Summary,
			"description": issue.Description,
			"status":      youtrack.GetStatus(*issue),
			"subsystem":   youtrack.GetSubsystem(*issue),
			"priority":    youtrack.GetPriority(*issue),
			"type":        youtrack.GetCustomFieldValue(*issue, "Type"),
			"assignee":    assignee,
			"created":     issue.Created,
			"updated":     issue.Updated,
			"attachments": issue.Attachments,
		},
	})
}

// GetIssueComments returns all comments for an issue with full author info
func (h *YouTrackHandler) GetIssueComments(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}
	issueID := mux.Vars(r)["issue_id"]
	comments, err := client.GetIssueCommentsFull(r.Context(), issueID)
	if err != nil {
		http.Error(w, "Failed to get comments: "+err.Error(), http.StatusInternalServerError)
		return
	}
	baseURL := client.GetBaseURL()
	for i := range comments {
		if comments[i].Author.AvatarUrl != "" && !strings.HasPrefix(comments[i].Author.AvatarUrl, "http") {
			comments[i].Author.AvatarUrl = baseURL + comments[i].Author.AvatarUrl
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": comments})
}

// AddIssueComment posts a new comment on an issue
func (h *YouTrackHandler) AddIssueComment(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}
	issueID := mux.Vars(r)["issue_id"]
	var req struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Text == "" {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if err := client.AddIssueComment(r.Context(), issueID, req.Text); err != nil {
		http.Error(w, "Failed to add comment: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

// ProxyAttachment fetches a YouTrack attachment using the stored token and streams it back.
// This is needed because YouTrack attachment URLs require Bearer auth that the browser can't provide.
func (h *YouTrackHandler) ProxyAttachment(w http.ResponseWriter, r *http.Request) {
	encodedURL := r.URL.Query().Get("url")
	if encodedURL == "" {
		http.Error(w, "Missing url param", http.StatusBadRequest)
		return
	}
	rawBytes, err := base64.StdEncoding.DecodeString(encodedURL)
	if err != nil {
		http.Error(w, "Invalid url encoding", http.StatusBadRequest)
		return
	}
	rawURL := string(rawBytes)

	// For image proxying, the browser sends no JWT — fall back to admin integration
	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		// Try admin integration directly (covers unauthenticated <img> loads)
		if adminInteg, aerr := h.settingsRepo.GetAdminYouTrackIntegration(r.Context()); aerr == nil && adminInteg != nil && adminInteg.Connected {
			c := youtrack.NewClient(adminInteg.BaseURL, adminInteg.Token, adminInteg.ProjectID)
			client = c
		}
	}
	if client == nil {
		http.Error(w, "YouTrack not configured", http.StatusBadRequest)
		return
	}

	// If the attachment URL is relative (e.g. /api/files/...), make it absolute
	if strings.HasPrefix(rawURL, "/") {
		rawURL = strings.TrimRight(client.GetBaseURL(), "/") + rawURL
	}

	// Security: only proxy URLs from the configured YouTrack instance
	if !strings.HasPrefix(rawURL, client.GetBaseURL()) {
		http.Error(w, "URL not allowed", http.StatusForbidden)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, rawURL, nil)
	if err != nil {
		http.Error(w, "Failed to build request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+client.GetToken())

	// Forward Range header so video seeking works
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "Failed to fetch from YouTrack", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Forward relevant response headers
	for _, hdr := range []string{
		"Content-Type", "Content-Length", "Content-Range",
		"Accept-Ranges", "Last-Modified", "ETag",
	} {
		if v := resp.Header.Get(hdr); v != "" {
			w.Header().Set(hdr, v)
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	// Prevents CORB — allows cross-origin <img> tags to load this proxied resource
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// CreateIssue creates a new issue in YouTrack
func (h *YouTrackHandler) CreateIssue(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Summary           string `json:"summary"`
		Description       string `json:"description"`
		State             string `json:"state,omitempty"`
		Priority          string `json:"priority,omitempty"`
		TypeName          string `json:"type_name,omitempty"`
		AssigneeLogin     string `json:"assignee_login,omitempty"`
		Subsystem         string `json:"subsystem,omitempty"`
		SprintID          string `json:"sprint_id,omitempty"`
		DueDate           *int64 `json:"due_date,omitempty"`
		EstimationMinutes *int   `json:"estimation_minutes,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	createReq := youtrack.CreateIssueRequest{
		Summary:     req.Summary,
		Description: req.Description,
	}

	var fields []youtrack.CustomField
	if req.State != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "StateIssueCustomField",
			Name:  "State",
			Value: map[string]string{"name": req.State},
		})
	}
	if req.Priority != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleEnumIssueCustomField",
			Name:  "Priority",
			Value: map[string]string{"name": req.Priority},
		})
	}
	if req.TypeName != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleEnumIssueCustomField",
			Name:  "Type",
			Value: map[string]string{"name": req.TypeName},
		})
	}
	if req.AssigneeLogin != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleUserIssueCustomField",
			Name:  "Assignee",
			Value: map[string]string{"login": req.AssigneeLogin},
		})
	}
	if req.Subsystem != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleOwnedIssueCustomField",
			Name:  "Subsystem",
			Value: map[string]interface{}{"$type": "OwnedBundleElement", "name": req.Subsystem},
		})
	}
	if req.DueDate != nil {
		fields = append(fields, youtrack.CustomField{
			Type:  "DateIssueCustomField",
			Name:  "Due Date",
			Value: *req.DueDate,
		})
	}
	if req.EstimationMinutes != nil {
		fields = append(fields, youtrack.CustomField{
			Type:  "PeriodIssueCustomField",
			Name:  "Estimation",
			Value: map[string]interface{}{"minutes": *req.EstimationMinutes},
		})
	}
	if len(fields) > 0 {
		createReq.CustomFields = fields
	}

	issue, err := client.CreateIssue(r.Context(), createReq)
	if err != nil {
		http.Error(w, "Failed to create issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Assign to sprint if requested (best-effort — don't fail the whole create)
	if req.SprintID != "" && issue != nil && issue.ID != "" {
		go func() {
			ctx2 := context.Background()
			if addErr := client.AddIssueToSprint(ctx2, req.SprintID, issue.ID); addErr != nil {
				log.Printf("failed to add issue %s to sprint %s: %v", issue.ID, req.SprintID, addErr)
			}
		}()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    issue,
	})
}

// UpdateIssue updates an existing issue
func (h *YouTrackHandler) UpdateIssue(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	issueID := vars["issue_id"]

	var req struct {
		Summary           string `json:"summary,omitempty"`
		Description       string `json:"description,omitempty"`
		State             string `json:"state,omitempty"`
		Priority          string `json:"priority,omitempty"`
		TypeName          string `json:"type_name,omitempty"`
		AssigneeLogin     string `json:"assignee_login,omitempty"`
		Subsystem         string `json:"subsystem,omitempty"`
		SprintID          string `json:"sprint_id,omitempty"`
		DueDate           *int64 `json:"due_date,omitempty"`
		EstimationMinutes *int   `json:"estimation_minutes,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	updateReq := youtrack.UpdateIssueRequest{
		Summary:     req.Summary,
		Description: req.Description,
	}

	var fields []youtrack.CustomField
	if req.State != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "StateIssueCustomField",
			Name:  "State",
			Value: map[string]string{"name": req.State},
		})
	}
	if req.Priority != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleEnumIssueCustomField",
			Name:  "Priority",
			Value: map[string]string{"name": req.Priority},
		})
	}
	if req.TypeName != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleEnumIssueCustomField",
			Name:  "Type",
			Value: map[string]string{"name": req.TypeName},
		})
	}
	if req.AssigneeLogin != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleUserIssueCustomField",
			Name:  "Assignee",
			Value: map[string]string{"login": req.AssigneeLogin},
		})
	}
	if req.Subsystem != "" {
		fields = append(fields, youtrack.CustomField{
			Type:  "SingleOwnedIssueCustomField",
			Name:  "Subsystem",
			Value: map[string]interface{}{"$type": "OwnedBundleElement", "name": req.Subsystem},
		})
	}
	if req.DueDate != nil {
		fields = append(fields, youtrack.CustomField{
			Type:  "DateIssueCustomField",
			Name:  "Due Date",
			Value: *req.DueDate,
		})
	}
	if req.EstimationMinutes != nil {
		fields = append(fields, youtrack.CustomField{
			Type:  "PeriodIssueCustomField",
			Name:  "Estimation",
			Value: map[string]interface{}{"minutes": *req.EstimationMinutes},
		})
	}
	if len(fields) > 0 {
		updateReq.CustomFields = fields
	}

	issue, err := client.UpdateIssue(r.Context(), issueID, updateReq)
	if err != nil {
		http.Error(w, "Failed to update issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    issue,
	})
}

// UpdateIssueState updates just the state of an issue
func (h *YouTrackHandler) UpdateIssueState(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	issueID := vars["issue_id"]

	var req struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	if err := client.UpdateIssueState(r.Context(), issueID, req.State); err != nil {
		http.Error(w, "Failed to update state: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "State updated successfully",
	})
}

// GetIssueFormMeta returns all dynamic data needed to render the Create Issue form in one call:
// states, priorities, types, subsystems, users, and sprints — all fetched in parallel.
func (h *YouTrackHandler) GetIssueFormMeta(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	type result struct {
		states           []youtrack.State
		priorities       []youtrack.PriorityValue
		types            []youtrack.PriorityValue
		subsystems       []youtrack.PriorityValue
		users            []youtrack.User
		sprints          []youtrack.Sprint
		developerConfigs []*database.DeveloperSubsystemConfig
	}
	var res result
	var mu sync.Mutex
	var wg sync.WaitGroup
	errs := make([]string, 0)

	fetch := func(fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := fn(); e != nil {
				mu.Lock()
				errs = append(errs, e.Error())
				mu.Unlock()
			}
		}()
	}

	fetch(func() error {
		v, e := client.GetStates(r.Context())
		if e == nil {
			mu.Lock(); res.states = v; mu.Unlock()
		}
		return e
	})
	fetch(func() error {
		v, e := client.GetPriorities(r.Context())
		if e == nil {
			mu.Lock(); res.priorities = v; mu.Unlock()
		}
		return e
	})
	fetch(func() error {
		v, e := client.GetCustomFieldValues(r.Context(), "Type")
		if e == nil {
			mu.Lock(); res.types = v; mu.Unlock()
		}
		return e
	})
	fetch(func() error {
		v, e := client.GetCustomFieldValues(r.Context(), "Subsystem")
		if e == nil {
			mu.Lock(); res.subsystems = v; mu.Unlock()
		}
		return e
	})
	fetch(func() error {
		v, e := client.GetUsers(r.Context())
		if e == nil {
			// Proxy avatar URLs
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			base := scheme + "://" + r.Host + "/api/youtrack/proxy?url="
			for i := range v {
				if v[i].AvatarUrl != "" {
					v[i].AvatarUrl = base + url.QueryEscape(base64.StdEncoding.EncodeToString([]byte(v[i].AvatarUrl)))
				}
			}
			mu.Lock(); res.users = v; mu.Unlock()
		}
		return e
	})
	fetch(func() error {
		v, e := client.GetSprints(r.Context())
		if e == nil {
			mu.Lock(); res.sprints = v; mu.Unlock()
		}
		return e
	})
	fetch(func() error {
		devRepo := database.NewDeveloperConfigRepository()
		v, e := devRepo.GetAll(r.Context())
		if e == nil {
			if v == nil {
				v = []*database.DeveloperSubsystemConfig{}
			}
			mu.Lock(); res.developerConfigs = v; mu.Unlock()
		}
		return e
	})

	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"states":            res.states,
			"priorities":        res.priorities,
			"types":             res.types,
			"subsystems":        res.subsystems,
			"users":             res.users,
			"sprints":           res.sprints,
			"developer_configs": res.developerConfigs,
			"errors":            errs,
		},
	})
}

// UploadIssueAttachment receives a multipart file from the frontend and proxies it to YouTrack.
func (h *YouTrackHandler) UploadIssueAttachment(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	issueID := mux.Vars(r)["issue_id"]
	if issueID == "" {
		http.Error(w, "issue_id required", http.StatusBadRequest)
		return
	}
	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "Failed to parse multipart: "+err.Error(), http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "No file in request: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	content, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Failed to read file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	if err := client.UploadAttachment(r.Context(), issueID, header.Filename, mimeType, content); err != nil {
		http.Error(w, "Failed to upload attachment: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

// AIParseTicket uses the AI provider to extract structured issue fields from raw natural-language text.
func (h *YouTrackHandler) AIParseTicket(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		RawText    string                   `json:"raw_text"`
		Users      []map[string]string      `json:"users"`      // [{login, fullName}]
		Types      []string                 `json:"types"`      // ["Bug","Feature",...]
		Subsystems []string                 `json:"subsystems"` // ["FE UI","BE API",...]
		Priorities []string                 `json:"priorities"` // ["Show-stopper","Critical",...]
		Sprints    []map[string]interface{} `json:"sprints"`    // [{id, name}]
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.RawText) == "" {
		http.Error(w, "raw_text is required", http.StatusBadRequest)
		return
	}

	usersJSON, _ := json.Marshal(req.Users)
	sprintsJSON, _ := json.Marshal(req.Sprints)

	// Load editable instructions from the ticket_parser bot config in DB.
	// The admin can customise the instructions; dynamic field values are always
	// appended here at runtime so the DB prompt never needs to list them.
	const defaultTicketParserInstructions = `You are a project management assistant. Convert raw text into a YouTrack ticket.

RESPOND ONLY WITH A SINGLE JSON OBJECT. No explanation, no markdown, no extra text — just JSON.

Title rules: "{subsystem}: {concise action-oriented description}" — max 80 chars, never copy raw text verbatim. The subsystem prefix MUST be copied EXACTLY from the available subsystems list — never invent or abbreviate. Do NOT include a priority prefix in the title. Examples of good titles: "FE UI: Handle Empty Transcribe Requests Gracefully", "FE MC: Courses Tab Fails to Open", "BE: Prevent Deletion During File Processing".

Description rules: 1-2 sentence overview of what is broken or missing, then "\n\n**Expected Behavior**\n- bullet\n- bullet". Remove filler words (okay, like, so, yeah, uh). For bugs: what is broken + what should happen. For features: what is missing + what should happen.

Priority: pick the closest match from the available priorities list — show-stopper/crash/data-loss → first option; completely broken → second; significant regression → third; standard bug → middle option; cosmetic → last. MUST be an exact string from the list.

CRITICAL: subsystem and type_name MUST exactly match values from the available lists — never invent or abbreviate. Both are REQUIRED.
assignee_login: match login from users list only if a person's name is mentioned, else "".
sprint_id: id of the most recent non-completed sprint from the sprints list, else "".`

	instructions := defaultTicketParserInstructions
	botRepo := database.NewBotConfigRepository()
	if bots, err2 := botRepo.GetByType(r.Context(), models.BotTypeTicketParser); err2 == nil {
		for _, b := range bots {
			if b.IsActive && strings.TrimSpace(b.Prompt) != "" {
				instructions = b.Prompt
				break
			}
		}
	}

	// Always append the dynamic runtime data — these are never editable in the DB
	// because they come live from YouTrack.
	systemPrompt := fmt.Sprintf(`%s

Available values — choose ONLY from these lists (return exact strings, no variations):
- priorities: %s
- types: %s
- subsystems: %s
- users (login → fullName): %s
- sprints: %s

Return ONLY this JSON object (no other text):
{"summary":"","description":"","priority":"","type_name":"","subsystem":"","assignee_login":"","sprint_id":""}`,
		instructions,
		strings.Join(req.Priorities, ", "),
		strings.Join(req.Types, ", "),
		strings.Join(req.Subsystems, ", "),
		string(usersJSON),
		string(sprintsJSON),
	)

	response, err := ai.QueryWithHistory(r.Context(), systemPrompt, nil, req.RawText)
	if err != nil {
		http.Error(w, "AI query failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Extract the first valid JSON object from the AI response.
	// Handles markdown fences, bold wrappers, leading prose, nested braces in descriptions.
	cleaned := extractFirstJSONObject(strings.TrimSpace(response))

	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		http.Error(w, "AI returned invalid JSON: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    parsed,
	})
}

// DeleteIssue deletes an issue from YouTrack
// extractFirstJSONObject finds the first complete, balanced JSON object in s.
// Handles markdown fences, bold wrappers, leading prose, and nested braces inside string values.
func extractFirstJSONObject(s string) string {
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		if runes[i] != '{' {
			continue
		}
		depth := 0
		inStr := false
		escaped := false
		for j := i; j < len(runes); j++ {
			c := runes[j]
			if escaped {
				escaped = false
				continue
			}
			if c == '\\' && inStr {
				escaped = true
				continue
			}
			if c == '"' {
				inStr = !inStr
				continue
			}
			if inStr {
				continue
			}
			if c == '{' {
				depth++
			} else if c == '}' {
				depth--
				if depth == 0 {
					return string(runes[i : j+1])
				}
			}
		}
	}
	return s
}

func (h *YouTrackHandler) DeleteIssue(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	issueID := vars["issue_id"]

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	if err := client.DeleteIssue(r.Context(), issueID); err != nil {
		http.Error(w, "Failed to delete issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Issue deleted successfully",
	})
}

// ImportFromYouTrack imports issues from YouTrack to local database
func (h *YouTrackHandler) ImportFromYouTrack(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured. Please configure YouTrack in Settings.", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// Get or create default project
	defaultProjectID, err := h.getOrCreateDefaultProject(ctx, userID)
	if err != nil {
		http.Error(w, "Failed to get/create default project: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Fetch states and save as sections
	states, err := client.GetStates(ctx)
	if err != nil {
		log.Printf("Warning: Failed to fetch YouTrack states: %v", err)
	} else {
		var sectionsToSave []models.AsanaSection
		for i, state := range states {
			sectionsToSave = append(sectionsToSave, models.AsanaSection{
				ProjectID:       defaultProjectID,
				AsanaSectionGID: state.Name, // Use state name as ID
				Name:            state.Name,
				Position:        i,
			})
		}
		if err := h.sectionRepo.SaveSections(ctx, defaultProjectID, sectionsToSave); err != nil {
			log.Printf("Warning: Failed to save sections: %v", err)
		} else {
			log.Printf("Synced %d states from YouTrack", len(sectionsToSave))
		}
	}

	// Get issues from YouTrack
	issues, err := client.GetIssues(ctx)
	if err != nil {
		http.Error(w, "Failed to fetch YouTrack issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var tasksCreated, tasksUpdated, tasksSynced int
	var errors []string

	for _, issue := range issues {
		// Check if task exists by YouTrack ID
		existingTask, err := h.taskRepo.GetByYouTrackID(ctx, issue.ID)
		if err != nil && !strings.Contains(err.Error(), "no rows") {
			errors = append(errors, "Error checking issue "+issue.ID+": "+err.Error())
			continue
		}

		status := h.mapYouTrackStatusToLocal(youtrack.GetStatus(issue))
		priority := h.mapYouTrackPriorityToLocal(youtrack.GetPriority(issue))
		stateName := youtrack.GetStatus(issue)

		if existingTask != nil {
			// Update existing
			existingTask.Title = issue.Summary
			existingTask.Description = issue.Description
			existingTask.Status = status
			existingTask.Priority = priority
			existingTask.SectionName = &stateName
			if err := h.taskRepo.Update(ctx, existingTask); err != nil {
				errors = append(errors, "Error updating task: "+err.Error())
				continue
			}
			tasksUpdated++
		} else {
			// Create new task
			createdTime := time.Unix(issue.Created/1000, 0)
			newTask := &models.Task{
				Title:        issue.Summary,
				Description:  issue.Description,
				Status:       status,
				Priority:     priority,
				ProjectID:    defaultProjectID,
				YouTrackID:   &issue.ID,
				SectionName:  &stateName,
				CreatedBy:    userID,
				CreatedAt:    createdTime,
			}

			// Set assignee if available
			if assignee := youtrack.GetAssignee(issue); assignee != nil {
				newTask.Assignee = &models.Assignee{
					ID:   assignee.ID,
					Name: assignee.FullName,
				}
			}

			if err := h.taskRepo.Create(ctx, newTask); err != nil {
				errors = append(errors, "Error creating task: "+err.Error())
				continue
			}
			tasksCreated++
		}
		tasksSynced++
	}

	log.Printf("Imported %d issues from YouTrack (created: %d, updated: %d)", tasksSynced, tasksCreated, tasksUpdated)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Import completed",
		"data": map[string]interface{}{
			"tasks_synced":  tasksSynced,
			"tasks_created": tasksCreated,
			"tasks_updated": tasksUpdated,
			"errors":        errors,
		},
	})
}

// SyncTaskToYouTrack syncs a local task to YouTrack
func (h *YouTrackHandler) SyncTaskToYouTrack(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	taskID := vars["id"]

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	// Get local task
	task, err := h.taskRepo.GetByID(r.Context(), taskID)
	if err != nil {
		http.Error(w, "Task not found: "+err.Error(), http.StatusNotFound)
		return
	}

	if task.YouTrackID == nil || *task.YouTrackID == "" {
		http.Error(w, "Task is not linked to YouTrack", http.StatusBadRequest)
		return
	}

	// Map local status to YouTrack state
	state := h.mapLocalStatusToYouTrack(task.Status)

	updateReq := youtrack.UpdateIssueRequest{
		Summary:     task.Title,
		Description: task.Description,
		CustomFields: []youtrack.CustomField{
			{
				Name:  "State",
				Value: map[string]string{"name": state},
			},
		},
	}

	_, err = client.UpdateIssue(r.Context(), *task.YouTrackID, updateReq)
	if err != nil {
		http.Error(w, "Failed to update YouTrack issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Task synced to YouTrack",
	})
}

// GetProjectSectionsFromDB returns sections stored in database for a project
func (h *YouTrackHandler) GetProjectSectionsFromDB(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Get project ID from URL or use default project
	vars := mux.Vars(r)
	projectID := vars["id"]

	// If no project ID specified, get the default/first project
	if projectID == "" {
		projects, err := h.projectRepo.GetByOwnerID(r.Context(), userID)
		if err != nil || len(projects) == 0 {
			// Return empty sections if no project
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success": true,
				"data":    []models.SectionResponse{},
			})
			return
		}
		projectID = projects[0].ID
	}

	sections, err := h.sectionRepo.GetProjectSections(r.Context(), projectID)
	if err != nil {
		http.Error(w, "Failed to get sections: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Convert to response format
	var response []models.SectionResponse
	for _, s := range sections {
		response = append(response, s.ToResponse())
	}

	// If no sections stored, return default fallback sections
	if len(response) == 0 {
		response = []models.SectionResponse{
			{GID: "Open", Name: "Open", Position: 0},
			{GID: "In Progress", Name: "In Progress", Position: 1},
			{GID: "Fixed", Name: "Fixed", Position: 2},
			{GID: "Done", Name: "Done", Position: 3},
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    response,
	})
}

// Helper methods

func (h *YouTrackHandler) getOrCreateDefaultProject(ctx context.Context, userID string) (string, error) {
	projects, err := h.projectRepo.GetByOwnerID(ctx, userID)
	if err == nil && len(projects) > 0 {
		return projects[0].ID, nil
	}

	project := &models.Project{
		Name:        "Default Project",
		Description: "Auto-created project for imported tasks",
		OwnerID:     userID,
	}

	if err := h.projectRepo.Create(ctx, project); err != nil {
		return "", err
	}

	return project.ID, nil
}

func (h *YouTrackHandler) mapYouTrackStatusToLocal(status string) models.TaskStatus {
	statusLower := strings.ToLower(status)
	switch {
	case strings.Contains(statusLower, "done") || strings.Contains(statusLower, "fixed") || strings.Contains(statusLower, "complete"):
		return models.TaskStatusDone
	case strings.Contains(statusLower, "progress") || strings.Contains(statusLower, "doing"):
		return models.TaskStatusInProgress
	case strings.Contains(statusLower, "review") || strings.Contains(statusLower, "verify"):
		return models.TaskStatusReview
	case strings.Contains(statusLower, "open") || strings.Contains(statusLower, "submitted"):
		return models.TaskStatusTodo
	default:
		return models.TaskStatusTodo
	}
}

func (h *YouTrackHandler) mapYouTrackPriorityToLocal(priority string) models.TaskPriority {
	priorityLower := strings.ToLower(priority)
	switch {
	case strings.Contains(priorityLower, "critical") || strings.Contains(priorityLower, "show-stopper"):
		return models.TaskPriorityHigh
	case strings.Contains(priorityLower, "major"):
		return models.TaskPriorityHigh
	case strings.Contains(priorityLower, "minor"):
		return models.TaskPriorityLow
	default:
		return models.TaskPriorityMedium
	}
}

func (h *YouTrackHandler) mapLocalStatusToYouTrack(status models.TaskStatus) string {
	switch status {
	case models.TaskStatusDone:
		return "Fixed"
	case models.TaskStatusInProgress:
		return "In Progress"
	case models.TaskStatusReview:
		return "To be discussed"
	default:
		return "Open"
	}
}

// ============================================================
// AI Analysis → YouTrack Matching & Bulk Move
// ============================================================

// MatchAnalysis matches AI analysis results against YouTrack issues using fuzzy matching
func (h *YouTrackHandler) MatchAnalysis(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		PersonBreakdown []struct {
			Name      string   `json:"name"`
			Assigned  []string `json:"assigned"`
			Completed []string `json:"completed"`
			Pending   []string `json:"pending"`
			Blocked   []string `json:"blocked"`
		} `json:"person_breakdown"`
		Analysis []struct {
			TaskTitle      string   `json:"task_title"`
			DetectedStatus string   `json:"detected_status"`
			Confidence     float64  `json:"confidence"`
			Evidence       []string `json:"evidence"`
			Assignee       string   `json:"assignee"`
		} `json:"analysis"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	// Fetch all YouTrack issues
	issues, err := client.GetIssues(r.Context())
	if err != nil {
		http.Error(w, "Failed to fetch YouTrack issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Build a list of all tasks from person_breakdown with their status and person
	type taskEntry struct {
		Title  string
		Person string
		Status string // completed, pending, blocked
	}
	var allTasks []taskEntry

	for _, person := range req.PersonBreakdown {
		for _, t := range person.Completed {
			allTasks = append(allTasks, taskEntry{Title: t, Person: person.Name, Status: "completed"})
		}
		for _, t := range person.Pending {
			allTasks = append(allTasks, taskEntry{Title: t, Person: person.Name, Status: "in_progress"})
		}
		for _, t := range person.Blocked {
			allTasks = append(allTasks, taskEntry{Title: t, Person: person.Name, Status: "blocked"})
		}
	}

	// Match each task against YouTrack issues
	type matchResult struct {
		TaskTitle     string                 `json:"task_title"`
		Person        string                 `json:"person"`
		Status        string                 `json:"status"`
		YouTrackIssue map[string]interface{} `json:"youtrack_issue"`
		ProposedState string                 `json:"proposed_state"`
		Confidence    float64                `json:"confidence"`
	}

	var matches []matchResult
	var unmatchedTasks []map[string]string
	matchedIssueIDs := make(map[string]bool)

	for _, task := range allTasks {
		bestMatch := -1
		bestScore := 0.0

		for i, issue := range issues {
			score := fuzzyMatchScore(task.Title, issue.Summary)
			if score > bestScore && score >= 0.4 {
				bestScore = score
				bestMatch = i
			}
		}

		if bestMatch >= 0 {
			issue := issues[bestMatch]
			currentState := youtrack.GetStatus(issue)

			// Determine proposed state based on AI status
			proposedState := ""
			switch task.Status {
			case "completed":
				proposedState = "DEV"
			case "in_progress":
				proposedState = "In Progress"
			case "blocked":
				proposedState = "In Progress" // blocked stays in progress
			}

			matches = append(matches, matchResult{
				TaskTitle: task.Title,
				Person:    task.Person,
				Status:    task.Status,
				YouTrackIssue: map[string]interface{}{
					"id":            issue.ID,
					"summary":       issue.Summary,
					"current_state": currentState,
				},
				ProposedState: proposedState,
				Confidence:    bestScore,
			})
			matchedIssueIDs[issue.ID] = true
		} else {
			unmatchedTasks = append(unmatchedTasks, map[string]string{
				"task_title": task.Title,
				"person":     task.Person,
				"status":     task.Status,
			})
		}
	}

	// Collect unmatched YouTrack issues
	var unmatchedIssues []map[string]interface{}
	for _, issue := range issues {
		if !matchedIssueIDs[issue.ID] {
			unmatchedIssues = append(unmatchedIssues, map[string]interface{}{
				"id":            issue.ID,
				"summary":       issue.Summary,
				"current_state": youtrack.GetStatus(issue),
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":          true,
		"matches":          matches,
		"unmatched_tasks":  unmatchedTasks,
		"unmatched_issues": unmatchedIssues,
	})
}

// BulkUpdateStates updates the state of multiple YouTrack issues at once
func (h *YouTrackHandler) BulkUpdateStates(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Updates []struct {
			IssueID  string `json:"issue_id"`
			NewState string `json:"new_state"`
		} `json:"updates"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	var succeeded, failed int
	var errors []string

	for _, update := range req.Updates {
		if err := client.UpdateIssueState(r.Context(), update.IssueID, update.NewState); err != nil {
			failed++
			errors = append(errors, update.IssueID+": "+err.Error())
			log.Printf("Failed to update %s to %s: %v", update.IssueID, update.NewState, err)
		} else {
			succeeded++
			log.Printf("Updated %s → %s", update.IssueID, update.NewState)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   failed == 0,
		"succeeded": succeeded,
		"failed":    failed,
		"errors":    errors,
		"message":   fmt.Sprintf("Updated %d/%d issues", succeeded, len(req.Updates)),
	})
}

// ============================================================
// Fuzzy Matching Helpers
// ============================================================

// fuzzyMatchScore returns a similarity score between 0 and 1 for two strings
func fuzzyMatchScore(a, b string) float64 {
	a = normalizeFuzzy(a)
	b = normalizeFuzzy(b)

	if a == "" || b == "" {
		return 0
	}

	// Exact match
	if a == b {
		return 1.0
	}

	// One contains the other (substring match)
	if strings.Contains(a, b) || strings.Contains(b, a) {
		shorter := len(a)
		longer := len(b)
		if shorter > longer {
			shorter, longer = longer, shorter
		}
		return 0.7 + 0.3*float64(shorter)/float64(longer)
	}

	// Levenshtein distance ratio
	dist := levenshtein(a, b)
	maxLen := len(a)
	if len(b) > maxLen {
		maxLen = len(b)
	}
	if maxLen == 0 {
		return 0
	}
	return 1.0 - float64(dist)/float64(maxLen)
}

// normalizeFuzzy normalizes a string for fuzzy matching
func normalizeFuzzy(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	// Remove common punctuation
	replacer := strings.NewReplacer(
		".", "", ",", "", "!", "", "?", "", ":", "", ";", "",
		"(", "", ")", "", "[", "", "]", "", "'", "", "\"", "",
		"-", " ", "_", " ",
	)
	s = replacer.Replace(s)
	// Collapse multiple spaces
	parts := strings.Fields(s)
	return strings.Join(parts, " ")
}

// levenshtein calculates the Levenshtein distance between two strings
func levenshtein(a, b string) int {
	la := len(a)
	lb := len(b)

	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}

	// Use two rows instead of full matrix for memory efficiency
	prev := make([]int, lb+1)
	curr := make([]int, lb+1)

	for j := 0; j <= lb; j++ {
		prev[j] = j
	}

	for i := 1; i <= la; i++ {
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			curr[j] = min(curr[j-1]+1, min(prev[j]+1, prev[j-1]+cost))
		}
		prev, curr = curr, prev
	}

	return prev[lb]
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ============================================================
// YouTrack Issues Grouped by Assignee (for Daily Task List)
// ============================================================

var priorityRegex = regexp.MustCompile(`^(P[0-3])\s+(.*)`)

// extractPriorityFromSummary parses "P2 FE UI: Avatar Bug" -> ("P2", "P2 FE UI: Avatar Bug")
// The clean_title keeps the priority prefix since it's part of the Slack message format
func extractPriorityFromSummary(summary string) (string, string) {
	matches := priorityRegex.FindStringSubmatch(summary)
	if len(matches) == 3 {
		return matches[1], summary // Keep full summary as title
	}
	return "", summary
}

// GetIssuesGroupedByAssignee returns active YouTrack issues grouped by assignee
func (h *YouTrackHandler) GetIssuesGroupedByAssignee(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	issues, err := client.GetIssues(r.Context())
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Group by assignee, filter out Done/Fixed
	type issueItem struct {
		ID          string `json:"id"`
		Summary     string `json:"summary"`
		PriorityTag string `json:"priority_tag"`
		CleanTitle  string `json:"clean_title"`
		Status      string `json:"status"`
		Selected    bool   `json:"selected"`
	}

	type assigneeGroup struct {
		UserName    string      `json:"user_name"`
		SlackHandle string      `json:"slack_handle"`
		Issues      []issueItem `json:"issues"`
	}

	groups := make(map[string]*assigneeGroup)
	var unassignedIssues []issueItem

	for _, issue := range issues {
		status := youtrack.GetStatus(issue)
		statusLower := strings.ToLower(status)

		// Skip done/fixed issues
		if statusLower == "done" || statusLower == "fixed" {
			continue
		}

		priorityTag, cleanTitle := extractPriorityFromSummary(issue.Summary)

		item := issueItem{
			ID:          issue.ID,
			Summary:     issue.Summary,
			PriorityTag: priorityTag,
			CleanTitle:  cleanTitle,
			Status:      status,
			Selected:    true,
		}

		assignee := youtrack.GetAssignee(issue)
		if assignee != nil && assignee.FullName != "" {
			name := assignee.FullName
			if groups[name] == nil {
				groups[name] = &assigneeGroup{
					UserName:    name,
					SlackHandle: "@" + name,
					Issues:      []issueItem{},
				}
			}
			groups[name].Issues = append(groups[name].Issues, item)
		} else {
			unassignedIssues = append(unassignedIssues, item)
		}
	}

	// Convert map to slice
	var assignments []assigneeGroup
	for _, group := range groups {
		assignments = append(assignments, *group)
	}

	// Add unassigned group if any
	if len(unassignedIssues) > 0 {
		assignments = append(assignments, assigneeGroup{
			UserName:    "Unassigned",
			SlackHandle: "@Unassigned",
			Issues:      unassignedIssues,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"assignments": assignments,
		},
	})
}

// ============================================================
// Workflow State Order & Backward Movement Detection
// ============================================================

// stateOrder maps lowercase state names to their workflow position.
// Based on actual YouTrack project states confirmed via /api/youtrack/states:
// Backlog(0) → In Progress(1) → DEV(2) → Ready for Stage(3) → STAGE(4) → Ready for PROD(5) → PROD(6) → Closed/Done(7)
// Blocked and Findings are treated as lateral states at In Progress level.
var stateOrder = map[string]int{
	"backlog":         0,
	"open":            0,
	"submitted":       0,
	"in progress":     1,
	"blocked":         1,  // lateral — not forward, not backward relative to In Progress
	"findings":        1,  // lateral
	"dev":             2,
	"ready for stage": 3,
	"stage":           4,
	"ready for prod":  5,
	"ready for prd":   5,
	"prod":            6,
	"mobile done":     6,
	"done":            7,
	"fixed":           7,
	"closed":          7,
}

func getStateIndex(state string) int {
	if idx, ok := stateOrder[strings.ToLower(state)]; ok {
		return idx
	}
	return 0
}

func isBackwardMove(currentState, proposedState string) bool {
	return getStateIndex(proposedState) < getStateIndex(currentState)
}

// GetSyncRecommendations compares AI analysis against YouTrack states and returns recommendations
func (h *YouTrackHandler) GetSyncRecommendations(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		PersonBreakdown []struct {
			Name      string   `json:"name"`
			Assigned  []string `json:"assigned"`
			Completed []string `json:"completed"`
			Pending   []string `json:"pending"`
			Blocked   []string `json:"blocked"`
		} `json:"person_breakdown"`
		Analysis []struct {
			TaskTitle      string   `json:"task_title"`
			DetectedStatus string   `json:"detected_status"`
			Confidence     float64  `json:"confidence"`
			Evidence       []string `json:"evidence"`
			Assignee       string   `json:"assignee"`
		} `json:"analysis"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	issues, err := client.GetIssues(r.Context())
	if err != nil {
		http.Error(w, "Failed to fetch YouTrack issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Build task list from person_breakdown
	type taskEntry struct {
		Title  string
		Person string
		Status string
	}
	var allTasks []taskEntry

	for _, person := range req.PersonBreakdown {
		for _, t := range person.Completed {
			allTasks = append(allTasks, taskEntry{Title: t, Person: person.Name, Status: "completed"})
		}
		for _, t := range person.Pending {
			allTasks = append(allTasks, taskEntry{Title: t, Person: person.Name, Status: "in_progress"})
		}
		for _, t := range person.Blocked {
			allTasks = append(allTasks, taskEntry{Title: t, Person: person.Name, Status: "blocked"})
		}
	}

	// Match and generate recommendations
	type recommendation struct {
		IssueID       string  `json:"issue_id"`
		Summary       string  `json:"summary"`
		Person        string  `json:"person"`
		CurrentState  string  `json:"current_state"`
		ProposedState string  `json:"proposed_state"`
		Reason        string  `json:"reason"`
		Backward      bool    `json:"backward"`
		Confidence    float64 `json:"confidence"`
	}

	var recommendations []recommendation

	for _, task := range allTasks {
		bestMatch := -1
		bestScore := 0.0

		for i, issue := range issues {
			score := fuzzyMatchScore(task.Title, issue.Summary)
			if score > bestScore && score >= 0.4 {
				bestScore = score
				bestMatch = i
			}
		}

		if bestMatch < 0 {
			continue
		}

		issue := issues[bestMatch]
		currentState := youtrack.GetStatus(issue)

		// Determine proposed state
		var proposedState string
		switch task.Status {
		case "completed":
			proposedState = "DEV"
		case "in_progress":
			proposedState = "In Progress"
		case "blocked":
			proposedState = "In Progress"
		}

		if proposedState == "" {
			continue
		}

		// Skip if already in the proposed state
		if strings.EqualFold(currentState, proposedState) {
			continue
		}

		backward := isBackwardMove(currentState, proposedState)
		reason := fmt.Sprintf("AI analysis detected status '%s' but YouTrack shows '%s'", task.Status, currentState)

		recommendations = append(recommendations, recommendation{
			IssueID:       issue.ID,
			Summary:       issue.Summary,
			Person:        task.Person,
			CurrentState:  currentState,
			ProposedState: proposedState,
			Reason:        reason,
			Backward:      backward,
			Confidence:    bestScore,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":         true,
		"recommendations": recommendations,
	})
}

// ============================================================
// PM Assistant Query (AI Chat with YouTrack Context)
// ============================================================

// defaultPMAssistantPrompt is used when no active pm_assistant bot config exists.
const defaultPMAssistantPrompt = `You are Velocity PM Assistant for a software dev team. Today: {{DATE}}
Answer questions using ONLY the sprint data below. Never invent names, IDs, or numbers not in the data.

DATA FORMAT: ID | Priority | Type | Summary | Status | Assignee | Subsystem | bounces:N [FLAGS]
  → FromState→ToState (Xh, by Person)   ← transition history (who moved it and how long it spent)
  BLOCKER: reason                        ← why the ticket is stuck (or "No reason recorded")
Sprint Summary line: Total/Done/InProgress/Blocked/Overdue/Bounced counts + Ticket Types breakdown

PIPELINE STATES (in order):
  Backlog → In Progress → DEV (code on dev server, needs QA) → Ready for Stage → Stage → Ready for Prod → Done/Closed

KEY CONCEPTS:
- OVERDUE: In Progress > SLA (P0:4h P1:24h P2:48h else:72h)
- BOUNCE: ticket moved backward (DEV→In Progress = QA rejected; In Progress→Backlog = dev stalled)
- CYCLE TIME: sum all In-Progress durations from transition history
- TESTER: person in "by {X}" on the transition INTO DEV/Stage/Verified/Done = that person tested it
- FEATURE/BUG/TASK: the Type field on each issue line
- OVERLOADED: developer with 5+ in-progress tickets

ANSWERING RULES:
1. Lead with the direct answer, then supporting detail
2. Bold ticket IDs: **3-1234**. Prefix assignees with @
3. Format durations as Xd Yh. Never raw hours.
4. For type/count queries: use the "Ticket Types" line from Sprint Summary for total counts
5. For "who tested X": look at transition INTO DEV/Stage/Done — "by {person}" = tester
6. For cycle time: sum the hours from In-Progress transitions in ticket history
7. If context header says "COMPLETE list" or "EXACTLY N tickets" — that IS the full set. Never imply more exist or add imaginary tickets.
8. STRICT: ONLY use ticket IDs that appear in the DATA below. Never invent IDs like ARD-1234, names like "John/Dave/Alice", or timestamps you don't see in the data. If you can't find the answer in the data, say "I don't have that information in the current sprint data."
9. If data is missing for a specific ticket: say "I don't have data for [ID] in this sprint" — do NOT guess or fabricate.
10. Multi-turn: build on conversation history, never re-introduce yourself
11. When query asks for date-based filtering (e.g., "exclude bugs resolved last week") but resolved dates are not in the data: list ALL matching tickets found and add a short note — do NOT ask the user for more context or refuse to answer
12. If only 1 ticket is returned and the data says "COMPLETE list", that IS the full result — state it directly without asking for more context`

// pmSprintKPIs carries sprint-level stats included in every PM assistant response.
type pmSprintKPIs struct {
	SprintName string
	SprintEnds string
	Total      int
	Done       int
	InProgress int
	Blocked    int
	Overdue    int
	Bounced    int
	TypeCounts map[string]int
}

func buildPMKPIContext(kpis pmSprintKPIs) string {
	ends := ""
	if kpis.SprintEnds != "" {
		ends = " | Ends: " + kpis.SprintEnds
	}
	typeStr := ""
	for t, n := range kpis.TypeCounts {
		if typeStr != "" {
			typeStr += ", "
		}
		typeStr += fmt.Sprintf("%s: %d", t, n)
	}
	pct := 0
	if kpis.Total > 0 {
		pct = kpis.Done * 100 / kpis.Total
	}
	return fmt.Sprintf("SPRINT SUMMARY: %s%s\nTotal: %d | Done: %d (%d%%) | In Progress: %d | Blocked: %d | Overdue: %d | Bounced: %d\nTicket Types: %s",
		kpis.SprintName, ends, kpis.Total, kpis.Done, pct, kpis.InProgress, kpis.Blocked, kpis.Overdue, kpis.Bounced, typeStr)
}

// buildYQLTranslationPrompt builds the system prompt for the LLM that translates
// natural-language questions into YouTrack Query Language (YQL).
// All domain data (states, priorities, sprints, users) is injected dynamically — nothing hardcoded.
func buildYQLTranslationPrompt(projectID, activeSprint string, states []youtrack.State, priorities []youtrack.PriorityValue, sprints []youtrack.Sprint, users []youtrack.User, subsystems []youtrack.PriorityValue) string {
	var sb strings.Builder
	sb.WriteString("You are a YouTrack Query Language (YQL) translator.\n")
	sb.WriteString("Output ONLY the raw YQL query string — no explanation, no quotes, no markdown.\n\n")
	sb.WriteString(fmt.Sprintf("PROJECT: %s\nACTIVE SPRINT: %s\nTODAY: %s\n\n", projectID, activeSprint, time.Now().Format("2006-01-02")))

	// States as ready-to-paste YQL tokens
	if len(states) > 0 {
		sb.WriteString("STATES — copy-paste these tokens exactly:\n")
		for _, s := range states {
			if strings.ContainsAny(s.Name, " \t") {
				sb.WriteString(fmt.Sprintf("  #{%s}\n", s.Name))
			} else {
				sb.WriteString(fmt.Sprintf("  #%s\n", s.Name))
			}
		}
		sb.WriteString("\n")
	}

	// Priorities as ready-to-paste YQL tokens
	if len(priorities) > 0 {
		sb.WriteString("PRIORITIES — copy-paste these tokens exactly:\n")
		for _, p := range priorities {
			if strings.ContainsAny(p.Name, " \t") {
				sb.WriteString(fmt.Sprintf("  #{%s}\n", p.Name))
			} else {
				sb.WriteString(fmt.Sprintf("  #%s\n", p.Name))
			}
		}
		sb.WriteString("\n")
	}

	// Sprints as ready-to-paste YQL tokens
	if len(sprints) > 0 {
		sb.WriteString("SPRINTS — copy-paste these tokens exactly:\n")
		for _, s := range sprints {
			if strings.ContainsAny(s.Name, " \t") {
				sb.WriteString(fmt.Sprintf("  #{%s}   (id: %s)\n", s.Name, s.ID))
			} else {
				sb.WriteString(fmt.Sprintf("  #%s   (id: %s)\n", s.Name, s.ID))
			}
		}
		sb.WriteString("\n")
	}

	if len(users) > 0 {
		sb.WriteString("TEAM MEMBERS (login → Full Name):\n")
		for _, u := range users {
			if u.Login != "" {
				sb.WriteString(fmt.Sprintf("  %s → %s\n", u.Login, u.FullName))
			}
		}
		sb.WriteString("\n")
	}

	// Subsystem values — critical for "mission control", "studio", "BE/FE" queries
	// Subsystems support BOTH #{value} hashtag AND Subsystem: {value} syntax.
	// EXCLUSION LOGIC: YouTrack has NO exclusion operator for subsystems.
	// To exclude a subsystem: list only the subsystems you WANT (omit the excluded one).
	if len(subsystems) > 0 {
		sb.WriteString("SUBSYSTEMS — each subsystem can be used as a hashtag #tag:\n")
		for _, s := range subsystems {
			if strings.Contains(s.Name, " ") {
				sb.WriteString(fmt.Sprintf("  #{%s}\n", s.Name))
			} else {
				sb.WriteString(fmt.Sprintf("  #%s\n", s.Name))
			}
		}
		sb.WriteString("\nSUBSYSTEM EXCLUSION LOGIC (CRITICAL):\n")
		sb.WriteString("  YouTrack has NO exclusion operator for subsystems. NEVER use -Subsystem: or -#{value}.\n")
		sb.WriteString("  Instead: identify all subsystems matching the category, then INCLUDE ONLY the ones the user wants.\n")
		sb.WriteString("  Example: 'BE tickets except RAG' → subsystems are #{BE MC} #{BE UI} #{BE Studio} #{BE RAG}\n")
		sb.WriteString("    → include only: #{Sprint 5} #{BE MC} #{BE Studio} #{BE UI}  (omit #{BE RAG})\n")
		sb.WriteString("  Example: 'FE tickets for Mission Control' → #{Sprint 5} #{FE MC}\n")
		sb.WriteString("  Example: 'all Mission Control tickets FE only' → #{Sprint 5} #{FE MC}\n\n")
	}

	sb.WriteString("YQL SYNTAX RULES:\n")
	sb.WriteString("• States, priorities, sprints all use # prefix:\n")
	sb.WriteString("    Single-word:  #Blocked  #P0  #DEV\n")
	sb.WriteString("    Multi-word:   #{In Progress}  #{Sprint 4}  #{Ready For Prod}\n")
	sb.WriteString("• Multiple filters are space-separated: #{Sprint 4} #{In Progress} #P0\n")
	sb.WriteString(fmt.Sprintf("• Always start with: project: %s\n", projectID))
	sb.WriteString("• Assignee filter: Assignee: login  (no # prefix, exact login)\n")
	sb.WriteString("• Reporter/creator filter: by: login\n")
	sb.WriteString("• Subsystem filter: use # hashtag — #{FE MC}  OR  Subsystem: {FE MC}  (both work)\n")
	sb.WriteString("• Subsystem EXCLUSION: NOT SUPPORTED — instead list only the subsystems you want (see SUBSYSTEM EXCLUSION LOGIC above)\n")
	sb.WriteString("• Type filter: Type: Bug  /  Type: Feature  /  Type: Hotfix  /  Type: Task\n")
	sb.WriteString("• Date filters:\n")
	sb.WriteString("    created: Today  |  created: yesterday  |  created: {This week}  |  created: {Last week}\n")
	sb.WriteString("    updated: Today  |  updated: yesterday  |  updated: {This week}\n")
	sb.WriteString("    Date range: created: 2026-05-01 .. 2026-05-24\n")
	sb.WriteString("• 'moved to [state] today/recently' → use that state + updated: Today  (NOT created:)\n")
	sb.WriteString("• NEVER use 'created:' for transition/movement queries — only for ticket creation date\n\n")

	sb.WriteString("PROVEN EXAMPLES (use these exact patterns):\n")
	sb.WriteString(fmt.Sprintf("  all sprint issues       → project: %s #{%s}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  blocked tickets         → project: %s #{%s} #Blocked\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  in progress             → project: %s #{%s} #{In Progress}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  moved to DEV today      → project: %s #{%s} #DEV updated: Today\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  moved to Stage today    → project: %s #{%s} #Stage updated: Today\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  moved to Done today     → project: %s #{%s} #Done updated: Today\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  updated this week       → project: %s #{%s} updated: {This week}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  DEV + Stage + Prod      → project: %s #{%s} #DEV #Stage #{Ready For Prod}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  single assignee         → project: %s #{%s} Assignee: rajvirsingh\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  P0 or P1 open           → project: %s #{%s} #P0 #P1 #{In Progress} #{To Do}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  created today           → project: %s #{%s} created: Today\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  created yesterday       → project: %s #{%s} created: yesterday\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  hotfixes in progress    → project: %s #{%s} Type: Hotfix #{In Progress}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  bugs in sprint          → project: %s #{%s} Type: Bug\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  tasks for one person    → project: %s #{%s} Assignee: simran\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  FE MC done tickets      → project: %s #{%s} #{FE MC} #DEV #Done\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  MC FE tickets only      → project: %s #{%s} #{FE MC}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  MC excl backend         → project: %s #{%s} #{FE MC}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  BE excl RAG             → project: %s #{%s} #{BE MC} #{BE Studio} #{BE UI}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  bugs this sprint only   → project: %s #{%s} Type: Bug\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  bugs not from last week → project: %s #{%s} Type: Bug\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  created this week       → project: %s created: {This week}\n", projectID))
	sb.WriteString(fmt.Sprintf("  bounced back            → project: %s #{%s}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  bounced tickets         → project: %s #{%s}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  highest bounce count    → project: %s #{%s}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  overdue tickets         → project: %s #{%s}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  past SLA deadline       → project: %s #{%s}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  at-risk tickets         → project: %s #{%s}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  cycle time per dev      → project: %s #{%s}\n", projectID, activeSprint))
	sb.WriteString(fmt.Sprintf("  developer workload      → project: %s #{%s}\n", projectID, activeSprint))

	sb.WriteString("\nCRITICAL RULES:\n")
	sb.WriteString("1. NEVER use  State: value  or  Priority: value  — always use # prefix\n")
	sb.WriteString("2. NEVER use  sprint: {name}  — always use  #{Sprint Name}\n")
	sb.WriteString("3. Multiple states: #{State1} #{State2} (space-separated, NOT comma-separated)\n")
	sb.WriteString(fmt.Sprintf("4. Default to active sprint #{%s} unless user asks for historical data\n", activeSprint))
	sb.WriteString("5. For 'summary' / 'all issues': only add #{SprintName}, no state filter\n")
	sb.WriteString("6. For 'multiple assignees': use only one Assignee: filter or none — NEVER chain Assignee: x Assignee: y\n")
	sb.WriteString("7. Type filter: Type: Hotfix / Type: Bug / Type: Task / Type: Feature (never use # for Type)\n")
	sb.WriteString("8. NEVER use date comparisons like  due: <  or  updated: <=  — these are invalid YQL\n")
	sb.WriteString("   NEVER use  resolved: {period}  — this project does NOT have resolved dates; use state filters instead\n")
	sb.WriteString("   For 'exclude resolved last week': just return sprint + type filter — the bot will reason from ticket data\n")
	sb.WriteString("9. NEVER invent state names like #Bounced #Overdue #AtRisk #Reopened #Fixed — these do not exist\n")
	sb.WriteString("10. Subsystem EXCLUSION (-Subsystem:) is NOT valid YQL — to get 'MC excluding backend', use Subsystem: {FE MC} only\n")
	sb.WriteString("11. Only use state names from the STATES list above — do not guess or invent state names\n")
	return sb.String()
}

// normalizeYQL converts LLM-generated field:value syntax to YouTrack's #tag syntax.
// "State: In Progress"   → "#{In Progress}"
// "State: Blocked"       → "#Blocked"
// "sprint: Sprint 4"     → "#{Sprint 4}"
// "Priority: P0"         → "#P0"
// Fields like project:, Assignee:, by:, created: are passed through unchanged.
func normalizeYQL(yql string) string {
	// Stops a field's value at the next field boundary OR an existing #tag.
	nextBoundaryRe := regexp.MustCompile(`#|\b[A-Za-z]+\s*:`)

	// Type uses "Type: value" syntax — never "#value" — so it is excluded from this list.
	for _, field := range []string{"State", "Priority", "sprint"} {
		re := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(field) + `\s*:\s*`)
		for {
			loc := re.FindStringIndex(yql)
			if loc == nil {
				break
			}
			valStart := loc[1]
			rest := yql[valStart:]
			next := nextBoundaryRe.FindStringIndex(rest)
			var valEnd int
			if next != nil {
				valEnd = valStart + next[0]
			} else {
				valEnd = len(yql)
			}
			rawVal := strings.TrimSpace(yql[valStart:valEnd])
			rawVal = strings.Trim(rawVal, "{}")
			rawVal = strings.TrimPrefix(rawVal, "#")
			rawVal = strings.TrimSpace(rawVal)
			if rawVal == "" {
				break
			}
			var tag string
			if strings.ContainsAny(rawVal, " \t") {
				tag = "#{" + rawVal + "}"
			} else {
				tag = "#" + rawVal
			}
			yql = strings.TrimSpace(yql[:loc[0]] + tag + " " + strings.TrimSpace(yql[valEnd:]))
		}
	}
	return strings.TrimSpace(yql)
}

// pmStateOrder is used to detect moved-back (regression) transitions.
var pmStateOrder = map[string]int{
	"backlog": 0, "open": 0, "to do": 0, "todo": 0, "new": 0,
	"in progress": 1,
	"dev": 2,
	"stage": 3, "ready for stage": 3,
	"prod": 4, "ready for prod": 4,
	"done": 5, "closed": 5, "won't fix": 5, "duplicate": 5, "mobile done": 5,
}

func pmIsMovedBack(from, to string) bool {
	toRank, toOk := pmStateOrder[strings.ToLower(to)]
	fromRank, fromOk := pmStateOrder[strings.ToLower(from)]
	if !toOk || !fromOk {
		return false
	}
	return toRank < fromRank
}

func pmOverdueThreshold(priority string) float64 {
	switch strings.ToUpper(priority) {
	case "P0", "CRITICAL":
		return 4
	case "P1":
		return 24
	case "P2":
		return 48
	default:
		return 72
	}
}

// PMAssistantQuery handles natural language queries against YouTrack + time tracking data.
// It loads an active pm_assistant bot config for custom instructions, injects live data,
// and supports multi-turn conversation history.
func (h *YouTrackHandler) PMAssistantQuery(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Query          string           `json:"query"`
		History        []ai.ConvMessage `json:"history"`
		SprintID       string           `json:"sprint_id"`
		SprintName     string           `json:"sprint_name"`
		SprintFinishMs int64            `json:"sprint_finish_ms"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Query == "" {
		http.Error(w, "Invalid request: query is required", http.StatusBadRequest)
		return
	}

	// ── 1. Load custom instructions from active pm_assistant bot config ──────
	botRepo := database.NewBotConfigRepository()
	bots, _ := botRepo.GetByType(r.Context(), models.BotTypePMAssistant)
	customInstructions := ""
	for _, b := range bots {
		if b.IsActive {
			customInstructions = b.Prompt
			break
		}
	}
	if customInstructions == "" {
		customInstructions = defaultPMAssistantPrompt
	}
	// Substitute {{DATE}} variable
	customInstructions = strings.ReplaceAll(customInstructions, "{{DATE}}", time.Now().Format("2006-01-02"))

	// ── 2. Get YouTrack client + fetch metadata (parallel) ───────────────────
	ytClient, err := h.getYouTrackClient(r.Context())
	if err != nil || ytClient == nil {
		http.Error(w, "YouTrack not configured", http.StatusBadRequest)
		return
	}
	projectID := ytClient.GetProjectID()

	var sprintIssues []youtrack.Issue
	var availableSprints []youtrack.Sprint
	var ytStates []youtrack.State
	var ytPriorities []youtrack.PriorityValue
	var ytUsers []youtrack.User
	var ytSubsystems []youtrack.PriorityValue

	var metaWg sync.WaitGroup
	metaWg.Add(5)
	go func() { defer metaWg.Done(); ytStates, _ = ytClient.GetStates(r.Context()) }()
	go func() { defer metaWg.Done(); ytPriorities, _ = ytClient.GetPriorities(r.Context()) }()
	go func() { defer metaWg.Done(); availableSprints, _ = ytClient.GetSprints(r.Context()) }()
	go func() { defer metaWg.Done(); ytUsers, _ = ytClient.GetUsers(r.Context()) }()
	go func() {
		defer metaWg.Done()
		ytSubsystems, _ = ytClient.GetCustomFieldValues(r.Context(), "Subsystem")
	}()
	metaWg.Wait()

	if req.SprintID != "" {
		sprintIssues, _ = ytClient.GetAllSprintIssues(r.Context(), req.SprintID)
	} else {
		sprintIssues, _ = ytClient.GetIssues(r.Context())
	}

	// Collect issue IDs for the tracking fetch scope.
	// issue_state_log stores readable IDs (e.g. "ARD-1872") written by the webhook handler,
	// so we must use IDReadable here — not the internal ID — otherwise no rows match.
	sprintIssueIDs := make([]string, 0, len(sprintIssues))
	for _, iss := range sprintIssues {
		id := iss.IDReadable
		if id == "" {
			id = iss.ID // fallback for older YouTrack server format
		}
		sprintIssueIDs = append(sprintIssueIDs, id)
	}

	// ── 3. Fetch tracking log scoped to this sprint only ─────────────────────
	reportRepo := database.NewReportRepository()
	trackingLogs, _ := reportRepo.GetTimeTracking(r.Context(), database.TimeTrackingParams{
		SprintIssueIDs: sprintIssueIDs,
	})

	// ── 4. Fetch cached blocker reasons ──────────────────────────────────────
	blockerReasons := map[string]string{}
	if rows, err2 := database.GetPool().Query(r.Context(),
		`SELECT issue_id, reason FROM blocker_analysis_cache ORDER BY analyzed_at DESC`); err2 == nil {
		defer rows.Close()
		for rows.Next() {
			var id, reason string
			if rows.Scan(&id, &reason) == nil {
				blockerReasons[id] = reason
			}
		}
	}

	// ── 5. Load workflow config for role-based KPI classification ──────────────
	var wfHierarchy []models.ColumnState
	if h.configRepo != nil {
		if wfCfg, err2 := h.configRepo.GetEffective(r.Context(), userID, "youtrack"); err2 == nil && wfCfg != nil {
			wfHierarchy = wfCfg.ColumnHierarchy
		}
	}
	wfDoneRoles := map[string]bool{"dev_done": true, "verified": true, "deployed": true, "closed": true}

	// ── 6. Build sprint KPIs — Overdue + Bounced from tracking logs ─────────────
	overdueSet := map[string]bool{}
	bouncedSet := map[string]bool{}
	bounceCount := map[string]int{}
	// Track most recent entry time into an active state (null duration = still there)
	activeEntryTime := map[string]time.Time{}
	issuePriority := map[string]string{}
	for _, row := range trackingLogs {
		if pmIsMovedBack(row.FromState, row.ToState) {
			bouncedSet[row.IssueID] = true
			bounceCount[row.IssueID]++
		}
		if row.DurationInPrevStateHours != nil {
			if *row.DurationInPrevStateHours > pmOverdueThreshold(row.Priority) {
				overdueSet[row.IssueID] = true
			}
		}
		// Capture when this issue last entered an active state with no exit yet
		role := getStateRole(row.ToState, wfHierarchy)
		if role == "" && strings.Contains(strings.ToLower(row.ToState), "progress") {
			role = "active"
		}
		if role == "active" && row.DurationInPrevStateHours == nil {
			if ex, ok := activeEntryTime[row.IssueID]; !ok || row.TransitionedAt.After(ex) {
				activeEntryTime[row.IssueID] = row.TransitionedAt
				issuePriority[row.IssueID] = row.Priority
			}
		}
	}
	// Mark currently active issues overdue if they've exceeded their SLA
	now := time.Now()
	for issID, entryTime := range activeEntryTime {
		if now.Sub(entryTime).Hours() > pmOverdueThreshold(issuePriority[issID]) {
			overdueSet[issID] = true
		}
	}

	// Build transition history lines for bounced and blocked tickets only.
	// Keeping scope narrow avoids token bloat for uninteresting tickets.
	issueTransitions := map[string][]string{}
	for _, row := range trackingLogs {
		if bounceCount[row.IssueID] > 0 || blockerReasons[row.IssueID] != "" {
			dur := "?"
			if row.DurationInPrevStateHours != nil {
				h := *row.DurationInPrevStateHours
				d, hh := int(h)/24, int(h)%24
				if d > 0 {
					dur = fmt.Sprintf("%dd%dh", d, hh)
				} else {
					dur = fmt.Sprintf("%dh", int(h))
				}
			}
			mover := row.MovedBy
			if mover == "" {
				mover = "?"
			}
			issueTransitions[row.IssueID] = append(issueTransitions[row.IssueID],
				fmt.Sprintf("  → %s→%s (%s, by %s)", row.FromState, row.ToState, dur, mover))
		}
	}

	sprintEnds := ""
	if req.SprintFinishMs > 0 {
		sprintEnds = time.UnixMilli(req.SprintFinishMs).Format("Jan 2, 2006")
	}

	kpis := pmSprintKPIs{
		SprintName: req.SprintName,
		SprintEnds: sprintEnds,
		Bounced:    len(bouncedSet),
		TypeCounts: map[string]int{},
	}
	for _, iss := range sprintIssues {
		kpis.Total++
		status := youtrack.GetStatus(iss)
		role := getStateRole(status, wfHierarchy)
		if role == "" {
			// Fallback keyword heuristics when state is not in workflow config
			lower := strings.ToLower(status)
			switch {
			case strings.Contains(lower, "block"):
				role = "blocked"
			case strings.Contains(lower, "progress"):
				role = "active"
			case strings.Contains(lower, "done") || strings.Contains(lower, "clos") ||
				strings.Contains(lower, "deploy") || strings.Contains(lower, "verif"):
				role = "closed"
			}
		}
		switch {
		case role == "blocked":
			kpis.Blocked++
		case wfDoneRoles[role]:
			kpis.Done++
		case role == "active":
			kpis.InProgress++
		}
		// Overdue: active issues that exceeded SLA (cross-ref overdueSet which now includes live check)
		if role == "active" || role == "blocked" {
			if overdueSet[iss.ID] {
				// Already counted below
			}
		}
		if t := youtrack.GetCustomFieldValue(iss, "Type"); t != "" {
			kpis.TypeCounts[t]++
		}
	}
	// Count overdue only among non-done issues present in the sprint
	sprintIssueSet := map[string]bool{}
	for _, iss := range sprintIssues {
		id := iss.IDReadable
		if id == "" {
			id = iss.ID
		}
		sprintIssueSet[id] = true
	}
	overdueFinal := 0
	for id := range overdueSet {
		if sprintIssueSet[id] {
			overdueFinal++
		}
	}
	kpis.Overdue = overdueFinal

	// ── 6. Translate query to YQL via LLM ────────────────────────────────────
	translationPrompt := buildYQLTranslationPrompt(projectID, req.SprintName, ytStates, ytPriorities, availableSprints, ytUsers, ytSubsystems)
	yql, translErr := ai.QueryWithHistory(r.Context(), translationPrompt, nil, req.Query)
	if translErr != nil {
		log.Printf("[PM-YQL] translation failed: %v — using default sprint query", translErr)
		if req.SprintName != "" {
			yql = fmt.Sprintf("project: %s sprint: {%s}", projectID, req.SprintName)
		} else {
			yql = fmt.Sprintf("project: %s", projectID)
		}
	}
	// Strip any code fences or extra whitespace the model may add, then normalize braces
	yql = strings.TrimSpace(yql)
	yql = strings.Trim(yql, "`")
	yql = strings.TrimSpace(yql)
	yql = normalizeYQL(yql)

	// Analytics override: queries about computed metrics (bounce, overdue, SLA, cycle time, workload)
	// have no native YouTrack filter — override to a plain sprint fetch so the bot reads the
	// bounces:N and [OVERDUE] flags that are embedded in every ticket line of the data context.
	analyticsKeywords := []string{
		"bounce", "bounced", "overdue", "sla", "cycle time", "cycletime",
		"workload", "at-risk", "at risk", "delay severity", "developer load",
		"developer workload", "who has the most",
		// Date-exclusion patterns: YouTrack has no resolved date in this project, so these
		// can't be filtered via YQL — fall back to full sprint fetch and let LLM reason from data
		"resolved by last week", "resolved last week", "exclude last week", "not last week",
		"last week bugs", "last week tickets",
	}
	queryLower := strings.ToLower(req.Query)
	for _, kw := range analyticsKeywords {
		if strings.Contains(queryLower, kw) {
			sprintTag := ""
			if req.SprintName != "" {
				sprintTag = fmt.Sprintf(" #{%s}", req.SprintName)
			}
			// Preserve Type: filter from the generated YQL if present (e.g. Type: Bug)
			typeFilter := ""
			if m := regexp.MustCompile(`(?i)\bType:\s*\w+`).FindString(yql); m != "" {
				typeFilter = " " + m
			}
			yql = fmt.Sprintf("project: %s%s%s", projectID, sprintTag, typeFilter)
			log.Printf("[PM-YQL] analytics override → %q", yql)
			break
		}
	}

	log.Printf("[PM-YQL] query=%q → yql=%q", req.Query, yql)

	// ── 7. Execute YQL against YouTrack ──────────────────────────────────────
	yqlIssues, yqlErr := ytClient.SearchIssues(r.Context(), yql, 150)
	if yqlErr != nil {
		log.Printf("[PM-YQL] search failed: %v", yqlErr)
		yqlIssues = []youtrack.Issue{}
	}
	log.Printf("[PM-YQL] results=%d issues for sprint=%q", len(yqlIssues), req.SprintName)

	// ── 8. Build data context from YQL results + sprint KPIs ─────────────────
	var ctxSB strings.Builder
	ctxSB.WriteString(buildPMKPIContext(kpis))
	ctxSB.WriteString("\n\n")

	// Build a query-context hint injected into the SYSTEM PROMPT (not the data context)
	// so the LLM understands the filter but never echoes it in the response.
	var queryContextHint string
	queryContextHint = fmt.Sprintf("The search filter applied was: %s\n", yql)
	if strings.Contains(yql, "Subsystem:") || strings.Contains(yql, "#{") && (strings.Contains(strings.ToLower(yql), "mc") || strings.Contains(strings.ToLower(yql), "studio")) {
		queryContextHint += "The subsystem filter above has already restricted results to the requested component (e.g. '#{FE MC}' = Frontend Mission Control only, excludes backend).\n"
	}
	queryContextHint += "The issues listed below are the COMPLETE result of this filter. Answer directly — never ask for more context, never say data is missing. If 0 results, say 'no matching tickets found'.\n"

	if len(yqlIssues) == 0 {
		ctxSB.WriteString("QUERY RESULTS: No issues found matching this filter. Answer only from the Sprint Summary above — do NOT invent ticket IDs or data.\n")
	} else {
		ctxSB.WriteString(fmt.Sprintf("QUERY RESULTS (%d issues — COMPLETE, answer directly from this list):\n", len(yqlIssues)))
		ctxSB.WriteString("ID | Priority | Type | Summary | State | Assignee\n")
		for _, iss := range yqlIssues {
			issID := iss.IDReadable
			if issID == "" {
				issID = iss.ID
			}
			// Use readable ID for all map lookups — tracking logs and blocker cache store "ARD-NNN" not internal IDs
			lookupID := issID
			state := youtrack.GetStatus(iss)
			prio := youtrack.GetPriority(iss)
			issType := youtrack.GetCustomFieldValue(iss, "Type")
			asgn := ""
			if a := youtrack.GetAssignee(iss); a != nil {
				asgn = a.FullName
				if asgn == "" {
					asgn = a.Login
				}
			}
			flags := ""
			if bc := bounceCount[lookupID]; bc > 0 {
				flags += fmt.Sprintf(" bounces:%d", bc)
			}
			if overdueSet[lookupID] {
				flags += " [OVERDUE]"
			}
			blocker := ""
			if reason, ok := blockerReasons[lookupID]; ok && reason != "" {
				blocker = "\n  BLOCKER: " + reason
			}
			transitions := ""
			if tLines := issueTransitions[lookupID]; len(tLines) > 0 {
				transitions = "\n" + strings.Join(tLines, "\n")
			}
			ctxSB.WriteString(fmt.Sprintf("%s | %s | %s | %s | %s | %s%s%s%s\n",
				issID, prio, issType, iss.Summary, state, asgn, flags, blocker, transitions))
		}
	}
	dataContext := ctxSB.String()

	// ── 9. Inject sprint list + sprint-action instructions ────────────────────
	if len(availableSprints) > 0 {
		var sprintListSB strings.Builder
		sprintListSB.WriteString("AVAILABLE SPRINTS:\n")
		for i, s := range availableSprints {
			sprintListSB.WriteString(fmt.Sprintf("  %d. %s (id: %s)\n", i+1, s.Name, s.ID))
		}
		sprintListSB.WriteString("\nIf the user asks to select, switch to, or use a specific sprint, respond ONLY with valid JSON (no markdown, no extra text):\n")
		sprintListSB.WriteString(`{"answer":"<confirmation message>","action":"select_sprint","payload":{"sprint_id":"<id>","sprint_name":"<name>"}}`)
		sprintListSB.WriteString("\nFor all other queries, respond normally in plain text or markdown.\n\n")
		customInstructions = sprintListSB.String() + customInstructions
	}
	if req.SprintName != "" {
		customInstructions = fmt.Sprintf("ACTIVE SPRINT: %s\n\n", req.SprintName) + customInstructions
	}

	// ── 10. Assemble system prompt ────────────────────────────────────────────
	// queryContextHint is injected into the system prompt so the LLM knows what was
	// searched without ever including it in the visible response.
	systemPrompt := customInstructions + "\n\n[QUERY CONTEXT — internal, never output this section]\n" + queryContextHint + "\n---\n" + dataContext
	log.Printf("[PM-YQL] instructions=%d data=%d total=%d bytes", len(customInstructions), len(dataContext), len(systemPrompt)+len(req.Query))

	// ── 11. Query AI for final response ──────────────────────────────────────
	response, err := ai.QueryWithHistory(r.Context(), systemPrompt, req.History, req.Query)
	if err != nil {
		http.Error(w, "AI query failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// ── 12. Parse structured action response if AI returned JSON ────────────
	type actionPayload struct {
		SprintID   string `json:"sprint_id"`
		SprintName string `json:"sprint_name"`
	}
	type actionResponse struct {
		Answer  string        `json:"answer"`
		Action  string        `json:"action"`
		Payload actionPayload `json:"payload"`
	}
	// Strip any accidental echo of internal metadata lines the LLM should never output
	displayResponse := response
	for _, prefix := range []string{"SEARCH FILTER APPLIED:", "[QUERY CONTEXT", "INSTRUCTION: The issues"} {
		if idx := strings.Index(displayResponse, prefix); idx != -1 {
			// Find the end of the metadata block (double newline or "QUERY RESULTS")
			rest := displayResponse[idx:]
			cut := strings.Index(rest, "\n\n")
			if cut2 := strings.Index(rest, "QUERY RESULTS"); cut2 != -1 && (cut == -1 || cut2 < cut) {
				cut = cut2
			}
			if cut != -1 {
				displayResponse = strings.TrimSpace(displayResponse[:idx] + displayResponse[idx+cut:])
			} else {
				displayResponse = strings.TrimSpace(displayResponse[:idx])
			}
		}
	}
	respAction := ""
	var respPayload interface{}
	var ar actionResponse
	if parseErr := json.Unmarshal([]byte(strings.TrimSpace(response)), &ar); parseErr == nil && ar.Action != "" {
		displayResponse = ar.Answer
		respAction = ar.Action
		respPayload = ar.Payload
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"response": displayResponse,
			"action":   respAction,
			"payload":  respPayload,
		},
	})
}

// ============================================================
// YouTrack Webhook (Real-time State Updates)
// ============================================================

// HandleWebhook receives and processes YouTrack webhook events
// This endpoint does NOT require authentication — called by YouTrack server
func (h *YouTrackHandler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("[YouTrack Webhook] Failed to read body: %v", err)
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	// Log full raw payload so we can diagnose the exact structure YouTrack sends
	log.Printf("[YouTrack Webhook] Received payload (%d bytes): %s", len(body), string(body))

	// YouTrack sends an array of events or a single event object
	// Try to parse as a single event first, then as an array
	var events []youtrack.WebhookEvent

	var singleEvent youtrack.WebhookEvent
	if err := json.Unmarshal(body, &singleEvent); err == nil && singleEvent.Issue != nil {
		events = append(events, singleEvent)
	} else {
		// Try as array
		if err := json.Unmarshal(body, &events); err != nil {
			log.Printf("[YouTrack Webhook] Failed to parse payload: %v", err)
			// Still respond 200 so YouTrack doesn't retry
			w.WriteHeader(http.StatusOK)
			return
		}
	}

	// Process events asynchronously so we respond quickly
	go h.processWebhookEvents(events)

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// processWebhookEvents handles YouTrack webhook events in the background
func (h *YouTrackHandler) processWebhookEvents(events []youtrack.WebhookEvent) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	for _, event := range events {
		if event.Issue == nil {
			log.Printf("[YouTrack Webhook] Skipping event with no issue field")
			continue
		}

		// Prefer the human-readable ID (e.g. "ARD-628") over internal ID (e.g. "3-671").
		// YouTrack Cloud sends idReadable in the issue object; top-level issueId is also readable.
		issueID := event.Issue.ID
		if event.Issue.IDReadable != "" {
			issueID = event.Issue.IDReadable
		} else if event.IssueID != "" {
			issueID = event.IssueID
		}
		summary := event.Issue.Summary

		// Extract assignee, priority, issue type and the person who made the change
		assignee := ""
		priority := ""
		issueType := ""
		movedBy := ""
		if event.Issue != nil {
			if u := youtrack.GetAssignee(*event.Issue); u != nil {
				if u.FullName != "" {
					assignee = u.FullName
				} else {
					assignee = u.Login
				}
			}
			priority = youtrack.GetPriority(*event.Issue)
			// Extract type field (for hotfix/regression classification) using configured field name
			if h.configRepo != nil {
				if wfCfg, err := h.configRepo.GetEffective(ctx, "", "youtrack"); err == nil && wfCfg != nil {
					if wfCfg.HotfixRules.TypeFieldName != "" {
						issueType = youtrack.GetCustomFieldValue(*event.Issue, wfCfg.HotfixRules.TypeFieldName)
					}
				}
			}
		}
		if updater := event.GetUpdater(); updater != nil {
			if updater.FullName != "" {
				movedBy = updater.FullName
			} else {
				movedBy = updater.Login
			}
		}

		log.Printf("[YouTrack Webhook] Processing event for issue=%q summary=%q movedBy=%q assignee=%q", issueID, summary, movedBy, assignee)

		for _, change := range event.NormalizedChanges() {
			oldValue := youtrack.ExtractFieldChangeValue(change.OldValue)
			newValue := youtrack.ExtractFieldChangeValue(change.NewValue)

			log.Printf("[YouTrack Webhook] Issue %s field change: name=%q old=%q new=%q", issueID, change.Name, oldValue, newValue)

			if oldValue == "" || newValue == "" || oldValue == newValue {
				continue
			}

			// Broadcast SSE event for ALL field changes so frontend can react
			if h.sseHub != nil {
				h.sseHub.Broadcast(SSEEvent{
					Type: "youtrack_update",
					Data: map[string]interface{}{
						"issue_id":  issueID,
						"field":     change.Name,
						"old_value": oldValue,
						"new_value": newValue,
						"summary":   summary,
					},
				})
			}

			// Invalidate sprint board cache for all users so the next request
			// returns fresh data reflecting this YouTrack change.
			apiCache.InvalidatePrefix("board:")

			// Only process State changes for task sync + time tracking
			// Use case-insensitive match — YouTrack may send "state" or "State"
			if !strings.EqualFold(change.Name, "State") {
				continue
			}

			log.Printf("[YouTrack Webhook] State change confirmed: %s → %s for %s", oldValue, newValue, issueID)

			backward := isBackwardMove(oldValue, newValue)

			// --- Fetch latest comment for backward moves and blocked transitions ---
			// We do this synchronously (before inserting state log) so we can store the comment.
			latestComment := ""
			if backward || strings.EqualFold(newValue, "blocked") {
				if ytClient, err := h.getYouTrackClient(ctx); err == nil && ytClient != nil {
					if comments, err := ytClient.GetIssueComments(ctx, issueID); err == nil && len(comments) > 0 {
						latestComment = comments[len(comments)-1]
					}
				}
			}

			// --- Time Tracking: record state transition (with comment for backward/blocked moves) ---
			if h.reportRepo != nil {
				stateLog := &database.IssueStateLog{
					IssueID:        issueID,
					IssueSummary:   summary,
					Assignee:       assignee,
					MovedBy:        movedBy,
					FromState:      oldValue,
					ToState:        newValue,
					Priority:       priority,
					IssueType:      issueType,
					TransitionedAt: time.Now(),
					Comment:        latestComment,
				}
				if err := h.reportRepo.InsertStateLog(ctx, stateLog); err != nil {
					log.Printf("[YouTrack Webhook] Failed to insert state log for %s: %v", issueID, err)
				} else {
					log.Printf("[YouTrack Webhook] State log recorded: %s → %s for %s (moved by: %s)", oldValue, newValue, issueID, movedBy)
				}

				// --- DayTrack: log ticket tested when moved to a verified/QA column ---
				if h.dayTrackRepo != nil {
					mover := movedBy
					if mover == "" {
						mover = assignee
					}
					h.logYouTrackTestedToDayTrack(ctx, issueID, summary, mover, newValue)
				}
			}

			// --- Moved-by mismatch: notify when someone else moves a ticket ---
			if h.notifHandler != nil && assignee != "" && movedBy != "" && assignee != movedBy {
				notif := &models.Notification{
					Type:    "warning",
					Title:   "Ticket Moved by Non-Assignee: " + issueID,
					Message: fmt.Sprintf("%s (%s) was moved %s → %s by %s, but is assigned to %s", issueID, summary, oldValue, newValue, movedBy, assignee),
				}
				if err := h.notifHandler.CreateAndBroadcast(ctx, notif); err != nil {
					log.Printf("[YouTrack Webhook] Failed to send mismatch notification: %v", err)
				}
			}

			// --- Blocked notification: use already-fetched comment ---
			if strings.EqualFold(newValue, "blocked") && h.notifHandler != nil {
				h.notifyBlocked(ctx, issueID, summary, assignee, latestComment)
			}

			// --- Moved to DEV: "done" notification ---
			if strings.EqualFold(newValue, "dev") && h.notifHandler != nil {
				mover := movedBy
				if mover == "" {
					mover = assignee
				}
				notif := &models.Notification{
					Type:    "success",
					Title:   "Ticket Done: " + issueID,
					Message: fmt.Sprintf("%s (%s) moved to DEV by %s", issueID, summary, mover),
				}
				if err := h.notifHandler.CreateAndBroadcast(ctx, notif); err != nil {
					log.Printf("[YouTrack Webhook] Failed to send done notification: %v", err)
				}
			}

			// --- Backward movement: critical notification with comment check ---
			if backward {
				log.Printf("[YouTrack Webhook] ⚠ BACKWARD MOVE: %s → %s for %s (comment: %q)", oldValue, newValue, issueID, latestComment)
				if h.notifHandler != nil {
					mover := movedBy
					if mover == "" {
						mover = assignee
					}
					var msg string
					if latestComment != "" {
						msg = fmt.Sprintf("%s (%s) moved backward: %s → %s by %s. Reason: %s", issueID, summary, oldValue, newValue, mover, latestComment)
					} else {
						msg = fmt.Sprintf("%s (%s) moved backward: %s → %s by %s. ⚠ NO REASON COMMENT FOUND — developer must explain why.", issueID, summary, oldValue, newValue, mover)
					}
					notif := &models.Notification{
						Type:    "danger",
						Title:   fmt.Sprintf("⚠ Backward Move: %s (%s → %s)", issueID, oldValue, newValue),
						Message: msg,
					}
					_ = h.notifHandler.CreateAndBroadcast(ctx, notif)
				}

				// --- DayTrack: log QA rejection for the mover ---
				if h.dayTrackRepo != nil {
					mover := movedBy
					if mover == "" {
						mover = assignee
					}
					h.logYouTrackRejectedToDayTrack(ctx, issueID, summary, mover, oldValue, newValue)
				}
			}

			// Update the matching local task if it exists
			task, err := h.taskRepo.GetByYouTrackID(ctx, issueID)
			if err != nil {
				log.Printf("[YouTrack Webhook] No local task for %s: %v", issueID, err)
				continue
			}

			newLocalStatus := h.mapYouTrackStatusToLocal(newValue)
			task.Status = newLocalStatus
			sectionName := newValue
			task.SectionName = &sectionName

			if err := h.taskRepo.Update(ctx, task); err != nil {
				log.Printf("[YouTrack Webhook] Failed to update local task for %s: %v", issueID, err)
			} else {
				log.Printf("[YouTrack Webhook] Updated local task %s → %s", issueID, newLocalStatus)
			}
		}

		// --- DayTrack: log ticket creation ---
		// A creation event has no changes (or all oldValues are empty).
		// We deduplicate using external_ref = "yt-create-{issueID}" so re-fires don't double-log.
		if h.dayTrackRepo != nil && issueID != "" {
			changes := event.NormalizedChanges()
			isCreation := len(changes) == 0
			if !isCreation {
				allEmpty := true
				for _, c := range changes {
					if youtrack.ExtractFieldChangeValue(c.OldValue) != "" {
						allEmpty = false
						break
					}
				}
				isCreation = allEmpty
			}
			if isCreation && movedBy != "" {
				h.logYouTrackCreationToDayTrack(ctx, issueID, summary, movedBy)
			}
		}
	}
}

// testedEnvFromState maps a YouTrack toState column name to the environment that was tested.
// Returns ("", "", false) if the state is not a verified/QA column.
func testedEnvFromState(toState string) (env, extSuffix string, ok bool) {
	lower := strings.ToLower(toState)
	switch {
	case strings.Contains(lower, "ready for stage") || strings.Contains(lower, "ready for staging"):
		return "DEV", "dev", true
	case strings.Contains(lower, "ready for prod"):
		return "STAGE", "stage", true
	case strings.Contains(lower, "mobile done"):
		return "Mobile", "mobile", true
	case lower == "verified":
		return "PROD", "prod", true
	}
	return "", "", false
}

// logYouTrackTestedToDayTrack logs a "Verified on <env>" DayTrack entry for the person who moved the ticket.
func (h *YouTrackHandler) logYouTrackTestedToDayTrack(ctx context.Context, issueID, summary, moverName, toState string) {
	env, extSuffix, ok := testedEnvFromState(toState)
	if !ok || moverName == "" {
		return
	}
	pool := database.GetPool()
	var userID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1`, moverName,
	).Scan(&userID); err != nil {
		log.Printf("[YouTrack Webhook] DayTrack tested log: no user found for mover %q: %v", moverName, err)
		return
	}
	now := time.Now()
	entryName := issueID + ": Verified on " + env
	if summary != "" {
		full := issueID + ": " + summary + " – Verified on " + env
		if len(full) <= 120 {
			entryName = full
		}
	}
	extRef := "yt-tested-" + issueID + "-" + extSuffix
	_, err := h.dayTrackRepo.CreateEntrySourced(ctx, userID, now.Format("2006-01-02"),
		entryName, "Testing",
		now.Format("3:04 PM"), now.Format("3:04 PM"), nil, "", "done", nil,
		"youtrack", extRef)
	if err != nil {
		log.Printf("[YouTrack Webhook] DayTrack tested log failed for %s on %s: %v", issueID, env, err)
	} else {
		log.Printf("[YouTrack Webhook] DayTrack tested entry: %s verified on %s by %s", issueID, env, moverName)
	}
}

// logYouTrackRejectedToDayTrack logs a "QA Rejected" DayTrack entry for the person who moved a ticket backward.
func (h *YouTrackHandler) logYouTrackRejectedToDayTrack(ctx context.Context, issueID, summary, moverName, fromState, toState string) {
	if moverName == "" {
		return
	}
	pool := database.GetPool()
	var userID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1`, moverName,
	).Scan(&userID); err != nil {
		log.Printf("[YouTrack Webhook] DayTrack rejected log: no user found for mover %q: %v", moverName, err)
		return
	}
	now := time.Now()
	entryName := fmt.Sprintf("%s: QA Rejected — %s → %s", issueID, fromState, toState)
	if summary != "" {
		full := fmt.Sprintf("%s: %s – QA Rejected (%s → %s)", issueID, summary, fromState, toState)
		if len(full) <= 120 {
			entryName = full
		}
	}
	// Dedup key includes fromState so re-fires of the same transition don't double-log.
	extRef := "yt-rejected-" + issueID + "-" + strings.ToLower(strings.ReplaceAll(fromState, " ", "-"))
	_, err := h.dayTrackRepo.CreateEntrySourced(ctx, userID, now.Format("2006-01-02"),
		entryName, "Testing",
		now.Format("3:04 PM"), now.Format("3:04 PM"), nil, "", "done", nil,
		"youtrack", extRef)
	if err != nil {
		log.Printf("[YouTrack Webhook] DayTrack rejected log failed for %s: %v", issueID, err)
	} else {
		log.Printf("[YouTrack Webhook] DayTrack rejected entry: %s moved back from %s to %s by %s", issueID, fromState, toState, moverName)
	}
}

// logYouTrackCreationToDayTrack finds the system user matching the creator and logs a DayTrack entry.
func (h *YouTrackHandler) logYouTrackCreationToDayTrack(ctx context.Context, issueID, summary, creatorName string) {
	pool := database.GetPool()
	var userID string
	err := pool.QueryRow(ctx,
		`SELECT id FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1`, creatorName,
	).Scan(&userID)
	if err != nil {
		log.Printf("[YouTrack Webhook] DayTrack creation log: no user found for creator %q: %v", creatorName, err)
		return
	}
	now := time.Now()
	timeStr := now.Format("3:04 PM")
	dateStr := now.Format("2006-01-02")
	entryName := issueID + ": " + summary
	if len(entryName) > 120 {
		entryName = entryName[:117] + "..."
	}
	extRef := "yt-create-" + issueID
	_, err = h.dayTrackRepo.CreateEntrySourced(ctx, userID, dateStr,
		entryName, "Tickets Created",
		timeStr, timeStr, nil, "", "done", nil,
		"youtrack", extRef)
	if err != nil {
		log.Printf("[YouTrack Webhook] DayTrack creation log failed for %s: %v", issueID, err)
	} else {
		log.Printf("[YouTrack Webhook] DayTrack entry created for ticket %s by %s", issueID, creatorName)
	}
}

// ScanYouTrackTickets fetches YouTrack issues created on a given date by the logged-in user
// and logs any new ones to DayTrack (deduped by external_ref).
func (h *YouTrackHandler) ScanYouTrackTickets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := middleware.GetUserID(ctx)

	// Optional date payload — defaults to today
	var reqBody struct {
		Date string `json:"date"` // "YYYY-MM-DD"
	}
	_ = json.NewDecoder(r.Body).Decode(&reqBody)
	scanDate := strings.TrimSpace(reqBody.Date)
	if scanDate == "" {
		scanDate = time.Now().Format("2006-01-02")
	}
	// Validate format
	scanDay, parseErr := time.ParseInLocation("2006-01-02", scanDate, time.Local)
	if parseErr != nil {
		http.Error(w, "invalid date format, expected YYYY-MM-DD", http.StatusBadRequest)
		return
	}

	ytClient, err := h.getYouTrackClientForUser(ctx, userID)
	if err != nil || ytClient == nil {
		log.Printf("[ScanYTTickets] YouTrack client unavailable: %v", err)
		http.Error(w, "YouTrack not configured", http.StatusBadRequest)
		return
	}

	// Identify this user in YouTrack by calling /api/users/me with their token
	ytMe, err := ytClient.GetCurrentUser(ctx)
	if err != nil || ytMe == nil {
		log.Printf("[ScanYTTickets] GetCurrentUser failed: %v", err)
		http.Error(w, "Could not identify YouTrack user", http.StatusInternalServerError)
		return
	}
	issues, err := ytClient.GetIssuesCreatedToday(ctx, scanDate, "")
	if err != nil {
		log.Printf("[ScanYTTickets] GetIssuesCreatedToday error: %v", err)
		http.Error(w, "YouTrack query failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	added := 0
	skipped := 0
	for _, issue := range issues {
		issueID := issue.IDReadable
		if issueID == "" {
			issueID = issue.ID
		}

		reporterID := ""
		reporterLogin := ""
		if issue.Reporter != nil {
			reporterID = issue.Reporter.ID
			reporterLogin = issue.Reporter.Login
		}
		// Match by YT user ID (most reliable), then login as fallback
		idMatch := reporterID != "" && reporterID == ytMe.ID
		loginMatch := reporterLogin != "" && strings.EqualFold(reporterLogin, ytMe.Login)
		if !idMatch && !loginMatch {
			log.Printf("[ScanYTTickets] skipping %s — reporter id=%q login=%q doesn't match me id=%q login=%q", issueID, reporterID, reporterLogin, ytMe.ID, ytMe.Login)
			skipped++
			continue
		}

		createdAt := time.UnixMilli(issue.Created)
		timeStr := createdAt.Format("3:04 PM")
		dateStr := createdAt.Format("2006-01-02")
		entryName := issueID + ": " + issue.Summary
		if len(entryName) > 120 {
			entryName = entryName[:117] + "..."
		}
		extRef := "yt-create-" + issueID

		entry, createErr := h.dayTrackRepo.CreateEntrySourced(ctx, userID, dateStr,
			entryName, "Tickets Created",
			timeStr, timeStr, nil, "", "done", nil,
			"youtrack", extRef)
		if createErr != nil {
			log.Printf("[ScanYTTickets] CreateEntrySourced failed for %s: %v", issueID, createErr)
		} else if entry != nil {
			log.Printf("[ScanYTTickets] logged DayTrack entry for %s", issueID)
			added++
		}
	}

	// --- Hybrid tested-ticket sync ---
	//
	// PRIMARY (Option C — YQL issues query):
	//   Query YouTrack directly for issues updated by this user today whose current
	//   state matches a tested column. This is reliable regardless of project activity
	//   volume because it uses the issues API with a targeted YQL filter.
	//
	// SECONDARY (Option B — date-scoped activities stream):
	//   Query the activities page filtered to today's issues only. This catches tickets
	//   that the user moved to a tested state but were subsequently updated by someone
	//   else (so "updated by" no longer matches). The activities stream is now scoped to
	//   a single day, making the 500-item cap more than sufficient.
	//
	// ON CONFLICT (user_id, external_ref) DO NOTHING in the DB deduplicates any overlaps.

	testedAdded := 0
	seenExtRefs := make(map[string]struct{})

	// helper: create one tested DayTrack entry, track uniqueness in seenExtRefs.
	createTestedEntry := func(issueID, summary, toState, timeStr, dateStr string) {
		env, extSuffix, ok := testedEnvFromState(toState)
		if !ok {
			return
		}
		extRef := "yt-tested-" + issueID + "-" + extSuffix
		if _, dup := seenExtRefs[extRef]; dup {
			return
		}
		seenExtRefs[extRef] = struct{}{}

		entryName := issueID + ": Verified on " + env
		if summary != "" {
			if full := issueID + ": " + summary + " – Verified on " + env; len(full) <= 120 {
				entryName = full
			}
		}
		// CreateEntrySourced returns (nil, nil) when ON CONFLICT DO NOTHING skips the row.
		// Only count as newly added when a real row is returned.
		entry, createErr := h.dayTrackRepo.CreateEntrySourced(ctx, userID, dateStr,
			entryName, "Testing",
			timeStr, timeStr, nil, "", "done", nil,
			"youtrack", extRef)
		if createErr != nil {
			log.Printf("[ScanYTTickets] tested entry failed for %s: %v", issueID, createErr)
			return
		}
		if entry != nil {
			log.Printf("[ScanYTTickets] tested entry saved: issue=%s env=%s", issueID, env)
			testedAdded++
		}
	}

	// PRIMARY: issues updated by this user today whose current state is a tested column.
	yqlIssues, yqlErr := ytClient.GetIssuesUpdatedByUserToday(ctx, scanDate, ytMe.Login)
	if yqlErr != nil {
		log.Printf("[ScanYTTickets] YQL tested query error: %v", yqlErr)
	} else {
		for _, issue := range yqlIssues {
			issueID := issue.IDReadable
			if issueID == "" {
				issueID = issue.ID
			}
			stateName := youtrack.IssueStateName(issue)
			if stateName == "" {
				continue
			}
			if _, _, ok := testedEnvFromState(stateName); !ok {
				continue
			}
			updatedAt := time.UnixMilli(issue.Updated)
			log.Printf("[ScanYTTickets] tested yql: issue=%s state=%q updated=%s", issueID, stateName, updatedAt.Format(time.RFC3339))
			createTestedEntry(issueID, issue.Summary, stateName, updatedAt.Format("3:04 PM"), updatedAt.Format("2006-01-02"))
		}
	}

	// SECONDARY: date-scoped activities stream for tickets moved by this user but
	// since touched by someone else (so they'd fall outside the YQL "updated by" filter).
	todayStart := scanDay.Truncate(24 * time.Hour)
	todayEnd := todayStart.Add(24 * time.Hour)
	activities, actErr := ytClient.GetProjectActivities(ctx, 500, scanDate)
	if actErr != nil {
		log.Printf("[ScanYTTickets] GetProjectActivities error: %v", actErr)
	} else {
		for _, act := range activities {
			if act.Field.Presentation != "State" {
				continue
			}
			if act.Author == nil {
				continue
			}
			idMatch := act.Author.ID != "" && act.Author.ID == ytMe.ID
			loginMatch := act.Author.Login != "" && strings.EqualFold(act.Author.Login, ytMe.Login)
			if !idMatch && !loginMatch {
				continue
			}
			actTime := time.UnixMilli(act.Timestamp)
			if actTime.Before(todayStart) || !actTime.Before(todayEnd) {
				continue
			}
			if len(act.Added) == 0 {
				continue
			}
			toState := act.Added[0].Name
			if _, _, ok := testedEnvFromState(toState); !ok {
				continue
			}
			issueID := act.Target.IDReadable
			if issueID == "" {
				issueID = act.Target.ID
			}
			log.Printf("[ScanYTTickets] tested activity (secondary): issue=%s toState=%q author=%s", issueID, toState, act.Author.Login)
			createTestedEntry(issueID, act.Target.Summary, toState, actTime.Format("3:04 PM"), actTime.Format("2006-01-02"))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "added": added, "skipped": skipped, "tested": testedAdded})
}

// notifyBlocked fires a notification when a ticket moves to Blocked state.
// latestComment is the already-fetched YouTrack comment (may be empty).
func (h *YouTrackHandler) notifyBlocked(ctx context.Context, issueID, summary, assignee, latestComment string) {
	msg := fmt.Sprintf("%s (%s) is BLOCKED", issueID, summary)
	if latestComment != "" {
		msg += " — Reason: " + latestComment
	} else {
		msg += " — ⚠ No reason comment found. Developer must add a comment explaining the blocker."
	}
	if assignee != "" {
		msg += " | Assignee: " + assignee
	}

	notif := &models.Notification{
		Type:    "danger",
		Title:   "Blocked: " + issueID,
		Message: msg,
	}
	if err := h.notifHandler.CreateAndBroadcast(ctx, notif); err != nil {
		log.Printf("[YouTrack Webhook] Failed to send blocked notification: %v", err)
	}
}

// overdueThresholdHours returns hours before a ticket is considered overdue by priority
func overdueThresholdHours(priority string) float64 {
	switch strings.ToUpper(priority) {
	case "P0", "CRITICAL":
		return 4
	case "P1":
		return 24
	case "P2":
		return 48
	default: // P3, Normal, Other
		return 72
	}
}

// issueRow is a compact representation of a YouTrack issue for Daily Ops responses
type issueRow struct {
	ID            string `json:"id"`
	Summary       string `json:"summary"`
	Status        string `json:"status"`
	Priority      string `json:"priority"`
	Assignee      string `json:"assignee"`
	BlockerReason string `json:"blocker_reason,omitempty"`
}

func toIssueRow(issue map[string]interface{}) issueRow {
	str := func(v interface{}) string {
		if v == nil {
			return ""
		}
		s, _ := v.(string)
		return s
	}
	assignee := ""
	if a, ok := issue["assignee"]; ok && a != nil {
		if am, ok := a.(map[string]interface{}); ok {
			assignee = str(am["fullName"])
			if assignee == "" {
				assignee = str(am["login"])
			}
		}
	}
	return issueRow{
		ID:       str(issue["id"]),
		Summary:  str(issue["summary"]),
		Status:   str(issue["status"]),
		Priority: str(issue["priority"]),
		Assignee: assignee,
	}
}

// GetDailyBrief returns a grouped morning brief derived from live YouTrack data
// and yesterday's state transitions from issue_state_log.
// GET /api/youtrack/daily-brief
func (h *YouTrackHandler) GetDailyBrief(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	// Fetch live issues — sprint-scoped when sprint_id is provided
	sprintID := r.URL.Query().Get("sprint_id")
	var issues []youtrack.Issue
	if sprintID != "" {
		issues, err = client.GetAllSprintIssues(r.Context(), sprintID)
	} else {
		issues, err = client.GetIssues(r.Context())
	}
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	baseURL := client.GetBaseURL()

	// Transform to map for easier handling
	var allIssues []map[string]interface{}
	for _, issue := range issues {
		assignee := youtrack.GetAssignee(issue)
		if assignee != nil && assignee.AvatarUrl != "" && !strings.HasPrefix(assignee.AvatarUrl, "http") {
			assignee.AvatarUrl = baseURL + assignee.AvatarUrl
		}
		row := map[string]interface{}{
			"id":       issue.ID,
			"summary":  issue.Summary,
			"status":   youtrack.GetStatus(issue),
			"priority": youtrack.GetPriority(issue),
			"assignee": assignee,
		}
		allIssues = append(allIssues, row)
	}

	// Query done_yesterday from issue_state_log
	// "Done" = moved to Dev, Ready for Stage, Stage, Ready for PROD, or PROD yesterday
	pool := database.GetPool()
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	doneStates := []string{"Dev", "Ready for Stage", "Stage", "Ready for PROD", "PROD"}
	_ = doneStates

	rows, err := pool.Query(r.Context(), `
		SELECT DISTINCT ON (issue_id) issue_id, issue_summary, assignee, to_state, priority
		FROM issue_state_log
		WHERE DATE(transitioned_at AT TIME ZONE 'UTC') = $1
		  AND to_state = ANY($2)
		ORDER BY issue_id, transitioned_at DESC
	`, yesterday, []string{"Dev", "Ready for Stage", "Stage", "Ready for PROD", "PROD"})

	var doneYesterday []issueRow
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, summary, assignee, toState, priority string
			if scanErr := rows.Scan(&id, &summary, &assignee, &toState, &priority); scanErr == nil {
				doneYesterday = append(doneYesterday, issueRow{
					ID: id, Summary: summary, Status: toState, Priority: priority, Assignee: assignee,
				})
			}
		}
	} else {
		log.Printf("[DailyBrief] issue_state_log query failed: %v", err)
	}

	// Group live issues by priority (exclude Closed)
	var p0, p1, p2, p3, blockedOurs, blockedTheirs, openItems, unassigned []issueRow
	for _, issue := range allIssues {
		status := ""
		if s, ok := issue["status"].(string); ok {
			status = s
		}
		if strings.EqualFold(status, "Closed") {
			continue
		}

		row := toIssueRow(issue)
		isBlocked := strings.EqualFold(status, "Blocked")

		if isBlocked {
			// Heuristic: if no assignee → blocked from their side, else ours
			if row.Assignee == "" {
				blockedTheirs = append(blockedTheirs, row)
			} else {
				blockedOurs = append(blockedOurs, row)
			}
			continue
		}

		if row.Assignee == "" && !strings.EqualFold(status, "Backlog") {
			unassigned = append(unassigned, row)
		}

		p := strings.ToUpper(row.Priority)
		switch {
		case p == "P0" || p == "CRITICAL":
			p0 = append(p0, row)
		case p == "P1":
			p1 = append(p1, row)
		case p == "P2":
			p2 = append(p2, row)
		default:
			p3 = append(p3, row)
		}
	}

	// Open items: state = "In Progress" with no assignee OR backlog with special tag
	// For now, treat unassigned In-Progress as open items
	for _, issue := range allIssues {
		status := ""
		if s, ok := issue["status"].(string); ok {
			status = s
		}
		if strings.EqualFold(status, "In Progress") {
			row := toIssueRow(issue)
			if row.Assignee == "" {
				openItems = append(openItems, row)
			}
		}
	}

	if doneYesterday == nil {
		doneYesterday = []issueRow{}
	}
	if p0 == nil { p0 = []issueRow{} }
	if p1 == nil { p1 = []issueRow{} }
	if p2 == nil { p2 = []issueRow{} }
	if p3 == nil { p3 = []issueRow{} }
	if blockedOurs == nil { blockedOurs = []issueRow{} }
	if blockedTheirs == nil { blockedTheirs = []issueRow{} }
	if openItems == nil { openItems = []issueRow{} }
	if unassigned == nil { unassigned = []issueRow{} }

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"done_yesterday":  doneYesterday,
			"p0":              p0,
			"p1":              p1,
			"p2":              p2,
			"p3":              p3,
			"blocked_ours":    blockedOurs,
			"blocked_theirs":  blockedTheirs,
			"open_items":      openItems,
			"unassigned":      unassigned,
			"generated_at":    time.Now().Format(time.RFC3339),
		},
	})
}

// GetEODSummary returns today's completed, in-progress, no-movement, and new-blocker issues.
// GET /api/youtrack/eod-summary
func (h *YouTrackHandler) GetEODSummary(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	today := time.Now().Format("2006-01-02")
	pool := database.GetPool()

	// completed_today: transitioned to forward states today
	completedRows, err := pool.Query(r.Context(), `
		SELECT DISTINCT ON (issue_id) issue_id, issue_summary, assignee, to_state, priority
		FROM issue_state_log
		WHERE DATE(transitioned_at AT TIME ZONE 'UTC') = $1
		  AND to_state = ANY($2)
		ORDER BY issue_id, transitioned_at DESC
	`, today, []string{"Dev", "Ready for Stage", "Stage", "Ready for PROD", "PROD"})

	var completedToday []issueRow
	if err == nil {
		defer completedRows.Close()
		for completedRows.Next() {
			var id, summary, assignee, toState, priority string
			if scanErr := completedRows.Scan(&id, &summary, &assignee, &toState, &priority); scanErr == nil {
				completedToday = append(completedToday, issueRow{ID: id, Summary: summary, Status: toState, Priority: priority, Assignee: assignee})
			}
		}
	}

	// new_blockers: transitioned to Blocked today
	blockerRows, err := pool.Query(r.Context(), `
		SELECT DISTINCT ON (issue_id) issue_id, issue_summary, assignee, to_state, priority
		FROM issue_state_log
		WHERE DATE(transitioned_at AT TIME ZONE 'UTC') = $1
		  AND LOWER(to_state) = 'blocked'
		ORDER BY issue_id, transitioned_at DESC
	`, today)

	var newBlockers []issueRow
	if err == nil {
		defer blockerRows.Close()
		for blockerRows.Next() {
			var id, summary, assignee, toState, priority string
			if scanErr := blockerRows.Scan(&id, &summary, &assignee, &toState, &priority); scanErr == nil {
				newBlockers = append(newBlockers, issueRow{ID: id, Summary: summary, Status: toState, Priority: priority, Assignee: assignee})
			}
		}
	}

	// Fetch live issues for still_in_progress and no_movement
	issues, err := client.GetIssues(r.Context())
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Build set of issue IDs that had transitions today
	movedToday := make(map[string]bool)
	movedTodayRows, qErr := pool.Query(r.Context(), `
		SELECT DISTINCT issue_id FROM issue_state_log
		WHERE DATE(transitioned_at AT TIME ZONE 'UTC') = $1
	`, today)
	if qErr == nil {
		defer movedTodayRows.Close()
		for movedTodayRows.Next() {
			var id string
			if scanErr := movedTodayRows.Scan(&id); scanErr == nil {
				movedToday[id] = true
			}
		}
	}

	var stillInProgress, noMovement []issueRow
	for _, issue := range issues {
		status := youtrack.GetStatus(issue)
		if !strings.EqualFold(status, "In Progress") {
			continue
		}
		assignee := youtrack.GetAssignee(issue)
		assigneeName := ""
		if assignee != nil {
			assigneeName = assignee.FullName
			if assigneeName == "" {
				assigneeName = assignee.Login
			}
		}
		row := issueRow{
			ID:       issue.ID,
			Summary:  issue.Summary,
			Status:   status,
			Priority: youtrack.GetPriority(issue),
			Assignee: assigneeName,
		}
		if movedToday[issue.ID] {
			stillInProgress = append(stillInProgress, row)
		} else {
			noMovement = append(noMovement, row)
		}
	}

	if completedToday == nil { completedToday = []issueRow{} }
	if newBlockers == nil { newBlockers = []issueRow{} }
	if stillInProgress == nil { stillInProgress = []issueRow{} }
	if noMovement == nil { noMovement = []issueRow{} }

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"completed_today":   completedToday,
			"still_in_progress": stillInProgress,
			"no_movement":       noMovement,
			"new_blockers":      newBlockers,
			"date":              today,
		},
	})
}

// GetDeveloperLoad returns per-assignee workload: active issues, blocked, avg hours per priority.
// GET /api/youtrack/developer-load
func (h *YouTrackHandler) GetDeveloperLoad(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	sprintID := r.URL.Query().Get("sprint_id")
	var issues []youtrack.Issue
	if sprintID != "" {
		issues, err = client.GetAllSprintIssues(r.Context(), sprintID)
		if err != nil {
			// fallback: try resolving sprint name
			if sprints, sErr := client.GetSprints(r.Context()); sErr == nil {
				for _, s := range sprints {
					if s.ID == sprintID {
						issues, err = client.GetIssuesByStateForSprint(r.Context(), s.Name, nil)
						break
					}
				}
			}
		}
	} else {
		issues, err = client.GetIssues(r.Context())
	}
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	type devLoad struct {
		Assignee        string     `json:"assignee"`
		ActiveIssues    []issueRow `json:"active_issues"`
		BlockedIssues   []issueRow `json:"blocked_issues"`
		DoneToday       int        `json:"done_today"`
		AvgHoursPerP1   float64    `json:"avg_hours_per_p1"`
		AvgHoursPerP2   float64    `json:"avg_hours_per_p2"`
		LastActivityAt  *string    `json:"last_activity_at"`
		MissingUpdate   bool       `json:"missing_update"`
		Overloaded      bool       `json:"overloaded"`
	}

	loadsMap := make(map[string]*devLoad)

	for _, issue := range issues {
		status := youtrack.GetStatus(issue)
		if strings.EqualFold(status, "Closed") {
			continue
		}
		assignee := youtrack.GetAssignee(issue)
		if assignee == nil {
			continue
		}
		name := assignee.FullName
		if name == "" {
			name = assignee.Login
		}
		if name == "" {
			continue
		}

		if loadsMap[name] == nil {
			loadsMap[name] = &devLoad{
				Assignee:      name,
				ActiveIssues:  []issueRow{},
				BlockedIssues: []issueRow{},
			}
		}
		dl := loadsMap[name]
		row := issueRow{
			ID:       issue.ID,
			Summary:  issue.Summary,
			Status:   status,
			Priority: youtrack.GetPriority(issue),
			Assignee: name,
		}
		if strings.EqualFold(status, "Blocked") {
			dl.BlockedIssues = append(dl.BlockedIssues, row)
		} else if sprintID != "" {
			// Sprint-scoped: all non-closed, non-blocked issues count as active
			dl.ActiveIssues = append(dl.ActiveIssues, row)
		} else if strings.EqualFold(status, "In Progress") {
			dl.ActiveIssues = append(dl.ActiveIssues, row)
		}
	}

	// Per-assignee: avg hours in In Progress before reaching Dev, grouped by priority
	// Also: done_today count and last_activity_at
	pool := database.GetPool()
	today := time.Now().Format("2006-01-02")

	avgRows, qErr := pool.Query(r.Context(), `
		SELECT
			assignee,
			priority,
			AVG(duration_in_prev_state_hours) as avg_hours
		FROM issue_state_log
		WHERE LOWER(to_state) = 'dev'
		  AND duration_in_prev_state_hours IS NOT NULL
		  AND assignee IS NOT NULL AND assignee != ''
		GROUP BY assignee, priority
	`)
	if qErr == nil {
		defer avgRows.Close()
		for avgRows.Next() {
			var assignee, priority string
			var avgHours float64
			if scanErr := avgRows.Scan(&assignee, &priority, &avgHours); scanErr == nil {
				if loadsMap[assignee] == nil {
					loadsMap[assignee] = &devLoad{
						Assignee:      assignee,
						ActiveIssues:  []issueRow{},
						BlockedIssues: []issueRow{},
					}
				}
				p := strings.ToUpper(priority)
				if p == "P1" {
					loadsMap[assignee].AvgHoursPerP1 = avgHours
				} else if p == "P2" {
					loadsMap[assignee].AvgHoursPerP2 = avgHours
				}
			}
		}
	}

	// done_today per assignee
	doneTodayRows, qErr := pool.Query(r.Context(), `
		SELECT assignee, COUNT(*) as cnt
		FROM issue_state_log
		WHERE DATE(transitioned_at AT TIME ZONE 'UTC') = $1
		  AND to_state = ANY($2)
		  AND assignee IS NOT NULL AND assignee != ''
		GROUP BY assignee
	`, today, []string{"Dev", "Ready for Stage", "Stage", "Ready for PROD", "PROD"})
	if qErr == nil {
		defer doneTodayRows.Close()
		for doneTodayRows.Next() {
			var assignee string
			var cnt int
			if scanErr := doneTodayRows.Scan(&assignee, &cnt); scanErr == nil {
				if loadsMap[assignee] == nil {
					loadsMap[assignee] = &devLoad{
						Assignee:      assignee,
						ActiveIssues:  []issueRow{},
						BlockedIssues: []issueRow{},
					}
				}
				loadsMap[assignee].DoneToday = cnt
			}
		}
	}

	// last_activity_at per assignee
	lastActivityRows, qErr := pool.Query(r.Context(), `
		SELECT assignee, MAX(transitioned_at) as last_at
		FROM issue_state_log
		WHERE assignee IS NOT NULL AND assignee != ''
		GROUP BY assignee
	`)
	if qErr == nil {
		defer lastActivityRows.Close()
		for lastActivityRows.Next() {
			var assignee string
			var lastAt time.Time
			if scanErr := lastActivityRows.Scan(&assignee, &lastAt); scanErr == nil {
				if loadsMap[assignee] == nil {
					loadsMap[assignee] = &devLoad{
						Assignee:      assignee,
						ActiveIssues:  []issueRow{},
						BlockedIssues: []issueRow{},
					}
				}
				lastAtStr := lastAt.Format(time.RFC3339)
				loadsMap[assignee].LastActivityAt = &lastAtStr
				// missing_update: no transition today
				loadsMap[assignee].MissingUpdate = !strings.HasPrefix(lastAt.Format("2006-01-02"), today)
			}
		}
	}

	// overloaded: >3 In Progress issues
	var result []devLoad
	for _, dl := range loadsMap {
		dl.Overloaded = len(dl.ActiveIssues) > 3
		result = append(result, *dl)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    result,
	})
}

// GetBlockerReasons returns AI-extracted blocker reasons for a set of issue IDs.
// Results are cached in blocker_analysis_cache and only re-analysed when a new comment
// is added or the issue has moved out of Blocked state.
// GET /api/youtrack/blocker-reasons?ids=ARD-123,ARD-456
func (h *YouTrackHandler) GetBlockerReasons(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idsParam := r.URL.Query().Get("ids")
	if idsParam == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": map[string]string{}})
		return
	}
	ids := strings.Split(idsParam, ",")

	client, err := h.getYouTrackClient(r.Context())
	if err != nil || client == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	pool := database.GetPool()
	reasons := make(map[string]string)

	for _, rawID := range ids {
		issueID := strings.TrimSpace(rawID)
		if issueID == "" {
			continue
		}

		// Fetch live comments to get current count
		comments, commErr := client.GetIssueComments(r.Context(), issueID)
		currentCount := len(comments)

		// Check cache
		var cachedReason string
		var cachedCount int
		var cachedState string
		row := pool.QueryRow(r.Context(),
			`SELECT reason, comment_count, last_state FROM blocker_analysis_cache WHERE issue_id = $1`,
			issueID,
		)
		cacheHit := row.Scan(&cachedReason, &cachedCount, &cachedState) == nil

		// Determine if cache is still valid:
		// valid = cache exists AND comment count hasn't grown AND issue is still Blocked
		if cacheHit && currentCount == cachedCount && strings.EqualFold(cachedState, "Blocked") {
			reasons[issueID] = cachedReason
			continue
		}

		// Need to (re-)analyse
		var reason string
		if commErr != nil || len(comments) == 0 {
			reason = "No comments — reason unknown"
		} else {
			reason = analyseBlockerComments(r.Context(), issueID, comments)
		}

		// Upsert cache
		_, _ = pool.Exec(r.Context(),
			`INSERT INTO blocker_analysis_cache(issue_id, reason, comment_count, last_state, analyzed_at)
			 VALUES($1,$2,$3,'Blocked',NOW())
			 ON CONFLICT(issue_id) DO UPDATE
			   SET reason=$2, comment_count=$3, last_state='Blocked', analyzed_at=NOW()`,
			issueID, reason, currentCount,
		)

		reasons[issueID] = reason
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    reasons,
	})
}

// analyseBlockerComments calls the AI to extract a one-sentence blocker reason from comments.
func analyseBlockerComments(ctx context.Context, issueID string, comments []string) string {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("OPENAI_API_KEY")
	}
	if apiKey == "" {
		return "AI not configured"
	}

	apiURL := "https://api.groq.com/openai/v1/chat/completions"
	model := "llama-3.3-70b-versatile"
	if os.Getenv("GROQ_API_KEY") == "" {
		apiURL = "https://api.openai.com/v1/chat/completions"
		model = "gpt-4o-mini"
	}

	commentText := strings.Join(comments, "\n---\n")
	if len(commentText) > 4000 {
		commentText = commentText[:4000] + "…"
	}

	prompt := fmt.Sprintf(
		"The following comments are from a blocked YouTrack ticket (%s).\nIn ONE short sentence, what is blocking this ticket? Be specific.\n\nComments:\n%s",
		issueID, commentText,
	)

	reqBody := map[string]interface{}{
		"model":  model,
		"stream": false,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewBuffer(bodyBytes))
	if err != nil {
		return "AI request error"
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return "AI unavailable"
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)

	var aiResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(respBytes, &aiResp) != nil || len(aiResp.Choices) == 0 {
		return "Could not analyse"
	}
	return strings.TrimSpace(aiResp.Choices[0].Message.Content)
}

// SaveCarryoverPlan saves today's EOD action items for carry-over to tomorrow's morning brief.
// POST /api/youtrack/save-plan
func (h *YouTrackHandler) SaveCarryoverPlan(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Items []struct {
			Text string `json:"text"`
			Done bool   `json:"done"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	itemsJSON, err := json.Marshal(req.Items)
	if err != nil {
		http.Error(w, "Failed to encode items", http.StatusInternalServerError)
		return
	}

	today := time.Now().Format("2006-01-02")
	pool := database.GetPool()
	_, err = pool.Exec(r.Context(),
		`INSERT INTO daily_ops_carryover(user_id, date, items)
		 VALUES($1, $2, $3)
		 ON CONFLICT(user_id, date) DO UPDATE
		   SET items=$3, updated_at=NOW()`,
		userID, today, itemsJSON,
	)
	if err != nil {
		http.Error(w, "Failed to save plan: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

// ============================================================
// Feature Groups — cross-ticket status clustering
// ============================================================

// FeatureIssue is one ticket inside a feature cluster.
type FeatureIssue struct {
	IDReadable   string `json:"id_readable"`
	Summary      string `json:"summary"`
	IssueType    string `json:"issue_type"`   // FE, BE, RAG, Mobile, etc.
	CurrentState string `json:"current_state"`
	StateClass   string `json:"state_class"` // "done"|"active"|"pending"|"blocked"
	Assignee     string `json:"assignee"`
	Priority     string `json:"priority"`
	InSprint     bool   `json:"in_sprint"`
}

// FeatureGroup is a cluster of related tickets that belong to the same feature.
type FeatureGroup struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Issues     []FeatureIssue `json:"issues"`
	DoneCount  int            `json:"done_count"`
	TotalCount int            `json:"total_count"`
	Health     string         `json:"health"` // "done"|"partial"|"pending"
}

// classifyState maps a YouTrack state name to a broad state class.
func classifyState(state string) string {
	s := strings.ToLower(state)
	doneKeywords := []string{"dev done", "verified", "closed", "released", "stage done", "prod done", "done", "fixed", "ready for prod"}
	for _, kw := range doneKeywords {
		if strings.Contains(s, kw) {
			return "done"
		}
	}
	if strings.Contains(s, "in progress") || strings.Contains(s, "in-progress") {
		return "active"
	}
	if strings.Contains(s, "blocked") {
		return "blocked"
	}
	return "pending"
}

// issueTypeFromSummary extracts the ticket type prefix (FE, BE, RAG, etc.) from the summary.
func issueTypeFromSummary(summary string) string {
	upper := strings.ToUpper(summary)
	prefixes := []struct{ keyword, typ string }{
		{"FE", "FE"}, {"BE", "BE"}, {"RAG", "RAG"}, {"MOBILE", "Mobile"},
		{"INFRA", "Infra"}, {"DEVOPS", "DevOps"}, {"QA", "QA"},
	}
	priorityPrefixes := []string{"P0 ", "P1 ", "P2 ", "P3 "}
	for _, p := range prefixes {
		kw := p.keyword + " "
		if strings.HasPrefix(upper, kw) {
			return p.typ
		}
		for _, pri := range priorityPrefixes {
			if strings.HasPrefix(upper, pri+kw) {
				return p.typ
			}
		}
	}
	return "Other"
}

// featureNameFromSummary strips the priority prefix and FE/BE/RAG prefix to get the feature label.
var featurePrefixRe = regexp.MustCompile(`(?i)^(?:P\d+\s+)?(?:FE|BE|RAG|Mobile|Frontend|Backend|Infra|QA)\s+\S+:\s*`)

func featureNameFromSummary(summary string) string {
	name := featurePrefixRe.ReplaceAllString(summary, "")
	if strings.TrimSpace(name) == "" {
		return summary
	}
	return strings.TrimSpace(name)
}

// GetFeatureGroups clusters sprint tickets into feature groups by shared links and description cross-references.
// GET /api/youtrack/feature-groups?sprint_id=<id>
func (h *YouTrackHandler) GetFeatureGroups(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	sprintID := r.URL.Query().Get("sprint_id")
	if sprintID == "" {
		http.Error(w, "sprint_id is required", http.StatusBadRequest)
		return
	}

	ytClient, err := h.getYouTrackClient(r.Context())
	if err != nil || ytClient == nil {
		http.Error(w, "YouTrack is not configured", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	sprintIssues, err := ytClient.GetAllSprintIssues(ctx, sprintID)
	if err != nil {
		http.Error(w, "Failed to fetch sprint issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Build a map: IDReadable → Issue for quick lookups
	issueMap := make(map[string]youtrack.Issue, len(sprintIssues))
	for _, iss := range sprintIssues {
		issueMap[iss.IDReadable] = iss
	}

	// adjacency list: IDReadable → set of linked IDReadables
	adj := make(map[string]map[string]struct{}, len(sprintIssues))
	addEdge := func(a, b string) {
		if _, ok := adj[a]; !ok {
			adj[a] = make(map[string]struct{})
		}
		if _, ok := adj[b]; !ok {
			adj[b] = make(map[string]struct{})
		}
		adj[a][b] = struct{}{}
		adj[b][a] = struct{}{}
	}

	// ── Source 1: description regex parsing ──────────────────────────────────
	descLinkRe := regexp.MustCompile(`(?i)(?:FE|BE|RAG|Mobile|Frontend|Backend)\s+Ticket\s+Link:\s+(ARD-\d+)`)
	for _, iss := range sprintIssues {
		matches := descLinkRe.FindAllStringSubmatch(iss.Description, -1)
		for _, m := range matches {
			linkedID := m[1]
			if linkedID != iss.IDReadable {
				addEdge(iss.IDReadable, linkedID)
			}
		}
	}

	// ── Source 2: YouTrack native links (concurrent fetch) ───────────────────
	type linkResult struct {
		issueID string
		links   []youtrack.IssueLink
	}
	sem := make(chan struct{}, 8)
	resultCh := make(chan linkResult, len(sprintIssues))

	var wg sync.WaitGroup
	for _, iss := range sprintIssues {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			links, lerr := ytClient.GetIssueLinks(ctx, id)
			if lerr != nil {
				log.Printf("[FeatureGroups] GetIssueLinks failed for %s: %v", id, lerr)
				return
			}
			resultCh <- linkResult{issueID: id, links: links}
		}(iss.IDReadable)
	}
	wg.Wait()
	close(resultCh)

	// Collect states for linked issues that may not be in the sprint
	linkedStateMap := make(map[string]string) // IDReadable → state
	for res := range resultCh {
		for _, link := range res.links {
			if link.IDReadable != "" && link.IDReadable != res.issueID {
				addEdge(res.issueID, link.IDReadable)
				if link.State != "" {
					linkedStateMap[link.IDReadable] = link.State
				}
			}
		}
	}

	// ── Union-Find ────────────────────────────────────────────────────────────
	// Collect all node IDs (sprint + any externally linked)
	allNodes := make(map[string]struct{})
	for _, iss := range sprintIssues {
		allNodes[iss.IDReadable] = struct{}{}
	}
	for id := range adj {
		allNodes[id] = struct{}{}
	}

	parent := make(map[string]string)
	for id := range allNodes {
		parent[id] = id
	}
	var find func(x string) string
	find = func(x string) string {
		if parent[x] != x {
			parent[x] = find(parent[x])
		}
		return parent[x]
	}
	union := func(a, b string) {
		ra, rb := find(a), find(b)
		if ra != rb {
			parent[ra] = rb
		}
	}
	for id, neighbours := range adj {
		for nb := range neighbours {
			union(id, nb)
		}
	}

	// Group by component
	components := make(map[string][]string)
	for id := range allNodes {
		root := find(id)
		components[root] = append(components[root], id)
	}

	// ── Build FeatureGroup per component ─────────────────────────────────────
	var groups []FeatureGroup
	for _, members := range components {
		if len(members) < 2 {
			continue
		}

		var issues []FeatureIssue
		for _, id := range members {
			var state, assignee, priority, summary string
			inSprint := false

			if iss, ok := issueMap[id]; ok {
				inSprint = true
				summary = iss.Summary
				state = youtrack.GetStatus(iss)
				priority = youtrack.GetPriority(iss)
				if u := youtrack.GetAssignee(iss); u != nil {
					assignee = u.FullName
					if assignee == "" {
						assignee = u.Login
					}
				}
			} else {
				// External linked issue — use state from link response
				state = linkedStateMap[id]
				summary = id // fallback label
			}

			issues = append(issues, FeatureIssue{
				IDReadable:   id,
				Summary:      summary,
				IssueType:    issueTypeFromSummary(summary),
				CurrentState: state,
				StateClass:   classifyState(state),
				Assignee:     assignee,
				Priority:     priority,
				InSprint:     inSprint,
			})
		}

		// Count done
		doneCount := 0
		for _, iss := range issues {
			if iss.StateClass == "done" {
				doneCount++
			}
		}

		health := "pending"
		if doneCount == len(issues) {
			health = "done"
		} else if doneCount > 0 {
			health = "partial"
		}

		// Feature name: use the first sprint issue's cleaned summary
		featureName := ""
		for _, iss := range issues {
			if iss.InSprint {
				featureName = featureNameFromSummary(iss.Summary)
				break
			}
		}
		if featureName == "" && len(issues) > 0 {
			featureName = featureNameFromSummary(issues[0].Summary)
		}

		// Use first sprint member ID as group ID
		groupID := ""
		for _, iss := range issues {
			if iss.InSprint {
				groupID = iss.IDReadable
				break
			}
		}
		if groupID == "" {
			groupID = issues[0].IDReadable
		}

		groups = append(groups, FeatureGroup{
			ID:         groupID,
			Name:       featureName,
			Issues:     issues,
			DoneCount:  doneCount,
			TotalCount: len(issues),
			Health:     health,
		})
	}

	// Sort: partial first, then pending, then done
	healthOrder := map[string]int{"partial": 0, "pending": 1, "done": 2}
	for i := 0; i < len(groups)-1; i++ {
		for j := i + 1; j < len(groups); j++ {
			if healthOrder[groups[i].Health] > healthOrder[groups[j].Health] {
				groups[i], groups[j] = groups[j], groups[i]
			}
		}
	}

	if groups == nil {
		groups = []FeatureGroup{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    groups,
	})
}

// GetCarryover returns yesterday's saved action items (for morning brief) and today's (for EOD).
// GET /api/youtrack/carryover
func (h *YouTrackHandler) GetCarryover(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	pool := database.GetPool()
	today := time.Now().Format("2006-01-02")
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")

	type carryoverItem struct {
		Text string `json:"text"`
		Done bool   `json:"done"`
	}

	fetchItems := func(date string) []carryoverItem {
		var rawItems []byte
		err := pool.QueryRow(r.Context(),
			`SELECT items FROM daily_ops_carryover WHERE user_id=$1 AND date=$2`,
			userID, date,
		).Scan(&rawItems)
		if err != nil {
			return []carryoverItem{}
		}
		var items []carryoverItem
		if json.Unmarshal(rawItems, &items) != nil {
			return []carryoverItem{}
		}
		return items
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":        true,
		"data": map[string]interface{}{
			"yesterday":      fetchItems(yesterday),
			"today":          fetchItems(today),
			"yesterday_date": yesterday,
			"today_date":     today,
		},
	})
}
