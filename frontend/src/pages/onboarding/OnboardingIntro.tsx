import { useState } from 'react'
import { motion } from 'framer-motion'
import { Zap, Activity, RefreshCw, MessageSquare, type LucideIcon } from 'lucide-react'

interface Feature {
  key:   string
  icon:  LucideIcon
  title: string
  blurb: string
}

const FEATURES: Feature[] = [
  { key: 'sprint', icon: Zap,           title: 'Sprint Pulse',    blurb: 'Live priority swimlanes, kanban, and focus views that track every ticket in real time.' },
  { key: 'ops',    icon: Activity,      title: 'Daily Ops',       blurb: 'See developer load, stuck tickets, and hotfixes across the whole team at a glance.' },
  { key: 'sync',   icon: RefreshCw,     title: 'YouTrack Sync',   blurb: 'Two-way sync — create, edit, and track tickets without leaving Velocity.' },
  { key: 'slack',  icon: MessageSquare, title: 'Slack Updates',   blurb: 'Automated standups and reminders posted straight to your team channel.' },
]

function FeatureCard({ feature, index }: { feature: Feature; index: number }) {
  const [flipped, setFlipped] = useState(false)
  const Icon = feature.icon

  return (
    <motion.div
      className="ob-fcard"
      initial={{ opacity: 0, y: 24, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: 0.15 + index * 0.1, duration: 0.45, ease: 'easeOut' }}
      whileHover={{ y: -6 }}
      onClick={() => setFlipped(f => !f)}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setFlipped(f => !f) }}
    >
      <motion.div
        className="ob-fcard-inner"
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.5, ease: 'easeInOut' }}
      >
        <div className="ob-fcard-face ob-fcard-front">
          <div className="ob-fcard-icon"><Icon size={22} /></div>
          <div className="ob-fcard-title">{feature.title}</div>
          <div className="ob-fcard-hint">Tap to learn more</div>
        </div>
        <div className="ob-fcard-face ob-fcard-back">
          <div className="ob-fcard-blurb">{feature.blurb}</div>
        </div>
      </motion.div>
    </motion.div>
  )
}

export default function OnboardingIntro({ onNext }: { onNext: () => void }) {
  return (
    <motion.div
      className="ob-step ob-step-intro"
      initial={{ opacity: 0, y: 16, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -16, filter: 'blur(4px)' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <h2 className="ob-heading">What is Velocity?</h2>
      <p className="ob-sub">One workspace for sprint tracking, daily standups, and YouTrack + Slack — built for how your team actually ships.</p>

      <div className="ob-fcard-grid">
        {FEATURES.map((f, i) => <FeatureCard key={f.key} feature={f} index={i} />)}
      </div>

      <motion.button
        className="ob-btn ob-btn-primary ob-btn-lg"
        onClick={onNext}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.7 }}
      >
        Continue →
      </motion.button>
    </motion.div>
  )
}
