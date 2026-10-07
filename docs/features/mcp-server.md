# Velocity MCP Server

## What it is

`/api/mcp` is an MCP (Model Context Protocol) server so Claude.ai's custom connector can call YouTrack and Slack actions directly, on behalf of a Velocity user. Auth is a plain MCP token sent as an `Authorization: Bearer` header (issued via OAuth; `?token=` query params are rejected so tokens never land in URL logs), separate from the app's JWT auth — managed under `/api/mcp/token` (JWT-protected, for generating/revoking the MCP token from Velocity's UI).

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

`get_developer_configs`, `get_sprints`, `get_developer_load`, `get_youtrack_ticket` (exact ID only; includes comments, attachments and images), `search_youtrack_tickets` (YQL-based free text + assignee/sprint/state filters), `create_youtrack_ticket`, `delete_youtrack_ticket`, `edit_youtrack_ticket`, `create_attachment_upload_url`, `upload_youtrack_attachment`, `link_youtrack_tickets`, `queue_slack_message`, `send_slack_message_now`, `delete_slack_message`, `edit_slack_message`, `get_slack_reply_config`, `update_slack_reply_config`.

### `get_slack_reply_config` / `update_slack_reply_config` notes

- Read/write the `bot_configs` row (`bot_type='slack_reply'`) that powers the Slack Events webhook's funny auto-reply persona — see [`docs/features/slack-events-bot.md`](docs/features/slack-events-bot.md). This is what lets the persona be changed by asking Claude, instead of editing a hardcoded Go string and redeploying.
- `update_slack_reply_config` replaces the whole prompt; there's no partial/append edit, so callers that want to tweak rather than replace should `get` first, then send back the edited full text.

### Markdown tables and long messages (`queue_slack_message`, `send_slack_message_now`, Quick Send)

All three paths send through `updatesvc.Service.QuickSend`, which now calls `slacksvc.BuildSendParts(message)` before posting. Slack's classic mrkdwn `text` field has no concept of a Markdown table — posting `| col | col |` rows as plain text just shows the raw pipe characters — so:

- A message containing a GFM pipe-table (header row + `|:---|:---|` separator, the format the Ardoise daily-update report uses) is converted to real Block Kit blocks: non-table text becomes `markdown`-type blocks (which, unlike classic mrkdwn, correctly parse GFM `**bold**`/`*italic*`), and the table itself becomes a native `table` block with actual bordered rows — the same rendering the official Slack MCP connector produces. See `backend/internal/services/slack/blocks.go`.
- Table cells are parsed into real rich_text elements (`parseInline`): `**bold**`, `*italic*`/`_italic_`, and `<@UID>` mentions become real mention chips, not literal angle-bracket text.
- A row of all-blank/invisible-char cells (`| ㅤ | ㅤ |`, used in the Ardoise template to separate people) is treated as a safe split point (`maxTableRowsPerBlock`) if a table needs to span multiple `table` blocks — the header row repeats in each one.
- Plain messages with no table are sent completely unchanged — no behavior change there.
- Long content (with or without a table) is split across multiple messages sent in sequence, each labeled "— continued", instead of being truncated with a cutoff notice. `QuickSend` returns the first part's `ts` for edit/delete tracking; later parts are additional posts in the same destination.
- This only affects the Claude Queue / Quick Send send path. DayTrack's Slack posting (`client.PostMessage`/`UpdateMessage`, its own `truncateForSlack`) and reminder-rule roster DMs are untouched — they don't go through `QuickSend`.

### Raw conversation IDs (`queue_slack_message`, `send_slack_message_now`, `delete_slack_message`)

`resolveChannel` (`mcp_slack.go`) accepts a raw Slack conversation ID — any channel, group DM, or DM ID matching `^[CGD][A-Z0-9]{8,}$` — in the `channel` param, passed straight through with no name lookup. This covers group DMs, which have no name to resolve by. Passing a raw ID doesn't grant access by itself — the Velocity bot still has to actually be a member of that conversation, or Slack returns `channel_not_found` just like it would for any other unauthorized conversation.

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

### `edit_slack_message` notes

- Targeting (resolve channel/DM, `IsVelocity`-only matching, `contains` to pick a specific message) is identical to `delete_slack_message` — same safety guarantee, Claude can only edit Velocity's own messages.
- Calls `updatesvc.Service.UpdateSlackMessage` → `chat.update`, the same path the Quick Send history UI's edit button uses. Plain text only — it does not run the new text through `slacksvc.BuildSendParts`, so editing a message that was originally sent as a Markdown table (native `table` block) isn't supported; that message keeps its original table content regardless of the new text passed in.
- Does not touch the `pending_slack_messages` row's stored `message` text (consistent with the existing REST edit endpoint, which only takes `channelId`/`ts`, not a queue row ID) — only the live Slack message content changes.

### `get_youtrack_ticket` notes

Returns the ticket fields plus the full discussion, because comments are often where a ticket is actually concluded (resolved? what was done? who still owes a reply?).

| Param | Default | Notes |
|---|---|---|
| `issue_id` | required | Readable ID, e.g. `ARD-123` |
| `comments_limit` | 50 (max 500) | Newest kept, still listed oldest first. `comments_truncated` / `comments_note` say when older ones were dropped |
| `include_images` | `true` | `false` gives a text-only result |
| `max_images` | 5 (max 10) | Over-cap images are listed as skipped in `images_note` |
| `image_names` | none | Only return these attachments by exact name, e.g. to fetch ones skipped by the cap |

- **Comments**: every non-deleted comment (paginated past YouTrack's default page size), each with `author` (login + full name), `created`/`created_at`, `updated`/`updated_at` (only when edited), `text`, its own `attachments` names, and `inline_images`.
- **Attachments**: from `/api/issues/{id}/attachments` (non-removed), each with `source`: `description`, `comment` (+ `comment_id`, `comment_index`), `older_comment_not_included` (comment cut by `comments_limit`), or `deleted_comment`. Each image's `image` field says whether it was returned, skipped (and why), or not requested.
- **Inline refs**: `![](image.png){width=70%}` in the description and comments is parsed into `description_inline_images` / `inline_images` and mapped to an attachment by name (exact, then case-insensitive, then URL basename). Unmapped refs have `attachment: null`.
- **Images as MCP image content blocks**: the result is a JSON text block, then for each image a short text label (`Image 1 of 2: image.png (attached to comment #4 by ...)`) followed by `{"type":"image","data":<base64>,"mimeType":...}`. Built with `toolOKContent` + `mcpTextBlock`/`mcpImageBlock` (`mcp.go`). `mcpResultSummary` (`mcp_dispatch.go`) handles both `[]map[string]string` and `[]map[string]interface{}` content and always logs the first text block, never base64.
- **Image sizing**: downloads go through the YouTrack client's own token (`Client.DownloadAttachment`, resolves the relative `url` against the instance host and refuses other hosts). PNG/JPEG/GIF over ~1MB or 1568px on the longest side are downscaled with a stdlib box filter and re-encoded as JPEG (`PrepareImageForLLM`). WebP has no stdlib decoder, so it's passed through only when already under 1MB. Anything that still doesn't fit is skipped and named in `images_note`.
- Images from comments outside `comments_limit` are skipped unless named in `image_names`.
- Files: `mcp_tool_get_youtrack_ticket.go` (schema + handler), `mcp_ticket_discussion.go` (payload/image helpers), `services/youtrack/issue_discussion.go` (comments/attachments/download/inline-ref parsing), `services/youtrack/attachment_images.go` (downscaling).
- The Slack bot's `get_ticket` tool (`slack_events_tools.go`) reuses `GetIssueDiscussion` but only appends the last 5 comments as compact text (author, time, 300 chars each, image embeds replaced with `[image: name]`). No images there, to keep the Groq context small.

### `search_youtrack_tickets` notes

- Resolves `assignee_login` from a display name via `get_developer_configs` first — YouTrack YQL rejects the whole query with a `400 invalid_query` error if `Assignee:` doesn't match a real login (not just an empty result), so the tool surfaces a hint to verify the login when that happens.
- `sprint_name` accepts the literal `"current"`/`"latest"` to resolve the active sprint via `GetLatestSprintName`.
- Always scopes to `project: <projectID>` plus whatever filters are given; YQL parts are ANDed by joining with spaces.
