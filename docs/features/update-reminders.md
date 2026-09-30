# Update Reminders

Automated Slack-based reminder system and Claude message queue. PMs create rules that check who has/hasn't posted daily standup updates in Slack channels and fire reminder messages on a configurable schedule. Also hosts the Claude Queue (MCP-based message staging) and Quick Send (one-off Slack message tool).

## UI placement

**Standalone left-nav page** — `'update-reminders'` in the `Page` type in `Dashboard.tsx`. URL: `/update-reminders/:subtab`. Mounted as a keep-alive tab alongside all other main pages.

Previously this was a subtab inside the Slack page. It was promoted to a top-level nav entry to give it more space and to co-locate Claude Queue with the reminder workflow.

### Left-nav indicator
A green dot (`sidebar-nav-badge-dot`) appears on the Update Reminders nav item when Claude has queued new messages that the user hasn't seen yet. Polling runs every 30 s in `Dashboard.tsx`. The dot clears when the user visits the page (writes `ur_queue_last_seen_ts` to `localStorage`). Browser notification permission is requested on first visit.

### Subtabs
The page has three inner subtabs rendered via `ur-inner-tabs` / `ur-inner-tab` classes:

| Subtab key | Content |
|---|---|
| `claude-queue` | Claude Queue — MCP-staged messages from Claude.ai |
| `quick-send` | Quick Send — one-off channel/DM messages |
| `rules` | Reminder Rules — CRUD for automated rules |

URL pattern: `/update-reminders/claude-queue`, `/update-reminders/quick-send`, `/update-reminders/rules`. `Dashboard.tsx` reads `pathSegments[1]` as `updateRemindersSubTab` and passes it as `initialTab` to `<UpdateRemindersTab>`.

### KPI row
Three cards at the top of the page (`.ur-kpi-row` / `.ur-kpi-card`):
- **Queue** — pending Claude messages (clicks → `claude-queue` subtab)
- **Active Rules** — count of enabled rules
- **Sent Today** — messages sent today via Claude Queue

KPI data comes from `api.listQueuedMessages()` fetched on mount of `UpdateRemindersTab`.

## Features

### Rule CRUD
- Create / edit / delete / enable-disable reminder rules
- Each rule: name, schedule (time + days + timezone), source channels, detection mode, roster, leave handling, delivery targets, message templates
- Admin/ProjectManager can see and modify all rules; regular users only their own

### Schedule
- Fires at `HH:MM` in the rule's timezone (stored as `schedule_time` + `timezone` fields)
- Days-of-week bitmask stored as `schedule_days: []int` (0=Sun … 6=Sat)
- Scheduler checks every 60s; uses `firedToday["ur:"+ruleID]` key for double-fire prevention

### Detection modes
- `any_message` — any message from a roster member in the check window counts
- `keywords` — message must contain one of the comma-separated keywords
- `pattern` — message must match a regex

### Check window
- `check_day_offset`: 0=today, -1=yesterday, -2=2 days ago, etc.
- `check_window_start` / `check_window_end`: HH:MM 24h bounds within that day

### Roster
- Per-rule list of Slack members to track (`update_reminder_roster` table)
- Members can be individually enabled/disabled without removing them
- Added from workspace user search (fetched via `users.list` Slack API)

### Leave handling
- Optional leave channel: bot reads messages for leave keywords
- `leave_action: exclude` — on-leave members disappear from reminder entirely
- `leave_action: list_separately` — on-leave members listed under `{on_leave_names}` placeholder

### Dry run / Run now
- **Dry Run** — computes fresh snapshot, diffs against saved snapshot, returns rendered message; does NOT send
- **Run Now** — `force_snapshot: true` sends fresh computed state; `force_snapshot: false` sends saved snapshot
- If diff detected (someone posted since last snapshot), UI warns and lets user choose "Send Updated" or "Send Original Snapshot"

### Claude Queue
- Receives messages staged by Claude via the MCP `queue_slack_message` tool
- Also receives messages sent instantly via the MCP `send_slack_message_now` tool — these land in the same table already marked `sent` with `slack_ts` set, so they show up in the KPI counts and "Recent" list immediately and get the same "Delete from Slack" button as any other sent message. The MCP `delete_slack_message` tool deletes both the Slack message and this queue row together.
- Managed via `ClaudeQueueCard` component (`frontend/src/pages/ClaudeQueueCard.tsx`)
- Each queued message: channel (optional — user can pick inline), scheduled time, message text
- **Scheduled time priority**: if `scheduled_at` is set (by Claude or by the user's inline TimePicker), that time is used. If `scheduled_at IS NULL`, the backend scheduler picks it up when the user's `default_send_time` in `mcp_tokens` has passed for today.
- Default send time shown as `Default (HH:MM)` on cards with no explicit schedule
- Sent/failed messages shown in a "Recent" section (last 5)
- `ConnectionBar` sub-component manages the MCP connector URL and token lifecycle
- `autoOpen` prop: when rendered inside a subtab (`autoOpen={true}`), accordion starts open and header is hidden via `.ur-tab-inline .cq-header { display: none }`

### Quick Send
- Send a one-off message to any channel or DM any workspace member
- Session-only send history (last 20, stored in `PERSIST.QUICK_SEND_HISTORY`)
- History cards styled to match Claude Queue recent cards (`.ur-qs-history-item` uses card border/background)
- `autoOpen` prop same as Claude Queue

### Run history
- 30-day retention in `update_reminder_runs` table
- `expires_at` set on insert; nightly purge via `PurgeUpdateReminderRuns()` called from scheduler

## Backend

| File | Role |
|------|------|
| `backend/internal/models/update_reminder.go` | All structs: rule, snapshot, diff, roster member, run, requests |
| `backend/internal/database/update_reminder_repo.go` | CRUD for rules, roster, run history; `GetAllEnabledRules` for scheduler |
| `backend/internal/services/update_reminder/service.go` | `ComputeSnapshot`, `DiffSnapshot`, `RenderTemplate`, `Execute`, `ExecuteScheduled`, `QuickSend` |
| `backend/internal/handlers/update_reminder.go` | REST handlers; `ownerOrAdmin` helper |
| `backend/internal/services/scheduler/service.go` | `fireUpdateReminders()` called each tick; purge task |

## API routes

All under `/api/update-reminders` (JWT-protected):

```
GET    /api/update-reminders               — list rules (admin sees all)
POST   /api/update-reminders               — create rule
GET    /api/update-reminders/:id           — get rule
PUT    /api/update-reminders/:id           — update rule
DELETE /api/update-reminders/:id           — delete rule
PATCH  /api/update-reminders/:id/toggle    — enable/disable { enabled: bool }
GET    /api/update-reminders/:id/roster    — list roster members
POST   /api/update-reminders/:id/roster    — add member { display_name, slack_user_id, enabled }
PUT    /api/update-reminders/:id/roster/:mid   — update member { enabled?, display_name? }
DELETE /api/update-reminders/:id/roster/:mid   — remove member
POST   /api/update-reminders/:id/dry-run   — dry run (no send)
POST   /api/update-reminders/:id/run-now   — run { force_snapshot: bool }
GET    /api/update-reminders/:id/history   — last 30 days of runs
POST   /api/slack/quick-send              — { channel_id?, message, dm_user_id? }
GET    /api/slack/workspace-users         — paginated users.list from Slack
```

## DB tables

- `update_reminder_rules` — rule config (JSONB columns for arrays/objects)
- `update_reminder_roster` — per-rule member list (FK → rules ON DELETE CASCADE)
- `update_reminder_runs` — run history with `expires_at` for 30-day TTL

## Template placeholders

`{names}` · `{mentions}` · `{date}` · `{count}` · `{on_leave_names}`

## Frontend data access pattern

The backend returns **bare arrays/objects** (not `{ success, data }` wrappers). Always read `r` directly:

```ts
// CORRECT
const r = await api.listUpdateReminderRules()
if (Array.isArray(r)) setRules(r)

// WRONG — r.data is always undefined
if (r.data) setRules(r.data)
```

## CSS

`frontend/src/styles/pages/slack-update-reminders.css` — all `.ur-*` classes.

| Class group | Purpose |
|---|---|
| `.ur-kpi-row` / `.ur-kpi-card` | Three KPI stat cards at top of page |
| `.ur-inner-tabs` / `.ur-inner-tab` | Subtab bar (Claude Queue / Quick Send / Rules) |
| `.ur-tab-inline` | Wrapper that hides `.cq-header` accordion toggle — used when ClaudeQueueCard / QuickSendCard render as a full subtab instead of a collapsible card |
| `.ur-qs-history-item` | History cards for Quick Send — styled to match `.cq-msg-card` |
| `.ur-*` rule/roster/editor classes | Reminder rule CRUD |

`frontend/src/styles/layout.css` — `.sidebar-nav-icon-rel` + `.sidebar-nav-badge-dot` for the green dot on the nav item.

## Key implementation notes

- `UpdateRemindersTab` fetches its own Slack channels via `api.getSlackChannels()` when `channels` prop is not provided. This makes it self-contained when mounted from `Dashboard.tsx` (no Slack page to inherit channels from).
- The `autoOpen` prop on both `ClaudeQueueCard` and `QuickSendCard` initialises the accordion open so content is visible immediately when the card is embedded in a subtab.
- Dashboard polling: `unreadQueueCount` state + `notifiedQueueCountRef` in `Dashboard.tsx` compare new pending messages against `ur_queue_last_seen_ts` in `localStorage`. Notification fires once per "wave" of new messages (ref prevents repeated toasts for the same count).
