// Dev Activity: small shared components (avatar, badges, journey chain, KPI summary bar).
import React from 'react'
import { CountUp } from '../components/CountUp'
import { useYouTrackAvatars } from '@/hooks/useYouTrackAvatars'
import type { IssueTimeline } from '../services/api'
import { type JourneyStep, DEV_DONE_STATES, devColor, devInitials, fmtH, getCurrentState, stateCfg } from './dev-activity-types'

// ─── Atom components ─────────────────────────────────────────────────────────

/** Profile picture from YouTrack, falling back to coloured initials when there's none or it fails to load. */
export const DaAvatar = React.memo(function DaAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const avatarOf = useYouTrackAvatars()
  const url = avatarOf(name)
  const [failed, setFailed] = React.useState<string | null>(null)
  const color = devColor(name)
  const showImg = url && failed !== url
  return (
    <div className="da-avatar" title={name} style={{
      width: size, height: size, fontSize: size * 0.35,
      background: showImg ? undefined : `linear-gradient(135deg, ${color}, ${color}99)`,
    }}>
      {showImg
        ? <img className="da-avatar-img" src={url} alt="" loading="lazy" onError={() => setFailed(url)} />
        : devInitials(name)}
    </div>
  )
})

export function DaStateBadge({ state, small = false }: { state: string; small?: boolean }) {
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

export function DaTicketId({ id, href }: { id: string; href?: string }) {
  return (
    <a href={href ?? '#'} target={href && href !== '#' ? '_blank' : undefined}
      rel="noopener noreferrer" className="da-ticket-id"
      onClick={e => { if (!href || href === '#') e.preventDefault() }}>
      {id}
    </a>
  )
}

export function DaPriDot({ priority }: { priority: string }) {
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

export function DaJourneyChain({ steps }: { steps: JourneyStep[] }) {
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

export function DaSummaryBar({ timelines }: { timelines: IssueTimeline[] }) {
  const total   = timelines.length
  const done    = timelines.filter(t => { const s = getCurrentState(t).toLowerCase(); return DEV_DONE_STATES.some(k => s.includes(k)) }).length
  const active  = timelines.filter(t => t.is_live).length
  const blocked = timelines.filter(t => getCurrentState(t).toLowerCase() === 'blocked').length
  const bounced = timelines.filter(t => (t.moved_back_count ?? 0) > 0).length
  const chips = [
    { label: 'Touched',   value: total,   color: 'var(--text-primary)',     icon: '🎯' },
    { label: 'Dev Done',  value: done,    color: 'var(--color-success)',    icon: '✅' },
    { label: 'Active',   value: active,  color: 'var(--color-primary)',    icon: '🔄' },
    { label: 'Blocked',  value: blocked, color: 'var(--color-danger)',     icon: '⛔' },
    { label: 'Bounced',  value: bounced, color: 'var(--color-warning)',    icon: '↩' },
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
