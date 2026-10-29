# Slack Events Bot (Funny Auto-Reply)

## What it is

Velocity listens for inbound Slack events (1:1 DMs to the bot, and @mentions in channels) via Slack's Events API, and replies with a short, witty, AI-generated response via Groq — not a serious PM assistant reply, just a fun auto-responder.

## Endpoint

`POST /api/slack/events` — public (not JWT-protected), registered in `main.go` next to the Asana/YouTrack webhooks. Authenticated by Slack's own request-signing scheme instead: `X-Slack-Signature` / `X-Slack-Request-Timestamp` headers, verified against `SLACK_SIGNING_SECRET` (HMAC-SHA256 of `v0:{timestamp}:{raw body}`, with a 5-minute replay window). A request with a missing/wrong signature, or a stale timestamp, is rejected before any event handling runs.

Handler: `internal/handlers/slack_events.go` (`SlackEventsHandler.Handle`).

## Flow

1. Slack POSTs an event envelope. `type: "url_verification"` (one-time handshake when configuring the Request URL in Slack's app settings) is answered by echoing back the `challenge` field.
2. For `type: "event_callback"`, Velocity acks with `200 OK` immediately (Slack requires a response within 3s and retries aggressively on timeout, which would otherwise cause duplicate replies), then handles the event in a goroutine.
3. Only `message` events with `channel_type: "im"` (a real 1:1 DM) or `app_mention` events are handled. Anything with `bot_id` set, `subtype: "bot_message"`, or no `user` is ignored — this is what stops Velocity from replying to its own messages and looping forever.
4. The bot token to reply with is resolved via `IntegrationRepository.GetSlackIntegrationByTeamID(teamID)` — Velocity's Slack integration is stored per-Velocity-user, but everyone in a workspace pastes the same bot token, so any one connected row for that `team_id` works as "the" credential for a workspace-wide inbound event (which has no Velocity user context of its own).
5. `slackReplyPrompt(ctx, botRepo)` fetches the persona/system prompt from `bot_configs` (see "Configurable persona" below), the conversation context is built (see below), then `groqFunnyReply(ctx, systemPrompt, history, userText, actor)` calls Groq (`openai/gpt-oss-20b`) and posts the reply back — a DM gets a plain reply, an `app_mention` gets a thread reply (so it doesn't spam the channel).

## Conversation memory (`slack_bot_context.go`)

The bot used to answer every message in isolation. Now, before each reply, `buildSlackBotContext` re-reads the conversation from Slack and replays it to the model as prior turns. Slack is the memory, nothing is stored on our side.

- **Thread reply** (DM or channel): the whole thread via `conversations.replies`. Root plus the newest 29 replies are kept.
- **DM, not in a thread**: the last 6 messages always (however old), plus any others from the 6 hours before the message being answered. When the previous message is older than 6 hours, a note tells the model how long ago it was. Measured live: with a time window alone, "what is this" three days after a "New ticket assigned to you: ARD-3033" DM got no history and a clueless reply.
- **Fresh @mention in a channel**: no history on purpose (no unrelated channel chatter in replies).
- Own messages are matched by `BotIdentity` (auth.test `user_id`/`bot_id`, cached per token) and become `assistant` turns; humans and other apps become `user` turns (prefixed with the author name outside DMs).
- Budget: ~12k chars of history, newest first, thread root always kept (cap 3k chars), 1.5k per message.
- **Origin note**: for the bot message being discussed (thread root, or the bot's latest DM message), `database.FindSlackMessageOrigin` checks `pending_slack_messages` (Claude Queue and instant MCP sends, including DMs, which store no channel) and `sent_slack_messages`, and the system prompt says e.g. "sent through Claude on behalf of Simran". Ticket IDs in it are listed with an instruction to `get_ticket` them.
- **Thread frame**: in a thread, a short "(Context: this message is a reply in a thread that X started with ...)" is prepended to the incoming message itself, not the system prompt. Tested live: `gpt-oss-20b` weighs the last turn far more than system text, and with the note only in the system prompt it kept roasting "what is this?" as vague.
- The context section also overrides the persona's "roast vague messages" rule for follow-ups that have context.
- Every fetch failure (missing `im:history`/`channels:history` scope, timeout of 8s) degrades to the old single-message behaviour.
- A DM reply inside a thread is now posted into that thread.

## Team knowledge base

Each reply also searches the admin knowledge base with the incoming message (`slack_bot_kb.go`) and adds matching excerpts to the system prompt as reference data, plus a `search_knowledge_base` bot tool. Answers are the same for everyone. Details: [`knowledge-base.md`](knowledge-base.md).

## Configurable persona (not hardcoded)

The system prompt is a `bot_configs` row (`bot_type = 'slack_reply'`), reusing the same generic bot-config system that already powers Daily Report/Stage Report/Ticket Parser etc. — not a string constant in Go. Seeded once by a migration in `migrations.go` (`WHERE NOT EXISTS (SELECT 1 FROM bot_configs WHERE bot_type = 'slack_reply')`, same pattern every other bot type uses), then read fresh on every reply via `slackReplyPrompt()` (`slack_events.go`), so an edit takes effect on the very next DM/mention with no redeploy or restart.

Editable two ways:
- **Via MCP** (`get_slack_reply_config` / `update_slack_reply_config`, `mcp_tool_slack_reply_config.go`) — e.g. "make Velocity's Slack replies more sarcastic" from Claude.
- **Via the existing Bot Config UI** in PM Assistant, the same place Daily Report/Stage Report/etc. prompts are edited — this type needed no new UI.

`defaultSlackReplyPrompt` in `slack_events.go` is only a fallback for when the DB is unreachable or the row is somehow missing; it is not the source of truth once the migration has seeded the real row.

## Groq model notes

- Uses `openai/gpt-oss-20b`, not `llama-3.3-70b-versatile` (the model the existing `callGroqChat` helper in `daytrack_handler.go` hardcodes) — that model has been deprecated and removed from Groq's model list entirely, confirmed live via `GET /v1/models`. **This means DayTrack's existing AI summary feature is currently broken in production too** — a pre-existing issue discovered while building this, not something this feature introduced. Worth a separate fix.
- `gpt-oss-20b` is a reasoning model: it spends tokens on an internal `reasoning` field before writing the user-facing `content`, and `content` comes back empty if `max_tokens` runs out first (confirmed live — a too-low budget left `reasoning_tokens: 148, content: ""`, `finish_reason: "length"`). Fixed with `reasoning_effort: "low"` + `max_tokens: 300`, which reliably leaves room for the actual reply.
- `sanitizeDashes()` strips em dashes/en dashes/double-dashes from the model's output as a hard guarantee of CLAUDE.md's "no em dashes in user-facing text" rule — confirmed live that the system prompt instruction alone isn't reliably followed by the model (it generated `—` despite being told not to).

## Required setup (Slack App config — not fixable in code)

This feature needs manual configuration on the Slack App itself before it works, by whoever administers it in your workspace:

1. **OAuth scopes** — the bot token currently lacks `im:write` (needed to open/reply to a DM) and `mpim:write` (group DMs); likely also needs `im:history` (to receive `message.im` events) and `app_mentions:read` (to receive `app_mention` events). Add these under **OAuth & Permissions → Bot Token Scopes**, then **reinstall the app to the workspace** (required for new scopes to take effect — this generates a new bot token, which then needs to be re-pasted into Velocity → Integrations → Slack).
2. **Event Subscriptions** — enable it, set the Request URL to `https://<your-deployed-host>/api/slack/events` (Slack verifies this via the `url_verification` handshake at save time, so the endpoint must already be deployed and reachable), and subscribe to the bot events `message.im` and `app_mention`.
3. **`SLACK_SIGNING_SECRET`** env var — from the Slack app's **Basic Information → App Credentials → Signing Secret**.

## Known limitation

Because all Velocity users in one workspace share a single bot token, this feature is workspace-scoped, not per-Velocity-user — it replies with the same "funny Velocity" persona regardless of who DMs the bot or which Velocity user's row `GetSlackIntegrationByTeamID` happens to pick.
