import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, Check, Bot, Shield, CheckCircle2, ChevronRight } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import Login from '@/pages/Login'
import api from '@/services/api'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import '@/styles/pages/oauth-authorize.css'

type Phase = 'idle' | 'connecting' | 'success'

function parseParams() {
  const p = new URLSearchParams(window.location.search)
  return {
    clientId: p.get('client_id') ?? '',
    redirectUri: p.get('redirect_uri') ?? '',
    state: p.get('state') ?? '',
    challenge: p.get('code_challenge') ?? '',
    method: p.get('code_challenge_method') ?? 'S256',
  }
}

function deny(redirectUri: string, state: string) {
  try {
    const url = new URL(redirectUri)
    url.searchParams.set('error', 'access_denied')
    if (state) url.searchParams.set('state', state)
    window.location.href = url.toString()
  } catch {
    console.error('Invalid redirect_uri, cannot deny gracefully')
  }
}

const PERMS = [
  'Queue Slack messages on your behalf',
  "Read your team's Slack channel list",
  'Act as you within Velocity',
]

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1, delayChildren: 0.38 } },
}
const itemVariants = {
  hidden: { opacity: 0, x: -12 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.36, ease: 'easeOut' } },
}

function Particle({ x, delay, duration }: { x: number; delay: number; duration: number }) {
  return (
    <motion.div
      className="oa-particle"
      style={{ left: `${x}%` }}
      initial={{ y: 0, opacity: 0 }}
      animate={{ y: -300, opacity: [0, 0.5, 0] }}
      transition={{ duration, delay, repeat: Infinity, ease: 'easeOut' }}
    />
  )
}
const PARTICLES = [
  { x: 10, delay: 0.3, duration: 6.2 },
  { x: 25, delay: 1.8, duration: 7.5 },
  { x: 50, delay: 0.7, duration: 5.4 },
  { x: 70, delay: 2.4, duration: 6.8 },
  { x: 85, delay: 1.1, duration: 7.1 },
]

// ── Idle beam — indeterminate loading bar ────────────────────────────────────
function IdleBeam() {
  return (
    <div className="oa-beam-wrap">
      <div className="oa-beam-track">
        <motion.div
          className="oa-beam-fill"
          animate={{ x: ['-100%', '200%'] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', repeatDelay: 0.1 }}
        />
      </div>
    </div>
  )
}

// ── Connecting chevrons — flow left to right ────────────────────────────────
function ConnectingChevrons() {
  return (
    <div className="oa-chevrons">
      {[0, 1, 2, 3].map(i => (
        <motion.div
          key={i}
          className="oa-chevron"
          animate={{ opacity: [0, 1, 0] }}
          transition={{
            duration: 0.7,
            delay: i * 0.16,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        >
          <ChevronRight size={13} strokeWidth={2.5} />
        </motion.div>
      ))}
    </div>
  )
}

// ── Phase content — idle (consent card body) ────────────────────────────────
function IdleContent({
  user, initials, displayEmail, perms, onApprove, onDeny, approving, error
}: {
  user: any; initials: string; displayEmail: string; perms: string[]
  onApprove: () => void; onDeny: () => void; approving: boolean; error: string
}) {
  return (
    <motion.div
      key="idle"
      className="oa-phase"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14, filter: 'blur(4px)' }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
    >
      {/* Connection row */}
      <motion.div
        className="oa-conn-row"
        initial={{ opacity: 0, scale: 0.88 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.15, duration: 0.4, ease: 'easeOut' }}
      >
        <div className="oa-icon-box oa-icon-box--velocity">
          <Zap size={20} strokeWidth={2.5} />
        </div>
        <IdleBeam />
        <div className="oa-icon-box oa-icon-box--claude">
          <Bot size={20} strokeWidth={2} />
        </div>
      </motion.div>

      {/* Title */}
      <motion.h1
        className="oa-title"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.22, duration: 0.38 }}
      >
        Claude.ai wants to connect to Velocity
      </motion.h1>

      {/* User pill */}
      <motion.div
        className="oa-user-pill"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.36 }}
      >
        <div className="oa-avatar">{initials}</div>
        <span className="oa-user-email">{displayEmail}</span>
        <span className="oa-user-dot" />
      </motion.div>

      {/* Permissions */}
      <motion.div
        className="oa-perms"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {perms.map((perm, i) => (
          <motion.div key={i} className="oa-perm-row" variants={itemVariants}>
            <motion.div
              className="oa-perm-check"
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.42 + i * 0.1, type: 'spring', stiffness: 320, damping: 18 }}
            >
              <Check size={10} strokeWidth={3} />
            </motion.div>
            <span>{perm}</span>
          </motion.div>
        ))}
      </motion.div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.p
            className="oa-error"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      {/* Actions */}
      <motion.div
        className="oa-actions"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.62, duration: 0.36 }}
      >
        <button className="oa-btn oa-btn--deny" onClick={onDeny} disabled={approving}>
          Deny
        </button>
        <button className="oa-btn oa-btn--approve" onClick={onApprove} disabled={approving}>
          <span className="oa-btn-shimmer" />
          Approve
        </button>
      </motion.div>

      {/* Trust footer */}
      <motion.div
        className="oa-trust"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.75 }}
      >
        <Shield size={11} />
        <span>Secured by Velocity OAuth 2.0</span>
      </motion.div>
    </motion.div>
  )
}

// ── Phase content — connecting ───────────────────────────────────────────────
function ConnectingContent() {
  return (
    <motion.div
      key="connecting"
      className="oa-phase oa-phase--centered"
      initial={{ opacity: 0, scale: 0.94, filter: 'blur(6px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.94, filter: 'blur(6px)' }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {/* Pulsing connection icons */}
      <div className="oa-conn-row oa-conn-row--lg">
        <motion.div
          className="oa-icon-box oa-icon-box--velocity oa-icon-box--lg"
          animate={{
            boxShadow: [
              '0 0 12px rgba(var(--color-primary-rgb), 0.25)',
              '0 0 28px rgba(var(--color-primary-rgb), 0.65)',
              '0 0 12px rgba(var(--color-primary-rgb), 0.25)',
            ],
          }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Zap size={26} strokeWidth={2.5} />
        </motion.div>

        <ConnectingChevrons />

        <motion.div
          className="oa-icon-box oa-icon-box--claude oa-icon-box--lg"
          animate={{
            boxShadow: [
              '0 0 0px rgba(255,255,255,0)',
              '0 0 20px rgba(255,255,255,0.12)',
              '0 0 0px rgba(255,255,255,0)',
            ],
          }}
          transition={{ duration: 1.6, delay: 0.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Bot size={26} strokeWidth={2} />
        </motion.div>
      </div>

      {/* Status text */}
      <motion.p
        className="oa-connecting-text"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        Establishing secure connection
        <motion.span
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        >...</motion.span>
      </motion.p>

      {/* Progress bar */}
      <div className="oa-progress-track">
        <motion.div
          className="oa-progress-fill"
          initial={{ width: '0%' }}
          animate={{ width: '100%' }}
          transition={{ duration: 2.0, ease: [0.4, 0, 0.2, 1] }}
        />
        {/* Shimmer over the fill */}
        <motion.div
          className="oa-progress-shimmer"
          animate={{ x: ['-100%', '300%'] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: 0.3 }}
        />
      </div>

      <motion.p
        className="oa-connecting-sub"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
      >
        Encrypting your authorization token
      </motion.p>
    </motion.div>
  )
}

// ── Phase content — success ──────────────────────────────────────────────────
function SuccessContent() {
  return (
    <motion.div
      key="success"
      className="oa-phase oa-phase--centered"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
    >
      <motion.div
        className="oa-success-icon-wrap"
        initial={{ scale: 0, rotate: -20 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 18, delay: 0.05 }}
      >
        <CheckCircle2 size={56} className="oa-success-icon" />
      </motion.div>

      <motion.h2
        className="oa-success-title"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.28, duration: 0.36 }}
      >
        Connected!
      </motion.h2>

      <motion.p
        className="oa-success-sub"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.48 }}
      >
        Redirecting you back to Claude.ai…
      </motion.p>
    </motion.div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function OAuthAuthorizePage() {
  const { isAuthenticated, isLoading, user } = useAuth()
  const isPreview = window.location.pathname === '/oauth-preview'
  const params = isPreview
    ? { clientId: 'preview', redirectUri: 'https://preview', state: '', challenge: '', method: 'S256' }
    : parseParams()

  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')

  if (isLoading) {
    return <div className="oa-root"><div className="oa-spinner" /></div>
  }
  if (!isAuthenticated && !isPreview) return <Login />
  if (!params.clientId || !params.redirectUri) {
    return (
      <div className="oa-root">
        <motion.div className="oa-card" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}>
          <p className="oa-error">Invalid OAuth request — missing client_id or redirect_uri.</p>
        </motion.div>
      </div>
    )
  }

  const initials = isPreview
    ? 'SS'
    : (user?.name ?? user?.email ?? '?').split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()
  const displayEmail = isPreview ? 'simranjot@apyhub.com' : (user?.email ?? '')

  const handleApprove = async () => {
    setPhase('connecting')
    setError('')

    // Minimum display time so the animation always plays fully
    const minDelay = new Promise<void>(res => setTimeout(res, 2200))

    try {
      const [r] = await Promise.all([
        isPreview
          ? Promise.resolve({ code: 'preview-code' })
          : api.createOAuthCode({
              client_id: params.clientId,
              redirect_uri: params.redirectUri,
              code_challenge: params.challenge,
              code_challenge_method: params.method,
            }),
        minDelay,
      ])
      const raw = r as any
      const code: string = raw?.code ?? raw?.data?.code ?? ''
      if (!code && !isPreview) throw new Error('No code returned')

      setPhase('success')

      if (!isPreview) {
        setTimeout(() => {
          const url = new URL(params.redirectUri)
          url.searchParams.set('code', code)
          if (params.state) url.searchParams.set('state', params.state)
          window.location.href = url.toString()
        }, 1400)
      } else {
        setTimeout(() => setPhase('idle'), 2800)
      }
    } catch (e: any) {
      setPhase('idle')
      setError(e?.message ?? 'Something went wrong')
    }
  }

  const handleDeny = () => deny(params.redirectUri, params.state)

  return (
    <div className="oa-root">
      <div className="oa-blob oa-blob-1" />
      <div className="oa-blob oa-blob-2" />
      <div className="oa-blob oa-blob-3" />
      <div className="oa-particles">
        {PARTICLES.map((p, i) => <Particle key={i} {...p} />)}
      </div>

      {/* Velocity logo above card */}
      <motion.div
        className="oa-brand"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
      >
        <VelocityLogo variant="icon" size="md" mark="chevron" showStatusDot={false} />
      </motion.div>

      {/* Card */}
      <motion.div
        className="oa-card"
        initial={{ opacity: 0, y: 36, filter: 'blur(10px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="oa-card-glow" />

        <AnimatePresence mode="wait">
          {phase === 'idle' && (
            <IdleContent
              user={user}
              initials={initials}
              displayEmail={displayEmail}
              perms={PERMS}
              onApprove={handleApprove}
              onDeny={handleDeny}
              approving={false}
              error={error}
            />
          )}
          {phase === 'connecting' && <ConnectingContent />}
          {phase === 'success' && <SuccessContent />}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
