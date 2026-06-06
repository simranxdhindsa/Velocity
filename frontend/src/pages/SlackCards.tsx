import { useState, useEffect, useRef } from 'react'
import {
  RefreshCw, CheckCircle, Clock, Hash, MessageSquare, Moon,
  ChevronDown, Star, Clipboard, Send, ExternalLink,
} from 'lucide-react'
import api from '../services/api'
import type { SlackMention, SlackThread } from '../services/api'

// ── Slack SVG icon ────────────────────────────────────────────────────────────
export function SlackIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.7 32.5a4.9 4.9 0 1 1-4.9-4.9h4.9v4.9Z" fill="#E01E5A"/>
      <path d="M22.2 32.5a4.9 4.9 0 0 1 9.8 0v12.3a4.9 4.9 0 0 1-9.8 0V32.5Z" fill="#E01E5A"/>
      <path d="M27.1 19.7a4.9 4.9 0 1 1 4.9-4.9v4.9H27.1Z" fill="#36C5F0"/>
      <path d="M27.1 22.2a4.9 4.9 0 0 1 0 9.8H14.8a4.9 4.9 0 0 1 0-9.8H27.1Z" fill="#36C5F0"/>
      <path d="M39.9 27.1a4.9 4.9 0 1 1 4.9 4.9H39.9V27.1Z" fill="#2EB67D"/>
      <path d="M37.4 27.1a4.9 4.9 0 0 1-9.8 0V14.8a4.9 4.9 0 0 1 9.8 0V27.1Z" fill="#2EB67D"/>
      <path d="M32.5 39.9a4.9 4.9 0 1 1-4.9 4.9V39.9h4.9Z" fill="#ECB22E"/>
      <path d="M32.5 37.4a4.9 4.9 0 0 1 0-9.8h12.3a4.9 4.9 0 0 1 0 9.8H32.5Z" fill="#ECB22E"/>
    </svg>
  )
}

// ── Utilities ─────────────────────────────────────────────────────────────────
export function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 7 ? `${d}d ago` : new Date(ts).toLocaleDateString()
}

export function cleanSlackText(text: string): string {
  return text
    .replace(/<@U[A-Z0-9]+>/g, '@user')
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<#C[A-Z0-9]+>/g, '#channel')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<https?:[^>]+>/g, '[link]')
    .replace(/\n+/g, ' ')
    .trim()
}

export function extractIssueIds(text: string): string[] {
  const m = text.match(/[A-Z]{2,10}-\d+/g)
  return m ? [...new Set(m)] : []
}

export function isSnoozed(snoozedUntil?: string) {
  if (!snoozedUntil) return false
  return new Date(snoozedUntil) > new Date()
}

function getSLAPct(createdAt: string): { pct: number; color: string; label: string } | null {
  const ageMins = (Date.now() - new Date(createdAt).getTime()) / 60000
  if (ageMins > 240) return { pct: 95, color: '#ef4444', label: `${Math.floor(ageMins / 60)}h · respond soon` }
  if (ageMins > 60) return { pct: 65, color: '#f59e0b', label: `${Math.floor(ageMins / 60)}h · in time` }
  if (ageMins > 20) return { pct: 30, color: '#f59e0b', label: `${Math.round(ageMins)}m · in time` }
  return null
}

// ── Avatar ────────────────────────────────────────────────────────────────────
const AVATAR_COLORS: Record<string, string> = {
  A: '#6366f1', B: '#8b5cf6', C: '#ec4899', D: '#0891b2',
  E: '#16a34a', F: '#d97706', G: '#ef4444', H: '#06b6d4',
}

export function AvatarFallback({ name, size = 28 }: { name: string; size?: number }) {
  const char = name.charAt(0).toUpperCase()
  const bg = AVATAR_COLORS[char] || '#6366f1'
  return (
    <div className="si2-avatar" style={{ width: size, height: size, background: `linear-gradient(135deg, ${bg}, ${bg}88)`, fontSize: size * 0.42 }}>
      {char}
    </div>
  )
}

// ── SLA Bar ───────────────────────────────────────────────────────────────────
export function SLABar({ createdAt }: { createdAt: string }) {
  const sla = getSLAPct(createdAt)
  if (!sla) return null
  return (
    <div className="si2-sla-wrap">
      <div className="si2-sla-track">
        <div className="si2-sla-fill" style={{ width: `${sla.pct}%`, background: sla.color }} />
      </div>
      <span className="si2-sla-label" style={{ color: sla.color }}>{sla.label}</span>
    </div>
  )
}

// ── Reply Composer ────────────────────────────────────────────────────────────
const QUICK_TEMPLATES_DEFAULT = ['On it!', 'Will check by EOD', 'Raised in YT']

interface ReplyComposerProps {
  open: boolean
  channelId: string
  threadTs: string
  mentionTs?: string
  savedTemplates?: string[]
  onClose: () => void
  onSent?: () => void
}

export function ReplyComposer({ open, channelId, threadTs, mentionTs, savedTemplates = [], onClose, onSent }: ReplyComposerProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const chips = [...QUICK_TEMPLATES_DEFAULT, ...savedTemplates]

  const handleSend = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    try {
      await api.slackReplyToThread(channelId, threadTs, text.trim(), mentionTs)
      setSent(true)
      setTimeout(() => { setSent(false); setText(''); onClose(); onSent?.() }, 1500)
    } catch {
      setSending(false)
    }
  }

  const handleCopy = () => { navigator.clipboard?.writeText(text).catch(() => {}) }

  if (!open) return null

  return (
    <div className="si2-reply-composer" onClick={e => e.stopPropagation()}>
      <div className="si2-template-chips">
        {chips.map(t => (
          <button key={t} className="si2-chip" onClick={() => setText(t)}>{t}</button>
        ))}
      </div>
      <textarea
        className="si2-reply-textarea"
        rows={2}
        placeholder="Reply in thread…"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend() }}
      />
      <div className="si2-reply-actions">
        <button className="si2-reply-copy" onClick={handleCopy} disabled={!text.trim()}>
          <Clipboard size={12} /> Copy
        </button>
        <button
          className={`si2-reply-send${sent ? ' sent' : ''}`}
          onClick={handleSend}
          disabled={!text.trim() || sending}
        >
          <Send size={12} />
          {sent ? 'Sent ✓' : sending ? 'Sending…' : 'Send to Thread'}
        </button>
      </div>
    </div>
  )
}

// ── Thread Preview ────────────────────────────────────────────────────────────
export function ThreadPreviewInline({ channelId, threadTs, replyCount }: {
  channelId: string; threadTs: string; replyCount?: number
}) {
  const [open, setOpen] = useState(false)
  const [replies, setReplies] = useState<Array<{ sender_name: string; text: string; timestamp: string }>>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState(false)

  const count = replyCount ?? 0
  if (count === 0) return null

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!open && replies.length === 0) {
      setLoading(true)
      setFetchError(false)
      try {
        const res = await api.getSlackThreadReplies(channelId, threadTs)
        setReplies(res.replies?.slice(-3) ?? [])
      } catch {
        setFetchError(true)
      }
      setLoading(false)
    }
    setOpen(v => !v)
  }

  return (
    <div className="si2-thread-preview">
      <button className="si2-thread-toggle" onClick={handleToggle}>
        {open ? `Collapse ▴` : `${count} ${count === 1 ? 'reply' : 'replies'} ▾`}
      </button>
      {open && (
        <div className="si2-thread-replies">
          {loading
            ? <div className="si2-thread-loading">Loading…</div>
            : fetchError
              ? <div className="si2-thread-loading" style={{ color: '#f87171' }}>Could not load replies</div>
              : replies.map(r => (
                <div key={r.timestamp} className="si2-thread-reply-row">
                  <AvatarFallback name={r.sender_name || '?'} size={20} />
                  <div className="si2-thread-reply-body">
                    <span className="si2-thread-reply-name">{r.sender_name}</span>
                    <span className="si2-thread-reply-text">{cleanSlackText(r.text).slice(0, 90)}</span>
                  </div>
                  <span className="si2-thread-reply-time">{timeAgo(r.timestamp)}</span>
                </div>
              ))
          }
        </div>
      )}
    </div>
  )
}

// ── Mention Card ──────────────────────────────────────────────────────────────
interface MentionCardProps {
  m: SlackMention
  slackTeamId: string
  channelName: string
  savedTemplates: string[]
  onDismiss: (ts: string) => void
  onSnooze: (ts: string, until: '2h' | 'tomorrow') => void
  onRemind: (m: SlackMention) => void
}

export function MentionCard({ m, slackTeamId, channelName, savedTemplates, onDismiss, onSnooze, onRemind }: MentionCardProps) {
  const [pinned, setPinned] = useState(m.pinned ?? false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const snoozeRef = useRef<HTMLDivElement>(null)
  const isDone = m.replied
  const snoozed = isSnoozed(m.snoozed_until)
  const issueIds = extractIssueIds(m.message_text)

  const urgencyColor = (() => {
    if (isDone) return 'rgba(255,255,255,0.06)'
    const ageMins = (Date.now() - new Date(m.created_at).getTime()) / 60000
    if (ageMins > 120) return '#ef4444'
    if (ageMins > 30) return '#f59e0b'
    return 'rgba(139,92,246,0.7)'
  })()

  const handlePin = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const next = !pinned
    setPinned(next)
    api.pinSlackMention(m.message_ts, next).catch(() => setPinned(!next))
  }

  useEffect(() => {
    if (!snoozeOpen) return
    const h = (e: MouseEvent) => {
      if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node)) setSnoozeOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [snoozeOpen])

  const openSlack = () => {
    const ts = m.message_ts.replace('.', '')
    window.location.href = `slack://channel?team=${slackTeamId}&id=${m.channel_id}&message=${ts}`
    setTimeout(() => window.open(`https://app.slack.com/client/${slackTeamId}/${m.channel_id}/p${ts}`, '_blank', 'noopener'), 1500)
  }

  return (
    <div className={`si2-card${isDone ? ' si2-card--done' : ''}${snoozed ? ' si2-card--snoozed' : ''}`}>
      <div className="si2-card-stripe" style={{ background: urgencyColor }} />
      <div className="si2-card-body">
        <div className="si2-card-head">
          {m.sender_avatar
            ? <img src={m.sender_avatar} alt={m.sender_name} className="si2-avatar" style={{ width: 28, height: 28 }} />
            : <AvatarFallback name={m.sender_name} size={28} />
          }
          <span className="si2-card-sender">{m.sender_name}</span>
          <span className="si2-card-channel"><Hash size={10} />{channelName || 'slack'}</span>
          {isDone && <span className="si2-done-chip"><CheckCircle size={10} /> Done</span>}
          {snoozed && <span className="si2-snooze-chip"><Moon size={10} /> Snoozed</span>}
          <span style={{ flex: 1 }} />
          <span className="si2-card-time">{timeAgo(m.created_at)}</span>
          <button className={`si2-pin-btn${pinned ? ' pinned' : ''}`} onClick={handlePin} title={pinned ? 'Unpin' : 'Pin'}>
            <Star size={13} fill={pinned ? 'currentColor' : 'none'} />
          </button>
        </div>

        <p className="si2-card-text" onClick={openSlack}>{cleanSlackText(m.message_text)}</p>

        {!isDone && !snoozed && <SLABar createdAt={m.created_at} />}

        {issueIds.length > 0 && (
          <div className="si2-issue-chips">
            {issueIds.map(id => <span key={id} className="si2-issue-chip">{id}</span>)}
          </div>
        )}

        <ThreadPreviewInline channelId={m.channel_id} threadTs={m.thread_ts || m.message_ts} />

        {!isDone && (
          <div className="si2-card-actions">
            <button className="si2-act-btn si2-act-done" onClick={() => onDismiss(m.message_ts)}>
              <CheckCircle size={12} /> Handled
            </button>
            <button
              className={`si2-act-btn si2-act-reply${replyOpen ? ' active' : ''}`}
              onClick={e => { e.stopPropagation(); setReplyOpen(v => !v) }}
            >
              <MessageSquare size={12} /> Reply
            </button>
            <div className="si2-snooze-wrap" ref={snoozeRef}>
              <button className="si2-act-btn si2-act-snooze" onClick={e => { e.stopPropagation(); setSnoozeOpen(v => !v) }}>
                <Moon size={12} /> Snooze <ChevronDown size={10} />
              </button>
              {snoozeOpen && (
                <div className="si2-snooze-menu" onClick={e => e.stopPropagation()}>
                  <button className="si2-snooze-opt" onClick={() => { onSnooze(m.message_ts, '2h'); setSnoozeOpen(false) }}>
                    <Clock size={12} /> 2 hours
                  </button>
                  <button className="si2-snooze-opt" onClick={() => { onSnooze(m.message_ts, 'tomorrow'); setSnoozeOpen(false) }}>
                    <Moon size={12} /> Tomorrow 9 AM
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <ReplyComposer
          open={replyOpen}
          channelId={m.channel_id}
          threadTs={m.thread_ts || m.message_ts}
          mentionTs={m.message_ts}
          savedTemplates={savedTemplates}
          onClose={() => setReplyOpen(false)}
          onSent={() => onDismiss(m.message_ts)}
        />
      </div>
    </div>
  )
}

// ── Thread Card ───────────────────────────────────────────────────────────────
interface ThreadCardProps {
  t: SlackThread
  slackTeamId: string
  channelName: string
  savedTemplates: string[]
  onSnooze: (ts: string, until: '2h' | 'tomorrow') => void
  onRemind: (t: SlackThread) => void
}

export function ThreadCard({ t, slackTeamId, channelName, savedTemplates, onSnooze, onRemind }: ThreadCardProps) {
  const [replyOpen, setReplyOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const snoozeRef = useRef<HTMLDivElement>(null)
  const snoozed = isSnoozed(t.snoozed_until)

  useEffect(() => {
    if (!snoozeOpen) return
    const h = (e: MouseEvent) => {
      if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node)) setSnoozeOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [snoozeOpen])

  const openSlack = () => {
    const ts = t.thread_ts.replace('.', '')
    window.location.href = `slack://channel?team=${slackTeamId}&id=${t.channel_id}&message=${ts}`
    setTimeout(() => window.open(`https://app.slack.com/client/${slackTeamId}/${t.channel_id}/p${ts}`, '_blank', 'noopener'), 1500)
  }

  const stripeColor = t.has_reply ? '#22c55e' : snoozed ? 'rgba(245,158,11,0.5)' : '#ef4444'

  return (
    <div className={`si2-card${t.has_reply ? ' si2-card--done' : ''}${snoozed ? ' si2-card--snoozed' : ''}`}>
      <div className="si2-card-stripe" style={{ background: stripeColor }} />
      <div className="si2-card-body">
        {/* Thread identity: channel icon + name (no fake sender — threads don't carry sender metadata) */}
        <div className="si2-card-head">
          <div className="si2-thread-channel-icon">
            <MessageSquare size={14} />
          </div>
          <span className="si2-card-sender"><Hash size={11} style={{ opacity: 0.7 }} />{channelName || t.channel_id}</span>
          {t.has_reply
            ? <span className="si2-reply-chip has-reply"><CheckCircle size={10} /> {t.reply_count} {t.reply_count === 1 ? 'reply' : 'replies'}</span>
            : <span className="si2-reply-chip no-reply">No replies yet</span>
          }
          {snoozed && <span className="si2-snooze-chip"><Moon size={10} /> Snoozed</span>}
          <span style={{ flex: 1 }} />
          <span className="si2-card-time">{timeAgo(t.created_at)}</span>
        </div>
        <p className="si2-card-text" onClick={openSlack}>{cleanSlackText(t.message_text)}</p>
        <ThreadPreviewInline channelId={t.channel_id} threadTs={t.thread_ts} replyCount={t.reply_count} />
        <div className="si2-card-actions">
          <button
            className={`si2-act-btn si2-act-reply${replyOpen ? ' active' : ''}`}
            onClick={e => { e.stopPropagation(); setReplyOpen(v => !v) }}
          >
            <MessageSquare size={12} /> Reply
          </button>
          <button className="si2-act-btn" onClick={() => onRemind(t)}>
            <Clock size={12} /> Follow up
          </button>
          <div className="si2-snooze-wrap" ref={snoozeRef}>
            <button className="si2-act-btn si2-act-snooze" onClick={e => { e.stopPropagation(); setSnoozeOpen(v => !v) }}>
              <Moon size={12} /> Snooze <ChevronDown size={10} />
            </button>
            {snoozeOpen && (
              <div className="si2-snooze-menu" onClick={e => e.stopPropagation()}>
                <button className="si2-snooze-opt" onClick={() => { onSnooze(t.thread_ts, '2h'); setSnoozeOpen(false) }}>
                  <Clock size={12} /> 2 hours
                </button>
                <button className="si2-snooze-opt" onClick={() => { onSnooze(t.thread_ts, 'tomorrow'); setSnoozeOpen(false) }}>
                  <Moon size={12} /> Tomorrow 9 AM
                </button>
              </div>
            )}
          </div>
        </div>
        <ReplyComposer
          open={replyOpen}
          channelId={t.channel_id}
          threadTs={t.thread_ts}
          savedTemplates={savedTemplates}
          onClose={() => setReplyOpen(false)}
        />
      </div>
    </div>
  )
}

// ── Empty ─────────────────────────────────────────────────────────────────────
export function EmptyState({ icon: Icon, text, sub }: { icon: React.ElementType; text: string; sub?: string }) {
  return (
    <div className="si2-empty">
      <Icon size={36} />
      <p>{text}</p>
      {sub && <p className="si2-empty-sub">{sub}</p>}
    </div>
  )
}

// ── Loading ───────────────────────────────────────────────────────────────────
export function LoadingState() {
  return (
    <div className="si2-empty">
      <RefreshCw size={20} className="spin" />
      <p>Loading…</p>
    </div>
  )
}

// Needed in sibling file but defined here for colocation with card styles
export const _ = ExternalLink  // prevents unused import warning
