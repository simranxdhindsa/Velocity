import React, { useMemo, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import HoverCard from '@/components/HoverCard'
import { useIgnoredBlocked } from '@/contexts/IgnoredBlockedContext'
import type { SprintBoardStatusResponse, YouTrackSprint, DeveloperLoad } from '@/services/api'
import type { ModeOption } from '@/components/SprintControlsBar'
import {
  Activity, LayoutGrid, Tag, Layers, AlignLeft, BarChart2,
  CheckCircle2, AlertTriangle, Clock, Archive,
} from 'lucide-react'
import { fmtHours, dangerLevel, type PulseIssue } from './sprint-pulse-types'
import { Sk, SK_W } from './SprintPulseShared'
import '@/styles/pages/sprint-pulse-live.css'

// ─── View mode list (exported — used by SprintPulsePage) ─────────────────────

export const VIEW_MODES: ModeOption[] = [
  { id: 'l', label: 'Live',        icon: Activity },
  { id: 'a', label: 'Kanban',      icon: LayoutGrid },
  { id: 'p', label: 'Priority',    icon: Tag },
  { id: 'c', label: 'Focus',       icon: Layers },
  { id: '1', label: 'Signal',      icon: AlignLeft },
  { id: '4', label: 'Pulse Board', icon: BarChart2 },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SLV_COLORS = ['#6366f1','#8b5cf6','#06b6d4','#ec4899','#f59e0b','#10b981']
function slvDevColor(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff
  return SLV_COLORS[h % SLV_COLORS.length]
}

function slvFmtTransitionTime(hoursInState: number): string {
  const ms  = Date.now() - hoursInState * 3600000
  const d   = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + '  ' + time
}

function buildFeedHoverContent(iss: PulseIssue): React.ReactNode {
  return (
    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--text-primary)', lineHeight: 1.3 }}>
        {iss.summary}
      </div>
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>
        Type: <strong style={{ color: 'var(--text-primary)' }}>{iss.issue_type || '—'}</strong>
        {iss.is_hotfix && <span style={{ marginLeft: 6, color: 'var(--color-danger)', fontWeight: 700 }}>⚡ Hotfix</span>}
      </div>
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>
        Priority: <strong style={{ color: 'var(--text-primary)' }}>{iss.priority || '—'}</strong>
      </div>
      {iss.from_state && (
        <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>
          Move: <strong style={{ color: 'var(--text-secondary)' }}>{iss.from_state}</strong>
          <span style={{ margin: '0 4px' }}>→</span>
          <strong style={{ color: 'var(--color-primary)' }}>{iss.current_state}</strong>
        </div>
      )}
      {iss.total_active_hours > 0 && (
        <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>
          Dev time: <strong style={{ color: 'var(--text-primary)' }}>{fmtHours(iss.total_active_hours)}</strong>
        </div>
      )}
      {iss.cycle_time_hours > 0 && (
        <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>
          Cycle time: <strong style={{ color: 'var(--text-primary)' }}>{fmtHours(iss.cycle_time_hours)}</strong>
        </div>
      )}
      {iss.bounce_count > 0 && (
        <div style={{ color: 'var(--color-warning)', marginBottom: 2 }}>↩ Bounced {iss.bounce_count}×</div>
      )}
      {iss.overdue_level && (
        <div style={{ color: 'var(--color-danger)' }}>⚠ {iss.overdue_level} overdue</div>
      )}
    </div>
  )
}

function sprintDayOf(startMs: number, finishMs: number): { day: number; total: number } {
  const total = Math.max(1, Math.round((finishMs - startMs) / 86400000))
  const day   = Math.min(total, Math.max(1, Math.round((Date.now() - startMs) / 86400000) + 1))
  return { day, total }
}

function sprintPaceStatus(completionPct: number, startMs: number, finishMs: number): 'on-track' | 'at-risk' | 'behind' {
  const elapsed = Math.min(1, Math.max(0, (Date.now() - startMs) / (finishMs - startMs)))
  const expected = elapsed * 100
  if (completionPct >= expected * 0.85) return 'on-track'
  if (completionPct >= expected * 0.60) return 'at-risk'
  return 'behind'
}

// ─── Live sub-components ──────────────────────────────────────────────────────

export const AttentionRow = memo(function AttentionRow({
  iss,
  onTitleClick,
  onIdClick,
  onPark,
}: {
  iss: PulseIssue
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
  onPark?: (id: string) => void
}) {
  return (
    <motion.div
      layout
      exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
      transition={{ duration: 0.18 }}
    >
      <HoverCard content={buildFeedHoverContent(iss)} delay={250} issueId={iss.idReadable} isBlocked={!!onPark} summary={iss.summary}>
        <div className={`slv-attn-row${onPark ? ' slv-attn-row--parkable' : ''}`}>
          <span
            className="spl-ticket-id"
            style={{ fontSize: 11, flexShrink: 0 }}
            onClick={(e) => onIdClick(iss.idReadable, e)}
          >{iss.idReadable}</span>
          <span
            className="slv-attn-title"
            onClick={(e) => onTitleClick(iss.idReadable, e)}
          >{iss.summary}</span>
          <span className="slv-attn-meta">{fmtHours(iss.hours_in_state)}</span>
          {onPark && (
            <button
              className="slv-park-btn"
              title="Park this blocked ticket (hide from all views)"
              onClick={(e) => { e.stopPropagation(); onPark(iss.idReadable) }}
            >
              <Archive size={10} />
              Park
            </button>
          )}
        </div>
      </HoverCard>
    </motion.div>
  )
})

export const LiveDevCard = memo(function LiveDevCard({
  dev,
  allIssues,
  onTitleClick,
  onIdClick,
}: {
  dev: DeveloperLoad
  allIssues: PulseIssue[]
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
}) {
  const isBlocked = dev.blocked_issues.length > 0
  const isActive  = dev.active_issues.length > 0
  const status    = isBlocked ? 'blocked' : isActive ? 'active' : 'idle'
  const currentIss = dev.active_issues[0] ?? null

  const pulseIss = currentIss
    ? allIssues.find(i => i.idReadable === currentIss.id || i.id === currentIss.id) ?? null
    : null

  const initials = dev.assignee.split(' ').filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('')
  const color    = slvDevColor(dev.assignee)

  return (
    <div className={`slv-dev-card slv-dev-card--${status}`}>
      <div className="slv-dev-card-header">
        <div className="slv-dev-avatar" style={{ background: color }}>{initials}</div>
        <div className="slv-dev-name">{dev.assignee.split(' ')[0]}</div>
        <span className={`slv-dev-badge slv-dev-badge--${status}`}>
          {status === 'blocked' ? '⛔ BLOCKED' : status === 'active' ? '▶ ACTIVE' : '○ IDLE'}
        </span>
      </div>

      {currentIss && (
        <div className="slv-dev-current">
          <span className="slv-dev-on-label">On:</span>
          <HoverCard content={pulseIss ? buildFeedHoverContent(pulseIss) : <div style={{ fontSize: 12 }}>{currentIss.summary}</div>} delay={250}>
            <span
              className="spl-ticket-id"
              style={{ fontSize: 11 }}
              onClick={(e) => onIdClick(currentIss.id, e)}
            >{currentIss.id}</span>
          </HoverCard>
          <span
            className="slv-dev-current-title"
            onClick={(e) => onTitleClick(currentIss.id, e)}
          >{currentIss.summary}</span>
        </div>
      )}

      {isBlocked && (
        <div className="slv-dev-blockers">
          {dev.blocked_issues.slice(0, 2).map(bi => (
            <span
              key={bi.id}
              className="spl-ticket-id slv-dev-blocker-id"
              onClick={(e) => onIdClick(bi.id, e)}
            >{bi.id}</span>
          ))}
          {dev.blocked_issues.length > 2 && (
            <span className="slv-dev-blocker-more">+{dev.blocked_issues.length - 2}</span>
          )}
        </div>
      )}

      <div className="slv-dev-stats">
        <span className="slv-dev-stat">
          <CheckCircle2 size={10} />
          {dev.done_today} done today
        </span>
        <span className="slv-dev-stat">
          <Clock size={10} />
          {dev.active_issues.length} active
        </span>
        {dev.missing_update && (
          <span className="slv-dev-stat slv-dev-stat--warn">
            <AlertTriangle size={10} /> no update
          </span>
        )}
      </div>
    </div>
  )
})

export const LiveActivityFeed = memo(function LiveActivityFeed({
  allIssues,
  onTitleClick,
  onIdClick,
}: {
  allIssues: PulseIssue[]
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
}) {
  const { sorted, todayOnly } = useMemo(() => {
    const all = [...allIssues].sort((a, b) => a.hours_in_state - b.hours_in_state)
    const recent = all.filter(i => i.hours_in_state < 24)
    if (recent.length > 0) return { sorted: recent, todayOnly: true }
    return { sorted: all.slice(0, 15), todayOnly: false }
  }, [allIssues])

  if (sorted.length === 0) {
    return (
      <div className="slv-feed-empty">
        <Activity size={24} style={{ opacity: 0.3 }} />
        <span>No activity yet today</span>
      </div>
    )
  }

  return (
    <div className="slv-feed-list">
      {!todayOnly && (
        <div className="slv-feed-stale-note">No moves today — showing most recent state changes</div>
      )}
      {sorted.map((iss) => {
        const danger = dangerLevel(iss)
        const avatarColor = slvDevColor(iss.assignee || '')
        return (
          <div key={iss.id} className="slv-anim-item">
            <HoverCard content={buildFeedHoverContent(iss)} delay={250} issueId={iss.idReadable} summary={iss.summary}>
              <div className={`slv-feed-row${danger === 2 ? ' slv-feed-row--crit' : danger === 1 ? ' slv-feed-row--warn' : ''}`}>
                <div className="slv-feed-row-left">
                  <div className="slv-feed-avatar" style={{ background: avatarColor }}>
                    {(iss.assignee || '?').split(' ').filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('')}
                  </div>
                  <div className="slv-feed-row-body">
                    <div className="slv-feed-row-top">
                      <span className="slv-feed-who">{iss.assignee?.split(' ')[0] || 'Unassigned'}</span>
                      <span className="slv-feed-verb">{todayOnly ? 'moved' : 'in'}</span>
                      <span
                        className="spl-ticket-id"
                        style={{ fontSize: 11 }}
                        onClick={(e) => onIdClick(iss.idReadable, e)}
                      >{iss.idReadable}</span>
                      <span className="slv-feed-arrow">→</span>
                      <span className={`spl-stage-chip spl-stage-chip--${iss.stageGroup}`}>{iss.current_state}</span>
                    </div>
                    <div
                      className="slv-feed-title"
                      onClick={(e) => onTitleClick(iss.idReadable, e)}
                    >{iss.summary}</div>
                  </div>
                </div>
                <span className="slv-feed-time">{slvFmtTransitionTime(iss.hours_in_state)}</span>
              </div>
            </HoverCard>
          </div>
        )
      })}
    </div>
  )
})

export const LiveAttention = memo(function LiveAttention({
  allIssues,
  activeSprint,
  onTitleClick,
  onIdClick,
}: {
  allIssues: PulseIssue[]
  activeSprint: YouTrackSprint | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
}) {
  const { ignoreTicket } = useIgnoredBlocked()
  const blocked    = allIssues.filter(i => i.stageGroup === 'blocked').sort((a, b) => b.hours_in_state - a.hours_in_state)
  const stuck      = allIssues.filter(i => i.stageGroup === 'active' && i.hours_in_state >= 16 && !i.isDone).sort((a, b) => b.hours_in_state - a.hours_in_state)
  const hotfixes   = allIssues.filter(i => i.is_hotfix && !i.isDone)
  const daysLeft   = activeSprint ? Math.max(0, Math.round((activeSprint.finish - Date.now()) / 86400000)) : null
  const carryRisk  = daysLeft !== null && daysLeft <= 2
    ? allIssues.filter(i => i.stageGroup === 'active' && i.hours_in_state < 4)
    : []

  const empty = blocked.length === 0 && stuck.length === 0 && hotfixes.length === 0 && carryRisk.length === 0

  if (empty) {
    return (
      <div className="slv-attn-empty">
        <CheckCircle2 size={28} style={{ color: 'var(--color-success)', opacity: 0.6 }} />
        <span>All clear — no blockers, hotfixes, or carry-over risk</span>
      </div>
    )
  }

  return (
    <div className="slv-attn-sections">
      {blocked.length > 0 && (
        <div className="slv-attn-section slv-attn-section--blocked">
          <div className="slv-attn-section-hd">⛔ Blocked now <span className="slv-attn-count">{blocked.length}</span></div>
          <AnimatePresence initial={false}>
            {blocked.map((i) => (
              <AttentionRow
                key={i.id}
                iss={i}
                onTitleClick={onTitleClick}
                onIdClick={onIdClick}
                onPark={ignoreTicket}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
      {hotfixes.length > 0 && (
        <div className="slv-attn-section slv-attn-section--hf">
          <div className="slv-attn-section-hd">🔥 Hotfixes open <span className="slv-attn-count">{hotfixes.length}</span></div>
          {hotfixes.map((i) => <AttentionRow key={i.id} iss={i} onTitleClick={onTitleClick} onIdClick={onIdClick} />)}
        </div>
      )}
      {stuck.length > 0 && (
        <div className="slv-attn-section slv-attn-section--stuck">
          <div className="slv-attn-section-hd">⚠ Stuck 16h+ <span className="slv-attn-count">{stuck.length}</span></div>
          {stuck.map((i) => <AttentionRow key={i.id} iss={i} onTitleClick={onTitleClick} onIdClick={onIdClick} />)}
        </div>
      )}
      {carryRisk.length > 0 && (
        <div className="slv-attn-section slv-attn-section--carry">
          <div className="slv-attn-section-hd">📦 Carry-over risk <span className="slv-attn-count">{carryRisk.length}</span></div>
          <div className="slv-attn-section-sub">Active tickets with &lt;4h spent — sprint ends in {daysLeft}d</div>
          {carryRisk.map((i) => <AttentionRow key={i.id} iss={i} onTitleClick={onTitleClick} onIdClick={onIdClick} />)}
        </div>
      )}
    </div>
  )
})

// ─── ViewLive ─────────────────────────────────────────────────────────────────

export function ViewLive({
  allIssues,
  developerLoad,
  activeSprint,
  summary,
  onTitleClick,
  onIdClick,
}: {
  allIssues: PulseIssue[]
  developerLoad: DeveloperLoad[]
  activeSprint: YouTrackSprint | null
  summary: SprintBoardStatusResponse['summary'] | undefined
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick: (id: string, e: React.MouseEvent) => void
}) {
  const pace = activeSprint && summary
    ? sprintPaceStatus(summary.completion_pct, activeSprint.start, activeSprint.finish)
    : null

  const dayOf = activeSprint
    ? sprintDayOf(activeSprint.start, activeSprint.finish)
    : null

  const blockedCount   = allIssues.filter(i => i.stageGroup === 'blocked').length
  const stuckCount     = allIssues.filter(i => i.stageGroup === 'active' && i.hours_in_state >= 16 && !i.isDone).length
  const doneTodayCount = developerLoad.reduce((s, d) => s + d.done_today, 0)
  const toGoCount      = allIssues.filter(i => !i.isDone && i.stageGroup !== 'blocked').length
  const hotfixCount    = allIssues.filter(i => i.is_hotfix && !i.isDone).length

  return (
    <div className="slv-root">
      {activeSprint && summary && (
        <div className="slv-status-bar slv-anim-section">
          <span className="slv-status-sprint">{activeSprint.name}</span>
          {dayOf && (
            <span className="slv-status-day">Day {dayOf.day} of {dayOf.total}</span>
          )}
          <div className="slv-status-prog-wrap">
            <div className="slv-status-prog-track">
              <motion.div
                className="slv-status-prog-fill"
                initial={{ width: 0 }}
                animate={{ width: `${Math.round(summary.completion_pct)}%` }}
                transition={{ duration: 0.7, ease: 'easeOut' }}
              />
            </div>
            <span className="slv-status-prog-pct">{Math.round(summary.completion_pct)}%</span>
          </div>
          {pace && (
            <motion.span
              className={`slv-pace-badge slv-pace-badge--${pace}`}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.5, duration: 0.2 }}
            >
              {pace === 'on-track' ? '✓ ON TRACK' : pace === 'at-risk' ? '⚠ AT RISK' : '✗ BEHIND'}
            </motion.span>
          )}
        </div>
      )}

      <div className="slv-counters slv-anim-section">
        {([
          { val: blockedCount,   lbl: 'Blocked',    mod: blockedCount > 0 ? ' slv-counter--danger' : '' },
          { val: stuckCount,     lbl: 'Stuck 16h+', mod: stuckCount > 0 ? ' slv-counter--warn' : '' },
          { val: doneTodayCount, lbl: 'Done today',  mod: ' slv-counter--success' },
          { val: toGoCount,      lbl: 'To go',       mod: '' },
        ] as { val: number; lbl: string; mod: string }[]).map(({ val, lbl, mod }) => (
          <div key={lbl} className={`slv-counter${mod}`}>
            <span className="slv-counter-val">{val}</span>
            <span className="slv-counter-lbl">{lbl}</span>
          </div>
        ))}
        {hotfixCount > 0 && (
          <div className="slv-counter slv-counter--danger slv-anim-item">
            <span className="slv-counter-val">{hotfixCount}</span>
            <span className="slv-counter-lbl">Hotfixes</span>
          </div>
        )}
      </div>

      <div className="slv-grid slv-anim-section">
        <div className="slv-col slv-col--devs">
          <div className="slv-col-hd">
            <span className="slv-col-hd-title">Team Status</span>
            <span className="slv-col-hd-sub">{developerLoad.length} developers</span>
          </div>
          <div className="slv-dev-list">
            {developerLoad.length === 0 && (
              <div className="slv-feed-empty" style={{ padding: '24px 0' }}>No developer data</div>
            )}
            {developerLoad.map((dev) => (
              <div key={dev.assignee} className="slv-anim-item">
                <LiveDevCard
                  dev={dev}
                  allIssues={allIssues}
                  onTitleClick={onTitleClick}
                  onIdClick={onIdClick}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="slv-col slv-col--feed">
          <div className="slv-col-hd">
            <span className="slv-col-hd-title">Today's Activity</span>
            <span className="slv-col-hd-sub">tickets moving — newest first</span>
          </div>
          <LiveActivityFeed allIssues={allIssues} onTitleClick={onTitleClick} onIdClick={onIdClick} />
        </div>

        <div className="slv-col slv-col--attn">
          <div className="slv-col-hd">
            <span className="slv-col-hd-title">Needs Attention</span>
            <span className="slv-col-hd-sub">blockers · hotfixes · risks</span>
          </div>
          <LiveAttention
            allIssues={allIssues}
            activeSprint={activeSprint}
            onTitleClick={onTitleClick}
            onIdClick={onIdClick}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Live skeleton ────────────────────────────────────────────────────────────

export function SkLive() {
  return (
    <div className="slv-root">
      <div className="slv-status-bar" style={{ gap: 10 }}>
        <Sk w={140} h={14} r={5} />
        <Sk w={72} h={22} r={6} />
        <div className="slv-status-prog-wrap">
          <div className="slv-status-prog-track"><Sk w="100%" h={6} r={3} /></div>
          <Sk w={30} h={12} r={4} />
        </div>
        <Sk w={88} h={24} r={6} />
      </div>

      <div className="slv-counters">
        {[80, 88, 80, 72, 80].map((w, i) => (
          <div key={i} className="slv-counter" style={{ gap: 6 }}>
            <Sk w={30} h={22} r={4} />
            <Sk w={w - 20} h={10} r={3} />
          </div>
        ))}
      </div>

      <div className="slv-grid">
        <div className="slv-col slv-col--devs">
          <div className="slv-col-hd"><Sk w={90} h={12} r={4} /><Sk w={60} h={10} r={4} /></div>
          <div className="slv-dev-list">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="slv-dev-card" style={{ gap: 8 }}>
                <div className="slv-dev-card-header">
                  <Sk w={26} h={26} r="50%" />
                  <Sk w={`${SK_W[i % 6]}%`} h={12} r={4} />
                  <Sk w={56} h={18} r={4} />
                </div>
                <div style={{ display: 'flex', gap: 6, paddingLeft: 2 }}>
                  <Sk w={28} h={10} r={3} />
                  <Sk w={`${SK_W[(i + 2) % 6]}%`} h={10} r={3} />
                </div>
                <div className="slv-dev-stats">
                  <Sk w={70} h={10} r={3} />
                  <Sk w={52} h={10} r={3} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="slv-col slv-col--feed">
          <div className="slv-col-hd"><Sk w={110} h={12} r={4} /><Sk w={80} h={10} r={4} /></div>
          <div className="slv-feed-list">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="slv-feed-row" style={{ alignItems: 'center' }}>
                <div className="slv-feed-row-left">
                  <Sk w={22} h={22} r="50%" />
                  <div className="slv-feed-row-body" style={{ gap: 6 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Sk w={44} h={10} r={3} />
                      <Sk w={28} h={10} r={3} />
                      <Sk w={52} h={18} r={4} />
                      <Sk w={16} h={10} r={2} />
                      <Sk w={80} h={18} r={4} />
                    </div>
                    <Sk w={`${SK_W[(i + 1) % 6]}%`} h={10} r={3} />
                  </div>
                </div>
                <Sk w={42} h={10} r={3} />
              </div>
            ))}
          </div>
        </div>

        <div className="slv-col slv-col--attn">
          <div className="slv-col-hd"><Sk w={110} h={12} r={4} /><Sk w={70} h={10} r={4} /></div>
          <div className="slv-attn-sections">
            <div className="slv-attn-section">
              <div className="slv-attn-section-hd"><Sk w={90} h={12} r={4} /></div>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="slv-attn-row">
                  <Sk w={60} h={18} r={4} />
                  <Sk w={`${SK_W[(i + 3) % 6]}%`} h={10} r={3} />
                  <Sk w={32} h={10} r={3} />
                </div>
              ))}
            </div>
            <div className="slv-attn-section">
              <div className="slv-attn-section-hd"><Sk w={80} h={12} r={4} /></div>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="slv-attn-row">
                  <Sk w={60} h={18} r={4} />
                  <Sk w={`${SK_W[i % 6]}%`} h={10} r={3} />
                  <Sk w={32} h={10} r={3} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
