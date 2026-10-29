# PM Reports — Tracking Tab & Charts

## Tracking Tab (`PMReportsPage.tsx` → `TrackingTab`)

12 view modes selectable via the view switcher:

| ID | Label |
|---|---|
| `by-column` | By Column |
| `by-assignee` | By Assignee |
| `swimlane` | Swimlane |
| `sidebar` | Sidebar |
| `heatmap` | Heatmap |
| `delay-bars` | Delay Bars |
| `alert-first` | Alert First |
| `split-pane` | Split Pane |
| `focus` | Focus Mode |
| `qa-pipeline` | QA Pipeline |
| `velocity` | Velocity |
| `burndown` | Burndown |

`viewMode` state uses `usePersistedState(PERSIST.TRACKING_VIEW, ...)` — adding a new view requires extending the `validate` array there.

## Velocity Tab (`VelocityTab`)

Defined in `frontend/src/components/PMFeatureTabs.tsx`. Shared between the Tracking tab and Sprint Dashboard.

- Accepts `hideControls?: boolean` — pass it when embedding in the Sprint Dashboard to suppress the limit dropdown
- Uses `useAsync<T>` hook defined in the same file

CSS: `styles/pages/pm-features.css` (`.pmf-*` classes)

## Burndown Tab (`BurndownTab`)

Defined in `frontend/src/components/PMFeatureTabs.tsx`. Shared between the Tracking tab and Sprint Dashboard.

- Accepts `{ sprints, activeSprint }` — always uses the active sprint from the top bar, never its own sprint selector
- Ideal burndown line generated **client-side** from `sprint.start`/`sprint.finish` milliseconds so it spans the full sprint even with only one snapshot
- Snapshots stored in `pm_burndown_snapshots`, taken once per day by background job or on first load

CSS: `styles/pages/pm-features.css`
