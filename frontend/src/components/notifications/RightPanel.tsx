import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft, AlertTriangle, Rocket, Sparkles, Settings,
  CheckCheck, X, BellOff,
} from 'lucide-react'
import api from '../../services/api'
import type { NotificationItem } from '../../services/api'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocalNotification {
  id: string
  type: 'backward_move' | 'sync_issue'
  issueId: string
  summary: string
  fromState: string
  toState: string
  timestamp: Date
  read: boolean
}

interface RightPanelProps {
  anchorRect: DOMRect
  onClose: () => void
  localNotifications?: LocalNotification[]
  onMoveToBlocked?: (notif: LocalNotification) => void
  onDismissLocal?: (id: string) => void
}

// ── Notification type config ──────────────────────────────────────────────────

const TYPE_CONFIG = {
  backward_move: { accent: '#f59e0b', tint: 'rgba(245,158,11,0.13)', Icon: ChevronLeft,     label: 'Moved back' },
  sync_issue:    { accent: '#ef4444', tint: 'rgba(239,68,68,0.13)',  Icon: AlertTriangle,   label: 'Sync issue' },
  deployment:    { accent: '#22c55e', tint: 'rgba(34,197,94,0.13)',  Icon: Rocket,          label: 'Deploy' },
  ai:            { accent: '#a855f7', tint: 'rgba(168,85,247,0.13)', Icon: Sparkles,        label: 'AI' },
  slack:         { accent: '#3b82f6', tint: 'rgba(59,130,246,0.13)', Icon: () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.04 15.17a2.53 2.53 0 0 1-2.52 2.52A2.53 2.53 0 0 1 0 15.17a2.53 2.53 0 0 1 2.52-2.52h2.52v2.52zm1.27 0a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.52 2.52v6.31A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52v-6.31zM8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.52 2.52v2.52H8.83zm0 1.27a2.53 2.53 0 0 1 2.52 2.52 2.53 2.53 0 0 1-2.52 2.52H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52h6.31zm10.13 2.52a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.52h-2.52V8.83zm-1.27 0a2.53 2.53 0 0 1-2.52 2.52 2.53 2.53 0 0 1-2.52-2.52V2.52A2.53 2.53 0 0 1 14.17 0a2.53 2.53 0 0 1 2.52 2.52v6.31zm-2.52 10.13a2.53 2.53 0 0 1 2.52 2.52A2.53 2.53 0 0 1 14.17 24a2.53 2.53 0 0 1-2.52-2.52v-2.52h2.52zm0-1.27a2.53 2.53 0 0 1-2.52-2.52 2.53 2.53 0 0 1 2.52-2.52h6.31A2.53 2.53 0 0 1 24 14.17a2.53 2.53 0 0 1-2.52 2.52h-6.31z"/>
    </svg>
  ), label: 'Slack' },
  system:        { accent: '#94a3b8', tint: 'rgba(148,163,184,0.12)', Icon: Settings,       label: 'System' },
} as const

type NotifType = keyof typeof TYPE_CONFIG

// ── Normalised row shape (server + local unified) ─────────────────────────────

interface NRow {
  key: string
  type: NotifType
  unread: boolean
  time: string
  title: string
  body: string
  primaryLabel?: string
  secondaryLabel?: string
  _local?: LocalNotification
  _server?: NotificationItem
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

function toNRow(n: NotificationItem): NRow {
  const type = (TYPE_CONFIG[n.type as NotifType] ? n.type : 'system') as NotifType
  return {
    key: `srv-${n.id}`,
    type,
    unread: !n.read,
    time: relativeTime(n.created_at),
    title: n.title || n.message || 'Notification',
    body: n.message || '',
    _server: n,
  }
}

function localToNRow(n: LocalNotification): NRow {
  return {
    key: `loc-${n.id}`,
    type: n.type,
    unread: !n.read,
    time: relativeTime(n.timestamp),
    title: `${n.issueId} moved backward`,
    body: `${n.fromState} → ${n.toState}`,
    primaryLabel: 'Move to Blocked',
    secondaryLabel: 'Dismiss',
    _local: n,
  }
}

// ── Notification row ──────────────────────────────────────────────────────────

function NotifRow({ row, exiting, onMarkRead, onPrimary, onDismiss }: {
  row: NRow
  exiting: boolean
  onMarkRead: () => void
  onPrimary: () => void
  onDismiss: () => void
}) {
  const cfg = TYPE_CONFIG[row.type]
  const { Icon } = cfg

  return (
    <div
      className={`np-row${exiting ? ' np-row--exit' : ''}`}
      style={{
        position: 'relative',
        display: 'flex', gap: 11, padding: '13px 16px',
        background: row.unread ? 'var(--np-surface, rgba(255,255,255,0.04))' : 'transparent',
        borderBottom: '1px solid var(--np-border, rgba(255,255,255,0.08))',
        cursor: 'default',
      }}
      onClick={() => row.unread && onMarkRead()}
    >
      {/* Left accent bar */}
      {row.unread && (
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: cfg.accent, borderRadius: '0 2px 2px 0' }} />
      )}

      {/* Icon */}
      <div style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, background: cfg.tint, color: cfg.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        <Icon size={15} />
      </div>

      {/* Content */}
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
        </div>

        {/* Actions */}
        {(row.primaryLabel || row.secondaryLabel) && (
          <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
            {row.primaryLabel && (
              <button className="np-action-btn np-action-btn--primary"
                style={{ '--np-accent-rgb': cfg.accent.replace('#','').match(/.{2}/g)?.map(x=>parseInt(x,16)).join(','), '--np-accent-color': cfg.accent } as React.CSSProperties}
                onClick={e => { e.stopPropagation(); onPrimary() }}>
                {row.primaryLabel}
              </button>
            )}
            {row.secondaryLabel && (
              <button className="np-action-btn np-action-btn--ghost" onClick={e => { e.stopPropagation(); onDismiss() }}>
                {row.secondaryLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function RightPanel({
  anchorRect, onClose,
  localNotifications = [],
  onMoveToBlocked,
  onDismissLocal,
}: RightPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<'all' | 'unread'>('all')
  const [visibleCount, setVisibleCount] = useState(6)
  const [serverNotifs, setServerNotifs] = useState<NotificationItem[]>([])
  const [exitingKeys, setExitingKeys] = useState<string[]>([])

  // Fetch server notifications
  const fetchNotifs = useCallback(async () => {
    try {
      const res = await api.getNotifications(100)
      if (res.success && res.data) setServerNotifs(res.data)
    } catch {}
  }, [])

  useEffect(() => { fetchNotifs() }, [fetchNotifs])

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

  // Build unified row list
  const allRows: NRow[] = [
    ...localNotifications.map(localToNRow),
    ...serverNotifs.map(toNRow),
  ]

  const filteredRows = tab === 'unread' ? allRows.filter(r => r.unread) : allRows
  const shownRows = filteredRows.slice(0, visibleCount)
  const hasMore = filteredRows.length > visibleCount
  const unreadCount = allRows.filter(r => r.unread).length

  // Position anchored below bell, right-aligned
  const PANEL_W = 380
  const left = Math.max(8, Math.min(anchorRect.right - PANEL_W, window.innerWidth - PANEL_W - 8))
  const top = anchorRect.bottom + 10
  const arrowRight = anchorRect.right - left - 22

  // Actions
  const markAll = async () => {
    try { await api.markAllNotificationsAsRead() } catch {}
    setServerNotifs(ns => ns.map(n => ({ ...n, read: true })))
  }

  const dismiss = (key: string, row: NRow) => {
    setExitingKeys(k => [...k, key])
    setTimeout(() => {
      if (row._local) onDismissLocal?.(row._local.id)
      if (row._server) api.deleteNotification(row._server.id).catch(() => {})
      setServerNotifs(ns => ns.filter(n => `srv-${n.id}` !== key))
      setExitingKeys(k => k.filter(x => x !== key))
    }, 260)
  }

  const markRead = (key: string, row: NRow) => {
    if (row._server) {
      api.markNotificationAsRead(row._server.id).catch(() => {})
      setServerNotifs(ns => ns.map(n => n.id === row._server!.id ? { ...n, read: true } : n))
    }
  }

  const handlePrimary = (row: NRow) => {
    if (row._local && onMoveToBlocked) {
      onMoveToBlocked(row._local)
    } else {
      dismiss(row.key, row)
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
          <button className="np-action-btn np-action-btn--ghost np-mark-all" onClick={markAll}>
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
                onMarkRead={() => markRead(row.key, row)}
                onPrimary={() => handlePrimary(row)}
                onDismiss={() => dismiss(row.key, row)}
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
