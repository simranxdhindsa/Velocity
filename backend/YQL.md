# YouTrack PM Assistant — YQL Translation Reference

This document describes how the YouTrack PM Assistant works end-to-end: how user queries become YQL searches, what analytics overrides exist, and how to fix or extend the system.

---

## Architecture: Two-Step LLM Flow

Every PM query goes through two sequential LLM calls:

```
User Query
    ↓
[Step 1] Translation LLM (buildYQLTranslationPrompt)
    → Generates a valid YQL string
    ↓
[Go Code] normalizeYQL → analytics override check
    ↓
[Step 2] YouTrack SearchIssues(yql)
    → Returns matching issues
    ↓
[Step 3] Build data context (KPIs + per-ticket lines with bounces/overdue flags)
    ↓
[Step 4] Response LLM (PM Assistant bot prompt from bot_configs DB table)
    → Produces the final answer
```

**Key files:**
- `backend/internal/handlers/youtrack.go` — `PMAssistantQuery()` handler + `buildYQLTranslationPrompt()` + `normalizeYQL()`
- `backend/internal/database/migrations.go` — bot_configs seed/update (the DB-stored response prompt)
- `backend/internal/services/youtrack/client.go` — `SearchIssues()`, `GetCustomFieldValues()`, `GetSprintIssues()`
- `backend/internal/services/ai/client.go` — `QueryWithHistory()` — Groq/OpenAI/Gemini caller

---

## YQL Syntax Quick Reference

### States, Priorities, Sprints — always use `#` prefix

```
#Blocked          #P0         #DEV        #Done
#{In Progress}    #{Sprint 5}  #{Ready For Prod}
```

Braces required for multi-word values. Multiple tags are space-separated (NOT comma-separated):
```
#{Sprint 5} #{In Progress} #P0
```

### Assignee / Reporter

```
Assignee: rajvirsingh        (login, no # prefix)
by: simran                   (reporter/creator)
```

### Type filter — NEVER use `#` for Type

```
Type: Bug
Type: Feature
Type: Hotfix
Type: Task
```

### Subsystem — hashtag syntax preferred

YouTrack subsystems can be used as hashtag values:
```
#{FE MC}      #{BE MC}      #{FE Studio}      #{BE Studio}
```

Both `#{FE MC}` and `Subsystem: {FE MC}` work, but hashtag is simpler for multi-subsystem queries.

**CRITICAL — Subsystem Exclusion:**
YouTrack has NO exclusion operator for subsystems (`-Subsystem:` does NOT work).
To "exclude" a subsystem, list only the subsystems you WANT:

```
# "BE tickets but not RAG"
# Available BE subsystems: #{BE MC} #{BE UI} #{BE Studio} #{BE RAG}
# Answer: include only the 3 you want:
#{Sprint 5} #{BE MC} #{BE Studio} #{BE UI}
```

### Date filters

```
created: Today
created: yesterday
created: {This week}
created: {Last week}
created: 2026-05-01 .. 2026-05-24
updated: Today
```

**NOTE:** `resolved: {period}` does NOT work in this project — no issues have a resolved date set. Use state filters (e.g. `#DEV #Done`) to identify "done" tickets instead.

---

## Analytics Override

Some query types can't be expressed as valid YQL. Go code detects keywords in the user query and overrides the generated YQL with a plain sprint fetch:

```go
analyticsKeywords := []string{
    "bounce", "bounced", "overdue", "sla", "cycle time",
    "workload", "at-risk", "developer workload", "who has the most",
    // date-exclusion (no resolved date in this project):
    "resolved by last week", "resolved last week",
}
```

When triggered, the override falls back to:
```
project: ARD #{Sprint 5} [Type: Bug if Type filter was in generated YQL]
```

The analytics data (bounce counts, overdue flags, transition history) is embedded directly in the data context per-ticket, so the response LLM can answer bounce/overdue queries from the context rather than via YQL.

---

## Per-Ticket Context Format

Each ticket in the data context looks like:
```
ARD-1234 | P1 | Bug | Summary text | In Progress | @developer  bounces:2 [OVERDUE]
  → In Progress→Blocked (4h, by qauser)
  → Blocked→In Progress (2h, by developer)
  BLOCKER: waiting on design approval
```

- `bounces:N` — backward transition count (from `issue_state_log`)
- `[OVERDUE]` — in active state beyond SLA threshold
- `→ From→To (Xh, by Person)` — state transition history (only for bounced/blocked tickets)
- `BLOCKER:` — AI-analyzed blocker reason

### ID Mismatch (Fixed)

YouTrack has two IDs per issue:
- `iss.ID` = internal (`3-1872`) — used in some internal APIs
- `iss.IDReadable` = human-readable (`ARD-1872`) — stored in `issue_state_log` webhook events

All lookups into `issue_state_log` and `blocker_cache` MUST use `IDReadable`. The code uses `iss.IDReadable` with a fallback to `iss.ID`.

---

## Bounce Detection

Bounces are backward state transitions. The order is defined in `pmStateOrder`:

```go
var pmStateOrder = map[string]int{
    "backlog": 0, "open": 0, "to do": 0, "todo": 0, "new": 0,
    "in progress": 1,
    "dev": 2,
    "stage": 3, "ready for stage": 3,
    "prod": 4, "ready for prod": 4,
    "done": 5, "closed": 5, "won't fix": 5, "duplicate": 5, "mobile done": 5,
}
```

A transition is a bounce when `pmStateOrder[toState] < pmStateOrder[fromState]`.

**Data source:** `issue_state_log` table, populated by YouTrack webhooks. Stores `IDReadable` (e.g. `ARD-1872`).

---

## normalizeYQL Post-Processor

After the LLM generates YQL, `normalizeYQL()` converts field:value syntax to proper `#tag` syntax:

```
"State: In Progress"  →  "#{In Progress}"
"Priority: P0"        →  "#P0"
"sprint: Sprint 4"    →  "#{Sprint 4}"
```

Fields explicitly NOT in the normalization list (pass through unchanged):
- `project:` — already correct
- `Assignee:` — uses field:value, not #tag
- `by:` — reporter filter
- `Type:` — `Type: Bug` is valid YQL (NOT `#Bug`)
- `created:` / `updated:` / `resolved:` — date fields
- `Subsystem:` — custom field with its own syntax

---

## Bot Prompts

### Response Prompt (Step 4)
Stored in `bot_configs` DB table (`bot_type = 'pm_assistant'`). Editable at runtime via the Bot Config page in Velocity UI.

To update it via migration, add to `migrations.go`:
```sql
UPDATE bot_configs SET prompt = '...' WHERE bot_type = 'pm_assistant'
```
Use `AND prompt NOT LIKE '%unique_phrase%'` to make idempotent.

### Translation Prompt (Step 1)
Built in Go code: `buildYQLTranslationPrompt()` in `youtrack.go`. Dynamically injects:
- Live sprint states from YouTrack
- Priority values
- Available sprint names
- Assignee logins
- Subsystem values (fetched via `GetCustomFieldValues("Subsystem")`)

---

## Metadata Fetched Per Query

All fetched in parallel (`sync.WaitGroup`) before building the prompt:
1. Sprint issues (`GetSprintIssues`)
2. Available sprints (`GetSprints`)
3. States (`GetStates`)
4. Priorities (`GetPriorities`)
5. Users (`GetProjectMembers`)
6. Subsystems (`GetCustomFieldValues("Subsystem")`)

Plus from the database (parallel):
- KPI counts (total/done/in-progress/blocked/overdue/bounced) from `GetPMSprintKPIs`
- Time tracking / state log from `GetTimeTracking`
- Blocker analysis from `GetBlockerAnalysis`

---

## Model Configuration

- Default: `llama-3.3-70b-versatile` (Groq)
- Override without code change: set `GROQ_MODEL=<model-id>` in `.env`
- Useful when daily 100K token quota is exhausted — switch to `meta-llama/llama-4-scout-17b-16e-instruct`
- AI provider: set `AI_PROVIDER=groq|openai|gemini` in `.env`

---

## Known Limitations

| Limitation | Reason | Workaround |
|---|---|---|
| `resolved:` date filter always returns 0 | This YouTrack project has no resolved dates set | Use state filters (`#DEV #Done`) instead |
| Subsystem exclusion (`-Subsystem:`) doesn't work | Not valid YQL | List only the subsystems you want |
| Bounces count 0 if webhook never fired | `issue_state_log` is empty | Webhooks must be configured in YouTrack |
| Analytics (bounce/overdue) can't be YQL-filtered | No native YQL for computed metrics | Go-side analytics override fetches full sprint data |

---

## Adding a New Subsystem Category

If a new subsystem is added in YouTrack admin:
1. It will be auto-fetched by `GetCustomFieldValues("Subsystem")` — no code change needed
2. It will appear in the translation prompt automatically
3. Test the query with the new subsystem to confirm hashtag syntax works

---

## Common Query Patterns

| User Says | Generated YQL |
|---|---|
| Sprint summary | `project: ARD #{Sprint 5}` |
| Blocked tickets | `project: ARD #{Sprint 5} #Blocked` |
| Bugs in sprint | `project: ARD #{Sprint 5} Type: Bug` |
| FE MC done | `project: ARD #{Sprint 5} #{FE MC} #DEV #Done` |
| BE excl RAG | `project: ARD #{Sprint 5} #{BE MC} #{BE Studio} #{BE UI}` |
| P0 or P1 open | `project: ARD #{Sprint 5} #P0 #P1 #{In Progress} #{To Do}` |
| One assignee | `project: ARD #{Sprint 5} Assignee: rajvirsingh` |
| Hotfixes active | `project: ARD #{Sprint 5} Type: Hotfix #{In Progress}` |
| Bounced (computed) | analytics override → `project: ARD #{Sprint 5}` |
| Overdue (computed) | analytics override → `project: ARD #{Sprint 5}` |

---

## Official YouTrack Search Documentation

> Read these before adding new query patterns or debugging unexpected YQL behavior.

### 1. Full-Text Search
**[Full-Text Search — YouTrack Server](https://www.jetbrains.com/help/youtrack/server/full-text-search.html)**

Covers searching within text fields (summary, description, comments):

- **Exact match**: `'single quotes'` — case-sensitive, character-perfect
- **Phrase search**: `"double quotes"` — consecutive word order preserved
- **Field-scoped text**: `summary: login`, `description: timeout`, `comments: {API error}`
- **Wildcards**: `*` (zero or more chars), `?` (one char) — only valid inside text attribute searches
- **Fuzzy match**: `~` suffix — `comments: {michael~}` matches approximate spellings
- **Stop words**: Common words (a, the, and) are filtered unless inside a phrase, where they act as wildcards

### 2. Attribute-Based Search
**[Attribute-Based Search — YouTrack Server](https://www.jetbrains.com/help/youtrack/server/attribute-based-search.html)**

Core reference for field:value syntax used in all PM Assistant queries:

- **Basic**: `attribute: value` (colon-space separator)
- **Multi-word values**: wrap in braces — `Type: {Support Request}`, `#{In Progress}`
- **Multiple values (OR)**: comma-separated — `Fix versions: 2018.1, 2018.2`
- **Negation**: minus prefix — `State: -Open` or `State: -{In Progress}`
- **Range**: two dots — `votes: 50 .. *` (50 or more), `created: 2026-01-01 .. 2026-05-01`
- **Hashtag shortcut**: `#value` = `attribute: value` without naming the attribute — `#Blocked`, `#{Sprint 5}`
- **Logic**: multiple different attributes → AND; multiple values for one attribute → OR
- **Grouping**: use parentheses — `(State: Open OR State: {In Progress}) Priority: Critical`

### 3. Search & Command Attributes (Cloud)
**[Search and Command Attributes — YouTrack Cloud](https://www.jetbrains.com/help/youtrack/cloud/search-and-command-attributes.html)**

Cloud-specific attribute reference — this is the version Velocity uses (loop.youtrack.cloud):

- **Date literals**: `Today`, `Yesterday`, `{This week}`, `{Last week}`, `{This month}`, `{Last month}`
- **Relative dates**: `minus 2 weeks`, `plus 1 month` — `created: {minus 2 weeks} .. Today`
- **Keywords**: `#me` (current user), `#Resolved`, `#Unresolved`
- **Sorting**: `sort by: created desc`, `sort by: Priority asc`
- **Relationship fields**: `Depends on:`, `Duplicates:`, `Subtask of:` — support sub-queries
- **Negation**: `-` prefix — `Priority: -minor`, `Assignee: -simran`
- **Custom fields**: use exact field name as configured in YouTrack admin (case-insensitive)

### Key Differences vs What Works in This Project

| Feature | Docs Say | Reality in loop.youtrack.cloud / ARD |
|---|---|---|
| `resolved: {Last week}` | Valid date filter | Returns 0 — project doesn't set resolved dates |
| `-Subsystem: {value}` | Negation syntax | **Broken** — "We couldn't find Subsystem" error |
| `#{Subsystem value}` | Hashtag for subsystem values | ✅ Works — use this instead |
| `Subsystem: {FE MC}` | Field:value for custom field | ✅ Works for positive filtering |
| `State: -Open` | Negation in attribute | Works for built-in fields; custom fields may vary |
