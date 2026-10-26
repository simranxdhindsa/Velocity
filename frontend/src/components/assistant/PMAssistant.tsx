// PM Assistant (floating panel). Redesigned around the 21st.dev "ai thinking orb and input":
// the question leaves the glowing pill as a ball, becomes a dotted thinking orb in the thread,
// turns green when the answer lands and unfolds into an answer card. Earlier exchanges stay
// above as cards. Logic (sprint context, retries, friendly rate-limit copy, sprint switch
// action) is unchanged from the old PMAssistantTab.
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitBranch, ChevronDown, Check, RotateCcw } from 'lucide-react'
import api, { type YouTrackSprint } from '@/services/api'
import { pmAssistantQuery } from '@/services/pmDataService'
import { useAuth } from '@/contexts/AuthContext'
import { upperAmPm } from '@/components/ClockTimePicker'
import { DAILY_LIMIT_MSGS, GENERIC_LIMIT_MSGS } from '@/data/assistantMessages'
import { renderMarkdown, SUGGESTED_QUERIES } from './assistant-markdown'
import { ThinkingOrb } from './ThinkingOrb'
import { AssistantPill } from './AssistantPill'
import '@/styles/components/pm-assistant.css'

interface Exchange {
  id: string
  question: string
  answer: string | null
  failed?: boolean
  askedAt: Date
  answeredAt?: Date
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
const fmtTime = (d: Date) => upperAmPm(timeFmt.format(d))
const fmtSprintDate = (ms: number) => ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]

function friendlyError(msg: string): string {
  const tpd = msg.match(/try again in (\d+)m(\d+(?:\.\d+)?)?s?/i)
  if (tpd) {
    const mins = parseInt(tpd[1])
    const secs = tpd[2] ? Math.round(parseFloat(tpd[2])) : 0
    const timeStr = secs > 0 ? `${mins}m ${secs}s` : `${mins} minute${mins !== 1 ? 's' : ''}`
    return pick(DAILY_LIMIT_MSGS).replace(/{time}/g, timeStr)
  }
  if (/try again in (\d+(?:\.\d+)?)(ms|s)\b/i.test(msg)) return pick(GENERIC_LIMIT_MSGS)
  if (/rate limit|token/i.test(msg)) return pick(GENERIC_LIMIT_MSGS)
  return 'Something went wrong on my end. Please try again.'
}

/** One finished exchange: the question chip and its answer card. `unfold` plays the
 *  circle-to-card reveal for the answer that just landed. */
const ExchangeView = memo(function ExchangeView({ ex, userPic, userInitial, unfold }: {
  ex: Exchange; userPic?: string; userInitial: string; unfold: boolean
}) {
  return (
    <div className="pa-ex">
      <div className="pa-q">
        <span className="pa-q-text">{ex.question}</span>
        {userPic
          ? <img className="pa-q-avatar" src={userPic} alt="" />
          : <span className="pa-q-avatar pa-q-avatar--initial">{userInitial}</span>}
      </div>
      {ex.answer !== null && (
        <div className={`pa-card pm-chat-assistant${ex.failed ? ' pa-card--failed' : ''}${unfold ? ' pa-card--unfold' : ''}`}>
          <div className="pa-card-head">
            <i className="pa-card-dot" aria-hidden="true" />
            <span>{ex.failed ? 'Could not answer' : 'Answer'}</span>
            {ex.answeredAt && <span className="pa-card-time">{fmtTime(ex.answeredAt)}</span>}
          </div>
          <div className="pa-card-body pm-chat-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(ex.answer) }} />
        </div>
      )}
    </div>
  )
})

export function PMAssistant() {
  const { user } = useAuth()
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [input, setInput] = useState('')
  /** The exchange being answered: orb thinks, then plays "done" once the reply is in */
  const [pending, setPending] = useState<{ id: string; from: DOMRect | null; reply: { text: string; failed: boolean } | null } | null>(null)
  const [unfoldId, setUnfoldId] = useState<string | null>(null)
  const pendingRef = useRef(pending)
  useEffect(() => { pendingRef.current = pending }, [pending])
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const reqRef = useRef(0)

  const [sprints, setSprints] = useState<YouTrackSprint[]>([])
  const [sprint, setSprint] = useState<YouTrackSprint | null>(null)
  const [sprintOpen, setSprintOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const sprintRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getYouTrackSprints().then(res => {
      const list = ((res as { data?: YouTrackSprint[] }).data) ?? []
      setSprints(list)
      const savedId = localStorage.getItem('pm_active_sprint_id')
      const found = savedId ? list.find(s => s.id === savedId) : undefined
      if (found) setSprint(found)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (sprintRef.current && !sprintRef.current.contains(e.target as Node) && !(e.target as Element).closest?.('.pa-sprint-menu')) setSprintOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 3500)
    return () => clearTimeout(t)
  }, [notice])

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = threadRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    })
  }, [])
  useEffect(scrollToEnd, [exchanges.length, pending?.id, scrollToEnd])

  const selectSprint = (s: YouTrackSprint | null) => {
    setSprint(s)
    setSprintOpen(false)
    if (s) { localStorage.setItem('pm_active_sprint_id', s.id); localStorage.setItem('pm_active_sprint_name', s.name) }
    else { localStorage.removeItem('pm_active_sprint_id'); localStorage.removeItem('pm_active_sprint_name') }
  }

  const ask = async (text: string, launchFrom: DOMRect | null) => {
    if (pending) return
    // Suggestion chips have no rect of their own: launch from the pill's send button
    const from = launchFrom ?? rootRef.current?.querySelector('.pa-send')?.getBoundingClientRect() ?? null
    const id = `ex-${Date.now()}`
    const req = ++reqRef.current
    const history = exchanges.flatMap(e => e.answer !== null && !e.failed
      ? [{ role: 'user' as const, content: e.question }, { role: 'assistant' as const, content: e.answer }]
      : [{ role: 'user' as const, content: e.question }])
    setExchanges(prev => [...prev, { id, question: text, answer: null, askedAt: new Date() }])
    setPending({ id, from, reply: null })
    setInput('')

    const doQuery = () => pmAssistantQuery(text, history, sprint?.id, sprint?.name, sprint?.finish ?? undefined)
    let reply: { text: string; failed: boolean }
    try {
      let res
      try {
        res = await doQuery()
      } catch (first) {
        // Per-minute limits under 5s: wait and retry once
        const m = (first instanceof Error ? first.message : '').match(/try again in (\d+(?:\.\d+)?)(ms|s)\b/i)
        const delay = m ? (m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) : parseFloat(m[1]) * 1000) : Infinity
        if (delay > 5000) throw first
        await new Promise(r => setTimeout(r, Math.ceil(delay) + 100))
        res = await doQuery()
      }
      const data = res.data as { response?: string; action?: string; payload?: { sprint_id?: string; sprint_name?: string } }
      if (data?.action === 'select_sprint' && data.payload?.sprint_id) {
        const target = sprints.find(s => s.id === data.payload!.sprint_id)
          ?? { id: data.payload.sprint_id, name: data.payload.sprint_name ?? data.payload.sprint_id, start: 0, finish: 0, isCompleted: false }
        selectSprint(target as YouTrackSprint)
        setNotice(`Switched to ${target.name}`)
      }
      reply = { text: data?.response || 'No response received.', failed: false }
    } catch (err) {
      reply = { text: friendlyError(err instanceof Error ? err.message : ''), failed: true }
    }
    if (req !== reqRef.current) return // stopped with Esc or chat cleared
    setPending(p => (p && p.id === id ? { ...p, reply } : p))
  }

  // Orb finished its "done" sequence: the answer card takes its place and unfolds
  const onOrbFinished = useCallback(() => {
    const p = pendingRef.current
    if (!p?.reply) return
    const { id, reply } = p
    setExchanges(prev => prev.map(e => e.id === id ? { ...e, answer: reply.text, failed: reply.failed, answeredAt: new Date() } : e))
    setUnfoldId(id)
    setPending(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  // Esc stops waiting for an answer (the request itself can't be cancelled; its reply is ignored)
  useEffect(() => {
    if (!pending || pending.reply) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      reqRef.current++
      setExchanges(prev => prev.filter(x => x.id !== pending.id))
      setInput(exchanges.find(x => x.id === pending.id)?.question ?? '')
      setPending(null)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, exchanges])

  const newChat = () => {
    reqRef.current++
    setExchanges([])
    setPending(null)
    setUnfoldId(null)
    inputRef.current?.focus()
  }

  const empty = exchanges.length === 0
  const busy = pending !== null
  const userInitial = user?.name?.charAt(0).toUpperCase() ?? 'U'
  const menuRect = sprintOpen ? sprintRef.current?.getBoundingClientRect() : undefined

  return (
    <div className={`pa-root${empty ? ' pa-root--empty' : ''}`} ref={rootRef}>
      <div className="pa-bg" aria-hidden="true" />

      <div className="pa-top">
        <div className="pa-sprint" ref={sprintRef}>
          <button type="button" className="pa-sprint-btn" onClick={() => setSprintOpen(o => !o)} aria-expanded={sprintOpen}>
            <GitBranch size={12} />
            <span>{sprint ? sprint.name : 'All sprints'}</span>
            <ChevronDown size={11} />
          </button>
          {sprintOpen && menuRect && createPortal(
            <div className="pm-custom-dropdown-menu pa-sprint-menu" style={{ position: 'fixed', top: menuRect.bottom + 4, left: menuRect.left, minWidth: 220, zIndex: 9999 }}>
              <div className={`pm-dropdown-item${!sprint ? ' active' : ''}`} onClick={() => selectSprint(null)}>All sprints</div>
              {sprints.map(s => (
                <div key={s.id} className={`pm-dropdown-item${sprint?.id === s.id ? ' active' : ''}${s.isCompleted ? ' pa-sprint-done' : ''}`} onClick={() => selectSprint(s)}>
                  <span className="pa-sprint-name">{s.name}</span>
                  {s.start && s.finish ? <span className="pa-sprint-dates">{fmtSprintDate(s.start)} to {fmtSprintDate(s.finish)}</span> : null}
                </div>
              ))}
            </div>,
            document.body,
          )}
        </div>
        <span className="pa-live"><i aria-hidden="true" />Live context</span>
        {!empty && (
          <button type="button" className="pa-new" onClick={newChat} title="Start a new conversation">
            <RotateCcw size={12} /> New chat
          </button>
        )}
      </div>

      {notice && <div className="pa-notice"><Check size={12} />{notice}</div>}

      <div className="pa-thread" ref={threadRef}>
        {empty ? (
          <div className="pa-hero">
            <ThinkingOrb mode="idle" radius={46} />
            <h3 className="pa-hero-title">Ask about your project</h3>
            <p className="pa-hero-sub">Overdue tickets, blockers, regressions, workload. Answers use live {sprint ? sprint.name : 'sprint'} data.</p>
            <div className="pa-chips">
              {SUGGESTED_QUERIES.slice(0, 4).map(q => (
                <button key={q} type="button" className="pa-chip" onClick={() => ask(q, null)}>{q}</button>
              ))}
            </div>
          </div>
        ) : (
          exchanges.map(ex => (
            <div key={ex.id}>
              <ExchangeView ex={ex} userPic={user?.picture} userInitial={userInitial} unfold={ex.id === unfoldId} />
              {pending?.id === ex.id && (
                <div className="pa-orb-slot">
                  <ThinkingOrb mode={pending.reply ? 'done' : 'think'} radius={34} launchFrom={pending.from} onFinished={onOrbFinished} />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="pa-dock">
        {!empty && !busy && (
          <div className="pa-chips pa-chips--row">
            {SUGGESTED_QUERIES.slice(0, 4).map(q => (
              <button key={q} type="button" className="pa-chip pa-chip--sm" onClick={() => ask(q, null)}>{q}</button>
            ))}
          </div>
        )}
        <AssistantPill
          ref={inputRef}
          value={input}
          onChange={setInput}
          onSubmit={ask}
          busy={busy}
          placeholder={sprint ? `Ask about ${sprint.name}…` : 'Ask anything about your project…'}
        />
      </div>
    </div>
  )
}
