import { useEffect, useState, type ReactNode } from 'react'
import {
  RefreshCw, Search, Users, ChevronDown, X, Check, Layers,
  ArrowDownUp, ArrowUpNarrowWide, ArrowDownNarrowWide,
  LayoutDashboard, CalendarDays, Rows3,
} from 'lucide-react'
import type { YouTrackSprint } from '../../services/api'
import type { FilterOption, SortKey, SwimlaneBy } from './board-filters'

type MenuKey = 'sprint' | 'assignee' | 'priority' | 'subsystem' | 'group' | 'sort'

const SORT_LABEL: Record<SortKey, string> = {
  newest: 'Newest first',
  priority: 'Priority',
  alpha: 'Alphabetical',
}

const SEARCH_THRESHOLD = 7

function fmtSprintDate(ms: number) {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function ticketWord(n: number) {
  return n === 1 ? 'ticket' : 'tickets'
}

function toggleIn(list: string[], name: string) {
  return list.includes(name) ? list.filter(x => x !== name) : [...list, name]
}

// ── Shared building blocks (module level so they keep a stable identity) ─────

interface MenuShellProps {
  id: MenuKey
  openMenu: MenuKey | null
  onOpenChange: (key: MenuKey | null) => void
  trigger: ReactNode
  active?: boolean
  align?: 'start' | 'end'
  children: ReactNode
}

function MenuShell({ id, openMenu, onOpenChange, trigger, active, align = 'start', children }: MenuShellProps) {
  const isOpen = openMenu === id
  return (
    <div className={`pm-custom-dropdown board-dd${align === 'end' ? ' board-dd--end' : ''}`}>
      <button
        type="button"
        className={`pm-custom-dropdown-trigger${active ? ' active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => onOpenChange(isOpen ? null : id)}
      >
        {trigger}
        <ChevronDown size={12} className={`dropdown-chevron ${isOpen ? 'open' : ''}`} />
      </button>
      {isOpen && <div className="pm-custom-dropdown-menu board-menu">{children}</div>}
    </div>
  )
}

function Dot({ color }: { color?: string }) {
  return <span className="board-priority-dot" style={color ? { background: color } : undefined} />
}

function Avatar({ name, src }: { name: string; src?: string }) {
  return src
    ? <img src={src} alt={name} className="filter-avatar-img" />
    : <span className="filter-avatar-placeholder">{name.charAt(0).toUpperCase()}</span>
}

interface OptionListProps {
  options: FilterOption[]
  selected: string[]
  allLabel: string
  onToggle: (name: string) => void
  onClearAll: () => void
  lead?: (option: FilterOption) => ReactNode
}

// Search + "All" row + scrolling list. Unmounts with its menu, so the query resets on close.
function OptionList({ options, selected, allLabel, onToggle, onClearAll, lead }: OptionListProps) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter(o => o.name.toLowerCase().includes(q)) : options

  return (
    <>
      {options.length > SEARCH_THRESHOLD && (
        <div className="board-menu-search">
          <Search size={12} />
          <input
            type="text"
            autoFocus
            placeholder="Search…"
            aria-label="Search options"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      )}
      <button
        type="button"
        className={`pm-dropdown-item${selected.length === 0 ? ' active' : ''}`}
        onClick={onClearAll}
      >
        <span className="board-menu-name">{allLabel}</span>
        {selected.length === 0 && <Check size={12} className="board-menu-check" />}
      </button>
      <div className="board-menu-divider" />
      <div className="board-menu-list" role="listbox">
        {shown.map(o => {
          const on = selected.includes(o.name)
          return (
            <button
              key={o.name}
              type="button"
              role="option"
              aria-selected={on}
              className={`pm-dropdown-item${on ? ' active' : ''}${o.count === 0 ? ' board-menu-item--empty' : ''}`}
              onClick={() => onToggle(o.name)}
            >
              {lead?.(o)}
              <span className="board-menu-name">{o.name}</span>
              <span className="board-menu-count">{o.count}</span>
              {on && <Check size={12} className="board-menu-check" />}
            </button>
          )
        })}
        {shown.length === 0 && <div className="board-menu-empty">No matches</div>}
      </div>
    </>
  )
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

export interface BoardToolbarProps {
  sourceLabel: string
  totalCount: number
  visibleCount: number
  /** True while some columns still have tickets that are not loaded yet. */
  hasMore: boolean
  filtered: boolean

  sprints: YouTrackSprint[]
  activeSprint: YouTrackSprint | null | undefined
  onSprintChange: (sprint: YouTrackSprint | null) => void
  syncing: boolean
  onRefresh: () => void

  search: string
  onSearchChange: (value: string) => void

  assignee: string
  assigneeOptions: FilterOption[]
  avatarMap: Record<string, string>
  onAssigneeChange: (value: string) => void

  priorityOptions: FilterOption[]
  selectedPriorities: string[]
  onPrioritiesChange: (values: string[]) => void

  subsystemOptions: FilterOption[]
  selectedSubsystems: string[]
  onSubsystemsChange: (values: string[]) => void

  swimlaneBy: SwimlaneBy
  swimlaneFieldName?: string
  onSwimlaneChange: (value: SwimlaneBy) => void

  sortKey: SortKey
  onSortChange: (value: SortKey) => void

  onClear: () => void
}

export function BoardToolbar(p: BoardToolbarProps) {
  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null)

  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.board-dd')) setOpenMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  const totalLabel = `${p.totalCount}${p.hasMore ? '+' : ''}`
  const scope = p.activeSprint ? p.activeSprint.name : p.sprints.length > 0 ? 'All sprints' : ''
  const groupLabel: Record<SwimlaneBy, string> = {
    none: 'No grouping',
    assignee: 'Assignee',
    priority: 'Priority',
    subsystem: 'Subsystem',
    board: p.swimlaneFieldName ?? 'Board',
  }
  // A board whose own swimlane field is Subsystem already offers it, with the board's lane order
  const canGroupBySubsystem = p.subsystemOptions.length > 0 && p.swimlaneFieldName?.toLowerCase() !== 'subsystem'
  const groupOptions: SwimlaneBy[] = [
    'none', 'assignee', 'priority',
    ...(canGroupBySubsystem ? ['subsystem' as const] : []),
    ...(p.swimlaneFieldName ? ['board' as const] : []),
  ]
  const sortOptions: { key: SortKey; Icon: typeof ArrowDownNarrowWide }[] = [
    { key: 'newest', Icon: ArrowDownNarrowWide },
    { key: 'priority', Icon: ArrowUpNarrowWide },
    { key: 'alpha', Icon: ArrowDownUp },
  ]

  const priorityColor = (name: string) => p.priorityOptions.find(o => o.name === name)?.color

  return (
    <div className="board-toolbar">
      {/* ── Header: what this is, how much is on it, and which sprint ───────── */}
      <div className="board-toolbar-head">
        <div className="board-title-block">
          <span className="board-title-icon"><LayoutDashboard size={18} /></span>
          <div className="board-title-text">
            <h3 className="board-title">Board</h3>
            <div className="board-subtitle">
              <span
                className="board-subtitle-count"
                title={p.hasMore ? 'Tickets loaded so far. Some columns have more to load.' : 'Tickets on this board'}
              >
                {p.filtered
                  ? <><strong>{p.visibleCount}</strong> of {totalLabel} {ticketWord(p.totalCount)}</>
                  : <><strong>{totalLabel}</strong> {ticketWord(p.totalCount)}</>}
              </span>
              {scope && <><span className="board-subtitle-dot">·</span><span className="board-subtitle-scope">{scope}</span></>}
            </div>
          </div>
        </div>

        <div className="board-head-actions">
          {p.sprints.length > 0 && (
            <MenuShell
              id="sprint"
              openMenu={openMenu}
              onOpenChange={setOpenMenu}
              align="end"
              trigger={
                <>
                  <CalendarDays size={14} />
                  <span className="board-trigger-strong">{p.activeSprint ? p.activeSprint.name : 'All sprints'}</span>
                  {p.activeSprint && (
                    <span className="board-trigger-muted">
                      {fmtSprintDate(p.activeSprint.start)} – {fmtSprintDate(p.activeSprint.finish)}
                    </span>
                  )}
                </>
              }
            >
              <button
                type="button"
                className={`pm-dropdown-item${!p.activeSprint ? ' active' : ''}`}
                onClick={() => { p.onSprintChange(null); setOpenMenu(null) }}
              >
                <CalendarDays size={14} /><span className="board-menu-name">All sprints</span>
              </button>
              <div className="board-menu-divider" />
              <div className="board-menu-list">
                {[...p.sprints].sort((a, b) => b.start - a.start).map(s => (
                  <button
                    key={s.id}
                    type="button"
                    className={`pm-dropdown-item${p.activeSprint?.id === s.id ? ' active' : ''}`}
                    onClick={() => { p.onSprintChange(s); setOpenMenu(null) }}
                  >
                    <span className="board-menu-name">
                      {s.isCompleted && <span className="board-menu-done">✓ </span>}{s.name}
                    </span>
                    <span className="board-menu-count">{fmtSprintDate(s.start)} – {fmtSprintDate(s.finish)}</span>
                  </button>
                ))}
              </div>
            </MenuShell>
          )}
          <button
            type="button"
            className="btn-secondary btn-sm board-refresh"
            onClick={p.onRefresh}
            disabled={p.syncing}
            title={`Refresh from ${p.sourceLabel}`}
          >
            <RefreshCw size={14} className={p.syncing ? 'animate-spin' : ''} />
            {p.syncing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Filters narrow the board, view options change how it is laid out ─── */}
      <div className="board-filter-row">
        <div className="board-filter-group">
          <div className="pm-search-box board-search">
            <Search size={13} />
            <input
              type="text"
              placeholder="Search tickets…"
              aria-label="Search tickets"
              value={p.search}
              onChange={e => p.onSearchChange(e.target.value)}
            />
          </div>

          <MenuShell
            id="assignee"
            openMenu={openMenu}
            onOpenChange={setOpenMenu}
            active={p.assignee !== ''}
            trigger={
              p.assignee
                ? <><Avatar name={p.assignee} src={p.avatarMap[p.assignee]} /><span className="board-trigger-strong">{p.assignee}</span></>
                : <><Users size={14} /><span>Assignee</span></>
            }
          >
            <OptionList
              options={p.assigneeOptions}
              selected={p.assignee ? [p.assignee] : []}
              allLabel="All assignees"
              lead={o => <Avatar name={o.name} src={p.avatarMap[o.name]} />}
              onToggle={name => { p.onAssigneeChange(name === p.assignee ? '' : name); setOpenMenu(null) }}
              onClearAll={() => { p.onAssigneeChange(''); setOpenMenu(null) }}
            />
          </MenuShell>

          {p.priorityOptions.length > 0 && (
            <MenuShell
              id="priority"
              openMenu={openMenu}
              onOpenChange={setOpenMenu}
              active={p.selectedPriorities.length > 0}
              trigger={
                <>
                  <ArrowUpNarrowWide size={14} />
                  {p.selectedPriorities.length === 1 && <Dot color={priorityColor(p.selectedPriorities[0])} />}
                  <span className={p.selectedPriorities.length === 1 ? 'board-trigger-strong' : undefined}>
                    {p.selectedPriorities.length === 1 ? p.selectedPriorities[0] : 'Priority'}
                  </span>
                  {p.selectedPriorities.length > 1 && <span className="board-filter-count">{p.selectedPriorities.length}</span>}
                </>
              }
            >
              <OptionList
                options={p.priorityOptions}
                selected={p.selectedPriorities}
                allLabel="All priorities"
                lead={o => <Dot color={o.color} />}
                onToggle={name => p.onPrioritiesChange(toggleIn(p.selectedPriorities, name))}
                onClearAll={() => p.onPrioritiesChange([])}
              />
            </MenuShell>
          )}

          {p.subsystemOptions.length > 0 && (
            <MenuShell
              id="subsystem"
              openMenu={openMenu}
              onOpenChange={setOpenMenu}
              active={p.selectedSubsystems.length > 0}
              trigger={
                <>
                  <Layers size={14} />
                  <span className={p.selectedSubsystems.length === 1 ? 'board-trigger-strong' : undefined}>
                    {p.selectedSubsystems.length === 1 ? p.selectedSubsystems[0] : 'Subsystem'}
                  </span>
                  {p.selectedSubsystems.length > 1 && <span className="board-filter-count">{p.selectedSubsystems.length}</span>}
                </>
              }
            >
              <OptionList
                options={p.subsystemOptions}
                selected={p.selectedSubsystems}
                allLabel="All subsystems"
                lead={o => <Dot color={o.color} />}
                onToggle={name => p.onSubsystemsChange(toggleIn(p.selectedSubsystems, name))}
                onClearAll={() => p.onSubsystemsChange([])}
              />
            </MenuShell>
          )}

          {p.filtered && (
            <button type="button" className="btn-sm btn-ghost tl-clear-filters" onClick={p.onClear}>
              <X size={12} /> Clear filters
            </button>
          )}
        </div>

        <div className="board-filter-group board-filter-group--view">
          <MenuShell
            id="group"
            openMenu={openMenu}
            onOpenChange={setOpenMenu}
            align="end"
            active={p.swimlaneBy !== 'none'}
            trigger={
              <>
                <Rows3 size={14} />
                <span>{p.swimlaneBy === 'none' ? 'Group by' : <>Group: <strong>{groupLabel[p.swimlaneBy]}</strong></>}</span>
              </>
            }
          >
            {groupOptions.map(key => (
              <button
                key={key}
                type="button"
                className={`pm-dropdown-item${p.swimlaneBy === key ? ' active' : ''}`}
                onClick={() => { p.onSwimlaneChange(key); setOpenMenu(null) }}
              >
                <span className="board-menu-name">{groupLabel[key]}{key === 'board' ? ' (Board)' : ''}</span>
                {p.swimlaneBy === key && <Check size={12} className="board-menu-check" />}
              </button>
            ))}
          </MenuShell>

          <MenuShell
            id="sort"
            openMenu={openMenu}
            onOpenChange={setOpenMenu}
            align="end"
            trigger={
              <>
                <ArrowDownUp size={14} />
                <span>Sort: <strong>{SORT_LABEL[p.sortKey]}</strong></span>
              </>
            }
          >
            {sortOptions.map(({ key, Icon }) => (
              <button
                key={key}
                type="button"
                className={`pm-dropdown-item${p.sortKey === key ? ' active' : ''}`}
                onClick={() => { p.onSortChange(key); setOpenMenu(null) }}
              >
                <Icon size={14} />
                <span className="board-menu-name">{SORT_LABEL[key]}</span>
                {p.sortKey === key && <Check size={12} className="board-menu-check" />}
              </button>
            ))}
          </MenuShell>
        </div>
      </div>
    </div>
  )
}

// ── Skeleton — mirrors the real header and filter row ────────────────────────

const Sk = ({ w, h, r = 8 }: { w: number | string; h: number; r?: number | string }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
)

export function BoardToolbarSkeleton() {
  return (
    <div className="board-toolbar board-toolbar--skeleton">
      <div className="board-toolbar-head">
        <div className="board-title-block">
          <Sk w={34} h={34} r={10} />
          <div className="board-title-text">
            <Sk w={72} h={15} r={4} />
            <Sk w={150} h={11} r={4} />
          </div>
        </div>
        <div className="board-head-actions">
          <Sk w={200} h={30} />
          <Sk w={92} h={30} />
        </div>
      </div>
      <div className="board-filter-row">
        <div className="board-filter-group">
          <Sk w={190} h={30} />
          <Sk w={104} h={30} />
          <Sk w={92} h={30} />
          <Sk w={108} h={30} />
        </div>
        <div className="board-filter-group board-filter-group--view">
          <Sk w={100} h={30} />
          <Sk w={150} h={30} />
        </div>
      </div>
    </div>
  )
}
