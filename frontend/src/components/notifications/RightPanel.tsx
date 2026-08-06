import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle, Rocket, Sparkles, Settings, Clock, CheckCircle2,
  UserPlus, RefreshCw, MessageCircle,
  CheckCheck, X, BellOff, Trash2,
} from 'lucide-react'
import type { NotificationItem } from '../../services/api'

// ── Slack glyph (reused across slack-ish notification types) ──────────────────

function SlackGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.04 15.17a2.53 2.53 0 0 1-2.52 2.52A2.53 2.53 0 0 1 0 15.17a2.53 2.53 0 0 1 2.52-2.52h2.52v2.52zm1.27 0a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.52 2.52v6.31A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52v-6.31zM8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.52 2.52v2.52H8.83zm0 1.27a2.53 2.53 0 0 1 2.52 2.52 2.53 2.53 0 0 1-2.52 2.52H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52h6.31zm10.13 2.52a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.52h-2.52V8.83zm-1.27 0a2.53 2.53 0 0 1-2.52 2.52 2.53 2.53 0 0 1-2.52-2.52V2.52A2.53 2.53 0 0 1 14.17 0a2.53 2.53 0 0 1 2.52 2.52v6.31zm-2.52 10.13a2.53 2.53 0 0 1 2.52 2.52A2.53 2.53 0 0 1 14.17 24a2.53 2.53 0 0 1-2.52-2.52v-2.52h2.52zm0-1.27a2.53 2.53 0 0 1-2.52-2.52 2.53 2.53 0 0 1 2.52-2.52h6.31A2.53 2.53 0 0 1 24 14.17a2.53 2.53 0 0 1-2.52 2.52h-6.31z"/>
    </svg>
  )
}

// ── Notification type config — keyed by the REAL backend `type` strings ───────
// (task_overdue/task_updated/task_assigned/task_completed from models.NotificationType,
//  warning/success/danger raw strings from youtrack.go + scheduler, slack_mention/
//  reminder_created from slack.go, update_reminder_* from update_reminder service)

const TYPE_CONFIG = {
  task_overdue:       { accent: '#f59e0b', tint: 'rgba(245,158,11,0.13)', Icon: Clock,        label: 'Overdue' },
  task_updated:       { accent: '#3b82f6', tint: 'rgba(59,130,246,0.13)', Icon: RefreshCw,     label: 'Updated' },
  task_assigned:      { accent: '#8b5cf6', tint: 'rgba(139,92,246,0.13)', Icon: UserPlus,      label: 'Assigned' },
  task_completed:     { accent: '#22c55e', tint: 'rgba(34,197,94,0.13)',  Icon: CheckCircle2,  label: 'Completed' },
  warning:            { accent: '#f59e0b', tint: 'rgba(245,158,11,0.13)', Icon: AlertTriangle, label: 'Warning' },
  danger:             { accent: '#ef4444', tint: 'rgba(239,68,68,0.13)',  Icon: AlertTriangle, label: 'Alert' },
  success:            { accent: '#22c55e', tint: 'rgba(34,197,94,0.13)',  Icon: CheckCircle2,  label: 'Success' },
  slack_mention:      { accent: '#3b82f6', tint: 'rgba(59,130,246,0.13)', Icon: SlackGlyph,    label: 'Slack' },
  slack_analysis:     { accent: '#3b82f6', tint: 'rgba(59,130,246,0.13)', Icon: SlackGlyph,    label: 'Slack' },
  mentioned:          { accent: '#3b82f6', tint: 'rgba(59,130,246,0.13)', Icon: SlackGlyph,    label: 'Mention' },
  discrepancy:        { accent: '#f59e0b', tint: 'rgba(245,158,11,0.13)', Icon: AlertTriangle, label: 'Discrepancy' },
  reminder_created:   { accent: '#a855f7', tint: 'rgba(168,85,247,0.13)', Icon: MessageCircle, label: 'Reminder' },
  update_reminder_sent:   { accent: '#22c55e', tint: 'rgba(34,197,94,0.13)', Icon: Rocket,     label: 'Reminder sent' },
  update_reminder_failed: { accent: '#ef4444', tint: 'rgba(239,68,68,0.13)', Icon: AlertTriangle, label: 'Reminder failed' },
  ai:                 { accent: '#a855f7', tint: 'rgba(168,85,247,0.13)', Icon: Sparkles,      label: 'AI' },
  system:             { accent: '#94a3b8', tint: 'rgba(148,163,184,0.12)', Icon: Settings,     label: 'System' },
} as const

type NotifType = keyof typeof TYPE_CONFIG

interface RightPanelProps {
  anchorRect: DOMRect
  onClose: () => void
  notifications: NotificationItem[]
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onDelete: (id: string) => void
  ytBaseUrl?: string
}

// ── Normalised row shape ───────────────────────────────────────────────────────

interface NRow {
  key: string
  type: NotifType
  unread: boolean
  time: string
  title: string
  body: string
  issueId: string | null
  item: NotificationItem
}

function relativeTime(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// YouTrack idReadable = <project short name>-<number>. Short names aren't always
// uppercase letters (this instance uses numeric project prefixes like "3-5997"),
// so match any short alphanumeric prefix rather than assuming letters.
const ISSUE_ID_RE = /\b[A-Za-z0-9]{1,10}-\d+\b/

function toNRow(n: NotificationItem): NRow {
  const type = (TYPE_CONFIG[n.type as NotifType] ? n.type : 'system') as NotifType
  const title = n.title || n.message || 'Notification'
  const body = n.message || ''
  const match = `${title} ${body}`.match(ISSUE_ID_RE)
  return {
    key: n.id,
    type,
    unread: !n.read,
    time: relativeTime(n.created_at),
    title,
    body,
    issueId: match ? match[0] : null,
    item: n,
  }
}

// ── Notification row ──────────────────────────────────────────────────────────

function NotifRow({ row, exiting, onOpen, onDelete }: {
  row: NRow
  exiting: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const cfg = TYPE_CONFIG[row.type]
  const { Icon } = cfg

  return (
    <div
      className={`np-row${exiting ? ' np-row--exit' : ''}${row.issueId ? ' np-row--clickable' : ''}`}
      style={{
        position: 'relative',
        display: 'flex', gap: 11, padding: '13px 16px',
        background: row.unread ? 'var(--np-surface, rgba(255,255,255,0.04))' : 'transparent',
        borderBottom: '1px solid var(--np-border, rgba(255,255,255,0.08))',
        cursor: row.issueId ? 'pointer' : 'default',
      }}
      onClick={onOpen}
    >
      {row.unread && (
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: cfg.accent, borderRadius: '0 2px 2px 0' }} />
      )}

      <div style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, background: cfg.tint, color: cfg.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        <Icon size={15} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.45, marginBottom: 3 }}>
              {row.unread && (
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: cfg.accent, marginRight: 7, verticalAlign: 'middle', boxShadow: `0 0 5px ${cfg.accent}` }} />
              )}
              {row.title}
            </div>
            {row.body && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{row.body}</div>
            )}
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, fontFamily: 'monospace', marginTop: 1 }}>{row.time}</span>
          <button
            className="np-icon-btn np-row-delete"
            onClick={e => { e.stopPropagation(); onDelete() }}
            aria-label="Delete notification"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function RightPanel({
  anchorRect, onClose,
  notifications, onMarkRead, onMarkAllRead, onDelete,
  ytBaseUrl,
}: RightPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<'all' | 'unread'>('all')
  const [visibleCount, setVisibleCount] = useState(6)
  const [exitingKeys, setExitingKeys] = useState<string[]>([])

  // Outside-click + Esc
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          !(e.target as Element).closest('[data-np-bell]')) {
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const allRows: NRow[] = notifications.map(toNRow)

  const filteredRows = tab === 'unread' ? allRows.filter(r => r.unread) : allRows
  const shownRows = filteredRows.slice(0, visibleCount)
  const hasMore = filteredRows.length > visibleCount
  const unreadCount = allRows.filter(r => r.unread).length

  // Position anchored below bell, right-aligned
  const PANEL_W = 380
  const left = Math.max(8, Math.min(anchorRect.right - PANEL_W, window.innerWidth - PANEL_W - 8))
  const top = anchorRect.bottom + 10
  const arrowRight = anchorRect.right - left - 22

  const dismiss = (row: NRow) => {
    setExitingKeys(k => [...k, row.key])
    setTimeout(() => {
      onDelete(row.item.id)
      setExitingKeys(k => k.filter(x => x !== row.key))
    }, 260)
  }

  const openRow = (row: NRow) => {
    if (row.unread) onMarkRead(row.item.id)
    if (row.issueId && ytBaseUrl) {
      window.open(`${ytBaseUrl}/issue/${row.issueId}`, '_blank', 'noopener,noreferrer')
    }
  }

  return createPortal(
    <div ref={panelRef} className="np-panel" style={{ left, top, '--arrow-right': `${arrowRight}px` } as React.CSSProperties}>
      {/* Arrow */}
      <span className="np-arrow" />

      {/* Header */}
      <div className="np-header">
        <span className="np-title">Notifications</span>
        {unreadCount > 0 && <span className="np-unread-badge">{unreadCount} new</span>}
        <div style={{ flex: 1 }} />
        {unreadCount > 0 && (
          <button className="np-action-btn np-action-btn--ghost np-mark-all" onClick={onMarkAllRead}>
            <CheckCheck size={12} /> Mark all read
          </button>
        )}
        <button className="np-icon-btn" onClick={onClose}><X size={14} /></button>
      </div>

      {/* Tabs */}
      <div className="np-tabs">
        {(['all', 'unread'] as const).map(t => (
          <button key={t} className={`np-tab${tab === t ? ' np-tab--active' : ''}`}
            onClick={() => { setTab(t); setVisibleCount(6) }}>
            {t === 'all' ? 'All' : `Unread${unreadCount ? ` (${unreadCount})` : ''}`}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="np-list">
        {shownRows.length === 0 ? (
          <div className="np-empty">
            <BellOff size={36} strokeWidth={1.4} />
            <div>
              <div className="np-empty-title">You're all caught up</div>
              <div className="np-empty-sub">No {tab === 'unread' ? 'unread ' : ''}notifications right now.</div>
            </div>
          </div>
        ) : (
          <>
            {shownRows.map(row => (
              <NotifRow
                key={row.key}
                row={row}
                exiting={exitingKeys.includes(row.key)}
                onOpen={() => openRow(row)}
                onDelete={() => dismiss(row)}
              />
            ))}
            {hasMore && (
              <button className="np-load-more" onClick={() => setVisibleCount(c => c + 6)}>
                Load more
              </button>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
