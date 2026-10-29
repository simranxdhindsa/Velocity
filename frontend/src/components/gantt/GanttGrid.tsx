import React, { useCallback, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  type GanttIssue, type GanttView, type GanttRow, type GanttIssueRow, type GanttGroupRow, DAY_PX,
  addDays, diffDays, fmtDayLabel, fmtMonth, fmtWeekRange, isWeekend, barRect, roleColor, rowKey, startOfDay, msToDate,
} from '../../pages/gantt-types'

// ── Constants ────────────────────────────────────────────────────────────────

const ROW_H = 38          // px per row (table and timeline)
const HDR_H = 60          // timeline header: week/month tier + day tier
const MS_DAY = 86_400_000
/** Narrower bars put their label to the right of the bar. */
const LABEL_INSIDE_MIN = 110

type DragMode = 'move' | 'resize-left' | 'resize-right'

// ── Header builders ──────────────────────────────────────────────────────────

function buildDayColumns(viewStart: Date, totalDays: number, view: GanttView) {
  const today = startOfDay(new Date()).getTime()
  return Array.from({ length: totalDays }, (_, i) => {
    const d = addDays(viewStart, i)
    const isToday = d.getTime() === today
    // Month scale is too narrow for every date: label Mondays and today only
    const label = view === 'month' && d.getDay() !== 1 && !isToday ? '' : fmtDayLabel(d, view)
    return { label, weekend: isWeekend(d), today: isToday }
  })
}

/** Top tier: weeks ("W42 Oct 12 - 18") for day/week scale, months for month scale. */
function buildGroupHeaders(viewStart: Date, totalDays: number, view: GanttView) {
  const dayPx = DAY_PX[view]
  const groups: { label: string; width: number }[] = []
  let cur = viewStart
  let i = 0
  while (i < totalDays) {
    let label: string
    let end: Date
    if (view === 'month') {
      label = fmtMonth(cur)
      end = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
    } else {
      const monday = addDays(cur, -((cur.getDay() + 6) % 7))
      label = fmtWeekRange(monday)
      end = addDays(monday, 7)
    }
    const endDay = Math.min(diffDays(viewStart, end), totalDays)
    groups.push({ label, width: (endDay - i) * dayPx })
    cur = end
    i = endDay
  }
  return groups
}

/** New start/due after dragging `days` in `mode`. */
function shiftDates(issue: GanttIssue, mode: DragMode, days: number) {
  let start = issue.startDate
  let due = issue.dueDate
  if (mode === 'move') {
    if (start) start += days * MS_DAY
    if (due) due += days * MS_DAY
  } else if (mode === 'resize-right') {
    const base = due ?? start
    if (base) due = Math.max(base + days * MS_DAY, start ?? 0)
  } else {
    const base = start ?? due
    if (base) start = Math.min(base + days * MS_DAY, due ?? Infinity)
  }
  return { startDate: start, dueDate: due }
}

// ── Bars ─────────────────────────────────────────────────────────────────────

interface BarProps {
  row: GanttIssueRow
  viewStart: Date
  dayPx: number
  editMode: boolean
  onDragStart: (e: React.MouseEvent, issue: GanttIssue, mode: DragMode) => void
  onConnectStart?: (e: React.MouseEvent, memberId: string) => void
  onClick: (row: GanttIssueRow) => void
}

const GanttBar = React.memo(function GanttBar({
  row, viewStart, dayPx, editMode, onDragStart, onConnectStart, onClick,
}: BarProps) {
  const { issue, progress } = row
  const rect = barRect(issue.startDate, issue.dueDate, viewStart, dayPx)
  if (!rect) return null
  return (
    <div
      className={`gt-bar${editMode ? ' gt-bar--edit' : ''}${rect.width < LABEL_INSIDE_MIN ? ' gt-bar--label-out' : ''}`}
      style={{ left: rect.left, width: rect.width, '--bar-color': roleColor(row.role), '--bar-progress': `${progress}%` } as React.CSSProperties}
      title={`${issue.idReadable} ${issue.summary} (${progress}%)`}
      onClick={editMode ? undefined : () => onClick(row)}
      onMouseDown={editMode ? e => onDragStart(e, issue, 'move') : undefined}
    >
      <span className="gt-bar-label">{issue.summary}</span>
      {editMode && (
        <>
          <span className="gt-bar-handle gt-bar-handle--left" onMouseDown={e => { e.stopPropagation(); onDragStart(e, issue, 'resize-left') }} />
          <span className="gt-bar-handle gt-bar-handle--right" onMouseDown={e => { e.stopPropagation(); onDragStart(e, issue, 'resize-right') }} />
          {onConnectStart && (
            <span
              className="gt-connect-dot"
              title="Drag to another bar to add a dependency"
              onMouseDown={e => { e.stopPropagation(); onConnectStart(e, issue.memberId) }}
            />
          )}
        </>
      )}
    </div>
  )
})

/** Thin summary line spanning a group's tickets, with its progress. */
const GroupBar = React.memo(function GroupBar({ row, viewStart, dayPx }: { row: GanttGroupRow; viewStart: Date; dayPx: number }) {
  const rect = barRect(row.startDate, row.dueDate, viewStart, dayPx)
  if (!rect) return null
  return (
    <div className="gt-sum" style={{ left: rect.left, width: rect.width, '--bar-progress': `${row.progress}%` } as React.CSSProperties}>
      <span className="gt-sum-pct">{row.progress}%</span>
    </div>
  )
})

/** Edge arrow for a bar scrolled out of view; clicking scrolls to it. */
function OffscreenHint({ issue, viewStart, visible, onJump }: {
  issue: GanttIssue
  viewStart: Date
  visible: { from: number; to: number }
  onJump: (day: number) => void
}) {
  const s = issue.startDate ?? issue.dueDate
  const e = issue.dueDate ?? issue.startDate
  if (!s || !e) return null
  const startDay = diffDays(viewStart, msToDate(s))
  const endDay = diffDays(viewStart, msToDate(e))
  const mid = (startDay + endDay) / 2
  if (endDay < visible.from) {
    return <button className="gt-off gt-off--left" onClick={() => onJump(mid)} aria-label={`Scroll to ${issue.idReadable}`}><ChevronLeft size={13} /></button>
  }
  if (startDay > visible.to) {
    return <button className="gt-off gt-off--right" onClick={() => onJump(mid)} aria-label={`Scroll to ${issue.idReadable}`}><ChevronRight size={13} /></button>
  }
  return null
}

// ── GanttGrid ────────────────────────────────────────────────────────────────

interface Props {
  rows: GanttRow[]
  viewStart: Date
  totalDays: number
  view: GanttView
  editMode: boolean
  onUpdateDates: (memberId: string, startMs: number | null, dueMs: number | null) => void
  onConnectStart: (e: React.MouseEvent, memberId: string) => void
  onIssueClick: (row: GanttIssueRow) => void
  /** Day indexes currently on screen, for the off-screen arrows. */
  visible: { from: number; to: number }
  onJump: (day: number) => void
}

export function GanttGrid({
  rows, viewStart, totalDays, view, editMode, onUpdateDates, onConnectStart, onIssueClick, visible, onJump,
}: Props) {
  const dayPx = DAY_PX[view]
  const totalW = totalDays * dayPx
  // Live position of the bar being dragged, so it follows the mouse.
  const [preview, setPreview] = useState<{ memberId: string; startDate: number | null; dueDate: number | null } | null>(null)

  const dayCols = useMemo(() => buildDayColumns(viewStart, totalDays, view), [viewStart, totalDays, view])
  const groupHdrs = useMemo(() => buildGroupHeaders(viewStart, totalDays, view), [viewStart, totalDays, view])
  const todayIdx = diffDays(viewStart, new Date())

  const handleDragStart = useCallback((e: React.MouseEvent, issue: GanttIssue, mode: DragMode) => {
    if (!editMode) return
    e.preventDefault()
    const startX = e.clientX
    const days = (ev: MouseEvent) => Math.round((ev.clientX - startX) / dayPx)
    const onMove = (ev: MouseEvent) => {
      setPreview({ memberId: issue.memberId, ...shiftDates(issue, mode, days(ev)) })
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setPreview(null)
      const d = days(ev)
      if (d !== 0) {
        const next = shiftDates(issue, mode, d)
        onUpdateDates(issue.memberId, next.startDate, next.dueDate)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [editMode, dayPx, onUpdateDates])

  return (
    <div className="gt-grid-wrap">
      <div className="gt-hdr" style={{ width: totalW, height: HDR_H }}>
        <div className="gt-hdr-groups">
          {groupHdrs.map((g, i) => (
            <div key={i} className="gt-hdr-group" style={{ width: g.width }}><span>{g.label}</span></div>
          ))}
        </div>
        <div className="gt-hdr-days">
          {dayCols.map((c, i) => (
            <div
              key={i}
              className={`gt-hdr-day${c.weekend ? ' gt-hdr-day--weekend' : ''}${c.today ? ' gt-hdr-day--today' : ''}`}
              style={{ width: dayPx }}
            >
              <span>{c.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="gt-canvas" style={{ width: totalW, height: Math.max(rows.length * ROW_H, 1) }}>
        {dayCols.map((c, i) => (
          <div key={i} className={`gt-col${c.weekend ? ' gt-col--weekend' : ''}`} style={{ left: i * dayPx, width: dayPx }} />
        ))}

        {rows.map((r, idx) => {
          if (r.kind === 'group') {
            return (
              <div key={rowKey(r)} className="gt-row gt-row--group" style={{ top: idx * ROW_H, height: ROW_H }}>
                <GroupBar row={r} viewStart={viewStart} dayPx={dayPx} />
              </div>
            )
          }
          const p = preview?.memberId === r.issue.memberId ? preview : null
          const shown = p ? { ...r, issue: { ...r.issue, startDate: p.startDate, dueDate: p.dueDate } } : r
          return (
            <div key={rowKey(r)} className="gt-row" style={{ top: idx * ROW_H, height: ROW_H }}>
              <GanttBar
                row={shown}
                viewStart={viewStart}
                dayPx={dayPx}
                editMode={editMode}
                onDragStart={handleDragStart}
                onConnectStart={editMode ? onConnectStart : undefined}
                onClick={onIssueClick}
              />
              <OffscreenHint issue={shown.issue} viewStart={viewStart} visible={visible} onJump={onJump} />
            </div>
          )
        })}

        {todayIdx >= 0 && todayIdx < totalDays && (
          <div className="gt-today-line" style={{ left: todayIdx * dayPx + dayPx / 2 }} />
        )}
      </div>
    </div>
  )
}

export { ROW_H, HDR_H }
