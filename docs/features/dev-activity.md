# Dev Activity Page — 5 Subtabs

## Overview

`frontend/src/pages/DevActivityPage.tsx` — tracks developer activity via issue state transitions (stints). Driven by `api.getIssueTimelines()`.

## Subtabs

| ID | Label | Description |
|---|---|---|
| `report` | Dev Report | Skeuomorphic completion report builder — select devs + date range, generates a printed-ledger-style results table |
| `feed` | Activity Feed | Per-developer accordion with ticket rows, journey chains, and expanded state history |
| `cards` | Developer Cards | Bento grid — one card per dev with KPI chips, progress bar, ticket list |
| `log` | Transition Log | Audit table of all state transitions, exportable, groupable by dev or date |
| `heatmap` | Lifecycle Heatmap | Grid of dev × state, coloured by hours; bottleneck bar chart below |

Active subtab persisted via `PERSIST.DEV_ACTIVITY_VIEW`.

## CSS Files (one per subtab)

| File | Subtab |
|---|---|
| `styles/pages/dev-activity-base.css` | Shared: shell, tabs, filter bar, KPI chips, state badges, avatar, empty state |
| `styles/pages/dev-activity-report.css` | Dev Report — skeuomorphic `.dr-*` classes (baize desk, parchment form, 3D buttons) |
| `styles/pages/dev-activity-feed.css` | Activity Feed — `.da-feed-*`, `.da-dev-section`, `.da-ticket-row`, `.da-history-*` |
| `styles/pages/dev-activity-cards.css` | Developer Cards — `.da-cards-scroll`, `.da-dev-card`, `.da-card-*` |
| `styles/pages/dev-activity-log.css` | Transition Log — `.da-log-*`, `.da-export-btn`, `.da-group-toggle-*` |
| `styles/pages/dev-activity-heatmap.css` | Lifecycle Heatmap — `.da-heatmap-*`, `.da-bottleneck-*` |

## Dev Report — Skeuomorphic Design

- **Background**: Dark baize felt desk / warm linen (light mode)
- **Panel**: Aged parchment with metallic binding bar (thick transparent `border-top` + layered `background` gradients)
- **Dev pills**: 3D raised keyboard chips — `box-shadow` top highlight + bottom face; `selected` state presses inward (`translateY(1px)` + inset shadow)
- **Generate button**: Full 3D push button — `0 6px 0 #1e1860` bottom face, `translateY(4px)` on `:active`
- **Results view**: Printed ledger — horizontal ruled lines via `repeating-linear-gradient`, manila folder-tab dev headers, embossed index card stat chips

## Data

`api.getIssueTimelines(sinceMs, untilMs)` — returns `IssueTimeline[]` with stints, bounce counts, total hours. Each stint = one In Progress period + the state it exited to.
