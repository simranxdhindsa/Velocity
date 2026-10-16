// ── Gantt chart types & pure helpers ─────────────────────────────────────────

export interface GanttIssue {
  id: string
  memberId: string   // YT gantt member ID (used for API updates)
  idReadable: string
  summary: string
  assignee: string
  avatarUrl: string
  state: string
  priority: string
  startDate: number | null  // Unix ms (from gantt member)
  dueDate: number | null    // Unix ms (startDate + estimation*60 000)
  estimation: number        // minutes
}

export interface GanttChartSummary {
  id: string
  name: string
}

export interface GanttDependency {
  sourceId: string  // gantt member ID of the prerequisite
  targetId: string  // gantt member ID of the dependent
}

export type GanttView = 'day' | 'week' | 'month'

// Pixels per day for each view
export const DAY_PX: Record<GanttView, number> = { day: 100, week: 44, month: 16 }

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Start of day in local time, returned as a Date */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Add N days to a date */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

/** Difference in whole days (b - a), floored */
export function diffDays(a: Date, b: Date): number {
  const msPerDay = 86_400_000
  return Math.floor((startOfDay(b).getTime() - startOfDay(a).getTime()) / msPerDay)
}

/** Format a date as "Mon 2" (day view) or "2" (month view) */
export function fmtDayLabel(d: Date, view: GanttView): string {
  if (view === 'month') return String(d.getDate())
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const name = view === 'week' ? days[d.getDay()].slice(0, 2) : days[d.getDay()]
  return `${name} ${d.getDate()}`
}

/** Format a date as "Jun 2026" for month headers */
export function fmtMonth(d: Date): string {
  return d.toLocaleString('default', { month: 'short', year: 'numeric' })
}

/** Format a date as "Week 27" for week grouping label */
export function fmtWeek(d: Date): string {
  // ISO week number
  const tmp = new Date(d)
  tmp.setHours(0, 0, 0, 0)
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7))
  const week1 = new Date(tmp.getFullYear(), 0, 4)
  const wn = 1 + Math.round(((tmp.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
  return `Wk ${wn}`
}

/** Returns true if a date is a weekend */
export function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6
}

/** Convert Unix ms to local midnight Date */
export function msToDate(ms: number): Date {
  return startOfDay(new Date(ms))
}

/** Convert a local midnight Date to Unix ms */
export function dateToMs(d: Date): number {
  return startOfDay(d).getTime()
}

// ── Bar position helpers ──────────────────────────────────────────────────────

export interface BarRect {
  left: number
  width: number
}

export function barRect(
  startMs: number | null,
  dueMs: number | null,
  viewStart: Date,
  dayPx: number
): BarRect | null {
  if (!startMs && !dueMs) return null
  const s = startMs ? msToDate(startMs) : msToDate(dueMs!)
  const e = dueMs ? msToDate(dueMs) : msToDate(startMs!)
  const left = diffDays(viewStart, s) * dayPx
  const width = Math.max((diffDays(s, e) + 1) * dayPx, dayPx)
  return { left, width }
}

// ── Priority → colour ─────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, string> = {
  critical:  'var(--color-danger)',
  blocker:   'var(--color-danger)',
  major:     'var(--color-warning)',
  normal:    'var(--color-primary)',
  minor:     'var(--color-success)',
  trivial:   'var(--text-muted)',
}

export function priorityColor(p: string): string {
  return PRIORITY_COLORS[p.toLowerCase()] ?? 'var(--color-primary)'
}

// ── Workflow role → colour (bars, status badges) ─────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  active:   'var(--color-primary)',
  dev_done: 'var(--color-info)',
  verified: 'var(--color-success)',
  deployed: 'var(--color-success)',
  blocked:  'var(--color-danger)',
  findings: 'var(--color-warning)',
}

export function roleColor(role: string): string {
  return ROLE_COLORS[role] ?? 'var(--text-muted)'
}

const DONE_ROLES = new Set(['dev_done', 'verified', 'deployed'])

/** How far along a ticket is, from its workflow role: done columns are 100,
 *  in-progress tickets show the share of their scheduled window already
 *  elapsed (capped below 100), everything else 0. */
export function issueProgress(issue: GanttIssue, role: string, now = Date.now()): number {
  if (DONE_ROLES.has(role)) return 100
  if (role !== 'active' || !issue.startDate || !issue.dueDate) return 0
  const span = issue.dueDate + 86_400_000 - issue.startDate
  if (span <= 0) return 0
  return Math.round(Math.min(95, Math.max(5, ((now - issue.startDate) / span) * 100)))
}

// ── Rows: one collapsible group per workflow state ───────────────────────────

export interface GanttGroupRow {
  kind: 'group'
  key: string
  label: string
  role: string
  count: number
  progress: number
  startDate: number | null
  dueDate: number | null
  collapsed: boolean
}

export interface GanttIssueRow {
  kind: 'issue'
  issue: GanttIssue
  role: string
  progress: number
}

export type GanttRow = GanttGroupRow | GanttIssueRow

/** Groups issues by state, ordered by the workflow column rank (unknown
 *  states last). Closed tickets are left out, like every PM view. */
export function buildRows(
  issues: GanttIssue[],
  roleOf: (state: string) => string,
  rankOf: (state: string) => number,
  collapsed: Set<string>,
): GanttRow[] {
  const groups = new Map<string, GanttIssue[]>()
  for (const is of issues) {
    const state = is.state || 'No state'
    if (roleOf(state) === 'closed') continue
    const list = groups.get(state)
    if (list) list.push(is)
    else groups.set(state, [is])
  }
  const keys = [...groups.keys()].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))
  const rows: GanttRow[] = []
  for (const key of keys) {
    const list = groups.get(key)!
    const role = roleOf(key)
    const items = list.map(issue => ({ kind: 'issue' as const, issue, role, progress: issueProgress(issue, role) }))
    const starts = list.map(i => i.startDate ?? i.dueDate).filter((v): v is number => !!v)
    const ends = list.map(i => i.dueDate ?? i.startDate).filter((v): v is number => !!v)
    rows.push({
      kind: 'group', key, label: key, role, count: list.length,
      progress: Math.round(items.reduce((s, r) => s + r.progress, 0) / items.length),
      startDate: starts.length ? Math.min(...starts) : null,
      dueDate: ends.length ? Math.max(...ends) : null,
      collapsed: collapsed.has(key),
    })
    if (!collapsed.has(key)) rows.push(...items)
  }
  return rows
}

export function rowKey(r: GanttRow): string {
  return r.kind === 'group' ? `g:${r.key}` : r.issue.memberId
}

/** "W42 Oct 12 - 18" for the Monday-to-Sunday week starting at `mon`. */
export function fmtWeekRange(mon: Date): string {
  const sun = addDays(mon, 6)
  const m = (d: Date) => d.toLocaleString('default', { month: 'short' })
  const end = sun.getMonth() === mon.getMonth() ? String(sun.getDate()) : `${m(sun)} ${sun.getDate()}`
  return `${fmtWeek(mon).replace('Wk ', 'W')} ${m(mon)} ${mon.getDate()} - ${end}`
}
