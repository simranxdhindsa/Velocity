# Board, List & Sprint Dashboard

## Kanban Board (`BoardPage.tsx`)

Drag-and-drop kanban driven by the active PM source. Columns derived from the live workflow config — never hardcoded. Issues fetched via `pmDataService.ts`.

### Top bar (`components/board/BoardToolbar.tsx`)

`BoardPage.tsx` holds the state and filtering; `BoardToolbar.tsx` renders the header and filter row (plus `BoardToolbarSkeleton`). Types and pure helpers live in `board-filters.ts` (`SortKey`, `SwimlaneBy`, `buildFilterOptions`, `NO_SUBSYSTEM`). Styles are the "Board toolbar" block at the bottom of `styles/pages/board.css`.

- **Header:** "Board" title with a labelled count under it (`58 tickets`, `12 of 58 tickets` when filtered, `58+` while some columns still have tickets to load) and the sprint name. The count is the tickets loaded on the board, not a project total. No source badge; the Refresh tooltip names the source.
- **Filter row, left:** Search, Assignee, Priority, Subsystem, Clear filters. These narrow the board.
- **Filter row, right:** Group by, Sort. These change the layout only.
- **Menus:** one menu open at a time, closed by outside click or Esc. Every option shows how many loaded tickets match it, menus with more than 7 options get a search box, and long lists scroll.

### Dynamic Subsystem filter

Multi-select, never hardcoded. Options are the project's configured subsystems (`getYouTrackFormMeta().subsystems`, with their colours, in the project's order) plus any subsystem found on the loaded tickets that the project list does not know. Tickets without one are filterable as `No subsystem`. The filter hides itself when no subsystem exists (for example on Asana).

### Group by

Assignee, Priority, Subsystem, or the board's own swimlane field (`Board`). Subsystem is hidden from the menu when the board's own swimlane field is already Subsystem, because that option keeps the board's lane order.

Grouped lanes are built from `getColumnIssues(col)`, so Search, Assignee, Priority and Subsystem filters and the sort all apply inside lanes, and lanes with no matching tickets disappear. Earlier the lanes were built from the raw issue list, which ignored every filter while grouping was on.

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
