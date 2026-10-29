import type { ActivityItem } from '../../services/api'
import { SprintScanLoader } from '../brand/VelocityLoaders'
import { VelocityLogo } from '../brand/VelocityLogo'

interface ActivityFeedProps {
  items: ActivityItem[]
  loading: boolean
  onLoadMore: () => void
  hasMore: boolean
}

function getActivityIcon(type: string) {
  switch (type) {
    case 'task_created':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      )
    case 'task_updated':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      )
    case 'task_completed':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )
    case 'task_assigned':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="8.5" cy="7" r="4" />
          <line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
        </svg>
      )
    case 'task_overdue':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )
    case 'slack_scan':
    case 'slack_digest':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.95 3.38C1.88 2.19 2.79 1 4 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
      )
    case 'issue_transition':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      )
    case 'ai_analysis':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      )
    case 'login':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" />
        </svg>
      )
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      )
  }
}

function getActivityTypeClass(type: string) {
  if (type.startsWith('task_completed')) return 'act-completed'
  if (type.startsWith('task_overdue')) return 'act-overdue'
  if (type.startsWith('task_')) return 'act-task'
  if (type.startsWith('slack_')) return 'act-slack'
  if (type.startsWith('issue_')) return 'act-issue'
  if (type === 'ai_analysis') return 'act-ai'
  return 'act-default'
}

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

function groupByDate(items: ActivityItem[]): { label: string; items: ActivityItem[] }[] {
  const groups: Map<string, ActivityItem[]> = new Map()
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  for (const item of items) {
    const d = new Date(item.created_at)
    let label: string
    if (d.toDateString() === today.toDateString()) {
      label = 'Today'
    } else if (d.toDateString() === yesterday.toDateString()) {
      label = 'Yesterday'
    } else {
      label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    }
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(item)
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }))
}

export function ActivityFeed({ items, loading, onLoadMore, hasMore }: ActivityFeedProps) {
  if (loading && items.length === 0) {
    return (
      <div className="activity-loading">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <SprintScanLoader size={40} />
        </div>
      </div>
    )
  }

  if (!loading && items.length === 0) {
    return (
      <div className="activity-empty">
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
          <VelocityLogo variant="icon" size="md" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
        </div>
        <p>No activity yet</p>
        <span>Actions like task updates, Slack scans, and AI analyses will appear here</span>
      </div>
    )
  }

  const groups = groupByDate(items)

  return (
    <div className="activity-feed">
      {groups.map(group => (
        <div key={group.label} className="activity-group">
          <div className="activity-date-label">{group.label}</div>
          {group.items.map(item => (
            <div key={item.id} className={`activity-item ${getActivityTypeClass(item.type)}`}>
              <div className="activity-icon">{getActivityIcon(item.type)}</div>
              <div className="activity-content">
                <p className="activity-title">{item.title}</p>
                {item.description && (
                  <p className="activity-description">{item.description}</p>
                )}
                <div className="activity-meta">
                  {item.actor_name && <span className="activity-actor">{item.actor_name}</span>}
                  <span className="activity-time">{formatRelativeTime(item.created_at)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
      {hasMore && (
        <button className="activity-load-more" onClick={onLoadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  )
}
