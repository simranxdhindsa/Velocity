// DailyOpsViews.tsx — 6 design views for Daily Ops tab
// Adapted from claude.ai/design — ops-v1 through ops-v6
import React from 'react'
import { motion } from 'framer-motion'
import type { SprintBoardIssue } from '../services/api'
import HoverCard, { HCRow, HCDivider, HCBadge } from '../components/HoverCard'

// ── Thresholds ──────────────────────────────────────────────────────────────
const WATCH  = 8   // hours — muted blue
const WARN   = 16  // hours — amber
const DANGER = 48  // hours — red

// ── Color palette ───────────────────────────────────────────────────────────
const C = {
  done:    '#4ade80',
  active:  '#60a5fa',
  blocked: '#f87171',
  overdue: '#fbbf24',
  accent:  '#6366f1',
} as const

// ── Inline style constants (matching existing CSS vars) ──────────────────────
const GLASS  = 'rgba(var(--overlay-rgb),0.05)'
const BORDER = 'rgba(var(--overlay-rgb),0.09)'

// ── Shared context (ytBaseUrl + detail panel opener) ────────────────────────
export interface OpsCtx {
  ytBaseUrl: string
  onOpenDetail: (idReadable: string) => void
}

// ── DevStat mirror (no circular dep with DailyOpsTab) ───────────────────────
export interface DevStatLike {
  name: string
  avatarUrl: string
  doneIssues: SprintBoardIssue[]
  doneTodayIssues: SprintBoardIssue[]
  activeIssues: SprintBoardIssue[]
  blockedIssues: SprintBoardIssue[]
  queuedIssues: SprintBoardIssue[]
  overdueIssues: SprintBoardIssue[]
  bouncedIssues: SprintBoardIssue[]
  totalActiveHours: number
  hotfixCount: number
}

// ── Internal issue shape ─────────────────────────────────────────────────────
interface OpsIssue {
  id: string
  summary: string
  hoursInState: number
  isHotfix: boolean
  isRegression: boolean
  since?: string
  timestamp?: string
  hoursSpent?: number
}
interface OpsDev {
  name: string
  initials: string
  color: string
  totalActiveHours: number
  hotfixCount: number
  doneCount: number
  doneTodayIssues: OpsIssue[]
  activeIssues: OpsIssue[]
  blockedIssues: OpsIssue[]
  queuedIssues: OpsIssue[]
}
interface FlatTicket extends OpsIssue {
  dev: OpsDev
  state: 'blocked' | 'overdue' | 'active' | 'done'
  hours: number
}

// ── Adapters ─────────────────────────────────────────────────────────────────
const DEV_COLORS = ['#6366f1','#8b5cf6','#06b6d4','#ec4899','#f59e0b','#10b981']
function devColor(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff
  return DEV_COLORS[h % DEV_COLORS.length]
}
function devInitials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('')
}
function fmtSince(sinceDate: string): string {
  if (!sinceDate) return 'earlier'
  const d = new Date(sinceDate)
  if (isNaN(d.getTime())) return 'earlier'
  const diffH = (Date.now() - d.getTime()) / 3_600_000
  if (diffH > 30) return 'yesterday'
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
function fmtTimestamp(sinceDate: string): string {
  if (!sinceDate) return ''
  const d = new Date(sinceDate)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}
function adaptDev(dev: DevStatLike): OpsDev {
  return {
    name: dev.name,
    initials: devInitials(dev.name),
    color: devColor(dev.name),
    totalActiveHours: dev.totalActiveHours,
    hotfixCount: dev.hotfixCount,
    doneCount: dev.doneIssues.length,
    doneTodayIssues: dev.doneTodayIssues.map(i => ({
      id: i.idReadable, summary: i.summary, hoursInState: 0,
      isHotfix: i.is_hotfix ?? false, isRegression: false,
      timestamp: fmtTimestamp(i.since_date), hoursSpent: i.total_active_hours ?? 0,
    })),
    activeIssues: dev.activeIssues.map(i => ({
      id: i.idReadable, summary: i.summary, hoursInState: i.hours_in_state ?? 0,
      isHotfix: i.is_hotfix ?? false, isRegression: false,
    })),
    blockedIssues: dev.blockedIssues.map(i => ({
      id: i.idReadable, summary: i.summary, hoursInState: i.hours_in_state ?? 0,
      isHotfix: i.is_hotfix ?? false, isRegression: false,
      since: fmtSince(i.since_date),
    })),
    queuedIssues: dev.queuedIssues.map(i => ({
      id: i.idReadable, summary: i.summary, hoursInState: 0,
      isHotfix: false, isRegression: false,
    })),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function opsOverdue(dev: OpsDev) { return dev.activeIssues.filter(i => i.hoursInState >= WARN) }
function opsDanger(dev: OpsDev)  { return dev.activeIssues.filter(i => i.hoursInState >= DANGER) }
function opsTrackedCount(dev: OpsDev) {
  return dev.doneCount + dev.activeIssues.length + dev.blockedIssues.length + dev.queuedIssues.length
}
function opsDonePct(dev: OpsDev) {
  const t = opsTrackedCount(dev)
  return t ? Math.round((dev.doneCount / t) * 100) : 0
}
function opsTopStuck(dev: OpsDev): OpsIssue | null {
  return dev.activeIssues.reduce<OpsIssue | null>((m, i) => (!m || i.hoursInState > m.hoursInState) ? i : m, null)
}
function opsStatus(dev: OpsDev): { word: string; c: string } {
  if (dev.blockedIssues.length > 0) return { word: 'CRITICAL', c: C.blocked }
  if (opsDanger(dev).length)        return { word: 'AT RISK',  c: C.blocked }
  if (opsOverdue(dev).length)       return { word: 'AT RISK',  c: C.overdue }
  if (dev.doneTodayIssues.length >= 3) return { word: 'SHIPPING', c: C.done }
  if (dev.doneTodayIssues.length > 0)  return { word: 'ON TRACK', c: C.done }
  return { word: 'ON TRACK', c: C.active }
}
function opsUrgencyRank(dev: OpsDev) {
  return dev.blockedIssues.length * 1000 + opsDanger(dev).length * 300 + opsOverdue(dev).length * 80 + dev.activeIssues.length
}
function opsFmtHours(h: number): string {
  if (!h) return '0h'
  if (h >= 24) { const d = Math.floor(h / 24); const r = Math.round(h - d * 24); return r ? `${d}d ${r}h` : `${d}d` }
  const hh = Math.floor(h); const mm = Math.round((h - hh) * 60)
  if (hh === 0) return `${mm}m`
  return mm ? `${hh}h ${mm}m` : `${hh}h`
}
function opsStuckColor(hours: number): string {
  if (hours >= DANGER) return C.blocked
  if (hours >= WARN)   return C.overdue
  return C.active
}
function opsFlattenTickets(devs: OpsDev[]): FlatTicket[] {
  const out: FlatTicket[] = []
  devs.forEach(dev => {
    dev.blockedIssues.forEach(b => out.push({ ...b, dev, state: 'blocked', hours: b.hoursInState }))
    dev.activeIssues.forEach(a => out.push({ ...a, dev, state: a.hoursInState >= WARN ? 'overdue' : 'active', hours: a.hoursInState }))
    dev.doneTodayIssues.forEach(d => out.push({ ...d, dev, state: 'done', hours: d.hoursSpent ?? 0 }))
  })
  return out
}

// ── Atoms ─────────────────────────────────────────────────────────────────────
function OpsAvatar({ dev, size = 36, glow }: { dev: OpsDev; size?: number; glow?: string | null }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `linear-gradient(135deg, ${dev.color}, ${dev.color}99)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em',
      boxShadow: glow ? `0 0 14px ${glow}` : 'none',
    }}>{dev.initials}</div>
  )
}

function OpsHotfixBadge({ count = 1 }: { count?: number }) {
  return (
    <span title={`${count} hotfix`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 13,
        filter: 'drop-shadow(0 0 5px rgba(239,68,68,0.7))' }}>
      🔥{count > 1 ? <b style={{ fontSize: 10, color: '#ef4444' }}>{count}</b> : null}
    </span>
  )
}

function opsChipColor(issue: OpsIssue): string {
  if (issue.isHotfix) return C.blocked
  if (issue.since != null) return C.blocked
  if (issue.hoursInState >= DANGER) return C.blocked
  if (issue.hoursInState >= WARN)   return C.overdue
  return C.active
}
function opsChipTime(issue: OpsIssue): string {
  if (issue.since != null) return /yesterday|ago/i.test(issue.since) ? '1d+' : `since ${issue.since.replace(/\s*(AM|PM)/i, '')}`
  if (issue.hoursInState) return opsFmtHours(issue.hoursInState)
  return ''
}
function OpsTicketChip({ issue, animateGlow, ctx, noHover, isBlocked }: { issue: OpsIssue; animateGlow?: boolean; ctx?: OpsCtx; noHover?: boolean; isBlocked?: boolean }) {
  const c = opsChipColor(issue)
  const danger = issue.isHotfix || issue.since != null || issue.hoursInState >= DANGER

  const handleIdClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (ctx?.ytBaseUrl) window.open(`${ctx.ytBaseUrl}/issue/${issue.id}`, '_blank', 'noopener,noreferrer')
  }
  const handleSummaryClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    ctx?.onOpenDetail(issue.id)
  }

  const chip = (
    <motion.span
      animate={(danger && animateGlow) ? { boxShadow: [`0 0 0px ${c}00`, `0 0 10px ${c}77`, `0 0 0px ${c}00`] } : {}}
      transition={(danger && animateGlow) ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : {}}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
        borderRadius: 999, background: `${c}1a`, border: `1px solid ${c}55`,
        fontSize: 11, fontWeight: 700, color: c, whiteSpace: 'nowrap', maxWidth: '100%' }}>
      <span
        onClick={ctx ? handleIdClick : undefined}
        style={{ fontFamily: 'monospace', fontWeight: 700, cursor: ctx?.ytBaseUrl ? 'pointer' : 'default',
          textDecoration: ctx?.ytBaseUrl ? 'underline' : 'none', textDecorationColor: `${c}66` }}>
        {issue.id}
      </span>
      {issue.isHotfix && <span style={{ fontSize: 9 }}>🔥</span>}
      {issue.isRegression && !issue.isHotfix && <span style={{ fontSize: 9 }}>↩</span>}
      <span
        onClick={ctx ? handleSummaryClick : undefined}
        style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis',
          cursor: ctx ? 'pointer' : 'default' }}>
        {opsChipTime(issue)}
      </span>
    </motion.span>
  )

  if (!ctx || noHover) return chip
  return (
    <HoverCard content={<OpsIssueHoverContent issue={issue} />} maxWidth={260} issueId={issue.id} isBlocked={isBlocked} summary={issue.summary}>
      {chip}
    </HoverCard>
  )
}

function OpsHead({ title, tagline }: { title: string; tagline: string }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', margin: 0 }}>{title}</h2>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, marginBottom: 0 }}>{tagline}</p>
    </div>
  )
}

const OPS_STATE_WORD: Record<string, { word: string; c: string }> = {
  blocked: { word: 'BLOCKED',     c: C.blocked },
  overdue: { word: 'OVERDUE',     c: C.overdue },
  active:  { word: 'IN PROGRESS', c: C.active  },
  done:    { word: 'DONE',        c: C.done    },
}

// ── Hover content ─────────────────────────────────────────────────────────────
function OpsIssueHoverContent({ issue }: { issue: OpsIssue }) {
  return (
    <div>
      <div className="hc-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {issue.id}
        {issue.isHotfix && <HCBadge label="Hotfix" variant="warn" />}
        {issue.isRegression && !issue.isHotfix && <HCBadge label="Regression" variant="warn" />}
      </div>
      <div className="hc-subtitle">{issue.summary}</div>
      <HCDivider />
      {issue.hoursInState > 0 && (
        <HCRow label="In state" value={opsFmtHours(issue.hoursInState)}
          accent={issue.hoursInState >= DANGER ? 'danger' : issue.hoursInState >= WARN ? 'warn' : undefined} />
      )}
      {issue.since && <HCRow label="Blocked since" value={issue.since} accent="danger" />}
      {issue.timestamp && <HCRow label="Completed at" value={issue.timestamp} />}
      {(issue.hoursSpent ?? 0) > 0 && <HCRow label="Dev time" value={opsFmtHours(issue.hoursSpent!)} />}
    </div>
  )
}

function OpsDevHoverContent({ dev }: { dev: OpsDev }) {
  return (
    <div>
      <div className="hc-title">{dev.name}</div>
      {dev.blockedIssues.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.blocked, letterSpacing: '0.05em', marginTop: 8, marginBottom: 4 }}>
            BLOCKED · {dev.blockedIssues.length}
          </div>
          {dev.blockedIssues.map(i => (
            <HCRow key={i.id} label={i.id} value={i.since ? `since ${i.since}` : 'blocked'} accent="danger" />
          ))}
          <HCDivider />
        </>
      )}
      {dev.activeIssues.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.active, letterSpacing: '0.05em', marginTop: 8, marginBottom: 4 }}>
            IN PROGRESS · {dev.activeIssues.length}
          </div>
          {dev.activeIssues.map(i => (
            <HCRow key={i.id} label={i.id}
              value={i.hoursInState > 0 ? opsFmtHours(i.hoursInState) : '—'}
              accent={i.hoursInState >= DANGER ? 'danger' : i.hoursInState >= WARN ? 'warn' : undefined} />
          ))}
          <HCDivider />
        </>
      )}
      {dev.doneTodayIssues.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.done, letterSpacing: '0.05em', marginTop: 8, marginBottom: 4 }}>
            DONE TODAY · {dev.doneTodayIssues.length}
          </div>
          {dev.doneTodayIssues.map(i => (
            <HCRow key={i.id} label={i.id} value={i.timestamp ?? '✓'} />
          ))}
          <HCDivider />
        </>
      )}
      {dev.queuedIssues.length > 0 && (
        <HCRow label="To Do" value={`${dev.queuedIssues.length} tickets queued`} />
      )}
      {dev.totalActiveHours > 0 && (
        <HCRow label="Total dev time" value={opsFmtHours(dev.totalActiveHours)} />
      )}
    </div>
  )
}

// ── View 1: Health Rings ──────────────────────────────────────────────────────
function OpsRingCard({ dev, index, ctx }: { dev: OpsDev; index: number; ctx?: OpsCtx }) {
  const size = 176, stroke = 13, r = (size - stroke) / 2 - 8, cx = size / 2, cy = size / 2
  const circ = 2 * Math.PI * r
  const status    = opsStatus(dev)
  const donePct   = opsDonePct(dev)
  const overdue   = opsOverdue(dev)
  const danger    = opsDanger(dev)
  const hasBlock  = dev.blockedIssues.length > 0
  const ringColor = hasBlock ? C.blocked : overdue.length ? C.overdue : C.done

  const gapCount = dev.blockedIssues.length
  const dashArray = (() => {
    if (!gapCount) return undefined
    const visible = circ * (donePct / 100)
    const gap = 9, seg = Math.max(6, (visible - gap * gapCount) / (gapCount + 1))
    const parts: number[] = []
    for (let i = 0; i <= gapCount; i++) { parts.push(seg, gap) }
    return parts.join(' ')
  })()

  // Dots include 8h+ (watch) items too — overdue already has 16h+, add watch separately
  const watchIssues = dev.activeIssues.filter(a => a.hoursInState >= WATCH && a.hoursInState < WARN)
  const allDotIssues = [...overdue, ...watchIssues]

  const dots = allDotIssues.map((o, i) => {
    const frac = 0.08 + i * (0.84 / Math.max(allDotIssues.length, 1))
    const ang  = -90 + frac * 360
    const rad  = (ang * Math.PI) / 180
    const svgX = cx + Math.cos(rad) * r
    const svgY = cy + Math.sin(rad) * r
    // Screen coords after CSS rotate(-90deg) around center: sx = svgY, sy = size - svgX
    return {
      x: svgX, y: svgY,
      sx: svgY, sy: size - svgX,
      danger:  o.hoursInState >= DANGER,
      warn:    o.hoursInState >= WARN,
      issue:   o,
    }
  })

  const blockedIds = new Set(dev.blockedIssues.map(i => i.id))
  const urgent = [
    ...dev.blockedIssues,
    ...dev.activeIssues.filter(a => a.hoursInState >= WARN),
    ...dev.activeIssues.filter(a => a.hoursInState < WARN),
  ].slice(0, 3)

  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0, transition: { type: 'spring', bounce: 0.05, duration: 0.8 } } }}
      animate={hasBlock
        ? { boxShadow: ['0 0 0px #ef444400', '0 0 18px #ef444466', '0 0 0px #ef444400'] }
        : undefined}
      transition={hasBlock ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : undefined}
      style={{ background: GLASS, borderRadius: 16, padding: 18, backdropFilter: 'blur(14px)',
        border: `1px solid ${hasBlock ? C.blocked + '66' : overdue.length ? C.overdue + '55' : BORDER}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'default' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
        <OpsAvatar dev={dev} size={34} glow={hasBlock ? C.blocked + '66' : null} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dev.name}</div>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', color: status.c }}>{status.word}</div>
        </div>
        {dev.hotfixCount > 0 && <OpsHotfixBadge count={dev.hotfixCount} />}
      </div>

      <div style={{ position: 'relative', width: size, height: size, marginTop: 18 }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={cx} cy={cy} r={r} fill="none" style={{ stroke: 'rgba(var(--overlay-rgb),0.07)' }} strokeWidth={stroke} />
          <motion.circle cx={cx} cy={cy} r={r} fill="none" stroke={ringColor} strokeWidth={stroke}
            strokeLinecap={gapCount ? 'butt' : 'round'}
            strokeDasharray={dashArray || circ}
            initial={{ strokeDashoffset: circ }}
            animate={{ strokeDashoffset: gapCount ? 0 : circ - (circ * donePct) / 100,
              opacity: hasBlock ? [0.55, 1, 0.55] : 1 }}
            transition={{ strokeDashoffset: { type: 'spring', bounce: 0.05, duration: 1.2, delay: 0.3 + index * 0.06 },
              opacity: hasBlock ? { duration: 2.5, repeat: Infinity, ease: 'easeInOut' } : {} }}
            style={{ filter: `drop-shadow(0 0 6px ${ringColor}77)` }} />
          {/* Stuck / watch ticket dots on the ring arc */}
          {dots.map((d, i) => {
            const dotR  = d.danger ? 6 : d.warn ? 5 : 4
            const fill  = d.danger ? '#ef4444' : d.warn ? C.overdue : 'rgba(148,163,184,0.6)'
            const glow  = d.danger ? 'drop-shadow(0 0 5px #ef4444)' : d.warn ? `drop-shadow(0 0 4px ${C.overdue})` : 'none'
            return (
              <motion.circle key={'od' + i} cx={d.x} cy={d.y} r={dotR}
                fill={fill} stroke="var(--bg-base,#0d0d1a)" strokeWidth={2}
                initial={{ scale: 0 }} animate={{ scale: 1 }}
                transition={{ delay: 0.9 + i * 0.1, type: 'spring', bounce: 0.4 }}
                style={{ transformOrigin: `${d.x}px ${d.y}px`, filter: glow }} />
            )
          })}
        </svg>

        {/* Invisible click/hover targets aligned to each dot's screen position */}
        {dots.map((d, i) => {
          const hitSize = 22
          const hoverContent = (
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 700, color: d.danger ? '#ef4444' : d.warn ? C.overdue : 'var(--text-muted)', marginBottom: 4 }}>
                {d.danger ? '🔴 DANGER — 48h+' : d.warn ? '🟡 STUCK — 16h+' : '◎ WATCH — 8h+'}
              </div>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>{d.issue.id}</div>
              <div style={{ color: 'var(--text-secondary)', marginBottom: 4, fontSize: 11 }}>{d.issue.summary}</div>
              <div style={{ color: 'var(--text-muted)' }}>
                In this state: <strong style={{ color: d.danger ? '#ef4444' : d.warn ? C.overdue : 'var(--text-primary)' }}>
                  {opsFmtHours(d.issue.hoursInState)}
                </strong>
              </div>
              {d.issue.hoursSpent && d.issue.hoursSpent > 0 && (
                <div style={{ color: 'var(--text-muted)' }}>
                  Total dev time: <strong style={{ color: 'var(--text-primary)' }}>{opsFmtHours(d.issue.hoursSpent)}</strong>
                </div>
              )}
              {ctx && (
                <div style={{ marginTop: 6, fontSize: 10, color: 'var(--color-primary)' }}>Click to open ticket ↗</div>
              )}
            </div>
          )
          return (
            <HoverCard key={'dot-hit-' + i} content={hoverContent} maxWidth={220} delay={180} issueId={d.issue.id} summary={d.issue.summary}>
              <div
                onClick={(e) => { e.stopPropagation(); ctx?.onOpenDetail(d.issue.id) }}
                style={{
                  position: 'absolute',
                  left: d.sx - hitSize / 2,
                  top:  d.sy - hitSize / 2,
                  width: hitSize, height: hitSize,
                  borderRadius: '50%',
                  cursor: ctx ? 'pointer' : 'default',
                  zIndex: 10,
                }}
              />
            </HoverCard>
          )
        })}

        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 5 }}>
          {hasBlock ? (
            <>
              <motion.div animate={{ opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
                style={{ fontSize: 38, lineHeight: 1, color: C.blocked, fontWeight: 700,
                  filter: 'drop-shadow(0 0 12px #ef4444)' }}>⊘</motion.div>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.blocked, letterSpacing: '0.05em' }}>BLOCKED</span>
            </>
          ) : danger.length ? (
            <>
              <div style={{ fontSize: 28 }}>⚠️</div>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.overdue, letterSpacing: '0.05em' }}>OVERDUE</span>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 3 }}>
                {Array.from({ length: 7 }).map((_, i) => {
                  const filled = i < Math.round((donePct / 100) * 7)
                  return (
                    <motion.span key={i} initial={{ scaleY: 0 }} animate={{ scaleY: 1 }}
                      transition={{ delay: 0.6 + i * 0.05, type: 'spring', bounce: 0.3 }}
                      style={{ width: 7, height: 22, borderRadius: 2, transformOrigin: 'bottom',
                        background: filled ? C.done : 'rgba(var(--overlay-rgb),0.10)' }} />
                  )
                })}
              </div>
              <motion.span
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.0 }}
                style={{ fontSize: 22, fontWeight: 800, color: C.done, lineHeight: 1, marginTop: 2 }}
              >
                {Math.round(donePct)}%
              </motion.span>
              <span style={{ fontSize: 9, fontWeight: 700, color: C.done, letterSpacing: '0.06em', marginTop: 1 }}>on track</span>
            </>
          )}
        </div>
      </div>

      {/* Stats strip — what the ring represents */}
      <div style={{ display: 'flex', gap: 10, marginTop: 10, width: '100%', justifyContent: 'center', flexWrap: 'wrap' }}>
        {hasBlock && (
          <span style={{ fontSize: 10, fontWeight: 700, color: C.blocked }}>⛔ {dev.blockedIssues.length} blocked</span>
        )}
        {overdue.length > 0 && (
          <span style={{ fontSize: 10, fontWeight: 700, color: C.overdue }}>⚠ {overdue.length} stuck</span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>▶ {dev.activeIssues.length} active</span>
        <span style={{ fontSize: 10, color: C.done }}>✓ {dev.doneCount} done</span>
      </div>

      <div style={{ width: '100%', height: 1, background: BORDER, marginTop: 12, marginBottom: 10 }} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, width: '100%', justifyContent: 'center' }}>
        {urgent.length === 0
          ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>nothing urgent · hover chips for details</span>
          : urgent.map(t => <OpsTicketChip key={t.id} issue={t} animateGlow ctx={ctx} isBlocked={blockedIds.has(t.id)} />)}
      </div>
    </motion.div>
  )
}

const RING_LEGEND: { color: string; fill?: boolean; label: string; sub: string }[] = [
  { color: '#4ade80', fill: true,  label: 'Ring fill',      sub: '% of sprint done' },
  { color: '#4ade80', fill: true,  label: 'Green ring',     sub: 'on track' },
  { color: '#fbbf24', fill: true,  label: 'Amber ring',     sub: 'ticket stuck 16h+' },
  { color: '#ef4444', fill: true,  label: 'Red ring',       sub: 'developer blocked' },
  { color: '#ef4444', fill: true,  label: '● Red dot',      sub: 'stuck 48h+ (danger)' },
  { color: '#fbbf24', fill: true,  label: '● Amber dot',    sub: 'stuck 16h+ (warn)' },
  { color: 'rgba(148,163,184,0.7)', fill: false, label: '○ Grey dot', sub: 'idle 8h+ (watch)' },
  { color: 'rgba(var(--overlay-rgb),0.25)', fill: true, label: 'Ring gap',   sub: 'blocked ticket (one gap each)' },
]

export function OpsViewRings({ devStats, ctx }: { devStats: DevStatLike[]; ctx?: OpsCtx }) {
  const devs = devStats.map(adaptDev)
  return (
    <div>
      <OpsHead title="Health Rings" tagline="Hover any dot on the ring to see the stuck ticket. Click to open it." />

      {/* Legend strip */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 20,
        padding: '10px 14px', borderRadius: 8,
        background: 'rgba(var(--overlay-rgb),0.03)', border: '1px solid rgba(var(--overlay-rgb),0.08)',
      }}>
        {RING_LEGEND.map(({ color, fill, label, sub }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
              background: fill ? color : 'transparent',
              border: fill ? 'none' : `2px solid ${color}`,
            }} />
            <span style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>{label}</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>= {sub}</span>
          </div>
        ))}
      </div>

      <motion.div className="ops-grid-rings" variants={{ show: { transition: { staggerChildren: 0.08 } } }} initial="hidden" animate="show">
        {devs.map((dev, i) => <OpsRingCard key={dev.name} dev={dev} index={i} ctx={ctx} />)}
      </motion.div>
    </div>
  )
}

// ── View 2: Mission Control ───────────────────────────────────────────────────
function OpsDonut({ dev, index, size = 92 }: { dev: OpsDev; index: number; size?: number }) {
  const stroke = 11, r = (size - stroke) / 2, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r
  const tracked = opsTrackedCount(dev) || 1
  const segs = [
    { n: dev.doneCount,              c: C.done },
    { n: dev.activeIssues.length,    c: C.active },
    { n: dev.blockedIssues.length,   c: C.blocked },
    { n: dev.queuedIssues.length,    c: 'rgba(var(--overlay-rgb),0.12)' },
  ]
  let acc = 0
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" style={{ stroke: 'rgba(var(--overlay-rgb),0.06)' }} strokeWidth={stroke} />
      {segs.map((s, i) => {
        if (!s.n) return null
        const len = circ * (s.n / tracked)
        const node = (
          <motion.circle key={i} cx={cx} cy={cy} r={r} fill="none" style={{ stroke: s.c }} strokeWidth={stroke}
            strokeDasharray={`${len} ${circ - len}`}
            initial={{ strokeDashoffset: circ }} animate={{ strokeDashoffset: -acc }}
            transition={{ type: 'spring', bounce: 0.05, duration: 1, delay: 0.3 + index * 0.1 + i * 0.08 }} />
        )
        acc += len
        return node
      })}
    </svg>
  )
}

function OpsActivityStrip({ dev }: { dev: OpsDev }) {
  const events: { t: string; c: string; kind: string }[] = []
  dev.doneTodayIssues.forEach(d => events.push({ t: d.timestamp ?? '', c: C.done, kind: 'done' }))
  dev.blockedIssues.forEach(b => events.push({ t: /yesterday|ago/i.test(b.since ?? '') ? '09:00' : (b.since ?? '09:00'), c: C.blocked, kind: 'blocked' }))
  dev.activeIssues.slice(0, 3).forEach((_, i) => events.push({ t: ['10:30', '12:10', '14:00'][i], c: C.active, kind: 'active' }))
  events.sort((a, b) => {
    const toH = (s: string) => { const m = s.match(/(\d{1,2}):(\d{2})/); return m ? +m[1] + +m[2] / 60 : 9 }
    return toH(a.t) - toH(b.t)
  })
  const shown = events.slice(0, 6)
  return (
    <div style={{ position: 'relative', paddingTop: 13, marginTop: 4 }}>
      <div style={{ position: 'absolute', left: 4, right: 4, top: 19, height: 1.5, background: 'rgba(var(--overlay-rgb),0.08)' }} />
      <div style={{ display: 'flex', justifyContent: shown.length > 1 ? 'space-between' : 'flex-start',
        gap: shown.length > 1 ? 0 : 14, position: 'relative' }}>
        {shown.length === 0 && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>no transitions today</span>}
        {shown.map((e, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 8.5, fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{e.t}</span>
            <motion.span animate={e.kind === 'blocked' ? { opacity: [0.55, 1, 0.55] } : {}}
              transition={e.kind === 'blocked' ? { duration: 2.5, repeat: Infinity } : {}}
              style={{ width: 11, height: 11, borderRadius: '50%', background: e.c,
                border: '2px solid var(--bg-base,#0d0d1a)',
                boxShadow: e.kind === 'blocked' ? `0 0 7px ${e.c}` : 'none' }} />
          </div>
        ))}
      </div>
    </div>
  )
}

function OpsMissionCard({ dev, index, ctx }: { dev: OpsDev; index: number; ctx?: OpsCtx }) {
  const hasBlock    = dev.blockedIssues.length > 0
  const danger      = opsDanger(dev)
  const shippingGlow = !hasBlock && dev.doneTodayIssues.length >= 3

  let zone: { icon: string; word: string; c: string; sub: string; breathe?: boolean; big?: boolean }
  if (hasBlock) {
    const b = dev.blockedIssues[0]
    const sinceTxt = /yesterday|ago/i.test(b.since ?? '') ? 'since yesterday' : `since ${b.since ?? ''}`
    zone = { icon: '⊘', word: 'BLOCKED', c: C.blocked, sub: sinceTxt, breathe: true }
  } else if (danger.length) {
    const o = opsTopStuck(dev)
    zone = { icon: '⚠️', word: 'STUCK', c: C.overdue, sub: `${opsFmtHours(o?.hoursInState ?? 0)} in progress` }
  } else if (dev.doneTodayIssues.length > 0) {
    zone = { icon: '↑', word: 'SHIPPING', c: C.done, sub: `${dev.doneTodayIssues.length} done today`, big: true }
  } else {
    zone = { icon: '●', word: 'IN PROGRESS', c: C.active, sub: `${dev.activeIssues.length} active`, big: true }
  }

  const borderGlow = hasBlock ? C.blocked : danger.length ? C.overdue : shippingGlow ? C.done : C.accent

  return (
    <HoverCard content={<OpsDevHoverContent dev={dev} />} maxWidth={290}>
    <motion.div
      variants={{ hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0, transition: { type: 'spring', bounce: 0.05, duration: 0.8 } } }}
      animate={hasBlock
        ? { boxShadow: ['0 0 0px #ef444400', '0 0 20px #ef444466', '0 0 0px #ef444400'] }
        : danger.length
          ? { boxShadow: ['0 0 0px #fbbf2400', '0 0 12px #fbbf2455', '0 0 0px #fbbf2400'] }
          : undefined}
      transition={hasBlock ? { duration: 2, repeat: Infinity, ease: 'easeInOut' }
        : danger.length ? { duration: 3, repeat: Infinity, ease: 'easeInOut' } : undefined}
      style={{ background: GLASS, borderRadius: 16, padding: 16, backdropFilter: 'blur(14px)',
        border: borderGlow === C.accent ? '1px solid rgba(var(--color-primary-rgb),0.33)' : `1px solid ${borderGlow}55`, cursor: 'default',
        boxShadow: shippingGlow ? `0 0 16px ${C.done}22` : borderGlow === C.accent ? '0 0 14px rgba(var(--color-primary-rgb),0.08)' : `0 0 14px ${borderGlow}14` }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <OpsAvatar dev={dev} size={32} glow={hasBlock ? C.blocked + '55' : null} />
        <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dev.name}</span>
        {dev.hotfixCount > 0 && <OpsHotfixBadge count={dev.hotfixCount} />}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
        <motion.div animate={zone.breathe ? { opacity: [0.7, 1, 0.7] } : {}}
          transition={zone.breathe ? { duration: 2.5, repeat: Infinity, ease: 'easeInOut' } : {}}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '6px 0' }}>
          <div style={{ fontSize: zone.big ? 30 : 34, lineHeight: 1, color: zone.c, fontWeight: 800,
            filter: `drop-shadow(0 0 10px ${zone.c}66)` }}>{zone.icon}</div>
          <span style={{ fontSize: 18, fontWeight: 800, color: zone.c, letterSpacing: '0.02em' }}>{zone.word}</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>{zone.sub}</span>
        </motion.div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <OpsDonut dev={dev} index={index} />
          {/* Donut legend */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9, fontWeight: 600 }}>
            {dev.doneCount > 0 && <span style={{ color: C.done }}>✓ {dev.doneCount} done</span>}
            {dev.activeIssues.length > 0 && <span style={{ color: C.active }}>▶ {dev.activeIssues.length} active</span>}
            {dev.blockedIssues.length > 0 && <span style={{ color: C.blocked }}>⛔ {dev.blockedIssues.length} blocked</span>}
            {dev.queuedIssues.length > 0 && <span style={{ color: 'var(--text-muted)' }}>○ {dev.queuedIssues.length} queued</span>}
          </div>
        </div>
      </div>

      <OpsActivityStrip dev={dev} />
    </motion.div>
    </HoverCard>
  )
}

export function OpsViewMission({ devStats, ctx }: { devStats: DevStatLike[]; ctx?: OpsCtx }) {
  const devs = devStats.map(adaptDev)
  return (
    <div>
      <OpsHead title="Mission Control" tagline="Status word = worst issue · donut = done/active/blocked/queued breakdown · hover any card for full ticket list." />
      <motion.div className="ops-grid-mission" variants={{ show: { transition: { staggerChildren: 0.08 } } }} initial="hidden" animate="show">
        {devs.map((dev, i) => <OpsMissionCard key={dev.name} dev={dev} index={i} ctx={ctx} />)}
      </motion.div>
    </div>
  )
}

// ── View 3: Stuck Detector ────────────────────────────────────────────────────
function OpsStuckRow({ t, index, maxHours, ctx }: { t: FlatTicket; index: number; maxHours: number; ctx?: OpsCtx }) {
  const isDanger  = t.hours >= DANGER
  const isWarning = !isDanger && t.hours >= WARN
  const fillColor = isDanger ? C.blocked : isWarning ? C.overdue : C.active
  const fillPct   = Math.max(6, (t.hours / maxHours) * 100)
  const blocked   = t.state === 'blocked'
  const stateCfg  = OPS_STATE_WORD[t.state] ?? OPS_STATE_WORD.active

  return (
    <motion.div
      variants={{ hidden: { opacity: 0, x: -16 }, show: { opacity: 1, x: 0, transition: { duration: 0.4 } } }}
      animate={isDanger ? { boxShadow: ['0 0 0px #f8717100', '0 0 14px #f8717155', '0 0 0px #f8717100'] } : undefined}
      transition={isDanger ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : undefined}
      style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: GLASS, backdropFilter: 'blur(14px)',
        border: `1px solid ${isDanger ? 'rgba(248,113,113,0.35)' : isWarning ? 'rgba(251,191,36,0.28)' : BORDER}` }}>
      <motion.div initial={{ width: 0 }} animate={{ width: `${fillPct}%` }}
        transition={{ type: 'spring', bounce: 0.05, duration: 1, delay: 0.1 + index * 0.05 }}
        style={{ position: 'absolute', inset: 0, right: 'auto',
          background: isDanger
            ? 'linear-gradient(90deg, rgba(248,113,113,0.22), rgba(248,113,113,0.07))'
            : isWarning
              ? 'linear-gradient(90deg, rgba(251,191,36,0.18), rgba(251,191,36,0.05))'
              : 'linear-gradient(90deg, rgba(96,165,250,0.13), rgba(96,165,250,0.03))',
          borderRight: `2px solid ${fillColor}66` }} />
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px' }}>
        <OpsAvatar dev={t.dev} size={28} glow={blocked ? C.blocked + '55' : null} />
        <span className="ops-stuck-name" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0, width: 78,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.dev.name.split(' ')[0]}</span>
        <span
          onClick={ctx?.ytBaseUrl ? (e) => { e.stopPropagation(); window.open(`${ctx.ytBaseUrl}/issue/${t.id}`, '_blank', 'noopener,noreferrer') } : undefined}
          style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: fillColor, flexShrink: 0,
            cursor: ctx?.ytBaseUrl ? 'pointer' : 'default',
            textDecoration: ctx?.ytBaseUrl ? 'underline' : 'none', textDecorationColor: `${fillColor}66` }}>
          {t.id}
        </span>
        <span
          onClick={ctx ? (e) => { e.stopPropagation(); ctx.onOpenDetail(t.id) } : undefined}
          style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            cursor: ctx ? 'pointer' : 'default' }}>
          {t.summary}
        </span>
        {t.isHotfix && <span style={{ fontSize: 14, flexShrink: 0 }}>🔥</span>}
        <motion.span className="ops-stuck-state-badge" animate={blocked ? { opacity: [0.6, 1, 0.6] } : {}}
          transition={blocked ? { duration: 2.5, repeat: Infinity } : {}}
          style={{ flexShrink: 0, padding: '3px 9px', borderRadius: 7, fontSize: 10, fontWeight: 800,
            letterSpacing: '0.03em', background: `${stateCfg.c}1e`, border: `1px solid ${stateCfg.c}55`, color: stateCfg.c }}>
          {stateCfg.word}
        </motion.span>
        <span style={{ flexShrink: 0, fontFamily: 'monospace', fontSize: 14, fontWeight: 800,
          color: fillColor, width: 64, textAlign: 'right' }}>{opsFmtHours(t.hours)}</span>
      </div>
    </motion.div>
  )
}

function OpsStuckSection({ icon, label, sub, color, rows, maxHours, startIndex, ctx }: {
  icon: string; label: string; sub: string; color: string; rows: FlatTicket[]; maxHours: number; startIndex: number; ctx?: OpsCtx
}) {
  if (!rows.length) return null
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}>
        <span style={{ fontSize: 14 }}>{icon}</span>
        <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: '0.06em', color }}>{label}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{sub}</span>
        <span style={{ fontSize: 11, color, fontWeight: 700 }}>· {rows.length}</span>
        <div style={{ flex: 1, height: 1, background: BORDER }} />
      </div>
      <motion.div variants={{ show: { transition: { staggerChildren: 0.06 } } }} initial="hidden" animate="show"
        style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {rows.map((t, i) => <OpsStuckRow key={t.id + t.dev.name} t={t} index={startIndex + i} maxHours={maxHours} ctx={ctx} />)}
      </motion.div>
    </div>
  )
}

export function OpsViewStuck({ devStats, ctx }: { devStats: DevStatLike[]; ctx?: OpsCtx }) {
  const devs = devStats.map(adaptDev)
  const all = opsFlattenTickets(devs)
    .filter(t => (t.state === 'active' || t.state === 'overdue' || t.state === 'blocked') && t.hours >= WATCH)
    .sort((a, b) => b.hours - a.hours)

  const maxHours = all.length ? all[0].hours : 1
  const danger  = all.filter(t => t.hours >= DANGER)
  const warning = all.filter(t => t.hours >= WARN && t.hours < DANGER)
  const watch   = all.filter(t => t.hours >= WATCH && t.hours < WARN)

  return (
    <div>
      <OpsHead title="Stuck Detector" tagline="Longest-running tickets first — what's been sitting too long." />
      {all.length === 0 ? (
        <motion.div initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', bounce: 0.3, duration: 0.8 }}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: '80px 20px', textAlign: 'center' }}>
          <svg width="76" height="76" viewBox="0 0 76 76" style={{ marginBottom: 18 }}>
            <circle cx="38" cy="38" r="35" fill="none" stroke="#4ade80" strokeWidth="3" opacity="0.3" />
            <motion.path d="M23 39 L34 50 L53 27" fill="none" stroke="#4ade80" strokeWidth="5"
              strokeLinecap="round" strokeLinejoin="round"
              initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
              transition={{ duration: 0.7, delay: 0.3, ease: 'easeInOut' }}
              style={{ filter: 'drop-shadow(0 0 8px #4ade80)' }} />
          </svg>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#4ade80' }}>No stale tickets — everything is moving</div>
        </motion.div>
      ) : (
        <div className="ops-stuck-container">
          <OpsStuckSection icon="🚨" label="DANGER" sub="stuck 48h+" color={C.blocked} rows={danger} maxHours={maxHours} startIndex={0} ctx={ctx} />
          <OpsStuckSection icon="⚠" label="WARNING" sub="stuck 16–48h" color={C.overdue} rows={warning} maxHours={maxHours} startIndex={danger.length} ctx={ctx} />
          <OpsStuckSection icon="◎" label="WATCH" sub="stuck 8–16h" color="var(--text-muted)" rows={watch} maxHours={maxHours} startIndex={danger.length + warning.length} ctx={ctx} />
        </div>
      )}
    </div>
  )
}

// ── View 4: Hotfix & Regression Command ───────────────────────────────────────
function OpsAllClear() {
  return (
    <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', bounce: 0.3, duration: 0.8 }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '80px 20px', textAlign: 'center' }}>
      <svg width="86" height="86" viewBox="0 0 86 86" style={{ marginBottom: 20 }}>
        <circle cx="43" cy="43" r="40" fill="none" stroke="#4ade80" strokeWidth="3" opacity="0.3" />
        <motion.path d="M26 44 L38 56 L60 31" fill="none" stroke="#4ade80" strokeWidth="5"
          strokeLinecap="round" strokeLinejoin="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, delay: 0.3, ease: 'easeInOut' }}
          style={{ filter: 'drop-shadow(0 0 8px #4ade80)' }} />
      </svg>
      <div style={{ fontSize: 28, fontWeight: 800, color: '#4ade80', letterSpacing: '-0.01em' }}>All Clear</div>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 8 }}>No active hotfixes or regressions this sprint.</p>
    </motion.div>
  )
}

function OpsCriticalCard({ t, index, ctx }: { t: FlatTicket; index: number; ctx?: OpsCtx }) {
  const isReg   = t.isRegression
  const badge   = isReg ? { txt: '⚠️ REGRESSION', c: '#fbbf24' } : { txt: '🔥 HOTFIX', c: '#ef4444' }
  const stateCfg = OPS_STATE_WORD[t.state] ?? OPS_STATE_WORD.active
  const done    = t.state === 'done'
  const blocked = t.state === 'blocked'

  let timeTxt: string, timeColor: string
  if (blocked)              { timeTxt = `blocked since ${t.since ?? ''}`; timeColor = C.blocked }
  else if (t.state === 'overdue') { timeTxt = `${opsFmtHours(t.hours)} in progress`; timeColor = C.overdue }
  else if (done)            { timeTxt = `✓ done at ${t.timestamp ?? ''}`; timeColor = C.done }
  else                      { timeTxt = `${opsFmtHours(t.hours)} in progress`; timeColor = C.active }

  const ageDays = t.hours / 24
  const agePct  = Math.min(100, (ageDays / 3) * 100 + 12)
  const ageOver = ageDays > 2

  return (
    <motion.div
      initial={{ opacity: 0, y: -16 }}
      animate={done
        ? { opacity: 0.6, y: 0 }
        : blocked
          ? { opacity: 1, y: 0, boxShadow: ['0 0 0px #ef444400', '0 0 18px #ef444455', '0 0 0px #ef444400'] }
          : { opacity: 1, y: 0 }}
      transition={blocked
        ? { y: { duration: 0.5, delay: index * 0.08 }, opacity: { duration: 0.5, delay: index * 0.08 }, boxShadow: { duration: 2, repeat: Infinity, ease: 'easeInOut' } }
        : { duration: 0.5, delay: index * 0.08 }}
      style={{ background: GLASS, borderRadius: 14, padding: '16px 20px', backdropFilter: 'blur(14px)',
        border: `1px solid ${done ? BORDER : blocked ? 'rgba(239,68,68,0.35)' : isReg ? 'rgba(251,191,36,0.3)' : 'rgba(239,68,68,0.25)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 999,
          background: `${badge.c}1e`, border: `1px solid ${badge.c}66`, color: badge.c, letterSpacing: '0.03em' }}>
          {badge.txt}
        </span>
        <span
          onClick={ctx?.ytBaseUrl ? () => window.open(`${ctx.ytBaseUrl}/issue/${t.id}`, '_blank', 'noopener,noreferrer') : undefined}
          style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
            cursor: ctx?.ytBaseUrl ? 'pointer' : 'default',
            textDecoration: ctx?.ytBaseUrl ? 'underline' : 'none', textDecorationColor: 'rgba(var(--overlay-rgb),0.3)' }}>
          {t.id}
        </span>
        <span
          onClick={ctx ? () => ctx.onOpenDetail(t.id) : undefined}
          style={{ fontSize: 14, fontWeight: 500, color: done ? 'var(--text-muted)' : 'var(--text-primary)',
            flex: 1, minWidth: 180, cursor: ctx ? 'pointer' : 'default' }}>
          {t.summary}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <HoverCard content={<OpsDevHoverContent dev={t.dev} />} maxWidth={290}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'default' }}>
            <OpsAvatar dev={t.dev} size={32} glow={blocked ? C.blocked + '55' : null} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{t.dev.name}</div>
              <span style={{ fontSize: 14, fontWeight: 800, color: stateCfg.c, letterSpacing: '0.03em' }}>{stateCfg.word}</span>
            </div>
          </div>
        </HoverCard>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: timeColor, fontFamily: 'monospace' }}>{timeTxt}</span>
      </div>
      <div style={{ height: 4, borderRadius: 999, background: 'rgba(var(--overlay-rgb),0.07)', overflow: 'hidden', marginTop: 14 }}>
        <motion.div initial={{ width: 0 }} animate={{ width: `${agePct}%` }}
          transition={{ type: 'spring', bounce: 0.05, duration: 1, delay: 0.3 + index * 0.08 }}
          style={{ height: '100%', borderRadius: 999,
            background: done ? C.done : ageOver ? C.blocked : C.overdue,
            boxShadow: ageOver && !done ? `0 0 8px ${C.blocked}` : 'none' }} />
      </div>
    </motion.div>
  )
}

export function OpsViewHotfix({ devStats, ctx }: { devStats: DevStatLike[]; ctx?: OpsCtx }) {
  const devs = devStats.map(adaptDev)
  const crit = opsFlattenTickets(devs).filter(t => t.isHotfix || t.isRegression)
  const rank: Record<string, number> = { blocked: 0, overdue: 1, active: 2, done: 3 }
  crit.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.hours - a.hours))

  return (
    <div>
      <OpsHead title="Hotfix & Regression Command" tagline="Nothing critical ships broken." />
      {crit.length === 0 ? <OpsAllClear /> : (
        <div className="ops-hotfix-container">
          {crit.map((t, i) => <OpsCriticalCard key={t.id + t.dev.name} t={t} index={i} ctx={ctx} />)}
        </div>
      )}
    </div>
  )
}

// ── View 5: Developer Pulse Strips ────────────────────────────────────────────
interface Segment { id: string; kind: string; hours: number; c: string; fire?: boolean; reg?: boolean; blocked?: boolean; queued?: boolean; count?: number }

function opsDaySegments(dev: OpsDev): Segment[] {
  const segs: Segment[] = []
  dev.doneTodayIssues.forEach(d => segs.push({ id: d.id, kind: 'done', hours: d.hoursSpent ?? 1, c: C.done }))
  dev.activeIssues.forEach(a => segs.push({ id: a.id, kind: 'active', hours: a.hoursInState, c: opsStuckColor(a.hoursInState), fire: a.isHotfix, reg: a.isRegression }))
  dev.blockedIssues.forEach(b => segs.push({ id: b.id, kind: 'blocked', hours: b.hoursInState || 2, c: C.blocked, fire: b.isHotfix, blocked: true }))
  if (dev.queuedIssues.length) segs.push({ id: 'queue', kind: 'queued', hours: 2.5, c: 'rgba(var(--overlay-rgb),0.14)', queued: true, count: dev.queuedIssues.length })
  return segs
}

function OpsStripCard({ dev, ctx }: { dev: OpsDev; ctx?: OpsCtx }) {
  const status = opsStatus(dev)
  const segs   = opsDaySegments(dev)
  const totalH = segs.reduce((s, x) => s + Math.max(0.6, x.hours), 0) || 1
  const urgent = [
    ...dev.blockedIssues,
    ...dev.activeIssues.filter(a => a.hoursInState >= WARN),
    ...dev.activeIssues.filter(a => a.hoursInState < WARN),
  ].slice(0, 4)

  return (
    <HoverCard content={<OpsDevHoverContent dev={dev} />} maxWidth={290}>
    <motion.div
      variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0, transition: { type: 'spring', bounce: 0.05, duration: 0.7 } } }}
      style={{ background: GLASS, borderRadius: 14, padding: 16, backdropFilter: 'blur(14px)',
        border: `1px solid ${dev.blockedIssues.length ? C.blocked + '44' : BORDER}`, cursor: 'default' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <OpsAvatar dev={dev} size={30} glow={dev.blockedIssues.length ? C.blocked + '55' : null} />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{dev.name}</span>
        {dev.hotfixCount > 0 && <OpsHotfixBadge count={dev.hotfixCount} />}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.05em', color: status.c,
          padding: '3px 10px', borderRadius: 999, background: `${status.c}1a`, border: `1px solid ${status.c}44` }}>
          {status.word}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 3, height: 48, borderRadius: 8, overflow: 'hidden' }}>
        {segs.map((seg, i) => {
          const grow = Math.max(0.6, seg.hours) / totalH
          return (
            <motion.div key={seg.id + i}
              initial={{ scaleX: 0, opacity: 0 }}
              animate={seg.blocked ? { scaleX: 1, opacity: [0.75, 1, 0.75] } : { scaleX: 1, opacity: seg.kind === 'done' ? 0.75 : 1 }}
              transition={seg.blocked
                ? { scaleX: { type: 'spring', bounce: 0.05, duration: 0.8, delay: 0.2 + i * 0.07 }, opacity: { duration: 2.5, repeat: Infinity, ease: 'easeInOut' } }
                : { type: 'spring', bounce: 0.05, duration: 0.8, delay: 0.2 + i * 0.07 }}
              title={`${seg.id} · ${opsFmtHours(seg.hours)}${seg.queued ? ` · ${seg.count} queued` : ''}`}
              style={{ flexGrow: grow, flexBasis: 0, minWidth: seg.queued ? 28 : 36, transformOrigin: 'left center',
                background: seg.queued
                  ? 'repeating-linear-gradient(45deg, rgba(var(--overlay-rgb),0.10), rgba(var(--overlay-rgb),0.10) 4px, transparent 4px, transparent 8px)'
                  : seg.kind === 'done'
                    ? `${seg.c}45`
                    : `linear-gradient(180deg, ${seg.c}dd, ${seg.c}99)`,
                border: `1px solid ${seg.queued ? 'rgba(var(--overlay-rgb),0.12)' : seg.c}88`,
                borderRadius: 5, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                position: 'relative', overflow: 'hidden',
                boxShadow: seg.blocked ? `0 0 10px ${seg.c}aa` : 'none' }}>
              {!seg.queued && (
                <span style={{ fontSize: 8.5, fontWeight: 800, color: '#fff', opacity: 0.9,
                  lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: '100%',
                  paddingLeft: 3, paddingRight: 3, textOverflow: 'ellipsis' }}>
                  {seg.id}
                </span>
              )}
              <span style={{ fontSize: 8, color: '#fff', opacity: 0.65, whiteSpace: 'nowrap' }}>
                {seg.queued
                  ? `+${seg.count}`
                  : opsFmtHours(seg.hours)}
              </span>
              {seg.fire && <span style={{ fontSize: 10, position: 'absolute', top: 2, right: 2 }}>🔥</span>}
              {seg.kind === 'done' && !seg.fire && <span style={{ fontSize: 10, position: 'absolute', top: 2, right: 2, color: seg.c, fontWeight: 800 }}>✓</span>}
            </motion.div>
          )
        })}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
        {urgent.length === 0
          ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>clean day · {dev.queuedIssues.length} queued</span>
          : urgent.map(t => <OpsTicketChip key={t.id} issue={t} animateGlow ctx={ctx} noHover />)}
      </div>
    </motion.div>
    </HoverCard>
  )
}

export function OpsViewStrips({ devStats, ctx }: { devStats: DevStatLike[]; ctx?: OpsCtx }) {
  const devs = [...devStats.map(adaptDev)].sort((a, b) => opsUrgencyRank(b) - opsUrgencyRank(a))
  return (
    <div>
      <OpsHead title="Developer Pulse Strips" tagline="Each bar segment = one ticket. ID + time shown inside. Hover any card for full breakdown." />
      <motion.div className="ops-strips-container" variants={{ show: { transition: { staggerChildren: 0.09 } } }} initial="hidden" animate="show">
        {devs.map(dev => <OpsStripCard key={dev.name} dev={dev} ctx={ctx} />)}
      </motion.div>
    </div>
  )
}

// ── View 6: Sprint Snapshot Grid ──────────────────────────────────────────────
function OpsDotCluster({ items, color, baseDelay }: { items: { blocked?: boolean; danger?: boolean }[]; color: string; baseDelay: number }) {
  if (!items.length) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {items.map((it, i) => (
        <motion.span key={i}
          initial={{ scale: 0, opacity: 0 }}
          animate={it.blocked ? { scale: 1, opacity: [0.55, 1, 0.55] } : { scale: 1, opacity: 1 }}
          transition={it.blocked
            ? { scale: { delay: baseDelay + i * 0.05, type: 'spring', bounce: 0.4 }, opacity: { duration: 2.5, repeat: Infinity, ease: 'easeInOut' } }
            : { delay: baseDelay + i * 0.05, type: 'spring', bounce: 0.4 }}
          style={{ width: it.blocked ? 12 : 9, height: it.blocked ? 12 : 9, borderRadius: '50%',
            background: color, flexShrink: 0, boxShadow: it.blocked ? `0 0 7px ${color}` : 'none' }} />
      ))}
    </div>
  )
}

function OpsSnapshotTicketRow({ label, color, issues, ctx }: {
  label: string; color: string; issues: OpsIssue[]; ctx?: OpsCtx
}) {
  if (!issues.length) return null
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 9, fontWeight: 800, color, letterSpacing: '0.05em', marginBottom: 3 }}>
        {label} · {issues.length}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {issues.slice(0, 4).map(t => (
          <span
            key={t.id}
            onClick={ctx?.ytBaseUrl ? () => window.open(`${ctx.ytBaseUrl}/issue/${t.id}`, '_blank', 'noopener,noreferrer') : undefined}
            title={t.summary}
            style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4,
              background: `${color}18`, border: `1px solid ${color}44`, color,
              cursor: ctx?.ytBaseUrl ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
            {t.id}
          </span>
        ))}
        {issues.length > 4 && (
          <span style={{ fontSize: 9, color, opacity: 0.7 }}>+{issues.length - 4}</span>
        )}
      </div>
    </div>
  )
}

function OpsSnapshotCard({ dev, index, ctx }: { dev: OpsDev; index: number; ctx?: OpsCtx }) {
  const donePct = opsDonePct(dev)
  const status  = opsStatus(dev)
  const stuck   = dev.activeIssues.filter(a => a.hoursInState >= WARN)
  const active  = dev.activeIssues.filter(a => a.hoursInState < WARN)
  const barColor = dev.blockedIssues.length ? C.blocked : stuck.length ? C.overdue : C.done

  return (
    <HoverCard content={<OpsDevHoverContent dev={dev} />} maxWidth={290}>
    <motion.div
      variants={{ hidden: { opacity: 0, scale: 0.9 }, show: { opacity: 1, scale: 1, transition: { type: 'spring', bounce: 0.2, duration: 0.6 } } }}
      style={{ position: 'relative', background: GLASS, borderRadius: 14, padding: 14, backdropFilter: 'blur(14px)',
        border: `1px solid ${dev.blockedIssues.length ? C.blocked + '44' : BORDER}`, cursor: 'default' }}>
      {dev.hotfixCount > 0 && (
        <div style={{ position: 'absolute', top: 10, right: 10 }}><OpsHotfixBadge count={dev.hotfixCount} /></div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10, paddingRight: dev.hotfixCount > 0 ? 22 : 0 }}>
        <OpsAvatar dev={dev} size={30} glow={dev.blockedIssues.length ? C.blocked + '55' : null} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dev.name}</div>
          <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.05em', color: status.c }}>{status.word}</div>
        </div>
      </div>

      {/* Done progress bar with percentage */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <div style={{ flex: 1, height: 6, borderRadius: 999, overflow: 'hidden', background: 'rgba(var(--overlay-rgb),0.07)' }}>
          <motion.div initial={{ width: 0 }} animate={{ width: `${donePct}%` }}
            transition={{ type: 'spring', bounce: 0.05, duration: 1, delay: 0.2 + index * 0.05 }}
            style={{ height: '100%', background: barColor }} />
        </div>
        <span style={{ fontSize: 9, fontWeight: 700, color: barColor, flexShrink: 0 }}>{donePct}%</span>
      </div>

      {/* Ticket sections — labeled with clickable IDs */}
      <div style={{ minHeight: 52 }}>
        <OpsSnapshotTicketRow label="BLOCKED" color={C.blocked} issues={dev.blockedIssues} ctx={ctx} />
        <OpsSnapshotTicketRow label="STUCK" color={C.overdue} issues={stuck} ctx={ctx} />
        <OpsSnapshotTicketRow label="ACTIVE" color={C.active} issues={active} ctx={ctx} />
        {dev.queuedIssues.length > 0 && (
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
            ○ {dev.queuedIssues.length} queued
          </div>
        )}
        {!dev.blockedIssues.length && !stuck.length && !active.length && !dev.queuedIssues.length && (
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>no open tickets</span>
        )}
      </div>

      {/* Done today */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 10, paddingTop: 9,
        borderTop: `1px solid ${BORDER}`, minHeight: 24 }}>
        {dev.doneTodayIssues.length === 0
          ? <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>nothing shipped today</span>
          : <>
              <span style={{ fontSize: 9, color: C.done, fontWeight: 700 }}>DONE TODAY</span>
              {dev.doneTodayIssues.slice(0, 4).map((d, i) => (
                <motion.span key={d.id}
                  initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.7 + index * 0.05 + i * 0.1, type: 'spring', bounce: 0.55 }}
                  onClick={ctx?.ytBaseUrl ? () => window.open(`${ctx.ytBaseUrl}/issue/${d.id}`, '_blank', 'noopener,noreferrer') : undefined}
                  title={`${d.id} done at ${d.timestamp ?? ''}`}
                  style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4,
                    background: `${C.done}18`, border: `1px solid ${C.done}44`, color: C.done,
                    cursor: ctx?.ytBaseUrl ? 'pointer' : 'default',
                    filter: 'drop-shadow(0 0 3px rgba(74,222,128,0.3))' }}>
                  {d.id}
                </motion.span>
              ))}
              {dev.doneTodayIssues.length > 4 && (
                <span style={{ fontSize: 9, color: C.done, opacity: 0.7 }}>+{dev.doneTodayIssues.length - 4}</span>
              )}
            </>}
      </div>
    </motion.div>
    </HoverCard>
  )
}

export function OpsViewSnapshot({ devStats, ctx }: { devStats: DevStatLike[]; ctx?: OpsCtx }) {
  const devs = [...devStats.map(adaptDev)].sort((a, b) => opsUrgencyRank(b) - opsUrgencyRank(a))
  return (
    <div>
      <OpsHead title="Sprint Snapshot" tagline="Per-developer ticket breakdown — blocked/stuck/active/queued/done today. Click any ticket ID to open in YouTrack." />
      <motion.div className="ops-grid-snapshot" variants={{ show: { transition: { staggerChildren: 0.08 } } }} initial="hidden" animate="show">
        {devs.map((dev, i) => <OpsSnapshotCard key={dev.name} dev={dev} index={i} ctx={ctx} />)}
      </motion.div>
    </div>
  )
}

// ── Skeleton loaders — one per view ──────────────────────────────────────────
// Each skeleton mirrors the real card layout (same grid class, same padding/radius).
// Widths vary by index so the shimmer looks organic, not like a repeating pattern.

const Sk = ({ w, h, r = 6 }: { w: number | string; h: number; r?: number | string }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
)

function SkHead() {
  return (
    <div style={{ marginBottom: 20 }}>
      <Sk w={160} h={22} r={6} />
      <div style={{ marginTop: 8 }}><Sk w="62%" h={13} r={4} /></div>
    </div>
  )
}

// Widths cycle so consecutive cards look different
const W = [55, 70, 48, 65, 58, 72] // name bar widths (%)
const W2 = [75, 55, 80, 62, 70, 50] // summary widths (%)

function SkRings() {
  return (
    <div>
      <SkHead />
      <div className="ops-grid-rings">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ background: GLASS, borderRadius: 16, padding: 18, border: `1px solid ${BORDER}`,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
              <Sk w={34} h={34} r="50%" />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Sk w={`${W[i % 6]}%`} h={13} r={4} />
                <Sk w={60} h={9} r={3} />
              </div>
            </div>
            {/* Ring circle placeholder */}
            <div style={{ position: 'relative', width: 176, height: 176, margin: '18px 0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="skeleton" style={{ position: 'absolute', inset: 0, borderRadius: '50%', opacity: 0.18 }} />
              {/* Inner cutout to fake a ring */}
              <div style={{ width: 138, height: 138, borderRadius: '50%', background: 'var(--bg-surface, #1a1a2e)' }} />
            </div>
            {/* Chip row */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
              <Sk w={72} h={24} r={999} />
              <Sk w={84} h={24} r={999} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SkMission() {
  return (
    <div>
      <SkHead />
      <div className="ops-grid-mission">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ background: GLASS, borderRadius: 16, padding: 16, border: `1px solid ${BORDER}` }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <Sk w={32} h={32} r="50%" />
              <Sk w={`${W[i % 6]}%`} h={14} r={4} />
            </div>
            {/* Status + donut row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Sk w={36} h={36} r={6} />
                <Sk w={100} h={20} r={4} />
                <Sk w={`${W2[i % 6]}%`} h={11} r={3} />
              </div>
              {/* Donut circle */}
              <div style={{ position: 'relative', width: 92, height: 92, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="skeleton" style={{ position: 'absolute', inset: 0, borderRadius: '50%', opacity: 0.18 }} />
                <div style={{ width: 66, height: 66, borderRadius: '50%', background: 'var(--bg-surface, #1a1a2e)' }} />
              </div>
            </div>
            {/* Activity strip */}
            <div style={{ marginTop: 14, paddingTop: 6 }}>
              <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
                {[0,1,2].map(j => (
                  <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <Sk w={30} h={9} r={3} />
                    <Sk w={11} h={11} r="50%" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SkStuck() {
  const SECTION_ROWS = [3, 2, 2] // DANGER / WARNING / WATCH row counts
  const SECTION_COLORS = ['rgba(248,113,113,0.25)', 'rgba(251,191,36,0.2)', 'rgba(var(--overlay-rgb),0.1)']
  return (
    <div>
      <SkHead />
      <div className="ops-stuck-container">
        {SECTION_ROWS.map((rows, si) => (
          <div key={si} style={{ marginBottom: 22 }}>
            {/* Section header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}>
              <Sk w={14} h={14} r={3} />
              <Sk w={70} h={12} r={4} />
              <Sk w={90} h={11} r={3} />
              <div style={{ flex: 1, height: 1, background: BORDER }} />
            </div>
            {/* Rows */}
            {Array.from({ length: rows }).map((_, ri) => (
              <div key={ri} style={{ position: 'relative', borderRadius: 12, overflow: 'hidden',
                background: GLASS, border: `1px solid ${BORDER}`, marginBottom: 7 }}>
                {/* Fill bar */}
                <div className="skeleton" style={{
                  position: 'absolute', inset: 0, right: 'auto',
                  width: `${[65, 40, 80, 52, 70, 35][ri + si * 3 < 6 ? ri + si * 3 : ri]}%`,
                  background: SECTION_COLORS[si], opacity: 0.6 }} />
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px' }}>
                  <Sk w={28} h={28} r="50%" />
                  <Sk w={78} h={12} r={3} />
                  <Sk w={60} h={12} r={3} />
                  <Sk w={`${W2[(ri + si) % 6]}%`} h={13} r={3} />
                  <Sk w={70} h={22} r={7} />
                  <Sk w={44} h={14} r={3} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function SkHotfix() {
  return (
    <div>
      <SkHead />
      <div className="ops-hotfix-container">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ background: GLASS, borderRadius: 14, padding: '16px 20px', border: `1px solid ${BORDER}` }}>
            {/* Badge + id + summary */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <Sk w={88} h={24} r={999} />
              <Sk w={64} h={13} r={3} />
              <Sk w={`${W2[i % 6]}%`} h={14} r={3} />
            </div>
            {/* Dev + state + time row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Sk w={32} h={32} r="50%" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <Sk w={80} h={12} r={3} />
                  <Sk w={60} h={12} r={3} />
                </div>
              </div>
              <div style={{ flex: 1 }} />
              <Sk w={120} h={14} r={3} />
            </div>
            {/* Progress bar */}
            <div style={{ height: 4, borderRadius: 999, background: 'rgba(var(--overlay-rgb),0.07)', overflow: 'hidden', marginTop: 14 }}>
              <div className="skeleton" style={{ height: '100%', borderRadius: 999,
                width: `${[45, 70, 30][i % 3]}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SkStrips() {
  // Segment widths per card — vary so each strip looks unique
  const SEGS = [
    [0.18, 0.28, 0.22, 0.16, 0.12],
    [0.32, 0.20, 0.14, 0.24, 0.06],
    [0.10, 0.35, 0.18, 0.28, 0.06],
    [0.22, 0.16, 0.30, 0.20, 0.10],
    [0.28, 0.24, 0.18, 0.16, 0.12],
  ]
  const SEG_COLORS = ['rgba(74,222,128,0.25)','rgba(96,165,250,0.25)','rgba(251,191,36,0.25)','rgba(248,113,113,0.25)','rgba(var(--overlay-rgb),0.08)']
  return (
    <div>
      <SkHead />
      <div className="ops-strips-container">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ background: GLASS, borderRadius: 14, padding: 16, border: `1px solid ${BORDER}` }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <Sk w={30} h={30} r="50%" />
              <Sk w={`${W[i % 6]}%`} h={14} r={4} />
              <div style={{ flex: 1 }} />
              <Sk w={76} h={22} r={999} />
            </div>
            {/* Film strip */}
            <div style={{ display: 'flex', gap: 3, height: 40, borderRadius: 8, overflow: 'hidden' }}>
              {SEGS[i % SEGS.length].map((grow, j) => (
                <div key={j} className="skeleton" style={{
                  flexGrow: grow, flexBasis: 0, minWidth: 24, borderRadius: 5,
                  background: SEG_COLORS[j % SEG_COLORS.length], opacity: 0.7 }} />
              ))}
            </div>
            {/* Chips row */}
            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              <Sk w={76} h={22} r={999} />
              <Sk w={88} h={22} r={999} />
              {i % 2 === 0 && <Sk w={68} h={22} r={999} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SkSnapshot() {
  return (
    <div>
      <SkHead />
      <div className="ops-grid-snapshot">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} style={{ background: GLASS, borderRadius: 14, padding: 14, border: `1px solid ${BORDER}` }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
              <Sk w={30} h={30} r="50%" />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
                <Sk w={`${W[i % 6]}%`} h={13} r={4} />
                <Sk w={44} h={9} r={3} />
              </div>
            </div>
            {/* Progress bar */}
            <div style={{ height: 7, borderRadius: 999, background: 'rgba(var(--overlay-rgb),0.07)', overflow: 'hidden', marginBottom: 13 }}>
              <div className="skeleton" style={{ height: '100%', borderRadius: 999,
                width: `${[55, 38, 72, 44, 60, 30, 80, 50][i % 8]}%` }} />
            </div>
            {/* Dot cluster area */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, minHeight: 54, alignContent: 'flex-start' }}>
              {Array.from({ length: 3 + (i % 4) }).map((_, di) => (
                <Sk key={di} w={di < 2 ? 12 : 9} h={di < 2 ? 12 : 9} r="50%" />
              ))}
            </div>
            {/* Done row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 12, paddingTop: 11,
              borderTop: `1px solid ${BORDER}`, minHeight: 26 }}>
              {i % 3 !== 2
                ? Array.from({ length: 1 + (i % 3) }).map((_, ci) => <Sk key={ci} w={16} h={16} r="50%" />)
                : <Sk w={100} h={11} r={3} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function OpsViewSkeleton({ view }: { view: string }) {
  switch (view) {
    case 'rings':    return <SkRings />
    case 'mission':  return <SkMission />
    case 'stuck':    return <SkStuck />
    case 'hotfix':   return <SkHotfix />
    case 'strips':   return <SkStrips />
    case 'snapshot': return <SkSnapshot />
    default:         return null
  }
}
