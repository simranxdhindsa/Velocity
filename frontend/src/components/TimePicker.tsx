import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Clock } from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

function parse(value: string): { hour: number; minute: number; ampm: 'AM' | 'PM' } {
  const [h = 0, m = 0] = value.split(':').map(Number)
  return {
    hour: h % 12 || 12,
    minute: Math.round(m / 5) * 5 % 60,
    ampm: h < 12 ? 'AM' : 'PM',
  }
}

function to24(hour: number, ampm: 'AM' | 'PM'): number {
  if (ampm === 'AM') return hour === 12 ? 0 : hour
  return hour === 12 ? 12 : hour + 12
}

function toHHMM(hour: number, minute: number, ampm: 'AM' | 'PM'): string {
  const h = to24(hour, ampm)
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function displayTime(value: string): string {
  const { hour, minute, ampm } = parse(value)
  return `${hour}:${String(minute).padStart(2, '0')} ${ampm}`
}

// ── Scrollable column ─────────────────────────────────────────────────────────

function Col<T extends number | string>({
  items,
  selected,
  onSelect,
  format,
}: {
  items: T[]
  selected: T
  onSelect: (v: T) => void
  format?: (v: T) => string
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Scroll selected item into centre on mount / selection change
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const active = el.querySelector<HTMLElement>('.tp-col-item.active')
    if (active) {
      el.scrollTop = active.offsetTop - el.clientHeight / 2 + active.clientHeight / 2
    }
  }, [selected])

  return (
    <div className="tp-col" ref={ref}>
      {items.map(item => (
        <button
          key={item}
          type="button"
          className={`tp-col-item${item === selected ? ' active' : ''}`}
          onClick={() => onSelect(item)}
        >
          {format ? format(item) : String(item)}
        </button>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export interface TimePickerProps {
  /** HH:MM in 24-hour format */
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}

export function TimePicker({ value, onChange, className = '', placeholder }: TimePickerProps) {
  const { hour, minute, ampm } = parse(value || '09:00')
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)

  const positionMenu = useCallback(() => {
    if (!triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const menuH = 220
    const top = spaceBelow > menuH + 8 ? r.bottom + 4 : r.top - menuH - 4
    setMenuStyle({ position: 'fixed', top, left: r.left, minWidth: r.width, zIndex: 9999 })
  }, [])

  useEffect(() => {
    if (!open) return
    positionMenu()
    window.addEventListener('scroll', positionMenu, true)
    window.addEventListener('resize', positionMenu)
    return () => {
      window.removeEventListener('scroll', positionMenu, true)
      window.removeEventListener('resize', positionMenu)
    }
  }, [open, positionMenu])

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      const menu = document.querySelector('.tp-menu')
      if (menu?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const set = (h: number, m: number, ap: 'AM' | 'PM') => onChange(toHHMM(h, m, ap))

  const label = value ? displayTime(value) : (placeholder ?? 'Select time…')

  return (
    <div className={`pm-custom-dropdown tp-root ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="pm-custom-dropdown-trigger"
        onClick={() => setOpen(o => !o)}
        style={{ gap: 8 }}
      >
        <Clock size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
        <ChevronDown size={11} className={`dropdown-chevron${open ? ' open' : ''}`} />
      </button>

      {open && createPortal(
        <div className="tp-menu" style={menuStyle}>
          <div className="tp-cols">
            <Col
              items={HOURS}
              selected={hour}
              onSelect={h => set(h, minute, ampm)}
              format={h => String(h).padStart(2, '0')}
            />
            <div className="tp-colon">:</div>
            <Col
              items={MINUTES}
              selected={minute}
              onSelect={m => set(hour, m, ampm)}
              format={m => String(m).padStart(2, '0')}
            />
            <div className="tp-ampm-col">
              {(['AM', 'PM'] as const).map(ap => (
                <button
                  key={ap}
                  type="button"
                  className={`tp-ampm-btn${ampm === ap ? ' active' : ''}`}
                  onClick={() => set(hour, minute, ap)}
                >
                  {ap}
                </button>
              ))}
            </div>
          </div>
          <div className="tp-footer">
            <button type="button" className="tp-done-btn" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
