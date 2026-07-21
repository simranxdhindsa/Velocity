import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import api from '@/services/api'

interface Suggestion { id: string; summary: string }

interface Props {
  value: string
  onChange: (v: string) => void
  onSelect: (id: string) => void
  onConfirm: () => void
  placeholder?: string
  disabled?: boolean
}

// Build the right YQL query from raw user input
function buildQuery(raw: string): string {
  const t = raw.trim()
  const upper = t.toUpperCase()
  // Full issue ID e.g. "ard-2355" or "ARD-2355"
  if (/^[A-Za-z]+-\d+$/.test(t)) return `#${upper}`
  // Free-text — sort newest first so recently created tickets surface
  return `${t} sort by: created desc`
}

export function LinkTypeahead({ value, onChange, onSelect, onConfirm, placeholder = 'Search ticket…', disabled }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const updatePos = () => {
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect()
      setDropPos({ top: r.bottom + 4, left: r.left, width: r.width })
    }
  }

  const search = useCallback(async (q: string) => {
    try {
      const res = await api.searchYouTrackIssues(q) as { success: boolean; data: Suggestion[] }
      const data = res.data ?? (res as unknown as Suggestion[])
      if (Array.isArray(data) && data.length > 0) {
        updatePos()
        setSuggestions(data)
        setOpen(true)
        setActive(-1)
      } else {
        setSuggestions([])
        setOpen(false)
      }
    } catch {
      setSuggestions([])
      setOpen(false)
    }
  }, [])

  // Debounced search on input change
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const q = value.trim()
    if (!q || q.length < 2) { setSuggestions([]); setOpen(false); return }
    timerRef.current = setTimeout(() => search(buildQuery(q)), 280)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [value, search])

  // Outside click closes dropdown
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!inputRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // Show recent tickets on focus when input is empty
  const handleFocus = async () => {
    if (value.trim().length >= 2) return
    await search('sort by: created desc')
  }

  const pick = (s: Suggestion) => {
    onSelect(s.id)
    setSuggestions([])
    setOpen(false)
    setActive(-1)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, suggestions.length - 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return }
      if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(suggestions[active]); return }
      if (e.key === 'Escape') { setOpen(false); return }
    }
    if (e.key === 'Enter') onConfirm()
  }

  return (
    <>
      <input
        ref={inputRef}
        className="idp-link-target-input lta-input"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKey}
        onFocus={handleFocus}
        disabled={disabled}
        autoFocus
        autoComplete="off"
      />
      {open && suggestions.length > 0 && createPortal(
        <div
          className="lta-dropdown"
          style={{ top: dropPos.top, left: dropPos.left, width: Math.max(dropPos.width, 280) }}
        >
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              className={`lta-option${i === active ? ' lta-option--active' : ''}`}
              onMouseDown={e => { e.preventDefault(); pick(s) }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="lta-option-id">{s.id}</span>
              <span className="lta-option-summary">{s.summary}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
