package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/services/s3storage"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
	updatesvc "github.com/dhindsa/project-management/internal/services/update_reminder"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// devConfigRepo is a package-level repo for the MCP tool; no state, safe to share.
var devConfigRepo = database.NewDeveloperConfigRepository()
var mcpSettingsRepo = database.NewSettingsRepository()

// mcpYTClient builds a YouTrack client for MCP tools.
// Resolution order: per-user DB integration → global settings DB → env vars.
// This mirrors getYouTrackClientForUser so the MCP tools pick up whatever the
// user configured in Integrations → YouTrack, not just env vars.
func mcpYTClient(ctx context.Context, userID string) *youtrack.Client {
	var baseURL, token, projectID, boardID string

	// 1. Per-user integration from DB
	if userID != "" {
		if integration, err := mcpSettingsRepo.GetYouTrackIntegration(ctx, userID); err == nil && integration != nil && integration.Connected {
			baseURL = integration.BaseURL
			token = integration.Token
			projectID = integration.ProjectID
			boardID = integration.BoardID
		}
	}

	// 2. Global (org-wide) settings from DB
	if baseURL == "" {
		if settings, err := mcpSettingsRepo.GetYouTrackSettings(ctx); err == nil && settings != nil && settings.Configured {
			baseURL = settings.BaseURL
			token = settings.Token
			projectID = settings.ProjectID
		}
	}

	// 3. Env vars (last resort)
	if baseURL == "" {
		baseURL = os.Getenv("YOUTRACK_BASE_URL")
	}
	if token == "" {
		token = os.Getenv("YOUTRACK_TOKEN")
	}
	if projectID == "" {
		projectID = os.Getenv("YOUTRACK_PROJECT_ID")
	}
	if boardID == "" {
		boardID = os.Getenv("YOUTRACK_BOARD_ID")
	}

	if baseURL == "" || token == "" || projectID == "" {
		return nil
	}
	client := youtrack.NewClient(baseURL, token, projectID)
	if boardID != "" {
		client.SetBoardID(boardID)
	}
	return client
}

// mcpS3Client builds the S3 client used for MCP ticket-attachment uploads.
// Config comes from env vars only — this is an infra credential, not a
// per-user setting like YouTrack/Slack.
func mcpS3Client(ctx context.Context) (*s3storage.Client, error) {
	region := os.Getenv("AWS_REGION")
	accessKeyID := os.Getenv("AWS_ACCESS_KEY_ID")
	secretAccessKey := os.Getenv("AWS_SECRET_ACCESS_KEY")
	bucket := os.Getenv("S3_ATTACHMENTS_BUCKET")
	if region == "" || accessKeyID == "" || secretAccessKey == "" || bucket == "" {
		return nil, errors.New("attachment uploads are not configured — set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_ATTACHMENTS_BUCKET")
	}
	return s3storage.NewClient(ctx, region, accessKeyID, secretAccessKey, bucket)
}

// MCPHandler serves the MCP protocol endpoint used by Claude's custom connector.
// Auth: Authorization: Bearer header only (plain MCP token, NOT a JWT).
// Query-string tokens are rejected so tokens never land in access/proxy logs.
// All JWT-protected token management lives in MCPTokenHandler (mcp_token.go).
type MCPHandler struct {
	tokenRepo    *database.MCPTokenRepository
	settingsRepo *database.MCPSettingsRepository
	msgRepo      *database.PendingMessagesRepository
	slackSvc     *slacksvc.Service
	updateSvc    *updatesvc.Service
	botRepo      *database.BotConfigRepository
}

func NewMCPHandler() *MCPHandler {
	return &MCPHandler{
		tokenRepo:    database.NewMCPTokenRepository(),
		settingsRepo: database.NewMCPSettingsRepository(),
		msgRepo:      database.NewPendingMessagesRepository(),
		slackSvc:     slacksvc.NewService(),
		updateSvc:    updatesvc.NewService(),
		botRepo:      database.NewBotConfigRepository(),
	}
}

// ── JSON-RPC 2.0 types ────────────────────────────────────────────────────────

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	ID      interface{}     `json:"id"`
}

type rpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	Result  interface{} `json:"result,omitempty"`
	Error   interface{} `json:"error,omitempty"`
	ID      interface{} `json:"id"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func rpcOK(id, result interface{}) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", Result: result, ID: id}
}

func rpcErr(id interface{}, code int, msg string) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", Error: rpcError{Code: code, Message: msg}, ID: id}
}

// ── GET /api/mcp — SSE stream (MCP 2025-06-18 Streamable HTTP transport) ────
// Claude.ai opens this after OAuth to establish a server-sent events channel.
// Velocity doesn't push server-initiated events, so we keep the connection
// open and send periodic heartbeats until the client disconnects.

func (h *MCPHandler) HandleSSE(w http.ResponseWriter, r *http.Request) {
	userID := h.resolveUser(r)
	if userID == "" {
		frontendURL := strings.TrimRight(os.Getenv("FRONTEND_URL"), "/")
		if frontendURL == "" {
			frontendURL = "http://localhost:5173"
		}
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+frontendURL+`/.well-known/oauth-protected-resource"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

	// Propagate session-id from request back to client (MCP 2025-06-18)
	if sid := r.Header.Get("Mcp-Session-Id"); sid != "" {
		w.Header().Set("Mcp-Session-Id", sid)
	}

	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	// Send a heartbeat every 30s; exit when the client closes the connection.
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// ── Main entrypoint: POST /api/mcp ───────────────────────────────────────────

func (h *MCPHandler) Handle(w http.ResponseWriter, r *http.Request) {
	// Resolve user from the Authorization: Bearer header
	userID := h.resolveUser(r)
	if userID == "" {
		// Include WWW-Authenticate so Claude.ai discovers our OAuth server
		frontendURL := strings.TrimRight(os.Getenv("FRONTEND_URL"), "/")
		if frontendURL == "" {
			frontendURL = "http://localhost:5173"
		}
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+frontendURL+`/.well-known/oauth-protected-resource"`)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(rpcErr(nil, -32001, "invalid or missing MCP token"))
		return
	}

	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rpcErr(nil, -32700, "parse error"))
		return
	}

	w.Header().Set("Content-Type", "application/json")

	var resp rpcResponse
	switch req.Method {
	case "initialize":
		// No Mcp-Session-Id — we have no server-initiated events so sessions are not needed.
		// Returning a session ID would cause Claude.ai to open a GET SSE connection, but
		// claude.ai's shttp proxy returns 405 for browser-side GET, breaking the connection.
		resp = rpcOK(req.ID, map[string]interface{}{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]interface{}{"tools": map[string]bool{"listChanged": false}},
			"serverInfo":      map[string]string{"name": "velocity", "version": "1.0.0"},
		})

	case "tools/list":
		resp = rpcOK(req.ID, map[string]interface{}{"tools": mcpTools})

	case "tools/call":
		resp = h.callTool(r, req.ID, req.Params, userID)

	default:
		resp = rpcErr(req.ID, -32601, "method not found: "+req.Method)
	}

	json.NewEncoder(w).Encode(resp)
}

func toolOK(id interface{}, text string) rpcResponse {
	return rpcOK(id, map[string]interface{}{
		"content": []map[string]string{{"type": "text", "text": text}},
		"isError": false,
	})
}

// toolOKContent returns a successful tool result built from arbitrary MCP
// content blocks (e.g. a text block followed by image blocks, see
// mcpTextBlock/mcpImageBlock). mcpResultSummary reads the first text block.
func toolOKContent(id interface{}, blocks []map[string]interface{}) rpcResponse {
	return rpcOK(id, map[string]interface{}{
		"content": blocks,
		"isError": false,
	})
}

func mcpTextBlock(text string) map[string]interface{} {
	return map[string]interface{}{"type": "text", "text": text}
}

// mcpImageBlock is an MCP image content block; data is base64 (no data: prefix).
func mcpImageBlock(base64Data, mimeType string) map[string]interface{} {
	return map[string]interface{}{"type": "image", "data": base64Data, "mimeType": mimeType}
}

func toolError(id interface{}, text string) rpcResponse {
	return rpcOK(id, map[string]interface{}{
		"content": []map[string]string{{"type": "text", "text": text}},
		"isError": true,
	})
}

func (h *MCPHandler) resolveUser(r *http.Request) string {
	// ?token= is deliberately not accepted: URLs end up in access and proxy
	// logs, browser history and Referer headers, which would leak the token.
	if r.URL.Query().Has("token") {
		log.Printf("[MCP] ✗ rejected request with ?token= query param, use the Authorization: Bearer header")
		return ""
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return ""
	}
	token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if token == "" {
		return ""
	}
	userID, _ := h.tokenRepo.GetUserByToken(r.Context(), token)
	return userID
}
