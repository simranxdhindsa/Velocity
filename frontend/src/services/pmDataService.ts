/**
 * pmDataService — source-agnostic PM data layer.
 *
 * All PM pages import from here instead of calling api.youtrack* or
 * api.asanaPM* directly. The active source is read from localStorage
 * (synced to DB on change via setActiveSource).
 */

import api, { getYouTrackAvatarMap } from './api'

export type DataSource = 'youtrack' | 'asana'

const SOURCE_KEY = 'pm_active_source'

// ── Issue cache (2-minute TTL, keyed by source) ───────────────────────────────
const CACHE_TTL = 2 * 60 * 1000
interface CacheEntry { data: unknown; ts: number }
const _issueCache = new Map<string, CacheEntry>()

export function invalidatePMCache() {
  _issueCache.clear()
}

export function getActiveSource(): DataSource {
  return (localStorage.getItem(SOURCE_KEY) as DataSource) || 'youtrack'
}

export async function setActiveSource(source: DataSource): Promise<void> {
  localStorage.setItem(SOURCE_KEY, source)
  window.dispatchEvent(new CustomEvent('pm-source-changed', { detail: source }))
  await api.setDataSource(source)
}

export async function loadActiveSourceFromDB(): Promise<DataSource> {
  try {
    const res = await api.getDataSource()
    const source = (res.data?.source || 'youtrack') as DataSource
    const prev = localStorage.getItem(SOURCE_KEY)
    localStorage.setItem(SOURCE_KEY, source)
    if (prev !== source) window.dispatchEvent(new CustomEvent('pm-source-changed', { detail: source }))
    return source
  } catch {
    return getActiveSource()
  }
}

// ── Status ───────────────────────────────────────────────────────────────────

export function getPMStatus() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMStatus()
    : api.getYouTrackStatus()
}

// ── Lists / metadata ─────────────────────────────────────────────────────────

export function getPMProjects() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMProjects()
    : api.getYouTrackProjects()
}

export function getPMBoards() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMBoards()
    : api.getYouTrackBoards()
}

export function getPMBoardColumns(boardId: string) {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMBoardColumns(boardId)
    : api.getYouTrackBoardColumns(boardId)
}

export function getPMDefaultBoardColumns() {
  return api.getYouTrackDefaultBoardColumns()
}

export function getPMStates() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMStates()
    : api.getYouTrackStates()
}

export function getPMPriorities() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMPriorities()
    : api.getYouTrackPriorities()
}

export function getPMUsers() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMUsers()
    : api.getYouTrackUsers()
}

export function getPMSections() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMSections()
    : api.getYouTrackSections()
}

// ── Issues / tasks ────────────────────────────────────────────────────────────

export async function getPMIssues(forceRefresh = false, sprintId?: string): Promise<{ success: boolean; data: unknown; message?: string }> {
  const key = `${getActiveSource()}${sprintId ? `:sprint:${sprintId}` : ''}`
  const hit = _issueCache.get(key)
  if (!forceRefresh && hit && Date.now() - hit.ts < CACHE_TTL) {
    return { success: true, data: hit.data }
  }
  const res = getActiveSource() === 'asana'
    ? await api.getAsanaPMIssues()
    : await api.getYouTrackIssues(sprintId)
  if ((res as any).success && (res as any).data) {
    _issueCache.set(key, { data: (res as any).data, ts: Date.now() })
  }
  return res as { success: boolean; data: unknown; message?: string }
}

export function getPMIssue(id: string) {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMIssue(id)
    : api.getYouTrackIssue(id)
}

export async function createPMIssue(params: {
  summary: string
  description?: string
  state?: string
  priority?: string
  assignee_login?: string
  due_date?: number
  estimation_minutes?: number
}) {
  const res = getActiveSource() === 'asana'
    ? await api.createAsanaPMIssue(params)
    : await api.createYouTrackIssue(params)
  invalidatePMCache()
  return res
}

export async function updatePMIssue(id: string, summary?: string, description?: string, state?: string) {
  const res = getActiveSource() === 'asana'
    ? await api.updateAsanaPMIssue(id, summary, description, state)
    : await api.updateYouTrackIssue(id, { summary, description, state })
  invalidatePMCache()
  return res
}

export async function updatePMIssueState(id: string, state: string) {
  const res = getActiveSource() === 'asana'
    ? await api.updateAsanaPMIssueState(id, state)
    : await api.updateYouTrackIssueState(id, state)
  invalidatePMCache()
  return res
}

export async function deletePMIssue(id: string) {
  const res = getActiveSource() === 'asana'
    ? await api.deleteAsanaPMIssue(id)
    : await api.deleteYouTrackIssue(id)
  invalidatePMCache()
  return res
}

export function getPMIssuesGroupedByAssignee() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMIssuesGroupedByAssignee()
    : api.getYouTrackIssuesGroupedByAssignee()
}

// ── AI / analysis ─────────────────────────────────────────────────────────────

export function pmAssistantQuery(query: string, history: { role: string; content: string }[] = [], sprintId?: string, sprintName?: string, sprintFinishMs?: number) {
  return getActiveSource() === 'asana'
    ? api.asanaPMAssistantQuery(query, history)
    : api.pmAssistantQuery(query, history, sprintId, sprintName, sprintFinishMs)
}

export function matchAnalysis(personBreakdown: any[], analysis: any[]) {
  return getActiveSource() === 'asana'
    ? api.matchAnalysisWithAsana(personBreakdown, analysis)
    : api.matchAnalysisWithYouTrack(personBreakdown, analysis)
}

// ── Daily ops ─────────────────────────────────────────────────────────────────

export function getDailyBrief(sprintId?: string) {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMDailyBrief()
    : api.getDailyBrief(sprintId)
}

export function getEODSummary() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMEODSummary()
    : api.getEODSummary()
}

export function getDeveloperLoad(sprintId?: string) {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMDeveloperLoad()
    : api.getDeveloperLoad(sprintId)
}

export function getBlockerReasons(issueIds: string[]) {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMBlockerReasons(issueIds)
    : api.getBlockerReasons(issueIds)
}

export function saveCarryoverPlan(items: any[]) {
  return getActiveSource() === 'asana'
    ? api.saveAsanaPMCarryoverPlan(items)
    : api.saveCarryoverPlan(items)
}

export function getCarryover() {
  return getActiveSource() === 'asana'
    ? api.getAsanaPMCarryover()
    : api.getCarryover()
}

// ── PM Reports ────────────────────────────────────────────────────────────────

export function getAssigneeStats(sprintId?: string) {
  return getActiveSource() === 'asana'
    ? api.getAsanaAssigneeStats()
    : api.getAssigneeStats(sprintId)
}

export function getAvatarMap(): Promise<Record<string, string>> {
  if (getActiveSource() === 'asana') {
    return api.getAsanaUserAvatars().then(res => (res as any).data || {})
  }
  return getYouTrackAvatarMap()
}

export function getTimeTracking(params?: { week?: string; assignee?: string; priority?: string; sprint_id?: string }) {
  return getActiveSource() === 'asana'
    ? api.getAsanaTimeTracking(params)
    : api.getTimeTracking(params)
}

export function getIssueTimelines(sinceMs?: number, untilMs?: number) {
  return getActiveSource() === 'asana'
    ? api.getAsanaIssueTimelines()
    : api.getIssueTimelines(sinceMs, untilMs)
}

export function generatePMReport(date: string, scope: 'full' | 'summary' = 'full', overrides?: { priorities?: string[]; open_states?: string[]; sections?: string[] }, sprintId?: string, sprintName?: string) {
  return getActiveSource() === 'asana'
    ? api.generateAsanaPMReport(date, scope, overrides)
    : api.generatePMReport(date, scope, overrides, sprintId, sprintName)
}

export function generateWeeklyPMReport(weekStart: string, scope: 'full' | 'summary' = 'full', overrides?: { priorities?: string[]; open_states?: string[]; sections?: string[] }, sprintId?: string, sprintName?: string) {
  return getActiveSource() === 'asana'
    ? api.generateAsanaWeeklyPMReport(weekStart, scope)
    : api.generateWeeklyPMReport(weekStart, scope, overrides, sprintId, sprintName)
}

export function listPMReports() {
  return api.listPMReports()
}

export function listWeeklyPMReports() {
  return api.listWeeklyPMReports()
}

export function deletePMReport(id: string) {
  return api.deletePMReport(id)
}

export function getStageReportColumns() {
  return getActiveSource() === 'asana'
    ? api.getAsanaStageReportColumns()
    : api.getStageReportColumns()
}

export function generateStageReport(columns: string[]) {
  return getActiveSource() === 'asana'
    ? api.generateAsanaStageReport(columns)
    : api.generateStageReport(columns)
}

export function backfillLog() {
  return getActiveSource() === 'asana'
    ? api.backfillAsanaLog()
    : api.backfillStateLog()
}
