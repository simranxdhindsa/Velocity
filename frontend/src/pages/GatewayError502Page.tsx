import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useGatewayError } from '@/contexts/GatewayErrorContext'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

const MESSAGES = [
  'Something new is on its way.',
  'Good things take a moment.',
  'Making Velocity faster for you.',
  'New release in progress.',
  'Almost ready for you.',
  'Preparing your workspace.',
  'Hold tight — great things are loading.',
  'Your data is safe and sound.',
  'We\'re leveling up in the background.',
  'Fresh features, incoming.',
]

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api'

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

// Floating particle — drifts upward and fades
function Particle({ x, delay, duration }: { x: number; delay: number; duration: number }) {
  return (
    <motion.div
      className="g5-particle"
      style={{ left: `${x}%` }}
      initial={{ y: 0, opacity: 0, scale: 0.6 }}
      animate={{ y: -320, opacity: [0, 0.6, 0], scale: [0.6, 1, 0.4] }}
      transition={{ duration, delay, repeat: Infinity, ease: 'easeOut' }}
    />
  )
}

const PARTICLES = [
  { x: 12, delay: 0, duration: 5.5 },
  { x: 28, delay: 1.2, duration: 6.8 },
  { x: 47, delay: 0.4, duration: 4.9 },
  { x: 63, delay: 2.1, duration: 7.2 },
  { x: 78, delay: 0.8, duration: 5.1 },
  { x: 88, delay: 1.8, duration: 6.3 },
  { x: 35, delay: 3.2, duration: 5.8 },
  { x: 55, delay: 2.7, duration: 4.6 },
]

export default function GatewayError502Page() {
  const { clear } = useGatewayError()
  const [msgQueue] = useState(() => shuffle(MESSAGES))
  const [msgIndex, setMsgIndex] = useState(0)
  const checkingRef = useRef(false)

  const probe = async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    try {
      const res = await fetch(`${API_URL}/health`, { method: 'GET', cache: 'no-store' })
      if (res.ok || res.status < 500) { clear(); return }
    } catch { /* still down */ }
    checkingRef.current = false
  }

  useEffect(() => {
    probe()
    const interval = setInterval(probe, 2000)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const interval = setInterval(() => setMsgIndex(i => (i + 1) % msgQueue.length), 4000)
    return () => clearInterval(interval)
  }, [msgQueue.length])

  return (
    <div className="g5-root">
      {/* Animated background blobs */}
      <div className="g5-blob g5-blob-1" />
      <div className="g5-blob g5-blob-2" />
      <div className="g5-blob g5-blob-3" />

      {/* Floating particles */}
      <div className="g5-particles">
        {PARTICLES.map((p, i) => <Particle key={i} {...p} />)}
      </div>

      <div className="g5-center">
        {/* Orbit system */}
        <div className="g5-orbit-system">
          {/* Outer ring — clockwise */}
          <motion.div
            className="g5-orbit g5-orbit-outer"
            animate={{ rotate: 360 }}
            transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
          >
            <div className="g5-orbit-dot g5-orbit-dot--primary" />
          </motion.div>

          {/* Middle ring — counter-clockwise */}
          <motion.div
            className="g5-orbit g5-orbit-mid"
            animate={{ rotate: -360 }}
            transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
          >
            <div className="g5-orbit-dot g5-orbit-dot--accent" />
          </motion.div>

          {/* Inner glow ring — slow CW */}
          <motion.div
            className="g5-orbit g5-orbit-inner"
            animate={{ rotate: 360 }}
            transition={{ duration: 22, repeat: Infinity, ease: 'linear' }}
          >
            <div className="g5-orbit-dot g5-orbit-dot--muted" />
          </motion.div>

          {/* Logo — breathe */}
          <motion.div
            className="g5-logo-wrap"
            animate={{ scale: [1, 1.06, 1] }}
            transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            <VelocityLogo variant="icon" size="xl" mark="chevron" showStatusDot={false} />
          </motion.div>
        </div>

        {/* Brand name */}
        <motion.p
          className="g5-brand"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.5 }}
        >
          Velocity
        </motion.p>

        {/* Rotating status message */}
        <div className="g5-message-wrap">
          <AnimatePresence mode="wait">
            <motion.p
              key={msgIndex}
              className="g5-message"
              initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            >
              {msgQueue[msgIndex]}
            </motion.p>
          </AnimatePresence>
        </div>

        {/* Shimmer scanner */}
        <motion.div
          className="g5-scanner-track"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
        >
          <motion.div
            className="g5-scanner-glow"
            animate={{ x: ['-100%', '200%'] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut', repeatDelay: 0.6 }}
          />
        </motion.div>
      </div>
    </div>
  )
}
