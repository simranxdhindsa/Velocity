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
	tokenRepo    *database.MCPTokenRepository
	settingsRepo *database.MCPSettingsRepository
}

func NewMCPTokenHandler() *MCPTokenHandler {
	return &MCPTokenHandler{
		tokenRepo:    database.NewMCPTokenRepository(),
		settingsRepo: database.NewMCPSettingsRepository(),
	}
}

// GET /api/mcp/token — connection status: whether any client is connected,
// plus the full list of connected clients (Claude, Codex, ...), each with its
// own independent token now that they no longer share one row.
func (h *MCPTokenHandler) GetToken(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	tokens, err := h.tokenRepo.ListTokens(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	hhmm, tz := h.settingsRepo.GetDefaultSendSettings(r.Context(), u.ID)

	conns := make([]map[string]interface{}, 0, len(tokens))
	for _, t := range tokens {
		conns = append(conns, map[string]interface{}{
			"client_id":    t.ClientID,
			"client_name":  t.ClientName,
			"created_at":   t.CreatedAt,
			"last_used_at": t.LastUsedAt,
		})
	}

	resp := map[string]interface{}{
		"exists":                len(tokens) > 0,
		"connections":           conns,
		"default_send_time":     hhmm,
		"default_send_timezone": tz,
	}
	// Top-level created_at/last_used_at mirror the most recently created
	// connection, kept for backward compatibility with the existing UI.
	if len(tokens) > 0 {
		resp["created_at"] = tokens[0].CreatedAt
		resp["last_used_at"] = tokens[0].LastUsedAt
	}
	writeJSON(w, http.StatusOK, resp)
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
	if err := h.settingsRepo.UpdateDefaultSendSettings(r.Context(), u.ID, body.DefaultSendTime, body.DefaultSendTimezone); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// POST /api/mcp/token — generate (or regenerate) a manual token; returns the
// plain token once. Kept for compatibility; OAuth (used by Claude.ai, Codex,
// etc.) issues its own per-client token and never calls this.
func (h *MCPTokenHandler) GenerateToken(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	plain, err := h.tokenRepo.GenerateToken(r.Context(), u.ID, "manual", "Manual token")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": plain})
}

// DELETE /api/mcp/token?client_id=... — revoke one connected client's token.
// Defaults to the legacy "manual" token so this stays a no-op for OAuth
// clients if ever called without a client_id. Only revokes the named client's
// session — other connected clients are unaffected.
func (h *MCPTokenHandler) RevokeToken(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	clientID := r.URL.Query().Get("client_id")
	if clientID == "" {
		clientID = "manual"
	}
	if err := h.tokenRepo.RevokeToken(r.Context(), u.ID, clientID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}
