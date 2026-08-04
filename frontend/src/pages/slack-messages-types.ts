import type { SentSlackMessage, SentSlackMessageSource, LiveSlackMessage } from '@/services/api'
import { upperAmPm } from '@/components/ClockTimePicker'

export interface HubChannel {
  id: string
  name: string
  is_private: boolean
  is_member: boolean
}

// ── Source labels/colors — the small pill shown next to each message ──────────

const SOURCE_META: Record<SentSlackMessageSource, { label: string; color: string }> = {
  claude_queue:         { label: 'Claude Queue',    color: 'var(--color-primary)' },
  quick_send:           { label: 'Quick Send',      color: 'var(--color-accent)' },
  rules:                { label: 'Rules',           color: 'var(--color-secondary)' },
  blocker_alert:        { label: 'Blocker Alert',   color: 'var(--color-danger)' },
  time_threshold_alert: { label: 'Time Alert',      color: 'var(--color-warning)' },
  daily_digest:         { label: 'Daily Digest',    color: 'var(--color-success)' },
  standup:              { label: 'Standup',         color: 'var(--color-accent)' },
  daytrack:             { label: 'DayTrack',        color: 'var(--color-primary)' },
  report:               { label: 'Report',          color: 'var(--color-secondary)' },
  hub:                  { label: 'Sent manually',   color: 'var(--text-muted)' },
}

export function sourceLabel(source: SentSlackMessageSource): string {
  return SOURCE_META[source]?.label ?? source
}

export function sourceColor(source: SentSlackMessageSource): string {
  return SOURCE_META[source]?.color ?? 'var(--text-muted)'
}

// ── Date grouping — mirrors Slack's date-divider chips ─────────────────────────

export function dayKey(iso: string): string {
  const d = new Date(iso)
  return d.toISOString().slice(0, 10)
}

export function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

export function groupByDay(messages: SentSlackMessage[]): Array<{ key: string; label: string; items: SentSlackMessage[] }> {
  const groups: Record<string, SentSlackMessage[]> = {}
  for (const m of messages) {
    const key = dayKey(m.sent_at)
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }
  return Object.keys(groups)
    .sort()
    .map(key => ({
      key,
      label: dayLabel(groups[key][0].sent_at),
      items: groups[key].sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime()),
    }))
}

// ── Slack mrkdwn → lightweight formatting ───────────────────────────────────────
// Slack uses single-asterisk *bold*, single-underscore _italic_, backtick `code`
// and triple-backtick code blocks — not GitHub-flavored markdown.

export interface MrkdwnToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock'
  content: string
}

export function parseMrkdwn(text: string): MrkdwnToken[] {
  const tokens: MrkdwnToken[] = []
  const re = /```([\s\S]+?)```|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) tokens.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    if (match[1] !== undefined) tokens.push({ type: 'codeblock', content: match[1] })
    else if (match[2] !== undefined) tokens.push({ type: 'code', content: match[2] })
    else if (match[3] !== undefined) tokens.push({ type: 'bold', content: match[3] })
    else if (match[4] !== undefined) tokens.push({ type: 'italic', content: match[4] })
    lastIndex = re.lastIndex
  }
  if (lastIndex < text.length) tokens.push({ type: 'text', content: text.slice(lastIndex) })
  return tokens
}

export function timeLabel(iso: string): string {
  return upperAmPm(new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
}

export function channelIcon(isPrivate: boolean): string {
  return isPrivate ? '🔒' : '#'
}

// ── Live channel messages — Slack ts is "<seconds>.<micros>", not ISO ──────────

export function tsToDate(ts: string): Date {
  return new Date(parseFloat(ts) * 1000)
}

export function tsTimeLabel(ts: string): string {
  return upperAmPm(tsToDate(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
}

export function groupLiveByDay(messages: LiveSlackMessage[]): Array<{ key: string; label: string; items: LiveSlackMessage[] }> {
  const groups: Record<string, LiveSlackMessage[]> = {}
  for (const m of messages) {
    const key = tsToDate(m.ts).toISOString().slice(0, 10)
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }
  return Object.keys(groups)
    .sort()
    .map(key => ({
      key,
      label: dayLabel(tsToDate(groups[key][0].ts).toISOString()),
      items: groups[key].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts)),
    }))
}
