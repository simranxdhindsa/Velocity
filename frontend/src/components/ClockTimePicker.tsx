import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Clock, Keyboard, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import '../styles/components/clock-time-picker.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

type AMPM = 'AM' | 'PM'
type Phase = 'hour' | 'minute'

function parse(value: string): { hour: number; minute: number; ampm: AMPM } {
  const [h = 9, m = 0] = value.split(':').map(Number)
  return {
    hour: h % 12 || 12,
    minute: Math.round(m / 5) * 5 % 60,
    ampm: h < 12 ? 'AM' : 'PM',
  }
}

function to24(hour: number, ampm: AMPM): number {
  if (ampm === 'AM') return hour === 12 ? 0 : hour
  return hour === 12 ? 12 : hour + 12
}

function toHHMM(hour: number, minute: number, ampm: AMPM): string {
  const h = to24(hour, ampm)
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// Some locales (e.g. en-IN) lowercase am/pm in Intl output — normalize to uppercase everywhere.
export function upperAmPm(s: string): string {
  return s.replace(/\b(am|pm)\b/i, m => m.toUpperCase())
}

export function displayTime(value: string): string {
  const { hour, minute, ampm } = parse(value)
  return `${hour}:${String(minute).padStart(2, '0')} ${ampm}`
}

// ── Clock geometry ────────────────────────────────────────────────────────────

const SIZE = 260
const CR = SIZE / 2
const NR = CR * 0.72   // number ring radius
const THUMB_R = 20     // selected-number circle radius
const SPRING = { type: 'spring' as const, stiffness: 600, damping: 38 }

function clockPos(index: number) {
  const rad = (index / 12) * 2 * Math.PI - Math.PI / 2
  return { x: CR + NR * Math.cos(rad), y: CR + NR * Math.sin(rad) }
}

function hourToIndex(h: number)  { return h % 12 }
function minuteToIndex(m: number) { return m / 5 }

function indexFromPointer(
  e: React.PointerEvent<SVGSVGElement>,
  svg: SVGSVGElement
): number {
  const rect = svg.getBoundingClientRect()
  const dx = e.clientX - rect.left - CR
  const dy = e.clientY - rect.top  - CR
  let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90
  if (deg < 0) deg += 360
  return Math.round(deg / 30) % 12
}

// ── Clock SVG ─────────────────────────────────────────────────────────────────

function ClockFace({
  phase, hour, minute,
  onUpdate, onCommit,
}: {
  phase: Phase
  hour: number
  minute: number
  onUpdate: (hour: number, minute: number) => void
  onCommit: (hour: number, minute: number, advance: boolean) => void
}) {
  const svgRef  = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)
  const [isDragging, setIsDragging] = useState(false)

  const selIndex = phase === 'hour' ? hourToIndex(hour) : minuteToIndex(minute)
  const selPos   = clockPos(selIndex)

  const applyIndex = useCallback((idx: number, commit: boolean, advance: boolean) => {
    const h = phase === 'hour' ? (idx === 0 ? 12 : idx) : hour
    const m = phase === 'minute' ? idx * 5 : minute
    if (commit) onCommit(h, m, advance)
    else         onUpdate(h, m)
  }, [phase, hour, minute, onUpdate, onCommit])

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault()
    dragging.current = true
    setIsDragging(true)
    svgRef.current?.setPointerCapture(e.pointerId)
    applyIndex(indexFromPointer(e, svgRef.current!), false, false)
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return
    applyIndex(indexFromPointer(e, svgRef.current!), false, false)
  }

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return
    dragging.current = false
    setIsDragging(false)
    const idx = indexFromPointer(e, svgRef.current!)
    // advance to minute phase after selecting hour
    applyIndex(idx, true, phase === 'hour')
  }

  const labels = phase === 'hour'
    ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    : [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

  return (
    <svg
      ref={svgRef}
      width={SIZE}
      height={SIZE}
      className="ctp-clock-svg"
      style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Background */}
      <circle cx={CR} cy={CR} r={CR - 6} className="ctp-clock-bg" />

      {/* Hand — animates in real time */}
      <motion.line
        x1={CR} y1={CR}
        className="ctp-clock-hand"
        strokeWidth={2}
        strokeLinecap="round"
        animate={{ x2: selPos.x, y2: selPos.y }}
        transition={SPRING}
      />

      {/* Center dot */}
      <circle cx={CR} cy={CR} r={5} className="ctp-clock-center" />

      {/* Thumb circle — animates in real time */}
      <motion.circle
        r={THUMB_R}
        className="ctp-clock-thumb"
        animate={{ cx: selPos.x, cy: selPos.y }}
        transition={SPRING}
      />

      {/* Numbers — rendered above thumb */}
      {labels.map((label, idx) => {
        const pos   = clockPos(idx)
        const isSel = idx === selIndex
        return (
          <motion.text
            key={`${phase}-${label}`}
            x={pos.x}
            y={pos.y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={13}
            fontFamily="inherit"
            fontWeight={isSel ? 700 : 400}
            className={isSel ? 'ctp-num ctp-num--sel' : 'ctp-num'}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.1 }}
          >
            {phase === 'minute' ? String(label).padStart(2, '0') : label}
          </motion.text>
        )
      })}
    </svg>
  )
}

// ── Dialog ────────────────────────────────────────────────────────────────────

function ClockDialog({
  initial, onConfirm, onCancel,
}: {
  initial: string
  onConfirm: (v: string) => void
  onCancel: () => void
}) {
  const { hour: ih, minute: im, ampm: iap } = parse(initial || '09:00')
  const [hour,    setHour]    = useState(ih)
  const [minute,  setMinute]  = useState(im)
  const [ampm,    setAMPM]    = useState<AMPM>(iap)
  const [phase,   setPhase]   = useState<Phase>('hour')
  const [textMode,setTextMode]= useState(false)
  const [textVal, setTextVal] = useState(displayTime(initial || '09:00'))

  // Live update from clock drag
  const handleUpdate = useCallback((h: number, m: number) => {
    setHour(h); setMinute(m)
  }, [])

  // Commit (on pointer-up / click) — optionally advance phase
  const handleCommit = useCallback((h: number, m: number, advance: boolean) => {
    setHour(h); setMinute(m)
    if (advance) setPhase('minute')
  }, [])

  const handleOK = () => {
    if (textMode) {
      const match = textVal.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i)
      if (match) {
        const h  = parseInt(match[1])
        const m  = parseInt(match[2])
        const ap = (match[3]?.toUpperCase() as AMPM) ?? ampm
        if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
          if (h > 12) { onConfirm(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`); return }
          onConfirm(toHHMM(h || 12, m, ap)); return
        }
      }
    }
    onConfirm(toHHMM(hour, minute, ampm))
  }

  return createPortal(
    <div className="ctp-overlay" onMouseDown={onCancel}>
      <motion.div
        className="ctp-dialog"
        onMouseDown={e => e.stopPropagation()}
        initial={{ scale: 0.92, opacity: 0, y: 12 }}
        animate={{ scale: 1,    opacity: 1, y: 0  }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      >
        <div className="ctp-title">SELECT TIME</div>

        {/* Display row */}
        <div className="ctp-display">
          <button
            className={`ctp-display-seg${phase === 'hour' ? ' ctp-display-seg--active' : ''}`}
            onClick={() => setPhase('hour')}
          >
            <AnimatePresence mode="wait">
              <motion.span
                key={hour}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0  }}
                exit={{ opacity: 0, y: 6    }}
                transition={{ duration: 0.12 }}
              >
                {String(hour).padStart(2, '0')}
              </motion.span>
            </AnimatePresence>
          </button>
          <span className="ctp-display-colon">:</span>
          <button
            className={`ctp-display-seg${phase === 'minute' ? ' ctp-display-seg--active' : ''}`}
            onClick={() => setPhase('minute')}
          >
            <AnimatePresence mode="wait">
              <motion.span
                key={minute}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0  }}
                exit={{ opacity: 0, y: 6    }}
                transition={{ duration: 0.12 }}
              >
                {String(minute).padStart(2, '0')}
              </motion.span>
            </AnimatePresence>
          </button>
          <div className="ctp-ampm">
            {(['AM', 'PM'] as AMPM[]).map(ap => (
              <button
                key={ap}
                className={`ctp-ampm-btn${ampm === ap ? ' ctp-ampm-btn--active' : ''}`}
                onClick={() => setAMPM(ap)}
              >
                {ap}
              </button>
            ))}
          </div>
        </div>

        {/* Clock or text input */}
        <AnimatePresence mode="wait">
          {textMode ? (
            <motion.div
              key="text"
              className="ctp-text-wrap"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <input
                className="ctp-text-input"
                value={textVal}
                onChange={e => setTextVal(e.target.value)}
                placeholder="7:00 AM"
                autoFocus
              />
            </motion.div>
          ) : (
            <motion.div
              key="clock"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <ClockFace
                phase={phase}
                hour={hour}
                minute={minute}
                onUpdate={handleUpdate}
                onCommit={handleCommit}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer */}
        <div className="ctp-footer">
          <button
            className="ctp-keyboard-btn"
            title="Enter time manually"
            onClick={() => setTextMode(t => !t)}
          >
            <Keyboard size={18} />
          </button>
          <button className="ctp-btn-cancel" onClick={onCancel}>CANCEL</button>
          <button className="ctp-btn-ok" onClick={handleOK}>OK</button>
        </div>
      </motion.div>
    </div>,
    document.body
  )
}

// ── Exported component ────────────────────────────────────────────────────────

export interface ClockTimePickerProps {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}

export function ClockTimePicker({ value, onChange, className = '', placeholder }: ClockTimePickerProps) {
  const [open, setOpen] = useState(false)
  const label = value ? displayTime(value) : (placeholder ?? 'Select time…')

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open])

  const handleConfirm = useCallback((v: string) => {
    onChange(v); setOpen(false)
  }, [onChange])

  return (
    <div className={`pm-custom-dropdown ctp-root ${className}`.trim()}>
      <button
        type="button"
        className="pm-custom-dropdown-trigger"
        onClick={() => setOpen(o => !o)}
        style={{ gap: 8 }}
      >
        <Clock size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
        <ChevronDown size={11} className={`dropdown-chevron${open ? ' open' : ''}`} />
      </button>

      {open && (
        <ClockDialog
          initial={value}
          onConfirm={handleConfirm}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  )
}
