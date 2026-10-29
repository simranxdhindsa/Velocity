import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import api, { type User } from '@/services/api'

interface AuthContextType {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  accessDenied: boolean
  accessDeniedMessage: string
  login: (credential: string, rememberMe?: boolean) => Promise<void>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
  clearAccessDenied: () => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// Refresh token every 12 hours to keep the session alive (sliding session)
const TOKEN_REFRESH_INTERVAL = 12 * 60 * 60 * 1000 // 12 hours in ms

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)
  const [accessDeniedMessage, setAccessDeniedMessage] = useState('')
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const clearAccessDenied = useCallback(() => {
    setAccessDenied(false)
    setAccessDeniedMessage('')
  }, [])

  // Refresh the token to extend the session
  const refreshToken = useCallback(async () => {
    try {
      const token = api.getToken()
      if (!token) return

      const response = await api.refreshToken()
      if (response.success && response.data) {
        api.setToken(response.data.token)
      }
    } catch (error) {
      console.error('Token refresh failed:', error)
      // Don't logout on refresh failure - token may still be valid
    }
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      const token = api.getToken()
      if (!token) {
        setUser(null)
        return
      }

      // Check for dev mode
      const devUser = localStorage.getItem('dev-user')
      if (token.startsWith('dev-mode-token') && devUser) {
        setUser(JSON.parse(devUser))
        return
      }

      const response = await api.getMe()
      if (response.success && response.data) {
        setUser(response.data)
        // Start token refresh interval when user is authenticated
        if (!refreshIntervalRef.current) {
          refreshIntervalRef.current = setInterval(refreshToken, TOKEN_REFRESH_INTERVAL)
        }
      } else {
        setUser(null)
        api.setToken(null)
      }
    } catch (error) {
      // TypeError means "Failed to fetch" — backend is temporarily down (e.g. branch
      // switch caused air to restart). The token is still valid; don't log the user out.
      // Only clear auth state on actual server errors (401, 403, etc.).
      if (!(error instanceof TypeError)) {
        setUser(null)
        api.setToken(null)
      }
    }
  }, [refreshToken])

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const initAuth = async () => {
      setIsLoading(true)
      await refreshUser()
      setIsLoading(false)
    }
    initAuth()
  }, [refreshUser])

  const login = async (credential: string, rememberMe: boolean = false) => {
    setIsLoading(true)
    try {
      const response = await api.googleAuth(credential, rememberMe)
      if (response.success && response.data) {
        api.setToken(response.data.token)
        setUser(response.data.user)
        if (!refreshIntervalRef.current) {
          refreshIntervalRef.current = setInterval(refreshToken, TOKEN_REFRESH_INTERVAL)
        }
      }
    } catch (error) {
      // TypeError = "Failed to fetch" — backend temporarily down (branch switch / restart).
      // Don't show Access Denied for a network error; rethrow so the login page can handle it.
      if (error instanceof TypeError) throw error
      // Actual server rejection (403 blocked, 401 whitelist, etc.) → show Access Denied page
      const message = error instanceof Error ? error.message : 'Access denied'
      setAccessDenied(true)
      setAccessDeniedMessage(message)
    } finally {
      setIsLoading(false)
    }
  }

  const logout = async () => {
    try {
      // Don't call API logout if in dev mode
      const token = api.getToken()
      if (!token?.startsWith('dev-mode-token')) {
        await api.logout()
      }
    } finally {
      api.setToken(null)
      setUser(null)
      localStorage.removeItem('dev-user')
      // Clear refresh interval
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current)
        refreshIntervalRef.current = null
      }
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        accessDenied,
        accessDeniedMessage,
        login,
        logout,
        refreshUser,
        clearAccessDenied,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
