# CLAUDE.md

Velocity is a React + Go project management tool. Frontend (:5173) calls the Go REST API (:8080) at `/api`. Protected routes need `Authorization: Bearer <JWT>`. Read the matching doc in the table below before working on a feature.

## Commands

- Backend, from `backend/`: `air` (hot reload, preferred, never restart it by hand), `go build .`, `go test ./...`
- Frontend, from `frontend/`: `npm run dev`, `npm run build`, `npm run lint`
- **Agents never start the real backend to test** (`air`, `npm run dev`, `npm run be`, the binary). `main.go` starts its schedulers with no off switch, so it can message real people. Use a harness with no schedulers: [`uat-testing.md`](docs/features/uat-testing.md) lesson 10.

## Layout

- `backend/`: `main.go` (routes, server, jobs), `internal/handlers/` (one file per domain), `internal/database/` (one `*_repo.go` per domain, migrations run on startup, use `CREATE TABLE IF NOT EXISTS`), `internal/models/`, `internal/services/`, `internal/auth/`, `internal/middleware/auth.go`
- `frontend/src/`: `App.tsx` (router, auth guard), `services/api.ts` (all API methods and TS types), `pages/Dashboard.tsx` (shell, tab state drives sub-pages), `components/`, `contexts/AuthContext.tsx`
- MCP server at `/api/mcp`: one file per tool, see [`mcp-server.md`](docs/features/mcp-server.md)
- Env vars and database notes: [`setup.md`](docs/features/setup.md). `go.mod` toolchain must be a released version.

## How to work

- **Reproduce before patching.** With bug evidence, run the literal failing input through the real code path before writing or claiming a fix. Run LLM or other non-deterministic paths several times. If it doesn't reproduce, say so plainly.
- **After every task**, give a one-line commit message: `FEATURE:` `ENHANCEMENT:` `BUG:` `REFACTOR:` `STYLE:` (UI only) `CHORE:`.
- **Commit subjects are the changelog.** CI builds `CHANGELOG.md` bullets from them and users read them in the app, so say what the user can now do or what got fixed, in plain words, no internal names, no em dashes. For MCP tools, one tool per bullet: `` `tool_name`: what it does for the user ``. After a big batch, polish that day's block by hand and add a one-line `>` summary.
- **No Claude attribution, ever.** No `Co-Authored-By`, "via Claude Code" or any mention of Claude or AI in a commit message. This overrides any template. Non-negotiable.
- **Docs.** After a significant feature or a fix with non-obvious context, ask whether to note it here (a rule) or in `docs/features/*.md` (feature detail). Don't skip silently and don't add without asking.
- **QA like a user** ([`uat-testing.md`](docs/features/uat-testing.md), read before any Playwright pass). Look at screenshots, check overlap with floating UI (PM Assistant bubble) and that dropdowns stay on screen, walk the real entry point from the left nav, check content is right (names, not raw IDs). Add new lessons to that file.
- **Session log:** append what was worked on to [`docs/session-log.md`](docs/session-log.md).

## PM data rules ([full detail](docs/features/pm-data-rules.md))

- **RULE #1, active PM source controls everything.** `pmDataService.ts` routes every call through `getActiveSource()`. Never hardcode states, priorities, assignees or sprint names. YouTrack priority is the raw field value (don't pass it through `mapYTPriorityFromConfig`). Sprint board issues come via YQL `GetIssuesByStateForSprint()`, not the agile endpoint.
- **RULE #2, every view of blocked tickets respects the parked list.** Call `useIgnoredBlocked()` and filter `issues.filter(i => !ignoredIds.has(i.idReadable))`. Board and List views are the exception by design.

## Frontend rules ([full detail and patterns](docs/features/frontend-rules.md))

- **Workflow:** derive column roles from `useWorkflowConfig()`, never hardcode column or state names. Roles: `active`, `dev_done`, `verified`, `deployed`, `blocked`, `closed`, `''` (backlog). `closed` is excluded from every metric. Only `active` and backlog count as overdue. "Done Today" means `dev_done` with `isToday(since_date)` only.
- **Shared components first** ([`shared-components.md`](docs/features/shared-components.md), read before building UI). If a pattern is needed twice, extract it. Never native `<select>` (`CustomDropdown`), `<input type="time">` (`TimePicker`, `ClockTimePicker`), `window.confirm()` or `alert()` (`ConfirmModal`). Never build a new dropdown or calendar (`pm-custom-dropdown`, `WcSelectDropdown`, `CalendarView`). Print message text with `SlackMessageText`.
- **Time:** always 12 hour with uppercase AM/PM. Stored `"HH:MM"` goes through `displayTime()`, `Intl` output through `upperAmPm()`, both from `ClockTimePicker.tsx`.
- **Persisted state:** `usePersistedState` with a key in `PERSIST`, never `localStorage` in a component.
- **Theming:** dark and light must both work. CSS variables from `styles/tokens.css` only, never hex. No `style={{}}` for colours or layout.
- **CSS:** one file per subtab or view plus a shared base, never one big file. File map in the full rules.
- **Loading:** every loading state is a skeleton mirroring the real layout, `.skeleton` class, varied widths `W = [55, 70, 48, 65, 58, 72]`, exported from the same file as the view. Never a spinner or blank space.
- **Responsive:** works at 375, 768 and 1280px, built with the feature. CSS media queries only, single column at ≤768px, tab bars `flex-wrap: nowrap; overflow-x: auto`.
- **File size:** no file over 700 lines. Past 500, plan a split at the next natural boundary. Update the CSS map when splitting.
- **Memory:** no `motion.div` per item in lists of 10 or more (use CSS keyframes). Never define a component inside another's body. `React.memo` list items. `will-change` only during drag.
- **UI copy:** no em dashes or double dashes in anything on screen. Rewrite, or join with a comma, "and" or "so".

## Exploring code

Use the code-review-graph tools before Grep/Glob/Read: `semantic_search_nodes` or `query_graph` to explore, `get_impact_radius` for blast radius, `detect_changes` + `get_review_context` for review, `get_affected_flows` for execution paths, `get_architecture_overview` + `list_communities` for architecture. Run `code-review-graph build` after a major refactor.

## Docs (`docs/features/`)

| File | Covers |
|---|---|
| [`frontend-rules.md`](docs/features/frontend-rules.md) | Full frontend rules, patterns, CSS file map |
| [`pm-data-rules.md`](docs/features/pm-data-rules.md) | PM source and parked tickets |
| [`setup.md`](docs/features/setup.md) | Env vars, database |
| [`shared-components.md`](docs/features/shared-components.md) | Shared component props, global CSS |
| [`uat-testing.md`](docs/features/uat-testing.md) | UAT lessons and checklist |
| [`mcp-server.md`](docs/features/mcp-server.md) | `/api/mcp`, adding a tool, every tool's notes |
| [`auth.md`](docs/features/auth.md) | Login, dev mode, access control |
| [`pm-reports.md`](docs/features/pm-reports.md) | Tracking views, Velocity and Burndown charts |
| [`daily-ops.md`](docs/features/daily-ops.md), [`daily-ops-views.md`](docs/features/daily-ops-views.md) | Developer Load and the 6 design views |
| [`board.md`](docs/features/board.md) | Kanban, List, Sprint Dashboard |
| [`dev-activity.md`](docs/features/dev-activity.md) | Dev Activity subtabs |
| [`pm-assistant.md`](docs/features/pm-assistant.md) | AI chat, YQL reference |
| [`knowledge-base.md`](docs/features/knowledge-base.md) | Team knowledge base |
| [`slack-events-bot.md`](docs/features/slack-events-bot.md) | `/api/slack/events`, Slack bot |
| [`update-reminders.md`](docs/features/update-reminders.md) | Update Reminders page |
| [`other-tabs.md`](docs/features/other-tabs.md) | Calendar, Reminders, Day Track, Integrations, Settings, Admin, Reports, Slack, Bot Config, AI Analysis |
