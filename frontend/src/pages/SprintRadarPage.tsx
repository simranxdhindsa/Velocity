import { useState, useMemo } from 'react'
import {
  AlertTriangle, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Zap,
} from 'lucide-react'
import type { SprintBoardStatusResponse, SprintBoardIssue, YouTrackSprint, PriorityTag } from '@/services/api'
import { useWorkflowConfig } from '@/hooks/useWorkflowConfig'
import HoverCard, { HCRow, HCDivider, HCBadge } from '@/components/HoverCard'
import { SprintScanLoader } from '@/components/brand/VelocityLoaders'
import '@/styles/pages/sprint-radar.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const DONE_ROLES = new Set(['dev_done', 'verified', 'deployed', 'closed'])
const SLA_HOURS: Record<number, number> = { 1: 1, 2: 24 }

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyTier(priority: string, issueType: string, isHotfix: boolean): number {
  if (isHotfix) return 1
  const p = priority.toLowerCase()
  if (p === 'p0' || p === 'a0' || p === 'critical') return 1
  const t = issueType.toLowerCase()
  if (t === 'regression' || t.includes('regression')) return 0
  if (p === 'p1' || p === 'a1' || p === 'major') return 2
  if (p === 'p2' || p === 'a2') return 3
  return 4
}

function fmtHours(h: number): string {
  if (!h || h <= 0) return '—'
  const d = Math.floor(h / 24)
  const hr = Math.round(h % 24)
  if (d > 0 && hr > 0) return `${d}d ${hr}h`
  if (d > 0) return `${d}d`
  return `${hr}h`
}

function slaBreach(tier: number, h: number): boolean {
  return SLA_HOURS[tier] != null && h >= SLA_HOURS[tier]
}

function urgencyClass(iss: SprintBoardIssue): string {
  if (iss.overdue_level === 'deadline') return 'db-urgency--deadline'
  if (iss.overdue_level === 'sprint' || iss.overdue_level === 'sla') return 'db-urgency--risk'
  if (iss.bounce_count > 0) return 'db-urgency--bounced'
  return ''
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

function getPriClass(priority: string): string {
  const p = (priority || '').toLowerCase()
  if (p === 'a1' || p === 'p0' || p === 'critical') return 'db-pri--critical'
  if (p === 'a2' || p === 'p1' || p === 'high')     return 'db-pri--high'
  if (p === 'a3' || p === 'p2' || p === 'medium' || p === 'normal') return 'db-pri--medium'
  return 'db-pri--low'
}

function categorizeIssue(issueType: string): 'feature' | 'bug' | 'task' | 'other' {
  const t = (issueType || '').toLowerCase().trim()
  if (!t) return 'other'
  if (t.includes('feature') || t.includes('story') || t.includes('epic')) return 'feature'
  if (t.includes('bug') || t.includes('defect') || t.includes('hotfix') || t.includes('regression')) return 'bug'
  if (t.includes('task') || t.includes('enhancement') || t.includes('improvement') ||
      t.includes('chore') || t.includes('tech debt') || t.includes('techdebt')) return 'task'
  return 'other'
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PulseIssue extends SprintBoardIssue {
  tier: number
  isDone: boolean
  colRole: string
}

// ── Sub-components — same visual language as SprintDashboardPage ──────────────

function DBAvatar({ name, url, size = 16 }: { name: string; url?: string; size?: number }) {
  const initials = (name || '?').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)
  if (url) {
    return (
      <img
        src={url} alt={name} className="db-avatar"
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

function PriPill({ priority, tags }: { priority: string; tags?: PriorityTag[] }) {
  if (!priority) return null
  const color = tags ? getPriColorFromTags(priority, tags) : null
  if (color) {
    return (
      <span className="db-pri-pill" style={{ background: color + '26', color, border: `1px solid ${color}44` }}>
        {priority}
      </span>
    )
  }
  return <span className={`db-pri-pill ${getPriClass(priority)}`}>{priority}</span>
}

function IssueTypePill({ issueType }: { issueType?: string }) {
  if (!issueType) return null
  const cat = categorizeIssue(issueType)
  const label = issueType.length > 10 ? issueType.slice(0, 10) + '…' : issueType
  return <span className={`db-type-pill db-type-pill--${cat}`} title={issueType}>{label}</span>
}

function SLABadge({ hours, tier, isDone }: { hours: number; tier: number; isDone: boolean }) {
  if (isDone || !SLA_HOURS[tier]) return null
  const breach = slaBreach(tier, hours)
  const ratio = Math.min(hours / SLA_HOURS[tier], 1)
  const cls = breach ? 'sp-sla-breach' : ratio > 0.7 ? 'sp-sla-warn' : 'sp-sla-ok'
  return <span className={`sp-sla ${cls}`}>{fmtHours(hours)}{breach && ' ⚠'}</span>
}

// ── Issue hover card ──────────────────────────────────────────────────────────

function issueHover(iss: PulseIssue) {
  const hasVerif = iss.verified_on_dev || iss.verified_on_stage || iss.verified_on_prod
  return (
    <div>
      <div className="hc-title">{iss.idReadable}</div>
      <div className="hc-subtitle">{iss.summary}</div>
      <HCDivider />
      <HCRow label="State"    value={iss.current_state || '—'} />
      {iss.hours_in_state > 0 && (
        <HCRow
          label="In state" value={fmtHours(iss.hours_in_state)}
          accent={iss.overdue_level === 'deadline' ? 'danger' : iss.is_delayed ? 'warn' : undefined}
        />
      )}
      {iss.cycle_time_hours > 0 && <HCRow label="Cycle"    value={fmtHours(iss.cycle_time_hours)} />}
      {iss.bounce_count > 0     && <HCRow label="Bounces"  value={`${iss.bounce_count}×`} accent="warn" />}
      {iss.assignee              && <HCRow label="Assignee" value={iss.assignee} />}
      {iss.priority              && <HCRow label="Priority" value={iss.priority} />}
      {hasVerif && (
        <>
          <HCDivider />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {iss.verified_on_dev   && <HCBadge label="DEV✓" variant="dev" />}
            {iss.verified_on_stage && <HCBadge label="STG✓" variant="stg" />}
            {iss.verified_on_prod  && <HCBadge label="PRD✓" variant="prd" />}
          </div>
        </>
      )}
    </div>
  )
}

// ── Issue card — matches db-mc-focus-card from the other 3 dashboard views ────

interface IssueRowProps {
  iss: PulseIssue
  onIdClick: (id: string, e: React.MouseEvent) => void
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  priorityTags?: PriorityTag[]
  dim?: boolean
}

function IssueRow({ iss, onIdClick, onTitleClick, priorityTags, dim }: IssueRowProps) {
  return (
    <HoverCard content={issueHover(iss)} maxWidth={270} delay={300}>
      <div className={`db-mc-focus-card ${urgencyClass(iss)}${dim ? ' sp-row-dim' : ''}`}>
        <div className="db-mc-focus-top">
          <PriPill priority={iss.priority} tags={priorityTags} />
          <IssueTypePill issueType={iss.issue_type} />
          <span
            className="db-ticket-id db-ticket-id--link"
            onClick={e => onIdClick(iss.idReadable, e)}
            title={`Open ${iss.idReadable} in YouTrack`}
          >{iss.idReadable}</span>
          {iss.bounce_count > 0 && <span className="db-bounce-chip">↩{iss.bounce_count}</span>}
          <span className="db-ticket-state" style={{ marginLeft: 'auto' }}>{iss.current_state}</span>
          <SLABadge hours={iss.hours_in_state} tier={iss.tier} isDone={iss.isDone} />
        </div>
        <div
          className="db-mc-focus-title db-ticket-title--link"
          onClick={e => onTitleClick(iss.idReadable, e)}
        >{iss.summary}</div>
        <div className="db-mc-focus-footer">
          <DBAvatar name={iss.assignee || '?'} url={iss.avatarUrl} size={16} />
          <span className="db-mc-focus-assignee">{iss.assignee?.split(' ')[0] || 'Unassigned'}</span>
          {iss.hours_in_state > 0 && (
            <span
              className="db-mc-focus-time"
              style={{ color: iss.overdue_level === 'deadline' ? 'var(--color-danger)' : undefined }}
            >
              {fmtHours(iss.hours_in_state)} in state
            </span>
          )}
          {(iss.verified_on_dev || iss.verified_on_stage || iss.verified_on_prod) && (
            <div className="db-verif-badges">
              {iss.verified_on_dev   && <span className="db-verif-badge db-verif-badge--dev" title={`DEV: ${iss.verified_on_dev}`}>DEV✓</span>}
              {iss.verified_on_stage && <span className="db-verif-badge db-verif-badge--stg" title={`STG: ${iss.verified_on_stage}`}>STG✓</span>}
              {iss.verified_on_prod  && <span className="db-verif-badge db-verif-badge--prd" title={`PRD: ${iss.verified_on_prod}`}>PRD✓</span>}
            </div>
          )}
        </div>
      </div>
    </HoverCard>
  )
}

// ── Tier block — shows only active issues; done are collapsed under a toggle ──

interface TierBlockProps {
  title: string
  tier: number
  issues: PulseIssue[]
  defaultOpen?: boolean
  onIdClick: (id: string, e: React.MouseEvent) => void
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  priorityTags?: PriorityTag[]
}

function TierBlock({ title, tier, issues, defaultOpen = true, onIdClick, onTitleClick, priorityTags }: TierBlockProps) {
  const [open, setOpen]     = useState(defaultOpen)
  const [doneOpen, setDoneOpen] = useState(false)

  const active   = issues.filter(i => !i.isDone)
  const done     = issues.filter(i => i.isDone)
  const breached = active.filter(i => slaBreach(tier, i.hours_in_state))
  const borderCls = tier === 1 ? 'sp-t1' : tier === 2 ? 'sp-t2' : tier === 3 ? 'sp-t3' : 'sp-t4'

  return (
    <div className={`sp-tier ${borderCls}`}>
      <button className="sp-tier-hd" onClick={() => setOpen(o => !o)}>
        <span className="sp-tier-chevron">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="sp-tier-name">{title}</span>
        <span className="sp-tier-active">{active.length} active</span>
        {done.length > 0 && <span className="sp-tier-done">{done.length} done</span>}
        {breached.length > 0 && <span className="sp-tier-breach">{breached.length} ⚠ SLA</span>}
      </button>
      {open && (
        <div className="sp-tier-body">
          {active.length === 0 && done.length === 0 && (
            <p className="sp-empty">No issues in this tier</p>
          )}
          {active.length === 0 && done.length > 0 && (
            <p className="sp-empty sp-empty-ok">✓ All {done.length} delivered</p>
          )}
          {active.map(i => (
            <IssueRow key={i.idReadable} iss={i} onIdClick={onIdClick} onTitleClick={onTitleClick} priorityTags={priorityTags} />
          ))}
          {done.length > 0 && active.length > 0 && (
            <button
              className="sp-done-toggle"
              onClick={e => { e.stopPropagation(); setDoneOpen(o => !o) }}
            >
              {doneOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {done.length} done
            </button>
          )}
          {doneOpen && done.map(i => (
            <IssueRow key={i.idReadable} iss={i} onIdClick={onIdClick} onTitleClick={onTitleClick} priorityTags={priorityTags} dim />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Health bar (right panel) ──────────────────────────────────────────────────

function HealthBar({ label, done, total, color }: { label: string; done: number; total: number; color: string }) {
  const pct = total > 0 ? (done / total) * 100 : 0
  return (
    <div className="sp-hbar">
      <span className="sp-hbar-label">{label}</span>
      <div className="sp-hbar-track">
        <div className="sp-hbar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="sp-hbar-frac" style={{ color }}>{done}<span className="sp-hbar-sep">/</span>{total}</span>
    </div>
  )
}

// ── Props + main view ─────────────────────────────────────────────────────────

export interface SprintPulseViewProps {
  activeSprint: YouTrackSprint | null
  boardData: SprintBoardStatusResponse | null
  boardLoading: boolean
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
}

export function SprintPulseView({ activeSprint, boardData, boardLoading, onTitleClick, onIdClick }: SprintPulseViewProps) {
  const { config: wfConfig } = useWorkflowConfig()
  const [regOpen,    setRegOpen]    = useState(true)
  const [t4Open,     setT4Open]     = useState(false)
  const [t4DoneOpen, setT4DoneOpen] = useState(false)

  const priorityTags = wfConfig?.priority_tags

  const roleMap = useMemo(() => {
    const m = new Map<string, string>()
    wfConfig?.column_hierarchy?.forEach(col => {
      m.set(col.state.toLowerCase(), col.role)
      col.aliases?.forEach((a: string) => m.set(a.toLowerCase(), col.role))
    })
    return m
  }, [wfConfig])

  const allIssues = useMemo((): PulseIssue[] => {
    if (!boardData) return []
    const out: PulseIssue[] = []
    for (const col of boardData.columns) {
      const colRole = roleMap.get(col.name.toLowerCase()) ?? ''
      const isDone  = DONE_ROLES.has(colRole)
      for (const iss of col.issues) {
        out.push({ ...iss, tier: classifyTier(iss.priority, iss.issue_type, iss.is_hotfix), isDone, colRole })
      }
    }
    return out
  }, [boardData, roleMap])

  const tier1 = useMemo(() => allIssues.filter(i => i.tier === 1), [allIssues])
  const tier2 = useMemo(() => allIssues.filter(i => i.tier === 2), [allIssues])
  const tier3 = useMemo(() => allIssues.filter(i => i.tier === 3), [allIssues])
  const tier4 = useMemo(() => allIssues.filter(i => i.tier === 4), [allIssues])
  const regs  = useMemo(() => allIssues.filter(i => i.tier === 0).sort((a, b) => b.hours_in_state - a.hours_in_state), [allIssues])

  const totalDone = allIssues.filter(i => i.isDone).length
  const totalAll  = allIssues.length
  const pct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0

  const t1Breached = tier1.filter(i => !i.isDone && slaBreach(1, i.hours_in_state))
  const t2Breached = tier2.filter(i => !i.isDone && slaBreach(2, i.hours_in_state))
  const atRisk     = allIssues.filter(i => i.is_delayed && !i.isDone)

  const t4Active = tier4.filter(i => !i.isDone)
  const t4Done   = tier4.filter(i => i.isDone)

  if (!activeSprint) {
    return (
      <div className="sp-no-sprint">
        <Zap size={28} />
        <p>Select a sprint to view Sprint Pulse</p>
      </div>
    )
  }

  if (boardLoading || !boardData) {
    return (
      <div className="sp-loading">
        <SprintScanLoader size={48} />
        Loading Sprint Pulse — {activeSprint.name}…
      </div>
    )
  }

  return (
    <div className="sp-page">

      {/* Status strip */}
      <div className="sp-strip">
        <div className="sp-strip-left">
          {t1Breached.length > 0 && (
            <span className="sp-pill sp-pill-crit"><AlertTriangle size={12} /> {t1Breached.length} CRITICAL SLA breached</span>
          )}
          {t2Breached.length > 0 && (
            <span className="sp-pill sp-pill-urg"><AlertCircle size={12} /> {t2Breached.length} urgent SLA stalled</span>
          )}
          {t1Breached.length === 0 && t2Breached.length === 0 && (
            <span className="sp-pill sp-pill-ok"><CheckCircle2 size={12} /> All SLAs on track</span>
          )}
          {atRisk.length > 0 && (
            <span className="sp-pill sp-pill-delay"><AlertTriangle size={12} /> {atRisk.length} delayed</span>
          )}
        </div>
        <div className="sp-strip-right">
          <span className="sp-sprint-name">{activeSprint.name}</span>
          <span className="sp-pct">{pct}%</span>
          <span className="sp-total">{totalDone}/{totalAll}</span>
        </div>
      </div>

      {/* Main layout */}
      <div className="sp-grid">

        {/* Left: tier accordion */}
        <div className="sp-tiers">
          <TierBlock
            title="CRITICAL / HOTFIX" tier={1} issues={tier1} defaultOpen
            onIdClick={onIdClick} onTitleClick={onTitleClick} priorityTags={priorityTags}
          />
          <TierBlock
            title="URGENT (P1 / A1)" tier={2} issues={tier2} defaultOpen
            onIdClick={onIdClick} onTitleClick={onTitleClick} priorityTags={priorityTags}
          />
          <TierBlock
            title="SCHEDULED (P2 / A2)" tier={3} issues={tier3} defaultOpen={false}
            onIdClick={onIdClick} onTitleClick={onTitleClick} priorityTags={priorityTags}
          />

          {/* Tier 4 — Normal, collapsed by default */}
          <div className="sp-tier sp-t4">
            <button className="sp-tier-hd" onClick={() => setT4Open(o => !o)}>
              <span className="sp-tier-chevron">{t4Open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
              <span className="sp-tier-name">NORMAL</span>
              <span className="sp-tier-active">{t4Active.length} active</span>
              {t4Done.length > 0 && <span className="sp-tier-done">{t4Done.length} done</span>}
            </button>
            {t4Open && (
              <div className="sp-tier-body">
                {t4Active.length === 0 && t4Done.length === 0 && <p className="sp-empty">No issues</p>}
                {t4Active.length === 0 && t4Done.length > 0  && <p className="sp-empty sp-empty-ok">✓ All {t4Done.length} delivered</p>}
                {t4Active.map(i => (
                  <IssueRow key={i.idReadable} iss={i} onIdClick={onIdClick} onTitleClick={onTitleClick} priorityTags={priorityTags} />
                ))}
                {t4Done.length > 0 && t4Active.length > 0 && (
                  <>
                    <button className="sp-done-toggle" onClick={() => setT4DoneOpen(o => !o)}>
                      {t4DoneOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      {t4Done.length} done
                    </button>
                    {t4DoneOpen && t4Done.map(i => (
                      <IssueRow key={i.idReadable} iss={i} onIdClick={onIdClick} onTitleClick={onTitleClick} priorityTags={priorityTags} dim />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Regressions */}
          {regs.length > 0 && (
            <div className="sp-reg-wrap">
              <button className="sp-reg-hd" onClick={() => setRegOpen(o => !o)}>
                {regOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="sp-reg-title">REGRESSIONS</span>
                <span className="sp-tier-active">{regs.filter(i => !i.isDone).length} active</span>
                {regs.filter(i => i.isDone).length > 0 && (
                  <span className="sp-tier-done">{regs.filter(i => i.isDone).length} done</span>
                )}
                <span className="sp-reg-sub">oldest first</span>
              </button>
              {regOpen && (
                <div className="sp-tier-body">
                  {regs.filter(i => !i.isDone).map(i => (
                    <IssueRow key={i.idReadable} iss={i} onIdClick={onIdClick} onTitleClick={onTitleClick} priorityTags={priorityTags} />
                  ))}
                  {regs.filter(i => !i.isDone).length === 0 && (
                    <p className="sp-empty sp-empty-ok">✓ No active regressions</p>
                  )}
                  {regs.filter(i => i.isDone).length > 0 && (
                    <p className="sp-empty" style={{ marginTop: 2 }}>
                      + {regs.filter(i => i.isDone).length} resolved
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: health summary panel */}
        <div className="sp-panel">
          <div className="sp-card">
            <div className="sp-card-title">Sprint Health</div>
            <div className="sp-hbars">
              <HealthBar label="Critical" done={tier1.filter(i => i.isDone).length} total={tier1.length} color="var(--color-danger)" />
              <HealthBar label="Urgent"   done={tier2.filter(i => i.isDone).length} total={tier2.length} color="var(--color-warning)" />
              <HealthBar label="Normal"   done={tier4.filter(i => i.isDone).length} total={tier4.length} color="var(--color-success)" />
            </div>
            <div className="sp-health-footer">
              <span className="sp-health-label">{totalDone} / {totalAll} delivered</span>
              <span className="sp-health-pct">{pct}%</span>
            </div>
          </div>

          {atRisk.length > 0 && (
            <div className="sp-card sp-card-risk">
              <div className="sp-card-title">⚠ Delayed</div>
              <div className="sp-risk-list">
                {atRisk.slice(0, 8).map(i => (
                  <button key={i.idReadable} className="sp-risk-id" onClick={e => onIdClick(i.idReadable, e)}>
                    {i.idReadable}
                  </button>
                ))}
                {atRisk.length > 8 && <span className="sp-risk-more">+{atRisk.length - 8} more</span>}
              </div>
            </div>
          )}

          <div className="sp-card">
            <div className="sp-card-title">Breakdown</div>
            {([
              { label: 'Critical / Hotfix', active: tier1.filter(i => !i.isDone).length, total: tier1.length, color: 'var(--color-danger)' },
              { label: 'Urgent (P1/A1)',    active: tier2.filter(i => !i.isDone).length, total: tier2.length, color: 'var(--color-warning)' },
              { label: 'Scheduled',         active: tier3.filter(i => !i.isDone).length, total: tier3.length, color: 'var(--color-primary)' },
              { label: 'Normal',            active: t4Active.length,                     total: tier4.length, color: 'var(--text-muted)' },
              { label: 'Regressions',       active: regs.filter(i => !i.isDone).length,  total: regs.length,  color: 'var(--color-warning)' },
            ] as const).filter(r => r.total > 0).map(r => (
              <div key={r.label} className="sp-bk-row">
                <span className="sp-bk-dot" style={{ background: r.color }} />
                <span className="sp-bk-label">{r.label}</span>
                <span className="sp-bk-active">{r.active}</span>
                <span className="sp-bk-n" style={{ color: r.color }}>{r.total}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
