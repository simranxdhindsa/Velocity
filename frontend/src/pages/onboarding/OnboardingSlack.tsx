import { useState } from 'react'
import { motion } from 'framer-motion'
import { Link2, CheckCircle2 } from 'lucide-react'
import api from '@/services/api'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

export default function OnboardingSlack({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [botToken,   setBotToken]   = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connected,  setConnected]  = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const handleConnect = async () => {
    if (!botToken.trim()) return
    setConnecting(true); setError(null)
    try {
      await api.connectSlack(botToken.trim())
      setConnected(true)
      setTimeout(onNext, 900)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect — check your bot token')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <motion.div
      className="ob-step ob-step-connect ob-step-connect--slack"
      initial={{ opacity: 0, x: 24, filter: 'blur(4px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: -24, filter: 'blur(4px)' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <div className="ob-connect-visual">
        <div className="ob-connect-node ob-connect-node--brand">
          <VelocityLogo variant="icon" size="sm" mark="chevron" showStatusDot={false} />
        </div>
        <svg className="ob-connect-line" viewBox="0 0 120 4" preserveAspectRatio="none">
          <motion.line
            x1="0" y1="2" x2="120" y2="2"
            strokeWidth="2" strokeDasharray="6 6"
            className={connected ? 'ob-connect-line-path ob-connect-line-path--active' : 'ob-connect-line-path'}
            animate={connected ? { strokeDashoffset: [0, -24] } : {}}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          />
        </svg>
        <div className="ob-connect-node ob-connect-node--target">#</div>
      </div>

      <h2 className="ob-heading">Connect Slack</h2>
      <p className="ob-sub">Get automated standups and reminders posted straight to your team channel.</p>

      <div className="ob-form">
        <input
          className="ob-input"
          type="password"
          placeholder="Slack bot token (xoxb-…)"
          value={botToken}
          onChange={e => setBotToken(e.target.value)}
          autoComplete="off"
        />
        {error && <div className="ob-error">{error}</div>}
      </div>

      <div className="ob-actions">
        <button className="ob-btn ob-btn-ghost" onClick={onSkip}>Skip for now</button>
        <motion.button
          className="ob-btn ob-btn-primary"
          disabled={!botToken.trim() || connecting}
          onClick={handleConnect}
          whileHover={{ scale: botToken.trim() ? 1.03 : 1 }}
          whileTap={{ scale: botToken.trim() ? 0.97 : 1 }}
        >
          {connected ? <><CheckCircle2 size={16} /> Connected</> : connecting ? 'Connecting…' : <><Link2 size={16} /> Connect</>}
        </motion.button>
      </div>
    </motion.div>
  )
}
