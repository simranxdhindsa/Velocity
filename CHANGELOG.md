# Changelog

## 2026-09-30

### Bug Fixes
- truncate long Slack messages


### Features
- Day Track category emojis, Slack-exact report

### Refactors
- split DayTrackPage, shrink emojis, log session

### Enhancements
- remove navbar chip progress bars
- render DayTrack Summary as formatted mrkdwn

## 2026-09-23

### Bug Fixes
- login page theme toggle sat at the bottom and scrolled away with the page, pin it to the top-right corner
- dragging in Day Track hijacked scroll on mobile, disable drag below 769px and rely on the Carry/Start buttons there
- manually-created and carried-over in-progress items disappeared from Planned & Carry Over the next day
- stale In Progress tickets never left Planned & Carry Over when moved to Dev directly in YouTrack
- enforce a strict invariant, Today's Log is done-only, Planned & Carry Over is not-done-only
- Day Track drag was free-floating horizontally too, restrict it to vertical movement only
- Pending stat pill ignored in-progress entries already sitting in Today's Log


### Enhancements
- fix apostrophe, "organization's Google account"
- change login copy "company Google account" to "organization Google account"
- contain Day Track page width on mobile so it can't force the whole page to zoom out

## 2026-09-22

### Features
- drag tasks between Today's Log and Planned & Carry Over, same drag pattern as the Kanban board
- pull each user's current In Progress YouTrack tickets into Day Track automatically, and add In Progress as a manual entry category
- add a delete button on the Day Track Slack post pill to undo a mistaken send


### Enhancements
- replace native title tooltip on Auto Send chip with a fast, bulleted hover card anchored to the chip
- disable Sign In/Sign Off/Breaks categories when "Still in progress" is checked
- keep the Day Track header bar on one line, force nowrap and trim the posted-status indicator down to a single icon button instead of a separate pill+dot; shorten the subtitle to "Daily Time Log"
- instant optimistic UI for Day Track drag/carry/start, with rollback animation on failure
- make in-progress rows in Today's Log clearly stand out, pulsing dot, "In Progress" label instead of "active", left-accent row tint
- replace native "Still in progress" checkbox with a custom animated one that matches both themes
- move the "Still in progress" checkbox above Category, right below Task Name
- refine Day Track delete-post UI (bigger, clearer bin icon, no wrap) and handle already-deleted Slack messages gracefully

### Bug Fixes
- auto-pulled YouTrack "In Progress" tickets now land in Planned & Carry Over, not Today's Log
- manual entries with no end time were always marked In Progress even with the "Still in progress" checkbox left unchecked
- make "In Progress" a status, not a category, so finishing a task or carrying it forward no longer needs a manual category change

## 2026-09-21

### Enhancements
- shorten the "Posted" pill and make the Day Track toolbar scroll instead of wrapping, so it never breaks the bar layout
- richer Auto Send hover tooltip on Day Track, shows send time, channel, and what happens before sending
- pull latest YouTrack ticket activity before the Day Track auto-send job posts, matching the manual sync + post flow
- separate Sign In/Sign Off/Breaks entries in Day Track log with a divider noting they're excluded from the Slack report


### Bug Fixes
- add theme to MEMBER_PAGES so non-admin/PM users aren't redirected away from the Theme tab

### Features
- auto-send Day Track update to Slack daily at 11:50 PM IST, with an on/off toggle (time is not user-configurable)

## 2026-09-15

### Bug Fixes
- isolate MCP OAuth tokens per client so connecting one no longer logs out another


## 2026-09-08

### Features
- log MCP tool activity to DB (7-day retention) and add private admin MCP Activity view


### Enhancements
- drop manual MCP token generate/revoke UI, show plain OAuth connector URL

## 2026-08-26

### Features
- display and edit board and sprint in issue detail panel


### Enhancements
- live-remove deleted YouTrack tickets from DayTrack via webhook + SSE
- make board field editable in issue detail panel
- fix board/sprint fetching using dedicated YouTrack API endpoint

### Bug Fixes
- scope DayTrack YouTrack-deletion pruning to today only, skip once posted
- fix IST timezone throughout Velocity app

## 2026-08-14

### Refactors
- split mcp.go into one file per MCP tool, doc convention in docs/features/mcp-server.md


## 2026-08-13

### Features
- auto-prune DayTrack entries for deleted tickets, post-once-then-update Slack digest
- scope dev-hotfix DayTrack entries to subsystem-owning developers, fix re-entry dedup


### Bug Fixes
- fix DayTrack entries to use IST and record actual start/end duration

## 2026-08-06

### Enhancements
- wire notification bell to real backend data with SSE, fix type/icon mapping, add click-to-navigate and Update Reminders notification events
- center send icon, add fly-out/fly-in animation on send


### Features
- add 'get_youtrack_ticket' tool to fetch ticket details by readable ID, including summary, description, status, and attachments
- hide top-nav clock widget on mobile, and BUG: fix DayTrack horizontal overflow on mobile viewports

## 2026-08-05

### Bug Fixes
- report widget size to host via ui/notifications/size-changed


### Enhancements
- consolidate Slack Intelligence + Update Reminders tabs, fix UAT-found bugs

## 2026-08-04

### Enhancements
- add busy state to paste-split so bulk creation can't be double-submitted
- restructure Slack Intelligence tabs - Messages first, drop fake/duplicate tabs
- embed uploaded attachments inline in ticket description


### Bug Fixes
- fix strict id equality blocking MCP Apps init handshake
- bump MCP initialize protocolVersion to fix broken widget rendering
- fix Dashboard remount loop from stale loading state in useOnboardingGate

### Features
- add MCP Apps interactive UI widgets for create_youtrack_ticket and get_developer_load
- add @mention autocomplete to Slack Messages Hub compose box
- paste-to-split multi-line text into separate DayTrack tasks/subtasks
- add Slack Messages Hub - live 1:1 channel replica in Slack Intelligence

## 2026-08-03

### Features
- add S3-backed file upload to MCP connector for ticket attachments


## 2026-08-01

### Features
- add 5-screen onboarding flow for new users


### Enhancements
- onboarding polish - chip-card picker, completion animation, copy cleanup, YouTrack URL-scheme fix

## 2026-07-31

### Enhancements
- split Sprint Pulse P2/A2 and P3/A3 into dedicated swimlanes


### Features
- add base64 file upload support to upload_youtrack_attachment MCP tool

## 2026-07-22

### Enhancements
- show IST (Asia/Kolkata) timestamps throughout Update Reminders and Claude Queue tabs instead of browser-local time
- add DM user support to Claude Queue — MCP queue_slack_message accepts dm_user param, UI shows channel and person pickers side-by-side when no destination set


### Bug Fixes
- fix get_developer_load to count To Do + In Progress tickets in current sprint only, not all unresolved tickets across entire project
- fix scheduler sending deleted/no-destination messages — atomic UPDATE claim prevents race condition, require destination before sending, add dismiss button for failed messages

## 2026-07-21

### Bug Fixes
- fix LinkIssues Commands API using wrong field for internal IDs (id vs idReadable)
- fix link_youtrack_tickets 405 — switch from links endpoint to Commands API


### Features
- ENHANCEMENT: add Day Track "Development" category auto-logging for To Do/In Progress → Dev/Stage/PROD/Mobile Done transitions, and fix the existing Mobile-verified rule to key off Mobile Done → Verified instead of arrival at Mobile Done
- add ticket links UI in IssueDetailPanel and CreateIssueModal + YouTrack links API

### Enhancements
- auto-sync YouTrack on Day Track open (today only) plus live SSE refresh when a ticket's state changes while the page is open; animate the sync icon in place instead of swapping to a generic spinner
- fix link typeahead query (YQL #ID format), show recent tickets on focus, unified UI in both modals
- move links under description, portal typeahead dropdown, always-visible remove btn
- add issue search typeahead to link input + move links to IssueDetailPanel sidebar

## 2026-07-20

### Enhancements
- add edit, delete, link, upload-attachment MCP tools + fix mcpYTClient to read credentials from DB
- Redesign Developer Subsystem Config — pill-based UI, admin-only write, global scope


### Features
- Added Edidting Ticekt

### Bug Fixes
- fix form-meta returning empty types/subsystems/priorities/states

## 2026-07-18

### Enhancements
- compact board cards
- move priority indicator to top-right chip on board cards (dot + name, replaces absolute attachment anchor)
- improve YouTrack integration UI with Framer Motion animations and error handling
- progressive disclosure YouTrack setup — auto-fetch projects on URL+token fill, board fetch on project select, no save-first required
- add date picking (shared CalendarPicker component) alongside time picking across Claude Queue compose/edit and Quick Send scheduling, so messages can be scheduled for any future date, not just today/tomorrow
- standardize time format to 12-hour (AM/PM) across the app and improve mention rendering in messages


### Features
- add get_sprints MCP tool to Velocity connector for sprint-name resolution
- add get_developer_load and create_youtrack_ticket to Velocity MCP — single connector for Claude ticket creation
- dynamic YouTrack priority colors in board filter

### Bug Fixes
- MCP create_youtrack_ticket — default state To Do, auto-assign to active sprint
- add idReadable to CreateIssue response fields so MCP returns ARD-XXXX format

## 2026-07-17

### Enhancements
- MCP protocol version 2025-06-18 + session ID in initialize response
- Complete light-mode overrides for 502 page — orbit rings, particles, scanner, brand text
- 502 page — full redesign with orbital rings, particles, shimmer scanner, global detection via DOM event, unlimited 2s retry
- Global 502 detection via DOM event + unlimited 2s retry + Framer Motion animations on 502 page
- ClockTimePicker — real-time drag with pointer capture, framer-motion spring animation on hand and thumb, display numbers animate on change
- Replace TimePicker with ClockTimePicker in Claude Queue card (default send time + inline message time pickers)
- MCP connector URL always visible — auto-generate on first open, store plain token in localStorage, remove Regenerate, show Generate only when revoked


### Features
- MCP OAuth 2.1 + manual Claude Queue scheduling
- ClockTimePicker — analog clock-face time selector component, used in Update Reminders rule editor

### Bug Fixes
- remove Mcp-Session-Id from initialize response to stop GET SSE attempt
- fix oauth-protected-resource returning wrong metadata format
- MCP GET/SSE endpoint + Bearer casing for OAuth 2025-06-18 protocol
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
