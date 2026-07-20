import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, Check, Bot, Shield } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import Login from '@/pages/Login'
import api from '@/services/api'
import '@/styles/pages/oauth-authorize.css'

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
  visible: { transition: { staggerChildren: 0.09, delayChildren: 0.35 } },
}
const itemVariants = {
  hidden: { opacity: 0, x: -14 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.38, ease: 'easeOut' } },
}

function Particle({ x, delay, duration }: { x: number; delay: number; duration: number }) {
  return (
    <motion.div
      className="oa-particle"
      style={{ left: `${x}%` }}
      initial={{ y: 0, opacity: 0, scale: 0.5 }}
      animate={{ y: -280, opacity: [0, 0.5, 0], scale: [0.5, 1, 0.3] }}
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

export default function OAuthAuthorizePage() {
  const { isAuthenticated, isLoading, user } = useAuth()
  const isPreview = window.location.pathname === '/oauth-preview'
  const params = isPreview
    ? { clientId: 'preview', redirectUri: 'https://preview', state: '', challenge: '', method: 'S256' }
    : parseParams()
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState('')

  if (isLoading) {
    return (
      <div className="oa-root">
        <div className="oa-spinner" />
      </div>
    )
  }

  if (!isAuthenticated && !isPreview) return <Login />

  if (!params.clientId || !params.redirectUri) {
    return (
      <div className="oa-root">
        <motion.div
          className="oa-card"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
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
    setApproving(true)
    setError('')
    if (isPreview) { setTimeout(() => setApproving(false), 1800); return }
    try {
      const r = await api.createOAuthCode({
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        code_challenge: params.challenge,
        code_challenge_method: params.method,
      })
      const raw = r as any
      const code: string = raw?.code ?? raw?.data?.code ?? ''
      if (!code) throw new Error('No code returned')
      const url = new URL(params.redirectUri)
      url.searchParams.set('code', code)
      if (params.state) url.searchParams.set('state', params.state)
      window.location.href = url.toString()
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong')
      setApproving(false)
    }
  }

  const handleDeny = () => deny(params.redirectUri, params.state)

  return (
    <div className="oa-root">
      {/* Ambient background blobs */}
      <div className="oa-blob oa-blob-1" />
      <div className="oa-blob oa-blob-2" />
      <div className="oa-blob oa-blob-3" />

      {/* Floating particles */}
      <div className="oa-particles">
        {PARTICLES.map((p, i) => <Particle key={i} {...p} />)}
      </div>

      {/* Main card */}
      <motion.div
        className="oa-card"
        initial={{ opacity: 0, y: 36, filter: 'blur(10px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* Top glow edge */}
        <div className="oa-card-glow" />

        {/* Connection header */}
        <motion.div
          className="oa-conn-row"
          initial={{ opacity: 0, scale: 0.88 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.4, ease: 'easeOut' }}
        >
          {/* Velocity icon */}
          <div className="oa-icon-box oa-icon-box--velocity">
            <Zap size={20} strokeWidth={2.5} />
          </div>

          {/* Animated beam */}
          <div className="oa-beam">
            <div className="oa-beam-line" />
            <motion.div
              className="oa-beam-dot"
              animate={{ x: ['-8px', '36px', '-8px'] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>

          {/* Claude / AI icon */}
          <div className="oa-icon-box oa-icon-box--claude">
            <Bot size={20} strokeWidth={2} />
          </div>
        </motion.div>

        {/* Title */}
        <motion.h1
          className="oa-title"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.28, duration: 0.4, ease: 'easeOut' }}
        >
          Claude.ai wants to connect to Velocity
        </motion.h1>

        {/* User pill */}
        <motion.div
          className="oa-user-pill"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.36, duration: 0.38, ease: 'easeOut' }}
        >
          <div className="oa-avatar">{initials}</div>
          <span className="oa-user-email">{displayEmail}</span>
        </motion.div>

        {/* Permissions */}
        <motion.div
          className="oa-perms"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {PERMS.map((perm, i) => (
            <motion.div key={i} className="oa-perm-row" variants={itemVariants}>
              <div className="oa-perm-check">
                <Check size={10} strokeWidth={3} />
              </div>
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
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.65, duration: 0.38, ease: 'easeOut' }}
        >
          <button
            className="oa-btn oa-btn--deny"
            onClick={handleDeny}
            disabled={approving}
          >
            Deny
          </button>
          <button
            className="oa-btn oa-btn--approve"
            onClick={handleApprove}
            disabled={approving}
          >
            {approving ? (
              <span className="oa-btn-spinner" />
            ) : (
              <>
                <span className="oa-btn-shimmer" />
                Approve
              </>
            )}
          </button>
        </motion.div>

        {/* Footer trust line */}
        <motion.div
          className="oa-trust"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.75, duration: 0.4 }}
        >
          <Shield size={11} />
          <span>Secured by Velocity OAuth 2.0</span>
        </motion.div>
      </motion.div>
    </div>
  )
}
