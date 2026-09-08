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

// GET /api/mcp/activity?limit=200 → { success, data: MCPActivityEntry[] }
// Admin-only. Rows are pruned after 7 days (see RunMCPActivityPruner), so
// this always reflects at most the last week of MCP transactions.
func (h *MCPActivityHandler) List(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	entries, err := h.repo.List(r.Context(), limit)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": entries})
}
