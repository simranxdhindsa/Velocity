import { Paperclip } from 'lucide-react'
import type { YouTrackIssue } from '../../services/api'
import HoverCard, { HCRow, HCDivider } from '../HoverCard'

interface TaskCardProps {
  issue: YouTrackIssue
  avatarMap: Record<string, string>
  isDragging?: boolean
  onClick?: () => void
}

function getInitials(name: string): string {
  if (!name) return '?'
  return name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()
}

function getPriorityClass(priority: string): string {
  const p = (priority || '').toLowerCase()
  if (p.includes('critical') || p.includes('show-stopper') || p.includes('blocker')) return 'priority-high'
  if (p.includes('major')) return 'priority-medium'
  if (p.includes('minor') || p.includes('cosmetic') || p.includes('low')) return 'priority-low'
  return 'priority-medium'
}

function getStatusBadge(status: string): { label: string; cls: string } {
  const s = (status || '').toLowerCase()
  if (s === 'in progress') return { label: 'In Progress', cls: 'badge-progress' }
  if (s === 'dev')         return { label: 'DEV',         cls: 'badge-review' }
  if (s === 'done' || s === 'fixed' || s.includes('mobile done') || s.includes('verified')) return { label: status, cls: 'badge-done' }
  if (s.includes('stage') || s.includes('prod') || s.includes('ready')) return { label: status, cls: 'badge-review' }
  if (s === 'blocked')     return { label: 'Blocked',     cls: 'badge-blocked' }
  return { label: status || 'Backlog', cls: 'badge-todo' }
}

function cardHoverContent(issue: YouTrackIssue) {
  const id = issue.idReadable || issue.id
  const assigneeName = issue.assignee?.fullName || issue.assignee?.login
  return (
    <div>
      <div className="hc-title">{id}</div>
      <div className="hc-subtitle">{issue.summary}</div>
      <HCDivider />
      <HCRow label="State" value={issue.status || '—'} />
      {issue.priority && <HCRow label="Priority" value={issue.priority} />}
      {assigneeName && <HCRow label="Assignee" value={assigneeName} />}
    </div>
  )
}

export function TaskCard({ issue, avatarMap, isDragging, onClick }: TaskCardProps) {
  const priorityCls = getPriorityClass(issue.priority || '')
  const { label: statusLabel, cls: statusCls } = getStatusBadge(issue.status || '')
  const assigneeName = issue.assignee?.fullName || issue.assignee?.login || ''
  const avatarUrl = assigneeName ? avatarMap[assigneeName] : undefined

  return (
    <HoverCard content={cardHoverContent(issue)} maxWidth={280}>
      <div
        className={`task-card ${priorityCls} ${isDragging ? 'dragging' : ''}`}
        onClick={onClick}
      >
        {/* Attachment count — top-right corner */}
        {(issue.attachments?.length ?? 0) > 0 && (
          <span className="task-attachment-count" title={`${issue.attachments!.length} attachment${issue.attachments!.length !== 1 ? 's' : ''}`}>
            <Paperclip size={10} />
            {issue.attachments!.length}
          </span>
        )}

        {/* Issue ID */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <span style={{ color: '#8250df', fontSize: '0.75rem', fontWeight: 600 }}>{issue.idReadable || issue.id}</span>
        </div>

        {/* Title */}
        <h4 className="task-title">{issue.summary}</h4>

        {/* Footer: status badge + avatar */}
        <div className="task-meta">
          <span className={`badge ${statusCls}`}>{statusLabel}</span>
          {assigneeName && (
            avatarUrl ? (
              <img
                src={avatarUrl}
                alt={assigneeName}
                title={assigneeName}
                className="avatar avatar-sm"
                style={{ objectFit: 'cover' }}
              />
            ) : (
              <div className="avatar avatar-sm" title={assigneeName}>
                {getInitials(assigneeName)}
              </div>
            )
          )}
        </div>
      </div>
    </HoverCard>
  )
}
