import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bot, ChevronDown, Copy, Check, RefreshCw, Trash2,
  Clock, Send, Pencil, X, AlertCircle, Zap,
  CheckCircle2, CircleDashed, Plus,
} from 'lucide-react'
import api from '../services/api'
import type { PendingSlackMessage, ChannelRef } from '../services/api'
import { usePersistedState, PERSIST } from '../hooks/usePersistedState'
import { ClockTimePicker } from '../components/ClockTimePicker'
import { ConfirmModal } from '../components/ConfirmModal'
import '../styles/pages/claude-queue.css'

const MCP_BASE_URL = (() => {
  const apiUrl = import.meta.env.VITE_API_URL
  if (apiUrl) {
    const path = apiUrl.replace(/\/api$/, '/api/mcp')
    // VITE_API_URL may be a relative path (e.g. "/api") in production builds
    return path.startsWith('/') ? `${window.location.origin}${path}` : path
  }
  return `${window.location.origin}/api/mcp`
})()

// ── Compact connection status + manage panel ──────────────────────────────────

type TokenMeta = { exists: boolean; created_at?: string; last_used_at?: string; default_send_time?: string }

function ConnectionBar({ onDefaultTime }: { onDefaultTime: (t: string) => void }) {
  const [meta, setMeta] = useState<TokenMeta | null>(null)
  const [storedToken, setStoredToken] = usePersistedState<string>(PERSIST.MCP_PLAIN_TOKEN, '')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showRevoke, setShowRevoke] = useState(false)

  const connectorUrl = storedToken ? `${MCP_BASE_URL}?token=${storedToken}` : ''

  const generateToken = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.generateMcpToken()
      const raw = r as any
      const token = raw?.token ?? raw?.data?.token
      if (token) {
        setStoredToken(token)
        setMeta({ exists: true, created_at: new Date().toISOString() })
      }
    } finally {
      setLoading(false)
    }
  }, [setStoredToken])

  useEffect(() => {
    const init = async () => {
      const r = await api.getMcpToken()
      const raw = r as any
      const m = raw?.exists !== undefined ? raw : raw?.data
      if (!m) return
      setMeta(m)
      if (m.default_send_time) onDefaultTime(m.default_send_time)
      if (!m.exists) {
        // No token in DB — auto-generate silently
        await generateToken()
      }
      // If token exists but storedToken is empty it means the token was issued via
      // OAuth on another device; don't overwrite it — the user can revoke to get a URL here.
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isConnected = meta?.exists === true || !!storedToken

  const handleRevoke = async () => {
    await api.revokeMcpToken()
    setMeta({ exists: false })
    setStoredToken('')
    setShowRevoke(false)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(connectorUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const lastUsedLabel = meta?.last_used_at
    ? `last used ${new Date(meta.last_used_at).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })}`
    : null

  // Revoked state — token explicitly removed, show generate button
  if (meta !== null && !isConnected) {
    return (
      <div className="cq-conn">
        <div className="cq-conn-row">
          <CircleDashed size={12} className="cq-conn-icon" />
          <span className="cq-conn-label">Not connected</span>
          <button className="cq-conn-action" onClick={generateToken} disabled={loading}>
            {loading && <RefreshCw size={11} className="cq-spin" />}
            Generate token
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="cq-conn">
      <div className="cq-conn-row">
        {isConnected
          ? <CheckCircle2 size={12} className="cq-conn-icon cq-conn-icon--ok" />
          : <CircleDashed size={12} className="cq-conn-icon" />
        }
        <span className="cq-conn-label">
          {isConnected ? 'Connected' : 'Setting up…'}
          {lastUsedLabel && <span className="cq-conn-sub"> · {lastUsedLabel}</span>}
        </span>
        {isConnected && (
          <button
            className="cq-panel-btn cq-panel-btn--danger cq-conn-revoke"
            onClick={() => setShowRevoke(true)}
          >
            <Trash2 size={11} />Revoke
          </button>
        )}
      </div>

      {connectorUrl ? (
        <div className="cq-url-always">
          <div className="cq-url-label-sm">Claude.ai connector URL</div>
          <div className="cq-url-row">
            <code className="cq-url-code">{connectorUrl}</code>
            <button
              className={`cq-copy-btn${copied ? ' cq-copy-btn--ok' : ''}`}
              onClick={handleCopy}
            >
              {copied
                ? <><Check size={11} />Copied!</>
                : <><Copy size={11} />Copy</>
              }
            </button>
          </div>
          <div className="cq-url-hint">
            Claude.ai → Settings → Connectors → Add custom connector
          </div>
        </div>
      ) : meta?.exists && (
        <div className="cq-url-hint cq-url-hint--oauth">
          Connected via Claude.ai OAuth — URL not visible here.
          Revoke and regenerate if you need the connector URL on this device.
        </div>
      )}

      {showRevoke && (
        <ConfirmModal
          variant="danger"
          title="Revoke MCP token?"
          message="Claude will lose access to queue messages immediately."
          detail="You can generate a new token anytime — just paste the new URL into your Claude.ai connector."
          confirmLabel="Revoke"
          onConfirm={handleRevoke}
          onCancel={() => setShowRevoke(false)}
        />
      )}
    </div>
  )
}

// ── Inline channel picker (for cards with no channel set) ─────────────────────

function InlineChannelPicker({ channels, onPick }: {
  channels: ChannelRef[]
  onPick: (ch: ChannelRef) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})

  // Position menu using trigger's bounding rect
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setMenuStyle({
      position: 'fixed',
      top: r.bottom + 4,
      left: r.left,
      zIndex: 9999,
      width: 200,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const filtered = channels.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <button
        ref={triggerRef}
        className="cq-ch-trigger"
        onClick={() => setOpen(o => !o)}
      >
        <AlertCircle size={11} /> Pick channel
      </button>
      {open && createPortal(
        <div ref={menuRef} className="cq-ch-menu" style={menuStyle}>
          <input
            className="cq-ch-search"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          <div className="cq-ch-list">
            {filtered.map(c => (
              <button key={c.id} className="cq-ch-item" onClick={() => { onPick(c); setOpen(false); setSearch('') }}>
                #{c.name}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// ── Individual queued message card ─────────────────────────────────────────────

function QueuedMessageCard({
  msg, defaultTime, channels, onUpdated, onDeleted, onSent,
}: {
  msg: PendingSlackMessage
  defaultTime: string
  channels: ChannelRef[]
  onUpdated: (m: PendingSlackMessage) => void
  onDeleted: (id: string) => void
  onSent: (id: string, slackTs: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(msg.message)
  const [editChannel, setEditChannel] = useState<ChannelRef | null>(
    msg.channel_id ? { id: msg.channel_id, name: msg.channel_label.replace(/^#/, '') } : null
  )
  const [editTime, setEditTime] = useState(
    msg.scheduled_at
      ? new Date(msg.scheduled_at).toTimeString().slice(0, 5)
      : defaultTime
  )
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)

  const [editingTime, setEditingTime] = useState(false)
  const [quickTime, setQuickTime] = useState(
    msg.scheduled_at ? new Date(msg.scheduled_at).toTimeString().slice(0, 5) : defaultTime
  )
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showSlackDeleteConfirm, setShowSlackDeleteConfirm] = useState(false)
  const [deletingFromSlack, setDeletingFromSlack] = useState(false)

  // Save channel immediately when picked without entering full edit mode
  const handlePickChannel = async (ch: ChannelRef) => {
    const r = await api.updateQueuedMessage(msg.id, msg.message, msg.scheduled_at ?? undefined, ch.id, `#${ch.name}`)
    const raw = r as any
    const updated = raw?.id ? raw : raw?.data
    if (updated) onUpdated(updated as PendingSlackMessage)
  }

  // Save time immediately when changed inline
  const handlePickTime = async (hhmm: string) => {
    setQuickTime(hhmm)
    setEditingTime(false)
    const base = msg.scheduled_at ? new Date(msg.scheduled_at) : new Date()
    const [hh, mm] = hhmm.split(':').map(Number)
    base.setHours(hh, mm, 0, 0)
    if (base < new Date()) base.setDate(base.getDate() + 1)
    const r = await api.updateQueuedMessage(msg.id, msg.message, base.toISOString(), msg.channel_id, msg.channel_label)
    const raw = r as any
    const updated = raw?.id ? raw : raw?.data
    if (updated) onUpdated(updated as PendingSlackMessage)
  }

  const scheduledLabel = msg.scheduled_at
    ? new Date(msg.scheduled_at).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : `Default (${defaultTime})`

  const handleSave = async () => {
    setSaving(true)
    try {
      let scheduledAt: string | undefined
      if (editTime) {
        const base = msg.scheduled_at ? new Date(msg.scheduled_at) : new Date()
        const [hh, mm] = editTime.split(':').map(Number)
        base.setHours(hh, mm, 0, 0)
        scheduledAt = base.toISOString()
      }
      const r = await api.updateQueuedMessage(
        msg.id, editText, scheduledAt,
        editChannel?.id ?? msg.channel_id,
        editChannel ? `#${editChannel.name}` : msg.channel_label,
      )
      const raw = r as any
      const updated = raw?.id ? raw : raw?.data
      if (updated) { onUpdated(updated as PendingSlackMessage); setEditing(false) }
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteFromSlack = async () => {
    setDeletingFromSlack(true)
    try {
      await api.deleteSlackMessage(msg.channel_id, msg.slack_ts)
      await api.deleteQueuedMessage(msg.id)
      onDeleted(msg.id)
    } catch { /* ignore */ } finally {
      setDeletingFromSlack(false)
      setShowSlackDeleteConfirm(false)
    }
  }

  const handleSendNow = async () => {
    setSending(true)
    try {
      const r = await api.sendQueuedMessageNow(msg.id)
      const raw = r as any
      const ts = raw?.slack_ts ?? raw?.data?.slack_ts ?? ''
      onSent(msg.id, ts)
    } finally {
      setSending(false)
    }
  }

  const isPending = msg.status === 'pending'
  const isSent = msg.status === 'sent'
  const isFailed = msg.status === 'failed'

  return (
    <>
    <div className={`cq-msg-card cq-msg-card--${msg.status}`}>
      <div className="cq-msg-meta">
        {msg.channel_id
          ? <span className="cq-msg-channel">{msg.channel_label || msg.channel_id}</span>
          : isPending
            ? <InlineChannelPicker channels={channels} onPick={handlePickChannel} />
            : null
        }
        {isPending ? (
          <span className="cq-msg-time cq-msg-time--editable" onClick={() => setEditingTime(t => !t)}>
            <Clock size={10} />{scheduledLabel}
            {editingTime && (
              <span className="cq-time-inline" onClick={e => e.stopPropagation()}>
                <ClockTimePicker value={quickTime} onChange={handlePickTime} />
              </span>
            )}
          </span>
        ) : (
          <span className="cq-msg-time"><Clock size={10} />{scheduledLabel}</span>
        )}
        <span className={`cq-msg-badge cq-msg-badge--${msg.status}`}>
          {isSent
            ? <><CheckCircle2 size={10} />Sent</>
            : isFailed
            ? <><AlertCircle size={10} />Failed</>
            : <><Zap size={10} />Pending</>
          }
        </span>
      </div>

      {editing ? (
        <div className="cq-msg-edit">
          <textarea
            className="cq-msg-edit-input"
            value={editText}
            onChange={e => setEditText(e.target.value)}
            rows={4}
            autoFocus
          />
          <div className="cq-msg-edit-footer">
            <div className="cq-msg-edit-time">
              <span className="cq-label">Channel</span>
              <InlineChannelPicker
                channels={channels}
                onPick={ch => setEditChannel(ch)}
              />
              {editChannel && <span className="cq-msg-channel">#{editChannel.name}</span>}
            </div>
            <div className="cq-msg-edit-time">
              <span className="cq-label">Send at</span>
              <ClockTimePicker value={editTime} onChange={setEditTime} />
            </div>
            <div className="cq-msg-edit-actions">
              <button className="cq-btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
              <button className="cq-btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <p className="cq-msg-text">{msg.message}</p>
          {isFailed && msg.error_message && (
            <div className="cq-msg-error"><AlertCircle size={11} />{msg.error_message}</div>
          )}
          {isPending && (
            <div className="cq-msg-actions">
              <button
                className="cq-msg-icon-btn"
                title="Edit"
                onClick={() => { setEditing(true); setEditText(msg.message) }}
              >
                <Pencil size={12} />
              </button>
              <button
                className="cq-msg-icon-btn cq-msg-icon-btn--danger"
                title="Remove"
                onClick={() => setShowDeleteConfirm(true)}
              >
                <X size={12} />
              </button>
              <button className="cq-btn-send" onClick={handleSendNow} disabled={sending}>
                <Send size={11} />{sending ? 'Sending…' : 'Send now'}
              </button>
            </div>
          )}
          {isSent && msg.slack_ts && (
            <div className="cq-msg-actions">
              <button
                className="cq-panel-btn cq-panel-btn--danger"
                onClick={() => setShowSlackDeleteConfirm(true)}
                disabled={deletingFromSlack}
              >
                <Trash2 size={12} />{deletingFromSlack ? 'Deleting…' : 'Delete from Slack'}
              </button>
            </div>
          )}
        </>
      )}
    </div>

    {showDeleteConfirm && (
      <ConfirmModal
        variant="danger"
        title="Remove from queue?"
        message="This message will be cancelled and won't be sent."
        confirmLabel="Remove"
        onConfirm={async () => { await api.deleteQueuedMessage(msg.id); onDeleted(msg.id) }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    )}
    {showSlackDeleteConfirm && (
      <ConfirmModal
        variant="danger"
        title="Delete from Slack?"
        message="This will permanently delete the message from the Slack channel."
        confirmLabel="Delete"
        onConfirm={handleDeleteFromSlack}
        onCancel={() => setShowSlackDeleteConfirm(false)}
      />
    )}
    </>
  )
}

// ── Compose form — manually schedule a message into the queue ─────────────────

function ComposeForm({
  channels, defaultTime, onCreated, onClose,
}: {
  channels: ChannelRef[]
  defaultTime: string
  onCreated: (m: PendingSlackMessage) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [channel, setChannel] = useState<ChannelRef | null>(null)
  const [time, setTime] = useState(defaultTime)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const handleSubmit = async () => {
    if (!text.trim()) { setErr('Message is required'); return }
    setSaving(true)
    setErr('')
    try {
      const base = new Date()
      const [hh, mm] = time.split(':').map(Number)
      base.setHours(hh, mm, 0, 0)
      if (base <= new Date()) base.setDate(base.getDate() + 1)
      const r = await api.createQueuedMessage(
        text.trim(),
        base.toISOString(),
        channel?.id ?? '',
        channel ? `#${channel.name}` : '',
      )
      const raw = r as any
      const created = raw?.id ? raw : raw?.data
      if (created) { onCreated(created as PendingSlackMessage); onClose() }
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to schedule message')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cq-compose">
      <div className="cq-compose-hd">
        <span className="cq-queue-title">Schedule message</span>
        <button className="cq-msg-icon-btn" onClick={onClose}><X size={12} /></button>
      </div>
      <textarea
        className="cq-msg-edit-input"
        placeholder="Write your Slack message…"
        value={text}
        onChange={e => setText(e.target.value)}
        rows={4}
        autoFocus
      />
      <div className="cq-msg-edit-footer">
        <div className="cq-msg-edit-time">
          <span className="cq-label">Channel</span>
          <InlineChannelPicker channels={channels} onPick={setChannel} />
          {channel && <span className="cq-msg-channel">#{channel.name}</span>}
        </div>
        <div className="cq-msg-edit-time">
          <span className="cq-label">Send at</span>
          <ClockTimePicker value={time} onChange={setTime} />
        </div>
        {err && <span className="cq-compose-err">{err}</span>}
        <div className="cq-msg-edit-actions">
          <button className="cq-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="cq-btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Scheduling…' : <><Clock size={12} />Schedule</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main exported card ─────────────────────────────────────────────────────────

export function ClaudeQueueCard({ channels = [], autoOpen = false }: { channels?: ChannelRef[]; autoOpen?: boolean }) {
  const [open, setOpen] = useState(autoOpen)
  const [messages, setMessages] = useState<PendingSlackMessage[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [composing, setComposing] = useState(false)
  const [defaultTime, setDefaultTime] = usePersistedState<string>(
    PERSIST.QUEUE_DEFAULT_TIME, '10:00'
  )

  const loadMessages = useCallback(async () => {
    setLoadingMsgs(true)
    try {
      const r = await api.listQueuedMessages()
      const list = Array.isArray(r) ? r : Array.isArray((r as any)?.data) ? (r as any).data : []
      setMessages(list as PendingSlackMessage[])
    } finally {
      setLoadingMsgs(false)
    }
  }, [])

  useEffect(() => {
    loadMessages()
    const id = setInterval(loadMessages, 15_000)
    return () => clearInterval(id)
  }, [loadMessages])

  const pendingMsgs = messages.filter(m => m.status === 'pending')
  const recentMsgs = messages.filter(m => m.status !== 'pending').slice(0, 5)
  const pendingCount = pendingMsgs.length

  return (
    <div className="cq-card">
      <button className={`cq-header${open ? ' cq-header--open' : ''}`} onClick={() => setOpen(o => !o)}>
        <div className="cq-header-left">
          <div className="cq-header-icon"><Bot size={14} /></div>
          <span className="cq-header-title">Claude Queue</span>
          {pendingCount > 0 && <span className="cq-header-badge">{pendingCount}</span>}
        </div>
        <ChevronDown size={14} className={`cq-caret${open ? ' cq-caret--open' : ''}`} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            {/* Connection — compact one-liner; seeds defaultTime from backend */}
            <ConnectionBar onDefaultTime={setDefaultTime} />

            {/* Default time — one compact row; saves to backend on change */}
            <div className="cq-time-row">
              <span className="cq-label">Default send time</span>
              <ClockTimePicker
                value={defaultTime}
                onChange={t => { setDefaultTime(t); api.updateMcpSettings(t) }}
              />
            </div>

            {/* Queue */}
            <div className="cq-queue">
              <div className="cq-queue-hd">
                <span className="cq-queue-title">
                  Queued
                  {pendingCount > 0 && <span className="cq-count-pill">{pendingCount}</span>}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="cq-refresh-btn"
                    onClick={() => setComposing(c => !c)}
                    title="Schedule a message"
                  >
                    <Plus size={12} />
                  </button>
                  <button
                    className="cq-refresh-btn"
                    onClick={loadMessages}
                    disabled={loadingMsgs}
                    title="Refresh"
                  >
                    <RefreshCw size={12} className={loadingMsgs ? 'cq-spin' : ''} />
                  </button>
                </div>
              </div>

              {composing && (
                <ComposeForm
                  channels={channels}
                  defaultTime={defaultTime}
                  onCreated={m => setMessages(ms => [m, ...ms])}
                  onClose={() => setComposing(false)}
                />
              )}

              {pendingMsgs.length === 0 ? (
                <div className="cq-empty">
                  <Bot size={18} className="cq-empty-icon" />
                  <span>No pending messages</span>
                </div>
              ) : (
                <div className="cq-msg-list">
                  {pendingMsgs.map(m => (
                    <QueuedMessageCard
                      key={m.id} msg={m} defaultTime={defaultTime} channels={channels}
                      onUpdated={u => setMessages(ms => ms.map(x => x.id === u.id ? u : x))}
                      onDeleted={id => setMessages(ms => ms.filter(x => x.id !== id))}
                      onSent={(id, ts) => setMessages(ms => ms.map(x =>
                        x.id === id ? { ...x, status: 'sent' as const, slack_ts: ts } : x
                      ))}
                    />
                  ))}
                </div>
              )}

              {recentMsgs.length > 0 && (
                <div className="cq-recent">
                  <div className="cq-queue-hd">
                    <span className="cq-queue-title">Recent</span>
                  </div>
                  <div className="cq-msg-list">
                    {recentMsgs.map(m => (
                      <QueuedMessageCard
                        key={m.id} msg={m} defaultTime={defaultTime} channels={channels}
                        onUpdated={u => setMessages(ms => ms.map(x => x.id === u.id ? u : x))}
                        onDeleted={id => setMessages(ms => ms.filter(x => x.id !== id))}
                        onSent={(id, ts) => setMessages(ms => ms.map(x =>
                          x.id === id ? { ...x, status: 'sent' as const, slack_ts: ts } : x
                        ))}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
