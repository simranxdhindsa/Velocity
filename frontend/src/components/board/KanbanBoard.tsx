import { useState, useCallback, memo } from 'react'
import {
  DndContext, DragOverlay, closestCorners,
  KeyboardSensor, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import type { DragStartEvent, DragOverEvent, DragEndEvent } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { KanbanColumn } from './KanbanColumn'
import { TaskCard } from './TaskCard'
import type { YouTrackIssue } from '../../services/api'

interface ColPaginationState {
  skip: number
  hasMore: boolean
  loading: boolean
}

interface KanbanBoardProps {
  issues: YouTrackIssue[]
  columns: string[]
  avatarMap: Record<string, string>
  priorityColorMap?: Record<string, string>
  getColumnIssues: (col: string) => YouTrackIssue[]
  onIssueMove: (issueId: string, newState: string) => void
  onIssueClick?: (issue: YouTrackIssue) => void
  getExtraClass?: (issue: YouTrackIssue) => string
  colPagination?: Record<string, ColPaginationState>
  onLoadMore?: (col: string) => void
}

export const KanbanBoard = memo(function KanbanBoard({
  issues, columns, avatarMap, priorityColorMap, getColumnIssues, onIssueMove, onIssueClick, getExtraClass, colPagination, onLoadMore,
}: KanbanBoardProps) {
  const [activeIssue, setActiveIssue] = useState<YouTrackIssue | null>(null)
  // Track hovered column locally — only for CSS highlight, never touches parent state
  const [hoverCol, setHoverCol] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const found = issues.find(i => i.id === (event.active.id as string))
    if (found) setActiveIssue(found)
  }, [issues])

  // Only update local hover state — never moves data during drag (was the lag source)
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

    // Dropped on a column header
    const overCol = columns.find(c => c === overId)
    if (overCol && dragged.status !== overCol) {
      onIssueMove(activeId, overCol)
      return
    }
    // Dropped on another card — move to that card's column
    const overItem = issues.find(i => i.id === overId)
    if (overItem && overItem.status !== dragged.status) {
      onIssueMove(activeId, overItem.status)
    }
  }, [issues, columns, onIssueMove])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="kanban-board">
        {columns.map(col => {
          const pg = colPagination?.[col]
          return (
            <KanbanColumn
              key={col}
              id={col}
              title={col}
              issues={getColumnIssues(col)}
              avatarMap={avatarMap}
              priorityColorMap={priorityColorMap}
              onIssueClick={onIssueClick}
              getExtraClass={getExtraClass}
              hasMore={pg?.hasMore}
              isLoadingMore={pg?.loading}
              onLoadMore={onLoadMore}
              isHoverTarget={hoverCol === col}
            />
          )
        })}
      </div>

      <DragOverlay>
        {activeIssue ? (
          <div
            className="task-card priority-medium"
            style={{ opacity: 0.9, boxShadow: '0 8px 25px rgba(0,0,0,0.3)', transform: 'rotate(3deg)', pointerEvents: 'none' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              {activeIssue.priority && priorityColorMap?.[activeIssue.priority] && (
                <span className="board-priority-dot" style={{ background: priorityColorMap[activeIssue.priority] }} />
              )}
              <span style={{ color: 'var(--color-primary)', fontSize: '0.75rem', fontWeight: 600 }}>{activeIssue.idReadable || activeIssue.id}</span>
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
