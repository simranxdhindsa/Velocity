import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Shield, Sparkles, XCircle, CheckCircle2 } from 'lucide-react'
import api from '@/services/api'
import type { KBDocument } from '@/services/api'
import { useAuth } from '@/contexts/AuthContext'
import { ConfirmModal } from '@/components/ConfirmModal'
import { KBDocRow, KBNoteEditor, KBTrySearch, KnowledgeBaseSkeleton } from './KnowledgeBaseParts'
import { KBUploadCard } from './KnowledgeBaseUpload'
import { useKBUploads } from '@/hooks/useKBUploads'
import type { KBUploadItem } from '@/hooks/useKBUploads'
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
  const [loadError, setLoadError] = useState('')
  const [smartSearch, setSmartSearch] = useState(true)
  const [exts, setExts] = useState<string[]>(DEFAULT_EXTS)
  const [maxBytes, setMaxBytes] = useState(15 * 1024 * 1024)

  const [notices, setNotices] = useState<Notice[]>([])
  const [noteEditor, setNoteEditor] = useState<{ doc: KBDocument | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<KBDocument | null>(null)

  const replaceInput = useRef<HTMLInputElement>(null)
  const replaceTarget = useRef<KBDocument | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.getKBDocuments()
      setDocs(r.data ?? [])
      setSmartSearch(r.smart_search ?? false)
      if (r.supported_extensions?.length) setExts(r.supported_extensions)
      if (r.max_file_bytes) setMaxBytes(r.max_file_bytes)
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the knowledge base')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  // Indexing runs in the background: poll while anything is processing.
  const processing = docs.some(d => d.status === 'processing')
  useEffect(() => {
    if (!processing) return
    const t = setInterval(() => load(), 2500)
    return () => clearInterval(t)
  }, [processing, load])

  const notify = (n: Notice[]) => setNotices(n)

  // Upload queue lives in the page; the card below renders it.
  const { items: uploads, add: addUploads, dismiss: dismissUpload } =
    useKBUploads({ docs, maxBytes, exts, onUploaded: load })

  // The bin on a finished upload removes the document, via the same
  // confirmation as the list's delete button.
  const deleteUploaded = (item: KBUploadItem) => {
    const doc = docs.find(d => d.id === item.docId)
    if (doc) setConfirmDelete(doc)
    else dismissUpload(item.id)
  }

  const onReplacePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const target = replaceTarget.current
    if (!file || !target) return
    try {
      await api.replaceKBFile(target.id, file)
      notify([{ kind: 'ok', text: `${target.title}: new version uploaded, indexing now` }])
      load()
    } catch (err) {
      notify([{ kind: 'error', text: `${target.title}: ${err instanceof Error ? err.message : 'replace failed'}` }])
    }
  }

  // Row actions, stable so memoised rows don't re-render on every poll.
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
    load()
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
      load()
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

  return (
    <div className="kb-page">
      <div className="kb-header">
        <div className="kb-header-title">
          <BookOpen size={20} />
          <div>
            <h2>Knowledge Base</h2>
            <p>What Velocity Bot and Claude know about your team. Everyone gets the same answers, only admins can change this page.</p>
          </div>
        </div>
        <div className="kb-header-stats">
          <span className="kb-stat">{docs.length} {docs.length === 1 ? 'document' : 'documents'}</span>
          {readyCount !== docs.length && <span className="kb-stat">{readyCount} ready</span>}
          <span className={`kb-stat${smartSearch ? ' kb-stat--good' : ' kb-stat--warn'}`} title={smartSearch ? 'Finds exact names and paraphrased questions' : 'No AI key is configured, so only exact words match'}>
            <Sparkles size={12} />{smartSearch ? 'Smart search on' : 'Keyword search only'}
          </span>
        </div>
      </div>

      <KBUploadCard
        items={uploads}
        onAdd={addUploads}
        onDismiss={i => dismissUpload(i.id)}
        onDelete={deleteUploaded}
        exts={exts}
        maxBytes={maxBytes}
        onWriteNote={() => setNoteEditor({ doc: null })}
      />
      <input ref={replaceInput} type="file" accept={exts.join(',')} hidden onChange={onReplacePick} />

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

      <KBTrySearch disabled={readyCount === 0} resetKey={docs.map(d => `${d.id}:${d.status}`).join('|')} />

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
          onSaved={() => { setNoteEditor(null); load() }}
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
