import { useState } from 'react'
import { Zap, Check } from 'lucide-react'
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
    // redirectUri is not a valid URL — can't redirect back; just stay on the page
    console.error('Invalid redirect_uri, cannot deny gracefully')
  }
}

export default function OAuthAuthorizePage() {
  const { isAuthenticated, isLoading, user } = useAuth()
  const params = parseParams()
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState('')

  // Still checking auth state
  if (isLoading) {
    return (
      <div className="oauth-page">
        <div className="oauth-spinner" />
      </div>
    )
  }

  // Not logged in — render Login inline; after login isAuthenticated flips to true
  if (!isAuthenticated) {
    return <Login />
  }

  // No client_id / redirect_uri in URL — invalid request
  if (!params.clientId || !params.redirectUri) {
    return (
      <div className="oauth-page">
        <div className="oauth-card">
          <p className="oauth-error">Invalid OAuth request — missing client_id or redirect_uri.</p>
        </div>
      </div>
    )
  }

  const initials = (user?.name ?? user?.email ?? '?')
    .split(' ')
    .map((w: string) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const handleApprove = async () => {
    setApproving(true)
    setError('')
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
    <div className="oauth-page">
      <div className="oauth-card">
        <div className="oauth-logo-row">
          <div className="oauth-logo-icon">
            <Zap size={22} />
          </div>
          <span className="oauth-logo-arrow">↔</span>
          <div className="oauth-claude-icon">🤖</div>
        </div>

        <h1 className="oauth-title">Claude.ai wants to connect to Velocity</h1>

        <div className="oauth-user-pill">
          <div className="oauth-user-avatar">{initials}</div>
          <span className="oauth-user-name">{user?.email}</span>
        </div>

        <div className="oauth-perms">
          <div className="oauth-perm-row">
            <div className="oauth-perm-check"><Check size={11} /></div>
            Queue Slack messages on your behalf
          </div>
          <div className="oauth-perm-row">
            <div className="oauth-perm-check"><Check size={11} /></div>
            Read your team's Slack channel list
          </div>
          <div className="oauth-perm-row">
            <div className="oauth-perm-check"><Check size={11} /></div>
            Act as you within Velocity
          </div>
        </div>

        {error && <p className="oauth-error">{error}</p>}

        <div className="oauth-actions">
          <button className="oauth-btn oauth-btn--deny" onClick={handleDeny} disabled={approving}>
            Deny
          </button>
          <button className="oauth-btn oauth-btn--approve" onClick={handleApprove} disabled={approving}>
            {approving ? 'Connecting…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  )
}
