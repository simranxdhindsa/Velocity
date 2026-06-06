import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  RefreshCw, CheckCircle, Clock, AlertTriangle, TrendingDown, Users,
  GitBranch, ChevronDown, Check, X,
} from 'lucide-react'
import { api } from '../services/api'
import type { SprintBoardColumn, SprintBoardIssue, YouTrackSprint, YouTrackIssue } from '../services/api'
import { useWorkflowConfig } from '../hooks/useWorkflowConfig'
import { getActiveSource } from '../services/pmDataService'
import HoverCard, { HCRow, HCDivider, HCBadge, HCBar } from '../components/HoverCard'
import { IssueDetailPanel } from '../components/IssueDetailPanel'
import { useSprintsCache } from '@/contexts/VelocityDataContext'

interface Props {
  onBlockersChange: (ids: Set<string>) => void
  sprintId?: string
}

// ── Helpers (module-level, never recreated) ────────────────────────────────

const DONE_ROLES   = new Set(['dev_done', 'verified', 'deployed', 'closed'])
const BLOCKED_ROLE = 'blocked'
const ACTIVE_ROLE  = 'active'

function priorityClass(priority: string) {
  const p = priority.toUpperCase()
  if (p === 'P0' || p === 'CRITICAL') return 'do-priority-p0'
  if (p === 'P1') return 'do-priority-p1'
  if (p === 'P2') return 'do-priority-p2'
  return 'do-priority-p3'
}

function priorityLabel(p: string) {
  const up = p.toUpperCase()
  if (up === 'P0' || up === 'CRITICAL') return 'P0'
  if (up === 'P1') return 'P1'
  if (up === 'P2') return 'P2'
  return 'P3'
}

function fmtHours(h: number) {
  if (!h || h < 0.1) return ''
  const d = Math.floor(h / 24)
  const rem = Math.round(h % 24)
  if (d > 0 && rem > 0) return `${d}d ${rem}h`
  if (d > 0) return `${d}d`
  return `${rem}h`
}

function getInitials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('')
}

// Classify a column name into a role using workflow config map, then keyword fallback.
// Returns the role string or '' for unrecognised columns (backlog/todo).
function resolveColRole(colName: string, roleMap: Map<string, string>): string {
  const mapped = roleMap.get(colName.toLowerCase())
  if (mapped) return mapped
  const n = colName.toLowerCase().trim()
  if (n.includes('block')) return BLOCKED_ROLE
  // Done / completed columns — covers: Dev, Ready for Stage, Stage, Ready for Prod, Prod, Verified, Mobile Done, etc.
  if (
    n.includes('done') || n.includes('closed') || n.includes('deployed') || n.includes('verified') ||
    n.includes('prod') || n.includes('stage') || n.includes('ready for') ||
    n === 'dev' || n.startsWith('dev ') || n.endsWith(' dev')
  ) return 'dev_done'
  // Active / in-progress — only explicit "in progress" variants, not "dev" or "todo"
  if (n.includes('in progress') || n.includes('working') || n === 'active' || n.includes('review')) return ACTIVE_ROLE
  return ''  // backlog / to do / open / unknown
}

function fmtHoursCompact(h: number): string {
  if (h <= 0) return '0h'
  const d = Math.floor(h / 24)
  const hrs = Math.floor(h % 24)
  if (d > 0) return `${d}d ${hrs}h`
  return `${hrs}h`
}

function ticketHoverContent(issue: SprintBoardIssue) {
  const cycleLabel = issue.cycle_time_hours > 0 ? fmtHoursCompact(issue.cycle_time_hours) : null
  const devLabel   = issue.total_active_hours > 0 ? fmtHoursCompact(issue.total_active_hours) : null
  const stateLabel = issue.hours_in_state > 0 ? fmtHoursCompact(issue.hours_in_state) : null
  const overdueAccent = issue.overdue_level === 'deadline' ? 'danger'
    : (issue.overdue_level === 'sprint' || issue.is_delayed) ? 'warn' : undefined
  return (
    <div>
      <div className="hc-title" style={{ marginBottom: 2 }}>
        {issue.idReadable}
        {issue.is_hotfix && <HCBadge label="HF" variant="warn" />}
        {issue.issue_type && issue.issue_type.toLowerCase() !== 'task' && <HCBadge label={issue.issue_type} />}
      </div>
      <div className="hc-subtitle">{issue.summary}</div>
      <HCDivider />
      {stateLabel && <HCRow label="In state" value={stateLabel} accent={overdueAccent as any} />}
      {cycleLabel && <HCRow label="Cycle time" value={cycleLabel} />}
      {devLabel && <HCRow label="Dev time" value={devLabel} />}
      {issue.bounce_count > 0 && (
        <HCRow label="Bounces" value={`${issue.bounce_count}×`} accent="warn" />
      )}
      {issue.is_delayed && <HCRow label="Status" value="Overdue" accent={overdueAccent as any} />}
    </div>
  )
}

// ── Types ──────────────────────────────────────────────────────────────────

interface DevStat {
  name: string
  avatarUrl: string
  doneIssues: SprintBoardIssue[]
  activeIssues: SprintBoardIssue[]
  blockedIssues: SprintBoardIssue[]
  queuedIssues: SprintBoardIssue[]
  overdueIssues: SprintBoardIssue[]
  bouncedIssues: SprintBoardIssue[]
  totalActiveHours: number
  hotfixCount: number
}

type ChipKey = 'done' | 'active' | 'blocked' | 'bounced' | 'overdue' | 'todo' | null

// ── Avatar with initials fallback ──────────────────────────────────────────

function Avatar({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (url && !failed) {
    return (
      <img
        src={url}
        alt={name}
        className="dl-dev-avatar"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div className="dl-dev-avatar dl-dev-avatar--initials">
      {getInitials(name)}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function DailyOpsTab({ onBlockersChange, sprintId }: Props) {
  const wfConfig = useWorkflowConfig()
  const [columns, setColumns] = useState<SprintBoardColumn[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)
  const [ytBaseUrl, setYtBaseUrl] = useState('')
  const [ytDetailIssue, setYtDetailIssue] = useState<YouTrackIssue | null>(null)
  const [ytDetailLoading, setYtDetailLoading] = useState(false)

  // Stable ref so onBlockersChange doesn't force re-renders
  const onBlockersRef = useRef(onBlockersChange)
  useEffect(() => { onBlockersRef.current = onBlockersChange }, [onBlockersChange])

  // Fetch YouTrack base URL from DB integration
  useEffect(() => {
    api.getYouTrackStatus().then(res => {
      const url = (res as any).base_url || (res as any).data?.base_url || ''
      setYtBaseUrl(url.replace(/\/$/, ''))
    }).catch(() => {})
  }, [])

  const openInYouTrack = useCallback((idReadable: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!ytBaseUrl || !idReadable) return
    window.open(`${ytBaseUrl}/issue/${idReadable}`, '_blank', 'noopener,noreferrer')
  }, [ytBaseUrl])

  const openYtIssue = useCallback(async (idReadable: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (ytDetailLoading || !idReadable) return
    setYtDetailLoading(true)
    try {
      const res = await api.getYouTrackIssue(idReadable)
      setYtDetailIssue((res as any).data as YouTrackIssue)
    } catch { /* ignore */ }
    finally { setYtDetailLoading(false) }
  }, [ytDetailLoading])

  // column name → role (from workflow config + aliases)
  const columnRoleMap = useMemo(() => {
    const m = new Map<string, string>()
    if (!wfConfig?.column_hierarchy) return m
    for (const col of wfConfig.column_hierarchy) {
      m.set(col.state.toLowerCase(), col.role)
      for (const alias of (col.aliases || [])) {
        m.set(alias.toLowerCase(), col.role)
      }
    }
    return m
  }, [wfConfig])

  // Derive per-developer stats from sprint board columns
  const devStats = useMemo<DevStat[]>(() => {
    const map = new Map<string, DevStat>()

    for (const col of columns) {
      const role = resolveColRole(col.name, columnRoleMap)
      const isDone    = DONE_ROLES.has(role)
      const isBlocked = role === BLOCKED_ROLE
      const isActive  = role === ACTIVE_ROLE
      const isQueued  = !isDone && !isBlocked && !isActive  // backlog / todo

      for (const issue of col.issues) {
        const name = issue.assignee || 'Unassigned'
        if (!map.has(name)) {
          map.set(name, {
            name,
            avatarUrl: issue.avatarUrl || '',
            doneIssues: [],
            activeIssues: [],
            blockedIssues: [],
            queuedIssues: [],
            overdueIssues: [],
            bouncedIssues: [],
            totalActiveHours: 0,
            hotfixCount: 0,
          })
        }
        const stat = map.get(name)!

        if (isDone)    stat.doneIssues.push(issue)
        else if (isBlocked) stat.blockedIssues.push(issue)
        else if (isActive)  stat.activeIssues.push(issue)
        else if (isQueued)  stat.queuedIssues.push(issue)

        if ((isActive || isQueued) && issue.is_delayed) stat.overdueIssues.push(issue)
        if ((issue.bounce_count || 0) > 0) stat.bouncedIssues.push(issue)
        if (issue.is_hotfix) stat.hotfixCount++
        stat.totalActiveHours += issue.total_active_hours || 0
      }
    }

    return Array.from(map.values())
      .filter(d => d.name !== 'Unassigned')
      .sort((a, b) => {
        if (a.overdueIssues.length !== b.overdueIssues.length) return b.overdueIssues.length - a.overdueIssues.length
        if (a.blockedIssues.length !== b.blockedIssues.length) return b.blockedIssues.length - a.blockedIssues.length
        return b.activeIssues.length - a.activeIssues.length
      })
  }, [columns, columnRoleMap])

  // Side-effect: notify parent of blocked IDs — kept out of useMemo
  useEffect(() => {
    const ids = new Set<string>()
    for (const col of columns) {
      if (resolveColRole(col.name, columnRoleMap) === BLOCKED_ROLE) {
        for (const iss of col.issues) ids.add(iss.idReadable)
      }
    }
    onBlockersRef.current(ids)
  }, [columns, columnRoleMap])

  const load = useCallback(async () => {
    if (!sprintId) return
    setLoading(true)
    setError('')
    try {
      const res = await api.getSprintBoardStatus({ sprint_id: sprintId })
      const data = res.data
      if (data?.columns) {
        setColumns(data.columns)
        setRefreshedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load sprint data')
    } finally {
      setLoading(false)
    }
  }, [sprintId])

  useEffect(() => { load() }, [load])

  // Sprint-wide totals
  const totalActive  = devStats.reduce((s, d) => s + d.activeIssues.length, 0)
  const totalDone    = devStats.reduce((s, d) => s + d.doneIssues.length, 0)
  const totalBlocked = devStats.reduce((s, d) => s + d.blockedIssues.length, 0)
  const totalOverdue = devStats.reduce((s, d) => s + d.overdueIssues.length, 0)
  const totalToDo    = devStats.reduce((s, d) => s + d.queuedIssues.length, 0)

  // Modal state — which dev + which chip is open
  const [chipModal, setChipModal] = useState<{ title: string; issues: SprintBoardIssue[] } | null>(null)

  const openChipModal = useCallback((title: string, issues: SprintBoardIssue[]) => {
    setChipModal({ title, issues })
  }, [])

  return (
    <>
    <div className="do-scroll">
      <div className="do-block">

        {/* Header */}
        <div className="do-block-header">
          <span className="do-block-title dl-block-title-icon">
            <Users size={12} />
            Developer Load
          </span>
          <div className="do-block-actions">
            {refreshedAt && <span className="do-ts">Updated {refreshedAt}</span>}
            <button className="do-post-btn do-post-btn--secondary" onClick={load} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'spin' : ''} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Sprint summary bar */}
        {!loading && devStats.length > 0 && (
          <div className="dl-summary-bar">
            <div className="dl-summary-pill dl-summary-pill--active">
              <Clock size={10} />
              {totalActive} in progress
            </div>
            <div className="dl-summary-pill dl-summary-pill--done">
              <CheckCircle size={10} />
              {totalDone} done in sprint
            </div>
            {totalBlocked > 0 && (
              <div className="dl-summary-pill dl-summary-pill--blocked">
                <AlertTriangle size={10} />
                {totalBlocked} blocked
              </div>
            )}
            {totalOverdue > 0 && (
              <div className="dl-summary-pill dl-summary-pill--overdue">
                <TrendingDown size={10} />
                {totalOverdue} overdue
              </div>
            )}
            {totalToDo > 0 && (
              <div className="dl-summary-pill dl-summary-pill--todo">
                {totalToDo} to do
              </div>
            )}
            <span className="dl-summary-pill dl-summary-pill--count">
              {devStats.length} developers
            </span>
          </div>
        )}

        {error && <div className="do-error">{error}</div>}

        {/* Skeleton while loading */}
        {loading && (() => {
          const sk = (w: number | string, h: number, r = 5) =>
            <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
          return (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, padding: '0.5rem 0' }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '0.875rem', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {sk(36, 36, '50%')}{sk(80 + (i * 17 % 50), 13, 4)}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {sk(60, 20, 99)}{sk(60, 20, 99)}{sk(55, 20, 99)}
                  </div>
                  <div style={{ height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div className="skeleton" style={{ height: '100%', width: `${[60,40,75,50,85,30,65,45][i % 8]}%`, borderRadius: 4 }} />
                  </div>
                  {Array.from({ length: 3 }).map((_, j) => (
                    <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {sk(8, 8, '50%')}{sk(44, 11, 3)}{sk(`${55 + j * 12}%`, 11, 3)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )
        })()}

        {!loading && devStats.length === 0 && (
          <div className="do-loading">
            {sprintId ? 'No developer data found for this sprint' : 'Select a sprint to see developer load'}
          </div>
        )}

        {/* Developer cards grid — only when not loading */}
        {!loading && <div className="do-dev-grid">
          {devStats.map(dev => {
            // Overloaded = workload problem: too many in-progress tickets (> 5)
            // Overdue is a separate concern shown via its own chip
            const isOverloaded = dev.activeIssues.length > 5
            const hasBlocked   = dev.blockedIssues.length > 0
            // Progress = done out of (done + active + blocked), excludes backlog
            const denominator  = dev.doneIssues.length + dev.activeIssues.length + dev.blockedIssues.length
            const donePercent  = denominator > 0 ? Math.round(dev.doneIssues.length / denominator * 100) : 0

            return (
              <div
                key={dev.name}
                className={`do-dev-card dl-dev-card ${isOverloaded ? 'dl-dev-card--overloaded' : hasBlocked ? 'dl-dev-card--blocked' : ''}`}
              >
                {/* Header row */}
                <div className="dl-dev-header">
                  <div className="dl-dev-identity">
                    <Avatar url={dev.avatarUrl} name={dev.name} />
                    <div className="dl-dev-name-wrap">
                      <span className="do-dev-name">{dev.name}</span>
                      <span className="dl-dev-total">
                        {denominator} tracked{dev.queuedIssues.length > 0 ? ` · ${dev.queuedIssues.length} to do` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="dl-dev-badge-row">
                    {isOverloaded && <span className="do-overloaded-badge">Overloaded</span>}
                    {dev.hotfixCount > 0 && <span className="dl-hotfix-badge">{dev.hotfixCount} HF</span>}
                  </div>
                </div>

                {/* Progress bar: done vs total tracked */}
                <div className="dl-progress-wrap">
                  <div className="dl-progress-bar">
                    <div className="dl-progress-done" style={{ width: `${donePercent}%` }} />
                  </div>
                  <span className="dl-progress-label">{donePercent}%</span>
                </div>

                {/* Stat chips — all clickable, open modal */}
                <div className="dl-stat-chips">
                  <div className="dl-stat-chip dl-stat-chip--done dl-stat-chip--clickable"
                    onClick={() => openChipModal(`Done · ${dev.name}`, dev.doneIssues)}>
                    <CheckCircle size={9} />{dev.doneIssues.length} done
                  </div>
                  <div className="dl-stat-chip dl-stat-chip--active dl-stat-chip--clickable"
                    onClick={() => openChipModal(`In Progress · ${dev.name}`, dev.activeIssues)}>
                    <Clock size={9} />{dev.activeIssues.length} active
                  </div>
                  {hasBlocked && (
                    <div className="dl-stat-chip dl-stat-chip--blocked dl-stat-chip--clickable"
                      onClick={() => openChipModal(`Blocked · ${dev.name}`, dev.blockedIssues)}>
                      <AlertTriangle size={9} />{dev.blockedIssues.length} blocked
                    </div>
                  )}
                  {dev.bouncedIssues.length > 0 && (
                    <div className="dl-stat-chip dl-stat-chip--bounce dl-stat-chip--clickable"
                      onClick={() => openChipModal(`Bounced · ${dev.name}`, dev.bouncedIssues)}>
                      ↩{dev.bouncedIssues.length} bounced
                    </div>
                  )}
                  {dev.overdueIssues.length > 0 && (
                    <div className="dl-stat-chip dl-stat-chip--overdue dl-stat-chip--clickable"
                      onClick={() => openChipModal(`Overdue · ${dev.name}`, dev.overdueIssues)}>
                      ⏰ {dev.overdueIssues.length} overdue
                    </div>
                  )}
                  {dev.queuedIssues.length > 0 && (
                    <div className="dl-stat-chip dl-stat-chip--todo dl-stat-chip--clickable"
                      onClick={() => openChipModal(`To Do · ${dev.name}`, dev.queuedIssues)}>
                      {dev.queuedIssues.length} to do
                    </div>
                  )}
                </div>

                {/* Active issues preview */}
                {dev.activeIssues.length > 0 && (
                  <div className="do-dev-issues">
                    {dev.activeIssues.slice(0, 4).map(iss => (
                      <HoverCard key={iss.id} content={ticketHoverContent(iss)} maxWidth={280}>
                        <div className={`do-dev-issue-row ${priorityClass(iss.priority)}`}>
                          <span className={`do-prio-dot do-prio-dot--${priorityLabel(iss.priority).toLowerCase()}`} />
                          <span className="do-issue-id do-issue-id--link"
                            onClick={(e) => openInYouTrack(iss.idReadable, e)}>{iss.idReadable}</span>
                          <span className="do-issue-summary do-issue-summary--clickable"
                            onClick={(e) => openYtIssue(iss.idReadable, e)}>{iss.summary}</span>
                          {iss.is_delayed && <span className="do-overdue-chip">Late</span>}
                          {(iss.bounce_count || 0) > 0 && (
                            <span className="dl-bounce-dot">↩{iss.bounce_count}</span>
                          )}
                        </div>
                      </HoverCard>
                    ))}
                    {dev.activeIssues.length > 4 && (
                      <button className="do-dev-more do-dev-more--btn"
                        onClick={() => openChipModal(`In Progress · ${dev.name}`, dev.activeIssues)}>
                        +{dev.activeIssues.length - 4} more in progress
                      </button>
                    )}
                  </div>
                )}

                {/* Blocked issues preview */}
                {dev.blockedIssues.length > 0 && (
                  <div className="do-dev-issues do-dev-issues--blocked">
                    {dev.blockedIssues.map(iss => (
                      <HoverCard key={iss.id} content={ticketHoverContent(iss)} maxWidth={280}>
                        <div className="do-dev-issue-row do-priority-p0">
                          <span className="do-prio-dot do-prio-dot--p0" />
                          <span className="do-issue-id do-issue-id--link"
                            onClick={(e) => openInYouTrack(iss.idReadable, e)}>{iss.idReadable}</span>
                          <span className="do-issue-summary do-issue-summary--clickable"
                            onClick={(e) => openYtIssue(iss.idReadable, e)}>{iss.summary}</span>
                          <span className="do-blocker-badge">Blocked</span>
                        </div>
                      </HoverCard>
                    ))}
                  </div>
                )}

                {/* To Do preview */}
                {dev.queuedIssues.length > 0 && (
                  <div className="do-dev-issues do-dev-issues--todo">
                    {dev.queuedIssues.slice(0, 3).map(iss => (
                      <HoverCard key={iss.id} content={ticketHoverContent(iss)} maxWidth={280}>
                        <div className={`do-dev-issue-row ${priorityClass(iss.priority)}`}>
                          <span className={`do-prio-dot do-prio-dot--${priorityLabel(iss.priority).toLowerCase()}`} />
                          <span className="do-issue-id do-issue-id--link"
                            onClick={(e) => openInYouTrack(iss.idReadable, e)}>{iss.idReadable}</span>
                          <span className="do-issue-summary do-issue-summary--clickable"
                            onClick={(e) => openYtIssue(iss.idReadable, e)}>{iss.summary}</span>
                          {iss.is_hotfix && <span className="do-overdue-chip" style={{ background: 'rgba(249,115,22,0.2)', color: '#fb923c' }}>HF</span>}
                        </div>
                      </HoverCard>
                    ))}
                    {dev.queuedIssues.length > 3 && (
                      <button className="do-dev-more do-dev-more--btn"
                        onClick={() => openChipModal(`To Do · ${dev.name}`, dev.queuedIssues)}>
                        +{dev.queuedIssues.length - 3} more to do
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>}

      </div>
    </div>

    {/* YouTrack issue detail panel */}
    {ytDetailIssue && (
      <IssueDetailPanel
        issue={ytDetailIssue}
        onClose={() => setYtDetailIssue(null)}
        ytBaseUrl={ytBaseUrl}
      />
    )}

    {/* Chip modal — list of tickets for a selected chip category */}
    {chipModal && createPortal(
      <div className="pm-tracking-detail-overlay" onClick={() => setChipModal(null)}>
        <div className="pm-tracking-detail-modal do-chip-modal" onClick={e => e.stopPropagation()}>
          <div className="pm-tracking-detail-header">
            <span className="pm-tracking-detail-summary" style={{ fontWeight: 600 }}>{chipModal.title}</span>
            <button className="pm-tracking-detail-close" onClick={() => setChipModal(null)}><X size={16} /></button>
          </div>
          <div className="do-chip-modal-body">
            {chipModal.issues.length === 0 && (
              <div className="do-chip-modal-empty">No tickets in this category</div>
            )}
            {chipModal.issues.map(iss => (
              <div key={iss.id} className={`do-chip-modal-row ${priorityClass(iss.priority)}`}>
                <span className={`do-prio-dot do-prio-dot--${priorityLabel(iss.priority).toLowerCase()}`} />
                <span
                  className="do-issue-id do-issue-id--link"
                  title={`Open ${iss.idReadable} in YouTrack`}
                  onClick={(e) => openInYouTrack(iss.idReadable, e)}
                >{iss.idReadable}</span>
                <span
                  className="do-chip-modal-summary do-issue-summary--clickable"
                  title={iss.summary}
                  onClick={(e) => openYtIssue(iss.idReadable, e)}
                >{iss.summary}</span>
                <div className="do-chip-modal-meta">
                  {iss.current_state && <span className="do-chip-modal-state">{iss.current_state}</span>}
                  {iss.is_delayed && <span className="do-overdue-chip">Late</span>}
                  {iss.is_hotfix  && <span className="do-overdue-chip" style={{ background: 'rgba(249,115,22,0.2)', color: '#fb923c' }}>HF</span>}
                  {(iss.bounce_count || 0) > 0 && <span className="dl-bounce-dot">↩{iss.bounce_count}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  )
}

// ── Standalone page wrapper with sprint selector ───────────────────────────

const DO_SPRINT_ID_KEY   = 'pm_active_sprint_id'
const DO_SPRINT_NAME_KEY = 'pm_active_sprint_name'

function fmtSprintDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function DailyOpsPage() {
  const isYouTrack = getActiveSource() === 'youtrack'

  // Sprints from shared cache — no duplicate network call when Board tab already loaded them
  const { data: cachedSprints } = useSprintsCache()
  const sprints: YouTrackSprint[] = isYouTrack ? ((cachedSprints as YouTrackSprint[] | null) ?? []) : []
  const [activeSprint, setActiveSprint]     = useState<YouTrackSprint | null | undefined>(undefined)
  const [dropdownOpen, setDropdownOpen]     = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef    = useRef<HTMLDivElement>(null)

  // Auto-select active sprint once sprints are available
  useEffect(() => {
    if (!isYouTrack || activeSprint !== undefined || sprints.length === 0) return
    const now    = Date.now()
    const active = sprints
      .filter(s => !s.isCompleted && s.finish > now)
      .sort((a, b) => a.finish - b.finish)[0] ?? null
    setActiveSprint(active)
    localStorage.setItem(DO_SPRINT_ID_KEY, active?.id ?? '')
    localStorage.setItem(DO_SPRINT_NAME_KEY, active?.name ?? '')
  }, [isYouTrack, sprints, activeSprint])

  // Outside-click closes the dropdown
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSprintChange = (sprint: YouTrackSprint | null) => {
    setActiveSprint(sprint)
    setDropdownOpen(false)
    localStorage.setItem(DO_SPRINT_ID_KEY, sprint?.id ?? '')
    localStorage.setItem(DO_SPRINT_NAME_KEY, sprint?.name ?? '')
  }

  const sortedSprints = [...sprints].sort((a, b) => b.finish - a.finish)

  return (
    <div className="do-page-wrap">
      {/* Sprint selector bar */}
      {isYouTrack && (
        <div className="do-sprint-bar">
          <div ref={triggerRef} style={{ position: 'relative' }}>
            <button
              className="do-sprint-trigger"
              onClick={() => setDropdownOpen(o => !o)}
            >
              <GitBranch size={13} />
              {activeSprint ? (
                <>
                  {activeSprint.name}
                  <span className="do-sprint-dates">
                    {fmtSprintDate(activeSprint.start)}–{fmtSprintDate(activeSprint.finish)}
                  </span>
                </>
              ) : (
                <span>Select sprint</span>
              )}
              <ChevronDown size={12} style={{ opacity: 0.5 }} />
            </button>
            {dropdownOpen && createPortal(
              <div
                ref={menuRef}
                className="pm-custom-dropdown-menu"
                style={{
                  position: 'fixed',
                  top:   (triggerRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                  right: window.innerWidth - (triggerRef.current?.getBoundingClientRect().right ?? 0),
                  minWidth: 240,
                  zIndex: 9999,
                }}
              >
                <button
                  className={`pm-dropdown-item${!activeSprint ? ' active' : ''}`}
                  onClick={() => handleSprintChange(null)}
                >
                  <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>
                    {!activeSprint && <Check size={12} />}
                  </span>
                  All sprints
                </button>
                {sortedSprints.length === 0 && (
                  <div style={{ padding: '9px 14px', fontSize: 13, opacity: 0.5 }}>No sprints found</div>
                )}
                {sortedSprints.map(s => (
                  <button
                    key={s.id}
                    className={`pm-dropdown-item${activeSprint?.id === s.id ? ' active' : ''}`}
                    onClick={() => handleSprintChange(s)}
                    style={{ opacity: s.isCompleted ? 0.6 : 1 }}
                  >
                    <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>
                      {activeSprint?.id === s.id && <Check size={12} />}
                    </span>
                    <span style={{ flex: 1 }}>{s.name}</span>
                    <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 8 }}>
                      {fmtSprintDate(s.start)}–{fmtSprintDate(s.finish)}
                    </span>
                    {s.isCompleted && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>✓</span>}
                  </button>
                ))}
              </div>,
              document.body
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <DailyOpsTab onBlockersChange={() => {}} sprintId={activeSprint?.id} />
    </div>
  )
}
