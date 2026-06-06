import { useState, useEffect, useRef } from 'react'
import { GitMerge, RefreshCw, CheckCircle2, Clock, AlertCircle, ChevronDown } from 'lucide-react'
import type { FeatureGroup, FeatureIssue } from '../services/api'
import HoverCard, { HCRow, HCDivider, HCBadge } from './HoverCard'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function healthColor(h: FeatureGroup['health']): string {
  if (h === 'done')    return 'fg-health--done'
  if (h === 'partial') return 'fg-health--partial'
  return 'fg-health--pending'
}

function healthIcon(h: FeatureGroup['health']) {
  if (h === 'done')    return <CheckCircle2 size={11} />
  if (h === 'partial') return <Clock size={11} />
  return <AlertCircle size={11} />
}

function healthLabel(h: FeatureGroup['health']): string {
  if (h === 'done')    return 'Done'
  if (h === 'partial') return 'Partial'
  return 'Pending'
}

// Maps IssueType string → short badge label
function typeLabel(t: string): string {
  const u = (t || '').toUpperCase()
  if (u === 'FRONTEND' || u === 'FE') return 'FE'
  if (u === 'BACKEND'  || u === 'BE') return 'BE'
  if (u === 'RAG')    return 'RAG'
  if (u === 'MOBILE') return 'MOB'
  return u.slice(0, 3) || '?'
}

function typeCls(t: string): string {
  const u = (t || '').toUpperCase()
  if (u === 'FRONTEND' || u === 'FE') return 'fg-type--fe'
  if (u === 'BACKEND'  || u === 'BE') return 'fg-type--be'
  if (u === 'RAG')    return 'fg-type--rag'
  if (u === 'MOBILE') return 'fg-type--mob'
  return 'fg-type--other'
}

// Classify state → role category
function stateRole(state: string): 'done' | 'active' | 'pending' {
  const s = (state || '').toLowerCase()
  if (s.includes('done') || s.includes('closed') || s.includes('deploy') ||
      s.includes('verif') || s.includes('fixed') || s.includes('resolved')) return 'done'
  if (s.includes('progress') || s.includes('review') || s.includes('block') ||
      s.includes('testing') || s.includes('stage')) return 'active'
  return 'pending'
}

function statePillCls(state: string): string {
  const r = stateRole(state)
  if (r === 'done')   return 'fg-state--done'
  if (r === 'active') return 'fg-state--active'
  return 'fg-state--pending'
}

// ─── Sort dropdown ────────────────────────────────────────────────────────────

type SortMode = 'health' | 'name' | 'completion' | 'size'

const SORT_LABELS: Record<SortMode, string> = {
  health:     'By Health',
  name:       'By Name',
  completion: 'By Completion',
  size:       'By Size',
}

function sortGroups(groups: FeatureGroup[], mode: SortMode): FeatureGroup[] {
  const healthOrder = { partial: 0, pending: 1, done: 2 }
  return [...groups].sort((a, b) => {
    if (mode === 'health')     return (healthOrder[a.health] ?? 3) - (healthOrder[b.health] ?? 3)
    if (mode === 'name')       return a.name.localeCompare(b.name)
    if (mode === 'completion') {
      const pA = a.total_count > 0 ? a.done_count / a.total_count : 0
      const pB = b.total_count > 0 ? b.done_count / b.total_count : 0
      return pB - pA
    }
    if (mode === 'size') return b.total_count - a.total_count
    return 0
  })
}

// ─── Issue hover content ─────────────────────────────────────────────────────

function issueHoverContent(issue: FeatureIssue) {
  return (
    <div>
      <div className="hc-title" style={{ marginBottom: 2 }}>
        {issue.id_readable}
        {issue.issue_type && <HCBadge label={typeLabel(issue.issue_type)} />}
        {!issue.in_sprint && <HCBadge label="External" variant="warn" />}
      </div>
      <div className="hc-subtitle">{issue.summary}</div>
      <HCDivider />
      <HCRow label="State"    value={issue.current_state    || '—'} />
      <HCRow label="Assignee" value={issue.assignee || '—'} />
      {issue.priority && <HCRow label="Priority" value={issue.priority} />}
    </div>
  )
}

// ─── Issue row ───────────────────────────────────────────────────────────────

function IssueRow({ issue }: { issue: FeatureIssue }) {
  return (
    <HoverCard content={issueHoverContent(issue)} maxWidth={280}>
      <div className="fg-issue-row">
        <span className={`fg-type-badge ${typeCls(issue.issue_type)}`}>{typeLabel(issue.issue_type)}</span>
        <span className="fg-issue-id">{issue.id_readable}</span>
        <span className="fg-issue-summary" title={issue.summary}>{issue.summary}</span>
        <span className={`fg-state-pill fg-state--${issue.state_class || 'pending'}`}>{issue.current_state || '—'}</span>
        {issue.assignee && <span className="fg-assignee">{issue.assignee}</span>}
      </div>
    </HoverCard>
  )
}

// ─── Group card ──────────────────────────────────────────────────────────────

function GroupCard({ group }: { group: FeatureGroup }) {
  const [expanded, setExpanded] = useState(true)
  const pct = group.total_count > 0 ? Math.round((group.done_count / group.total_count) * 100) : 0

  return (
    <div className={`fg-card fg-card--${group.health}`}>
      <div className="fg-card-header" onClick={() => setExpanded(e => !e)}>
        <span className={`fg-health-badge ${healthColor(group.health)}`}>
          {healthIcon(group.health)}
          {healthLabel(group.health)}
        </span>
        <span className="fg-card-name">{group.name}</span>
        <span className="fg-card-count">{group.done_count}/{group.total_count}</span>
        <div className="fg-card-bar">
          <div className="fg-card-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="fg-card-pct">{pct}%</span>
        <ChevronDown size={13} className={`fg-card-chevron${expanded ? ' fg-card-chevron--open' : ''}`} />
      </div>

      {expanded && (
        <div className="fg-card-issues">
          {group.issues.map(iss => (
            <IssueRow key={iss.id_readable} issue={iss} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export interface FeatureGroupsViewProps {
  sprintId?: string
  groups: FeatureGroup[]
  loading: boolean
  onRefresh: () => void
}

export default function FeatureGroupsView({ sprintId, groups, loading, onRefresh }: FeatureGroupsViewProps) {
  const [sortMode, setSortMode] = useState<SortMode>('health')
  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const sorted = sortGroups(groups, sortMode)
  const doneCount    = groups.filter(g => g.health === 'done').length
  const partialCount = groups.filter(g => g.health === 'partial').length
  const pendingCount = groups.filter(g => g.health === 'pending').length

  return (
    <div className="fg-root">
      {/* KPI bar */}
      <div className="fg-kpi-bar">
        <GitMerge size={14} className="fg-kpi-icon" />
        <span className="fg-kpi-label">Feature Groups</span>
        <span className="fg-kpi-chip fg-kpi-chip--done">{doneCount} complete</span>
        <span className="fg-kpi-chip fg-kpi-chip--partial">{partialCount} partial</span>
        <span className="fg-kpi-chip fg-kpi-chip--pending">{pendingCount} pending</span>

        {/* Sort dropdown */}
        <div className="pm-custom-dropdown fg-sort-dropdown" ref={sortRef}>
          <button
            className={`pm-custom-dropdown-trigger${sortOpen ? ' open' : ''}`}
            onClick={() => setSortOpen(o => !o)}
          >
            {SORT_LABELS[sortMode]}
            <ChevronDown size={11} />
          </button>
          {sortOpen && (
            <div className="pm-custom-dropdown-menu">
              {(Object.keys(SORT_LABELS) as SortMode[]).map(k => (
                <div
                  key={k}
                  className={`pm-custom-dropdown-item${sortMode === k ? ' active' : ''}`}
                  onClick={() => { setSortMode(k); setSortOpen(false) }}
                >
                  {SORT_LABELS[k]}
                </div>
              ))}
            </div>
          )}
        </div>

        <button className="fg-refresh-btn" onClick={onRefresh}>
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="fg-skeleton-list">
          {[1, 2, 3].map(i => (
            <div key={i} className="fg-skeleton-card">
              <div className="skeleton" style={{ width: 80, height: 20, borderRadius: 4 }} />
              <div className="skeleton" style={{ width: '40%', height: 14, borderRadius: 4 }} />
              <div className="skeleton" style={{ width: '100%', height: 10, borderRadius: 4 }} />
            </div>
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && groups.length === 0 && (
        <div className="fg-empty">
          <GitMerge size={28} />
          <span>{!sprintId ? 'Select a sprint to see feature groups.' : 'No feature groups found for this sprint.'}</span>
          {sprintId && <span className="fg-empty-hint">Groups are detected from YouTrack "relates to" links and description cross-references (FE/BE/RAG Ticket Link: ARD-XXXX).</span>}
        </div>
      )}

      {/* Group cards */}
      {!loading && sorted.length > 0 && (
        <div className="fg-card-list">
          {sorted.map(g => <GroupCard key={g.id} group={g} />)}
        </div>
      )}
    </div>
  )
}
