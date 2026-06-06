import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

interface CalendarPickerProps {
  value: string
  onChange: (d: string) => void
  label?: string
  placeholder?: string
  className?: string
}

export function CalendarPicker({ value, onChange, label, placeholder = 'Select date', className }: CalendarPickerProps) {
  const [open, setOpen] = useState(false)
  const [calDate, setCalDate] = useState(() => value ? new Date(value + 'T00:00:00') : new Date())
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

  const todayStr = toDateStr(new Date())

  const fmtDisplay = (d: string) => {
    if (!d) return placeholder
    const obj = new Date(d + 'T00:00:00')
    return obj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  const openCalendar = () => {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 6, left: r.left })
    }
    if (value) setCalDate(new Date(value + 'T00:00:00'))
    setOpen(o => !o)
  }

  const firstDayOfMonth = new Date(calDate.getFullYear(), calDate.getMonth(), 1).getDay()
  const daysInMonth = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 0).getDate()

  const trigger = (
    <>
      <button ref={triggerRef} className="dr-cal-trigger" onClick={openCalendar}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <path d="M16 2v4M8 2v4M3 10h18"/>
        </svg>
        <span>{fmtDisplay(value)}</span>
      </button>

      {open && pos && createPortal(
        <div ref={dropRef} className="dr-cal-dropdown glass-card"
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999, minWidth: 240, padding: 12 }}>
          <div className="calendar-nav">
            <button onClick={() => setCalDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <span className="calendar-month-label">{MONTH_NAMES[calDate.getMonth()]} {calDate.getFullYear()}</span>
            <button onClick={() => setCalDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>
          <div className="calendar-grid">
            <div className="calendar-header-row">
              {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => <span key={d}>{d}</span>)}
            </div>
            <div className="calendar-body">
              {Array.from({ length: firstDayOfMonth }).map((_, i) => <span key={`e${i}`}/>)}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const dayStr = `${calDate.getFullYear()}-${String(calDate.getMonth()+1).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`
                return (
                  <button key={i}
                    className={`calendar-day${dayStr === value ? ' selected' : ''}${dayStr === todayStr ? ' today' : ''}`}
                    onClick={() => { onChange(dayStr); setOpen(false) }}>
                    {i + 1}
                  </button>
                )
              })}
            </div>
          </div>
          <div style={{ textAlign: 'center', marginTop: 6 }}>
            <button className="dt-btn dt-btn-ghost dt-btn-sm" style={{ fontSize: 11 }}
              onClick={() => { onChange(todayStr); setOpen(false) }}>Today</button>
          </div>
        </div>,
        document.body
      )}
    </>
  )

  if (label) {
    return (
      <div className={`form-group${className ? ' ' + className : ''}`}>
        <label className="form-label">{label}</label>
        {trigger}
      </div>
    )
  }

  return <div className={className}>{trigger}</div>
}
