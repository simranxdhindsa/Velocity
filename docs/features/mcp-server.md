# Velocity MCP Server

## What it is

`/api/mcp` is an MCP (Model Context Protocol) server so Claude.ai's custom connector can call YouTrack and Slack actions directly, on behalf of a Velocity user. Auth is a plain MCP token (`?token=` query param), separate from the app's JWT auth — managed under `/api/mcp/token` (JWT-protected, for generating/revoking the MCP token from Velocity's UI).

## File organization — one file per tool

`backend/internal/handlers/mcp*.go`:

| File | Contents |
|---|---|
| `mcp.go` | Core JSON-RPC glue: `MCPHandler` struct/constructor, `mcpYTClient`/`mcpS3Client` builders, JSON-RPC types, `HandleSSE`, `Handle` (top-level `initialize`/`tools/list`/`tools/call` routing), `toolOK`/`toolError`, `resolveUser` |
| `mcp_dispatch.go` | `callTool` — parses the `tools/call` request and looks up the handler in `mcpToolHandlers`, a `map[string]mcpToolFunc` |
| `mcp_tools.go` | `mcpTools` — aggregates every tool's schema var into the slice returned by `tools/list` |
| `mcp_slack.go` | `resolveChannel`, `resolveSlackUser`, `resolveSlackMentions`, `parseFlexTime` — helpers used only by `queue_slack_message` |
| `mcp_token.go` | `MCPTokenHandler` — JWT-protected `/api/mcp/token` lifecycle (generate/revoke/settings). Separate concern from the MCP protocol handler itself. |
| `mcp_tool_<name>.go` | **One file per tool.** Each holds both the tool's JSON schema (`<name>ToolSchema`) and its handler function (`mcp<Name>`) together. |

## Adding a new tool

1. Create `mcp_tool_<name>.go` with:
   - a schema var: `var <name>ToolSchema = map[string]interface{}{...}`
   - a handler: `func mcp<Name>(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse`
2. Register the schema in `mcpTools` (`mcp_tools.go`)
3. Register the handler in `mcpToolHandlers` (`mcp_dispatch.go`)

Never add tool logic inline to `mcp_dispatch.go` or `mcp.go` — each tool is self-contained in its own file so the dispatch/routing files stay thin as the tool count grows.

## Current tools (as of this writing)

`get_developer_configs`, `get_sprints`, `get_developer_load`, `get_youtrack_ticket` (exact ID only), `search_youtrack_tickets` (YQL-based free text + assignee/sprint/state filters), `create_youtrack_ticket`, `delete_youtrack_ticket`, `edit_youtrack_ticket`, `create_attachment_upload_url`, `upload_youtrack_attachment`, `link_youtrack_tickets`, `queue_slack_message`.

### `search_youtrack_tickets` notes

- Resolves `assignee_login` from a display name via `get_developer_configs` first — YouTrack YQL rejects the whole query with a `400 invalid_query` error if `Assignee:` doesn't match a real login (not just an empty result), so the tool surfaces a hint to verify the login when that happens.
- `sprint_name` accepts the literal `"current"`/`"latest"` to resolve the active sprint via `GetLatestSprintName`.
- Always scopes to `project: <projectID>` plus whatever filters are given; YQL parts are ANDed by joining with spaces.
