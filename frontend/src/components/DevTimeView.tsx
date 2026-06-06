import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import type { IssueTimeline, IssueStint, SprintBoardIssue } from '../services/api'

// ── Types ─────────────────────────────────────────────────────────────────────

export type DevTimeVariant = 'a' | 'b' | 'c'

export interface DevTimeViewProps {
  timelines: IssueTimeline[]
  variant: DevTimeVariant
  onTicketClick: (issueId: string) => void
  ytBaseUrl: string
  sprintStartMs?: number
  sprintFinishMs?: number
  boardIssues?: SprintBoardIssue[]
}

interface DevStat {
  name: string
  totalHours: number
  tickets: number
  bounced: number
  live: number
  overdue: number
  color: string
  initials: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEV_COLORS = ['#6366f1', '#ec4899', '#06b6d4', '#a855f7', '#f59e0b', '#10b981', '#f97316', '#14b8a6']

function devColor(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  return DEV_COLORS[Math.abs(h) % DEV_COLORS.length]
}

function initials(name: string): string {
  return name.split(' ').map(p => p[0] ?? '').join('').slice(0, 2).toUpperCase()
}

function roundH(h: number): number {
  return Math.round(h * 10) / 10
}

function fmtHours(h: number | null): string {
  if (h === null || h === undefined) return 'live'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h >= 24) {
    const days = Math.floor(h / 24)
    const hrs = Math.floor(h % 24)
    return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`
  }
  const hrs = Math.floor(h)
  const mins = Math.round((h - hrs) * 60)
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function slaStatus(t: IssueTimeline): 'overdue' | 'warning' | 'ok' {
  const ratio = t.total_hours / t.threshold_hours
  if (ratio >= 1.0) return 'overdue'
  if (ratio >= 0.8) return 'warning'
  return 'ok'
}

function clipToSprintWindow(timelines: IssueTimeline[], startMs: number, endMs: number): IssueTimeline[] {
  const nowMs = Date.now()
  const result: IssueTimeline[] = []

  for (const t of timelines) {
    const clipped: IssueStint[] = []

    for (const s of t.stints) {
      const sStart = new Date(s.entered_at).getTime()
      const sEnd   = s.exited_at ? new Date(s.exited_at).getTime() : nowMs
      if (sStart >= endMs || sEnd <= startMs) continue
      const cStart = Math.max(sStart, startMs)
      const cEnd   = Math.min(sEnd, endMs)
      clipped.push({ ...s, duration_hours: (cEnd - cStart) / 3_600_000 })
    }

    if (clipped.length === 0) continue

    const totalHours = roundH(clipped.reduce((sum, s) => sum + (s.duration_hours ?? 0), 0))
    result.push({
      ...t,
      stints:       clipped,
      total_stints: clipped.length,
      total_hours:  totalHours,
      is_overdue:   totalHours >= t.threshold_hours,
    })
  }

  return result
}

// Cross-reference timelines against the live board data to fix stale is_live flags.
// Two cases handled:
//   1. Ticket IS on the board but in a non-InProgress state (e.g. Verified, Done) → close open stint
//   2. Ticket is NOT on the board at all (e.g. from a previous sprint) → also close open stint
// If it were truly live it would appear in an In Progress column on the current board.
function reconcileWithBoard(timelines: IssueTimeline[], boardIssues: SprintBoardIssue[]): IssueTimeline[] {
  const boardMap = new Map<string, SprintBoardIssue>()
  const allBoardIds = new Set<string>()
  for (const b of boardIssues) {
    boardMap.set(b.idReadable, b)
    boardMap.set(b.id, b)
    allBoardIds.add(b.idReadable)
    allBoardIds.add(b.id)
  }

  const closeStint = (t: IssueTimeline, resolvedState: string): IssueTimeline => {
    const closedStints = t.stints.map(s => {
      if (!s.exited_at) {
        const exitMs  = new Date(t.last_activity_at).getTime()
        const enterMs = new Date(s.entered_at).getTime()
        return {
          ...s,
          exited_at:      t.last_activity_at,
          exited_to:      resolvedState,
          duration_hours: Math.max(0, (exitMs - enterMs) / 3_600_000),
        }
      }
      return s
    })
    const totalHours = roundH(closedStints.reduce((sum, s) => sum + (s.duration_hours ?? 0), 0))
    return { ...t, stints: closedStints, total_hours: totalHours, is_live: false, live_hours: 0, is_overdue: totalHours >= t.threshold_hours }
  }

  return timelines.map(t => {
    if (!t.is_live) return t

    const board = boardMap.get(t.issue_id)

    if (board) {
      // On the board — check if it's still actually In Progress
      const inProgress = board.current_state.toLowerCase().includes('in progress')
      if (!inProgress) return closeStint(t, board.current_state)
    } else {
      // Not on the board at all → ticket is from a different sprint or was removed; not live
      return closeStint(t, 'Done')
    }

    return t
  })
}

function buildDevStats(timelines: IssueTimeline[]): Record<string, DevStat> {
  const map: Record<string, DevStat> = {}
  for (const t of timelines) {
    if (!map[t.assignee]) {
      map[t.assignee] = {
        name: t.assignee, totalHours: 0, tickets: 0, bounced: 0, live: 0, overdue: 0,
        color: devColor(t.assignee), initials: initials(t.assignee),
      }
    }
    const d = map[t.assignee]
    d.totalHours = roundH(d.totalHours + t.total_hours)
    d.tickets++
    if (t.moved_back_count > 0) d.bounced++
    if (t.is_live) d.live++
    if (t.is_overdue) d.overdue++
  }
  return map
}

function buildSprintStats(timelines: IssueTimeline[]) {
  const raw = timelines.reduce((s, t) => s + t.total_hours, 0)
  const totalHours = roundH(raw)
  const withBounces = timelines.filter(t => t.moved_back_count > 0).length
  const live = timelines.filter(t => t.is_live).length
  const avgPerTicket = timelines.length > 0 ? roundH(raw / timelines.length) : 0
  return { totalHours, withBounces, live, avgPerTicket }
}

function getDevList(timelines: IssueTimeline[]): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const t of timelines) {
    if (!seen.has(t.assignee)) { seen.add(t.assignee); list.push(t.assignee) }
  }
  return list
}

// ── Shared atoms ──────────────────────────────────────────────────────────────

const SORT_OPTS = [
  { value: 'time-desc',    label: 'Time ↓' },
  { value: 'bounces-desc', label: 'Bounces ↓' },
  { value: 'assignee-az', label: 'Assignee A–Z' },
]

function SortDropdown({ sort, setSort }: { sort: string; setSort: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = SORT_OPTS.find(o => o.value === sort) ?? SORT_OPTS[0]

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="pm-custom-dropdown pm-tt-sort-dropdown" ref={ref}>
      <button className="pm-custom-dropdown-trigger" onClick={() => setOpen(o => !o)}>
        {current.label} <ChevronDown size={12} />
      </button>
      {open && (
        <div className="pm-custom-dropdown-menu">
          {SORT_OPTS.map(o => (
            <div key={o.value} className="pm-custom-dropdown-item" onClick={() => { setSort(o.value); setOpen(false) }}>
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function KPIBar({ timelines, right }: { timelines: IssueTimeline[]; right?: React.ReactNode }) {
  const s = buildSprintStats(timelines)
  const chips = [
    { cls: 'pm-tt-kpi-value--total',  val: `${s.totalHours}h`, label: 'Total Dev Hours' },
    { cls: 'pm-tt-kpi-value--avg',    val: `${s.avgPerTicket}h`, label: 'Avg / Ticket' },
    { cls: 'pm-tt-kpi-value--bounce', val: s.withBounces, label: 'With Bounces' },
    { cls: 'pm-tt-kpi-value--live',   val: s.live, label: 'Currently Live' },
  ]
  return (
    <div className="pm-tt-kpi-bar">
      {chips.map((c, i) => (
        <div key={i} className="pm-tt-kpi-chip" style={{ animationDelay: `${i * 60}ms` }}>
          <span className={`pm-tt-kpi-value ${c.cls}`}>{c.val}</span>
          <span className="pm-tt-kpi-label">{c.label}</span>
        </div>
      ))}
      {right}
    </div>
  )
}

function Avatar({ name, size }: { name: string; size: 'sm' | 'md'; isLive?: boolean }) {
  const color = devColor(name)
  const init = initials(name)
  return (
    <div
      className={`pm-tt-avatar pm-tt-avatar--${size}`}
      style={{ background: `linear-gradient(135deg, ${color}, ${color}88)` }}
    >
      {init}
    </div>
  )
}

function AvatarLive({ name }: { name: string }) {
  const color = devColor(name)
  const init = initials(name)
  return (
    <div className="pm-tt-avatar pm-tt-avatar--md" style={{ background: `linear-gradient(135deg, ${color}, ${color}88)` }}>
      {init}
      <div className="pm-tt-pulse-ring pm-tt-pulse-ring--outer" />
      <div className="pm-tt-pulse-ring pm-tt-pulse-ring--2" />
    </div>
  )
}

function IssueBadge({ id, ytBaseUrl }: { id: string; ytBaseUrl: string }) {
  return (
    <span
      className="pm-tt-issue-id"
      onClick={e => { e.stopPropagation(); if (ytBaseUrl) window.open(`${ytBaseUrl}/issue/${id}`, '_blank') }}
    >
      {id}
    </span>
  )
}

function PriBadge({ priority }: { priority: string }) {
  return (
    <span className="pm-tt-pri-badge" data-pri={priority}>{priority}</span>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// VARIANT A — Time Ledger (dense table)
// ══════════════════════════════════════════════════════════════════════════════

function ATimeBar({ t, maxHours }: { t: IssueTimeline; maxHours: number }) {
  const status = slaStatus(t)
  const pct = Math.min((t.total_hours / maxHours) * 100, 100)
  return (
    <div className="pm-tt-a-time-col">
      <span
        className="pm-tt-time-value"
        data-sla={t.is_overdue ? 'overdue' : status}
        data-live={String(t.is_live)}
      >
        {fmtHours(t.total_hours)}
      </span>
      <div className="pm-tt-time-bar-track">
        <div
          className="pm-tt-time-bar-fill"
          data-sla={status}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function AStintsTable({ stints }: { stints: IssueStint[] }) {
  return (
    <div className="pm-tt-a-stints-table">
      <div className="pm-tt-a-stints-head">
        {['#', 'Entered', 'Exited To', 'Duration', 'Regress', 'By'].map(h => (
          <span key={h} className="pm-tt-a-stints-head-cell">{h}</span>
        ))}
      </div>
      {stints.map(s => (
        <div key={s.stint_number} className="pm-tt-a-stint-row">
          <span className="pm-tt-a-stint-num">S{s.stint_number}</span>
          <span className="pm-tt-a-stint-date">{fmtDate(s.entered_at)}</span>
          <span className="pm-tt-a-stint-dest" data-live={String(!s.exited_at)}>
            {s.exited_to || (!s.exited_at ? '🟢 live' : '—')}
          </span>
          <span className="pm-tt-a-stint-dur" data-live={String(s.duration_hours === null)}>
            {s.duration_hours !== null ? fmtHours(s.duration_hours) : 'ongoing'}
          </span>
          <span>
            {s.moved_back && <span className="pm-tt-moved-back">↩ bounce</span>}
          </span>
          <span className="pm-tt-a-stint-by">{s.moved_by.split(' ')[0]}</span>
        </div>
      ))}
    </div>
  )
}

function ATicketRow({
  t, maxHours, expanded, onToggle, onTitleClick, ytBaseUrl,
}: {
  t: IssueTimeline; maxHours: number; expanded: boolean
  onToggle: () => void; onTitleClick: () => void; ytBaseUrl: string
}) {
  const rowStatus = t.is_overdue ? 'overdue' : t.is_live ? 'live' : 'done'
  return (
    <>
      <div
        className="pm-tt-a-ticket-row"
        data-live={String(t.is_live)}
        data-overdue={String(t.is_overdue)}
        onClick={onToggle}
      >
        <span className="pm-tt-a-expand-chevron" data-expanded={String(expanded)}>▶</span>
        <IssueBadge id={t.issue_id} ytBaseUrl={ytBaseUrl} />
        <PriBadge priority={t.priority} />
        <span
          className="pm-tt-a-summary"
          onClick={e => { e.stopPropagation(); onTitleClick() }}
        >
          {t.issue_summary}
        </span>
        <ATimeBar t={t} maxHours={maxHours} />
        <span
          className="pm-tt-a-stints-col"
          data-bounced={String(t.total_stints > 1)}
        >
          {t.total_stints}×
        </span>
        <div className="pm-tt-a-status-col">
          {t.is_live && <span className="pm-tt-live-dot" />}
          <span className="pm-tt-a-status-text" data-status={rowStatus}>
            {rowStatus}
          </span>
        </div>
      </div>
      {expanded && <AStintsTable stints={t.stints} />}
    </>
  )
}

function ADevRow({ name, stats }: { name: string; stats: DevStat }) {
  const chips = [
    { val: fmtHours(stats.totalHours), color: 'var(--color-primary-light)', label: 'total' },
    { val: stats.tickets,              color: 'var(--text-muted)',           label: 'tickets' },
    { val: stats.bounced,              color: 'var(--dt-bounce)',             label: 'bounced' },
    { val: stats.live,                 color: 'var(--color-success)',         label: 'live' },
  ]
  return (
    <div className="pm-tt-a-dev-row">
      <Avatar name={name} size="sm" />
      <span className="pm-tt-a-dev-name">{name}</span>
      <div className="pm-tt-a-dev-chips">
        {chips.map(c => (
          <span key={c.label} className="pm-tt-a-dev-chip">
            <span style={{ color: c.color }}>{c.val}</span>
            <span className="pm-tt-a-dev-chip-label">{c.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function VariantA({ timelines, onTicketClick, ytBaseUrl }: Omit<DevTimeViewProps, 'variant'>) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [sort, setSort] = useState('time-desc')
  const devStats = buildDevStats(timelines)
  const devList = getDevList(timelines)
  const maxHours = Math.max(...timelines.map(t => t.total_hours), 1)

  const sortedDevs = sort === 'assignee-az' ? [...devList].sort() : devList

  function sortTickets(tickets: IssueTimeline[]) {
    if (sort === 'time-desc')    return [...tickets].sort((a, b) => b.total_hours - a.total_hours)
    if (sort === 'bounces-desc') return [...tickets].sort((a, b) => b.moved_back_count - a.moved_back_count)
    return tickets
  }

  return (
    <>
      <KPIBar timelines={timelines} right={<SortDropdown sort={sort} setSort={setSort} />} />

      {/* Table header */}
      <div className="pm-tt-a-thead">
        {(['', 'ID', 'Pri', 'Summary', 'Active Time', 'Stints', 'Status'] as const).map((h, i) => (
          <span
            key={i}
            className="pm-tt-a-thead-cell"
            style={i === 4 ? { textAlign: 'right' } : i === 5 ? { textAlign: 'center' } : undefined}
          >{h}</span>
        ))}
      </div>

      <div className="pm-tt-a-body">
        {sortedDevs.map(name => {
          const tickets = sortTickets(timelines.filter(t => t.assignee === name))
          if (!tickets.length) return null
          const stats = devStats[name]
          return (
            <React.Fragment key={name}>
              <ADevRow name={name} stats={stats} />
              {tickets.map(t => (
                <ATicketRow
                  key={t.issue_id}
                  t={t}
                  maxHours={maxHours}
                  expanded={!!expanded[t.issue_id]}
                  onToggle={() => setExpanded(e => ({ ...e, [t.issue_id]: !e[t.issue_id] }))}
                  onTitleClick={() => onTicketClick(t.issue_id)}
                  ytBaseUrl={ytBaseUrl}
                />
              ))}
            </React.Fragment>
          )
        })}
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// VARIANT B — Dev Cards
// ══════════════════════════════════════════════════════════════════════════════

function BTimeBar({ t, maxHours }: { t: IssueTimeline; maxHours: number }) {
  const status = slaStatus(t)
  const totalPct = Math.min((t.total_hours / maxHours) * 100, 100)
  const firstStintH = t.stints[0]?.duration_hours ?? t.total_hours
  const bounceH = Math.max(0, t.total_hours - firstStintH)
  const bouncePct = Math.min((bounceH / maxHours) * 100, totalPct)
  const workPct = totalPct - bouncePct
  const slaMarker = Math.min((t.threshold_hours / maxHours) * 100, 100)

  return (
    <div className="pm-tt-b-time-bar-wrap">
      <div className="pm-tt-b-time-bar-track">
        <div className="pm-tt-b-time-bar-inner">
          <div
            className="pm-tt-b-time-bar-work"
            data-sla={status}
            style={{
              width: `${workPct}%`,
              borderRadius: bouncePct > 0 ? '99px 0 0 99px' : 99,
            }}
          />
          {bouncePct > 0 && (
            <div className="pm-tt-b-time-bar-bounce" style={{ width: `${bouncePct}%` }} />
          )}
        </div>
        <div className="pm-tt-b-time-bar-sla" style={{ left: `${slaMarker}%` }} />
      </div>
    </div>
  )
}

function BStintTimeline({ stints }: { stints: IssueStint[] }) {
  return (
    <div className="pm-tt-b-stint-timeline">
      {stints.map(s => (
        <div key={s.stint_number} className="pm-tt-b-stint-row">
          <div className="pm-tt-b-stint-num" data-live={String(!s.exited_at)}>
            {s.stint_number}
          </div>
          <span className="pm-tt-b-stint-date">{fmtDate(s.entered_at)}</span>
          <span className="pm-tt-b-stint-dest" data-live={String(!s.exited_at)}>
            → {s.exited_to || (!s.exited_at ? 'live' : '—')}
          </span>
          <span className="pm-tt-b-stint-dur" data-live={String(s.duration_hours === null)}>
            {s.duration_hours !== null ? fmtHours(s.duration_hours) : '…'}
          </span>
          {s.moved_back && <span className="pm-tt-moved-back">↩</span>}
        </div>
      ))}
    </div>
  )
}

function BTicketRow({
  t, maxHours, expanded, onToggle, onTitleClick, ytBaseUrl,
}: {
  t: IssueTimeline; maxHours: number; expanded: boolean
  onToggle: () => void; onTitleClick: () => void; ytBaseUrl: string
}) {
  const timeStatus = t.is_overdue ? 'overdue' : t.is_live ? 'live' : 'ok'
  return (
    <>
      <div
        className="pm-tt-b-ticket-row"
        data-live={String(t.is_live)}
        data-overdue={String(t.is_overdue)}
        onClick={onToggle}
      >
        <span className="pm-tt-a-expand-chevron" data-expanded={String(expanded)}>▶</span>
        <IssueBadge id={t.issue_id} ytBaseUrl={ytBaseUrl} />
        <PriBadge priority={t.priority} />
        <span
          className="pm-tt-b-ticket-summary"
          onClick={e => { e.stopPropagation(); onTitleClick() }}
        >
          {t.issue_summary}
        </span>
        <BTimeBar t={t} maxHours={maxHours} />
        <span className="pm-tt-b-ticket-time" data-overdue={String(t.is_overdue)} data-live={String(t.is_live)} data-status={timeStatus}>
          {fmtHours(t.total_hours)}
        </span>
        {t.total_stints > 1 && (
          <span className="pm-tt-bounce-chip">{t.total_stints}×</span>
        )}
        {t.is_live && <span className="pm-tt-live-dot" />}
      </div>
      {expanded && <BStintTimeline stints={t.stints} />}
    </>
  )
}

function BDevCard({
  name, tickets, maxHours, sort, onTicketClick, ytBaseUrl,
}: {
  name: string; tickets: IssueTimeline[]; maxHours: number; sort: string
  onTicketClick: (id: string) => void; ytBaseUrl: string
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const hasLive = tickets.some(t => t.is_live)
  const totalH = roundH(tickets.reduce((s, t) => s + t.total_hours, 0))
  const bounced = tickets.filter(t => t.moved_back_count > 0).length
  const liveCount = tickets.filter(t => t.is_live).length
  const overdue = tickets.filter(t => t.is_overdue).length
  const color = devColor(name)

  let sorted = [...tickets]
  if (sort === 'time-desc')    sorted.sort((a, b) => b.total_hours - a.total_hours)
  if (sort === 'bounces-desc') sorted.sort((a, b) => b.moved_back_count - a.moved_back_count)

  const chips = [
    { val: `${totalH}h`,       color: 'var(--color-primary-light)', label: 'total' },
    { val: tickets.length,     color: 'var(--text-muted)',           label: 'tickets' },
    { val: bounced,            color: 'var(--dt-bounce)',             label: 'bounced' },
    { val: liveCount,          color: 'var(--color-success)',         label: 'live' },
    ...(overdue > 0 ? [{ val: overdue, color: 'var(--color-danger-light)', label: 'overdue' }] : []),
  ]

  return (
    <div className="pm-tt-b-card" data-live={String(hasLive)}>
      <div className="pm-tt-b-card-header">
        {hasLive
          ? <AvatarLive name={name} />
          : <div className="pm-tt-avatar pm-tt-avatar--md" style={{ background: `linear-gradient(135deg, ${color}, ${color}88)` }}>{initials(name)}</div>
        }
        <div style={{ flex: 1 }}>
          <div className="pm-tt-b-card-name">{name}</div>
          <div className="pm-tt-b-card-chips">
            {chips.map(c => (
              <span key={c.label} className="pm-tt-b-kpi-chip">
                <span style={{ color: c.color }}>{c.val}</span>
                <span className="pm-tt-b-kpi-chip-label">{c.label}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="pm-tt-b-legend">
        <span className="pm-tt-b-legend-item">
          <span className="pm-tt-b-legend-swatch" style={{ width: 8, height: 6, background: 'var(--color-primary)', borderRadius: 99 }} />
          Work
        </span>
        <span className="pm-tt-b-legend-item">
          <span className="pm-tt-b-legend-swatch" style={{ width: 8, height: 6, background: 'var(--dt-bounce)', borderRadius: 99 }} />
          Bounce
        </span>
        <span className="pm-tt-b-legend-item">
          <span className="pm-tt-b-legend-swatch" style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.2)' }} />
          SLA limit
        </span>
      </div>

      <div className="pm-tt-b-ticket-rows">
        {sorted.map(t => (
          <BTicketRow
            key={t.issue_id}
            t={t}
            maxHours={maxHours}
            expanded={!!expanded[t.issue_id]}
            onToggle={() => setExpanded(e => ({ ...e, [t.issue_id]: !e[t.issue_id] }))}
            onTitleClick={() => onTicketClick(t.issue_id)}
            ytBaseUrl={ytBaseUrl}
          />
        ))}
      </div>
    </div>
  )
}

function VariantB({ timelines, onTicketClick, ytBaseUrl }: Omit<DevTimeViewProps, 'variant'>) {
  const [sort, setSort] = useState('time-desc')
  const devList = getDevList(timelines)
  const maxHours = Math.max(...timelines.map(t => t.total_hours), 1)
  const sortedDevs = sort === 'assignee-az' ? [...devList].sort() : devList

  return (
    <>
      <KPIBar timelines={timelines} right={<SortDropdown sort={sort} setSort={setSort} />} />
      <div className="pm-tt-b-grid">
        {sortedDevs.map(name => {
          const tickets = timelines.filter(t => t.assignee === name)
          if (!tickets.length) return null
          return (
            <BDevCard
              key={name}
              name={name}
              tickets={tickets}
              maxHours={maxHours}
              sort={sort}
              onTicketClick={onTicketClick}
              ytBaseUrl={ytBaseUrl}
            />
          )
        })}
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// VARIANT C — Timeline Gantt-Lite
// ══════════════════════════════════════════════════════════════════════════════

const PX_PER_HOUR = 4
const MAX_GANTT_LANES = 10

// Pack tickets into horizontal lanes so non-overlapping tickets share a lane.
// Returns array of lanes, each lane is an array of tickets that don't overlap.
function packLanes(tickets: IssueTimeline[], sprintStart: Date): IssueTimeline[][] {
  const now = Date.now()
  const sprintMs = sprintStart.getTime()
  const sorted = [...tickets].sort(
    (a, b) => new Date(a.first_entered_at).getTime() - new Date(b.first_entered_at).getTime()
  )
  const lanes: { ticket: IssueTimeline; endMs: number }[][] = []
  for (const ticket of sorted) {
    const startMs = Math.max(new Date(ticket.first_entered_at).getTime(), sprintMs)
    const endMs = ticket.is_live ? now : new Date(ticket.last_activity_at).getTime()
    let placed = false
    for (const lane of lanes) {
      if (startMs >= (lane[lane.length - 1]?.endMs ?? 0)) {
        lane.push({ ticket, endMs })
        placed = true
        break
      }
    }
    if (!placed && lanes.length < MAX_GANTT_LANES) {
      lanes.push([{ ticket, endMs }])
    }
  }
  return lanes.map(lane => lane.map(item => item.ticket))
}

function ganttColor(t: IssueTimeline): { bg: string; glow: string } {
  if (t.is_live)    return { bg: 'var(--color-primary)',   glow: 'rgba(99,102,241,0.5)' }
  if (t.is_overdue) return { bg: 'var(--color-danger)',    glow: 'rgba(239,68,68,0.4)' }
  const ratio = t.total_hours / t.threshold_hours
  if (ratio >= 0.8) return { bg: 'var(--color-warning)',   glow: 'rgba(245,158,11,0.4)' }
  return               { bg: 'var(--color-success)',  glow: 'rgba(34,197,94,0.35)' }
}

function CPill({
  t, yOffset, sprintStart, onTitleClick,
}: {
  t: IssueTimeline; yOffset: number; sprintStart: Date; onTitleClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const { bg, glow } = ganttColor(t)
  const now = new Date()
  const sprintMs = sprintStart.getTime()

  // Clamp pill to the visible sprint window
  const ticketStartMs = new Date(t.first_entered_at).getTime()
  const effectiveStartMs = Math.max(ticketStartMs, sprintMs)
  const effectiveEndMs = t.is_live ? now.getTime() : new Date(t.last_activity_at).getTime()
  const effectiveHours = Math.max((effectiveEndMs - effectiveStartMs) / 3600000, 0.5)

  const left = Math.max(0, (effectiveStartMs - sprintMs) / 3600000) * PX_PER_HOUR
  const width = Math.max(effectiveHours * PX_PER_HOUR, 28)
  const top = yOffset * 30 + 5

  const segments = t.stints.map(s => {
    const segStartMs = Math.max(new Date(s.entered_at).getTime(), sprintMs)
    const segLeft = Math.max(0, (segStartMs - sprintMs) / 3600000 * PX_PER_HOUR - left)
    const segDurH = s.duration_hours !== null
      ? s.duration_hours
      : (now.getTime() - new Date(s.entered_at).getTime()) / 3600000
    const segW = Math.max(Math.min(segDurH * PX_PER_HOUR, width - segLeft), 4)
    return { ...s, segLeft, segW }
  })

  return (
    <>
      <div
        className="pm-tt-c-pill"
        style={{
          left,
          top,
          width,
          boxShadow: hover ? `0 0 10px ${glow}` : 'none',
        }}
        onMouseEnter={e => { setHover(true); setPos({ x: e.clientX, y: e.clientY }) }}
        onMouseMove={e => setPos({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setHover(false)}
        onClick={onTitleClick}
      >
        {t.total_stints > 1 ? (
          segments.map((s, i) => (
            <div
              key={i}
              className="pm-tt-c-pill-segment"
              style={{
                left: s.segLeft,
                width: s.segW,
                background: s.stint_number === t.total_stints && t.is_live
                  ? `linear-gradient(90deg, ${bg}, transparent)`
                  : bg,
                borderRadius: 4,
                opacity: 0.85 + i * 0.05,
              }}
            />
          ))
        ) : (
          <div
            className="pm-tt-c-pill-segment"
            style={{
              inset: 0,
              background: t.is_live ? `linear-gradient(90deg, ${bg} 60%, transparent 100%)` : bg,
            }}
          />
        )}

        {/* Bounce gap markers */}
        {t.total_stints > 1 && segments.slice(0, -1).map((s, i) => (
          <div
            key={`gap-${i}`}
            className="pm-tt-c-pill-bounce-gap"
            style={{ left: s.segLeft + s.segW + 1 }}
          />
        ))}

        {width > 52 && <span className="pm-tt-c-pill-id">{t.issue_id}</span>}
        {t.is_live && <div className="pm-tt-c-pill-live-fade" />}
      </div>

      {hover && createPortal(
        <div
          className="pm-tt-c-tooltip"
          style={{
            left: Math.min(pos.x + 12, window.innerWidth - 248),
            top: Math.max(pos.y - 10, 4),
          }}
        >
          <div className="pm-tt-c-tooltip-header">
            <span className="pm-tt-c-tooltip-dot" style={{ background: bg }} />
            <span className="pm-tt-c-tooltip-id">{t.issue_id}</span>
            <PriBadge priority={t.priority} />
          </div>
          <div className="pm-tt-c-tooltip-summary">{t.issue_summary}</div>
          <div className="pm-tt-c-tooltip-grid">
            {[
              ['Active', fmtHours(t.total_hours)],
              ['SLA', fmtHours(t.threshold_hours)],
              ['Stints', `${t.total_stints}×`],
              ['Status', t.is_live ? '● live' : t.is_overdue ? '⚠ overdue' : '✓ done'],
            ].map(([l, v]) => (
              <div key={l}>
                <div className="pm-tt-c-tooltip-label">{l}</div>
                <div className="pm-tt-c-tooltip-value">{v}</div>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

function CDevRow({
  name, tickets, sprintStart, ganttW, onTicketClick,
}: {
  name: string; tickets: IssueTimeline[]; sprintStart: Date; ganttW: number; onTicketClick: (id: string) => void
}) {
  const color = devColor(name)
  const [firstName, ...rest] = name.split(' ')
  const lastName = rest.join(' ')
  const totalH = roundH(tickets.reduce((s, t) => s + t.total_hours, 0))
  const hidden = Math.max(0, tickets.length - MAX_GANTT_LANES)

  const lanes = packLanes(tickets, sprintStart)
  const rowHeight = Math.max(lanes.length * 30 + 10, 44)

  return (
    <div className="pm-tt-c-dev-row" style={{ minHeight: rowHeight }}>
      <div className="pm-tt-c-dev-label">
        <div className="pm-tt-avatar pm-tt-avatar--sm" style={{ background: `linear-gradient(135deg, ${color}, ${color}88)` }}>
          {initials(name)}
        </div>
        <div>
          <div className="pm-tt-c-dev-first-name">{firstName}</div>
          <div className="pm-tt-c-dev-last-name">{lastName}</div>
          <div className="pm-tt-c-dev-hours">{totalH}h · {tickets.length}t</div>
          {hidden > 0 && <div className="pm-tt-c-dev-hidden">+{hidden} hidden</div>}
        </div>
      </div>
      <div className="pm-tt-c-timeline-area" style={{ minWidth: ganttW, minHeight: rowHeight }}>
        {lanes.map((lane, laneIdx) =>
          lane.map(t => (
            <CPill
              key={t.issue_id}
              t={t}
              yOffset={laneIdx}
              sprintStart={sprintStart}
              onTitleClick={() => onTicketClick(t.issue_id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function CAxisHeader({ days, ganttW, nowOffset }: { days: { label: string; x: number }[]; ganttW: number; nowOffset: number }) {
  return (
    <div className="pm-tt-c-axis-header">
      <div className="pm-tt-c-axis-dev-label">Developer</div>
      <div className="pm-tt-c-axis-track" style={{ minWidth: ganttW }}>
        {days.map((d, i) => (
          <div key={i} className="pm-tt-c-axis-day" style={{ left: d.x }}>
            <div className="pm-tt-c-axis-tick" />
            <span className="pm-tt-c-axis-day-label">{d.label}</span>
          </div>
        ))}
        {nowOffset > 0 && nowOffset < ganttW && (
          <div className="pm-tt-c-now-marker" style={{ left: nowOffset }}>
            <span className="pm-tt-c-now-label">NOW</span>
          </div>
        )}
      </div>
    </div>
  )
}

function CDetailTable({
  timelines, expanded, onToggle, onTitleClick, ytBaseUrl,
}: {
  timelines: IssueTimeline[]
  expanded: Record<string, boolean>
  onToggle: (id: string) => void
  onTitleClick: (id: string) => void
  ytBaseUrl: string
}) {
  return (
    <div className="pm-tt-c-detail-wrap">
      <div className="pm-tt-c-detail-head">
        {['', 'ID', 'Pri', 'Summary', 'Stints', 'Active', 'Status'].map((h, i) => (
          <span key={i} className="pm-tt-c-detail-head-cell">{h}</span>
        ))}
      </div>
      <div className="pm-tt-c-detail-body">
        {timelines.map(t => {
          const { bg } = ganttColor(t)
          const isExp = !!expanded[t.issue_id]
          const rowStatus = t.is_overdue ? 'overdue' : t.is_live ? 'live' : 'done'
          return (
            <React.Fragment key={t.issue_id}>
              <div
                className="pm-tt-c-detail-row"
                data-expanded={String(isExp)}
                onClick={() => onToggle(t.issue_id)}
              >
                <span className="pm-tt-a-expand-chevron" data-expanded={String(isExp)}>▶</span>
                <IssueBadge id={t.issue_id} ytBaseUrl={ytBaseUrl} />
                <PriBadge priority={t.priority} />
                <span
                  className="pm-tt-c-detail-summary"
                  onClick={e => { e.stopPropagation(); onTitleClick(t.issue_id) }}
                >
                  {t.issue_summary}
                </span>
                <span
                  className="pm-tt-c-detail-stints"
                  data-bounced={String(t.total_stints > 1)}
                >
                  {t.total_stints}×
                </span>
                <span className="pm-tt-c-detail-time" style={{ color: bg }}>
                  {fmtHours(t.total_hours)}
                </span>
                <div className="pm-tt-c-detail-status">
                  {t.is_live && <span className="pm-tt-live-dot" />}
                  <span className="pm-tt-c-detail-status-text" data-status={rowStatus}>
                    {rowStatus}
                  </span>
                </div>
              </div>
              {isExp && (
                <div className="pm-tt-c-stint-expand">
                  {t.stints.map((s, i) => (
                    <div key={s.stint_number} className="pm-tt-c-stint-row">
                      <span className="pm-tt-c-stint-num">S{s.stint_number}</span>
                      <span className="pm-tt-c-stint-date">{fmtDate(s.entered_at)}</span>
                      <span className="pm-tt-c-stint-dest" data-live={String(!s.exited_at)}>
                        → {s.exited_to || (!s.exited_at ? 'live' : '—')}
                      </span>
                      <span className="pm-tt-c-stint-dur" data-live={String(s.duration_hours === null)}>
                        {s.duration_hours !== null ? fmtHours(s.duration_hours) : '…'}
                      </span>
                      {s.moved_back && <span className="pm-tt-moved-back">↩</span>}
                    </div>
                  ))}
                </div>
              )}
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}

function VariantC({ timelines, onTicketClick, ytBaseUrl }: Omit<DevTimeViewProps, 'variant'>) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const devList = getDevList(timelines)

  // Compute sprint window — cap to last 30 days so ancient live stints don't explode the gantt
  const now = new Date()
  const maxWindow30d = now.getTime() - 30 * 24 * 3600000

  const allStarts = timelines.map(t => Math.max(new Date(t.first_entered_at).getTime(), maxWindow30d))
  const sprintStart = new Date(Math.min(...allStarts))
  sprintStart.setHours(0, 0, 0, 0)

  const sprintEnd = new Date(now)
  sprintEnd.setDate(sprintEnd.getDate() + 1)

  const totalHours = Math.ceil((sprintEnd.getTime() - sprintStart.getTime()) / 3600000)
  const ganttW = Math.max(totalHours * PX_PER_HOUR, 400)
  const nowOffset = ((now.getTime() - sprintStart.getTime()) / 3600000) * PX_PER_HOUR

  // Day axis labels
  const days: { label: string; x: number }[] = []
  const cur = new Date(sprintStart)
  while (cur <= sprintEnd) {
    days.push({
      label: cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      x: ((cur.getTime() - sprintStart.getTime()) / 3600000) * PX_PER_HOUR,
    })
    cur.setDate(cur.getDate() + 1)
  }

  const legendItems = [
    { color: 'var(--color-success)', label: 'On time' },
    { color: 'var(--color-warning)', label: 'Near SLA' },
    { color: 'var(--color-danger)',  label: 'Overdue' },
    { color: 'var(--color-primary)', label: 'Live' },
    { color: 'rgba(249,115,22,0.7)', label: 'Bounce gap' },
  ]

  return (
    <>
      <KPIBar timelines={timelines} right={
        <div className="pm-tt-c-legend">
          {legendItems.map(it => (
            <span key={it.label} className="pm-tt-c-legend-item">
              <span className="pm-tt-c-legend-swatch" style={{ background: it.color }} />
              {it.label}
            </span>
          ))}
        </div>
      } />

      <div className="pm-tt-c-body">
        <div className="pm-tt-c-gantt-scroll">
          <div style={{ minWidth: 140 + ganttW }}>
            <CAxisHeader days={days} ganttW={ganttW} nowOffset={nowOffset} />
            {devList.map(name => {
              const tickets = timelines.filter(t => t.assignee === name)
              if (!tickets.length) return null
              return (
                <CDevRow
                  key={name}
                  name={name}
                  tickets={tickets}
                  sprintStart={sprintStart}
                  ganttW={ganttW}
                  onTicketClick={onTicketClick}
                />
              )
            })}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <CDetailTable
            timelines={timelines}
            expanded={expanded}
            onToggle={id => setExpanded(e => ({ ...e, [id]: !e[id] }))}
            onTitleClick={onTicketClick}
            ytBaseUrl={ytBaseUrl}
          />
        </div>
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Root export
// ══════════════════════════════════════════════════════════════════════════════

export default function DevTimeView(props: DevTimeViewProps) {
  const { variant, sprintStartMs, sprintFinishMs, boardIssues, ...rest } = props

  // Step 1 — fix stale is_live flags using live board data (YouTrack-authoritative)
  const reconciled = boardIssues?.length
    ? reconcileWithBoard(rest.timelines, boardIssues)
    : rest.timelines

  // Step 2 — clip to sprint window
  const timelines = (sprintStartMs && sprintFinishMs)
    ? clipToSprintWindow(reconciled, sprintStartMs, sprintFinishMs)
    : reconciled

  const scoped = { ...rest, timelines }
  return (
    <div className="pm-tt-root">
      {variant === 'a' && <VariantA {...scoped} />}
      {variant === 'b' && <VariantB {...scoped} />}
      {variant === 'c' && <VariantC {...scoped} />}
    </div>
  )
}
