import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom'
import { Suspense } from 'react'
import { SvgVDrawLoader } from '@/components/brand/VelocityLoaders'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { VelocityDataProvider } from '@/contexts/VelocityDataContext'
import { IgnoredBlockedProvider } from '@/contexts/IgnoredBlockedContext'
import { GatewayErrorProvider, useGatewayError } from '@/contexts/GatewayErrorContext'
import { useOnboardingGate } from '@/hooks/useOnboardingGate'
import Login from '@/pages/Login'
import Dashboard from '@/pages/Dashboard'
import ThemePreviewPage from '@/pages/ThemePreviewPage'
import NoAccessPage from '@/pages/NoAccessPage'
import GatewayError502Page from '@/pages/GatewayError502Page'
import OAuthAuthorizePage from '@/pages/OAuthAuthorizePage'
import OnboardingFlow from '@/pages/onboarding/OnboardingFlow'

function AppContent() {
  const { isAuthenticated, isLoading, accessDenied, accessDeniedMessage, clearAccessDenied } = useAuth()
  const { isDown } = useGatewayError()
  const { loading: onboardingLoading, needsOnboarding, dismiss: dismissOnboarding } = useOnboardingGate(isAuthenticated)
  const location = useLocation()
  const navigate = useNavigate()

  if (location.pathname === '/theme-preview') return <ThemePreviewPage />
  if (location.pathname === '/502-preview') return <GatewayError502Page />
  if (location.pathname === '/oauth/authorize') return <OAuthAuthorizePage />
  if (location.pathname === '/oauth-preview') return <OAuthAuthorizePage />
  if (location.pathname === '/onboarding-preview') {
    // Hand off to the real app on finish instead of dead-ending on the completion
    // screen — if you're actually logged in with both integrations configured,
    // this lands on the real Dashboard, same as the genuine flow would.
    return <OnboardingFlow onFinish={() => navigate('/')} />
  }

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

  if (!isAuthenticated) return <Login />

  if (onboardingLoading) {
    return (
      <div className="loading-screen">
        <div className="loading-screen-content">
          <div className="loading-spinner"></div>
          <p className="loading-screen-text">Loading Velocity...</p>
        </div>
      </div>
    )
  }

  if (needsOnboarding) {
    return <OnboardingFlow onFinish={dismissOnboarding} />
  }

  return (
    <VelocityDataProvider>
      <IgnoredBlockedProvider>
        <Dashboard />
      </IgnoredBlockedProvider>
    </VelocityDataProvider>
  )
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
