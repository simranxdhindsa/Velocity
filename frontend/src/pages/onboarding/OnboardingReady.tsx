import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Mic, PinOff, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react'

interface Tip {
  icon: LucideIcon
  text: string
}

const TIPS: Tip[] = [
  { icon: Mic,       text: 'Use the mic icon anywhere you see it — speak tasks and notes instead of typing.' },
  { icon: PinOff,    text: 'Park any blocked ticket to hide it across every view, without closing it in YouTrack.' },
  { icon: RefreshCw, text: 'Switch your active PM data source anytime from Integrations at the top of the page.' },
  { icon: Sparkles,  text: 'Ask the Assistant tab anything about your sprint — it speaks fluent YQL.' },
]

function Particle({ x, delay, duration }: { x: number; delay: number; duration: number }) {
  return (
    <motion.div
      className="ob-ready-particle"
      style={{ left: `${x}%` }}
      initial={{ y: 0, opacity: 0, scale: 0.5 }}
      animate={{ y: -220, opacity: [0, 1, 0], scale: [0.5, 1, 0.3] }}
      transition={{ duration, delay, repeat: Infinity, ease: 'easeOut' }}
    />
  )
}

const PARTICLES = [
  { x: 15, delay: 0,   duration: 3.2 },
  { x: 35, delay: 0.6, duration: 3.8 },
  { x: 55, delay: 0.2, duration: 3.0 },
  { x: 75, delay: 0.9, duration: 3.6 },
  { x: 90, delay: 0.4, duration: 3.4 },
]

export default function OnboardingReady({ onFinish }: { onFinish: () => void }) {
  const [tipIndex, setTipIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTipIndex(i => (i + 1) % TIPS.length), 3200)
    return () => clearInterval(interval)
  }, [])

  const Tip = TIPS[tipIndex].icon

  return (
    <motion.div
      className="ob-step ob-step-ready"
      initial={{ opacity: 0, y: 16, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -16, filter: 'blur(4px)' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <div className="ob-ready-particles">
        {PARTICLES.map((p, i) => <Particle key={i} {...p} />)}
      </div>

      <motion.div
        className="ob-ready-badge"
        initial={{ scale: 0 }}
        animate={{ scale: [0, 1.15, 1] }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        ✓
      </motion.div>

      <h2 className="ob-heading">You're all set</h2>

      <div className="ob-tip-wrap">
        <AnimatePresence mode="wait">
          <motion.div
            key={tipIndex}
            className="ob-tip"
            initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
            transition={{ duration: 0.5 }}
          >
            <Tip size={18} />
            <span>{TIPS[tipIndex].text}</span>
          </motion.div>
        </AnimatePresence>
      </div>

      <motion.button
        className="ob-btn ob-btn-primary ob-btn-lg"
        onClick={onFinish}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        Enter Velocity →
      </motion.button>
    </motion.div>
  )
}
