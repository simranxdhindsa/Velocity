// Day Track — pure helpers and constants (no JSX, no React dependency).
// Extracted from DayTrackPage.tsx per CLAUDE.md's file-size rule (pure
// helpers with no JSX belong in a <page>-types.ts/-helpers.ts file).

const PALETTE = ['#6366f1','#10b981','#8b5cf6','#f59e0b','#06b6d4','#ec4899','#f97316','#ef4444','#84cc16','#14b8a6']
export const DEFAULT_CATS = ['Development','Testing','Meetings','Breaks','Review','Research','Sign In','Sign Off']
export const REPORT_EXCLUDED_CATS = new Set(['sign in', 'sign off', 'breaks'])
// Same set, exact-cased against the category list — these are instantaneous or
// duration-less events (sign in/off, breaks), so "still in progress" doesn't apply.
export const NOT_IN_PROGRESS_CATS = new Set(['Sign In', 'Sign Off', 'Breaks'])

export function catColor(cat: string, cats: string[]): string {
  const fixed: Record<string,string> = {
    Development: '#6366f1', Testing: '#10b981', Meetings: '#8b5cf6',
    Breaks: '#f59e0b', Review: '#06b6d4', Research: '#ec4899',
    'Sign In': '#22c55e', 'Sign Off': '#94a3b8',
  }
  if (fixed[cat]) return fixed[cat]
  const idx = cats.indexOf(cat)
  return PALETTE[((idx < 0 ? 0 : idx)) % PALETTE.length]
}

// Fixed icon for every built-in category — mirrors backend's defaultCategoryEmoji
// (daytrack_emoji.go) so the UI and the Slack report always show the same icon.
const DEFAULT_CATEGORY_EMOJI: Record<string, string> = {
  'development': '🐛', 'testing': '🧪', 'meetings': '👥', 'breaks': '☕',
  'review': '🔍', 'research': '🔬', 'sign in': '🟢', 'sign off': '🔴',
  'project management': '📌', 'tickets created': '📆', 'tickets tested': '🧪', 'in progress': '🔄',
}

/** Resolves a category's icon: fixed default first, then the user's custom map, else a plain bullet. */
export function categoryEmoji(cat: string, customIcons: Record<string, string>): string {
  const key = cat.trim().toLowerCase()
  return DEFAULT_CATEGORY_EMOJI[key] || customIcons[key] || '▪️'
}

export function toDateStr(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

export function fmtDate(d: Date): string {
  const istString = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' })
  return istString
}

export function to12h(hhmm: string): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return hhmm
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

export function to24h(time12: string): string {
  if (!time12) return ''
  const match = time12.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return time12
  let h = parseInt(match[1])
  const m = match[2]
  const ampm = match[3].toUpperCase()
  if (ampm === 'AM' && h === 12) h = 0
  if (ampm === 'PM' && h !== 12) h += 12
  return `${String(h).padStart(2, '0')}:${m}`
}

export function nowHHMM(): string {
  const n = new Date()
  const istTime = n.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
  return to12h(istTime)
}

export function timeToMins(t: string): number {
  if (!t) return 0
  const match = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (match) {
    let h = parseInt(match[1])
    const m = parseInt(match[2])
    const ampm = match[3].toUpperCase()
    if (ampm === 'AM' && h === 12) h = 0
    if (ampm === 'PM' && h !== 12) h += 12
    return h * 60 + m
  }
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

export function addMinute(time12: string): string {
  const mins = timeToMins(time12)
  const total = mins + 1
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  return to12h(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
}

export function calcDuration(s: string, e: string): number | null {
  if (!s || !e) return null
  let diff = timeToMins(e) - timeToMins(s)
  if (diff < 0) diff += 24 * 60
  return diff > 0 ? diff : null
}

export function minsLabel(m: number | null | undefined): string {
  if (m == null) return '—'
  const h = Math.floor(m / 60), min = m % 60
  return h > 0 ? `${h}h ${min}m` : `${min}m`
}

export function truncateChannel(name: string, maxLen = 16): string {
  return name.length > maxLen ? name.slice(0, maxLen) + '…' : name
}

export function statusLabel(status: string): string {
  return status === 'active' ? 'In Progress' : status
}

// Finds the closest category (by list position, searching outward) that isn't in the
// excluded set — used to bump a category like "Sign In" to something valid when the
// user checks "still in progress" while one of those was already selected.
export function nearestAllowedCategory(categories: string[], fromIndex: number, excluded: Set<string>): string {
  for (let dist = 1; dist < categories.length; dist++) {
    const before = fromIndex - dist
    const after = fromIndex + dist
    if (before >= 0 && !excluded.has(categories[before])) return categories[before]
    if (after < categories.length && !excluded.has(categories[after])) return categories[after]
  }
  return categories.find(c => !excluded.has(c)) ?? categories[0] ?? 'General'
}

export function plannedStatusLabel(status: string): string {
  const map: Record<string, string> = { in_progress: 'In Progress', carry: 'Carried Over', planned: 'Planned' }
  return map[status] ?? status
}

export function dtRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Category auto-detect ──────────────────────────────────────────────────────

export function detectCategory(text: string, categories: string[]): string {
  const lower = text.toLowerCase()
  const rules: [string, string[]][] = [
    ['Testing', ['test', 'testing', 'qa', 'playwright', 'cypress', 'debug', 'bug', 'regression', 'e2e']],
    ['Development', ['develop', 'implement', 'build', 'feature', 'refactor', 'commit', 'pull request', 'code', 'coding', 'programming']],
    ['Meetings', ['meeting', 'standup', 'stand-up', 'call', 'sync', 'discussion', 'demo', 'retrospective', 'retro', 'planning']],
    ['Breaks', ['break', 'lunch', 'coffee', 'aws', 'away from screen', 'brb']],
    ['Research', ['research', 'reading', 'study', 'investigate', 'explore', 'analyze', 'analysis', 'look into']],
    ['Review', ['review', 'code review', 'pr review', 'feedback']],
    ['Sign In', ['signing in', 'signed in', 'logging in', 'starting work']],
    ['Sign Off', ['signing off', 'signed off', 'logging off', 'end of day']],
  ]
  for (const [cat, keywords] of rules) {
    if (keywords.some(kw => lower.includes(kw)) && categories.includes(cat)) return cat
  }
  return ''
}

// ── Toast ──────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'info' | 'warn'
export interface Toast { id: number; msg: string; type: ToastType }
