import type { SprintBoardIssue, WorkflowConfig } from '@/services/api'

// ─── Constants ────────────────────────────────────────────────────────────────

export const SPRINT_ID_KEY   = 'pm_active_sprint_id'
export const SPRINT_NAME_KEY = 'pm_active_sprint_name'
export const DONE_ROLES      = new Set(['dev_done', 'verified', 'deployed', 'closed'])

export type ViewMode = 'a' | 'c' | '1' | '4' | 'p' | 'l'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PulseIssue extends SprintBoardIssue {
  tier:       number
  colRole:    string
  stageGroup: 'active' | 'blocked' | 'dev_done' | 'stage' | 'deployed'
  isDone:     boolean
}

export interface TierGroups {
  t1:  PulseIssue[]
  t2:  PulseIssue[]
  t3:  PulseIssue[]
  t4:  PulseIssue[]
  t5:  PulseIssue[]
  reg: PulseIssue[]
}

export interface StageCounts {
  active:   number
  blocked:  number
  devDone:  number
  stage:    number
  deployed: number
}

export interface ViewProps {
  tierGroups:   TierGroups
  stageCounts?: StageCounts
  wfConfig:     WorkflowConfig | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick:    (id: string, e: React.MouseEvent) => void
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function classifyTier(iss: SprintBoardIssue): number {
  if (iss.issue_type.toLowerCase().includes('regress')) return 0
  if (iss.is_hotfix) return 1
  const p = iss.priority.toLowerCase()
  if (p.includes('critical') || p === 'p0' || p === 'a0') return 1
  if (p.includes('major')    || p === 'p1' || p === 'a1') return 2
  if (p.includes('minor')    || p === 'p2' || p === 'a2') return 3
  if (p === 'p3' || p === 'a3') return 4
  return 5
}

export function mapStage(colRole: string): PulseIssue['stageGroup'] {
  if (colRole === 'blocked')                          return 'blocked'
  if (colRole === 'dev_done')                         return 'dev_done'
  if (colRole === 'verified')                         return 'stage'
  if (colRole === 'deployed' || colRole === 'closed') return 'deployed'
  return 'active'
}

export function fmtHours(h: number): string {
  if (!h) return '—'
  if (h < 1)  return `${Math.round(h * 60)}m`
  if (h < 24) return `${Math.round(h)}h`
  return `${(h / 24).toFixed(1)}d`
}

export function fmtSprintDate(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function sprintCountdown(finishMs: number): string {
  const diff = finishMs - Date.now()
  if (diff <= 0) return 'OVERDUE'
  const days  = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`
}

export function dangerLevel(iss: SprintBoardIssue): 0 | 1 | 2 {
  if (iss.overdue_level === 'deadline' || iss.bounce_count >= 3) return 2
  if (iss.overdue_level === 'sprint'   || iss.bounce_count >= 2) return 2
  if (iss.overdue_level === 'sla'      || iss.is_delayed)         return 1
  return 0
}

export function tierLabel(tier: number): string {
  if (tier === 0) return 'Regressions'
  if (tier === 1) return 'Critical / Hotfix'
  if (tier === 2) return 'Urgent'
  if (tier === 3) return 'On Deck A2/P2s'
  if (tier === 4) return 'To Be Pushed With Current Sprint'
  return 'Normal'
}

export function tierCssClass(tier: number): string {
  if (tier === 1) return 'spl-t1'
  if (tier === 2) return 'spl-t2'
  if (tier === 3) return 'spl-t3'
  if (tier === 4) return 'spl-t4'
  if (tier === 0) return 'spl-treg'
  return 'spl-t5'
}
