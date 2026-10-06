import { useState, useEffect, useCallback } from 'react'
import { MessagesSquare, RefreshCw, XCircle } from 'lucide-react'
import api from '@/services/api'
import type { SlackBotConversation } from '@/services/api'

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string) {
  const ms = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(ms / 60000)
  const h = Math.floor(ms / 3600000)
  const d = Math.floor(ms / 86400000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  if (h < 24) return `${h}h ago`
  if (d < 7) return `${d}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const W = [55, 70, 48, 65, 58, 72]

// ── Skeleton ─────────────────────────────────────────────────────────────────

export function SlackBotConversationsSkeleton() {
  return (
    <div className="sbc-chat-list">
      {Array.from({ length: 5 }).map((_, i) => (
        <div className="sbc-chat-turn" key={i}>
          <div className="skeleton" style={{ width: 120, height: 10, borderRadius: 4, marginBottom: 4 }} />
          <div className="sbc-bubble-row sbc-bubble-row--in">
            <div className="skeleton" style={{ width: `${W[i % 6]}%`, height: 36, borderRadius: 14 }} />
          </div>
          <div className="sbc-bubble-row sbc-bubble-row--out">
            <div className="skeleton" style={{ width: `${W[(i + 3) % 6]}%`, height: 36, borderRadius: 14 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Bot Conversations view (chat-bubble transcript) ───────────────────────────
// Mounted as the "MCP Activity" sub-tab inside the Slack page's tab system
// (SlackIntelligencePage.tsx). The backend /api/slack-bot-chat endpoint
// filters server-side via is_admin_view: admins see everyone's conversations,
// non-admins see only their own — no client-side role branching needed here.

export function BotConversationsView({ isAdmin }: { isAdmin: boolean }) {
  const [entries, setEntries] = useState<SlackBotConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    try {
      const res = await api.getSlackBotConversations(200)
      if (res.success && res.data) {
        setEntries(res.data)
        setError(null)
      } else {
        setError(res.message || 'Failed to load bot conversations')
      }
    } catch {
      setError('Failed to load bot conversations')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(() => load(true), 30000)
    return () => clearInterval(interval)
  }, [load])

  return (
    <div className="sbc-view">
      <div className="sbc-header">
        <div className="sbc-header-title">
          <MessagesSquare size={20} />
          <div>
            <h2>Bot Conversations</h2>
            <p>
              {isAdmin
                ? 'Every DM and @mention the Velocity Slack bot has replied to, across everyone, newest first'
                : 'What you have asked the Velocity Slack bot and what it replied, newest first'}
            </p>
          </div>
        </div>
        <div className="sbc-header-stats">
          <span className="sbc-stat sbc-stat--total">{entries.length} conversations</span>
          <button className="sbc-refresh-btn" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'sbc-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <SlackBotConversationsSkeleton />
      ) : error ? (
        <div className="sbc-empty">
          <XCircle size={32} />
          <p>{error}</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="sbc-empty">
          <MessagesSquare size={32} />
          <p>No conversations yet. DM or @mention Velocity in Slack and it will show up here.</p>
        </div>
      ) : (
        <div className="sbc-chat-list">
          {entries.map(c => (
            <div className="sbc-chat-turn" key={c.id}>
              <div className="sbc-chat-meta">
                <span>{isAdmin ? (c.slack_user_email || c.slack_user_id || 'Unknown sender') : 'You'}</span>
                <span className="sbc-dot">•</span>
                <span>{c.channel_label || c.channel_id}</span>
                <span className="sbc-dot">•</span>
                <span>{timeAgo(c.created_at)}</span>
              </div>
              <div className="sbc-bubble-row sbc-bubble-row--in">
                <div className="sbc-bubble sbc-bubble--in">
                  <div className="sbc-bubble-label">{isAdmin ? (c.slack_user_email || 'Sender') : 'You'}</div>
                  {c.incoming_text || '(empty message)'}
                </div>
              </div>
              <div className="sbc-bubble-row sbc-bubble-row--out">
                <div className={`sbc-bubble sbc-bubble--out ${!c.success ? 'sbc-bubble--error' : ''}`}>
                  <div className="sbc-bubble-label">Velocity</div>
                  {c.success ? (c.reply_text || '(no reply)') : `Failed to reply: ${c.error_message || 'unknown error'}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
