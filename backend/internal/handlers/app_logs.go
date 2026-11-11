package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

// AppLogsHandler serves the backend log lines stored in app_logs (admin only).
type AppLogsHandler struct {
	repo *database.AppLogRepository
}

func NewAppLogsHandler() *AppLogsHandler {
	return &AppLogsHandler{repo: database.NewAppLogRepository()}
}

func parseAppLogFilter(r *http.Request) (database.AppLogFilter, string) {
	q := r.URL.Query()
	f := database.AppLogFilter{
		MinLevel:  strings.ToLower(strings.TrimSpace(q.Get("level"))),
		Q:         strings.TrimSpace(q.Get("q")),
		RequestID: strings.TrimSpace(q.Get("request_id")),
		UserID:    strings.TrimSpace(q.Get("user_id")),
	}
	if f.MinLevel != "" && database.AppLogLevelsFrom(f.MinLevel) == nil {
		return f, "level must be one of debug, info, warn, error"
	}
	if v := q.Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return f, "since must be an RFC3339 time"
		}
		f.Since = &t
	}
	if v := q.Get("until"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return f, "until must be an RFC3339 time"
		}
		f.Until = &t
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return f, "limit must be a positive number"
		}
		f.Limit = n
	}
	if v := q.Get("before_id"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			return f, "before_id must be a positive number"
		}
		f.BeforeID = n
	}
	return f, ""
}

// List handles GET /api/admin/logs.
func (h *AppLogsHandler) List(w http.ResponseWriter, r *http.Request) {
	f, bad := parseAppLogFilter(r)
	if bad != "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: bad})
		return
	}
	if database.GetPool() == nil {
		sendJSON(w, http.StatusServiceUnavailable, Response{Success: false, Message: "Database not connected"})
		return
	}
	logs, err := h.repo.List(r.Context(), f)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: "Could not load logs"})
		return
	}
	var next int64
	if len(logs) == database.AppLogClampLimit(f.Limit) {
		next = logs[len(logs)-1].ID
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: map[string]any{
		"logs": logs, "next_before_id": next,
	}})
}
