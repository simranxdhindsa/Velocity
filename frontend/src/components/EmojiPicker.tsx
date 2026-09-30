import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import '@/styles/components/emoji-picker.css'

interface EmojiPickerProps {
  emojis: string[]
  value: string
  onChange: (emoji: string) => void
  placeholder?: string
}

/**
 * A trigger button + portal grid popover for picking one emoji from a fixed,
 * curated list. Never accepts free-text emoji input — the list passed in is
 * the only thing selectable, so a caller that only offers a safe allow-list
 * can guarantee nothing else gets through.
 */
export function EmojiPicker({ emojis, value, onChange, placeholder = 'Pick an icon' }: EmojiPickerProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    // The popover is positioned once (fixed, computed from the trigger's rect at open time)
    // and doesn't track the trigger on scroll, so scrolling the page or an ancestor panel
    // behind it would leave it floating over the wrong spot — close it in that case. But
    // scrolling the emoji grid's own internal scrollbar must NOT close it (scroll events
    // bubble up through the capture phase, so without this check every scroll inside the
    // popover itself would also trigger a close).
    const handleScroll = (e: Event) => {
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('scroll', handleScroll, { capture: true })
    }
  }, [open])

  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 6, left: rect.left })
    }
    setOpen(o => !o)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`emj-trigger${value ? ' emj-trigger--filled' : ''}`}
        onClick={toggle}
        title={placeholder}
      >
        {value || <span className="emj-trigger-placeholder">🙂</span>}
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              key="emj-popover"
              ref={popoverRef}
              className="emj-popover"
              style={{ top: pos.top, left: pos.left }}
              initial={{ opacity: 0, y: -6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.96 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <div className="emj-popover-label">{placeholder}</div>
              <div className="emj-scroll">
                <div className="emj-grid">
                  {emojis.map(e => (
                    <button
                      key={e}
                      type="button"
                      className={`emj-cell${value === e ? ' emj-cell--selected' : ''}`}
                      onClick={() => { onChange(e); setOpen(false) }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

export default EmojiPicker
