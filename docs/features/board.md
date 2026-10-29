# Board, List & Sprint Dashboard

## Kanban Board (`BoardPage.tsx`)

Drag-and-drop kanban driven by the active PM source. Columns derived from the live workflow config — never hardcoded. Issues fetched via `pmDataService.ts`.

## List View (`ListViewPage.tsx`)

Flat table of sprint issues. Same data source as the board, different layout. Sortable and filterable.

## Sprint Dashboard (`SprintDashboardPage.tsx`)

5 design modes selectable via the mode switcher:

| Mode | Description |
|---|---|
| Velocity | Sprint velocity chart |
| Bento Grid | Bento-style metric cards |
| Ops Command | Ops-style command view |
| Sprint Velocity | Velocity over multiple sprints |
| Burndown | Burndown chart |

`DesignMode` type and `DESIGN_MODES` array defined at the top of `SprintDashboardPage.tsx`.

Velocity and Burndown views embed `VelocityTab`/`BurndownTab` from `PMFeatureTabs.tsx` — see [`pm-reports.md`](pm-reports.md) for details on those components.

## Data Flow

All three views use `getActiveSource()` from `pmDataService.ts` to route API calls to the correct backend namespace (`/api/youtrack/*` or `/api/asana/pm/*`).
