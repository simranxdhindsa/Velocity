# Daily Ops — Design Views

Six visual views added to the Daily Ops tab alongside the original Developer Load view. All views read from the same `devStats` data (derived from `DailyOpsTab.tsx`) via the `DevStatLike` interface exported from `DailyOpsViews.tsx`.

## Tab switcher

Implemented in `DailyOpsTab.tsx`. The active view is persisted with `usePersistedState(PERSIST.DAILY_OPS_VIEW, 'load')`. Valid keys: `load | rings | mission | stuck | hotfix | strips | snapshot`.

The tab bar is a horizontal scroll row on mobile (`flex-wrap: nowrap; overflow-x: auto`) so all 7 tabs stay accessible without wrapping.

## Data model

All views receive `devStats: DevStatLike[]`. `DevStatLike` mirrors the `DevStat` interface in `DailyOpsTab.tsx` but is defined separately in `DailyOpsViews.tsx` to avoid circular imports.

The `adaptDev()` function converts `DevStatLike` + `SprintBoardIssue` fields to the internal `OpsDev` / `OpsIssue` types used by the view components.

Key field mappings:

| SprintBoardIssue field | OpsIssue field |
|---|---|
| `idReadable` | `id` |
| `hours_in_state` | `hoursInState` |
| `is_hotfix` | `isHotfix` |
| `since_date` (formatted) | `since` (blocked), `timestamp` (done-today) |
| `total_active_hours` | `hoursSpent` |

Developer color is a deterministic hash of the name into one of 6 palette colors — not stored in the DB.

## Stuck thresholds

```
WATCH  = 8h   — muted blue dot/fill
WARN   = 16h  — amber
DANGER = 48h  — red + pulsing glow
```

These constants (`WATCH`, `WARN`, `DANGER`) are defined at the top of `DailyOpsViews.tsx`.

## Views

### 1 — Developer Load (`load`)
Original view. Per-developer cards with stat chips, progress bar, inline issue lists for Done Today / In Progress / Blocked / To Do. Clickable chips open a modal with the full ticket list.

### 2 — Health Rings (`rings`)
SVG arc ring per developer. Ring color = overall status (green = on track, amber = overdue, red = blocked). Gap dashes in the ring = number of blocked tickets. Amber/red dots on the ring = stuck tickets. Center shows a mini bar-chart or ⊘ symbol.

**CSS class:** `ops-grid-rings` — responsive grid (1 col mobile, 2 col tablet, auto-fill desktop).

### 3 — Mission Control (`mission`)
Mission-card per developer with a status word (BLOCKED / STUCK / SHIPPING / IN PROGRESS), a donut chart, and a timeline activity strip. Cards with blockers pulse red. Cards shipping today glow green.

**CSS class:** `ops-grid-mission` — responsive grid (1 col mobile, 2 col tablet, auto-fill desktop).

### 4 — Stuck Detector (`stuck`)
Full-width list sorted by time-in-state, sectioned into DANGER / WARNING / WATCH. Each row has a background fill bar proportional to hours. Hides dev name and state badge on mobile to prevent overflow.

**CSS classes:** `ops-stuck-container`, `ops-stuck-name` (hidden ≤768px), `ops-stuck-state-badge` (hidden ≤768px).

### 5 — Hotfix Command (`hotfix`)
Lists only tickets where `isHotfix === true` or `isRegression === true`, sorted by urgency (blocked first, then overdue, active, done). Each card shows an age progress bar. Shows "All Clear" state when no hotfixes exist.

**CSS class:** `ops-hotfix-container`.

### 6 — Pulse Strips (`strips`)
One horizontal strip per developer representing their entire day. Each segment's width is proportional to time spent; color encodes status (green=done, blue=active, amber=stuck 16h+, red=blocked/48h+, hatched=queued). Urgent ticket chips appear below the strip.

**CSS class:** `ops-strips-container`.

### 7 — Snapshot Grid (`snapshot`)
Compact dot-cluster cards — one per developer. Dots represent individual tickets, colored by state. A mini progress bar shows done %. Done-today checkmarks appear at the bottom. Sorted by urgency rank (blocked first).

**CSS class:** `ops-grid-snapshot` — responsive (2 col mobile, 3 col tablet, auto-fill desktop).

## Responsive breakpoints

| Breakpoint | Rings/Mission | Snapshot | Tab bar |
|---|---|---|---|
| ≤768px (mobile) | 1 column | 2 columns | horizontal scroll |
| 769–1024px (tablet) | 2 columns | 3 columns | horizontal scroll |
| ≥1025px (desktop) | auto-fill (3–5 per row) | auto-fill | wraps naturally |

## Animation

Uses `framer-motion` (package: `framer-motion ^12.38.0`). Import from `'framer-motion'`, not `'motion/react'`.

Key patterns:
- `variants={{ hidden: { opacity: 0, y: 20 }, show: { ... } }}` + stagger on the grid container
- `animate={{ boxShadow: ['0 0 0px ...', '0 0 18px ...', '0 0 0px ...'] }}` + `repeat: Infinity` for critical glow loops
- `strokeDashoffset` spring animation for SVG rings
