import { useState, useEffect, useCallback, useRef } from 'react'
import { MessagesSquare, RefreshCw, XCircle } from 'lucide-react'
import api from '@/services/api'
import type { SlackBotConversation } from '@/services/api'
import { SlackMessageText } from '@/components/SlackMessageText'
import { Pagination } from '@/components/Pagination'
import { PAGE_SIZE_OPTIONS } from '@/utils/pagination'
import { usePersistedState, PERSIST } from '@/hooks/usePersistedState'

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
// The "Bot conversations" view of the Slack page's "MCP Activity" sub-tab
// (SlackIntelligencePage.tsx; admins also get the "Claude actions" view).
// The backend /api/slack-bot-chat endpoint
// filters server-side via is_admin_view: admins see everyone's conversations,
// non-admins see only their own — no client-side role branching needed here.


export function BotConversationsView({ isAdmin }: { isAdmin: boolean }) {
  const [entries, setEntries] = useState<SlackBotConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = usePersistedState(PERSIST.SLACK_BOT_CHAT_PAGE_SIZE, 10, { validate: PAGE_SIZE_OPTIONS })
  const [total, setTotal] = useState(0)
  const [paging, setPaging] = useState(false) // a page change is loading
  const top = useRef<HTMLDivElement>(null)

  const load = useCallback(async (p: number, silent = false) => {
    if (silent) setRefreshing(true)
    try {
      const res = await api.getSlackBotConversationsPage(p, pageSize)
      if (res.success && res.data) {
        setEntries(res.data)
        setTotal(res.total ?? res.data.length)
        // The server snaps a page past the end (old entries pruned) to the last one.
        if (res.page && res.page !== p) setPage(res.page)
        setError(null)
      } else {
        setError(res.message || 'Failed to load bot conversations')
      }
    } catch {
      setError('Failed to load bot conversations')
    } finally {
      setLoading(false)
      setRefreshing(false)
      setPaging(false)
    }
  }, [pageSize])

  useEffect(() => {
    load(page)
    const interval = setInterval(() => load(page, true), 30000)
    return () => clearInterval(interval)
  }, [load, page])

  const changePageSize = useCallback((n: number) => {
    if (n === pageSize) return
    setPaging(true)
    setPageSize(n)
    setPage(1)
  }, [pageSize, setPageSize])

  const changePage = useCallback((p: number) => {
    setPaging(true)
    setPage(p)
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <div className="sbc-view" ref={top}>
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
          <span className="sbc-stat sbc-stat--total">{total} {total === 1 ? 'conversation' : 'conversations'}</span>
          <button className="sbc-refresh-btn" onClick={() => load(page, true)} disabled={refreshing}>
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
        <>
          <div className={`sbc-chat-list${paging ? ' sbc-chat-list--paging' : ''}`}>
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
                    {c.incoming_text ? <SlackMessageText text={c.incoming_text} /> : '(empty message)'}
                  </div>
                </div>
                <div className="sbc-bubble-row sbc-bubble-row--out">
                  <div className={`sbc-bubble sbc-bubble--out ${!c.success ? 'sbc-bubble--error' : ''}`}>
                    <div className="sbc-bubble-label">Velocity</div>
                    {c.success
                      ? (c.reply_text ? <SlackMessageText text={c.reply_text} /> : '(no reply)')
                      : `Failed to reply: ${c.error_message || 'unknown error'}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} pageSize={pageSize} total={total} onChange={changePage} disabled={paging} noun="conversations"
            onPageSizeChange={changePageSize} />
        </>
      )}
    </div>
  )
}
