import { useState, useEffect, useRef, useCallback } from 'react'
import '@/styles/components/world-clock.css'

const CLAMP_MIN = -720
const CLAMP_MAX = 720
const RESET_MS = 7500
const PX_PER_MIN = 1
const SNAP_ZONE_MIN = 8

type Zone = 'IST' | 'CET'
const TZ: Record<Zone, string> = { IST: 'Asia/Kolkata', CET: 'Europe/Berlin' }

function fmtTime(date: Date, tz: string): string {
  return date.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true })
}

function fmtOffsetLabel(min: number): string {
  const h = min / 60
  const rounded = Math.round(h * 10) / 10
  return (rounded >= 0 ? '+' : '') + rounded + 'h'
}

function getLocalHour(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).formatToParts(date)
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '12')
  return h === 24 ? 0 : h
}

function getTzTotalMin(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0')
  return (h === 24 ? 0 : h) * 60 + m
}

function parse12hTime(str: string): number | null {
  const match = str.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return null
  let h = parseInt(match[1])
  const min = parseInt(match[2])
  const ampm = match[3].toUpperCase()
  if (h < 1 || h > 12 || min < 0 || min > 59) return null
  if (ampm === 'AM') { if (h === 12) h = 0 }
  else { if (h !== 12) h += 12 }
  return h * 60 + min
}

function SunIcon() {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315]
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className="wc-daynight wc-daynight--sun" aria-hidden>
      <circle cx="5" cy="5" r="2" fill="currentColor" />
      {rays.map(deg => {
        const rad = (deg * Math.PI) / 180
        return (
          <line key={deg}
            x1={5 + Math.cos(rad) * 3.1} y1={5 + Math.sin(rad) * 3.1}
            x2={5 + Math.cos(rad) * 4.2} y2={5 + Math.sin(rad) * 4.2}
            stroke="currentColor" strokeWidth="0.9" strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className="wc-daynight wc-daynight--moon" aria-hidden>
      <path d="M6.5 5A3.5 3.5 0 0 1 3 1.5a.5.5 0 0 0-.6-.6A4 4 0 1 0 9.1 7.6a.5.5 0 0 0-.6-.6A3.5 3.5 0 0 1 6.5 5z" fill="currentColor" />
    </svg>
  )
}

// Globe illusion: two longitude ellipses with opposite-phase rx animations.
// Front is solid and shrinks to a line as it rotates to the side, then fades when behind.
// Back is dashed and appears when front goes behind. Both use the same delay (phase encoded in keyframes).
function PulseDot() {
  const syncDelay = useRef(`-${(Date.now() % 1000) / 1000}s`).current
  return (
    <span className="wc-pulse" style={{ animationDelay: syncDelay }} aria-hidden />
  )
}

export default function WorldClock() {
  const [realNow, setRealNow] = useState(() => new Date())
  const [offsetMin, setOffsetMin] = useState(0)
  const [copied, setCopied] = useState<Zone | null>(null)
  const [editingZone, setEditingZone] = useState<Zone | null>(null)
  const [editValue, setEditValue] = useState('')

  const dragZoneRef = useRef<Zone | null>(null)
  const startXRef = useRef(0)
  const startOffsetRef = useRef(0)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const id = setInterval(() => setRealNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (editingZone && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingZone])

  const scheduleReset = useCallback(() => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => {
      setOffsetMin(0)
      dragZoneRef.current = null
    }, RESET_MS)
  }, [])

  const onMouseMove = useCallback((e: MouseEvent) => {
    const dx = e.clientX - startXRef.current
    const raw = startOffsetRef.current + dx * PX_PER_MIN
    const nearestHour = Math.round(raw / 60) * 60
    const snapped = Math.abs(raw - nearestHour) < SNAP_ZONE_MIN ? nearestHour : raw
    setOffsetMin(Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, snapped)))
    scheduleReset()
  }, [scheduleReset])

  const onMouseUp = useCallback(() => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }, [onMouseMove])

  const startDrag = useCallback((e: React.MouseEvent, zone: Zone) => {
    if (editingZone) return
    e.preventDefault()
    dragZoneRef.current = zone
    startXRef.current = e.clientX
    startOffsetRef.current = offsetMin
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [offsetMin, onMouseMove, onMouseUp, editingZone])

  const onLeave = useCallback((zone: Zone) => {
    if (dragZoneRef.current !== zone || offsetMin === 0) return
    const displayDate = new Date(realNow.getTime() + offsetMin * 60_000)
    const otherZone: Zone = zone === 'IST' ? 'CET' : 'IST'
    navigator.clipboard.writeText(fmtTime(displayDate, TZ[otherZone])).catch(() => {})
    setCopied(otherZone)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(null), 1800)
  }, [offsetMin, realNow])

  const openEdit = useCallback((zone: Zone) => {
    const displayDate = new Date(realNow.getTime() + offsetMin * 60_000)
    setEditValue(fmtTime(displayDate, TZ[zone]))
    setEditingZone(zone)
  }, [realNow, offsetMin])

  const commitEdit = useCallback(() => {
    if (!editingZone) return
    const parsed = parse12hTime(editValue)
    if (parsed !== null) {
      const currentTzMin = getTzTotalMin(realNow, TZ[editingZone])
      let delta = parsed - currentTzMin
      if (delta > 720) delta -= 1440
      if (delta < -720) delta += 1440
      setOffsetMin(Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, delta)))
      scheduleReset()
    }
    setEditingZone(null)
  }, [editingZone, editValue, realNow, scheduleReset])

  const cancelEdit = useCallback(() => setEditingZone(null), [])

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const displayDate = new Date(realNow.getTime() + offsetMin * 60_000)
  const isLive = offsetMin === 0

  const istStr = fmtTime(displayDate, TZ.IST)
  const cetStr = fmtTime(displayDate, TZ.CET)
  const istDay = (() => { const h = getLocalHour(displayDate, TZ.IST); return h >= 6 && h < 20 })()
  const cetDay = (() => { const h = getLocalHour(displayDate, TZ.CET); return h >= 6 && h < 20 })()

  const istMin = getTzTotalMin(realNow, TZ.IST)
  const cetMin = getTzTotalMin(realNow, TZ.CET)
  let diffMin = istMin - cetMin
  if (diffMin < 0) diffMin += 1440
  const diffH = Math.floor(diffMin / 60)
  const diffM = diffMin % 60
  const diffLabel = diffM === 0 ? `${diffH}h` : `${diffH}h ${diffM}m`
  const diffTooltip = `IST is +${diffLabel} ahead of CET — drag or double-click to explore`

  const renderZone = (id: Zone, timeStr: string, isDay: boolean) => (
    <span
      className={[
        'wc-zone',
        copied === id ? 'wc-zone--copied' : '',
        editingZone === id ? 'wc-zone--editing' : '',
      ].filter(Boolean).join(' ')}
      onMouseDown={e => startDrag(e, id)}
      onMouseLeave={() => onLeave(id)}
      onDoubleClick={() => openEdit(id)}
      style={{ cursor: editingZone === id ? 'text' : undefined }}
    >
      {isDay ? <SunIcon /> : <MoonIcon />}
      <span className="wc-label">{id}</span>
      {editingZone === id ? (
        <input
          ref={inputRef}
          className="wc-edit-input"
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit() }}
          onBlur={commitEdit}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          placeholder="12:00 PM"
        />
      ) : (
        <span className={`wc-time${!isLive ? ' wc-time--offset' : ''}`}>{timeStr}</span>
      )}
      {copied === id && <span className="wc-copied">copied</span>}
    </span>
  )

  return (
    <div className="wc-wrap" title={diffTooltip}>
      {renderZone('IST', istStr, istDay)}
      <span className="wc-sep">
        <PulseDot />
      </span>
      {renderZone('CET', cetStr, cetDay)}
      {!isLive && <span className="wc-offset-badge">{fmtOffsetLabel(offsetMin)}</span>}
    </div>
  )
}
