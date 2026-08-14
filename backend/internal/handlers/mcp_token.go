package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
)

// ── Token management handler (JWT-protected) ──────────────────────────────────

// MCPTokenHandler manages MCP token lifecycle under JWT auth.
type MCPTokenHandler struct {
	tokenRepo *database.MCPTokenRepository
}

func NewMCPTokenHandler() *MCPTokenHandler {
	return &MCPTokenHandler{tokenRepo: database.NewMCPTokenRepository()}
}

// GET /api/mcp/token — returns token metadata (not the plain token)
func (h *MCPTokenHandler) GetToken(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	t, err := h.tokenRepo.GetToken(r.Context(), u.ID)
	if err != nil || t == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"exists": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"exists":                true,
		"created_at":            t.CreatedAt,
		"last_used_at":          t.LastUsedAt,
		"default_send_time":     t.DefaultSendTime,
		"default_send_timezone": t.DefaultSendTimezone,
	})
}

// PUT /api/mcp/settings — save user preferences (default_send_time + timezone)
func (h *MCPTokenHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body struct {
		DefaultSendTime     string `json:"default_send_time"`
		DefaultSendTimezone string `json:"default_send_timezone"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DefaultSendTime == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "default_send_time required (HH:MM)"})
		return
	}
	if body.DefaultSendTimezone != "" {
		if _, err := time.LoadLocation(body.DefaultSendTimezone); err != nil {
			body.DefaultSendTimezone = "UTC"
		}
	}
	if err := h.tokenRepo.UpdateDefaultSendSettings(r.Context(), u.ID, body.DefaultSendTime, body.DefaultSendTimezone); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// POST /api/mcp/token — generate (or regenerate) a token; returns plain token once
func (h *MCPTokenHandler) GenerateToken(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	plain, err := h.tokenRepo.GenerateToken(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": plain})
}

// DELETE /api/mcp/token — revoke the token
func (h *MCPTokenHandler) RevokeToken(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if err := h.tokenRepo.RevokeToken(r.Context(), u.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}
