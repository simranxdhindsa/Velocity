import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  DndContext, DragOverlay, closestCenter,
  KeyboardSensor, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable,
} from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import type { SprintBoardStatusResponse, WorkflowConfig } from '@/services/api'
import { updatePMIssueState } from '@/services/pmDataService'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { IssueCard } from './SprintPulseShared'
import {
  DONE_ROLES, dangerLevel, mapStage, tierCssClass,
  type PulseIssue,
} from './sprint-pulse-types'

// ─── View A — Tier Swimlane Kanban ────────────────────────────────────────────

const TIER_DEFS: { tier: number; label: string }[] = [
  { tier: 0, label: 'Regression' },
  { tier: 1, label: 'Critical / Hotfix' },
  { tier: 2, label: 'Urgent' },
  { tier: 3, label: 'On Deck A2/P2s' },
  { tier: 4, label: 'To Be Pushed With Current Sprint' },
  { tier: 5, label: 'Normal' },
]

function SwimDraggableCard({
  iss, wfConfig, onTitleClick, onIdClick, noHover = false,
}: {
  iss:          PulseIssue
  wfConfig:     WorkflowConfig | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick:    (id: string, e: React.MouseEvent) => void
  noHover?:     boolean
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: iss.id })
  return (
    <div
      ref={setNodeRef}
      className={`spl-swim-drag${isDragging ? ' spl-swim-drag--ghost' : ''}`}
      {...attributes}
      {...listeners}
    >
      <IssueCard iss={iss} wfConfig={wfConfig} onTitleClick={onTitleClick} onIdClick={onIdClick} noHover={noHover} />
    </div>
  )
}

function SwimDroppableCell({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={`spl-swim-cell${isOver ? ' spl-swim-cell--over' : ''}`}>
      {children}
    </div>
  )
}

export function PulseSwimKanban({
  allIssues, boardData, roleMap, wfConfig, onTitleClick, onIdClick,
}: {
  allIssues:    PulseIssue[]
  boardData:    SprintBoardStatusResponse
  roleMap:      Map<string, string>
  wfConfig:     WorkflowConfig | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick:    (id: string, e: React.MouseEvent) => void
}) {
  const [stateOverrides, setStateOverrides] = useState<Record<string, string>>({})
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => { setStateOverrides({}) }, [boardData])

  const columns = useMemo(() => boardData.columns.map(c => c.name), [boardData])

  const activeTiers = useMemo(
    () => TIER_DEFS.filter(t => allIssues.some(i => i.tier === t.tier)),
    [allIssues],
  )

  const getEffectiveState = useCallback(
    (iss: PulseIssue) => stateOverrides[iss.id] || iss.current_state,
    [stateOverrides],
  )

  const getCellIssues = useCallback((tier: number, col: string): PulseIssue[] => {
    const colRole = roleMap.get(col.toLowerCase()) || ''
    const isDoneCol = DONE_ROLES.has(colRole)
    return allIssues
      .filter(i => i.tier === tier && getEffectiveState(i) === col)
      .map(i => ({ ...i, current_state: col, colRole, isDone: isDoneCol, stageGroup: mapStage(colRole) }))
      .sort((a, b) => dangerLevel(b) - dangerLevel(a))
  }, [allIssues, getEffectiveState, roleMap])

  const activeIss = useMemo(
    () => activeId ? (allIssues.find(i => i.id === activeId) ?? null) : null,
    [activeId, allIssues],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(e.active.id as string)
  }, [])

  const handleDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e
    setActiveId(null)
    if (!over) return
    const colonIdx = (over.id as string).indexOf(':')
    const newCol = colonIdx >= 0 ? (over.id as string).slice(colonIdx + 1) : (over.id as string)
    const issueId = active.id as string
    const iss = allIssues.find(i => i.id === issueId)
    if (!iss || getEffectiveState(iss) === newCol) return
    setStateOverrides(prev => ({ ...prev, [issueId]: newCol }))
    updatePMIssueState(issueId, newCol)
  }, [allIssues, getEffectiveState])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="spl-swim-kanban">
        <div className="spl-swim-hdr-row">
          <div className="spl-swim-hdr-tier-spacer" />
          {columns.map(col => (
            <div key={col} className="spl-swim-hdr-col">{col}</div>
          ))}
        </div>

        {activeTiers.map(({ tier, label }) => {
          const breachCount = allIssues.filter(i => {
            if (i.tier !== tier) return false
            const role = roleMap.get(getEffectiveState(i).toLowerCase()) || ''
            return !DONE_ROLES.has(role) && role !== 'backlog' && dangerLevel(i) >= 2
          }).length
          const totalInTier = allIssues.filter(i => i.tier === tier).length
          return (
            <div key={tier} className={`spl-swim-tier-row ${tierCssClass(tier)}`}>
              <div className="spl-swim-tier-hd">
                <span className="spl-swim-tier-name">{label}</span>
                <span className="spl-swim-tier-cnt">{totalInTier}</span>
                {breachCount > 0 && (
                  <span className="spl-tier-col-breach">⚠ {breachCount}</span>
                )}
              </div>
              {columns.map(col => (
                <SwimDroppableCell key={col} id={`${tier}:${col}`}>
                  {getCellIssues(tier, col).map(iss => (
                    <SwimDraggableCard
                      key={iss.id}
                      iss={iss}
                      wfConfig={wfConfig}
                      onTitleClick={onTitleClick}
                      onIdClick={onIdClick}
                    />
                  ))}
                </SwimDroppableCell>
              ))}
            </div>
          )
        })}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeIss && (
          <div style={{ opacity: 0.92, transform: 'rotate(1.5deg)', width: 205, boxShadow: '0 16px 40px rgba(0,0,0,0.4)' }}>
            <IssueCard iss={activeIss} wfConfig={wfConfig} onTitleClick={onTitleClick} onIdClick={onIdClick} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

// ─── View P — Priority Swimlane Kanban ───────────────────────────────────────

export function PrioritySwimKanban({
  allIssues, boardData, roleMap, wfConfig, onTitleClick, onIdClick,
}: {
  allIssues:    PulseIssue[]
  boardData:    SprintBoardStatusResponse
  roleMap:      Map<string, string>
  wfConfig:     WorkflowConfig | null
  onTitleClick: (id: string, e?: React.MouseEvent) => void
  onIdClick:    (id: string, e: React.MouseEvent) => void
}) {
  const [stateOverrides, setStateOverrides] = useState<Record<string, string>>({})
  const [activeId,       setActiveId]       = useState<string | null>(null)

  useEffect(() => { setStateOverrides({}) }, [boardData])

  const columns = useMemo(() => boardData.columns.map(c => c.name), [boardData])

  const prioritySortKey = useCallback((priority: string): number => {
    const p = priority.trim()
    const pMatch = p.match(/^[Pp](\d+)$/)
    if (pMatch) return parseInt(pMatch[1], 10)
    const aMatch = p.match(/^[Aa](\d+)$/)
    if (aMatch) return 1000 + parseInt(aMatch[1], 10)
    if (p.toLowerCase() === 'normal') return 9000
    return 9999
  }, [])

  const priorities = useMemo(() => {
    const seen = new Set<string>()
    allIssues.forEach(i => { if (i.priority) seen.add(i.priority) })
    return [...seen].sort((a, b) => prioritySortKey(a) - prioritySortKey(b))
  }, [allIssues, prioritySortKey])

  const priorityColor = useCallback((priority: string): string => {
    const tag = wfConfig?.priority_tags?.find(t =>
      t.label.toLowerCase() === priority.toLowerCase() ||
      t.yt_mappings?.some(m => m.toLowerCase() === priority.toLowerCase())
    )
    return tag?.color ?? 'var(--text-muted)'
  }, [wfConfig])

  const getEffectiveState = useCallback(
    (iss: PulseIssue) => stateOverrides[iss.id] || iss.current_state,
    [stateOverrides],
  )

  const getCellIssues = useCallback((priority: string, col: string): PulseIssue[] => {
    const colRole  = roleMap.get(col.toLowerCase()) || ''
    const isDoneCol = DONE_ROLES.has(colRole)
    return allIssues
      .filter(i => i.priority === priority && getEffectiveState(i) === col)
      .map(i => ({ ...i, current_state: col, colRole, isDone: isDoneCol, stageGroup: mapStage(colRole) }))
      .sort((a, b) => dangerLevel(b) - dangerLevel(a))
  }, [allIssues, getEffectiveState, roleMap])

  const activeIss = useMemo(
    () => activeId ? (allIssues.find(i => i.id === activeId) ?? null) : null,
    [activeId, allIssues],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(e.active.id as string)
  }, [])

  const handleDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e
    setActiveId(null)
    if (!over) return
    const overId  = over.id as string
    const parts   = overId.split(':')
    const newCol  = parts.length >= 3 ? parts.slice(2).join(':') : overId
    const issueId = active.id as string
    const iss     = allIssues.find(i => i.id === issueId)
    if (!iss || getEffectiveState(iss) === newCol) return
    setStateOverrides(prev => ({ ...prev, [issueId]: newCol }))
    updatePMIssueState(issueId, newCol)
  }, [allIssues, getEffectiveState])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="spl-swim-kanban">
        <div className="spl-swim-hdr-row">
          <div className="spl-swim-hdr-tier-spacer" />
          {columns.map(col => (
            <div key={col} className="spl-swim-hdr-col">{col}</div>
          ))}
        </div>

        {priorities.map(priority => {
          const inPriority  = allIssues.filter(i => i.priority === priority)
          const activeCount = inPriority.filter(i => !DONE_ROLES.has(i.colRole)).length
          const breachCount = inPriority.filter(i => !DONE_ROLES.has(i.colRole) && dangerLevel(i) >= 2).length
          const color       = priorityColor(priority)
          return (
            <div
              key={priority}
              className="spl-swim-tier-row spl-swim-tier-row--pri"
              style={{ '--spl-pri-accent': color } as React.CSSProperties}
            >
              <div className="spl-swim-tier-hd">
                <span className="spl-swim-tier-name" style={{ color }}>{priority}</span>
                <span className="spl-swim-tier-cnt">{activeCount}</span>
                {breachCount > 0 && <span className="spl-tier-col-breach">⚠ {breachCount}</span>}
              </div>
              {columns.map(col => (
                <SwimDroppableCell key={col} id={`pri:${priority}:${col}`}>
                  {getCellIssues(priority, col).map(iss => (
                    <SwimDraggableCard
                      key={iss.id}
                      iss={iss}
                      wfConfig={wfConfig}
                      onTitleClick={onTitleClick}
                      onIdClick={onIdClick}
                      noHover
                    />
                  ))}
                </SwimDroppableCell>
              ))}
            </div>
          )
        })}

        {priorities.length === 0 && (
          <div className="spl-feed-empty">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            No issues with priority data found
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeIss && (
          <div style={{ opacity: 0.92, transform: 'rotate(1.5deg)', width: 205, boxShadow: '0 16px 40px rgba(0,0,0,0.4)' }}>
            <IssueCard iss={activeIss} wfConfig={wfConfig} onTitleClick={onTitleClick} onIdClick={onIdClick} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
