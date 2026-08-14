package handlers

import (
	"context"
	"encoding/json"
	"net/http"
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
		return rpcErr(id, -32601, "unknown tool: "+p.Name)
	}
	return handler(r.Context(), h, userID, id, p.Arguments)
}
