import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'
import { dayTrackApi, api, type DayTrackEntry, type DayTrackPlanned, type DayTrackSlackConfig, type DayTrackKWRule, DEFAULT_KEYWORD_RULES } from '../services/api'
import { CalendarPicker } from '../components/CalendarPicker'
import '../styles/pages/daytrack.css'

// ── Helpers ────────────────────────────────────────────────────────────────────

const PALETTE = ['#6366f1','#10b981','#8b5cf6','#f59e0b','#06b6d4','#ec4899','#f97316','#ef4444','#84cc16','#14b8a6']
const DEFAULT_CATS = ['Development','Testing','Meetings','Breaks','Review','Research','Sign In','Sign Off']

function catColor(cat: string, cats: string[]): string {
  const fixed: Record<string,string> = {
    Development: '#6366f1', Testing: '#10b981', Meetings: '#8b5cf6',
    Breaks: '#f59e0b', Review: '#06b6d4', Research: '#ec4899',
    'Sign In': '#22c55e', 'Sign Off': '#94a3b8',
  }
  if (fixed[cat]) return fixed[cat]
  const idx = cats.indexOf(cat)
  return PALETTE[((idx < 0 ? 0 : idx)) % PALETTE.length]
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function fmtDate(d: Date): string {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
}

function to12h(hhmm: string): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return hhmm
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

function to24h(time12: string): string {
  if (!time12) return ''
  const match = time12.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return time12
  let h = parseInt(match[1])
  const m = match[2]
  const ampm = match[3].toUpperCase()
  if (ampm === 'AM' && h === 12) h = 0
  if (ampm === 'PM' && h !== 12) h += 12
  return `${String(h).padStart(2, '0')}:${m}`
}

function nowHHMM(): string {
  const n = new Date()
  return to12h(`${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`)
}

function timeToMins(t: string): number {
  if (!t) return 0
  const match = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (match) {
    let h = parseInt(match[1])
    const m = parseInt(match[2])
    const ampm = match[3].toUpperCase()
    if (ampm === 'AM' && h === 12) h = 0
    if (ampm === 'PM' && h !== 12) h += 12
    return h * 60 + m
  }
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function addMinute(time12: string): string {
  const mins = timeToMins(time12)
  const total = mins + 1
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  return to12h(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
}

function calcDuration(s: string, e: string): number | null {
  if (!s || !e) return null
  let diff = timeToMins(e) - timeToMins(s)
  if (diff < 0) diff += 24 * 60
  return diff > 0 ? diff : null
}

function minsLabel(m: number | null | undefined): string {
  if (m == null) return '—'
  const h = Math.floor(m / 60), min = m % 60
  return h > 0 ? `${h}h ${min}m` : `${min}m`
}

// ── Toast ──────────────────────────────────────────────────────────────────────

type ToastType = 'success' | 'info' | 'warn'
interface Toast { id: number; msg: string; type: ToastType }

function ToastContainer({ toasts }: { toasts: Toast[] }) {
  const icon = (t: ToastType) => {
    if (t === 'success') return <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    if (t === 'warn')    return <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
    return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
  }
  return (
    <div className="dt-toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`dt-toast dt-toast--${t.type}`}>
          {icon(t.type)}
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

// ── Month picker ──────────────────────────────────────────────────────────────

function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(() => value ? parseInt(value.slice(0, 4)) : new Date().getFullYear())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !dropRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const fmtDisplay = (v: string) => {
    if (!v) return 'Select month'
    const [y, m] = v.split('-')
    return `${months[parseInt(m) - 1]} ${y}`
  }

  return (
    <div className="form-group">
      <label className="form-label">Select Month</label>
      <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
        <button ref={triggerRef} className="dr-cal-trigger" style={{ width: '100%', justifyContent: 'flex-start' }}
          onClick={() => {
            if (triggerRef.current) {
              const r = triggerRef.current.getBoundingClientRect()
              setPos({ top: r.bottom + 6, left: r.left })
            }
            if (value) setYear(parseInt(value.slice(0, 4)))
            setOpen(o => !o)
          }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          <span>{fmtDisplay(value)}</span>
        </button>
        {open && pos && createPortal(
          <div ref={dropRef} className="dr-cal-dropdown glass-card"
            style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999, minWidth: 240, padding: 12 }}>
            <div className="calendar-nav">
              <button onClick={() => setYear(y => y - 1)}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <span className="calendar-month-label">{year}</span>
              <button onClick={() => setYear(y => y + 1)}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
              </button>
            </div>
            <div className="dt-month-grid">
              {months.map((m, i) => {
                const val = `${year}-${String(i + 1).padStart(2, '0')}`
                const isSelected = val === value
                const isCurrent = val === toDateStr(new Date()).slice(0, 7)
                return (
                  <button key={m}
                    className={`dt-month-cell${isSelected ? ' selected' : ''}${isCurrent ? ' today' : ''}`}
                    onClick={() => { onChange(val); setOpen(false) }}>
                    {m}
                  </button>
                )
              })}
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>
  )
}

// CalendarPicker is imported from src/components/CalendarPicker.tsx

function CategoryChips({ value, onChange, categories }: {
  value: string
  onChange: (v: string) => void
  categories: string[]
}) {
  return (
    <div className="dt-chip-group">
      {categories.map(c => {
        const col = (() => {
          const fixed: Record<string,string> = {
            Development: '#6366f1', Testing: '#10b981', Meetings: '#8b5cf6',
            Breaks: '#f59e0b', Review: '#06b6d4', Research: '#ec4899',
          }
          if (fixed[c]) return fixed[c]
          const PALETTE = ['#6366f1','#10b981','#8b5cf6','#f59e0b','#06b6d4','#ec4899','#f97316','#ef4444','#84cc16','#14b8a6']
          const idx = categories.indexOf(c)
          return PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length]
        })()
        const selected = value === c
        return (
          <button
            key={c}
            type="button"
            className={`dt-chip${selected ? ' dt-chip--selected' : ''}`}
            style={selected ? { background: col + '25', borderColor: col, color: col } : {}}
            onClick={() => onChange(c)}
          >
            <span className="dt-chip-dot" style={{ background: col }}/>
            {c}
          </button>
        )
      })}
    </div>
  )
}

function TaskNameInput({ value, onChange, suggestions, placeholder, onEnter }: {
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  placeholder?: string
  onEnter?: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [showDrop, setShowDrop] = useState(false)
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const ghost = value.trim().length > 0
    ? (suggestions.find(s => s.toLowerCase().startsWith(value.toLowerCase()) && s.toLowerCase() !== value.toLowerCase()) ?? '')
    : ''
  const ghostSuffix = ghost ? ghost.slice(value.length) : ''

  const matches = value.trim().length >= 2
    ? suggestions.filter(s => s.toLowerCase().includes(value.toLowerCase()) && s.toLowerCase() !== value.toLowerCase()).slice(0, 6)
    : []

  function updatePos() {
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect()
      setDropPos({ top: r.bottom + 2, left: r.left, width: r.width })
    }
  }

  return (
    <div className="dt-suggest-wrap">
      {ghostSuffix && (
        <div className="dt-suggest-ghost" aria-hidden>
          <span className="dt-suggest-ghost-typed">{value}</span>
          <span className="dt-suggest-ghost-hint">{ghostSuffix}</span>
        </div>
      )}
      <input
        ref={inputRef}
        className="form-input dt-suggest-input"
        value={value}
        onChange={e => { onChange(e.target.value); updatePos(); setShowDrop(e.target.value.trim().length >= 2) }}
        placeholder={ghostSuffix ? '' : placeholder}
        autoComplete="off"
        onFocus={() => { updatePos(); if (value.trim().length >= 2 && matches.length > 0) setShowDrop(true) }}
        onBlur={() => setTimeout(() => setShowDrop(false), 150)}
        onKeyDown={e => {
          if (e.key === 'Tab' && ghostSuffix) { e.preventDefault(); onChange(ghost) }
          if (e.key === 'Enter') { onEnter?.(); setShowDrop(false) }
          if (e.key === 'Escape') setShowDrop(false)
        }}
      />
      {showDrop && dropPos && matches.length > 0 && createPortal(
        <div className="dt-suggest-dropdown"
          style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width, zIndex: 9999 }}>
          {matches.map(s => (
            <button key={s} className="dt-suggest-item"
              onMouseDown={e => { e.preventDefault(); onChange(s); setShowDrop(false) }}>
              {s}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Category auto-detect ──────────────────────────────────────────────────────

function detectCategory(text: string, categories: string[]): string {
  const lower = text.toLowerCase()
  const rules: [string, string[]][] = [
    ['Testing', ['test', 'testing', 'qa', 'playwright', 'cypress', 'debug', 'bug', 'regression', 'e2e']],
    ['Development', ['develop', 'implement', 'build', 'feature', 'refactor', 'commit', 'pull request', 'code', 'coding', 'programming']],
    ['Meetings', ['meeting', 'standup', 'stand-up', 'call', 'sync', 'discussion', 'demo', 'retrospective', 'retro', 'planning']],
    ['Breaks', ['break', 'lunch', 'coffee', 'aws', 'away from screen', 'brb']],
    ['Research', ['research', 'reading', 'study', 'investigate', 'explore', 'analyze', 'analysis', 'look into']],
    ['Review', ['review', 'code review', 'pr review', 'feedback']],
    ['Sign In', ['signing in', 'signed in', 'logging in', 'starting work']],
    ['Sign Off', ['signing off', 'signed off', 'logging off', 'end of day']],
  ]
  for (const [cat, keywords] of rules) {
    if (keywords.some(kw => lower.includes(kw)) && categories.includes(cat)) return cat
  }
  return ''
}

// ── Mic button ────────────────────────────────────────────────────────────────

function MicButton({ onResult, onError }: {
  onResult: (text: string) => void
  onError?: (msg: string) => void
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const mrRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startTimeRef = useRef<number>(0)

  function startBrowserFallback() {
    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    if (!SR) { onError?.('Microphone not available'); return }
    const rec = new SR()
    rec.lang = 'en-IN'
    rec.continuous = false
    rec.interimResults = false
    rec.onresult = (e: any) => { onResult(e.results[0][0].transcript); setState('idle') }
    rec.onerror = () => { onError?.('Could not recognise speech'); setState('idle') }
    rec.onend = () => setState('idle')
    setState('recording')
    rec.start()
  }

  async function toggle() {
    if (state === 'transcribing') return
    if (state === 'recording') { mrRef.current?.stop(); return }

    if (!navigator.mediaDevices?.getUserMedia) { startBrowserFallback(); return }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
      const mr = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const duration = Date.now() - startTimeRef.current
        if (duration < 400) {
          onError?.('Recording too short — please hold and speak, then tap to stop')
          setState('idle')
          return
        }
        setState('transcribing')
        const blob = new Blob(chunksRef.current, { type: mr.mimeType })
        try {
          const res = await dayTrackApi.transcribe(blob)
          if (res?.text) onResult(res.text.trim())
          else onError?.('No speech detected — please try again')
        } catch (err) {
          const msg = err instanceof Error ? err.message : ''
          if (msg.includes('400') || msg.includes('empty') || msg.includes('no audio')) {
            onError?.('No audio detected — please try again')
          } else {
            onError?.('Transcription failed — please try again')
          }
        }
        setState('idle')
      }
      mr.start()
      startTimeRef.current = Date.now()
      mrRef.current = mr
      setState('recording')
    } catch {
      startBrowserFallback()
    }
  }

  return (
    <button
      type="button"
      className={`dt-mic-btn${state === 'recording' ? ' dt-mic-btn--rec' : state === 'transcribing' ? ' dt-mic-btn--loading' : ''}`}
      onClick={toggle}
      disabled={state === 'transcribing'}
      title={state === 'idle' ? 'Click to record, click again to stop' : state === 'recording' ? 'Recording… click to stop' : 'Transcribing…'}
    >
      {state === 'transcribing' ? (
        <svg className="dt-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
      ) : state === 'recording' ? (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      )}
    </button>
  )
}

// Isolated clock component — keeps 1-second re-renders scoped to this tiny node
// instead of re-rendering the entire DayTrackPage tree.
const ClockDisplay = memo(function ClockDisplay() {
  const [clock, setClock] = useState(() => {
    const n = new Date()
    return n.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  })
  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date()
      setClock(n.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }, 1000)
    return () => clearInterval(id)
  }, [])
  return <>{clock}</>
})

export function DayTrackPage() {
  const [date, setDate] = useState<string>(toDateStr(new Date()))
  const [entries, setEntries] = useState<DayTrackEntry[]>([])
  const [planned, setPlanned] = useState<DayTrackPlanned[]>([])
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATS)
  const [loading, setLoading] = useState(true)

  // Active tab in left card: manual | timer | plan
  const [activeTab, setActiveTab] = useState<'manual'|'timer'|'plan'>('manual')

  // Settings modal
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Slack config state
  const [slackCfg, setSlackCfg] = useState<DayTrackSlackConfig | null>(null)
  const [slackCfgLoading, setSlackCfgLoading] = useState(false)
  const [slackCfgSaving, setSlackCfgSaving] = useState(false)
  const [slackChannels, setSlackChannels] = useState<{id: string; name: string}[]>([])
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [slackChanOpen, setSlackChanOpen] = useState(false)
  const slackChanRef = useRef<HTMLButtonElement>(null)
  const [slackChanPos, setSlackChanPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const [destChanOpen, setDestChanOpen] = useState(false)
  const destChanRef = useRef<HTMLButtonElement>(null)
  const [destChanPos, setDestChanPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const [posting, setPosting] = useState(false)
  const [openRuleCatIdx, setOpenRuleCatIdx] = useState<number | null>(null)
  const [ruleCatPos, setRuleCatPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const ruleCatRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [openRuleTypeIdx, setOpenRuleTypeIdx] = useState<number | null>(null)
  const [ruleTypePos, setRuleTypePos] = useState<{ top: number; left: number; width: number } | null>(null)
  const ruleTypeRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Draft persistence helpers
  const DRAFT_KEY = 'dt-draft'
  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      mName, mCat, mStart, mEnd, mNotes,
      tName, tCat, tNotes,
      pName, pCat, pTime, pWhen, pNotes,
    }))
  }
  function clearDraft() { localStorage.removeItem(DRAFT_KEY) }

  // Manual form — restored from draft on mount
  const _draft = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') } catch { return null } })()
  const [mName, setMName] = useState(_draft?.mName ?? '')
  const [mCat, setMCat] = useState(_draft?.mCat ?? '')
  const [mStart, setMStart] = useState(_draft?.mStart ?? '')
  const [mEnd, setMEnd] = useState(_draft?.mEnd ?? '')
  const [mNotes, setMNotes] = useState(_draft?.mNotes ?? '')

  // Timer form — restored from draft
  const [tName, setTName] = useState(_draft?.tName ?? '')
  const [tCat, setTCat] = useState(_draft?.tCat ?? '')
  const [tNotes, setTNotes] = useState(_draft?.tNotes ?? '')
  const [timerRunning, setTimerRunning] = useState(false)
  const [timerPaused, setTimerPaused] = useState(false)
  const [timerDisplay, setTimerDisplay] = useState('00:00:00')
  const [timerStatus, setTimerStatus] = useState<'idle'|'running'|'paused'>('idle')
  const timerStartRef = useRef<number>(0)
  const pausedMsRef = useRef<number>(0)
  const pauseStartRef = useRef<number>(0)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Plan form — restored from draft
  const [pName, setPName] = useState(_draft?.pName ?? '')
  const [pCat, setPCat] = useState(_draft?.pCat ?? '')
  const [pTime, setPTime] = useState(_draft?.pTime ?? '')
  const [pWhen, setPWhen] = useState<'today'|'tomorrow'>(_draft?.pWhen ?? 'today')
  const [pNotes, setPNotes] = useState(_draft?.pNotes ?? '')

  // Export modal
  const [exportOpen, setExportOpen] = useState(false)
  const [exportMode, setExportMode] = useState<'today'|'month'|'custom'>('today')
  const [exportMonth, setExportMonth] = useState(() => date.slice(0, 7))
  const [exportStart, setExportStart] = useState(date)
  const [exportEnd, setExportEnd] = useState(date)
  const [exportLoading, setExportLoading] = useState(false)
  const [exportBreaks, setExportBreaks] = useState(true)
  const [exportSummarise, setExportSummarise] = useState(false)
  const [exportCopyLoading, setExportCopyLoading] = useState(false)
  const [exportAISummary, setExportAISummary] = useState<string | null>(null)
  const [exportAILoading, setExportAILoading] = useState(false)

  // Category manager
  const [newCat, setNewCat] = useState('')
  const [catMgrOpen, setCatMgrOpen] = useState(false)

  // Edit modal
  const [editEntry, setEditEntry] = useState<DayTrackEntry | null>(null)
  const [eName, setEName] = useState('')
  const [eCat, setECat] = useState('')
  const [eStart, setEStart] = useState('')
  const [eEnd, setEEnd] = useState('')
  const [eNotes, setENotes] = useState('')

  // Category dropdown open state (one at a time)
  const [openDrop, setOpenDrop] = useState<'mCat'|'tCat'|'pCat'|'eCat'|'stCat'|null>(null)
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const mCatRef = useRef<HTMLDivElement>(null)
  const tCatRef = useRef<HTMLDivElement>(null)
  const pCatRef = useRef<HTMLDivElement>(null)
  const eCatRef = useRef<HTMLDivElement>(null)
  const stCatRef = useRef<HTMLDivElement>(null)

  function openDropdown(key: 'mCat'|'tCat'|'pCat'|'eCat'|'stCat', ref: React.RefObject<HTMLDivElement | null>) {
    if (openDrop === key) { setOpenDrop(null); return }
    if (ref.current) {
      const r = ref.current.getBoundingClientRect()
      setDropPos({ top: r.bottom + 4, left: r.left, width: r.width })
    }
    setOpenDrop(key)
  }

  // Subtask state
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set())
  const [subtaskParent, setSubtaskParent] = useState<DayTrackEntry | null>(null)
  const [stName, setStName] = useState('')
  const [stCat, setStCat] = useState('')
  const [stStart, setStStart] = useState('')
  const [stEnd, setStEnd] = useState('')
  const [stNotes, setStNotes] = useState('')

  // Calendar
  const [calOpen, setCalOpen] = useState(false)
  const [calDate, setCalDate] = useState(new Date())
  const calTriggerRef = useRef<HTMLButtonElement>(null)
  const calDropRef = useRef<HTMLDivElement>(null)
  // calRef kept for API compat but unused — portal approach used instead
  const [calPos, setCalPos] = useState<{ top: number; left: number } | null>(null)

  // Suggestions
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [mSuggest, setMSuggest] = useState<string[]>([])
  const [tSuggest, setTSuggest] = useState<string[]>([])

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)

  // Live clock rendered by isolated ClockDisplay component above

  // Close dropdowns / calendar on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      const inTrigger = [mCatRef, tCatRef, pCatRef, eCatRef, stCatRef].some(r => r.current?.contains(t))
      if (!inTrigger) setOpenDrop(null)
      if (!calTriggerRef.current?.contains(t) && !calDropRef.current?.contains(t)) setCalOpen(false)
      if (!slackChanRef.current?.contains(t)) { setSlackChanOpen(false) }
      if (!destChanRef.current?.contains(t)) { setDestChanOpen(false) }
      const inRuleCat = ruleCatRefs.current.some(r => r?.contains(t))
      if (!inRuleCat) setOpenRuleCatIdx(null)
      const inRuleType = ruleTypeRefs.current.some(r => r?.contains(t))
      if (!inRuleType) setOpenRuleTypeIdx(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toast = useCallback((msg: string, type: ToastType = 'success') => {
    const id = ++toastId.current
    setToasts(prev => [...prev, { id, msg, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3200)
  }, [])

  // Load data
  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [e, p, c] = await Promise.all([
        dayTrackApi.getEntries(date),
        dayTrackApi.getPlanned(date),
        dayTrackApi.getCategories(),
      ])
      setEntries(e)
      setPlanned(p)
      // Always show defaults + any custom categories from DB (deduped)
      const custom = c.filter(cat => !DEFAULT_CATS.includes(cat))
      setCategories([...DEFAULT_CATS, ...custom])
    } catch {
      // silently ignore — show empty state
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    dayTrackApi.getSuggestions().then(setSuggestions).catch(() => {})
    loadSlackConfig()
  }, [])

  // Default category to first in list (only if not restored from draft)
  useEffect(() => {
    if (categories.length > 0 && !mCat) setMCat(categories[0])
    if (categories.length > 0 && !tCat) setTCat(categories[0])
    if (categories.length > 0 && !pCat) setPCat(categories[0])
  }, [categories]) // eslint-disable-line react-hooks/exhaustive-deps

  // Save draft whenever any form field changes; clear on unmount so stale drafts don't persist forever
  useEffect(() => {
    saveDraft()
  }, [mName, mCat, mStart, mEnd, mNotes, tName, tCat, tNotes, pName, pCat, pTime, pWhen, pNotes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { saveDraft() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Timer tick
  useEffect(() => {
    if (timerRunning && !timerPaused) {
      timerIntervalRef.current = setInterval(() => {
        const elapsed = Date.now() - timerStartRef.current - pausedMsRef.current
        const s = Math.floor(elapsed / 1000)
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const sec = s % 60
        setTimerDisplay(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`)
      }, 1000)
    }
    return () => { if (timerIntervalRef.current) clearInterval(timerIntervalRef.current) }
  }, [timerRunning, timerPaused])

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function addManualEntry() {
    if (!mName.trim()) { toast('Enter a task name', 'warn'); return }
    const dur = calcDuration(mStart, mEnd)
    try {
      await dayTrackApi.createEntry({
        entry_date: date,
        name: mName.trim(),
        category: mCat || categories[0] || 'General',
        start_time: mStart,
        end_time: mEnd,
        duration_mins: dur,
        notes: mNotes,
        status: (mStart && mEnd) ? 'done' : 'active',
      })
      const nextStart = mEnd ? addMinute(mEnd) : ''
      setMName(''); setMStart(nextStart); setMEnd(''); setMNotes('')
      clearDraft()
      await loadAll()
      dayTrackApi.getSuggestions().then(setSuggestions).catch(() => {})
      toast(`"${mName.trim()}" logged`)
    } catch { toast('Failed to add entry', 'warn') }
  }

  function timerStart() {
    if (!tName.trim()) { toast('Enter a task name first', 'warn'); return }
    if (timerPaused) {
      pausedMsRef.current += Date.now() - pauseStartRef.current
      setTimerPaused(false)
      setTimerStatus('running')
      return
    }
    timerStartRef.current = Date.now()
    pausedMsRef.current = 0
    setTimerRunning(true)
    setTimerPaused(false)
    setTimerStatus('running')
    toast(`Timer started for "${tName.trim()}"`, 'info')
  }

  function timerPause() {
    if (!timerRunning || timerPaused) return
    clearInterval(timerIntervalRef.current!)
    pauseStartRef.current = Date.now()
    setTimerPaused(true)
    setTimerStatus('paused')
  }

  async function timerStop() {
    clearInterval(timerIntervalRef.current!)
    const elapsed = Date.now() - timerStartRef.current - pausedMsRef.current
    const mins = Math.round(elapsed / 60000)
    const now = new Date()
    const startD = new Date(timerStartRef.current)
    const fmt = (d: Date) => to12h(`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)
    const name = tName.trim()
    try {
      await dayTrackApi.createEntry({
        entry_date: date,
        name,
        category: tCat || categories[0] || 'General',
        start_time: fmt(startD),
        end_time: fmt(now),
        duration_mins: mins,
        notes: tNotes,
        status: 'done',
      })
      await loadAll()
      toast(`"${name}" logged — ${minsLabel(mins)}`)
    } catch { toast('Failed to log entry', 'warn') }
    setTimerRunning(false); setTimerPaused(false); setTimerStatus('idle')
    setTimerDisplay('00:00:00')
    setTName(''); setTNotes('')
    clearDraft()
  }

  async function addPlanned() {
    if (!pName.trim()) { toast('Enter a task name', 'warn'); return }
    try {
      await dayTrackApi.createPlanned({
        entry_date: date,
        name: pName.trim(),
        category: pCat || categories[0] || 'General',
        scheduled_time: pTime,
        when_type: pWhen,
        notes: pNotes,
        status: 'planned',
      })
      setPName(''); setPTime(''); setPNotes('')
      clearDraft()
      await loadAll()
      toast(`"${pName.trim()}" scheduled for ${pWhen}`)
    } catch { toast('Failed to schedule task', 'warn') }
  }

  async function deleteEntry(id: string) {
    try {
      await dayTrackApi.deleteEntry(id)
      await loadAll()
      toast('Entry removed', 'info')
    } catch { toast('Failed to delete', 'warn') }
  }

  async function deletePlanned(id: string) {
    try {
      await dayTrackApi.deletePlanned(id)
      await loadAll()
    } catch { toast('Failed to delete', 'warn') }
  }

  async function carryEntry(entry: DayTrackEntry) {
    try {
      const subs = subtaskMap.get(entry.id) ?? []
      // Carry subtasks first (as separate planned items), then delete them individually
      for (const s of subs) {
        await dayTrackApi.createPlanned({
          entry_date: date,
          name: s.name,
          category: s.category,
          scheduled_time: s.start_time || '',
          start_time: s.start_time,
          end_time: s.end_time,
          when_type: 'tomorrow',
          notes: s.notes ? `[subtask of ${entry.name}] ${s.notes}` : `[subtask of ${entry.name}]`,
          status: 'carry',
        })
        await dayTrackApi.deleteEntry(s.id)
      }
      // Now carry parent (no subtasks remain to cascade-delete)
      await dayTrackApi.createPlanned({
        entry_date: date,
        name: entry.name,
        category: entry.category,
        scheduled_time: entry.start_time || '',
        start_time: entry.start_time,
        end_time: entry.end_time,
        when_type: 'tomorrow',
        notes: entry.notes,
        status: 'carry',
      })
      await dayTrackApi.deleteEntry(entry.id)
      await loadAll()
      toast(`"${entry.name}" carried to tomorrow${subs.length > 0 ? ` (+${subs.length} subtask${subs.length > 1 ? 's' : ''})` : ''}`)
    } catch { toast('Failed to carry entry', 'warn') }
  }

  async function startPlanned(item: DayTrackPlanned) {
    const now = nowHHMM()
    try {
      await dayTrackApi.createEntry({
        entry_date: date,
        name: item.name,
        category: item.category,
        start_time: now,
        end_time: '',
        duration_mins: null,
        notes: item.notes,
        status: 'active',
      })
      await dayTrackApi.deletePlanned(item.id)
      await loadAll()
      toast(`Started "${item.name}"`)
    } catch { toast('Failed to start task', 'warn') }
  }

  async function rollbackPlanned(item: DayTrackPlanned) {
    const s = item.start_time || item.scheduled_time || ''
    const e = item.end_time || ''
    const dur = calcDuration(s, e)
    try {
      await dayTrackApi.createEntry({
        entry_date: date,
        name: item.name,
        category: item.category,
        start_time: s,
        end_time: e,
        duration_mins: dur,
        notes: item.notes,
        status: (s && e) ? 'done' : 'active',
      })
      await dayTrackApi.deletePlanned(item.id)
      await loadAll()
      toast(`"${item.name}" rolled back to today's log`)
    } catch { toast('Failed to roll back task', 'warn') }
  }


  async function carryAllUnfinished() {
    const active = entries.filter(e => e.status === 'active' && !e.parent_entry_id)
    try {
      for (const e of active) {
        await carryEntry(e)
      }
      toast(`${active.length} task(s) carried to tomorrow`)
    } catch { toast('Failed to carry tasks', 'warn') }
  }

  function openEdit(entry: DayTrackEntry) {
    setEditEntry(entry)
    setEName(entry.name); setECat(entry.category)
    setEStart(entry.start_time); setEEnd(entry.end_time); setENotes(entry.notes)
  }

  async function saveEdit() {
    if (!editEntry) return
    const dur = calcDuration(eStart, eEnd)
    const newStatus = (eStart && eEnd) ? 'done' : editEntry.status
    try {
      const updated = await dayTrackApi.updateEntry(editEntry.id, {
        name: eName || editEntry.name,
        category: eCat,
        start_time: eStart, end_time: eEnd,
        duration_mins: dur, notes: eNotes,
        status: newStatus,
      })
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
      setEditEntry(null)
      toast('Entry updated')
    } catch { toast('Failed to update', 'warn') }
  }

  function openSubtask(parent: DayTrackEntry) {
    setSubtaskParent(parent)
    setStName('')
    setStCat(parent.category)
    // Default start = latest subtask end_time + 1 min, else parent start_time
    const subs = subtaskMap.get(parent.id) ?? []
    const latestEnd = subs
      .map(s => s.end_time)
      .filter(Boolean)
      .sort((a, b) => timeToMins(b) - timeToMins(a))[0]
    if (latestEnd) {
      const mins = timeToMins(latestEnd) + 1
      const h = Math.floor(mins / 60) % 24
      const m = mins % 60
      setStStart(to12h(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`))
    } else {
      setStStart(parent.start_time || '')
    }
    setStEnd('')
    setStNotes('')
  }

  async function saveSubtask() {
    if (!subtaskParent) return
    if (!stName.trim()) { toast('Enter a subtask name', 'warn'); return }
    if (stStart && subtaskParent.start_time && timeToMins(stStart) < timeToMins(subtaskParent.start_time)) {
      toast(`Start time must be ≥ parent start (${subtaskParent.start_time})`, 'warn'); return
    }
    const dur = calcDuration(stStart, stEnd)
    try {
      await dayTrackApi.createEntry({
        entry_date: date,
        name: stName.trim(),
        category: stCat || subtaskParent.category,
        start_time: stStart,
        end_time: stEnd,
        duration_mins: dur,
        notes: stNotes,
        status: (stStart && stEnd) ? 'done' : 'active',
        parent_entry_id: subtaskParent.id,
      })
      // Auto-update parent end_time if subtask end is later
      if (stEnd && (!subtaskParent.end_time || timeToMins(stEnd) > timeToMins(subtaskParent.end_time))) {
        const newDur = calcDuration(subtaskParent.start_time, stEnd)
        await dayTrackApi.updateEntry(subtaskParent.id, {
          name: subtaskParent.name,
          category: subtaskParent.category,
          start_time: subtaskParent.start_time,
          end_time: stEnd,
          duration_mins: newDur,
          notes: subtaskParent.notes,
          status: subtaskParent.status,
        })
      }
      setExpandedEntries(prev => { const s = new Set(prev); s.add(subtaskParent.id); return s })
      setSubtaskParent(null)
      await loadAll()
      toast(`Subtask "${stName.trim()}" added`)
    } catch { toast('Failed to add subtask', 'warn') }
  }

  async function addCategory() {
    const v = newCat.trim()
    if (!v) return
    if (categories.includes(v)) { toast('Category already exists', 'warn'); return }
    try {
      await dayTrackApi.addCategory(v)
      setNewCat('')
      setCategories(prev => [...prev, v])
      toast(`Category "${v}" added`)
    } catch { toast('Failed to add category', 'warn') }
  }

  async function removeCategory(name: string) {
    try {
      await dayTrackApi.deleteCategory(name)
      setCategories(prev => prev.filter(c => c !== name))
    } catch { toast('Failed to remove category', 'warn') }
  }

  async function loadSlackConfig() {
    setSlackCfgLoading(true)
    try {
      const cfg = await dayTrackApi.getSlackConfig()
      setSlackCfg(cfg.keyword_rules?.length ? cfg : { ...cfg, keyword_rules: DEFAULT_KEYWORD_RULES })
    } catch {
      setSlackCfg({ channel_id: '', channel_name: '', slack_user_id: '', keyword_rules: DEFAULT_KEYWORD_RULES, enabled: true, dest_channel_id: '', dest_channel_name: '', timezone: 'Asia/Kolkata' })
    } finally {
      setSlackCfgLoading(false)
    }
  }

  async function loadSlackChannels() {
    setChannelsLoading(true)
    try {
      const ch = await api.getSlackChannels()
      setSlackChannels(ch.map(c => ({ id: c.id, name: c.name })))
    } catch {
      setSlackChannels([])
    } finally {
      setChannelsLoading(false)
    }
  }

  async function saveSlackCfg() {
    if (!slackCfg) return
    setSlackCfgSaving(true)
    try {
      await dayTrackApi.saveSlackConfig(slackCfg)
      toast('Slack auto-log config saved')
    } catch { toast('Failed to save config', 'warn') }
    finally { setSlackCfgSaving(false) }
  }

  async function scanNow() {
    try {
      await dayTrackApi.triggerSlackScan()
      toast('Slack scan triggered — entries will appear shortly', 'info')
    } catch { toast('Scan failed — check Slack config', 'warn') }
  }

  async function resetScanWindow() {
    try {
      await dayTrackApi.resetSlackScanWindow()
      toast('Scan window reset — next scan will pick up messages from today\'s start', 'info')
    } catch { toast('Reset failed', 'warn') }
  }

  const [ytScanning, setYtScanning] = useState(false)
  async function scanYouTrackTickets() {
    setYtScanning(true)
    try {
      const res = await dayTrackApi.scanYouTrackTickets(date)
      const parts: string[] = []
      if (res.added > 0)   parts.push(`${res.added} created`)
      if (res.tested > 0)  parts.push(`${res.tested} tested`)
      if (parts.length > 0) {
        toast(`Synced ${parts.join(' · ')} from YouTrack`, 'success')
      } else {
        toast(`No new YouTrack activity found for ${date}`, 'info')
      }
    } catch { toast('YouTrack sync failed', 'warn') }
    finally { setYtScanning(false) }

    // Also reset + trigger Slack scan so fresh messages are picked up
    try {
      await dayTrackApi.resetSlackScanWindow()
      await dayTrackApi.triggerSlackScan()
    } catch { /* Slack not configured — silently skip */ }

    await loadAll()
  }

  async function resolveSlackUser() {
    try {
      const res = await dayTrackApi.resolveSlackUser()
      if (res.slack_user_id) {
        setSlackCfg(c => c ? { ...c, slack_user_id: res.slack_user_id } : c)
        toast('Slack user ID resolved')
      } else {
        toast('Could not resolve Slack user — check your email', 'warn')
      }
    } catch { toast('Failed to resolve Slack user', 'warn') }
  }

  async function postToSlack() {
    setPosting(true)
    try {
      await dayTrackApi.postToSlack(date)
      toast('Posted to Slack!', 'success')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to post'
      toast(msg, 'warn')
    } finally {
      setPosting(false)
    }
  }

  function updateKWRule(idx: number, field: keyof DayTrackKWRule, value: string | string[]) {
    setSlackCfg(c => {
      if (!c) return c
      const rules = [...c.keyword_rules]
      rules[idx] = { ...rules[idx], [field]: value }
      return { ...c, keyword_rules: rules }
    })
  }

  function removeKWRule(idx: number) {
    setSlackCfg(c => c ? { ...c, keyword_rules: c.keyword_rules.filter((_, i) => i !== idx) } : c)
  }

  function addKWRule() {
    setSlackCfg(c => c ? {
      ...c,
      keyword_rules: [...c.keyword_rules, { category: 'General', keywords: [], rule_type: 'sign_in' }]
    } : c)
  }

  async function copyStandup() {
    // Use • for Slack compatibility (- renders as literal text in Slack)
    const text = buildStandup().replace(/^- /gm, '• ')
    navigator.clipboard.writeText(text).then(() => toast('DayTrack report copied!'))
  }

  // Parse AI output into a map of entryId → rephrased name, matched positionally
  function buildAINameMap(allEntries: DayTrackEntry[], aiSummary: string): Map<number, string> {
    const nameMap = new Map<number, string>()
    // AI omits Sign In / Sign Off / Breaks / YouTrack entries — filter to keep positions in sync
    const sentEntries = allEntries
      .filter(e => !e.parent_entry_id)
      .filter(e => !['Sign In', 'Sign Off', 'Breaks'].includes(e.category))
      .filter(e => e.entry_source !== 'youtrack')
    const rephrasedLines = aiSummary
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- ') || l.startsWith('• '))
      .map(l => l.replace(/^[-•]\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1').trim())
    sentEntries.forEach((e, i) => {
      if (i < rephrasedLines.length && rephrasedLines[i]) nameMap.set(e.id, rephrasedLines[i])
    })
    return nameMap
  }

  // Build the full structured report (same layout as buildStandup) with • bullets.
  // nameMap optionally substitutes AI-rephrased text for each entry's name.
  function buildReportText(sourceEntries: DayTrackEntry[], nameMap: Map<number, string>): string {
    const today = fmtDate(new Date(date))
    const parents = sourceEntries.filter(e => !e.parent_entry_id)

    const catHeading = (cat: string): string => {
      const map: Record<string, string> = {
        'Tickets': 'Tickets Created', 'Testing': 'Testing',
        'Project Management': 'Project Management', 'Meetings': 'Meetings',
        'Breaks': 'Breaks', 'Sign In': 'Sign In', 'Sign Off': 'Sign Off',
      }
      return map[cat] ?? cat
    }
    const isDoneInReport = (e: DayTrackEntry) =>
      e.status === 'done' || (e.status === 'active' && !e.start_time && !e.end_time)
    const getName = (e: DayTrackEntry) => nameMap.get(e.id) ?? e.name

    const testedEntries = parents.filter(e => e.external_ref?.startsWith('yt-tested-'))
    const testedIDs = new Set(testedEntries.map(e => e.id))

    const doneByCategory = new Map<string, DayTrackEntry[]>()
    parents.filter(e => isDoneInReport(e) && !testedIDs.has(e.id)).forEach(e => {
      const list = doneByCategory.get(e.category) ?? []
      list.push(e)
      doneByCategory.set(e.category, list)
    })

    let doneBlock = ''
    doneByCategory.forEach((items, cat) => {
      doneBlock += `*${catHeading(cat)}:*\n`
      items.forEach(e => {
        doneBlock += `• ${getName(e)}${e.duration_mins != null ? ` (${minsLabel(e.duration_mins)})` : ''}\n`
      })
      doneBlock += '\n'
    })

    const activeList = parents
      .filter(e => e.status === 'active' && (e.start_time || e.end_time))
      .map(e => `• ${getName(e)} (${e.category})`).join('\n')
    const planList = planned.filter(p => p.when_type === 'today')
      .map(p => `• ${p.name} (${p.category})`).join('\n')
    const testedBlock = testedEntries.length > 0
      ? testedEntries.map(e => `• ${getName(e)}`).join('\n') + '\n'
      : '• (none)\n'

    let text = `📋 DayTrack Report – ${today}\n`
    text += `⏱ Total: ${totalMins ? minsLabel(totalMins) : '—'} | Focus Rate: ${focusRate != null ? focusRate + '%' : '—'}\n\n`
    text += `✅ *Done Today:*\n\n${doneBlock || '• (none)\n\n'}`
    text += `🧪 *Tickets Tested:*\n${testedBlock}\n`
    if (activeList) text += `🔄 In Progress:\n${activeList}\n\n`
    text += `📌 Planned / Upcoming:\n${planList || '• (none)'}\n\n`
    text += `🚧 Blockers:\n• None`
    return text
  }

  // Shared helper — fetches entries for the selected range, runs AI once and caches it
  async function prepareExportData() {
    let start: string, end: string, rangeLabel: string
    if (exportMode === 'today') {
      start = date; end = date
      rangeLabel = fmtDate(new Date(date + 'T00:00:00'))
    } else if (exportMode === 'month') {
      start = `${exportMonth}-01`
      const [y, m] = exportMonth.split('-').map(Number)
      const last = new Date(y, m, 0).getDate()
      end = `${exportMonth}-${String(last).padStart(2, '0')}`
      rangeLabel = new Date(start + 'T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' })
    } else {
      start = exportStart; end = exportEnd
      rangeLabel = `${start} to ${end}`
    }

    let allEntries: DayTrackEntry[]
    if (exportMode === 'today') {
      allEntries = [...entries]
    } else {
      const token = localStorage.getItem('token')
      const res = await fetch(`${import.meta.env.VITE_API_URL}/daytrack/entries/range?start=${start}&end=${end}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch range')
      allEntries = await res.json()
    }
    if (!exportBreaks) allEntries = allEntries.filter(e => e.category !== 'Breaks')

    // Generate AI summary once and cache — reuse on subsequent button clicks
    let aiSummary = exportAISummary
    if (exportSummarise && !aiSummary) {
      setExportAILoading(true)
      const lines = allEntries
        .filter(e => !e.parent_entry_id)
        .filter(e => e.entry_source !== 'youtrack')
        .map(e => ({
          category: e.category,
          name: e.name,
          duration: e.duration_mins != null ? minsLabel(e.duration_mins) : '',
          notes: e.notes || ''
        }))
      if (lines.length > 0) {
        try {
          const res2 = await dayTrackApi.summarize({ date_label: rangeLabel, lines })
          if (res2.summary) { aiSummary = res2.summary; setExportAISummary(aiSummary) }
        } catch { /* proceed without AI */ }
      }
      setExportAILoading(false)
    }

    return { allEntries, rangeLabel, start, end, aiSummary }
  }

  async function runExport(format: 'pdf' | 'doc') {
    setExportLoading(true)
    try {
      const { allEntries, rangeLabel, start, end, aiSummary } = await prepareExportData()

      const byDate = new Map<string, DayTrackEntry[]>()
      allEntries.forEach(e => {
        if (!byDate.has(e.entry_date)) byDate.set(e.entry_date, [])
        byDate.get(e.entry_date)!.push(e)
      })
      const fmtDateStr = (d: string) => fmtDate(new Date(d + 'T00:00:00'))
      const renderExportRows = (dayEntries: DayTrackEntry[]) => {
        const dayParents = dayEntries.filter(e => !e.parent_entry_id)
        const daySubs = new Map<string, DayTrackEntry[]>()
        dayEntries.filter(e => e.parent_entry_id).forEach(e => {
          const l = daySubs.get(e.parent_entry_id!) ?? []; l.push(e); daySubs.set(e.parent_entry_id!, l)
        })
        return dayParents.flatMap(e => {
          const subs = daySubs.get(e.id) ?? []
          const rows = [`<tr>
    <td><strong>${e.name}</strong></td><td>${e.category}</td>
    <td>${e.start_time || '—'}</td><td>${e.end_time || '—'}</td>
    <td>${e.duration_mins != null ? minsLabel(e.duration_mins) : '—'}</td>
    <td><span class="${e.status === 'done' ? 'badge-done' : 'badge-active'}">${e.status}</span></td>
    <td>${e.notes || ''}</td>
  </tr>`]
          subs.forEach(s => rows.push(`<tr style="background:#f8fafc">
    <td style="padding-left:28px;border-left:3px solid #e2e8f0;color:#64748b">↳ ${s.name}</td>
    <td style="color:#64748b">${s.category}</td>
    <td style="color:#64748b">${s.start_time || '—'}</td><td style="color:#64748b">${s.end_time || '—'}</td>
    <td style="color:#64748b">${s.duration_mins != null ? minsLabel(s.duration_mins) : '—'}</td>
    <td><span class="${s.status === 'done' ? 'badge-done' : 'badge-active'}">${s.status}</span></td>
    <td style="color:#64748b">${s.notes || ''}</td>
  </tr>`))
          return rows
        }).join('')
      }

      const parentAllEntries = allEntries.filter(e => !e.parent_entry_id)
      const totalAll = parentAllEntries.reduce((a, e) => a + (e.duration_mins ?? 0), 0)
      const doneAll = parentAllEntries.filter(e => e.status === 'done').length
      const focusAll = parentAllEntries.filter(e => !['Meetings','Breaks'].includes(e.category)).reduce((a, e) => a + (e.duration_mins ?? 0), 0)
      const catTotals: Record<string, number> = {}
      parentAllEntries.forEach(e => { if (e.duration_mins) catTotals[e.category] = (catTotals[e.category] || 0) + e.duration_mins })

      const aiSummaryBlock = aiSummary
        ? `<div class="summary-box" style="margin-top:20px">
  <h3 style="color:#7c3aed">✨ AI Summary</h3>
  <div style="white-space:pre-wrap;font-size:13px;line-height:1.6">${aiSummary.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')}</div>
</div>` : ''

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>DayTrack Export — ${rangeLabel}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 40px; font-size: 13px; }
  h1 { font-size: 22px; color: #4f46e5; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 13px; margin-bottom: 28px; }
  h2 { font-size: 15px; color: #1e293b; margin: 24px 0 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { background: #f1f5f9; text-align: left; padding: 6px 10px; font-size: 11px; text-transform: uppercase; color: #64748b; border: 1px solid #e2e8f0; }
  td { padding: 6px 10px; border: 1px solid #e2e8f0; vertical-align: top; }
  tr:nth-child(even) td { background: #f8fafc; }
  .day-total { font-size: 12px; color: #64748b; margin-bottom: 16px; }
  .summary-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; margin-top: 28px; }
  .summary-box h3 { margin: 0 0 12px; font-size: 14px; color: #4f46e5; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .stat { text-align: center; }
  .stat-val { font-size: 20px; font-weight: 700; color: #1e293b; }
  .stat-lbl { font-size: 11px; color: #64748b; margin-top: 2px; }
  .cat-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
  .badge-done { background: #d1fae5; color: #065f46; padding: 1px 7px; border-radius: 10px; font-size: 11px; }
  .badge-active { background: #dbeafe; color: #1e40af; padding: 1px 7px; border-radius: 10px; font-size: 11px; }
  @media print { body { margin: 20px; } }
</style></head><body>
<h1>📋 DayTrack Export</h1>
<div class="subtitle">Period: ${rangeLabel} &nbsp;·&nbsp; Generated: ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</div>
${Array.from(byDate.entries()).map(([d, dayEntries]) => {
  const dayParents = dayEntries.filter(e => !e.parent_entry_id)
  const dayTotal = dayParents.reduce((a, e) => a + (e.duration_mins ?? 0), 0)
  return `<h2>${fmtDateStr(d)}</h2>
<table>
  <thead><tr><th>Task</th><th>Category</th><th>Start</th><th>End</th><th>Duration</th><th>Status</th><th>Notes</th></tr></thead>
  <tbody>${renderExportRows(dayEntries)}</tbody>
</table>
<div class="day-total">Daily total: <b>${minsLabel(dayTotal)}</b> &nbsp;·&nbsp; ${dayParents.length} task(s) &nbsp;·&nbsp; ${dayParents.filter(e => e.status === 'done').length} done</div>`
}).join('')}
<div class="summary-box">
  <h3>Overall Summary</h3>
  <div class="summary-grid">
    <div class="stat"><div class="stat-val">${minsLabel(totalAll)}</div><div class="stat-lbl">Total Logged</div></div>
    <div class="stat"><div class="stat-val">${allEntries.length}</div><div class="stat-lbl">Total Tasks</div></div>
    <div class="stat"><div class="stat-val">${doneAll}</div><div class="stat-lbl">Completed</div></div>
    <div class="stat"><div class="stat-val">${totalAll > 0 ? Math.round(focusAll / totalAll * 100) : 0}%</div><div class="stat-lbl">Focus Rate</div></div>
  </div>
  <div style="margin-top:16px"><b style="font-size:12px;color:#64748b">TIME BY CATEGORY</b>
    <div style="margin-top:6px">${Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([cat,mins]) =>
      `<div class="cat-row"><span>${cat}</span><span><b>${minsLabel(mins)}</b></span></div>`
    ).join('')}</div>
  </div>
</div>
${aiSummaryBlock}
</body></html>`

      if (format === 'pdf') {
        const w = window.open('', '_blank')
        if (!w) { toast('Allow popups to export PDF', 'warn'); return }
        w.document.write(html)
        w.document.close()
        w.focus()
      } else {
        const blob = new Blob([html], { type: 'application/msword' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `daytrack-${exportMode === 'month' ? exportMonth : `${start}-to-${end}`}.doc`
        a.click()
      }
      setExportOpen(false)
      setExportAISummary(null)
      toast('Export ready', 'success')
    } catch { toast('Export failed', 'warn') }
    finally { setExportLoading(false) }
  }

  async function copyExportSummary() {
    setExportCopyLoading(true)
    try {
      const { allEntries, aiSummary } = await prepareExportData()
      const nameMap = aiSummary ? buildAINameMap(allEntries, aiSummary) : new Map<number, string>()
      const text = buildReportText(allEntries, nameMap)
      await navigator.clipboard.writeText(text)
      toast('Summary copied!', 'success')
    } catch { toast('Copy failed', 'warn') }
    finally { setExportCopyLoading(false) }
  }

  function exportCSV() {
    const rows = [['Task','Category','Start','End','Duration (min)','Status','Notes','Date']]
    entries.forEach(e => rows.push([
      e.name, e.category, e.start_time, e.end_time,
      String(e.duration_mins ?? ''), e.status, e.notes, e.entry_date
    ]))
    const csv = rows.map(r => r.map(v => `"${(v||'').replace(/"/g,'""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `daytrack-${date}.csv`; a.click()
  }

  // ── Computed stats ────────────────────────────────────────────────────────────

  const totalMins = entries.reduce((a, e) => a + (e.duration_mins ?? 0), 0)
  const completedCount = entries.filter(e => e.status === 'done').length
  const pendingCount = planned.filter(p => p.when_type === 'today').length
  const focusMins = entries
    .filter(e => !['Meetings','Breaks'].includes(e.category))
    .reduce((a, e) => a + (e.duration_mins ?? 0), 0)
  const focusRate = totalMins > 0 ? Math.round(focusMins / totalMins * 100) : null

  const catMap: Record<string, number> = {}
  entries.forEach(e => { if (e.duration_mins) catMap[e.category] = (catMap[e.category] || 0) + e.duration_mins })
  const maxCatMins = Math.max(...Object.values(catMap), 1)

  // Latest end time across all entries (for auto-filling next start time)
  const latestEndTime = entries.reduce<string>((best, e) => {
    if (!e.end_time) return best
    if (!best) return e.end_time
    return timeToMins(e.end_time) > timeToMins(best) ? e.end_time : best
  }, '')

  // Subtask grouping
  const parentEntries = entries.filter(e => !e.parent_entry_id)
  const subtaskMap = new Map<string, DayTrackEntry[]>()
  entries.filter(e => e.parent_entry_id).forEach(e => {
    const list = subtaskMap.get(e.parent_entry_id!) ?? []
    list.push(e)
    subtaskMap.set(e.parent_entry_id!, list)
  })

  function buildStandup(): string {
    const today = fmtDate(new Date(date))
    const parents = entries.filter(e => !e.parent_entry_id)

    const catHeading = (cat: string): string => {
      const map: Record<string, string> = {
        'Tickets':            'Tickets Created',
        'Testing':            'Testing',
        'Project Management': 'Project Management',
        'Meetings':           'Meetings',
        'Breaks':             'Breaks',
        'Sign In':            'Sign In',
        'Sign Off':           'Sign Off',
      }
      return map[cat] ?? cat
    }

    const isDoneInReport = (e: DayTrackEntry) =>
      e.status === 'done' || (e.status === 'active' && !e.start_time && !e.end_time)

    // Separate tickets-tested entries (yt-tested-*) from the rest
    const testedEntries = parents.filter(e => e.external_ref?.startsWith('yt-tested-'))
    const testedIDs = new Set(testedEntries.map(e => e.id))

    // Group done entries by category, preserving insertion order (exclude tested entries — shown separately)
    const doneByCategory = new Map<string, DayTrackEntry[]>()
    parents.filter(e => isDoneInReport(e) && !testedIDs.has(e.id)).forEach(e => {
      const list = doneByCategory.get(e.category) ?? []
      list.push(e)
      doneByCategory.set(e.category, list)
    })

    let doneBlock = ''
    doneByCategory.forEach((items, cat) => {
      doneBlock += `*${catHeading(cat)}:*\n`
      items.forEach(e => {
        doneBlock += `- ${e.name}${e.duration_mins != null ? ` (${minsLabel(e.duration_mins)})` : ''}\n`
      })
      doneBlock += '\n'
    })

    const activeList = parents
      .filter(e => e.status === 'active' && (e.start_time || e.end_time))
      .map(e => `- ${e.name} (${e.category})`)
      .join('\n')
    const planList = planned.filter(p => p.when_type === 'today')
      .map(p => `- ${p.name} (${p.category})`)
      .join('\n')

    const testedBlock = testedEntries.length > 0
      ? testedEntries.map(e => `- ${e.name}`).join('\n') + '\n'
      : '- (none)\n'

    let text = `📋 DayTrack Report – ${today}\n`
    text += `⏱ Total: ${totalMins ? minsLabel(totalMins) : '—'} | Focus Rate: ${focusRate != null ? focusRate + '%' : '—'}\n\n`
    text += `✅ *Done Today:*\n\n${doneBlock || '- (none)\n\n'}`
    text += `🧪 *Tickets Tested:*\n${testedBlock}\n`
    if (activeList) text += `🔄 In Progress:\n${activeList}\n\n`
    text += `📌 Planned / Upcoming:\n${planList || '- (none)'}\n\n`
    text += `🚧 Blockers:\n- None`
    return text
  }

  // ── Category pill renderer ────────────────────────────────────────────────────

  function CatPill({ cat }: { cat: string }) {
    const c = catColor(cat, categories)
    return <span className="dt-cat-pill" style={{ background: c + '20', color: c }}>{cat}</span>
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const dateObj = new Date(date + 'T00:00:00')

  return (
    <div className="dt-page">

      {/* Header */}
      <div className="dt-header">
        <div className="dt-header-left">
          <div className="dt-header-icon">
            <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/></svg>
          </div>
          <div>
            <div className="dt-header-title">DayTrack</div>
            <div className="dt-header-sub">Daily Time Recording Sheet</div>
          </div>
        </div>

        <div className="dt-header-stats">
          <div className="dt-stat-pill">
            <span className="dt-stat-dot dt-stat-dot--green"/>Total: <b>{minsLabel(totalMins)}</b>
          </div>
          <div className="dt-stat-pill">
            <span className="dt-stat-dot dt-stat-dot--blue"/>Tasks: <b>{entries.length}</b>
          </div>
          <div className="dt-stat-pill">
            <span className="dt-stat-dot dt-stat-dot--amber"/>Pending: <b>{pendingCount}</b>
          </div>
        </div>

        <div className="dt-header-right">
          {/* Date navigation + calendar picker */}
          <div className="dt-date-nav">
            <div className="dr-cal-wrap">
              <button className="dr-cal-trigger" ref={calTriggerRef} onClick={() => {
                if (calTriggerRef.current) {
                  const r = calTriggerRef.current.getBoundingClientRect()
                  setCalPos({ top: r.bottom + 6, left: r.left })
                }
                setCalOpen(o => !o)
                setCalDate(new Date(date + 'T00:00:00'))
              }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
                </svg>
                <span>{fmtDate(dateObj)}</span>
              </button>
              {calOpen && calPos && createPortal((() => {
                const y = calDate.getFullYear(), m = calDate.getMonth()
                const firstDay = new Date(y, m, 1).getDay()
                const daysInMonth = new Date(y, m + 1, 0).getDate()
                const todayStr = toDateStr(new Date())
                const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
                return (
                  <div ref={calDropRef} className="dr-cal-dropdown glass-card"
                    style={{ position: 'fixed', top: calPos.top, left: calPos.left, zIndex: 9999, minWidth: 240, padding: 12 }}>
                    <div className="calendar-nav">
                      <button onClick={() => setCalDate(new Date(y, m - 1, 1))}>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
                      </button>
                      <span className="calendar-month-label">{monthNames[m]} {y}</span>
                      <button onClick={() => setCalDate(new Date(y, m + 1, 1))}>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
                      </button>
                    </div>
                    <div className="calendar-grid">
                      <div className="calendar-header-row">
                        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => <span key={d}>{d}</span>)}
                      </div>
                      <div className="calendar-body">
                        {Array.from({ length: firstDay }).map((_, i) => <span key={`e${i}`}/>)}
                        {Array.from({ length: daysInMonth }).map((_, i) => {
                          const dayStr = `${y}-${String(m+1).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`
                          return (
                            <button key={i}
                              className={`calendar-day${dayStr === date ? ' selected' : ''}${dayStr === todayStr ? ' today' : ''}`}
                              onClick={() => { setDate(dayStr); setCalOpen(false) }}>
                              {i + 1}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    <div style={{ textAlign: 'center', marginTop: 6 }}>
                      <button className="dt-btn dt-btn-ghost dt-btn-sm" style={{ fontSize: 11 }}
                        onClick={() => { setDate(todayStr); setCalOpen(false) }}>Today</button>
                    </div>
                  </div>
                )
              })(), document.body)}
            </div>
          </div>

          <div className="dt-clock"><ClockDisplay /></div>
          <button className="dt-header-settings-btn" title="Sync YouTrack tickets created today"
            onClick={scanYouTrackTickets} disabled={ytScanning}
            style={{ marginRight: 4 }}>
            {ytScanning
              ? <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
              : <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            }
          </button>
          <button
            className="dt-post-slack-btn"
            style={{ marginRight: 6, padding: '5px 11px', fontSize: 12 }}
            onClick={() => {
              if (!slackCfg?.dest_channel_id) {
                setSettingsOpen(true)
                if (!slackCfg) loadSlackConfig()
                if (slackChannels.length === 0) loadSlackChannels()
                toast('Set a Destination Channel in settings first', 'info')
                return
              }
              postToSlack()
            }}
            disabled={posting}
            title={slackCfg?.dest_channel_id ? `Post today's updates to #${slackCfg.dest_channel_name || slackCfg.dest_channel_id}` : 'Configure destination channel in settings'}
          >
            {posting ? (
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            )}
            {posting ? 'Posting…' : slackCfg?.dest_channel_id ? `Post to #${slackCfg.dest_channel_name || slackCfg.dest_channel_id}` : 'Post to Slack'}
          </button>
          <button className="dt-header-settings-btn" title="Slack auto-log settings"
            onClick={() => {
              setSettingsOpen(true)
              if (!slackCfg) loadSlackConfig()
              if (slackChannels.length === 0) loadSlackChannels()
            }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Main Grid */}
      <div className="dt-grid">

        {/* LEFT COLUMN */}
        <div>

          {/* Add Entry Card */}
          <div className="dt-card">
            <div className="dt-card-title">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
              Add Task / Entry
            </div>

            {/* Tab switcher */}
            <div className="dt-tabs">
              {(['manual','timer','plan'] as const).map((t, i) => (
                <button key={t} className={`dt-tab ${activeTab === t ? 'active' : ''}`}
                  onClick={() => setActiveTab(t)}>
                  {['Manual Entry','Live Timer','Plan Ahead'][i]}
                </button>
              ))}
            </div>

            {/* Manual */}
            <div className={`dt-tab-panel ${activeTab === 'manual' ? 'active' : ''}`}>
              <div className="form-group">
                <label className="form-label">Task Name *</label>
                <div className="dt-input-with-mic">
                  <TaskNameInput value={mName} onChange={setMName} suggestions={suggestions}
                    placeholder="What did you work on?" onEnter={addManualEntry} />
                  <MicButton
                    onResult={text => { setMName(text); const c = detectCategory(text, categories); if (c) setMCat(c) }}
                    onError={msg => toast(msg, 'warn')}
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Category</label>
                <CategoryChips value={mCat} onChange={setMCat} categories={categories} />
              </div>
              <div className="dt-row2">
                <div className="form-group">
                  <label className="form-label">Start Time</label>
                  <div className="dt-time-wrap">
                    <input className="form-input" type="time" value={to24h(mStart)} onChange={e => setMStart(to12h(e.target.value))} />
                    <button className="dt-now-btn" onClick={() => setMStart(nowHHMM())}>Now</button>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">End Time</label>
                  <div className="dt-time-wrap">
                    <input className="form-input" type="time" value={to24h(mEnd)} onChange={e => setMEnd(to12h(e.target.value))} />
                    <button className="dt-now-btn" onClick={() => setMEnd(nowHHMM())}>Now</button>
                  </div>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes (optional)</label>
                <div className="dt-input-with-mic dt-input-with-mic--textarea">
                  <textarea className="form-input" value={mNotes} onChange={e => setMNotes(e.target.value)}
                    placeholder="Any context or blockers…" rows={2} />
                  <MicButton
                    onResult={text => setMNotes(prev => prev ? prev + ' ' + text : text)}
                    onError={msg => toast(msg, 'warn')}
                  />
                </div>
              </div>
              <button className="dt-btn dt-btn-primary dt-btn-full" onClick={addManualEntry}>
                <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                Add to Timesheet
              </button>
            </div>

            {/* Timer */}
            <div className={`dt-tab-panel ${activeTab === 'timer' ? 'active' : ''}`}>
              <div className="dt-timer-widget">
                <div className="dt-timer-status">
                  {timerStatus === 'running' && <><span className="dt-timer-pulse"/><span style={{ color: 'var(--color-success)', fontWeight: 600 }}>Running</span></>}
                  {timerStatus === 'paused'  && <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>Paused</span>}
                  {timerStatus === 'idle'    && <span style={{ color: 'var(--text-muted)' }}>No active timer</span>}
                </div>
                <div className="dt-timer-display">{timerDisplay}</div>
                <div className="dt-timer-name">{timerStatus !== 'idle' ? tName : ''}</div>
                <div className="dt-timer-controls">
                  <button className="dt-btn dt-btn-success dt-btn-sm"
                    onClick={timerStart}
                    disabled={timerRunning && !timerPaused}>
                    <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    {timerPaused ? 'Resume' : 'Start'}
                  </button>
                  <button className="dt-btn dt-btn-ghost dt-btn-sm"
                    onClick={timerPause}
                    disabled={!timerRunning || timerPaused}>
                    <svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    Pause
                  </button>
                  <button className="dt-btn dt-btn-danger dt-btn-sm"
                    onClick={timerStop}
                    disabled={!timerRunning}>
                    <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
                    Stop
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Task Name *</label>
                <div className="dt-input-with-mic">
                  <TaskNameInput value={tName} onChange={setTName} suggestions={suggestions}
                    placeholder="What are you working on?" />
                  <MicButton
                    onResult={text => { setTName(text); const c = detectCategory(text, categories); if (c && timerStatus !== 'running') setTCat(c) }}
                    onError={msg => toast(msg, 'warn')}
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Category</label>
                <CategoryChips value={tCat} onChange={timerStatus === 'running' ? () => {} : setTCat} categories={categories} />
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <div className="dt-input-with-mic dt-input-with-mic--textarea">
                  <textarea className="form-input" value={tNotes} onChange={e => setTNotes(e.target.value)}
                    placeholder="Any notes…" rows={2} />
                  <MicButton
                    onResult={text => setTNotes(prev => prev ? prev + ' ' + text : text)}
                    onError={msg => toast(msg, 'warn')}
                  />
                </div>
              </div>
            </div>

            {/* Plan Ahead */}
            <div className={`dt-tab-panel ${activeTab === 'plan' ? 'active' : ''}`}>
              <div className="form-group">
                <label className="form-label">Task Name *</label>
                <div className="dt-input-with-mic">
                  <TaskNameInput value={pName} onChange={setPName} suggestions={suggestions}
                    placeholder="Plan a task for today or tomorrow…" onEnter={addPlanned} />
                  <MicButton
                    onResult={text => { setPName(text); const c = detectCategory(text, categories); if (c) setPCat(c) }}
                    onError={msg => toast(msg, 'warn')}
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Category</label>
                <CategoryChips value={pCat} onChange={setPCat} categories={categories} />
              </div>
              <div className="form-group">
                <label className="form-label">Scheduled Time (optional)</label>
                <div className="dt-time-wrap">
                  <input className="form-input" type="time" value={to24h(pTime)} onChange={e => setPTime(to12h(e.target.value))} />
                  <button className="dt-now-btn" onClick={() => setPTime(nowHHMM())}>Now</button>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Schedule For</label>
                <select className="form-input" value={pWhen} onChange={e => setPWhen(e.target.value as 'today'|'tomorrow')}>
                  <option value="today">Today</option>
                  <option value="tomorrow">Tomorrow (Carry Over)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <div className="dt-input-with-mic dt-input-with-mic--textarea">
                  <textarea className="form-input" value={pNotes} onChange={e => setPNotes(e.target.value)}
                    placeholder="Description or priority…" rows={2} />
                  <MicButton
                    onResult={text => setPNotes(prev => prev ? prev + ' ' + text : text)}
                    onError={msg => toast(msg, 'warn')}
                  />
                </div>
              </div>
              <button className="dt-btn dt-btn-warning dt-btn-full" onClick={addPlanned}>
                <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                Schedule Task
              </button>
            </div>

          </div>

          {/* Categories — collapsible */}
          <div className="dt-card dt-cat-mgr-card">
            <button className="dt-cat-mgr-toggle" onClick={() => setCatMgrOpen(o => !o)}>
              <div className="dt-card-title" style={{ margin: 0 }}>
                <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h7"/></svg>
                Manage Categories
                <span className="dt-sub-count">{categories.length}</span>
              </div>
              <svg className={`dt-cat-mgr-chevron${catMgrOpen ? ' open' : ''}`} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </button>
            {catMgrOpen && (
              <div className="dt-cat-mgr-body">
                <div className="dt-cats-wrap">
                  {categories.map(c => {
                    const col = catColor(c, categories)
                    const isDefault = DEFAULT_CATS.includes(c)
                    return (
                      <span key={c} className="dt-cat-tag" style={{ background: col + '20', color: col }}>
                        {c}
                        {!isDefault && (
                          <button className="dt-cat-tag-remove" onClick={() => removeCategory(c)} title="Remove">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                          </button>
                        )}
                      </span>
                    )
                  })}
                </div>
                <div className="dt-add-cat-row">
                  <input className="form-input" value={newCat} onChange={e => setNewCat(e.target.value)}
                    placeholder="Add custom category…" autoComplete="off"
                    onKeyDown={e => e.key === 'Enter' && addCategory()} />
                  <button className="dt-btn dt-btn-primary dt-btn-sm" onClick={addCategory}>
                    <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* RIGHT COLUMN */}
        <div>

          {/* Today's Log */}
          <div className="dt-card">
            <div className="dt-section-header">
              <h3 className="dt-section-title">
                <svg style={{ stroke: 'var(--color-success)' }} viewBox="0 0 24 24">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                Today's Log
                <span className="dt-count-badge">{entries.length}</span>
              </h3>
            </div>

            {loading ? (
              <div className="dt-empty">Loading…</div>
            ) : (
              <div className="dt-table-wrap">
                <table className="dt-table">
                  <thead>
                    <tr>
                      <th>Task</th><th>Category</th><th>Start</th><th>End</th>
                      <th>Duration</th><th>Status</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parentEntries.length === 0 ? (
                      <tr><td colSpan={7}>
                        <div className="dt-empty">
                          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/>
                            <path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>
                          </svg>
                          No tasks recorded yet. Add your first entry!
                        </div>
                      </td></tr>
                    ) : parentEntries.map(e => {
                      const subs = subtaskMap.get(e.id) ?? []
                      const isExpanded = expandedEntries.has(e.id)
                      const subDurTotal = subs.reduce((a, s) => a + (s.duration_mins ?? 0), 0)
                      const displayDur = subs.length > 0 && subDurTotal > 0 ? subDurTotal : e.duration_mins
                      return (
                        <>
                          <tr key={e.id}>
                            <td className="dt-td-name">
                              <div className="dt-td-name-row">
                                <button
                                  className="dt-expand-btn"
                                  style={{ visibility: subs.length > 0 ? 'visible' : 'hidden' }}
                                  onClick={() => setExpandedEntries(prev => {
                                    const s = new Set(prev)
                                    if (s.has(e.id)) s.delete(e.id); else s.add(e.id)
                                    return s
                                  })}
                                  title={isExpanded ? 'Collapse subtasks' : 'Expand subtasks'}>
                                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                    {isExpanded
                                      ? <path d="M6 9l6 6 6-6"/>
                                      : <path d="M9 18l6-6-6-6"/>}
                                  </svg>
                                </button>
                                <span>
                                  {e.name}
                                  {!isExpanded && subs.length > 0 && <span className="dt-sub-count">{subs.length} sub</span>}
                                  {e.entry_source === 'slack' && <span className="dt-source-badge dt-source-badge--slack">Slack</span>}
                                  {e.entry_source === 'youtrack_qa' && <span className="dt-source-badge dt-source-badge--yt">YT QA</span>}
                                  {e.entry_source === 'youtrack_created' && <span className="dt-source-badge dt-source-badge--yt">YT</span>}
                                  {e.notes && <span className="dt-td-note">{e.notes}</span>}
                                </span>
                              </div>
                            </td>
                            <td><CatPill cat={e.category} /></td>
                            <td className="dt-td-time">{e.start_time || '—'}</td>
                            <td className="dt-td-time">{e.end_time || '—'}</td>
                            <td>{displayDur != null
                              ? <span className="dt-td-dur">{minsLabel(displayDur)}</span>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </td>
                            <td>
                              <span className={`dt-status dt-status--${e.status}`}>{e.status}</span>
                            </td>
                            <td>
                              <div className="dt-td-actions">
                                <button className="dt-icon-btn dt-icon-btn-edit" onClick={() => openEdit(e)} title="Edit">
                                  <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>
                                  </svg>
                                </button>
                                <button className="dt-sub-add-btn" onClick={() => openSubtask(e)} title="Add subtask">
                                  + Sub
                                </button>
                                <button className="dt-icon-btn dt-icon-btn-carry" onClick={() => carryEntry(e)} title="Carry to tomorrow">
                                  <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                                </button>
                                <button className="dt-icon-btn dt-icon-btn-del" onClick={() => deleteEntry(e.id)} title="Delete">
                                  <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                                </button>
                              </div>
                            </td>
                          </tr>
                          {isExpanded && subs.map(s => (
                            <tr key={s.id} className="dt-subtask-row">
                              <td className="dt-td-name">
                                <div className="dt-subtask-indent">
                                  ↳ {s.name}
                                  {s.notes && <span className="dt-td-note">{s.notes}</span>}
                                </div>
                              </td>
                              <td><CatPill cat={s.category} /></td>
                              <td className="dt-td-time">{s.start_time || '—'}</td>
                              <td className="dt-td-time">{s.end_time || '—'}</td>
                              <td>{s.duration_mins != null
                                ? <span className="dt-td-dur">{minsLabel(s.duration_mins)}</span>
                                : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                              </td>
                              <td>
                                <span className={`dt-status dt-status--${s.status}`}>{s.status}</span>
                              </td>
                              <td>
                                <div className="dt-td-actions">
                                  <button className="dt-icon-btn dt-icon-btn-edit" onClick={() => openEdit(s)} title="Edit">
                                    <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>
                                    </svg>
                                  </button>
                                  <button className="dt-icon-btn dt-icon-btn-del" onClick={() => deleteEntry(s.id)} title="Delete">
                                    <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Planned / Carry Over */}
          <div className="dt-card">
            <div className="dt-section-header">
              <h3 className="dt-section-title">
                <svg style={{ stroke: 'var(--color-warning)' }} viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                Planned & Carry Over
                <span className="dt-count-badge">{planned.length}</span>
              </h3>
              <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={carryAllUnfinished}>
                <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                Carry All Unfinished
              </button>
            </div>
            <div className="dt-table-wrap">
              <table className="dt-table">
                <thead>
                  <tr>
                    <th>Task</th><th>Category</th><th>Scheduled</th><th>For</th><th>Status</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {planned.length === 0 ? (
                    <tr><td colSpan={6}>
                      <div className="dt-empty">
                        <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/>
                          <path d="M16 2v4M8 2v4M3 10h18"/>
                        </svg>
                        No planned tasks. Use "Plan Ahead" to schedule tasks.
                      </div>
                    </td></tr>
                  ) : planned.map(p => {
                    const whenColor = p.when_type === 'tomorrow' ? 'var(--color-warning)' : 'var(--color-primary-light)'
                    const whenLabel = p.when_type === 'tomorrow' ? 'Tomorrow' : 'Today'
                    return (
                      <tr key={p.id}>
                        <td className="dt-td-name">
                          {p.name}
                          {p.notes && <span className="dt-td-note">{p.notes}</span>}
                        </td>
                        <td><CatPill cat={p.category} /></td>
                        <td className="dt-td-time">{p.scheduled_time || '—'}</td>
                        <td>
                          <span className="dt-status" style={{ background: whenColor + '20', color: whenColor }}>
                            {whenLabel}
                          </span>
                        </td>
                        <td><span className="dt-status dt-status--planned">{p.status}</span></td>
                        <td>
                          <div className="dt-td-actions">
                            <button className="dt-icon-btn dt-icon-btn-start" onClick={() => startPlanned(p)} title="Start this task now">
                              <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            </button>
                            <button className="dt-icon-btn dt-icon-btn-rollback" onClick={() => rollbackPlanned(p)} title="Roll back to today's log">
                              <svg viewBox="0 0 24 24"><path d="M19 12H5M5 12l7-7M5 12l7 7"/></svg>
                            </button>
                            <button className="dt-icon-btn dt-icon-btn-del" onClick={() => deletePlanned(p.id)} title="Remove">
                              <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* End-of-Day Summary */}
          <div className="dt-card">
            <div className="dt-card-title">
              <svg viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
              End-of-Day Summary
            </div>

            <div className="dt-summary-grid">
              <div className="dt-summary-stat">
                <div className="dt-summary-val">{minsLabel(totalMins)}</div>
                <div className="dt-summary-lbl">Total Logged</div>
              </div>
              <div className="dt-summary-stat">
                <div className="dt-summary-val">{completedCount}</div>
                <div className="dt-summary-lbl">Completed</div>
              </div>
              <div className="dt-summary-stat">
                <div className="dt-summary-val">{pendingCount}</div>
                <div className="dt-summary-lbl">Pending</div>
              </div>
              <div className="dt-summary-stat">
                <div className="dt-summary-val">{focusRate != null ? focusRate + '%' : '—'}</div>
                <div className="dt-summary-lbl">Focus Rate</div>
              </div>
            </div>

            {Object.keys(catMap).length > 0 && (
              <div className="dt-cat-bars">
                {Object.entries(catMap).sort((a,b) => b[1]-a[1]).map(([cat, mins]) => {
                  const pct = Math.round(mins / maxCatMins * 100)
                  const col = catColor(cat, categories)
                  return (
                    <div key={cat} className="dt-cat-bar-row">
                      <div className="dt-cat-bar-label" title={cat}>{cat}</div>
                      <div className="dt-cat-bar-track">
                        <div className="dt-cat-bar-fill" style={{ width: pct + '%', background: col }} />
                      </div>
                      <div className="dt-cat-bar-val">{minsLabel(mins)}</div>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="dt-divider" />

            <div className="dt-standup-box">
              <h4>DayTrack Summary</h4>
              <pre>{buildStandup()}</pre>
            </div>

            <div className="dt-summary-actions">
              <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={() => setExportOpen(true)}>
                <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                Export Report
              </button>
              <button className="dt-btn dt-btn-primary dt-btn-sm" onClick={copyStandup}>
                <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copy DayTrack
              </button>
              <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={exportCSV}>
                <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Export CSV
              </button>
            </div>
          </div>

        </div>
      </div>

      {/* Settings Modal — Slack Auto-Log */}
      {settingsOpen && (
        <div className="dt-modal-overlay open" onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}>
          <div className="dt-modal dt-settings-modal">
            <div className="dt-settings-modal-header">
              <h3>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, verticalAlign: 'middle' }}>
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                Auto-Log Settings
              </h3>
              <button className="dt-modal-close-btn" onClick={() => setSettingsOpen(false)}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>

            {slackCfgLoading ? (
              <div className="dt-empty">Loading config…</div>
            ) : slackCfg ? (
              <>
                <div className="dt-settings-section-label">Slack Auto-Log</div>

                {/* Enable toggle */}
                <div className="dt-settings-row">
                  <label className="dt-settings-toggle-label">
                    <div className={`dt-toggle${slackCfg.enabled ? ' dt-toggle--on' : ''}`}
                      onClick={() => setSlackCfg(c => c ? { ...c, enabled: !c.enabled } : c)}>
                      <div className="dt-toggle-knob"/>
                    </div>
                    Auto-log from Slack
                  </label>
                </div>

                {/* Channel + Slack ID — two columns */}
                <div className="dt-settings-two-col">
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Monitor Channel</label>
                    <button
                      ref={slackChanRef}
                      className="pm-custom-dropdown-trigger"
                      style={{ width: '100%', justifyContent: 'space-between', fontSize: 12, padding: '5px 10px' }}
                      onClick={() => {
                        if (slackChanOpen) { setSlackChanOpen(false); return }
                        if (slackChanRef.current) {
                          const r = slackChanRef.current.getBoundingClientRect()
                          setSlackChanPos({ top: r.bottom + 4, left: r.left, width: r.width })
                        }
                        setSlackChanOpen(true)
                      }}>
                      <span>{slackCfg.channel_name ? `#${slackCfg.channel_name}` : 'Select…'}</span>
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Slack Member ID</label>
                    <div className="dt-slack-user-row">
                      <input className="form-input" style={{ fontSize: 12, padding: '5px 8px' }}
                        value={slackCfg.slack_user_id}
                        onChange={e => setSlackCfg(c => c ? { ...c, slack_user_id: e.target.value } : c)}
                        placeholder="U01AB2CDE" />
                      <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={resolveSlackUser}
                        style={{ fontSize: 11, padding: '4px 8px', whiteSpace: 'nowrap' }} title="Auto-detect from your app email">
                        Auto
                      </button>
                    </div>
                  </div>
                </div>

                {/* Timezone */}
                <div className="form-group" style={{ margin: '8px 0 0' }}>
                  <label className="form-label" style={{ fontSize: 11 }}>Your Timezone</label>
                  <input className="form-input" style={{ fontSize: 12, padding: '5px 8px' }}
                    value={slackCfg.timezone || 'Asia/Kolkata'}
                    onChange={e => setSlackCfg(c => c ? { ...c, timezone: e.target.value } : c)}
                    placeholder="Asia/Kolkata" />
                  <div style={{ fontSize: 10, opacity: 0.55, marginTop: 3 }}>IANA name — used to convert Slack timestamps to your local time</div>
                </div>

                {/* Destination channel for Post to Slack */}
                <div className="form-group" style={{ margin: '8px 0 0' }}>
                  <label className="form-label" style={{ fontSize: 11 }}>Destination Channel <span style={{ opacity: 0.6, fontWeight: 400 }}>(Post to Slack)</span></label>
                  <div className="dt-slack-user-row">
                    <button
                      ref={destChanRef}
                      className="pm-custom-dropdown-trigger"
                      style={{ flex: 1, justifyContent: 'space-between', fontSize: 12, padding: '5px 10px' }}
                      onClick={() => {
                        if (destChanOpen) { setDestChanOpen(false); return }
                        if (destChanRef.current) {
                          const r = destChanRef.current.getBoundingClientRect()
                          setDestChanPos({ top: r.bottom + 4, left: r.left, width: r.width })
                        }
                        setDestChanOpen(true)
                      }}>
                      <span>{slackCfg.dest_channel_name ? `#${slackCfg.dest_channel_name}` : 'Select…'}</span>
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                    <input
                      className="form-input"
                      style={{ fontSize: 12, padding: '5px 8px', width: 120, flexShrink: 0 }}
                      placeholder="or Channel ID"
                      value={slackCfg.dest_channel_id}
                      onChange={e => setSlackCfg(c => c ? { ...c, dest_channel_id: e.target.value, dest_channel_name: e.target.value ? (c.dest_channel_name || '') : '' } : c)}
                    />
                  </div>
                </div>

                {/* Keyword rules */}
                <div className="form-group" style={{ marginTop: 16 }}>
                  <div className="dt-settings-rules-header">
                    <label className="form-label" style={{ margin: 0 }}>Keyword Rules</label>
                    <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={addKWRule}>+ Add Rule</button>
                  </div>
                  <div className="dt-kw-rules">
                    {slackCfg.keyword_rules.map((rule, idx) => (
                      <div key={idx} className="dt-kw-rule-row">
                        <button
                          ref={el => { ruleTypeRefs.current[idx] = el }}
                          className="pm-custom-dropdown-trigger"
                          style={{ width: '100%', justifyContent: 'space-between', fontSize: 11, padding: '4px 7px', height: 28 }}
                          onClick={() => {
                            if (openRuleTypeIdx === idx) { setOpenRuleTypeIdx(null); return }
                            const el = ruleTypeRefs.current[idx]
                            if (el) {
                              const r = el.getBoundingClientRect()
                              setRuleTypePos({ top: r.bottom + 3, left: r.left, width: r.width })
                            }
                            setOpenRuleTypeIdx(idx)
                          }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {{ sign_in: 'Sign In', sign_off: 'Sign Off', break_start: 'Break Start', break_end: 'Break End' }[rule.rule_type] ?? rule.rule_type}
                          </span>
                          <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M6 9l6 6 6-6"/></svg>
                        </button>
                        <button
                          ref={el => { ruleCatRefs.current[idx] = el }}
                          className="pm-custom-dropdown-trigger"
                          style={{ width: '100%', justifyContent: 'space-between', fontSize: 11, padding: '4px 7px', height: 28 }}
                          onClick={() => {
                            if (openRuleCatIdx === idx) { setOpenRuleCatIdx(null); return }
                            const el = ruleCatRefs.current[idx]
                            if (el) {
                              const r = el.getBoundingClientRect()
                              setRuleCatPos({ top: r.bottom + 3, left: r.left, width: r.width })
                            }
                            setOpenRuleCatIdx(idx)
                          }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {rule.category || 'Category'}
                          </span>
                          <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M6 9l6 6 6-6"/></svg>
                        </button>
                        <input className="dt-kw-words-input" value={rule.keywords.join(', ')}
                          placeholder="keywords, comma-separated"
                          onChange={e => updateKWRule(idx, 'keywords', e.target.value.split(',').map(k => k.trim()).filter(Boolean))} />
                        <button className="dt-icon-btn dt-icon-btn-del" onClick={() => removeKWRule(idx)} title="Remove rule">
                          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="dt-modal-footer">
                  <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={scanNow}
                    disabled={!slackCfg.channel_id || !slackCfg.slack_user_id}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
                    Scan Now
                  </button>
                  <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={resetScanWindow}
                    disabled={!slackCfg.channel_id || !slackCfg.slack_user_id}
                    title="Clear the scan window so messages from today's start are re-processed">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                    Reset Window
                  </button>
                  <button className="dt-btn dt-btn-ghost" onClick={() => setSettingsOpen(false)}>Cancel</button>
                  <button className="dt-btn dt-btn-primary" onClick={async () => { await saveSlackCfg(); setSettingsOpen(false) }} disabled={slackCfgSaving}>
                    {slackCfgSaving ? 'Saving…' : 'Save Config'}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editEntry && (
        <div className="dt-modal-overlay open" onClick={e => { if (e.target === e.currentTarget) setEditEntry(null) }}>
          <div className="dt-modal">
            <h3>Edit Entry</h3>
            <div className="form-group">
              <label className="form-label">Task Name</label>
              <input className="form-input" value={eName} onChange={e => setEName(e.target.value)} autoComplete="off" />
            </div>
            <div className="form-group">
              <label className="form-label">Category</label>
              <CategoryChips value={eCat} onChange={setECat} categories={categories} />
            </div>
            <div className="dt-row2">
              <div className="form-group">
                <label className="form-label">Start Time</label>
                <div className="dt-time-wrap">
                  <input className="form-input" type="time" value={to24h(eStart)} onChange={e => setEStart(to12h(e.target.value))} />
                  <button className="dt-now-btn" onClick={() => setEStart(nowHHMM())}>Now</button>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">End Time</label>
                <div className="dt-time-wrap">
                  <input className="form-input" type="time" value={to24h(eEnd)} onChange={e => setEEnd(to12h(e.target.value))} />
                  <button className="dt-now-btn" onClick={() => setEEnd(nowHHMM())}>Now</button>
                </div>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Notes</label>
              <textarea className="form-input" value={eNotes} onChange={e => setENotes(e.target.value)} rows={2} />
            </div>
            <div className="dt-modal-footer">
              <button className="dt-btn dt-btn-ghost" onClick={() => setEditEntry(null)}>Cancel</button>
              <button className="dt-btn dt-btn-primary" onClick={saveEdit}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Subtask Modal */}
      {subtaskParent && (
        <div className="dt-modal-overlay open" onClick={e => { if (e.target === e.currentTarget) setSubtaskParent(null) }}>
          <div className="dt-modal">
            <h3>Add Subtask</h3>
            <div className="dt-subtask-parent-label">
              Parent: <strong>{subtaskParent.name}</strong>
              {subtaskParent.start_time && <span className="dt-subtask-parent-time"> · starts {subtaskParent.start_time}</span>}
            </div>
            <div className="form-group">
              <label className="form-label">Subtask Name *</label>
              <div className="dt-input-with-mic">
                <input className="form-input" value={stName} onChange={e => setStName(e.target.value)}
                  placeholder="What's the subtask?" autoComplete="off"
                  onKeyDown={e => e.key === 'Enter' && saveSubtask()} />
                <MicButton onResult={text => { setStName(text); const c = detectCategory(text, categories); if (c) setStCat(c) }} onError={msg => toast(msg, 'warn')} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Category</label>
              <CategoryChips value={stCat} onChange={setStCat} categories={categories} />
            </div>
            <div className="dt-row2">
              <div className="form-group">
                <label className="form-label">
                  Start Time
                  {subtaskParent.start_time && <span className="dt-subtask-time-hint"> (min: {subtaskParent.start_time})</span>}
                </label>
                <div className="dt-time-wrap">
                  <input className="form-input" type="time" value={to24h(stStart)} onChange={e => setStStart(to12h(e.target.value))} />
                  <button className="dt-now-btn" onClick={() => setStStart(nowHHMM())}>Now</button>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">End Time</label>
                <div className="dt-time-wrap">
                  <input className="form-input" type="time" value={to24h(stEnd)} onChange={e => setStEnd(to12h(e.target.value))} />
                  <button className="dt-now-btn" onClick={() => setStEnd(nowHHMM())}>Now</button>
                </div>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Notes</label>
              <div className="dt-input-with-mic dt-input-with-mic--textarea">
                <textarea className="form-input" value={stNotes} onChange={e => setStNotes(e.target.value)} rows={2} />
                <MicButton onResult={text => setStNotes(prev => prev ? prev + ' ' + text : text)} onError={msg => toast(msg, 'warn')} />
              </div>
            </div>
            <div className="dt-modal-footer">
              <button className="dt-btn dt-btn-ghost" onClick={() => setSubtaskParent(null)}>Cancel</button>
              <button className="dt-btn dt-btn-primary" onClick={saveSubtask}>Add Subtask</button>
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {exportOpen && (
        <div className="dt-modal-overlay open" onClick={e => { if (e.target === e.currentTarget) setExportOpen(false) }}>
          <div className="dt-modal">
            <h3>Export Report</h3>

            {/* Date range tabs */}
            <div className="dt-tabs" style={{ marginBottom: 16 }}>
              <button className={`dt-tab ${exportMode === 'today' ? 'active' : ''}`} onClick={() => { setExportMode('today'); setExportAISummary(null) }}>Today</button>
              <button className={`dt-tab ${exportMode === 'month' ? 'active' : ''}`} onClick={() => { setExportMode('month'); setExportAISummary(null) }}>By Month</button>
              <button className={`dt-tab ${exportMode === 'custom' ? 'active' : ''}`} onClick={() => { setExportMode('custom'); setExportAISummary(null) }}>Custom Range</button>
            </div>

            {exportMode === 'today' && (
              <div className="dt-export-today-label">{fmtDate(new Date(date + 'T00:00:00'))}</div>
            )}
            {exportMode === 'month' && (
              <MonthPicker value={exportMonth} onChange={setExportMonth} />
            )}
            {exportMode === 'custom' && (
              <div className="dt-row2">
                <CalendarPicker label="Start Date" value={exportStart} onChange={setExportStart} />
                <CalendarPicker label="End Date" value={exportEnd} onChange={setExportEnd} />
              </div>
            )}

            {/* Export options */}
            <div className="dt-export-options">
              <label className="dt-export-toggle">
                <input type="checkbox" checked={exportBreaks} onChange={e => { setExportBreaks(e.target.checked); setExportAISummary(null) }} />
                <span>Include Breaks</span>
              </label>
              <label className="dt-export-toggle">
                <input type="checkbox" checked={exportSummarise} onChange={e => { setExportSummarise(e.target.checked); setExportAISummary(null) }} />
                <span>Summarise with AI <span className="dt-export-toggle-hint">(Groq · skips tickets)</span></span>
              </label>
            </div>

            {/* AI summary preview — shown after first generation, reused by all buttons */}
            {exportSummarise && exportAILoading && (
              <div className="dt-export-ai-status">⏳ Generating AI summary…</div>
            )}
            {exportSummarise && exportAISummary && !exportAILoading && (
              <div className="dt-export-ai-preview">
                <div className="dt-export-ai-preview-label">✨ AI Summary Preview</div>
                <pre className="dt-export-ai-preview-text">{exportAISummary}</pre>
              </div>
            )}

            <div className="dt-modal-footer" style={{ marginTop: 20 }}>
              <button className="dt-btn dt-btn-ghost" onClick={() => setExportOpen(false)}>Cancel</button>
              <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={copyExportSummary} disabled={exportCopyLoading || exportLoading}>
                <svg viewBox="0 0 24 24" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                {exportCopyLoading ? 'Copying…' : 'Copy Summary'}
              </button>
              <button className="dt-btn dt-btn-ghost dt-btn-sm" onClick={() => runExport('doc')} disabled={exportLoading || exportCopyLoading}>
                <svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                {exportLoading ? 'Generating…' : 'Export DOC'}
              </button>
              <button className="dt-btn dt-btn-primary" onClick={() => runExport('pdf')} disabled={exportLoading || exportCopyLoading}>
                <svg viewBox="0 0 24 24" width="14" height="14"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                {exportLoading ? 'Generating…' : 'Export PDF'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Portal category dropdown — renders above all stacking contexts */}
      {openDrop && dropPos && createPortal(
        <div
          className="pm-custom-dropdown-menu"
          style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: 'max-content', maxWidth: 260, zIndex: 9999 }}
          onMouseDown={e => e.stopPropagation()}
        >
          {categories.map(c => {
            const active =
              (openDrop === 'mCat' && mCat === c) ||
              (openDrop === 'tCat' && tCat === c) ||
              (openDrop === 'pCat' && pCat === c) ||
              (openDrop === 'eCat' && eCat === c) ||
              (openDrop === 'stCat' && stCat === c)
            const select = (v: string) => {
              if (openDrop === 'mCat') setMCat(v)
              else if (openDrop === 'tCat') setTCat(v)
              else if (openDrop === 'pCat') setPCat(v)
              else if (openDrop === 'eCat') setECat(v)
              else if (openDrop === 'stCat') setStCat(v)
              setOpenDrop(null)
            }
            return (
              <button key={c} className={`pm-dropdown-item${active ? ' active' : ''}`} onClick={() => select(c)}>
                <span className="dt-cat-dot" style={{ background: catColor(c, categories) }}/>{c}
              </button>
            )
          })}
        </div>,
        document.body
      )}

      {/* Portal rule-type dropdown */}
      {openRuleTypeIdx !== null && ruleTypePos && slackCfg && createPortal(
        <div
          className="pm-custom-dropdown-menu"
          style={{ position: 'fixed', top: ruleTypePos.top, left: ruleTypePos.left, width: Math.max(ruleTypePos.width, 120), zIndex: 10000 }}
          onMouseDown={e => e.stopPropagation()}
        >
          {([
            { value: 'sign_in',     label: 'Sign In'     },
            { value: 'sign_off',    label: 'Sign Off'    },
            { value: 'break_start', label: 'Break Start' },
            { value: 'break_end',   label: 'Break End'   },
          ] as const).map(opt => (
            <button key={opt.value}
              className={`pm-dropdown-item${slackCfg.keyword_rules[openRuleTypeIdx]?.rule_type === opt.value ? ' active' : ''}`}
              onMouseDown={() => {
                updateKWRule(openRuleTypeIdx, 'rule_type', opt.value)
                setOpenRuleTypeIdx(null)
              }}>
              {opt.label}
            </button>
          ))}
        </div>,
        document.body
      )}

      {/* Portal rule-category dropdown */}
      {openRuleCatIdx !== null && ruleCatPos && slackCfg && createPortal(
        <div
          className="pm-custom-dropdown-menu"
          style={{ position: 'fixed', top: ruleCatPos.top, left: ruleCatPos.left, width: Math.max(ruleCatPos.width, 140), zIndex: 10000, maxHeight: 180, overflowY: 'auto' }}
          onMouseDown={e => e.stopPropagation()}
        >
          {categories.map(c => (
            <button key={c}
              className={`pm-dropdown-item${slackCfg.keyword_rules[openRuleCatIdx]?.category === c ? ' active' : ''}`}
              onMouseDown={() => {
                updateKWRule(openRuleCatIdx, 'category', c)
                setOpenRuleCatIdx(null)
              }}>
              <span className="dt-cat-dot" style={{ background: catColor(c, categories) }}/>{c}
            </button>
          ))}
        </div>,
        document.body
      )}

      {/* Portal channel dropdown */}
      {slackChanOpen && slackChanPos && createPortal(
        <div
          className="pm-custom-dropdown-menu"
          style={{ position: 'fixed', top: slackChanPos.top, left: slackChanPos.left, width: slackChanPos.width, zIndex: 10000, maxHeight: 220, overflowY: 'auto' }}
          onMouseDown={e => e.stopPropagation()}
        >
          {channelsLoading ? (
            <div className="pm-dropdown-item" style={{ pointerEvents: 'none', opacity: 0.6 }}>Loading channels…</div>
          ) : slackChannels.length === 0 ? (
            <div className="pm-dropdown-item" style={{ pointerEvents: 'none', opacity: 0.6 }}>No channels — connect Slack first</div>
          ) : slackChannels.map(ch => (
            <button key={ch.id}
              className={`pm-dropdown-item${slackCfg?.channel_id === ch.id ? ' active' : ''}`}
              onMouseDown={() => {
                setSlackCfg(c => c ? { ...c, channel_id: ch.id, channel_name: ch.name } : c)
                setSlackChanOpen(false)
              }}>
              #{ch.name}
            </button>
          ))}
        </div>,
        document.body
      )}

      {/* Portal dest channel dropdown */}
      {destChanOpen && destChanPos && slackCfg && createPortal(
        <div
          className="pm-custom-dropdown-menu"
          style={{ position: 'fixed', top: destChanPos.top, left: destChanPos.left, width: destChanPos.width, zIndex: 10000, maxHeight: 220, overflowY: 'auto' }}
          onMouseDown={e => e.stopPropagation()}
        >
          {channelsLoading ? (
            <div className="pm-dropdown-item" style={{ pointerEvents: 'none', opacity: 0.6 }}>Loading channels…</div>
          ) : slackChannels.length === 0 ? (
            <div className="pm-dropdown-item" style={{ pointerEvents: 'none', opacity: 0.6 }}>No channels — connect Slack first</div>
          ) : slackChannels.map(ch => (
            <button key={ch.id}
              className={`pm-dropdown-item${slackCfg.dest_channel_id === ch.id ? ' active' : ''}`}
              onMouseDown={() => {
                setSlackCfg(c => c ? { ...c, dest_channel_id: ch.id, dest_channel_name: ch.name } : c)
                setDestChanOpen(false)
              }}>
              #{ch.name}
            </button>
          ))}
        </div>,
        document.body
      )}

      <ToastContainer toasts={toasts} />
    </div>
  )
}
