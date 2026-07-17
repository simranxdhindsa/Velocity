# Changelog

## 2026-07-17

### Enhancements
- Complete light-mode overrides for 502 page — orbit rings, particles, scanner, brand text
- 502 page — full redesign with orbital rings, particles, shimmer scanner, global detection via DOM event, unlimited 2s retry
- Global 502 detection via DOM event + unlimited 2s retry + Framer Motion animations on 502 page
- ClockTimePicker — real-time drag with pointer capture, framer-motion spring animation on hand and thumb, display numbers animate on change
- Replace TimePicker with ClockTimePicker in Claude Queue card (default send time + inline message time pickers)
- MCP connector URL always visible — auto-generate on first open, store plain token in localStorage, remove Regenerate, show Generate only when revoked


### Features
- ClockTimePicker — analog clock-face time selector component, used in Update Reminders rule editor

### Bug Fixes
- Fix @user placeholder and raw channel ID in My Threads — resolve mentions + store channel_name
- Allow members to use Slack scan + label Fetch panel as Test Connection
- Allow members to set their own Slack channel — move SetChannel + SetMonitorChannel to any-auth routes
- fix 5 QA issues in Update Reminders + Claude Queue scheduler

## 2026-07-16

### Enhancements
- MCP connector URL always visible — auto-generate on first open, store plain token in localStorage, remove Regenerate, show Generate only when revoked
- Make Quick Send history consistent with Claude Queue cards; send unscheduled messages at user's default time
- Claude Queue UX — delete confirmation, Slack delete, Quick Send consistency, always-show history
- Make scheduled time on queue card clickable — inline TimePicker saves immediately without entering full edit mode
- Fetch user display name from DB in DayTrack Slack post (no re-login required)
- Prepend user name and date header to DayTrack Slack posts


### Bug Fixes
- Fix 7 QA issues in Claude Queue and Quick Send
- Persist MCP default send time to DB — backend applies it when Claude queues without explicit scheduled_at
- Fix MCP connector URL missing origin when VITE_API_URL is a relative path

### Features
- Accept natural send time in MCP — '3pm', '15:30', '9am' all work
- Simplify MCP tool — message only required, resolve channel by name, resolve @mentions to Slack IDs, inline channel picker for unset messages

## 2026-07-15

### Features
- Enhance Quick Send functionality with mention support and message history
- Update Reminders sub-tab — rule CRUD, roster, dry-run/run-now with diff, quick send, 30-day history

### Bug Fixes
- extractMentions regex didnt handle @ID|display_name Slack mention format
- Fix Update Reminders bugs — null snapshot crash, delivery diagnostics, memory leak, duplicate roster adds, cross-day check window, preview mention humanization

## 2026-07-07

### Enhancements
- Replace all hardcoded accent/danger colors in modals.css with CSS custom properties
- Replace Sparkles icon with Megaphone icon for changelog indicator

---

## 2026-07-06

### Enhancements
- Enable Slack access for member role — members can now read and post to configured Slack channels

---

## 2026-07-03

### Enhancements
- Remove admin credential fallback — YouTrack integration now strictly per-user; members must configure their own token
- Validate YouTrack project ID on save — connection test checks project short name against live YouTrack project list
- Replace all hardcoded colour values in PM Assistant with CSS custom properties

### Bug Fixes
- Fix login flow regression for users with an existing YouTrack integration row
- Fix user_ignored_blocked_tickets migration (was not applying on startup)
- Include CHANGELOG.md in Docker runtime image (was causing 500 on /api/changelog/status in production)
 
 
---

## 2026-07-02

### Features
- Gantt chart tab — interactive sprint timeline with drag/resize bars, dependency arrows, Edit Mode, Day/Week/Month views synced to YouTrack

---

## 2026-07-01

### Enhancements
- WorldClock — double-click to edit timezone, hour snap, day/night icons, pulse dot, IST/CET diff tooltip

### Bug Fixes
- Include subtasks in DayTrack Slack post as nested ◦ bullets under their parent task

---

## 2026-06-24

### Features
- Global per-user parked blocked tickets — DB-backed ignored list, optimistic UI, covers all PM views

### Enhancements
- Health Rings — clickable/hoverable dots, 8-hour watch dots, percentage center label, legend strip

### Bug Fixes
- Fix branch-switch logout (switching sprints no longer signs the user out)

---

## 2026-06-23

### Refactors
- Split SprintPulsePage (1917 lines) into 6 focused files; fix ticket ID display across board, list view, pull panel, and detail view

---

## 2026-06-22

### Features
- Sprint Pulse Live view — real-time animated sprint status board with attention panel and progress ring

### Styles
- Add color legend above Pulse Strips bars

### Bug Fixes
- Fix 6 security vulnerabilities: dev-mode bypass token in production, unauthenticated SSE endpoint, admin credential leak on YouTrack writes, missing AdminOnly guard on whitelist and PM report delete, open developer-config write
- Fix JWT secret lazy-init — `init()` fires before `godotenv` loads `.env`, causing a false FATAL in local dev

---

## 2026-06-19

### Features
- Daily Ops: 6 design views with persisted tab switcher — Health Rings, Mission Control, Stuck Detector, Hotfix Command, Pulse Strips, Snapshot

---

## 2026-06-18

### Features
- Daily Ops: "Done Today" section with corrected role semantics (dev_done only; verified/deployed excluded from developer attribution)

### Bug Fixes
- Include Meetings category in DayTrack Slack post (was explicitly excluded by mistake)

---

## 2026-06-16

### Features
- Complete Velocity brand identity — branded loaders and VelocityLogo across all pages, tabs, empty states, and modals

---

## 2026-06-14

### Features
- In-app changelog / What's New panel with per-user seen state and pulsing indicator

### Enhancements
- Automated CHANGELOG.md updates via commit-msg git hook — no manual changelog entries needed
- CLAUDE.md theming table updated to reference correct CSS variable names

---

## 2026-06-11

### Features
- Sprint Pulse Kanban is now a real swimlane — tier rows × state columns, draggable, with danger pulse
- Sprint Pulse Kanban uses real workflow state columns with drag-and-drop

### Enhancements
- SprintControlsBar shared component — replaces duplicated controls bar across Sprint Dashboard and Sprint Pulse
- Dev Report moved to first tab position
- Replaced "Yesterday" with "Last 2 Days" in date range options

### Bug Fixes
- Fixed issue timelines to include tickets completed in range even if In Progress started earlier
- Fixed `drIsDone` to use exact match; hide loading spinner on report tab
- Fixed pm-custom-dropdown active/hover colours to use theme CSS variables instead of hardcoded values
- Fixed priority badge to show raw YouTrack priority value instead of mapped internal label
- Fixed carousel CSS

### Refactors
- Added reusable `CustomDropdown` component; replaced native selects in Dev Activity page
- Replaced Schedule For `<select>` with `pm-custom-dropdown` in DayTrack Plan Ahead

---

## 2026-06-10

### Features
- Dev Activity — 4-view activity report (Feed, Cards, Log, Heatmap)

### Enhancements
- Restored name header and blank line spacing in DayTrack personal Slack report
- AI Fill: Bot Prompt Migration

### Bug Fixes
- Fixed priority badge showing mapped label instead of raw YouTrack field value

---

## 2026-06-06

### Refactors
- Split dev-activity.css into 6 per-subtab files for maintainability
- Lean CLAUDE.md: moved feature docs to docs/features/, added feature reference table

---

## 2026-06-05

### Features
- Sprint Pulse page — 4-view priority intelligence dashboard (Board, Focus, Signal, Pulse Board)

### Enhancements
- Sprint Pulse as dashboard view; ticket ID/title click + sprint selector integration
- Added Sprint Tracker view

---

## 2026-06-04

### Enhancements
- Fixed Dev Activity: attribution by moved_by, heatmap presence dots, blocked transition, DEV_DONE_STATES, 0-stint filter, priority dot colours
- Fixed Dev Report attribution: use moved_by for done stints, fix ImportHistory assignee fallback
- Fixed velocity dropdown to use pm-custom-dropdown pattern; hide controls in dashboard view
