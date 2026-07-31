import React, { useState, useEffect, useMemo, useCallback } from 'react'
import api from '@/services/api'
import { useWorkflowConfig } from '@/hooks/useWorkflowConfig'
import { IssueDetailPanel } from '@/components/IssueDetailPanel'
import { SprintControlsBar } from '@/components/SprintControlsBar'
import { useIgnoredBlocked } from '@/contexts/IgnoredBlockedContext'
import type {
  YouTrackSprint,
  SprintBoardStatusResponse,
  YouTrackIssue,
  DeveloperLoad,
} from '@/services/api'
import { GitBranch, RefreshCw, ChevronRight } from 'lucide-react'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import '@/styles/pages/sprint-pulse.css'

import {
  SPRINT_ID_KEY, SPRINT_NAME_KEY, DONE_ROLES,
  classifyTier, mapStage, fmtSprintDate, sprintCountdown,
  type ViewMode, type PulseIssue, type TierGroups, type StageCounts,
} from './sprint-pulse-types'
import { PulseSwimKanban, PrioritySwimKanban } from './SprintPulseKanban'
import { ViewC, View1, View4, SkBoard, SkSignal } from './SprintPulseOtherViews'
import { VIEW_MODES, ViewLive, SkLive } from './SprintPulseLive'

export function SprintPulsePage() {
  const { config: wfConfig } = useWorkflowConfig()
  const { ignoredIds } = useIgnoredBlocked()

  const [sprints,         setSprints]        = useState<YouTrackSprint[]>([])
  const [activeSprint,    setActiveSprint]    = useState<YouTrackSprint | null>(null)
  const [boardData,       setBoardData]       = useState<SprintBoardStatusResponse | null>(null)
  const [loading,         setLoading]         = useState(false)
  const [viewMode,        setViewMode]        = useState<ViewMode>('l')
  const [ytDetailIssue,   setYtDetailIssue]   = useState<YouTrackIssue | null>(null)
  const [ytDetailLoading, setYtDetailLoading] = useState(false)
  const [ytBaseUrl,       setYtBaseUrl]       = useState('')
  const [developerLoad,   setDeveloperLoad]   = useState<DeveloperLoad[]>([])

  useEffect(() => {
    api.getYouTrackIntegration().then(res => {
      const d = res as any
      setYtBaseUrl((d?.base_url || d?.data?.base_url || '').replace(/\/$/, ''))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    api.getYouTrackSprints().then(res => {
      const list = ((res as any).data as YouTrackSprint[]) ?? []
      setSprints(list)
      const savedId = localStorage.getItem(SPRINT_ID_KEY)
      const now = Date.now()
      const saved = savedId ? list.find(s => s.id === savedId && !s.isCompleted && s.finish > now) : null
      const auto = list.filter(s => !s.isCompleted && s.finish > now).sort((a, b) => a.finish - b.finish)[0]
        ?? list.find(s => !s.isCompleted)
        ?? list[list.length - 1]
        ?? null
      setActiveSprint(saved ?? auto)
    }).catch(() => {})
  }, [])

  const fetchBoardData = useCallback((sprint: YouTrackSprint) => {
    setLoading(true)
    api.getSprintBoardStatus({
      sprint_id:       sprint.id,
      sprint_finish_ms: sprint.finish,
    }).then(res => {
      const data = (res as any).data as SprintBoardStatusResponse
      setBoardData(data ?? null)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const fetchDevLoad = useCallback((sprint: YouTrackSprint) => {
    api.getDeveloperLoad(sprint.id).then(res => {
      setDeveloperLoad((res as any).data ?? [])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!activeSprint) { setBoardData(null); setDeveloperLoad([]); return }
    fetchBoardData(activeSprint)
    fetchDevLoad(activeSprint)
  }, [activeSprint, fetchBoardData, fetchDevLoad])

  const handleSprintSelect = useCallback((s: YouTrackSprint) => {
    setActiveSprint(s)
    localStorage.setItem(SPRINT_ID_KEY,   s.id)
    localStorage.setItem(SPRINT_NAME_KEY, s.name)
  }, [])

  const openIssueDetail = useCallback(async (idReadable: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (ytDetailLoading) return
    setYtDetailLoading(true)
    try {
      const res   = await api.getYouTrackIssue(idReadable)
      const issue = (res as any).data as YouTrackIssue
      if (issue) setYtDetailIssue(issue)
    } catch {}
    finally { setYtDetailLoading(false) }
  }, [ytDetailLoading])

  const openInYt = useCallback((idReadable: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!idReadable || !ytBaseUrl) return
    window.open(`${ytBaseUrl}/issue/${idReadable}`, '_blank', 'noopener,noreferrer')
  }, [ytBaseUrl])

  const roleMap = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>()
    if (!wfConfig?.column_hierarchy) return m
    for (const col of wfConfig.column_hierarchy) {
      m.set(col.state.toLowerCase(), col.role)
      for (const alias of (col.aliases || [])) {
        m.set(alias.toLowerCase(), col.role)
      }
    }
    return m
  }, [wfConfig])

  const allIssues = useMemo<PulseIssue[]>(() => {
    if (!boardData) return []
    const result: PulseIssue[] = []
    for (const col of boardData.columns) {
      const colRole = roleMap.get(col.name.toLowerCase()) || ''
      const isDone  = DONE_ROLES.has(colRole)
      for (const iss of col.issues) {
        const stageGroup = mapStage(colRole)
        // Skip blocked tickets the user has parked
        if (stageGroup === 'blocked' && ignoredIds.has(iss.idReadable)) continue
        result.push({
          ...iss,
          tier: classifyTier(iss),
          colRole,
          stageGroup,
          isDone,
        })
      }
    }
    return result
  }, [boardData, roleMap, ignoredIds])

  const stageCounts = useMemo<StageCounts>(() => ({
    active:   allIssues.filter(i => i.stageGroup === 'active').length,
    blocked:  allIssues.filter(i => i.stageGroup === 'blocked').length,
    devDone:  allIssues.filter(i => i.stageGroup === 'dev_done').length,
    stage:    allIssues.filter(i => i.stageGroup === 'stage').length,
    deployed: allIssues.filter(i => i.stageGroup === 'deployed').length,
  }), [allIssues])

  const tierGroups = useMemo<TierGroups>(() => ({
    t1:  allIssues.filter(i => i.tier === 1),
    t2:  allIssues.filter(i => i.tier === 2),
    t3:  allIssues.filter(i => i.tier === 3),
    t4:  allIssues.filter(i => i.tier === 4),
    t5:  allIssues.filter(i => i.tier === 5),
    reg: allIssues.filter(i => i.tier === 0),
  }), [allIssues])

  const summary = boardData?.summary

  const sprintLabel = useMemo(
    () => activeSprint?.finish ? sprintCountdown(activeSprint.finish) : null,
    [activeSprint],
  )

  return (
    <div className="db-page">
      <SprintControlsBar
        modes={VIEW_MODES}
        activeMode={viewMode}
        onModeChange={(id) => setViewMode(id as ViewMode)}
        sprints={sprints}
        activeSprint={activeSprint}
        onSprintChange={handleSprintSelect}
      >
        <button
          className="pm-custom-dropdown-trigger"
          style={{ gap: 5 }}
          disabled={loading || !activeSprint}
          onClick={() => { if (activeSprint) { fetchBoardData(activeSprint); fetchDevLoad(activeSprint) } }}
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'spl-spin' : ''} />
        </button>
      </SprintControlsBar>

      <div className="db-content spl-content">
        {summary && (
          <div className="pm-tracking-kpi-row">
            <div className="pm-tracking-kpi pm-tracking-kpi--green">
              <div className="pm-tracking-kpi-lbl">Completion</div>
              <div className="pm-tracking-kpi-val">
                {Math.round(summary.completion_pct)}<span className="pm-tracking-kpi-unit">%</span>
              </div>
              <div className="pm-tracking-kpi-prog">
                <div className="pm-tracking-kpi-prog-f" style={{ width: `${Math.round(summary.completion_pct)}%` }} />
              </div>
              <div className="pm-tracking-kpi-note">{summary.done_issues} / {summary.total_issues} tickets</div>
            </div>
            <div className="pm-tracking-kpi pm-tracking-kpi--blue">
              <div className="pm-tracking-kpi-lbl">In Progress</div>
              <div className="pm-tracking-kpi-val">{summary.in_progress_count}</div>
              <div className="pm-tracking-kpi-note">
                {summary.overdue_count} overdue · {summary.blocked_count} blocked
              </div>
            </div>
            <div className="pm-tracking-kpi pm-tracking-kpi--red">
              <div className="pm-tracking-kpi-lbl">Blocked</div>
              <div className="pm-tracking-kpi-val">{summary.blocked_count}</div>
              <div className="pm-tracking-kpi-note">
                {summary.hotfix_count} hotfix{summary.hotfix_count !== 1 ? 'es' : ''} · {summary.overdue_count} overdue
              </div>
            </div>
            <div className="pm-tracking-kpi pm-tracking-kpi--amber">
              <div className="pm-tracking-kpi-lbl">Bounced</div>
              <div className="pm-tracking-kpi-val">{summary.bounced_count}</div>
              <div className="pm-tracking-kpi-note">backward moves</div>
            </div>
            {activeSprint?.finish && (
              <div className={`pm-tracking-kpi ${sprintLabel === 'OVERDUE' ? 'pm-tracking-kpi--red' : 'pm-tracking-kpi--amber'}`}>
                <div className="pm-tracking-kpi-lbl">Sprint Ends</div>
                <div className={`pm-tracking-kpi-val${sprintLabel === 'OVERDUE' ? ' pm-tracking-kpi-val--danger' : ''}`}>
                  {sprintLabel}
                </div>
                <div className="pm-tracking-kpi-note">{fmtSprintDate(activeSprint.finish)}</div>
              </div>
            )}
          </div>
        )}

        <div className="spl-pipeline">
          <span className="spl-pipeline-label">Delivery</span>
          <div className="spl-pipe-stages">
            <div className="spl-pipe-stage spl-pipe-stage--active">
              <div className="spl-pipe-count">{stageCounts.active}</div>
              <div className="spl-pipe-lbl">Active</div>
            </div>
            <ChevronRight size={12} className="spl-pipe-arrow" />
            <div className="spl-pipe-stage spl-pipe-stage--devdone">
              <div className="spl-pipe-count">{stageCounts.devDone}</div>
              <div className="spl-pipe-lbl">Dev Done</div>
            </div>
            <ChevronRight size={12} className="spl-pipe-arrow" />
            <div className="spl-pipe-stage spl-pipe-stage--stage">
              <div className="spl-pipe-count">{stageCounts.stage}</div>
              <div className="spl-pipe-lbl">Stage</div>
            </div>
            <ChevronRight size={12} className="spl-pipe-arrow" />
            <div className="spl-pipe-stage spl-pipe-stage--deployed">
              <div className="spl-pipe-count">{stageCounts.deployed}</div>
              <div className="spl-pipe-lbl">Deployed</div>
            </div>
          </div>
          {stageCounts.blocked > 0 && (
            <div className="spl-pipe-blocked">
              <span className="spl-pipe-blocked-count">{stageCounts.blocked}</span>
              <span className="spl-pipe-blocked-lbl">blocked</span>
            </div>
          )}
        </div>

        {!activeSprint && !loading && (
          <div className="sp-no-sprint">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            <GitBranch size={24} />
            <span>Select a sprint to load Sprint Pulse</span>
          </div>
        )}
        {loading && (
          viewMode === 'l' ? <SkLive /> :
          viewMode === '1' ? <SkSignal /> :
          <SkBoard />
        )}

        {!loading && boardData && (
          <>
            {viewMode === 'a' && (
              <PulseSwimKanban
                allIssues={allIssues}
                boardData={boardData}
                roleMap={roleMap}
                wfConfig={wfConfig}
                onTitleClick={openIssueDetail}
                onIdClick={openInYt}
              />
            )}
            {viewMode === 'p' && (
              <PrioritySwimKanban
                allIssues={allIssues}
                boardData={boardData}
                roleMap={roleMap}
                wfConfig={wfConfig}
                onTitleClick={openIssueDetail}
                onIdClick={openInYt}
              />
            )}
            {viewMode === 'c' && (
              <ViewC
                tierGroups={tierGroups}
                stageCounts={stageCounts}
                wfConfig={wfConfig}
                onTitleClick={openIssueDetail}
                onIdClick={openInYt}
              />
            )}
            {viewMode === '1' && (
              <View1
                tierGroups={tierGroups}
                wfConfig={wfConfig}
                onTitleClick={openIssueDetail}
                onIdClick={openInYt}
              />
            )}
            {viewMode === '4' && (
              <View4
                tierGroups={tierGroups}
                wfConfig={wfConfig}
                onTitleClick={openIssueDetail}
                onIdClick={openInYt}
              />
            )}
            {viewMode === 'l' && (
              <ViewLive
                allIssues={allIssues}
                developerLoad={developerLoad}
                activeSprint={activeSprint}
                summary={summary}
                onTitleClick={openIssueDetail}
                onIdClick={openInYt}
              />
            )}
          </>
        )}
      </div>

      {ytDetailIssue && (
        <IssueDetailPanel
          issue={ytDetailIssue}
          onClose={() => setYtDetailIssue(null)}
          ytBaseUrl={ytBaseUrl}
        />
      )}
    </div>
  )
}
