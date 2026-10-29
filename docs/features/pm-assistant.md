# PM Assistant — AI Chat

## Overview

AI chat over YouTrack sprint data. Allows natural-language queries about tickets, assignees, blockers, and sprint health.

## Two-Step LLM Flow

1. Translate user query → YQL (YouTrack Query Language)
2. Fetch matching issues from YouTrack API
3. Respond with per-ticket context: bounce counts, overdue flags, state history

## Full Technical Reference

**Read [`backend/YQL.md`](../../backend/YQL.md) before modifying the PM Assistant.**

Covers:
- YQL syntax and supported fields
- Subsystem exclusion logic
- Analytics overrides
- Bounce detection algorithm
- Bot prompt file locations
- Model configuration (`AI_PROVIDER` env var)
- Known limitations

## AI Provider

Selected via `AI_PROVIDER` env var: `groq`, `openai`, or `gemini`. Bot prompts editable at runtime via the `bot_configs` table (Bot Config tab in UI).

## Key Files

- `backend/internal/handlers/ai.go` — chat handler
- `backend/internal/services/youtrack/` — YQL execution
- `frontend/src/components/assistant/` — PM Assistant UI (floating panel, mounted in `Dashboard.tsx`)

## UI: thinking orb + pill input

Redesigned around the 21st.dev "ai thinking orb and input" component (@anark17r). The original was a single-question widget with a 108px answer card, so it was adapted to a running thread:

1. **Idle**: faint turning orb, heading, 4 suggestion chips, glowing pill input.
2. **Ask**: a ball flies (WAAPI, appended to `<body>`) from the pill's send button to the orb slot in the thread; chips launch from the send button too.
3. **Think**: canvas dotted orb with 4 light patterns, labels rotate every 1150ms. **Esc** stops waiting (the request can't be cancelled; its reply is ignored via `reqRef`) and puts the question back in the input.
4. **Done**: green sweep + "Done", collapses into a green ball, then `onFinished` swaps the slot for the answer card, which unfolds with `clip-path` from the ball and reveals its blocks with a staggered blur.

| File | Role |
|---|---|
| `PMAssistant.tsx` | State + logic: sprint picker, `pmAssistantQuery` (via `pmDataService`, respects the active PM source), retry under 5s rate limits, friendly limit copy, `select_sprint` action |
| `ThinkingOrb.tsx` | Orb modes `idle` / `think` / `done`, flight, labels, done sequence |
| `orb-engine.ts` | Pure TS canvas orb + track tweener (radius is a parameter; dot and "done" colours resolved from `--text-primary` / `--color-success`) |
| `AssistantPill.tsx` | Pill input: rainbow rim, aurora, shake on empty submit, squeeze on send |
| `assistant-markdown.ts` | Markdown → HTML for answers + `SUGGESTED_QUERIES` |
| `styles/components/pm-assistant.css` | All `.pa-*` styles, light mode, reduced motion, mobile |

Gotchas:
- Answer body reuses the old markdown styles (`.pm-chat-assistant .pm-chat-content`) for tables/lists; its reset selector must outrank the old light-mode bubble rule in `pm-reports.css`, or the text gets a box behind it.
- The global light-mode `input` rule uses `!important`; `.pa-field` overrides it with `!important` to stay transparent.
- Hero centring uses `margin: auto`, not `justify-content: center`, which clips the orb when the panel is short.
- The rainbow rim/aurora colours are fixed hex on purpose (the component's signature); everything else uses theme tokens.

## MCP Server (Velocity connector)

`backend/internal/handlers/mcp.go` exposes Velocity's own tools over MCP for external AI clients (e.g. the claude.ai "Velocity" connector) — separate from the in-app PM Assistant chat above. Tool schemas live in the `mcpTools` var; handlers live in `callTool()`.

**YouTrack ticket tools:**
- `get_youtrack_ticket(issue_id)` — fetch a ticket by readable ID (e.g. `ARD-123`): summary, description, status, subsystem, priority, type, assignee, reporter, timestamps, attachments, URL. Read-only; call before editing a ticket or when asked what a ticket says.
- `create_youtrack_ticket`, `edit_youtrack_ticket`, `delete_youtrack_ticket`, `link_youtrack_tickets`
- `upload_youtrack_attachment`, `create_attachment_upload_url`

**Other tools:** `get_developer_configs`, `get_developer_load`, `get_sprints`, `queue_slack_message`.

When adding a new MCP tool, add its schema to `mcpTools` and its case to `callTool()`, then add a one-line entry here.
