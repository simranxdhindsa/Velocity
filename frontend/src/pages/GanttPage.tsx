import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { IssueDetailPanel } from '@/components/IssueDetailPanel'
import { IssueDetailSkeleton } from '@/components/IssueDetailSkeleton'
import { GanttGrid, ROW_H, HDR_H } from '@/components/gantt/GanttGrid'
import { GanttArrows } from '@/components/gantt/GanttArrows'
import {
  type GanttIssue, type GanttDependency, type GanttChartSummary, type GanttView,
  DAY_PX, addDays, diffDays, startOfDay, priorityColor,
} from './gantt-types'
import api from '@/services/api'
import type { YouTrackIssue } from '@/services/api'
import { Edit2, GitBranch, ChevronDown } from 'lucide-react'
import { createPortal } from 'react-dom'
import '@/styles/pages/gantt.css'

// ── Constants ──────────────────────────────────────────────────────────────────

const CHART_KEY = 'gantt_chart_id'

const VIEW_MODES: { id: GanttView; label: string }[] = [
  { id: 'day',   label: 'Day' },
  { id: 'week',  label: 'Week' },
  { id: 'month', label: 'Month' },
]

// ── Chart selector dropdown (portal) ─────────────────────────────────────────

const ChartSelector = React.memo(function ChartSelector({
  charts, active, onChange,
}: {
  charts: GanttChartSummary[]
  active: GanttChartSummary | null
  onChange: (c: GanttChartSummary) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef  = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const rect = btnRef.current?.getBoundingClientRect()

  return (
    <div ref={btnRef} className="pm-custom-dropdown">
      <button className="pm-custom-dropdown-trigger" onClick={() => setOpen(o => !o)}>
        <GitBranch size={13} />
        {active?.name ?? 'Select chart'}
        <ChevronDown size={11} style={{ opacity: 0.5 }} />
      </button>
      {open && rect && createPortal(
        <div
          ref={menuRef}
          className="pm-custom-dropdown-menu"
          style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, minWidth: rect.width, zIndex: 9999 }}
        >
          {charts.map(c => (
            <div
              key={c.id}
              className={`pm-custom-dropdown-item${active?.id === c.id ? ' active' : ''}`}
              onClick={() => { onChange(c); setOpen(false) }}
            >
              {c.name}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
})

// ── Sidebar row ───────────────────────────────────────────────────────────────

const SidebarRow = React.memo(function SidebarRow({
  issue, onClick,
}: { issue: GanttIssue; onClick: () => void }) {
  const initials = issue.assignee.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div className="gt-sb-row" style={{ height: ROW_H }} onClick={onClick}>
      {issue.avatarUrl
        ? <img className="gt-sb-avatar" src={issue.avatarUrl} alt={issue.assignee} />
        : <div className="gt-sb-avatar gt-sb-avatar--initials">{initials || '?'}</div>
      }
      <div className="gt-sb-meta">
        <span className="gt-sb-id">{issue.idReadable}</span>
        <span className="gt-sb-name" title={issue.summary}>{issue.summary}</span>
      </div>
      <span
        className="gt-sb-dot"
        style={{ background: priorityColor(issue.priority) }}
        title={issue.priority}
      />
    </div>
  )
})

// ── Skeleton ──────────────────────────────────────────────────────────────────

const W = [55, 70, 48, 65, 58, 72]

function GanttSkeleton() {
  return (
    <div className="gt-skeleton-wrap">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="gt-skeleton-row">
          <div className="skeleton" style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div className="skeleton" style={{ width: 52, height: 10, borderRadius: 4 }} />
            <div className="skeleton" style={{ width: `${W[i % 6]}%`, height: 10, borderRadius: 4 }} />
          </div>
          <div className="skeleton" style={{ width: `${35 + (i % 3) * 20}%`, height: 20, borderRadius: 6, marginLeft: 12 }} />
        </div>
      ))}
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
  const [view,        setView]        = useState<GanttView>('week')
  const [editMode,    setEditMode]    = useState(false)

  // Connect-dependency draw state
  const [connectingFrom,  setConnectingFrom]  = useState<string | null>(null)  // memberId
  const [connectMousePos, setConnectMousePos] = useState<{ x: number; y: number } | null>(null)

  // Detail panel
  const [detailIssue,   setDetailIssue]   = useState<YouTrackIssue | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [ytBaseUrl,     setYtBaseUrl]     = useState('')

  // Refs for scroll sync
  const sidebarRef    = useRef<HTMLDivElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const gridRef       = useRef<HTMLDivElement>(null)

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    api.getYouTrackIntegration().then(res => {
      const d = res as any
      setYtBaseUrl((d?.base_url || d?.data?.base_url || '').replace(/\/$/, ''))
    }).catch(() => {})

    api.getGanttCharts().then(res => {
      const list = ((res as any).data as GanttChartSummary[]) ?? []
      setCharts(list)
      const savedId = localStorage.getItem(CHART_KEY)
      const saved   = savedId ? list.find(c => c.id === savedId) : null
      const pick    = saved ?? list[0] ?? null
      if (pick) { setActiveChart(pick); setGanttId(pick.id) }
    }).catch(() => {})
  }, [])

  // ── Fetch Gantt data ──────────────────────────────────────────────────────

  const fetchChart = useCallback((id: string) => {
    setLoading(true)
    api.getGanttChart(id).then(res => {
      const data = (res as any).data
      setIssues(data?.issues ?? [])
      setDeps(data?.dependencies ?? [])
      setGanttId(data?.ganttId ?? id)
    }).catch(() => {
      setIssues([])
      setDeps([])
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!activeChart) return
    fetchChart(activeChart.id)
  }, [activeChart, fetchChart])

  const handleChartSelect = useCallback((c: GanttChartSummary) => {
    setActiveChart(c)
    localStorage.setItem(CHART_KEY, c.id)
  }, [])

  // ── View geometry ──────────────────────────────────────────────────────────

  const viewStart = useMemo((): Date => {
    const starts = issues.map(i => i.startDate).filter(Boolean) as number[]
    if (starts.length === 0) return addDays(startOfDay(new Date()), -7)
    return addDays(startOfDay(new Date(Math.min(...starts))), -2)
  }, [issues])

  const totalDays = useMemo((): number => {
    const ends = issues.map(i => i.dueDate ?? i.startDate).filter(Boolean) as number[]
    if (ends.length === 0) return 30
    const lastDate = addDays(startOfDay(new Date(Math.max(...ends))), 5)
    return Math.max(diffDays(viewStart, lastDate), 30)
  }, [issues, viewStart])

  // ── Scroll sync ───────────────────────────────────────────────────────────

  const onCanvasScroll = useCallback(() => {
    const s = sidebarRef.current; const w = canvasWrapRef.current
    if (s && w) s.scrollTop = w.scrollTop
  }, [])

  const onSidebarScroll = useCallback(() => {
    const s = sidebarRef.current; const w = canvasWrapRef.current
    if (s && w) w.scrollTop = s.scrollTop
  }, [])

  // ── Date update (drag/resize) ──────────────────────────────────────────────

  const handleUpdateDates = useCallback(async (
    memberId: string, startMs: number | null, dueMs: number | null
  ) => {
    if (!ganttId) return
    // Optimistic update
    setIssues(prev => prev.map(i => {
      if (i.memberId !== memberId) return i
      const estimation = (startMs && dueMs) ? Math.max(0, Math.floor((dueMs - startMs) / 60_000)) : i.estimation
      return { ...i, startDate: startMs, dueDate: dueMs, estimation }
    }))
    try {
      await api.updateGanttMember(ganttId, memberId, startMs, dueMs)
    } catch {
      if (ganttId) fetchChart(ganttId)
    }
  }, [ganttId, fetchChart])

  // ── Connect dependency ─────────────────────────────────────────────────────

  const handleConnectStart = useCallback((e: React.MouseEvent, memberId: string) => {
    e.preventDefault()
    setConnectingFrom(memberId)
    setConnectMousePos({ x: e.clientX, y: e.clientY })
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
    // Optimistic — show arrow immediately (no server round-trip for now)
    setDeps(prev => {
      const already = prev.some(d => d.sourceId === connectingFrom && d.targetId === targetMemberId)
      if (already) return prev
      return [...prev, { sourceId: connectingFrom, targetId: targetMemberId }]
    })
  }, [connectingFrom])

  const handleRemoveDep = useCallback((dep: GanttDependency) => {
    if (!editMode) return
    setDeps(prev => prev.filter(d => !(d.sourceId === dep.sourceId && d.targetId === dep.targetId)))
  }, [editMode])

  // ── Issue detail panel ────────────────────────────────────────────────────

  const openDetail = useCallback(async (issue: GanttIssue) => {
    if (detailLoading) return
    setDetailLoading(true)
    try {
      const res  = await api.getYouTrackIssue(issue.idReadable)
      const full = (res as any).data as YouTrackIssue
      if (full) setDetailIssue(full)
    } catch {}
    finally { setDetailLoading(false) }
  }, [detailLoading])

  const dayPx = DAY_PX[view]

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="gt-page">
      {/* ── Toolbar ── */}
      <div className="gt-toolbar db-controls">
        <ChartSelector charts={charts} active={activeChart} onChange={handleChartSelect} />

        <div className="db-controls-spacer" />

        <div className="gt-view-tabs">
          {VIEW_MODES.map(v => (
            <button
              key={v.id}
              className={`gt-view-tab${view === v.id ? ' active' : ''}`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>

        <button
          className={`gt-edit-btn${editMode ? ' active' : ''}`}
          onClick={() => setEditMode(m => !m)}
          title="Toggle Edit Mode — drag bars, resize, draw dependencies"
        >
          <Edit2 size={14} />
          {editMode ? 'Exit Edit' : 'Edit Mode'}
        </button>
      </div>

      {/* ── Body ── */}
      {loading ? (
        <GanttSkeleton />
      ) : issues.length === 0 ? (
        <div className="gt-empty">
          <GitBranch size={40} opacity={0.3} />
          <p>{activeChart ? 'No scheduled issues in this chart.' : 'Select a Gantt chart to view.'}</p>
        </div>
      ) : (
        <div className="gt-body">
          {/* Sidebar */}
          <div className="gt-sidebar" ref={sidebarRef} onScroll={onSidebarScroll}>
            <div className="gt-sb-hdr" style={{ height: HDR_H }}>Issues</div>
            {issues.map(issue => (
              <SidebarRow key={issue.memberId} issue={issue} onClick={() => openDetail(issue)} />
            ))}
          </div>

          {/* Canvas scroll area */}
          <div className="gt-canvas-wrap" ref={canvasWrapRef} onScroll={onCanvasScroll}>
            <div
              className="gt-canvas-inner"
              style={{ width: totalDays * dayPx, position: 'relative' }}
            >
              <GanttGrid
                issues={issues}
                viewStart={viewStart}
                totalDays={totalDays}
                view={view}
                editMode={editMode}
                onUpdateDates={handleUpdateDates}
                onConnectStart={handleConnectStart}
                onIssueClick={openDetail}
                connectingFrom={connectingFrom}
                gridRef={gridRef}
              />
              <div className="gt-arrow-layer" style={{ top: HDR_H }}>
                <GanttArrows
                  issues={issues}
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
        </div>
      )}

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
