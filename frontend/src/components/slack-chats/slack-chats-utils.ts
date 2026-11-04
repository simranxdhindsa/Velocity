import { upperAmPm } from '@/components/ClockTimePicker'
import { slackEmojify } from '@/utils/slackEmoji'
import type { SlackChat, SlackChatMessage, SlackChatMode } from '@/services/api'

// Pure helpers for the admin Chats page (no React).

/** 12-hour time with uppercase AM/PM, e.g. "4:05 PM". */
export function chatTime(iso: string): string {
  return upperAmPm(new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }))
}

/** "Jan 5, 4:05 PM" style date and time, 12-hour. */
export function chatDateTime(iso: string): string {
  return upperAmPm(
    new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }),
  )
}

/** Short relative time for the people list. */
export function chatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  const h = Math.floor(ms / 3600000)
  const d = Math.floor(ms / 86400000)
  if (m < 1) return 'Now'
  if (m < 60) return `${m}m`
  if (h < 24) return `${h}h`
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Heading for a run of messages from the same day: Today, Yesterday, or "Mon, Nov 2". */
export function dayLabel(iso: string): string {
  const d = new Date(iso)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(new Date()) - startOf(d)) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** What to call a chat in the list: the person's name, else their email, else a placeholder. */
export function chatName(c: Pick<SlackChat, 'slack_user_name' | 'slack_user_email' | 'slack_user_id'>): string {
  return c.slack_user_name || c.slack_user_email || c.slack_user_id || 'Unknown person'
}

export const MODE_OPTIONS: Array<{ value: SlackChatMode; label: string; hint: string }> = [
  { value: 'smart', label: 'Smart', hint: 'The bot stays quiet while a chat Velocity started for you is open, and answers otherwise.' },
  { value: 'auto', label: 'Always answer', hint: 'The bot answers every message from this person, as it does for anyone else.' },
  { value: 'muted', label: 'Muted', hint: 'The bot never answers this person. You reply from here.' },
]

/**
 * Applies a thread's fresh details to its list row. The thread answer has no preview, and may have
 * no name or photo if Slack could not be asked, so those keep what the list already knows.
 */
export function mergeConversation(row: SlackChat, conv: SlackChat): SlackChat {
  return {
    ...row,
    ...conv,
    last_preview: row.last_preview,
    last_kind: row.last_kind,
    last_direction: row.last_direction,
    slack_user_name: conv.slack_user_name || row.slack_user_name,
    slack_user_image: conv.slack_user_image || row.slack_user_image,
  }
}

/** Who a message is from and how it should look: the person, a Velocity user, or Velocity itself. */
export type BubbleSide = 'them' | 'you' | 'bot'

export function bubbleSide(m: SlackChatMessage): BubbleSide {
  if (m.kind === 'human') return 'them'
  if (m.kind === 'claude' || m.kind === 'dashboard') return 'you'
  return 'bot'
}

/** True when two neighbouring messages come from the same author, so the photo shows only once. */
export function sameAuthor(a: SlackChatMessage, b: SlackChatMessage): boolean {
  return bubbleSide(a) === bubbleSide(b) && a.author_label === b.author_label
}

/** A caption only when the speaker or the way it was sent changes, so a run of messages stays clean. */
export function needsCaption(prev: SlackChatMessage | undefined, m: SlackChatMessage): boolean {
  return !prev || !sameAuthor(prev, m) || prev.kind !== m.kind
}

/** The small caption above a bubble. */
export function bubbleCaption(m: SlackChatMessage): string {
  switch (m.kind) {
    case 'claude': return `${m.author_label} via Claude`
    case 'dashboard': return `${m.author_label} from the dashboard`
    case 'auto_reply': return 'Velocity (automatic reply)'
    case 'ack': return 'Velocity (passed this on)'
    case 'notice': return 'Velocity (alert to you)'
    default: return m.author_label
  }
}

/** Preview line for the people list: "You: ..." for what you sent, "Velocity: ..." for the bot. */
export function previewLine(c: SlackChat): string {
  if (!c.last_preview) return ''
  const flat = slackEmojify(c.last_preview).replace(/\s+/g, ' ')
  if (c.last_kind === 'claude' || c.last_kind === 'dashboard') return `You: ${flat}`
  if (c.last_kind === 'auto_reply' || c.last_kind === 'ack' || c.last_kind === 'notice') return `Velocity: ${flat}`
  return flat
}
