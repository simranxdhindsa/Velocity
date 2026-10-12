package handlers

import (
	"net/http"
	"strconv"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
)

type SlackBotConversationsHandler struct {
	repo *database.SlackBotConversationRepository
}

func NewSlackBotConversationsHandler() *SlackBotConversationsHandler {
	return &SlackBotConversationsHandler{repo: database.NewSlackBotConversationRepository()}
}

// List handles GET /api/slack-bot-chat?limit=200 -> { success, data: SlackBotConversation[], is_admin_view: bool }
// or ?page=1&page_size=20 -> the same plus total, page, page_size.
// Authenticated (any logged-in user), NOT admin-gated at the route level —
// admins see every conversation, everyone else sees only their own (matched
// by the Velocity user ID resolved at log time via Slack sender email).
// THIS IS THE SECURITY BOUNDARY: a non-admin user's filter is ALWAYS their
// own authenticated user.ID from the JWT-derived context, never a
// client-supplied value (there is no user_id query param at all, by design,
// so there is nothing a non-admin could tamper with to see someone else's
// conversations).
func (h *SlackBotConversationsHandler) List(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "authentication required"})
		return
	}

	isAdmin := user.Role == models.RoleAdmin
	userIDFilter := user.ID
	if isAdmin {
		userIDFilter = ""
	}

	// ?page=N&page_size=M: one page plus the filtered total (same filter).
	q := r.URL.Query()
	if q.Get("page") != "" {
		page, _ := strconv.Atoi(q.Get("page"))
		if page < 1 {
			page = 1
		}
		size, _ := strconv.Atoi(q.Get("page_size"))
		if size < 1 || size > 100 {
			size = 20
		}
		total, err := h.repo.Count(r.Context(), userIDFilter)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
			return
		}
		if last := (total + size - 1) / size; last > 0 && page > last {
			page = last // entries pruned since the page was opened
		}
		entries, err := h.repo.ListPage(r.Context(), userIDFilter, size, (page-1)*size)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": entries, "is_admin_view": isAdmin,
			"total": total, "page": page, "page_size": size})
		return
	}

	limit := 200
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	entries, err := h.repo.List(r.Context(), userIDFilter, limit)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": entries, "is_admin_view": isAdmin})
}
