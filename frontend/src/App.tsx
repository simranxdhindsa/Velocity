import { BrowserRouter, useLocation } from 'react-router-dom'
import { Suspense } from 'react'
import { SvgVDrawLoader } from '@/components/brand/VelocityLoaders'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { VelocityDataProvider } from '@/contexts/VelocityDataContext'
import { IgnoredBlockedProvider } from '@/contexts/IgnoredBlockedContext'
import { GatewayErrorProvider, useGatewayError } from '@/contexts/GatewayErrorContext'
import Login from '@/pages/Login'
import Dashboard from '@/pages/Dashboard'
import ThemePreviewPage from '@/pages/ThemePreviewPage'
import NoAccessPage from '@/pages/NoAccessPage'
import GatewayError502Page from '@/pages/GatewayError502Page'
import OAuthAuthorizePage from '@/pages/OAuthAuthorizePage'

function AppContent() {
  const { isAuthenticated, isLoading, accessDenied, accessDeniedMessage, clearAccessDenied } = useAuth()
  const { isDown } = useGatewayError()
  const location = useLocation()

  if (location.pathname === '/theme-preview') return <ThemePreviewPage />
  if (location.pathname === '/502-preview') return <GatewayError502Page />
  if (location.pathname === '/oauth/authorize') return <OAuthAuthorizePage />

  if (isDown) return <GatewayError502Page />

  if (isLoading) {
    return (
      <div className="loading-screen">
        <div className="loading-screen-content">
          <div className="loading-spinner"></div>
          <p className="loading-screen-text">Loading Velocity...</p>
        </div>
      </div>
    )
  }

  if (accessDenied) {
    return <NoAccessPage message={accessDeniedMessage} onReset={clearAccessDenied} />
  }

  return isAuthenticated ? (
    <VelocityDataProvider>
      <IgnoredBlockedProvider>
        <Dashboard />
      </IgnoredBlockedProvider>
    </VelocityDataProvider>
  ) : <Login />
}

function App() {
  return (
    <BrowserRouter>
      <GatewayErrorProvider>
        <AuthProvider>
          <Suspense fallback={
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--color-background,#020617)' }}>
              <SvgVDrawLoader size={128} />
            </div>
          }>
            <AppContent />
          </Suspense>
        </AuthProvider>
      </GatewayErrorProvider>
    </BrowserRouter>
  )
}

export default App
