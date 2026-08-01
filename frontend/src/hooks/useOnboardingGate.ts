import { useCallback, useEffect, useRef, useState } from 'react'
import api from '@/services/api'

const SESSION_KEY = 'vlc_onboarding_dismissed'

export function useOnboardingGate(enabled: boolean) {
  const [loading, setLoading] = useState(true)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const dismissedRef = useRef(sessionStorage.getItem(SESSION_KEY) === '1')

  const check = useCallback(async () => {
    if (!enabled) { setLoading(false); return }
    if (dismissedRef.current) { setLoading(false); setNeedsOnboarding(false); return }
    setLoading(true)
    try {
      const [ytRes, slackRes] = await Promise.all([
        api.getYouTrackIntegration().catch(() => null),
        api.getSlackStatus().catch(() => null),
      ])
      const ytConfigured = !!ytRes?.success && !!ytRes.data?.configured
      const slackConnected = !!(slackRes as unknown as { connected?: boolean } | null)?.connected
      setNeedsOnboarding(!ytConfigured || !slackConnected)
    } catch {
      setNeedsOnboarding(false)
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => { check() }, [check])

  const dismiss = useCallback(() => {
    dismissedRef.current = true
    sessionStorage.setItem(SESSION_KEY, '1')
    setNeedsOnboarding(false)
  }, [])

  return { loading, needsOnboarding, recheck: check, dismiss }
}
