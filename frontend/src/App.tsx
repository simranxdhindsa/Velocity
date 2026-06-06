import { BrowserRouter, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { VelocityDataProvider } from '@/contexts/VelocityDataContext'
import { GatewayErrorProvider, useGatewayError, GatewayError } from '@/contexts/GatewayErrorContext'
import Login from '@/pages/Login'
import Dashboard from '@/pages/Dashboard'
import ThemePreviewPage from '@/pages/ThemePreviewPage'
import NoAccessPage from '@/pages/NoAccessPage'
import GatewayError502Page from '@/pages/GatewayError502Page'

function AppContent() {
  const { isAuthenticated, isLoading, accessDenied, accessDeniedMessage, clearAccessDenied } = useAuth()
  const { isDown, trigger } = useGatewayError()
  const location = useLocation()

  useEffect(() => {
    function handleUnhandledRejection(event: PromiseRejectionEvent) {
      if (event.reason instanceof GatewayError) {
        trigger()
      }
    }
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    return () => window.removeEventListener('unhandledrejection', handleUnhandledRejection)
  }, [trigger])

  if (location.pathname === '/theme-preview') return <ThemePreviewPage />

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
      <Dashboard />
    </VelocityDataProvider>
  ) : <Login />
}

function App() {
  return (
    <BrowserRouter>
      <GatewayErrorProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </GatewayErrorProvider>
    </BrowserRouter>
  )
}

export default App
