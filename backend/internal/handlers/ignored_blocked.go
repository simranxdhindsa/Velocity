package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/gorilla/mux"
)

type IgnoredBlockedHandler struct {
	repo *database.IgnoredBlockedRepository
}

func NewIgnoredBlockedHandler() *IgnoredBlockedHandler {
	return &IgnoredBlockedHandler{
		repo: database.NewIgnoredBlockedRepository(),
	}
}

// GET /api/ignored-blocked  →  { data: ["ARD-123", ...] }
func (h *IgnoredBlockedHandler) GetIgnored(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "Unauthorized"})
		return
	}

	ids, err := h.repo.GetIgnoredIDs(r.Context(), user.ID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": ids})
}

// POST /api/ignored-blocked  body: { issue_id: "ARD-123" }
func (h *IgnoredBlockedHandler) IgnoreTicket(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "Unauthorized"})
		return
	}

	var body struct {
		IssueID string `json:"issue_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.IssueID == "" {
		sendJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": "issue_id required"})
		return
	}

	if err := h.repo.IgnoreTicket(r.Context(), user.ID, body.IssueID); err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /api/ignored-blocked/{issue_id}
func (h *IgnoredBlockedHandler) UnignoreTicket(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "Unauthorized"})
		return
	}

	issueID := mux.Vars(r)["issue_id"]
	if issueID == "" {
		sendJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": "issue_id required"})
		return
	}

	if err := h.repo.UnignoreTicket(r.Context(), user.ID, issueID); err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true})
}
