import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import {
  TrendingUp, Flame, Users, Tag, GitBranch, ShieldAlert,
  Plus, Trash2, RefreshCw, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle2, Clock, Save,
} from 'lucide-react'
import api from '../services/api'
import { SprintScanLoader } from './brand/VelocityLoaders'
import { Checkbox } from './Checkbox'
import type {
  CapacityRow, DependencyLink, BlockerSLAItem, EscalationConfig,
  YouTrackSprint,
} from '../services/api'
// ─────────────────────────────────────────────────────────────────────────────
// Shared tiny helpers
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="pmf-empty">
      <Icon size={32} className="pmf-empty-icon" />
      <p>{text}</p>
    </div>
  )
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <SprintScanLoader size={40} />
    </div>
  )
}

function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData(await fn()) } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error') }
    finally { setLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => { run() }, [run])
  return { data, loading, error, refetch: run }
}

// ─────────────────────────────────────────────────────────────────────────────
// F1 — Velocity Tab
// ─────────────────────────────────────────────────────────────────────────────

export function VelocityTab({ hideControls }: { hideControls?: boolean } = {}) {
  const [limit, setLimit] = useState(8)
  const [limitOpen, setLimitOpen] = useState(false)
  const limitRef = useRef<HTMLDivElement>(null)
  const { data, loading, error, refetch } = useAsync(
    () => api.getSprintVelocity(limit).then(r => r.data ?? []),
    [limit]
  )

  useEffect(() => {
    if (!limitOpen) return
    const handler = (e: MouseEvent) => {
      if (limitRef.current && !limitRef.current.contains(e.target as Node)) setLimitOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [limitOpen])

  const avg = data && data.length > 0
    ? Math.round(data.reduce((s, p) => s + p.completed, 0) / data.length)
    : 0

  return (
    <div className="pmf-tab">
      <div className="pmf-header">
        <div>
          <h3 className="pmf-title"><TrendingUp size={16} /> Sprint Velocity</h3>
          <p className="pmf-subtitle">Completed vs total tickets per sprint</p>
        </div>
        {!hideControls && (
          <div className="pmf-header-actions">
            <div className="pm-custom-dropdown" ref={limitRef}>
              <button className="pm-custom-dropdown-trigger" onClick={() => setLimitOpen(o => !o)}>
                Last {limit} sprints <ChevronDown size={12} />
              </button>
              {limitOpen && (
                <div className="pm-custom-dropdown-menu">
                  {[4, 6, 8, 10, 12].map(n => (
                    <div key={n} className="pm-custom-dropdown-item" onClick={() => { setLimit(n); setLimitOpen(false) }}>
                      Last {n} sprints
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button className="btn btn-sm btn-secondary" onClick={refetch}><RefreshCw size={13} /></button>
          </div>
        )}
      </div>

      {loading && <Spinner />}
      {error && <div className="pmf-error">{error}</div>}
      {!loading && !error && data && (
        <>
          <div className="pmf-kpi-row">
            <div className="pmf-kpi">
              <span className="pmf-kpi-value">{avg}</span>
              <span className="pmf-kpi-label">Avg completed / sprint</span>
            </div>
            <div className="pmf-kpi">
              <span className="pmf-kpi-value">{data.filter(p => p.is_completed).length}</span>
              <span className="pmf-kpi-label">Sprints completed</span>
            </div>
            <div className="pmf-kpi">
              <span className="pmf-kpi-value">
                {data.length > 0 ? Math.round(data[data.length - 1].completion_rate) : 0}%
              </span>
              <span className="pmf-kpi-label">Last sprint completion</span>
            </div>
          </div>

          {data.length === 0
            ? <EmptyState icon={TrendingUp} text="No sprint data found. Make sure YouTrack is connected and has sprints." />
            : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 32 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="sprint_name" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} angle={-25} textAnchor="end" interval={0} />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text-primary)', fontWeight: 600 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)' }} />
                  <ReferenceLine y={avg} stroke="rgba(99,102,241,0.5)" strokeDasharray="4 4" label={{ value: `Avg ${avg}`, fill: 'var(--text-muted)', fontSize: 11 }} />
                  <Bar dataKey="total" name="Total" fill="rgba(99,102,241,0.25)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="completed" name="Completed" fill="rgba(99,102,241,0.85)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )
          }
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// F2 — Burndown Tab
// ─────────────────────────────────────────────────────────────────────────────

interface BurndownTabProps {
  sprints: YouTrackSprint[]
  activeSprint?: YouTrackSprint | null
}

export function BurndownTab({ sprints, activeSprint }: BurndownTabProps) {
  const sprint = activeSprint ?? sprints[0] ?? null

  const { data, loading, error, refetch } = useAsync(
    () => sprint
      ? api.getSprintBurndown({
        sprint_id: sprint.id,
        sprint_name: sprint.name,
        sprint_start_ms: sprint.start,
        sprint_finish_ms: sprint.finish,
      }).then(r => r.data)
      : Promise.resolve(null),
    [sprint?.id]
  )

  // Build a merged dataset: ideal line spans full sprint, actual data only on snapshot days.
  // This makes the chart readable even with 1 snapshot — you always see the ideal trajectory.
  const chartData = useMemo(() => {
    if (!sprint) return []
    const startMs = sprint.start
    const endMs = sprint.finish
    const sprintDays = Math.round((endMs - startMs) / 86400000) + 1
    const snapshotMap = new Map((data?.points ?? []).map(p => [p.date, p]))
    const totalAtStart = data?.points?.[0]?.total ?? 0
    const todayStr = new Date().toISOString().split('T')[0]

    // Start from earliest snapshot date or sprint start, whichever is earlier
    const firstSnapMs = data?.points?.[0]?.date
      ? new Date(data.points[0].date + 'T00:00:00Z').getTime()
      : startMs
    const chartStartMs = Math.min(startMs, firstSnapMs)

    const result = []
    for (let ms = chartStartMs; ms <= endMs; ms += 86400000) {
      const dateStr = new Date(ms).toISOString().split('T')[0]
      const sprintOffset = Math.round((ms - startMs) / 86400000)
      const ideal = sprintOffset < 0
        ? totalAtStart  // flat before sprint starts
        : (sprintDays > 1 && totalAtStart > 0
          ? Math.round(totalAtStart * (1 - sprintOffset / (sprintDays - 1)) * 10) / 10
          : 0)
      const snap = snapshotMap.get(dateStr)
      result.push({
        date: dateStr,
        ideal_remain: ideal,
        remaining: snap && dateStr <= todayStr ? snap.remaining : undefined,
        completed: snap && dateStr <= todayStr ? snap.completed : undefined,
      })
    }
    return result
  }, [sprint, data])

  const doneCount  = data?.points?.at(-1)?.completed ?? 0
  const totalCount = data?.points?.[0]?.total ?? 0

  return (
    <div className="pmf-tab">
      <div className="pmf-header">
        <div>
          <h3 className="pmf-title"><Flame size={16} /> Burndown / Burnup</h3>
          <p className="pmf-subtitle">{sprint ? sprint.name : 'Select a sprint'} — daily remaining vs ideal</p>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={refetch}><RefreshCw size={13} /></button>
      </div>

      {!sprint && <EmptyState icon={Flame} text="No sprint selected. Use the sprint selector at the top." />}
      {loading && sprint && <Spinner />}
      {error && <div className="pmf-error">{error}</div>}
      {!loading && !error && sprint && (
        <>
          {totalCount > 0 && (
            <div className="pmf-kpi-row">
              <div className="pmf-kpi">
                <span className="pmf-kpi-value">{totalCount}</span>
                <span className="pmf-kpi-label">Sprint total</span>
              </div>
              <div className="pmf-kpi">
                <span className="pmf-kpi-value">{doneCount}</span>
                <span className="pmf-kpi-label">Completed so far</span>
              </div>
              <div className="pmf-kpi">
                <span className="pmf-kpi-value">{totalCount - doneCount}</span>
                <span className="pmf-kpi-label">Remaining</span>
              </div>
              <div className={`pmf-kpi ${doneCount / totalCount >= 0.5 ? '' : 'pmf-kpi-warn'}`}>
                <span className="pmf-kpi-value">{totalCount > 0 ? Math.round(doneCount / totalCount * 100) : 0}%</span>
                <span className="pmf-kpi-label">Completion</span>
              </div>
            </div>
          )}
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--text-primary)', fontWeight: 600 }}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)' }} />
              <Line type="monotone" dataKey="ideal_remain" name="Ideal" stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} strokeDasharray="5 5" dot={false} connectNulls />
              <Line type="monotone" dataKey="remaining" name="Remaining" stroke="#818cf8" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
              <Line type="monotone" dataKey="completed" name="Completed" stroke="#34d399" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// F3 — Capacity Planner Tab
// ─────────────────────────────────────────────────────────────────────────────

interface CapacityTabProps {
  sprints: YouTrackSprint[]
  activeSprint?: YouTrackSprint | null
}

export function CapacityTab({ sprints, activeSprint }: CapacityTabProps) {
  const [selectedId, setSelectedId] = useState(activeSprint?.id ?? sprints[0]?.id ?? '')
  const selectedSprint = sprints.find(s => s.id === selectedId) ?? sprints[0]

  const { data, loading, error, refetch } = useAsync(
    () => api.getSprintCapacity(selectedId).then(r => r.data),
    [selectedId]
  )

  const [newName, setNewName] = useState('')
  const [newDays, setNewDays] = useState('10')
  const [newNotes, setNewNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleAdd() {
    if (!newName.trim() || !selectedSprint) return
    setSaving(true)
    try {
      await api.saveSprintCapacity({
        sprint_id: selectedSprint.id,
        sprint_name: selectedSprint.name,
        assignee_name: newName.trim(),
        available_days: parseFloat(newDays) || 10,
        notes: newNotes.trim(),
      })
      setNewName(''); setNewDays('10'); setNewNotes('')
      refetch()
    } finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    await api.deleteSprintCapacity(id)
    refetch()
  }

  const rows: CapacityRow[] = data?.capacity ?? []
  const loadMap: Record<string, number> = data?.load ?? {}

  return (
    <div className="pmf-tab">
      <div className="pmf-header">
        <div>
          <h3 className="pmf-title"><Users size={16} /> Team Capacity Planner</h3>
          <p className="pmf-subtitle">Available days vs actual issue load per person</p>
        </div>
        <div className="pmf-header-actions">
          <select className="pmf-select" value={selectedId} onChange={e => setSelectedId(e.target.value)}>
            {sprints.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="btn btn-sm btn-secondary" onClick={refetch}><RefreshCw size={13} /></button>
        </div>
      </div>

      {sprints.length === 0 && <EmptyState icon={Users} text="No sprints available. Make sure YouTrack is connected and has sprints configured." />}
      {loading && sprints.length > 0 && <Spinner />}
      {error && <div className="pmf-error">{error}</div>}
      {!loading && !error && sprints.length > 0 && (
        <>
          <div className="pmf-cap-add">
            <input className="pmf-input" placeholder="Developer name" value={newName} onChange={e => setNewName(e.target.value)} />
            <input className="pmf-input pmf-input-sm" type="number" min="0" max="20" step="0.5" placeholder="Days" value={newDays} onChange={e => setNewDays(e.target.value)} />
            <input className="pmf-input" placeholder="Notes (optional)" value={newNotes} onChange={e => setNewNotes(e.target.value)} />
            <button className="btn btn-sm btn-primary" onClick={handleAdd} disabled={saving || !newName.trim()}>
              <Plus size={13} /> Add
            </button>
          </div>

          {rows.length === 0 && Object.keys(loadMap).length === 0
            ? <EmptyState icon={Users} text="No capacity data yet. Add team members above." />
            : (
              <table className="pmf-table">
                <thead>
                  <tr>
                    <th>Developer</th>
                    <th>Available Days</th>
                    <th>Assigned Issues</th>
                    <th>Load %</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const load = loadMap[row.assignee_name] ?? 0
                    const pct = row.available_days > 0 ? Math.round(load / row.available_days * 100) : 0
                    return (
                      <tr key={row.id}>
                        <td className="pmf-td-name">{row.assignee_name}</td>
                        <td>{row.available_days}d</td>
                        <td>{load}</td>
                        <td>
                          <div className="pmf-bar-wrap">
                            <div className="pmf-bar" style={{ width: `${Math.min(pct, 100)}%`, background: pct > 100 ? 'var(--color-danger)' : pct > 80 ? 'var(--color-warning)' : 'var(--color-success)' }} />
                            <span className="pmf-bar-label">{pct}%</span>
                          </div>
                        </td>
                        <td className="pmf-td-notes">{row.notes || '—'}</td>
                        <td>
                          <button className="icon-button" onClick={() => handleDelete(row.id)} title="Remove">
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  {Object.entries(loadMap)
                    .filter(([name]) => !rows.find(r => r.assignee_name === name))
                    .map(([name, load]) => (
                      <tr key={`load-${name}`} className="pmf-tr-unplanned">
                        <td className="pmf-td-name">{name} <span className="pmf-badge-muted">no plan</span></td>
                        <td>—</td>
                        <td>{load}</td>
                        <td>—</td>
                        <td>—</td>
                        <td></td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            )
          }
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// F4 — Releases Tab
// ─────────────────────────────────────────────────────────────────────────────

export function ReleasesTab() {
  const { data: releases, loading, error, refetch } = useAsync(
    () => api.getReleases().then(r => r.data ?? []),
    []
  )
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="pmf-tab">
      <div className="pmf-header">
        <div>
          <h3 className="pmf-title"><Tag size={16} /> Release / Milestone Tracking</h3>
          <p className="pmf-subtitle">Fix versions from YouTrack with issue progress</p>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={refetch}><RefreshCw size={13} /></button>
      </div>

      {loading && <Spinner />}
      {error && <div className="pmf-error">{error}</div>}
      {!loading && !error && (
        <>
          {(!releases || releases.length === 0)
            ? <EmptyState icon={Tag} text="No fix versions / milestones found. Add them in YouTrack under Agile → Custom Fields → Fix versions." />
            : releases.map(rel => (
              <div key={rel.version} className="pmf-release-card">
                <button
                  className="pmf-release-header"
                  onClick={() => setExpanded(expanded === rel.version ? null : rel.version)}
                >
                  <span className="pmf-release-name">
                    {expanded === rel.version ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {rel.version}
                  </span>
                  <div className="pmf-release-meta">
                    <span className="pmf-badge">{rel.completed}/{rel.total} done</span>
                    <div className="pmf-progress-wrap">
                      <div className="pmf-progress-bar" style={{ width: `${rel.progress}%` }} />
                    </div>
                    <span className="pmf-pct">{Math.round(rel.progress)}%</span>
                  </div>
                </button>
                {expanded === rel.version && (
                  <div className="pmf-release-issues">
                    {rel.issues.map(iss => (
                      <div key={iss.id} className={`pmf-issue-row ${iss.done ? 'pmf-issue-done' : ''}`}>
                        <span className="pmf-issue-id">{iss.id}</span>
                        <span className="pmf-issue-summary">{iss.summary}</span>
                        <span className="pmf-issue-state">{iss.state}</span>
                        <span className="pmf-issue-assignee">{iss.assignee || '—'}</span>
                        {iss.done ? <CheckCircle2 size={13} className="pmf-done-icon" /> : <Clock size={13} className="pmf-open-icon" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          }
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// F5 — Dependency Map Tab
// ─────────────────────────────────────────────────────────────────────────────

export function DependencyTab() {
  const [issueId, setIssueId] = useState('')
  const [query, setQuery] = useState('')
  const [links, setLinks] = useState<DependencyLink[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function search() {
    const id = query.trim()
    if (!id) return
    setLoading(true); setError(null)
    try {
      const res = await api.getIssueDependencies(id)
      setLinks(res.data ?? [])
      setIssueId(id)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally { setLoading(false) }
  }

  const grouped = links
    ? links.reduce<Record<string, DependencyLink[]>>((acc, l) => {
      const key = l.link_type || 'Other'
      ;(acc[key] = acc[key] || []).push(l)
      return acc
    }, {})
    : null

  return (
    <div className="pmf-tab">
      <div className="pmf-header">
        <div>
          <h3 className="pmf-title"><GitBranch size={16} /> Dependency Map</h3>
          <p className="pmf-subtitle">All link types for a YouTrack issue</p>
        </div>
      </div>

      <div className="pmf-dep-search">
        <input
          className="pmf-input pmf-input-lg"
          placeholder="Enter issue ID, e.g. ARD-1234"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
        />
        <button className="btn btn-sm btn-primary" onClick={search} disabled={loading}>
          {loading ? <RefreshCw size={13} className="spin" /> : 'Search'}
        </button>
      </div>

      {error && <div className="pmf-error">{error}</div>}
      {!loading && links !== null && (
        <>
          {links.length === 0
            ? <EmptyState icon={GitBranch} text={`No links found for ${issueId}.`} />
            : (
              <div className="pmf-dep-groups">
                {Object.entries(grouped!).map(([type, items]) => (
                  <div key={type} className="pmf-dep-group">
                    <h4 className="pmf-dep-type">{type}</h4>
                    {items.map(link => (
                      <div key={`${link.id_readable}-${link.direction}`} className={`pmf-dep-item ${link.resolved ? 'pmf-dep-resolved' : ''}`}>
                        <span className="pmf-dep-dir">{link.direction}</span>
                        <span className="pmf-dep-id">{link.id_readable}</span>
                        <span className="pmf-dep-summary">{link.summary}</span>
                        <span className="pmf-dep-state">{link.state || '—'}</span>
                        {link.resolved && <CheckCircle2 size={12} className="pmf-done-icon" />}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
          }
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// F6 — Blocker Escalation Tab
// ─────────────────────────────────────────────────────────────────────────────

export function BlockerEscalationTab() {
  const { data, loading, error, refetch } = useAsync(
    () => api.getBlockerSLA().then(r => r.data),
    []
  )
  const [cfg, setCfg] = useState<EscalationConfig>({ sla_hours: 24, notify_slack_channel: '', auto_notify: false })
  const [cfgLoading, setCfgLoading] = useState(true)
  const [cfgSaving, setCfgSaving] = useState(false)
  const [showCfg, setShowCfg] = useState(false)

  useEffect(() => {
    api.getEscalationConfig().then(r => {
      if (r.data) setCfg(r.data)
    }).finally(() => setCfgLoading(false))
  }, [])

  async function saveCfg() {
    setCfgSaving(true)
    try { await api.saveEscalationConfig(cfg); refetch() }
    finally { setCfgSaving(false) }
  }

  const items: BlockerSLAItem[] = data?.items ?? []
  const breached = items.filter(i => i.breached)
  const warning = items.filter(i => !i.breached && i.hours_blocked >= i.sla_hours * 0.75)

  return (
    <div className="pmf-tab">
      <div className="pmf-header">
        <div>
          <h3 className="pmf-title"><ShieldAlert size={16} /> Blocker Escalation</h3>
          <p className="pmf-subtitle">SLA tracking for blocked issues</p>
        </div>
        <div className="pmf-header-actions">
          <button className="btn btn-sm btn-secondary" onClick={() => setShowCfg(v => !v)}>
            <Save size={13} /> SLA Config
          </button>
          <button className="btn btn-sm btn-secondary" onClick={refetch}><RefreshCw size={13} /></button>
        </div>
      </div>

      {showCfg && !cfgLoading && (
        <div className="pmf-cfg-panel">
          <div className="pmf-cfg-row">
            <label className="pmf-cfg-label">SLA threshold (hours)</label>
            <input className="pmf-input pmf-input-sm" type="number" min="1" value={cfg.sla_hours}
              onChange={e => setCfg(c => ({ ...c, sla_hours: parseFloat(e.target.value) || 24 }))} />
          </div>
          <div className="pmf-cfg-row">
            <label className="pmf-cfg-label">Slack channel (optional)</label>
            <input className="pmf-input" placeholder="#blockers" value={cfg.notify_slack_channel}
              onChange={e => setCfg(c => ({ ...c, notify_slack_channel: e.target.value }))} />
          </div>
          <div className="pmf-cfg-row">
            <Checkbox
              checked={cfg.auto_notify}
              onChange={v => setCfg(c => ({ ...c, auto_notify: v }))}
              label="Auto-notify on breach"
            />
          </div>
          <button className="btn btn-sm btn-primary" onClick={saveCfg} disabled={cfgSaving}>
            {cfgSaving ? <RefreshCw size={13} className="spin" /> : <Save size={13} />}
            Save
          </button>
        </div>
      )}

      {loading && <Spinner />}
      {error && <div className="pmf-error">{error}</div>}
      {!loading && !error && (
        <>
          <div className="pmf-kpi-row">
            <div className="pmf-kpi pmf-kpi-danger">
              <span className="pmf-kpi-value">{breached.length}</span>
              <span className="pmf-kpi-label">SLA breached</span>
            </div>
            <div className="pmf-kpi pmf-kpi-warn">
              <span className="pmf-kpi-value">{warning.length}</span>
              <span className="pmf-kpi-label">Near SLA (≥75%)</span>
            </div>
            <div className="pmf-kpi">
              <span className="pmf-kpi-value">{items.length}</span>
              <span className="pmf-kpi-label">Total blocked</span>
            </div>
          </div>

          {items.length === 0
            ? <EmptyState icon={ShieldAlert} text="No blockers detected. Great job! Blockers are detected from YouTrack state transitions." />
            : (
              <table className="pmf-table">
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>Summary</th>
                    <th>Assignee</th>
                    <th>Blocked for</th>
                    <th>SLA</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.issue_id} className={item.breached ? 'pmf-tr-danger' : ''}>
                      <td className="pmf-td-id">{item.issue_id}</td>
                      <td>{item.summary}</td>
                      <td>{item.assignee || '—'}</td>
                      <td>{fmtHours(item.hours_blocked)}</td>
                      <td>{item.sla_hours}h</td>
                      <td>
                        {item.breached
                          ? <span className="pmf-badge-danger"><AlertTriangle size={11} /> Breached</span>
                          : item.hours_blocked >= item.sla_hours * 0.75
                            ? <span className="pmf-badge-warn"><Clock size={11} /> Warning</span>
                            : <span className="pmf-badge-ok"><CheckCircle2 size={11} /> OK</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </>
      )}
    </div>
  )
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 24) return `${h.toFixed(1)}h`
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`
}
