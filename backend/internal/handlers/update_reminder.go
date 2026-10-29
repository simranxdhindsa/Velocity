package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	updatesvc "github.com/dhindsa/project-management/internal/services/update_reminder"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// UpdateReminderHandler handles all /api/update-reminders routes
type UpdateReminderHandler struct {
	repo    *database.UpdateReminderRepository
	service *updatesvc.Service
	intRepo *database.IntegrationRepository
}

func NewUpdateReminderHandler() *UpdateReminderHandler {
	return &UpdateReminderHandler{
		repo:    database.NewUpdateReminderRepository(),
		service: updatesvc.NewService(),
		intRepo: database.NewIntegrationRepository(),
	}
}

// ── helper ───────────────────────────────────────────────────────────────────

func (h *UpdateReminderHandler) isAdmin(r *http.Request) bool {
	u := middleware.GetUserFromContext(r)
	return u != nil && (u.Role == models.RoleAdmin || u.Role == models.RoleProjectManager)
}

// ownerOrAdmin returns the calling user and whether they are allowed to touch the given rule.
// Returns (user, rule, allowed). Writes 403/404 if not allowed.
func (h *UpdateReminderHandler) ownerOrAdmin(w http.ResponseWriter, r *http.Request, ruleID string) (*models.User, *models.UpdateReminderRule, bool) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return nil, nil, false
	}
	rule, err := h.repo.GetRule(r.Context(), ruleID)
	if err != nil {
		http.Error(w, `{"error":"rule not found"}`, http.StatusNotFound)
		return nil, nil, false
	}
	if rule.UserID != u.ID && u.Role != models.RoleAdmin && u.Role != models.RoleProjectManager {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return nil, nil, false
	}
	return u, rule, true
}

// ── Rules ─────────────────────────────────────────────────────────────────────

// GET /api/update-reminders
func (h *UpdateReminderHandler) ListRules(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	isAdmin := u.Role == models.RoleAdmin || u.Role == models.RoleProjectManager
	rules, err := h.repo.ListRules(r.Context(), u.ID, isAdmin)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if rules == nil {
		rules = []*models.UpdateReminderRule{}
	}
	writeJSON(w, http.StatusOK, rules)
}

// POST /api/update-reminders
func (h *UpdateReminderHandler) CreateRule(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	var req models.CreateUpdateReminderRuleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	if req.ScheduleTime == "" {
		req.ScheduleTime = "11:00"
	}
	if len(req.ScheduleDays) == 0 {
		req.ScheduleDays = []int{1, 2, 3, 4, 5}
	}
	if req.Timezone == "" {
		req.Timezone = "Asia/Kolkata"
	}
	if req.DetectionMode == "" {
		req.DetectionMode = models.DetectionModeAny
	}
	if req.LeaveAction == "" {
		req.LeaveAction = models.LeaveActionExclude
	}
	if len(req.LeaveKeywords) == 0 {
		req.LeaveKeywords = []string{"leave", "wfh", "sick", "holiday", "off", "vacation", "pto"}
	}
	if req.ChannelTemplate == "" {
		req.ChannelTemplate = "Hey team! The following members haven't posted their update yet: {mentions}. Please share your update when you get a chance."
	}
	if req.DMTemplate == "" {
		req.DMTemplate = "Hi! Just a reminder to post your daily update in the team channel."
	}

	rule, err := h.repo.CreateRule(r.Context(), u.ID, &req)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, rule)
}

// GET /api/update-reminders/{id}
func (h *UpdateReminderHandler) GetRule(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, rule, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, rule)
}

// PUT /api/update-reminders/{id}
func (h *UpdateReminderHandler) UpdateRule(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, _, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	var req models.CreateUpdateReminderRuleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	rule, err := h.repo.UpdateRule(r.Context(), id, &req)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rule)
}

// DELETE /api/update-reminders/{id}
func (h *UpdateReminderHandler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, _, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	if err := h.repo.DeleteRule(r.Context(), id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// PATCH /api/update-reminders/{id}/toggle
func (h *UpdateReminderHandler) ToggleRule(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, rule, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := h.repo.ToggleRule(r.Context(), rule.ID, body.Enabled); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// ── Roster ─────────────────────────────────────────────────────────────────────

// GET /api/update-reminders/{id}/roster
func (h *UpdateReminderHandler) ListRoster(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, _, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	members, err := h.repo.ListRoster(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if members == nil {
		members = []*models.UpdateReminderRosterMember{}
	}
	writeJSON(w, http.StatusOK, members)
}

// POST /api/update-reminders/{id}/roster
func (h *UpdateReminderHandler) AddRosterMember(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, _, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	var req models.AddRosterMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if req.SlackUserID == "" || req.DisplayName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "slack_user_id and display_name are required"})
		return
	}
	member, err := h.repo.AddRosterMember(r.Context(), id, &req)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, member)
}

// PUT /api/update-reminders/{id}/roster/{mid}
func (h *UpdateReminderHandler) UpdateRosterMember(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	mid := mux.Vars(r)["mid"]
	_, _, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	var req models.UpdateRosterMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	member, err := h.repo.UpdateRosterMember(r.Context(), mid, &req)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, member)
}

// DELETE /api/update-reminders/{id}/roster/{mid}
func (h *UpdateReminderHandler) DeleteRosterMember(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	mid := mux.Vars(r)["mid"]
	_, _, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	if err := h.repo.DeleteRosterMember(r.Context(), mid); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// ── Run actions ───────────────────────────────────────────────────────────────

// POST /api/update-reminders/{id}/dry-run
func (h *UpdateReminderHandler) DryRun(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, rule, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	result, err := h.service.Execute(r.Context(), rule, true, true, models.TriggeredByDryRun)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"snapshot":       result.Snapshot,
		"diff":           result.Diff,
		"rendered_msg":   result.RenderedMsg,
		"rendered_dm":    result.RenderedDM,
		"channel_errors": result.ChannelErrors,
	})
}

// POST /api/update-reminders/{id}/run-now
// Body: { "force_snapshot": bool } — true = use fresh snapshot, false = use saved snapshot
func (h *UpdateReminderHandler) RunNow(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, rule, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	var body struct {
		ForceSnapshot bool `json:"force_snapshot"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	result, err := h.service.Execute(r.Context(), rule, false, body.ForceSnapshot, models.TriggeredByManual)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"snapshot":        result.Snapshot,
		"diff":            result.Diff,
		"rendered_msg":    result.RenderedMsg,
		"rendered_dm":     result.RenderedDM,
		"delivered_to":    result.DeliveredTo,
		"delivery_errors": result.DeliveryErrors,
		"channel_errors":  result.ChannelErrors,
		"skipped_send":    result.SkippedSend,
	})
}

// GET /api/update-reminders/{id}/history
func (h *UpdateReminderHandler) GetHistory(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	_, _, ok := h.ownerOrAdmin(w, r, id)
	if !ok {
		return
	}
	runs, err := h.repo.ListRuns(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if runs == nil {
		runs = []*models.UpdateReminderRun{}
	}
	writeJSON(w, http.StatusOK, runs)
}

// ── Workspace users (for member picker) ──────────────────────────────────────

// GET /api/slack/workspace-users
func (h *UpdateReminderHandler) GetWorkspaceUsers(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	integration, err := h.intRepo.GetSlackIntegration(r.Context(), u.ID)
	if err != nil || !integration.Connected {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "slack not connected"})
		return
	}
	client := slacksvc.NewClient(integration.BotToken)
	users, err := client.GetWorkspaceUsers(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, users)
}

// ── Quick Send ────────────────────────────────────────────────────────────────

// POST /api/slack/quick-send
func (h *UpdateReminderHandler) QuickSend(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	var req models.QuickSendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if req.Message == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message is required"})
		return
	}
	if req.ChannelID == "" && req.DmUserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel_id or dm_user_id is required"})
		return
	}

	slackTS, channelID, err := h.service.QuickSend(r.Context(), u.ID, req.ChannelID, req.Message, req.DmUserID, "quick_send")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"slack_ts": slackTS, "channel_id": channelID})
}

// DELETE /api/slack/quick-send/messages/{channelId}/{ts}
func (h *UpdateReminderHandler) DeleteSlackMessage(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	channelID := vars["channelId"]
	ts := vars["ts"]
	if channelID == "" || ts == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channelId and ts are required"})
		return
	}
	if err := h.service.DeleteSlackMessage(r.Context(), u.ID, channelID, ts); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// PUT /api/slack/quick-send/messages/{channelId}/{ts}
func (h *UpdateReminderHandler) UpdateSlackMessage(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	channelID := vars["channelId"]
	ts := vars["ts"]
	if channelID == "" || ts == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channelId and ts are required"})
		return
	}
	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Message == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message is required"})
		return
	}
	if err := h.service.UpdateSlackMessage(r.Context(), u.ID, channelID, ts, body.Message); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}
