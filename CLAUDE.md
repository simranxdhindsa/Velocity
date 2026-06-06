# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend (run from `backend/`)
```bash
air                # Hot-reload dev server — rebuilds on every .go/.toml/.env change (PREFERRED)
go run .           # One-shot start without hot reload
go build .         # Compile binary only
go test ./...      # Run all tests
```

**Hot reload:** `air` is installed and configured via `backend/.air.toml`. It watches all `.go`, `.toml`, and `.env` files and auto-rebuilds/restarts the server. **Do NOT manually restart the backend** when `air` is already running — file saves trigger rebuilds automatically. Only run `go build .` to verify compilation, never to restart.

### Frontend (run from `frontend/`)
```bash
npm run dev        # Start Vite dev server on :5173
npm run build      # Production build
npm run lint       # ESLint
```

The backend loads `backend/.env` automatically on startup via `godotenv`.

## Workflow Rule

After every task, output a short commit message (don't run git commit). Keep it plain — no prefixes required, just describe what changed clearly in one line.

## Architecture Overview

Velocity is a React + Go project management tool. Frontend (port 5173) talks to a Go REST API (port 8080) at `http://localhost:8080/api`. All protected routes require `Authorization: Bearer <JWT>`.

### Backend Structure

```
backend/
  main.go                         # Route registration (200+ routes), server init, background jobs
  internal/
    auth/                         # JWT generation/validation, Google OAuth
    middleware/auth.go            # JWT extraction → DB user lookup → context injection
    handlers/                     # One file per feature domain (tasks, asana, youtrack, slack, ai, ...)
    database/                     # Repository pattern: one *_repo.go per domain
    models/                       # Shared structs
    services/asana/ youtrack/     # Business logic for external API integrations
  migrations/                     # SQL files run automatically on startup via migrations.go
```

**Key pattern**: Handlers call repositories directly — no service layer for most features. Repositories use a global pgxpool (`database.GetPool()`).

**Auto-migrations**: `internal/database/migrations.go` runs all DDL on startup. Add new tables there — use `CREATE TABLE IF NOT EXISTS`.

**Background jobs** (started in `main.go`): mid-day/evening blocker detection, daily cleanup (deletes notifications + activity logs older than 30 days), reminder polling.

**Real-time**: SSE hub in `handlers/sse_hub.go` broadcasts events to connected clients.

**AI**: Groq, OpenAI, or Gemini — selected via `AI_PROVIDER` env var. Bot prompts editable at runtime via `bot_configs` table.

### Frontend Structure

```
frontend/src/
  App.tsx                         # Router + auth guard
  contexts/AuthContext.tsx        # Auth state, token storage, 12h refresh interval
  services/api.ts                 # All API methods + TypeScript interfaces (single source of truth for types)
  pages/Dashboard.tsx             # Main shell — renders all sub-pages via tab state
  components/                     # Feature components (kanban, reports, integrations, etc.)
```

All API calls go through `api.ts`, which injects the JWT from localStorage automatically.

### Authentication Flow

1. Google Sign-In → `POST /api/auth/google` with credential (ID token)
2. Backend validates with Google, checks denylist then whitelist, creates/fetches user in DB
3. Returns JWT (24h default, 30d if `remember_me: true`)
4. Middleware on every request: validates JWT → looks up user by **email** in DB → puts DB user in context

The middleware resolves by email (not JWT user_id) to handle in-memory UUID mismatches. If the user doesn't exist in DB yet, middleware auto-creates them.

**Dev mode**: Any token starting with `dev-mode-token-` bypasses JWT validation and uses hardcoded admin (`simranjot@apyhub.com`, ID `08938fa6-27b4-446f-a9aa-b8fe5c7b97c4`). This ID must exist in the `users` table.

**Access control**: `simranjot@apyhub.com` is always admin. Domain `@apyhub.com` grants `member` role. Configurable via `whitelist` table. Blocked emails in `denied_emails` table are rejected before the whitelist check — blocked users get a specific error message, non-whitelisted get "not authorised". The `AuthContext` catches 403 errors and sets `accessDenied` state; `App.tsx` renders `NoAccessPage` when that's true.

### PM Data Sources (Dual-Tracker Design) — RULE #1

**The active PM source controls EVERYTHING.** When the user sets their active source in Integrations → Active PM Data Source:

- All data is fetched from that source only — boards, kanban, PM reports, tracking, daily ops, activity feed, calendar, etc.
- All configuration comes from that source — workflow config, priority tags, column hierarchy, open/blocked states, done role.
- Switching source immediately changes all of the above — no mixing of YouTrack data with Asana config.

Active source is stored in `user_data_source` table (backend) and `localStorage` key `pm_active_source` (frontend). The service layer (`pmDataService.ts`) routes every call to the correct API via `getActiveSource()`. **Before building or modifying any PM feature, verify it reads the active source.**

Users can switch between **YouTrack** and **Asana**. Both use separate route namespaces: `/api/youtrack/*` and `/api/asana/pm/*`.

**RULE — No hardcoding of domain data.** Every feature must fetch states, priorities, assignees, sprint names, and any other project data live from the active PM source. Never hardcode these values in backend or frontend code.

## Environment Variables

**Backend** (`backend/.env`):
```
DATABASE_URL=postgresql://...
JWT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:5173/auth/callback
FRONTEND_URL=http://localhost:5173
PORT=8080
AI_PROVIDER=groq          # or openai, gemini
GROQ_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
SLACK_BOT_TOKEN=
ASANA_PAT=                # fallback if user hasn't connected Asana via UI
ASANA_PROJECT_ID=
```

**Frontend** (`frontend/.env`):
```
VITE_API_URL=http://localhost:8080/api
VITE_GOOGLE_CLIENT_ID=    # must match backend GOOGLE_CLIENT_ID
```

## Database Notes

- PostgreSQL via pgx/pgxpool. Connection pool: max 10, min 2, 1h max lifetime.
- If `DATABASE_URL` is unset, app runs with in-memory maps (limited persistence).
- The `go.mod` toolchain version must match an **actually released** Go version — `go 1.25.x` does not exist, use `go 1.24.0` or lower.
- Windows: Windows Defender may corrupt module cache downloads. Add `C:\Users\<user>\go\pkg\mod` to Defender exclusions if you see `unexpected NUL in input` errors.

---

## Frontend Development Rules

### 1 — Always follow the Workflow Config

Every PM feature must derive its column classification, roles, and thresholds from the live workflow config — **never hardcode column or state names**.

- Load with `useWorkflowConfig()` hook (`frontend/src/hooks/useWorkflowConfig.ts`)
- Column role lookup: build a `Map<string, string>` from `wfConfig.column_hierarchy` (state + all aliases, lowercased); fall back to keyword heuristics only when the map is empty

| Role | Meaning |
|---|---|
| `active` | In Progress |
| `blocked` | Blocked — dev can't act |
| `dev_done` | Done / DEV |
| `verified` | Ready for Stage or Prod |
| `deployed` | Deployed |
| `closed` | Fully resolved |
| `backlog` / `''` | To Do / Queued |

- Done tickets (`dev_done`, `verified`, `deployed`, `closed`) must **never** show overdue
- Blocked tickets must **never** count as overdue
- Only `active` and `backlog` tickets count toward a developer's overdue metric

### 2 — Use the Established Dropdown and Calendar Components

Do not build new dropdown or calendar implementations.

**`pm-custom-dropdown` pattern** — used in `PMReportsPage.tsx`, `BoardPage.tsx`, `DayTrackPage.tsx`, etc.
```tsx
<div className="pm-custom-dropdown" ref={myRef}>
  <button className="pm-custom-dropdown-trigger" onClick={() => setOpen(o => !o)}>
    {label} <ChevronDown size={12} />
  </button>
  {open && (
    <div className="pm-custom-dropdown-menu">
      {options.map(opt => (
        <div key={opt} className="pm-custom-dropdown-item" onClick={() => { setValue(opt); setOpen(false) }}>
          {opt}
        </div>
      ))}
    </div>
  )}
</div>
```

**`WcSelectDropdown` component** — defined in `IntegrationsPage.tsx`. Portal-based; the portal div **must** have `wc-sel-dropdown` in its className — without it, the global mousedown outside-click handler closes the menu before the option's `onClick` fires.

**`CalendarView` component** — `frontend/src/components/calendar/CalendarView.tsx`. Use this for any date-range or calendar display.

### 3 — Persisted UI State

Any UI state that should survive a page refresh or new browser tab **must** use `usePersistedState` from `frontend/src/hooks/usePersistedState.ts`. Never call `localStorage.setItem/getItem` directly in a component.

**Adding a new persisted value — two steps:**

1. Add the key to the `PERSIST` constant in `usePersistedState.ts`:
   ```ts
   export const PERSIST = {
     LAST_PAGE:     'velocity_last_page',  // main tab
     TRACKING_VIEW: 'pm_tracking_view',    // PM Reports 10-view selector
     SPRINT_ID:     'pm_active_sprint_id',
     ...
     MY_NEW_KEY:    'my_feature_key',      // ← add here
   }
   ```

2. Replace `useState` with `usePersistedState`:
   ```ts
   // Before
   const [mode, setMode] = useState<Mode>('default')

   // After
   const [mode, setMode] = usePersistedState(PERSIST.MY_NEW_KEY, 'default', {
     validate: ['default', 'other'],  // optional — rejects unknown stored values
   })
   ```

**Currently persisted:**
| Key | What it stores | Used in |
|-----|---------------|---------|
| `velocity_last_page` | Last main Dashboard tab visited | `Dashboard.tsx` |
| `pm_tracking_view` | Last of 10 tracking views selected | `PMReportsPage.tsx` |
| `pm_active_sprint_id` | Active sprint ID | `PMReportsPage`, `DailyOpsTab` |
| `pm_active_sprint_name` | Active sprint name | same |
| `theme` | Dark/light mode | `Dashboard.tsx` |

**Tab keep-alive (related):** Tabs are kept mounted via `.dash-tab-hidden` CSS in `Dashboard.tsx`. This preserves local component state within a session. `usePersistedState` handles cross-session persistence. Together they ensure no stale UI on tab switch or refresh.

### 4 — Light Mode and Dark Mode

**Every frontend component must be fully theme-aware.** All colors, backgrounds, borders, shadows, and text MUST use CSS variables or `[data-theme="light"]` overrides — never hardcoded hex/rgba that only works in one theme. Verify both themes before marking any UI task complete.

**Pattern:**
```css
/* Dark mode (default) */
.my-class {
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.8);
  border: 1px solid rgba(255,255,255,0.1);
}

[data-theme="light"] .my-class {
  background: rgba(241,245,249,0.9);
  color: #1e293b;
  border: 1px solid rgba(99,102,241,0.15);
}
```

Light-mode values to use consistently:
- Surface: `rgba(241,245,249,0.9)` / `#ffffff`
- Primary text: `#1e293b` / `#0f172a`
- Secondary text: `#475569` / `#64748b`
- Muted: `#94a3b8`
- Border: `rgba(99,102,241,0.12)–rgba(99,102,241,0.2)`
- Accent: `#4f46e5` / `#6366f1`
- Danger: `#dc2626` / `#ef4444`
- Warning: `#d97706` · Success: `#16a34a`

**No inline `style={{}}`** except truly dynamic values (e.g. `width: ${pct}%`). All colours and layout go in CSS files.

CSS files per feature:
- `styles/pages/pm-reports.css` — PMReports, Tracking, QA Pipeline
- `styles/pages/daily-ops.css` — Daily Ops tab
- `styles/pages/integrations.css` — Integrations page
- `index.css` — global shared classes

---

## Features Overview

### Tracking Tab (`PMReportsPage.tsx` — `TrackingTab`)
View modes: By Column, By Assignee, Swimlane, Sidebar, Heatmap, Delay Bars, Alert First, Split Pane, Focus Mode, QA Pipeline.

### Daily Ops Tab
Single Developer Load view — per-developer cards with sprint progress, stat chips (done/active/blocked/bounced/overdue/hours), active and blocked issue lists.

### PM Assistant
AI chat over YouTrack sprint data. Uses a two-step LLM flow: (1) translate user query to YQL, (2) fetch issues, (3) respond with per-ticket context including bounce counts and overdue flags.

**Full technical reference: [`backend/YQL.md`](backend/YQL.md)** — covers YQL syntax, subsystem exclusion logic, analytics overrides, bounce detection, bot prompt locations, model config, and known limitations. Read this file before modifying the PM Assistant.

### Board & List Views
Kanban board (`BoardPage.tsx`) and flat list (`ListViewPage.tsx`) — both driven by the active PM source.

### Other Tabs
Calendar, Activity Feed, Reminders, Day Track, Integrations (column hierarchy + workflow config), Settings (access control + denylist), Admin, Reports, Bot Config, AI Analysis, Slack.

---

## MCP Tools: code-review-graph

**IMPORTANT: ALWAYS use code-review-graph MCP tools BEFORE Grep/Glob/Read to explore the codebase.** The graph is faster, cheaper, and gives structural context (callers, dependents, test coverage) that file scanning cannot.

| Tool | Use when |
|------|----------|
| `semantic_search_nodes` / `query_graph` | Exploring code instead of Grep |
| `get_impact_radius` | Understanding blast radius of a change |
| `detect_changes` + `get_review_context` | Code review |
| `get_affected_flows` | Finding impacted execution paths |
| `get_architecture_overview` + `list_communities` | Architecture questions |

The graph auto-updates on every file change via PostToolUse hook. Run `code-review-graph build` manually after adding a new feature or major refactor.
