import React, { useState, useEffect, useCallback, useLayoutEffect, useRef, useMemo } from 'react'
import { GitBranch, Plus, Minus } from 'lucide-react'
import { IssueDetailPanel } from '@/components/IssueDetailPanel'
import { IssueDetailSkeleton } from '@/components/IssueDetailSkeleton'
import { GanttGrid, ROW_H, HDR_H } from '@/components/gantt/GanttGrid'
import { GanttArrows } from '@/components/gantt/GanttArrows'
import { GanttTable } from '@/components/gantt/GanttTable'
import { GanttToolbar } from '@/components/gantt/GanttToolbar'
import {
  type GanttIssue, type GanttDependency, type GanttChartSummary, type GanttView, type GanttIssueRow,
  DAY_PX, addDays, diffDays, startOfDay, buildRows,
} from './gantt-types'
import { useWorkflowConfig } from '@/hooks/useWorkflowConfig'
import { usePersistedState, PERSIST } from '@/hooks/usePersistedState'
import api from '@/services/api'
import type { YouTrackIssue } from '@/services/api'
import '@/styles/pages/gantt.css'
import '@/styles/pages/gantt-timeline.css'

// ── Constants ──────────────────────────────────────────────────────────────────

const CHART_KEY = 'gantt_chart_id'
const SCALES: GanttView[] = ['day', 'week', 'month']
/** Prev/next jump per scale, in days. */
const STEP_DAYS: Record<GanttView, number> = { day: 7, week: 14, month: 30 }

// ── Skeleton ──────────────────────────────────────────────────────────────────

const W = [55, 70, 48, 65, 58, 72]

function GanttSkeleton() {
  return (
    <div className="gt-body">
      <div className="gt-tb gt-tb--skeleton">
        <div className="gt-tb-hdr" style={{ height: HDR_H }} />
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="gt-tb-row" style={{ height: ROW_H }}>
            <div className="gt-tb-cell gt-tb-task"><div className="skeleton" style={{ width: `${W[i % 6]}%`, height: 10, borderRadius: 4 }} /></div>
            <div className="gt-tb-cell gt-tb-owner">
              <div className="skeleton" style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0 }} />
              <div className="skeleton" style={{ width: `${W[(i + 2) % 6]}%`, height: 10, borderRadius: 4 }} />
            </div>
            <div className="gt-tb-cell gt-tb-status"><div className="skeleton" style={{ width: 64, height: 18, borderRadius: 6 }} /></div>
          </div>
        ))}
      </div>
      <div className="gt-timeline">
        <div className="gt-hdr gt-hdr--skeleton" style={{ height: HDR_H }} />
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="gt-sk-row" style={{ height: ROW_H }}>
            <div className="skeleton" style={{ marginLeft: `${(i * 7) % 40}%`, width: `${20 + (i % 3) * 12}%`, height: i % 4 === 0 ? 6 : 22, borderRadius: 6 }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── GanttPage ─────────────────────────────────────────────────────────────────

export function GanttPage() {
  const [charts,      setCharts]      = useState<GanttChartSummary[]>([])
  const [activeChart, setActiveChart] = useState<GanttChartSummary | null>(null)
  const [ganttId,     setGanttId]     = useState<string | null>(null)
  const [issues,      setIssues]      = useState<GanttIssue[]>([])
  const [deps,        setDeps]        = useState<GanttDependency[]>([])
  const [loading,     setLoading]     = useState(false)
  const [view,        setView]        = usePersistedState<GanttView>(PERSIST.GANTT_VIEW, 'week', { validate: SCALES })
  const [editMode,    setEditMode]    = useState(false)
  const [collapsed,   setCollapsed]   = useState<Set<string>>(new Set())
  const [visible,     setVisible]     = useState({ from: 0, to: 0 })   // day indexes on screen

  // Connect-dependency draw state
  const [connectingFrom,  setConnectingFrom]  = useState<string | null>(null)  // memberId
  const [connectMousePos, setConnectMousePos] = useState<{ x: number; y: number } | null>(null)

  // Detail panel
  const [detailIssue,   setDetailIssue]   = useState<YouTrackIssue | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [ytBaseUrl,     setYtBaseUrl]     = useState('')

  const tableRef      = useRef<HTMLDivElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const scrolledFor   = useRef<string | null>(null)   // chart already scrolled to today
  const keepCenter    = useRef<number | null>(null)   // day to re-centre on after a scale change

  const { config: wfConfig } = useWorkflowConfig()

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    api.getYouTrackIntegration().then(res => {
      setYtBaseUrl((res.data?.base_url || '').replace(/\/$/, ''))
    }).catch(() => {})

    api.getGanttCharts().then(res => {
      const list = (res.data as GanttChartSummary[] | undefined) ?? []
      setCharts(list)
      const savedId = localStorage.getItem(CHART_KEY)
      const saved   = savedId ? list.find(c => c.id === savedId) : null
      const pick    = saved ?? list[0] ?? null
      if (pick) { setActiveChart(pick); setGanttId(pick.id) }
    }).catch(() => {})
  }, [])

  const fetchChart = useCallback((id: string) => {
    setLoading(true)
    api.getGanttChart(id).then(res => {
      const data = res.data as { issues?: GanttIssue[]; dependencies?: GanttDependency[]; ganttId?: string } | undefined
      setIssues(data?.issues ?? [])
      setDeps(data?.dependencies ?? [])
      setGanttId(data?.ganttId ?? id)
    }).catch(() => {
      setIssues([])
      setDeps([])
    }).finally(() => setLoading(false))
  }, [])

  const activeChartId = activeChart?.id
  useEffect(() => {
    if (!activeChartId) return
    scrolledFor.current = null
    fetchChart(activeChartId)
  }, [activeChartId, fetchChart])

  const handleChartSelect = useCallback((id: string) => {
    const c = charts.find(x => x.id === id)
    if (!c) return
    setActiveChart(c)
    localStorage.setItem(CHART_KEY, c.id)
  }, [charts])

  // ── Rows (grouped by workflow state) ──────────────────────────────────────

  const { roleOf, rankOf } = useMemo(() => {
    const role = new Map<string, string>()
    const rank = new Map<string, number>()
    for (const col of wfConfig?.column_hierarchy ?? []) {
      for (const name of [col.state, ...(col.aliases || [])]) {
        role.set(name.toLowerCase(), col.role)
        rank.set(name.toLowerCase(), col.rank)
      }
    }
    return {
      roleOf: (s: string) => role.get(s.toLowerCase()) ?? '',
      rankOf: (s: string) => rank.get(s.toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
    }
  }, [wfConfig])

  const rows = useMemo(() => buildRows(issues, roleOf, rankOf, collapsed), [issues, roleOf, rankOf, collapsed])

  const toggleGroup = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // ── View geometry: always spans the tickets and the weeks around today ────

  const viewStart = useMemo((): Date => {
    const starts = issues.map(i => i.startDate ?? i.dueDate).filter(Boolean) as number[]
    const from = Math.min(addDays(startOfDay(new Date()), -14).getTime(), ...starts)
    const d = addDays(startOfDay(new Date(from)), -3)
    return addDays(d, -((d.getDay() + 6) % 7))   // start on a Monday
  }, [issues])

  const totalDays = useMemo((): number => {
    const ends = issues.map(i => i.dueDate ?? i.startDate).filter(Boolean) as number[]
    const to = Math.max(addDays(startOfDay(new Date()), 45).getTime(), ...ends)
    return diffDays(viewStart, addDays(new Date(to), 7))
  }, [issues, viewStart])

  const dayPx = DAY_PX[view]

  // ── Scrolling ─────────────────────────────────────────────────────────────

  const scrollToDay = useCallback((day: number, smooth = true) => {
    const w = canvasWrapRef.current
    if (!w) return
    w.scrollTo({ left: Math.max(0, day * dayPx - w.clientWidth / 2), behavior: smooth ? 'smooth' : 'auto' })
  }, [dayPx])

  const todayDay = diffDays(viewStart, new Date())
  const centerDay = Math.round((visible.from + visible.to) / 2)

  // Open each chart on today.
  useLayoutEffect(() => {
    if (loading || !activeChart || issues.length === 0 || scrolledFor.current === activeChart.id) return
    scrolledFor.current = activeChart.id
    scrollToDay(todayDay, false)
  }, [loading, activeChart, issues.length, scrollToDay, todayDay])

  // Keep the same date in the middle when the scale changes.
  useLayoutEffect(() => {
    if (keepCenter.current === null) return
    scrollToDay(keepCenter.current, false)
    keepCenter.current = null
  }, [view, scrollToDay])

  const changeView = useCallback((v: GanttView) => {
    keepCenter.current = centerDay
    setView(v)
  }, [centerDay, setView])

  const zoom = useCallback((dir: -1 | 1) => {
    const i = SCALES.indexOf(view) - dir
    if (i >= 0 && i < SCALES.length) changeView(SCALES[i])
  }, [view, changeView])

  const frame = useRef(0)
  const onCanvasScroll = useCallback(() => {
    const t = tableRef.current; const w = canvasWrapRef.current
    if (!w) return
    if (t && t.scrollTop !== w.scrollTop) t.scrollTop = w.scrollTop
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setVisible({
      from: Math.floor(w.scrollLeft / dayPx),
      to: Math.floor((w.scrollLeft + w.clientWidth) / dayPx),
    }))
  }, [dayPx])

  const onTableScroll = useCallback(() => {
    const t = tableRef.current; const w = canvasWrapRef.current
    if (t && w && w.scrollTop !== t.scrollTop) w.scrollTop = t.scrollTop
  }, [])

  const periodLabel = useMemo(() => {
    const d = addDays(viewStart, centerDay)
    return d.toLocaleString('default', { month: 'long', year: 'numeric' })
  }, [viewStart, centerDay])

  // ── Date update (drag/resize) ──────────────────────────────────────────────

  const handleUpdateDates = useCallback(async (memberId: string, startMs: number | null, dueMs: number | null) => {
    if (!ganttId) return
    setIssues(prev => prev.map(i => {
      if (i.memberId !== memberId) return i
      const estimation = (startMs && dueMs) ? Math.max(0, Math.floor((dueMs - startMs) / 60_000)) : i.estimation
      return { ...i, startDate: startMs, dueDate: dueMs, estimation }
    }))
    try {
      await api.updateGanttMember(ganttId, memberId, startMs, dueMs)
    } catch {
      fetchChart(ganttId)
    }
  }, [ganttId, fetchChart])

  // ── Connect dependency ─────────────────────────────────────────────────────

  const handleConnectStart = useCallback((e: React.MouseEvent, memberId: string) => {
    e.preventDefault()
    setConnectingFrom(memberId)
    setConnectMousePos(null)
  }, [])

  useEffect(() => {
    if (!connectingFrom) return
    const onMove = (e: MouseEvent) => {
      const wrap = canvasWrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      setConnectMousePos({
        x: e.clientX - rect.left + wrap.scrollLeft,
        y: e.clientY - rect.top  + wrap.scrollTop - HDR_H,
      })
    }
    const onUp = () => { setConnectingFrom(null); setConnectMousePos(null) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [connectingFrom])

  const handleConnectEnd = useCallback((targetMemberId: string) => {
    if (!connectingFrom || connectingFrom === targetMemberId) return
    setConnectingFrom(null)
    setConnectMousePos(null)
    // Optimistic: show the arrow immediately (not saved to YouTrack yet)
    setDeps(prev => prev.some(d => d.sourceId === connectingFrom && d.targetId === targetMemberId)
      ? prev
      : [...prev, { sourceId: connectingFrom, targetId: targetMemberId }])
  }, [connectingFrom])

  const handleRemoveDep = useCallback((dep: GanttDependency) => {
    if (!editMode) return
    setDeps(prev => prev.filter(d => !(d.sourceId === dep.sourceId && d.targetId === dep.targetId)))
  }, [editMode])

  // ── Issue detail panel ────────────────────────────────────────────────────

  const openDetail = useCallback(async (row: GanttIssueRow) => {
    if (detailLoading) return
    setDetailLoading(true)
    try {
      const res  = await api.getYouTrackIssue(row.issue.idReadable)
      if (res.data) setDetailIssue(res.data)
    } catch {
      // panel just doesn't open
    } finally { setDetailLoading(false) }
  }, [detailLoading])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="gt-page">
      <div className="gt-card">
        <GanttToolbar
          charts={charts}
          activeChartId={activeChart?.id ?? ''}
          onChartChange={handleChartSelect}
          view={view}
          onViewChange={changeView}
          periodLabel={issues.length ? periodLabel : ''}
          onToday={() => scrollToDay(todayDay)}
          onStep={dir => scrollToDay(centerDay + dir * STEP_DAYS[view])}
          editMode={editMode}
          onEditToggle={() => setEditMode(m => !m)}
          disabled={issues.length === 0}
        />

        {loading ? (
          <GanttSkeleton />
        ) : issues.length === 0 ? (
          <div className="gt-empty">
            <GitBranch size={40} opacity={0.3} />
            <p>{activeChart ? 'No scheduled issues in this chart.' : 'Select a Gantt chart to view.'}</p>
          </div>
        ) : (
          <div className="gt-body">
            <div className="gt-tb-scroll" ref={tableRef} onScroll={onTableScroll}>
              <GanttTable rows={rows} onToggleGroup={toggleGroup} onIssueClick={openDetail} />
            </div>

            <div className="gt-timeline">
              <div className="gt-canvas-wrap" ref={canvasWrapRef} onScroll={onCanvasScroll}>
                <div className="gt-canvas-inner" style={{ width: totalDays * dayPx }}>
                  <GanttGrid
                    rows={rows}
                    viewStart={viewStart}
                    totalDays={totalDays}
                    view={view}
                    editMode={editMode}
                    onUpdateDates={handleUpdateDates}
                    onConnectStart={handleConnectStart}
                    onIssueClick={openDetail}
                    visible={visible}
                    onJump={scrollToDay}
                  />
                  <div className="gt-arrow-layer" style={{ top: HDR_H }}>
                    <GanttArrows
                      rows={rows}
                      dependencies={deps}
                      viewStart={viewStart}
                      view={view}
                      totalDays={totalDays}
                      editMode={editMode}
                      connectingFrom={connectingFrom}
                      connectMousePos={connectMousePos}
                      onConnectEnd={handleConnectEnd}
                      onRemoveDep={handleRemoveDep}
                    />
                  </div>
                </div>
              </div>

              <div className="gt-zoom">
                <button className="gt-icon-btn" onClick={() => zoom(1)} disabled={view === 'day'} aria-label="Zoom in"><Plus size={14} /></button>
                <button className="gt-icon-btn" onClick={() => zoom(-1)} disabled={view === 'month'} aria-label="Zoom out"><Minus size={14} /></button>
              </div>
            </div>
          </div>
        )}
      </div>

      {detailLoading && !detailIssue && <IssueDetailSkeleton onClose={() => setDetailLoading(false)} />}
      {detailIssue && (
        <IssueDetailPanel
          issue={detailIssue}
          ytBaseUrl={ytBaseUrl}
          onClose={() => setDetailIssue(null)}
        />
      )}
    </div>
  )
}
