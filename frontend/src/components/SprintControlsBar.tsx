import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, GitBranch, Check } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { YouTrackSprint } from '@/services/api'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModeOption {
  id:    string
  label: string
  icon:  LucideIcon
}

interface SprintControlsBarProps {
  modes:          ModeOption[]
  activeMode:     string
  onModeChange:   (id: string) => void
  sprints:        YouTrackSprint[]
  activeSprint:   YouTrackSprint | null
  onSprintChange: (sprint: YouTrackSprint) => void
  /** Slot for extra controls between spacer and sprint selector (e.g. refresh button) */
  children?:      React.ReactNode
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SprintControlsBar({
  modes, activeMode, onModeChange,
  sprints, activeSprint, onSprintChange,
  children,
}: SprintControlsBarProps) {
  const [modeOpen,   setModeOpen]   = useState(false)
  const [sprintOpen, setSprintOpen] = useState(false)

  const modeRef     = useRef<HTMLDivElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const sprintRef     = useRef<HTMLDivElement>(null)
  const sprintMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (modeOpen   && !modeRef.current?.contains(t)   && !modeMenuRef.current?.contains(t))   setModeOpen(false)
      if (sprintOpen && !sprintRef.current?.contains(t) && !sprintMenuRef.current?.contains(t)) setSprintOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [modeOpen, sprintOpen])

  const current      = modes.find(m => m.id === activeMode)
  const ActiveIcon   = current?.icon
  const sortedSprints = [...sprints].sort((a, b) => b.finish - a.finish)

  return (
    <div className="db-controls">

      {/* Left: mode selector */}
      <div ref={modeRef} className="db-design-selector">
        <button
          className="pm-custom-dropdown-trigger db-design-btn"
          onClick={() => setModeOpen(o => !o)}
        >
          {ActiveIcon && <ActiveIcon size={13} />}
          {current?.label}
          <ChevronDown size={11} style={{ opacity: 0.5 }} />
        </button>
        {modeOpen && createPortal(
          <div
            ref={modeMenuRef}
            className="pm-custom-dropdown-menu"
            style={{
              position: 'fixed',
              top:  (modeRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
              left: modeRef.current?.getBoundingClientRect().left ?? 0,
              minWidth: 180,
              zIndex: 9999,
            }}
          >
            {modes.map(m => {
              const Icon = m.icon
              return (
                <button
                  key={m.id}
                  className={`pm-dropdown-item${activeMode === m.id ? ' active' : ''}`}
                  onClick={() => { onModeChange(m.id); setModeOpen(false) }}
                >
                  <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>
                    {activeMode === m.id && <Check size={12} />}
                  </span>
                  <Icon size={12} style={{ marginRight: 6 }} />
                  {m.label}
                </button>
              )
            })}
          </div>,
          document.body
        )}
      </div>

      <div className="db-controls-spacer" />

      {/* Middle slot (e.g. refresh button) */}
      {children}

      {/* Right: sprint selector */}
      <div ref={sprintRef} className="db-sprint-selector">
        <button
          className="pm-custom-dropdown-trigger"
          onClick={() => setSprintOpen(o => !o)}
        >
          <GitBranch size={13} />
          {activeSprint
            ? <>{activeSprint.name}<span className="db-sprint-dates">{fmtDate(activeSprint.start)}–{fmtDate(activeSprint.finish)}</span></>
            : <span>Select sprint</span>
          }
          <ChevronDown size={11} style={{ opacity: 0.5 }} />
        </button>
        {sprintOpen && createPortal(
          <div
            ref={sprintMenuRef}
            className="pm-custom-dropdown-menu"
            style={{
              position: 'fixed',
              top:   (sprintRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
              right: window.innerWidth - (sprintRef.current?.getBoundingClientRect().right ?? 0),
              minWidth: 240,
              zIndex: 9999,
            }}
          >
            {sortedSprints.length === 0 && (
              <div style={{ padding: '9px 14px', fontSize: 13, opacity: 0.5 }}>No sprints found</div>
            )}
            {sortedSprints.map(s => (
              <button
                key={s.id}
                className={`pm-dropdown-item${activeSprint?.id === s.id ? ' active' : ''}`}
                onClick={() => { onSprintChange(s); setSprintOpen(false) }}
                style={{ opacity: s.isCompleted ? 0.6 : 1 }}
              >
                <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>
                  {activeSprint?.id === s.id && <Check size={12} />}
                </span>
                <span style={{ flex: 1 }}>{s.name}</span>
                <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 8 }}>
                  {fmtDate(s.start)}–{fmtDate(s.finish)}
                </span>
                {s.isCompleted && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>✓</span>}
              </button>
            ))}
          </div>,
          document.body
        )}
      </div>
    </div>
  )
}
