import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ListChecks } from 'lucide-react'

/**
 * Small popover shown right after a multi-line paste into a single-line
 * input, asking whether to split it into N separate items or keep it as one.
 * Dismissing (outside click / Escape) defaults to "keep as one" so the
 * pasted text is never silently discarded.
 */
export function PasteSplitPrompt({
  anchorRect, count, onSplit, onKeepOne,
}: {
  anchorRect: DOMRect
  count: number
  onSplit: () => void
  onKeepOne: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onKeepOne()
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onKeepOne() }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onKeepOne])

  return createPortal(
    <motion.div
      ref={ref}
      className="paste-split-prompt"
      style={{ top: anchorRect.bottom + 6, left: anchorRect.left, minWidth: Math.max(anchorRect.width, 220) }}
      initial={{ opacity: 0, y: -6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.96 }}
      transition={{ duration: 0.15 }}
    >
      <div className="paste-split-prompt-text">
        <ListChecks size={14} />
        Split into {count} tasks?
      </div>
      <div className="paste-split-prompt-actions">
        <button className="paste-split-btn paste-split-btn--primary" onClick={onSplit}>
          Split into {count}
        </button>
        <button className="paste-split-btn" onClick={onKeepOne}>Keep as one</button>
      </div>
    </motion.div>,
    document.body,
  )
}
