package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/services/youtrack"
	"github.com/gorilla/mux"
)

// ── Wire types ────────────────────────────────────────────────────────────────

// GanttChartSummary is used by the chart-list endpoint.
type GanttChartSummary struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// GanttIssue is the per-row data sent to the frontend.
type GanttIssue struct {
	ID         string `json:"id"`
	MemberID   string `json:"memberId"`   // YT gantt member ID (used for updates)
	IDReadable string `json:"idReadable"`
	Summary    string `json:"summary"`
	Assignee   string `json:"assignee"`
	AvatarURL  string `json:"avatarUrl"`
	State      string `json:"state"`
	Priority   string `json:"priority"`
	StartDate  *int64 `json:"startDate"` // Unix ms from the gantt member
	DueDate    *int64 `json:"dueDate"`   // startDate + estimation*60 000 ms
	Estimation int    `json:"estimation"` // minutes
}

// GanttDependency is a "depends on" edge between two gantt members.
// SourceID must finish before TargetID can start.
type GanttDependency struct {
	SourceID string `json:"sourceId"` // gantt member ID of the prerequisite
	TargetID string `json:"targetId"` // gantt member ID of the dependent
}

// GanttChartData is the combined chart response.
type GanttChartData struct {
	GanttID      string            `json:"ganttId"`
	Issues       []GanttIssue      `json:"issues"`
	Dependencies []GanttDependency `json:"dependencies"`
}

// ── Handler ───────────────────────────────────────────────────────────────────

type GanttHandler struct {
	settingsRepo *database.SettingsRepository
}

func NewGanttHandler(settingsRepo *database.SettingsRepository) *GanttHandler {
	return &GanttHandler{settingsRepo: settingsRepo}
}

func (h *GanttHandler) getClient(r *http.Request) (*youtrack.Client, error) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		return nil, http.ErrNoCookie
	}
	integ, err := h.settingsRepo.GetYouTrackIntegration(r.Context(), user.ID)
	if err != nil || integ == nil || !integ.Connected {
		return nil, http.ErrNoCookie
	}
	return youtrack.NewClient(integ.BaseURL, integ.Token, integ.ProjectID), nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func memberToGanttIssue(m youtrack.YTGanttMember, baseURL string) GanttIssue {
	gi := GanttIssue{
		MemberID:   m.ID,
		StartDate:  m.StartDate,
		Estimation: m.Estimation,
	}

	// DueDate = startDate + estimation (minutes → ms)
	if m.StartDate != nil && m.Estimation > 0 {
		due := *m.StartDate + int64(m.Estimation)*60_000
		gi.DueDate = &due
	}

	if m.Issue != nil {
		gi.ID = m.Issue.ID
		gi.IDReadable = m.Issue.IDReadable
		gi.Summary = m.Issue.Summary
		gi.State = youtrack.GetStatus(*m.Issue)
		gi.Priority = youtrack.GetPriority(*m.Issue)

		if a := youtrack.GetAssignee(*m.Issue); a != nil {
			if a.FullName != "" {
				gi.Assignee = a.FullName
			} else {
				gi.Assignee = a.Login
			}
			gi.AvatarURL = a.AvatarUrl
			if gi.AvatarURL != "" && !strings.HasPrefix(gi.AvatarURL, "http") {
				gi.AvatarURL = baseURL + gi.AvatarURL
			}
		}
	}

	return gi
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

// GetCharts lists all gantt charts visible to the user.
// GET /api/gantt/charts
func (h *GanttHandler) GetCharts(w http.ResponseWriter, r *http.Request) {
	client, err := h.getClient(r)
	if err != nil {
		http.Error(w, "YouTrack not configured", http.StatusUnauthorized)
		return
	}
	charts, err := client.ListGanttCharts(r.Context())
	if err != nil {
		http.Error(w, "failed to list gantt charts: "+err.Error(), http.StatusInternalServerError)
		return
	}
	result := make([]GanttChartSummary, 0, len(charts))
	for _, c := range charts {
		result = append(result, GanttChartSummary{ID: c.ID, Name: c.Name})
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: result})
}

// GetChart fetches a single gantt chart with all members and dependencies.
// GET /api/gantt/chart?id={ganttId}
func (h *GanttHandler) GetChart(w http.ResponseWriter, r *http.Request) {
	ganttID := r.URL.Query().Get("id")
	if ganttID == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	client, err := h.getClient(r)
	if err != nil {
		http.Error(w, "YouTrack not configured", http.StatusUnauthorized)
		return
	}
	chart, err := client.GetGanttChart(r.Context(), ganttID)
	if err != nil {
		http.Error(w, "failed to fetch gantt chart: "+err.Error(), http.StatusInternalServerError)
		return
	}

	baseURL := client.GetBaseURL()
	var issues []GanttIssue
	deps := make([]GanttDependency, 0)
	seen := make(map[string]bool)

	for _, m := range chart.Members {
		if m.Issue == nil {
			continue
		}
		gi := memberToGanttIssue(m, baseURL)
		// Skip members with no scheduling data
		if gi.StartDate == nil && gi.DueDate == nil {
			continue
		}
		issues = append(issues, gi)

		// Each member's dependsOn list: those members are prerequisites
		for _, dep := range m.DependsOn {
			key := dep.ID + "→" + m.ID
			if !seen[key] {
				seen[key] = true
				deps = append(deps, GanttDependency{
					SourceID: dep.ID, // prerequisite
					TargetID: m.ID,   // this member
				})
			}
		}
	}
	if issues == nil {
		issues = []GanttIssue{}
	}

	sendJSON(w, http.StatusOK, Response{Success: true, Data: GanttChartData{
		GanttID:      ganttID,
		Issues:       issues,
		Dependencies: deps,
	}})
}

// UpdateMember updates startDate and estimation (derived from dueDate) on a gantt member.
// POST /api/gantt/chart/{ganttId}/members/{memberId}
func (h *GanttHandler) UpdateMember(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	ganttID := vars["ganttId"]
	memberID := vars["memberId"]
	if ganttID == "" || memberID == "" {
		http.Error(w, "ganttId and memberId required", http.StatusBadRequest)
		return
	}

	var body struct {
		StartDate *int64 `json:"startDate"`
		DueDate   *int64 `json:"dueDate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	client, err := h.getClient(r)
	if err != nil {
		http.Error(w, "YouTrack not configured", http.StatusUnauthorized)
		return
	}

	// Derive estimation in minutes from startDate + dueDate when both provided
	var estimMins *int
	if body.StartDate != nil && body.DueDate != nil && *body.DueDate > *body.StartDate {
		mins := int((*body.DueDate - *body.StartDate) / 60_000)
		estimMins = &mins
	}

	if err := client.UpdateGanttMember(r.Context(), ganttID, memberID, body.StartDate, estimMins); err != nil {
		http.Error(w, "failed to update gantt member: "+err.Error(), http.StatusInternalServerError)
		return
	}
	sendJSON(w, http.StatusOK, Response{Success: true})
}
