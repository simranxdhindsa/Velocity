import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Sparkles, Star, Zap, Bug, Wrench } from 'lucide-react'
import type { ChangelogEntry } from '../../services/api'
import api from '../../services/api'
import { VelocityLogo } from '../brand/VelocityLogo'

// Changelog bullets are Markdown; render `tool_name` spans as inline code so
// tool names read the same here as on GitHub/GitLab.
function renderInlineCode(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`')
      ? <code key={i} className="cl-code">{part.slice(1, -1)}</code>
      : part,
  )
}

interface Props {
  anchorRect: DOMRect
  entries: ChangelogEntry[]
  onClose: () => void
}

const SECTIONS = [
  { key: 'features'     as const, label: 'Features',     Icon: Star,     cls: 'cl-sec--feature'  },
  { key: 'enhancements' as const, label: 'Enhancements', Icon: Zap,      cls: 'cl-sec--enhance'  },
  { key: 'bugs'         as const, label: 'Bug Fixes',    Icon: Bug,      cls: 'cl-sec--bug'      },
  { key: 'refactors'    as const, label: 'Refactors',    Icon: Wrench,   cls: 'cl-sec--refactor' },
] as const

export default function ChangelogPanel({ anchorRect, entries, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.markChangelogSeen().catch(() => {})
  }, [])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])

  const right = window.innerWidth - anchorRect.right
  const top   = anchorRect.bottom + 8

  return createPortal(
    <div
      ref={panelRef}
      className="cl-panel"
      style={{ position: 'fixed', top, right, zIndex: 9999 }}
    >
      {/* Header */}
      <div className="cl-panel-header">
        <div className="cl-panel-title">
          <Sparkles size={14} />
          What's New
        </div>
        <button className="cl-panel-close" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="cl-panel-body">
        {entries.length === 0 && (
          <div className="cl-empty">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
              <VelocityLogo variant="icon" size="md" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            <p>No changelog entries yet.</p>
          </div>
        )}
        {entries.map((entry, idx) => (
          <div key={entry.date} className="cl-entry">
            {/* Date heading + badge */}
            <div className="cl-entry-meta">
              <span className="cl-entry-date">{formatDate(entry.date)}</span>
              {idx === 0 && <span className="cl-badge">Latest</span>}
            </div>

            {/* Sections */}
            {SECTIONS.map(({ key, label, Icon, cls }) => {
              const items = entry[key]
              if (!items?.length) return null
              return (
                <div key={key} className="cl-section">
                  <div className={`cl-section-header ${cls}`}>
                    <span className={`cl-section-icon ${cls}`}>
                      <Icon size={10} />
                    </span>
                    {label}
                  </div>
                  <ul className="cl-items">
                    {items.map((item, i) => (
                      <li key={i} className="cl-item">{renderInlineCode(item)}</li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body
  )
}

function formatDate(iso: string) {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}
