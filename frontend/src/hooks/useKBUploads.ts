import { useCallback, useEffect, useRef, useState } from 'react'
import api from '@/services/api'
import type { KBDocument } from '@/services/api'

// Upload queue for the Knowledge Base upload dialog. Lives in the page (not
// the dialog) so uploads keep running and stay visible after the dialog is
// closed and reopened.

export type KBUploadStatus = 'uploading' | 'indexing' | 'done' | 'error'

export interface KBUploadItem {
  id: string
  file: File
  progress: number // 0-100, upload only
  status: KBUploadStatus
  error?: string
  docId?: string
}

interface Options {
  docs: KBDocument[]        // live list from the page, used to follow indexing
  maxBytes: number
  exts: string[]
  onUploaded: () => void    // reload the document list
}

let seq = 0

export function useKBUploads({ docs, maxBytes, exts, onUploaded }: Options) {
  const [items, setItems] = useState<KBUploadItem[]>([])
  const aborts = useRef(new Map<string, () => void>())

  const patch = (id: string, p: Partial<KBUploadItem>) =>
    setItems(prev => prev.map(i => (i.id === id ? { ...i, ...p } : i)))

  const add = useCallback((files: File[]) => {
    const next: KBUploadItem[] = files.map(file => {
      const ext = '.' + (file.name.split('.').pop() ?? '').toLowerCase()
      const id = `up-${++seq}`
      if (!exts.includes(ext)) {
        return { id, file, progress: 0, status: 'error', error: `${ext} files are not supported` }
      }
      if (file.size > maxBytes) {
        return { id, file, progress: 0, status: 'error', error: `Larger than ${Math.round(maxBytes / 1048576)} MB` }
      }
      if (file.size === 0) {
        return { id, file, progress: 0, status: 'error', error: 'File is empty' }
      }
      return { id, file, progress: 0, status: 'uploading' }
    })
    setItems(prev => [...next, ...prev])

    for (const item of next) {
      if (item.status !== 'uploading') continue
      const { promise, abort } = api.uploadKBFile(item.file, pct => patch(item.id, { progress: pct }))
      aborts.current.set(item.id, abort)
      promise
        .then(res => {
          if (res.error || !res.document) {
            patch(item.id, { status: 'error', error: res.error || 'Upload failed' })
            return
          }
          patch(item.id, { status: 'indexing', progress: 100, docId: res.document.id })
          onUploaded()
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return // cancelled, already removed
          patch(item.id, { status: 'error', error: e instanceof Error ? e.message : 'Upload failed' })
        })
        .finally(() => aborts.current.delete(item.id))
    }
  }, [exts, maxBytes, onUploaded])

  // Follow server-side indexing through the page's polled document list.
  useEffect(() => {
    setItems(prev => {
      let changed = false
      const next = prev.flatMap(i => {
        if (!i.docId || i.status === 'uploading') return [i]
        const doc = docs.find(d => d.id === i.docId)
        if (!doc) {
          if (i.status === 'indexing') return [i] // list not refreshed yet
          changed = true
          return [] // deleted from the knowledge base
        }
        const status: KBUploadStatus = doc.status === 'ready' ? 'done' : doc.status === 'failed' ? 'error' : 'indexing'
        const error = doc.status === 'failed' ? doc.error : undefined
        if (status === i.status && error === i.error) return [i]
        changed = true
        return [{ ...i, status, error }]
      })
      return changed ? next : prev
    })
  }, [docs])

  /** Cancel an upload in flight, or drop a finished/failed row from the list. */
  const dismiss = useCallback((id: string) => {
    aborts.current.get(id)?.()
    aborts.current.delete(id)
    setItems(prev => prev.filter(i => i.id !== id))
  }, [])

  const busy = items.some(i => i.status === 'uploading' || i.status === 'indexing')
  return { items, add, dismiss, busy }
}
