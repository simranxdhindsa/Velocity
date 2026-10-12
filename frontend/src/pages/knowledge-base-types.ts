import type { KBDocument, KBVisibility } from '@/services/api'

// Shared constants and pure helpers for the Knowledge Base page (no React).

export const VISIBILITY_OPTIONS: { value: KBVisibility; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'admins', label: 'Admins only' },
]

/** A note written in Velocity (editable in place) rather than an uploaded file. */
export function isNote(d: KBDocument) {
  return d.mime_type === 'text/markdown' && d.filename.endsWith('.md')
}

export function fileExt(d: KBDocument) {
  return d.filename.split('.').pop()?.toLowerCase() ?? ''
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function timeAgo(dateStr: string) {
  const ms = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(ms / 60000)
  const h = Math.floor(ms / 3600000)
  const d = Math.floor(ms / 86400000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (h < 24) return `${h}h ago`
  if (d < 7) return `${d}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
