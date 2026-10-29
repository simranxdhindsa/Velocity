# Daily Ops Tab — Developer Load View

## Overview

Single-view tab showing per-developer sprint load. Rendered by `frontend/src/pages/DailyOpsTab.tsx`.

## Layout

Each developer gets a card showing:
- Sprint progress bar (done / total tickets)
- Stat chips: **done**, **active**, **blocked**, **bounced**, **overdue**, **hours worked**
- Active issue list (in-progress tickets)
- Blocked issue list

## Data Source

Driven by the active PM source (YouTrack or Asana) — reads from `pmDataService.ts`. Sprint ID comes from the shared sprint selector in the top bar, persisted via `PERSIST.pm_active_sprint_id`.

## Overdue Logic

- Only `active` and `backlog` tickets count as overdue
- `dev_done`, `verified`, `deployed`, `closed` → never overdue
- `blocked` → never overdue
- Role classification uses `useWorkflowConfig()` → `column_hierarchy` map

## CSS

`styles/pages/daily-ops.css` — all `.do-*` classes
