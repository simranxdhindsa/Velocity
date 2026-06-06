import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  X, Bold, Italic, Strikethrough, Code, Link2, List, MoreHorizontal,
  ChevronDown, Loader2, Check, Eye, FileCode2, Paperclip, Type, Hash,
  Sparkles, AlertCircle, Pencil,
} from 'lucide-react'
import { marked } from 'marked'
import api from '../services/api'
import type { YouTrackUser, YouTrackState, DeveloperSubsystemConfig, YouTrackIssue } from '../services/api'
import MicButton from './MicButton'
import { IssueDetailPanel } from './IssueDetailPanel'
import { useYouTrackBaseUrl } from '../hooks/useYouTrackBaseUrl'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FormMeta {
  states: YouTrackState[]
  priorities: { name: string; background: string; foreground: string }[]
  types: { name: string; background: string; foreground: string }[]
  subsystems: { name: string; background: string; foreground: string }[]
  users: YouTrackUser[]
  sprints: { id: string; name: string; start: number; finish: number; isCompleted: boolean }[]
  developerConfigs: DeveloperSubsystemConfig[]
}

interface CreateIssueFormData {
  summary: string
  description: string
  state: string
  priority: string
  type_name: string
  assignee_login: string
  assignee_name: string
  assignee_avatar: string
  subsystem: string
  sprint_id: string
  sprint_name: string
  due_date: string
  estimation: string
}

interface CreateIssueModalProps {
  onClose: () => void
  onCreated: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseEstimation(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  let total = 0
  const hMatch = raw.match(/(\d+)\s*h/i)
  const mMatch = raw.match(/(\d+)\s*m/i)
  if (hMatch) total += parseInt(hMatch[1]) * 60
  if (mMatch) total += parseInt(mMatch[1])
  return total > 0 ? total : undefined
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CreateIssueModal({ onClose, onCreated }: CreateIssueModalProps) {
  const ytBaseUrl = useYouTrackBaseUrl()

  // After creation, store the full issue and switch to IssueDetailPanel view
  const [createdFullIssue, setCreatedFullIssue] = useState<YouTrackIssue | null>(null)

  const [form, setForm] = useState<CreateIssueFormData>({
    summary: '', description: '', state: '', priority: 'Normal',
    type_name: '', assignee_login: '', assignee_name: '', assignee_avatar: '',
    subsystem: '', sprint_id: '', sprint_name: '', due_date: '', estimation: '',
  })

  const [meta, setMeta] = useState<FormMeta>({
    states: [], priorities: [], types: [], subsystems: [], users: [], sprints: [], developerConfigs: [],
  })
  const [metaLoading, setMetaLoading] = useState(true)

  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const [creating, setCreating] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState(false)
  const [createdIssueId, setCreatedIssueId] = useState<string | null>(null)
  const [createdReadableId, setCreatedReadableId] = useState('')
  const [isViewMode, setIsViewMode] = useState(false)
  const [openDropdown, setOpenDropdown] = useState<
    'state' | 'priority' | 'type' | 'assignee' | 'subsystem' | 'sprint' | 'textformat' | null
  >(null)
  const [assigneeSearch, setAssigneeSearch] = useState('')
  const [descMode, setDescMode] = useState<'visual' | 'markdown'>('visual')
  const [submitAttempted, setSubmitAttempted] = useState(false)

  const summaryRef  = useRef<HTMLInputElement>(null)
  const descRef     = useRef<HTMLTextAreaElement>(null)
  const visualRef   = useRef<HTMLDivElement>(null)
  const modalRef    = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Fetch all form meta in one call on mount
  useEffect(() => {
    api.getYouTrackFormMeta().then(res => {
      if (res.success && res.data) {
        const d = res.data
        setMeta({ ...d, developerConfigs: d.developer_configs ?? [] })
        // Default state: prefer "To Do", fall back to "Backlog", then first state
        const todoState =
          d.states.find(s => s.name.toLowerCase() === 'to do') ??
          d.states.find(s => s.name.toLowerCase() === 'backlog') ??
          d.states[0]
        if (todoState) {
          setForm(f => ({ ...f, state: todoState.name }))
        }
        // Default sprint: last non-completed sprint (highest index = most recent)
        const activesprints = d.sprints.filter(s => !s.isCompleted)
        const defaultSprint = activesprints[activesprints.length - 1] ?? d.sprints[d.sprints.length - 1]
        if (defaultSprint) {
          setForm(f => ({ ...f, sprint_id: defaultSprint.id, sprint_name: defaultSprint.name }))
        }
      }
    }).catch(() => {}).finally(() => setMetaLoading(false))
  }, [])

  useEffect(() => { summaryRef.current?.focus() }, [])

  // Always-current ref so the useEffect reads the latest description without a stale closure
  const latestDesc = useRef(form.description)
  latestDesc.current = form.description

  // Populate contenteditable when switching to visual mode (not on every keystroke)
  useEffect(() => {
    if (descMode === 'visual' && !isViewMode && visualRef.current) {
      visualRef.current.innerHTML = marked.parse(latestDesc.current) as string
      // Move cursor to end
      const range = document.createRange()
      const sel = window.getSelection()
      range.selectNodeContents(visualRef.current)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [descMode, isViewMode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (modalRef.current?.contains(e.target as Node)) return
      setOpenDropdown(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const set = (k: keyof CreateIssueFormData, v: string) =>
    setForm(f => ({ ...f, [k]: v }))

  const wrapText = useCallback((before: string, after = before) => {
    const ta = descRef.current
    if (!ta) return
    const s = ta.selectionStart, e = ta.selectionEnd
    const selected = ta.value.slice(s, e)
    set('description', ta.value.slice(0, s) + before + selected + after + ta.value.slice(e))
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(s + before.length, e + before.length) })
  }, [])

  const insertLine = useCallback((prefix: string) => {
    const ta = descRef.current
    if (!ta) return
    const s = ta.selectionStart
    const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1
    set('description', ta.value.slice(0, lineStart) + prefix + ta.value.slice(lineStart))
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(s + prefix.length, s + prefix.length) })
  }, [])

  const PRIORITY_CODE: Record<string, string> = {
    'Show-stopper': 'P0', 'Critical': 'P1', 'Major': 'P2', 'Normal': 'P3', 'Minor': 'P4',
  }

  const handleAiFill = async () => {
    const raw = form.description.trim()
    if (!raw || aiLoading) return
    setAiLoading(true)
    setError(null)
    try {
      const res = await api.aiParseTicket(raw, {
        users: meta.users.map(u => ({ login: u.login, fullName: u.fullName || u.login })),
        types: meta.types.map(t => t.name),
        subsystems: meta.subsystems.map(s => s.name),
        priorities: meta.priorities.map(p => p.name),
        sprints: meta.sprints.map(s => ({ id: s.id, name: s.name })),
      })
      if (res.success && res.data) {
        const d = res.data

        // Validate subsystem against live list — trim + case-insensitive to handle minor AI variations
        const rawSub = (d.subsystem ?? '').trim()
        const validSubsystem =
          meta.subsystems.find(s => s.name === rawSub)?.name
          ?? meta.subsystems.find(s => s.name.toLowerCase() === rawSub.toLowerCase())?.name
          ?? ''

        // Only apply priority if the raw text contains an explicit priority signal
        const hasPriorityHint = /\bp[0-4]\b|show[\s-]?stopper|critical|major|blocker|urgent|high[\s-]priority/i.test(raw)
        const validPriority = hasPriorityHint
          ? (meta.priorities.find(p => p.name === d.priority)?.name ?? form.priority)
          : form.priority

        // Build title: "P{n} {subsystem}: {title}" — priority prefix only when there's a hint
        const pCode = PRIORITY_CODE[validPriority ?? 'Normal'] ?? 'P3'
        const baseTitle = d.summary || form.summary
        const subsystemPrefix = validSubsystem  // never use AI's abbreviation fallback
        const cleanTitle = baseTitle
          .replace(/^P\d+\s+/, '')
          .replace(new RegExp(`^${subsystemPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '')
          .trim()
        const fullSummary = subsystemPrefix
          ? hasPriorityHint ? `${pCode} ${subsystemPrefix}: ${cleanTitle}` : `${subsystemPrefix}: ${cleanTitle}`
          : hasPriorityHint ? `${pCode} ${cleanTitle}` : cleanTitle

        // Smart assignee: use developer-subsystem config if available for this subsystem.
        // Priority: (1) AI matched someone configured for this subsystem → keep
        //           (2) AI picked someone not configured → use first configured dev
        //           (3) No config for this subsystem → use AI's pick as-is
        let resolvedLogin = d.assignee_login
        if (validSubsystem && meta.developerConfigs.length > 0) {
          const configuredDevs = meta.developerConfigs.filter(c => !c.is_qa && c.subsystems.includes(validSubsystem))
          if (configuredDevs.length > 0) {
            const aiPickIsConfigured = configuredDevs.some(c => c.developer_login === d.assignee_login)
            resolvedLogin = aiPickIsConfigured ? d.assignee_login : configuredDevs[0].developer_login
          }
        }
        const matchedUser = meta.users.find(u => u.login === resolvedLogin)
        const matchedSprint = meta.sprints.find(s => s.id === d.sprint_id)
        setForm(f => ({
          ...f,
          summary:         fullSummary || f.summary,
          description:     d.description || f.description,
          priority:        validPriority ?? form.priority,
          type_name:       d.type_name || f.type_name,
          subsystem:       validSubsystem || f.subsystem,
          assignee_login:  matchedUser ? matchedUser.login : f.assignee_login,
          assignee_name:   matchedUser ? (matchedUser.fullName || matchedUser.login) : f.assignee_name,
          assignee_avatar: matchedUser ? (matchedUser.avatarUrl || '') : f.assignee_avatar,
          sprint_id:       matchedSprint ? matchedSprint.id : f.sprint_id,
          sprint_name:     matchedSprint ? matchedSprint.name : f.sprint_name,
        }))
        // Switch to markdown mode so the AI-generated description renders correctly
        setDescMode('markdown')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI parsing failed')
    } finally {
      setAiLoading(false)
    }
  }

  const handleCreate = async () => {
    setSubmitAttempted(true)
    if (!form.summary.trim() || !form.type_name || !form.subsystem) return
    setCreating(true)
    setError(null)
    try {
      const dueDateMs      = form.due_date ? new Date(form.due_date).getTime() : undefined
      const estimationMins = parseEstimation(form.estimation)
      const res = await api.createYouTrackIssue({
        summary:            form.summary.trim(),
        description:        form.description || undefined,
        state:              form.state || undefined,
        priority:           form.priority || undefined,
        type_name:          form.type_name || undefined,
        assignee_login:     form.assignee_login || undefined,
        subsystem:          form.subsystem || undefined,
        sprint_id:          form.sprint_id || undefined,
        due_date:           dueDateMs,
        estimation_minutes: estimationMins,
      })

      if (res.success && res.data) {
        const id = (res.data as any).id || ''
        const readable = (res.data as any).idReadable || id
        // Upload staged attachments after creation
        if (stagedFiles.length > 0 && id) {
          await Promise.allSettled(stagedFiles.map(f => api.uploadYouTrackAttachment(id, f)))
        }
        setCreated(true)
        setCreatedIssueId(id)
        setCreatedReadableId(readable)
        onCreated()
        // Fetch full issue to switch to unified IssueDetailPanel view
        try {
          const fullRes = await api.getYouTrackIssue(readable || id)
          const fullIssue = (fullRes as any).data ?? fullRes
          if (fullIssue?.id) setCreatedFullIssue(fullIssue as YouTrackIssue)
          else { setIsViewMode(true); setDescMode('visual') }
        } catch {
          setIsViewMode(true)
          setDescMode('visual')
        }
      } else {
        setError('Failed to create issue')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create issue')
    } finally {
      setCreating(false)
    }
  }

  const handleUpdate = async () => {
    if (!createdIssueId) return
    setCreating(true)
    setError(null)
    try {
      const dueDateMs      = form.due_date ? new Date(form.due_date).getTime() : undefined
      const estimationMins = parseEstimation(form.estimation)
      const res = await api.updateYouTrackIssue(createdIssueId, {
        summary:            form.summary.trim(),
        description:        form.description || undefined,
        state:              form.state || undefined,
        priority:           form.priority || undefined,
        type_name:          form.type_name || undefined,
        assignee_login:     form.assignee_login || undefined,
        subsystem:          form.subsystem || undefined,
        sprint_id:          form.sprint_id || undefined,
        due_date:           dueDateMs,
        estimation_minutes: estimationMins,
      })
      if (res.success) {
        setIsViewMode(true)
        setDescMode('visual')
      } else {
        setError('Failed to update issue')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update issue')
    } finally {
      setCreating(false)
    }
  }

  const handleDescPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) as File[]
    if (files.length > 0) {
      e.preventDefault()
      setStagedFiles(prev => [...prev, ...files])
    }
  }, [])

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    setStagedFiles(f => [...f, ...files])
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setStagedFiles(f => [...f, ...files])
    e.target.value = ''
  }

  const removeFile = (idx: number) =>
    setStagedFiles(f => f.filter((_, i) => i !== idx))

  const filteredUsers = meta.users.filter(u =>
    !assigneeSearch ||
    (u.fullName ?? '').toLowerCase().includes(assigneeSearch.toLowerCase()) ||
    u.login.toLowerCase().includes(assigneeSearch.toLowerCase())
  )

  const toggle = (name: typeof openDropdown) =>
    setOpenDropdown(o => o === name ? null : name)

  const canCreate = form.summary.trim().length > 0 && !creating && !created && !createdIssueId
  const enterEdit = () => { setIsViewMode(false); setDescMode('markdown') }

  const descHasText = form.description.trim().length > 0

  const missing = (field: string) => submitAttempted && !field

  // Priority display
  const priorityDisplay = meta.priorities.find(p => p.name === form.priority) ?? null

  // After successful creation, delegate entirely to IssueDetailPanel (single source of truth)
  if (createdFullIssue) {
    return <IssueDetailPanel issue={createdFullIssue} onClose={onClose} ytBaseUrl={ytBaseUrl} />
  }

  return (
    <div className="ci-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ci-modal" ref={modalRef}>
        {isViewMode && (
          <button className="ci-pencil-btn" onClick={enterEdit} title="Edit ticket">
            <Pencil size={14} />
          </button>
        )}
        {createdReadableId && <span className="ci-ticket-id">{createdReadableId}</span>}
        <button className="ci-close-btn" onClick={onClose} title="Close"><X size={15} /></button>

        {/* ══ LEFT PANEL ═══════════════════════════════════════════════ */}
        <div className="ci-left">

          {/* Summary */}
          <div className="ci-summary-row">
            <input
              ref={summaryRef}
              className={`ci-summary-input${missing(form.summary.trim()) ? ' ci-field--error' : ''}${isViewMode ? ' ci-summary-input--view' : ''}`}
              placeholder="Summary*"
              value={form.summary}
              readOnly={isViewMode}
              onClick={() => isViewMode && enterEdit()}
              onChange={e => !isViewMode && set('summary', e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setDescMode('markdown'); setTimeout(() => descRef.current?.focus(), 50) } }}
            />
            <MicButton
              className="ci-summary-mic"
              onResult={t => set('summary', form.summary ? form.summary + ' ' + t : t)}
            />
          </div>
          {missing(form.summary.trim()) && (
            <span className="ci-field-error-msg"><AlertCircle size={11} /> Summary is required</span>
          )}

          {/* Formatting toolbar */}
          <div className="ci-toolbar">
            <div className="ci-toolbar-left">
              <div style={{ position: 'relative' }}>
                <button className="ci-tb-btn" onClick={() => toggle('textformat')} title="Text format">
                  <Type size={13} />
                  <span style={{ fontSize: '12px', marginLeft: '3px' }}>Normal text</span>
                  <ChevronDown size={11} style={{ marginLeft: '2px' }} />
                </button>
                {openDropdown === 'textformat' && (
                  <div className="ci-dropdown-menu" style={{ left: 0, top: 'calc(100% + 4px)', minWidth: '140px' }} onClick={e => e.stopPropagation()}>
                    {['Normal text', 'Heading 1', 'Heading 2', 'Heading 3', 'Code block'].map(t => (
                      <button key={t} className="ci-dropdown-item" onClick={() => setOpenDropdown(null)}>{t}</button>
                    ))}
                  </div>
                )}
              </div>
              <div className="ci-tb-sep" />
              <button className="ci-tb-btn" title="Bold"          onClick={() => wrapText('**')}><Bold size={14} /></button>
              <button className="ci-tb-btn" title="Italic"        onClick={() => wrapText('*')}><Italic size={14} /></button>
              <button className="ci-tb-btn" title="Strikethrough" onClick={() => wrapText('~~')}><Strikethrough size={14} /></button>
              <button className="ci-tb-btn" title="Quote"         onClick={() => insertLine('> ')}><Hash size={14} /></button>
              <button className="ci-tb-btn" title="Code"          onClick={() => wrapText('`')}><Code size={14} /></button>
              <button className="ci-tb-btn" title="Link"          onClick={() => wrapText('[', '](url)')}><Link2 size={14} /></button>
              <button className="ci-tb-btn" title="List"          onClick={() => insertLine('- ')}><List size={14} /></button>
              <button className="ci-tb-btn" title="More"><MoreHorizontal size={14} /></button>
            </div>
            <div className="ci-mode-tabs">
              <button className={`ci-mode-tab ${descMode === 'visual' ? 'active' : ''}`} onClick={() => setDescMode('visual')}><Eye size={12} /> Visual</button>
              <button className={`ci-mode-tab ${descMode === 'markdown' ? 'active' : ''}`} onClick={() => setDescMode('markdown')}><FileCode2 size={12} /> Markdown</button>
            </div>
          </div>

          {/* Scrollable body: description + attach + validation */}
          <div className="ci-left-body">
            {/* Description with overlaid mic (top-right) and AI Fill (bottom-right) */}
            <div className="ci-desc-wrap">
              {isViewMode ? (
                /* Read-only rendered preview after ticket creation */
                <div className="ci-desc-input ci-desc-preview">
                  {form.description
                    ? <div className="ci-desc-rendered" dangerouslySetInnerHTML={{ __html: marked.parse(form.description) as string }} />
                    : <span className="ci-desc-placeholder">No description</span>
                  }
                </div>
              ) : descMode === 'visual' ? (
                /* Visual mode: contenteditable — shows rendered formatting, fully editable */
                <div
                  ref={visualRef}
                  contentEditable
                  suppressContentEditableWarning
                  className="ci-desc-input ci-desc-visual-edit"
                  onInput={e => set('description', (e.currentTarget as HTMLDivElement).innerText)}
                  onPaste={e => {
                    const items = Array.from(e.clipboardData?.items ?? [])
                    const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) as File[]
                    if (files.length > 0) { e.preventDefault(); setStagedFiles(prev => [...prev, ...files]) }
                  }}
                />
              ) : (
                /* Markdown mode: plain textarea with raw markdown syntax */
                <textarea
                  ref={descRef}
                  className="ci-desc-input"
                  placeholder="Describe the issue or paste raw text…"
                  value={form.description}
                  onChange={e => set('description', e.target.value)}
                  onPaste={handleDescPaste}
                />
              )}
              {/* Mic — top-right corner of description box */}
              <MicButton
                className="ci-desc-mic"
                onResult={t => {
                  const newDesc = latestDesc.current ? latestDesc.current + '\n' + t : t
                  set('description', newDesc)
                  // In visual mode update the contenteditable DOM directly so the text is visible immediately
                  if (descMode === 'visual' && visualRef.current) {
                    visualRef.current.innerHTML = marked.parse(newDesc) as string
                    const range = document.createRange()
                    const sel = window.getSelection()
                    range.selectNodeContents(visualRef.current)
                    range.collapse(false)
                    sel?.removeAllRanges()
                    sel?.addRange(range)
                  }
                }}
              />
              {/* AI Fill — bottom-right, shown only when description has text */}
              {descHasText && (
                <button
                  className={`ci-ai-btn${aiLoading ? ' ci-ai-btn--loading' : ''}`}
                  onClick={handleAiFill}
                  disabled={aiLoading}
                  title="Fill all fields with AI"
                >
                  {aiLoading
                    ? <Loader2 size={13} className="animate-spin" />
                    : <Sparkles size={13} />
                  }
                  {aiLoading ? 'Analysing…' : 'AI Fill'}
                </button>
              )}
            </div>

            {/* Attach files */}
            <div
              className="ci-attach-row"
              onDragOver={e => e.preventDefault()}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={14} />
              <span>Click to <span className="ci-browse-link">browse</span> or drag files here</span>
              <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
            </div>
            {stagedFiles.length > 0 && (
              <div className="ci-staged-files">
                {stagedFiles.map((f, i) => (
                  <div key={i} className="ci-staged-file">
                    <Paperclip size={11} />
                    <span>{f.name}</span>
                    <button className="ci-staged-remove" onClick={() => removeFile(i)}><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}

            {/* Validation errors */}
            {submitAttempted && (!form.type_name || !form.subsystem) && (
              <div className="ci-error">
                <AlertCircle size={13} />
                {!form.type_name && !form.subsystem ? 'Type and Subsystem are required'
                 : !form.type_name ? 'Type is required'
                 : 'Subsystem is required'}
              </div>
            )}
            {error && <div className="ci-error"><AlertCircle size={13} /> {error}</div>}

            {/* Similar issues */}
            <div style={{ marginTop: '0.4rem' }}>
              <button className="ci-tb-btn" style={{ gap: '5px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <ChevronDown size={13} /> Similar Issues and Articles
              </button>
            </div>
          </div>

          {/* Footer actions — always pinned to bottom */}
          <div className="ci-actions">
            {isViewMode ? (
              <>
                <button className="ci-btn-create" onClick={enterEdit}><Pencil size={13} /> Edit</button>
                <button className="ci-btn-cancel" onClick={onClose}>Done</button>
              </>
            ) : createdIssueId ? (
              <>
                <button className="ci-btn-create" onClick={handleUpdate} disabled={creating}>
                  {creating ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : <><Check size={13} /> Save</>}
                </button>
                <button className="ci-btn-cancel" onClick={() => { setIsViewMode(true); setDescMode('visual') }}>Cancel</button>
              </>
            ) : (
              <>
                <button className="ci-btn-create" onClick={handleCreate} disabled={!canCreate}>
                  {created ? <><Check size={14} /> Created</>
                   : creating ? <><Loader2 size={14} className="animate-spin" /> Creating…</>
                   : 'Create'}
                </button>
                <button className="ci-btn-cancel" onClick={onClose}>Cancel</button>
              </>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button className="ci-tb-btn" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', gap: '4px' }}>
                <Eye size={13} /> Visible to issue readers
              </button>
            </span>
          </div>
        </div>

        {/* ══ RIGHT SIDEBAR ════════════════════════════════════════════ */}
        <div className="ci-sidebar">

          {/* Project — static */}
          <div className="ci-sidebar-field">
            <span className="ci-sidebar-label">Project</span>
            <div className="ci-sidebar-value">
              <span className="ci-project-badge">ARD</span>
              <span className="ci-sidebar-val-text">ARD</span>
            </div>
          </div>

          {/* Type — MANDATORY */}
          <div
            className={`ci-sidebar-field ci-dropdown-field${missing(form.type_name) ? ' ci-field--error' : ''}`}
            onClick={() => isViewMode ? enterEdit() : toggle('type')}
          >
            <span className="ci-sidebar-label">
              Type <span className="ci-required-star">*</span>
            </span>
            <div className="ci-sidebar-value ci-clickable">
              {form.type_name
                ? <span className="ci-sidebar-val-text">{form.type_name}</span>
                : <span className={`ci-sidebar-val-placeholder${missing(form.type_name) ? ' ci-placeholder--error' : ''}`}>
                    {missing(form.type_name) ? '⚠ Required' : 'No Type'}
                  </span>
              }
              <ChevronDown size={13} className={`ci-chevron ${openDropdown === 'type' ? 'open' : ''}`} />
            </div>
            {openDropdown === 'type' && (
              <div className="ci-dropdown-menu" onClick={e => e.stopPropagation()}>
                {metaLoading
                  ? <div className="ci-dropdown-loading">Loading…</div>
                  : meta.types.length === 0
                    ? <div className="ci-dropdown-loading">No types found</div>
                    : meta.types.map(t => (
                        <button
                          key={t.name}
                          className={`ci-dropdown-item ${form.type_name === t.name ? 'active' : ''}`}
                          onClick={() => { set('type_name', t.name); setOpenDropdown(null) }}
                        >{t.name}</button>
                      ))
                }
              </div>
            )}
          </div>

          {/* Priority */}
          <div className="ci-sidebar-field ci-dropdown-field" onClick={() => isViewMode ? enterEdit() : toggle('priority')}>
            <span className="ci-sidebar-label">Priority</span>
            <div className="ci-sidebar-value ci-clickable">
              <span
                className="ci-priority-dot"
                style={priorityDisplay ? { background: priorityDisplay.background || undefined } : undefined}
              />
              <span className="ci-sidebar-val-text">{form.priority || 'Normal'}</span>
              <ChevronDown size={13} className={`ci-chevron ${openDropdown === 'priority' ? 'open' : ''}`} />
            </div>
            {openDropdown === 'priority' && (
              <div className="ci-dropdown-menu" onClick={e => e.stopPropagation()}>
                {metaLoading
                  ? <div className="ci-dropdown-loading">Loading…</div>
                  : (meta.priorities.length > 0 ? meta.priorities : [{ name: 'Show-stopper', background: '#e00', foreground: '#fff' }, { name: 'Critical', background: '#f60', foreground: '#fff' }, { name: 'Major', background: '#fa0', foreground: '#fff' }, { name: 'Normal', background: '#888', foreground: '#fff' }, { name: 'Minor', background: '#aaa', foreground: '#fff' }]).map(p => (
                      <button
                        key={p.name}
                        className={`ci-dropdown-item ${form.priority === p.name ? 'active' : ''}`}
                        onClick={() => { set('priority', p.name); setOpenDropdown(null) }}
                      >
                        <span className="ci-priority-dot" style={{ background: p.background || undefined }} />
                        <span>{p.name}</span>
                      </button>
                    ))
                }
              </div>
            )}
          </div>

          {/* State */}
          <div className="ci-sidebar-field ci-dropdown-field" onClick={() => isViewMode ? enterEdit() : toggle('state')}>
            <span className="ci-sidebar-label">State</span>
            <div className="ci-sidebar-value ci-clickable">
              <span className="ci-sidebar-val-text ci-state-val">{form.state || 'To Do'}</span>
              <ChevronDown size={13} className={`ci-chevron ${openDropdown === 'state' ? 'open' : ''}`} />
            </div>
            {openDropdown === 'state' && (
              <div className="ci-dropdown-menu" onClick={e => e.stopPropagation()}>
                {metaLoading
                  ? <div className="ci-dropdown-loading">Loading…</div>
                  : (meta.states.length > 0 ? meta.states : [{ name: 'Backlog' }, { name: 'In Progress' }, { name: 'Done' }]).map(s => (
                      <button
                        key={s.name}
                        className={`ci-dropdown-item ${form.state === s.name ? 'active' : ''}`}
                        onClick={() => { set('state', s.name); setOpenDropdown(null) }}
                      >{s.name}</button>
                    ))
                }
              </div>
            )}
          </div>

          {/* Assignee */}
          <div className="ci-sidebar-field ci-dropdown-field" onClick={() => isViewMode ? enterEdit() : (toggle('assignee'), setAssigneeSearch(''))}>
            <span className="ci-sidebar-label">Assignee</span>
            <div className="ci-sidebar-value ci-clickable">
              {form.assignee_login ? (
                <>
                  {form.assignee_avatar
                    ? <img src={form.assignee_avatar} alt="" className="ci-avatar-img" />
                    : <span className="ci-avatar-placeholder">{(form.assignee_name || form.assignee_login).charAt(0).toUpperCase()}</span>
                  }
                  <span className="ci-sidebar-val-text">{form.assignee_name || form.assignee_login}</span>
                </>
              ) : (
                <span className="ci-sidebar-val-placeholder">Unassigned</span>
              )}
              <ChevronDown size={13} className={`ci-chevron ${openDropdown === 'assignee' ? 'open' : ''}`} />
            </div>
            {openDropdown === 'assignee' && (
              <div className="ci-dropdown-menu ci-assignee-menu" onClick={e => e.stopPropagation()}>
                <input
                  className="ci-assignee-search"
                  placeholder="Search members…"
                  value={assigneeSearch}
                  onChange={e => setAssigneeSearch(e.target.value)}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                />
                <button
                  className={`ci-dropdown-item ${!form.assignee_login ? 'active' : ''}`}
                  onClick={() => { set('assignee_login', ''); set('assignee_name', ''); set('assignee_avatar', ''); setOpenDropdown(null) }}
                >
                  <span className="ci-avatar-placeholder">–</span>
                  <span>Unassigned</span>
                </button>
                {filteredUsers.map(u => (
                  <button
                    key={u.id}
                    className={`ci-dropdown-item ${form.assignee_login === u.login ? 'active' : ''}`}
                    onClick={() => {
                      set('assignee_login', u.login)
                      set('assignee_name', u.fullName || u.login)
                      set('assignee_avatar', u.avatarUrl || '')
                      setOpenDropdown(null)
                    }}
                  >
                    {u.avatarUrl
                      ? <img src={u.avatarUrl} alt={u.fullName} className="ci-avatar-img" />
                      : <span className="ci-avatar-placeholder">{(u.fullName || u.login).charAt(0).toUpperCase()}</span>
                    }
                    <span>{u.fullName || u.login}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Subsystem — MANDATORY */}
          <div
            className={`ci-sidebar-field ci-dropdown-field${missing(form.subsystem) ? ' ci-field--error' : ''}`}
            onClick={() => isViewMode ? enterEdit() : toggle('subsystem')}
          >
            <span className="ci-sidebar-label">
              Subsystem <span className="ci-required-star">*</span>
            </span>
            <div className="ci-sidebar-value ci-clickable">
              {form.subsystem
                ? <span className="ci-sidebar-val-text">{form.subsystem}</span>
                : <span className={`ci-sidebar-val-placeholder${missing(form.subsystem) ? ' ci-placeholder--error' : ''}`}>
                    {missing(form.subsystem) ? '⚠ Required' : 'No Subsystem'}
                  </span>
              }
              <ChevronDown size={13} className={`ci-chevron ${openDropdown === 'subsystem' ? 'open' : ''}`} />
            </div>
            {openDropdown === 'subsystem' && (
              <div className="ci-dropdown-menu" onClick={e => e.stopPropagation()}>
                {metaLoading
                  ? <div className="ci-dropdown-loading">Loading…</div>
                  : <>
                      <button
                        className={`ci-dropdown-item ${!form.subsystem ? 'active' : ''}`}
                        onClick={() => { set('subsystem', ''); setOpenDropdown(null) }}
                      >No Subsystem</button>
                      {meta.subsystems.map(s => (
                        <button
                          key={s.name}
                          className={`ci-dropdown-item ${form.subsystem === s.name ? 'active' : ''}`}
                          onClick={() => { set('subsystem', s.name); setOpenDropdown(null) }}
                        >{s.name}</button>
                      ))}
                    </>
                }
              </div>
            )}
          </div>

          {/* Sprint / Board */}
          <div className="ci-sidebar-field ci-dropdown-field" onClick={() => isViewMode ? enterEdit() : toggle('sprint')}>
            <span className="ci-sidebar-label">Boards</span>
            <div className="ci-sidebar-value ci-clickable">
              {form.sprint_name
                ? <span className="ci-sidebar-val-text">{form.sprint_name}</span>
                : <span className="ci-sidebar-val-placeholder">No visible boards</span>
              }
              <ChevronDown size={13} className={`ci-chevron ${openDropdown === 'sprint' ? 'open' : ''}`} />
            </div>
            {openDropdown === 'sprint' && (
              <div className="ci-dropdown-menu" onClick={e => e.stopPropagation()}>
                {metaLoading
                  ? <div className="ci-dropdown-loading">Loading…</div>
                  : <>
                      <button
                        className={`ci-dropdown-item ${!form.sprint_id ? 'active' : ''}`}
                        onClick={() => { set('sprint_id', ''); set('sprint_name', ''); setOpenDropdown(null) }}
                      >No board</button>
                      {meta.sprints.map(s => (
                        <button
                          key={s.id}
                          className={`ci-dropdown-item ${form.sprint_id === s.id ? 'active' : ''}`}
                          onClick={() => { set('sprint_id', s.id); set('sprint_name', s.name); setOpenDropdown(null) }}
                        >
                          <span>{s.name}</span>
                          {!s.isCompleted && <span className="ci-sprint-active-dot" />}
                        </button>
                      ))}
                    </>
                }
              </div>
            )}
          </div>

          {/* Estimation */}
          <div className="ci-sidebar-field">
            <span className="ci-sidebar-label">Estimation</span>
            <input
              className="ci-sidebar-input"
              placeholder="e.g. 2h 30m"
              value={form.estimation}
              onChange={e => set('estimation', e.target.value)}
              onClick={e => { e.stopPropagation(); setOpenDropdown(null) }}
            />
          </div>

          {/* Due Date */}
          <div className="ci-sidebar-field" onClick={() => isViewMode && enterEdit()}>
            <span className="ci-sidebar-label">Due Date</span>
            <input
              type="date"
              className="ci-sidebar-input ci-date-input"
              value={form.due_date}
              readOnly={isViewMode}
              onChange={e => !isViewMode && set('due_date', e.target.value)}
              onClick={e => { e.stopPropagation(); setOpenDropdown(null) }}
            />
          </div>

        </div>
      </div>
    </div>
  )
}
