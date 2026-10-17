// Dev Activity → Activity Feed: what the team did, as one day-grouped timeline.
// Each ticket's In Progress history (stints) becomes events: "started", "moved to Dev",
// "moved to Blocked", "sent back to To Do". Expanding a row shows the ticket's journey.
import { memo, useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { IssueTimeline } from '../services/api'
import { Timeline, type TimelineEvent } from '@/components/timeline/Timeline'
import { DEV_DONE_STATES, buildJourney, fmtH, getCurrentState } from './dev-activity-types'
import { DaAvatar, DaJourneyChain, DaSummaryBar } from './DevActivityShared'
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
    const out: (TimelineEvent & { person: string; kind: Kind })[] = []
    const inRange = (iso: string) => { const t = new Date(iso).getTime(); return t >= sinceMs && t <= untilMs }
    for (const t of timelines) {
      const stints = t.stints ?? []
      const owner = t.assignee || 'Unassigned'
      const detail = <TicketDetail t={t} onOpen={onOpenDetail} />
      stints.forEach((s, i) => {
        if (s.entered_at && inRange(s.entered_at)) {
          const kind: Kind = i === 0 ? 'start' : 'restart'
          out.push({
            id: `${t.issue_id}-${i}-in`, at: s.entered_at, person: owner, kind,
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
            id: `${t.issue_id}-${i}-out`, at: s.exited_at, person: who, kind,
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

  // People with activity in range, busiest first (chips double as the "who was active" overview)
  const people = useMemo(() => {
    const m = new Map<string, { n: number; done: number }>()
    for (const e of all) {
      const p = m.get(e.person) ?? { n: 0, done: 0 }
      p.n++
      if (e.kind === 'done') p.done++
      m.set(e.person, p)
    }
    return [...m].sort((a, b) => b[1].n - a[1].n)
  }, [all])

  const who = assigneeFilter || dev
  const events = useMemo(() => (who ? all.filter(e => e.person === who) : all), [all, who])
  const timelinesShown = useMemo(
    () => (who ? timelines.filter(t => t.assignee === who) : timelines),
    [timelines, who],
  )

  return (
    <div className="daf-wrap">
      <DaSummaryBar timelines={timelinesShown} />
      {!assigneeFilter && people.length > 0 && (
        <div className="daf-people" role="toolbar" aria-label="Filter by developer">
          <button className={`daf-chip${dev === ALL ? ' active' : ''}`} onClick={() => setDev(ALL)}>
            Everyone <span className="daf-chip-n">{all.length}</span>
          </button>
          {people.map(([name, p]) => (
            <button key={name} className={`daf-chip${dev === name ? ' active' : ''}`} onClick={() => setDev(d => (d === name ? ALL : name))}
              title={`${p.n} updates, ${p.done} dev done`}>
              <DaAvatar name={name} size={20} />
              {name} <span className="daf-chip-n">{p.n}</span>
            </button>
          ))}
        </div>
      )}
      <div className="daf-scroll">
        <Timeline
          events={events}
          now={now}
          label="Developer activity"
          empty={<div className="da-empty"><span className="da-empty-icon">📭</span><span className="da-empty-text">No activity found for this date range</span></div>}
        />
      </div>
    </div>
  )
}
