# Backend logging

Status: **backend done** on branch `feature/logging`. The frontend logs page comes later.

## Goal

Every request, MCP tool call, background job, outbound API call and database error leaves a log line, without editing 351 handlers one by one. Logging is added at the five points everything passes through, so new endpoints and tools are covered without any extra work.

## How it works

| # | Choke point | Where | What it records |
|---|---|---|---|
| 1 | Request middleware | wraps the whole server in `main.go` (outside CORS) | request ID, method, path, route pattern, status, duration, bytes, user, IP, error text for 4xx/5xx, outbound and DB call counts |
| 2 | Panic recovery | same middleware | the panic, stack trace, request ID, and a clean JSON 500 instead of a dropped connection |
| 3 | MCP tool dispatch | `handlers/mcp_dispatch.go` `callTool` | tool name, user, duration, ok or failed, result summary, argument key names (never values) |
| 4 | Background jobs | `logging.Job` / `logging.Tick` / `logging.Go` | job name, run ID, duration, panics (the loop keeps running instead of the server crashing) |
| 5 | Outbound HTTP | `http.DefaultTransport` wrapped once at startup | service host, method, redacted path, status, duration, network errors |
| + | Database | pgx `QueryTracer` on the pool | failed queries and slow queries (SQL text only, never parameters) |
| + | Old `log.Printf` lines | bridged into the same logger | all ~230 existing lines, with level guessed from the text (`error`, `failed`, `⚠` and so on) |

Every line logged with `slog.*Context` while a request is in flight carries its `request_id` and `user_id`. The old bridged `log.Printf` lines have no context, so they do not carry them; they are stored with only the first 200 characters. Unauthenticated 4xx responses are logged to stdout at INFO and are not stored; 4xx from signed-in users are WARN. Detached goroutines started from a request keep the request ID too. The ID is returned to the caller in the `X-Request-ID` response header (exposed through CORS for the frontend later).

## Levels

| Level | Used for |
|---|---|
| `ERROR` | 5xx responses, panics, failed jobs, outbound network errors, legacy lines with `error`/`failed`/`❌` |
| `WARN` | 4xx responses, slow requests, slow or failed DB queries, outbound 4xx/5xx or slow calls, MCP tool failures |
| `INFO` | every API request, every MCP call, every job run that is not a per-minute tick, startup |
| `DEBUG` | `/api/health`, CORS preflights, static SPA files, per-minute ticks, successful outbound calls |

## Never logged

Request or response bodies (except the first 300 characters of a 4xx/5xx error message), query strings, `Authorization` and cookie headers, MCP argument values, SQL parameters, Slack webhook paths and any token-shaped path segment in outbound URLs.

As a last line of defence, every message and string field passes through `logging.Scrub` before it is printed or saved. It masks sensitive query values (`key`, `token`, `id_token`, `code`, `signature` and similar), passwords in connection URLs, Bearer tokens, Slack webhooks and `xox` tokens, Google `AIza` keys, `sk-`/`gsk_`/`ghp_`/`glpat` keys and JWTs. This matters because a Go network error prints the full request URL, and Gemini sends its API key in `?key=`.

## Settings (env vars, all optional)

| Var | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `text` in development, `json` otherwise | output format on stdout |
| `LOG_SLOW_REQUEST_MS` | `3000` | requests slower than this are `WARN` |
| `LOG_SLOW_QUERY_MS` | `500` | DB queries slower than this are `WARN` |
| `LOG_STORE` | `on` | save `WARN` and `ERROR` lines to the `app_logs` table |
| `LOG_RETENTION_DAYS` | `14` | how long saved lines are kept |

## Saved logs and the admin endpoint

`WARN` and `ERROR` lines are also written to `app_logs` in the background (buffered, never blocks a request, drops instead of piling up if the DB is down). Pruned daily.

`GET /api/admin/logs` (admin only): `level`, `q` (text search), `request_id`, `user_id`, `since`, `until`, `limit` (max 500), `before_id` (paging). This is what the frontend logs page will read.

## Build plan

- [x] 1. `internal/logging` package: setup, context, legacy bridge
- [x] 2. Request middleware with panic recovery, route tagging, user tagging from `AuthMiddleware` and MCP
- [x] 3. MCP `callTool` structured logging
- [x] 4. Background jobs wrapped (list below)
- [x] 5. Detached and fan-out goroutines get panic recovery (list below)
- [x] 6. Outbound HTTP transport
- [x] 7. Database tracer
- [x] 8. `app_logs` table, background writer, pruning, `GET /api/admin/logs`
- [x] 9. Tests for every piece, `go vet`, `go build`, `go test ./...`
- [x] 10. Check against the coverage lists below

## Coverage

### MCP tools (33), all through `callTool`

get_developer_configs, get_sprints, get_developer_load, get_youtrack_ticket, search_youtrack_tickets, create_youtrack_ticket, delete_youtrack_ticket, edit_youtrack_ticket, create_attachment_upload_url, upload_youtrack_attachment, link_youtrack_tickets, bulk_update_tickets, create_sprint, add_youtrack_comment, edit_youtrack_comment, delete_youtrack_comment, queue_slack_message, send_slack_message_now, delete_slack_message, edit_slack_message, get_slack_reply_config, update_slack_reply_config, get_daytrack, add_daytrack_entries, update_daytrack_entry, delete_daytrack_entry, send_daytrack, add_daytrack_category, whoami, search_knowledge_base, read_slack_messages, get_slack_mentions, generate_deployment_report. Plus the `initialize` and `tools/list` methods and the SSE stream, which go through the request middleware.

### Background jobs

| Job | File | Interval | Wrapper |
|---|---|---|---|
| PM scheduler | `services/scheduler/service.go` | 60s | `Tick` |
| Update reminder fire | `services/scheduler/service.go` | per rule | `Go` + `Job` |
| Pending Slack messages | `handlers/pending_messages.go` | 60s | `Tick` |
| Day Track Slack scanner | `handlers/daytrack_slack.go` | 5 min | `Job` |
| Day Track manual scan | `handlers/daytrack_handler.go` | on request | `Go` |
| Day Track auto send | `handlers/daytrack_handler.go` | 60s check, sends once a day | `Tick` + `Job` |
| MCP activity pruner | `handlers/mcp_activity_prune.go` | daily | `Job` |
| Slack bot conversation pruner | `handlers/slack_bot_conversation_prune.go` | daily | `Job` |
| 30 day cleanup | `main.go` | daily | `Job` |
| KB resume and indexing | `services/kb/service.go` | startup, per upload | `Job` / `Go` |
| Cache cleanup | `cache/cache.go` | ticker | `Go` (recover only) |
| App logs pruner (new) | `logging` | daily | `Job` |

### Detached and fan-out goroutines (panic recovery, request ID kept)

`handlers/slack_events.go` (bot reply), `handlers/youtrack.go` (webhook events, 3 background syncs, metadata fan-out, per-issue fan-out), `handlers/asana.go`, `handlers/asana_pm.go` (deployment fan-out), `handlers/slack_chats.go`, `handlers/slack_chats_profile.go`, `handlers/report.go` (2 fan-outs), `handlers/pm_features.go` (2 fan-outs), `handlers/mcp_deployment_report_helpers.go`, `handlers/sse.go`, `services/kb/service.go` (search fan-out).

### Outbound services (all use `http.DefaultTransport`, none set their own)

YouTrack (`services/youtrack/client.go`, `handlers/youtrack.go`), Slack (`services/slack/client.go`, `handlers/slack_events.go`), Asana (`services/asana/client.go`, `handlers/asana_pm.go`), AI providers (`services/ai/client.go`, `services/ai/gemini.go`, `handlers/ai.go`), embeddings (`services/kb/embed.go`), Google auth (`auth/google.go`), Day Track (`handlers/daytrack_handler.go`), attachments (`handlers/mcp_attachment_source.go`). S3 uses the AWS SDK's own client and is not covered.

### Endpoints (351), all through the request middleware

Generated from `main.go`. Route patterns are logged as written here, so `/api/tasks/{id}` groups all task IDs together.

<details><summary>Full list</summary>


#### `/api/health` (1)

- [x] `GET /api/health`

#### `/api/auth` (5)

- [x] `POST /api/auth/google`
- [x] `GET /api/auth/google/url`
- [x] `GET /api/auth/me`
- [x] `POST /api/auth/logout`
- [x] `POST /api/auth/refresh`

#### `/api/tasks` (14)

- [x] `GET /api/tasks`
- [x] `POST /api/tasks`
- [x] `GET /api/tasks/yesterday-pending`
- [x] `GET /api/tasks/stats`
- [x] `PATCH /api/tasks/bulk-status`
- [x] `GET /api/tasks/by-date/{date}`
- [x] `GET /api/tasks/{id}`
- [x] `PUT /api/tasks/{id}`
- [x] `DELETE /api/tasks/{id}`
- [x] `PATCH /api/tasks/{id}/status`
- [x] `PATCH /api/tasks/{id}/section`
- [x] `POST /api/tasks/{id}/asana/sync`
- [x] `POST /api/tasks/{id}/asana/push`
- [x] `POST /api/tasks/{id}/youtrack/sync`

#### `/api/asana` (48)

- [x] `GET /api/asana/pm/status`
- [x] `GET /api/asana/pm/projects`
- [x] `GET /api/asana/pm/boards`
- [x] `GET /api/asana/pm/boards/{board_id}/columns`
- [x] `GET /api/asana/pm/states`
- [x] `GET /api/asana/pm/priorities`
- [x] `GET /api/asana/pm/users`
- [x] `GET /api/asana/pm/issues/grouped-by-assignee`
- [x] `GET /api/asana/pm/issues`
- [x] `POST /api/asana/pm/issues`
- [x] `GET /api/asana/pm/issues/{issue_id}`
- [x] `PUT,PATCH /api/asana/pm/issues/{issue_id}`
- [x] `DELETE /api/asana/pm/issues/{issue_id}`
- [x] `PATCH /api/asana/pm/issues/{issue_id}/state`
- [x] `GET /api/asana/pm/sections`
- [x] `POST /api/asana/pm/import`
- [x] `POST /api/asana/pm/match-analysis`
- [x] `POST /api/asana/pm/pm-query`
- [x] `GET /api/asana/pm/daily-brief`
- [x] `GET /api/asana/pm/eod-summary`
- [x] `GET /api/asana/pm/developer-load`
- [x] `GET /api/asana/pm/blocker-reasons`
- [x] `POST /api/asana/pm/save-plan`
- [x] `GET /api/asana/pm/carryover`
- [x] `PATCH /api/asana/pm/project`
- [x] `GET /api/asana/pm/assignee-stats`
- [x] `GET /api/asana/pm/users/avatars`
- [x] `GET /api/asana/pm/time-tracking`
- [x] `GET /api/asana/pm/issue-timelines`
- [x] `GET /api/asana/pm/report/weekly/{weekStart}`
- [x] `GET /api/asana/pm/report/{date}`
- [x] `GET /api/asana/pm/stage-report/columns`
- [x] `POST /api/asana/pm/stage-report/generate`
- [x] `POST /api/asana/pm/deployment/task`
- [x] `POST /api/asana/pm/deployment/generate`
- [x] `GET /api/asana/pm/deployment/config`
- [x] `PUT /api/asana/pm/deployment/config`
- [x] `GET /api/asana/pm/deployment/project/sections`
- [x] `GET /api/asana/pm/deployment/sections/{sectionGid}/tasks`
- [x] `POST /api/asana/pm/backfill`
- [x] `POST /api/asana/connect`
- [x] `POST /api/asana/disconnect`
- [x] `GET /api/asana/status`
- [x] `GET /api/asana/workspaces`
- [x] `GET /api/asana/projects`
- [x] `GET /api/asana/projects/{asana_project_id}/sections`
- [x] `GET /api/asana/sections`
- [x] `POST /api/asana/import`

#### `/api/user` (2)

- [x] `GET /api/user/data-source`
- [x] `PUT /api/user/data-source`

#### `/api/projects` (3)

- [x] `POST /api/projects/{id}/asana/link`
- [x] `POST /api/projects/{id}/asana/sync`
- [x] `POST /api/projects/{id}/asana/webhook`

#### `/api/webhooks` (2)

- [x] `POST /api/webhooks/asana`
- [x] `POST /api/webhooks/youtrack`

#### `/api/events` (1)

- [x] `GET /api/events`

#### `/api/gantt` (3)

- [x] `GET /api/gantt/charts`
- [x] `GET /api/gantt/chart`
- [x] `POST /api/gantt/chart/{ganttId}/members/{memberId}`

#### `/api/slack` (40)

- [x] `POST /api/slack/events`
- [x] `GET /api/slack/status`
- [x] `GET /api/slack/channels`
- [x] `GET /api/slack/messages`
- [x] `GET /api/slack/messages/yesterday`
- [x] `GET /api/slack/mentions`
- [x] `POST /api/slack/mentions/{messageTS}/dismiss`
- [x] `POST /api/slack/mentions/{messageTS}/snooze`
- [x] `POST /api/slack/mentions/{messageTS}/pin`
- [x] `GET /api/slack/threads`
- [x] `POST /api/slack/threads/{threadTS}/dismiss`
- [x] `POST /api/slack/threads/{threadTS}/snooze`
- [x] `GET /api/slack/thread-replies`
- [x] `POST /api/slack/reminders`
- [x] `GET /api/slack/templates`
- [x] `POST /api/slack/templates`
- [x] `DELETE /api/slack/templates/{id}`
- [x] `GET /api/slack/saved-items`
- [x] `GET /api/slack/workspace-users`
- [x] `POST /api/slack/quick-send`
- [x] `DELETE /api/slack/quick-send/messages/{channelId}/{ts}`
- [x] `PUT /api/slack/quick-send/messages/{channelId}/{ts}`
- [x] `GET /api/slack/queued`
- [x] `POST /api/slack/queued`
- [x] `PUT /api/slack/queued/{id}`
- [x] `DELETE /api/slack/queued/{id}`
- [x] `POST /api/slack/queued/{id}/send-now`
- [x] `GET /api/slack/hub/messages`
- [x] `GET /api/slack/hub/live-messages`
- [x] `POST /api/slack/hub/messages`
- [x] `PUT /api/slack/hub/messages/{id}`
- [x] `DELETE /api/slack/hub/messages/{id}`
- [x] `POST /api/slack/connect`
- [x] `POST /api/slack/disconnect`
- [x] `POST /api/slack/channel`
- [x] `POST /api/slack/monitor-channel`
- [x] `POST /api/slack/scan`
- [x] `POST /api/slack/digest`
- [x] `POST /api/slack/reply`
- [x] `POST /api/slack/post-morning-report`

#### `/api/youtrack` (44)

- [x] `GET /api/youtrack/status`
- [x] `POST /api/youtrack/test`
- [x] `POST /api/youtrack/probe`
- [x] `POST /api/youtrack/probe/boards`
- [x] `GET /api/youtrack/projects`
- [x] `GET /api/youtrack/boards`
- [x] `GET /api/youtrack/board/columns`
- [x] `GET /api/youtrack/boards/{board_id}/columns`
- [x] `GET /api/youtrack/sprints`
- [x] `GET /api/youtrack/states`
- [x] `GET /api/youtrack/priorities`
- [x] `GET /api/youtrack/swimlane-field`
- [x] `GET /api/youtrack/type-field-values`
- [x] `GET /api/youtrack/users`
- [x] `GET /api/youtrack/form-meta`
- [x] `POST /api/youtrack/ai/parse-ticket`
- [x] `GET /api/youtrack/issues`
- [x] `POST /api/youtrack/issues`
- [x] `GET /api/youtrack/issues/grouped-by-assignee`
- [x] `GET /api/youtrack/issues/{issue_id}`
- [x] `PUT,PATCH /api/youtrack/issues/{issue_id}`
- [x] `DELETE /api/youtrack/issues/{issue_id}`
- [x] `PATCH /api/youtrack/issues/{issue_id}/state`
- [x] `POST /api/youtrack/issues/{issue_id}/attachments`
- [x] `GET /api/youtrack/issues/{issue_id}/comments`
- [x] `POST /api/youtrack/issues/{issue_id}/comments`
- [x] `GET /api/youtrack/search`
- [x] `GET /api/youtrack/issues/{issue_id}/links`
- [x] `POST /api/youtrack/issues/{issue_id}/links`
- [x] `DELETE /api/youtrack/issues/{issue_id}/links`
- [x] `GET,HEAD /api/youtrack/proxy`
- [x] `GET /api/youtrack/sections`
- [x] `POST /api/youtrack/import`
- [x] `POST /api/youtrack/match-analysis`
- [x] `POST /api/youtrack/bulk-update-states`
- [x] `POST /api/youtrack/sync-recommendations`
- [x] `POST /api/youtrack/pm-query`
- [x] `GET /api/youtrack/daily-brief`
- [x] `GET /api/youtrack/eod-summary`
- [x] `GET /api/youtrack/developer-load`
- [x] `GET /api/youtrack/blocker-reasons`
- [x] `POST /api/youtrack/save-plan`
- [x] `GET /api/youtrack/carryover`
- [x] `GET /api/youtrack/feature-groups`

#### `/api/ignored-blocked` (3)

- [x] `GET /api/ignored-blocked`
- [x] `POST /api/ignored-blocked`
- [x] `DELETE /api/ignored-blocked/{issue_id}`

#### `/api/update-reminders` (13)

- [x] `GET /api/update-reminders`
- [x] `POST /api/update-reminders`
- [x] `GET /api/update-reminders/{id}`
- [x] `PUT /api/update-reminders/{id}`
- [x] `DELETE /api/update-reminders/{id}`
- [x] `PATCH /api/update-reminders/{id}/toggle`
- [x] `GET /api/update-reminders/{id}/roster`
- [x] `POST /api/update-reminders/{id}/roster`
- [x] `PUT /api/update-reminders/{id}/roster/{mid}`
- [x] `DELETE /api/update-reminders/{id}/roster/{mid}`
- [x] `POST /api/update-reminders/{id}/dry-run`
- [x] `POST /api/update-reminders/{id}/run-now`
- [x] `GET /api/update-reminders/{id}/history`

#### `/api/changelog` (3)

- [x] `GET /api/changelog/status`
- [x] `PATCH /api/changelog/seen`
- [x] `PATCH /api/changelog/seen/reset`

#### `/api/notifications` (6)

- [x] `GET /api/notifications`
- [x] `GET /api/notifications/unread-count`
- [x] `PATCH /api/notifications/{id}/read`
- [x] `DELETE /api/notifications/{id}`
- [x] `PATCH /api/notifications/read-all`
- [x] `DELETE /api/notifications/clear-all`

#### `/api/activity` (1)

- [x] `GET /api/activity`

#### `/api/standup` (6)

- [x] `GET /api/standup/config`
- [x] `PUT /api/standup/config`
- [x] `POST /api/standup/compile`
- [x] `POST /api/standup/parse-one`
- [x] `POST /api/standup/post`
- [x] `POST /api/standup/weekly`

#### `/api/ai` (4)

- [x] `POST /api/ai/analyze`
- [x] `POST /api/ai/analyze-manual`
- [x] `GET /api/ai/discrepancies`
- [x] `POST /api/ai/eod-plan`

#### `/api/daily-tasks` (11)

- [x] `POST /api/daily-tasks/analysis`
- [x] `GET /api/daily-tasks/analysis/{date}`
- [x] `GET /api/daily-tasks/today/{date}`
- [x] `GET /api/daily-tasks/next-day/{date}`
- [x] `POST /api/daily-tasks/next-day/generate`
- [x] `POST /api/daily-tasks/next-day/task`
- [x] `POST /api/daily-tasks/next-day/bulk-create`
- [x] `PATCH /api/daily-tasks/next-day/task/{taskId}`
- [x] `DELETE /api/daily-tasks/next-day/task/{taskId}`
- [x] `PATCH /api/daily-tasks/next-day/reorder`
- [x] `GET /api/daily-tasks/next-day/{date}/slack-format`

#### `/api/developer-config` (2)

- [x] `GET /api/developer-config`
- [x] `POST /api/developer-config`

#### `/api/bots` (10)

- [x] `GET /api/bots`
- [x] `POST /api/bots`
- [x] `GET /api/bots/templates`
- [x] `GET /api/bots/stage-report/columns`
- [x] `POST /api/bots/stage-report/generate`
- [x] `GET /api/bots/deployment/tickets`
- [x] `POST /api/bots/deployment/generate-ticket`
- [x] `GET /api/bots/{id}`
- [x] `PUT /api/bots/{id}`
- [x] `DELETE /api/bots/{id}`

#### `/api/workflow-config` (8)

- [x] `GET /api/workflow-config`
- [x] `PUT /api/workflow-config`
- [x] `PUT /api/workflow-config/priorities`
- [x] `PUT /api/workflow-config/columns`
- [x] `PUT /api/workflow-config/hotfix-rules`
- [x] `PUT /api/workflow-config/report`
- [x] `POST /api/workflow-config/reset`
- [x] `GET /api/workflow-config/defaults`

#### `/api/calendar` (1)

- [x] `GET /api/calendar/{year}/{month}`

#### `/api/reminders` (4)

- [x] `GET /api/reminders`
- [x] `POST /api/reminders`
- [x] `PATCH /api/reminders/{id}/dismiss`
- [x] `DELETE /api/reminders/{id}`

#### `/api/reports` (33)

- [x] `GET /api/reports/pm-report/weekly/{weekStart}`
- [x] `GET /api/reports/pm-reports/weekly`
- [x] `GET /api/reports/pm-report/{date}/saved`
- [x] `GET /api/reports/pm-report/{date}`
- [x] `GET /api/reports/pm-reports`
- [x] `DELETE /api/reports/pm-report/{id}/delete`
- [x] `GET /api/reports/assignee-stats`
- [x] `GET /api/reports/time-tracking`
- [x] `GET /api/reports/pins`
- [x] `POST /api/reports/pins`
- [x] `DELETE /api/reports/pins/{issueID}`
- [x] `GET /api/reports/issue-timelines`
- [x] `GET /api/reports/activity-by-day`
- [x] `POST /api/reports/alerts/dismiss`
- [x] `DELETE /api/reports/alerts/dismiss/{issueID}`
- [x] `POST /api/reports/backfill`
- [x] `POST /api/reports/import-history`
- [x] `POST /api/reports/reconcile`
- [x] `DELETE /api/reports/reset-state-log`
- [x] `GET /api/reports/sprint-board-status`
- [x] `GET /api/reports/sprint-qa-summary`
- [x] `GET /api/reports/issue-transitions`
- [x] `GET /api/reports/sprint-velocity`
- [x] `GET /api/reports/sprint-burndown`
- [x] `GET /api/reports/capacity`
- [x] `POST /api/reports/capacity`
- [x] `DELETE /api/reports/capacity/{id}`
- [x] `GET /api/reports/blocker-sla`
- [x] `GET /api/reports/blocker-sla/config`
- [x] `POST /api/reports/blocker-sla/config`
- [x] `GET /api/reports/releases`
- [x] `GET /api/reports/dependencies`
- [x] `GET /api/reports/sprint-radar`

#### `/api/daytrack` (26)

- [x] `GET /api/daytrack/entries/range`
- [x] `GET /api/daytrack/entries`
- [x] `POST /api/daytrack/entries`
- [x] `PUT /api/daytrack/entries/{id}`
- [x] `DELETE /api/daytrack/entries/{id}`
- [x] `GET /api/daytrack/planned`
- [x] `POST /api/daytrack/planned`
- [x] `PUT /api/daytrack/planned/{id}`
- [x] `DELETE /api/daytrack/planned/{id}`
- [x] `GET /api/daytrack/suggestions`
- [x] `GET /api/daytrack/categories`
- [x] `POST /api/daytrack/categories`
- [x] `DELETE /api/daytrack/categories/{name}`
- [x] `GET /api/daytrack/category-emoji`
- [x] `GET /api/daytrack/slack-preview`
- [x] `GET /api/daytrack/slack-config`
- [x] `PUT /api/daytrack/slack-config`
- [x] `POST /api/daytrack/slack-scan`
- [x] `POST /api/daytrack/slack-reset-scan`
- [x] `POST /api/daytrack/summarize`
- [x] `POST /api/daytrack/yt-scan`
- [x] `GET /api/daytrack/slack-resolve-user`
- [x] `POST /api/daytrack/transcribe`
- [x] `POST /api/daytrack/post-to-slack`
- [x] `GET /api/daytrack/slack-post-status`
- [x] `DELETE /api/daytrack/slack-post`

#### `/api/mcp` (7)

- [x] `GET /api/mcp`
- [x] `POST /api/mcp`
- [x] `GET /api/mcp/token`
- [x] `POST /api/mcp/token`
- [x] `DELETE /api/mcp/token`
- [x] `PUT /api/mcp/settings`
- [x] `GET /api/mcp/activity`

#### `/api/slack-bot-chat` (1)

- [x] `GET /api/slack-bot-chat`

#### `/api/slack-chats` (7)

- [x] `GET /api/slack-chats`
- [x] `GET /api/slack-chats/summary`
- [x] `POST /api/slack-chats/rephrase`
- [x] `GET /api/slack-chats/{channel}/messages`
- [x] `POST /api/slack-chats/{channel}/reply`
- [x] `PUT /api/slack-chats/{channel}/mode`
- [x] `POST /api/slack-chats/{channel}/resolve`

#### `/api/kb` (11)

- [x] `GET /api/kb/documents`
- [x] `POST /api/kb/documents`
- [x] `PATCH /api/kb/documents/{id}`
- [x] `DELETE /api/kb/documents/{id}`
- [x] `PUT /api/kb/documents/{id}/file`
- [x] `POST /api/kb/documents/{id}/reindex`
- [x] `GET /api/kb/documents/{id}/chunks`
- [x] `GET /api/kb/documents/{id}/text`
- [x] `POST /api/kb/notes`
- [x] `PUT /api/kb/notes/{id}`
- [x] `GET /api/kb/search`

#### `/api/users` (4)

- [x] `GET /api/users`
- [x] `POST /api/users/invite`
- [x] `PATCH /api/users/{id}/role`
- [x] `DELETE /api/users/{id}`

#### `/api/settings` (20)

- [x] `GET /api/settings/access`
- [x] `GET /api/settings/access/emails`
- [x] `POST /api/settings/access/emails`
- [x] `DELETE /api/settings/access/emails/{email}`
- [x] `GET /api/settings/access/domains`
- [x] `POST /api/settings/access/domains`
- [x] `DELETE /api/settings/access/domains/{domain}`
- [x] `GET /api/settings/access/denied`
- [x] `POST /api/settings/access/denied`
- [x] `DELETE /api/settings/access/denied/{email}`
- [x] `GET /api/settings/integrations/asana/status`
- [x] `GET /api/settings/integrations/asana`
- [x] `PUT /api/settings/integrations/asana`
- [x] `POST /api/settings/integrations/asana/test`
- [x] `GET /api/settings/integrations/asana/projects`
- [x] `GET /api/settings/integrations/youtrack`
- [x] `PUT /api/settings/integrations/youtrack`
- [x] `POST /api/settings/integrations/youtrack/disconnect`
- [x] `GET /api/settings/theme`
- [x] `PUT /api/settings/theme`

#### `/.well-known` (3)

- [x] `GET,OPTIONS /.well-known/oauth-authorization-server`
- [x] `GET,OPTIONS /.well-known/oauth-protected-resource`
- [x] `GET,OPTIONS /.well-known/oauth-protected-resource/api/mcp`

#### `/oauth` (3)

- [x] `POST,OPTIONS /oauth/register`
- [x] `POST,OPTIONS /oauth/token`
- [x] `GET,OPTIONS /oauth/client-info`

#### `/api/oauth` (1)

- [x] `POST /api/oauth/code`

</details>
