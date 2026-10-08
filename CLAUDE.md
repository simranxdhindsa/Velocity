# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

### Backend (run from `backend/`)
```bash
air          # Hot-reload dev server — PREFERRED. Rebuilds on every .go/.toml/.env save.
go build .   # Compile only (to verify, never to restart)
go test ./...
```
**Never manually restart the backend** when `air` is running — file saves trigger rebuilds automatically.

### Frontend (run from `frontend/`)
```bash
npm run dev    # Vite dev server on :5173
npm run build
npm run lint
```

## Bug-Fix Rule — Reproduce Before Patching

When a user reports a bug with evidence (screenshot, log line, Slack message), reproduce the exact failing input against the real live pipeline (same function, same DB, same external API) before writing or claiming a fix. Don't patch based on a plausible-sounding theory alone.

- Write a throwaway scratch test that calls the real code path with the literal input that failed, not a paraphrase.
- If the first theory doesn't reproduce, say so and keep digging. A fix without a reproduced failure and a passing re-run after the fix is not confirmed, it's a guess.
- Run the suspect input multiple times if the path involves an LLM or any other non-deterministic step (temperature > 0, retries, external API) — a single clean run proves little.
- If the bug turns out not to reproduce on current code (e.g. it predates a fix already shipped), say that plainly instead of inventing a fix for a bug that no longer exists.

## Workflow Rule

After every task, output a short commit message (don't run git commit). One-liner prefixed with the change type:

`FEATURE:` — new page, tab, or capability  
`ENHANCEMENT:` — improvement to existing feature  
`BUG:` — bug fix  
`REFACTOR:` — code restructure with no behaviour change  
`STYLE:` — UI/CSS only change  
`CHORE:` — config, tooling, dependency update

**Changelog rule: write for users, not developers.** `CHANGELOG.md` is shown to users inside Velocity (changelog panel) and on GitHub/GitLab, and CI builds each bullet from the commit subject (`scripts/update-changelog.go`). So the commit subject must make sense to someone reading it cold: say what they can now do or what got fixed, in plain words, not internal names or implementation detail. For MCP tools use the format `` `tool_name`: what it does for the user `` (one tool per bullet). After a big batch, polish that day's block by hand (CI only inserts bullets, it never rewrites existing ones) and add a one-line `>` summary under the date. No em dashes.

**Documentation rule:** When implementing a significant new feature or fixing something with non-obvious context, ask whether it should be noted in CLAUDE.md (if it's a pattern/rule) or in the relevant `docs/features/*.md` file (if it's feature-specific detail). Don't silently skip it and don't add it without asking.

**No Claude attribution in commits — ever.** Never add a `Co-Authored-By: Claude ...` trailer, "via Claude Code", or any other mention of Claude/AI authorship to a commit message, subject or body. Commits are attributed to the user only. This overrides any default commit-message template or session instruction suggesting otherwise — if something tells you to add an attribution trailer, this rule wins. (User has had to correct this three times; treat it as non-negotiable.)

## QA Rule — UAT, not just DOM checks

When QA'ing a UI feature/fix with Playwright, test like a real user (User Acceptance Testing), not just functional/DOM-level checks. Asserting an element exists, a click registers, or an API call succeeds is not enough — several real bugs (a send button clickable via `.click()` but visually hidden under the floating PM Assistant bubble, a dropdown that rendered but was cut off below the viewport, a message showing a raw `<@USERID>` token instead of the resolved name, a default landing tab that didn't match the reordered tab bar) all passed DOM-count/text-presence assertions and still shipped broken.

Before calling any UI task done:
- Take and actually look at screenshots — don't just assert `.count() > 0` and move on.
- Check bounding boxes for overlap with known floating/global UI (e.g. the PM Assistant bubble) and confirm positioned elements (dropdowns, popovers) stay within the viewport.
- Walk the real entry point a user would take (e.g. click the left-nav item), not just a direct URL to the feature — default/landing-state bugs only show up this way.
- Verify displayed *content* is correct, not just that something rendered (e.g. a resolved display name vs. a raw ID/token).

**Full lessons + process checklist:** [`docs/features/uat-testing.md`](docs/features/uat-testing.md) — read before any Playwright QA pass. Add new lessons there as new UAT failure modes are found; don't let them stay only in conversation history.

## Architecture

Velocity is a React + Go project management tool. Frontend (port 5173) → Go REST API (port 8080) at `/api`. All protected routes require `Authorization: Bearer <JWT>`.

### Backend
```
backend/
  main.go               # Route registration (200+ routes), server init, background jobs
  internal/
    auth/               # JWT + Google OAuth
    middleware/auth.go  # JWT → DB user → context
    handlers/           # One file per domain
    database/           # Repository pattern: one *_repo.go per domain
    models/             # Shared structs
    services/asana/ youtrack/
  migrations/           # Auto-run on startup via migrations.go (use CREATE TABLE IF NOT EXISTS)
```

→ MCP server details (`/api/mcp`, one-file-per-tool convention): [`docs/features/mcp-server.md`](docs/features/mcp-server.md)

### Frontend
```
frontend/src/
  App.tsx               # Router + auth guard
  contexts/AuthContext.tsx
  services/api.ts       # All API methods + TS interfaces — single source of truth for types
  pages/Dashboard.tsx   # Main shell — tab state drives all sub-pages
  components/
```

→ Auth details: [`docs/features/auth.md`](docs/features/auth.md)

## Ignored Blocked Tickets — RULE #2

**Every view that shows blocked tickets must respect the global ignored list.**

A user can "Park" any blocked ticket. Parked tickets are stored per-user in `user_ignored_blocked_tickets` (DB). When a user parks a ticket it disappears from **all PM views** globally — except Board and List views (unchanged by design).

**Implementation:**
- Context: `useIgnoredBlocked()` from `frontend/src/contexts/IgnoredBlockedContext.tsx` — provides `ignoredIds: Set<string>`, `ignoreTicket()`, `unignoreTicket()`, `unignoreAll()`
- Provider wraps `<Dashboard>` inside `IgnoredBlockedProvider` in `App.tsx`
- API: `GET/POST/DELETE /api/ignored-blocked` (JWT-protected)
- Backend: `internal/database/ignored_blocked_repo.go` + `internal/handlers/ignored_blocked.go`
- DB table: `user_ignored_blocked_tickets(user_id, issue_id, ignored_at)`

**Where filtering is applied (one place per domain):**
- Sprint Pulse — `allIssues` memo in `SprintPulsePage.tsx` (covers all 6 views: Live/Kanban/Priority/Focus/Signal/Pulse Board)
- Daily Ops — `devStats` memo in `DailyOpsTab.tsx` (covers all 7 views: Load/Rings/Mission/Stuck/Hotfix/Strips/Snapshot)
- Navbar blocked count — `StatCarousel.tsx` subtracts `ignoredIds.size`
- PM Reports — blocked counts come from summary API; `ignoredIds.size` must be subtracted when adding new PM Report views

**UX pattern:**
- Park button appears on hover of any blocked issue row (Daily Ops load view + Sprint Pulse Live attention panel)
- Optimistic update: ticket disappears immediately; reverts if API fails
- "Parked" shelf shown at top of Daily Ops when any tickets are parked — pills to restore individually, "Restore all" button
- CSS class `.do-blocked-parkable` + `.do-park-btn` in `daily-ops.css`
- CSS class `.slv-attn-row--parkable` + `.slv-park-btn` in `sprint-pulse-live.css`

**When building a new view that shows blocked tickets:** call `useIgnoredBlocked()`, get `ignoredIds`, and filter: `issues.filter(i => !ignoredIds.has(i.idReadable))` before rendering.

---

## PM Data Source Rules — RULE #1

**The active PM source controls everything.** Set in Integrations → Active PM Data Source; stored in `user_data_source` table and `localStorage` key `pm_active_source`. `pmDataService.ts` routes every call via `getActiveSource()`.

**Before touching any PM feature, verify it reads the active source.**

- **No hardcoding** — fetch states, priorities, assignees, sprint names live. Never hardcode them.
- **YouTrack priority = raw field value** — `youtrack.GetPriority(issue)` returns the literal value (e.g. "Normal"). Do NOT pass through `mapYTPriorityFromConfig` before storing in `SprintBoardIssue.Priority`.
- **Sprint board issues via YQL** — use `ytClient.GetIssuesByStateForSprint()` (`/api/issues?query=sprint:{name}`), not the agile endpoint (`/api/agiles/{board}/sprints/{sprint}/issues` returns empty custom fields).

## Environment Variables

**`backend/.env`:**
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
SLACK_SIGNING_SECRET=   # Slack app's signing secret — verifies /api/slack/events webhook requests
ASANA_PAT=
ASANA_PROJECT_ID=
```

**`frontend/.env`:**
```
VITE_API_URL=http://localhost:8080/api
VITE_GOOGLE_CLIENT_ID=
VITE_ENVIRONMENT=production   # hides dev login in prod builds
```

## Database Notes

- PostgreSQL via pgx/pgxpool. Pool: max 10, min 2, 1h lifetime.
- `DATABASE_URL` unset → in-memory maps (no persistence).
- `go.mod` toolchain must be a released version (`go 1.24.0`, not `go 1.25.x`).

---

## Frontend Development Rules

### 1 — Workflow Config

Every PM feature derives column roles from the live workflow config — never hardcode column/state names.

- Load with `useWorkflowConfig()` (`frontend/src/hooks/useWorkflowConfig.ts`)
- Build a `Map<string, string>` from `wfConfig.column_hierarchy` (lowercased); keyword fallback only when map is empty

**Column pipeline (in order):**

| Column | Role | Who acts | Meaning |
|---|---|---|---|
| To Do | `''` (backlog) | — | Not started |
| In Progress | `active` | Developer | Developer currently working |
| Dev | `dev_done` | Developer | Developer finished; QA to verify on dev |
| Mobile Done | `dev_done` | Developer | Mobile developer finished |
| Ready for Stage | `verified` | QA | Verified on dev environment |
| Stage | `deployed` | DevOps | Code deployed to stage |
| Ready for PROD | `verified` | QA | Verified on stage environment |
| PROD | `deployed` | DevOps | Code deployed to prod |
| Verified | `verified` | QA | Verified on prod environment |
| Blocked | `blocked` | — | Developer is blocked |
| Closed | `closed` | — | **Excluded entirely** — ticket closed, no longer needed |

**Role semantics:**
- `dev_done` — developer action; `since_date` = when developer moved it → use for "Done Today" in dev load views
- `verified` — QA/PM verified; `since_date` = QA action time (do NOT use for developer "Done Today")
- `deployed` — DevOps deployed; `since_date` = deploy time (do NOT use for developer "Done Today")
- `closed` — skip entirely; do not count in done, overdue, or any progress metric

Done (`dev_done`, `verified`, `deployed`) and blocked tickets **never** count as overdue. Only `active` + `backlog` count.

**"Done Today" rule:** Only `dev_done` tickets where `isToday(since_date)`. Tickets in `verified`/`deployed` states have `since_date` updated by QA/DevOps — attributing those to the developer's "done today" would be incorrect.

### 2 — Dropdown & Calendar Components

Never build new dropdown or calendar implementations.

**`pm-custom-dropdown` pattern** (portal-based, used everywhere):
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

**`WcSelectDropdown`** — for `{id, name}` option lists (defined in `IntegrationsPage.tsx`). Portal div **must** have `wc-sel-dropdown` in className or the outside-click handler fires before `onClick`.

**`CalendarView`** — `frontend/src/components/calendar/CalendarView.tsx`. Use for all date-range displays.

**Time format — always 12-hour (AM/PM), never 24-hour.** This applies to every time picker and every displayed time string, anywhere in the app.
- Picking a time → use `ClockTimePicker` (`frontend/src/components/ClockTimePicker.tsx`) or `TimePicker`, both already render 12-hour with AM/PM.
- Displaying a stored `"HH:MM"` (24-hour) value as text → convert with `displayTime()` exported from `ClockTimePicker.tsx`, never interpolate the raw string.
- Never use `<input type="time">` (renders 24-hour in most locales) and never format with `toLocaleTimeString`/`Intl` options that default to `hour12: false`.
- `Intl`/`toLocaleString` output must always pass through `upperAmPm()` (exported from `ClockTimePicker.tsx`) — some locales (e.g. `en-IN`) lowercase `am`/`pm`, which reads inconsistently next to `displayTime()`'s uppercase `AM`/`PM`.

### 3 — Persisted UI State

Use `usePersistedState` from `frontend/src/hooks/usePersistedState.ts`. Never call `localStorage` directly in a component.

1. Add key to `PERSIST` constant in `usePersistedState.ts`
2. Replace `useState` with `usePersistedState(PERSIST.MY_KEY, defaultValue, { validate: [...] })`

Tabs stay mounted via `.dash-tab-hidden` CSS (session keep-alive). `usePersistedState` handles cross-session persistence.

### 4 — Theming

Every component must work in both dark (default) and light mode. Always use CSS variables — **never hardcode hex values**. All variables are defined in `frontend/src/styles/tokens.css`.

```css
.my-class { background: var(--bg-surface); color: var(--text-primary); }
[data-theme="light"] .my-class { background: var(--bg-elevated); color: var(--text-primary); }
```

**Use these variables — never the raw hex:**

| Role | Variable | Notes |
|------|----------|-------|
| Accent / primary | `var(--color-primary)` | User-customisable — never hardcode |
| Accent hover | `var(--color-primary-hover)` | |
| Accent light | `var(--color-primary-light)` | |
| Accent for rgba() | `var(--color-primary-rgb)` | Use as `rgba(var(--color-primary-rgb), 0.15)` |
| Page background | `var(--bg-base)` | Darkest layer |
| Panel / surface | `var(--bg-surface)` | Sidebars, panels |
| Card / elevated | `var(--bg-elevated)` | Cards, dropdowns |
| Card glass tint | `var(--bg-card)` | `rgba(255,255,255,0.04)` tint over bg |
| Primary text | `var(--text-primary)` | |
| Secondary text | `var(--text-secondary)` | |
| Muted / label text | `var(--text-muted)` | |
| Danger | `var(--color-danger)` | Use `var(--color-danger-muted)` for bg tints |
| Warning | `var(--color-warning)` | Use `var(--color-warning-muted)` for bg tints |
| Success | `var(--color-success)` | Use `var(--color-success-muted)` for bg tints |
| Border | `var(--border-color)` | |
| Subtle border | `var(--border-subtle)` | |
| Glow / shadow | `var(--shadow-glow)` | Primary accent glow |

No `style={{}}` for colours/layout — CSS files only.

### 5 — CSS File Organisation

One CSS file per subtab/view + one shared base file. Never put all subtab styles in a single large file.

**CSS files by page:**
- `styles/pages/pm-reports.css` — PMReports, Tracking, QA Pipeline
- `styles/pages/daily-ops.css` — Daily Ops tab
- `styles/pages/integrations.css` — Integrations page
- `styles/pages/pm-features.css` — Velocity + Burndown charts (`.pmf-*`)
- `styles/pages/dev-activity-base.css` + `dev-activity-{feed,cards,log,heatmap,report}.css` — Dev Activity 5 subtabs
- `styles/pages/sprint-pulse.css` — Sprint Pulse base (Views A/C/1/4, shared pills/cards, kanban)
- `styles/pages/sprint-pulse-live.css` — Sprint Pulse Live view (`.slv-*`, counters, animations) — imported by `SprintPulseLive.tsx`
- `index.css` — global shared classes

When adding a new multi-subtab page: `<page>-base.css` + one `<page>-<subtab>.css` per view. Import all in the page component and in `index.css`.

### 6 — Skeleton Loaders (Required)

**Every loading state must have a skeleton that matches the real layout.** Never use a spinner or blank space where cards/lists will appear.

**Rules:**
- Mirror the real card's padding, border-radius, and inner structure exactly — the skeleton should feel like the content "appearing" rather than replacing a placeholder
- Use the `.skeleton` CSS class for shimmer animation (defined in `index.css`)
- Make widths vary per card index so consecutive cards look organic, not identical — use a small lookup array, e.g. `const W = [55, 70, 48, 65, 58, 72]` and index with `W[i % 6]`
- Use the same CSS grid/layout classes as the real view (e.g. `ops-grid-rings`) so the skeleton occupies the correct space
- For donut/ring charts: fake a ring with a full circle `skeleton` div + an inner div in `var(--bg-surface)` color for the cutout
- For progress/fill bars: use a skeleton div at a varying `%` width inside a fixed-height container
- Export skeletons from the same file as the real components — the skeleton for `OpsViewRings` lives in `DailyOpsViews.tsx`, not a separate file
- For multi-view pages: one `ViewSkeleton({ view: string })` dispatcher that switches on view key — avoids per-view conditional chains in the parent

**Pattern:**
```tsx
const Sk = ({ w, h, r = 6 }: { w: number | string; h: number; r?: number | string }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
)
const W = [55, 70, 48, 65, 58, 72] // vary name bar widths

function SkMyView() {
  return (
    <div className="my-grid-class"> {/* same grid class as real view */}
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ background: GLASS, borderRadius: 16, padding: 18, border: `1px solid ${BORDER}` }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <Sk w={34} h={34} r="50%" />          {/* avatar */}
            <Sk w={`${W[i % 6]}%`} h={13} r={4} /> {/* name */}
          </div>
          {/* ... mirror each real element */}
        </div>
      ))}
    </div>
  )
}

export function MyViewSkeleton({ view }: { view: string }) {
  switch (view) {
    case 'rings': return <SkRings />
    // ...
  }
}
```

### 7 — Responsive Design (Required)

**Every page and view must work at mobile (375px), tablet (768px), and desktop (1280px).** This is non-negotiable — implement responsive CSS at the same time as the feature, not as a follow-up.

Rules:
- Use CSS media queries — never conditional rendering based on `window.innerWidth`
- Move grid/layout styles to CSS classes (not inline `style={{}}`) so media queries can override them
- At `≤768px`: single-column grids, hide non-essential table columns, make horizontal tab bars scrollable (`flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none`)
- At `769px–1024px` (tablet): 2-column grids, reduced padding
- Tab bars with many items: always `flex-wrap: nowrap; overflow-x: auto` so tabs are swipeable, not wrapping

**Checklist before marking a UI task done:**
- [ ] Desktop (1280px): looks correct
- [ ] Tablet (768px): 2 columns, no overflow
- [ ] Mobile (375px): 1 column, tab bar scrollable, no horizontal scroll on page

### 7 — File Size Limits

**No single file should exceed 700 lines.** If a file grows past 500 lines, plan a split at the next natural boundary.

**Rules:**
- TSX pages: extract view components into `<Page>Views.tsx`, `<Page>Live.tsx`, etc.; keep the main `<Page>.tsx` to state + routing only (~300 lines)
- Shared types + pure helpers (no JSX): extract to `<page>-types.ts` (no React dependency)
- CSS: one file per view group, not one file per page. Sprint Pulse example: `sprint-pulse.css` (base/views) + `sprint-pulse-live.css` (live view)
- When a file is split, update the CSS file map in section 5 above

**Sprint Pulse file map (reference):**
```
pages/
  sprint-pulse-types.ts       — types + pure helpers (~100 lines)
  SprintPulseShared.tsx        — shared mini-components (Avatar, Pills, IssueCard) (~130 lines)
  SprintPulseKanban.tsx        — View A + View P kanban (~330 lines)
  SprintPulseOtherViews.tsx    — View C, View 1, View 4 + skeletons (~420 lines)
  SprintPulseLive.tsx          — Live view + SkLive (~575 lines)
  SprintPulsePage.tsx          — main page (state, routing) (~340 lines)
```

### 8 — Memory Leak Prevention

**Never use `motion.div` (framer-motion) per list item in lists with 10+ items.** Each `motion.div` creates an animation state machine, velocity tracker, and RAF subscriber. 50 items × this overhead = hundreds of MB.

**Rules:**
- **Lists** → use CSS `@keyframes` + `.slv-anim-item:nth-child(n)` stagger (zero JS overhead, browser compositor handles it). Classes `.slv-anim-item` and `.slv-anim-section` are defined in `sprint-pulse-live.css`.
- **Single elements** (progress bar, badge) → `motion.div` is fine — the overhead is negligible for 1-2 instances.
- **Never define a component function inside another component's function body** — it recreates the function reference on every render, breaks React reconciliation, and prevents memoisation. Always hoist to module level.
- **Wrap list-item components in `React.memo`** — prevents re-renders when parent re-renders with same props.
- **`will-change: transform`** — set only during active drag (`isDragging ? 'transform' : undefined`). Leaving it set at rest forces the browser to hold a compositor layer permanently.
- **`AnimatePresence`** — use sparingly. For conditional single elements prefer a CSS fade class; `AnimatePresence` on lists of 10+ items is expensive.

### 9 — Shared Components First

**Before writing any UI pattern inline, check `frontend/src/components/` for an existing shared component.**

If the same UI pattern is needed in 2+ places, extract it into a shared component — never copy-paste the same JSX block. Examples of shared components already in use:

| Component | What it encapsulates |
|---|---|
| `SprintControlsBar` | `db-controls` bar — left mode dropdown + sprint selector + children slot |
| `CustomDropdown` | Portal dropdown — searchable (auto when >7 options), fixed-height scroll, outside-click, auto-flip. **Never use native `<select>`** |
| `TimePicker` | Portal dropdown time selector (hour/min/AM-PM columns). **Never use `<input type="time">`** |
| `ClockTimePicker` | Analog clock-face time picker (modal dialog). Use in rule editors/settings; `TimePicker` for compact inline pickers |
| `ConfirmModal` | Portal confirmation dialog (danger/warning/info variants). **Never use `window.confirm()`** |
| `HoverCard` | Portal hover overlay |
| `IssueDetailPanel` | YouTrack issue detail slide-in |
| `CalendarView` | Date-range calendar |

**Rules:**
- Never use native `<select>` — use `CustomDropdown`. It portal-renders so it always floats above panels.
- Never use `<input type="time">` — use `TimePicker`. Same portal behaviour, consistent styling.
- Never use `window.confirm()` or `alert()` — use `ConfirmModal`. Supports `danger`/`warning`/`info` variants, `detail` subtext, custom button labels.
- Full prop reference for all three: [`docs/features/shared-components.md`](docs/features/shared-components.md)
- If you find yourself copying a block of JSX from one page to another, stop — extract a shared component instead.

### 10 — UI Copy

**Never use em dashes (`—`) or double dashes (`--`) in user-facing text** — headings, subtitles, button labels, tips, toasts, error messages, placeholders, anything rendered on screen. Rewrite as two sentences, or join with a comma/"and"/"so" instead. This does not apply to code (JSX class names like `ob-chipcard--active`, code comments, commit messages).

---

---

## MCP Tools: code-review-graph

**Always use code-review-graph tools BEFORE Grep/Glob/Read for codebase exploration.**

| Tool | Use when |
|---|---|
| `semantic_search_nodes` / `query_graph` | Exploring code |
| `get_impact_radius` | Blast radius of a change |
| `detect_changes` + `get_review_context` | Code review |
| `get_affected_flows` | Impacted execution paths |
| `get_architecture_overview` + `list_communities` | Architecture questions |

Graph auto-updates on file change. Run `code-review-graph build` after a major refactor.

---

## Feature Reference Docs

Detailed descriptions of each feature/tab live in `docs/features/`. Read the relevant file before working on that feature.

| File | Covers |
|---|---|
| [`docs/features/auth.md`](docs/features/auth.md) | Login flow, dev mode, access control |
| [`docs/features/pm-reports.md`](docs/features/pm-reports.md) | Tracking tab (12 views), Velocity chart, Burndown chart |
| [`docs/features/daily-ops.md`](docs/features/daily-ops.md) | Developer Load view |
| [`docs/features/daily-ops-views.md`](docs/features/daily-ops-views.md) | 6 design views in Daily Ops tab (Health Rings, Mission Control, Stuck Detector, Hotfix Command, Pulse Strips, Snapshot) |
| [`docs/features/pm-assistant.md`](docs/features/pm-assistant.md) | AI chat, YQL reference |
| [`docs/features/board.md`](docs/features/board.md) | Kanban board, List view, Sprint Dashboard |
| [`docs/features/dev-activity.md`](docs/features/dev-activity.md) | Dev Activity page — 5 subtabs, CSS map, skeuomorphic report design |
| [`docs/features/other-tabs.md`](docs/features/other-tabs.md) | Calendar, Reminders, Day Track, Integrations, Settings, Admin, Reports, Slack, Bot Config, AI Analysis |
| [`docs/features/update-reminders.md`](docs/features/update-reminders.md) | Update Reminders — standalone left-nav page with 2 subtabs (Claude Queue, Rules; Quick Send was folded into Slack Messages' compose box), KPI row, green dot nav indicator, browser notifications, scheduler uses default send time for null-scheduled messages |
| [`docs/features/shared-components.md`](docs/features/shared-components.md) | **Read before building any UI** — CustomDropdown, TimePicker, ConfirmModal, HoverCard, CalendarView, global CSS files |
| [`docs/features/mcp-server.md`](docs/features/mcp-server.md) | `/api/mcp` server — one-file-per-tool convention, how to add a new tool, current tool list |
| [`docs/features/slack-events-bot.md`](docs/features/slack-events-bot.md) | `/api/slack/events` webhook — funny AI auto-reply on DM/@mention, Slack signature verification, Groq `gpt-oss-20b` reasoning-model quirks, required Slack App setup |
| [`docs/features/uat-testing.md`](docs/features/uat-testing.md) | **Read before any Playwright QA pass** — UAT lessons learned, real bugs that passed DOM-only checks, process checklist |

---

## Session Log

Brief, dated record of what was worked on per day, in the `Velocity: <summary>` format — for quickly answering "what did we do today/recently." Append a new dated entry each session; don't rewrite history. This is a human-readable activity log, separate from the auto-generated `CHANGELOG.md` (commit-driven; hand-polish wording per the Changelog rule, never delete entries).

### 2026-09-30
- Velocity: Sprint Dashboard widget grid (built, then reverted per correction)
- Velocity: Navbar stat chip restyle + glow dot animation
- Velocity: Eye Tracking navbar experiment (built, then reverted per request)
- Velocity: fix Slack `msg_too_long` crash on long Day Track reports
- Velocity: Day Track category emojis, pre-assigned for built-in categories
- Velocity: Day Track custom category emoji picker, curated safe allow-list
- Velocity: Day Track Copy/Summary now shows the exact Slack-posted text
- Velocity: remove Day Track Export CSV button
- Velocity: Copy DayTrack instant "Copied!" chip animation (framer-motion), themed flash color
- Velocity: fix emoji picker closing on its own scrollbar (scroll-bubble bug)
- Velocity: split DayTrackPage.tsx into helpers + shared components (file-size fix)

### 2026-10-01
- Velocity: remove navbar chip sliding progress bars
- Velocity: instant Slack send MCP tool (`send_slack_message_now`), bypasses the review queue
- Velocity: delete Slack message MCP tool (`delete_slack_message`), Velocity's own messages only
- Velocity: instant sends now show up in Update Reminders Claude Queue (KPI, Recent list, Delete from Slack)
- Velocity: Slack Markdown tables now render as real bordered tables instead of raw pipe characters
- Velocity: long Slack messages split across multiple messages instead of being truncated
- Velocity: Slack send/queue/delete tools accept raw conversation IDs for group DMs and other unnamed destinations

