import { useCallback, useState } from 'react'
import type { SlackWorkspaceUser } from '@/services/api'

/**
 * Shared "@ to mention a Slack user" autocomplete for plain-text textareas.
 * Inserts plain `@DisplayName` text (not a Slack token) — the message is
 * expected to pass through the backend's resolveSlackMentions() before
 * sending, which is what every Velocity Slack-compose endpoint already does.
 */
export function useMentionAutocomplete(users: SlackWorkspaceUser[]) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [mentionDropStyle, setMentionDropStyle] = useState<React.CSSProperties>({})

  const mentionResults = mentionQuery !== null
    ? users
        .filter(u => !u.is_bot && !u.deleted && (u.profile.display_name || u.real_name).toLowerCase().includes(mentionQuery.toLowerCase()))
        .slice(0, 8)
    : []

  /** Call from onChange with the new value, cursor position, and the input/textarea element. */
  const detectMention = useCallback((value: string, cursor: number, anchorEl: HTMLTextAreaElement | HTMLInputElement | null) => {
    const textBefore = value.slice(0, cursor)
    const atIdx = textBefore.lastIndexOf('@')
    if (atIdx === -1) { setMentionQuery(null); return }
    const query = textBefore.slice(atIdx + 1)
    if (query.includes(' ') || query.includes('\n')) { setMentionQuery(null); return }
    setMentionQuery(query)
    setMentionIdx(0)
    if (anchorEl) {
      // The dropdown's option list caps at 200px (scrolls beyond that), so a
      // fixed budget for header + list is enough to decide whether it fits
      // below the anchor — flip above when it doesn't (e.g. a compose box
      // pinned near the bottom of the viewport, like a chat input).
      const ESTIMATED_MAX_HEIGHT = 250
      const r = anchorEl.getBoundingClientRect()
      const spaceBelow = window.innerHeight - r.bottom
      const spaceAbove = r.top
      const openUpward = spaceBelow < ESTIMATED_MAX_HEIGHT && spaceAbove > spaceBelow
      setMentionDropStyle(
        openUpward
          ? { position: 'fixed', bottom: window.innerHeight - r.top + 4, left: r.left, width: Math.min(r.width, 320), zIndex: 9999 }
          : { position: 'fixed', top: r.bottom + 4, left: r.left, width: Math.min(r.width, 320), zIndex: 9999 }
      )
    }
  }, [])

  const dismissMention = useCallback(() => setMentionQuery(null), [])

  /** Replaces the "@query" run before the cursor with "@DisplayName ". Returns the new text + cursor, or null if there's no active mention. */
  const applyMention = useCallback((text: string, cursor: number, user: SlackWorkspaceUser): { text: string; cursor: number } | null => {
    const name = user.profile.display_name || user.real_name
    const textBefore = text.slice(0, cursor)
    const atIdx = textBefore.lastIndexOf('@')
    if (atIdx === -1) return null
    const next = `${text.slice(0, atIdx)}@${name} ${text.slice(cursor)}`
    return { text: next, cursor: atIdx + name.length + 2 }
  }, [])

  /** Wire this to onKeyDown on the input/textarea to get arrow/enter/escape navigation. Returns true if it handled the key. */
  const handleMentionKeyDown = useCallback((e: React.KeyboardEvent, onSelect: (u: SlackWorkspaceUser) => void): boolean => {
    if (mentionQuery === null || mentionResults.length === 0) return false
    if (e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault()
      setMentionIdx(i => (i + 1) % mentionResults.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setMentionIdx(i => (i - 1 + mentionResults.length) % mentionResults.length)
      return true
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onSelect(mentionResults[mentionIdx])
      return true
    }
    if (e.key === 'Escape') {
      setMentionQuery(null)
      return true
    }
    return false
  }, [mentionQuery, mentionResults, mentionIdx])

  return {
    mentionQuery, mentionResults, mentionIdx, mentionDropStyle,
    setMentionIdx, detectMention, dismissMention, applyMention, handleMentionKeyDown,
  }
}
