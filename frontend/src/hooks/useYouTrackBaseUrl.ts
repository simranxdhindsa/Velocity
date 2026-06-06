import { useState, useEffect } from 'react'
import api from '@/services/api'

// Module-level cache: one fetch for the entire app session.
let _cached: string | null = null
const _listeners = new Set<(url: string) => void>()

export function useYouTrackBaseUrl(): string {
  const [url, setUrl] = useState(_cached ?? '')

  useEffect(() => {
    if (_cached !== null) {
      setUrl(_cached)
      return
    }
    _listeners.add(setUrl)
    // Only the first subscriber triggers the fetch
    if (_listeners.size === 1) {
      api.getYouTrackIntegration()
        .then(res => {
          const d = res as any
          const base = (d?.base_url || d?.data?.base_url || '').replace(/\/$/, '')
          _cached = base
          _listeners.forEach(fn => fn(base))
        })
        .catch(() => {
          _cached = ''
          _listeners.forEach(fn => fn(''))
        })
        .finally(() => _listeners.clear())
    }
    return () => { _listeners.delete(setUrl) }
  }, [])

  return url
}