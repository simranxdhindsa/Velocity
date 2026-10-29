import React, { useState, useMemo } from 'react'
import HoverCard from '@/components/HoverCard'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { IssueCard, DBAvatar, PriPill, IssueTypePill, buildHoverContent, Sk, SK_W } from './SprintPulseShared'
import {
  fmtHours, dangerLevel, tierLabel, tierCssClass,
  type PulseIssue, type ViewProps,
} from './sprint-pulse-types'
import type { WorkflowConfig } from '@/services/api'

// ─── View C — Focus (split panel) ────────────────────────────────────────────

export function ViewC({ tierGroups, stageCounts, wfConfig, onTitleClick, onIdClick }: ViewProps) {
  const allIssues = useMemo(() => {
    const tiers = [tierGroups.t1, tierGroups.t2, tierGroups.t3, tierGroups.t4, tierGroups.t5, tierGroups.reg]
    return tiers.flat().filter(i => !i.isDone).sort((a, b) => {
      const da = dangerLevel(a), db = dangerLevel(b)
      if (da !== db) return db - da
      return a.tier - b.tier
    })
  }, [tierGroups])

  const groups: { tier: number; items: PulseIssue[] }[] = [
    { tier: 1, items: tierGroups.t1 },
    { tier: 2, items: tierGroups.t2 },
    { tier: 3, items: tierGroups.t3 },
    { tier: 4, items: tierGroups.t4 },
    { tier: 5, items: tierGroups.t5 },
    { tier: 0, items: tierGroups.reg },
  ]

  const totalActive = allIssues.length
  const dangerCount = allIssues.filter(i => dangerLevel(i) >= 1).length

  return (
    <div className="spl-split">
      <div className="spl-split-panel">
        <div className="spl-panel-card">
          <div className="spl-panel-title">Tier Health</div>
          <div className="spl-hbars">
            {groups.map(({ tier, items }) => {
              const activeItems = items.filter(i => !i.isDone)
              const doneItems   = items.filter(i => i.isDone)
              const total = activeItems.length + doneItems.length
              const pct = total > 0 ? Math.round((doneItems.length / total) * 100) : 0
              const barColor = tier === 1 ? 'var(--color-danger)' : tier === 2 ? 'var(--color-warning)' : tier === 0 ? 'var(--color-warning)' : 'var(--color-primary)'
              return (
                <div key={tier} className="spl-hbar">
                  <span className="spl-hbar-label">{tierLabel(tier).split(' ')[0]}</span>
                  <div className="spl-hbar-track">
                    <div className="spl-hbar-fill" style={{ width: `${pct}%`, background: barColor }} />
                  </div>
                  <span className="spl-hbar-frac">
                    <span style={{ color: 'var(--color-success)' }}>{doneItems.length}</span>
                    <span className="spl-hbar-sep">/</span>
                    {total}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="spl-panel-footer">
            <span className="spl-panel-footer-label">{dangerCount} needs attention</span>
            <span className="spl-panel-footer-val">{totalActive} active</span>
          </div>
        </div>

        {stageCounts && (
          <div className="spl-panel-card">
            <div className="spl-panel-title">Delivery Pipeline</div>
            {([
              { key: 'active',   label: 'Active',    color: 'var(--color-primary)'  },
              { key: 'devDone',  label: 'Dev Done',  color: 'var(--color-success)'  },
              { key: 'stage',    label: 'Stage',     color: 'var(--color-warning)'  },
              { key: 'deployed', label: 'Deployed',  color: 'var(--text-muted)'     },
              { key: 'blocked',  label: 'Blocked',   color: 'var(--color-danger)'   },
            ] as const).map(({ key, label, color }) => (
              <div key={key} className="spl-bk-row">
                <div className="spl-bk-dot" style={{ background: color }} />
                <span className="spl-bk-label">{label}</span>
                <span className="spl-bk-n" style={{ color }}>{stageCounts[key]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="spl-split-feed">
        <div className="spl-feed-hd">
          <span className="spl-feed-hd-title">Priority Feed</span>
          <span className="spl-feed-hd-sub">{allIssues.length} active issues · sorted by urgency</span>
        </div>
        {allIssues.length === 0 && (
          <div className="spl-feed-empty">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            ✓ No active issues
          </div>
        )}
        {allIssues.map(iss => (
          <IssueCard
            key={iss.id}
            iss={iss}
            wfConfig={wfConfig}
            onTitleClick={onTitleClick}
            onIdClick={onIdClick}
            showStage
          />
        ))}
      </div>
    </div>
  )
}

// ─── View 1 — Signal (flat linear list) ──────────────────────────────────────

function SignalRow({
  iss, wfConfig, onTitleClick, onIdClick,
}: {
  iss: PulseIssue
  wfConfig: WorkflowConfig | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
}) {
  const danger = dangerLevel(iss)
  return (
    <HoverCard content={buildHoverContent(iss)} delay={250}>
      <div className={`spl-signal-row${iss.isDone ? ' spl-signal-row--done' : ''}${danger === 2 ? ' spl-signal-row--crit' : danger === 1 ? ' spl-signal-row--warn' : ''}`}>
        <PriPill priority={iss.priority} tags={wfConfig?.priority_tags} />
        <IssueTypePill type={iss.issue_type} />
        <span
          className="spl-ticket-id"
          onClick={(e) => onIdClick(iss.idReadable, e)}
          title={`Open ${iss.idReadable} in YouTrack`}
        >
          {iss.idReadable}
        </span>
        <span className="spl-signal-title" onClick={(e) => onTitleClick(iss.idReadable, e)}>
          {iss.summary}
        </span>
        <span className={`spl-stage-chip spl-stage-chip--${iss.stageGroup}`}>{iss.current_state}</span>
        <DBAvatar name={iss.assignee || '?'} url={iss.avatarUrl} size={18} />
        <span className="spl-signal-assignee">{iss.assignee?.split(' ')[0] || '—'}</span>
        <span className="spl-signal-time" style={{ color: danger >= 1 ? 'var(--color-danger)' : undefined }}>
          {fmtHours(iss.hours_in_state)}
        </span>
        {iss.bounce_count > 0 && <span className="spl-bounce-chip">↩{iss.bounce_count}</span>}
        {iss.is_hotfix && <span className="spl-hf-chip">HF</span>}
      </div>
    </HoverCard>
  )
}

function TierSection({
  tier, active, done, wfConfig, onTitleClick, onIdClick,
}: {
  tier: number
  active: PulseIssue[]
  done: PulseIssue[]
  wfConfig: WorkflowConfig | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
}) {
  const [showDone, setShowDone] = useState(false)
  const breachCount = active.filter(i => dangerLevel(i) >= 1).length
  return (
    <div className={`spl-signal-section ${tierCssClass(tier)}`}>
      <div className="spl-signal-section-hd">
        <span className="spl-signal-tier-name">{tierLabel(tier)}</span>
        <span className="spl-signal-tier-cnt">{active.length}</span>
        {breachCount > 0 && <span className="spl-tier-col-breach">⚠ {breachCount}</span>}
        {done.length > 0 && <span className="spl-tier-col-done">{done.length} done</span>}
      </div>
      {active.length === 0 && <div className="spl-signal-empty">✓ Nothing active</div>}
      {active.map(iss => (
        <SignalRow key={iss.id} iss={iss} wfConfig={wfConfig} onTitleClick={onTitleClick} onIdClick={onIdClick} />
      ))}
      {done.length > 0 && (
        <button className="spl-done-toggle" onClick={() => setShowDone(v => !v)}>
          {showDone ? '↑ Hide done' : `↓ ${done.length} done`}
        </button>
      )}
      {showDone && done.map(iss => (
        <SignalRow key={iss.id} iss={iss} wfConfig={wfConfig} onTitleClick={onTitleClick} onIdClick={onIdClick} />
      ))}
    </div>
  )
}

export function View1({ tierGroups, wfConfig, onTitleClick, onIdClick }: ViewProps) {
  const sections: { tier: number; issues: PulseIssue[] }[] = [
    { tier: 1, issues: tierGroups.t1 },
    { tier: 2, issues: tierGroups.t2 },
    { tier: 3, issues: tierGroups.t3 },
    { tier: 4, issues: tierGroups.t4 },
    { tier: 5, issues: tierGroups.t5 },
    { tier: 0, issues: tierGroups.reg },
  ]

  return (
    <div className="spl-signal">
      <div className="spl-signal-hdr">
        <span style={{ minWidth: 52 }}>Priority</span>
        <span style={{ minWidth: 60 }}>Type</span>
        <span style={{ minWidth: 70 }}>ID</span>
        <span style={{ flex: 1 }}>Title</span>
        <span style={{ minWidth: 100 }}>State</span>
        <span style={{ minWidth: 120 }}>Assignee</span>
        <span style={{ minWidth: 55, textAlign: 'right' }}>In State</span>
        <span style={{ minWidth: 30 }}></span>
      </div>

      {sections.map(({ tier, issues }) => {
        const active = issues.filter(i => !i.isDone)
        const done   = issues.filter(i => i.isDone)
        if (active.length === 0 && done.length === 0) return null
        return (
          <TierSection
            key={tier}
            tier={tier}
            active={active}
            done={done}
            wfConfig={wfConfig}
            onTitleClick={onTitleClick}
            onIdClick={onIdClick}
          />
        )
      })}
    </div>
  )
}

// ─── View 4 — Pulse Board (swimlanes) ────────────────────────────────────────

const STAGE_COLS: { key: PulseIssue['stageGroup']; label: string }[] = [
  { key: 'active',   label: 'Active' },
  { key: 'blocked',  label: 'Blocked' },
  { key: 'dev_done', label: 'Dev Done' },
  { key: 'stage',    label: 'Stage' },
  { key: 'deployed', label: 'Deployed' },
]

function PulseCell({
  issues, wfConfig, onTitleClick, onIdClick,
}: {
  issues: PulseIssue[]
  wfConfig: WorkflowConfig | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
}) {
  const MAX_VISIBLE = 4
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? issues : issues.slice(0, MAX_VISIBLE)
  const overflow = issues.length - MAX_VISIBLE

  if (issues.length === 0) {
    return <div className="spl-sw-empty">—</div>
  }

  return (
    <div className="spl-sw-cell">
      {visible.map(iss => {
        const danger = dangerLevel(iss)
        return (
          <HoverCard key={iss.id} content={buildHoverContent(iss)} delay={250}>
            <div className={`spl-sw-card${danger === 2 ? ' spl-sw-card--crit' : danger === 1 ? ' spl-sw-card--warn' : ''}${iss.isDone ? ' spl-sw-card--done' : ''}`}>
              <div className="spl-sw-card-top">
                <span
                  className="spl-ticket-id spl-ticket-id--sm"
                  onClick={(e) => onIdClick(iss.idReadable, e)}
                >
                  {iss.idReadable}
                </span>
                {iss.is_hotfix && <span className="spl-hf-chip spl-hf-chip--xs">HF</span>}
                {iss.bounce_count > 0 && <span className="spl-bounce-chip spl-bounce-chip--xs">↩{iss.bounce_count}</span>}
              </div>
              <div
                className="spl-sw-card-title"
                onClick={(e) => onTitleClick(iss.idReadable, e)}
              >
                {iss.summary}
              </div>
              <div className="spl-sw-card-footer">
                <DBAvatar name={iss.assignee || '?'} url={iss.avatarUrl} size={14} />
                <span className="spl-sw-card-time" style={{ color: danger >= 1 ? 'var(--color-danger)' : undefined }}>
                  {fmtHours(iss.hours_in_state)}
                </span>
              </div>
            </div>
          </HoverCard>
        )
      })}
      {!expanded && overflow > 0 && (
        <button className="spl-sw-more" onClick={() => setExpanded(true)}>
          +{overflow} more
        </button>
      )}
      {expanded && issues.length > MAX_VISIBLE && (
        <button className="spl-sw-more" onClick={() => setExpanded(false)}>
          ↑ Show less
        </button>
      )}
    </div>
  )
}

export function View4({ tierGroups, wfConfig, onTitleClick, onIdClick }: ViewProps) {
  const tiers: { tier: number; issues: PulseIssue[] }[] = [
    { tier: 1, issues: tierGroups.t1 },
    { tier: 2, issues: tierGroups.t2 },
    { tier: 3, issues: tierGroups.t3 },
    { tier: 4, issues: tierGroups.t4 },
    { tier: 5, issues: tierGroups.t5 },
    { tier: 0, issues: tierGroups.reg },
  ]

  return (
    <div className="spl-swimlane">
      <div className="spl-sw-grid">
        <div className="spl-sw-row-hd-cell" />
        {STAGE_COLS.map(col => (
          <div key={col.key} className={`spl-sw-col-hd spl-sw-col-hd--${col.key}`}>
            {col.label}
          </div>
        ))}
      </div>

      {tiers.map(({ tier, issues }) => {
        const hasAny = issues.length > 0
        if (!hasAny) return null
        return (
          <div key={tier} className={`spl-sw-grid ${tierCssClass(tier)}`}>
            <div className="spl-sw-row-hd">
              <span className="spl-sw-row-hd-name">{tierLabel(tier)}</span>
              <span className="spl-sw-row-hd-cnt">{issues.filter(i => !i.isDone).length}</span>
            </div>
            {STAGE_COLS.map(col => (
              <PulseCell
                key={col.key}
                issues={issues.filter(i => i.stageGroup === col.key)}
                wfConfig={wfConfig}
                onTitleClick={onTitleClick}
                onIdClick={onIdClick}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ─── Skeleton loaders ─────────────────────────────────────────────────────────

export function SkBoard() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-color)' }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ flex: 1, padding: '10px 12px', borderRight: i < 5 ? '1px solid var(--border-color)' : 'none' }}>
            <Sk w="60%" h={11} r={3} />
          </div>
        ))}
      </div>
      {Array.from({ length: 4 }).map((_, row) => (
        <div key={row} style={{ display: 'flex', gap: 8 }}>
          <div style={{ width: 90, padding: '10px 0' }}>
            <Sk w={70} h={12} r={4} />
          </div>
          {Array.from({ length: 6 }).map((_, col) => (
            <div key={col} style={{ flex: 1, padding: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
              {Math.random() > 0.4 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Sk w={28} h={16} r={4} />
                    <Sk w={40} h={16} r={4} />
                  </div>
                  <Sk w={`${SK_W[(row * 6 + col) % 6]}%`} h={10} r={3} />
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <Sk w={14} h={14} r="50%" />
                    <Sk w={44} h={9} r={3} />
                    <Sk w={30} h={9} r={3} />
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkSignal() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div style={{ display: 'flex', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        {[52, 60, 70, 120, 100, 120, 55].map((w, i) => <Sk key={i} w={w} h={10} r={3} />)}
      </div>
      <div style={{ padding: '8px 12px 4px', display: 'flex', gap: 8, alignItems: 'center' }}>
        <Sk w={90} h={13} r={4} />
        <Sk w={24} h={18} r={4} />
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', alignItems: 'center' }}>
          <Sk w={52} h={18} r={4} />
          <Sk w={60} h={16} r={4} />
          <Sk w={66} h={16} r={4} />
          <Sk w={`${SK_W[i % 6]}%`} h={10} r={3} style={{ flex: 1 }} />
          <Sk w={100} h={18} r={4} />
          <Sk w={16} h={16} r="50%" />
          <Sk w={60} h={10} r={3} />
          <Sk w={36} h={10} r={3} />
        </div>
      ))}
    </div>
  )
}
