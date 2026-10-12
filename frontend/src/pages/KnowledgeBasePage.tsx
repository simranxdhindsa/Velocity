import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Upload, StickyNote, RefreshCw, Shield, Users, Sparkles, XCircle, CheckCircle2 } from 'lucide-react'
import api from '@/services/api'
import type { KBDocument, KBVisibility } from '@/services/api'
import { useAuth } from '@/contexts/AuthContext'
import { CustomDropdown } from '@/components/CustomDropdown'
import { ConfirmModal } from '@/components/ConfirmModal'
import { KBDocRow, KBNoteEditor, KBTrySearch, KnowledgeBaseSkeleton } from './KnowledgeBaseParts'
import { VISIBILITY_OPTIONS, formatBytes } from './knowledge-base-types'
import '@/styles/pages/knowledge-base.css'

const DEFAULT_EXTS = ['.md', '.txt', '.csv', '.json', '.html', '.pdf', '.docx', '.pptx', '.xlsx']

interface Notice {
  kind: 'ok' | 'error'
  text: string
}

// Admin-only page for the team knowledge base: what Velocity Bot (Slack)
// and Claude (MCP search_knowledge_base) know about the team.
export function KnowledgeBasePage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [docs, setDocs] = useState<KBDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [vectorSearch, setVectorSearch] = useState(true)
  const [exts, setExts] = useState<string[]>(DEFAULT_EXTS)
  const [maxBytes, setMaxBytes] = useState(15 * 1024 * 1024)

  const [uploadVisibility, setUploadVisibility] = useState<KBVisibility>('everyone')
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [notices, setNotices] = useState<Notice[]>([])
  const [noteEditor, setNoteEditor] = useState<{ doc: KBDocument | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<KBDocument | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const replaceTarget = useRef<KBDocument | null>(null)

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    try {
      const r = await api.getKBDocuments()
      setDocs(r.data ?? [])
      setVectorSearch(r.vector_search ?? false)
      if (r.supported_extensions?.length) setExts(r.supported_extensions)
      if (r.max_file_bytes) setMaxBytes(r.max_file_bytes)
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the knowledge base')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  // Indexing runs in the background: poll while anything is processing.
  const processing = docs.some(d => d.status === 'processing')
  useEffect(() => {
    if (!processing) return
    const t = setInterval(() => load(true), 2500)
    return () => clearInterval(t)
  }, [processing, load])

  const notify = (n: Notice[]) => setNotices(n)

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return
    const tooBig = files.filter(f => f.size > maxBytes)
    const ok = files.filter(f => f.size <= maxBytes)
    const pre: Notice[] = tooBig.map(f => ({ kind: 'error', text: `${f.name}: larger than ${formatBytes(maxBytes)}` }))
    if (ok.length === 0) {
      notify(pre)
      return
    }
    setUploading(true)
    try {
      const r = await api.uploadKBDocuments(ok, uploadVisibility)
      const results = r.data ?? []
      notify([
        ...pre,
        ...results.map(res => res.error
          ? { kind: 'error' as const, text: `${res.filename}: ${res.error}` }
          : { kind: 'ok' as const, text: `${res.filename}: added, indexing now` }),
      ])
      await load(true)
    } catch (e) {
      notify([...pre, { kind: 'error', text: e instanceof Error ? e.message : 'Upload failed' }])
    } finally {
      setUploading(false)
    }
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    uploadFiles(files)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    uploadFiles(Array.from(e.dataTransfer.files))
  }

  const onReplacePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const target = replaceTarget.current
    if (!file || !target) return
    try {
      await api.replaceKBFile(target.id, file)
      notify([{ kind: 'ok', text: `${target.title}: new version uploaded, indexing now` }])
      load(true)
    } catch (err) {
      notify([{ kind: 'error', text: `${target.title}: ${err instanceof Error ? err.message : 'replace failed'}` }])
    }
  }

  // Row actions, stable so memoised rows don't re-render on every poll.
  const handleVisibility = useCallback(async (doc: KBDocument, v: KBVisibility) => {
    setDocs(prev => prev.map(d => d.id === doc.id ? { ...d, visibility: v } : d)) // optimistic
    try {
      await api.updateKBDocument(doc.id, { visibility: v })
    } catch (e) {
      setDocs(prev => prev.map(d => d.id === doc.id ? { ...d, visibility: doc.visibility } : d))
      setNotices([{ kind: 'error', text: `${doc.title}: ${e instanceof Error ? e.message : 'could not change visibility'}` }])
    }
  }, [])
  const handleEditNote = useCallback((doc: KBDocument) => setNoteEditor({ doc }), [])
  const handleReplace = useCallback((doc: KBDocument) => {
    replaceTarget.current = doc
    replaceInput.current?.click()
  }, [])
  const handleReindex = useCallback(async (doc: KBDocument) => {
    setDocs(prev => prev.map(d => d.id === doc.id ? { ...d, status: 'processing', error: '' } : d))
    try {
      await api.reindexKBDocument(doc.id)
    } catch (e) {
      setNotices([{ kind: 'error', text: `${doc.title}: ${e instanceof Error ? e.message : 'could not re-index'}` }])
    }
    load(true)
  }, [load])
  const handleDelete = useCallback((doc: KBDocument) => setConfirmDelete(doc), [])

  const doDelete = async () => {
    const doc = confirmDelete
    setConfirmDelete(null)
    if (!doc) return
    setDocs(prev => prev.filter(d => d.id !== doc.id))
    try {
      await api.deleteKBDocument(doc.id)
    } catch (e) {
      setNotices([{ kind: 'error', text: `${doc.title}: ${e instanceof Error ? e.message : 'could not delete'}` }])
      load(true)
    }
  }

  if (!isAdmin) {
    return (
      <div className="kb-page">
        <div className="kb-empty">
          <Shield size={32} />
          <p>Only admins can manage the knowledge base.</p>
        </div>
      </div>
    )
  }

  const readyCount = docs.filter(d => d.status === 'ready').length
  const adminOnlyCount = docs.filter(d => d.visibility === 'admins').length

  return (
    <div className="kb-page">
      <div className="kb-header">
        <div className="kb-header-title">
          <BookOpen size={20} />
          <div>
            <h2>Knowledge Base</h2>
            <p>What Velocity Bot and Claude know about your team. Only admins can see and change this page.</p>
          </div>
        </div>
        <div className="kb-header-stats">
          <span className="kb-stat">{docs.length} {docs.length === 1 ? 'document' : 'documents'}</span>
          {readyCount !== docs.length && <span className="kb-stat">{readyCount} ready</span>}
          {adminOnlyCount > 0 && <span className="kb-stat"><Shield size={12} />{adminOnlyCount} admin-only</span>}
          <span className={`kb-stat${vectorSearch ? ' kb-stat--good' : ' kb-stat--warn'}`} title={vectorSearch ? 'Finds exact names and paraphrased questions' : 'Meaning-based search is unavailable on this server, exact words still match'}>
            <Sparkles size={12} />{vectorSearch ? 'Smart search on' : 'Keyword search only'}
          </span>
          <button className="kb-btn" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'kb-spin' : ''} />Refresh
          </button>
        </div>
      </div>

      <div
        className={`kb-drop${dragOver ? ' kb-drop--over' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="kb-drop-text">
          <Upload size={22} />
          <div>
            <strong>{uploading ? 'Uploading…' : 'Drop files here'}</strong>
            <span className="kb-muted">{exts.join(' ')} up to {formatBytes(maxBytes)} each. Text is split into chunks automatically.</span>
          </div>
        </div>
        <div className="kb-drop-actions">
          <div className="kb-drop-vis">
            <span className="kb-muted">Visible to</span>
            <CustomDropdown
              className="kb-vis-dd"
              options={VISIBILITY_OPTIONS}
              value={uploadVisibility}
              onChange={setUploadVisibility}
              icon={uploadVisibility === 'admins' ? <Shield size={13} /> : <Users size={13} />}
            />
          </div>
          <button className="kb-btn kb-btn--primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
            <Upload size={14} />Upload files
          </button>
          <button className="kb-btn" onClick={() => setNoteEditor({ doc: null })}>
            <StickyNote size={14} />Write a note
          </button>
        </div>
        <input ref={fileInput} type="file" multiple accept={exts.join(',')} hidden onChange={onPick} />
        <input ref={replaceInput} type="file" accept={exts.join(',')} hidden onChange={onReplacePick} />
      </div>

      {notices.length > 0 && (
        <div className="kb-notices">
          {notices.map((n, i) => (
            <div key={i} className={`kb-notice kb-notice--${n.kind}`}>
              {n.kind === 'ok' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              <span>{n.text}</span>
            </div>
          ))}
          <button className="kb-link" onClick={() => setNotices([])}>Dismiss</button>
        </div>
      )}

      <KBTrySearch disabled={readyCount === 0} resetKey={docs.map(d => `${d.id}:${d.status}:${d.visibility}`).join('|')} />

      {loading ? (
        <KnowledgeBaseSkeleton />
      ) : loadError ? (
        <div className="kb-empty"><XCircle size={32} /><p>{loadError}</p></div>
      ) : docs.length === 0 ? (
        <div className="kb-empty">
          <BookOpen size={32} />
          <p>No documents yet. Upload a team roster, an onboarding guide or a process doc, or write a quick note about who does what.</p>
        </div>
      ) : (
        <div className="kb-list">
          {docs.map(d => (
            <KBDocRow
              key={d.id}
              doc={d}
              onVisibility={handleVisibility}
              onEditNote={handleEditNote}
              onReplace={handleReplace}
              onReindex={handleReindex}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {noteEditor && (
        <KBNoteEditor
          doc={noteEditor.doc}
          onClose={() => setNoteEditor(null)}
          onSaved={() => { setNoteEditor(null); load(true) }}
        />
      )}
      <ConfirmModal
        open={!!confirmDelete}
        title="Delete document?"
        message={`"${confirmDelete?.title ?? ''}" will be removed from the knowledge base.`}
        detail="Velocity Bot and Claude stop using it immediately. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
