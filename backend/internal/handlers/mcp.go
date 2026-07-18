package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
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

// MCPHandler serves the MCP protocol endpoint used by Claude's custom connector.
// Auth: ?token= query param (plain MCP token, NOT a JWT).
// All JWT-protected token management lives in MCPTokenHandler below.
type MCPHandler struct {
	tokenRepo *database.MCPTokenRepository
	msgRepo   *database.PendingMessagesRepository
	slackSvc  *slacksvc.Service
	updateSvc *updatesvc.Service
}

func NewMCPHandler() *MCPHandler {
	return &MCPHandler{
		tokenRepo: database.NewMCPTokenRepository(),
		msgRepo:   database.NewPendingMessagesRepository(),
		slackSvc:  slacksvc.NewService(),
		updateSvc: updatesvc.NewService(),
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

// ── Tool definitions ──────────────────────────────────────────────────────────

var mcpTools = []map[string]interface{}{
	{
		"name": "get_developer_configs",
		"description": "Returns the developer→subsystem mapping configured in Velocity (Integrations → Developers tab). " +
			"Use this when creating a YouTrack ticket to find which developers own a given subsystem, " +
			"so you can auto-assign the ticket to the developer with the lowest current workload. " +
			"Each entry has: developer_login (YouTrack login), developer_name (display name), subsystems (list of subsystems they own), is_qa (true if QA role).",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
			"required":   []string{},
		},
	},
	{
		"name": "get_sprints",
		"description": "Returns all sprints for the YouTrack project, with their ID, name, and whether they are completed. " +
			"Use this when the user mentions a specific sprint by name (e.g. 'Sprint 6', 'Sprint 8') to resolve its ID before calling create_youtrack_ticket. " +
			"The latest non-completed sprint is the active sprint.",
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
			"required":   []string{},
		},
	},
	{
		"name": "get_developer_load",
		"description": "Returns the open ticket count for one or more YouTrack developer logins. " +
			"Use this after get_developer_configs to decide who to auto-assign a ticket to — pick the developer with the lowest count. " +
			"Pass a list of logins (e.g. [\"parv\", \"harpreet\"]) and get back {login: count} pairs.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"logins": map[string]interface{}{
					"type":        "array",
					"items":       map[string]string{"type": "string"},
					"description": "List of YouTrack developer login names to check workload for.",
				},
			},
			"required": []string{"logins"},
		},
	},
	{
		"name": "create_youtrack_ticket",
		"description": "Creates a new ticket in YouTrack. Call this only after the user has confirmed the ticket details. " +
			"Returns the created ticket ID (e.g. ARD-123) and its URL.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"summary": map[string]string{
					"type":        "string",
					"description": "Ticket title. Format: '<Subsystem>: <Action Verb> <What>'. Max 80 chars.",
				},
				"description": map[string]string{
					"type":        "string",
					"description": "Full ticket description (markdown supported).",
				},
				"type_name": map[string]string{
					"type":        "string",
					"description": "Issue type: Bug, Feature, Enhancement, Hotfix, or Regression.",
				},
				"priority": map[string]string{
					"type":        "string",
					"description": "Priority: Show-stopper, P0, P1, P2, P3, A0, A1, A2, A3, or Normal.",
				},
				"subsystem": map[string]string{
					"type":        "string",
					"description": "Subsystem name exactly as configured in Velocity (e.g. 'FE UI', 'BE MC', 'Mobile').",
				},
				"assignee_login": map[string]string{
					"type":        "string",
					"description": "YouTrack login of the assignee. Omit or pass empty string to leave unassigned.",
				},
				"sprint_id": map[string]string{
					"type":        "string",
					"description": "Optional. YouTrack sprint ID to attach the ticket to.",
				},
			},
			"required": []string{"summary", "type_name", "priority"},
		},
	},
	{
		"name":        "delete_youtrack_ticket",
		"description": "Permanently deletes a YouTrack ticket by its readable ID (e.g. ARD-123). Always confirm with the user before calling this.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"issue_id": map[string]string{
					"type":        "string",
					"description": "Readable ticket ID, e.g. ARD-123.",
				},
			},
			"required": []string{"issue_id"},
		},
	},
	{
		"name": "queue_slack_message",
		"description": "Queue a Slack message to be reviewed and sent by the Velocity bot. " +
			"Only `message` is required — channel and time are optional. " +
			"If no channel is given, the user will pick one in Velocity before sending. " +
			"Include @mentions by display name (e.g. @Suryansh) and they will resolve to Slack mentions automatically. " +
			"Do NOT call list_slack_channels first — just pass the channel name the user mentioned, or omit it.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"message": map[string]string{
					"type":        "string",
					"description": "The message text. Use @DisplayName for mentions (e.g. @Suryansh).",
				},
				"channel": map[string]string{
					"type":        "string",
					"description": "Optional. Channel name as the user mentioned it, e.g. 'ardoise-pm', 'simran-demo', '#general'. Omit if not specified.",
				},
				"send_time": map[string]string{
					"type": "string",
					"description": "Optional. Accepts a time-of-day today/tomorrow ('3:00 PM', '15:30', '9am') or a full ISO 8601 datetime ('2026-07-21T11:00:00'). " +
						"Does NOT understand relative phrases like 'next Monday' or 'tomorrow' as raw text — if the user says something like " +
						"'next Monday at 11am', compute the actual calendar date yourself (you know today's date) and pass the resolved ISO 8601 datetime instead. " +
						"Omit to use the user's saved default send time.",
				},
			},
			"required": []string{"message"},
		},
	},
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
	// Resolve user from ?token= query param or Authorization: Bearer header
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

// ── Tool dispatch ─────────────────────────────────────────────────────────────

func (h *MCPHandler) callTool(r *http.Request, id interface{}, raw json.RawMessage, userID string) rpcResponse {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return rpcErr(id, -32602, "invalid params")
	}

	ctx := r.Context()

	switch p.Name {
	case "get_developer_configs":
		configs, err := devConfigRepo.GetAll(ctx)
		if err != nil {
			return toolError(id, "Failed to fetch developer configs: "+err.Error())
		}
		data, _ := json.Marshal(configs)
		return toolOK(id, string(data))

	case "get_sprints":
		ytClient := mcpYTClient(ctx, userID)
		if ytClient == nil {
			return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
		}
		sprints, err := ytClient.GetSprints(ctx)
		if err != nil {
			return toolError(id, "Failed to fetch sprints: "+err.Error())
		}
		data, _ := json.Marshal(sprints)
		return toolOK(id, string(data))

	case "get_developer_load":
		var args struct {
			Logins []string `json:"logins"`
		}
		if err := json.Unmarshal(p.Arguments, &args); err != nil || len(args.Logins) == 0 {
			return rpcErr(id, -32602, "invalid arguments: logins array is required")
		}
		ytClient := mcpYTClient(ctx, userID)
		if ytClient == nil {
			return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
		}
		load := map[string]int{}
		for _, login := range args.Logins {
			count, err := ytClient.CountOpenIssuesByAssignee(ctx, login)
			if err != nil {
				load[login] = -1
			} else {
				load[login] = count
			}
		}
		data, _ := json.Marshal(load)
		return toolOK(id, string(data))

	case "create_youtrack_ticket":
		var args struct {
			Summary       string `json:"summary"`
			Description   string `json:"description"`
			TypeName      string `json:"type_name"`
			Priority      string `json:"priority"`
			Subsystem     string `json:"subsystem"`
			AssigneeLogin string `json:"assignee_login"`
			SprintID      string `json:"sprint_id"`
		}
		if err := json.Unmarshal(p.Arguments, &args); err != nil || args.Summary == "" {
			return rpcErr(id, -32602, "invalid arguments: summary is required")
		}
		ytClient := mcpYTClient(ctx, userID)
		if ytClient == nil {
			return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
		}

		req := youtrack.CreateIssueRequest{Summary: args.Summary, Description: args.Description}
		var fields []youtrack.CustomField

		// Always default state to "To Do"
		fields = append(fields, youtrack.CustomField{
			Type:  "StateIssueCustomField",
			Name:  "State",
			Value: map[string]string{"name": "To Do"},
		})
		if args.TypeName != "" {
			fields = append(fields, youtrack.CustomField{
				Type:  "SingleEnumIssueCustomField",
				Name:  "Type",
				Value: map[string]string{"name": args.TypeName},
			})
		}
		if args.Priority != "" {
			fields = append(fields, youtrack.CustomField{
				Type:  "SingleEnumIssueCustomField",
				Name:  "Priority",
				Value: map[string]string{"name": args.Priority},
			})
		}
		if args.Subsystem != "" {
			fields = append(fields, youtrack.CustomField{
				Type:  "SingleOwnedIssueCustomField",
				Name:  "Subsystem",
				Value: map[string]interface{}{"$type": "OwnedBundleElement", "name": args.Subsystem},
			})
		}
		if args.AssigneeLogin != "" {
			fields = append(fields, youtrack.CustomField{
				Type:  "SingleUserIssueCustomField",
				Name:  "Assignee",
				Value: map[string]string{"login": args.AssigneeLogin},
			})
		}
		req.CustomFields = fields

		issue, err := ytClient.CreateIssue(ctx, req)
		if err != nil {
			return toolError(id, "Failed to create ticket: "+err.Error())
		}

		// Assign to sprint — use provided sprint_id or auto-pick the latest active sprint
		sprintID := args.SprintID
		if sprintID == "" {
			if sprints, sErr := ytClient.GetSprints(ctx); sErr == nil {
				for i := len(sprints) - 1; i >= 0; i-- {
					if !sprints[i].IsCompleted {
						sprintID = sprints[i].ID
						break
					}
				}
			}
		}
		if sprintID != "" && issue != nil && issue.ID != "" {
			_ = ytClient.AddIssueToSprint(ctx, sprintID, issue.ID)
		}

		displayID := issue.IDReadable
		if displayID == "" {
			displayID = issue.ID
		}
		ytBaseURL := strings.TrimRight(ytClient.GetBaseURL(), "/")
		ticketURL := fmt.Sprintf("%s/issue/%s", ytBaseURL, displayID)
		result := fmt.Sprintf("Created %s — %s\n%s", displayID, issue.Summary, ticketURL)
		return toolOK(id, result)

	case "delete_youtrack_ticket":
		var args struct {
			IssueID string `json:"issue_id"`
		}
		if err := json.Unmarshal(p.Arguments, &args); err != nil || args.IssueID == "" {
			return rpcErr(id, -32602, "invalid arguments: issue_id is required")
		}
		ytClient := mcpYTClient(ctx, userID)
		if ytClient == nil {
			return toolError(id, "YouTrack not configured — add your YouTrack integration in Velocity → Integrations")
		}
		if err := ytClient.DeleteIssue(ctx, args.IssueID); err != nil {
			return toolError(id, "failed to delete "+args.IssueID+": "+err.Error())
		}
		return toolOK(id, "Deleted "+args.IssueID)

	case "queue_slack_message":
		var args struct {
			Message  string `json:"message"`
			Channel  string `json:"channel"`   // optional human-readable name
			SendTime string `json:"send_time"` // optional: "3pm", "15:30", ISO 8601
		}
		if err := json.Unmarshal(p.Arguments, &args); err != nil || args.Message == "" {
			return rpcErr(id, -32602, "invalid arguments: message is required")
		}

		// Resolve channel name → ID (best-effort; user can fix in Velocity if wrong)
		channelID, channelLabel := h.resolveChannel(ctx, userID, args.Channel)

		// Resolve @DisplayName → <@UXXX> mentions in message text
		message := resolveSlackMentions(ctx, h.slackSvc, userID, args.Message)

		// Fetch user's default settings once — timezone used for both explicit and default paths
		defaultHHMM, tzName := h.tokenRepo.GetDefaultSendSettings(ctx, userID)
		userLoc, locErr := time.LoadLocation(tzName)
		if locErr != nil {
			userLoc = time.UTC
		}

		// Determine scheduled time — parse flexible natural time or fall back to user default
		var scheduledAt *time.Time
		if args.SendTime != "" {
			t, err := parseFlexTime(args.SendTime, userLoc)
			if err != nil {
				return toolError(id, "couldn't parse send_time '"+args.SendTime+"' — try '3:00 PM', '15:30', or '9am'")
			}
			scheduledAt = &t
		} else {
			now := time.Now().In(userLoc)
			var hh, mm int
			fmt.Sscanf(defaultHHMM, "%d:%d", &hh, &mm)
			candidate := time.Date(now.Year(), now.Month(), now.Day(), hh, mm, 0, 0, userLoc)
			if !candidate.After(now) {
				candidate = candidate.Add(24 * time.Hour)
			}
			scheduledAt = &candidate
		}

		msg, err := h.msgRepo.Create(ctx, userID, message, channelID, channelLabel, "", scheduledAt)
		if err != nil {
			return toolError(id, "Failed to queue message: "+err.Error())
		}

		result := "Queued (id: " + msg.ID + ")."
		if channelLabel != "" {
			result += " Channel: " + channelLabel + "."
		} else {
			result += " No channel set — user will pick one in Velocity."
		}
		if scheduledAt != nil {
			result += " Scheduled for " + scheduledAt.Format("02 Jan 15:04 MST") + "."
		}
		return toolOK(id, result)

	default:
		return rpcErr(id, -32601, "unknown tool: "+p.Name)
	}
}

// resolveChannel looks up a human-readable channel name (e.g. "ardoise-pm", "#general")
// and returns (channelID, "#channelName"). Returns ("", "") if name is blank or not found.
func (h *MCPHandler) resolveChannel(ctx context.Context, userID, name string) (string, string) {
	if name == "" {
		return "", ""
	}
	name = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(name)), "#")
	channels, err := h.slackSvc.GetChannels(ctx, userID)
	if err != nil {
		return "", "#" + name // store the label at least
	}
	for _, ch := range channels {
		if strings.ToLower(ch.Name) == name {
			return ch.ID, "#" + ch.Name
		}
	}
	// Not found — store empty ID so frontend shows channel picker
	return "", "#" + name
}

// resolveSlackMentions replaces @DisplayName tokens with Slack <@UXXX> format.
// Unknown names are left as-is so the user can correct in Velocity. Shared by the
// MCP tool path (mcp.go) and the manual compose form (pending_messages.go).
func resolveSlackMentions(ctx context.Context, slackSvc *slacksvc.Service, userID, text string) string {
	if !strings.Contains(text, "@") {
		return text
	}
	users, err := slackSvc.GetWorkspaceUsers(ctx, userID)
	if err != nil || len(users) == 0 {
		return text
	}
	// Build name→ID map (display_name and real_name, case-insensitive). Track the
	// longest name in words so multi-word names (e.g. "Simran Dhindsa") can match.
	nameMap := make(map[string]string, len(users)*3)
	maxWords := 1
	addName := func(name, id string) {
		if name == "" {
			return
		}
		nameMap[strings.ToLower(name)] = id
		if w := len(strings.Fields(name)); w > maxWords {
			maxWords = w
		}
	}
	for _, u := range users {
		if u.ID == "" || u.IsBot || u.Deleted {
			continue
		}
		addName(u.Profile.DisplayName, u.ID)
		addName(u.RealName, u.ID)
		addName(u.Name, u.ID)
	}

	// Replace @Name tokens — try the longest space-separated run of words after @
	// first (so "@Simran Dhindsa" matches before falling back to just "@Simran").
	var result strings.Builder
	i := 0
	for i < len(text) {
		if text[i] != '@' {
			result.WriteByte(text[i])
			i++
			continue
		}
		var tokens []string
		var tokenEnds []int
		pos := i + 1
		for w := 0; w < maxWords; w++ {
			start := pos
			for pos < len(text) && text[pos] != ' ' && text[pos] != '\n' && text[pos] != ',' && text[pos] != ':' {
				pos++
			}
			if pos == start {
				break
			}
			tokens = append(tokens, text[start:pos])
			tokenEnds = append(tokenEnds, pos)
			if pos >= len(text) || text[pos] != ' ' {
				break
			}
			pos++ // skip the space, try to extend the match
		}
		matched := false
		for w := len(tokens); w >= 1; w-- {
			candidate := strings.ToLower(strings.Join(tokens[:w], " "))
			if uid, ok := nameMap[candidate]; ok {
				result.WriteString("<@" + uid + ">")
				i = tokenEnds[w-1]
				matched = true
				break
			}
		}
		if !matched {
			if len(tokens) > 0 {
				result.WriteString("@" + tokens[0]) // leave as-is
				i = tokenEnds[0]
			} else {
				result.WriteByte('@')
				i++
			}
		}
	}
	return result.String()
}

// parseFlexTime parses natural time strings ("3pm", "3:00 PM", "15:30") and
// full ISO 8601 datetimes. Returns a time on today (or tomorrow if past).
func parseFlexTime(s string, loc *time.Location) (time.Time, error) {
	s = strings.TrimSpace(s)
	if loc == nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)

	// Try ISO 8601 first (already timezone-aware via the offset in the string)
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, nil
		}
	}

	// Try time-only formats in user's timezone, rolling to tomorrow if past
	timeLayouts := []string{"3:04 PM", "3:04PM", "15:04", "3 PM", "3PM", "3pm", "15"}
	for _, layout := range timeLayouts {
		if t, err := time.ParseInLocation(layout, strings.ToUpper(s), loc); err == nil {
			candidate := time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), 0, 0, loc)
			if !candidate.After(now) {
				candidate = candidate.Add(24 * time.Hour)
			}
			return candidate, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised time format: %q", s)
}

func toolOK(id interface{}, text string) rpcResponse {
	return rpcOK(id, map[string]interface{}{
		"content": []map[string]string{{"type": "text", "text": text}},
		"isError": false,
	})
}

func toolError(id interface{}, text string) rpcResponse {
	return rpcOK(id, map[string]interface{}{
		"content": []map[string]string{{"type": "text", "text": text}},
		"isError": true,
	})
}

func (h *MCPHandler) resolveUser(r *http.Request) string {
	token := r.URL.Query().Get("token")
	if token == "" {
		auth := r.Header.Get("Authorization")
		token = strings.TrimPrefix(auth, "Bearer ")
	}
	if token == "" {
		return ""
	}
	userID, _ := h.tokenRepo.GetUserByToken(r.Context(), token)
	return userID
}

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
