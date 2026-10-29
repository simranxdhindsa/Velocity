// Dev Activity → Activity Feed: what the team did, as one day-grouped timeline.
// Each ticket's In Progress history (stints) becomes events: "started", "moved to Dev",
// "moved to Blocked", "sent back to To Do". Expanding a row shows the ticket's journey.
import { memo, useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { IssueTimeline } from '../services/api'
import { Timeline, type TimelineEvent } from '@/components/timeline/Timeline'
import { DEV_DONE_STATES, buildJourney, fmtH, getCurrentState } from './dev-activity-types'
import { DaAvatar, DaJourneyChain, DaSummaryBar } from './DevActivityShared'
import { DevActivityRoster, type RosterRow, type RosterStatus } from './DevActivityRoster'
import '../styles/pages/dev-activity-feed.css'

type Kind = 'start' | 'restart' | 'done' | 'blocked' | 'back' | 'moved'

const ALL = ''

const isDevDone = (state: string) => DEV_DONE_STATES.some(k => state.toLowerCase().includes(k))
// Leaving In Progress for a not-started column means the ticket went backwards, even when the
// log's moved_back flag wasn't set.
const isBackwards = (state: string) => /^(to do|todo|backlog|open)$/i.test(state.trim())

const TicketDetail = memo(function TicketDetail({ t, onOpen }: { t: IssueTimeline; onOpen: (id: string) => void }) {
  const state = getCurrentState(t)
  return (
    <div className="daf-detail">
      <div className="daf-detail-summary">{t.issue_summary}</div>
      <DaJourneyChain steps={buildJourney(t.stints ?? [], t.is_live)} />
      <div className="daf-detail-foot">
        <span>Now in <strong>{state}</strong></span>
        <span>{fmtH(t.total_hours)} in progress</span>
        {(t.moved_back_count ?? 0) > 0 && <span className="daf-detail-bounce">Sent back {t.moved_back_count}×</span>}
        <button className="daf-open" onClick={() => onOpen(t.issue_id)}><ExternalLink size={12} /> Open ticket</button>
      </div>
    </div>
  )
})

interface Props {
  timelines: IssueTimeline[]
  onOpenDetail: (id: string) => void
  assigneeFilter: string
  sinceMs: number
  untilMs: number
}

export function ActivityFeedView({ timelines, onOpenDetail, assigneeFilter, sinceMs, untilMs }: Props) {
  const [dev, setDev] = useState(ALL)
  const [now] = useState(() => Date.now())

  // Every event in the date range, with who did it and what kind of move it was
  const all = useMemo(() => {
    const out: (TimelineEvent & { person: string; kind: Kind; summaryText: string; issueId: string })[] = []
    const inRange = (iso: string) => { const t = new Date(iso).getTime(); return t >= sinceMs && t <= untilMs }
    for (const t of timelines) {
      const stints = t.stints ?? []
      const owner = t.assignee || 'Unassigned'
      const detail = <TicketDetail t={t} onOpen={onOpenDetail} />
      stints.forEach((s, i) => {
        if (s.entered_at && inRange(s.entered_at)) {
          const kind: Kind = i === 0 ? 'start' : 'restart'
          out.push({
            id: `${t.issue_id}-${i}-in`, issueId: t.issue_id, at: s.entered_at, person: owner, kind,
            summaryText: `${kind === 'start' ? 'Started' : 'Picked up'} ${t.issue_id}`,
            actor: owner,
            title: <>{kind === 'start' ? 'started' : 'picked up'} <span className="daf-id">{t.issue_id}</span>{kind === 'restart' ? ' again' : ''}</>,
            meta: t.issue_summary, detail, tone: 'accent', icon: <DaAvatar name={owner} size={28} />,
          })
        }
        if (s.exited_at && s.exited_to && inRange(s.exited_at)) {
          const to = s.exited_to
          const kind: Kind = /blocked/i.test(to) ? 'blocked' : (s.moved_back || isBackwards(to)) ? 'back' : isDevDone(to) ? 'done' : 'moved'
          const who = s.moved_by || owner
          out.push({
            id: `${t.issue_id}-${i}-out`, issueId: t.issue_id, at: s.exited_at, person: who, kind,
            summaryText: kind === 'back' ? `Sent ${t.issue_id} back to ${to}` : `Moved ${t.issue_id} to ${to}`,
            actor: who,
            title: kind === 'back'
              ? <>sent <span className="daf-id">{t.issue_id}</span> back to <strong>{to}</strong></>
              : <>moved <span className="daf-id">{t.issue_id}</span> to <strong>{to}</strong>{kind === 'done' ? ', dev done' : kind === 'blocked' ? ', blocked' : ''}</>,
            meta: t.issue_summary,
            detail,
            tone: kind === 'done' ? 'success' : kind === 'blocked' ? 'danger' : kind === 'back' ? 'warning' : 'neutral',
            icon: <DaAvatar name={who} size={28} />,
          })
        }
      })
    }
    return out
  }, [timelines, sinceMs, untilMs, onOpenDetail])

  // Roster: everyone with activity in range, busiest first, with what they're on right now
  const roster = useMemo<RosterRow[]>(() => {
    const m = new Map<string, RosterRow & { latestTitle: string }>()
    for (const e of all) {
      const t = new Date(e.at).getTime()
      const r = m.get(e.person) ?? { name: e.person, status: 'idle' as RosterStatus, subtitle: '', updates: 0, done: 0, blocked: 0, lastAt: 0, latestTitle: '' }
      r.updates++
      if (e.kind === 'done') r.done++
      if (t > r.lastAt) { r.lastAt = t; r.latestTitle = e.summaryText }
      m.set(e.person, r)
    }
    for (const r of m.values()) {
      const mine = timelines.filter(t => t.assignee === r.name)
      const live = mine.find(t => t.is_live)
      // Blocked = their tickets blocked right now (same thing the amber status dot means)
      r.blocked = mine.filter(t => /blocked/i.test(getCurrentState(t))).length
      if (live) {
        r.status = 'working'
        r.subtitle = `Working on ${live.issue_id}`
      } else {
        r.status = r.blocked > 0 ? 'blocked' : 'idle'
        r.subtitle = r.latestTitle
      }
    }
    return [...m.values()].sort((a, b) => b.updates - a.updates)
  }, [all, timelines])

  const who = assigneeFilter || dev
  const events = useMemo(() => (who ? all.filter(e => e.person === who) : all), [all, who])
  // KPI chips for a selected person = the tickets they actually worked on in this range
  // (not tickets currently assigned to them: finished work usually gets reassigned to QA).
  const timelinesShown = useMemo(() => {
    if (!who) return timelines
    const ids = new Set(events.map(e => e.issueId))
    return timelines.filter(t => ids.has(t.issue_id))
  }, [timelines, who, events])

  return (
    <div className="daf-wrap">
      <DaSummaryBar timelines={timelinesShown} />
      <div className="daf-sections">
        {!assigneeFilter && roster.length > 0 && (
          <section className="daf-card daf-card--team" aria-label="Team">
            <header className="daf-card-head">
              <span className="daf-card-title">Team</span>
              <span className="daf-card-meta">{roster.length} {roster.length === 1 ? 'person' : 'people'} active</span>
              <span className="daf-card-hint">Click someone to see only their activity</span>
            </header>
            <DevActivityRoster rows={roster} selected={dev} now={now} onSelect={name => setDev(d => (d === name ? ALL : name))} />
          </section>
        )}
        <section className="daf-card daf-card--activity" aria-label="Activity">
          <header className="daf-card-head">
            <span className="daf-card-title">Activity</span>
            {who
              ? <span className="daf-card-meta"><DaAvatar name={who} size={18} /> <strong>{who}</strong> · {events.length} {events.length === 1 ? 'update' : 'updates'}</span>
              : <span className="daf-card-meta">Everyone · {events.length} {events.length === 1 ? 'update' : 'updates'}</span>}
            {who && !assigneeFilter && <button className="daf-filter-clear" onClick={() => setDev(ALL)}>Show everyone</button>}
          </header>
          <div className="daf-scroll">
            <Timeline
              events={events}
              now={now}
              label="Developer activity"
              empty={<div className="da-empty"><span className="da-empty-icon">📭</span><span className="da-empty-text">No activity found for this date range</span></div>}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
