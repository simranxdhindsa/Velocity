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

`get_developer_configs`, `get_sprints`, `get_developer_load`, `get_youtrack_ticket` (exact ID only), `search_youtrack_tickets` (YQL-based free text + assignee/sprint/state filters), `create_youtrack_ticket`, `delete_youtrack_ticket`, `edit_youtrack_ticket`, `create_attachment_upload_url`, `upload_youtrack_attachment`, `link_youtrack_tickets`, `queue_slack_message`, `send_slack_message_now`, `delete_slack_message`.

### `send_slack_message_now` notes

- Sends immediately by calling `updatesvc.Service.QuickSend` directly (the same service the Quick Send UI tab uses) — no waiting for the scheduler's next tick.
- Requires `channel` or `dm_user` to resolve to a real Slack destination; unlike `queue_slack_message`, it does not fall back to "user picks a destination in Velocity" — resolution failures return a tool error instead.
- No `send_time` param — this tool is for "send right now" requests only. Anything scheduled/reviewed first still goes through `queue_slack_message`.
- Still writes a row to `pending_slack_messages` (via `msgRepo.Create` + `MarkSent`/`MarkFailed`), same table `queue_slack_message` uses, just created already-sent instead of pending. This is what makes an instant send show up in Update Reminders → Claude Queue (KPI counts, "Recent" list, and the existing "Delete from Slack" button) instead of only existing in Slack with no trace in the app.

### `delete_slack_message` notes

- Only ever deletes messages Velocity itself posted — cross-references `slacksvc.Service.GetLiveChannelMessages`'s `IsVelocity` flag (backed by the separate `sent_slack_messages` hub-log table, not `pending_slack_messages`) before allowing a delete. Slack's API wouldn't allow deleting another user's message with a bot token anyway, but this also stops Claude from trying.
- Without `contains`, deletes the most recent Velocity message in that channel/DM (`GetLiveChannelMessages` returns newest-first). Pass `contains` to target an older one by a text snippet.
- After deleting from Slack, separately looks up and removes the matching `pending_slack_messages` row by `slack_ts` (a second lookup — `GetLiveChannelMessages`'s own `ID` field belongs to the hub-log table, not the queue table, so it can't be reused for this) so the Claude Queue "Recent" list doesn't keep a dangling card pointing at a deleted message.
- DM destinations open the DM channel via a fresh `slacksvc.Client.OpenDirectMessageChannel` call rather than through `Service`, since `Service` doesn't expose that resolution itself.

### `search_youtrack_tickets` notes

- Resolves `assignee_login` from a display name via `get_developer_configs` first — YouTrack YQL rejects the whole query with a `400 invalid_query` error if `Assignee:` doesn't match a real login (not just an empty result), so the tool surfaces a hint to verify the login when that happens.
- `sprint_name` accepts the literal `"current"`/`"latest"` to resolve the active sprint via `GetLatestSprintName`.
- Always scopes to `project: <projectID>` plus whatever filters are given; YQL parts are ANDed by joining with spaces.
