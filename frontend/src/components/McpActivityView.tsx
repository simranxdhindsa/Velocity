import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Activity, RefreshCw, CheckCircle2, XCircle, Ticket, MessageSquare,
  Search, Link2, Paperclip, ListTree, Users, Zap,
} from 'lucide-react'
import api from '@/services/api'
import type { MCPActivityEntry } from '@/services/api'
import { Pagination } from '@/components/Pagination'
import { JsonBlock } from '@/components/JsonBlock'
import { parseJsonObject } from '@/utils/json'
import { PAGE_SIZE_OPTIONS } from '@/utils/pagination'
import { usePersistedState, PERSIST } from '@/hooks/usePersistedState'
import '@/styles/pages/mcp-activity.css'

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

// One icon per tool "family" so the log reads at a glance.
function toolIcon(toolName: string) {
  if (toolName.includes('slack')) return MessageSquare
  if (toolName.includes('search')) return Search
  if (toolName.includes('link')) return Link2
  if (toolName.includes('attachment')) return Paperclip
  if (toolName.includes('sprint')) return ListTree
  if (toolName.includes('developer')) return Users
  if (toolName.includes('ticket')) return Ticket
  return Zap
}

// Tool output that is JSON (a fetched ticket, a search result) is shown
// pretty-printed; anything else stays plain text.
function ActivitySummary({ text }: { text: string }) {
  const json = useMemo(() => parseJsonObject(text), [text])
  return json ? <JsonBlock value={json} /> : <p className="mcpa-row-summary">{text}</p>
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

const W = [55, 70, 48, 65, 58, 72]

function McpActivitySkeleton() {
  return (
    <div className="mcpa-list">
      {Array.from({ length: 8 }).map((_, i) => (
        <div className="mcpa-row" key={i}>
          <div className="skeleton" style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0 }} />
          <div className="mcpa-row-main">
            <div className="skeleton" style={{ width: `${W[i % 6]}%`, height: 13, borderRadius: 4, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: `${W[(i + 3) % 6]}%`, height: 11, borderRadius: 4 }} />
          </div>
          <div className="skeleton" style={{ width: 70, height: 11, borderRadius: 4, flexShrink: 0 }} />
        </div>
      ))}
    </div>
  )
}

// ── View ─────────────────────────────────────────────────────────────────────
// "Claude actions" in Slack > MCP Activity (admins only): every tool call
// Claude made through the Velocity MCP connector. Was a standalone
// /mcp-activity page, which now redirects here (Dashboard.tsx).


export function McpActivityView() {
  const [entries, setEntries] = useState<MCPActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = usePersistedState(PERSIST.MCP_ACTIVITY_PAGE_SIZE, 10, { validate: PAGE_SIZE_OPTIONS })
  const [total, setTotal] = useState(0)
  const [failCount, setFailCount] = useState(0)
  const [paging, setPaging] = useState(false) // a page change is loading
  const listTop = useRef<HTMLDivElement>(null)

  const load = useCallback(async (p: number, silent = false) => {
    if (silent) setRefreshing(true)
    try {
      const res = await api.getMcpActivityPage(p, pageSize)
      if (res.success && res.data) {
        setEntries(res.data)
        setTotal(res.total ?? res.data.length)
        setFailCount(res.failed ?? 0)
        // The server snaps a page past the end (old entries pruned) to the last one.
        if (res.page && res.page !== p) setPage(res.page)
        setError(null)
      } else {
        setError(res.message || 'Failed to load MCP activity')
      }
    } catch {
      setError('Failed to load MCP activity')
    } finally {
      setLoading(false)
      setRefreshing(false)
      setPaging(false)
    }
  }, [pageSize])

  useEffect(() => {
    load(page)
    // MCP calls come from Claude asynchronously (not user-initiated in this
    // tab), so poll rather than relying on a manual refresh only.
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
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <div className="mcpa-page" ref={listTop}>
      <div className="mcpa-header">
        <div className="mcpa-header-title">
          <Activity size={20} />
          <div>
            <h2>Claude actions</h2>
            <p>What Claude has done through the Velocity connector, last 7 days, newest first</p>
          </div>
        </div>
        <div className="mcpa-header-stats">
          <span className="mcpa-stat mcpa-stat--total">{total} {total === 1 ? 'transaction' : 'transactions'}</span>
          {failCount > 0 && <span className="mcpa-stat mcpa-stat--fail">{failCount} failed</span>}
          <button className="mcpa-refresh-btn" onClick={() => load(page, true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'mcpa-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <McpActivitySkeleton />
      ) : error ? (
        <div className="mcpa-empty">
          <XCircle size={32} />
          <p>{error}</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="mcpa-empty">
          <Activity size={32} />
          <p>No MCP activity yet. Actions Claude takes through the Velocity connector will show up here.</p>
        </div>
      ) : (
        <>
          <div className={`mcpa-list${paging ? ' mcpa-list--paging' : ''}`}>
            {entries.map(e => {
              const Icon = toolIcon(e.tool_name)
              return (
                <div className="mcpa-row" key={e.id}>
                  <div className={`mcpa-row-icon ${e.success ? 'mcpa-row-icon--ok' : 'mcpa-row-icon--fail'}`}>
                    <Icon size={16} />
                  </div>
                  <div className="mcpa-row-main">
                    <div className="mcpa-row-top">
                      <span className="mcpa-row-action">{e.action_label}</span>
                      {e.success ? (
                        <CheckCircle2 size={13} className="mcpa-status-icon mcpa-status-icon--ok" />
                      ) : (
                        <XCircle size={13} className="mcpa-status-icon mcpa-status-icon--fail" />
                      )}
                    </div>
                    <ActivitySummary text={e.summary} />
                    <div className="mcpa-row-meta">
                      <span>{e.user_name}</span>
                      <span className="mcpa-dot">•</span>
                      <span>{e.duration_ms}ms</span>
                    </div>
                  </div>
                  <span className="mcpa-row-time">{timeAgo(e.created_at)}</span>
                </div>
              )
            })}
          </div>
          <Pagination page={page} pageSize={pageSize} total={total} onChange={changePage} disabled={paging} noun="transactions"
            onPageSizeChange={changePageSize} />
        </>
      )}
    </div>
  )
}
