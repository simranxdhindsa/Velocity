import { useState, useCallback, memo } from 'react'
import {
  DndContext, DragOverlay, closestCorners,
  KeyboardSensor, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import type { DragStartEvent, DragOverEvent, DragEndEvent } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { ChevronRight, Users, ArrowUpNarrowWide, Rows3 } from 'lucide-react'
import { KanbanColumn } from './KanbanColumn'
import type { YouTrackIssue } from '../../services/api'

interface ColPaginationState {
  skip: number
  hasMore: boolean
  loading: boolean
}

type SwimlaneBy = 'none' | 'assignee' | 'priority' | 'board'

interface BoardSwimlaneField {
  field_name: string
  values: { name: string; background?: string; foreground?: string }[]
}

interface KanbanBoardProps {
  issues: YouTrackIssue[]
  columns: string[]
  avatarMap: Record<string, string>
  priorityColorMap?: Record<string, string>
  swimlaneBy?: SwimlaneBy
  boardSwimlaneField?: BoardSwimlaneField
  getColumnIssues: (col: string, laneKey?: string) => YouTrackIssue[]
  onIssueMove: (issueId: string, newState: string) => void
  onIssueClick?: (issue: YouTrackIssue) => void
  getExtraClass?: (issue: YouTrackIssue) => string
  colPagination?: Record<string, ColPaginationState>
  onLoadMore?: (col: string) => void
}

// Extract the lane key for a given grouping mode
function laneKeyForIssue(issue: YouTrackIssue, by: SwimlaneBy, boardField?: BoardSwimlaneField): string {
  if (by === 'assignee') return issue.assignee?.fullName || issue.assignee?.login || 'Unassigned'
  if (by === 'priority') return issue.priority || 'No Priority'
  if (by === 'board' && boardField) {
    const fn = boardField.field_name.toLowerCase()
    if (fn === 'subsystem') return issue.subsystem || 'Uncategorized'
    if (fn === 'priority') return issue.priority || 'No Priority'
    if (fn === 'type') return issue.type || 'Uncategorized'
    // Generic fallback: check swimlane_value if pre-populated
    return issue.swimlane_value || 'Uncategorized'
  }
  return ''
}

// Build ordered lane keys — preserve the order from boardField.values when available
function buildLanes(issues: YouTrackIssue[], by: SwimlaneBy, boardField?: BoardSwimlaneField): string[] {
  if (by === 'none') return []

  // For board mode, use the ordered values from the board config as the canonical order
  if (by === 'board' && boardField?.values?.length) {
    const fromBoard = boardField.values.map(v => v.name)
    const inIssues = new Set(issues.map(i => laneKeyForIssue(i, by, boardField)))
    const fallback = 'Uncategorized'
    const ordered = fromBoard.filter(k => inIssues.has(k))
    if (inIssues.has(fallback) && !ordered.includes(fallback)) ordered.push(fallback)
    return ordered
  }

  const seen = new Set<string>()
  const keys: string[] = []
  for (const issue of issues) {
    const key = laneKeyForIssue(issue, by, boardField)
    if (!seen.has(key)) { seen.add(key); keys.push(key) }
  }
  const fallback = by === 'assignee' ? 'Unassigned' : 'No Priority'
  return [...keys.filter(k => k !== fallback), ...(seen.has(fallback) ? [fallback] : [])]
}

// ── Swimlane row header ──────────────────────────────────────────────────────
interface SwimLaneHeaderProps {
  laneKey: string
  by: SwimlaneBy
  count: number
  collapsed: boolean
  onToggle: () => void
  avatarMap: Record<string, string>
  priorityColorMap?: Record<string, string>
  boardSwimlaneField?: BoardSwimlaneField
}

const SwimLaneHeader = memo(function SwimLaneHeader({
  laneKey, by, count, collapsed, onToggle, avatarMap, priorityColorMap, boardSwimlaneField,
}: SwimLaneHeaderProps) {
  const isFallback = laneKey === 'Unassigned' || laneKey === 'No Priority' || laneKey === 'Uncategorized'
  const avatarUrl = by === 'assignee' && !isFallback ? avatarMap[laneKey] : undefined
  const priorityColor = by === 'priority' && !isFallback ? priorityColorMap?.[laneKey] : undefined
  const boardFieldColor = by === 'board' && !isFallback
    ? boardSwimlaneField?.values.find(v => v.name === laneKey)?.background
    : undefined

  const initials = laneKey.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()

  return (
    <button className="swimlane-header" onClick={onToggle} aria-expanded={!collapsed}>
      <ChevronRight
        size={14}
        className={`swimlane-chevron${collapsed ? '' : ' swimlane-chevron--open'}`}
      />

      {/* Lane icon */}
      {by === 'assignee' && !isFallback && (
        avatarUrl
          ? <img src={avatarUrl} alt={laneKey} className="swimlane-avatar" />
          : <div className="swimlane-avatar swimlane-avatar--initials">{initials}</div>
      )}
      {by === 'assignee' && isFallback && (
        <div className="swimlane-icon-wrap"><Users size={13} /></div>
      )}
      {by === 'priority' && priorityColor && (
        <span className="board-priority-dot" style={{ background: priorityColor }} />
      )}
      {by === 'priority' && !priorityColor && (
        <div className="swimlane-icon-wrap"><ArrowUpNarrowWide size={13} /></div>
      )}
      {by === 'board' && boardFieldColor && (
        <span className="board-priority-dot" style={{ background: boardFieldColor }} />
      )}
      {by === 'board' && !boardFieldColor && !isFallback && (
        <div className="swimlane-icon-wrap"><Rows3 size={13} /></div>
      )}

      <span className="swimlane-label">{laneKey}</span>
      <span className="swimlane-count">{count}</span>
    </button>
  )
})

// ── Main Board ───────────────────────────────────────────────────────────────
export const KanbanBoard = memo(function KanbanBoard({
  issues, columns, avatarMap, priorityColorMap, swimlaneBy = 'none', boardSwimlaneField,
  getColumnIssues, onIssueMove, onIssueClick, getExtraClass, colPagination, onLoadMore,
}: KanbanBoardProps) {
  const [activeIssue, setActiveIssue] = useState<YouTrackIssue | null>(null)
  const [hoverCol, setHoverCol] = useState<string | null>(null)
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set())

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const found = issues.find(i => i.id === (event.active.id as string))
    if (found) setActiveIssue(found)
  }, [issues])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event
    if (!over) { setHoverCol(null); return }
    const col = columns.find(c => c === (over.id as string))
    setHoverCol(col ?? null)
  }, [columns])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    setActiveIssue(null)
    setHoverCol(null)
    if (!over) return
    const activeId = active.id as string
    const overId   = over.id as string
    const dragged  = issues.find(i => i.id === activeId)
    if (!dragged) return
    const overCol = columns.find(c => c === overId)
    if (overCol && dragged.status !== overCol) { onIssueMove(activeId, overCol); return }
    const overItem = issues.find(i => i.id === overId)
    if (overItem && overItem.status !== dragged.status) onIssueMove(activeId, overItem.status)
  }, [issues, columns, onIssueMove])

  const toggleLane = useCallback((key: string) => {
    setCollapsedLanes(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])

  // ── Column strip — shared renderer ─────────────────────────────────────────
  const renderColumns = (laneKey?: string) => (
    <div className="kanban-board">
      {columns.map(col => {
        const colIssues = swimlaneBy !== 'none' && laneKey
          ? issues.filter(i => i.status === col && laneKeyForIssue(i, swimlaneBy, boardSwimlaneField) === laneKey)
          : getColumnIssues(col)
        const pg = colPagination?.[col]
        return (
          <KanbanColumn
            key={col}
            id={col}
            title={col}
            issues={colIssues}
            avatarMap={avatarMap}
            priorityColorMap={priorityColorMap}
            onIssueClick={onIssueClick}
            getExtraClass={getExtraClass}
            hasMore={laneKey ? false : pg?.hasMore}
            isLoadingMore={laneKey ? false : pg?.loading}
            onLoadMore={laneKey ? undefined : onLoadMore}
            isHoverTarget={hoverCol === col}
          />
        )
      })}
    </div>
  )

  const lanes = swimlaneBy !== 'none' ? buildLanes(issues, swimlaneBy, boardSwimlaneField) : []

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {swimlaneBy === 'none' ? (
        renderColumns()
      ) : (
        <div className="swimlane-wrap">
          {lanes.map(laneKey => {
            const laneIssues = issues.filter(i => laneKeyForIssue(i, swimlaneBy, boardSwimlaneField) === laneKey)
            const collapsed = collapsedLanes.has(laneKey)
            return (
              <div key={laneKey} className="swimlane-row">
                <SwimLaneHeader
                  laneKey={laneKey}
                  by={swimlaneBy}
                  count={laneIssues.length}
                  collapsed={collapsed}
                  onToggle={() => toggleLane(laneKey)}
                  avatarMap={avatarMap}
                  priorityColorMap={priorityColorMap}
                  boardSwimlaneField={boardSwimlaneField}
                />
                <div className={`swimlane-body${collapsed ? ' swimlane-body--collapsed' : ''}`}>
                  {renderColumns(laneKey)}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <DragOverlay>
        {activeIssue ? (
          <div
            className="task-card priority-medium"
            style={{ opacity: 0.9, boxShadow: '0 8px 25px rgba(0,0,0,0.3)', transform: 'rotate(3deg)', pointerEvents: 'none' }}
          >
            <div className="task-card-top-row">
              {activeIssue.priority && priorityColorMap?.[activeIssue.priority] && (
                <span className="board-priority-dot" style={{ background: priorityColorMap[activeIssue.priority] }} />
              )}
              <span className="task-card-id">{activeIssue.idReadable || activeIssue.id}</span>
            </div>
            <h4 className="task-title">{activeIssue.summary}</h4>
            <div className="task-meta">
              <span className="badge badge-todo">{activeIssue.status}</span>
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
})
