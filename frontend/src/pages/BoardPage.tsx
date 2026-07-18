import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  RefreshCw, Search, Users, ChevronDown, X,
  AlertTriangle, ArrowDownUp, ArrowUpNarrowWide, ArrowDownNarrowWide,
  Filter, LayoutDashboard, CalendarDays, Rows3,
} from 'lucide-react'
import { SprintScanLoader, QuantumOrbitLoader } from '@/components/brand/VelocityLoaders'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { KanbanBoard } from '../components/board'
import api, { getYouTrackAvatarMap } from '../services/api'
import type { YouTrackIssue, YouTrackSprint } from '../services/api'
import { getPMIssues, updatePMIssueState, getPMStates, getActiveSource } from '../services/pmDataService'
import { IssueDetailPanel } from '../components/IssueDetailPanel'
import { useSprintsCache } from '@/contexts/VelocityDataContext'
import { useYouTrackBaseUrl } from '@/hooks/useYouTrackBaseUrl'

const PAGE_SIZE = 20

interface ColPaginationState {
  skip: number
  hasMore: boolean
  loading: boolean
}


function priorityOrder(name: string): number {
  const p = (name || '').toLowerCase()
  if (p.includes('critical') || p.includes('show-stopper') || p.includes('blocker')) return 0
  if (p.includes('major')) return 1
  if (p.includes('normal') || p.includes('medium')) return 2
  if (p.includes('minor') || p.includes('cosmetic') || p.includes('low')) return 3
  return 4
}


type SortKey = 'newest' | 'priority' | 'alpha'

// ── Main Page ────────────────────────────────────────────────────────────────

export function BoardPage() {
  const ytBaseUrl = useYouTrackBaseUrl()
  const [issues, setIssues] = useState<YouTrackIssue[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [colPagination, setColPagination] = useState<Record<string, ColPaginationState>>({})
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIssue, setSelectedIssue] = useState<YouTrackIssue | null>(null)

  // ── Sprint state (shared cache — avoids duplicate fetch with DailyOps) ──────
  const { data: cachedSprints } = useSprintsCache()
  const sprints: YouTrackSprint[] = (cachedSprints as YouTrackSprint[] | null) ?? []
  const [activeSprint, setActiveSprint] = useState<YouTrackSprint | null | undefined>(undefined)
  const [sprintDropdownOpen, setSprintDropdownOpen] = useState(false)
  const sprintDropdownRef = useRef<HTMLDivElement>(null)

  // ── Filter state ───────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [filterPriorities, setFilterPriorities] = useState<string[]>([])
  const [priorities, setPriorities] = useState<{ name: string; background?: string; foreground?: string }[]>([])
  const [assigneeDropdownOpen, setAssigneeDropdownOpen] = useState(false)
  const assigneeDropdownRef = useRef<HTMLDivElement>(null)
  const [priorityDropdownOpen, setPriorityDropdownOpen] = useState(false)
  const priorityDropdownRef = useRef<HTMLDivElement>(null)

  // ── Sort state ─────────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>('newest')
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false)
  const sortDropdownRef = useRef<HTMLDivElement>(null)

  // ── Swimlane state ─────────────────────────────────────────────────────────
  type SwimlaneBy = 'none' | 'assignee' | 'priority' | 'board'
  const [swimlaneBy, setSwimlaneBy] = useState<SwimlaneBy>('none')
  const [swimlaneDropdownOpen, setSwimlaneDropdownOpen] = useState(false)
  const swimlaneDropdownRef = useRef<HTMLDivElement>(null)
  const [boardSwimlaneField, setBoardSwimlaneField] = useState<{
    field_name: string
    values: { name: string; background?: string; foreground?: string }[]
  } | null>(null)

  // ── Close dropdowns on outside click ──────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (assigneeDropdownRef.current && !assigneeDropdownRef.current.contains(e.target as Node))
        setAssigneeDropdownOpen(false)
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(e.target as Node))
        setSortDropdownOpen(false)
      if (priorityDropdownRef.current && !priorityDropdownRef.current.contains(e.target as Node))
        setPriorityDropdownOpen(false)
      if (sprintDropdownRef.current && !sprintDropdownRef.current.contains(e.target as Node))
        setSprintDropdownOpen(false)
      if (swimlaneDropdownRef.current && !swimlaneDropdownRef.current.contains(e.target as Node))
        setSwimlaneDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Close modal on Escape ──────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedIssue) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedIssue(null) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedIssue])

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchBoard = useCallback(async (silent = false, force = false, sprintId?: string) => {
    if (!silent) setLoading(true)
    else setSyncing(true)
    setError(null)
    try {
      let sortedCols: string[]
      if (getActiveSource() === 'youtrack') {
        try {
          const boardRes = await api.getYouTrackDefaultBoardColumns()
          const boardCols = (boardRes as any).data as import('../services/api').YouTrackColumn[] || []
          const seen = new Set<string>()
          const orderedCols: string[] = []
          boardCols.forEach(col => col.fieldValues.forEach(v => {
            if (!seen.has(v)) { seen.add(v); orderedCols.push(v) }
          }))
          sortedCols = orderedCols.length > 0 ? orderedCols : []
        } catch {
          sortedCols = []
        }
      } else {
        const statesRes = await getPMStates()
        const stateObjs = (statesRes.data as { name: string }[]) || []
        sortedCols = stateObjs.map(s => s.name)
      }
      setColumns(sortedCols)

      if (getActiveSource() === 'youtrack') {
        setIssues([])
        setColPagination({})
        const results = await Promise.all(
          sortedCols.map(col =>
            api.getYouTrackIssuesByState(col, 0, PAGE_SIZE, sprintId)
              .then(res => ({ col, data: (res as any).data as { issues: YouTrackIssue[]; hasMore: boolean } }))
              .catch(() => ({ col, data: { issues: [] as YouTrackIssue[], hasMore: false } }))
          )
        )
        const allIssues: YouTrackIssue[] = []
        const pagination: Record<string, ColPaginationState> = {}
        for (const { col, data } of results) {
          const colIssues = data?.issues ?? []
          allIssues.push(...colIssues)
          pagination[col] = { skip: colIssues.length, hasMore: data?.hasMore ?? false, loading: false }
        }
        setIssues(allIssues)
        setColPagination(pagination)
      } else {
        const issuesRes = await getPMIssues(force)
        if (issuesRes.data) setIssues(issuesRes.data as YouTrackIssue[])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load board')
    } finally {
      setLoading(false)
      setSyncing(false)
    }
  }, [])

  // ── Load more for a specific column (triggered by scroll) ─────────────────
  const handleLoadMore = useCallback(async (col: string) => {
    setColPagination(prev => {
      if (!prev[col] || prev[col].loading || !prev[col].hasMore) return prev
      return { ...prev, [col]: { ...prev[col], loading: true } }
    })

    const pg = colPagination[col]
    if (!pg || pg.loading || !pg.hasMore) return

    try {
      const res = await api.getYouTrackIssuesByState(col, pg.skip, PAGE_SIZE, activeSprint?.id)
      const data = (res as any).data as { issues: YouTrackIssue[]; hasMore: boolean } | null
      const newItems = data?.issues ?? []
      setIssues(prev => {
        const existingIds = new Set(prev.map(i => i.id))
        return [...prev, ...newItems.filter(i => !existingIds.has(i.id))]
      })
      setColPagination(prev => ({
        ...prev,
        [col]: { skip: pg.skip + newItems.length, hasMore: data?.hasMore ?? false, loading: false },
      }))
    } catch {
      setColPagination(prev => ({ ...prev, [col]: { ...prev[col], loading: false } }))
    }
  }, [colPagination, activeSprint])

  // Avatar map + live priorities — fetch once on mount
  useEffect(() => {
    getYouTrackAvatarMap().then(setAvatarMap)
    api.getYouTrackPriorities().then(res => {
      const raw = (res as any)?.data ?? []
      const items = Array.isArray(raw)
        ? raw.map((p: any) => typeof p === 'string'
            ? { name: p }
            : { name: p?.name ?? '', background: p?.background, foreground: p?.foreground }
          ).filter(p => p.name)
        : []
      setPriorities(items)
    }).catch(() => {})

    api.getYouTrackSwimlaneField().then(res => {
      const data = (res as any)?.data
      if (data?.field_name) setBoardSwimlaneField(data)
    }).catch(() => {})
  }, [])

  // Auto-select active sprint when sprints become available from cache.
  // activeSprint === undefined means "not yet initialized".
  useEffect(() => {
    if (activeSprint !== undefined) return
    if (getActiveSource() !== 'youtrack') {
      setActiveSprint(null)
      fetchBoard(false, false, undefined)
      return
    }
    if (sprints.length === 0) return  // wait for cache to populate
    const now = Date.now()
    const active = sprints
      .filter(s => !s.isCompleted && s.finish > now)
      .sort((a, b) => a.finish - b.finish)[0] ?? null
    setActiveSprint(active)
    fetchBoard(false, false, active?.id)
  }, [sprints, activeSprint, fetchBoard])

  // ── Derived values ─────────────────────────────────────────────────────────
  const allAssignees = useMemo(() =>
    Array.from(new Set(
      issues.map(i => i.assignee?.fullName || i.assignee?.login || '').filter(Boolean)
    )).sort()
  , [issues])

  const activeFilterCount = [
    searchQuery !== '',
    filterAssignee !== '',
    filterPriorities.length > 0,
  ].filter(Boolean).length

  const getColumnIssues = useCallback((colName: string): YouTrackIssue[] => {
    let list = issues.filter(i => i.status === colName)
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(i => i.id.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q))
    }
    if (filterAssignee) {
      list = list.filter(i =>
        (i.assignee?.fullName || i.assignee?.login || '') === filterAssignee
      )
    }
    if (filterPriorities.length > 0) {
      list = list.filter(i => filterPriorities.includes(i.priority || ''))
    }
    return list.sort((a, b) => {
      if (sortKey === 'alpha') return a.summary.localeCompare(b.summary)
      if (sortKey === 'priority') return priorityOrder(a.priority || '') - priorityOrder(b.priority || '')
      return (b.updated || 0) - (a.updated || 0)
    })
  }, [issues, searchQuery, filterAssignee, filterPriorities, sortKey])

  const handleSprintChange = useCallback((sprint: YouTrackSprint | null) => {
    setActiveSprint(sprint)
    setSprintDropdownOpen(false)
    fetchBoard(false, true, sprint?.id)
  }, [fetchBoard])

  const handleIssueMove = useCallback(async (issueId: string, newState: string) => {
    setIssues(prev => prev.map(i => i.id === issueId ? { ...i, status: newState } : i))
    try {
      await updatePMIssueState(issueId, newState)
    } catch {
      fetchBoard(true)
    }
  }, [fetchBoard])

  const clearFilters = () => {
    setSearchQuery('')
    setFilterAssignee('')
    setFilterPriorities([])
  }

  const visibleCount = useMemo(() =>
    columns.reduce((acc, col) => acc + getColumnIssues(col).length, 0)
  , [columns, getColumnIssues])

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading) {
    // Realistic card counts per column — vary like real board data
    const skelCols = [
      { color: '#64748b',              count: 10 },
      { color: 'var(--color-warning)', count: 5  },
      { color: '#8250df',              count: 13 },
      { color: 'var(--color-danger)',  count: 7  },
      { color: '#a78bfa',              count: 9  },
      { color: 'var(--color-success)', count: 11 },
    ]
    // Varying title widths so cards look organic, not identical
    const titleW  = ['88%','72%','95%','80%','65%','91%','76%','83%','69%','87%','74%','92%','78%']
    const title2W = ['55%','68%','48%','62%','71%','50%','64%','58%','45%','67%','52%','61%','59%']
    const sk = (w: number | string, h: number, r = 6) => (
      <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
    )
    return (
      <div className="pm-reports-page board-page-layout">
        {/* Skeleton header */}
        <div className="pm-tab-header" style={{ pointerEvents: 'none' }}>
          {sk(180, 22, 8)}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            {sk(110, 30, 8)}{sk(90, 30, 8)}{sk(80, 30, 8)}
          </div>
        </div>
        {/* Skeleton filter bar — search | assignee | priority | group by | sort */}
        <div className="board-filter-bar" style={{ pointerEvents: 'none', gap: 8, alignItems: 'center' }}>
          {sk(160, 30, 8)}
          {sk(110, 30, 8)}
          {sk(130, 30, 8)}
          {sk(105, 30, 8)}
          {sk(95, 30, 8)}
        </div>
        {/* Skeleton kanban board — fills full width + height */}
        <div className="board-kanban-wrap">
          <div className="kanban-board" style={{ pointerEvents: 'none' }}>
            {skelCols.map((col, ci) => (
              <div className="kanban-column" key={ci}>
                <div className="kanban-column-header">
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: col.color, flexShrink: 0, display: 'inline-block', opacity: 0.5 }} />
                  {sk(60 + ci * 8, 11, 4)}
                  <div style={{ marginLeft: 'auto' }}>{sk(28, 18, 12)}</div>
                </div>
                <div className="kanban-column-body">
                  {Array.from({ length: col.count }).map((_, ki) => (
                    <div className="task-card" key={ki} style={{ cursor: 'default', gap: '0.6rem', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        {sk(52, 13, 4)}{sk(44, 18, 12)}
                      </div>
                      {sk(titleW[ki % titleW.length], 12, 4)}
                      {ki % 3 !== 1 && sk(title2W[ki % title2W.length], 12, 4)}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                        {sk(54, 17, 12)}
                        {sk(22, 22, 11)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="pm-reports-page">
        <div className="pm-empty-state">
          <AlertTriangle size={40} />
          <p>{error}</p>
          <button className="btn-primary btn-sm" onClick={() => fetchBoard()}>Retry</button>
        </div>
      </div>
    )
  }

  function fmtSprintDate(ms: number) {
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  const sortLabel: Record<SortKey, string> = {
    newest: 'Newest First',
    priority: 'Priority',
    alpha: 'Alphabetical',
  }

  return (
    <div className="pm-reports-page board-page-layout">
      {/* ── Header — same pattern as pm-tab-header ─────────────────────────── */}
      <div className="pm-tab-header">
        <h3 className="pm-section-title">
          <LayoutDashboard size={18} />
          Project Board
          <span className="board-task-count">
            {activeFilterCount > 0 ? `${visibleCount} / ${issues.length}` : issues.length}
          </span>
          <span className="board-yt-badge">YouTrack</span>
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {/* Sprint selector — only for YouTrack */}
          {getActiveSource() === 'youtrack' && sprints.length > 0 && (
            <div className="pm-custom-dropdown" ref={sprintDropdownRef}>
              <button
                className="pm-custom-dropdown-trigger"
                onClick={() => setSprintDropdownOpen(o => !o)}
                style={{ minWidth: 160 }}
              >
                <CalendarDays size={14} />
                <span style={{ fontWeight: 600 }}>
                  {activeSprint ? activeSprint.name : 'All sprints'}
                </span>
                {activeSprint && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginLeft: 4 }}>
                    {fmtSprintDate(activeSprint.start)} – {fmtSprintDate(activeSprint.finish)}
                  </span>
                )}
                <ChevronDown size={12} className={`dropdown-chevron ${sprintDropdownOpen ? 'open' : ''}`} />
              </button>
              {sprintDropdownOpen && (
                <div className="pm-custom-dropdown-menu" style={{ minWidth: 220 }}>
                  <button
                    className={`pm-dropdown-item ${!activeSprint ? 'active' : ''}`}
                    onClick={() => handleSprintChange(null)}
                  >
                    <CalendarDays size={14} /><span>All sprints</span>
                  </button>
                  <div style={{ borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
                  {[...sprints]
                    .sort((a, b) => b.start - a.start)
                    .map(s => (
                      <button
                        key={s.id}
                        className={`pm-dropdown-item ${activeSprint?.id === s.id ? 'active' : ''}`}
                        onClick={() => handleSprintChange(s)}
                      >
                        <span style={{ flex: 1, textAlign: 'left' }}>
                          {s.isCompleted && <span style={{ opacity: 0.5 }}>✓ </span>}
                          {s.name}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                          {fmtSprintDate(s.start)} – {fmtSprintDate(s.finish)}
                        </span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
          <button
            className="btn-secondary btn-sm"
            onClick={() => fetchBoard(true, true, activeSprint?.id)}
            disabled={syncing}
            title="Refresh from YouTrack"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Filter bar — identical to PMReportsPage pm-filter-bar ──────────── */}
      <div className="pm-filter-bar">
        {/* Search */}
        <div className="pm-search-box">
          <Search size={13} />
          <input
            type="text"
            placeholder="Search issue…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Assignee dropdown */}
        <div className="pm-custom-dropdown" ref={assigneeDropdownRef}>
          <button className="pm-custom-dropdown-trigger" onClick={() => setAssigneeDropdownOpen(o => !o)}>
            {filterAssignee ? (
              <>
                {avatarMap[filterAssignee]
                  ? <img src={avatarMap[filterAssignee]} alt={filterAssignee} className="filter-avatar-img" />
                  : <span className="filter-avatar-placeholder">{filterAssignee.charAt(0).toUpperCase()}</span>}
                <span className="filter-assignee-name">{filterAssignee.split(' ')[0]}</span>
              </>
            ) : (
              <><Users size={14} /><span>All Assignees</span></>
            )}
            <ChevronDown size={12} className={`dropdown-chevron ${assigneeDropdownOpen ? 'open' : ''}`} />
          </button>
          {assigneeDropdownOpen && (
            <div className="pm-custom-dropdown-menu">
              <button
                className={`pm-dropdown-item ${!filterAssignee ? 'active' : ''}`}
                onClick={() => { setFilterAssignee(''); setAssigneeDropdownOpen(false) }}
              >
                <Users size={14} /><span>All Assignees</span>
              </button>
              {allAssignees.map(a => (
                <button
                  key={a}
                  className={`pm-dropdown-item ${filterAssignee === a ? 'active' : ''}`}
                  onClick={() => { setFilterAssignee(a); setAssigneeDropdownOpen(false) }}
                >
                  {avatarMap[a]
                    ? <img src={avatarMap[a]} alt={a} className="filter-avatar-img" />
                    : <span className="filter-avatar-placeholder">{a.charAt(0).toUpperCase()}</span>}
                  <span>{a}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Priority dropdown — multi-select, live from YouTrack */}
        {priorities.length > 0 && (
          <div className="pm-custom-dropdown" ref={priorityDropdownRef}>
            <button className="pm-custom-dropdown-trigger" onClick={() => setPriorityDropdownOpen(o => !o)}>
              <ArrowUpNarrowWide size={14} />
              {filterPriorities.length === 1 && (() => {
                const match = priorities.find(p => p.name === filterPriorities[0])
                return match ? <span className="board-priority-dot" style={match.background ? { background: match.background } : undefined} /> : null
              })()}
              <span>
                {filterPriorities.length === 0
                  ? 'All Priorities'
                  : filterPriorities.length === 1
                    ? filterPriorities[0]
                    : `${filterPriorities.length} priorities`}
              </span>
              {filterPriorities.length > 0 && (
                <span className="board-filter-count">{filterPriorities.length}</span>
              )}
              <ChevronDown size={12} className={`dropdown-chevron ${priorityDropdownOpen ? 'open' : ''}`} />
            </button>
            {priorityDropdownOpen && (
              <div className="pm-custom-dropdown-menu">
                <button
                  className={`pm-dropdown-item ${filterPriorities.length === 0 ? 'active' : ''}`}
                  onClick={() => { setFilterPriorities([]); setPriorityDropdownOpen(false) }}
                >
                  <ArrowUpNarrowWide size={14} /><span>All Priorities</span>
                </button>
                <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }} />
                {priorities.map(({ name, background }) => (
                  <button
                    key={name}
                    className={`pm-dropdown-item ${filterPriorities.includes(name) ? 'active' : ''}`}
                    onClick={() => setFilterPriorities(prev =>
                      prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]
                    )}
                  >
                    <span
                      className="board-priority-dot"
                      style={background ? { background } : undefined}
                    />
                    <span>{name}</span>
                    {filterPriorities.includes(name) && <span style={{ marginLeft: 'auto', color: 'var(--color-primary)', fontSize: '0.7rem' }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Group By (swimlane) dropdown */}
        <div className="pm-custom-dropdown" ref={swimlaneDropdownRef}>
          <button
            className={`pm-custom-dropdown-trigger${swimlaneBy !== 'none' ? ' active' : ''}`}
            onClick={() => setSwimlaneDropdownOpen(o => !o)}
          >
            <Rows3 size={14} />
            <span>{
              swimlaneBy === 'assignee' ? 'By Assignee'
              : swimlaneBy === 'priority' ? 'By Priority'
              : swimlaneBy === 'board' ? `By ${boardSwimlaneField?.field_name ?? 'Board'}`
              : 'Group By'
            }</span>
            <ChevronDown size={12} className={`dropdown-chevron ${swimlaneDropdownOpen ? 'open' : ''}`} />
          </button>
          {swimlaneDropdownOpen && (
            <div className="pm-custom-dropdown-menu">
              {([
                { key: 'none', label: 'No Grouping' },
                { key: 'assignee', label: 'Assignee' },
                { key: 'priority', label: 'Priority' },
                ...(boardSwimlaneField ? [{ key: 'board', label: `${boardSwimlaneField.field_name} (Board)` }] : []),
              ] as { key: SwimlaneBy; label: string }[]).map(({ key, label }) => (
                <button
                  key={key}
                  className={`pm-dropdown-item ${swimlaneBy === key ? 'active' : ''}`}
                  onClick={() => { setSwimlaneBy(key); setSwimlaneDropdownOpen(false) }}
                >
                  <Rows3 size={14} /><span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sort dropdown */}
        <div className="pm-custom-dropdown" ref={sortDropdownRef}>
          <button className="pm-custom-dropdown-trigger" onClick={() => setSortDropdownOpen(o => !o)}>
            <ArrowDownUp size={14} />
            <span>{sortLabel[sortKey]}</span>
            <ChevronDown size={12} className={`dropdown-chevron ${sortDropdownOpen ? 'open' : ''}`} />
          </button>
          {sortDropdownOpen && (
            <div className="pm-custom-dropdown-menu">
              {([
                { key: 'newest' as SortKey, label: 'Newest First', Icon: ArrowDownNarrowWide },
                { key: 'priority' as SortKey, label: 'Priority', Icon: ArrowUpNarrowWide },
                { key: 'alpha' as SortKey, label: 'Alphabetical', Icon: ArrowDownUp },
              ]).map(({ key, label, Icon }) => (
                <button
                  key={key}
                  className={`pm-dropdown-item ${sortKey === key ? 'active' : ''}`}
                  onClick={() => { setSortKey(key); setSortDropdownOpen(false) }}
                >
                  <Icon size={14} /><span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Clear filters */}
        {activeFilterCount > 0 && (
          <button className="btn-sm btn-ghost tl-clear-filters" onClick={clearFilters}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* ── Board ──────────────────────────────────────────────────────────── */}
      {columns.length === 0 ? (
        <div className="pm-empty-state">
          <div style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
            <VelocityLogo variant="icon" size="md" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
          </div>
          <Filter size={40} />
          <p>No columns found. Make sure YouTrack is configured in Settings.</p>
        </div>
      ) : (
        <div className="board-kanban-wrap">
          <KanbanBoard
            issues={issues}
            columns={columns}
            avatarMap={avatarMap}
            priorityColorMap={Object.fromEntries(priorities.map(p => [p.name, p.background ?? '']))}
            swimlaneBy={swimlaneBy}
            boardSwimlaneField={boardSwimlaneField ?? undefined}
            getColumnIssues={getColumnIssues}
            onIssueMove={handleIssueMove}
            onIssueClick={setSelectedIssue}
            colPagination={getActiveSource() === 'youtrack' ? colPagination : undefined}
            onLoadMore={getActiveSource() === 'youtrack' ? handleLoadMore : undefined}
          />
        </div>
      )}

      {/* ── Detail Modal ───────────────────────────────────────────────────── */}
      {selectedIssue && (
        <IssueDetailPanel
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
          ytBaseUrl={ytBaseUrl}
        />
      )}
    </div>
  )
}
