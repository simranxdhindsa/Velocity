import { motion } from 'framer-motion'
import { Check } from 'lucide-react'

interface ChipOption {
  value:     string
  label:     string
  sublabel?: string
}

function initials(label: string): string {
  const parts = label.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/**
 * Card picker with a shared-layout sliding highlight (layoutId) behind the
 * active option — the same technique behind Linear/Vercel/Notion's tab
 * indicators. groupId must be unique per picker instance on the page so
 * multiple pickers don't share one animated highlight.
 */
export default function OnboardingChipSelect({
  groupId, label, options, value, onChange, loading, emptyText,
}: {
  groupId:    string
  label:      string
  options:    ChipOption[]
  value:      string
  onChange:   (v: string) => void
  loading?:   boolean
  emptyText?: string
}) {
  return (
    <motion.div
      className="ob-chipselect"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <div className="ob-chipselect-label">{label}</div>
      {loading ? (
        <div className="ob-chipselect-hint">Loading…</div>
      ) : options.length === 0 ? (
        <div className="ob-chipselect-hint">{emptyText ?? 'Nothing found'}</div>
      ) : (
        <div className="ob-chipselect-row">
          {options.map((opt, i) => {
            const active = opt.value === value
            return (
              <motion.button
                key={opt.value}
                type="button"
                className={`ob-chipcard ${active ? 'ob-chipcard--active' : ''}`}
                onClick={() => onChange(opt.value)}
                initial={{ opacity: 0, y: 10, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ delay: i * 0.07, duration: 0.32, ease: 'easeOut' }}
                whileHover={{ y: -3 }}
                whileTap={{ scale: 0.96 }}
              >
                {active && (
                  <motion.div
                    className="ob-chipcard-highlight"
                    layoutId={`${groupId}-highlight`}
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="ob-chipcard-avatar">{initials(opt.label)}</span>
                <span className="ob-chipcard-text">
                  <span className="ob-chipcard-title">{opt.label}</span>
                  {opt.sublabel && <span className="ob-chipcard-sub">{opt.sublabel}</span>}
                </span>
                {active && (
                  <motion.span
                    className="ob-chipcard-check"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 20 }}
                  >
                    <Check size={11} strokeWidth={3} />
                  </motion.span>
                )}
              </motion.button>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}
