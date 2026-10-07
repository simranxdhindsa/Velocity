package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

// mcpToolFunc handles one MCP tools/call invocation. Each MCP tool lives in
// its own mcp_tool_<name>.go file defining a schema var + one function of
// this type. A new tool must register itself in mcpTools (mcp_tools.go) and
// mcpToolHandlers below.
type mcpToolFunc func(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse

// mcpToolHandlers maps each tool name to its handler, defined alongside its
// schema in mcp_tool_<name>.go.
var mcpToolHandlers = map[string]mcpToolFunc{
	"get_developer_configs":        mcpGetDeveloperConfigs,
	"get_sprints":                  mcpGetSprints,
	"get_developer_load":           mcpGetDeveloperLoad,
	"get_youtrack_ticket":          mcpGetYoutrackTicket,
	"search_youtrack_tickets":      mcpSearchYoutrackTickets,
	"create_youtrack_ticket":       mcpCreateYoutrackTicket,
	"delete_youtrack_ticket":       mcpDeleteYoutrackTicket,
	"edit_youtrack_ticket":         mcpEditYoutrackTicket,
	"create_attachment_upload_url": mcpCreateAttachmentUploadURL,
	"upload_youtrack_attachment":   mcpUploadYoutrackAttachment,
	"link_youtrack_tickets":        mcpLinkYoutrackTickets,
	"queue_slack_message":          mcpQueueSlackMessage,
	"send_slack_message_now":       mcpSendSlackMessageNow,
	"delete_slack_message":         mcpDeleteSlackMessage,
	"edit_slack_message":           mcpEditSlackMessage,
	"get_slack_reply_config":       mcpGetSlackReplyConfig,
	"update_slack_reply_config":    mcpUpdateSlackReplyConfig,
	"get_daytrack":                 mcpGetDaytrack,
}

// mcpToolActionLabels gives each tool a plain-language action name for the
// MCP Activity log/UI, e.g. "queue_slack_message" → "Scheduled Slack message".
var mcpToolActionLabels = map[string]string{
	"get_developer_configs":        "Fetched developer configs",
	"get_sprints":                  "Fetched sprints",
	"get_developer_load":           "Fetched developer load",
	"get_youtrack_ticket":          "Fetched ticket",
	"search_youtrack_tickets":      "Searched tickets",
	"create_youtrack_ticket":       "Created ticket",
	"delete_youtrack_ticket":       "Deleted ticket",
	"edit_youtrack_ticket":         "Edited ticket",
	"create_attachment_upload_url": "Created attachment upload URL",
	"upload_youtrack_attachment":   "Uploaded attachment",
	"link_youtrack_tickets":        "Linked tickets",
	"queue_slack_message":          "Scheduled Slack message",
	"send_slack_message_now":       "Sent Slack message",
	"delete_slack_message":         "Deleted Slack message",
	"edit_slack_message":           "Edited Slack message",
	"get_slack_reply_config":       "Fetched Slack reply config",
	"update_slack_reply_config":    "Updated Slack reply config",
	"get_daytrack":                 "Fetched DayTrack",
}

// callTool dispatches a tools/call request to the matching tool's handler.
func (h *MCPHandler) callTool(r *http.Request, id interface{}, raw json.RawMessage, userID string) rpcResponse {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return rpcErr(id, -32602, "invalid params")
	}

	handler, ok := mcpToolHandlers[p.Name]
	if !ok {
		log.Printf("[MCP] ✗ unknown tool %q requested by user=%s", p.Name, userID)
		return rpcErr(id, -32601, "unknown tool: "+p.Name)
	}

	label := mcpToolActionLabels[p.Name]
	if label == "" {
		label = p.Name
	}

	start := time.Now()
	resp := handler(r.Context(), h, userID, id, p.Arguments)
	elapsed := time.Since(start).Round(time.Millisecond)

	summary, success := mcpResultSummary(resp)
	if summary == "" {
		summary = label
	}

	if success {
		log.Printf("[MCP] ✓ %s (user=%s, %s): %s", label, userID, elapsed, summary)
	} else {
		log.Printf("[MCP] ✗ %s failed (user=%s, %s): %s", label, userID, elapsed, summary)
	}

	logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := mcpActivityRepo.Log(logCtx, database.MCPActivityEntry{
		UserID:      userID,
		ToolName:    p.Name,
		ActionLabel: label,
		Summary:     summary,
		Success:     success,
		DurationMs:  int(elapsed.Milliseconds()),
	}); err != nil {
		log.Printf("[MCP Activity] ⚠ failed to record log entry: %v", err)
	}

	return resp
}

// mcpResultSummary pulls the plain-text result (or error) out of an rpcResponse
// so the activity log can show what actually happened, not just a tool name.
// Handles both protocol-level errors (resp.Error set) and tool-level errors
// (rpcOK with isError:true in the content, from toolError()).
func mcpResultSummary(resp rpcResponse) (summary string, success bool) {
	if resp.Error != nil {
		if e, ok := resp.Error.(rpcError); ok {
			return e.Message, false
		}
		return fmt.Sprintf("%v", resp.Error), false
	}

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		return "", true
	}
	isError, _ := result["isError"].(bool)

	// Text-only tools use []map[string]string (toolOK/toolError); tools that
	// return images use []map[string]interface{} (toolOKContent). Either way,
	// the summary is the first text block, never base64 image data.
	text := ""
	switch content := result["content"].(type) {
	case []map[string]string:
		for _, b := range content {
			if b["type"] == "text" {
				text = b["text"]
				break
			}
		}
	case []map[string]interface{}:
		for _, b := range content {
			if t, _ := b["type"].(string); t == "text" {
				text, _ = b["text"].(string)
				break
			}
		}
	}
	return text, !isError
}
