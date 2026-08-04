import { useCallback, useEffect, useRef, useState } from 'react'
import api from '@/services/api'

const SESSION_KEY = 'vlc_onboarding_dismissed'

export function useOnboardingGate(enabled: boolean) {
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  // Which `enabled` value we've completed a check for — null until the first
  // check finishes. Comparing this against the current `enabled` lets `loading`
  // be derived synchronously during render, instead of only updating after the
  // effect fires. Without this, a false→true flip in `enabled` renders once
  // with the *previous* (stale) loading value before the effect catches up —
  // which was flipping App.tsx's render branch and remounting Dashboard.
  const [checkedFor, setCheckedFor] = useState<boolean | null>(null)
  const dismissedRef = useRef(sessionStorage.getItem(SESSION_KEY) === '1')

  const loading = enabled && checkedFor !== enabled

  const check = useCallback(async () => {
    if (!enabled) { setCheckedFor(false); return }
    if (dismissedRef.current) { setNeedsOnboarding(false); setCheckedFor(true); return }
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
      setCheckedFor(true)
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
