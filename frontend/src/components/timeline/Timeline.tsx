// Timeline: a vertical activity feed grouped by day, with expandable rows, a connector
// line that draws itself as rows come into view, and pinned day headings.
// Based on @kuratlielia/timeline (21st.dev). Rewritten without per-row framer-motion
// (CLAUDE.md rule 8: feeds have hundreds of rows): one shared IntersectionObserver
// stamps rows as revealed and CSS (timeline.css) does the marker pop, line draw and expand.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { upperAmPm } from '@/components/ClockTimePicker'
import '../../styles/components/timeline.css'

export interface TimelineEvent {
  id: string
  /** When it happened, ISO string or epoch ms. */
  at: string | number
  /** Who did it, shown first and emphasised. */
  actor?: string
  /** What happened, completing the actor: "moved ARD-12 to Dev". */
  title: ReactNode
  /** Short context under the title. */
  meta?: ReactNode
  /** Shown in place when the row is expanded. Rows without detail are not interactive. */
  detail?: ReactNode
  /** Marker content: an avatar/initials badge or an icon. */
  icon?: ReactNode
  /** Marker ring colour. Always say the outcome in the title too, so it never rests on colour alone. */
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent'
}

export interface TimelineProps {
  events: TimelineEvent[]
  /** Reference time for relative labels and Today/Yesterday, epoch ms. */
  now: number
  /** Accessible name for the feed. */
  label: string
  /** Text shown when there are no events. */
  empty?: ReactNode
  className?: string
}

type Row = TimelineEvent & { time: number }
type Group = { day: string; label: string; rows: Row[] }

const HOUR = 3_600_000
const STEP = 0.07 // seconds between rows revealed together, so the line reads as drawing downward

const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

const clockFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
const fullFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
const headFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

function relative(time: number, now: number) {
  const m = Math.max(0, Math.floor((now - time) / 60_000))
  if (m < 1) return 'Now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

interface RowProps {
  row: Row
  last: boolean
  expanded: boolean
  onToggle: (id: string) => void
  timeLabel: string
  timeFull: string
}

const TimelineRow = memo(function TimelineRow({ row, last, expanded, onToggle, timeLabel, timeFull }: RowProps) {
  const interactive = !!row.detail
  const Trigger = interactive ? 'button' : 'div'
  return (
    <li className="tl-item" data-tl-row="">
      <span className="tl-marker" data-tone={row.tone ?? 'neutral'} aria-hidden="true">{row.icon}</span>
      {!last && <span className="tl-segment" aria-hidden="true" />}
      <div className="tl-content">
        <Trigger
          className={`tl-trigger${interactive ? ' tl-trigger--interactive' : ''}`}
          {...(interactive ? { type: 'button' as const, 'data-tl-trigger': '', 'aria-expanded': expanded, onClick: () => onToggle(row.id) } : {})}
        >
          <span className="tl-text">
            <span className="tl-title">
              {row.actor && <span className="tl-actor">{row.actor}</span>}
              {row.actor ? ' ' : ''}{row.title}
            </span>
            {row.meta && <span className="tl-meta">{row.meta}</span>}
          </span>
          <time className="tl-time" dateTime={new Date(row.time).toISOString()} title={timeFull}>{timeLabel}</time>
          {interactive && <ChevronDown size={15} strokeWidth={1.75} className={`tl-chevron${expanded ? ' tl-chevron--open' : ''}`} aria-hidden="true" />}
        </Trigger>
        {expanded && row.detail && <div className="tl-detail">{row.detail}</div>}
      </div>
    </li>
  )
})

export function Timeline({ events, now, label, empty, className }: TimelineProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const rootRef = useRef<HTMLDivElement>(null)

  const groups = useMemo<Group[]>(() => {
    const today = dayKey(now)
    const yesterday = dayKey(now - 24 * HOUR)
    const byDay = new Map<string, Row[]>()
    events
      .map(e => ({ ...e, time: new Date(e.at).getTime() }))
      .filter(e => Number.isFinite(e.time))
      .sort((a, b) => b.time - a.time)
      .forEach(e => {
        const k = dayKey(e.time)
        const list = byDay.get(k)
        if (list) list.push(e)
        else byDay.set(k, [e])
      })
    return [...byDay].map(([day, rows]) => ({
      day,
      rows,
      label: day === today ? 'Today' : day === yesterday ? 'Yesterday' : headFmt.format(new Date(rows[0].time)),
    }))
  }, [events, now])

  // One observer for every row: stamp it revealed the first time it scrolls into view, spacing rows
  // that arrive together a beat apart. CSS reads --tl-delay and [data-shown] for the pop + line draw.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    let next = 0
    const io = new IntersectionObserver(entries => {
      const t = performance.now() / 1000
      for (const en of entries) {
        if (!en.isIntersecting) continue
        const el = en.target as HTMLElement
        const start = Math.min(Math.max(t, next), t + 0.45)
        next = start + STEP
        el.style.setProperty('--tl-delay', `${(start - t).toFixed(2)}s`)
        el.dataset.shown = ''
        io.unobserve(el)
      }
    }, { threshold: 0.2 })
    root.querySelectorAll<HTMLElement>('[data-tl-row]:not([data-shown])').forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [groups])

  const toggle = useCallback((id: string) => {
    setExpanded(cur => {
      const n = new Set(cur)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])

  // Arrow keys move between rows, Home/End jump; Enter/Space expand (native button).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const triggers = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-tl-trigger]') ?? [])]
    const i = triggers.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? triggers.length - 1
      : Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), triggers.length - 1)
    triggers[n]?.focus()
  }

  return (
    <div ref={rootRef} className={['tl-root', className].filter(Boolean).join(' ')} role="region" aria-label={label} onKeyDown={onKeyDown}>
      {groups.length === 0 && empty}
      {groups.map(g => (
        <section key={g.day} className="tl-group" aria-label={`${g.label}, ${g.rows.length} ${g.rows.length === 1 ? 'update' : 'updates'}`}>
          <div className="tl-day">
            <span>{g.label}</span>
            <span className="tl-count">{g.rows.length} {g.rows.length === 1 ? 'update' : 'updates'}</span>
          </div>
          <ol className="tl-list">
            {g.rows.map((row, i) => {
              const recent = g.label === 'Today' && now - row.time < 12 * HOUR
              return (
                <TimelineRow
                  key={row.id}
                  row={row}
                  last={i === g.rows.length - 1}
                  expanded={expanded.has(row.id)}
                  onToggle={toggle}
                  timeLabel={recent ? relative(row.time, now) : upperAmPm(clockFmt.format(new Date(row.time)))}
                  timeFull={upperAmPm(fullFmt.format(new Date(row.time)))}
                />
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}

export default Timeline
