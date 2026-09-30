// Day Track — shared, self-contained mini-components (no dependency on
// DayTrackPage's internal state beyond their own props). Extracted from
// DayTrackPage.tsx per CLAUDE.md's file-size rule.

import { useState, useEffect, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { dayTrackApi } from '../services/api'
import { toDateStr, type Toast, type ToastType } from './daytrack-helpers'

// ── Toast ──────────────────────────────────────────────────────────────────────

export function ToastContainer({ toasts }: { toasts: Toast[] }) {
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

// ── Month picker ──────────────────────────────────────────────────────────────

export function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
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

// ── Drag and drop: Today's Log <-> Planned & Carry Over ─────────────────────────
// Desktop/tablet only (see useIsDesktopWidth below) — on touch devices, a vertical
// swipe to scroll the table is indistinguishable from a drag gesture, and disabling
// drag there costs nothing since the Carry/Start action buttons already do the exact
// same move. Below the breakpoint these render as inert, ordinary rows/tbody: the
// underlying useDraggable/useDroppable calls stay (Rules of Hooks), just disabled.
export function useIsDesktopWidth(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 769px)').matches : true
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 769px)')
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isDesktop
}

// Row-level draggable wrapper. Whole-row drag handle (like the Kanban board's task
// cards) — dnd-kit's PointerSensor activation distance means ordinary clicks on the
// row's own Edit/Carry/Delete buttons still register as clicks, not drags.
export function DraggableRow({ id, className, children, dragEnabled }: { id: string; className?: string; children: React.ReactNode; dragEnabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id, disabled: !dragEnabled })
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.35 : 1,
    cursor: dragEnabled ? 'grab' : undefined,
    // touch-action: none tells the browser to stop handling touch gestures on this
    // element at all (including scroll) so dnd-kit can take over — only safe to set
    // while drag is actually enabled; leaving it on unconditionally is what broke
    // scrolling on mobile.
    touchAction: dragEnabled ? 'none' : undefined,
    position: isDragging ? 'relative' : undefined,
    zIndex: isDragging ? 10 : undefined,
  }
  return (
    <tr ref={setNodeRef} style={style} className={className} {...(dragEnabled ? { ...attributes, ...listeners } : {})}>
      {children}
    </tr>
  )
}

// Droppable target wrapping a table body — highlights while something is dragged over it.
export function DroppableTBody({ id, children, dropEnabled }: { id: string; children: React.ReactNode; dropEnabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !dropEnabled })
  return (
    <tbody ref={setNodeRef} className={isOver ? 'dt-drop-target-active' : undefined}>
      {children}
    </tbody>
  )
}

export function CategoryChips({ value, onChange, categories, disabledOptions }: {
  value: string
  onChange: (v: string) => void
  categories: string[]
  disabledOptions?: Set<string>
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
        const disabled = disabledOptions?.has(c) ?? false
        return (
          <button
            key={c}
            type="button"
            disabled={disabled}
            title={disabled ? "Not available while marked as in progress" : undefined}
            className={`dt-chip${selected ? ' dt-chip--selected' : ''}${disabled ? ' dt-chip--disabled' : ''}`}
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

export function TaskNameInput({ value, onChange, suggestions, placeholder, onEnter, onPaste }: {
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  placeholder?: string
  onEnter?: () => void
  onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void
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
        onPaste={onPaste}
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

// ── Mic button ────────────────────────────────────────────────────────────────

export function MicButton({ onResult, onError }: {
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
export const ClockDisplay = memo(function ClockDisplay() {
  const [clock, setClock] = useState(() => {
    const n = new Date()
    return n.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  })
  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date()
      setClock(n.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }, 1000)
    return () => clearInterval(id)
  }, [])
  return <>{clock}</>
})
