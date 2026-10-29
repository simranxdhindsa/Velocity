import { useCallback, useEffect, useState } from 'react'
import { getYouTrackAvatarMap, peekYouTrackAvatarMap } from '@/services/api'

/**
 * Looks up a person's YouTrack profile picture by full name or login (any case).
 * The user list is fetched once per session and shared by every caller.
 */
export function useYouTrackAvatars(): (name?: string | null) => string | undefined {
  const [map, setMap] = useState<Record<string, string>>(() => peekYouTrackAvatarMap() ?? {})
  useEffect(() => {
    if (peekYouTrackAvatarMap()) return
    let live = true
    getYouTrackAvatarMap().then(m => { if (live) setMap(m) })
    return () => { live = false }
  }, [])
  return useCallback(
    (name?: string | null) => (name ? map[name] ?? map[name.toLowerCase()] : undefined),
    [map],
  )
}
