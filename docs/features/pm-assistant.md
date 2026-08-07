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
- `frontend/src/pages/` — PM Assistant UI

## MCP Server (Velocity connector)

`backend/internal/handlers/mcp.go` exposes Velocity's own tools over MCP for external AI clients (e.g. the claude.ai "Velocity" connector) — separate from the in-app PM Assistant chat above. Tool schemas live in the `mcpTools` var; handlers live in `callTool()`.

**YouTrack ticket tools:**
- `get_youtrack_ticket(issue_id)` — fetch a ticket by readable ID (e.g. `ARD-123`): summary, description, status, subsystem, priority, type, assignee, reporter, timestamps, attachments, URL. Read-only; call before editing a ticket or when asked what a ticket says.
- `create_youtrack_ticket`, `edit_youtrack_ticket`, `delete_youtrack_ticket`, `link_youtrack_tickets`
- `upload_youtrack_attachment`, `create_attachment_upload_url`

**Other tools:** `get_developer_configs`, `get_developer_load`, `get_sprints`, `queue_slack_message`.

When adding a new MCP tool, add its schema to `mcpTools` and its case to `callTool()`, then add a one-line entry here.
