import { useState, useEffect, useCallback, useMemo } from 'react'
import { AlertTriangle, Filter } from 'lucide-react'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { KanbanBoard } from '../components/board'
import { BoardToolbar, BoardToolbarSkeleton } from '../components/board/BoardToolbar'
import {
  NO_SUBSYSTEM, buildFilterOptions, priorityOrder,
  type SortKey, type SwimlaneBy,
} from '../components/board/board-filters'
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

  // ── Filter state ───────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [filterPriorities, setFilterPriorities] = useState<string[]>([])
  const [filterSubsystems, setFilterSubsystems] = useState<string[]>([])
  const [priorities, setPriorities] = useState<{ name: string; background?: string; foreground?: string }[]>([])
  const [subsystemCatalog, setSubsystemCatalog] = useState<{ name: string; background?: string }[]>([])

  // ── Sort + swimlane state ──────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>('newest')
  const [swimlaneBy, setSwimlaneBy] = useState<SwimlaneBy>('none')
  const [boardSwimlaneField, setBoardSwimlaneField] = useState<{
    field_name: string
    values: { name: string; background?: string; foreground?: string }[]
  } | null>(null)

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

    // The project's configured subsystems (with colours) seed the Subsystem filter.
    // Anything else found on the loaded tickets is added on top, so it stays dynamic.
    if (getActiveSource() === 'youtrack') {
      api.getYouTrackFormMeta().then(res => {
        if (res.success && res.data) setSubsystemCatalog(res.data.subsystems ?? [])
      }).catch(() => {})
    }
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
  const assigneeOptions = useMemo(() =>
    buildFilterOptions(issues.map(i => i.assignee?.fullName || i.assignee?.login || ''))
  , [issues])

  const priorityOptions = useMemo(() =>
    buildFilterOptions(issues.map(i => i.priority || ''), priorities)
  , [issues, priorities])

  const subsystemOptions = useMemo(() =>
    buildFilterOptions(issues.map(i => i.subsystem || NO_SUBSYSTEM), subsystemCatalog)
  , [issues, subsystemCatalog])

  const activeFilterCount = [
    searchQuery !== '',
    filterAssignee !== '',
    filterPriorities.length > 0,
    filterSubsystems.length > 0,
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
    if (filterSubsystems.length > 0) {
      list = list.filter(i => filterSubsystems.includes(i.subsystem || NO_SUBSYSTEM))
    }
    return list.sort((a, b) => {
      if (sortKey === 'alpha') return a.summary.localeCompare(b.summary)
      if (sortKey === 'priority') return priorityOrder(a.priority || '') - priorityOrder(b.priority || '')
      return (b.updated || 0) - (a.updated || 0)
    })
  }, [issues, searchQuery, filterAssignee, filterPriorities, filterSubsystems, sortKey])

  const handleSprintChange = useCallback((sprint: YouTrackSprint | null) => {
    setActiveSprint(sprint)
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
    setFilterSubsystems([])
  }

  const visibleCount = useMemo(() =>
    columns.reduce((acc, col) => acc + getColumnIssues(col).length, 0)
  , [columns, getColumnIssues])

  const hasMore = Object.values(colPagination).some(pg => pg.hasMore)
  const isYouTrack = getActiveSource() === 'youtrack'
  const sourceLabel = isYouTrack ? 'YouTrack' : 'Asana'

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
        <BoardToolbarSkeleton />
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

  return (
    <div className="pm-reports-page board-page-layout">
      <BoardToolbar
        sourceLabel={sourceLabel}
        totalCount={issues.length}
        visibleCount={visibleCount}
        hasMore={hasMore}
        filtered={activeFilterCount > 0}
        sprints={isYouTrack ? sprints : []}
        activeSprint={activeSprint}
        onSprintChange={handleSprintChange}
        syncing={syncing}
        onRefresh={() => fetchBoard(true, true, activeSprint?.id)}
        search={searchQuery}
        onSearchChange={setSearchQuery}
        assignee={filterAssignee}
        assigneeOptions={assigneeOptions}
        avatarMap={avatarMap}
        onAssigneeChange={setFilterAssignee}
        priorityOptions={priorityOptions}
        selectedPriorities={filterPriorities}
        onPrioritiesChange={setFilterPriorities}
        subsystemOptions={subsystemOptions}
        selectedSubsystems={filterSubsystems}
        onSubsystemsChange={setFilterSubsystems}
        swimlaneBy={swimlaneBy}
        swimlaneFieldName={boardSwimlaneField?.field_name}
        onSwimlaneChange={setSwimlaneBy}
        sortKey={sortKey}
        onSortChange={setSortKey}
        onClear={clearFilters}
      />

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
            subsystemColorMap={Object.fromEntries(subsystemOptions.filter(o => o.color).map(o => [o.name, o.color as string]))}
            swimlaneBy={swimlaneBy}
            boardSwimlaneField={boardSwimlaneField ?? undefined}
            getColumnIssues={getColumnIssues}
            onIssueMove={handleIssueMove}
            onIssueClick={setSelectedIssue}
            colPagination={isYouTrack ? colPagination : undefined}
            onLoadMore={isYouTrack ? handleLoadMore : undefined}
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
