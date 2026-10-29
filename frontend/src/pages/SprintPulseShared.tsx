import React, { useState } from 'react'
import HoverCard from '@/components/HoverCard'
import type { WorkflowConfig } from '@/services/api'
import { fmtHours, dangerLevel, type PulseIssue } from './sprint-pulse-types'

// ─── Avatar ───────────────────────────────────────────────────────────────────

export function DBAvatar({ name, url, size = 22 }: { name: string; url?: string; size?: number }) {
  const [imgFailed, setImgFailed] = useState(false)
  const initials = (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  if (url && !imgFailed) {
    return (
      <img
        src={url} alt={name} width={size} height={size}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        onError={() => setImgFailed(true)}
      />
    )
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'var(--color-primary)', color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.4), fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  )
}

// ─── Pills ────────────────────────────────────────────────────────────────────

export function PriPill({ priority, tags }: { priority: string; tags?: WorkflowConfig['priority_tags'] }) {
  if (!priority) return null
  const tag  = tags?.find(t =>
    t.label.toLowerCase() === priority.toLowerCase() ||
    t.yt_mappings?.some(m => m.toLowerCase() === priority.toLowerCase())
  )
  const color = tag?.color || 'var(--text-muted)'
  return (
    <span
      className="spl-pri-pill"
      style={{ color, borderColor: `${color}55`, background: `${color}1A` }}
    >
      {priority}
    </span>
  )
}

export function IssueTypePill({ type }: { type: string }) {
  if (!type) return null
  const lower  = type.toLowerCase()
  const isHf   = lower.includes('hotfix')
  const isReg  = lower.includes('regress')
  const isBug  = lower.includes('bug')
  return (
    <span className={`spl-type-pill${isHf ? ' spl-type-pill--hf' : isReg ? ' spl-type-pill--reg' : isBug ? ' spl-type-pill--bug' : ''}`}>
      {type}
    </span>
  )
}

// ─── Hover content builders ───────────────────────────────────────────────────

export function buildHoverContent(iss: PulseIssue): React.ReactNode {
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>{iss.summary}</div>
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>State: <strong style={{ color: 'var(--text-primary)' }}>{iss.current_state}</strong></div>
      {iss.assignee && <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Assignee: {iss.assignee}</div>}
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Time in state: {fmtHours(iss.hours_in_state)}</div>
      {iss.cycle_time_hours > 0 && <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>Cycle time: {fmtHours(iss.cycle_time_hours)}</div>}
      {iss.bounce_count > 0 && <div style={{ color: 'var(--color-warning)', marginBottom: 2 }}>↩ Bounced {iss.bounce_count}×</div>}
      {iss.is_hotfix && <div style={{ color: 'var(--color-danger)' }}>⚡ Hotfix</div>}
      {iss.overdue_level && <div style={{ color: 'var(--color-danger)' }}>⚠ {iss.overdue_level} overdue</div>}
    </div>
  )
}

// ─── IssueCard ────────────────────────────────────────────────────────────────

export function IssueCard({
  iss, wfConfig, onTitleClick, onIdClick, showStage = false, noHover = false,
}: {
  iss: PulseIssue
  wfConfig: WorkflowConfig | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
  showStage?: boolean
  noHover?: boolean
}) {
  const danger = dangerLevel(iss)
  const canPulse = danger === 2 && !iss.isDone && iss.colRole !== 'backlog'
  const card = (
    <div className={`spl-card${iss.isDone ? ' spl-card--done' : ''}${danger === 2 ? ' spl-card--crit' : danger === 1 ? ' spl-card--warn' : ''}${canPulse ? ' spl-card--pulse' : ''}`}>
      <div className="spl-card-top">
        <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
        <IssueTypePill type={iss.issue_type} />
        <span
          className="spl-ticket-id"
          onClick={(e) => onIdClick(iss.idReadable, e)}
          title={`Open ${iss.idReadable} in YouTrack`}
        >
          {iss.idReadable}
        </span>
        {iss.is_hotfix && <span className="spl-hf-chip">HF</span>}
        {iss.bounce_count > 0 && <span className="spl-bounce-chip">↩{iss.bounce_count}</span>}
        {showStage && <span className={`spl-stage-chip spl-stage-chip--${iss.stageGroup}`}>{iss.current_state}</span>}
        {!showStage && <span className="spl-state-chip">{iss.current_state}</span>}
      </div>
      <div className="spl-card-title" onClick={(e) => onTitleClick(iss.idReadable, e)}>
        {iss.summary}
      </div>
      <div className="spl-card-footer">
        <DBAvatar name={iss.assignee || '?'} url={iss.avatarUrl} size={16} />
        <span className="spl-card-assignee">{iss.assignee?.split(' ')[0] || 'Unassigned'}</span>
        <span className="spl-card-time" style={{ color: danger >= 1 ? 'var(--color-danger)' : undefined }}>
          {fmtHours(iss.hours_in_state)}
        </span>
      </div>
    </div>
  )
  if (noHover) return card
  return <HoverCard content={buildHoverContent(iss)} delay={250}>{card}</HoverCard>
}

// ─── Skeleton primitive ───────────────────────────────────────────────────────

export const Sk = ({ w, h, r = 6 }: { w: number | string; h: number; r?: number | string }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
)

export const SK_W = [55, 70, 48, 65, 58, 72]
