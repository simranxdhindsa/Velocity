import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { Check } from 'lucide-react'

const PHASES = [
  'Saving your setup',
  'Syncing YouTrack and Slack',
  'Personalizing your workspace',
]

const RING_R = 70
const RING_C = 2 * Math.PI * RING_R

const RING_MS   = 2200
const HOLD_MS   = 700
const EXIT_MS   = 700
const PHASE_MS  = RING_MS / PHASES.length

function Burst({ x, angle, delay }: { x: number; angle: number; delay: number }) {
  const rad = (angle * Math.PI) / 180
  return (
    <motion.div
      className="obc-burst-particle"
      initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
      animate={{ x: Math.cos(rad) * x, y: Math.sin(rad) * x, opacity: 0, scale: 0.3 }}
      transition={{ duration: 0.7, delay, ease: 'easeOut' }}
    />
  )
}

const BURST_PARTICLES = Array.from({ length: 12 }).map((_, i) => ({
  angle: (360 / 12) * i,
  x: 70 + (i % 3) * 12,
  delay: (i % 4) * 0.03,
}))

export default function OnboardingComplete({ onDone }: { onDone: () => void }) {
  const [phaseIdx, setPhaseIdx]   = useState(0)
  const [done,     setDone]       = useState(false)
  const [exiting,  setExiting]    = useState(false)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    PHASES.forEach((_, i) => {
      if (i === 0) return
      timers.push(setTimeout(() => setPhaseIdx(i), PHASE_MS * i))
    })
    timers.push(setTimeout(() => setDone(true), RING_MS))
    timers.push(setTimeout(() => setExiting(true), RING_MS + HOLD_MS))
    timers.push(setTimeout(() => onDone(), RING_MS + HOLD_MS + EXIT_MS))
    return () => timers.forEach(clearTimeout)
  }, [onDone])

  return (
    <motion.div
      className="obc-root"
      initial={{ opacity: 0 }}
      animate={exiting
        ? { opacity: 0, scale: 1.08, filter: 'blur(16px)' }
        : { opacity: 1, scale: 1, filter: 'blur(0px)' }}
      transition={exiting ? { duration: EXIT_MS / 1000, ease: 'easeInOut' } : { duration: 0.4 }}
    >
      <div className="obc-blob obc-blob-1" />
      <div className="obc-blob obc-blob-2" />

      <div className="obc-center">
        <div className="obc-ring-wrap">
          <svg className="obc-ring-svg" viewBox="0 0 160 160">
            <circle className="obc-ring-track" cx="80" cy="80" r={RING_R} />
            <motion.circle
              className="obc-ring-progress"
              cx="80" cy="80" r={RING_R}
              strokeDasharray={RING_C}
              initial={{ strokeDashoffset: RING_C }}
              animate={{ strokeDashoffset: 0 }}
              transition={{ duration: RING_MS / 1000, ease: 'linear' }}
            />
          </svg>

          <div className="obc-ring-content">
            <AnimatePresence>
              {!done ? (
                <motion.div
                  key="logo"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: [1, 1.05, 1] }}
                  exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.25, ease: 'easeIn' } }}
                  transition={{ scale: { duration: 1.2, repeat: Infinity, ease: 'easeInOut' } }}
                >
                  <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} />
                </motion.div>
              ) : (
                <motion.div
                  key="check"
                  className="obc-check-badge"
                  initial={{ scale: 0, rotate: -45 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 18 }}
                >
                  <Check size={30} strokeWidth={3} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {done && (
            <div className="obc-burst">
              {BURST_PARTICLES.map((p, i) => <Burst key={i} {...p} />)}
            </div>
          )}
        </div>

        <div className="obc-text-wrap">
          <AnimatePresence mode="wait">
            <motion.p
              key={done ? 'ready' : phaseIdx}
              className="obc-text"
              initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
              transition={{ duration: 0.4 }}
            >
              {done ? "You're in" : PHASES[phaseIdx] + '…'}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}
