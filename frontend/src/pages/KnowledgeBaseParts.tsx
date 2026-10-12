import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  FileText, FileSpreadsheet, FileCode, Presentation, StickyNote, Loader2, CheckCircle2, AlertTriangle,
  XCircle, Eye, Pencil, Upload, RotateCw, Trash2, X, Search, Users, Shield, ChevronUp,
} from 'lucide-react'
import api from '@/services/api'
import type { KBDocument, KBHit, KBVisibility } from '@/services/api'
import { CustomDropdown } from '@/components/CustomDropdown'
import { VISIBILITY_OPTIONS, isNote, fileExt, formatBytes, timeAgo } from './knowledge-base-types'
import '@/styles/pages/knowledge-base-tools.css'

// ── Icon ─────────────────────────────────────────────────────────────────────

function DocIcon({ doc }: { doc: KBDocument }) {
  if (isNote(doc)) return <StickyNote size={18} />
  const ext = fileExt(doc)
  if (['csv', 'tsv', 'xlsx'].includes(ext)) return <FileSpreadsheet size={18} />
  if (['json', 'yaml', 'yml', 'xml', 'html', 'htm'].includes(ext)) return <FileCode size={18} />
  if (ext === 'pptx') return <Presentation size={18} />
  return <FileText size={18} />
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

const W = [55, 70, 48, 65, 58, 72]

export function KnowledgeBaseSkeleton() {
  return (
    <div className="kb-list">
      {Array.from({ length: 5 }).map((_, i) => (
        <div className="kb-doc" key={i}>
          <div className="kb-doc-row">
            <div className="skeleton" style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0 }} />
            <div className="kb-doc-main">
              <div className="skeleton" style={{ width: `${W[i % 6]}%`, height: 14, borderRadius: 4, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: `${W[(i + 2) % 6]}%`, height: 11, borderRadius: 4 }} />
            </div>
            <div className="skeleton kb-hide-mobile" style={{ width: 92, height: 28, borderRadius: 8, flexShrink: 0 }} />
            <div className="skeleton" style={{ width: 64, height: 22, borderRadius: 999, flexShrink: 0 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ doc }: { doc: KBDocument }) {
  if (doc.status === 'processing') {
    return <span className="kb-badge kb-badge--processing"><Loader2 size={12} className="kb-spin" />Indexing</span>
  }
  if (doc.status === 'failed') {
    return <span className="kb-badge kb-badge--failed"><XCircle size={12} />Failed</span>
  }
  if (doc.error) {
    return <span className="kb-badge kb-badge--warn" title={doc.error}><AlertTriangle size={12} />Ready</span>
  }
  return <span className="kb-badge kb-badge--ready"><CheckCircle2 size={12} />Ready</span>
}

// ── Document row ─────────────────────────────────────────────────────────────

interface DocRowProps {
  doc: KBDocument
  onVisibility: (doc: KBDocument, v: KBVisibility) => void
  onEditNote: (doc: KBDocument) => void
  onReplace: (doc: KBDocument) => void
  onReindex: (doc: KBDocument) => void
  onDelete: (doc: KBDocument) => void
}

export const KBDocRow = memo(function KBDocRow({ doc, onVisibility, onEditNote, onReplace, onReindex, onDelete }: DocRowProps) {
  const [open, setOpen] = useState(false)
  const note = isNote(doc)
  const meta = [
    note ? 'Note' : doc.filename,
    formatBytes(doc.size_bytes),
    doc.status === 'ready' ? `${doc.chunk_count} ${doc.chunk_count === 1 ? 'chunk' : 'chunks'}` : null,
    doc.uploader_name || null,
    timeAgo(doc.updated_at),
  ].filter(Boolean)

  return (
    <div className={`kb-doc${open ? ' kb-doc--open' : ''}`}>
      <div className="kb-doc-row">
        <div className={`kb-doc-icon${note ? ' kb-doc-icon--note' : ''}`}><DocIcon doc={doc} /></div>
        <div className="kb-doc-main">
          <div className="kb-doc-title">{doc.title}</div>
          <div className="kb-doc-meta">{meta.join(' · ')}</div>
          {doc.error && (
            <div className={`kb-doc-msg${doc.status === 'failed' ? ' kb-doc-msg--fail' : ''}`}>{doc.error}</div>
          )}
        </div>
        <CustomDropdown
          className="kb-vis-dd"
          options={VISIBILITY_OPTIONS}
          value={doc.visibility}
          onChange={v => v !== doc.visibility && onVisibility(doc, v)}
          icon={doc.visibility === 'admins' ? <Shield size={13} /> : <Users size={13} />}
        />
        <StatusBadge doc={doc} />
        <div className="kb-doc-actions">
          <button className="kb-icon-btn" title={open ? 'Hide chunks' : 'See how it was split'} onClick={() => setOpen(o => !o)} disabled={doc.status !== 'ready'}>
            {open ? <ChevronUp size={15} /> : <Eye size={15} />}
          </button>
          {note ? (
            <button className="kb-icon-btn" title="Edit note" onClick={() => onEditNote(doc)}><Pencil size={15} /></button>
          ) : (
            <button className="kb-icon-btn" title="Upload a new version" onClick={() => onReplace(doc)}><Upload size={15} /></button>
          )}
          <button className="kb-icon-btn" title="Index again" onClick={() => onReindex(doc)} disabled={doc.status === 'processing'}><RotateCw size={15} /></button>
          <button className="kb-icon-btn kb-icon-btn--danger" title="Delete" onClick={() => onDelete(doc)}><Trash2 size={15} /></button>
        </div>
      </div>
      {open && <ChunkPreview docId={doc.id} />}
    </div>
  )
})

function ChunkPreview({ docId }: { docId: string }) {
  const [chunks, setChunks] = useState<KBHit[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api.getKBChunks(docId)
      .then(r => setChunks(r.data ?? []))
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load chunks'))
  }, [docId])
  if (error) return <div className="kb-chunks"><p className="kb-muted">{error}</p></div>
  if (!chunks) {
    return (
      <div className="kb-chunks">
        {[0, 1].map(i => <div key={i} className="skeleton" style={{ height: 54, borderRadius: 8, marginBottom: 8 }} />)}
      </div>
    )
  }
  return (
    <div className="kb-chunks">
      <p className="kb-muted">This is exactly what Velocity Bot and Claude can read from this document.</p>
      {chunks.map((c, i) => (
        <div className="kb-chunk" key={c.chunk_id}>
          <div className="kb-chunk-head">
            <span className="kb-chunk-num">#{i + 1}</span>
            {c.heading && <span className="kb-chunk-heading">{c.heading}</span>}
          </div>
          <pre className="kb-chunk-body">{c.content}</pre>
        </div>
      ))}
    </div>
  )
}

// ── Try a question ───────────────────────────────────────────────────────────

const MATCH_LABEL: Record<string, string> = { both: 'Keyword + meaning', keyword: 'Keyword', meaning: 'Meaning' }

// resetKey changes whenever documents are added, removed, re-indexed or
// change visibility, so stale results (e.g. from a deleted doc) are cleared.
export function KBTrySearch({ disabled, resetKey }: { disabled: boolean; resetKey: string }) {
  const [q, setQ] = useState('')
  const [as, setAs] = useState<'everyone' | 'admin'>('everyone')
  const [hits, setHits] = useState<KBHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [shownFor, setShownFor] = useState(resetKey)
  if (shownFor !== resetKey) {
    // Adjust state during render (React's recommended alternative to an effect)
    setShownFor(resetKey)
    setHits(null)
  }

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!q.trim()) return
    setBusy(true)
    setError('')
    try {
      const r = await api.searchKB(q.trim(), as)
      setHits(r.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="kb-try">
      <div className="kb-try-head">
        <Search size={15} />
        <h3>Try a question</h3>
        <span className="kb-muted kb-hide-mobile">See what the bot would find before anyone asks it</span>
      </div>
      <form className="kb-try-form" onSubmit={run}>
        <input
          className="kb-input"
          placeholder="e.g. Who owns payments?"
          value={q}
          onChange={e => setQ(e.target.value)}
          disabled={disabled}
        />
        <div className="kb-seg" role="group" aria-label="Ask as">
          <button type="button" className={as === 'everyone' ? 'active' : ''} onClick={() => setAs('everyone')}>As a member</button>
          <button type="button" className={as === 'admin' ? 'active' : ''} onClick={() => setAs('admin')}>As an admin</button>
        </div>
        <button className="kb-btn kb-btn--primary" type="submit" disabled={disabled || busy || !q.trim()}>
          {busy ? <Loader2 size={14} className="kb-spin" /> : <Search size={14} />}Search
        </button>
      </form>
      {error && <p className="kb-error">{error}</p>}
      {hits && !error && (
        hits.length === 0 ? (
          <p className="kb-muted kb-try-empty">{"Nothing relevant found, so the bot would say it doesn't know."}</p>
        ) : (
          <div className="kb-hits">
            {hits.map(h => (
              <div className="kb-hit" key={h.chunk_id}>
                <div className="kb-hit-head">
                  <span className="kb-hit-src">{h.document_title}{h.heading ? ` › ${h.heading}` : ''}</span>
                  {h.matched && <span className="kb-hit-tag">{MATCH_LABEL[h.matched]}</span>}
                  {h.visibility === 'admins' && <span className="kb-hit-tag kb-hit-tag--admin"><Shield size={11} />Admins only</span>}
                </div>
                <p className="kb-hit-body">{h.content.length > 420 ? h.content.slice(0, 420) + '…' : h.content}</p>
              </div>
            ))}
          </div>
        )
      )}
    </section>
  )
}

// ── Note editor ──────────────────────────────────────────────────────────────

const NOTE_PLACEHOLDER = `# Team

## Amrinder
Backend developer. Owns the payments service. Ask about refunds and invoices.

## Simran
QA lead and project manager for Ardoise.`

interface NoteEditorProps {
  doc: KBDocument | null // null = new note
  onClose: () => void
  onSaved: () => void
}

export function KBNoteEditor({ doc, onClose, onSaved }: NoteEditorProps) {
  const [title, setTitle] = useState(doc?.title ?? '')
  const [content, setContent] = useState('')
  const [visibility, setVisibility] = useState<KBVisibility>(doc?.visibility ?? 'everyone')
  const [loading, setLoading] = useState(!!doc)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!doc) return
    api.getKBNoteText(doc.id)
      .then(r => {
        if (r.data) {
          setTitle(r.data.title)
          setContent(r.data.content)
          setVisibility(r.data.visibility)
        }
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load the note'))
      .finally(() => setLoading(false))
  }, [doc])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      setError('Give the note a title and some content.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const body = { title: title.trim(), content, visibility }
      if (doc) await api.updateKBNote(doc.id, body)
      else await api.createKBNote(body)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the note')
      setSaving(false)
    }
  }

  return createPortal(
    <div className="kb-modal-overlay" onMouseDown={onClose}>
      <div className="kb-modal" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="kb-modal-head">
          <StickyNote size={16} />
          <h3>{doc ? 'Edit note' : 'Write a note'}</h3>
          <button className="kb-icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>
        <div className="kb-modal-body">
          {loading ? (
            <>
              <div className="skeleton" style={{ height: 38, borderRadius: 8, marginBottom: 12 }} />
              <div className="skeleton" style={{ height: 260, borderRadius: 8 }} />
            </>
          ) : (
            <>
              <div className="kb-field-row">
                <input className="kb-input" placeholder="Title, e.g. Team directory" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
                <CustomDropdown
                  className="kb-vis-dd"
                  options={VISIBILITY_OPTIONS}
                  value={visibility}
                  onChange={setVisibility}
                  icon={visibility === 'admins' ? <Shield size={13} /> : <Users size={13} />}
                />
              </div>
              <textarea
                className="kb-textarea"
                placeholder={NOTE_PLACEHOLDER}
                value={content}
                onChange={e => setContent(e.target.value)}
              />
              <p className="kb-muted">Markdown works best. Give each person or topic its own heading so answers stay precise.</p>
            </>
          )}
          {error && <p className="kb-error">{error}</p>}
        </div>
        <div className="kb-modal-foot">
          <button className="kb-btn" onClick={onClose}>Cancel</button>
          <button className="kb-btn kb-btn--primary" onClick={save} disabled={saving || loading}>
            {saving && <Loader2 size={14} className="kb-spin" />}{doc ? 'Save changes' : 'Add to knowledge base'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
