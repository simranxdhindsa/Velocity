package handlers

import (
	"net/http"
	"strconv"

	"github.com/dhindsa/project-management/internal/database"
)

// mcpActivityRepo is a package-level repo shared by the dispatcher (writes)
// and this handler (reads); no state, safe to share.
var mcpActivityRepo = database.NewMCPActivityRepository()

type MCPActivityHandler struct {
	repo *database.MCPActivityRepository
}

func NewMCPActivityHandler() *MCPActivityHandler {
	return &MCPActivityHandler{repo: mcpActivityRepo}
}

// GET /api/mcp/activity?page=1&page_size=25
// → { success, data: MCPActivityEntry[], total, failed, page, page_size }.
// Admin-only. Without page, the older ?limit=200 form returns the latest
// rows only. Rows are pruned after 7 days (see RunMCPActivityPruner), so
// this always reflects at most the last week of MCP transactions.
func (h *MCPActivityHandler) List(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("page") == "" {
		limit := 200
		if n, err := strconv.Atoi(q.Get("limit")); err == nil {
			limit = n
		}
		entries, err := h.repo.List(r.Context(), limit)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": entries})
		return
	}

	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(q.Get("page_size"))
	if size < 1 || size > 100 {
		size = 25
	}
	total, failed, err := h.repo.Counts(r.Context())
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
		return
	}
	// A page past the end (entries pruned or deleted since) snaps to the last one.
	if last := (total + size - 1) / size; last > 0 && page > last {
		page = last
	}
	entries, err := h.repo.ListPage(r.Context(), size, (page-1)*size)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{
		"success": true, "data": entries,
		"total": total, "failed": failed, "page": page, "page_size": size,
	})
}
