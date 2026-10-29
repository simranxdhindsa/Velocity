package handlers

// pm_features.go — Sprint Velocity, Burndown, Capacity Planner, Release Tracking,
// Dependency Map, and Blocker Escalation handlers.

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	"github.com/dhindsa/project-management/internal/services/youtrack"
	"github.com/gorilla/mux"
)

// ─────────────────────────────────────────────────────────────────────────────
// Feature 1 — Sprint Velocity
// GET /api/reports/sprint-velocity?limit=8
// ─────────────────────────────────────────────────────────────────────────────

type SprintVelocityPoint struct {
	SprintID       string  `json:"sprint_id"`
	SprintName     string  `json:"sprint_name"`
	Start          int64   `json:"start"`
	Finish         int64   `json:"finish"`
	Completed      int     `json:"completed"`
	Total          int     `json:"total"`
	IsCompleted    bool    `json:"is_completed"`
	CompletionRate float64 `json:"completion_rate"`
}

func (h *ReportHandler) GetSprintVelocity(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	limit := 8
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 20 {
		limit = n
	}

	ytClient, err := h.getYouTrackClient(r.Context())
	if err != nil {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "YouTrack not configured: " + err.Error()})
		return
	}

	sprints, err := ytClient.GetSprints(r.Context())
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: "Failed to fetch sprints: " + err.Error()})
		return
	}

	// Sort by finish desc, take last N, reverse to chronological
	sort.Slice(sprints, func(i, j int) bool { return sprints[i].Finish > sprints[j].Finish })
	if len(sprints) > limit {
		sprints = sprints[:limit]
	}
	for i, j := 0, len(sprints)-1; i < j; i, j = i+1, j-1 {
		sprints[i], sprints[j] = sprints[j], sprints[i]
	}

	// Build done-state set from workflow config
	wfCfg := h.loadWorkflowConfig(r.Context(), user.ID, "youtrack")
	doneSet := buildDoneSet(wfCfg)

	type res struct {
		idx   int
		point SprintVelocityPoint
	}
	results := make([]res, len(sprints))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)

	for i, sp := range sprints {
		wg.Add(1)
		go func(idx int, s youtrack.Sprint) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			pt := SprintVelocityPoint{
				SprintID:    s.ID,
				SprintName:  s.Name,
				Start:       s.Start,
				Finish:      s.Finish,
				IsCompleted: s.IsCompleted,
			}
			issues, ferr := ytClient.GetAllSprintIssues(r.Context(), s.ID)
			if ferr == nil {
				pt.Total = len(issues)
				for _, iss := range issues {
					state := strings.ToLower(youtrack.GetCustomFieldValue(iss, "State"))
					if doneSet[state] {
						pt.Completed++
					}
				}
				if pt.Total > 0 {
					pt.CompletionRate = float64(pt.Completed) / float64(pt.Total) * 100
				}
			}
			results[idx] = res{idx, pt}
		}(i, sp)
	}
	wg.Wait()

	points := make([]SprintVelocityPoint, len(sprints))
	for _, rv := range results {
		points[rv.idx] = rv.point
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: points})
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 2 — Burndown Chart
// GET /api/reports/sprint-burndown?sprint_id=xxx&sprint_start_ms=xxx&sprint_finish_ms=xxx
// ─────────────────────────────────────────────────────────────────────────────

type BurndownPoint struct {
	Date        string  `json:"date"`
	Total       int     `json:"total"`
	Completed   int     `json:"completed"`
	Remaining   int     `json:"remaining"`
	IdealRemain float64 `json:"ideal_remain"`
}

func (h *ReportHandler) GetSprintBurndown(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	sprintID := r.URL.Query().Get("sprint_id")
	sprintName := r.URL.Query().Get("sprint_name")
	sprintStartMs, _ := strconv.ParseInt(r.URL.Query().Get("sprint_start_ms"), 10, 64)
	sprintFinishMs, _ := strconv.ParseInt(r.URL.Query().Get("sprint_finish_ms"), 10, 64)

	if sprintID == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "sprint_id is required"})
		return
	}

	pmRepo := database.NewPMFeaturesRepository()

	snapshots, err := pmRepo.GetBurndownSnapshots(r.Context(), sprintID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: err.Error()})
		return
	}

	// No snapshots yet — take one now from live data
	if len(snapshots) == 0 {
		ytClient, ytErr := h.getYouTrackClient(r.Context())
		if ytErr == nil {
			wfCfg := h.loadWorkflowConfig(r.Context(), user.ID, "youtrack")
			h.takeBurndownSnapshot(r.Context(), ytClient, pmRepo, wfCfg, sprintID, sprintName)
			snapshots, _ = pmRepo.GetBurndownSnapshots(r.Context(), sprintID)
		}
	}

	var sprintDays int
	if sprintStartMs > 0 && sprintFinishMs > 0 {
		dur := time.Duration(sprintFinishMs-sprintStartMs) * time.Millisecond
		sprintDays = int(dur.Hours()/24) + 1
	}

	totalAtStart := 0
	if len(snapshots) > 0 {
		totalAtStart = snapshots[0].Total
	}

	var points []BurndownPoint
	for i, s := range snapshots {
		ideal := 0.0
		if sprintDays > 1 && totalAtStart > 0 {
			ideal = float64(totalAtStart) * (1 - float64(i)/float64(sprintDays-1))
		} else if sprintDays == 1 {
			ideal = 0
		}
		points = append(points, BurndownPoint{
			Date:        s.Date,
			Total:       s.Total,
			Completed:   s.Completed,
			Remaining:   s.Total - s.Completed,
			IdealRemain: ideal,
		})
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"points":      points,
			"sprint_name": sprintName,
		},
	})
}

// TakeDailyBurndownSnapshots is called by the background job each morning.
func (h *ReportHandler) TakeDailyBurndownSnapshots(ctx context.Context, userID string) {
	ytClient, err := h.getYouTrackClient(ctx)
	if err != nil {
		return
	}
	sprints, err := ytClient.GetSprints(ctx)
	if err != nil {
		return
	}
	pmRepo := database.NewPMFeaturesRepository()
	wfCfg := h.loadWorkflowConfig(ctx, userID, "youtrack")
	now := time.Now().UnixMilli()
	for _, sp := range sprints {
		if !sp.IsCompleted && sp.Finish > now {
			h.takeBurndownSnapshot(ctx, ytClient, pmRepo, wfCfg, sp.ID, sp.Name)
		}
	}
}

func (h *ReportHandler) takeBurndownSnapshot(
	ctx context.Context,
	ytClient *youtrack.Client,
	pmRepo *database.PMFeaturesRepository,
	wfCfg *models.WorkflowConfig,
	sprintID, sprintName string,
) {
	issues, err := ytClient.GetAllSprintIssues(ctx, sprintID)
	if err != nil {
		return
	}
	doneSet := buildDoneSet(wfCfg)
	total := len(issues)
	completed := 0
	for _, iss := range issues {
		if doneSet[strings.ToLower(youtrack.GetCustomFieldValue(iss, "State"))] {
			completed++
		}
	}
	today := time.Now().Format("2006-01-02")
	_ = pmRepo.UpsertBurndownSnapshot(ctx, sprintID, sprintName, today, total, completed)
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 3 — Team Capacity Planner
// GET    /api/reports/capacity?sprint_id=xxx
// POST   /api/reports/capacity
// DELETE /api/reports/capacity/{id}
// ─────────────────────────────────────────────────────────────────────────────

func (h *ReportHandler) GetSprintCapacity(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}
	sprintID := r.URL.Query().Get("sprint_id")
	pmRepo := database.NewPMFeaturesRepository()
	rows, err := pmRepo.GetCapacity(r.Context(), user.ID, sprintID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: err.Error()})
		return
	}

	var load interface{}
	ytClient, ytErr := h.getYouTrackClient(r.Context())
	if ytErr == nil && sprintID != "" {
		if issues, ferr := ytClient.GetAllSprintIssues(r.Context(), sprintID); ferr == nil {
			assigneeCount := map[string]int{}
			for _, iss := range issues {
				a := youtrack.GetCustomFieldValue(iss, "Assignee")
				if a != "" {
					assigneeCount[a]++
				}
			}
			load = assigneeCount
		}
	}

	sendJSON(w, http.StatusOK, Response{Success: true, Data: map[string]interface{}{
		"capacity": rows,
		"load":     load,
	}})
}

func (h *ReportHandler) SaveSprintCapacity(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}
	var body struct {
		SprintID      string  `json:"sprint_id"`
		SprintName    string  `json:"sprint_name"`
		AssigneeName  string  `json:"assignee_name"`
		AvailableDays float64 `json:"available_days"`
		Notes         string  `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "Invalid body"})
		return
	}
	if body.SprintID == "" || body.AssigneeName == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "sprint_id and assignee_name are required"})
		return
	}
	pmRepo := database.NewPMFeaturesRepository()
	id, err := pmRepo.UpsertCapacity(r.Context(), user.ID, body.SprintID, body.SprintName, body.AssigneeName, body.AvailableDays, body.Notes)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: map[string]string{"id": id}})
}

func (h *ReportHandler) DeleteSprintCapacity(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}
	id := mux.Vars(r)["id"]
	pmRepo := database.NewPMFeaturesRepository()
	if err := pmRepo.DeleteCapacity(r.Context(), user.ID, id); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, Response{Success: true})
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 4 — Release / Fix Version Tracking
// GET /api/youtrack/releases
// ─────────────────────────────────────────────────────────────────────────────

type ReleaseInfo struct {
	Version   string         `json:"version"`
	Issues    []ReleaseIssue `json:"issues"`
	Total     int            `json:"total"`
	Completed int            `json:"completed"`
	Progress  float64        `json:"progress"`
}

type ReleaseIssue struct {
	ID       string `json:"id"`
	Summary  string `json:"summary"`
	State    string `json:"state"`
	Assignee string `json:"assignee"`
	Priority string `json:"priority"`
	Done     bool   `json:"done"`
}

func (h *ReportHandler) GetReleases(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	ytClient, err := h.getYouTrackClient(r.Context())
	if err != nil {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "YouTrack not configured: " + err.Error()})
		return
	}

	versions, err := ytClient.GetFixVersions(r.Context())
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to fetch fix versions: " + err.Error(),
		})
		return
	}

	if len(versions) == 0 {
		sendJSON(w, http.StatusOK, Response{Success: true, Data: []ReleaseInfo{}})
		return
	}

	wfCfg := h.loadWorkflowConfig(r.Context(), user.ID, "youtrack")
	doneSet := buildDoneSet(wfCfg)

	type relRes struct {
		idx  int
		info ReleaseInfo
	}
	results := make([]relRes, len(versions))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)

	for i, v := range versions {
		wg.Add(1)
		go func(idx int, ver string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			issues, ferr := ytClient.GetIssuesByFixVersion(r.Context(), ver)
			info := ReleaseInfo{Version: ver}
			if ferr == nil {
				info.Total = len(issues)
				for _, iss := range issues {
					state := youtrack.GetCustomFieldValue(iss, "State")
					ri := ReleaseIssue{
						ID:       iss.IDReadable,
						Summary:  iss.Summary,
						State:    state,
						Assignee: youtrack.GetCustomFieldValue(iss, "Assignee"),
						Priority: youtrack.GetCustomFieldValue(iss, "Priority"),
						Done:     doneSet[strings.ToLower(state)],
					}
					if ri.Done {
						info.Completed++
					}
					info.Issues = append(info.Issues, ri)
				}
				if info.Total > 0 {
					info.Progress = float64(info.Completed) / float64(info.Total) * 100
				}
			}
			results[idx] = relRes{idx, info}
		}(i, v)
	}
	wg.Wait()

	releases := make([]ReleaseInfo, len(versions))
	for _, rv := range results {
		releases[rv.idx] = rv.info
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: releases})
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 5 — Dependency Map
// GET /api/youtrack/dependencies?issue_id=ARD-123
// ─────────────────────────────────────────────────────────────────────────────

func (h *ReportHandler) GetIssueDependencies(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}
	issueID := r.URL.Query().Get("issue_id")
	if issueID == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "issue_id is required"})
		return
	}

	ytClient, err := h.getYouTrackClient(r.Context())
	if err != nil {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "YouTrack not configured: " + err.Error()})
		return
	}

	links, err := ytClient.GetAllIssueLinks(r.Context(), issueID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: err.Error()})
		return
	}

	sendJSON(w, http.StatusOK, Response{Success: true, Data: links})
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 6 — Blocker Escalation
// GET  /api/reports/blocker-sla
// POST /api/reports/blocker-sla/config
// GET  /api/reports/blocker-sla/config
// ─────────────────────────────────────────────────────────────────────────────

type BlockerSLAItem struct {
	IssueID      string  `json:"issue_id"`
	Summary      string  `json:"summary"`
	Assignee     string  `json:"assignee"`
	BlockedSince string  `json:"blocked_since"`
	HoursBlocked float64 `json:"hours_blocked"`
	SLAHours     float64 `json:"sla_hours"`
	Breached     bool    `json:"breached"`
	Reason       string  `json:"reason"`
}

func (h *ReportHandler) GetBlockerSLA(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	pmRepo := database.NewPMFeaturesRepository()
	cfg, _ := pmRepo.GetEscalationConfig(r.Context(), user.ID)
	slaHours := 24.0
	if cfg != nil && cfg.SLAHours > 0 {
		slaHours = cfg.SLAHours
	}

	items, err := pmRepo.GetActiveBlockers(r.Context(), user.ID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: err.Error()})
		return
	}

	now := time.Now()
	var result []BlockerSLAItem
	for _, item := range items {
		hoursBlocked := now.Sub(item.BlockedSince).Hours()
		result = append(result, BlockerSLAItem{
			IssueID:      item.IssueID,
			Summary:      item.Summary,
			Assignee:     item.Assignee,
			BlockedSince: item.BlockedSince.Format(time.RFC3339),
			HoursBlocked: hoursBlocked,
			SLAHours:     slaHours,
			Breached:     hoursBlocked >= slaHours,
			Reason:       item.Reason,
		})
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].Breached != result[j].Breached {
			return result[i].Breached
		}
		return result[i].HoursBlocked > result[j].HoursBlocked
	})

	sendJSON(w, http.StatusOK, Response{Success: true, Data: map[string]interface{}{
		"items":     result,
		"sla_hours": slaHours,
	}})
}

func (h *ReportHandler) GetEscalationConfig(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}
	pmRepo := database.NewPMFeaturesRepository()
	cfg, err := pmRepo.GetEscalationConfig(r.Context(), user.ID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: err.Error()})
		return
	}
	if cfg == nil {
		cfg = &database.EscalationConfig{SLAHours: 24, NotifySlackChannel: "", AutoNotify: false}
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: cfg})
}

func (h *ReportHandler) SaveEscalationConfig(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}
	var body struct {
		SLAHours           float64 `json:"sla_hours"`
		NotifySlackChannel string  `json:"notify_slack_channel"`
		AutoNotify         bool    `json:"auto_notify"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "Invalid body"})
		return
	}
	if body.SLAHours <= 0 {
		body.SLAHours = 24
	}
	pmRepo := database.NewPMFeaturesRepository()
	if err := pmRepo.UpsertEscalationConfig(r.Context(), user.ID, body.SLAHours, body.NotifySlackChannel, body.AutoNotify); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, Response{Success: true})
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

// buildDoneSet builds a lowercase set of state names that count as "done".
func buildDoneSet(wfCfg *models.WorkflowConfig) map[string]bool {
	doneSet := map[string]bool{}
	if wfCfg != nil {
		for _, s := range getDoneStates(wfCfg) {
			doneSet[strings.ToLower(s)] = true
		}
	}
	if len(doneSet) == 0 {
		for _, s := range []string{"dev done", "dev", "done", "closed", "verified",
			"ready for stage", "stage", "ready for prod", "prod"} {
			doneSet[s] = true
		}
	}
	return doneSet
}
