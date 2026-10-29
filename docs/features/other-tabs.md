# Other Tabs & Pages

## Calendar

`frontend/src/components/calendar/CalendarView.tsx` — date-range view of sprint issues. Use this component for any calendar/date-range display in the app, never build a new one.

## Reminders

Reminder creation and management. Backend polling started in `main.go` as a background job.

## Day Track (`DayTrackPage.tsx`)

Daily planner — log what you worked on, plan ahead for the next day. "Schedule For" dropdown and all other dropdowns use the `pm-custom-dropdown` portal pattern.

**Auto-entries from YouTrack** (`backend/internal/handlers/youtrack.go`, fired from the webhook handler on every `State` field change):
- QA verification — a ticket moved into `Ready for Stage` / `Ready for PROD` / `Verified` logs a "Verified on {env}" entry (category `Testing`) for whoever moved it. `testedEnvFromState` / `logYouTrackTestedToDayTrack`.
- Dev/hotfix completion — a ticket moved **directly from To Do/Backlog/In Progress** into `Dev` / `Stage` / `PROD` / `Mobile Done` logs a "Fixed on {env}" entry (category `Development`). `devEnvFromState` / `logYouTrackDevToDayTrack`.
  - **Scoped to subsystem owners only**: the mover must have at least one subsystem assigned in Developer Config (Integrations → Developers) — `moverOwnsSubsystem()`. A developer with no subsystem (e.g. a QA-only user) never gets these entries.
  - **Bulk release sweeps never trigger this**: because the origin state must be To Do/Backlog/In Progress, the routine `Ready for Stage → Stage` / `Ready for PROD → PROD` hop (bulk-deploying already-QA-verified tickets) never matches, regardless of how many tickets move together. Only a ticket that skips the QA gate — jumping straight from backlog/active into a deployed environment — counts as a hotfix.
  - Dedup key includes the issue, target env, and the minute (`yt-dev-{issueID}-{env}-{YYYYMMDDHHMM}`) — a ticket that bounces backward and is fixed again later (even later the same day) gets its own fresh entry; only true webhook redeliveries within the same minute collapse.
  - Requires the mover to have a Velocity login (`users.name` match) — a subsystem-owning developer with no Velocity account won't get an entry either; check server logs (`DayTrack dev log SKIPPED`) to tell the two skip reasons apart.

## Integrations (`IntegrationsPage.tsx`)

- **YouTrack setup**: base URL, project ID, board ID (fetched as dropdown via `api.getYouTrackBoards()`), permanent token (optional on update — backend reuses saved token if field is empty)
- **Asana setup**: PAT, workspace, project
- **Active PM Data Source**: switches the global data source between YouTrack and Asana — affects every PM feature
- **Column Hierarchy / Workflow Config**: defines column roles (`active`, `blocked`, `dev_done`, etc.) and priority tag mappings

CSS: `styles/pages/integrations.css`

## Settings

Access control management — whitelist entries, denied emails denylist. Admin-only.

## Admin

User management, role assignment.

## Reports

Deployment report builder — `frontend/src/components/deployment/` components. Lets you assemble a deployment report from completed tickets.

## Bot Config

Runtime editing of AI bot prompts stored in the `bot_configs` table. Changes take effect immediately without a redeploy.

## AI Analysis

Slack message analysis via the configured AI provider (Groq/OpenAI/Gemini).

## Slack

Slack integration management — bot token, channel selection.
