// Dev Activity → Activity Feed roster: everyone active in the range as one table, with a
// live status dot, what they're on now, and their numbers. Clicking a row filters the
// timeline below to that person. Design based on @ln-dev7/member-list (21st.dev),
// rebuilt without Radix/date-fns and with spacing in CSS (Tailwind p-/m- don't apply here).
import { memo } from 'react'
import { DaAvatar } from './DevActivityShared'

export type RosterStatus = 'working' | 'blocked' | 'idle'

export interface RosterRow {
  name: string
  status: RosterStatus
  /** "Working on ARD-3065", or their latest update */
  subtitle: string
  updates: number
  done: number
  blocked: number
  lastAt: number
}

const STATUS_LABEL: Record<RosterStatus, string> = {
  working: 'Working on a ticket now',
  blocked: 'Has blocked tickets',
  idle: 'Nothing in progress',
}

const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function lastActiveLabel(at: number, now: number): string {
  if (!at) return 'None'
  const m = Math.max(0, Math.floor((now - at) / 60_000))
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  if (h < 48) return 'Yesterday'
  return dayFmt.format(new Date(at))
}

const RosterLine = memo(function RosterLine({ row, selected, now, onSelect }: {
  row: RosterRow
  selected: boolean
  now: number
  onSelect: (name: string) => void
}) {
  return (
    <button
      className={`dar-row${selected ? ' dar-row--selected' : ''}`}
      onClick={() => onSelect(row.name)}
      aria-pressed={selected}
      title={selected ? 'Show everyone' : `Show only ${row.name}`}
    >
      <span className="dar-who">
        <span className="dar-avatar">
          <DaAvatar name={row.name} size={32} />
          <span className={`dar-dot dar-dot--${row.status}`} title={STATUS_LABEL[row.status]}>
            <span className="sr-only">{STATUS_LABEL[row.status]}</span>
          </span>
        </span>
        <span className="dar-name-col">
          <span className="dar-name">{row.name}</span>
          <span className="dar-sub">{row.subtitle}</span>
        </span>
      </span>
      <span className="dar-col dar-num">{row.updates}</span>
      <span className={`dar-col dar-num${row.done ? ' dar-done' : ' dar-zero'}`}>{row.done}</span>
      <span className={`dar-col dar-num${row.blocked ? ' dar-blocked' : ' dar-zero'}`}>{row.blocked}</span>
      <span className="dar-col dar-last">{lastActiveLabel(row.lastAt, now)}</span>
    </button>
  )
})

export function DevActivityRoster({ rows, selected, now, onSelect }: {
  rows: RosterRow[]
  selected: string
  now: number
  onSelect: (name: string) => void
}) {
  return (
    <div className="dar-wrap" role="group" aria-label="Team members, click one to filter the timeline">
      <div className="dar-head">
        <span className="dar-who">Member</span>
        <span className="dar-col dar-num">Updates</span>
        <span className="dar-col dar-num" title="Tickets they moved to dev done in this period">Finished</span>
        <span className="dar-col dar-num" title="Tickets blocked right now">Blocked now</span>
        <span className="dar-col dar-last">Last active</span>
      </div>
      <div className="dar-body">
        {rows.map(r => (
          <RosterLine key={r.name} row={r} selected={selected === r.name} now={now} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

/** Skeleton for the roster, same row geometry. */
export function DevActivityRosterSkeleton() {
  const W = [55, 70, 48, 65, 58]
  return (
    <div className="dar-wrap">
      <div className="dar-head">
        <span className="dar-who"><span className="skeleton dar-sk dar-sk-h" /></span>
        {Array.from({ length: 4 }).map((_, i) => <span key={i} className="dar-col"><span className="skeleton dar-sk dar-sk-h" /></span>)}
      </div>
      <div className="dar-body">
        {W.map((w, i) => (
          <div key={i} className="dar-row dar-row--sk">
            <span className="dar-who">
              <span className="skeleton dar-sk-av" />
              <span className="dar-name-col">
                <span className="skeleton dar-sk" style={{ width: `${w}%`, height: 12 }} />
                <span className="skeleton dar-sk" style={{ width: `${w + 15}%`, height: 10 }} />
              </span>
            </span>
            {Array.from({ length: 4 }).map((_, k) => <span key={k} className="dar-col"><span className="skeleton dar-sk dar-sk-n" /></span>)}
          </div>
        ))}
      </div>
    </div>
  )
}
