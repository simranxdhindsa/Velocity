# PM Data Rules

Full detail behind RULE #1 and RULE #2 in `CLAUDE.md`. Read before touching any PM feature or any view that shows blocked tickets.

## Ignored Blocked Tickets (RULE #2)

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

## PM Data Source (RULE #1)

**The active PM source controls everything.** Set in Integrations → Active PM Data Source; stored in `user_data_source` table and `localStorage` key `pm_active_source`. `pmDataService.ts` routes every call via `getActiveSource()`.

**Before touching any PM feature, verify it reads the active source.**

- **No hardcoding** — fetch states, priorities, assignees, sprint names live. Never hardcode them.
- **YouTrack priority = raw field value** — `youtrack.GetPriority(issue)` returns the literal value (e.g. "Normal"). Do NOT pass through `mapYTPriorityFromConfig` before storing in `SprintBoardIssue.Priority`.
- **Sprint board issues via YQL** — use `ytClient.GetIssuesByStateForSprint()` (`/api/issues?query=sprint:{name}`), not the agile endpoint (`/api/agiles/{board}/sprints/{sprint}/issues` returns empty custom fields).
