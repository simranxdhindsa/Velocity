import React, { useRef, useEffect, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search } from 'lucide-react'

export interface DropdownOption<T extends string = string> {
  value: T
  label: string
  icon?: React.ReactNode
}

interface CustomDropdownProps<T extends string = string> {
  options: DropdownOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Icon shown before the label in the trigger */
  icon?: React.ReactNode
  /** Shown when value matches none of the options (e.g. "All Devs") */
  placeholder?: string
  className?: string
  /**
   * Show a search box + fixed-height scrollable list.
   * Defaults to true when options.length > 7.
   */
  searchable?: boolean
  /** Max-height of the scrollable option list in px. Default 200. */
  menuMaxHeight?: number
}

/**
 * Reusable dropdown following the pm-custom-dropdown pattern.
 * Menu renders in a portal so it always floats above everything.
 * Automatically enables search when options exceed 7.
 */
export function CustomDropdown<T extends string = string>({
  options,
  value,
  onChange,
  icon,
  placeholder,
  className = '',
  searchable,
  menuMaxHeight = 200,
}: CustomDropdownProps<T>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const showSearch = searchable ?? options.length > 7

  // Position menu under trigger on open
  useEffect(() => {
    if (!open) { setSearch(''); return }

    const positionMenu = () => {
      if (!triggerRef.current) return
      const rect = triggerRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const menuHeight = menuRef.current?.offsetHeight ?? 260

      // Flip above if not enough space below
      if (spaceBelow < menuHeight + 8 && rect.top > menuHeight + 8) {
        setMenuStyle({
          top: rect.top - menuHeight - 4,
          left: rect.left,
          width: rect.width,
        })
      } else {
        setMenuStyle({
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
        })
      }
    }

    positionMenu()
    window.addEventListener('scroll', positionMenu, true)
    window.addEventListener('resize', positionMenu)
    return () => {
      window.removeEventListener('scroll', positionMenu, true)
      window.removeEventListener('resize', positionMenu)
    }
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Auto-focus search on open
  useEffect(() => {
    if (open && showSearch) {
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open, showSearch])

  const filtered = useMemo(() => {
    if (!search) return options
    const q = search.toLowerCase()
    return options.filter(o => o.label.toLowerCase().includes(q))
  }, [options, search])

  const current = options.find(o => o.value === value)
  const label = current?.label ?? placeholder ?? value

  const menu = open ? (
    <div
      ref={menuRef}
      className="cd-portal-menu"
      style={menuStyle}
    >
      {showSearch && (
        <div className="cd-search-row">
          <Search size={12} className="cd-search-icon" />
          <input
            ref={searchRef}
            className="cd-search-input"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      )}
      <div
        className="cd-option-list"
        style={showSearch ? { maxHeight: menuMaxHeight } : undefined}
      >
        {filtered.length === 0
          ? <div className="cd-no-results">No results</div>
          : filtered.map(opt => (
            <button
              key={opt.value}
              className={`pm-dropdown-item${value === opt.value ? ' active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))
        }
      </div>
    </div>
  ) : null

  return (
    <div className={`pm-custom-dropdown ${className}`.trim()}>
      <button
        ref={triggerRef}
        className="pm-custom-dropdown-trigger"
        onClick={() => setOpen(o => !o)}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown size={11} className={`dropdown-chevron${open ? ' open' : ''}`} />
      </button>
      {createPortal(menu, document.body)}
    </div>
  )
}
