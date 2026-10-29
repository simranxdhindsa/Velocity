// Dev Activity: shared constants, types and pure helpers (no React).
import type { IssueTimeline, IssueStint } from '../services/api'

// ─── Constants ──────────────────────────────────────────────────────────────

export const WORKFLOW_ORDER = ['To Do', 'In Progress', 'Blocked', 'DEV', 'Stage', 'Prod', 'Done']
export const HEATMAP_STATES = ['To Do', 'In Progress', 'Blocked', 'DEV', 'Stage', 'Prod', 'Done']

export interface StateConfig { color: string; bg: string; border: string }
export const STATE_CFG: Record<string, StateConfig> = {
  'To Do':       { color: '#64748b', bg: 'rgba(100,116,139,0.15)', border: 'rgba(100,116,139,0.3)' },
  'In Progress': { color: 'var(--color-primary)', bg: 'rgba(var(--color-primary-rgb),0.15)',  border: 'rgba(var(--color-primary-rgb),0.3)'  },
  'Blocked':     { color: '#ef4444', bg: 'rgba(239,68,68,0.15)',   border: 'rgba(239,68,68,0.3)'   },
  'DEV':         { color: '#10b981', bg: 'rgba(16,185,129,0.15)',  border: 'rgba(16,185,129,0.3)'  },
  'Stage':       { color: '#06b6d4', bg: 'rgba(6,182,212,0.15)',   border: 'rgba(6,182,212,0.3)'   },
  'Prod':        { color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)',  border: 'rgba(139,92,246,0.3)'  },
  'Done':        { color: '#475569', bg: 'rgba(71,85,105,0.15)',   border: 'rgba(71,85,105,0.25)'  },
}
export function stateCfg(state: string): StateConfig {
  for (const [k, v] of Object.entries(STATE_CFG)) {
    if (state.toLowerCase().includes(k.toLowerCase())) return v
  }
  return STATE_CFG['In Progress']
}

export const DATE_OPTS = ['Today', 'Last 2 Days', 'Last Week', 'Custom'] as const
export type DateRange = typeof DATE_OPTS[number]

// ─── Helpers ────────────────────────────────────────────────────────────────

export function getDateRange(range: DateRange, customFrom?: string, customTo?: string): { sinceMs: number; untilMs: number } {
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

export function fmtH(h: number | null | undefined): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  const hrs = Math.floor(h)
  const mins = Math.round((h - hrs) * 60)
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`
}

export function fmtTransitionTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export function fmtSprintDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function getCurrentState(timeline: IssueTimeline): string {
  if (timeline.is_live) return 'In Progress'
  const stints = timeline.stints ?? []
  const last = stints[stints.length - 1]
  if (last?.exited_to) return last.exited_to
  return 'In Progress'
}

export interface JourneyStep { state: string; durationH: number | null; isActive: boolean }
export function buildJourney(stints: IssueStint[], isLive: boolean): JourneyStep[] {
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
export const DEV_DONE_STATES = ['dev', 'mobile done', 'done', 'deployed', 'closed']

export interface DevStats { total: number; done: number; active: number; blocked: number; bounced: number; hoursWorked: number }
export function getDevStats(timelines: IssueTimeline[]): DevStats {
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

export const DEV_PALETTE = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899']
export function devColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return DEV_PALETTE[hash % DEV_PALETTE.length]
}
export function devInitials(name: string): string {
  return name.split(/\s+/).map(p => p[0] ?? '').join('').toUpperCase().slice(0, 2) || '?'
}

export function isBackwardTransition(from: string, to: string): boolean {
  // Blocked is a side-lane state — moving out of it (to In Progress, To Do, etc.) is never a regression
  if (from.toLowerCase() === 'blocked') return false
  const fromIdx = WORKFLOW_ORDER.findIndex(s => from.toLowerCase().includes(s.toLowerCase()))
  const toIdx   = WORKFLOW_ORDER.findIndex(s => to.toLowerCase().includes(s.toLowerCase()))
  if (fromIdx === -1 || toIdx === -1) return false
  return toIdx < fromIdx
}

export function heatColor(hours: number, maxH: number): { bg: string; border: string; text: string } | null {
  if (!hours) return null
  const r = hours / maxH
  if (r < 0.25) return { bg: 'rgba(var(--color-primary-rgb),0.18)', border: 'rgba(var(--color-primary-rgb),0.3)',  text: 'var(--color-primary-light)' }
  if (r < 0.5)  return { bg: 'rgba(var(--color-primary-rgb),0.32)', border: 'rgba(var(--color-primary-rgb),0.4)',  text: 'var(--color-primary-light)' }
  if (r < 0.75) return { bg: 'rgba(var(--color-primary-rgb),0.52)', border: 'rgba(var(--color-primary-rgb),0.55)', text: 'var(--color-accent)' }
  return              { bg: 'rgba(var(--color-primary-rgb),0.80)', border: 'rgba(var(--color-primary-rgb),0.9)',  text: '#e0e7ff' }
}

