/**
 * usePersistedState — drop-in useState replacement that syncs to localStorage.
 *
 * Usage (replaces useState + manual localStorage calls):
 *   const [viewMode, setViewMode] = usePersistedState(PERSIST.TRACKING_VIEW, 'column')
 *
 * Rules for future features:
 *  1. Always use a key from the PERSIST constant below — never inline a string literal.
 *  2. T must be JSON-serializable (string, number, boolean, plain object/array).
 *  3. For validation (enum values), pass a `validate` option.
 */

import { useState, useCallback } from 'react'

// ── Central registry of all persisted state keys ─────────────────────────────
// Add a new entry here whenever a new piece of UI state should survive refresh.
export const PERSIST = {
  /** Main Dashboard tab last visited (e.g. 'board', 'pm-reports') */
  LAST_PAGE:        'velocity_last_page',
  /** PM Reports — which of the 10 tracking views was last active */
  TRACKING_VIEW:    'pm_tracking_view',
  /** PM Reports — active sprint id */
  SPRINT_ID:        'pm_active_sprint_id',
  /** PM Reports — active sprint name */
  SPRINT_NAME:      'pm_active_sprint_name',
  /** App theme */
  THEME:            'theme',
  /** Per-user theme cache (JSON) */
  THEME_CACHE:      'user-theme-cache',
  /** Dev Activity page — which of the 4 views was last active */
  DEV_ACTIVITY_VIEW: 'dev_activity_view',
  /** Dev Activity page — date range filter */
  DEV_ACTIVITY_DATE: 'dev_activity_date',
  /** Daily Ops tab — which design view is active */
  DAILY_OPS_VIEW: 'daily_ops_view',
  /** Quick Send — last 10 sent messages for history display */
  QUICK_SEND_HISTORY: 'quick_send_history',
  /** Pending queue — default scheduled time for Claude-queued messages (HH:MM) */
  QUEUE_DEFAULT_TIME: 'queue_default_send_time',
  /** MCP plain token — stored so connector URL is always visible without re-generating */
  MCP_PLAIN_TOKEN: 'mcp_plain_token',
  /** Slack Messages hub — last selected channel id */
  SLACK_HUB_CHANNEL: 'slack_hub_channel',
  /** Slack Messages hub — per-channel last-viewed timestamp (JSON), drives unread bolding */
  SLACK_HUB_LAST_VIEWED: 'slack_hub_last_viewed',
} as const

export type PersistKey = typeof PERSIST[keyof typeof PERSIST]

// ── Hook ─────────────────────────────────────────────────────────────────────

interface Options<T> {
  /**
   * Optional allowlist of valid values. If the stored value is not in this
   * list it is discarded and defaultValue is used instead.
   */
  validate?: readonly T[]
}

export function usePersistedState<T>(
  key: PersistKey,
  defaultValue: T,
  options: Options<T> = {},
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setStateRaw] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return defaultValue
      const parsed = JSON.parse(raw) as T
      if (options.validate && !options.validate.includes(parsed)) return defaultValue
      return parsed
    } catch {
      return defaultValue
    }
  })

  const setState = useCallback((value: T | ((prev: T) => T)) => {
    setStateRaw(prev => {
      const next = typeof value === 'function' ? (value as (p: T) => T)(prev) : value
      try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* storage full */ }
      return next
    })
  }, [key])

  return [state, setState]
}
