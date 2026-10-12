import { useRef, useState } from 'react'
import { UploadCloud, X, CheckCircle2, Trash2, AlertCircle, Loader2, StickyNote } from 'lucide-react'
import type { KBUploadItem } from '@/hooks/useKBUploads'
import { formatBytes } from './knowledge-base-types'
import '@/styles/pages/knowledge-base-upload.css'

// Knowledge Base upload card, always on the page (not a modal): drag and
// drop or browse, then a live list of files with real upload progress and
// indexing status. Design adapted from
// the 21st.dev "File Upload Card" (ravikatiyar162), rebuilt with Velocity's
// CSS tokens instead of shadcn/Tailwind.

interface Props {
  items: KBUploadItem[]
  onAdd: (files: File[]) => void
  onDismiss: (item: KBUploadItem) => void   // cancel / clear a row
  onDelete: (item: KBUploadItem) => void    // remove a finished file from the KB
  exts: string[]
  maxBytes: number
  onWriteNote: () => void
}

const COMMON_FORMATS = ['.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.md', '.txt']

function typeBadge(name: string) {
  return (name.split('.').pop() ?? 'file').slice(0, 4).toUpperCase()
}

function statusLine(i: KBUploadItem) {
  switch (i.status) {
    case 'uploading':
      return <>{formatBytes(Math.round((i.file.size * i.progress) / 100))} of {formatBytes(i.file.size)}<span className="kbu-dot">•</span><span className="kbu-st kbu-st--up">Uploading {i.progress}%</span></>
    case 'indexing':
      return <>{formatBytes(i.file.size)}<span className="kbu-dot">•</span><span className="kbu-st kbu-st--up">Splitting into chunks…</span></>
    case 'done':
      return <>{formatBytes(i.file.size)}<span className="kbu-dot">•</span><span className="kbu-st kbu-st--ok">Ready</span></>
    default:
      return <span className="kbu-st kbu-st--err">{i.error || 'Failed'}</span>
  }
}

export function KBUploadCard({ items, onAdd, onDismiss, onDelete, exts, maxBytes, onWriteNote }: Props) {
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // Lead with the formats people actually use, not the order the server lists them.
  const common = COMMON_FORMATS.filter(e => exts.includes(e))
  const rest = exts.length - common.length
  const formatText = common.map(e => e.slice(1).toUpperCase()).join(', ') + (rest > 0 ? ' and more' : '')

  return (
      <section className="kbu-card" aria-labelledby="kbu-title">
        <div className="kbu-head">
          <div className="kbu-head-icon"><UploadCloud size={22} /></div>
          <div className="kbu-head-text">
            <h3 id="kbu-title">Upload files</h3>
            <p>Add documents for Velocity Bot and Claude to learn from. They are split into chunks automatically.</p>
          </div>
          <button className="kbu-note-btn" onClick={onWriteNote}><StickyNote size={14} />Write a note</button>
        </div>

        <div
          className={`kbu-drop${dragging ? ' kbu-drop--over' : ''}`}
          onClick={() => input.current?.click()}
          onDragEnter={e => { e.preventDefault(); setDragging(true) }}
          onDragOver={e => e.preventDefault()}
          onDragLeave={e => { e.preventDefault(); if (e.currentTarget === e.target) setDragging(false) }}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            const files = Array.from(e.dataTransfer.files)
            if (files.length) onAdd(files)
          }}
        >
          <UploadCloud size={40} className="kbu-drop-icon" />
          <p className="kbu-drop-title">Choose a file or drag &amp; drop it here.</p>
          <p className="kbu-drop-sub">{formatText} formats, up to {formatBytes(maxBytes)} each.</p>
          <span className="kbu-browse">Browse File</span>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept={exts.join(',')}
            onChange={e => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (files.length) onAdd(files)
            }}
          />
        </div>

        {items.length > 0 && (
          <ul className="kbu-list">
            {items.map(i => (
              <li key={i.id} className={`kbu-item kbu-item--${i.status}`}>
                <div className="kbu-badge">{typeBadge(i.file.name)}</div>
                <div className="kbu-item-main">
                  <p className="kbu-name" title={i.file.name}>{i.file.name}</p>
                  <div className="kbu-meta">{statusLine(i)}</div>
                  {(i.status === 'uploading' || i.status === 'indexing') && (
                    <div className={`kbu-bar${i.status === 'indexing' ? ' kbu-bar--indeterminate' : ''}`}>
                      <div className="kbu-bar-fill" style={i.status === 'uploading' ? { width: `${i.progress}%` } : undefined} />
                    </div>
                  )}
                </div>
                <div className="kbu-item-actions">
                  {i.status === 'done' && <CheckCircle2 size={20} className="kbu-ok-icon" />}
                  {i.status === 'error' && <AlertCircle size={20} className="kbu-err-icon" />}
                  {i.status === 'indexing' && <Loader2 size={18} className="kbu-spin kbu-wait-icon" />}
                  {i.status === 'done' ? (
                    <button className="kbu-icon-btn" title="Remove from knowledge base" aria-label="Remove from knowledge base" onClick={() => onDelete(i)}>
                      <Trash2 size={15} />
                    </button>
                  ) : i.status !== 'indexing' && (
                    <button className="kbu-icon-btn" title={i.status === 'uploading' ? 'Cancel upload' : 'Clear'} aria-label={i.status === 'uploading' ? 'Cancel upload' : 'Clear'} onClick={() => onDismiss(i)}>
                      <X size={15} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
  )
}
