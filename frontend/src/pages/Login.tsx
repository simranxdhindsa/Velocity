import { useEffect, useCallback, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { KanbanSquare, CheckCircle, Zap, Shield, Sun, Moon } from 'lucide-react'
import IsoTicketCard from '@/components/IsoTicketCard'

// Declare Google global type
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string
            callback: (response: { credential: string }) => void
          }) => void
          renderButton: (
            element: HTMLElement,
            config: {
              theme?: string
              size?: string
              width?: number
              text?: string
            }
          ) => void
          prompt: () => void
        }
      }
    }
  }
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const IS_PROD = import.meta.env.VITE_ENVIRONMENT === 'production'

export default function Login() {
  const { login, isLoading } = useAuth()
  const [rememberMe, setRememberMe] = useState(true) // Default to checked
  const [isDark, setIsDark] = useState<boolean>(() => {
    return document.documentElement.getAttribute('data-theme') !== 'light'
  })

  const toggleTheme = () => {
    const next = !isDark
    setIsDark(next)
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light')
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }
  const [showDevLogin, setShowDevLogin] = useState(false)
  const [devEmail, setDevEmail] = useState('')
  const [devPassword, setDevPassword] = useState('')

  const handleGoogleCallback = useCallback(
    async (response: { credential: string }) => {
      try {
        await login(response.credential, rememberMe)
        // Redirect will happen automatically via App.tsx
      } catch (error) {
        console.error('Login failed:', error)
      }
    },
    [login, rememberMe]
  )

  useEffect(() => {
    // Load Google Sign-In script
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    document.body.appendChild(script)

    script.onload = () => {
      if (window.google && GOOGLE_CLIENT_ID) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleGoogleCallback,
        })

        const buttonDiv = document.getElementById('google-signin-button')
        if (buttonDiv) {
          window.google.accounts.id.renderButton(buttonDiv, {
            theme: 'filled_black',
            size: 'large',
            width: 300,
            text: 'signin_with',
          })
        }
      }
    }

    return () => {
      document.body.removeChild(script)
    }
  }, [handleGoogleCallback])

  const handleDevLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    // Hardcoded dev credentials
    if (devEmail === 'simranjot@apyhub.com' && devPassword === 'Testing@123') {
      // Create a fake JWT token for dev mode
      const fakeToken = 'dev-mode-token-' + Date.now()
      localStorage.setItem('token', fakeToken)
      localStorage.setItem('dev-user', JSON.stringify({
        id: 'dev-user-1',
        email: 'simranjot@apyhub.com',
        name: 'Simranjot Singh',
        role: 'admin',
        picture: ''
      }))
      window.location.reload()
    } else {
      alert('Invalid credentials!')
    }
  }

  const features = [
    {
      icon: <KanbanSquare className="feature-icon" />,
      title: 'Asana Sync',
      description: 'Two-way sync with your Asana projects',
    },
    {
      icon: <Zap className="feature-icon" />,
      title: 'AI Analysis',
      description: 'Smart Slack message analysis with Gemini',
    },
    {
      icon: <CheckCircle className="feature-icon" />,
      title: 'Daily Carry-Over',
      description: "Yesterday's pending tasks at a glance",
    },
    {
      icon: <Shield className="feature-icon" />,
      title: 'Role-Based Access',
      description: 'Admin, PM, Member, and Viewer roles',
    },
  ]

  return (
    <div className="login-container">
      {/* Theme toggle — top right */}
      <button className="login-theme-toggle" onClick={toggleTheme} title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <div className="login-content animate-fade-in-up">
        {/* Logo and Title */}
        <div className="login-header">
          <div className="login-logo animate-float">
            <KanbanSquare size={48} />
          </div>
          <h1 className="login-title text-gradient">Velocity</h1>
          <p className="login-subtitle">
            Sync your Asana tasks, analyze Slack progress with AI
          </p>
        </div>

        {/* Login Card */}
        <div className="login-card glass-static">
          <h2
            className="login-card-title"
            onClick={() => !IS_PROD && setShowDevLogin(!showDevLogin)}
            style={!IS_PROD ? { cursor: 'pointer', userSelect: 'none' } : undefined}
          >
            Welcome Back
          </h2>
          <p className="login-card-description">
            Sign in with your company Google account
          </p>

          <div className="login-button-container">
            {showDevLogin ? (
              <form onSubmit={handleDevLogin} className="dev-login-form">
                <div className="form-group">
                  <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', display: 'block' }}>
                    Email
                  </label>
                  <input
                    type="email"
                    className="form-input"
                    value={devEmail}
                    onChange={(e) => setDevEmail(e.target.value)}
                    placeholder="Enter email"
                    autoFocus
                    style={{ marginBottom: '0.75rem' }}
                  />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', display: 'block' }}>
                    Password
                  </label>
                  <input
                    type="password"
                    className="form-input"
                    value={devPassword}
                    onChange={(e) => setDevPassword(e.target.value)}
                    placeholder="Enter password"
                    style={{ marginBottom: '1rem' }}
                  />
                </div>
                <button type="submit" className="btn-primary" style={{ width: '100%' }}>
                  Login
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ width: '100%', marginTop: '0.5rem' }}
                  onClick={() => setShowDevLogin(false)}
                >
                  Back to Google
                </button>
              </form>
            ) : isLoading ? (
              <div className="loading-container">
                <div className="loading-spinner"></div>
                <span className="loading-text">Signing in...</span>
              </div>
            ) : GOOGLE_CLIENT_ID ? (
              <>
                <div id="google-signin-button"></div>
                <label className="remember-me-label">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="remember-me-checkbox"
                  />
                  <span className="remember-me-text">Remember Me</span>
                </label>
              </>
            ) : (
              <div className="login-demo-notice">
                <p>Google Client ID not configured.</p>
                <p className="login-demo-hint">
                  Set VITE_GOOGLE_CLIENT_ID in .env file
                </p>
                <button
                  className="btn-primary btn-md login-demo-button"
                  onClick={() => {
                    // Demo mode - create a fake login for development
                    alert('Configure Google OAuth to enable login')
                  }}
                >
                  Configure OAuth
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Features Grid */}
        <div className="features-grid">
          {features.map((feature, index) => (
            <div
              key={feature.title}
              className={`feature-card glass stagger-${index + 1}`}
            >
              {feature.icon}
              <h3 className="feature-title">{feature.title}</h3>
              <p className="feature-description">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Background decorations */}
      <div className="login-bg-decoration login-bg-decoration-1"></div>
      <div className="login-bg-decoration login-bg-decoration-2"></div>

      {/* 3D Isometric Board — left: Backlog + In Progress */}
      <div className="iso-board-left">
        <div className="iso-board">
          <div className="iso-col">
            <div className="iso-col-header">Backlog</div>
            <IsoTicketCard color="red"    ticketId="PM-118" priority="P0" assignee="RK" estimate="4h" initialDelay={0}    titles={["Auth token expiry crashes app","Session loop on mobile","JWT refresh 500 error"]} />
            <IsoTicketCard color="yellow" ticketId="PM-134" priority="P1" assignee="SJ" estimate="2h" initialDelay={700}  titles={["Update user profile API","Add avatar upload flow","Profile cache miss"]} />
            <IsoTicketCard color="indigo" ticketId="PM-141" priority="P2" assignee="AM" estimate="1d" initialDelay={1400} titles={["Refactor settings page","Move config to env vars","Remove legacy flags"]} />
          </div>
          <div className="iso-col">
            <div className="iso-col-header">In Progress</div>
            <IsoTicketCard color="yellow" ticketId="PM-127" priority="P1" assignee="PR" estimate="3h" initialDelay={350}  titles={["Dashboard loading skeleton","Shimmer for data tables","Skeleton on route change"]} />
            <IsoTicketCard color="purple" ticketId="PM-139" priority="P1" assignee="AS" estimate="2d" initialDelay={1050} titles={["Sprint board drag & drop","Fix card reorder bug","Kanban state out of sync"]} />
            <IsoTicketCard color="indigo" ticketId="PM-143" priority="P2" assignee="NK" estimate="5h" initialDelay={1750} titles={["Dark mode contrast audit","Fix light mode tokens","Review color variables"]} />
          </div>
        </div>
      </div>

      {/* 3D Isometric Board — right: Blocked + Done */}
      <div className="iso-board-right">
        <div className="iso-board">
          <div className="iso-col">
            <div className="iso-col-header">Blocked</div>
            <IsoTicketCard color="red"    ticketId="PM-109" priority="P0" assignee="VT" estimate="6h" initialDelay={200}  titles={["Payment gateway timeout","Stripe webhook 502s","Billing rate limit hit"]} />
            <IsoTicketCard color="red"    ticketId="PM-122" priority="P0" assignee="RK" estimate="1d" initialDelay={900}  titles={["DB migration blocked","Needs schema review","Prod index rebuild pending"]} />
            <IsoTicketCard color="yellow" ticketId="PM-136" priority="P1" assignee="SJ" estimate="3h" initialDelay={1600} titles={["Blocked on design review","Waiting Figma handoff","UI spec pending"]} />
          </div>
          <div className="iso-col">
            <div className="iso-col-header">Done</div>
            <IsoTicketCard color="green"  ticketId="PM-101" priority="P1" assignee="AS" estimate="4h" initialDelay={500}  titles={["OAuth Google login live","SSO integration shipped","Login redirect fixed"]} />
            <IsoTicketCard color="green"  ticketId="PM-115" priority="P2" assignee="NK" estimate="2h" initialDelay={1200} titles={["Email digest system","Weekly emails shipped","Unsubscribe flow done"]} />
            <IsoTicketCard color="indigo" ticketId="PM-131" priority="P2" assignee="PR" estimate="1d" initialDelay={1900} titles={["Analytics tracking live","Mixpanel events wired","Dashboard metrics up"]} />
          </div>
        </div>
      </div>
    </div>
  )
}
