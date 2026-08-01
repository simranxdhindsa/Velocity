import { motion } from 'framer-motion'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

export default function OnboardingWelcome({ userName, onNext }: { userName?: string; onNext: () => void }) {
  const firstName = userName?.split(' ')[0] || 'there'

  return (
    <motion.div
      className="ob-step ob-step-welcome"
      initial={{ opacity: 0, y: 16, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -16, filter: 'blur(4px)' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <div className="ob-welcome-orbit">
        <motion.div
          className="ob-orbit ob-orbit-outer"
          animate={{ rotate: 360 }}
          transition={{ duration: 16, repeat: Infinity, ease: 'linear' }}
        >
          <div className="ob-orbit-dot ob-orbit-dot--primary" />
        </motion.div>
        <motion.div
          className="ob-orbit ob-orbit-inner"
          animate={{ rotate: -360 }}
          transition={{ duration: 10, repeat: Infinity, ease: 'linear' }}
        >
          <div className="ob-orbit-dot ob-orbit-dot--accent" />
        </motion.div>
        <motion.div
          className="ob-logo-wrap"
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          <VelocityLogo variant="icon" size="xl" mark="chevron" showStatusDot={false} />
        </motion.div>
      </div>

      <motion.h1
        className="ob-heading ob-heading-lg"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        Welcome, {firstName}
      </motion.h1>
      <motion.p
        className="ob-sub"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        Let's get your workspace set up — it only takes a minute.
      </motion.p>

      <motion.button
        className="ob-btn ob-btn-primary ob-btn-lg"
        onClick={onNext}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.45 }}
      >
        Get Started →
      </motion.button>
    </motion.div>
  )
}
