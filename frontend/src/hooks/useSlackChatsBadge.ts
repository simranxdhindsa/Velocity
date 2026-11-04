import { useEffect, useRef, useState, useCallback } from 'react'
import api from '@/services/api'
import { usePersistedState, PERSIST } from '@/hooks/usePersistedState'
import { hasNewChatMessage } from '@/components/slack-chats/slack-chats-utils'

const POLL_MS = 30_000

type Permission = NotificationPermission | 'unsupported'

function currentPermission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/**
 * How many Slack chats are waiting on the admin (the Chats tab badge), polled while the tab is
 * visible. When the count goes up and the browser allows it, shows a browser notification, so
 * an answer from someone is noticed even while another page is open. Also says whether a message
 * arrived since Chats was last viewed, for the dot on Slack in the left nav.
 */
export function useSlackChatsBadge(enabled: boolean, viewing = false) {
  const [count, setCount] = useState(0)
  const [latest, setLatest] = useState('')
  const [seenAt, setSeenAt] = usePersistedState<string>(PERSIST.SLACK_CHATS_SEEN, '')
  const viewingRef = useRef(viewing)
  const [permission, setPermission] = useState<Permission>(currentPermission)
  const prev = useRef<number | null>(null) // null until the first load, so opening the app never notifies

  const refresh = useCallback(async () => {
    try {
      const res = await api.getSlackChatsSummary()
      if (!res.success || !res.data) return
      const n = res.data.needs_attention
      setCount(n)
      const newest = res.data.latest_inbound_at ?? ''
      setLatest(newest)
      // The first load starts from now, so old messages never light the dot.
      if (newest) setSeenAt(seen => (!seen || viewingRef.current ? newest : seen))
      if (prev.current !== null && n > prev.current && currentPermission() === 'granted') {
        try {
          const body = n === 1 ? 'A chat is waiting for your reply.' : `${n} chats are waiting for your reply.`
          new Notification('Velocity Chats', { body, tag: 'velocity-chats' })
        } catch {
          // Some browsers only allow notifications from a service worker; the badge still shows.
        }
      }
      prev.current = n
    } catch {
      // The badge is a convenience; a failed poll just leaves the last number.
    }
  }, [setSeenAt])

  // Opening Chats counts as seeing what came in.
  useEffect(() => {
    viewingRef.current = viewing
    if (!enabled || !viewing) return
    const t = window.setTimeout(refresh, 0)
    return () => window.clearTimeout(t)
  }, [enabled, viewing, refresh])

  useEffect(() => {
    if (!enabled) return
    const first = window.setTimeout(refresh, 0) // first load, off the effect body
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refresh])

  /** Ask the browser for permission to show notifications (must come from a click). */
  const enableAlerts = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    try {
      setPermission(await Notification.requestPermission())
    } catch {
      setPermission(currentPermission())
    }
  }, [])

  return { count, refresh, permission, enableAlerts, hasNew: enabled && !viewing && hasNewChatMessage(count, latest, seenAt) }
}
