import { useState, useEffect, useCallback } from 'react'
import {
  Bell, RefreshCw, CheckCircle2, UserPlus, ArrowRightLeft,
  Clock, MessageSquare, AlertTriangle, Zap, X, ChevronDown,
} from 'lucide-react'
import api from '@/services/api'
import type { NotificationItem } from '@/services/api'

type Filter = 'all' | 'unread' | 'task' | 'slack' | 'system'

// ── Type config ───────────────────────────────────────────────────────────────
interface TypeCfg {
  Icon: React.ElementType; color: string; bg: string; stripe: string; label: string
}
function getTypeCfg(type: string): TypeCfg {
  if (type === 'task_assigned')
    return { Icon: UserPlus,       color: '#818cf8', bg: 'rgba(99,102,241,0.15)',  stripe: '#6366f1', label: 'Assigned' }
  if (type === 'task_completed')
    return { Icon: CheckCircle2,   color: '#4ade80', bg: 'rgba(34,197,94,0.15)',   stripe: '#22c55e', label: 'Completed' }
  if (type === 'task_updated' || type === 'task_status_changed')
    return { Icon: ArrowRightLeft, color: '#22d3ee', bg: 'rgba(6,182,212,0.15)',   stripe: '#06b6d4', label: 'Updated' }
  if (type === 'task_overdue')
    return { Icon: Clock,          color: '#f87171', bg: 'rgba(239,68,68,0.15)',   stripe: '#ef4444', label: 'Overdue' }
  if (type === 'mentioned' || type === 'slack_analysis' || type === 'slack_followup')
    return { Icon: MessageSquare,  color: '#60a5fa', bg: 'rgba(59,130,246,0.15)',  stripe: '#3b82f6', label: 'Slack' }
  if (type === 'discrepancy')
    return { Icon: AlertTriangle,  color: '#fbbf24', bg: 'rgba(245,158,11,0.15)',  stripe: '#f59e0b', label: 'Alert' }
  return   { Icon: Bell,           color: '#a78bfa', bg: 'rgba(139,92,246,0.15)',  stripe: 'rgba(139,92,246,0.7)', label: 'System' }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(dateStr: string) {
  const ms = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(ms / 60000)
  const h = Math.floor(ms / 3600000)
  const d = Math.floor(ms / 86400000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  if (h < 24) return `${h}h ago`
  if (d < 7)  return `${d}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getDateLabel(dateStr: string) {
  const d = new Date(dateStr)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString())     return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function groupByDate(items: NotificationItem[]) {
  const groups: { label: string; items: NotificationItem[] }[] = []
  let cur = ''
  for (const item of items) {
    const label = getDateLabel(item.created_at)
    if (label !== cur) { cur = label; groups.push({ label, items: [] }) }
    groups[groups.length - 1].items.push(item)
  }
  return groups
}

// Client-side dedup safety net: same type + title on the same calendar day → keep newest only
function deduplicate(items: NotificationItem[]): NotificationItem[] {
  const seen = new Set<string>()
  return items.filter(n => {
    const day = new Date(n.created_at).toDateString()
    const key = `${n.type}::${n.title}::${day}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function matchesFilter(n: NotificationItem, f: Filter) {
  if (f === 'all')    return true
  if (f === 'unread') return !n.read
  if (f === 'task')   return n.type.startsWith('task_')
  if (f === 'slack')  return n.type.includes('slack') || n.type === 'mentioned'
  if (f === 'system') return n.type === 'discrepancy' || n.type === 'task_overdue'
  return true
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
const SKEL_TITLE   = ['55%','70%','42%','66%','78%','48%','62%','72%']
const SKEL_STRIPES = ['#6366f1','#22c55e','#ef4444','#06b6d4','#3b82f6','#f59e0b','#a78bfa','#22c55e']

function SkeletonFeed() {
  const groups = [{ label: 'Today', count: 3 }, { label: 'Yesterday', count: 3 }, { label: 'Earlier', count: 4 }]
  let idx = 0
  return (
    <div className="act2-feed">
      {groups.map(g => (
        <div key={g.label} className="act2-date-group">
          <div className="act2-date-divider">
            <div className="act2-date-line" />
            <div className="act2-skel" style={{ width: 80, height: 10, borderRadius: 4 }} />
            <div className="act2-date-line" />
          </div>
          <div className="act2-card-list">
            {Array.from({ length: g.count }).map((_, ri) => {
              const i = idx++
              return (
                <div key={ri} className="act2-card act2-card--skel">
                  <div className="act2-stripe" style={{ background: SKEL_STRIPES[i % 8] }} />
                  <div className="act2-card-inner">
                    <div className="act2-card-row">
                      <div className="act2-skel act2-skel-icon" />
                      <div className="act2-skel act2-skel-chip" style={{ width: 52 + (i % 3) * 12 }} />
                      <div className="act2-skel" style={{ flex: 1, height: 11, minWidth: 0 }} />
                      <div className="act2-skel" style={{ width: 34, height: 10, flexShrink: 0 }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Notification card ─────────────────────────────────────────────────────────
function NotifCard({
  notif,
  expanded,
  onToggle,
  onMarkRead,
  onDelete,
}: {
  notif: NotificationItem
  expanded: boolean
  onToggle: () => void
  onMarkRead: (id: string) => void
  onDelete: (id: string) => void
}) {
  const cfg = getTypeCfg(notif.type)
  const hasDetail = !!notif.message

  const handleClick = () => {
    if (!notif.read) onMarkRead(notif.id)
    if (hasDetail) onToggle()
  }

  return (
    <div
      className={`act2-card${notif.read ? '' : ' act2-card--unread'}${expanded ? ' act2-card--open' : ''}`}
      onClick={handleClick}
      style={{ cursor: hasDetail ? 'pointer' : notif.read ? 'default' : 'pointer' }}
    >
      {/* Colored left stripe */}
      <div className="act2-stripe" style={{ background: cfg.stripe }} />

      <div className="act2-card-inner">

        {/* ── Compact row (always visible) ── */}
        <div className="act2-card-row">
          {/* Icon */}
          <div className="act2-card-icon" style={{ background: cfg.bg, color: cfg.color }}>
            <cfg.Icon size={14} />
          </div>

          {/* Type chip */}
          <span
            className="act2-type-chip"
            style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.stripe}55` }}
          >
            {cfg.label}
          </span>

          {/* Title — grows, single line truncated */}
          <span className="act2-card-title">{notif.title}</span>

          {/* Time */}
          <span className="act2-card-time">{timeAgo(notif.created_at)}</span>

          {/* Unread dot */}
          {!notif.read && (
            <div className="act2-unread-dot" style={{ background: cfg.stripe }} />
          )}

          {/* Expand chevron (only if there's a message) */}
          {hasDetail && (
            <ChevronDown
              size={13}
              className={`act2-chevron${expanded ? ' act2-chevron--open' : ''}`}
            />
          )}

          {/* Dismiss */}
          <button
            className="act2-dismiss-btn"
            aria-label="Dismiss"
            onClick={e => { e.stopPropagation(); onDelete(notif.id) }}
          >
            <X size={10} />
          </button>
        </div>

        {/* ── Expanded detail (only when open) ── */}
        {expanded && hasDetail && (
          <div className="act2-card-detail">
            {notif.message}
          </div>
        )}

      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export function ActivityPage() {
  const [all, setAll]           = useState<NotificationItem[]>([])
  const [loading, setLoading]   = useState(true)
  const [filter, setFilter]     = useState<Filter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.getNotifications(100)
      if (res.success && res.data) setAll(deduplicate(res.data))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered    = all.filter(n => matchesFilter(n, filter))
  const groups      = groupByDate(filtered)
  const unreadCount = all.filter(n => !n.read).length
  const taskCount   = all.filter(n => n.type.startsWith('task_')).length
  const slackCount  = all.filter(n => n.type.includes('slack') || n.type === 'mentioned').length

  const handleMarkAllRead = async () => {
    await api.markAllNotificationsAsRead()
    setAll(prev => prev.map(n => ({ ...n, read: true })))
  }
  const handleDelete   = async (id: string) => {
    await api.deleteNotification(id)
    setAll(prev => prev.filter(n => n.id !== id))
    if (expandedId === id) setExpandedId(null)
  }
  const handleMarkRead = async (id: string) => {
    await api.markNotificationAsRead(id)
    setAll(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
  }

  const KPI = [
    { label: 'TOTAL',  value: all.length,  color: '#a78bfa', glow: 'rgba(139,92,246,0.4)' },
    { label: 'UNREAD', value: unreadCount,  color: '#60a5fa', glow: 'rgba(59,130,246,0.4)' },
    { label: 'TASKS',  value: taskCount,    color: '#818cf8', glow: 'rgba(99,102,241,0.4)' },
    { label: 'SLACK',  value: slackCount,   color: '#4ade80', glow: 'rgba(34,197,94,0.4)'  },
  ]
  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all',    label: `All (${all.length})` },
    { key: 'unread', label: `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}` },
    { key: 'task',   label: 'Tasks' },
    { key: 'slack',  label: 'Slack' },
    { key: 'system', label: 'System' },
  ]

  return (
    <div className="act2-page">

      {/* Header */}
      <div className="act2-header">
        <div className="act2-header-left">
          <div className="act2-header-icon"><Bell size={18} /></div>
          <div>
            <h2 className="act2-title">Activity Feed</h2>
            <p className="act2-subtitle">Notifications and events — last 30 days</p>
          </div>
          {unreadCount > 0 && <span className="act2-badge">{unreadCount} unread</span>}
        </div>
        <div className="act2-header-right">
          {unreadCount > 0 && (
            <button className="act2-ghost-btn" onClick={handleMarkAllRead}>
              <CheckCircle2 size={13} /> Mark all read
            </button>
          )}
          <button className="act2-ghost-btn" onClick={load} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'act2-spin' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="act2-kpi-row">
        {KPI.map(k => (
          <div key={k.label} className="act2-kpi-card">
            <div className="act2-kpi-glow" style={{ background: `radial-gradient(circle at 30% 40%, ${k.glow} 0%, transparent 70%)` }} />
            <span className="act2-kpi-label">{k.label}</span>
            <span className="act2-kpi-value" style={{ color: k.color }}>{k.value}</span>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="act2-filter-bar">
        {FILTERS.map(f => (
          <button
            key={f.key}
            className={`act2-filter-chip${filter === f.key ? ' active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Feed */}
      {loading ? <SkeletonFeed /> : filtered.length === 0 ? (
        <div className="act2-empty">
          <div className="act2-empty-icon"><Bell size={28} strokeWidth={1.3} /></div>
          <p className="act2-empty-title">No activity{filter !== 'all' ? ` for "${filter}"` : ''}</p>
          <p className="act2-empty-sub">Task updates, Slack scans, and AI events appear here.</p>
        </div>
      ) : (
        <div className="act2-feed">
          {groups.map(group => (
            <div key={group.label} className="act2-date-group">
              <div className="act2-date-divider">
                <div className="act2-date-line" />
                <span className="act2-date-text"><Zap size={9} /> {group.label}</span>
                <div className="act2-date-line" />
              </div>
              <div className="act2-card-list">
                {group.items.map(notif => (
                  <NotifCard
                    key={notif.id}
                    notif={notif}
                    expanded={expandedId === notif.id}
                    onToggle={() => setExpandedId(prev => prev === notif.id ? null : notif.id)}
                    onMarkRead={handleMarkRead}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  )
}
