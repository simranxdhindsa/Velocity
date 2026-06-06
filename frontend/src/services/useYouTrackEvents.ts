import { useEffect, useRef } from 'react'
import { sseService } from './sseService'

export interface YouTrackUpdateEvent {
  issue_id: string
  field: string
  old_value: string
  new_value: string
  summary: string
}

/**
 * React hook that subscribes to YouTrack change events via the shared SSE
 * connection. Uses sseService to avoid opening a duplicate EventSource.
 */
export function useYouTrackEvents(onUpdate: (event: YouTrackUpdateEvent) => void) {
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  useEffect(() => {
    return sseService.subscribe('youtrack_update', (e: MessageEvent) => {
      try {
        const data: YouTrackUpdateEvent = JSON.parse(e.data)
        onUpdateRef.current(data)
      } catch {
        // Ignore malformed events
      }
    })
  }, [])
}
