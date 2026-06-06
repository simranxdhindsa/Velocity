import { useState } from 'react'
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
  getColumnIssues: (col: string) => YouTrackIssue[]
  onIssueMove: (issueId: string, newState: string) => void
  onIssueClick?: (issue: YouTrackIssue) => void
  colPagination?: Record<string, ColPaginationState>
  onLoadMore?: (col: string) => void
}

export function KanbanBoard({
  issues, columns, avatarMap, getColumnIssues, onIssueMove, onIssueClick, colPagination, onLoadMore,
}: KanbanBoardProps) {
  const [activeIssue, setActiveIssue] = useState<YouTrackIssue | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragStart = (event: DragStartEvent) => {
    const found = issues.find(i => i.id === (event.active.id as string))
    if (found) setActiveIssue(found)
  }

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (!over) return
    const activeId = active.id as string
    const overId = over.id as string
    const activeIssueItem = issues.find(i => i.id === activeId)
    if (!activeIssueItem) return

    const overColumn = columns.find(col => col === overId)
    if (overColumn && activeIssueItem.status !== overColumn) {
      onIssueMove(activeId, overColumn)
      return
    }
    const overIssue = issues.find(i => i.id === overId)
    if (overIssue && overIssue.status !== activeIssueItem.status) {
      onIssueMove(activeId, overIssue.status)
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveIssue(null)
    if (!over) return
    const activeId = active.id as string
    const overId = over.id as string
    const activeIssueItem = issues.find(i => i.id === activeId)
    if (!activeIssueItem) return

    const overColumn = columns.find(col => col === overId)
    if (overColumn && activeIssueItem.status !== overColumn) {
      onIssueMove(activeId, overColumn)
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {/* Use same .kanban-board class as Dashboard */}
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
              onIssueClick={onIssueClick}
              hasMore={pg?.hasMore}
              isLoadingMore={pg?.loading}
              onLoadMore={onLoadMore ? () => onLoadMore(col) : undefined}
            />
          )
        })}
      </div>

      <DragOverlay>
        {activeIssue ? (
          <div
            className="task-card priority-medium"
            style={{ opacity: 0.9, boxShadow: '0 8px 25px rgba(0,0,0,0.3)', transform: 'rotate(3deg)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span style={{ color: '#8250df', fontSize: '0.75rem', fontWeight: 600 }}>{activeIssue.idReadable || activeIssue.id}</span>
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
}
