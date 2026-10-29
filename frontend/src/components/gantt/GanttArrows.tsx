import React from 'react'
import { type GanttIssue, type GanttDependency, type GanttView, type GanttRow, DAY_PX, barRect } from '../../pages/gantt-types'
import { ROW_H } from './GanttGrid'

interface ArrowPoint { x: number; y: number }

function barEndpoints(
  issue: GanttIssue,
  rowIdx: number,
  viewStart: Date,
  dayPx: number
): { right: ArrowPoint; left: ArrowPoint } | null {
  const rect = barRect(issue.startDate, issue.dueDate, viewStart, dayPx)
  if (!rect) return null
  const midY = rowIdx * ROW_H + ROW_H / 2
  return {
    right: { x: rect.left + rect.width, y: midY },
    left:  { x: rect.left, y: midY },
  }
}

function cubicPath(from: ArrowPoint, to: ArrowPoint): string {
  const dx = Math.abs(to.x - from.x)
  const cx = Math.max(dx * 0.4, 40)
  return `M ${from.x} ${from.y} C ${from.x + cx} ${from.y}, ${to.x - cx} ${to.y}, ${to.x} ${to.y}`
}

interface Props {
  rows: GanttRow[]
  dependencies: GanttDependency[]
  viewStart: Date
  view: GanttView
  totalDays: number
  editMode: boolean
  // Connect-draw state
  connectingFrom: string | null
  connectMousePos: { x: number; y: number } | null
  onConnectEnd: (targetId: string) => void
  onRemoveDep: (dep: GanttDependency) => void
}

export function GanttArrows({
  rows, dependencies, viewStart, view, totalDays, editMode,
  connectingFrom, connectMousePos, onConnectEnd, onRemoveDep,
}: Props) {
  const dayPx = DAY_PX[view]
  const totalH = rows.length * ROW_H
  // Dependencies use gantt member IDs. Index visible issue rows by memberId;
  // tickets inside a collapsed group have no row, so their arrows are hidden.
  const idxMap = new Map<string, number>()
  const issues: GanttIssue[] = []
  rows.forEach((r, i) => {
    if (r.kind === 'issue') { idxMap.set(r.issue.memberId, i); issues[i] = r.issue }
  })

  const arrows = dependencies.flatMap(dep => {
    const srcIdx = idxMap.get(dep.sourceId)
    const tgtIdx = idxMap.get(dep.targetId)
    if (srcIdx === undefined || tgtIdx === undefined) return []
    const srcIssue = issues[srcIdx]
    const tgtIssue = issues[tgtIdx]
    const srcPts = barEndpoints(srcIssue, srcIdx, viewStart, dayPx)
    const tgtPts = barEndpoints(tgtIssue, tgtIdx, viewStart, dayPx)
    if (!srcPts || !tgtPts) return []
    return [{ dep, path: cubicPath(srcPts.right, tgtPts.left) }]
  })

  // Live draw line (while dragging a connection)
  let livePath: string | null = null
  if (connectingFrom && connectMousePos) {
    const srcIdx = idxMap.get(connectingFrom)
    if (srcIdx !== undefined) {
      const srcIssue = issues[srcIdx]
      const srcPts = barEndpoints(srcIssue, srcIdx, viewStart, dayPx)
      if (srcPts) {
        livePath = cubicPath(srcPts.right, connectMousePos)
      }
    }
  }

  return (
    <svg
      className="gt-arrows"
      style={{ width: totalDays * dayPx, height: totalH, pointerEvents: editMode ? 'all' : 'none' }}
    >
      <defs>
        <marker id="gt-arrow-head" markerWidth="8" markerHeight="8"
          refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill="var(--color-danger)" />
        </marker>
        <marker id="gt-arrow-head-dim" markerWidth="8" markerHeight="8"
          refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill="var(--text-muted)" />
        </marker>
      </defs>

      {arrows.map(({ dep, path }) => (
        <g key={`${dep.sourceId}-${dep.targetId}`}>
          {/* Wider invisible hit area for click-to-remove */}
          {editMode && (
            <path
              d={path} fill="none" stroke="transparent" strokeWidth={12}
              style={{ cursor: 'pointer' }}
              onClick={() => onRemoveDep(dep)}
            />
          )}
          <path
            d={path} fill="none"
            stroke="var(--color-danger)"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            markerEnd="url(#gt-arrow-head)"
            opacity={0.8}
          />
        </g>
      ))}

      {/* Live draw arrow */}
      {livePath && (
        <path
          d={livePath} fill="none"
          stroke="var(--color-primary)"
          strokeWidth={1.5}
          strokeDasharray="5 3"
          markerEnd="url(#gt-arrow-head-dim)"
          opacity={0.6}
        />
      )}

      {/* Drop targets: left edge of each bar while connecting */}
      {editMode && connectingFrom && issues.map((issue, i) => {
        if (!issue || issue.memberId === connectingFrom) return null
        const rect = barRect(issue.startDate, issue.dueDate, viewStart, dayPx)
        if (!rect) return null
        const y = i * ROW_H
        return (
          <rect
            key={issue.memberId}
            x={rect.left - 8} y={y + 4} width={16} height={ROW_H - 8}
            fill="rgba(var(--color-primary-rgb),0.15)"
            stroke="var(--color-primary)"
            strokeWidth={1}
            rx={4}
            style={{ cursor: 'crosshair' }}
            onMouseUp={() => onConnectEnd(issue.memberId)}
          />
        )
      })}
    </svg>
  )
}
