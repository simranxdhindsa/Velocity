import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import api from '@/services/api'

interface IgnoredBlockedCtx {
  ignoredIds: Set<string>
  ignoredList: string[]
  ignoreTicket: (id: string) => Promise<void>
  unignoreTicket: (id: string) => Promise<void>
  unignoreAll: () => Promise<void>
}

const IgnoredBlockedContext = createContext<IgnoredBlockedCtx | undefined>(undefined)

export function IgnoredBlockedProvider({ children }: { children: React.ReactNode }) {
  const [ignoredList, setIgnoredList] = useState<string[]>([])

  useEffect(() => {
    api.getIgnoredBlocked()
      .then(res => setIgnoredList((res as any).data ?? []))
      .catch(() => {})
  }, [])

  const ignoreTicket = useCallback(async (id: string) => {
    setIgnoredList(prev => prev.includes(id) ? prev : [id, ...prev])
    try {
      await api.ignoreBlockedTicket(id)
    } catch {
      setIgnoredList(prev => prev.filter(x => x !== id))
    }
  }, [])

  const unignoreTicket = useCallback(async (id: string) => {
    setIgnoredList(prev => prev.filter(x => x !== id))
    try {
      await api.unignoreBlockedTicket(id)
    } catch {
      setIgnoredList(prev => [id, ...prev])
    }
  }, [])

  const unignoreAll = useCallback(async () => {
    const snapshot = ignoredList.slice()
    setIgnoredList([])
    try {
      await Promise.all(snapshot.map(id => api.unignoreBlockedTicket(id)))
    } catch {
      setIgnoredList(snapshot)
    }
  }, [ignoredList])

  const ignoredIds = useMemo(() => new Set(ignoredList), [ignoredList])

  return (
    <IgnoredBlockedContext.Provider value={{
      ignoredIds,
      ignoredList,
      ignoreTicket,
      unignoreTicket,
      unignoreAll,
    }}>
      {children}
    </IgnoredBlockedContext.Provider>
  )
}

export function useIgnoredBlocked() {
  const ctx = useContext(IgnoredBlockedContext)
  if (!ctx) throw new Error('useIgnoredBlocked must be used within IgnoredBlockedProvider')
  return ctx
}

export function useIgnoredBlockedSafe() {
  return useContext(IgnoredBlockedContext)
}
