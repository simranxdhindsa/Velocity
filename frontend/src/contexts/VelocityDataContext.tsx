/**
 * VelocityDataContext — shared SWR-style data cache for the whole app.
 *
 * Usage:
 *   const { data, loading, error, refresh } = useVelocityData(
 *     'sprints',
 *     () => api.getYouTrackSprints(),
 *     { ttl: 10 * 60_000 }
 *   )
 *
 * • First caller fetches; subsequent callers get the cached value instantly.
 * • TTL defaults to 3 minutes. Pass ttl: 0 to always fetch fresh.
 * • invalidate(key) / invalidatePrefix(prefix) force next read to re-fetch.
 * • SSE youtrack_update events auto-invalidate 'board:*' entries (debounced 2s).
 */

import {
  createContext, useContext, useRef, useCallback,
  useState, useEffect, type ReactNode,
} from 'react'
import api from '@/services/api'
import { sseService } from '@/services/sseService'

// ── Types ────────────────────────────────────────────────────────────────────

interface CacheEntry<T = unknown> {
  data: T
  fetchedAt: number
  loading: boolean
  error: string | null
}

interface VelocityDataContextValue {
  // Low-level access
  getEntry<T>(key: string): CacheEntry<T> | null
  fetchEntry<T>(key: string, fetcher: () => Promise<T>, ttl?: number): Promise<T>
  invalidate(key: string): void
  invalidatePrefix(prefix: string): void
}

interface UseVelocityDataOptions {
  /** Cache TTL in ms. Default 3 minutes. Pass 0 to always fetch. */
  ttl?: number
  /** Skip fetch entirely (e.g. when a required param is missing). */
  skip?: boolean
}

// ── Context ──────────────────────────────────────────────────────────────────

const VelocityDataContext = createContext<VelocityDataContextValue | null>(null)

export function VelocityDataProvider({ children }: { children: ReactNode }) {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const inflight = useRef<Map<string, Promise<unknown>>>(new Map())
  const listenersRef = useRef<Map<string, Set<() => void>>>(new Map())

  const notify = useCallback((key: string) => {
    listenersRef.current.get(key)?.forEach(fn => fn())
  }, [])

  const getEntry = useCallback(<T,>(key: string): CacheEntry<T> | null => {
    return (cacheRef.current.get(key) as CacheEntry<T>) ?? null
  }, [])

  const fetchEntry = useCallback(<T,>(
    key: string,
    fetcher: () => Promise<T>,
    ttl = 3 * 60_000,
  ): Promise<T> => {
    const existing = cacheRef.current.get(key)
    if (
      ttl > 0 &&
      existing &&
      !existing.loading &&
      !existing.error &&
      Date.now() - existing.fetchedAt < ttl
    ) {
      return Promise.resolve(existing.data as T)
    }

    // Deduplicate concurrent fetches
    const existing_inflight = inflight.current.get(key) as Promise<T> | undefined
    if (existing_inflight) return existing_inflight

    const entry: CacheEntry = { data: existing?.data ?? undefined, fetchedAt: 0, loading: true, error: null }
    cacheRef.current.set(key, entry)
    notify(key)

    const promise: Promise<T> = fetcher()
      .then(data => {
        cacheRef.current.set(key, { data, fetchedAt: Date.now(), loading: false, error: null })
        notify(key)
        return data
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        cacheRef.current.set(key, { data: existing?.data ?? undefined, fetchedAt: existing?.fetchedAt ?? 0, loading: false, error: msg })
        notify(key)
        throw err
      })
      .finally(() => {
        inflight.current.delete(key)
      })

    inflight.current.set(key, promise)
    return promise
  }, [notify])

  const invalidate = useCallback((key: string) => {
    cacheRef.current.delete(key)
    notify(key)
  }, [notify])

  const invalidatePrefix = useCallback((prefix: string) => {
    const keys = [...cacheRef.current.keys()].filter(k => k.startsWith(prefix))
    keys.forEach(k => {
      cacheRef.current.delete(k)
      notify(k)
    })
  }, [notify])

  // ── SSE: debounced cache invalidation on youtrack_update ─────────────────
  useEffect(() => {
    const token = localStorage.getItem('token') || localStorage.getItem('auth_token')
    if (!token) return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const unsubscribe = sseService.subscribe('youtrack_update', () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        invalidatePrefix('board:')
        invalidate('sprints')
      }, 2000)
    })

    return () => {
      unsubscribe()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [invalidate, invalidatePrefix])

  // ── Listener registry (used by useVelocityData hook) ────────────────────
  const subscribe = useCallback((key: string, fn: () => void) => {
    if (!listenersRef.current.has(key)) listenersRef.current.set(key, new Set())
    listenersRef.current.get(key)!.add(fn)
    return () => listenersRef.current.get(key)?.delete(fn)
  }, [])

  const ctx: VelocityDataContextValue & { subscribe: typeof subscribe } = {
    getEntry, fetchEntry, invalidate, invalidatePrefix, subscribe,
  } as VelocityDataContextValue & { subscribe: typeof subscribe }

  return (
    <VelocityDataContext.Provider value={ctx}>
      {children}
    </VelocityDataContext.Provider>
  )
}

// ── Internal extended context type ───────────────────────────────────────────

interface InternalContextValue extends VelocityDataContextValue {
  subscribe: (key: string, fn: () => void) => () => void
}

function useInternalCtx(): InternalContextValue {
  const ctx = useContext(VelocityDataContext)
  if (!ctx) throw new Error('useVelocityData must be used inside VelocityDataProvider')
  return ctx as InternalContextValue
}

// ── Public hook ──────────────────────────────────────────────────────────────

export function useVelocityData<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: UseVelocityDataOptions = {},
) {
  const { ttl = 3 * 60_000, skip = false } = options
  const ctx = useInternalCtx()

  const [, forceUpdate] = useState(0)

  useEffect(() => {
    const unsub = ctx.subscribe(key, () => forceUpdate(n => n + 1))
    return unsub
  }, [ctx, key])

  useEffect(() => {
    if (!skip) {
      ctx.fetchEntry<T>(key, fetcher, ttl).catch(() => {/* error stored in entry */})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, skip])

  const entry = ctx.getEntry<T>(key)
  const data = entry?.data ?? null
  const loading = entry ? entry.loading : !skip
  const error = entry?.error ?? null

  const refresh = useCallback(() => {
    ctx.invalidate(key)
    ctx.fetchEntry<T>(key, fetcher, 0).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key])

  return { data, loading, error, refresh }
}

// ── Convenience: expose invalidate without full hook ─────────────────────────

export function useDataCache() {
  return useInternalCtx()
}

// ── Pre-baked hooks for common data ─────────────────────────────────────────

export function useSprintsCache() {
  return useVelocityData(
    'sprints',
    () => api.getYouTrackSprints().then(r => r.data ?? []),
    { ttl: 10 * 60_000 },
  )
}
