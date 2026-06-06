import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  ExternalLink, X, Send, MessageSquare, Paperclip, Clock, User, FileText,
  Film, Music, FileCode, File, FileSpreadsheet, Tag, GitBranch, Activity,
  ChevronDown, Check, Image, Upload,
} from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import api from '@/services/api'
import type { YouTrackIssue, YouTrackComment, IssueStateLogEntry, YouTrackUser } from '@/services/api'
import { getActiveSource } from '@/services/pmDataService'
import { AttachmentViewer } from '@/components/AttachmentViewer'
import { useYouTrackBaseUrl } from '@/hooks/useYouTrackBaseUrl'

interface IssueDetailPanelProps {
  issue: YouTrackIssue
  onClose: () => void
  ytBaseUrl?: string
}

function getInitials(name?: string) {
  if (!name) return '?'
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

function fmtDate(ms?: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtDateTime(ms?: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatCommentTime(ms: number): string {
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return fmtDate(ms)
}

// Renders YouTrack comment markdown, handling the {width=X%} image attribute extension.
// Relative image URLs (e.g. "image.png") are resolved against the YouTrack base URL.
function renderCommentText(text: string, ytBaseUrl?: string): string {
  if (!text) return ''

  const resolveUrl = (url: string) => {
    if (!url || url.startsWith('http') || url.startsWith('data:')) return url
    const base = (ytBaseUrl || '').replace(/\/$/, '')
    return base ? `${base}/${url.replace(/^\//, '')}` : url
  }

  // Convert YouTrack's ![alt](url){width=70%} / {width=100} → proper <img> tags
  let processed = text.replace(
    /!\[([^\]]*)\]\(([^)]+)\)\{width=(\d+%?)\}/g,
    (_, alt, url, width) => {
      const style = width.includes('%') ? `width:${width}` : `width:${width}px`
      return `<img src="${resolveUrl(url)}" alt="${alt}" style="${style};max-width:100%;border-radius:4px;" />`
    }
  )
  // Also resolve plain markdown images without width attribute: ![alt](url)
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, alt, url) => `<img src="${resolveUrl(url)}" alt="${alt}" style="max-width:100%;border-radius:4px;" />`
  )

  const html = marked.parse(processed) as string
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['img'],
    ADD_ATTR: ['style', 'src', 'alt', 'width', 'height'],
  })
}

function formatTransitionTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(hours: number | null): string {
  if (hours == null || hours <= 0) return ''
  const d = Math.floor(hours / 24)
  const h = Math.round(hours % 24)
  if (d > 0 && h > 0) return `${d}d ${h}h`
  if (d > 0) return `${d}d`
  return `${h}h`
}

function priorityBadgeStyle(priority: string): { background: string; color: string } {
  const p = (priority || '').toLowerCase()
  if (p.includes('critical') || p.includes('show-stopper') || p.includes('blocker'))
    return { background: 'rgba(239,68,68,0.18)', color: '#f87171' }
  if (p.includes('major'))
    return { background: 'rgba(245,158,11,0.18)', color: '#fbbf24' }
  if (p.includes('minor') || p.includes('cosmetic'))
    return { background: 'rgba(99,102,241,0.18)', color: '#818cf8' }
  return { background: 'rgba(148,163,184,0.15)', color: '#94a3b8' }
}

function isImageAttachment(mimeType: string, url: string) {
  if (mimeType?.startsWith('image/')) return true
  const ext = url?.split('.').pop()?.toLowerCase()
  return ['png','jpg','jpeg','gif','webp','svg'].includes(ext || '')
}

function attachmentTypeIcon(mimeType: string, name: string) {
  const ext = (name?.split('.').pop() || '').toLowerCase()
  const mime = (mimeType || '').toLowerCase()
  if (mime.startsWith('video/') || ['mp4','webm','mov','mkv','avi'].includes(ext))
    return <Film size={22} />
  if (mime.startsWith('audio/') || ['mp3','wav','ogg','aac','flac'].includes(ext))
    return <Music size={22} />
  if (mime === 'application/pdf' || ext === 'pdf')
    return <FileText size={22} />
  if (['xls','xlsx','csv'].includes(ext))
    return <FileSpreadsheet size={22} />
  if (['js','ts','jsx','tsx','py','go','json','xml','html','css','md','txt','log'].includes(ext))
    return <FileCode size={22} />
  if (['doc','docx','ppt','pptx'].includes(ext))
    return <FileText size={22} />
  return <File size={22} />
}

function filePreviewIcon(file: File) {
  const mime = file.type.toLowerCase()
  if (mime.startsWith('image/')) return <Image size={14} />
  if (mime.startsWith('video/')) return <Film size={14} />
  if (mime.startsWith('audio/')) return <Music size={14} />
  if (mime === 'application/pdf') return <FileText size={14} />
  return <File size={14} />
}

function fmt_file_size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Inline select dropdown ─────────────────────────────────────────────────
function InlineSelect({
  value, options, onSelect, saving,
}: {
  value: string
  options: string[]
  onSelect: (v: string) => void
  saving?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="idp-inline-select" style={{ position: 'relative' }}>
      <button
        className="idp-editable-field"
        onClick={() => !saving && setOpen(o => !o)}
        disabled={saving}
        title="Click to edit"
      >
        <span>{value || '—'}</span>
        {saving ? <span className="idp-saving-dot" /> : <ChevronDown size={11} style={{ opacity: 0.5 }} />}
      </button>
      {open && (
        <div className="idp-select-menu">
          {options.map(opt => (
            <button
              key={opt}
              className={`idp-select-option${opt === value ? ' active' : ''}`}
              onClick={() => { onSelect(opt); setOpen(false) }}
            >
              {opt === value && <Check size={11} />}
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function IssueDetailPanel({ issue, onClose, ytBaseUrl: ytBaseUrlProp }: IssueDetailPanelProps) {
  const isYouTrack = getActiveSource() === 'youtrack'
  const fetchedBaseUrl = useYouTrackBaseUrl()
  const ytBaseUrl = ytBaseUrlProp || fetchedBaseUrl

  // Local editable state (mirrors issue props, updated optimistically)
  const [localStatus,   setLocalStatus]   = useState(issue.status || '')
  const [localPriority, setLocalPriority] = useState(issue.priority || '')
  const [localAssignee, setLocalAssignee] = useState<YouTrackUser | undefined>(issue.assignee)
  const [localDueDate,  setLocalDueDate]  = useState(issue.due_date ? new Date(issue.due_date).toISOString().slice(0,10) : '')

  // Saving indicators per field
  const [saving, setSaving] = useState<Record<string, boolean>>({})

  // Available options
  const [states,     setStates]     = useState<string[]>([])
  const [priorities, setPriorities] = useState<string[]>([])
  const [users,      setUsers]      = useState<YouTrackUser[]>([])
  const [userOpen,   setUserOpen]   = useState(false)
  const userRef = useRef<HTMLDivElement>(null)

  // Comments
  const [comments, setComments] = useState<YouTrackComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [posting, setPosting] = useState(false)

  // File attachments for comment
  const [attachFiles, setAttachFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef  = useRef<HTMLTextAreaElement>(null)

  // Attachment viewer
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const allAttachments = issue.attachments || []

  // Transitions
  const [transitions, setTransitions] = useState<IssueStateLogEntry[]>([])
  const [transitionsLoading, setTransitionsLoading] = useState(false)

  // Display ID — prefer readable (ARD-1767) over internal (3-3797)
  const displayId = issue.idReadable || issue.id
  const issueUrl  = isYouTrack
    ? `${ytBaseUrl}/issue/${displayId}`
    : (issue.permalink || '#')

  // ── Load options on mount ────────────────────────────────────────────────
  useEffect(() => {
    if (!isYouTrack) return
    api.getYouTrackStates().then(res => {
      const data = (res as any).data ?? res
      setStates(Array.isArray(data) ? data.map((s: any) => s.name || s) : [])
    }).catch(() => {})
    api.getYouTrackPriorities().then(res => {
      const data = (res as any).data ?? res
      setPriorities(Array.isArray(data) ? data.map((p: any) => p.name || p) : [])
    }).catch(() => {})
    api.getYouTrackUsers().then(res => {
      const data = (res as any).data ?? res
      setUsers(Array.isArray(data) ? data : [])
    }).catch(() => {})
  }, [isYouTrack])

  // ── Load comments ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isYouTrack) return
    setCommentsLoading(true)
    api.getYouTrackIssueComments(issue.id)
      .then(res => {
        const r = res as { success: boolean; data: YouTrackComment[] }
        if (r.success && r.data) setComments(r.data)
      })
      .catch(() => {})
      .finally(() => setCommentsLoading(false))
  }, [issue.id, isYouTrack])

  // ── Load transitions ─────────────────────────────────────────────────────
  useEffect(() => {
    setTransitionsLoading(true)
    api.getIssueTransitions(issue.id)
      .then(res => {
        const r = res as { success: boolean; data: IssueStateLogEntry[] }
        const data = (r.data ?? r) as IssueStateLogEntry[]
        setTransitions(Array.isArray(data) ? data : [])
      })
      .catch(() => {})
      .finally(() => setTransitionsLoading(false))
  }, [issue.id])

  // ── Outside click closes user dropdown ───────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!userRef.current?.contains(e.target as Node)) setUserOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Field update helpers ─────────────────────────────────────────────────
  const saveField = async (field: string, updater: () => Promise<void>) => {
    setSaving(s => ({ ...s, [field]: true }))
    try { await updater() } catch { /* ignore */ }
    finally { setSaving(s => ({ ...s, [field]: false })) }
  }

  const handleStateChange = (newState: string) => {
    setLocalStatus(newState)
    saveField('status', () => api.updateYouTrackIssueState(issue.id, newState) as Promise<any>)
  }

  const handlePriorityChange = (newPriority: string) => {
    setLocalPriority(newPriority)
    saveField('priority', () => api.updateYouTrackIssue(issue.id, { priority: newPriority }) as Promise<any>)
  }

  const handleAssigneeChange = (user: YouTrackUser) => {
    setLocalAssignee(user)
    setUserOpen(false)
    saveField('assignee', () => api.updateYouTrackIssue(issue.id, { assignee_login: user.login }) as Promise<any>)
  }

  const handleDueDateChange = (dateStr: string) => {
    setLocalDueDate(dateStr)
    const ms = dateStr ? new Date(dateStr).getTime() : 0
    saveField('due_date', () => api.updateYouTrackIssue(issue.id, { due_date: ms } as any) as Promise<any>)
  }

  // ── File handling ────────────────────────────────────────────────────────
  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files)
    setAttachFiles(prev => {
      const names = new Set(prev.map(f => f.name))
      return [...prev, ...arr.filter(f => !names.has(f.name))]
    })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }, [addFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files
    if (files && files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  // ── Post comment + upload attachments ────────────────────────────────────
  const handlePostComment = async () => {
    const text = commentText.trim()
    if ((!text && attachFiles.length === 0) || posting) return
    setPosting(true)
    try {
      // Upload files first (attach to issue)
      for (const file of attachFiles) {
        try { await api.uploadYouTrackAttachment(issue.id, file) } catch { /* non-fatal */ }
      }
      // Post comment text if any
      if (text) await api.addYouTrackIssueComment(issue.id, text)
      setCommentText('')
      setAttachFiles([])
      // Refresh comments
      const res = await api.getYouTrackIssueComments(issue.id)
      const r = res as { success: boolean; data: YouTrackComment[] }
      if (r.success && r.data) setComments(r.data)
    } catch { /* ignore */ }
    finally { setPosting(false) }
  }

  const priStyle = priorityBadgeStyle(localPriority)
  const dueDateMs = localDueDate ? new Date(localDueDate).getTime() : undefined

  return createPortal(
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="idp-modal" onClick={e => e.stopPropagation()}>

        {/* ── Top bar ── */}
        <div className="idp-topbar">
          <div className="idp-topbar-left">
            <a
              className="idp-issue-id idp-issue-id--link"
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in YouTrack"
            >{displayId}</a>
            {issue.type && <span className="idp-type-chip">{issue.type}</span>}
          </div>
          <div className="idp-topbar-actions">
            <a href={issueUrl} target="_blank" rel="noopener noreferrer" className="idp-ext-link">
              <ExternalLink size={13} />
              View in {isYouTrack ? 'YouTrack' : 'Asana'}
            </a>
            <button className="idp-close" onClick={onClose}><X size={16} /></button>
          </div>
        </div>

        {/* ── Two-column body ── */}
        <div className="idp-body">

          {/* ── Left: main content ── */}
          <div className="idp-main">
            <h2 className="idp-title">{issue.summary}</h2>

            <div className="idp-meta-line">
              {issue.created ? <span>Created {fmtDateTime(issue.created)}</span> : null}
              {issue.updated ? <span>· Updated {fmtDateTime(issue.updated)}</span> : null}
            </div>

            {issue.description && (
              <div className="idp-section">
                <div className="idp-section-label"><FileText size={12} /> Description</div>
                <div
                  className="idp-description idp-markdown"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(marked.parse(issue.description) as string)
                  }}
                />
              </div>
            )}

            {/* Activity Log */}
            <div className="idp-section">
              <div className="idp-section-label"><Activity size={12} /> Activity</div>
              {transitionsLoading ? (
                <div className="idp-activity-list">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="idp-activity-row idp-activity-row--skeleton">
                      <div className="skeleton" style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0 }} />
                      <div className="skeleton" style={{ width: 80, height: 10, borderRadius: 4 }} />
                      <div className="skeleton" style={{ width: '40%', height: 10, borderRadius: 4 }} />
                      <div className="skeleton" style={{ width: 60, height: 10, borderRadius: 4 }} />
                    </div>
                  ))}
                </div>
              ) : transitions.length === 0 ? (
                <p className="idp-no-comments">No state transitions recorded.</p>
              ) : (
                <div className="idp-activity-list">
                  {transitions.map((t, i) => (
                    <div key={i} className="idp-activity-row">
                      <div className="idp-activity-dot" />
                      <span className="idp-activity-time">{formatTransitionTime(t.transitioned_at)}</span>
                      <div className="idp-activity-states">
                        <span className="idp-activity-from">{t.from_state || '—'}</span>
                        <span className="idp-activity-arrow">→</span>
                        <span className="idp-activity-to">{t.to_state}</span>
                      </div>
                      {t.duration_in_prev_state_hours != null && t.duration_in_prev_state_hours > 0 && (
                        <span className="idp-activity-dur">{fmtDuration(t.duration_in_prev_state_hours)}</span>
                      )}
                      {t.moved_by && <span className="idp-activity-by">{t.moved_by}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Attachments */}
            {(issue.attachments?.length ?? 0) > 0 && (
              <div className="idp-section">
                <div className="idp-section-label">
                  <Paperclip size={13} /> Attachments · {issue.attachments!.length}
                </div>
                <div className="idp-attachments-grid">
                  {issue.attachments!.map((a, i) => {
                    const isImg = isImageAttachment(a.mimeType, a.url)
                    const imgSrc = isYouTrack ? api.buildProxyUrl(a.url) : a.url
                    return (
                      <div
                        key={a.id}
                        className="idp-attachment-thumb"
                        onClick={() => setViewerIndex(i)}
                        role="button" tabIndex={0}
                        onKeyDown={e => e.key === 'Enter' && setViewerIndex(i)}
                        title={a.name}
                      >
                        {isImg ? (
                          <img src={imgSrc} alt={a.name}
                            onError={e => {
                              const el = e.currentTarget
                              el.style.display = 'none';
                              (el.nextElementSibling as HTMLElement | null)?.classList.add('idp-attachment-icon-fallback')
                            }} />
                        ) : null}
                        <div className={`idp-attachment-icon${isImg ? ' idp-attachment-icon--hidden' : ''}`}>
                          {attachmentTypeIcon(a.mimeType, a.name)}
                        </div>
                        <span className="idp-attachment-name">{a.name}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Comments */}
            {isYouTrack && (
              <div className="idp-section idp-comments-section">
                <div className="idp-section-label">
                  <MessageSquare size={13} />
                  Comments{comments.length > 0 ? ` · ${comments.length}` : ''}
                </div>

                {commentsLoading ? (
                  <div className="idp-comments-loading">
                    {[80, 65, 90].map((w, i) => (
                      <div key={i} className="idp-comment-skeleton">
                        <div className="skeleton" style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0 }} />
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div className="skeleton" style={{ width: '40%', height: 10, borderRadius: 4 }} />
                          <div className="skeleton" style={{ width: `${w}%`, height: 10, borderRadius: 4 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : comments.length === 0 ? (
                  <p className="idp-no-comments">No comments yet.</p>
                ) : (
                  <div className="idp-comments-list">
                    {comments.map(c => (
                      <div key={c.id} className="idp-comment">
                        <div className="idp-comment-avatar">
                          {c.author.avatarUrl
                            ? <img src={c.author.avatarUrl} alt={c.author.fullName} />
                            : <span>{getInitials(c.author.fullName || c.author.login)}</span>}
                        </div>
                        <div className="idp-comment-body">
                          <div className="idp-comment-header">
                            <span className="idp-comment-author">{c.author.fullName || c.author.login}</span>
                            <span className="idp-comment-time">{formatCommentTime(c.created)}</span>
                          </div>
                          <div className="idp-comment-text" dangerouslySetInnerHTML={{ __html: renderCommentText(c.text, ytBaseUrl) }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Comment composer with file upload ── */}
                <div
                  className={`idp-comment-input-wrap${dragOver ? ' idp-comment-input-wrap--dragover' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                >
                  <textarea
                    ref={textareaRef}
                    className="idp-comment-input"
                    placeholder="Write a comment… (drag & drop or paste files)"
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    onPaste={handlePaste}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handlePostComment()
                    }}
                    rows={3}
                  />

                  {/* Attached file previews */}
                  {attachFiles.length > 0 && (
                    <div className="idp-attach-previews">
                      {attachFiles.map((f, i) => (
                        <div key={i} className="idp-attach-preview-chip">
                          {filePreviewIcon(f)}
                          <span className="idp-attach-preview-name">{f.name}</span>
                          <span className="idp-attach-preview-size">{fmt_file_size(f.size)}</span>
                          <button
                            className="idp-attach-preview-remove"
                            onClick={() => setAttachFiles(prev => prev.filter((_, j) => j !== i))}
                            aria-label="Remove attachment"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {dragOver && (
                    <div className="idp-drop-overlay">
                      <Upload size={24} />
                      <span>Drop files to attach</span>
                    </div>
                  )}

                  <div className="idp-comment-actions">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      {/* Hidden file input */}
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.json,.zip"
                        style={{ display: 'none' }}
                        onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
                      />
                      <button
                        className="idp-attach-btn"
                        onClick={() => fileInputRef.current?.click()}
                        title="Attach file (or drag & drop / Ctrl+V)"
                        type="button"
                      >
                        <Paperclip size={14} />
                      </button>
                      <span className="idp-comment-hint">Ctrl+Enter to submit · drag & drop or Ctrl+V to attach</span>
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handlePostComment}
                      disabled={(!commentText.trim() && attachFiles.length === 0) || posting}
                    >
                      <Send size={13} />
                      {posting ? 'Posting…' : 'Add comment'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Right: editable metadata sidebar ── */}
          <div className="idp-sidebar">
            <div className="idp-meta-group">

              {/* State */}
              <div className="idp-meta-row">
                <span className="idp-meta-label">State</span>
                {isYouTrack && states.length > 0 ? (
                  <InlineSelect
                    value={localStatus}
                    options={states}
                    onSelect={handleStateChange}
                    saving={saving['status']}
                  />
                ) : (
                  <span className="idp-status-badge">{localStatus || '—'}</span>
                )}
              </div>

              {/* Priority */}
              <div className="idp-meta-row">
                <span className="idp-meta-label">Priority</span>
                {isYouTrack && priorities.length > 0 ? (
                  <InlineSelect
                    value={localPriority}
                    options={priorities}
                    onSelect={handlePriorityChange}
                    saving={saving['priority']}
                  />
                ) : (
                  localPriority
                    ? <span className="idp-priority-badge" style={priStyle}>{localPriority}</span>
                    : <span className="idp-meta-value">—</span>
                )}
              </div>

              {/* Type (read-only) */}
              {issue.type && (
                <div className="idp-meta-row">
                  <span className="idp-meta-label"><Tag size={11} style={{ opacity: 0.6 }} /> Type</span>
                  <span className="idp-meta-badge">{issue.type}</span>
                </div>
              )}

              {/* Assignee */}
              <div className="idp-meta-row">
                <span className="idp-meta-label"><User size={11} style={{ opacity: 0.6 }} /> Assignee</span>
                {isYouTrack && users.length > 0 ? (
                  <div ref={userRef} style={{ position: 'relative' }}>
                    <button
                      className="idp-editable-field idp-assignee-btn"
                      onClick={() => setUserOpen(o => !o)}
                      disabled={saving['assignee']}
                      title="Click to reassign"
                    >
                      {localAssignee ? (
                        <>
                          <div className="idp-assignee-avatar idp-assignee-avatar--sm">
                            {localAssignee.avatarUrl
                              ? <img src={localAssignee.avatarUrl} alt={localAssignee.fullName} />
                              : <span>{getInitials(localAssignee.fullName || localAssignee.login)}</span>}
                          </div>
                          <span>{localAssignee.fullName || localAssignee.login}</span>
                        </>
                      ) : <span>Unassigned</span>}
                      {saving['assignee'] ? <span className="idp-saving-dot" /> : <ChevronDown size={11} style={{ opacity: 0.5 }} />}
                    </button>
                    {userOpen && (
                      <div className="idp-select-menu idp-user-menu">
                        {users.map(u => (
                          <button
                            key={u.id}
                            className={`idp-select-option${localAssignee?.id === u.id ? ' active' : ''}`}
                            onClick={() => handleAssigneeChange(u)}
                          >
                            <div className="idp-assignee-avatar idp-assignee-avatar--sm">
                              {u.avatarUrl
                                ? <img src={u.avatarUrl} alt={u.fullName} />
                                : <span>{getInitials(u.fullName)}</span>}
                            </div>
                            <span>{u.fullName || u.login}</span>
                            {localAssignee?.id === u.id && <Check size={11} style={{ marginLeft: 'auto' }} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : localAssignee ? (
                  <div className="idp-assignee">
                    <div className="idp-assignee-avatar">
                      {localAssignee.avatarUrl
                        ? <img src={localAssignee.avatarUrl} alt={localAssignee.fullName} />
                        : <span>{getInitials(localAssignee.fullName || localAssignee.login)}</span>}
                    </div>
                    <div className="idp-assignee-info">
                      <span className="idp-assignee-name">{localAssignee.fullName || localAssignee.login}</span>
                    </div>
                  </div>
                ) : <span className="idp-meta-value">Unassigned</span>}
              </div>

              {/* Subsystem */}
              {issue.subsystem && (
                <div className="idp-meta-row">
                  <span className="idp-meta-label"><GitBranch size={11} style={{ opacity: 0.6 }} /> Subsystem</span>
                  <span className="idp-meta-value">{issue.subsystem}</span>
                </div>
              )}

              {/* Due date */}
              <div className="idp-meta-row">
                <span className="idp-meta-label"><Clock size={11} style={{ opacity: 0.6 }} /> Due date</span>
                {isYouTrack ? (
                  <div style={{ position: 'relative' }}>
                    <input
                      type="date"
                      className={`idp-date-input${dueDateMs && dueDateMs < Date.now() ? ' idp-overdue' : ''}`}
                      value={localDueDate}
                      onChange={e => handleDueDateChange(e.target.value)}
                      disabled={saving['due_date']}
                    />
                    {saving['due_date'] && <span className="idp-saving-dot" style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)' }} />}
                  </div>
                ) : (
                  <span className={`idp-meta-value ${dueDateMs && dueDateMs < Date.now() ? 'idp-overdue' : ''}`}>
                    {fmtDate(dueDateMs)}
                  </span>
                )}
              </div>

              <div className="idp-meta-divider" />

              <div className="idp-meta-row">
                <span className="idp-meta-label">Created</span>
                <span className="idp-meta-value idp-meta-value--sm">{fmtDateTime(issue.created)}</span>
              </div>
              <div className="idp-meta-row">
                <span className="idp-meta-label">Updated</span>
                <span className="idp-meta-value idp-meta-value--sm">{fmtDateTime(issue.updated)}</span>
              </div>
              {transitions.length > 0 && (
                <div className="idp-meta-row">
                  <span className="idp-meta-label">Transitions</span>
                  <span className="idp-meta-value">{transitions.length}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>

    {viewerIndex !== null && allAttachments.length > 0 && (
      <AttachmentViewer
        attachments={allAttachments}
        initialIndex={viewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    )}
    </>,
    document.body
  )
}
