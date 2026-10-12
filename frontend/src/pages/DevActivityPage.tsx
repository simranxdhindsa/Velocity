import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, GitBranch, Check, Download } from 'lucide-react'
import { VelocityBarsLoader, SprintScanLoader, SvgVelocityBarsLoader, SvgSprintScanLoader } from '@/components/brand/VelocityLoaders'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { usePersistedState, PERSIST } from '@/hooks/usePersistedState'
import api from '../services/api'
import { getActiveSource } from '../services/pmDataService'
import type { IssueTimeline, IssueStint, YouTrackSprint, TimeTrackingRow } from '../services/api'
import { IssueDetailPanel } from '../components/IssueDetailPanel'
import { IssueDetailSkeleton } from '../components/IssueDetailSkeleton'
import { CustomDropdown } from '../components/CustomDropdown'
import { CalendarPicker } from '../components/CalendarPicker'
import '../styles/pages/dev-activity-base.css'
import '../styles/pages/dev-activity-feed.css'
import '../styles/pages/dev-activity-cards.css'
import '../styles/pages/dev-activity-log.css'
import '../styles/pages/dev-activity-heatmap.css'
import '../styles/pages/dev-activity-report.css'
import { CountUp } from '../components/CountUp'

// ─── Constants ──────────────────────────────────────────────────────────────

const WORKFLOW_ORDER = ['To Do', 'In Progress', 'Blocked', 'DEV', 'Stage', 'Prod', 'Done']
const HEATMAP_STATES = ['To Do', 'In Progress', 'Blocked', 'DEV', 'Stage', 'Prod', 'Done']

interface StateConfig { color: string; bg: string; border: string }
const STATE_CFG: Record<string, StateConfig> = {
  'To Do':       { color: '#64748b', bg: 'rgba(100,116,139,0.15)', border: 'rgba(100,116,139,0.3)' },
  'In Progress': { color: 'var(--color-primary)', bg: 'rgba(var(--color-primary-rgb),0.15)',  border: 'rgba(var(--color-primary-rgb),0.3)'  },
  'Blocked':     { color: '#ef4444', bg: 'rgba(239,68,68,0.15)',   border: 'rgba(239,68,68,0.3)'   },
  'DEV':         { color: '#10b981', bg: 'rgba(16,185,129,0.15)',  border: 'rgba(16,185,129,0.3)'  },
  'Stage':       { color: '#06b6d4', bg: 'rgba(6,182,212,0.15)',   border: 'rgba(6,182,212,0.3)'   },
  'Prod':        { color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)',  border: 'rgba(139,92,246,0.3)'  },
  'Done':        { color: '#475569', bg: 'rgba(71,85,105,0.15)',   border: 'rgba(71,85,105,0.25)'  },
}
function stateCfg(state: string): StateConfig {
  for (const [k, v] of Object.entries(STATE_CFG)) {
    if (state.toLowerCase().includes(k.toLowerCase())) return v
  }
  return STATE_CFG['In Progress']
}

const VIEWS = [
  { id: 'report',  label: 'Dev Report',       desc: 'Completion analytics' },
  { id: 'feed',    label: 'Activity Feed',    desc: 'Per-assignee accordion' },
  { id: 'cards',   label: 'Developer Cards',  desc: 'Bento grid with metrics' },
  { id: 'log',     label: 'Transition Log',   desc: 'Audit table, exportable' },
  { id: 'heatmap', label: 'Lifecycle Heatmap',desc: 'State coverage grid' },
] as const
type ViewId = typeof VIEWS[number]['id']

const DATE_OPTS = ['Today', 'Last 2 Days', 'Last Week', 'Custom'] as const
type DateRange = typeof DATE_OPTS[number]

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDateRange(range: DateRange, customFrom?: string, customTo?: string): { sinceMs: number; untilMs: number } {
  const now = Date.now()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  switch (range) {
    case 'Today':
      return { sinceMs: todayMs, untilMs: now }
    case 'Last 2 Days':
      return { sinceMs: todayMs - 86400000, untilMs: now }
    case 'Last Week':
      return { sinceMs: todayMs - 7 * 86400000, untilMs: now }
    case 'Custom': {
      if (customFrom && customTo) {
        const from = new Date(customFrom); from.setHours(0, 0, 0, 0)
        const to   = new Date(customTo);   to.setHours(23, 59, 59, 999)
        return { sinceMs: from.getTime(), untilMs: to.getTime() }
      }
      return { sinceMs: todayMs - 30 * 86400000, untilMs: now }
    }
  }
}

function fmtH(h: number | null | undefined): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  const hrs = Math.floor(h)
  const mins = Math.round((h - hrs) * 60)
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`
}

function fmtTransitionTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function fmtSprintDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function getCurrentState(timeline: IssueTimeline): string {
  if (timeline.is_live) return 'In Progress'
  const stints = timeline.stints ?? []
  const last = stints[stints.length - 1]
  if (last?.exited_to) return last.exited_to
  return 'In Progress'
}

interface JourneyStep { state: string; durationH: number | null; isActive: boolean }
function buildJourney(stints: IssueStint[], isLive: boolean): JourneyStep[] {
  if (!stints || stints.length === 0) return []
  const steps: JourneyStep[] = []
  for (let i = 0; i < stints.length; i++) {
    const s = stints[i]
    const isLastStint = i === stints.length - 1
    steps.push({ state: 'In Progress', durationH: s.duration_hours, isActive: isLive && isLastStint && !s.exited_at })
    if (s.exited_at && s.exited_to) {
      const next = stints[i + 1]
      const nextEnteredMs = next ? new Date(next.entered_at).getTime() : Date.now()
      const exitedMs = new Date(s.exited_at).getTime()
      const gapH = Math.round((nextEnteredMs - exitedMs) / 360000) / 10
      steps.push({ state: s.exited_to, durationH: next ? gapH : null, isActive: !next && !isLive })
    }
  }
  return steps
}

// DEV_DONE_STATES: developer completed their work. Stage/Prod are QA pipeline — not "dev done" yet.
const DEV_DONE_STATES = ['dev', 'mobile done', 'done', 'deployed', 'closed']

interface DevStats { total: number; done: number; active: number; blocked: number; bounced: number; hoursWorked: number }
function getDevStats(timelines: IssueTimeline[]): DevStats {
  const done = timelines.filter(t => {
    const s = getCurrentState(t).toLowerCase()
    return DEV_DONE_STATES.some(k => s.includes(k))
  }).length
  const active = timelines.filter(t => t.is_live).length
  const blocked = timelines.filter(t => getCurrentState(t).toLowerCase() === 'blocked').length
  const bounced = timelines.filter(t => (t.moved_back_count ?? 0) > 0).length
  const hoursWorked = timelines.reduce((s, t) => s + (t.total_hours ?? 0), 0)
  return { total: timelines.length, done, active, blocked, bounced, hoursWorked: Math.round(hoursWorked * 10) / 10 }
}

const DEV_PALETTE = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899']
function devColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return DEV_PALETTE[hash % DEV_PALETTE.length]
}
function devInitials(name: string): string {
  return name.split(/\s+/).map(p => p[0] ?? '').join('').toUpperCase().slice(0, 2) || '?'
}

function isBackwardTransition(from: string, to: string): boolean {
  // Blocked is a side-lane state — moving out of it (to In Progress, To Do, etc.) is never a regression
  if (from.toLowerCase() === 'blocked') return false
  const fromIdx = WORKFLOW_ORDER.findIndex(s => from.toLowerCase().includes(s.toLowerCase()))
  const toIdx   = WORKFLOW_ORDER.findIndex(s => to.toLowerCase().includes(s.toLowerCase()))
  if (fromIdx === -1 || toIdx === -1) return false
  return toIdx < fromIdx
}

function heatColor(hours: number, maxH: number): { bg: string; border: string; text: string } | null {
  if (!hours) return null
  const r = hours / maxH
  if (r < 0.25) return { bg: 'rgba(var(--color-primary-rgb),0.18)', border: 'rgba(var(--color-primary-rgb),0.3)',  text: 'var(--color-primary-light)' }
  if (r < 0.5)  return { bg: 'rgba(var(--color-primary-rgb),0.32)', border: 'rgba(var(--color-primary-rgb),0.4)',  text: 'var(--color-primary-light)' }
  if (r < 0.75) return { bg: 'rgba(var(--color-primary-rgb),0.52)', border: 'rgba(var(--color-primary-rgb),0.55)', text: 'var(--color-accent)' }
  return              { bg: 'rgba(var(--color-primary-rgb),0.80)', border: 'rgba(var(--color-primary-rgb),0.9)',  text: '#e0e7ff' }
}

// ─── Atom components ─────────────────────────────────────────────────────────

function DaAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const color = devColor(name)
  const initials = devInitials(name)
  return (
    <div className="da-avatar" style={{
      width: size, height: size, fontSize: size * 0.35,
      background: `linear-gradient(135deg, ${color}, ${color}99)`,
    }}>
      {initials}
    </div>
  )
}

function DaStateBadge({ state, small = false }: { state: string; small?: boolean }) {
  const cfg = stateCfg(state)
  return (
    <span className="da-state-badge" style={{
      color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`,
      padding: small ? '1px 6px' : '2px 8px', fontSize: small ? 9 : 10,
    }}>
      {state}
    </span>
  )
}

function DaTicketId({ id, href }: { id: string; href?: string }) {
  return (
    <a href={href ?? '#'} target={href && href !== '#' ? '_blank' : undefined}
      rel="noopener noreferrer" className="da-ticket-id"
      onClick={e => { if (!href || href === '#') e.preventDefault() }}>
      {id}
    </a>
  )
}

function DaPriDot({ priority }: { priority: string }) {
  // Don't render a dot when priority is the generic fallback — it adds no information
  if (!priority || priority === 'Other' || priority === 'Normal' || priority === 'Medium') return null
  const c = priority === 'Critical' ? '#ef4444'
          : priority === 'Major'    ? '#f59e0b'
          : priority === 'P0'       ? '#ef4444'
          : priority === 'P1'       ? '#f59e0b'
          : priority === 'P2'       ? 'var(--color-primary)'
          : '#94a3b8'
  return <span className="da-pri-dot" style={{ background: c, boxShadow: `0 0 4px ${c}` }} title={priority} />
}

function DaJourneyChain({ steps }: { steps: JourneyStep[] }) {
  return (
    <div className="da-journey">
      {steps.map((step, i) => {
        const cfg = stateCfg(step.state)
        return (
          <React.Fragment key={i}>
            {i > 0 && <span className="da-journey-arrow">›</span>}
            <div className="da-journey-step">
              <span className="da-journey-pill" style={{
                color: cfg.color, background: cfg.bg,
                border: `1px solid ${step.isActive ? cfg.color : cfg.border}`,
                boxShadow: step.isActive ? `0 0 6px ${cfg.color}55` : 'none',
              }}>
                {step.state}
              </span>
              <span className="da-journey-dur">
                {step.isActive ? 'live' : step.durationH != null ? fmtH(step.durationH) : ''}
              </span>
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

function DaSummaryBar({ timelines }: { timelines: IssueTimeline[] }) {
  const total   = timelines.length
  const done    = timelines.filter(t => { const s = getCurrentState(t).toLowerCase(); return DEV_DONE_STATES.some(k => s.includes(k)) }).length
  const active  = timelines.filter(t => t.is_live).length
  const blocked = timelines.filter(t => getCurrentState(t).toLowerCase() === 'blocked').length
  const bounced = timelines.filter(t => (t.moved_back_count ?? 0) > 0).length
  const chips = [
    { label: 'Touched',   value: total,   color: 'rgba(255,255,255,0.85)', icon: '🎯' },
    { label: 'Dev Done',  value: done,    color: '#4ade80',                icon: '✅' },
    { label: 'Active',   value: active,  color: 'var(--color-primary-light)', icon: '🔄' },
    { label: 'Blocked',  value: blocked, color: '#f87171',                icon: '⛔' },
    { label: 'Bounced',  value: bounced, color: '#fb923c',                icon: '↩' },
  ]
  return (
    <div className="da-summary-bar">
      {chips.map(c => (
        <div key={c.label} className="da-kpi-chip">
          <span style={{ fontSize: 13 }}>{c.icon}</span>
          <span className="da-kpi-value" style={{ color: c.color }}><CountUp value={c.value} /></span>
          <span className="da-kpi-label">{c.label}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Filter bar ──────────────────────────────────────────────────────────────

interface FilterBarProps {
  dateRange: DateRange
  onDateRange: (d: DateRange) => void
  assignee: string
  onAssignee: (a: string) => void
  assignees: string[]
  customFrom: string
  customTo: string
  onCustomFrom: (d: string) => void
  onCustomTo: (d: string) => void
  onApplyCustom: () => void
}

function DaFilterBar({ dateRange, onDateRange, assignee, onAssignee, assignees,
  customFrom, customTo, onCustomFrom, onCustomTo, onApplyCustom }: FilterBarProps) {
  return (
    <div className="da-filter-bar">
      <div className="da-date-pills">
        {DATE_OPTS.map(d => (
          <button key={d} className={`da-date-pill${dateRange === d ? ' active' : ''}`}
            onClick={() => onDateRange(d)}>
            {d}
          </button>
        ))}
      </div>

      {dateRange === 'Custom' && (
        <div className="da-custom-range">
          <CalendarPicker
            value={customFrom}
            onChange={onCustomFrom}
            placeholder="From date"
          />
          <span className="da-date-sep">→</span>
          <CalendarPicker
            value={customTo}
            onChange={onCustomTo}
            placeholder="To date"
          />
          <button
            className="da-apply-btn"
            disabled={!customFrom || !customTo || customFrom > customTo}
            onClick={onApplyCustom}
          >
            Apply
          </button>
        </div>
      )}

      <span className="da-filter-divider" />
      <CustomDropdown
        value={assignee}
        onChange={onAssignee}
        placeholder="All Devs"
        options={[
          { value: '', label: 'All Devs' },
          ...assignees.map(a => ({ value: a, label: a })),
        ]}
      />
    </div>
  )
}

// ─── View 1 — Activity Feed ───────────────────────────────────────────────────

function ActivityFeedView({ timelines, onOpenDetail, assigneeFilter, dateRange }: {
  timelines: IssueTimeline[]
  onOpenDetail: (id: string) => void
  assigneeFilter: string
  dateRange: DateRange
}) {
  const [compact, setCompact] = useState(false)
  const [openDevs, setOpenDevs] = useState<Record<string, boolean>>({})
  const [expandedTicket, setExpandedTicket] = useState<string | null>(null)

  // Group by assignee — exclude 0-stint YT-enriched issues that have no state log data
  const devGroups = useMemo(() => {
    const withActivity = timelines.filter(t => (t.stints?.length ?? 0) > 0 || t.is_live)
    const filtered = assigneeFilter ? withActivity.filter(t => t.assignee === assigneeFilter) : withActivity
    const map = new Map<string, IssueTimeline[]>()
    for (const t of filtered) {
      if (!map.has(t.assignee)) map.set(t.assignee, [])
      map.get(t.assignee)!.push(t)
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [timelines, assigneeFilter])

  // Initialize all devs open
  useEffect(() => {
    setOpenDevs(prev => {
      const next = { ...prev }
      for (const [name] of devGroups) if (!(name in next)) next[name] = true
      return next
    })
  }, [devGroups])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="da-view-controls">
        <div className="da-density-toggle">
          <span className="da-density-label">Density</span>
          {(['Compact', 'Expanded'] as const).map(opt => (
            <button key={opt} className={`da-density-btn${(opt === 'Compact') === compact ? ' active' : ''}`}
              onClick={() => setCompact(opt === 'Compact')}>
              {opt}
            </button>
          ))}
        </div>
      </div>

      <DaSummaryBar timelines={timelines} />

      <div className="da-feed-scroll">
        {devGroups.length === 0 && (
          <div className="da-empty">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            <span className="da-empty-icon">📭</span>
            <span className="da-empty-text">No activity found for this date range</span>
          </div>
        )}
        {devGroups.map(([devName, devTimelines]) => {
          const stats = getDevStats(devTimelines)
          const isOpen = openDevs[devName] !== false
          const healthColor = stats.blocked > 0 ? '#ef4444' : stats.bounced > 0 ? '#f59e0b' : '#22c55e'

          return (
            <div key={devName} className="da-dev-section">
              <div className="da-dev-header"
                onClick={() => setOpenDevs(p => ({ ...p, [devName]: !p[devName] }))}>
                <span className="da-health-dot" style={{ background: healthColor, boxShadow: `0 0 6px ${healthColor}` }} />
                <DaAvatar name={devName} size={30} />
                <span className="da-dev-name">{devName}</span>
                <div className="da-dev-stats">
                  {[
                    { v: stats.done,    c: '#4ade80', l: 'dev done' },
                    { v: stats.active,  c: 'var(--color-primary-light)', l: 'active'  },
                    { v: stats.blocked, c: '#f87171', l: 'blocked' },
                    { v: stats.bounced, c: '#fb923c', l: 'bounced' },
                    { v: `${stats.hoursWorked}h`, c: 'rgba(255,255,255,0.4)', l: 'worked' },
                  ].map(chip => (
                    <span key={chip.l} className="da-dev-stat-chip">
                      <span style={{ color: chip.c }}>{chip.v}</span>
                      <span className="da-dev-stat-label">{chip.l}</span>
                    </span>
                  ))}
                </div>
                <span className={`da-chevron${isOpen ? ' open' : ''}`}>▶</span>
              </div>

              {isOpen && devTimelines.map(t => {
                const isBounced = (t.moved_back_count ?? 0) > 0
                const isExpanded = expandedTicket === t.issue_id
                const steps = buildJourney(t.stints ?? [], t.is_live)
                const currentState = getCurrentState(t)
                const staleMs = 3 * 24 * 3600000
                const isStale = t.last_activity_at && (Date.now() - new Date(t.last_activity_at).getTime()) > staleMs

                return (
                  <div key={t.issue_id}
                    className={`da-ticket-row${isBounced ? ' bounced' : ''}${compact ? ' compact' : ''}`}
                    onClick={() => setExpandedTicket(e => e === t.issue_id ? null : t.issue_id)}>

                    <div className="da-ticket-main-row">
                      <DaStateBadge state={currentState} small />
                      <DaPriDot priority={t.priority} />
                      <DaTicketId id={t.issue_id} />
                      <span className="da-ticket-title"
                        onClick={e => { e.stopPropagation(); onOpenDetail(t.issue_id) }}>
                        {t.issue_summary}
                      </span>
                      {isStale && <span className="da-stale" title="No movement in 3+ days">⚠️</span>}
                      {isBounced && (
                        <span className="da-bounce-badge">↩{t.moved_back_count}</span>
                      )}
                      <span className="da-ticket-time">{fmtH(t.total_hours)}</span>
                      <span className={`da-ticket-expand-arrow${isExpanded ? ' open' : ''}`}>▶</span>
                    </div>

                    {(!compact || isExpanded) && steps.length > 0 && (
                      <div className="da-journey-row">
                        <DaJourneyChain steps={steps} />
                      </div>
                    )}

                    {isExpanded && (t.stints ?? []).length > 0 && (
                      <div className="da-history-table">
                        <div className="da-history-header">
                          {['State', 'Entered', 'Exited', 'Duration'].map(h => (
                            <span key={h} className="da-history-col-head">{h}</span>
                          ))}
                        </div>
                        {(t.stints ?? []).map((s, i) => {
                          const inProgCfg = stateCfg('In Progress')
                          const exitCfg   = s.exited_to ? stateCfg(s.exited_to) : null
                          return (
                            <div key={i} className="da-history-row">
                              {/* Stint = In Progress period → exited_to state */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <DaStateBadge state="In Progress" small />
                                {s.exited_to && (
                                  <>
                                    <span style={{ fontSize: 10, opacity: 0.4 }}>→</span>
                                    <DaStateBadge state={s.exited_to} small />
                                  </>
                                )}
                                {!s.exited_to && <span style={{ fontSize: 10, color: '#4ade80' }}>ongoing</span>}
                              </div>
                              <span className="da-history-time">
                                {new Date(s.entered_at).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                              </span>
                              <span className={s.exited_at ? 'da-history-time' : 'da-history-live'}>
                                {s.exited_at
                                  ? new Date(s.exited_at).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
                                  : 'now'}
                              </span>
                              <span className="da-history-dur" style={{ color: s.duration_hours == null ? '#4ade80' : inProgCfg.color }}>
                                {s.duration_hours != null ? fmtH(s.duration_hours) : 'ongoing'}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── View 2 — Developer Cards ─────────────────────────────────────────────────

function DeveloperCardsView({ timelines, onOpenDetail, assigneeFilter, dateRange }: {
  timelines: IssueTimeline[]
  onOpenDetail: (id: string) => void
  assigneeFilter: string
  dateRange: DateRange
}) {
  const [expandedDev, setExpandedDev] = useState<string | null>(null)

  const devGroups = useMemo(() => {
    const withActivity = timelines.filter(t => (t.stints?.length ?? 0) > 0 || t.is_live)
    const filtered = assigneeFilter ? withActivity.filter(t => t.assignee === assigneeFilter) : withActivity
    const map = new Map<string, IssueTimeline[]>()
    for (const t of filtered) {
      if (!map.has(t.assignee)) map.set(t.assignee, [])
      map.get(t.assignee)!.push(t)
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [timelines, assigneeFilter])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="da-cards-scroll">
        {devGroups.length === 0 && (
          <div className="da-empty" style={{ gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            <span className="da-empty-icon">📭</span>
            <span className="da-empty-text">No activity found for this date range</span>
          </div>
        )}
        {devGroups.map(([devName, devTimelines]) => {
          const stats = getDevStats(devTimelines)
          const color = devColor(devName)
          const isExpanded = expandedDev === devName
          const healthAccent = stats.blocked > 0 ? '#ef4444' : stats.bounced > 0 ? '#f59e0b' : '#22c55e'
          const healthBorder = stats.blocked > 0 ? 'rgba(239,68,68,0.3)' : stats.bounced > 0 ? 'rgba(245,158,11,0.25)' : 'rgba(34,197,94,0.2)'
          const healthTint   = stats.blocked > 0 ? 'rgba(239,68,68,0.04)' : stats.bounced > 0 ? 'rgba(245,158,11,0.04)' : 'rgba(34,197,94,0.03)'
          const estTotal   = devTimelines.reduce((s, t) => s + 0, 0) // no estimate in IssueTimeline
          const spentTotal = Math.round(devTimelines.reduce((s, t) => s + (t.total_hours ?? 0), 0) * 10) / 10
          const pct = stats.total ? (stats.done / stats.total) * 100 : 0

          return (
            <div key={devName} className="da-dev-card"
              style={{ background: healthTint, borderColor: isExpanded ? healthAccent : healthBorder,
                boxShadow: isExpanded ? `0 0 0 1px ${healthAccent}44, 0 8px 32px rgba(0,0,0,0.3)` : undefined }}>

              <div className="da-card-header"
                onClick={() => setExpandedDev(isExpanded ? null : devName)}>
                <DaAvatar name={devName} size={36} />
                <div className="da-card-dev-info">
                  <div className="da-card-dev-name">{devName}</div>
                  <div className="da-card-dev-sub">
                    {dateRange} · <span style={{ fontFamily: 'JetBrains Mono, monospace', color }}>{spentTotal}h worked</span>
                  </div>
                </div>
                <span className={`da-chevron${isExpanded ? ' open' : ''}`}>▶</span>
              </div>

              <div className="da-card-kpis">
                {[
                  { label: 'Dev Done', value: stats.done,    color: '#4ade80', icon: '✅' },
                  { label: 'Active',   value: stats.active,  color: 'var(--color-primary-light)', icon: '🔄' },
                  { label: 'Blocked',  value: stats.blocked, color: '#f87171', icon: '⛔' },
                  { label: 'Bounced',  value: stats.bounced, color: '#fb923c', icon: '↩' },
                ].map(c => (
                  <div key={c.label} className="da-card-kpi">
                    <span className="da-card-kpi-icon">{c.icon}</span>
                    <span className="da-card-kpi-val" style={{ color: c.color }}>{c.value}</span>
                    <span className="da-card-kpi-lbl">{c.label}</span>
                  </div>
                ))}
              </div>

              <div className="da-card-progress-wrap">
                <div className="da-card-progress-meta">
                  <span>Completion</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', color: healthAccent }}>
                    {stats.done}/{stats.total}
                  </span>
                </div>
                <div className="da-card-progress-bar">
                  <div className="da-card-progress-fill" style={{ width: `${pct}%`, background: healthAccent }} />
                </div>
              </div>

              <div className="da-card-hours">
                <span>Spent <span>{spentTotal}h</span></span>
              </div>

              <div className="da-card-ticket-list">
                {devTimelines.slice(0, isExpanded ? undefined : 3).map((t, i) => {
                  const cfg = stateCfg(getCurrentState(t))
                  return (
                    <div key={t.issue_id} className="da-card-ticket-row"
                      onClick={() => onOpenDetail(t.issue_id)}>
                      <span className="da-card-state-dot" style={{ background: cfg.color, boxShadow: `0 0 4px ${cfg.color}` }} />
                      <DaTicketId id={t.issue_id} />
                      <span className="da-card-ticket-title">{t.issue_summary}</span>
                      {(t.moved_back_count ?? 0) > 0 && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#fb923c', flexShrink: 0 }}>↩{t.moved_back_count}</span>
                      )}
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>
                        {fmtH(t.total_hours)}
                      </span>
                    </div>
                  )
                })}
                {!isExpanded && devTimelines.length > 3 && (
                  <div className="da-card-more" onClick={() => setExpandedDev(devName)}>
                    +{devTimelines.length - 3} more tickets
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── View 3 — Transition Log ──────────────────────────────────────────────────

function TransitionLogView({ transitions, onOpenDetail, assigneeFilter, dateRange, sinceMs, untilMs }: {
  transitions: TimeTrackingRow[]
  onOpenDetail: (id: string) => void
  assigneeFilter: string
  dateRange: DateRange
  sinceMs: number
  untilMs: number
}) {
  const [groupBy, setGroupBy] = useState<'Flat' | 'Assignee' | 'State'>('Flat')
  const [hoveredRow, setHoveredRow] = useState<number | null>(null)

  // Client-side date filter using resolved ms from parent (handles Custom range too)
  const filtered = useMemo(() => {
    const base = assigneeFilter ? transitions.filter(t => t.assignee === assigneeFilter) : transitions
    return base.filter(t => {
      const ms = new Date(t.transitioned_at).getTime()
      return ms >= sinceMs && ms <= untilMs
    }).sort((a, b) => new Date(b.transitioned_at).getTime() - new Date(a.transitioned_at).getTime())
  }, [transitions, sinceMs, untilMs, assigneeFilter])

  const backCount = filtered.filter(t => isBackwardTransition(t.from_state, t.to_state)).length
  const fwdCount  = filtered.length - backCount

  function handleExport() {
    const rows = [['Time', 'Developer', 'Ticket', 'Title', 'From', 'To', 'Prev Duration']]
    for (const t of filtered) {
      rows.push([fmtTransitionTime(t.transitioned_at), t.assignee, t.issue_id, t.issue_summary, t.from_state, t.to_state, String(fmtH(t.duration_in_prev_state_hours))])
    }
    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'transitions.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  type GroupedItem = { label: string; items: TimeTrackingRow[]; accent: string }

  const grouped = useMemo<GroupedItem[] | null>(() => {
    if (groupBy === 'Assignee') {
      const g: Record<string, GroupedItem> = {}
      for (const t of filtered) {
        if (!g[t.assignee]) g[t.assignee] = { label: t.assignee || '(unassigned)', items: [], accent: devColor(t.assignee) }
        g[t.assignee].items.push(t)
      }
      return Object.values(g)
    }
    if (groupBy === 'State') {
      const g: Record<string, GroupedItem> = {}
      for (const t of filtered) {
        const key = t.to_state || '(unknown)'
        if (!g[key]) { const cfg = stateCfg(key); g[key] = { label: `→ ${key}`, items: [], accent: cfg.color } }
        g[key].items.push(t)
      }
      return Object.values(g).sort((a, b) => {
        const ai = WORKFLOW_ORDER.findIndex(s => a.label.toLowerCase().includes(s.toLowerCase()))
        const bi = WORKFLOW_ORDER.findIndex(s => b.label.toLowerCase().includes(s.toLowerCase()))
        return ai - bi
      })
    }
    return null
  }, [filtered, groupBy])

  const flat = useMemo<Array<{ type: 'divider'; label: string } | { type: 'row'; t: TimeTrackingRow; idx: number }> | null>(() => {
    if (groupBy !== 'Flat') return null
    const out: Array<{ type: 'divider'; label: string } | { type: 'row'; t: TimeTrackingRow; idx: number }> = []
    let lastDay = ''
    filtered.forEach((t, idx) => {
      const day = new Date(t.transitioned_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      if (day !== lastDay) {
        const count = filtered.filter(x => new Date(x.transitioned_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) === day).length
        out.push({ type: 'divider', label: `${day}  (${count} transitions)` })
        lastDay = day
      }
      out.push({ type: 'row', t, idx })
    })
    return out
  }, [filtered, groupBy])

  const ColHeader = () => (
    <div className="da-log-col-header">
      {['Time', 'Developer', 'Ticket', 'Title', 'Transition', 'Prev Duration'].map(h => (
        <span key={h} className="da-log-col-head-label">{h}</span>
      ))}
    </div>
  )

  const TransRow = ({ t, idx }: { t: TimeTrackingRow; idx: number }) => {
    const backward = isBackwardTransition(t.from_state, t.to_state)
    const fromCfg  = stateCfg(t.from_state)
    const toCfg    = stateCfg(t.to_state)
    return (
      <div className={`da-log-row${backward ? ' backward' : ''}`}
        onMouseEnter={() => setHoveredRow(idx)} onMouseLeave={() => setHoveredRow(null)}>
        <span className="da-log-time">{fmtTransitionTime(t.transitioned_at)}</span>
        <div className="da-log-dev">
          <DaAvatar name={t.assignee} size={20} />
          <span className="da-log-dev-name">{t.assignee}</span>
        </div>
        <DaTicketId id={t.issue_id} />
        <span className="da-log-title" onClick={() => onOpenDetail(t.issue_id)}>{t.issue_summary}</span>
        <div className="da-log-transition">
          <span className="da-log-state-pill" style={{ color: fromCfg.color, background: fromCfg.bg, border: `1px solid ${fromCfg.border}` }}>
            {t.from_state}
          </span>
          <span className="da-log-arrow" style={{ color: backward ? '#f59e0b' : '#4ade80' }}>
            {backward ? '↩' : '→'}
          </span>
          <span className="da-log-state-pill" style={{ color: toCfg.color, background: toCfg.bg, border: `1px solid ${toCfg.border}` }}>
            {t.to_state}
          </span>
        </div>
        <span className="da-log-prev-dur">{fmtH(t.duration_in_prev_state_hours)}</span>
      </div>
    )
  }


  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="da-view-controls">
        <div className="da-group-toggle-row">
          {([['Flat', 'Flat'], ['Group by Assignee', 'Assignee'], ['Group by State', 'State']] as const).map(([label, key]) => (
            <button key={key} className={`da-group-toggle-btn${groupBy === key ? ' active' : ''}`}
              onClick={() => setGroupBy(key as typeof groupBy)}>
              {label}
            </button>
          ))}
        </div>
        <button className="da-export-btn" onClick={handleExport}>
          <Download size={12} /> Export CSV
        </button>
      </div>

      <div className="da-log-legend">
        {[['Forward progress', '#4ade80'], ['Backward / bounce', '#f59e0b']].map(([l, c]) => (
          <span key={l} className="da-log-legend-item">
            <span className="da-log-legend-line" style={{ background: c }} />{l}
          </span>
        ))}
        <span className="da-log-legend-item" style={{ marginLeft: 8 }}>
          <strong style={{ color: 'rgba(255,255,255,0.75)' }}>{backCount}</strong>&nbsp;backward&nbsp;·&nbsp;
          <strong style={{ color: 'rgba(255,255,255,0.75)' }}>{fwdCount}</strong>&nbsp;forward
        </span>
      </div>

      <div className="da-log-body">
        <ColHeader />
        {filtered.length === 0 && (
          <div className="da-empty">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            <span className="da-empty-icon">📋</span>
            <span className="da-empty-text">No transitions in this date range</span>
          </div>
        )}

        {groupBy === 'Flat' && flat && flat.map((item, i) =>
          item.type === 'divider' ? (
            <div key={i} className="da-log-date-divider">
              <div className="da-log-divider-line" />
              <span className="da-log-divider-label">{item.label}</span>
              <div className="da-log-divider-line" />
            </div>
          ) : (
            <TransRow key={i} t={item.t} idx={item.idx} />
          )
        )}

        {(groupBy === 'Assignee' || groupBy === 'State') && grouped && grouped.map((g, gi) => (
          <div key={gi}>
            <div className="da-log-group-header">
              <span className="da-log-group-label" style={{ color: g.accent }}>{g.label}</span>
              <span className="da-log-group-count">{g.items.length}</span>
            </div>
            {g.items.map((t, i) => <TransRow key={i} t={t} idx={gi * 100 + i} />)}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── View 4 — Lifecycle Heatmap ──────────────────────────────────────────────

function LifecycleHeatmapView({ timelines, onOpenDetail, assigneeFilter, dateRange }: {
  timelines: IssueTimeline[]
  onOpenDetail: (id: string) => void
  assigneeFilter: string
  dateRange: DateRange
}) {
  const [selectedDev, setSelectedDev] = useState<string | null>(null)
  const [sort, setSort] = useState<'Total Time' | 'Bounce Count' | 'Assignee'>('Total Time')
  const [hoveredCell, setHoveredCell] = useState<{ ticketId: string; state: string } | null>(null)

  const devGroups = useMemo(() => {
    const map = new Map<string, IssueTimeline[]>()
    for (const t of timelines) {
      if (!map.has(t.assignee)) map.set(t.assignee, [])
      map.get(t.assignee)!.push(t)
    }
    return Array.from(map.entries())
  }, [timelines])

  const filteredTickets = useMemo(() => {
    const withActivity = timelines.filter(t => (t.stints?.length ?? 0) > 0 || t.is_live)
    const byDev = (selectedDev || assigneeFilter)
      ? withActivity.filter(t => t.assignee === (selectedDev || assigneeFilter))
      : withActivity
    return [...byDev].sort((a, b) => {
      if (sort === 'Total Time') return (b.total_hours ?? 0) - (a.total_hours ?? 0)
      if (sort === 'Bounce Count') return (b.moved_back_count ?? 0) - (a.moved_back_count ?? 0)
      return a.assignee.localeCompare(b.assignee)
    })
  }, [timelines, selectedDev, assigneeFilter, sort])

  // For heatmap cells: In Progress = actual hours (from stints); other states = presence only (no fake hours)
  function getCellData(t: IssueTimeline, state: string): { hours: number | null; isPresent: boolean } {
    if (state.toLowerCase().includes('in progress')) {
      const h = t.total_hours || null
      return { hours: h, isPresent: !!h }
    }
    const stints = t.stints ?? []
    const isCurrent = getCurrentState(t).toLowerCase().includes(state.toLowerCase())
    const appearsInJourney = stints.some(s => s.exited_to?.toLowerCase().includes(state.toLowerCase()))
    return { hours: null, isPresent: isCurrent || appearsInJourney }
  }

  const maxH = Math.max(...timelines.map(t => t.total_hours ?? 0), 1)

  // Bottleneck: cumulative In Progress hours per state (presence-only states contribute 0)
  const bottleneck = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const state of HEATMAP_STATES) {
      totals[state] = timelines.reduce((sum, t) => {
        const { hours } = getCellData(t, state)
        return sum + (hours ?? 0)
      }, 0)
    }
    return totals
  }, [timelines])
  const maxBottleneck = Math.max(...Object.values(bottleneck), 1)

  const colCount = HEATMAP_STATES.length
  const gridTemplateColumns = `200px repeat(${colCount}, 1fr)`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="da-view-controls">
        <CustomDropdown
          value={sort}
          onChange={v => setSort(v as typeof sort)}
          options={[
            { value: 'Total Time',   label: 'Total Time' },
            { value: 'Bounce Count', label: 'Bounce Count' },
            { value: 'Assignee',     label: 'Assignee' },
          ]}
        />
      </div>

      <div className="da-heatmap-body">
        {/* Left panel */}
        <div className="da-heatmap-left">
          <div className="da-heatmap-section-title">Team Activity</div>
          {devGroups.map(([name, devT]) => {
            const moved = devT.filter(t => (t.stints?.length ?? 0) > 0).length
            const pct = devT.length ? (moved / devT.length) * 100 : 0
            const color = devColor(name)
            const isActive = selectedDev === name
            return (
              <div key={name} className={`da-heatmap-dev-row${isActive ? ' active' : ''}`}
                style={{ '--da-dev-color': color } as React.CSSProperties}
                onClick={() => setSelectedDev(isActive ? null : name)}>
                <div className="da-heatmap-dev-info">
                  <DaAvatar name={name} size={24} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{name}</span>
                  <span className="da-heatmap-dev-moved">{moved}/{devT.length}</span>
                </div>
                <div className="da-heatmap-dev-bar">
                  <div className="da-heatmap-dev-bar-fill" style={{ width: `${pct}%`, background: isActive ? color : 'var(--color-primary)' }} />
                </div>
                <div className="da-heatmap-dev-sub">{moved} of {devT.length} tickets touched</div>
              </div>
            )
          })}

          <div className="da-heatmap-legend">
            <div className="da-heatmap-legend-title">Time in state</div>
            {[
              { label: 'Short (< 25%)', bg: 'rgba(var(--color-primary-rgb),0.18)', border: 'rgba(var(--color-primary-rgb),0.3)' },
              { label: 'Medium',        bg: 'rgba(var(--color-primary-rgb),0.32)', border: 'rgba(var(--color-primary-rgb),0.4)' },
              { label: 'Long',          bg: 'rgba(var(--color-primary-rgb),0.52)', border: 'rgba(var(--color-primary-rgb),0.55)' },
              { label: 'Very long',     bg: 'rgba(var(--color-primary-rgb),0.80)', border: 'rgba(var(--color-primary-rgb),0.9)' },
            ].map(l => (
              <div key={l.label} className="da-heatmap-legend-item">
                <div className="da-heatmap-legend-swatch" style={{ background: l.bg, border: `1px solid ${l.border}` }} />
                {l.label}
              </div>
            ))}
            <div className="da-heatmap-legend-item">
              <div className="da-heatmap-legend-swatch" style={{ background: 'transparent', border: '1px dashed rgba(255,255,255,0.15)' }} />
              Skipped / no data
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div className="da-heatmap-right">
          <div className="da-heatmap-grid-scroll">
            {/* Column headers */}
            <div className="da-heatmap-col-headers" style={{ gridTemplateColumns, display: 'grid', gap: 3 }}>
              <span className="da-heatmap-ticket-label">Ticket</span>
              {HEATMAP_STATES.map(state => {
                const cfg = stateCfg(state)
                return <div key={state} className="da-heatmap-col-head" style={{ color: cfg.color }}>{state}</div>
              })}
            </div>

            {/* Ticket rows */}
            <div className="da-heatmap-grid-body">
              {filteredTickets.length === 0 && (
                <div className="da-empty">
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                    <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
                  </div>
                  <span className="da-empty-icon">📊</span>
                  <span className="da-empty-text">No tickets to display</span>
                </div>
              )}
              {filteredTickets.map(ticket => (
                <div key={ticket.issue_id} className="da-heatmap-ticket-row"
                  style={{ gridTemplateColumns, display: 'grid', gap: 3 }}>
                  {/* Ticket label */}
                  <div className="da-heatmap-ticket-info">
                    <DaAvatar name={ticket.assignee} size={18} />
                    <div style={{ minWidth: 0 }}>
                      <div className="da-heatmap-ticket-id">{ticket.issue_id}</div>
                      <div className="da-heatmap-ticket-name">{ticket.issue_summary}</div>
                    </div>
                    {(ticket.moved_back_count ?? 0) > 0 && (
                      <span style={{ fontSize: 9, color: '#fb923c', fontWeight: 700, flexShrink: 0 }}>↩{ticket.moved_back_count}</span>
                    )}
                  </div>

                  {/* State cells */}
                  {HEATMAP_STATES.map(state => {
                    const { hours, isPresent } = getCellData(ticket, state)
                    const isCurrent = getCurrentState(ticket).toLowerCase().includes(state.toLowerCase())
                    const colors = hours != null && hours > 0 ? heatColor(hours, maxH) : null
                    const isHov = hoveredCell?.ticketId === ticket.issue_id && hoveredCell?.state === state
                    return (
                      <div key={state} className={`da-heatmap-cell${colors ? ' has-data' : isPresent ? ' is-present' : ''}`}
                        style={{
                          background: colors ? colors.bg : 'transparent',
                          border: colors ? `1px solid ${colors.border}` : isPresent ? `1px solid ${stateCfg(state).color}44` : '1px dashed rgba(255,255,255,0.1)',
                          boxShadow: isCurrent ? `0 0 8px ${stateCfg(state).color}55` : 'none',
                        }}
                        onMouseEnter={() => setHoveredCell({ ticketId: ticket.issue_id, state })}
                        onMouseLeave={() => setHoveredCell(null)}
                        onClick={() => { if (colors || isPresent) onOpenDetail(ticket.issue_id) }}>
                        {colors && (
                          <span className="da-heatmap-cell-dur" style={{ color: colors.text }}>
                            {fmtH(hours)}
                          </span>
                        )}
                        {!colors && isPresent && (
                          <span className="da-heatmap-cell-dot" style={{ background: stateCfg(state).color }} />
                        )}
                        {ticket.is_live && isCurrent && (
                          <span className="da-heatmap-live-dot" />
                        )}
                        {isHov && (colors || isPresent) && (
                          <div className="da-heatmap-tooltip">
                            <div className="da-heatmap-tooltip-state" style={{ color: stateCfg(state).color }}>{state}</div>
                            <div className="da-heatmap-tooltip-info">{hours != null ? fmtH(hours) : 'visited'} · {ticket.issue_id}</div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Bottleneck analysis */}
          <div className="da-bottleneck">
            <div className="da-bottleneck-title">Bottleneck Analysis — cumulative hours per state</div>
            {Object.entries(bottleneck)
              .filter(([, v]) => v > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([state, hours]) => {
                const cfg = stateCfg(state)
                const pct = (hours / maxBottleneck) * 100
                return (
                  <div key={state} className="da-bottleneck-row">
                    <span className="da-bottleneck-label" style={{ color: cfg.color }}>{state}</span>
                    <div className="da-bottleneck-track">
                      <div className="da-bottleneck-fill"
                        style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${cfg.color}cc, ${cfg.color}66)` }} />
                    </div>
                    <span className="da-bottleneck-val" style={{ color: cfg.color }}>{Math.round(hours)}h</span>
                  </div>
                )
              })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Dev Report View ─────────────────────────────────────────────────────────

interface CompletionRecord {
  issueId: string
  summary: string
  completedState: string
  journey: JourneyStep[]
  totalHours: number
  bounceCount: number
  completedAt: string
}

const DR_DONE_STATES = new Set(['dev', 'stage', 'prod', 'mobile done', 'deployed', 'verified', 'done', 'closed'])
function drIsDone(state: string): boolean {
  return DR_DONE_STATES.has(state.toLowerCase())
}

function DevReportView({ onOpenDetail, ytBaseUrl }: {
  onOpenDetail: (id: string) => void
  ytBaseUrl: string
}) {
  const [allDevs, setAllDevs] = useState<string[]>([])
  const [selectedDevs, setSelectedDevs] = useState<string[]>([])
  const [drDateRange, setDrDateRange] = useState<DateRange>('Last 2 Days')
  const [drCustomFrom, setDrCustomFrom] = useState('')
  const [drCustomTo, setDrCustomTo] = useState('')
  const [generating, setGenerating] = useState(false)
  const [reportData, setReportData] = useState<Record<string, CompletionRecord[]> | null>(null)

  useEffect(() => {
    const now = Date.now()
    api.getIssueTimelines(now - 30 * 86400000, now)
      .then(res => {
        const tls = (res as any)?.data as IssueTimeline[] ?? []
        // Collect devs from done-stint movers (who actually moved tickets to done)
        // and assignees. moved_by is the ground truth for "who did the work."
        const devSet = new Set<string>()
        for (const tl of tls) {
          if (tl.assignee) devSet.add(tl.assignee)
          for (const stint of tl.stints ?? []) {
            if (stint.moved_by && drIsDone(stint.exited_to ?? '')) devSet.add(stint.moved_by)
          }
        }
        setAllDevs([...devSet].sort())
      })
      .catch(() => {})
  }, [])

  const { sinceMs, untilMs } = useMemo(
    () => getDateRange(drDateRange, drCustomFrom, drCustomTo),
    [drDateRange, drCustomFrom, drCustomTo],
  )

  const canGenerate = selectedDevs.length > 0
    && (drDateRange !== 'Custom' || (!!drCustomFrom && !!drCustomTo && drCustomFrom <= drCustomTo))

  const toggleDev = (dev: string) =>
    setSelectedDevs(prev => prev.includes(dev) ? prev.filter(d => d !== dev) : [...prev, dev])

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      const res = await api.getIssueTimelines(sinceMs, untilMs)
      const tls = (res as any)?.data as IssueTimeline[] ?? []
      const byDev: Record<string, CompletionRecord[]> = {}
      for (const tl of tls) {
        for (const stint of tl.stints ?? []) {
          if (!stint.exited_to || !drIsDone(stint.exited_to)) continue
          if (!stint.exited_at) continue
          const exitMs = new Date(stint.exited_at).getTime()
          if (exitMs < sinceMs || exitMs > untilMs) continue
          // Credit the person who moved the ticket to done (moved_by), not just the assignee.
          // This correctly handles cases where someone moves a ticket they don't own.
          const dev = stint.moved_by || tl.assignee || 'Unknown'
          if (!selectedDevs.includes(dev)) continue
          if (!byDev[dev]) byDev[dev] = []
          byDev[dev].push({
            issueId: tl.issue_id,
            summary: tl.issue_summary || tl.issue_id,
            completedState: stint.exited_to,
            journey: buildJourney(tl.stints, tl.is_live),
            totalHours: tl.total_hours ?? 0,
            bounceCount: tl.moved_back_count ?? 0,
            completedAt: stint.exited_at,
          })
        }
      }
      setReportData(byDev)
    } finally {
      setGenerating(false)
    }
  }

  const rangeLabel = drDateRange === 'Custom' ? `${drCustomFrom} → ${drCustomTo}` : drDateRange

  if (generating) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0' }}>
        <SvgSprintScanLoader size={128} />
      </div>
    )
  }

  if (reportData !== null) {
    const devEntries = Object.entries(reportData)
    const totalCompleted = devEntries.reduce((s, [, recs]) => s + recs.length, 0)
    const totalHours = devEntries.reduce((s, [, recs]) => s + recs.reduce((h, r) => h + r.totalHours, 0), 0)
    const totalBounced = devEntries.reduce((s, [, recs]) => s + recs.filter(r => r.bounceCount > 0).length, 0)

    return (
      <div className="dr-results">
        <div className="dr-results-header">
          <div>
            <div className="dr-results-title">Completion Report — {rangeLabel}</div>
            <div className="dr-results-meta">{selectedDevs.join(', ')}</div>
          </div>
          <button className="dr-new-query-btn" onClick={() => setReportData(null)}>← New Query</button>
        </div>

        <div className="dr-stats-strip">
          {[
            { val: totalCompleted, lbl: 'Tickets Done' },
            { val: devEntries.length, lbl: 'Developers' },
            { val: `${Math.round(totalHours * 10) / 10}h`, lbl: 'Hours Worked' },
            { val: totalBounced, lbl: 'Bounced' },
          ].map(s => (
            <div key={s.lbl} className="dr-stat-chip">
              <span className="dr-stat-val">{s.val}</span>
              <span className="dr-stat-lbl">{s.lbl}</span>
            </div>
          ))}
        </div>

        {totalCompleted === 0 && (
          <div className="dr-empty">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            <div className="dr-empty-icon">🔍</div>
            <div className="dr-empty-msg">No tickets completed in this period</div>
            <div className="dr-empty-sub">Try a wider date range or different developers</div>
          </div>
        )}

        {devEntries.map(([dev, records]) => {
          const color = devColor(dev)
          return (
            <div key={dev} className="dr-dev-section">
              <div className="dr-dev-header">
                <div className="dr-dev-avatar" style={{ background: `linear-gradient(135deg, ${color}, ${color}99)` }}>
                  {devInitials(dev)}
                </div>
                <span className="dr-dev-name">{dev}</span>
                <span className="dr-dev-count">{records.length} completed</span>
              </div>
              <div className="dr-table-wrap">
                <table className="dr-table">
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Summary</th>
                      <th>Completed To</th>
                      <th>Journey</th>
                      <th style={{ textAlign: 'right' }}>Hours</th>
                      <th style={{ textAlign: 'right' }}>Bounces</th>
                      <th style={{ textAlign: 'right' }}>Completed At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <span className="dr-id-link" onClick={() => onOpenDetail(r.issueId)}>{r.issueId}</span>
                        </td>
                        <td style={{ maxWidth: 200 }}>
                          <span style={{ cursor: 'pointer', color: 'var(--text-primary)', fontSize: 12 }}
                            onClick={() => onOpenDetail(r.issueId)} title={r.summary}>
                            {r.summary.length > 55 ? r.summary.slice(0, 55) + '…' : r.summary}
                          </span>
                        </td>
                        <td><DaStateBadge state={r.completedState} small /></td>
                        <td>
                          <div className="dr-journey">
                            {r.journey.map((step, ji) => {
                              const cfg = stateCfg(step.state)
                              return (
                                <React.Fragment key={ji}>
                                  {ji > 0 && <span className="dr-journey-arrow">›</span>}
                                  <span className="dr-journey-step" style={{ color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}` }}>
                                    {step.state}
                                  </span>
                                </React.Fragment>
                              )
                            })}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtH(r.totalHours)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {r.bounceCount > 0
                            ? <span style={{ color: '#f87171', fontWeight: 600 }}>{r.bounceCount}</span>
                            : <span style={{ opacity: 0.3 }}>—</span>
                          }
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>
                          {new Date(r.completedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="dr-command-center">
      <div className="dr-scanline" />
      <div className="dr-corner dr-corner--tl" />
      <div className="dr-corner dr-corner--tr" />
      <div className="dr-corner dr-corner--bl" />
      <div className="dr-corner dr-corner--br" />

      <div className="dr-panel">
        <div className="dr-title">
          <div className="dr-title-main">
            <span className="dr-title-glyph">◈</span>
            Dev Report
          </div>
          <div className="dr-title-sub">Select developers and a time window — get a full completion audit</div>
        </div>

        <div className="dr-field">
          <div className="dr-label">Developers</div>
          {allDevs.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading developers…</div>
            : (
              <div className="dr-dev-grid">
                {allDevs.map(dev => {
                  const color = devColor(dev)
                  const selected = selectedDevs.includes(dev)
                  return (
                    <button key={dev} className={`dr-dev-pill${selected ? ' selected' : ''}`} onClick={() => toggleDev(dev)}>
                      <span className="dr-dev-dot" style={{ background: color }} />
                      {dev}
                      <span className="dr-dev-check">{selected && <Check size={8} />}</span>
                    </button>
                  )
                })}
              </div>
            )
          }
        </div>

        <div className="dr-field">
          <div className="dr-label">Time Period</div>
          <div className="dr-date-row">
            {DATE_OPTS.map(d => (
              <button key={d} className={`da-date-pill${drDateRange === d ? ' active' : ''}`} onClick={() => setDrDateRange(d)}>{d}</button>
            ))}
          </div>
          {drDateRange === 'Custom' && (
            <div className="da-custom-range" style={{ marginTop: 8 }}>
              <CalendarPicker value={drCustomFrom} onChange={setDrCustomFrom} placeholder="From date" />
              <span className="da-date-sep">→</span>
              <CalendarPicker value={drCustomTo} onChange={setDrCustomTo} placeholder="To date" />
            </div>
          )}
        </div>

        <button className="dr-generate-btn" disabled={!canGenerate || generating} onClick={handleGenerate}>
          {generating ? '◌  Generating…' : '◈  Generate Report'}
        </button>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

interface Props {
  initialView?: ViewId
}

export function DevActivityPage({ initialView }: Props) {
  const [view, setView] = usePersistedState<ViewId>(PERSIST.DEV_ACTIVITY_VIEW, 'report', { validate: VIEWS.map(v => v.id) as string[] })
  const [sprints, setSprints] = useState<YouTrackSprint[]>([])
  const [activeSprint, setActiveSprint] = useState<YouTrackSprint | null>(null)
  const [sprintDropOpen, setSprintDropOpen] = useState(false)
  const [timelines, setTimelines] = useState<IssueTimeline[]>([])
  const [transitions, setTransitions] = useState<TimeTrackingRow[]>([])
  const [loading, setLoading] = useState(false)
  const [assigneeFilter, setAssigneeFilter] = useState('')
  const [detailIssue, setDetailIssue] = useState<import('../services/api').YouTrackIssue | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [ytBaseUrl, setYtBaseUrl] = useState('')
  const [dateRange, setDateRange] = usePersistedState<DateRange>(PERSIST.DEV_ACTIVITY_DATE, 'Today', { validate: [...DATE_OPTS] })
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo]     = useState('')

  const sprintDropRef  = useRef<HTMLDivElement>(null)
  const sprintMenuRef  = useRef<HTMLDivElement>(null)
  const isYouTrack = getActiveSource() === 'youtrack'

  // ── Load sprints ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isYouTrack) return
    api.getYouTrackSprints().then(res => {
      const list = ((res as any).data as YouTrackSprint[]) ?? []
      setSprints(list)
      const now = Date.now()
      const active = list.filter(s => !s.isCompleted && s.finish > now).sort((a, b) => a.finish - b.finish)[0] ?? null
      setActiveSprint(active)
    }).catch(() => {})
  }, [isYouTrack])

  // ── Load YT base URL ──────────────────────────────────────────────────────
  useEffect(() => {
    api.getYouTrackIntegration().then(res => {
      const d = (res as any)
      setYtBaseUrl((d?.base_url || d?.data?.base_url || '').replace(/\/$/, ''))
    }).catch(() => {})
  }, [])

  // ── Outside-click for sprint dropdown ────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (!sprintDropRef.current?.contains(target) && !sprintMenuRef.current?.contains(target))
        setSprintDropOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Resolved ms values — shared with TransitionLogView for client-side filtering
  const { sinceMs, untilMs } = useMemo(
    () => getDateRange(dateRange, customFrom, customTo),
    [dateRange, customFrom, customTo],
  )

  // ── Fetch timeline data ───────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!isYouTrack) return
    // Don't fetch Custom range until both dates are chosen and valid
    if (dateRange === 'Custom' && (!customFrom || !customTo || customFrom > customTo)) return
    setLoading(true)
    try {
      const { sinceMs: sMs, untilMs: uMs } = getDateRange(dateRange, customFrom, customTo)
      const [tlRes, ttRes] = await Promise.allSettled([
        api.getIssueTimelines(sMs, uMs),
        activeSprint?.id ? api.getTimeTracking({ sprint_id: activeSprint.id }) : api.getTimeTracking({}),
      ])
      if (tlRes.status === 'fulfilled') {
        const data = (tlRes.value as any)?.data as IssueTimeline[] ?? []
        setTimelines(data)
      }
      if (ttRes.status === 'fulfilled') {
        const data = (ttRes.value as any)?.data as TimeTrackingRow[] ?? []
        setTransitions(data)
      }
    } finally {
      setLoading(false)
    }
  }, [dateRange, customFrom, customTo, activeSprint?.id])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Open issue detail ─────────────────────────────────────────────────────
  const handleOpenDetail = useCallback(async (issueId: string) => {
    setDetailLoading(true)
    try {
      const res = await api.getYouTrackIssue(issueId)
      const issue = (res as any).data as import('../services/api').YouTrackIssue
      if (issue) setDetailIssue(issue)
    } catch { /* ignore */ }
    finally { setDetailLoading(false) }
  }, [])

  const sortedSprints = useMemo(() => [...sprints].sort((a, b) => b.finish - a.finish), [sprints])
  const uniqueAssignees = useMemo(() => [...new Set(timelines.map(t => t.assignee))].sort(), [timelines])

  return (
    <div className="da-page" style={{ padding: '1.25rem 1.75rem', height: 'calc(100vh - var(--header-height))', overflow: 'hidden' }}>
      {/* ── Tab row + sprint dropdown ── */}
      <div className="da-tab-row">
        <div className="da-tab-bar">
          {VIEWS.map(v => (
            <button key={v.id} className={`da-tab-btn${view === v.id ? ' active' : ''}`}
              onClick={() => setView(v.id)}>
              <span>{v.label}</span>
              <span className="da-tab-desc">— {v.desc}</span>
            </button>
          ))}
        </div>

        {isYouTrack && (
          <div ref={sprintDropRef} className="da-sprint-drop-wrap">
            <button
              onClick={() => setSprintDropOpen(o => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 7,
                border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer',
                fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
              <GitBranch size={13} />
              {activeSprint
                ? <>{activeSprint.name}&nbsp;<span style={{ opacity: 0.55, fontWeight: 400 }}>{fmtSprintDate(activeSprint.start)}–{fmtSprintDate(activeSprint.finish)}</span></>
                : <span>All sprints</span>
              }
              <ChevronDown size={12} style={{ opacity: 0.5 }} />
            </button>
            {sprintDropOpen && createPortal(
              <div ref={sprintMenuRef} className="pm-custom-dropdown-menu"
                style={{ position: 'fixed',
                  top: (sprintDropRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                  left: (sprintDropRef.current?.getBoundingClientRect().right ?? 0) - 220,
                  minWidth: 220, zIndex: 9999 }}>
                <button className={`pm-dropdown-item${!activeSprint ? ' active' : ''}`}
                  onClick={() => { setActiveSprint(null); setSprintDropOpen(false) }}>
                  <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>
                    {!activeSprint && <Check size={12} />}
                  </span>
                  All sprints
                </button>
                {sortedSprints.map(s => (
                  <button key={s.id}
                    className={`pm-dropdown-item${activeSprint?.id === s.id ? ' active' : ''}`}
                    onClick={() => { setActiveSprint(s); setSprintDropOpen(false) }}
                    style={{ opacity: s.isCompleted ? 0.6 : 1 }}>
                    <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>
                      {activeSprint?.id === s.id && <Check size={12} />}
                    </span>
                    <span style={{ flex: 1 }}>{s.name}</span>
                    <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 8 }}>{fmtSprintDate(s.start)}–{fmtSprintDate(s.finish)}</span>
                    {s.isCompleted && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>✓</span>}
                  </button>
                ))}
              </div>,
              document.body
            )}
          </div>
        )}
      </div>

      {/* ── Content panel ── */}
      <div className="da-panel" key={view}>
        {/* Shared filter bar — hidden for Dev Report which has its own controls */}
        {view !== 'report' && (
          <DaFilterBar
            dateRange={dateRange}
            onDateRange={setDateRange}
            assignee={assigneeFilter}
            onAssignee={setAssigneeFilter}
            assignees={uniqueAssignees}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFrom={setCustomFrom}
            onCustomTo={setCustomTo}
            onApplyCustom={fetchData}
          />
        )}

        {loading && view !== 'report' && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0' }}>
            <SvgVelocityBarsLoader size={128} />
          </div>
        )}
        {!loading && view === 'feed' && (
          <ActivityFeedView timelines={timelines} onOpenDetail={handleOpenDetail} assigneeFilter={assigneeFilter} dateRange={dateRange} />
        )}
        {!loading && view === 'cards' && (
          <DeveloperCardsView timelines={timelines} onOpenDetail={handleOpenDetail} assigneeFilter={assigneeFilter} dateRange={dateRange} />
        )}
        {!loading && view === 'log' && (
          <TransitionLogView transitions={transitions} onOpenDetail={handleOpenDetail} assigneeFilter={assigneeFilter} dateRange={dateRange} sinceMs={sinceMs} untilMs={untilMs} />
        )}
        {!loading && view === 'heatmap' && (
          <LifecycleHeatmapView timelines={timelines} onOpenDetail={handleOpenDetail} assigneeFilter={assigneeFilter} dateRange={dateRange} />
        )}
        {view === 'report' && (
          <DevReportView onOpenDetail={handleOpenDetail} ytBaseUrl={ytBaseUrl} />
        )}
      </div>

      {/* ── Issue detail panel ── */}
      {detailLoading && !detailIssue && <IssueDetailSkeleton onClose={() => setDetailLoading(false)} />}
      {detailIssue && (
        <IssueDetailPanel
          issue={detailIssue}
          onClose={() => setDetailIssue(null)}
          ytBaseUrl={ytBaseUrl}
        />
      )}
    </div>
  )
}

export default DevActivityPage
