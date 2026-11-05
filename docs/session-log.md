# Session Log

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


### 2026-10-12
- Velocity: Slack bot conversation memory, replays the thread / recent DM from Slack and explains messages sent through Claude (`slack_bot_context.go`)
- Velocity: team knowledge base backend, file extraction (md/pdf/docx/pptx/xlsx/csv/json/html/txt), heading-aware chunking, Gemini embeddings + pgvector, hybrid search with calibrated cutoff, per-document visibility (`services/kb/`)
- Velocity: Slack bot answers from the knowledge base, admins-only docs only for admins; `search_knowledge_base` MCP tool
- Velocity: admin Knowledge Base page (upload, notes, visibility, chunk preview, try-a-question), UAT-verified
- Velocity: ticket detail shows who created and who last updated the ticket, names in the accent colour
- Velocity: ticket detail opens instantly with a loading skeleton, no flash or layout shift when content loads
- Velocity: Sprint Pulse remembers the selected view (Live, Kanban, Priority...) after refresh
- Velocity: KPI numbers count up (shared `CountUp`), replay when a tab is opened, slowed to 2.2s
- Velocity: skeleton loaders for the top KPI cards and Delivery strip on Sprint Pulse and PM Reports
- Velocity: Slack bot understands replies to older DMs (keeps the last 6 messages, not just the last 6 hours)
- Velocity: Knowledge Base always-visible upload card (drag and drop, live upload progress, indexing status)
- Velocity: KB finds people in PDFs with glued text ("life.Sandeep"), one person per chunk
- Velocity: KB handles messy/unstructured files: Poppler PDF reader, walls of text split per person with AI summary lines (daily Groq budget), neighbouring windows in search, extraction quality warnings
- Velocity: Slack > MCP Activity shows Bot conversations and Claude actions (switch), paginated with a 10/20/30/40/100 per-page choice; standalone /mcp-activity redirects there

### 2026-10-16
- Velocity: Gantt redesigned (ReUI style): tasks grouped by status with Owner/Status columns, week/day header, hatched weekends, today line, progress bars, Today/prev/next, zoom, off-screen arrows; fixed Gantt tickets showing no state/assignee/priority

### 2026-10-26
- Velocity: PM Assistant redesigned around the 21st.dev thinking orb (pill input, ball flies into a dotted orb, green "Done", answer card unfolds); moved to `components/assistant/`
- Velocity: Dashboard Delay Analysis ticket IDs no longer run under their bars
- Velocity: Slack tools no longer carry a real channel ID as their example (a weekly report meant for Rohit's DM went to #project-managers); channel-ID sends show the channel name
- Velocity: Claude actions cards show a preview of the Slack message that was sent
- Velocity: delete_slack_message says where a message actually went when it isn't in the place named
- Velocity: fixed the stale TestGetStateIndex test (state order now covers the full DEV to PROD pipeline)

### 2026-10-27
- Velocity: Velocity can now edit and delete its own Slack DMs (DMs and split message parts were never recorded, so Claude reported "couldn't find" in Rohit's and Suryansh's DMs)
- Velocity: queued DMs store the real message timestamp and DM channel (scheduler and "Send now" read QuickSend's return values the wrong way round); one shared `sendQueuedMessage`
- Velocity: edits through Claude or Claude Queue update the stored text; `edit_slack_message` accepts a Slack link; not-found hints no longer read as "never sent"
- Velocity: Claude Queue "Delete from Slack" works for DMs; Recent cards get the users list
- Velocity: unit tests with a fake Slack (`update_reminder`) and a 5-user end-to-end MCP regression (`TestMCPSlackE2E`, opt-in, real Slack, #velocity-app + own DM only)

### 2026-10-29
- Velocity: tickets created through MCP end with a permanent "#Created by Velocity 🤖" footer (linked, blank line above); AI edits and attachment uploads keep it in place (`youtrack/velocity_footer.go`)

### 2026-10-30
- Velocity: Board top bar redesigned (clear "Board" title, labelled ticket count, no YouTrack badge, filters on the left and group/sort on the right) and a dynamic Subsystem filter with live counts and search (`components/board/BoardToolbar.tsx`)
- Velocity: Board Group by Subsystem; grouped lanes now respect Search, Assignee, Priority and Subsystem filters and the sort; board toolbar documented in `docs/features/board.md`

### 2026-11-05
- Velocity: Day Track tools for connected agents: `add_daytrack_entries` (one line per task, automatic category and time), `update_daytrack_entry`, `delete_daytrack_entry`, `send_daytrack`, `add_daytrack_category`
- Velocity: `get_daytrack` returns entry IDs, planned and in-progress items, and whether the day was posted to Slack
- Velocity: MCP server instructions tell connected agents to report finished work as `• Velocity: ...` bullets and log each one to Day Track
- Velocity: opt-in end-to-end test for the Day Track tools (`TestMCPDayTrackE2E`), real Slack in #velocity-app, fake YouTrack
- Velocity: `CLAUDE.md` shortened, full rules moved to `docs/features/frontend-rules.md`, `pm-data-rules.md`, `setup.md` and `docs/session-log.md`
