import { useState, useEffect, useRef } from 'react'
import api from '@/services/api'

interface Suggestion { id: string; summary: string }

interface Props {
  value: string
  onChange: (v: string) => void
  onSelect: (id: string) => void
  onConfirm: () => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

export function LinkTypeahead({ value, onChange, onSelect, onConfirm, placeholder = 'ARD-123 or search…', disabled, className }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // Debounced search
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const q = value.trim()
    if (!q || q.length < 2) { setSuggestions([]); setOpen(false); return }
    timerRef.current = setTimeout(async () => {
      try {
        const res = await api.searchYouTrackIssues(q) as { success: boolean; data: Suggestion[] }
        const data = res.data ?? (res as unknown as Suggestion[])
        if (Array.isArray(data) && data.length > 0) {
          setSuggestions(data)
          setOpen(true)
          setActive(-1)
        } else {
          setSuggestions([])
          setOpen(false)
        }
      } catch { setSuggestions([]); setOpen(false) }
    }, 280)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [value])

  // Outside click closes dropdown
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

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
    <div ref={boxRef} className="lta-wrap">
      <input
        className={`idp-link-target-input lta-input${className ? ' ' + className : ''}`}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKey}
        disabled={disabled}
        autoFocus
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div className="lta-dropdown">
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
        </div>
      )}
    </div>
  )
}
