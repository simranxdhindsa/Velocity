import React, { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface HoverCardProps {
  content: React.ReactNode | null
  children: React.ReactNode
  delay?: number
  maxWidth?: number
}

export default function HoverCard({ content, children, delay = 280, maxWidth = 300 }: HoverCardProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0, above: true })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const show = useCallback(() => {
    if (!wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    const spaceAbove = rect.top
    const above = spaceAbove > 180
    let x = rect.left + rect.width / 2 - maxWidth / 2
    x = Math.max(8, Math.min(x, window.innerWidth - maxWidth - 8))
    const y = above ? rect.top - 8 : rect.bottom + 8
    setPos({ x, y, above })
    setVisible(true)
  }, [maxWidth])

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
  }, [])

  const startHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setVisible(false), 2000)
  }, [])

  const handleEnter = useCallback(() => {
    if (!content) return
    cancelHide()
    timerRef.current = setTimeout(show, delay)
  }, [show, delay, content, cancelHide])

  const handleLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    startHideTimer()
  }, [startHideTimer])

  return (
    <div
      ref={wrapRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ display: 'contents' }}
    >
      {children}
      {visible && createPortal(
        <div
          className={`hc-card${pos.above ? ' hc-card--above' : ' hc-card--below'}`}
          style={{ left: pos.x, top: pos.y, maxWidth }}
          onMouseEnter={cancelHide}
          onMouseLeave={startHideTimer}
        >
          {content}
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Reusable content blocks ──────────────────────────────────────────────────

export function HCRow({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="hc-row">
      <span className="hc-label">{label}</span>
      <span className={`hc-value${accent ? ` hc-value--${accent}` : ''}`}>{value}</span>
    </div>
  )
}

export function HCBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="hc-bar-track">
      <div className="hc-bar-fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
    </div>
  )
}

export function HCDivider() {
  return <div className="hc-divider" />
}

export function HCBadge({ label, variant }: { label: string; variant?: 'dev' | 'stg' | 'prd' | 'warn' | 'danger' | 'ok' }) {
  return <span className={`hc-badge${variant ? ` hc-badge--${variant}` : ''}`}>{label}</span>
}