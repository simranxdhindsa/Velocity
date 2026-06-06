import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown, Check, RefreshCw, GitBranch,
  BarChart2, Zap, Target, Activity, X, GitMerge,
} from 'lucide-react'
import api from '@/services/api'
import type {
  YouTrackSprint, SprintBoardIssue, SprintBoardColumn,
  SprintSummary, SprintBoardStatusResponse, YouTrackIssue,
  FeatureGroup, PriorityTag,
} from '@/services/api'
import { IssueDetailPanel } from '@/components/IssueDetailPanel'
import HoverCard, { HCRow, HCDivider, HCBadge, HCBar } from '@/components/HoverCard'
import { useWorkflowConfig } from '@/hooks/useWorkflowConfig'
import '../styles/pages/dashboard.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const SPRINT_ID_KEY   = 'pm_active_sprint_id'
const SPRINT_NAME_KEY = 'pm_active_sprint_name'

type DesignMode = 'velocity' | 'bento' | 'ops'

const DESIGN_MODES: { id: DesignMode; label: string; icon: typeof Activity }[] = [
  { id: 'velocity', label: 'Velocity',    icon: Activity },
  { id: 'bento',   label: 'Bento Grid',  icon: BarChart2 },
  { id: 'ops',     label: 'Ops Command', icon: Zap },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtSprintDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fmtHours(hours: number): string {
  if (!hours || hours <= 0) return '—'
  const d = Math.floor(hours / 24)
  const h = Math.round(hours % 24)
  if (d > 0 && h > 0) return `${d}d ${h}h`
  if (d > 0) return `${d}d`
  return `${h}h`
}

function fmtCountdown(finishMs: number): string {
  const diff = finishMs - Date.now()
  if (diff < 0) return 'OVERDUE'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  if (days > 0) return `${days}d ${hours}h`
  return `${hours}h`
}

/** Backend sends completion_pct as a 0–100 float; round to integer for display */
function toPct(raw: number): number {
  return Math.round(raw ?? 0)
}

function getPriClass(priority: string): string {
  const p = (priority || '').toLowerCase()
  if (p === 'a1' || p === 'p0' || p === 'critical') return 'db-pri--critical'
  if (p === 'a2' || p === 'p1' || p === 'high')     return 'db-pri--high'
  if (p === 'a3' || p === 'p2' || p === 'medium' || p === 'normal') return 'db-pri--medium'
  return 'db-pri--low'
}

function urgencyClass(iss: SprintBoardIssue): string {
  if (iss.overdue_level === 'deadline') return 'db-urgency--deadline'
  if (iss.overdue_level === 'sprint' || iss.overdue_level === 'sla') return 'db-urgency--risk'
  if (iss.bounce_count > 0) return 'db-urgency--bounced'
  return ''
}

function urgencyScore(iss: SprintBoardIssue): number {
  if (iss.bounce_count >= 3)            return 5
  if (iss.bounce_count >= 2)            return 4
  if (iss.bounce_count >= 1)            return 3
  if (iss.overdue_level === 'deadline') return 2.5
  if (iss.overdue_level === 'sprint')   return 2
  if (iss.overdue_level === 'sla')      return 1.5
  if (iss.is_delayed)                   return 1
  return 0
}

function isBlockedCol(name: string): boolean {
  return (name || '').toLowerCase().includes('block')
}
function isProgressCol(name: string): boolean {
  return (name || '').toLowerCase().includes('progress')
}
function isDoneCol(name: string): boolean {
  const n = (name || '').toLowerCase()
  return n.includes('done') || n.includes('clos') || n.includes('deploy') ||
         n.includes('verif') || n.includes('prod') || n.includes('stage')
}

// ─── Role-aware column classification ────────────────────────────────────────
// Uses workflow config roles when available, falls back to keyword matching.

const DONE_ROLES = new Set(['dev_done', 'verified', 'deployed', 'closed'])

function resolveRole(stateName: string, roleMap: Map<string, string>): string {
  const mapped = roleMap.get((stateName || '').toLowerCase())
  if (mapped) return mapped
  if (isDoneCol(stateName))    return 'dev_done'
  if (isBlockedCol(stateName)) return 'blocked'
  if (isProgressCol(stateName)) return 'active'
  return 'backlog'
}

function isIssueDone(i: SprintBoardIssue, roleMap: Map<string, string>): boolean {
  return DONE_ROLES.has(resolveRole(i.current_state, roleMap))
}

function isIssueBlocked(i: SprintBoardIssue, roleMap: Map<string, string>): boolean {
  return resolveRole(i.current_state, roleMap) === 'blocked'
}

function isIssueActive(i: SprintBoardIssue, roleMap: Map<string, string>): boolean {
  return resolveRole(i.current_state, roleMap) === 'active'
}

// ─── Issue type categorization ───────────────────────────────────────────────

type IssueCategory = 'feature' | 'bug' | 'task' | 'other'

function categorizeIssue(issueType: string): IssueCategory {
  const t = (issueType || '').toLowerCase().trim()
  if (!t) return 'other'
  if (t.includes('feature') || t.includes('story') || t.includes('epic')) return 'feature'
  if (t.includes('bug') || t.includes('defect') || t.includes('hotfix')) return 'bug'
  if (t.includes('task') || t.includes('enhancement') || t.includes('improvement') ||
      t.includes('chore') || t.includes('tech debt') || t.includes('techdebt')) return 'task'
  return 'other'
}

// ─── Shared Sub-components ────────────────────────────────────────────────────

function DBAvatar({ name, url, size = 28 }: { name: string; url?: string; size?: number }) {
  const initials = (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
  if (url) {
    return (
      <img
        src={url} alt={name}
        className="db-avatar"
        style={{ width: size, height: size }}
        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div
      className="db-avatar db-avatar--initials"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials}
    </div>
  )
}

function getPriColorFromTags(priority: string, tags: PriorityTag[]): string | null {
  if (!tags?.length || !priority) return null
  const p = priority.toLowerCase()
  const tag = tags.find(t =>
    t.prefixes?.some(px => px.toLowerCase() === p) ||
    t.yt_mappings?.some(m => m.toLowerCase() === p) ||
    t.label?.toLowerCase() === p
  )
  return tag?.color ?? null
}

function PriPill({ priority, tags }: { priority: string; tags?: PriorityTag[] }) {
  const color = tags ? getPriColorFromTags(priority, tags) : null
  if (color) {
    return (
      <span className="db-pri-pill" style={{
        background: color + '26', color, border: `1px solid ${color}44`,
      }}>
        {priority || '?'}
      </span>
    )
  }
  return <span className={`db-pri-pill ${getPriClass(priority)}`}>{priority || '?'}</span>
}

function VerifBadges({ dev, stg, prd }: { dev?: string; stg?: string; prd?: string }) {
  if (!dev && !stg && !prd) return null
  return (
    <div className="db-verif-badges">
      {dev && <span className="db-verif-badge db-verif-badge--dev" title={`DEV: ${dev}`}>DEV✓</span>}
      {stg && <span className="db-verif-badge db-verif-badge--stg" title={`STG: ${stg}`}>STG✓</span>}
      {prd && <span className="db-verif-badge db-verif-badge--prd" title={`PRD: ${prd}`}>PRD✓</span>}
    </div>
  )
}

function KpiChip({ label, value, cls, onClick }: { label: string; value: number | string; cls?: string; onClick?: () => void }) {
  return (
    <div className={`db-kpi-chip${cls ? ` ${cls}` : ''}${onClick ? ' db-kpi-chip--clickable' : ''}`} onClick={onClick}>
      <span className="db-kpi-chip-val">{value}</span>
      <span className="db-kpi-chip-label">{label}</span>
    </div>
  )
}

function SprintTrack({ pct }: { pct: number }) {
  return (
    <div className="db-sprint-track">
      <div className="db-sprint-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  )
}

function Countdown({ finishMs }: { finishMs: number }) {
  if (!finishMs) return null
  const label = fmtCountdown(finishMs)
  const overdue = Date.now() > finishMs
  const urgent  = !overdue && finishMs - Date.now() < 86400000 * 2
  return (
    <span className={`db-countdown${overdue ? ' db-countdown--overdue' : urgent ? ' db-countdown--urgent' : ''}`}>
      {overdue ? '⚠ ' : '⏱ '}{label}
    </span>
  )
}

// Shows the YouTrack issue type (Feature / Bug / Task / etc.) as a compact pill
function IssueTypePill({ issueType }: { issueType?: string }) {
  if (!issueType) return null
  const cat = categorizeIssue(issueType)
  const label = issueType.length > 12 ? issueType.slice(0, 12) + '…' : issueType
  return <span className={`db-type-pill db-type-pill--${cat}`} title={issueType}>{label}</span>
}

// Sprint composition breakdown (features / bugs / tasks) with at-risk feature alert.
// Returns null when no issues have issue_type populated (graceful degradation).
function TypeDeliveryPanel({
  columns,
  summary,
  columnRoleMap,
}: {
  columns: SprintBoardColumn[]
  summary: SprintSummary
  columnRoleMap: Map<string, string>
}) {
  const CATS: IssueCategory[] = ['feature', 'bug', 'task', 'other']
  const CAT_LABELS: Record<IssueCategory, string> = { feature: 'Features', bug: 'Bugs', task: 'Tasks', other: 'Other' }

  const allIssues = useMemo(() => columns.flatMap(c => c.issues), [columns])
  const hasTypes  = useMemo(() => allIssues.some(i => !!i.issue_type), [allIssues])

  const daysLeft = summary.sprint_finish_ms > 0
    ? Math.ceil((summary.sprint_finish_ms - Date.now()) / 86400000)
    : null

  // All hooks must run before any conditional return
  const stats = useMemo(() => {
    if (!hasTypes) return []
    const acc: Record<IssueCategory, { total: number; done: number; active: number; notStarted: number }> = {
      feature: { total: 0, done: 0, active: 0, notStarted: 0 },
      bug:     { total: 0, done: 0, active: 0, notStarted: 0 },
      task:    { total: 0, done: 0, active: 0, notStarted: 0 },
      other:   { total: 0, done: 0, active: 0, notStarted: 0 },
    }
    allIssues.forEach(iss => {
      const cat  = categorizeIssue(iss.issue_type)
      const role = resolveRole(iss.current_state, columnRoleMap)
      acc[cat].total++
      if (DONE_ROLES.has(role))   acc[cat].done++
      else if (role === 'active') acc[cat].active++
      else                        acc[cat].notStarted++
    })
    return CATS.map(cat => ({ cat, label: CAT_LABELS[cat], ...acc[cat] })).filter(s => s.total > 0)
  }, [allIssues, columnRoleMap, hasTypes])

  // Features that haven't started (not done, not active) with sprint ending in ≤ 4 days
  const atRiskFeatures = useMemo(() => {
    if (!hasTypes || daysLeft === null || daysLeft > 4) return []
    return allIssues.filter(iss => {
      if (categorizeIssue(iss.issue_type) !== 'feature') return false
      const role = resolveRole(iss.current_state, columnRoleMap)
      return !DONE_ROLES.has(role) && role !== 'active'
    })
  }, [allIssues, columnRoleMap, daysLeft, hasTypes])

  // Now safe to conditionally render
  if (!hasTypes) return null

  return (
    <div className="db-type-panel">
      <div className="db-mc-section-label" style={{ marginBottom: 8, marginTop: 0 }}>Sprint Composition</div>
      {stats.map(st => {
        const pct  = st.total > 0 ? Math.round((st.done / st.total) * 100) : 0
        const warn = st.cat === 'feature' && st.notStarted > 0 && daysLeft !== null && daysLeft <= 4
        return (
          <div key={st.cat} className="db-type-stat-row">
            <span className={`db-type-stat-label db-type-stat-label--${st.cat}`}>{st.label}</span>
            <div className="db-type-stat-bar-wrap">
              <div className="db-type-stat-bar">
                <div className="db-type-stat-fill" style={{ width: `${pct}%`, background: `var(--db-type-${st.cat})` }} />
              </div>
            </div>
            <span className="db-type-stat-nums">
              {st.done}<span className="db-type-stat-total">/{st.total}</span>
            </span>
            {warn && (
              <span className="db-type-stat-warn" title={`${st.notStarted} not started, sprint ends in ${daysLeft}d`}>
                ⚠{st.notStarted}
              </span>
            )}
          </div>
        )
      })}

      {atRiskFeatures.length > 0 && (
        <div className="db-type-risk-banner">
          <div className="db-type-risk-header">
            ⚠ {atRiskFeatures.length} feature{atRiskFeatures.length !== 1 ? 's' : ''} not started — sprint ends in {daysLeft}d
          </div>
          {atRiskFeatures.slice(0, 3).map(iss => (
            <div key={iss.idReadable} className="db-type-risk-row">
              <span className="db-ticket-id">{iss.idReadable}</span>
              <span className="db-type-risk-title" title={iss.summary}>{iss.summary}</span>
            </div>
          ))}
          {atRiskFeatures.length > 3 && (
            <div className="db-type-risk-more">+{atRiskFeatures.length - 3} more</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Hover content builders ───────────────────────────────────────────────────

function devHoverContent(dev: { name: string; active: SprintBoardIssue[]; blocked: SprintBoardIssue[]; done: SprintBoardIssue[]; bounceCount: number; totalActiveHours: number }) {
  const total = dev.active.length + dev.blocked.length + dev.done.length
  const overdue = dev.active.filter(i => i.is_delayed).length
  return (
    <div>
      <div className="hc-title">{dev.name}</div>
      <div className="hc-subtitle">{total} ticket{total !== 1 ? 's' : ''} this sprint</div>
      <HCDivider />
      <HCRow label="Active"  value={dev.active.length}  accent={dev.active.length > 4 ? 'warn' : undefined} />
      <HCRow label="Blocked" value={dev.blocked.length} accent={dev.blocked.length > 0 ? 'danger' : undefined} />
      <HCRow label="Done"    value={dev.done.length}    accent={dev.done.length > 0 ? 'ok' : undefined} />
      {dev.bounceCount > 0 && <HCRow label="Bounces" value={dev.bounceCount} accent="warn" />}
      {overdue > 0 && <HCRow label="Overdue" value={overdue} accent="danger" />}
      {dev.totalActiveHours > 0 && <HCRow label="Dev hours" value={fmtHours(dev.totalActiveHours)} />}
      {total > 0 && (
        <>
          <HCDivider />
          <div className="hc-stack">
            {dev.active.length  > 0 && <div className="hc-stack-seg hc-stack-seg--active"  style={{ flex: dev.active.length }}  />}
            {dev.blocked.length > 0 && <div className="hc-stack-seg hc-stack-seg--blocked" style={{ flex: dev.blocked.length }} />}
            {dev.done.length    > 0 && <div className="hc-stack-seg hc-stack-seg--done"    style={{ flex: dev.done.length }}    />}
          </div>
        </>
      )}
    </div>
  )
}

function issueHoverContent(iss: SprintBoardIssue) {
  const cycleLabel = iss.cycle_time_hours > 0 ? fmtHours(iss.cycle_time_hours) : null
  const devLabel   = iss.total_active_hours > 0 ? fmtHours(iss.total_active_hours) : null
  const overdueAccent = iss.overdue_level === 'deadline' ? 'danger'
    : (iss.overdue_level === 'sprint' || iss.is_delayed) ? 'warn' : undefined
  const hasVerif = iss.verified_on_dev || iss.verified_on_stage || iss.verified_on_prod
  return (
    <div>
      <div className="hc-title">{iss.idReadable}</div>
      <div className="hc-subtitle">{iss.summary}</div>
      <HCDivider />
      {iss.hours_in_state > 0 && <HCRow label="In state" value={fmtHours(iss.hours_in_state)} accent={overdueAccent} />}
      {cycleLabel && <HCRow label="Cycle" value={cycleLabel} />}
      {devLabel   && <HCRow label="Dev"   value={devLabel} />}
      {iss.bounce_count > 0 && <HCRow label="Bounces" value={`${iss.bounce_count}×`} accent="warn" />}
      {iss.assignee && <HCRow label="Assignee" value={iss.assignee} />}
      {hasVerif && (
        <>
          <HCDivider />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {iss.verified_on_dev   && <HCBadge label={`DEV✓`} variant="dev" />}
            {iss.verified_on_stage && <HCBadge label={`STG✓`} variant="stg" />}
            {iss.verified_on_prod  && <HCBadge label={`PRD✓`} variant="prd" />}
          </div>
        </>
      )}
    </div>
  )
}

function kpiHoverContent(type: string, summary: SprintSummary, columns: SprintBoardColumn[]) {
  if (type === 'completion') {
    const remaining = summary.total_issues - summary.done_issues
    return (
      <div>
        <div className="hc-title">Sprint Completion</div>
        <HCDivider />
        <HCRow label="Done"      value={summary.done_issues} accent="ok" />
        <HCRow label="Remaining" value={remaining} accent={remaining > 0 ? 'warn' : undefined} />
        <HCRow label="Total"     value={summary.total_issues} />
        <div style={{ marginTop: 6 }}>
          <HCBar pct={summary.completion_pct} color="#4ade80" />
        </div>
      </div>
    )
  }
  if (type === 'blocked') {
    const blocked = columns.flatMap(c => c.issues).filter(i => i.current_state?.toLowerCase().includes('block')).slice(0, 4)
    return (
      <div>
        <div className="hc-title">{summary.blocked_count} Blocked</div>
        <div className="hc-subtitle">Tickets awaiting external unblocking</div>
        {blocked.length > 0 && (
          <>
            <HCDivider />
            <div className="hc-issue-list">
              {blocked.map(i => (
                <div key={i.idReadable} className="hc-issue-item">
                  <div className="hc-issue-dot hc-issue-dot--blocked" />
                  <span className="hc-issue-id">{i.idReadable}</span>
                  <span className="hc-issue-summary">{i.summary}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    )
  }
  if (type === 'bounced') {
    const bounced = columns.flatMap(c => c.issues).filter(i => i.bounce_count > 0).sort((a,b) => b.bounce_count - a.bounce_count).slice(0, 4)
    return (
      <div>
        <div className="hc-title">{summary.bounced_count} Bounced</div>
        <div className="hc-subtitle">Tickets moved backwards</div>
        {bounced.length > 0 && (
          <>
            <HCDivider />
            <div className="hc-issue-list">
              {bounced.map(i => (
                <div key={i.idReadable} className="hc-issue-item">
                  <div className="hc-issue-dot hc-issue-dot--atrisk" />
                  <span className="hc-issue-id">{i.idReadable}</span>
                  <span className="hc-issue-summary">↩{i.bounce_count} {i.summary}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    )
  }
  if (type === 'overdue') {
    const overdue = columns.flatMap(c => c.issues).filter(i => i.is_delayed).sort((a,b) => urgencyScore(b) - urgencyScore(a)).slice(0, 4)
    return (
      <div>
        <div className="hc-title">{summary.overdue_count} Overdue</div>
        <div className="hc-subtitle">Tickets past SLA or sprint deadline</div>
        {overdue.length > 0 && (
          <>
            <HCDivider />
            <div className="hc-issue-list">
              {overdue.map(i => (
                <div key={i.idReadable} className="hc-issue-item">
                  <div className={`hc-issue-dot ${i.overdue_level === 'deadline' ? 'hc-issue-dot--overdue' : 'hc-issue-dot--atrisk'}`} />
                  <span className="hc-issue-id">{i.idReadable}</span>
                  <span className="hc-issue-summary">{i.summary}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    )
  }
  if (type === 'sprint') {
    const isOver = Date.now() > summary.sprint_finish_ms
    const daysLeft = Math.floor((summary.sprint_finish_ms - Date.now()) / 86400000)
    return (
      <div>
        <div className="hc-title">Sprint Timeline</div>
        <HCDivider />
        <HCRow label="Status"    value={isOver ? 'Overdue' : `${daysLeft}d remaining`} accent={isOver ? 'danger' : daysLeft < 2 ? 'warn' : undefined} />
        <HCRow label="End date"  value={new Date(summary.sprint_finish_ms).toLocaleDateString()} />
        <HCRow label="Done"      value={`${summary.completion_pct}%`} accent="ok" />
      </div>
    )
  }
  return null
}

// ─── KPI Summary Bar (shared across all views) ────────────────────────────────

type DbKpiDrawer = 'completion' | 'blocked' | 'bounced' | 'overdue' | 'in-progress' | 'hotfix' | 'sprint' | null

function KpiBar({ summary, activeDrawer, onKpiClick, columns = [] }: {
  summary: SprintSummary
  activeDrawer: DbKpiDrawer
  onKpiClick: (type: DbKpiDrawer) => void
  columns?: SprintBoardColumn[]
}) {
  const pct = toPct(summary.completion_pct)
  const isOverdue = summary.sprint_finish_ms > 0 && Date.now() > summary.sprint_finish_ms
  const isUrgent  = !isOverdue && summary.sprint_finish_ms > 0 &&
                    summary.sprint_finish_ms - Date.now() < 86400000 * 2
  const tog = (type: DbKpiDrawer) => onKpiClick(activeDrawer === type ? null : type)
  return (
    <div className="db-kpi-bar">
      <HoverCard content={kpiHoverContent('completion', summary, columns)} delay={400} maxWidth={220}>
      <button className={`db-kpi-bar-item db-kpi-bar-item--primary db-kpi-bar-item--btn${activeDrawer === 'completion' ? ' db-kpi-bar-item--active' : ''}`}
        onClick={() => tog('completion')}>
        <span className="db-kpi-bar-val">{summary.done_issues}/{summary.total_issues}</span>
        <span className="db-kpi-bar-label">Done</span>
        <div className="db-kpi-bar-track">
          <div className="db-kpi-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="db-kpi-bar-pct">{pct}%</span>
      </button>
      </HoverCard>

      <div className="db-kpi-bar-sep" />

      <HoverCard content={kpiHoverContent('blocked', summary, columns)} delay={400} maxWidth={260}>
      <button className={`db-kpi-bar-item db-kpi-bar-item--btn${summary.blocked_count > 0 ? ' db-kpi-bar-item--danger' : ''}${activeDrawer === 'blocked' ? ' db-kpi-bar-item--active' : ''}`}
        onClick={() => tog('blocked')}>
        <span className="db-kpi-bar-val">{summary.blocked_count}</span>
        <span className="db-kpi-bar-label">Blocked</span>
      </button>
      </HoverCard>

      <HoverCard content={kpiHoverContent('bounced', summary, columns)} delay={400} maxWidth={260}>
      <button className={`db-kpi-bar-item db-kpi-bar-item--btn${summary.bounced_count > 0 ? ' db-kpi-bar-item--warn' : ''}${activeDrawer === 'bounced' ? ' db-kpi-bar-item--active' : ''}`}
        onClick={() => tog('bounced')}>
        <span className="db-kpi-bar-val">{summary.bounced_count}</span>
        <span className="db-kpi-bar-label">Bounced</span>
      </button>
      </HoverCard>

      <HoverCard content={kpiHoverContent('overdue', summary, columns)} delay={400} maxWidth={260}>
      <button className={`db-kpi-bar-item db-kpi-bar-item--btn${summary.overdue_count > 0 ? ' db-kpi-bar-item--danger' : ''}${activeDrawer === 'overdue' ? ' db-kpi-bar-item--active' : ''}`}
        onClick={() => tog('overdue')}>
        <span className="db-kpi-bar-val">{summary.overdue_count}</span>
        <span className="db-kpi-bar-label">Overdue</span>
      </button>
      </HoverCard>

      <button className={`db-kpi-bar-item db-kpi-bar-item--info db-kpi-bar-item--btn${activeDrawer === 'in-progress' ? ' db-kpi-bar-item--active' : ''}`}
        onClick={() => tog('in-progress')}>
        <span className="db-kpi-bar-val">{summary.in_progress_count}</span>
        <span className="db-kpi-bar-label">In Progress</span>
      </button>

      {summary.hotfix_count > 0 && (
        <button className={`db-kpi-bar-item db-kpi-bar-item--hotfix db-kpi-bar-item--btn${activeDrawer === 'hotfix' ? ' db-kpi-bar-item--active' : ''}`}
          onClick={() => tog('hotfix')}>
          <span className="db-kpi-bar-val">{summary.hotfix_count}</span>
          <span className="db-kpi-bar-label">Hotfixes</span>
        </button>
      )}

      {summary.sprint_finish_ms > 0 && (
        <>
          <div className="db-kpi-bar-sep" />
          <HoverCard content={kpiHoverContent('sprint', summary, columns)} delay={400} maxWidth={230}>
          <button className={`db-kpi-bar-item db-kpi-bar-item--btn${activeDrawer === 'sprint' ? ' db-kpi-bar-item--active' : ''}${isOverdue ? ' db-kpi-bar-item--danger' : isUrgent ? ' db-kpi-bar-item--warn' : ''}`}
            onClick={() => tog('sprint')}>
            <span className="db-kpi-bar-val">{fmtCountdown(summary.sprint_finish_ms)}</span>
            <span className="db-kpi-bar-label">Sprint ends</span>
          </button>
          </HoverCard>
        </>
      )}
    </div>
  )
}

// ─── Skeleton Loaders ─────────────────────────────────────────────────────────

function SkeletonBar({ w, h = 10, radius = 4 }: { w: string | number; h?: number; radius?: number }) {
  return (
    <div
      className="skeleton"
      style={{ width: w, height: h, borderRadius: radius, flexShrink: 0 }}
    />
  )
}

function SkeletonKpiBar() {
  return (
    <div className="db-kpi-bar db-kpi-bar--skeleton">
      {[80, 60, 60, 60, 70, 90].map((w, i) => (
        <div key={i} className="db-kpi-bar-item">
          <SkeletonBar w={w} h={18} />
          <SkeletonBar w={40} h={9} />
        </div>
      ))}
    </div>
  )
}

function SkeletonVelocity() {
  return (
    <div className="db-mc-layout">
      <div className="db-mc-col db-mc-col--left">
        <SkeletonBar w="60%" h={11} />
        {[1,2,3,4].map(i => (
          <div key={i} className="db-mc-dev-card" style={{ gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <SkeletonBar w={26} h={26} radius={99} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
                <SkeletonBar w="50%" h={10} />
                <SkeletonBar w="70%" h={8} />
              </div>
            </div>
            <SkeletonBar w="100%" h={6} radius={99} />
          </div>
        ))}
      </div>
      <div className="db-mc-col db-mc-col--center">
        <SkeletonBar w="50%" h={11} />
        {[1,2,3].map(i => (
          <div key={i} className="db-mc-focus-card" style={{ gap: 7 }}>
            <SkeletonBar w="80%" h={10} />
            <SkeletonBar w="100%" h={12} />
            <SkeletonBar w="60%" h={8} />
          </div>
        ))}
      </div>
      <div className="db-mc-col db-mc-col--right">
        <SkeletonBar w="60%" h={11} />
        <div className="db-mc-kpi-grid">
          {[1,2,3,4].map(i => <div key={i} className="db-kpi-chip"><SkeletonBar w="100%" h={36} /></div>)}
        </div>
        <SkeletonBar w="100%" h={8} radius={99} />
        {[1,2,3,4,5].map(i => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '5px 0' }}>
            <SkeletonBar w="40%" h={9} />
            <SkeletonBar w="40%" h={6} radius={99} />
            <SkeletonBar w={20} h={9} />
          </div>
        ))}
      </div>
    </div>
  )
}

function SkeletonBento() {
  return (
    <div className="db-bg-layout">
      <div className="db-bg-row db-bg-row--r1">
        {[1,2].map(i => (
          <div key={i} className="db-bg-card">
            <div className="db-bg-topline skeleton" style={{ animation: 'none', opacity: 0.3 }} />
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <SkeletonBar w="50%" h={11} />
              <SkeletonBar w="80%" h={34} />
              <SkeletonBar w="100%" h={8} radius={99} />
              <div style={{ display: 'flex', gap: 8 }}>
                {[1,2,3,4].map(j => <div key={j} className="db-kpi-chip"><SkeletonBar w="100%" h={36} /></div>)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="db-bg-row db-bg-row--r2">
        {[1,2].map(i => (
          <div key={i} className="db-bg-card">
            <div className="db-bg-topline skeleton" style={{ animation: 'none', opacity: 0.3 }} />
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SkeletonBar w="50%" h={11} />
              {[1,2,3,4].map(j => (
                <div key={j} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <SkeletonBar w={22} h={22} radius={99} />
                  <SkeletonBar w="60%" h={9} />
                  <SkeletonBar w="30%" h={6} radius={99} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="db-bg-row db-bg-row--r3">
        <div className="db-bg-card" style={{ gridColumn: '1/-1' }}>
          <div className="db-bg-topline skeleton" style={{ animation: 'none', opacity: 0.3 }} />
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 9 }}>
            <SkeletonBar w="30%" h={11} />
            {[1,2,3,4,5,6].map(i => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <SkeletonBar w={60} h={9} />
                <SkeletonBar w={30} h={9} />
                <SkeletonBar w="40%" h={9} />
                <SkeletonBar w="15%" h={9} />
                <SkeletonBar w="10%" h={9} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function SkeletonOps() {
  return (
    <div className="db-oc-layout">
      <div className="db-oc-left">
        {[1,2,3].map(i => (
          <div key={i} className="db-oc-panel-section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SkeletonBar w="70%" h={11} />
            <SkeletonBar w="100%" h={8} radius={99} />
            <SkeletonBar w="50%" h={16} />
          </div>
        ))}
        <div className="db-oc-panel-section db-oc-kpi-grid">
          {[1,2,3,4].map(i => <div key={i} className="db-kpi-chip"><SkeletonBar w="100%" h={36} /></div>)}
        </div>
        <div className="db-oc-panel-section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1,2,3,4].map(i => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <SkeletonBar w={22} h={22} radius={99} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <SkeletonBar w="50%" h={9} />
                <SkeletonBar w="80%" h={5} radius={99} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="db-oc-right">
        <div className="db-oc-feed">
          {[1,2,3,4,5,6,7,8].map(i => (
            <div key={i} className="db-oc-feed-row" style={{ padding: '10px 16px', gap: 10 }}>
              <div className="db-oc-feed-left-bar skeleton" style={{ opacity: 0.2 }} />
              <div className="db-oc-feed-content" style={{ gap: 6 }}>
                <SkeletonBar w="30%" h={9} />
                <SkeletonBar w="70%" h={11} />
                <SkeletonBar w="40%" h={8} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Design 1: Velocity ───────────────────────────────────────────────────────

interface DevStat {
  name: string; avatarUrl: string
  inProgress: SprintBoardIssue[]; queued: SprintBoardIssue[]
  blocked: SprintBoardIssue[]; done: SprintBoardIssue[]
  active: SprintBoardIssue[]  // inProgress + queued combined (for backward-compat)
  bounceCount: number; totalActiveHours: number
}

// ─── Feature Health Widget ────────────────────────────────────────────────────

const HEALTH_ORDER: Record<string, number> = { partial: 0, pending: 1, done: 2 }

function FGIssueLine({ issue }: { issue: FeatureGroup['issues'][0] }) {
  const typeLabel = (t: string) => {
    const u = (t || '').toUpperCase()
    if (u === 'FRONTEND' || u === 'FE') return 'FE'
    if (u === 'BACKEND'  || u === 'BE') return 'BE'
    if (u === 'RAG')    return 'RAG'
    if (u === 'MOBILE') return 'MOB'
    return u.slice(0, 3) || '?'
  }
  const typeCls = (t: string) => {
    const u = (t || '').toUpperCase()
    if (u === 'FRONTEND' || u === 'FE') return 'fg-type--fe'
    if (u === 'BACKEND'  || u === 'BE') return 'fg-type--be'
    if (u === 'RAG')    return 'fg-type--rag'
    if (u === 'MOBILE') return 'fg-type--mob'
    return 'fg-type--other'
  }
  const stateRole = (s: string) => {
    const v = (s || '').toLowerCase()
    if (v.includes('done') || v.includes('closed') || v.includes('deploy') || v.includes('verif') || v.includes('fixed')) return 'done'
    if (v.includes('progress') || v.includes('review') || v.includes('block') || v.includes('testing')) return 'active'
    return 'pending'
  }
  const hoverContent = (
    <div>
      <div className="hc-title" style={{ marginBottom: 2 }}>
        {issue.id_readable}
        <HCBadge label={typeLabel(issue.issue_type)} />
        {!issue.in_sprint && <HCBadge label="External" variant="warn" />}
      </div>
      <div className="hc-subtitle">{issue.summary}</div>
      <HCDivider />
      <HCRow label="State"    value={issue.current_state || '—'} />
      <HCRow label="Assignee" value={issue.assignee || '—'} />
      {issue.priority && <HCRow label="Priority" value={issue.priority} />}
    </div>
  )
  return (
    <HoverCard content={hoverContent} maxWidth={280}>
      <div className="fg-issue-row">
        <span className={`fg-type-badge ${typeCls(issue.issue_type)}`}>{typeLabel(issue.issue_type)}</span>
        <span className="fg-issue-id">{issue.id_readable}</span>
        <span className="fg-issue-summary" title={issue.summary}>{issue.summary}</span>
        <span className={`fg-state-pill fg-state--${issue.state_class || 'pending'}`}>{issue.current_state || '—'}</span>
        {issue.assignee && <span className="fg-assignee">{issue.assignee}</span>}
      </div>
    </HoverCard>
  )
}

function FeatureHealthWidget({ sprintId, expandable }: { sprintId?: string; expandable?: boolean }) {
  const [groups, setGroups]   = useState<FeatureGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  // Per-group collapse state when fully expanded
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!sprintId) { setLoading(false); return }
    setLoading(true)
    api.getFeatureGroups(sprintId)
      .then(res => setGroups((res as any).data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [sprintId])

  const done    = groups.filter(g => g.health === 'done').length
  const partial = groups.filter(g => g.health === 'partial').length
  const pending = groups.filter(g => g.health === 'pending').length

  const sortedGroups = [...groups].sort((a, b) => (HEALTH_ORDER[a.health] ?? 3) - (HEALTH_ORDER[b.health] ?? 3))
  const previewGroups = sortedGroups.filter(g => g.health !== 'done').slice(0, 4)

  const toggleGroup = (id: string) => setCollapsedGroups(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  function healthBadgeCls(h: string) {
    if (h === 'done')    return 'fg-health--done'
    if (h === 'partial') return 'fg-health--partial'
    return 'fg-health--pending'
  }
  function healthLabel(h: string) {
    if (h === 'done')    return 'Done'
    if (h === 'partial') return 'Partial'
    return 'Pending'
  }

  return (
    <div className="fg-widget">
      <div className="fg-widget-header">
        <GitMerge size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span className="fg-widget-title">Feature Groups</span>
        {expandable && !loading && expanded && (
          <button className="fg-widget-toggle-btn" onClick={() => setExpanded(false)}>
            ↑ Collapse
          </button>
        )}
      </div>

      {loading && (
        <div className="fg-widget-loading">
          <div className="skeleton" style={{ width: '100%', height: 24, borderRadius: 4 }} />
          <div className="skeleton" style={{ width: '70%',  height: 14, borderRadius: 4 }} />
        </div>
      )}

      {!loading && groups.length === 0 && (
        <div className="fg-widget-empty">No feature groups detected</div>
      )}

      {!loading && groups.length > 0 && (
        <>
          <div className="fg-widget-chips">
            <span className="fg-widget-chip fg-widget-chip--done">{done} complete</span>
            <span className="fg-widget-chip fg-widget-chip--partial">{partial} partial</span>
            {pending > 0 && <span className="fg-widget-chip fg-widget-chip--pending">{pending} pending</span>}
          </div>

          {/* Collapsed: show compact partial/pending list */}
          {!expanded && previewGroups.length > 0 && (
            <div className="fg-widget-list">
              {previewGroups.map(g => (
                <div key={g.id} className="fg-widget-row">
                  <span className={`fg-health-badge ${healthBadgeCls(g.health)}`} style={{ fontSize: 9, padding: '1px 5px' }}>
                    {healthLabel(g.health)}
                  </span>
                  <span className="fg-widget-row-name" title={g.name}>{g.name}</span>
                  <span className="fg-widget-row-count">{g.done_count}/{g.total_count}</span>
                </div>
              ))}
              {groups.length > previewGroups.length && !expanded && (
                <button className="db-view-more-btn" onClick={() => setExpanded(true)}>
                  ↓ View {groups.length - previewGroups.length} more
                </button>
              )}
            </div>
          )}

          {/* Expanded: full group cards with issue rows */}
          {expanded && (
            <div className="fg-widget-expanded">
              {sortedGroups.map(g => {
                const pct = g.total_count > 0 ? Math.round((g.done_count / g.total_count) * 100) : 0
                const isCollapsed = collapsedGroups.has(g.id)
                return (
                  <div key={g.id} className={`fg-card fg-card--${g.health}`} style={{ margin: '0 0 6px' }}>
                    <div className="fg-card-header" onClick={() => toggleGroup(g.id)}>
                      <span className={`fg-health-badge ${healthBadgeCls(g.health)}`}>{healthLabel(g.health)}</span>
                      <span className="fg-card-name">{g.name}</span>
                      <span className="fg-card-count">{g.done_count}/{g.total_count}</span>
                      <div className="fg-card-bar"><div className="fg-card-bar-fill" style={{ width: `${pct}%` }} /></div>
                      <span className="fg-card-pct">{pct}%</span>
                      <ChevronDown size={12} className={`fg-card-chevron${isCollapsed ? '' : ' fg-card-chevron--open'}`} />
                    </div>
                    {!isCollapsed && (
                      <div className="fg-card-issues">
                        {g.issues.map(iss => <FGIssueLine key={iss.id_readable} issue={iss} />)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

interface DesignProps {
  summary: SprintSummary
  columns: SprintBoardColumn[]
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
  ytDetailLoading?: boolean
  onKpiClick?: (drawer: DbKpiDrawer) => void
  sprintId?: string
}

function Design1({ summary, columns, onTitleClick, onIdClick, ytDetailLoading, onKpiClick, sprintId }: DesignProps) {
  const [expandedDev, setExpandedDev] = useState<string | null>(null)
  const [devModal, setDevModal] = useState<{ title: string; issues: SprintBoardIssue[] } | null>(null)
  const [showAllAtRisk, setShowAllAtRisk] = useState(false)
  const [showAllDelay, setShowAllDelay] = useState(false)

  const { config: wfConfig } = useWorkflowConfig()
  const columnRoleMap = useMemo(() => {
    const m = new Map<string, string>()
    if (wfConfig) {
      wfConfig.column_hierarchy.forEach((col: any) => {
        m.set(col.state.toLowerCase(), col.role)
        ;(col.aliases ?? []).forEach((a: string) => m.set(a.toLowerCase(), col.role))
      })
    }
    return m
  }, [wfConfig])

  const developers = useMemo<DevStat[]>(() => {
    const map = new Map<string, DevStat>()
    columns.forEach(col => col.issues.forEach(iss => {
      const key = iss.assignee || 'Unassigned'
      if (!map.has(key)) map.set(key, {
        name: key, avatarUrl: iss.avatarUrl,
        inProgress: [], queued: [], active: [], blocked: [], done: [],
        bounceCount: 0, totalActiveHours: 0,
      })
      const d = map.get(key)!
      d.totalActiveHours += iss.total_active_hours
      if (isBlockedCol(col.name))       { d.blocked.push(iss); d.bounceCount += iss.bounce_count }
      else if (isDoneCol(col.name))     d.done.push(iss)
      else if (isProgressCol(col.name)) { d.inProgress.push(iss); d.active.push(iss); d.bounceCount += iss.bounce_count }
      else                              { d.queued.push(iss); d.active.push(iss) }
    }))
    return Array.from(map.values()).sort((a, b) => b.inProgress.length - a.inProgress.length)
  }, [columns])

  const atRisk = useMemo(() =>
    columns.flatMap(c => c.issues)
      .filter(i => !isIssueDone(i, columnRoleMap) && (urgencyScore(i) > 0 || isIssueBlocked(i, columnRoleMap)))
      .sort((a, b) => {
        const s = (x: SprintBoardIssue) => {
          let score = 0
          if      (x.bounce_count >= 3) score += 30
          else if (x.bounce_count >= 2) score += 22
          else if (x.bounce_count >= 1) score += 14
          if (isIssueActive(x, columnRoleMap))     score += 10
          if (x.overdue_level === 'deadline')       score += 7
          else if (x.overdue_level === 'sprint')    score += 5
          else if (x.overdue_level === 'sla')       score += 3
          if (x.is_hotfix)                          score += 2
          if (isIssueBlocked(x, columnRoleMap))     score += 1
          return score
        }
        return s(b) - s(a)
      })
  , [columns, columnRoleMap])

  const delayRows = useMemo(() =>
    columns.filter(c => isProgressCol(c.name))
      .flatMap(c => c.issues)
      .sort((a, b) => b.cycle_time_hours - a.cycle_time_hours)
  , [columns])

  const barW = 220
  function barSegs(iss: SprintBoardIssue) {
    const scale = barW / (10 * 24)
    const workPx   = Math.min(barW, iss.total_active_hours * scale)
    const bouncePx = Math.min(barW - workPx, iss.bounce_count * 0.5 * 24 * scale)
    const idlePx   = Math.max(0, Math.min(barW - workPx - bouncePx,
      (iss.cycle_time_hours - iss.total_active_hours) * scale))
    return { workPx, bouncePx, idlePx }
  }

  return (
    <>
    <div className="db-mc-layout">
      {/* ── Left: Developer Load ── */}
      <div className="db-mc-col db-mc-col--left">
        <div className="db-mc-section-label">Developer Load</div>
        {developers.map(dev => {
          const total = dev.inProgress.length + dev.queued.length + dev.blocked.length + dev.done.length
          return (
            <HoverCard key={dev.name} content={devHoverContent(dev)} delay={350} maxWidth={230}>
            <div className="db-mc-dev-card">
              <div
                className="db-mc-dev-header"
                onClick={() => setExpandedDev(expandedDev === dev.name ? null : dev.name)}
              >
                <DBAvatar name={dev.name} url={dev.avatarUrl} size={26} />
                <div className="db-mc-dev-info">
                  <span className="db-mc-dev-name">{dev.name.split(' ')[0]}</span>
                  <span className="db-mc-dev-meta">
                    {dev.inProgress.length} in prog.
                    {dev.queued.length > 0  && <span> · {dev.queued.length} to do</span>}
                    {dev.blocked.length > 0 && <span className="db-mc-dev-blocked"> · {dev.blocked.length} blocked</span>}
                    {dev.bounceCount > 0    && <span className="db-mc-dev-bounced"> · ↩{dev.bounceCount}</span>}
                  </span>
                </div>
                <span className="db-mc-dev-hours">{fmtHours(dev.totalActiveHours)}</span>
              </div>
              {total > 0 && (
                <div className="db-mc-load-bar">
                  <div className="db-mc-load-seg db-mc-load-seg--active"  style={{ width: `${(dev.inProgress.length / total) * 100}%` }} />
                  <div className="db-mc-load-seg db-mc-load-seg--queued"  style={{ width: `${(dev.queued.length    / total) * 100}%` }} />
                  <div className="db-mc-load-seg db-mc-load-seg--blocked" style={{ width: `${(dev.blocked.length   / total) * 100}%` }} />
                  <div className="db-mc-load-seg db-mc-load-seg--done"    style={{ width: `${(dev.done.length      / total) * 100}%` }} />
                </div>
              )}
              {expandedDev === dev.name && (
                <div className="db-mc-dev-tickets">
                  {/* In Progress */}
                  {dev.inProgress.length > 0 && (
                    <>
                      <div className="db-mc-dev-section-label db-mc-dev-section-label--active">In Progress ({dev.inProgress.length})</div>
                      {dev.inProgress.map(iss => (
                        <div key={iss.idReadable} className={`db-mc-ticket-row ${urgencyClass(iss)}`}>
                          <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
                          <span className="db-ticket-id db-ticket-id--link" onClick={(e) => onIdClick(iss.idReadable, e)}>{iss.idReadable}</span>
                          <span className="db-mc-ticket-title db-ticket-title--link" onClick={(e) => onTitleClick(iss.idReadable, e)} title={iss.summary}>{iss.summary}</span>
                          {iss.bounce_count > 0 && <span className="db-bounce-chip">↩{iss.bounce_count}</span>}
                          <span className="db-mc-ticket-time">{fmtHours(iss.hours_in_state)}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {/* Blocked */}
                  {dev.blocked.length > 0 && (
                    <>
                      <div className="db-mc-dev-section-label db-mc-dev-section-label--blocked">Blocked ({dev.blocked.length})</div>
                      {dev.blocked.map(iss => (
                        <div key={iss.idReadable} className={`db-mc-ticket-row ${urgencyClass(iss)}`}>
                          <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
                          <span className="db-ticket-id db-ticket-id--link" onClick={(e) => onIdClick(iss.idReadable, e)}>{iss.idReadable}</span>
                          <span className="db-mc-ticket-title db-ticket-title--link" onClick={(e) => onTitleClick(iss.idReadable, e)} title={iss.summary}>{iss.summary}</span>
                          <span className="db-mc-ticket-time">{fmtHours(iss.hours_in_state)}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {/* To Do */}
                  {dev.queued.length > 0 && (
                    <>
                      <div className="db-mc-dev-section-label db-mc-dev-section-label--queued">To Do ({dev.queued.length})</div>
                      {dev.queued.slice(0, 5).map(iss => (
                        <div key={iss.idReadable} className="db-mc-ticket-row">
                          <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
                          <span className="db-ticket-id db-ticket-id--link" onClick={(e) => onIdClick(iss.idReadable, e)}>{iss.idReadable}</span>
                          <span className="db-mc-ticket-title db-ticket-title--link" onClick={(e) => onTitleClick(iss.idReadable, e)} title={iss.summary}>{iss.summary}</span>
                        </div>
                      ))}
                      {dev.queued.length > 5 && (
                        <button className="db-mc-ticket-more db-view-more-btn"
                          onClick={() => setDevModal({ title: `To Do · ${dev.name}`, issues: dev.queued })}>
                          ↓ View {dev.queued.length - 5} more to do
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            </HoverCard>
          )
        })}
      </div>

      {/* ── Center: At Risk + Delay Bars ── */}
      <div className="db-mc-col db-mc-col--center">
        <div>
          <div className="db-mc-section-label">
            At Risk
            {atRisk.length > 0 && <span className="db-mc-section-count">{atRisk.length}</span>}
          </div>
          {atRisk.slice(0, showAllAtRisk ? atRisk.length : 5).map(iss => (
            <HoverCard key={iss.idReadable} content={issueHoverContent(iss)} maxWidth={270} delay={300}>
            <div className={`db-mc-focus-card ${urgencyClass(iss)}`}>
              <div className="db-mc-focus-top">
                <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
                <IssueTypePill issueType={iss.issue_type} />
                <span
                  className="db-ticket-id db-ticket-id--link"
                  onClick={(e) => onIdClick(iss.idReadable, e)}
                  title={`Open ${iss.idReadable} in YouTrack`}
                >{iss.idReadable}</span>
                {iss.is_hotfix && <span className="db-hotfix-chip">HF</span>}
                {iss.bounce_count > 0 && <span className="db-bounce-chip">↩{iss.bounce_count}</span>}
                <span className="db-ticket-state" style={{ marginLeft: 'auto' }}>{iss.current_state}</span>
              </div>
              <div
                className="db-mc-focus-title db-ticket-title--link"
                onClick={(e) => onTitleClick(iss.idReadable, e)}
              >{iss.summary}</div>
              <div className="db-mc-focus-footer">
                <DBAvatar name={iss.assignee || '?'} url={iss.avatarUrl} size={16} />
                <span className="db-mc-focus-assignee">{iss.assignee?.split(' ')[0] || 'Unassigned'}</span>
                <span
                  className="db-mc-focus-time"
                  style={{ color: iss.overdue_level === 'deadline' ? 'var(--color-danger)' : undefined }}
                >
                  {fmtHours(iss.hours_in_state)} in state
                </span>
                <VerifBadges dev={iss.verified_on_dev} stg={iss.verified_on_stage} prd={iss.verified_on_prod} />
              </div>
            </div>
            </HoverCard>
          ))}
          {!showAllAtRisk && atRisk.length > 5 && (
            <button className="db-view-more-btn" onClick={() => setShowAllAtRisk(true)}>
              ↓ View {atRisk.length - 5} more
            </button>
          )}
          {showAllAtRisk && atRisk.length > 5 && (
            <button className="db-view-more-btn" onClick={() => setShowAllAtRisk(false)}>
              ↑ Show less
            </button>
          )}
          {atRisk.length === 0 && (
            <div style={{ fontSize: '0.72rem', color: 'var(--color-success)', padding: '8px 0' }}>
              ✓ No at-risk tickets
            </div>
          )}
        </div>

        {delayRows.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="db-mc-section-label">Delay Analysis</div>
            <div className="db-mc-delay-legend">
              <span className="db-mc-legend-item db-mc-legend-work">Work</span>
              <span className="db-mc-legend-item db-mc-legend-bounce">Bounce</span>
              <span className="db-mc-legend-item db-mc-legend-idle">Idle</span>
            </div>
            {delayRows.slice(0, showAllDelay ? delayRows.length : 5).map(iss => {
              const { workPx, bouncePx, idlePx } = barSegs(iss)
              return (
                <div key={iss.idReadable} className="db-mc-delay-row">
                  <div className="db-mc-delay-id">
                    <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
                    <span
                      className="db-ticket-id db-ticket-id--link"
                      onClick={(e) => onIdClick(iss.idReadable, e)}
                      title={`Open ${iss.idReadable} in YouTrack`}
                    >{iss.idReadable}</span>
                  </div>
                  <div className="db-mc-delay-bar-wrap">
                    <div className="db-mc-timebar" style={{ width: barW }}>
                      <div className="db-mc-tb-seg db-mc-tb-seg--work"   style={{ width: workPx }} />
                      <div className="db-mc-tb-seg db-mc-tb-seg--bounce" style={{ width: bouncePx, left: workPx }} />
                      <div className="db-mc-tb-seg db-mc-tb-seg--idle"   style={{ width: idlePx,   left: workPx + bouncePx }} />
                    </div>
                    <span className="db-mc-delay-time">{fmtHours(iss.cycle_time_hours)}</span>
                  </div>
                </div>
              )
            })}
            {!showAllDelay && delayRows.length > 5 && (
              <button className="db-view-more-btn" onClick={() => setShowAllDelay(true)}>
                ↓ View {delayRows.length - 5} more
              </button>
            )}
            {showAllDelay && delayRows.length > 5 && (
              <button className="db-view-more-btn" onClick={() => setShowAllDelay(false)}>
                ↑ Show less
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Right: Sprint Health + Column Breakdown ── */}
      <div className="db-mc-col db-mc-col--right">
        <div className="db-mc-section-label">Sprint Health</div>
        <div className="db-mc-kpi-grid">
          <KpiChip label="Done"     value={`${summary.done_issues}/${summary.total_issues}`} cls="db-kpi-chip--success" />
          <KpiChip label="Blocked"  value={summary.blocked_count}  cls="db-kpi-chip--danger" onClick={() => onKpiClick?.('blocked')} />
          <KpiChip label="Bounced"  value={summary.bounced_count}  cls="db-kpi-chip--warn"   onClick={() => onKpiClick?.('bounced')} />
          <KpiChip label="Overdue"  value={summary.overdue_count}  cls="db-kpi-chip--danger" onClick={() => onKpiClick?.('overdue')} />
        </div>
        <SprintTrack pct={toPct(summary.completion_pct)} />
        {summary.sprint_finish_ms > 0 && <Countdown finishMs={summary.sprint_finish_ms} />}

        <div style={{ marginTop: 14 }}>
          <FeatureHealthWidget sprintId={sprintId} />
        </div>

        <div className="db-mc-section-label" style={{ marginTop: 16 }}>By Column</div>
        {columns.map(col => (
          <div key={col.name} className="db-mc-col-row">
            <span className="db-mc-col-name" title={col.name}>{col.name}</span>
            <div className="db-mc-col-bar-track">
              <div
                className="db-mc-col-bar-fill"
                style={{
                  width: `${summary.total_issues ? (col.total / summary.total_issues) * 100 : 0}%`,
                  background: isBlockedCol(col.name)  ? 'var(--color-danger)'
                            : isProgressCol(col.name) ? 'var(--color-primary)'
                            : isDoneCol(col.name)      ? 'var(--color-success)'
                            : 'var(--text-faint)',
                }}
              />
            </div>
            <span className="db-mc-col-cnt">{col.total}</span>
          </div>
        ))}
        <TypeDeliveryPanel columns={columns} summary={summary} columnRoleMap={columnRoleMap} />
      </div>
    </div>

    {/* Dev issue list modal */}
    {devModal && createPortal(
      <div className="pm-tracking-detail-overlay" onClick={() => setDevModal(null)}>
        <div className="pm-tracking-detail-modal do-chip-modal" onClick={e => e.stopPropagation()}>
          <div className="pm-tracking-detail-header">
            <span className="pm-tracking-detail-summary" style={{ fontWeight: 600 }}>{devModal.title}</span>
            <button className="pm-tracking-detail-close" onClick={() => setDevModal(null)}><X size={16} /></button>
          </div>
          <div className="do-chip-modal-body">
            {devModal.issues.map(iss => (
              <div key={iss.idReadable} className="do-chip-modal-row">
                <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
                <span className="do-issue-id do-issue-id--link" onClick={(e) => onIdClick(iss.idReadable, e)}>{iss.idReadable}</span>
                <span className="do-chip-modal-summary do-issue-summary--clickable" title={iss.summary} onClick={(e) => onTitleClick(iss.idReadable, e)}>{iss.summary}</span>
                <div className="do-chip-modal-meta">
                  {iss.current_state && <span className="do-chip-modal-state">{iss.current_state}</span>}
                  {iss.is_delayed && <span className="do-overdue-chip">Late</span>}
                  {iss.bounce_count > 0 && <span className="dl-bounce-dot">↩{iss.bounce_count}</span>}
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

// ─── Design 2: Bento Intelligence Grid ───────────────────────────────────────

function SprintDonut({ pct, size = 110 }: { pct: number; size?: number }) {
  const r = (size - 16) / 2
  const cx = size / 2; const cy = size / 2
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  return (
    <svg width={size} height={size} style={{ display: 'block', transform: 'rotate(-90deg)' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--glass-border)" strokeWidth={10} />
      <circle
        cx={cx} cy={cy} r={r} fill="none"
        stroke="var(--color-primary)" strokeWidth={10}
        strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.6s ease' }}
      />
    </svg>
  )
}

function Design2({ summary, columns, onTitleClick, onIdClick, sprintId }: DesignProps) {
  const allIssues = useMemo(() => columns.flatMap(c => c.issues), [columns])
  const pct = toPct(summary.completion_pct)
  const [showAllNeeds, setShowAllNeeds]   = useState(false)
  const [showAllIssues, setShowAllIssues] = useState(false)

  const { config: wfConfig } = useWorkflowConfig()
  const columnRoleMap = useMemo(() => {
    const m = new Map<string, string>()
    if (wfConfig) {
      wfConfig.column_hierarchy.forEach((col: any) => {
        m.set(col.state.toLowerCase(), col.role)
        ;(col.aliases ?? []).forEach((a: string) => m.set(a.toLowerCase(), col.role))
      })
    }
    return m
  }, [wfConfig])

  // Issues that genuinely need PM attention: not done AND (blocked | overdue | bounced≥2 | hotfix)
  const needsAttention = useMemo(() =>
    allIssues
      .filter(i => !isIssueDone(i, columnRoleMap))
      .filter(i =>
        isIssueBlocked(i, columnRoleMap) ||
        !!i.overdue_level ||
        i.bounce_count >= 2 ||
        i.is_hotfix
      )
      .sort((a, b) => {
        const s = (x: SprintBoardIssue) => {
          let score = 0
          if      (x.bounce_count >= 3) score += 30
          else if (x.bounce_count >= 2) score += 22
          else if (x.bounce_count >= 1) score += 14
          if (isIssueActive(x, columnRoleMap))     score += 10
          if (x.overdue_level === 'deadline')       score += 7
          else if (x.overdue_level === 'sprint')    score += 5
          else if (x.overdue_level === 'sla')       score += 3
          if (x.is_hotfix)                          score += 2
          if (isIssueBlocked(x, columnRoleMap))     score += 1
          return score
        }
        return s(b) - s(a)
      })
  , [allIssues, columnRoleMap])

  const developers = useMemo(() => {
    const map = new Map<string, { name: string; url: string; inProgress: number; queued: number; active: number; blocked: number; done: number; hours: number }>()
    columns.forEach(col => col.issues.forEach(iss => {
      const key = iss.assignee || 'Unassigned'
      if (!map.has(key)) map.set(key, { name: key, url: iss.avatarUrl, inProgress: 0, queued: 0, active: 0, blocked: 0, done: 0, hours: 0 })
      const d = map.get(key)!
      d.hours += iss.total_active_hours
      const role = resolveRole(col.name, columnRoleMap)
      if (role === 'blocked')          d.blocked++
      else if (DONE_ROLES.has(role))  d.done++
      else if (role === 'active')      { d.inProgress++; d.active++ }
      else                             { d.queued++;     d.active++ }
    }))
    return Array.from(map.values())
  }, [columns, columnRoleMap])

  return (
    <div className="db-bg-layout">
      {/* Row 1: Sprint Health (2/3) + Column Distribution (1/3) */}
      <div className="db-bg-row db-bg-row--r1">
        <div className="db-bg-card db-bg-card--health">
          <div className="db-bg-topline db-bg-topline--indigo" />
          <div className="db-bg-health-inner">
            <div className="db-bg-donut-wrap">
              <SprintDonut pct={pct} size={110} />
              <div className="db-bg-donut-center">
                <span className="db-bg-donut-pct">{pct}%</span>
                <span className="db-bg-donut-label">DONE</span>
              </div>
            </div>
            <div className="db-bg-health-right">
              <span className="db-bg-health-count">{summary.done_issues} / {summary.total_issues} issues</span>
              {summary.sprint_finish_ms > 0 && <Countdown finishMs={summary.sprint_finish_ms} />}
              <SprintTrack pct={pct} />
              <div className="db-bg-kpi-row">
                <KpiChip label="Blocked"  value={summary.blocked_count}  cls="db-kpi-chip--danger" />
                <KpiChip label="Bounced"  value={summary.bounced_count}  cls="db-kpi-chip--warn" />
                <KpiChip label="Overdue"  value={summary.overdue_count}  cls="db-kpi-chip--danger" />
                <KpiChip label="Hotfixes" value={summary.hotfix_count}   cls="db-kpi-chip--info" />
              </div>
            </div>
          </div>
          <TypeDeliveryPanel columns={columns} summary={summary} columnRoleMap={columnRoleMap} />
        </div>

        <div className="db-bg-card">
          <div className="db-bg-topline db-bg-topline--violet" />
          <div className="db-bg-card-label">By Column</div>
          <div className="db-bg-col-bars">
            {columns.map(col => (
              <div key={col.name} className="db-bg-col-bar-row">
                <span className="db-bg-col-bar-name" title={col.name}>{col.name}</span>
                <div className="db-bg-col-bar-track">
                  <div
                    className="db-bg-col-bar-fill"
                    style={{
                      width: `${summary.total_issues ? (col.total / summary.total_issues) * 100 : 0}%`,
                      background: isBlockedCol(col.name)  ? 'var(--color-danger)'
                                : isProgressCol(col.name) ? 'var(--color-primary)'
                                : isDoneCol(col.name)      ? 'var(--color-success)'
                                : 'var(--text-faint)',
                    }}
                  />
                </div>
                <span className="db-bg-col-bar-cnt">{col.total}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Row 2: Needs Attention (1/2) + Developer Load (1/2) */}
      <div className="db-bg-row db-bg-row--r2">
        <div className="db-bg-card">
          <div className="db-bg-topline db-bg-topline--danger" />
          <div className="db-bg-card-label">
            Needs Attention
            {needsAttention.length > 0 && <span className="db-bg-card-count">{needsAttention.length}</span>}
          </div>
          <div className="db-bg-critical-list">
            {needsAttention.length === 0 && (
              <div style={{ fontSize: '0.72rem', color: 'var(--color-success)', padding: '4px 0' }}>✓ No issues need attention</div>
            )}
            {needsAttention.slice(0, showAllNeeds ? needsAttention.length : 5).map(iss => (
              <div key={iss.idReadable} className={`db-bg-critical-row ${urgencyClass(iss)}`}>
                <div className="db-bg-cr-top">
                  <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
                  <IssueTypePill issueType={iss.issue_type} />
                  <span
                    className="db-ticket-id db-ticket-id--link"
                    onClick={(e) => onIdClick(iss.idReadable, e)}
                    title={`Open ${iss.idReadable} in YouTrack`}
                  >{iss.idReadable}</span>
                  {iss.is_hotfix && <span className="db-hotfix-chip">HF</span>}
                  {isIssueBlocked(iss, columnRoleMap) && <span className="db-bounce-chip" style={{ background: 'rgba(239,68,68,0.2)', color: '#fca5a5' }}>BLK</span>}
                  {iss.bounce_count > 0 && <span className="db-bounce-chip">↩{iss.bounce_count}</span>}
                  <span className="db-ticket-state" style={{ marginLeft: 'auto' }}>{iss.current_state}</span>
                </div>
                <div
                  className="db-bg-cr-title db-ticket-title--link"
                  onClick={(e) => onTitleClick(iss.idReadable, e)}
                >{iss.summary}</div>
                <div className="db-bg-cr-footer">
                  <DBAvatar name={iss.assignee || '?'} url={iss.avatarUrl} size={16} />
                  <span className="db-bg-cr-assignee">{iss.assignee?.split(' ')[0] || 'Unassigned'}</span>
                  <span
                    className="db-bg-cr-time"
                    style={{ color: iss.overdue_level ? 'var(--color-danger)' : undefined }}
                  >
                    {fmtHours(iss.hours_in_state)}
                  </span>
                  <VerifBadges dev={iss.verified_on_dev} stg={iss.verified_on_stage} prd={iss.verified_on_prod} />
                </div>
              </div>
            ))}
            {!showAllNeeds && needsAttention.length > 5 && (
              <button className="db-view-more-btn" onClick={() => setShowAllNeeds(true)}>
                ↓ View {needsAttention.length - 5} more
              </button>
            )}
            {showAllNeeds && needsAttention.length > 5 && (
              <button className="db-view-more-btn" onClick={() => setShowAllNeeds(false)}>
                ↑ Show less
              </button>
            )}
          </div>
        </div>

        <div className="db-bg-card">
          <div className="db-bg-topline db-bg-topline--green" />
          <div className="db-bg-card-label">Developer Load</div>
          <div className="db-bg-dev-list">
            {developers.map(dev => {
              const total = dev.inProgress + dev.queued + dev.blocked + dev.done
              return (
                <div key={dev.name} className="db-bg-dev-row">
                  <DBAvatar name={dev.name} url={dev.url} size={24} />
                  <div className="db-bg-dev-info">
                    <span className="db-bg-dev-name">{dev.name.split(' ')[0]}</span>
                    <div className="db-bg-dev-bar">
                      {total > 0 && <>
                        <div className="db-bg-dev-bar-seg db-bg-dev-bar-seg--active"  style={{ width: `${(dev.inProgress / total) * 100}%` }} />
                        <div className="db-bg-dev-bar-seg db-bg-dev-bar-seg--queued"  style={{ width: `${(dev.queued    / total) * 100}%` }} />
                        <div className="db-bg-dev-bar-seg db-bg-dev-bar-seg--blocked" style={{ width: `${(dev.blocked   / total) * 100}%` }} />
                        <div className="db-bg-dev-bar-seg db-bg-dev-bar-seg--done"    style={{ width: `${(dev.done      / total) * 100}%` }} />
                      </>}
                    </div>
                  </div>
                  <span className="db-bg-dev-hours">{fmtHours(dev.hours)}</span>
                  <div className="db-bg-dev-chips">
                    <span title="In Progress">{dev.inProgress}</span>
                    {dev.queued > 0 && <span style={{ opacity: 0.55 }} title="To Do">/{dev.queued}</span>}
                    {dev.blocked > 0 && <span className="db-bg-dev-chip--blocked">⛔{dev.blocked}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Row 2b: Feature Groups */}
      <div className="db-bg-row" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
        <div className="db-bg-card" style={{ gridColumn: '1 / -1' }}>
          <div className="db-bg-topline" style={{ background: 'linear-gradient(90deg,#6366f1,#8b5cf6)' }} />
          <FeatureHealthWidget sprintId={sprintId} expandable />
        </div>
      </div>

      {/* Row 3: All Issues Table */}
      <div className="db-bg-row db-bg-row--r3">
        <div className="db-bg-card" style={{ gridColumn: '1 / -1' }}>
          <div className="db-bg-topline db-bg-topline--indigo" />
          <div className="db-bg-card-label">All Issues</div>
          <div className="db-bg-table-head">
            <span>ID</span><span>Pri</span><span>Title</span><span>State</span>
            <span>Assignee</span><span>Cycle</span><span>In State</span><span>Verified</span>
          </div>
          {(() => {
            const sorted = [...allIssues].sort((a, b) => urgencyScore(b) - urgencyScore(a))
            const visible = sorted.slice(0, showAllIssues ? sorted.length : 5)
            return (
              <>
                {visible.map(iss => (
                  <div key={iss.idReadable} className={`db-bg-table-row ${urgencyClass(iss)}`}>
                    <span
                      className="db-ticket-id db-ticket-id--link"
                      onClick={(e) => onIdClick(iss.idReadable, e)}
                      title={`Open ${iss.idReadable} in YouTrack`}
                    >{iss.idReadable}</span>
                    <span><PriPill priority={iss.priority} tags={wfConfig?.priority_tags} /></span>
                    <span
                      className="db-bg-table-title db-ticket-title--link"
                      title={iss.summary}
                      onClick={(e) => onTitleClick(iss.idReadable, e)}
                    >{iss.summary}</span>
                    <span className="db-bg-table-assignee">{iss.current_state}</span>
                    <span className="db-bg-table-assignee">{iss.assignee?.split(' ')[0] || '—'}</span>
                    <span className="db-bg-table-num">{fmtHours(iss.cycle_time_hours)}</span>
                    <span
                      className="db-bg-table-num"
                      style={{ color: iss.overdue_level ? 'var(--color-danger)' : undefined }}
                    >
                      {fmtHours(iss.hours_in_state)}
                    </span>
                    <span><VerifBadges dev={iss.verified_on_dev} stg={iss.verified_on_stage} prd={iss.verified_on_prod} /></span>
                  </div>
                ))}
                {!showAllIssues && sorted.length > 5 && (
                  <button className="db-view-more-btn" onClick={() => setShowAllIssues(true)}>
                    ↓ View {sorted.length - 5} more
                  </button>
                )}
                {showAllIssues && sorted.length > 5 && (
                  <button className="db-view-more-btn" onClick={() => setShowAllIssues(false)}>
                    ↑ Show less
                  </button>
                )}
              </>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

// ─── Design 3: Ops Command + Live Feed ───────────────────────────────────────

function FeedDivider({ label, color }: { label: string; color?: string }) {
  return (
    <div className="db-oc-feed-divider" style={{ color }}>
      {label}
    </div>
  )
}

function Design3({
  summary, columns, activeSprint, onTitleClick, onIdClick, sprintId,
}: {
  summary: SprintSummary
  columns: SprintBoardColumn[]
  activeSprint: YouTrackSprint | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
  sprintId?: string
}) {
  const [showAllBounced, setShowAllBounced]     = useState(false)
  const [showAllInProgress, setShowAllInProgress] = useState(false)
  const [showAllAtRisk, setShowAllAtRisk]       = useState(false)
  const [showAllBlocked, setShowAllBlocked]     = useState(false)
  const pct = toPct(summary.completion_pct)
  const allIssues = useMemo(() => columns.flatMap(c => c.issues), [columns])

  const { config: wfConfig } = useWorkflowConfig()
  const columnRoleMap = useMemo(() => {
    const m = new Map<string, string>()
    if (wfConfig) {
      wfConfig.column_hierarchy.forEach((col: any) => {
        m.set(col.state.toLowerCase(), col.role)
        ;(col.aliases ?? []).forEach((a: string) => m.set(a.toLowerCase(), col.role))
      })
    }
    return m
  }, [wfConfig])

  // Use role-aware blocked detection for accuracy
  const blockedIssues = useMemo(() =>
    columns.filter(c => resolveRole(c.name, columnRoleMap) === 'blocked').flatMap(c => c.issues)
  , [columns, columnRoleMap])

  const blockedIds = useMemo(() => {
    const ids = new Set<string>()
    blockedIssues.forEach(i => ids.add(i.idReadable))
    return ids
  }, [blockedIssues])

  const sorted = useMemo(() =>
    [...allIssues].sort((a, b) => urgencyScore(b) - urgencyScore(a))
  , [allIssues])

  const bouncedIssues = useMemo(() =>
    sorted.filter(i =>
      i.bounce_count >= 1 &&
      !isIssueDone(i, columnRoleMap) &&
      !blockedIds.has(i.idReadable)
    )
  , [sorted, blockedIds, columnRoleMap])

  const bouncedIds = useMemo(() => {
    const ids = new Set<string>()
    bouncedIssues.forEach(i => ids.add(i.idReadable))
    return ids
  }, [bouncedIssues])

  const inProgressIssues = useMemo(() =>
    sorted.filter(i =>
      isIssueActive(i, columnRoleMap) &&
      !i.overdue_level &&
      !blockedIds.has(i.idReadable) &&
      !bouncedIds.has(i.idReadable)
    )
  , [sorted, blockedIds, bouncedIds, columnRoleMap])

  const atRiskIssues = useMemo(() =>
    sorted.filter(i =>
      (i.overdue_level === 'deadline' || i.overdue_level === 'sprint') &&
      !blockedIds.has(i.idReadable) &&
      !bouncedIds.has(i.idReadable) &&
      !isIssueDone(i, columnRoleMap)
    )
  , [sorted, blockedIds, bouncedIds, columnRoleMap])

  const otherIssues = useMemo(() =>
    sorted.filter(i =>
      !isIssueActive(i, columnRoleMap) &&
      !blockedIds.has(i.idReadable) &&
      !bouncedIds.has(i.idReadable) &&
      !i.overdue_level &&
      !isIssueDone(i, columnRoleMap)
    ).slice(0, 10)
  , [sorted, blockedIds, bouncedIds, columnRoleMap])

  const developers = useMemo(() => {
    const map = new Map<string, { name: string; url: string; inProgress: number; queued: number; active: number; blocked: number; total: number }>()
    columns.forEach(col => col.issues.forEach(iss => {
      const key = iss.assignee || 'Unassigned'
      if (!map.has(key)) map.set(key, { name: key, url: iss.avatarUrl, inProgress: 0, queued: 0, active: 0, blocked: 0, total: 0 })
      const d = map.get(key)!
      d.total++
      const role = resolveRole(col.name, columnRoleMap)
      if (role === 'active')   { d.inProgress++; d.active++ }
      else if (!DONE_ROLES.has(role) && role !== 'blocked') { d.queued++; }
      if (role === 'blocked')  d.blocked++
    }))
    return Array.from(map.values()).sort((a, b) => b.inProgress - a.inProgress)
  }, [columns, columnRoleMap])

  function FeedRow({ iss, leftBarCls }: { iss: SprintBoardIssue; leftBarCls?: string }) {
    return (
      <div className={`db-oc-feed-row${blockedIds.has(iss.idReadable) ? ' db-oc-feed-row--blocked' : iss.overdue_level ? ' db-oc-feed-row--overdue' : ''}`}>
        <div className={`db-oc-feed-left-bar${leftBarCls ? ` ${leftBarCls}` : ''}`} />
        <div className="db-oc-feed-content">
          <div className="db-oc-feed-top">
            <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
            <IssueTypePill issueType={iss.issue_type} />
            <span
              className="db-ticket-id db-ticket-id--link"
              onClick={(e) => onIdClick(iss.idReadable, e)}
              title={`Open ${iss.idReadable} in YouTrack`}
            >{iss.idReadable}</span>
            {iss.is_hotfix  && <span className="db-hotfix-chip">HF</span>}
            {iss.bounce_count > 0 && <span className="db-bounce-chip">↩{iss.bounce_count}</span>}
            <span className="db-ticket-state">{iss.current_state}</span>
            <span className="db-oc-feed-time" style={{ marginLeft: 'auto' }}>
              {fmtHours(iss.hours_in_state)}
            </span>
          </div>
          <div
            className="db-oc-feed-title db-ticket-title--link"
            title={iss.summary}
            onClick={(e) => onTitleClick(iss.idReadable, e)}
          >{iss.summary}</div>
          <div className="db-oc-feed-bottom">
            <DBAvatar name={iss.assignee || '?'} url={iss.avatarUrl} size={15} />
            <span className="db-oc-feed-assignee">{iss.assignee?.split(' ')[0] || '—'}</span>
            <VerifBadges dev={iss.verified_on_dev} stg={iss.verified_on_stage} prd={iss.verified_on_prod} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="db-oc-layout">
      {/* ── Left Command Panel ── */}
      <div className="db-oc-left">
        {activeSprint && (
          <div className="db-oc-panel-section db-oc-sprint-info">
            <div className="db-oc-sprint-name">{activeSprint.name}</div>
            <div className="db-oc-sprint-dates">
              {fmtSprintDate(activeSprint.start)} – {fmtSprintDate(activeSprint.finish)}
            </div>
            <SprintTrack pct={pct} />
            <div className="db-oc-pct-row">
              <span className="db-oc-pct">{pct}%</span>
              <span className="db-oc-pct-label">{summary.done_issues}/{summary.total_issues} done</span>
              {summary.sprint_finish_ms > 0 && <Countdown finishMs={summary.sprint_finish_ms} />}
            </div>
          </div>
        )}

        <div className="db-oc-panel-section db-oc-blocked-banner">
          <div className="db-oc-blocked-count">{summary.blocked_count}</div>
          <div className="db-oc-blocked-label">tickets blocked</div>
        </div>

        <div className="db-oc-panel-section">
          <div className="db-oc-kpi-grid">
            <KpiChip label="In Progress" value={summary.in_progress_count} cls="db-kpi-chip--info" />
            <KpiChip label="Bounced"     value={summary.bounced_count}     cls="db-kpi-chip--warn" />
            <KpiChip label="Overdue"     value={summary.overdue_count}     cls="db-kpi-chip--danger" />
            <KpiChip label="Hotfixes"    value={summary.hotfix_count}      cls="db-kpi-chip--info" />
          </div>
        </div>

        <div className="db-oc-panel-section">
          <div className="db-oc-panel-label">Developer Load</div>
          {developers.map(dev => (
            <div key={dev.name} className="db-oc-dev-row">
              <DBAvatar name={dev.name} url={dev.url} size={22} />
              <div className="db-oc-dev-info">
                <span className="db-oc-dev-name">{dev.name.split(' ')[0]}</span>
                <div className="db-oc-mini-bar">
                  {dev.total > 0 && <>
                    <div className="db-oc-mini-bar-active"  style={{ width: `${(dev.inProgress / dev.total) * 100}%` }} />
                    <div className="db-oc-mini-bar-queued"  style={{ width: `${(dev.queued     / dev.total) * 100}%`, background: 'rgba(255,255,255,0.12)' }} />
                    {dev.blocked > 0 && <div className="db-oc-mini-bar-blocked" style={{ width: `${(dev.blocked / dev.total) * 100}%` }} />}
                  </>}
                </div>
              </div>
              <span className="db-oc-dev-cnt">
                {dev.inProgress} <span style={{ opacity: 0.45 }}>in prog.</span>
                {dev.queued > 0 && <span style={{ opacity: 0.45 }}> · {dev.queued} to do</span>}
              </span>
            </div>
          ))}
        </div>

        <div className="db-oc-panel-section">
          <TypeDeliveryPanel columns={columns} summary={summary} columnRoleMap={columnRoleMap} />
        </div>

        <div className="db-oc-panel-section">
          <FeatureHealthWidget sprintId={sprintId} expandable />
        </div>
      </div>

      {/* ── Right Feed ── */}
      <div className="db-oc-right">
        <div className="db-oc-feed">
          {bouncedIssues.length > 0 && (
            <>
              <FeedDivider label={`BOUNCED (${bouncedIssues.length})`} color="#fb923c" />
              {bouncedIssues.slice(0, showAllBounced ? bouncedIssues.length : 5).map(iss => (
                <FeedRow key={iss.idReadable} iss={iss} leftBarCls="db-oc-feed-left-bar--bounce" />
              ))}
              {!showAllBounced && bouncedIssues.length > 5 && (
                <button className="db-view-more-btn" onClick={() => setShowAllBounced(true)}>
                  ↓ View {bouncedIssues.length - 5} more
                </button>
              )}
              {showAllBounced && bouncedIssues.length > 5 && (
                <button className="db-view-more-btn" onClick={() => setShowAllBounced(false)}>
                  ↑ Show less
                </button>
              )}
            </>
          )}

          {inProgressIssues.length > 0 && (
            <>
              <FeedDivider label={`IN PROGRESS (${inProgressIssues.length})`} color="var(--color-primary-light)" />
              {inProgressIssues.slice(0, showAllInProgress ? inProgressIssues.length : 5).map(iss => (
                <FeedRow key={iss.idReadable} iss={iss} leftBarCls="db-oc-feed-left-bar--primary" />
              ))}
              {!showAllInProgress && inProgressIssues.length > 5 && (
                <button className="db-view-more-btn" onClick={() => setShowAllInProgress(true)}>
                  ↓ View {inProgressIssues.length - 5} more
                </button>
              )}
              {showAllInProgress && inProgressIssues.length > 5 && (
                <button className="db-view-more-btn" onClick={() => setShowAllInProgress(false)}>
                  ↑ Show less
                </button>
              )}
            </>
          )}

          {atRiskIssues.length > 0 && (
            <>
              <FeedDivider label={`OVERDUE (${atRiskIssues.length})`} color="var(--color-warning)" />
              {atRiskIssues.slice(0, showAllAtRisk ? atRiskIssues.length : 5).map(iss => (
                <FeedRow key={iss.idReadable} iss={iss} leftBarCls="db-oc-feed-left-bar--warn" />
              ))}
              {!showAllAtRisk && atRiskIssues.length > 5 && (
                <button className="db-view-more-btn" onClick={() => setShowAllAtRisk(true)}>
                  ↓ View {atRiskIssues.length - 5} more
                </button>
              )}
              {showAllAtRisk && atRiskIssues.length > 5 && (
                <button className="db-view-more-btn" onClick={() => setShowAllAtRisk(false)}>
                  ↑ Show less
                </button>
              )}
            </>
          )}

          {blockedIssues.length > 0 && (
            <>
              <FeedDivider label={`BLOCKED (${blockedIssues.length})`} color="var(--color-danger)" />
              {blockedIssues.slice(0, showAllBlocked ? blockedIssues.length : 5).map(iss => <FeedRow key={iss.idReadable} iss={iss} />)}
              {!showAllBlocked && blockedIssues.length > 5 && (
                <button className="db-view-more-btn" onClick={() => setShowAllBlocked(true)}>
                  ↓ View {blockedIssues.length - 5} more
                </button>
              )}
              {showAllBlocked && blockedIssues.length > 5 && (
                <button className="db-view-more-btn" onClick={() => setShowAllBlocked(false)}>
                  ↑ Show less
                </button>
              )}
            </>
          )}

          {otherIssues.length > 0 && (
            <>
              <FeedDivider label={`OTHER (${otherIssues.length})`} />
              {otherIssues.map(iss => (
                <FeedRow key={iss.idReadable} iss={iss} leftBarCls="db-oc-feed-left-bar--muted" />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function SprintDashboardPage() {
  const [designMode, setDesignMode] = useState<DesignMode>('velocity')
  const [designOpen, setDesignOpen] = useState(false)
  const [sprints, setSprints]       = useState<YouTrackSprint[]>([])
  const [activeSprint, setActiveSprint] = useState<YouTrackSprint | null>(null)
  const [sprintOpen, setSprintOpen] = useState(false)
  const [boardData, setBoardData]   = useState<SprintBoardStatusResponse | null>(null)
  const [loading, setLoading]       = useState(false)
  const [kpiDrawer, setKpiDrawer]   = useState<DbKpiDrawer>(null)
  const [ytDetailIssue, setYtDetailIssue] = useState<YouTrackIssue | null>(null)
  const [ytDetailLoading, setYtDetailLoading] = useState(false)
  const [ytBaseUrl, setYtBaseUrl]   = useState('')

  const designRef     = useRef<HTMLDivElement>(null)
  const sprintRef     = useRef<HTMLDivElement>(null)
  const designMenuRef = useRef<HTMLDivElement>(null)
  const sprintMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getYouTrackIntegration().then(res => {
      const d = (res as any)
      setYtBaseUrl((d?.base_url || d?.data?.base_url || '').replace(/\/$/, ''))
    }).catch(() => {})
  }, [])

  const openIssueDetail = useCallback(async (idReadable: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (ytDetailLoading) return
    setYtDetailLoading(true)
    try {
      const res = await api.getYouTrackIssue(idReadable)
      const issue = (res as any).data as YouTrackIssue
      if (issue) setYtDetailIssue(issue)
    } catch {}
    finally { setYtDetailLoading(false) }
  }, [ytDetailLoading])

  const openInYt = useCallback((idReadable: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!idReadable) return
    const url = ytBaseUrl ? `${ytBaseUrl}/issue/${idReadable}` : null
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }, [ytBaseUrl])

  useEffect(() => {
    api.getYouTrackSprints().then(res => {
      const list = ((res as any).data as YouTrackSprint[]) ?? []
      setSprints(list)
      const savedId = localStorage.getItem(SPRINT_ID_KEY)
      const saved   = savedId ? list.find(s => s.id === savedId) : null
      setActiveSprint(saved || list.find(s => !s.isCompleted) || list[0] || null)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!activeSprint) { setBoardData(null); return }
    setLoading(true)
    api.getSprintBoardStatus({
      sprint_id: activeSprint.id,
      sprint_finish_ms: activeSprint.finish,
    }).then(res => {
      const data = (res as any).data as SprintBoardStatusResponse
      setBoardData(data ?? null)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [activeSprint?.id])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (designOpen && !designRef.current?.contains(t) && !designMenuRef.current?.contains(t)) setDesignOpen(false)
      if (sprintOpen && !sprintRef.current?.contains(t) && !sprintMenuRef.current?.contains(t)) setSprintOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [designOpen, sprintOpen])

  function handleSprintChange(s: YouTrackSprint) {
    setActiveSprint(s)
    setSprintOpen(false)
    localStorage.setItem(SPRINT_ID_KEY,   s.id)
    localStorage.setItem(SPRINT_NAME_KEY, s.name)
  }

  const sortedSprints = [...sprints].sort((a, b) => b.finish - a.finish)
  const currentDesign = DESIGN_MODES.find(d => d.id === designMode)!

  return (
    <div className="db-page">
      {/* Controls bar */}
      <div className="db-controls">
        <div ref={designRef} className="db-design-selector">
          <button
            className="pm-custom-dropdown-trigger db-design-btn"
            onClick={() => setDesignOpen(o => !o)}
          >
            <currentDesign.icon size={13} />
            {currentDesign.label}
            <ChevronDown size={11} style={{ opacity: 0.5 }} />
          </button>
          {designOpen && createPortal(
            <div
              ref={designMenuRef}
              className="pm-custom-dropdown-menu"
              style={{
                position: 'fixed',
                top:  (designRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                left: designRef.current?.getBoundingClientRect().left ?? 0,
                minWidth: 180,
                zIndex: 9999,
              }}
            >
              {DESIGN_MODES.map(d => (
                <button
                  key={d.id}
                  className={`pm-dropdown-item${designMode === d.id ? ' active' : ''}`}
                  onClick={() => { setDesignMode(d.id); setDesignOpen(false) }}
                >
                  <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>
                    {designMode === d.id && <Check size={12} />}
                  </span>
                  <d.icon size={12} style={{ marginRight: 6 }} />
                  {d.label}
                </button>
              ))}
            </div>,
            document.body
          )}
        </div>

        <div className="db-controls-spacer" />

        {/* Sprint selector */}
        <div ref={sprintRef} className="db-sprint-selector">
          <button
            className="pm-custom-dropdown-trigger"
            onClick={() => setSprintOpen(o => !o)}
          >
            <GitBranch size={13} />
            {activeSprint
              ? <>{activeSprint.name}<span className="db-sprint-dates">{fmtSprintDate(activeSprint.start)}–{fmtSprintDate(activeSprint.finish)}</span></>
              : <span>Select sprint</span>
            }
            <ChevronDown size={11} style={{ opacity: 0.5 }} />
          </button>
          {sprintOpen && createPortal(
            <div
              ref={sprintMenuRef}
              className="pm-custom-dropdown-menu"
              style={{
                position: 'fixed',
                top:   (sprintRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                right: window.innerWidth - (sprintRef.current?.getBoundingClientRect().right ?? 0),
                minWidth: 240,
                zIndex: 9999,
              }}
            >
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

      {/* KPI bar — shown when data is loaded or loading */}
      {loading && <SkeletonKpiBar />}
      {!loading && boardData && (
        <KpiBar summary={boardData.summary} activeDrawer={kpiDrawer} onKpiClick={setKpiDrawer} columns={boardData.columns} />
      )}

      {/* KPI Drawer */}
      {!loading && boardData && kpiDrawer && (() => {
        const allIssues = boardData.columns.flatMap(c => c.issues)
        const blockedIssues   = boardData.columns.filter(c => isBlockedCol(c.name)).flatMap(c => c.issues)
        const bouncedIssues   = allIssues.filter(i => i.bounce_count > 0).sort((a, b) => b.bounce_count - a.bounce_count)
        const overdueIssues   = allIssues.filter(i => i.is_delayed)
        const inProgIssues    = boardData.columns.filter(c => (c.name || '').toLowerCase().includes('progress')).flatMap(c => c.issues)
        const hotfixIssues    = allIssues.filter(i => i.is_hotfix)
        const doneIssues      = allIssues.filter(i => {
          const s = (i.current_state || '').toLowerCase()
          return s.includes('done') || s.includes('verified') || s.includes('deployed') || s.includes('closed')
        })
        const summary = boardData.summary
        const notStarted = Math.max(0, summary.total_issues - summary.done_issues - summary.in_progress_count - summary.blocked_count)

        const issueList = kpiDrawer === 'blocked'     ? blockedIssues
                        : kpiDrawer === 'bounced'     ? bouncedIssues
                        : kpiDrawer === 'overdue'     ? overdueIssues
                        : kpiDrawer === 'in-progress' ? inProgIssues
                        : kpiDrawer === 'hotfix'      ? hotfixIssues
                        : []

        const drawerTitles: Record<string, string> = {
          blocked:      `Blocked Tickets (${blockedIssues.length})`,
          bounced:      `Bounced Tickets (${bouncedIssues.length})`,
          overdue:      `Overdue Tickets (${overdueIssues.length})`,
          'in-progress': `In Progress (${inProgIssues.length})`,
          hotfix:       `Hotfix Tickets (${hotfixIssues.length})`,
          completion:   'Sprint Progress',
          sprint:       'Sprint Timeline',
        }

        return (
          <div className="db-kpi-drawer">
            <div className="db-kpi-drawer-header">
              <span className="db-kpi-drawer-title">{drawerTitles[kpiDrawer] ?? ''}</span>
              <button className="db-kpi-drawer-close" onClick={() => setKpiDrawer(null)}><X size={13} /></button>
            </div>
            <div className="db-kpi-drawer-body">

              {/* ── Issue list views ── */}
              {['blocked','bounced','overdue','in-progress','hotfix'].includes(kpiDrawer) && (
                issueList.length === 0
                  ? <div className="db-kpi-drawer-empty">No tickets in this category.</div>
                  : issueList.map(issue => (
                    <div key={issue.id} className="db-kpi-drawer-row">
                      <span className="db-kpi-drawer-id db-ticket-id--link"
                        onClick={(e) => openInYt(issue.idReadable || issue.id, e)}>
                        {issue.idReadable || issue.id}
                      </span>
                      <span className="db-kpi-drawer-summary db-ticket-title--link"
                        onClick={(e) => openIssueDetail(issue.idReadable || issue.id, e)}>
                        {issue.summary}
                      </span>
                      {issue.assignee && <span className="db-kpi-drawer-assignee">{issue.assignee}</span>}
                      {kpiDrawer === 'bounced' && issue.bounce_count > 0 && (
                        <span className="db-kpi-drawer-chip db-kpi-drawer-chip--warn">↩ {issue.bounce_count}</span>
                      )}
                      {kpiDrawer === 'overdue' && issue.overdue_level && (
                        <span className={`db-kpi-drawer-chip db-kpi-drawer-chip--${issue.overdue_level === 'deadline' ? 'danger' : 'warn'}`}>
                          {issue.overdue_level}
                        </span>
                      )}
                      {kpiDrawer === 'blocked' && (issue.total_active_hours || 0) > 0 && (
                        <span className="db-kpi-drawer-chip db-kpi-drawer-chip--danger">
                          {Math.round(issue.total_active_hours || 0)}h
                        </span>
                      )}
                    </div>
                  ))
              )}

              {/* ── Completion ── */}
              {kpiDrawer === 'completion' && (() => {
                const pct = Math.round(summary.completion_pct)
                const doneIds = new Set(
                  boardData.columns.filter(c => !isBlockedCol(c.name) && !((c.name||'').toLowerCase().includes('progress')) && !['to do','todo','backlog','open','new'].some(k => (c.name||'').toLowerCase().includes(k))).flatMap(c => c.issues.map(i => i.id))
                )
                const activeIds = new Set(
                  boardData.columns.filter(c => (c.name||'').toLowerCase().includes('progress')).flatMap(c => c.issues.map(i => i.id))
                )
                const byPerson = new Map<string, { done: number; active: number; total: number }>()
                allIssues.forEach(i => {
                  const name = i.assignee || 'Unassigned'
                  const isDone   = doneIds.has(i.id)
                  const isActive = activeIds.has(i.id)
                  const entry = byPerson.get(name) ?? { done: 0, active: 0, total: 0 }
                  byPerson.set(name, { done: entry.done + (isDone ? 1 : 0), active: entry.active + (isActive ? 1 : 0), total: entry.total + 1 })
                })
                return (
                  <>
                    <div className="db-kpi-drawer-prog-row">
                      <span>{summary.done_issues} / {summary.total_issues} done</span>
                      <span className="db-kpi-drawer-prog-pct">{pct}%</span>
                    </div>
                    <div className="db-kpi-drawer-prog-track">
                      <div className="db-kpi-drawer-prog-fill db-kpi-drawer-prog-fill--green" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="db-kpi-drawer-person-list">
                      {[...byPerson.entries()].sort((a, b) => b[1].done - a[1].done).map(([name, stat]) => {
                        const pp = stat.total > 0 ? Math.round((stat.done / stat.total) * 100) : 0
                        return (
                          <div key={name} className="db-kpi-drawer-person-row">
                            <div className="db-kpi-drawer-avatar"><span>{(name || '?')[0]}</span></div>
                            <span className="db-kpi-drawer-person-name">{name}</span>
                            <div className="db-kpi-drawer-mini-track">
                              <div className="db-kpi-drawer-mini-fill" style={{ width: `${pp}%` }} />
                            </div>
                            <span className="db-kpi-drawer-person-stats">{stat.done} done · {stat.active} active</span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )
              })()}

              {/* ── Sprint ── */}
              {kpiDrawer === 'sprint' && (() => {
                const isOvd = summary.sprint_finish_ms > 0 && Date.now() > summary.sprint_finish_ms
                const segs = [
                  { label: 'Done', count: summary.done_issues, cls: 'green' },
                  { label: 'In Progress', count: summary.in_progress_count, cls: 'blue' },
                  { label: 'Blocked', count: summary.blocked_count, cls: 'red' },
                  { label: 'Not Started', count: notStarted, cls: 'muted' },
                ]
                return (
                  <>
                    <div className={`db-kpi-drawer-sprint-countdown${isOvd ? ' db-kpi-drawer-sprint-countdown--danger' : ''}`}>
                      {isOvd ? '⚠ Sprint Overdue' : `⏱ ${fmtCountdown(summary.sprint_finish_ms)}`}
                    </div>
                    <div className="db-kpi-drawer-sprint-segs">
                      {segs.map(seg => (
                        <div key={seg.label} className="db-kpi-drawer-sprint-seg">
                          <span className={`db-kpi-drawer-sprint-seg-count db-kpi-drawer-sprint-seg-count--${seg.cls}`}>{seg.count}</span>
                          <div className="db-kpi-drawer-sprint-bar">
                            <div className={`db-kpi-drawer-sprint-bar-fill db-kpi-drawer-sprint-bar-fill--${seg.cls}`}
                              style={{ width: `${summary.total_issues > 0 ? Math.round((seg.count / summary.total_issues) * 100) : 0}%` }} />
                          </div>
                          <span className="db-kpi-drawer-sprint-seg-label">{seg.label}</span>
                        </div>
                      ))}
                    </div>
                    {overdueIssues.length > 0 && (
                      <>
                        <div className="db-kpi-drawer-at-risk-header">At Risk ({overdueIssues.length})</div>
                        {overdueIssues.slice(0, 5).map(issue => (
                          <div key={issue.id} className="db-kpi-drawer-row">
                            <span className="db-kpi-drawer-id db-ticket-id--link"
                              onClick={(e) => openInYt(issue.idReadable || issue.id, e)}>
                              {issue.idReadable || issue.id}
                            </span>
                            <span className="db-kpi-drawer-summary db-ticket-title--link"
                              onClick={(e) => openIssueDetail(issue.idReadable || issue.id, e)}>
                              {issue.summary}
                            </span>
                            {issue.assignee && <span className="db-kpi-drawer-assignee">{issue.assignee}</span>}
                            {issue.overdue_level && (
                              <span className={`db-kpi-drawer-chip db-kpi-drawer-chip--${issue.overdue_level === 'deadline' ? 'danger' : 'warn'}`}>
                                {issue.overdue_level}
                              </span>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )
              })()}

            </div>
          </div>
        )
      })()}

      {/* No sprint selected */}
      {!loading && !activeSprint && (
        <div className="db-empty">
          <Target size={38} />
          <span>Select a sprint to see the dashboard</span>
        </div>
      )}

      {/* No data */}
      {!loading && activeSprint && !boardData && (
        <div className="db-empty">
          <RefreshCw size={38} />
          <span>No data available for this sprint</span>
        </div>
      )}

      {/* Skeleton views while loading */}
      {loading && (
        <div className="db-content">
          {designMode === 'velocity' && <SkeletonVelocity />}
          {designMode === 'bento'    && <SkeletonBento />}
          {designMode === 'ops'      && <SkeletonOps />}
        </div>
      )}

      {/* Design views */}
      {!loading && boardData && (
        <div className="db-content">
          {designMode === 'velocity' && (
            <Design1
              summary={boardData.summary}
              columns={boardData.columns}
              onTitleClick={openIssueDetail}
              onIdClick={openInYt}
              ytDetailLoading={ytDetailLoading}
              onKpiClick={setKpiDrawer}
              sprintId={activeSprint?.id}
            />
          )}
          {designMode === 'bento' && (
            <Design2
              summary={boardData.summary}
              columns={boardData.columns}
              onTitleClick={openIssueDetail}
              onIdClick={openInYt}
              sprintId={activeSprint?.id}
            />
          )}
          {designMode === 'ops' && (
            <Design3
              summary={boardData.summary}
              columns={boardData.columns}
              activeSprint={activeSprint}
              onTitleClick={openIssueDetail}
              onIdClick={openInYt}
              sprintId={activeSprint?.id}
            />
          )}
        </div>
      )}

      {/* Ticket detail panel */}
      {ytDetailIssue && (
        <IssueDetailPanel
          issue={ytDetailIssue}
          onClose={() => setYtDetailIssue(null)}
          ytBaseUrl={ytBaseUrl}
        />
      )}
    </div>
  )
}
