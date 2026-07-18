import { useRef, useEffect, memo, useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { SortableTaskCard } from './SortableTaskCard'
import type { YouTrackIssue } from '../../services/api'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

function getColumnMeta(title: string): { color: string } {
  const t = title.toLowerCase()
  if (t === 'in progress')                                                                  return { color: 'var(--color-warning)' }
  if (t === 'dev')                                                                          return { color: '#8250df' }
  if (t.includes('stage') || t.includes('prod') || t.includes('ready'))                   return { color: '#a78bfa' }
  if (t.includes('done') || t.includes('fixed') || t.includes('mobile done') || t.includes('verified')) return { color: 'var(--color-success)' }
  if (t.includes('block'))                                                                  return { color: 'var(--color-danger)' }
  return { color: '#888' }
}

interface KanbanColumnProps {
  id: string
  title: string
  issues: YouTrackIssue[]
  avatarMap: Record<string, string>
  priorityColorMap?: Record<string, string>
  onIssueClick?: (issue: YouTrackIssue) => void
  getExtraClass?: (issue: YouTrackIssue) => string
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: (col: string) => void
  isHoverTarget?: boolean
}

export const KanbanColumn = memo(function KanbanColumn({
  id, title, issues, avatarMap, priorityColorMap, onIssueClick, getExtraClass,
  hasMore, isLoadingMore, onLoadMore, isHoverTarget,
}: KanbanColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id })
  const issueIds = issues.map(i => i.id)
  const { color } = getColumnMeta(title)
  const bodyRef = useRef<HTMLDivElement>(null)

  const handleLoadMore = useCallback(() => {
    onLoadMore?.(id)
  }, [onLoadMore, id])

  // Trigger onLoadMore when user scrolls within 80px of the column bottom
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !onLoadMore) return
    const handleScroll = () => {
      if (!hasMore || isLoadingMore) return
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) handleLoadMore()
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [hasMore, isLoadingMore, handleLoadMore, onLoadMore])

  const highlighted = isOver || isHoverTarget

  return (
    <div
      ref={setNodeRef}
      className={`kanban-column ${highlighted ? 'drop-zone-active' : ''}`}
      data-status={id}
    >
      <div className="kanban-column-header">
        <span className="kanban-column-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
          {title}
        </span>
        <span className="kanban-column-count">{issues.length}{hasMore ? '+' : ''}</span>
      </div>

      <div className="kanban-column-body" ref={bodyRef}>
        <SortableContext items={issueIds} strategy={verticalListSortingStrategy}>
          {issues.length === 0 ? (
            <div style={{ padding: '1rem', textAlign: 'center' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
                <VelocityLogo variant="icon" size="md" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
              </div>
              <p className="text-muted" style={{ fontSize: '0.85rem', margin: 0 }}>No issues</p>
            </div>
          ) : (
            issues.map(issue => (
              <SortableTaskCard
                key={issue.id}
                issue={issue}
                avatarMap={avatarMap}
                priorityColorMap={priorityColorMap}
                extraClass={getExtraClass?.(issue)}
                onIssueClick={onIssueClick}
              />
            ))
          )}
        </SortableContext>

        {isLoadingMore && (
          <div style={{ padding: '0.75rem', textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Loading…
          </div>
        )}
      </div>
    </div>
  )
})
