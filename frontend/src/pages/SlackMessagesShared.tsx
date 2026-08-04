import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import { Pencil, Trash2, ExternalLink, MoreHorizontal, Copy, Check, X, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import type { LiveSlackMessage } from '@/services/api'
import {
  tsTimeLabel, parseMrkdwn, channelIcon,
  type HubChannel,
} from './slack-messages-types'

const Sk = ({ w, h, r = 6 }: { w: number | string; h: number; r?: number | string }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
)

// ── Channel sidebar item — sliding active highlight via layoutId ──────────────

export function ChannelListItem({
  channel, active, unread, onClick,
}: {
  channel: HubChannel
  active: boolean
  unread: boolean
  onClick: () => void
}) {
  return (
    <button className="smh-chan-item" onClick={onClick}>
      {active && (
        <motion.div
          className="smh-chan-highlight"
          layoutId="smh-chan-highlight"
          transition={{ type: 'spring', stiffness: 500, damping: 40 }}
        />
      )}
      <span className="smh-chan-icon">{channelIcon(channel.is_private)}</span>
      <span className={`smh-chan-name${unread ? ' smh-chan-name--unread' : ''}${active ? ' smh-chan-name--active' : ''}`}>
        {channel.name}
      </span>
      {unread && <span className="smh-chan-dot" />}
    </button>
  )
}

export function ChannelListSkeleton() {
  const W = [70, 55, 82, 60, 48, 75, 64]
  return (
    <div className="smh-chan-list">
      {W.map((w, i) => (
        <div key={i} className="smh-chan-item smh-chan-item--sk">
          <Sk w={14} h={14} r={4} />
          <Sk w={`${w}%`} h={12} r={4} />
        </div>
      ))}
    </div>
  )
}

// ── Message text renderer (Slack mrkdwn) ────────────────────────────────────────

export function MrkdwnText({ text }: { text: string }) {
  const tokens = parseMrkdwn(text)
  return (
    <>
      {tokens.map((t, i) => {
        if (t.type === 'bold') return <strong key={i}>{t.content}</strong>
        if (t.type === 'italic') return <em key={i}>{t.content}</em>
        if (t.type === 'code') return <code key={i} className="smh-inline-code">{t.content}</code>
        if (t.type === 'codeblock') return <pre key={i} className="smh-code-block"><code>{t.content}</code></pre>
        return <span key={i}>{t.content}</span>
      })}
    </>
  )
}

// ── Message row context menu (portal, matches the Slack "..." dropdown) ───────

function MessageMenu({
  anchorRef, onClose, onEdit, onDelete, onCopy, onViewInSlack, canManage,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onCopy: () => void
  onViewInSlack: () => void
  canManage: boolean
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: r.right - 200 })
    }
  }, [anchorRef])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  if (!pos) return null

  return createPortal(
    <motion.div
      ref={menuRef}
      className="smh-menu"
      style={{ top: pos.top, left: pos.left }}
      initial={{ opacity: 0, scale: 0.95, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4 }}
      transition={{ duration: 0.15 }}
    >
      {canManage && (
        <button className="smh-menu-item" onClick={() => { onEdit(); onClose() }}>
          <Pencil size={14} /> Edit message
        </button>
      )}
      <button className="smh-menu-item" onClick={() => { onCopy(); onClose() }}>
        <Copy size={14} /> Copy message
      </button>
      <button className="smh-menu-item" onClick={() => { onViewInSlack(); onClose() }}>
        <ExternalLink size={14} /> View in Slack
      </button>
      {canManage && (
        <>
          <div className="smh-menu-divider" />
          <button className="smh-menu-item smh-menu-item--danger" onClick={() => { onDelete(); onClose() }}>
            <Trash2 size={14} /> Delete message
          </button>
        </>
      )}
    </motion.div>,
    document.body,
  )
}

// ── Sender avatar — real Slack avatar, Velocity mark, or initials fallback ─────

function SenderAvatar({ message }: { message: LiveSlackMessage }) {
  if (message.is_velocity) {
    return (
      <div className="smh-msg-avatar">
        <VelocityLogo variant="icon" size="sm" mark="chevron" showStatusDot={false} />
      </div>
    )
  }
  if (message.user_avatar) {
    return (
      <div className="smh-msg-avatar smh-msg-avatar--img">
        <img src={message.user_avatar} alt={message.user_name} referrerPolicy="no-referrer" />
      </div>
    )
  }
  const initial = (message.user_name || '?').trim().charAt(0).toUpperCase() || '?'
  return <div className="smh-msg-avatar smh-msg-avatar--fallback">{initial}</div>
}

// ── Message row — hover-reveal action bar + inline edit ────────────────────────

export function MessageRow({
  message, onSaveEdit, onDelete, onViewInSlack, onOpenThread,
}: {
  message: LiveSlackMessage
  onSaveEdit: (id: string, text: string) => Promise<void>
  onDelete: (id: string) => void
  onViewInSlack: (message: LiveSlackMessage) => void
  onOpenThread?: (message: LiveSlackMessage) => void
}) {
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(message.text)
  const [saving, setSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const moreBtnRef = useRef<HTMLButtonElement>(null)

  const canManage = message.is_velocity && !!message.id

  const startEdit = () => { setEditText(message.text); setEditing(true) }
  const cancelEdit = () => setEditing(false)
  const saveEdit = async () => {
    if (!message.id || !editText.trim() || editText === message.text) { setEditing(false); return }
    setSaving(true)
    try {
      await onSaveEdit(message.id, editText.trim())
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="smh-msg-row"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <SenderAvatar message={message} />
      <div className="smh-msg-body">
        <div className="smh-msg-head">
          <span className="smh-msg-sender">{message.user_name || 'Unknown'}</span>
          {message.is_velocity && <span className="smh-msg-source smh-msg-source--velocity">Sent via Velocity</span>}
          <span className="smh-msg-time">{tsTimeLabel(message.ts)}</span>
        </div>

        {editing ? (
          <div className="smh-edit-box">
            <textarea
              className="smh-edit-textarea"
              value={editText}
              onChange={e => setEditText(e.target.value)}
              autoFocus
              rows={3}
            />
            <div className="smh-edit-actions">
              <button className="smh-edit-btn smh-edit-btn--cancel" onClick={cancelEdit}>
                <X size={13} /> Cancel
              </button>
              <button className="smh-edit-btn smh-edit-btn--save" onClick={saveEdit} disabled={saving}>
                <Check size={13} /> {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="smh-msg-text"><MrkdwnText text={message.text} /></div>
        )}

        {!editing && (message.reply_count ?? 0) > 0 && onOpenThread && (
          <button className="smh-thread-pill" onClick={() => onOpenThread(message)}>
            <MessageSquare size={12} />
            {message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </div>

      <AnimatePresence>
        {hovered && !editing && (
          <motion.div
            className="smh-hover-bar"
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.15 }}
          >
            {canManage && (
              <button className="smh-hover-btn" title="Edit" onClick={startEdit}>
                <Pencil size={14} />
              </button>
            )}
            <button className="smh-hover-btn" title="View in Slack" onClick={() => onViewInSlack(message)}>
              <ExternalLink size={14} />
            </button>
            {canManage && (
              <button className="smh-hover-btn smh-hover-btn--danger" title="Delete" onClick={() => onDelete(message.id!)}>
                <Trash2 size={14} />
              </button>
            )}
            <button ref={moreBtnRef} className="smh-hover-btn" title="More" onClick={() => setMenuOpen(o => !o)}>
              <MoreHorizontal size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {menuOpen && (
        <MessageMenu
          canManage={canManage}
          onClose={() => setMenuOpen(false)}
          onEdit={startEdit}
          onDelete={() => onDelete(message.id!)}
          onCopy={() => navigator.clipboard.writeText(message.text)}
          onViewInSlack={() => onViewInSlack(message)}
          anchorRef={moreBtnRef}
        />
      )}
    </div>
  )
}

export function MessageListSkeleton() {
  const W = [72, 45, 60, 38, 80, 50]
  return (
    <div className="smh-msg-list">
      {W.map((w, i) => (
        <div key={i} className="smh-msg-row">
          <Sk w={32} h={32} r="50%" />
          <div className="smh-msg-body">
            <div className="smh-msg-head"><Sk w={70} h={11} r={4} /></div>
            <Sk w={`${w}%`} h={13} r={4} />
          </div>
        </div>
      ))}
    </div>
  )
}
