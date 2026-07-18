import { memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TaskCard } from './TaskCard'
import type { YouTrackIssue } from '../../services/api'

interface SortableTaskCardProps {
  issue: YouTrackIssue
  avatarMap: Record<string, string>
  priorityColorMap?: Record<string, string>
  extraClass?: string
  onIssueClick?: (issue: YouTrackIssue) => void
}

export const SortableTaskCard = memo(function SortableTaskCard({ issue, avatarMap, priorityColorMap, extraClass, onIssueClick }: SortableTaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Promote to own compositor layer only while dragging — avoids layout thrash at rest
    willChange: isDragging ? 'transform' : undefined,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard
        issue={issue}
        avatarMap={avatarMap}
        priorityColorMap={priorityColorMap}
        isDragging={isDragging}
        extraClass={extraClass}
        onClick={onIssueClick ? () => onIssueClick(issue) : undefined}
      />
    </div>
  )
})
