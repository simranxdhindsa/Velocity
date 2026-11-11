package handlers

// AsanaPMHandler mirrors all YouTrack PM endpoints but fetches data from Asana.
// All response shapes are identical to the YouTrack handler so the frontend can
// switch sources transparently.
//
// Routes (all protected by AuthMiddleware):
//   GET  /api/asana/pm/status
//   GET  /api/asana/pm/projects
//   GET  /api/asana/pm/boards
//   GET  /api/asana/pm/boards/{board_id}/columns
//   GET  /api/asana/pm/states
//   GET  /api/asana/pm/priorities
//   GET  /api/asana/pm/users
//   GET  /api/asana/pm/issues
//   POST /api/asana/pm/issues
//   GET  /api/asana/pm/issues/grouped-by-assignee
//   GET  /api/asana/pm/issues/{gid}
//   PUT  /api/asana/pm/issues/{gid}
//   PATCH /api/asana/pm/issues/{gid}
//   DELETE /api/asana/pm/issues/{gid}
//   PATCH /api/asana/pm/issues/{gid}/state
//   POST /api/asana/pm/match-analysis
//   POST /api/asana/pm/pm-query
//   GET  /api/asana/pm/daily-brief
//   GET  /api/asana/pm/eod-summary
//   GET  /api/asana/pm/developer-load
//   GET  /api/asana/pm/blocker-reasons
//   POST /api/asana/pm/save-plan
//   GET  /api/asana/pm/carryover
//   GET  /api/asana/pm/sections
//   POST /api/asana/pm/import

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/logging"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	"github.com/dhindsa/project-management/internal/services/ai"
	"github.com/dhindsa/project-management/internal/services/asana"
	"github.com/gorilla/mux"
)

// AsanaPMHandler handles all Asana PM-mode endpoints
type AsanaPMHandler struct {
	integrationRepo *database.IntegrationRepository
	settingsRepo    *database.SettingsRepository
	sectionRepo     *database.SectionRepository
	projectRepo     *database.ProjectRepository
	taskRepo        *database.TaskRepository
	asanaPMRepo     *database.AsanaPMRepository
	configRepo      *database.WorkflowConfigRepository
	reportRepo      *database.ReportRepository
	botRepo         *database.BotConfigRepository
}

// NewAsanaPMHandler creates a new AsanaPMHandler
func NewAsanaPMHandler() *AsanaPMHandler {
	return &AsanaPMHandler{
		integrationRepo: database.NewIntegrationRepository(),
		settingsRepo:    database.NewSettingsRepository(),
		sectionRepo:     database.NewSectionRepository(),
		projectRepo:     database.NewProjectRepository(),
		taskRepo:        database.NewTaskRepository(),
		asanaPMRepo:     database.NewAsanaPMRepository(),
		configRepo:      database.NewWorkflowConfigRepository(),
		reportRepo:      database.NewReportRepository(),
		botRepo:         database.NewBotConfigRepository(),
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// getAsanaClient resolves credentials: per-user asana_integrations → global_settings → env
func (h *AsanaPMHandler) getAsanaClient(ctx context.Context, userID string) (*asana.Client, string, string, error) {
	var pat, projectGID, workspaceGID string

	// 1. Per-user integration
	if userID != "" {
		if integ, err := h.integrationRepo.GetAsanaIntegration(ctx, userID); err == nil && integ != nil && integ.Connected {
			pat = integ.AccessToken
			workspaceGID = integ.WorkspaceID
			if integ.ProjectID != "" {
				projectGID = integ.ProjectID
			}
		}
	}

	// 2. Global settings DB — only fills gaps not already set by per-user integration
	settings, _ := h.settingsRepo.GetAsanaSettings(ctx)
	if settings != nil && settings.Configured {
		if pat == "" {
			pat = settings.PAT
		}
		if projectGID == "" && settings.ProjectID != "" {
			projectGID = settings.ProjectID
		}
		if workspaceGID == "" {
			workspaceGID = settings.WorkspaceID
		}
	}

	// 3. Environment variables
	if pat == "" {
		pat = os.Getenv("ASANA_PAT")
	}
	if projectGID == "" {
		projectGID = os.Getenv("ASANA_PROJECT_ID")
	}
	if workspaceGID == "" {
		workspaceGID = os.Getenv("ASANA_WORKSPACE_ID")
	}

	if pat == "" {
		return nil, "", "", fmt.Errorf("Asana is not configured. Please connect Asana in Settings.")
	}
	if projectGID == "" {
		return nil, "", "", fmt.Errorf("No Asana project selected. Please choose a project in Settings > Integrations > Asana.")
	}

	return asana.NewClient(pat), projectGID, workspaceGID, nil
}

// sectionStatus classifies an Asana section name as a status string
// Returns one of: "In Progress", "Blocked", "Done", "Backlog"
func sectionStatus(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "done") || strings.Contains(n, "complet") ||
		strings.Contains(n, "deploy") || strings.Contains(n, "prod") ||
		strings.Contains(n, "fixed") || strings.Contains(n, "closed"):
		return "Done"
	case strings.Contains(n, "block") || strings.Contains(n, "wait") ||
		strings.Contains(n, "hold"):
		return "Blocked"
	case strings.Contains(n, "backlog") || strings.Contains(n, "todo") ||
		strings.Contains(n, "to do") || strings.Contains(n, "upcoming"):
		return "Backlog"
	default:
		return "In Progress"
	}
}

// isDoneSection returns true if the section name looks like a "done" forward state
func isDoneSection(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "done") || strings.Contains(n, "complet") ||
		strings.Contains(n, "deploy") || strings.Contains(n, "prod") ||
		strings.Contains(n, "fixed") || strings.Contains(n, "closed")
}

// isDoneSectionWithConfig checks if a section is a done/deployed/closed state using the
// Asana workflow config column hierarchy first, falling back to pattern matching.
func isDoneSectionWithConfig(name string, hierarchy []models.ColumnState) bool {
	if len(hierarchy) > 0 {
		role := getStateRole(strings.ToLower(name), hierarchy)
		if role != "" {
			return role == "dev_done" || role == "closed" || role == "deployed"
		}
	}
	return isDoneSection(name)
}

// isBlockedSection returns true if the section name implies blocked
func isBlockedSection(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "block") || strings.Contains(n, "wait") || strings.Contains(n, "hold")
}

// taskToIssueRow converts an Asana task to the issueRow shape used in daily ops responses
func taskToIssueRow(task asana.Task) issueRow {
	status := "Backlog"
	for _, m := range task.Memberships {
		if m.Section != nil {
			status = sectionStatus(m.Section.Name)
			break
		}
	}
	if task.Completed {
		status = "Done"
	}
	assigneeName := ""
	if task.Assignee != nil {
		assigneeName = task.Assignee.Name
	}
	priority := extractAsanaPriority(task)
	return issueRow{
		ID:       task.GID,
		Summary:  task.Name,
		Status:   status,
		Priority: priority,
		Assignee: assigneeName,
	}
}

// extractAsanaPriority tries to get priority from Asana custom fields
func extractAsanaPriority(task asana.Task) string {
	for _, cf := range task.CustomFields {
		switch strings.ToLower(cf.Name) {
		case "priority", "p", "pri":
			if cf.EnumValue != nil && cf.EnumValue.Name != "" {
				return cf.EnumValue.Name
			}
			if cf.DisplayValue != "" {
				return cf.DisplayValue
			}
		}
	}
	return "Normal"
}

// extractAsanaDueDate returns the due date string for a task.
// Prefers the standard due_on field; falls back to a custom field named "due date", "deadline", or "target date".
func extractAsanaDueDate(task asana.Task) *string {
	if task.DueOn != nil && *task.DueOn != "" {
		return task.DueOn
	}
	for _, cf := range task.CustomFields {
		switch strings.ToLower(cf.Name) {
		case "due date", "deadline", "target date", "due":
			if cf.DisplayValue != "" {
				return &cf.DisplayValue
			}
		}
	}
	return nil
}

// taskSectionName returns the first section name for a task
func taskSectionName(task asana.Task) string {
	for _, m := range task.Memberships {
		if m.Section != nil {
			return m.Section.Name
		}
	}
	return ""
}

// ─── Status / Config ──────────────────────────────────────────────────────────

// GetStatus returns Asana PM connection status (mirrors YouTrack GetStatus)
func (h *AsanaPMHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, workspaceGID, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"connected":  false,
			"configured": false,
			"error":      err.Error(),
		})
		return
	}

	// Test connection
	_, testErr := client.GetMe(r.Context())
	connected := testErr == nil
	errMsg := ""
	if testErr != nil {
		errMsg = testErr.Error()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"connected":     connected,
		"configured":    true,
		"error":         errMsg,
		"project_id":    projectGID,
		"workspace_id":  workspaceGID,
		"source":        "asana",
	})
}

// ─── Projects / Boards / States / Users ──────────────────────────────────────

// GetProjects returns Asana projects (mirrors YouTrack GetProjects)
func (h *AsanaPMHandler) GetProjects(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	client, _, workspaceGID, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if workspaceGID == "" {
		// Try fetching workspaces
		ws, wsErr := client.GetWorkspaces(r.Context())
		if wsErr != nil || len(ws) == 0 {
			http.Error(w, "No Asana workspace found", http.StatusBadRequest)
			return
		}
		workspaceGID = ws[0].GID
	}

	projects, err := client.GetProjects(r.Context(), workspaceGID)
	if err != nil {
		http.Error(w, "Failed to get projects: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Shape: [{id, name, short_name}] — matches YouTrack project shape
	var result []map[string]interface{}
	for _, p := range projects {
		result = append(result, map[string]interface{}{
			"id":         p.GID,
			"name":       p.Name,
			"short_name": p.Name,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// GetBoards returns Asana projects as boards (mirrors YouTrack GetBoards)
func (h *AsanaPMHandler) GetBoards(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	client, _, workspaceGID, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if workspaceGID == "" {
		ws, wsErr := client.GetWorkspaces(r.Context())
		if wsErr != nil || len(ws) == 0 {
			http.Error(w, "No Asana workspace found", http.StatusBadRequest)
			return
		}
		workspaceGID = ws[0].GID
	}

	projects, err := client.GetProjects(r.Context(), workspaceGID)
	if err != nil {
		http.Error(w, "Failed to get boards: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var result []map[string]interface{}
	for _, p := range projects {
		result = append(result, map[string]interface{}{
			"id":   p.GID,
			"name": p.Name,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// GetBoardColumns returns sections of an Asana project as board columns
func (h *AsanaPMHandler) GetBoardColumns(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	boardID := vars["board_id"]

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if boardID == "" {
		boardID = projectGID
	}
	if boardID == "" {
		http.Error(w, "board_id is required", http.StatusBadRequest)
		return
	}

	sections, err := client.GetSections(r.Context(), boardID)
	if err != nil {
		http.Error(w, "Failed to get columns: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var result []map[string]interface{}
	for _, s := range sections {
		result = append(result, map[string]interface{}{
			"name":         s.Name,
			"field_values": []string{s.Name},
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// GetStates returns Asana project sections as states (mirrors YouTrack GetStates)
func (h *AsanaPMHandler) GetStates(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if projectGID == "" {
		http.Error(w, "Asana project not configured", http.StatusBadRequest)
		return
	}

	sections, err := client.GetSections(r.Context(), projectGID)
	if err != nil {
		http.Error(w, "Failed to get states: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Shape matches YouTrack state: {name string}
	var result []map[string]string
	for _, s := range sections {
		result = append(result, map[string]string{"name": s.Name})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// GetPriorities returns available priority values (from Asana custom field or hardcoded)
func (h *AsanaPMHandler) GetPriorities(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	// Default priority list — matches common Asana priority custom field values
	priorities := []string{"P0", "P1", "P2", "P3", "Critical", "High", "Medium", "Low", "Normal"}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": priorities})
}

// GetUsers returns Asana workspace members (mirrors YouTrack GetUsers)
func (h *AsanaPMHandler) GetUsers(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, _, workspaceGID, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if workspaceGID == "" {
		ws, wsErr := client.GetWorkspaces(r.Context())
		if wsErr != nil || len(ws) == 0 {
			http.Error(w, "No Asana workspace found", http.StatusBadRequest)
			return
		}
		workspaceGID = ws[0].GID
	}

	users, err := client.GetWorkspaceUsers(r.Context(), workspaceGID)
	if err != nil {
		http.Error(w, "Failed to get users: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Shape matches YouTrack user: {id, login, full_name, email}
	var result []map[string]interface{}
	for _, u := range users {
		result = append(result, map[string]interface{}{
			"id":        u.GID,
			"login":     u.GID,
			"full_name": u.Name,
			"email":     u.Email,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// ─── Issues CRUD ─────────────────────────────────────────────────────────────

// GetIssues returns all Asana tasks as issues (mirrors YouTrack GetIssues)
func (h *AsanaPMHandler) GetIssues(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if projectGID == "" {
		http.Error(w, "Asana project not configured", http.StatusBadRequest)
		return
	}

	tasks, err := client.GetProjectTasksPaginated(r.Context(), projectGID)
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	response := tasksToIssueList(tasks)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": response})
}

// GetIssue returns a single Asana task (mirrors YouTrack GetIssue)
func (h *AsanaPMHandler) GetIssue(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	taskGID := vars["issue_id"]

	client, _, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	task, err := client.GetTask(r.Context(), taskGID)
	if err != nil {
		http.Error(w, "Failed to get issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    taskToIssueMap(*task),
	})
}

// CreateIssue creates a new Asana task (mirrors YouTrack CreateIssue)
func (h *AsanaPMHandler) CreateIssue(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Summary     string `json:"summary"`
		Description string `json:"description"`
		State       string `json:"state,omitempty"`   // section name
		Priority    string `json:"priority,omitempty"`
		Assignee    string `json:"assignee_login,omitempty"` // Asana user GID
		DueDate     *int64 `json:"due_date,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if projectGID == "" {
		http.Error(w, "Asana project not configured", http.StatusBadRequest)
		return
	}

	createReq := asana.CreateTaskRequest{
		Name:     req.Summary,
		Notes:    req.Description,
		Projects: []string{projectGID},
		Assignee: req.Assignee,
	}
	if req.DueDate != nil {
		t := time.Unix(*req.DueDate/1000, 0)
		createReq.DueOn = t.Format("2006-01-02")
	}

	task, err := client.CreateTask(r.Context(), createReq)
	if err != nil {
		http.Error(w, "Failed to create issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Move to section if state provided
	if req.State != "" {
		sections, _ := client.GetSections(r.Context(), projectGID)
		for _, s := range sections {
			if strings.EqualFold(s.Name, req.State) {
				_ = client.AddTaskToSection(r.Context(), s.GID, task.GID)
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": taskToIssueMap(*task)})
}

// UpdateIssue updates an Asana task (mirrors YouTrack UpdateIssue)
func (h *AsanaPMHandler) UpdateIssue(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	taskGID := vars["issue_id"]

	var req struct {
		Summary     string `json:"summary,omitempty"`
		Description string `json:"description,omitempty"`
		State       string `json:"state,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	updateReq := asana.UpdateTaskRequest{}
	if req.Summary != "" {
		updateReq.Name = &req.Summary
	}
	if req.Description != "" {
		updateReq.Notes = &req.Description
	}

	task, err := client.UpdateTask(r.Context(), taskGID, updateReq)
	if err != nil {
		http.Error(w, "Failed to update issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Move to section if state provided
	if req.State != "" && projectGID != "" {
		sections, _ := client.GetSections(r.Context(), projectGID)
		for _, s := range sections {
			if strings.EqualFold(s.Name, req.State) {
				_ = client.AddTaskToSection(r.Context(), s.GID, taskGID)
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": taskToIssueMap(*task)})
}

// UpdateIssueState moves an Asana task to a different section (mirrors YouTrack UpdateIssueState)
func (h *AsanaPMHandler) UpdateIssueState(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	taskGID := vars["issue_id"]

	var req struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.State == "" {
		http.Error(w, "state is required", http.StatusBadRequest)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if projectGID == "" {
		http.Error(w, "Asana project not configured", http.StatusBadRequest)
		return
	}

	sections, err := client.GetSections(r.Context(), projectGID)
	if err != nil {
		http.Error(w, "Failed to get sections: "+err.Error(), http.StatusInternalServerError)
		return
	}

	for _, s := range sections {
		if strings.EqualFold(s.Name, req.State) {
			if err := client.AddTaskToSection(r.Context(), s.GID, taskGID); err != nil {
				http.Error(w, "Failed to move task: "+err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "message": "State updated"})
			return
		}
	}

	http.Error(w, "Section '"+req.State+"' not found in Asana project", http.StatusNotFound)
}

// DeleteIssue deletes an Asana task (mirrors YouTrack DeleteIssue)
func (h *AsanaPMHandler) DeleteIssue(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	taskGID := vars["issue_id"]

	client, _, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := client.DeleteTask(r.Context(), taskGID); err != nil {
		http.Error(w, "Failed to delete issue: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "message": "Issue deleted"})
}

// ─── Grouped by Assignee ─────────────────────────────────────────────────────

// GetIssuesGroupedByAssignee groups active tasks by assignee (mirrors YouTrack)
func (h *AsanaPMHandler) GetIssuesGroupedByAssignee(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if projectGID == "" {
		http.Error(w, "Asana project not configured", http.StatusBadRequest)
		return
	}

	tasks, err := client.GetProjectTasksPaginated(r.Context(), projectGID)
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

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

	for _, task := range tasks {
		if task.Completed {
			continue
		}
		status := taskSectionName(task)
		if isDoneSection(status) {
			continue
		}
		statusMapped := sectionStatus(status)
		if statusMapped == "Done" {
			continue
		}

		priorityTag, cleanTitle := extractPriorityFromSummary(task.Name)
		item := issueItem{
			ID:          task.GID,
			Summary:     task.Name,
			PriorityTag: priorityTag,
			CleanTitle:  cleanTitle,
			Status:      statusMapped,
			Selected:    true,
		}

		if task.Assignee != nil && task.Assignee.Name != "" {
			name := task.Assignee.Name
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

	var assignments []assigneeGroup
	for _, g := range groups {
		assignments = append(assignments, *g)
	}
	if len(unassignedIssues) > 0 {
		assignments = append(assignments, assigneeGroup{
			UserName:    "Unassigned",
			SlackHandle: "@Unassigned",
			Issues:      unassignedIssues,
		})
	}
	if assignments == nil {
		assignments = []assigneeGroup{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    map[string]interface{}{"assignments": assignments},
	})
}

// ─── Match Analysis ──────────────────────────────────────────────────────────

// MatchAnalysis fuzzy-matches AI analysis tasks against Asana tasks (mirrors YouTrack MatchAnalysis)
func (h *AsanaPMHandler) MatchAnalysis(w http.ResponseWriter, r *http.Request) {
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

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	tasks, err := client.GetProjectTasksPaginated(r.Context(), projectGID)
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	type matchResult struct {
		TaskTitle      string  `json:"task_title"`
		Person         string  `json:"person"`
		Status         string  `json:"status"`
		AsanaTask      map[string]interface{} `json:"youtrack_issue"` // keeps same key name for frontend compat
		ProposedState  string  `json:"proposed_state"`
		Confidence     float64 `json:"confidence"`
	}
	type unmatchedTask struct {
		TaskTitle string `json:"task_title"`
		Person    string `json:"person"`
		Status    string `json:"status"`
	}

	var matches []matchResult
	var unmatchedTasks []unmatchedTask
	matchedTaskGIDs := make(map[string]bool)

	for _, item := range req.Analysis {
		bestMatch := -1
		bestScore := 0.0
		for i, task := range tasks {
			score := fuzzyMatchScore(item.TaskTitle, task.Name)
			if score > bestScore && score >= 0.4 {
				bestScore = score
				bestMatch = i
			}
		}
		if bestMatch < 0 {
			unmatchedTasks = append(unmatchedTasks, unmatchedTask{
				TaskTitle: item.TaskTitle, Person: item.Assignee, Status: item.DetectedStatus,
			})
			continue
		}
		t := tasks[bestMatch]
		matchedTaskGIDs[t.GID] = true
		currentState := taskSectionName(t)

		var proposedState string
		switch item.DetectedStatus {
		case "completed":
			proposedState = "Done"
		case "in_progress", "blocked":
			proposedState = "In Progress"
		}

		matches = append(matches, matchResult{
			TaskTitle: item.TaskTitle,
			Person:    item.Assignee,
			Status:    item.DetectedStatus,
			AsanaTask: map[string]interface{}{
				"id":            t.GID,
				"summary":       t.Name,
				"current_state": currentState,
			},
			ProposedState: proposedState,
			Confidence:    bestScore,
		})
	}

	var unmatchedIssues []map[string]interface{}
	for _, t := range tasks {
		if !matchedTaskGIDs[t.GID] && !t.Completed {
			unmatchedIssues = append(unmatchedIssues, map[string]interface{}{
				"id":            t.GID,
				"summary":       t.Name,
				"current_state": taskSectionName(t),
			})
		}
	}

	if matches == nil {
		matches = []matchResult{}
	}
	if unmatchedTasks == nil {
		unmatchedTasks = []unmatchedTask{}
	}
	if unmatchedIssues == nil {
		unmatchedIssues = []map[string]interface{}{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":          true,
		"matches":          matches,
		"unmatched_tasks":  unmatchedTasks,
		"unmatched_issues": unmatchedIssues,
	})
}

// ─── PM Assistant ────────────────────────────────────────────────────────────

const defaultAsanaPMAssistantPrompt = `You are a PM Assistant for a software development team using Asana.

## Your Role
Answer questions about Asana tasks and section transition data provided below. Be concise and accurate.

## Assignee Task Format
When asked for tasks assigned to a specific person, ALWAYS respond in this exact format:

@{assignee_name}

{Status}:
{taskGID} {task_name}

Group by status (Backlog, In Progress, Blocked, Done). One task per line.

## General Format
- Use bullet points for lists
- Bold (**text**) for important flags (OVERDUE, MOVED BACK)
- Group data by assignee when showing team workload

## Key Rules
- OVERDUE = task has been in the same section longer than its priority threshold
- MOVED BACK = task moved to a less-advanced section (regression)
- If the query is ambiguous, make reasonable assumptions and state them

Today's date: {{DATE}}`

// PMAssistantQuery handles natural language queries with live Asana context (mirrors YouTrack PMAssistantQuery)
func (h *AsanaPMHandler) PMAssistantQuery(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Query   string           `json:"query"`
		History []ai.ConvMessage `json:"history"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Query == "" {
		http.Error(w, "query is required", http.StatusBadRequest)
		return
	}

	// 1. Load custom bot instructions
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
		customInstructions = defaultAsanaPMAssistantPrompt
	}
	customInstructions = strings.ReplaceAll(customInstructions, "{{DATE}}", time.Now().Format("2006-01-02"))

	// 2. Fetch live Asana tasks
	var issueSection strings.Builder
	issueSection.WriteString("\n\n---\n## Live Asana Tasks (current state)\n")
	issueSection.WriteString("Format: GID | Priority | Name | Section | Assignee\n\n")

	client, projectGID, _, clientErr := h.getAsanaClient(r.Context(), userID)
	if clientErr == nil && projectGID != "" {
		tasks, taskErr := client.GetProjectTasksPaginated(r.Context(), projectGID)
		if taskErr == nil {
			for _, t := range tasks {
				if t.Completed {
					continue
				}
				assigneeName := ""
				if t.Assignee != nil {
					assigneeName = t.Assignee.Name
				}
				section := taskSectionName(t)
				priority := extractAsanaPriority(t)
				issueSection.WriteString(fmt.Sprintf("%s | %s | %s | %s | %s\n",
					t.GID, priority, t.Name, section, assigneeName))
			}
		}
	}

	// 3. Fetch recent section transitions from asana_task_log
	var historySection strings.Builder
	historySection.WriteString("\n\n---\n## Asana Section Transition History (last 7 days)\n")
	historySection.WriteString("Format: TaskGID | TaskName | Assignee | From → To | Date\n\n")

	if projectGID != "" {
		since := time.Now().AddDate(0, 0, -7)
		logs, _ := h.asanaPMRepo.GetTransitionsSince(r.Context(), projectGID, since)
		for _, l := range logs {
			historySection.WriteString(fmt.Sprintf("%s | %s | %s | %s → %s | %s\n",
				l.TaskGID, l.TaskName, l.Assignee, l.FromSection, l.ToSection,
				l.TransitionedAt.Format("2006-01-02 15:04")))
		}
	}

	systemPrompt := customInstructions + issueSection.String() + historySection.String()

	response, err := ai.QueryWithHistory(r.Context(), systemPrompt, req.History, req.Query)
	if err != nil {
		http.Error(w, "AI service error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    map[string]string{"response": response},
	})
}

// ─── Daily Ops ───────────────────────────────────────────────────────────────

// GetDailyBrief returns a grouped morning brief from Asana (mirrors YouTrack GetDailyBrief)
func (h *AsanaPMHandler) GetDailyBrief(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if projectGID == "" {
		http.Error(w, "Asana project not configured", http.StatusBadRequest)
		return
	}

	tasks, err := client.GetProjectTasksPaginated(r.Context(), projectGID)
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Get done yesterday using Asana's native completed_at timestamp (reliable, not affected by backfill timing)
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")

	var doneYesterday []issueRow
	for _, task := range tasks {
		if task.CompletedAt != nil && task.CompletedAt.UTC().Format("2006-01-02") == yesterday {
			assigneeName := ""
			if task.Assignee != nil {
				assigneeName = task.Assignee.Name
			}
			doneYesterday = append(doneYesterday, issueRow{
				ID:       task.GID,
				Summary:  task.Name,
				Status:   taskSectionName(task),
				Priority: extractAsanaPriority(task),
				Assignee: assigneeName,
			})
		}
	}

	var p0, p1, p2, p3, blockedOurs, blockedTheirs, openItems, unassigned []issueRow

	for _, task := range tasks {
		if task.Completed {
			continue
		}
		row := taskToIssueRow(task)
		statusMapped := row.Status

		if statusMapped == "Done" {
			continue
		}

		if statusMapped == "Blocked" {
			if row.Assignee == "" {
				blockedTheirs = append(blockedTheirs, row)
			} else {
				blockedOurs = append(blockedOurs, row)
			}
			continue
		}

		if row.Assignee == "" && statusMapped != "Backlog" {
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

	for _, task := range tasks {
		if task.Completed {
			continue
		}
		row := taskToIssueRow(task)
		if row.Status == "In Progress" && row.Assignee == "" {
			openItems = append(openItems, row)
		}
	}

	nullSafe := func(s []issueRow) []issueRow {
		if s == nil {
			return []issueRow{}
		}
		return s
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"done_yesterday":  nullSafe(doneYesterday),
			"p0":              nullSafe(p0),
			"p1":              nullSafe(p1),
			"p2":              nullSafe(p2),
			"p3":              nullSafe(p3),
			"blocked_ours":    nullSafe(blockedOurs),
			"blocked_theirs":  nullSafe(blockedTheirs),
			"open_items":      nullSafe(openItems),
			"unassigned":      nullSafe(unassigned),
			"generated_at":    time.Now().Format(time.RFC3339),
		},
	})
}

// GetEODSummary returns today's progress from Asana (mirrors YouTrack GetEODSummary)
func (h *AsanaPMHandler) GetEODSummary(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if projectGID == "" {
		http.Error(w, "Asana project not configured", http.StatusBadRequest)
		return
	}

	// Load Asana workflow config for done/regression detection
	var asanaHierarchy []models.ColumnState
	if asanaCfg, cfgErr := h.configRepo.GetEffective(r.Context(), userID, "asana"); cfgErr == nil {
		asanaHierarchy = asanaCfg.ColumnHierarchy
	}

	today := time.Now().Format("2006-01-02")
	todayStart := time.Now().Truncate(24 * time.Hour)
	logs, _ := h.asanaPMRepo.GetTransitionsSince(r.Context(), projectGID, todayStart)

	var completedToday, newBlockers []issueRow
	movedToday := make(map[string]bool)

	for _, l := range logs {
		if l.TransitionedAt.Format("2006-01-02") != today {
			continue
		}
		movedToday[l.TaskGID] = true
		if isDoneSectionWithConfig(l.ToSection, asanaHierarchy) {
			completedToday = append(completedToday, issueRow{
				ID: l.TaskGID, Summary: l.TaskName, Status: l.ToSection,
				Priority: l.Priority, Assignee: l.Assignee,
			})
		}
		if isBlockedSection(l.ToSection) {
			newBlockers = append(newBlockers, issueRow{
				ID: l.TaskGID, Summary: l.TaskName, Status: l.ToSection,
				Priority: l.Priority, Assignee: l.Assignee,
			})
		}
	}

	tasks, err := client.GetProjectTasksPaginated(r.Context(), projectGID)
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var stillInProgress, noMovement []issueRow
	for _, task := range tasks {
		if task.Completed {
			continue
		}
		row := taskToIssueRow(task)
		if row.Status != "In Progress" {
			continue
		}
		if movedToday[task.GID] {
			stillInProgress = append(stillInProgress, row)
		} else {
			noMovement = append(noMovement, row)
		}
	}

	nullSafe := func(s []issueRow) []issueRow {
		if s == nil {
			return []issueRow{}
		}
		return s
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"completed_today":   nullSafe(completedToday),
			"still_in_progress": nullSafe(stillInProgress),
			"no_movement":       nullSafe(noMovement),
			"new_blockers":      nullSafe(newBlockers),
			"date":              today,
		},
	})
}

// GetDeveloperLoad returns per-assignee workload from Asana (mirrors YouTrack GetDeveloperLoad)
func (h *AsanaPMHandler) GetDeveloperLoad(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if projectGID == "" {
		http.Error(w, "Asana project not configured", http.StatusBadRequest)
		return
	}

	tasks, err := client.GetProjectTasksPaginated(r.Context(), projectGID)
	if err != nil {
		http.Error(w, "Failed to get issues: "+err.Error(), http.StatusInternalServerError)
		return
	}

	type devLoad struct {
		Assignee       string     `json:"assignee"`
		ActiveIssues   []issueRow `json:"active_issues"`
		BlockedIssues  []issueRow `json:"blocked_issues"`
		DoneToday      int        `json:"done_today"`
		AvgHoursPerP1  float64    `json:"avg_hours_per_p1"`
		AvgHoursPerP2  float64    `json:"avg_hours_per_p2"`
		LastActivityAt *string    `json:"last_activity_at"`
		MissingUpdate  bool       `json:"missing_update"`
		Overloaded     bool       `json:"overloaded"`
	}

	loadsMap := make(map[string]*devLoad)

	for _, task := range tasks {
		if task.Completed {
			continue
		}
		row := taskToIssueRow(task)
		if row.Status == "Done" || row.Assignee == "" {
			continue
		}
		if loadsMap[row.Assignee] == nil {
			loadsMap[row.Assignee] = &devLoad{
				Assignee:      row.Assignee,
				ActiveIssues:  []issueRow{},
				BlockedIssues: []issueRow{},
			}
		}
		dl := loadsMap[row.Assignee]
		if row.Status == "Blocked" {
			dl.BlockedIssues = append(dl.BlockedIssues, row)
		} else {
			dl.ActiveIssues = append(dl.ActiveIssues, row)
		}
	}

	// Compute done_today and last_activity_at from asana_task_log
	today := time.Now().Format("2006-01-02")
	todayStart := time.Now().Truncate(24 * time.Hour)
	logs, _ := h.asanaPMRepo.GetTransitionsSince(r.Context(), projectGID, todayStart)

	for _, l := range logs {
		if l.TransitionedAt.Format("2006-01-02") != today || l.Assignee == "" {
			continue
		}
		if loadsMap[l.Assignee] == nil {
			loadsMap[l.Assignee] = &devLoad{
				Assignee:      l.Assignee,
				ActiveIssues:  []issueRow{},
				BlockedIssues: []issueRow{},
			}
		}
		dl := loadsMap[l.Assignee]
		if isDoneSection(l.ToSection) {
			dl.DoneToday++
		}
		lastAt := l.TransitionedAt.Format(time.RFC3339)
		dl.LastActivityAt = &lastAt
	}

	var result []devLoad
	for _, dl := range loadsMap {
		dl.Overloaded = len(dl.ActiveIssues) > 3
		dl.MissingUpdate = dl.LastActivityAt == nil
		result = append(result, *dl)
	}
	if result == nil {
		result = []devLoad{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// GetBlockerReasons returns AI-extracted blocker reasons for Asana tasks (mirrors YouTrack)
func (h *AsanaPMHandler) GetBlockerReasons(w http.ResponseWriter, r *http.Request) {
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

	client, _, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	reasons := make(map[string]string)

	for _, rawID := range ids {
		taskGID := strings.TrimSpace(rawID)
		if taskGID == "" {
			continue
		}

		// Fetch stories (comments) for this task
		stories, storiesErr := client.GetTaskStories(r.Context(), taskGID)
		currentCount := len(stories)

		// Check cache
		cachedReason, cachedCount, cachedSection, found := h.asanaPMRepo.GetAsanaBlockerCache(r.Context(), taskGID)
		if found && currentCount == cachedCount && isBlockedSection(cachedSection) {
			reasons[taskGID] = cachedReason
			continue
		}

		// Analyse
		var reason string
		if storiesErr != nil || len(stories) == 0 {
			reason = "No comments — reason unknown"
		} else {
			// Collect comment text from stories
			var comments []string
			for _, s := range stories {
				if s.Type == "comment" && s.Text != "" {
					comments = append(comments, s.Text)
				}
			}
			if len(comments) == 0 {
				reason = "No comments — reason unknown"
			} else {
				reason = analyseBlockerComments(r.Context(), taskGID, comments)
			}
		}

		_ = h.asanaPMRepo.SaveAsanaBlockerCache(r.Context(), taskGID, reason, "Blocked", currentCount)
		reasons[taskGID] = reason
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": reasons})
}

// ─── Carryover (reuse same daily_ops_carryover table as YouTrack) ─────────────

// SaveCarryoverPlan saves EOD action items (mirrors YouTrack SaveCarryoverPlan)
func (h *AsanaPMHandler) SaveCarryoverPlan(w http.ResponseWriter, r *http.Request) {
	// Delegate to YouTrack handler logic — same table, same format
	ytHandler := NewYouTrackHandler()
	ytHandler.SaveCarryoverPlan(w, r)
}

// GetCarryover retrieves saved carryover items (mirrors YouTrack GetCarryover)
func (h *AsanaPMHandler) GetCarryover(w http.ResponseWriter, r *http.Request) {
	ytHandler := NewYouTrackHandler()
	ytHandler.GetCarryover(w, r)
}

// ─── Import ──────────────────────────────────────────────────────────────────

// ImportFromAsana imports Asana tasks into local DB (reuses existing asana.go ImportFromEnv)
func (h *AsanaPMHandler) ImportFromAsana(w http.ResponseWriter, r *http.Request) {
	asanaHandler := NewAsanaHandler()
	asanaHandler.ImportFromEnv(w, r)
}

// GetProjectSectionsFromDB returns cached Asana sections (reuses existing asana.go handler)
func (h *AsanaPMHandler) GetProjectSectionsFromDB(w http.ResponseWriter, r *http.Request) {
	asanaHandler := NewAsanaHandler()
	asanaHandler.GetProjectSectionsFromDB(w, r)
}

// ─── Data Source preference endpoints ────────────────────────────────────────

// GetDataSource returns the active data source for the current user
func (h *AsanaPMHandler) GetDataSource(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	var source string
	u := middleware.GetUserFromCtx(r.Context())
	if u != nil && (u.Role == models.RoleMember || u.Role == models.RoleViewer) {
		source = h.settingsRepo.GetAdminDataSource(r.Context())
	} else {
		source, _ = h.settingsRepo.GetUserDataSource(r.Context(), userID)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": map[string]string{"source": source}})
}

// SetDataSource saves the active data source for the current user
func (h *AsanaPMHandler) SetDataSource(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	var req struct {
		Source string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if err := h.settingsRepo.SetUserDataSource(r.Context(), userID, req.Source); err != nil {
		http.Error(w, "Failed to save data source: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": map[string]string{"source": req.Source}})
}

// SaveProjectGID saves the user's selected Asana project GID
func (h *AsanaPMHandler) SaveProjectGID(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	var req struct {
		ProjectGID string `json:"project_gid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ProjectGID == "" {
		http.Error(w, "project_gid is required", http.StatusBadRequest)
		return
	}
	if err := h.integrationRepo.UpdateAsanaProjectGID(r.Context(), userID, req.ProjectGID); err != nil {
		http.Error(w, "Failed to save project: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": map[string]string{"project_gid": req.ProjectGID}})
}

// ─── internal helpers ────────────────────────────────────────────────────────

// tasksToIssueList converts a slice of Asana tasks to the YouTrack issue list shape
func tasksToIssueList(tasks []asana.Task) []map[string]interface{} {
	var result []map[string]interface{}
	for _, task := range tasks {
		result = append(result, taskToIssueMap(task))
	}
	if result == nil {
		result = []map[string]interface{}{}
	}
	return result
}

// taskToIssueMap converts a single Asana task to the YouTrack issue map shape.
// status = real section name (e.g. "Sprint 23 - P1") so the board columns match exactly.
// sectionStatus() is only used by daily-ops endpoints (taskToIssueRow).
func taskToIssueMap(task asana.Task) map[string]interface{} {
	section := taskSectionName(task)
	// Use the actual section name as the status so board columns line up 1:1 with Asana sections.
	status := section
	if status == "" && task.Completed {
		status = "Done"
	}
	if status == "" {
		status = "Backlog"
	}

	var assignee interface{}
	if task.Assignee != nil {
		assignee = map[string]interface{}{
			"id":        task.Assignee.GID,
			"login":     task.Assignee.GID,
			"fullName":  task.Assignee.Name,
			"full_name": task.Assignee.Name,
			"email":     task.Assignee.Email,
		}
	}

	createdMs := task.CreatedAt.UnixMilli()
	updatedMs := task.ModifiedAt.UnixMilli()

	var dueMs int64
	if task.DueOn != nil && *task.DueOn != "" {
		if t, err := time.Parse("2006-01-02", *task.DueOn); err == nil {
			dueMs = t.UnixMilli()
		}
	}

	return map[string]interface{}{
		"id":          task.GID,
		"summary":     task.Name,
		"description": task.Notes,
		"status":      status,
		"subsystem":   "",
		"priority":    extractAsanaPriority(task),
		"assignee":    assignee,
		"created":     createdMs,
		"updated":     updatedMs,
		"due_date":    dueMs,
		"attachments": []interface{}{},
		"section":     section,
		"permalink":   task.PermalinkURL,
	}
}

// analyseAsanaBlockerComments is an alias for analyseBlockerComments (defined in youtrack.go)
// We call it directly since it's in the same package.
// Redeclaring here would cause a duplicate; use the function from youtrack.go.
var _ = analyseAsanaBlockerStories // suppress unused warning

func analyseAsanaBlockerStories(ctx context.Context, taskGID string, comments []string) string {
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
		"The following comments are from a blocked Asana task (%s).\nIn ONE short sentence, what is blocking this task? Be specific.\n\nComments:\n%s",
		taskGID, commentText,
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
			Message struct{ Content string `json:"content"` } `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(respBytes, &aiResp) != nil || len(aiResp.Choices) == 0 {
		return "Could not analyse"
	}
	return strings.TrimSpace(aiResp.Choices[0].Message.Content)
}

// ─── Assignee Stats ───────────────────────────────────────────────────────────

// GetAssigneeStats returns per-assignee open/in_progress/blocked/done counts from Asana
// GET /api/asana/pm/assignee-stats
func (h *AsanaPMHandler) GetAssigneeStats(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	type AssigneeReport struct {
		Assignee           string   `json:"assignee"`
		Open               int      `json:"open"`
		InProgress         int      `json:"in_progress"`
		Done               int      `json:"done"`
		Blocked            int      `json:"blocked"`
		AvgHoursInProgress *float64 `json:"avg_hours_in_progress"`
		Issues             []string `json:"issues"`
	}

	reportMap := make(map[string]*AssigneeReport)
	ensureAssignee := func(name string) *AssigneeReport {
		if name == "" {
			name = "Unassigned"
		}
		if _, ok := reportMap[name]; !ok {
			reportMap[name] = &AssigneeReport{Assignee: name}
		}
		return reportMap[name]
	}

	// Live tasks from Asana
	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err == nil {
		tasks, taskErr := client.GetProjectTasksPaginated(r.Context(), projectGID)
		if taskErr == nil {
			for _, task := range tasks {
				if task.Completed {
					continue
				}
				name := ""
				if task.Assignee != nil {
					name = task.Assignee.Name
				}
				ar := ensureAssignee(name)
				section := taskSectionName(task)
				status := sectionStatus(section)
				switch status {
				case "In Progress":
					ar.InProgress++
				case "Blocked":
					ar.Blocked++
				default:
					ar.Open++
				}
				ar.Issues = append(ar.Issues, task.GID+" "+task.Name)
			}
		}
	}

	// DB done stats from asana_task_log
	dbStats, _ := h.asanaPMRepo.GetAsanaAssigneeStats(r.Context())
	for _, stat := range dbStats {
		ar := ensureAssignee(stat.Assignee)
		ar.Done = stat.Done
		ar.AvgHoursInProgress = stat.AvgHoursInProgress
	}

	var result []AssigneeReport
	for _, ar := range reportMap {
		result = append(result, *ar)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Assignee < result[j].Assignee
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// ─── User Avatars ─────────────────────────────────────────────────────────────

// GetUserAvatars returns a map of assignee name → avatar URL for Asana workspace users
// GET /api/asana/pm/users/avatars
func (h *AsanaPMHandler) GetUserAvatars(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, _, workspaceGID, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": map[string]string{}})
		return
	}

	if workspaceGID == "" {
		ws, wsErr := client.GetWorkspaces(r.Context())
		if wsErr == nil && len(ws) > 0 {
			workspaceGID = ws[0].GID
		}
	}

	users, err := client.GetWorkspaceUsers(r.Context(), workspaceGID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": map[string]string{}})
		return
	}

	avatarMap := make(map[string]string, len(users))
	for _, u := range users {
		// Photo is already included in GetWorkspaceUsers (opt_fields=photo)
		photoURL := ""
		if u.Photo != nil {
			if u.Photo.Image60x60 != "" {
				photoURL = u.Photo.Image60x60
			} else if u.Photo.Image128x128 != "" {
				photoURL = u.Photo.Image128x128
			}
		}
		// Fallback: individual fetch if workspace listing didn't include photo
		if photoURL == "" {
			photoURL = client.GetUserPhoto(r.Context(), u.GID)
		}
		if photoURL != "" {
			avatarMap[u.Name] = photoURL
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": avatarMap})
}

// ─── Time Tracking ────────────────────────────────────────────────────────────

// GetTimeTracking returns the Asana time tracking table (section durations per task)
// GET /api/asana/pm/time-tracking?week=2026-02-16&assignee=alice,bob&priority=P0
func (h *AsanaPMHandler) GetTimeTracking(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	q := r.URL.Query()
	params := database.TimeTrackingParams{}

	if weekStr := q.Get("week"); weekStr != "" {
		monday, err := time.Parse("2006-01-02", weekStr)
		if err == nil {
			monday = time.Date(monday.Year(), monday.Month(), monday.Day(), 0, 0, 0, 0, time.UTC)
			sunday := monday.AddDate(0, 0, 6).Add(23*time.Hour + 59*time.Minute + 59*time.Second)
			params.WeekStart = &monday
			params.WeekEnd = &sunday
		}
	}
	if a := q.Get("assignee"); a != "" {
		for _, name := range strings.Split(a, ",") {
			if t := strings.TrimSpace(strings.ToLower(name)); t != "" {
				params.Assignees = append(params.Assignees, t)
			}
		}
	}
	if p := q.Get("priority"); p != "" {
		for _, pri := range strings.Split(p, ",") {
			if t := strings.TrimSpace(pri); t != "" {
				params.Priorities = append(params.Priorities, t)
			}
		}
	}

	pinnedIDs, _ := h.reportRepo.GetPinnedIssueIDs(r.Context(), userID)
	params.PinnedIssues = pinnedIDs

	logs, err := h.asanaPMRepo.GetAsanaTimeTracking(r.Context(), params)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Failed to get time tracking: " + err.Error()})
		return
	}
	if logs == nil {
		logs = []database.IssueStateLog{}
	}

	// Live fallback: if asana_task_log is empty (no webhook history yet), synthesize
	// rows from live Asana tasks. Week filter is intentionally ignored here — when
	// there is no log data we show current task state regardless of the week param.
	if len(logs) == 0 {
		if liveClient, liveProjectGID, _, liveClientErr := h.getAsanaClient(r.Context(), userID); liveClientErr == nil && liveProjectGID != "" {
			liveTasks, _ := liveClient.GetProjectTasksPaginated(r.Context(), liveProjectGID)
			now := time.Now()
			for _, task := range liveTasks {
				if task.Completed {
					continue
				}
				assigneeName := ""
				if task.Assignee != nil {
					assigneeName = task.Assignee.Name
				}
				if len(params.Assignees) > 0 {
					matched := false
					for _, a := range params.Assignees {
						if strings.EqualFold(a, assigneeName) {
							matched = true
							break
						}
					}
					if !matched {
						continue
					}
				}
				section := taskSectionName(task)
				hoursInState := now.Sub(task.ModifiedAt).Hours()
				var liveDD *time.Time
				if task.DueOn != nil && *task.DueOn != "" {
					if d, parseErr := time.Parse("2006-01-02", *task.DueOn); parseErr == nil {
						liveDD = &d
					}
				}
				logs = append(logs, database.IssueStateLog{
					IssueID:                  task.GID,
					IssueSummary:             task.Name,
					Assignee:                 assigneeName,
					ToState:                  section,
					TransitionedAt:           task.ModifiedAt,
					DurationInPrevStateHours: &hoursInState,
					DueDate:                  liveDD,
				})
			}
		}
	}

	pinnedSet := make(map[string]bool, len(pinnedIDs))
	for _, id := range pinnedIDs {
		pinnedSet[id] = true
	}

	type TimeTrackingRow struct {
		database.IssueStateLog
		Overdue        bool    `json:"overdue"`
		ThresholdHours float64 `json:"threshold_hours"`
		Pinned         bool    `json:"pinned"`
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)
	var rows []TimeTrackingRow
	for _, l := range logs {
		threshold := overdueThresholdHoursForPriority(l.Priority)
		var overdue bool
		if l.DueDate != nil {
			// Asana: use task due date for overdue detection
			overdue = l.DueDate.UTC().Before(today)
		} else {
			overdue = l.DurationInPrevStateHours != nil && *l.DurationInPrevStateHours > threshold
		}
		rows = append(rows, TimeTrackingRow{
			IssueStateLog:  l,
			Overdue:        overdue,
			ThresholdHours: threshold,
			Pinned:         pinnedSet[l.IssueID],
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": rows})
}

// ─── Issue Timelines ──────────────────────────────────────────────────────────

// GetIssueTimelines returns per-task timelines from asana_task_log
// GET /api/asana/pm/issue-timelines
func (h *AsanaPMHandler) GetIssueTimelines(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	pinnedIDs, _ := h.reportRepo.GetPinnedIssueIDs(r.Context(), userID)
	dismissedSet, _ := h.reportRepo.GetDismissedAlertIDs(r.Context(), userID)

	timelines, err := h.asanaPMRepo.GetAsanaIssueTimelines(r.Context(), pinnedIDs)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Failed to get timelines: " + err.Error()})
		return
	}
	if timelines == nil {
		timelines = []database.IssueTimeline{}
	}

	// Live fallback: synthesize timelines from current Asana tasks when log is empty.
	if len(timelines) == 0 {
		if client, projectGID, _, clientErr := h.getAsanaClient(r.Context(), userID); clientErr == nil && projectGID != "" {
			tasks, _ := client.GetProjectTasksPaginated(r.Context(), projectGID)
			now := time.Now()
			pinnedSet2 := make(map[string]bool, len(pinnedIDs))
			for _, id := range pinnedIDs {
				pinnedSet2[id] = true
			}
			for _, task := range tasks {
				if task.Completed {
					continue
				}
				assigneeName := ""
				if task.Assignee != nil {
					assigneeName = task.Assignee.Name
				}
				section := taskSectionName(task)
				liveHours := now.Sub(task.ModifiedAt).Hours()
				threshold := overdueThresholdHoursForPriority("")
				timelines = append(timelines, database.IssueTimeline{
					IssueID:        task.GID,
					IssueSummary:   task.Name,
					Assignee:       assigneeName,
					Pinned:         pinnedSet2[task.GID],
					TotalStints:    1,
					TotalHours:     liveHours,
					IsLive:         true,
					LiveHours:      liveHours,
					IsOverdue:      liveHours > threshold,
					ThresholdHours: threshold,
					FirstEnteredAt: task.ModifiedAt,
					LastActivityAt: task.ModifiedAt,
					Stints: []database.IssueStint{{
						StintNumber: 1,
						EnteredAt:   task.ModifiedAt,
						ExitedTo:    section,
					}},
				})
			}
		}
	}

	type TimelineWithDismiss struct {
		database.IssueTimeline
		AlertDismissed bool `json:"alert_dismissed"`
	}
	result := make([]TimelineWithDismiss, len(timelines))
	for i, t := range timelines {
		result[i] = TimelineWithDismiss{
			IssueTimeline:  t,
			AlertDismissed: dismissedSet[t.IssueID],
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// ─── PM Report Generation ─────────────────────────────────────────────────────

// GeneratePMReport generates a Slack-style daily PM report using Asana data
// GET /api/asana/pm/report/{date}?scope=full|summary
func (h *AsanaPMHandler) GeneratePMReport(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	date := vars["date"]
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	scope := r.URL.Query().Get("scope")
	if scope != "summary" {
		scope = "full"
	}

	// Parse filter params (mirrors YouTrack report handler)
	var openStatesFilter []string
	if raw := r.URL.Query().Get("open_states"); raw != "" {
		for _, s := range strings.Split(raw, ",") {
			if t := strings.TrimSpace(s); t != "" {
				openStatesFilter = append(openStatesFilter, strings.ToLower(t))
			}
		}
	}
	var sectionsFilter []string
	if raw := r.URL.Query().Get("sections"); raw != "" {
		for _, s := range strings.Split(raw, ",") {
			if t := strings.TrimSpace(s); t != "" {
				sectionsFilter = append(sectionsFilter, t)
			}
		}
	}
	showSection := func(name string) bool {
		if len(sectionsFilter) == 0 {
			return true
		}
		for _, f := range sectionsFilter {
			if f == name {
				return true
			}
		}
		return false
	}

	parsedDate, err := time.Parse("2006-01-02", date)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Invalid date format"})
		return
	}
	yesterday := parsedDate.AddDate(0, 0, -1).Format("2006-01-02")

	// Fetch all tasks once — used for both done (completed_at) and open/blocked categorisation
	client, projectGID, _, clientErr := h.getAsanaClient(r.Context(), userID)
	var allTasks []asana.Task
	if clientErr == nil {
		allTasks, _ = client.GetProjectTasksPaginated(r.Context(), projectGID)
	}

	// Done tasks — use Asana's native completed_at (accurate timestamp, not affected by backfill)
	var doneTasks []asana.Task
	for _, task := range allTasks {
		if task.CompletedAt != nil && task.CompletedAt.UTC().Format("2006-01-02") == yesterday {
			doneTasks = append(doneTasks, task)
		}
	}

	// Open/blocked — live from Asana, skip completed tasks
	// If open_states filter provided, a task is "open" only if its section matches one of those states
	var openTasks, blockedTasks []asana.Task
	if scope == "full" {
		for _, task := range allTasks {
			if task.Completed {
				continue
			}
			sectionName := taskSectionName(task)
			if len(openStatesFilter) > 0 {
				// User specified explicit open states — check section name match
				sectionLower := strings.ToLower(sectionName)
				matched := false
				for _, f := range openStatesFilter {
					if sectionLower == f || strings.Contains(sectionLower, f) {
						matched = true
						break
					}
				}
				if matched {
					if isBlockedSection(sectionName) {
						blockedTasks = append(blockedTasks, task)
					} else {
						openTasks = append(openTasks, task)
					}
				}
			} else {
				// Default: use sectionStatus classification
				status := sectionStatus(sectionName)
				switch status {
				case "Blocked":
					blockedTasks = append(blockedTasks, task)
				case "In Progress", "Backlog":
					openTasks = append(openTasks, task)
				}
			}
		}
	}

	var sb strings.Builder
	doneLabel := parsedDate.AddDate(0, 0, -1).Format("Mon, Jan 2")

	// Done section
	if showSection("done") {
		sb.WriteString(fmt.Sprintf("*Tasks Done %s (Asana):*\n\n", doneLabel))
		if len(doneTasks) == 0 {
			sb.WriteString("_No tasks completed yesterday_\n")
		} else {
			for _, t := range doneTasks {
				assigneeStr := ""
				if t.Assignee != nil {
					assigneeStr = fmt.Sprintf(" (%s)", t.Assignee.Name)
				}
				sb.WriteString(fmt.Sprintf("• %s%s\n", t.Name, assigneeStr))
			}
		}
	}

	if scope == "full" {
		// Open section
		if showSection("open") {
			sb.WriteString("\n\n*Open Tasks Today:*\n\n")
			if len(openTasks) == 0 {
				sb.WriteString("_No open tasks_\n")
			} else {
				for _, task := range openTasks {
					assignee := ""
					if task.Assignee != nil {
						assignee = fmt.Sprintf(" (%s)", task.Assignee.Name)
					}
					section := taskSectionName(task)
					sb.WriteString(fmt.Sprintf("• %s%s [%s]\n", task.Name, assignee, section))
				}
			}
		}

		// Blocked section
		if showSection("blocked") && len(blockedTasks) > 0 {
			sb.WriteString("\n\n*Blocked Tasks:*\n\n")
			for _, task := range blockedTasks {
				assignee := ""
				if task.Assignee != nil {
					assignee = fmt.Sprintf(" (%s)", task.Assignee.Name)
				}
				sb.WriteString(fmt.Sprintf("• %s%s\n", task.Name, assignee))
			}
		}
	}

	reportText := sb.String()
	reportType := "daily-" + scope
	savedReport, saveErr := h.reportRepo.SavePMReport(
		r.Context(), date, reportType, reportText,
		len(doneTasks), len(openTasks), len(blockedTasks),
	)
	if saveErr != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":       true,
			"report_text":   reportText,
			"done_count":    len(doneTasks),
			"open_count":    len(openTasks),
			"blocked_count": len(blockedTasks),
			"date":          date,
			"report_type":   reportType,
			"saved":         false,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":       true,
		"report_text":   savedReport.ReportText,
		"done_count":    savedReport.DoneCount,
		"open_count":    savedReport.OpenCount,
		"blocked_count": savedReport.BlockedCount,
		"date":          savedReport.Date,
		"report_type":   savedReport.ReportType,
		"id":            savedReport.ID,
		"generated_at":  savedReport.GeneratedAt,
		"saved":         true,
	})
}

// GenerateWeeklyPMReport generates a Slack-style weekly PM report using Asana data
// GET /api/asana/pm/report/weekly/{weekStart}?scope=full|summary
func (h *AsanaPMHandler) GenerateWeeklyPMReport(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	weekStart := vars["weekStart"]
	if weekStart == "" {
		// Default to current Monday
		now := time.Now()
		offset := int(now.Weekday())
		if offset == 0 {
			offset = 7
		}
		weekStart = now.AddDate(0, 0, -(offset - 1)).Format("2006-01-02")
	}

	scope := r.URL.Query().Get("scope")
	if scope != "summary" {
		scope = "full"
	}

	monday, err := time.Parse("2006-01-02", weekStart)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Invalid weekStart format (use YYYY-MM-DD)"})
		return
	}
	sunday := monday.AddDate(0, 0, 6)
	weekEnd := sunday.Format("2006-01-02")

	client, projectGID, _, clientErr := h.getAsanaClient(r.Context(), userID)

	// Fetch all tasks once — used for both done (completed_at) and open/blocked categorisation
	var allWeeklyTasks []asana.Task
	if clientErr == nil {
		allWeeklyTasks, _ = client.GetProjectTasksPaginated(r.Context(), projectGID)
	}

	// Done tasks for the week — use Asana's native completed_at timestamp
	var doneTasks []asana.Task
	for _, task := range allWeeklyTasks {
		if task.CompletedAt != nil {
			d := task.CompletedAt.UTC().Format("2006-01-02")
			if d >= weekStart && d <= weekEnd {
				doneTasks = append(doneTasks, task)
			}
		}
	}

	var openTasks, blockedTasks []asana.Task
	if scope == "full" {
		for _, task := range allWeeklyTasks {
			if task.Completed {
				continue
			}
			status := sectionStatus(taskSectionName(task))
			if status == "Blocked" {
				blockedTasks = append(blockedTasks, task)
			} else {
				openTasks = append(openTasks, task)
			}
		}
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("*Weekly Report — %s to %s (Asana)*\n\n", monday.Format("Jan 2"), sunday.Format("Jan 2, 2006")))

	// Done tasks grouped by assignee
	sb.WriteString("*Tasks Completed This Week:*\n\n")
	if len(doneTasks) == 0 {
		sb.WriteString("_No tasks completed this week_\n")
	} else {
		assigneeGroups := map[string][]asana.Task{}
		assigneeOrder := []string{}
		for _, t := range doneTasks {
			name := "Unassigned"
			if t.Assignee != nil {
				name = t.Assignee.Name
			}
			if _, ok := assigneeGroups[name]; !ok {
				assigneeOrder = append(assigneeOrder, name)
			}
			assigneeGroups[name] = append(assigneeGroups[name], t)
		}
		for i, name := range assigneeOrder {
			if i > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(fmt.Sprintf("@%s\n", name))
			for _, t := range assigneeGroups[name] {
				sb.WriteString(fmt.Sprintf("• %s\n", t.Name))
			}
		}
	}

	if scope == "full" {
		sb.WriteString(fmt.Sprintf("\n\n*Open Tasks (%d):*\n\n", len(openTasks)))
		if len(openTasks) == 0 {
			sb.WriteString("_No open tasks_\n")
		} else {
			for _, task := range openTasks {
				assignee := ""
				if task.Assignee != nil {
					assignee = fmt.Sprintf(" (%s)", task.Assignee.Name)
				}
				sb.WriteString(fmt.Sprintf("• %s%s\n", task.Name, assignee))
			}
		}
		if len(blockedTasks) > 0 {
			sb.WriteString(fmt.Sprintf("\n\n*Blocked Tasks (%d):*\n\n", len(blockedTasks)))
			for _, task := range blockedTasks {
				sb.WriteString(fmt.Sprintf("• %s\n", task.Name))
			}
		}
	}

	reportText := sb.String()
	reportType := "weekly-" + scope
	savedReport, saveErr := h.reportRepo.SavePMReport(
		r.Context(), weekStart, reportType, reportText,
		len(doneTasks), len(openTasks), len(blockedTasks),
	)

	if saveErr != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":       true,
			"report_text":   reportText,
			"done_count":    len(doneTasks),
			"open_count":    len(openTasks),
			"blocked_count": len(blockedTasks),
			"date":          weekStart,
			"report_type":   reportType,
			"saved":         false,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":       true,
		"report_text":   savedReport.ReportText,
		"done_count":    savedReport.DoneCount,
		"open_count":    savedReport.OpenCount,
		"blocked_count": savedReport.BlockedCount,
		"date":          savedReport.Date,
		"report_type":   savedReport.ReportType,
		"id":            savedReport.ID,
		"generated_at":  savedReport.GeneratedAt,
		"saved":         true,
	})
}

// ─── Stage / Deployment Report ────────────────────────────────────────────────

// GetStageReportColumns returns Asana sections from the active project as selectable columns
// GET /api/asana/pm/stage-report/columns
func (h *AsanaPMHandler) GetStageReportColumns(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": []string{}})
		return
	}

	sections, err := client.GetSections(r.Context(), projectGID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": []string{}})
		return
	}

	names := make([]string, 0, len(sections))
	for _, s := range sections {
		names = append(names, s.Name)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": names})
}

// GenerateStageReport fetches tasks from selected Asana sections and generates a deployment report
// POST /api/asana/pm/stage-report/generate
func (h *AsanaPMHandler) GenerateStageReport(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Columns []string `json:"columns"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Columns) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Provide at least one column"})
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": err.Error()})
		return
	}

	// Fetch all sections to map names → GIDs
	sections, err := client.GetSections(r.Context(), projectGID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Failed to fetch sections: " + err.Error()})
		return
	}
	sectionGIDMap := map[string]string{}
	for _, s := range sections {
		sectionGIDMap[strings.ToLower(s.Name)] = s.GID
	}

	// Collect tasks from selected sections
	selectedSet := map[string]bool{}
	for _, col := range req.Columns {
		selectedSet[strings.ToLower(col)] = true
	}

	allTasks, err := client.GetProjectTasksPaginated(r.Context(), projectGID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Failed to fetch tasks: " + err.Error()})
		return
	}

	var matchedTasks []asana.Task
	for _, task := range allTasks {
		if task.Completed {
			continue
		}
		section := strings.ToLower(taskSectionName(task))
		if selectedSet[section] {
			matchedTasks = append(matchedTasks, task)
		}
	}

	if len(matchedTasks) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": map[string]interface{}{"report": "", "issue_count": 0}})
		return
	}

	// Load stage report bot config prompt
	systemPrompt := `You are writing bullet points for a Slack deployment update.
Write ONE short sentence (max 15 words) describing what was fixed, in past tense, from the user's perspective.
- Be specific and direct — name the exact feature or interaction that changed
- Vary your sentence starts naturally (can use "Fixed", "Users can now...", etc.)
- No internal jargon, no ticket IDs, no padding
- Output ONLY the single sentence, nothing else`

	botRepo := database.NewBotConfigRepository()
	bots, _ := botRepo.GetByType(r.Context(), models.BotTypeStageReport)
	for _, b := range bots {
		if b.IsActive && strings.TrimSpace(b.Prompt) != "" {
			systemPrompt = b.Prompt
			break
		}
	}

	type fixItem struct {
		section string
		fix     string
	}
	var fixes []fixItem

	for _, task := range matchedTasks {
		section := taskSectionName(task)
		if section == "" {
			section = "General"
		}
		context := task.Notes
		if len(context) > 800 {
			context = context[:800]
		}
		userMsg := fmt.Sprintf("Task: %s\nContext: %s", task.Name, context)
		fixText, aiErr := ai.QueryWithContext(r.Context(), systemPrompt, userMsg)
		if aiErr != nil || strings.TrimSpace(fixText) == "" {
			fixText = task.Name
		}
		fixes = append(fixes, fixItem{section: section, fix: strings.TrimSpace(fixText)})
	}

	// Group by section
	sectionOrder := []string{}
	sectionMap := map[string][]string{}
	for _, f := range fixes {
		if _, exists := sectionMap[f.section]; !exists {
			sectionOrder = append(sectionOrder, f.section)
		}
		sectionMap[f.section] = append(sectionMap[f.section], f.fix)
	}

	var sb strings.Builder
	sb.WriteString("Hey team :wave: here is the list of fixes which have been deployed to STAGE today:\n")
	for _, sec := range sectionOrder {
		sb.WriteString(fmt.Sprintf("\n%s\n", sec))
		for _, fix := range sectionMap[sec] {
			sb.WriteString(fmt.Sprintf("• %s\n", fix))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"report":      strings.TrimRight(sb.String(), "\n"),
			"issue_count": len(matchedTasks),
		},
	})
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

// BackfillAsanaLog seeds asana_task_log with current sections for all live tasks
// POST /api/asana/pm/backfill
func (h *AsanaPMHandler) BackfillAsanaLog(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": err.Error()})
		return
	}

	tasks, err := client.GetProjectTasksPaginated(r.Context(), projectGID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Failed to fetch tasks: " + err.Error()})
		return
	}

	var entries []database.AsanaTaskLog
	for _, task := range tasks {
		section := taskSectionName(task)
		// For completed tasks use their done section name; for in-progress tasks use current section
		if section == "" {
			if task.Completed {
				section = "Done"
			} else {
				continue
			}
		}
		assigneeName := ""
		if task.Assignee != nil {
			assigneeName = task.Assignee.Name
		}
		// Use accurate timestamps: completed_at for done tasks, modified_at for in-progress
		var transitionedAt time.Time
		if task.Completed && task.CompletedAt != nil {
			transitionedAt = *task.CompletedAt
		} else {
			transitionedAt = task.ModifiedAt
		}
		entries = append(entries, database.AsanaTaskLog{
			TaskGID:        task.GID,
			TaskName:       task.Name,
			ProjectGID:     projectGID,
			Assignee:       assigneeName,
			FromSection:    "",
			ToSection:      section,
			Priority:       extractAsanaPriority(task),
			TransitionedAt: transitionedAt,
		})
	}

	inserted, err := h.asanaPMRepo.BackfillAsanaTaskLog(r.Context(), entries)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Backfill failed: " + err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"message":   fmt.Sprintf("Backfill complete: %d tasks seeded, %d already had log entries", inserted, len(entries)-inserted),
		"inserted":  inserted,
		"skipped":   len(entries) - inserted,
	})
}

// ─── Deployment Report ───────────────────────────────────────────────────────

// deploymentSectionEntry mirrors the Deployment-Report app's SectionEntry shape
type deploymentSectionEntry struct {
	Platform string `json:"platform"`
	Header   string `json:"header"`
	Enabled  bool   `json:"enabled"`
}

// deploymentBotConfig is the shape returned/accepted by GET/PUT /deployment/config
type deploymentBotConfig struct {
	SystemPrompt string                   `json:"systemPrompt"`
	Sections     []deploymentSectionEntry `json:"sections"`
}

var defaultDeploymentPrompt = `You are a technical writer creating client-facing deployment reports.

You will receive a ticket title and description. The description may be a rough internal note written by a developer (e.g. "is now fixed", "added support for X").

Your job is to rewrite it as a single polished, professional fix statement for a client deployment report. Rules:
- Write in past tense, from the user's perspective (what they now experience)
- Be 1-2 sentences. Do not pad or over-explain.
- Remove ALL internal prefixes: priority tags (P0, P1, A2, etc.), platform tags (FE, BE, UI, MC, Studio), ticket IDs, and jargon
- Start with the subject of what changed (e.g. "The restart conversation button...", "Avatar playback...")
- If the description already says what was fixed clearly, use it as the basis — do not invent details
- Sound polished and client-ready

Respond with ONLY the fix statement. No preamble, no labels, no quotes.`

var defaultDeploymentSections = []deploymentSectionEntry{
	{Platform: "UI", Header: "UI", Enabled: true},
	{Platform: "Studio", Header: "Studio", Enabled: true},
	{Platform: "Mission Control", Header: "Mission Control", Enabled: true},
	{Platform: "Backend", Header: "Backend / Platform", Enabled: true},
	{Platform: "Uncategorized", Header: "Other", Enabled: true},
}

// getDeploymentPAT returns the Asana PAT for direct HTTP calls (same resolution as getAsanaClient)
func (h *AsanaPMHandler) getDeploymentPAT(ctx context.Context, userID string) string {
	if userID != "" {
		if integ, err := h.integrationRepo.GetAsanaIntegration(ctx, userID); err == nil && integ != nil && integ.Connected && integ.AccessToken != "" {
			return integ.AccessToken
		}
	}
	settings, _ := h.settingsRepo.GetAsanaSettings(ctx)
	if settings != nil && settings.Configured && settings.PAT != "" {
		return settings.PAT
	}
	return os.Getenv("ASANA_PAT")
}

// GetDeploymentTask fetches a single Asana task by URL and returns its name + notes.
// POST /api/asana/pm/deployment/task
func (h *AsanaPMHandler) GetDeploymentTask(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "url is required"})
		return
	}
	if !strings.HasPrefix(req.URL, "https://app.asana.com/") {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Please enter a valid Asana URL"})
		return
	}

	// Extract numeric GID from URL
	gid := extractAsanaTaskGID(req.URL)
	if gid == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Could not parse task ID from URL"})
		return
	}

	pat := h.getDeploymentPAT(r.Context(), userID)
	if pat == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Asana is not configured"})
		return
	}

	asanaURL := fmt.Sprintf("https://app.asana.com/api/1.0/tasks/%s?opt_fields=gid,name,notes", gid)
	httpReq, _ := http.NewRequest(http.MethodGet, asanaURL, nil)
	httpReq.Header.Set("Authorization", "Bearer "+pat)
	httpReq.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Could not reach Asana"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Asana authentication failed"})
		return
	}
	if resp.StatusCode == http.StatusNotFound {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Task not found — check the URL"})
		return
	}
	if resp.StatusCode != http.StatusOK {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Asana returned an error"})
		return
	}

	body, _ := io.ReadAll(resp.Body)
	var asanaResp struct {
		Data struct {
			GID   string `json:"gid"`
			Name  string `json:"name"`
			Notes string `json:"notes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &asanaResp); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Failed to parse Asana response"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"gid":   asanaResp.Data.GID,
			"name":  asanaResp.Data.Name,
			"notes": asanaResp.Data.Notes,
		},
	})
}

// extractAsanaTaskGID extracts the numeric GID from an Asana task URL
func extractAsanaTaskGID(rawURL string) string {
	// Strip query and fragment
	if idx := strings.Index(rawURL, "?"); idx != -1 {
		rawURL = rawURL[:idx]
	}
	if idx := strings.Index(rawURL, "#"); idx != -1 {
		rawURL = rawURL[:idx]
	}
	parts := strings.Split(strings.TrimRight(rawURL, "/"), "/")
	for i := len(parts) - 1; i >= 0; i-- {
		seg := parts[i]
		if len(seg) > 0 {
			allDigit := true
			for _, c := range seg {
				if c < '0' || c > '9' {
					allDigit = false
					break
				}
			}
			if allDigit {
				return seg
			}
		}
	}
	return ""
}

// deploymentTicketInput is one ticket in a GenerateDeploymentReport request
type deploymentTicketInput struct {
	GID               string `json:"gid"`
	Name              string `json:"name"`
	Notes             string `json:"notes"`
	ManualDescription bool   `json:"manualDescription"`
}

// GenerateDeploymentReport generates per-ticket AI fix statements.
// POST /api/asana/pm/deployment/generate
func (h *AsanaPMHandler) GenerateDeploymentReport(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Tickets []deploymentTicketInput `json:"tickets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Tickets) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "No tickets provided"})
		return
	}
	if len(req.Tickets) > 100 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Maximum 100 tickets per request"})
		return
	}

	// Truncate oversized fields
	for i, t := range req.Tickets {
		if len(t.Name) > 500 {
			req.Tickets[i].Name = t.Name[:500]
		}
		if len(t.Notes) > 5000 {
			req.Tickets[i].Notes = t.Notes[:5000]
		}
	}

	// Load system prompt from active deployment_report bot config
	systemPrompt := defaultDeploymentPrompt
	if h.botRepo != nil {
		bots, _ := h.botRepo.GetByType(r.Context(), models.BotTypeDeploymentReport)
		for _, b := range bots {
			if b.IsActive && strings.TrimSpace(b.Prompt) != "" {
				systemPrompt = b.Prompt
				break
			}
		}
	}

	type ticketResult struct {
		GID          string  `json:"gid"`
		FixStatement *string `json:"fixStatement"`
		Error        *string `json:"error,omitempty"`
	}
	results := make([]ticketResult, len(req.Tickets))

	// Process concurrently (max 3 goroutines — Groq free tier limit)
	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup

	for i, ticket := range req.Tickets {
		wg.Add(1)
		go func(idx int, t deploymentTicketInput) {
			defer wg.Done()
			defer logging.Recover(r.Context(), "deployment_fix_statement")
			sem <- struct{}{}
			defer func() { <-sem }()

			notes := strings.TrimSpace(t.Notes)

			// If user provided a manual description (via --> syntax), use it directly — skip AI
			if t.ManualDescription && notes != "" {
				results[idx] = ticketResult{GID: t.GID, FixStatement: &notes}
				return
			}

			if notes == "" {
				notes = "No description provided."
			}
			userMsg := fmt.Sprintf("<title>%s</title>\n<description>%s</description>", t.Name, notes)

			// Retry up to 4 times with exponential backoff on rate-limit errors (mirrors DR backend)
			const maxRetries = 4
			backoff := 2 * time.Second
			var fix string
			var lastErr error
			for attempt := 0; attempt < maxRetries; attempt++ {
				fix, lastErr = ai.QueryWithContext(r.Context(), systemPrompt, userMsg)
				if lastErr == nil && strings.TrimSpace(fix) != "" {
					break
				}
				if lastErr != nil {
					lower := strings.ToLower(lastErr.Error())
					isRateLimit := strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate_limit") ||
						strings.Contains(lower, "429") || strings.Contains(lower, "too many")
					if isRateLimit && attempt < maxRetries-1 {
						time.Sleep(backoff)
						backoff *= 2
						continue
					}
				}
				break
			}
			if lastErr != nil || strings.TrimSpace(fix) == "" {
				if lastErr != nil {
					errMsg := lastErr.Error()
					results[idx] = ticketResult{GID: t.GID, FixStatement: nil, Error: &errMsg}
				} else {
					results[idx] = ticketResult{GID: t.GID, FixStatement: &t.Name}
				}
				return
			}
			fix = strings.TrimSpace(fix)
			results[idx] = ticketResult{GID: t.GID, FixStatement: &fix}
		}(i, ticket)
	}
	wg.Wait()

	// Signal frontend to wait if any ticket hit a rate limit (case-insensitive)
	retryAfter := 0
	for _, r := range results {
		if r.Error != nil {
			lower := strings.ToLower(*r.Error)
			if strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate_limit") || strings.Contains(lower, "429") || strings.Contains(lower, "too many") {
				retryAfter = 34 // Groq's typical retry window
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"results":    results,
			"retryAfter": retryAfter,
		},
	})
}

// GetDeploymentConfig returns the deployment bot config (system prompt + sections).
// GET /api/asana/pm/deployment/config
func (h *AsanaPMHandler) GetDeploymentConfig(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	cfg := deploymentBotConfig{
		SystemPrompt: defaultDeploymentPrompt,
		Sections:     defaultDeploymentSections,
	}

	if h.botRepo != nil {
		bots, _ := h.botRepo.GetByType(r.Context(), models.BotTypeDeploymentReport)
		for _, b := range bots {
			if b.IsActive {
				if strings.TrimSpace(b.Prompt) != "" {
					cfg.SystemPrompt = b.Prompt
				}
				if strings.TrimSpace(b.Variables) != "" && b.Variables != "[]" {
					var sections []deploymentSectionEntry
					if err := json.Unmarshal([]byte(b.Variables), &sections); err == nil && len(sections) > 0 {
						cfg.Sections = sections
					}
				}
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": cfg})
}

// PutDeploymentConfig saves the deployment bot config.
// PUT /api/asana/pm/deployment/config
func (h *AsanaPMHandler) PutDeploymentConfig(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var incoming deploymentBotConfig
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Invalid request body"})
		return
	}
	if strings.TrimSpace(incoming.SystemPrompt) == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "systemPrompt is required"})
		return
	}
	if len(incoming.SystemPrompt) > 8000 {
		incoming.SystemPrompt = incoming.SystemPrompt[:8000]
	}
	if len(incoming.Sections) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "sections must not be empty"})
		return
	}

	sectionsJSON, _ := json.Marshal(incoming.Sections)

	// Upsert: update if active deployment_report bot exists, else insert
	var upsertErr error
	if h.botRepo != nil {
		bots, _ := h.botRepo.GetByType(r.Context(), models.BotTypeDeploymentReport)
		var existing *models.BotConfig
		for _, b := range bots {
			if b.IsActive {
				existing = b
				break
			}
		}
		if existing != nil {
			existing.Prompt = incoming.SystemPrompt
			existing.Variables = string(sectionsJSON)
			upsertErr = h.botRepo.Update(r.Context(), existing)
		} else {
			newBot := &models.BotConfig{
				Name:        "Deployment Report",
				Description: "Generates client-facing deployment reports from Asana tickets",
				BotType:     models.BotTypeDeploymentReport,
				Prompt:      incoming.SystemPrompt,
				Variables:   string(sectionsJSON),
				IsActive:    true,
				CreatedBy:   userID,
			}
			upsertErr = h.botRepo.Create(r.Context(), newBot)
		}
	}

	if upsertErr != nil {
		log.Printf("PutDeploymentConfig: %v", upsertErr)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": incoming})
}

// GetSectionTasksForDeployment returns paginated tasks for a given Asana section GID.
// GET /api/asana/pm/deployment/sections/{sectionGid}/tasks
func (h *AsanaPMHandler) GetSectionTasksForDeployment(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	sectionGid := vars["sectionGid"]
	if sectionGid == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "sectionGid is required"})
		return
	}

	pat := h.getDeploymentPAT(r.Context(), userID)
	if pat == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Asana is not configured"})
		return
	}

	type taskItem struct {
		GID          string `json:"gid"`
		Name         string `json:"name"`
		PermalinkURL string `json:"permalink_url"`
	}

	var allTasks []taskItem
	nextURL := fmt.Sprintf("https://app.asana.com/api/1.0/sections/%s/tasks?opt_fields=gid,name,permalink_url&limit=100", sectionGid)
	httpClient := &http.Client{Timeout: 30 * time.Second}
	pageCount := 0

	for nextURL != "" && pageCount < 50 {
		pageCount++
		req, _ := http.NewRequest(http.MethodGet, nextURL, nil)
		req.Header.Set("Authorization", "Bearer "+pat)
		req.Header.Set("Accept", "application/json")

		resp, err := httpClient.Do(req)
		if err != nil {
			break
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			break
		}

		var page struct {
			Data     []taskItem `json:"data"`
			NextPage *struct {
				URI string `json:"uri"`
			} `json:"next_page"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
			resp.Body.Close()
			break
		}
		resp.Body.Close()

		allTasks = append(allTasks, page.Data...)

		if page.NextPage != nil && page.NextPage.URI != "" {
			if strings.HasPrefix(page.NextPage.URI, "/") {
				nextURL = "https://app.asana.com" + page.NextPage.URI
			} else {
				nextURL = page.NextPage.URI
			}
		} else {
			nextURL = ""
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": map[string]interface{}{"tasks": allTasks}})
}

// GetDeploymentProjectSections returns sections for the configured Asana project.
// GET /api/asana/pm/deployment/project/sections
func (h *AsanaPMHandler) GetDeploymentProjectSections(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	client, projectGID, _, err := h.getAsanaClient(r.Context(), userID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": err.Error()})
		return
	}

	sections, err := client.GetSections(r.Context(), projectGID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Failed to fetch sections: " + err.Error()})
		return
	}

	type sectionItem struct {
		GID  string `json:"gid"`
		Name string `json:"name"`
	}
	result := make([]sectionItem, 0, len(sections))
	for _, s := range sections {
		result = append(result, sectionItem{GID: s.GID, Name: s.Name})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": result})
}

// Ensure log and _ imports are used
var _ = log.Printf
