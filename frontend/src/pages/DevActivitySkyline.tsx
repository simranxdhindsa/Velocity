// Dev Activity → Skyline: a year of daily ticket moves as a heat map / 3D skyline.
// Counts come from the state log (/reports/activity-by-day); states are mapped to
// roles through the live workflow config, so "Dev done", "QA tested" and "Deployed"
// follow whatever columns the team has configured.
import { useEffect, useMemo, useRef, useState, memo } from 'react'
import { User, CalendarDays } from 'lucide-react'
import api from '@/services/api'
import type { ActivityDayRow, ActivityMove } from '@/services/api'
import { useWorkflowConfig } from '@/hooks/useWorkflowConfig'
import { usePersistedState, PERSIST } from '@/hooks/usePersistedState'
import { CustomDropdown } from '@/components/CustomDropdown'
import { upperAmPm } from '@/components/ClockTimePicker'
import ContributionSkyline, { type ContributionDay } from '@/components/skyline/ContributionSkyline'
import '../styles/pages/dev-activity-skyline.css'

type Metric = 'dev_done' | 'verified' | 'deployed'

const METRICS: { id: Metric; label: string; who: 'assignee' | 'moved_by'; title: string; empty: string }[] = [
  { id: 'dev_done', label: 'Dev done',  who: 'assignee', title: 'finished by developers',     empty: 'No tickets finished by developers on this day.' },
  { id: 'verified', label: 'QA tested', who: 'moved_by', title: 'verified by QA',             empty: 'No tickets verified by QA on this day.' },
  { id: 'deployed', label: 'Deployed',  who: 'moved_by', title: 'deployed to stage or prod',  empty: 'No deployments on this day.' },
]

// Used only when the workflow config has no column hierarchy yet.
const FALLBACK_ROLES: Record<string, Metric> = {
  'dev': 'dev_done', 'mobile done': 'dev_done',
  'ready for stage': 'verified', 'ready for prod': 'verified', 'verified': 'verified',
  'stage': 'deployed', 'prod': 'deployed',
}

const ALL = '__all__'
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const DAY_W = [72, 58, 80, 64, 70, 55]

const fmtTime = (iso: string) =>
  upperAmPm(new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }))
const fmtDay = (day: string) =>
  new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

interface Props {
  onOpenDetail: (issueId: string) => void
}

export function SkylineSkeleton() {
  return (
    <div className="dsk-sk-card">
      <div className="dsk-sk-head">
        <div className="skeleton dsk-sk-title" />
        <div className="skeleton dsk-sk-toggle" />
      </div>
      <div className="skeleton dsk-sk-stage" />
      <div className="dsk-sk-stats">
        {DAY_W.slice(0, 4).map((w, i) => (
          <div key={i} className="dsk-sk-stat">
            <div className="skeleton dsk-sk-stat-lbl" />
            <div className="skeleton dsk-sk-stat-val" />
            <div className="skeleton dsk-sk-stat-sub" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

const DayMoveRow = memo(function DayMoveRow({ m, who, onOpen }: { m: ActivityMove; who: 'assignee' | 'moved_by'; onOpen: (id: string) => void }) {
  return (
    <button className="dsk-day-row" onClick={() => onOpen(m.issue_id)} title="Open ticket">
      <span className="dsk-day-id">{m.issue_id}</span>
      <span className="dsk-day-summary">{m.issue_summary}</span>
      <span className="dsk-day-state">{m.to_state}</span>
      <span className="dsk-day-person">{(who === 'assignee' ? m.assignee : m.moved_by) || 'Unknown'}</span>
      <span className="dsk-day-time">{fmtTime(m.transitioned_at)}</span>
    </button>
  )
})

export function DevActivitySkyline({ onOpenDetail }: Props) {
  const { config: wfConfig } = useWorkflowConfig()
  const [metric, setMetric] = usePersistedState<Metric>(PERSIST.DEV_ACTIVITY_SKYLINE_METRIC, 'dev_done', { validate: ['dev_done', 'verified', 'deployed'] })
  const [person, setPerson] = useState<string>(ALL)
  const [rows, setRows] = useState<ActivityDayRow[] | null>(null)
  const [error, setError] = useState('')
  const [day, setDay] = useState<string | null>(null)
  const [dayData, setDayData] = useState<{ day: string; moves: ActivityMove[] } | null>(null)

  const meta = METRICS.find(m => m.id === metric) ?? METRICS[0]
  const dayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getActivityByDay(TZ)
      .then(res => setRows(res.data ?? []))
      .catch(() => { setRows([]); setError('Could not load activity. Try refreshing the page.') })
  }, [])

  // state name (lowercased, incl. aliases) → workflow role
  const roleOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const col of wfConfig?.column_hierarchy ?? []) {
      m.set(col.state.toLowerCase(), col.role)
      for (const a of col.aliases ?? []) m.set(a.toLowerCase(), col.role)
    }
    return (state: string) => {
      const k = state.toLowerCase()
      return m.size ? m.get(k) ?? '' : FALLBACK_ROLES[k] ?? ''
    }
  }, [wfConfig])

  const metricRows = useMemo(
    () => (rows ?? []).filter(r => roleOf(r.to_state) === metric),
    [rows, roleOf, metric],
  )

  const people = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of metricRows) {
      const p = r[meta.who]
      if (p) totals.set(p, (totals.get(p) ?? 0) + r.count)
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  }, [metricRows, meta.who])

  // A person picked under one metric may not exist under another: show everyone instead.
  const who = person !== ALL && rows && !people.includes(person) ? ALL : person

  const data = useMemo<ContributionDay[]>(() => {
    const byDay = new Map<string, number>()
    for (const r of metricRows) {
      if (who !== ALL && r[meta.who] !== who) continue
      byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.count)
    }
    return [...byDay.entries()].map(([date, count]) => ({ date, count }))
  }, [metricRows, who, meta.who])

  // Day drill-down: bring the list into view (it opens below the chart)
  useEffect(() => {
    if (day) dayRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [day])

  useEffect(() => {
    if (!day) return
    let live = true
    api.getActivityDay(day, TZ)
      .then(res => { if (live) setDayData({ day, moves: res.data ?? [] }) })
      .catch(() => { if (live) setDayData({ day, moves: [] }) })
    return () => { live = false }
  }, [day])

  const dayList = useMemo(() => {
    if (!dayData || dayData.day !== day) return null // still loading this day
    return dayData.moves.filter(m => roleOf(m.to_state) === metric && (who === ALL || m[meta.who] === who))
  }, [dayData, day, roleOf, metric, who, meta.who])

  const personLabel = who === ALL ? '' : ` by ${who}`

  return (
    <div className="dsk-wrap">
      <div className="da-filter-bar dsk-controls">
        <div className="da-date-pills dsk-metric-pills">
          {METRICS.map(m => (
            <button key={m.id} className={`da-date-pill${metric === m.id ? ' active' : ''}`} onClick={() => { setMetric(m.id); setDay(null) }}>
              {m.label}
            </button>
          ))}
        </div>
        <span className="da-filter-divider" />
        <CustomDropdown
          className="dsk-person"
          icon={<User size={12} />}
          value={who}
          onChange={v => { setPerson(v); setDay(null) }}
          options={[{ value: ALL, label: 'Everyone' }, ...people.map(p => ({ value: p, label: p }))]}
        />
      </div>

      <div className="dsk-body">
        {rows === null ? <SkylineSkeleton /> : error ? (
          <div className="dsk-empty">{error}</div>
        ) : (
          <ContributionSkyline
            data={data}
            caption={`${meta.title}${personLabel} in the last year`}
            unit="ticket"
            onCellClick={d => setDay(cur => (cur === d.date ? null : d.date))}
          />
        )}

        {day && (
          <div className="dsk-day" ref={dayRef}>
            <div className="dsk-day-head">
              <CalendarDays size={14} />
              <span className="dsk-day-title">{fmtDay(day)}</span>
              <span className="dsk-day-meta">{meta.label}{personLabel}{dayList ? ` · ${dayList.length} ${dayList.length === 1 ? 'move' : 'moves'}` : ''}</span>
              <button className="dsk-day-close" onClick={() => setDay(null)}>Close</button>
            </div>
            {dayList === null ? (
              <div className="dsk-day-list">
                {DAY_W.slice(0, 4).map((w, i) => (
                  <div key={i} className="dsk-day-row dsk-day-row--sk">
                    <div className="skeleton dsk-sk-id" />
                    <div className="skeleton dsk-sk-sum" style={{ width: `${w}%` }} />
                    <div className="skeleton dsk-sk-meta" />
                  </div>
                ))}
              </div>
            ) : dayList.length === 0 ? (
              <div className="dsk-empty dsk-empty--day">{meta.empty}</div>
            ) : (
              <div className="dsk-day-list">
                {dayList.map((m, i) => <DayMoveRow key={`${m.issue_id}-${m.to_state}-${i}`} m={m} who={meta.who} onOpen={onOpenDetail} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
