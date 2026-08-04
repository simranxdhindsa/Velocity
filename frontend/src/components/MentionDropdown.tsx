import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Search } from 'lucide-react'
import type { SlackWorkspaceUser } from '@/services/api'

/**
 * Portal dropdown listing Slack users, for "@ to mention" autocomplete.
 * Pair with `useMentionAutocomplete` — this is the render half only. Filtering
 * is driven by continuing to type after "@" in the composer itself — the
 * "Search members" row is a visual label, not a second independent input.
 */
export function MentionDropdown({
  results, activeIdx, style, onHover, onSelect,
}: {
  results: SlackWorkspaceUser[]
  activeIdx: number
  style: CSSProperties
  onHover: (idx: number) => void
  onSelect: (u: SlackWorkspaceUser) => void
}) {
  if (results.length === 0) return null

  return createPortal(
    <div className="cd-portal-menu" style={style}>
      <div className="mention-drop-search">
        <Search size={12} />
        Search members
      </div>
      <div className="cd-option-list" style={{ maxHeight: 200 }}>
        {results.map((u, idx) => {
          const name = u.profile.display_name || u.real_name
          return (
            <button
              key={u.id}
              type="button"
              className={`pm-dropdown-item${idx === activeIdx ? ' active' : ''}`}
              onMouseDown={e => { e.preventDefault(); onSelect(u) }}
              onMouseEnter={() => onHover(idx)}
            >
              {u.profile.image_48 && <img src={u.profile.image_48} className="mention-drop-avatar" alt="" />}
              <span>{name}</span>
              <span className="mention-drop-handle">@{u.name}</span>
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
