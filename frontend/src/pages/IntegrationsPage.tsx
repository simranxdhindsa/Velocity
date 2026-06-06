import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import api from '../services/api'
import type { WorkflowConfig, PriorityTag, ColumnState, HotfixRules, ReportConfig, DeveloperSubsystemConfig, YouTrackUser } from '../services/api'
import { getActiveSource, loadActiveSourceFromDB, setActiveSource } from '../services/pmDataService'
import type { DataSource } from '../services/pmDataService'
import {
  RefreshCw, CheckCircle, AlertCircle, ExternalLink,
  Settings, Save, MessageSquare, Download, Clock, User, Sliders,
  Plus, Trash2, RotateCcw, ChevronDown, ChevronUp, Link2, Unlink, GripVertical
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface SlackStatus {
  connected: boolean
  team_id?: string
  team_name?: string
  channel_id?: string
  channel_name?: string
  monitor_channel_id?: string
  monitor_channel_name?: string
}

interface SlackChannel {
  id: string
  name: string
  is_private: boolean
  is_member: boolean
}

interface SlackMessage {
  id: string
  channel_id: string
  user_id: string
  user_name: string
  text: string
  timestamp: string
}

interface YouTrackStatus {
  connected: boolean
  configured: boolean
  error?: string
  base_url?: string
  project_id?: string
  board_id?: string
  source?: 'user_db' | 'global_db' | 'env'
}

type MainTab = 'youtrack' | 'asana' | 'slack' | 'workflow' | 'developers'

interface IntegrationsPageProps {
  initialTab?: MainTab
  onTabChange?: (tab: MainTab) => void
  userRole?: string
}

// Reusable compact custom dropdown for string option lists
interface WcSelectDropdownProps {
  value: string
  options: string[]
  onChange: (val: string) => void
  className?: string
}
function WcSelectDropdown({ value, options, onChange, className = '' }: WcSelectDropdownProps) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.wc-sel-dropdown')) {
        setOpen(false); setRect(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  return (
    <div className={`pm-custom-dropdown wc-sel-dropdown ${className}`}>
      <button
        type="button"
        className="pm-custom-dropdown-trigger wc-sel-trigger"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
          setRect(r); setOpen(o => !o)
        }}
      >
        <span>{value}</span>
        <ChevronDown size={11} className={`dropdown-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && rect && createPortal(
        <div className="pm-custom-dropdown-menu wc-sel-dropdown" style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, minWidth: rect.width, zIndex: 9999 }}>
          {options.map(opt => (
            <button key={opt} type="button" className={`pm-dropdown-item ${value === opt ? 'active' : ''}`}
              onClick={() => { onChange(opt); setOpen(false); setRect(null) }}>
              <span>{opt}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

// Dropdown for object option lists (id + label pairs)
interface WcObjDropdownProps {
  value: string
  placeholder?: string
  options: Array<{ id: string; name: string }>
  onChange: (id: string) => void
  className?: string
  disabled?: boolean
}
function WcObjDropdown({ value, placeholder = '— Select —', options, onChange, className = '', disabled = false }: WcObjDropdownProps) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.wc-obj-dropdown')) {
        setOpen(false); setRect(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  const label = options.find(o => o.id === value)?.name ?? placeholder
  return (
    <div className={`pm-custom-dropdown wc-obj-dropdown ${className}`}>
      <button
        type="button"
        className="pm-custom-dropdown-trigger"
        disabled={disabled}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
          setRect(r); setOpen(o => !o)
        }}
      >
        <span>{label}</span>
        <ChevronDown size={11} className={`dropdown-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && rect && createPortal(
        <div className="pm-custom-dropdown-menu wc-obj-dropdown" style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, minWidth: rect.width, zIndex: 9999 }}>
          {options.map(opt => (
            <button key={opt.id} type="button" className={`pm-dropdown-item ${value === opt.id ? 'active' : ''}`}
              onClick={() => { onChange(opt.id); setOpen(false); setRect(null) }}>
              <span>{opt.name}</span>
            </button>
          ))}
          {options.length === 0 && (
            <div className="pm-dropdown-item" style={{ opacity: 0.5, cursor: 'default' }}>No projects found</div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

const ROLE_COLORS: Record<string, string> = {
  backlog:  '#6b7280',
  active:   '#3d6eff',
  blocked:  '#ef4444',
  findings: '#f59e0b',
  dev_done: '#22c55e',
  verified: '#06b6d4',
  deployed: '#8b5cf6',
  closed:   '#94a3b8',
}

interface SortableColumnRowProps {
  col: ColumnState
  i: number
  updateColumn: (i: number, field: keyof ColumnState, value: string | number | boolean | string[]) => void
  removeColumn: (i: number) => void
  COLUMN_ROLES: string[]
}

function SortableColumnRow({ col, i, updateColumn, removeColumn, COLUMN_ROLES }: SortableColumnRowProps) {
  const id = col.state || `__empty_${i}`
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
  const roleColor = ROLE_COLORS[col.role] || 'transparent'
  return (
    <div ref={setNodeRef} style={style} className="wc-col-card">
      <div className="wc-col-card-stripe" style={{ background: roleColor }} />
      <div className="wc-drag-handle" {...attributes} {...listeners}><GripVertical size={14} /></div>
      <span className="wc-col-rank">{i + 1}</span>
      <input
        type="text"
        value={col.state}
        onChange={e => updateColumn(i, 'state', e.target.value)}
        className="wc-input wc-col-name-input"
        placeholder="Column name"
      />
      <WcSelectDropdown value={col.role || '—'} options={['—', ...COLUMN_ROLES]} onChange={val => updateColumn(i, 'role', val === '—' ? '' : val)} className="wc-sel-col-role" />
      <input
        type="text"
        value={(col.aliases ?? []).join(', ')}
        onChange={e => updateColumn(i, 'aliases', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
        className="wc-input wc-input-grow"
        placeholder="alias1, alias2"
      />
      <label className="wc-lateral-toggle" title="Lateral move (doesn't count as bounce)">
        <input type="checkbox" checked={col.is_lateral} onChange={e => updateColumn(i, 'is_lateral', e.target.checked)} className="wc-checkbox" />
        <span>Lateral</span>
      </label>
      <button className="wc-icon-btn wc-icon-btn-danger" onClick={() => removeColumn(i)} title="Remove row"><Trash2 size={12} /></button>
    </div>
  )
}

interface ColumnDndListProps {
  editColumns: ColumnState[]
  setEditColumns: React.Dispatch<React.SetStateAction<ColumnState[]>>
  updateColumn: (i: number, field: keyof ColumnState, value: string | number | boolean | string[]) => void
  removeColumn: (i: number) => void
  COLUMN_ROLES: string[]
}

function ColumnDndList({ editColumns, setEditColumns, updateColumn, removeColumn, COLUMN_ROLES }: ColumnDndListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setEditColumns(prev => {
        const oldIndex = prev.findIndex((c, idx) => (c.state || `__empty_${idx}`) === active.id)
        const newIndex = prev.findIndex((c, idx) => (c.state || `__empty_${idx}`) === over.id)
        return arrayMove(prev, oldIndex, newIndex)
      })
    }
  }
  const items = editColumns.map((c, i) => c.state || `__empty_${i}`)
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {editColumns.map((col, i) => (
          <SortableColumnRow key={col.state || `__empty_${i}`} col={col} i={i} updateColumn={updateColumn} removeColumn={removeColumn} COLUMN_ROLES={COLUMN_ROLES} />
        ))}
      </SortableContext>
    </DndContext>
  )
}

export function IntegrationsPage({ initialTab = 'youtrack', onTabChange, userRole }: IntegrationsPageProps = {}) {
  const isMember = userRole === 'member' || userRole === 'viewer'
  const isFullAccess = userRole === 'admin' || userRole === 'project_manager'
  const [mainTab, setMainTab] = useState<MainTab>(initialTab)

  useEffect(() => {
    if (initialTab && initialTab !== mainTab) {
      setMainTab(initialTab)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab])
  const [loading, setLoading] = useState(true)

  // ── YouTrack ────────────────────────────────────────────────────────────────
  const [ytStatus, setYtStatus] = useState<YouTrackStatus | null>(null)
  const [ytChecking, setYtChecking] = useState(false)
  const [ytSaving, setYtSaving] = useState(false)
  const [ytError, setYtError] = useState<string | null>(null)
  const [ytSuccess, setYtSuccess] = useState<string | null>(null)
  const [ytConfigured, setYtConfigured] = useState(false)
  const [ytBaseURL, setYtBaseURL] = useState('')
  const [ytToken, setYtToken] = useState('')
  const [ytProjectID, setYtProjectID] = useState('')
  const [ytBoardID, setYtBoardID] = useState('')
  const [ytConnected, setYtConnected] = useState(false)
  const [showYtForm, setShowYtForm] = useState(false)
  const [ytBoards, setYtBoards] = useState<Array<{ id: string; name: string }>>([])
  const [ytBoardsLoading, setYtBoardsLoading] = useState(false)

  // ── Asana ────────────────────────────────────────────────────────────────────
  const [asanaConnected, setAsanaConnected] = useState(false)
  const [asanaWorkspaceName, setAsanaWorkspaceName] = useState('')
  const [asanaHasProject, setAsanaHasProject] = useState(false)
  const [asanaPAT, setAsanaPAT] = useState('')
  const [asanaWorkspaceID, setAsanaWorkspaceID] = useState('')
  const [asanaSaving, setAsanaSaving] = useState(false)
  const [asanaError, setAsanaError] = useState<string | null>(null)
  const [asanaSuccess, setAsanaSuccess] = useState<string | null>(null)
  const [showAsanaForm, setShowAsanaForm] = useState(false)
  const [asanaProjects, setAsanaProjects] = useState<Array<{ id: string; name: string }>>([])
  const [asanaSelectedProject, setAsanaSelectedProject] = useState('')
  const [asanaProjectName, setAsanaProjectName] = useState('')
  const [asanaLoadingProjects, setAsanaLoadingProjects] = useState(false)
  const [asanaSavingProject, setAsanaSavingProject] = useState(false)

  // ── Slack ───────────────────────────────────────────────────────────────────
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null)
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([])
  const [slackBotToken, setSlackBotToken] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('')
  const [connectingSlack, setConnectingSlack] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [slackMessages, setSlackMessages] = useState<SlackMessage[]>([])
  const [fetchingMessages, setFetchingMessages] = useState(false)
  const [msgDateFrom, setMsgDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]
  })
  const [msgDateTo, setMsgDateTo] = useState(() => new Date().toISOString().split('T')[0])
  const [showSlackInstructions, setShowSlackInstructions] = useState(false)
  const [slackError, setSlackError] = useState<string | null>(null)
  const [slackSuccess, setSlackSuccess] = useState<string | null>(null)

  // ── YT metadata ─────────────────────────────────────────────────────────────
  const [ytPriorities, setYtPriorities] = useState<string[]>([])
  const [ytStates, setYtStates] = useState<string[]>([])

  // ── Workflow Config ─────────────────────────────────────────────────────────
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowConfig | null>(null)
  const [wcSection, setWcSection] = useState<'priorities' | 'columns' | 'hotfix' | 'report'>('priorities')
  const [wcSaving, setWcSaving] = useState(false)
  const [wcSuccess, setWcSuccess] = useState<string | null>(null)
  const [wcError, setWcError] = useState<string | null>(null)
  const [editTags, setEditTags] = useState<PriorityTag[]>([])
  const [ytMappingOpen, setYtMappingOpen] = useState<number | null>(null)
  const [ytMappingRect, setYtMappingRect] = useState<DOMRect | null>(null)
  const ytMappingRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [channelDropdownOpen, setChannelDropdownOpen] = useState(false)
  const [channelDropdownRect, setChannelDropdownRect] = useState<DOMRect | null>(null)
  const [doneRoleOpen, setDoneRoleOpen] = useState(false)
  const [doneRoleRect, setDoneRoleRect] = useState<DOMRect | null>(null)
  const [editColumns, setEditColumns] = useState<ColumnState[]>([])
  const [columnsLoadingFromYT, setColumnsLoadingFromYT] = useState(false)
  const [editHotfix, setEditHotfix] = useState<HotfixRules>({ from_states: [], to_states: [], type_field_name: '', hotfix_values: [], regression_values: [] })
  const [typeFieldValues, setTypeFieldValues] = useState<{ name: string; background?: string }[]>([])
  const [typeFieldLoading, setTypeFieldLoading] = useState(false)
  const [prioritiesLoadingFromYT, setPrioritiesLoadingFromYT] = useState(false)
  const [editReport, setEditReport] = useState<ReportConfig>({
    done_role: 'dev_done', blocked_states: [], open_states: [], priority_filters: [], sections: [], tracked_column_roles: []
  })
  const wcSource = 'youtrack' as const
  const setWcSource = (_src: 'youtrack' | 'asana') => {} // no-op: Asana removed

  // Auto-load columns from YouTrack board when Column Hierarchy tab opens (Issue 3)
  useEffect(() => {
    if (wcSection !== 'columns') return
    setColumnsLoadingFromYT(true)
    api.getYouTrackDefaultBoardColumns().then(res => {
      const boardCols = (res as any).data as import('../services/api').YouTrackColumn[] ?? []
      if (!boardCols?.length) return
      const seen = new Set<string>()
      const stateNames: string[] = []
      boardCols.forEach(col => col.fieldValues.forEach(v => {
        const k = v.toLowerCase()
        if (!seen.has(k)) { seen.add(k); stateNames.push(v) }
      }))
      if (stateNames.length === 0) return
      setEditColumns(prev => {
        const storedMap = new Map(prev.map(c => [c.state.toLowerCase(), c]))
        return stateNames.map((name, i) => {
          const stored = storedMap.get(name.toLowerCase())
          return stored ? { ...stored, state: name, rank: i } : { state: name, rank: i, aliases: [], role: '', is_lateral: false }
        })
      })
    }).catch(() => {}).finally(() => setColumnsLoadingFromYT(false))
  }, [wcSection, wcSource]) // eslint-disable-line react-hooks/exhaustive-deps

  // For Report Defaults Open/Blocked States: use real Asana sections in Asana mode,
  const reportAvailableStates = ytStates

  useEffect(() => {
    Promise.all([fetchYtIntegration(), fetchSlackStatus(), fetchWorkflowConfig()])
      .finally(() => setLoading(false))
  }, [])

  // Fetch boards whenever the form is shown (so dropdown is populated)
  useEffect(() => {
    if (showYtForm && ytConnected) fetchYtBoards()
  }, [showYtForm]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ytMappingOpen === null) return
    const close = () => setYtMappingOpen(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [ytMappingOpen])

  // Fetch YT metadata (priorities + states) — try on mount and again once YT is confirmed connected
  useEffect(() => {
    api.getYouTrackPriorities().then(res => {
      if (res.success && res.data) setYtPriorities(res.data as unknown as string[])
    }).catch(() => {})
    api.getYouTrackStates().then(res => {
      if (res.success && res.data) setYtStates((res.data as unknown as Array<{ name: string }>).map(s => s.name))
    }).catch(() => {})
  }, [])

  // ── YouTrack ────────────────────────────────────────────────────────────────
  const fetchYtIntegration = async () => {
    // Check per-user DB row first
    let hasDbRow = false
    try {
      const res = await api.getYouTrackIntegration()
      if (res.success && res.data?.configured) {
        hasDbRow = true
        setYtConfigured(true)
        setYtConnected(res.data.connected ?? false)
        setYtBaseURL(res.data.base_url ?? '')
        setYtProjectID(res.data.project_id ?? '')
        setYtBoardID(res.data.board_id ?? '')
      }
    } catch { /* ignore */ }

    // Always check live connection status — also gives us config values from ENV/global fallback
    try {
      const res = await api.getYouTrackStatus()
      const status = res as unknown as YouTrackStatus
      setYtStatus(status)
      // If connected via ENV or global DB but no user DB row yet, show as configured so
      // the details view renders (not the connect form)
      if (!hasDbRow && status.connected) {
        setYtConfigured(true)
        setYtConnected(true)
        setYtBaseURL(status.base_url ?? '')
        setYtProjectID(status.project_id ?? '')
        setYtBoardID(status.board_id ?? '')
      }
    } catch {
      setYtStatus({ connected: false, configured: false })
    }
  }

  const fetchYtBoards = async () => {
    setYtBoardsLoading(true)
    try {
      const res = await api.getYouTrackBoards()
      const boards = (res as any)?.data ?? res ?? []
      setYtBoards(Array.isArray(boards) ? boards : [])
    } catch { /* silently ignore */ }
    finally { setYtBoardsLoading(false) }
  }

  const handleSaveYt = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ytBaseURL.trim() || !ytProjectID.trim() || (!ytToken.trim() && !ytConfigured)) {
      setYtError(ytConfigured ? 'Base URL and project ID are required' : 'Base URL, token, and project ID are required')
      return
    }
    try {
      setYtSaving(true); setYtError(null)
      const res = await api.saveYouTrackIntegration({
        base_url: ytBaseURL.trim(),
        token: ytToken.trim(),
        project_id: ytProjectID.trim(),
        board_id: ytBoardID.trim() || undefined,
      })
      if (res.success) {
        setYtSuccess('YouTrack connected!')
        setYtToken('') // clear after save
        setShowYtForm(false)
        await fetchYtIntegration()
        setTimeout(() => setYtSuccess(null), 3000)
      }
    } catch (err) {
      setYtError(err instanceof Error ? err.message : 'Failed to save')
    } finally { setYtSaving(false) }
  }

  const handleDisconnectYt = async () => {
    if (!confirm('Disconnect YouTrack?')) return
    try {
      setYtError(null)
      await api.disconnectYouTrackIntegration()
      setYtConfigured(false); setYtConnected(false)
      setYtBaseURL(''); setYtProjectID(''); setYtBoardID('')
      setYtStatus({ connected: false, configured: false })
      setYtSuccess('Disconnected')
      setTimeout(() => setYtSuccess(null), 3000)
    } catch (err) {
      setYtError(err instanceof Error ? err.message : 'Failed to disconnect')
    }
  }

  const handleRecheckYt = async () => {
    setYtChecking(true)
    try {
      const res = await api.getYouTrackStatus()
      setYtStatus(res as unknown as YouTrackStatus)
    } catch {
      setYtStatus({ connected: false, configured: false })
    } finally { setYtChecking(false) }
  }

  // ── Asana ────────────────────────────────────────────────────────────────────
  const fetchAsanaStatus = async () => {
    try {
      const [statusRes, pmStatusRes] = await Promise.all([
        api.getAsanaStatus(),
        api.getAsanaPMStatus().catch(() => null),
      ])
      const status = statusRes as unknown as { connected: boolean; workspace_name?: string; project_gid?: string; project_name?: string }
      setAsanaConnected(status.connected ?? false)
      setAsanaWorkspaceName(status.workspace_name ?? '')
      const pmData = (pmStatusRes as any)?.data
      const hasProject = !!(status.project_gid || pmData?.project_id || pmData?.configured)
      setAsanaHasProject(hasProject)
      if (status.project_gid) {
        setAsanaSelectedProject(status.project_gid)
        setAsanaProjectName(status.project_name ?? status.project_gid)
      }
      // Load projects list if connected
      if (status.connected) {
        fetchAsanaProjects()
      }
    } catch {
      setAsanaConnected(false)
    }
  }

  const fetchAsanaProjects = async () => {
    setAsanaLoadingProjects(true)
    try {
      const res = await api.getAsanaPMProjects()
      const projects = (res as any)?.data ?? res ?? []
      setAsanaProjects(Array.isArray(projects) ? projects : [])
    } catch {
      // silently ignore — projects dropdown just won't populate
    } finally {
      setAsanaLoadingProjects(false)
    }
  }

  const handleSaveAsanaProject = async (projectGID: string) => {
    if (!projectGID) return
    setAsanaSavingProject(true)
    try {
      await api.saveAsanaPMProject(projectGID)
      const proj = asanaProjects.find(p => p.id === projectGID)
      setAsanaSelectedProject(projectGID)
      setAsanaProjectName(proj?.name ?? projectGID)
      setAsanaHasProject(true)
      setAsanaSuccess('Project saved! Board and reports will now use this project.')
      setTimeout(() => setAsanaSuccess(null), 4000)
    } catch (err) {
      setAsanaError(err instanceof Error ? err.message : 'Failed to save project')
    } finally {
      setAsanaSavingProject(false)
    }
  }

  const handleConnectAsana = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!asanaPAT.trim()) { setAsanaError('Personal Access Token is required'); return }
    try {
      setAsanaSaving(true); setAsanaError(null)
      const res = await api.connectAsana(asanaPAT.trim(), asanaWorkspaceID.trim() || undefined)
      const data = (res as any)
      if (data?.success || data?.user) {
        setAsanaSuccess('Asana connected!')
        setAsanaPAT('')
        setShowAsanaForm(false)
        await fetchAsanaStatus()
        setTimeout(() => setAsanaSuccess(null), 3000)
      } else {
        setAsanaError(data?.message || 'Failed to connect')
      }
    } catch (err) {
      setAsanaError(err instanceof Error ? err.message : 'Failed to connect Asana')
    } finally { setAsanaSaving(false) }
  }

  const handleDisconnectAsana = async () => {
    if (!confirm('Disconnect Asana?')) return
    try {
      setAsanaError(null)
      await api.disconnectAsana()
      setAsanaConnected(false); setAsanaWorkspaceName('')
      setAsanaSuccess('Asana disconnected')
      setTimeout(() => setAsanaSuccess(null), 3000)
    } catch (err) {
      setAsanaError(err instanceof Error ? err.message : 'Failed to disconnect')
    }
  }

  // ── Slack ───────────────────────────────────────────────────────────────────
  const fetchSlackStatus = async () => {
    try {
      const res = await api.getSlackStatus()
      // backend returns { connected, team_name, ... } directly (no success/data wrapper)
      const status = res as unknown as SlackStatus
      setSlackStatus(status)
      if (status.connected) fetchSlackChannels()
    } catch {
      setSlackStatus({ connected: false })
    }
  }

  const fetchSlackChannels = async () => {
    try {
      setLoadingChannels(true)
      const res = await api.getSlackChannels()
      // channels returned as array directly
      const channels = res as unknown as SlackChannel[]
      if (Array.isArray(channels)) setSlackChannels(channels)
    } catch { /* ignore */ }
    finally { setLoadingChannels(false) }
  }

  const handleConnectSlack = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      setConnectingSlack(true); setSlackError(null)
      await api.connectSlack(slackBotToken, selectedChannel)
      setSlackSuccess('Slack connected!')
      setSlackBotToken('')
      await fetchSlackStatus()
      setTimeout(() => setSlackSuccess(null), 3000)
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : 'Failed to connect Slack')
    } finally { setConnectingSlack(false) }
  }

  const handleDisconnectSlack = async () => {
    if (!confirm('Disconnect Slack?')) return
    try {
      setSlackError(null)
      await api.disconnectSlack()
      setSlackSuccess('Slack disconnected')
      setSlackStatus({ connected: false })
      setSlackChannels([])
      setTimeout(() => setSlackSuccess(null), 3000)
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : 'Failed to disconnect Slack')
    }
  }

  const handleSetChannel = async () => {
    if (!selectedChannel) return
    try {
      setSlackError(null)
      const channel = slackChannels.find(c => c.id === selectedChannel)
      if (!channel) return
      await api.setSlackChannel(selectedChannel, channel.name)
      setSlackSuccess(`Channel set to #${channel.name}`)
      await fetchSlackStatus()
      setTimeout(() => setSlackSuccess(null), 3000)
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : 'Failed to set channel')
    }
  }

  const handleFetchMessages = async () => {
    try {
      setFetchingMessages(true); setSlackError(null)
      const res = await api.getSlackMessages({ from: msgDateFrom, to: msgDateTo })
      const data = (res as any)?.messages ?? (res as any) ?? []
      const msgs = Array.isArray(data) ? data : []
      setSlackMessages(msgs)
      setSlackSuccess(`Fetched ${msgs.length} messages`)
      setTimeout(() => setSlackSuccess(null), 3000)
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : 'Failed to fetch messages')
    } finally { setFetchingMessages(false) }
  }

  // ── Workflow Config ─────────────────────────────────────────────────────────
  const fetchWorkflowConfig = async (src?: 'youtrack' | 'asana') => {
    const source = src ?? wcSource
    try {
      const res = await api.getWorkflowConfig(source)
      if (res.success && res.data) {
        setWorkflowConfig(res.data)
        setEditTags(res.data.priority_tags ?? [])
        setEditHotfix(res.data.hotfix_rules ?? { from_states: [], to_states: [] })

        const rawReport = res.data.report_config ?? {
          done_role: 'dev_done', blocked_states: [], open_states: [], priority_filters: [], sections: [], tracked_column_roles: []
        }

        // For Asana: store the role/rank mappings in editColumns as a baseline.
        // The useEffect above will override editColumns with REAL section names from the
        // Asana project API (fixes race condition and ensures correct section names).
        setEditColumns(res.data.column_hierarchy ?? [])

        // Normalize report config: strip any open/blocked state values that don't match
        // the stored column hierarchy (cleans up stale YouTrack values in Asana configs).
        const hierarchy = res.data.column_hierarchy ?? []
        if (source === 'asana' && hierarchy.length > 0) {
          const validStates = new Set(hierarchy.map((c: ColumnState) => c.state).filter(Boolean))
          setEditReport({
            ...rawReport,
            open_states: (rawReport.open_states ?? []).filter(s => validStates.has(s)),
            blocked_states: (rawReport.blocked_states ?? []).filter(s => validStates.has(s)),
          })
        } else {
          setEditReport(rawReport)
        }
      }
    } catch { /* ignore */ }
  }

  const handleSavePriorities = async () => {
    try {
      setWcSaving(true); setWcError(null)
      const res = await api.updatePriorityTags(editTags, wcSource)
      if (res.success) {
        if (res.data) setWorkflowConfig(res.data)
        else await fetchWorkflowConfig()
        setWcSuccess('Priority tags saved!'); setTimeout(() => setWcSuccess(null), 3000)
      }
    } catch (e) { setWcError(e instanceof Error ? e.message : 'Save failed') }
    finally { setWcSaving(false) }
  }

  const handleSaveColumns = async () => {
    const withRanks = editColumns.map((c, i) => ({ ...c, rank: i }))
    try {
      setWcSaving(true); setWcError(null)
      const res = await api.updateColumnHierarchy(withRanks, wcSource)
      if (res.success) {
        if (res.data) { setWorkflowConfig(res.data); setEditColumns(res.data.column_hierarchy) }
        else await fetchWorkflowConfig()
        setWcSuccess('Columns saved!'); setTimeout(() => setWcSuccess(null), 3000)
      }
    } catch (e) { setWcError(e instanceof Error ? e.message : 'Save failed') }
    finally { setWcSaving(false) }
  }

  const handleSaveHotfix = async () => {
    try {
      setWcSaving(true); setWcError(null)
      const res = await api.updateHotfixRules(editHotfix, wcSource)
      if (res.success && res.data) { setWorkflowConfig(res.data); setWcSuccess('Hotfix rules saved!'); setTimeout(() => setWcSuccess(null), 3000) }
    } catch (e) { setWcError(e instanceof Error ? e.message : 'Save failed') }
    finally { setWcSaving(false) }
  }

  const handleSaveReport = async () => {
    try {
      setWcSaving(true); setWcError(null)
      const res = await api.updateReportConfig(editReport, wcSource)
      if (res.success) {
        if (res.data) { setWorkflowConfig(res.data); setEditReport(res.data.report_config ?? editReport) }
        else { await fetchWorkflowConfig() }
        setWcSuccess('Report config saved!'); setTimeout(() => setWcSuccess(null), 3000)
      }
    } catch (e) { setWcError(e instanceof Error ? e.message : 'Save failed') }
    finally { setWcSaving(false) }
  }

  const handleResetWorkflow = async () => {
    if (!confirm(`Reset ${wcSource} workflow config to system defaults?`)) return
    try {
      setWcSaving(true); setWcError(null)
      await api.resetWorkflowConfig(wcSource)
      await fetchWorkflowConfig()
      setWcSuccess('Reset to defaults!'); setTimeout(() => setWcSuccess(null), 3000)
    } catch (e) { setWcError(e instanceof Error ? e.message : 'Reset failed') }
    finally { setWcSaving(false) }
  }

  // Load priorities from YouTrack (Issue 11)
  const handleLoadPrioritiesFromYT = async () => {
    setPrioritiesLoadingFromYT(true)
    try {
      const res = await api.getYouTrackPriorities()
      const vals = (res as any).data as { name: string; background?: string; foreground?: string }[] ?? []
      if (vals.length === 0) return
      setEditTags(vals.map((v, i) => ({
        label: v.name,
        color: v.background || '#6366f1',
        display_order: i,
        sla_hours: editTags.find(p => p.label === v.name)?.sla_hours ?? 48,
        prefixes: editTags.find(p => p.label === v.name)?.prefixes ?? [],
        yt_mappings: [v.name],
      })))
    } catch { /* ignore */ }
    finally { setPrioritiesLoadingFromYT(false) }
  }

  // Load type field values from YouTrack (Issue 7G)
  const handleLoadTypeFieldValues = async () => {
    const fieldName = editHotfix.type_field_name
    if (!fieldName?.trim()) return
    setTypeFieldLoading(true)
    try {
      const res = await api.getYouTrackTypeFieldValues(fieldName)
      const vals = (res as any).data as { name: string; background?: string }[] ?? []
      setTypeFieldValues(vals)
    } catch { /* ignore */ }
    finally { setTypeFieldLoading(false) }
  }

  const addTag = () => setEditTags(prev => [...prev, { label: '', color: '#6366f1', display_order: prev.length, sla_hours: 24, prefixes: [], yt_mappings: [] }])
  const updateTag = (i: number, field: keyof PriorityTag, value: string | number | string[]) =>
    setEditTags(prev => prev.map((t, idx) => idx === i ? { ...t, [field]: value } : t))
  const removeTag = (i: number) => setEditTags(prev => prev.filter((_, idx) => idx !== i))
  const updateColumn = (i: number, field: keyof ColumnState, value: string | number | boolean | string[]) =>
    setEditColumns(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: value } : c))
  const removeColumn = (i: number) => setEditColumns(prev => prev.filter((_, idx) => idx !== i))
  const addColumn = () => setEditColumns(prev => [...prev, { state: '', rank: prev.length, aliases: [], role: '', is_lateral: false }])
  const moveColumn = (i: number, dir: -1 | 1) => setEditColumns(prev => {
    const arr = [...prev]; const j = i + dir
    if (j < 0 || j >= arr.length) return arr
    ;[arr[i], arr[j]] = [arr[j], arr[i]]; return arr
  })

  const COLUMN_ROLES = ['backlog', 'active', 'blocked', 'findings', 'dev_done', 'verified', 'deployed', 'closed']
  const REPORT_SECTIONS = ['done', 'hotfixes', 'open', 'blocked', 'overdue']

  // SLA unit helpers — stored as hours internally
  const SLA_UNITS = ['minutes', 'hours', 'days', 'weeks', 'months'] as const
  type SlaUnit = typeof SLA_UNITS[number]
  const toHours = (val: number, unit: SlaUnit) => {
    if (unit === 'minutes') return val / 60
    if (unit === 'hours')   return val
    if (unit === 'days')    return val * 24
    if (unit === 'weeks')   return val * 24 * 7
    if (unit === 'months')  return val * 24 * 30
    return val
  }
  const fromHours = (hours: number): { val: number; unit: SlaUnit } => {
    if (hours < 1)            return { val: Math.round(hours * 60), unit: 'minutes' }
    if (hours < 24)           return { val: hours, unit: 'hours' }
    if (hours < 24 * 7)      return { val: Math.round(hours / 24), unit: 'days' }
    if (hours < 24 * 30)     return { val: Math.round(hours / (24 * 7)), unit: 'weeks' }
    return                         { val: Math.round(hours / (24 * 30)), unit: 'months' }
  }

  if (loading) return (
    <div className="int-page">
      <div className="int-loading"><div className="loading-spinner" /><p>Loading…</p></div>
    </div>
  )

  return (
    <div className="int-page">

      {/* Header */}
      <div className="int-header">
        <h1 className="int-title">Integrations</h1>
        <p className="int-subtitle">Connected tools and workflow configuration</p>
      </div>

      {/* Tab bar */}
      <div className="int-tabs">
        <button className={`int-tab ${mainTab === 'youtrack' ? 'int-tab-active' : ''}`} onClick={() => { setMainTab('youtrack'); onTabChange?.('youtrack') }}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            <path d="M8 12l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          YouTrack
          {ytStatus?.connected && <span className="int-tab-dot int-tab-dot-green" />}
        </button>
        {!isMember && (
          <button className={`int-tab ${mainTab === 'slack' ? 'int-tab-active' : ''}`} onClick={() => { setMainTab('slack'); onTabChange?.('slack') }}>
            <MessageSquare size={14} />
            Slack
            {slackStatus?.connected && <span className="int-tab-dot int-tab-dot-green" />}
          </button>
        )}
        {!isMember && (
          <button className={`int-tab ${mainTab === 'workflow' ? 'int-tab-active' : ''}`} onClick={() => { setMainTab('workflow'); onTabChange?.('workflow') }}>
            <Sliders size={14} />
            Workflow
          </button>
        )}
        {isFullAccess && (
          <button className={`int-tab ${mainTab === 'developers' ? 'int-tab-active' : ''}`} onClick={() => { setMainTab('developers'); onTabChange?.('developers') }}>
            <User size={14} />
            Developers
          </button>
        )}
      </div>

      {/* ══════════════ YOUTRACK ══════════════ */}
      {mainTab === 'youtrack' && (
        <div className="int-content">
          <div className="int-service-header">
            <div className="int-service-logo int-yt-logo">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                <circle cx="12" cy="12" r="10" fill="#087CFA"/>
                <path d="M8 12l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="int-service-info">
              <h2>YouTrack</h2>
              <p>Primary issue tracker — boards, reports, PM assistant</p>
            </div>
            <div>
              {ytStatus?.connected
                ? <span className="int-badge int-badge-green"><CheckCircle size={12} /> Connected</span>
                : ytConfigured
                  ? <span className="int-badge int-badge-yellow"><AlertCircle size={12} /> Saved, not reachable</span>
                  : <span className="int-badge int-badge-gray">Not configured</span>
              }
            </div>
          </div>

          {ytError && (
            <div className="int-alert int-alert-error">
              <AlertCircle size={14} /><span>{ytError}</span>
              <button className="int-alert-close" onClick={() => setYtError(null)}>&times;</button>
            </div>
          )}
          {ytSuccess && (
            <div className="int-alert int-alert-success"><CheckCircle size={14} /><span>{ytSuccess}</span></div>
          )}

          {/* Show saved config details when connected */}
          {ytConfigured && !showYtForm && (
            <>
              <div className="int-details-grid">
                <div className="int-detail-card">
                  <span className="int-detail-label">Base URL</span>
                  <span className="int-detail-value">{ytBaseURL}</span>
                </div>
                <div className="int-detail-card">
                  <span className="int-detail-label">Project ID</span>
                  <span className="int-detail-value">{ytProjectID}</span>
                </div>
                {ytBoardID && (
                  <div className="int-detail-card">
                    <span className="int-detail-label">Board ID</span>
                    <span className="int-detail-value">{ytBoardID}</span>
                  </div>
                )}
                <div className="int-detail-card">
                  <span className="int-detail-label">Credentials source</span>
                  <span className="int-detail-value">
                    {ytStatus?.source === 'user_db' ? 'Your profile (DB)' : ytStatus?.source === 'global_db' ? 'Org-wide (DB)' : 'Environment variables'}
                  </span>
                </div>
              </div>

              {ytStatus && !ytStatus.connected && (
                <div className="int-section-box int-section-box-warn">
                  <div className="int-section-box-header"><AlertCircle size={15} className="int-icon-warn" /><span>Connection failed</span></div>
                  {ytStatus.error && <p className="int-help-text int-text-warn">{ytStatus.error}</p>}
                  <p className="int-help-text">The credentials are saved but YouTrack is not reachable. Check your base URL and token.</p>
                </div>
              )}

              <div className="int-row-actions">
                <button className="int-btn int-btn-ghost int-btn-sm" onClick={handleRecheckYt} disabled={ytChecking}>
                  <RefreshCw size={13} className={ytChecking ? 'spin' : ''} /> {ytChecking ? 'Checking…' : 'Re-check'}
                </button>
                <button className="int-btn int-btn-ghost int-btn-sm" onClick={() => setShowYtForm(true)}>
                  <Settings size={13} /> Update Credentials
                </button>
                <button className="int-btn int-btn-danger-ghost int-btn-sm" onClick={handleDisconnectYt}>
                  <Unlink size={13} /> Disconnect
                </button>
              </div>
            </>
          )}

          {/* Connect / Edit form */}
          {(!ytConfigured || showYtForm) && (
            <form onSubmit={handleSaveYt} className="int-form">
              {!ytConfigured && (
                <p className="int-help-text">
                  Enter your YouTrack credentials. They are stored securely in the database and never exposed to other users.
                </p>
              )}
              <div className="int-field">
                <label>Base URL</label>
                <input type="url" value={ytBaseURL} onChange={e => setYtBaseURL(e.target.value)} placeholder="https://yourteam.youtrack.cloud" className="int-input" autoComplete="off" required />
              </div>
              <div className="int-field">
                <label>Permanent Token</label>
                <input type="password" value={ytToken} onChange={e => setYtToken(e.target.value)} placeholder={ytConfigured ? 'Enter new token to update' : 'perm:...'} className="int-input int-mono" autoComplete="new-password" required={!ytConfigured} />
              </div>
              <div className="int-field">
                <label>Project ID <span className="int-label-hint">short ID, e.g. PM</span></label>
                <input type="text" value={ytProjectID} onChange={e => setYtProjectID(e.target.value)} placeholder="PM" className="int-input" autoComplete="off" required />
              </div>
              <div className="int-field">
                <label>Board <span className="int-label-hint">optional — for sprint tracking</span></label>
                <WcObjDropdown
                  value={ytBoardID}
                  placeholder={ytBoardsLoading ? 'Loading boards…' : ytBoards.length === 0 ? 'No boards found' : '— Select a board —'}
                  options={ytBoards}
                  onChange={setYtBoardID}
                  disabled={ytBoardsLoading}
                />
              </div>
              <div className="int-form-actions">
                {showYtForm && (
                  <button type="button" className="int-btn int-btn-ghost" onClick={() => { setShowYtForm(false); setYtError(null) }}>Cancel</button>
                )}
                <button type="submit" className="int-btn int-btn-primary" disabled={ytSaving}>
                  {ytSaving ? 'Connecting…' : <><Link2 size={14} /> {ytConfigured ? 'Update' : 'Connect YouTrack'}</>}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Asana tab removed — YouTrack is the only PM data source */}
      {false && mainTab === 'asana' && (
        <div className="int-content">
          <div className="int-service-header">
            <div className="int-service-logo int-asana-logo"></div>
            <div className="int-service-info">
              <h2>Asana</h2>
            </div>
            <div>
              {asanaConnected
                ? <span className="int-badge int-badge-green"><CheckCircle size={12} /> Connected</span>
                : <span className="int-badge int-badge-gray">Not connected</span>
              }
            </div>
          </div>

          {asanaError && (
            <div className="int-alert int-alert-error">
              <AlertCircle size={14} /><span>{asanaError}</span>
              <button className="int-alert-close" onClick={() => setAsanaError(null)}>&times;</button>
            </div>
          )}
          {asanaSuccess && (
            <div className="int-alert int-alert-success"><CheckCircle size={14} /><span>{asanaSuccess}</span></div>
          )}

          {asanaConnected && !showAsanaForm && (
            <>
              <div className="int-details-grid">
                {asanaWorkspaceName && (
                  <div className="int-detail-card">
                    <span className="int-detail-label">Workspace</span>
                    <span className="int-detail-value">{asanaWorkspaceName}</span>
                  </div>
                )}
                <div className="int-detail-card">
                  <span className="int-detail-label">Active project</span>
                  <span className="int-detail-value">{asanaProjectName || (asanaHasProject ? 'Configured' : 'None selected')}</span>
                </div>
              </div>

              <div className="int-section-box">
                <div className="int-section-box-header"><Settings size={15} /><span>Select Asana Project</span></div>
                <p className="int-help-text">Choose which Asana project to use for board view, PM reports, daily brief, and assistant queries.</p>
                <div className="int-field">
                  <label>Project</label>
                  <div className="int-project-select-row">
                    <WcObjDropdown
                      value={asanaSelectedProject}
                      placeholder={asanaLoadingProjects ? 'Loading projects…' : '— Select a project —'}
                      options={asanaProjects}
                      onChange={setAsanaSelectedProject}
                      disabled={asanaLoadingProjects}
                      className="int-project-dropdown"
                    />
                    <button
                      className="int-btn int-btn-primary int-btn-sm"
                      onClick={() => handleSaveAsanaProject(asanaSelectedProject)}
                      disabled={!asanaSelectedProject || asanaSavingProject}
                    >
                      {asanaSavingProject ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="int-row-actions">
                <button className="int-btn int-btn-ghost int-btn-sm" onClick={() => setShowAsanaForm(true)}>
                  <Settings size={13} /> Update Token
                </button>
                <button className="int-btn int-btn-danger-ghost int-btn-sm" onClick={handleDisconnectAsana}>
                  <Unlink size={13} /> Disconnect
                </button>
              </div>
            </>
          )}

          {(!asanaConnected || showAsanaForm) && (
            <form onSubmit={handleConnectAsana} className="int-form">
              <p className="int-help-text">
                Enter your Asana Personal Access Token. Create one at <strong>Asana &gt; Profile &gt; Apps &gt; Personal access tokens</strong>.
                Your token is stored securely and only used for your account.
              </p>
              <div className="int-field">
                <label>Personal Access Token</label>
                <input
                  type="password"
                  value={asanaPAT}
                  onChange={e => setAsanaPAT(e.target.value)}
                  placeholder={asanaConnected ? 'Enter new token to update' : '1/xxxxxxxxxxxxxxxx…'}
                  className="int-input int-mono"
                  autoComplete="new-password"
                  required={!asanaConnected}
                />
              </div>
              <div className="int-field">
                <label>Workspace ID <span className="int-label-hint">optional — uses first workspace if blank</span></label>
                <input
                  type="text"
                  value={asanaWorkspaceID}
                  onChange={e => setAsanaWorkspaceID(e.target.value)}
                  placeholder="1234567890"
                  className="int-input"
                  autoComplete="off"
                />
              </div>
              <div className="int-form-actions">
                {showAsanaForm && (
                  <button type="button" className="int-btn int-btn-ghost" onClick={() => { setShowAsanaForm(false); setAsanaError(null) }}>Cancel</button>
                )}
                <button type="submit" className="int-btn int-btn-primary" disabled={asanaSaving}>
                  {asanaSaving ? 'Connecting…' : <><Link2 size={14} /> {asanaConnected ? 'Update Token' : 'Connect Asana'}</>}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* ══════════════ SLACK ══════════════ */}
      {mainTab === 'slack' && (
        <div className="int-content">
          <div className="int-service-header">
            <div className="int-service-logo int-slack-logo">
              <MessageSquare size={22} color="white" />
            </div>
            <div className="int-service-info">
              <h2>Slack</h2>
              <p>Monitor channels, pull messages, and track mentions</p>
            </div>
            <div>
              {slackStatus?.connected
                ? <span className="int-badge int-badge-green"><CheckCircle size={12} /> Connected</span>
                : <span className="int-badge int-badge-gray">Not connected</span>}
            </div>
          </div>

          {slackError && (
            <div className="int-alert int-alert-error">
              <AlertCircle size={14} /><span>{slackError}</span>
              <button className="int-alert-close" onClick={() => setSlackError(null)}>&times;</button>
            </div>
          )}
          {slackSuccess && (
            <div className="int-alert int-alert-success"><CheckCircle size={14} /><span>{slackSuccess}</span></div>
          )}

          {slackStatus?.connected ? (
            <>
              {/* Connection details */}
              <div className="int-details-grid">
                {slackStatus.team_name && (
                  <div className="int-detail-card">
                    <span className="int-detail-label">Workspace</span>
                    <span className="int-detail-value">{slackStatus.team_name}</span>
                  </div>
                )}
                {slackStatus.channel_name && (
                  <div className="int-detail-card">
                    <span className="int-detail-label">Digest Channel</span>
                    <span className="int-detail-value">#{slackStatus.channel_name}</span>
                  </div>
                )}
                {slackStatus.monitor_channel_name && (
                  <div className="int-detail-card">
                    <span className="int-detail-label">Monitor Channel</span>
                    <span className="int-detail-value">#{slackStatus.monitor_channel_name}</span>
                  </div>
                )}
              </div>

              {/* Channel select */}
              <div className="int-section-box">
                <div className="int-section-box-header"><Settings size={15} /><span>Channel Settings</span></div>
                <div className="int-field">
                  <label>Digest / Report Channel</label>
                  <div className="int-input-row">
                    <div className="pm-custom-dropdown wc-sel-dropdown int-channel-dropdown">
                      <button
                        type="button"
                        className="pm-custom-dropdown-trigger int-channel-trigger"
                        disabled={loadingChannels}
                        onClick={(e) => {
                          const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                          setChannelDropdownRect(r); setChannelDropdownOpen(o => !o)
                        }}
                      >
                        <span>
                          {selectedChannel
                            ? (() => { const c = slackChannels.find(c => c.id === selectedChannel); return c ? `#${c.name}` : selectedChannel })()
                            : slackStatus.channel_id
                              ? (() => { const c = slackChannels.find(c => c.id === slackStatus.channel_id); return c ? `#${c.name}` : `#${slackStatus.channel_name ?? slackStatus.channel_id}` })()
                              : 'Select a channel…'
                          }
                        </span>
                        <ChevronDown size={11} className={`dropdown-chevron ${channelDropdownOpen ? 'open' : ''}`} />
                      </button>
                      {channelDropdownOpen && channelDropdownRect && createPortal(
                        <div className="pm-custom-dropdown-menu int-channel-menu" style={{ position: 'fixed', top: channelDropdownRect.bottom + 4, left: channelDropdownRect.left, minWidth: channelDropdownRect.width, zIndex: 9999 }}>
                          {slackChannels.map(c => (
                            <button key={c.id} type="button"
                              className={`pm-dropdown-item ${(selectedChannel || slackStatus.channel_id) === c.id ? 'active' : ''}`}
                              onClick={() => { setSelectedChannel(c.id); setChannelDropdownOpen(false); setChannelDropdownRect(null) }}>
                              <span>#{c.name}{c.is_private ? ' 🔒' : ''}</span>
                            </button>
                          ))}
                        </div>,
                        document.body
                      )}
                    </div>
                    <button className="int-btn int-btn-primary int-btn-sm" onClick={handleSetChannel} disabled={!selectedChannel || loadingChannels}>
                      <Save size={13} /> Set
                    </button>
                  </div>
                  {loadingChannels && <p className="int-help-text">Loading channels…</p>}
                </div>
              </div>

              {/* Fetch messages */}
              <div className="int-section-box">
                <div className="int-section-box-header"><Download size={15} /><span>Fetch Messages</span></div>
                {slackStatus.channel_name && (
                  <p className="int-help-text">Pull messages from #{slackStatus.channel_name} for a date range.</p>
                )}
                <div className="int-date-row">
                  <div className="int-field">
                    <label>From</label>
                    <input type="date" value={msgDateFrom} onChange={e => setMsgDateFrom(e.target.value)} className="int-input" />
                  </div>
                  <div className="int-field">
                    <label>To</label>
                    <input type="date" value={msgDateTo} onChange={e => setMsgDateTo(e.target.value)} className="int-input" />
                  </div>
                  <button className="int-btn int-btn-primary int-date-btn" onClick={handleFetchMessages} disabled={fetchingMessages}>
                    {fetchingMessages ? <><RefreshCw size={13} className="spin" /> Fetching…</> : <><Download size={13} /> Fetch</>}
                  </button>
                </div>

                {slackMessages.length > 0 && (
                  <div className="int-msg-list">
                    <div className="int-msg-count">{slackMessages.length} messages</div>
                    <div className="int-msg-scroll">
                      {slackMessages.map((msg, i) => (
                        <div key={msg.id ?? i} className="int-msg-item">
                          <div className="int-msg-meta">
                            <span className="int-msg-user"><User size={11} /> {msg.user_name}</span>
                            <span className="int-msg-time"><Clock size={11} /> {new Date(msg.timestamp).toLocaleString()}</span>
                          </div>
                          <div className="int-msg-text">{msg.text}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="int-row-actions">
                <button className="int-btn int-btn-danger-ghost" onClick={handleDisconnectSlack}>
                  <Unlink size={13} /> Disconnect
                </button>
              </div>
            </>
          ) : (
            <>
              <form onSubmit={handleConnectSlack} className="int-form int-connect-form">
                <p className="int-help-text">
                  Enter your Slack Bot Token to connect. Required scopes:{' '}
                  <code>channels:history</code>, <code>channels:read</code>, <code>users:read</code>, <code>chat:write</code>.
                </p>
                <div className="int-field">
                  <label>Slack Bot Token</label>
                  <input
                    type="password"
                    value={slackBotToken}
                    onChange={e => setSlackBotToken(e.target.value)}
                    placeholder="xoxb-your-bot-token"
                    className="int-input int-mono"
                  />
                </div>
                <div className="int-form-actions">
                  <button type="submit" className="int-btn int-btn-primary" disabled={connectingSlack || !slackBotToken.trim()}>
                    {connectingSlack ? 'Connecting…' : <><Link2 size={14} /> Connect Slack</>}
                  </button>
                </div>
              </form>

              <div className="int-collapsible">
                <button className="int-collapsible-trigger" onClick={() => setShowSlackInstructions(v => !v)}>
                  How to get your Slack Bot Token
                  {showSlackInstructions ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                {showSlackInstructions && (
                  <div className="int-collapsible-body">
                    <ol className="int-steps">
                      <li>Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">api.slack.com/apps</a></li>
                      <li>Create New App → From scratch</li>
                      <li>Go to <strong>OAuth &amp; Permissions</strong>, add bot scopes: <code>channels:history</code>, <code>channels:read</code>, <code>users:read</code>, <code>chat:write</code></li>
                      <li>Install to workspace, copy the <strong>Bot User OAuth Token</strong> (xoxb-…)</li>
                      <li>After connecting, invite the bot: <code>/invite @YourBot</code></li>
                    </ol>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════ WORKFLOW CONFIG ══════════════ */}
      {mainTab === 'workflow' && (
        <div className="int-content">
          <div className="int-service-header">
            <div className="int-service-logo int-workflow-logo">
              <Sliders size={22} />
            </div>
            <div className="int-service-info">
              <h2>Workflow Configuration</h2>
              <p>Priority tags, column hierarchy, hotfix detection, report defaults</p>
            </div>
            <div>
              {workflowConfig
                ? <span className="int-badge int-badge-green"><CheckCircle size={12} /> Loaded</span>
                : <span className="int-badge int-badge-gray">Loading…</span>}
            </div>
          </div>

          {workflowConfig && (
            <>
              {wcError && (
                <div className="int-alert int-alert-error">
                  <AlertCircle size={14} /><span>{wcError}</span>
                  <button className="int-alert-close" onClick={() => setWcError(null)}>&times;</button>
                </div>
              )}
              {wcSuccess && (
                <div className="int-alert int-alert-success"><CheckCircle size={14} /><span>{wcSuccess}</span></div>
              )}

              {/* Workflow sub-tabs */}
              <div className="wc-tabs">
                {(['priorities', 'columns', 'hotfix', 'report'] as const).map(t => (
                  <button key={t} className={`wc-tab${wcSection === t ? ' wc-tab-active' : ''}`} onClick={() => setWcSection(t)}>
                    {t === 'priorities' ? 'Priority Tags' : t === 'columns' ? 'Column Hierarchy' : t === 'hotfix' ? 'Hotfix Rules' : 'Report Defaults'}
                  </button>
                ))}
              </div>

              {/* Priority Tags */}
              {wcSection === 'priorities' && (
                <div className="wc-section">
                  <p className="int-help-text">Define tags like P0, B1, A0 with custom colors and SLA thresholds.</p>
                  <div className="wc-tag-list">
                    <div className="wc-tag-header">
                      <span>Color</span><span>Label</span>
                      <span>SLA</span>
                      <span>Unit</span>
                      <span>Prefixes</span><span>YT Mappings</span><span></span>
                    </div>
                    {editTags.map((tag, i) => (
                      <div key={i} className="wc-tag-row">
                        <input type="color" value={tag.color} onChange={e => updateTag(i, 'color', e.target.value)} className="wc-color-input" />
                        <input type="text" value={tag.label} onChange={e => updateTag(i, 'label', e.target.value)} placeholder="P0" className="wc-input wc-input-label" />
                        <div className="wc-sla-cell">
                          <input
                            type="number"
                            value={fromHours(tag.sla_hours).val}
                            onChange={e => {
                              const unit = fromHours(tag.sla_hours).unit
                              updateTag(i, 'sla_hours', toHours(parseFloat(e.target.value) || 0, unit))
                            }}
                            className="wc-input wc-sla-val"
                            min={1} step={1}
                          />
                          <select
                            value={fromHours(tag.sla_hours).unit}
                            onChange={e => {
                              const cur = fromHours(tag.sla_hours)
                              updateTag(i, 'sla_hours', toHours(cur.val, e.target.value as SlaUnit))
                            }}
                            className="wc-sla-unit"
                          >
                            {SLA_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </div>
                        <input type="text" value={(tag.prefixes ?? []).join(', ')} onChange={e => updateTag(i, 'prefixes', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} placeholder="P0, B0" className="wc-input wc-input-grow" />
                        <div className="wc-yt-mapping-cell">
                          <button
                            type="button"
                            ref={el => { ytMappingRefs.current[i] = el }}
                            className="pm-custom-dropdown-trigger"
                            onClick={() => {
                              if (ytMappingOpen === i) { setYtMappingOpen(null); return }
                              const rect = ytMappingRefs.current[i]?.getBoundingClientRect() ?? null
                              setYtMappingRect(rect)
                              setYtMappingOpen(i)
                            }}
                          >
                            <span>{(tag.yt_mappings ?? [])[0] || '— none —'}</span>
                            <ChevronDown size={13} className={`dropdown-chevron${ytMappingOpen === i ? ' open' : ''}`} />
                          </button>
                          {ytMappingOpen === i && ytMappingRect && createPortal(
                            <div
                              className="pm-custom-dropdown-menu"
                              style={{ position: 'fixed', top: ytMappingRect.bottom + 4, left: ytMappingRect.left, minWidth: ytMappingRect.width, zIndex: 9999 }}
                            >
                              <button className={`pm-dropdown-item${!(tag.yt_mappings ?? [])[0] ? ' active' : ''}`} onClick={() => { updateTag(i, 'yt_mappings', []); setYtMappingOpen(null) }}>— none —</button>
                              {ytPriorities.map(p => (
                                <button key={p} className={`pm-dropdown-item${(tag.yt_mappings ?? [])[0] === p ? ' active' : ''}`} onClick={() => { updateTag(i, 'yt_mappings', [p]); setYtMappingOpen(null) }}>{p}</button>
                              ))}
                            </div>,
                            document.body
                          )}
                        </div>
                        <button className="wc-icon-btn wc-icon-btn-danger" onClick={() => removeTag(i)}><Trash2 size={13} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="wc-actions">
                    <button className="int-btn int-btn-ghost int-btn-sm" onClick={addTag}><Plus size={13} /> Add Tag</button>
                    {wcSource === 'youtrack' && (
                      <button className="int-btn int-btn-secondary int-btn-sm" onClick={handleLoadPrioritiesFromYT} disabled={prioritiesLoadingFromYT}>
                        {prioritiesLoadingFromYT ? <RefreshCw size={12} className="spin" /> : <Download size={12} />} Load from YouTrack
                      </button>
                    )}
                    <button className="int-btn int-btn-primary int-btn-sm" onClick={handleSavePriorities} disabled={wcSaving}>
                      {wcSaving ? 'Saving…' : <><Save size={13} /> Save</>}
                    </button>
                  </div>
                </div>
              )}

              {/* Column Hierarchy */}
              {wcSection === 'columns' && (
                <div className="wc-section">
                  <div className="wc-col-topbar">
                    <p className="int-help-text" style={{ margin: 0 }}>Each row maps a board column to a role. Roles drive hotfix detection, bounce labels, and overdue logic.</p>
                    {columnsLoadingFromYT && <span className="wc-col-syncing"><RefreshCw size={12} className="spin" /> Syncing from YouTrack…</span>}
                  </div>
                  <div className="wc-col-legend">
                    {Object.entries(ROLE_COLORS).map(([role, color]) => (
                      <span key={role} className="wc-col-legend-item">
                        <span className="wc-col-legend-dot" style={{ background: color }} />
                        {role}
                      </span>
                    ))}
                  </div>
                  <div className="wc-col-list">
                    <div className="wc-col-card-header">
                      <span style={{ width: 24 }} /><span style={{ width: 24 }} /><span style={{ width: 20 }} />
                      <span style={{ width: 160 }}>State</span>
                      <span style={{ width: 132 }}>Role</span>
                      <span style={{ flex: 1 }}>Aliases</span>
                      <span style={{ width: 72 }}>Lateral</span>
                      <span style={{ width: 28 }} />
                    </div>
                    <ColumnDndList
                      editColumns={editColumns}
                      setEditColumns={setEditColumns}
                      updateColumn={updateColumn}
                      removeColumn={removeColumn}
                      COLUMN_ROLES={COLUMN_ROLES}
                    />
                  </div>
                  <div className="wc-actions">
                    <button className="int-btn int-btn-ghost int-btn-sm" onClick={addColumn}><Plus size={13} /> Add row</button>
                    <button className="int-btn int-btn-primary int-btn-sm" onClick={handleSaveColumns} disabled={wcSaving}>
                      {wcSaving ? 'Saving…' : <><Save size={13} /> Save</>}
                    </button>
                  </div>
                </div>
              )}

              {/* Hotfix Rules */}
              {wcSection === 'hotfix' && (
                <div className="wc-section">
                  <p className="int-help-text">
                    Classify tickets as hotfix or regression based on a YouTrack custom field (e.g. "Type"). If configured, field-based classification takes priority over transition-based detection.
                  </p>

                  {wcSource === 'youtrack' && (
                    <>
                      <div className="int-field">
                        <label>Type Field Name</label>
                        <div className="int-field-row">
                          <input
                            type="text"
                            value={editHotfix.type_field_name ?? ''}
                            onChange={e => setEditHotfix(h => ({ ...h, type_field_name: e.target.value }))}
                            className="int-input"
                            placeholder="e.g. Type"
                          />
                          <button
                            className="int-btn int-btn-secondary int-btn-sm"
                            onClick={handleLoadTypeFieldValues}
                            disabled={typeFieldLoading || !editHotfix.type_field_name?.trim()}
                          >
                            {typeFieldLoading ? <RefreshCw size={12} className="spin" /> : <Download size={12} />} Load values
                          </button>
                        </div>
                      </div>

                      <div className="int-field">
                        <label>Hotfix Values <span className="int-label-hint">(select which values indicate a hotfix)</span></label>
                        <div className="wc-chip-group">
                          {typeFieldValues.length === 0 && (editHotfix.hotfix_values ?? []).length === 0 && (
                            <span className="int-label-hint">Enter field name and click "Load values" to see options</span>
                          )}
                          {[...typeFieldValues.map(v => v.name), ...(editHotfix.hotfix_values ?? []).filter(v => !typeFieldValues.find(t => t.name === v))].map(val => (
                            <label key={val} className="wc-chip-label">
                              <input
                                type="checkbox"
                                checked={(editHotfix.hotfix_values ?? []).includes(val)}
                                onChange={e => setEditHotfix(h => {
                                  const cur = h.hotfix_values ?? []
                                  return { ...h, hotfix_values: e.target.checked ? [...cur, val] : cur.filter(x => x !== val) }
                                })}
                              />
                              <span
                                className="wc-chip"
                                style={{ background: typeFieldValues.find(v => v.name === val)?.background }}
                              >{val}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="int-field">
                        <label>Regression Values <span className="int-label-hint">(select which values indicate a regression)</span></label>
                        <div className="wc-chip-group">
                          {typeFieldValues.length === 0 && (editHotfix.regression_values ?? []).length === 0 && (
                            <span className="int-label-hint">Enter field name and click "Load values" to see options</span>
                          )}
                          {[...typeFieldValues.map(v => v.name), ...(editHotfix.regression_values ?? []).filter(v => !typeFieldValues.find(t => t.name === v))].map(val => (
                            <label key={val} className="wc-chip-label">
                              <input
                                type="checkbox"
                                checked={(editHotfix.regression_values ?? []).includes(val)}
                                onChange={e => setEditHotfix(h => {
                                  const cur = h.regression_values ?? []
                                  return { ...h, regression_values: e.target.checked ? [...cur, val] : cur.filter(x => x !== val) }
                                })}
                              />
                              <span
                                className="wc-chip"
                                style={{ background: typeFieldValues.find(v => v.name === val)?.background }}
                              >{val}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <details className="wc-advanced-section">
                        <summary className="wc-advanced-summary">Advanced: Transition-based detection <span className="int-label-hint">(fallback when field not configured)</span></summary>
                        <div className="wc-advanced-content">
                          <div className="int-field">
                            <label>From States <span className="int-label-hint">(empty = auto)</span></label>
                            <input type="text" value={editHotfix.from_states.join(', ')} onChange={e => setEditHotfix(h => ({ ...h, from_states: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} className="int-input" placeholder="e.g. Backlog, In Progress" />
                          </div>
                          <div className="int-field">
                            <label>To States <span className="int-label-hint">(empty = auto)</span></label>
                            <input type="text" value={editHotfix.to_states.join(', ')} onChange={e => setEditHotfix(h => ({ ...h, to_states: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} className="int-input" placeholder="e.g. STAGE, PROD" />
                          </div>
                        </div>
                      </details>
                    </>
                  )}

                  {wcSource !== 'youtrack' && (
                    <>
                      <div className="int-field">
                        <label>From States <span className="int-label-hint">(empty = auto)</span></label>
                        <input type="text" value={editHotfix.from_states.join(', ')} onChange={e => setEditHotfix(h => ({ ...h, from_states: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} className="int-input" placeholder="e.g. Backlog, In Progress" />
                      </div>
                      <div className="int-field">
                        <label>To States <span className="int-label-hint">(empty = auto)</span></label>
                        <input type="text" value={editHotfix.to_states.join(', ')} onChange={e => setEditHotfix(h => ({ ...h, to_states: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} className="int-input" placeholder="e.g. STAGE, PROD" />
                      </div>
                    </>
                  )}

                  <div className="wc-actions">
                    <button className="int-btn int-btn-primary int-btn-sm" onClick={handleSaveHotfix} disabled={wcSaving}>
                      {wcSaving ? 'Saving…' : <><Save size={13} /> Save</>}
                    </button>
                  </div>
                </div>
              )}

              {/* Report Defaults */}
              {wcSection === 'report' && (
                <div className="wc-section">
                  <p className="int-help-text">Configure which columns and priorities appear in PM reports by default.</p>

                  <div className="wc-report-grid">
                    {/* Done Role */}
                    <div className="wc-report-block">
                      <div className="wc-report-block-title">Done Role</div>
                      <p className="int-label-hint">Columns with this role count as "done" in reports.</p>
                      <WcSelectDropdown value={editReport.done_role} options={COLUMN_ROLES} onChange={val => setEditReport(r => ({ ...r, done_role: val }))} className="wc-sel-full" />
                    </div>

                    {/* Priority Filters */}
                    <div className="wc-report-block">
                      <div className="wc-report-block-title">Priority Filters <span className="int-label-hint">(empty = all)</span></div>
                      <p className="int-label-hint">Which priority tags to include in reports.</p>
                      <div className="wc-chip-group">
                        {[...(editTags.length > 0 ? editTags : workflowConfig?.priority_tags ?? []), { label: 'Other', color: '#94a3b8' }].map(tag => (
                          <label key={tag.label} className="wc-chip-label">
                            <input
                              type="checkbox"
                              checked={(editReport.priority_filters ?? []).length === 0 || (editReport.priority_filters ?? []).includes(tag.label)}
                              onChange={e => setEditReport(r => {
                                const all = [...(editTags.length > 0 ? editTags : workflowConfig?.priority_tags ?? []), { label: 'Other' }].map(t => t.label)
                                const current = (r.priority_filters ?? []).length === 0 ? all : (r.priority_filters ?? [])
                                const next = e.target.checked ? [...current.filter(x => x !== tag.label), tag.label] : current.filter(x => x !== tag.label)
                                return { ...r, priority_filters: next.length === all.length ? [] : next }
                              })}
                            />
                            <span className="wc-chip-dot" style={{ background: tag.color }} />
                            {tag.label}
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Open States */}
                    <div className="wc-report-block">
                      <div className="wc-report-block-title">Open States</div>
                      <p className="int-label-hint">Columns shown in the "open issues" section.</p>
                      {reportAvailableStates.length > 0 ? (
                        <div className="wc-chip-group">
                          {reportAvailableStates.map(s => (
                            <label key={s} className="wc-chip-label">
                              <input
                                type="checkbox"
                                checked={(editReport.open_states ?? []).includes(s)}
                                onChange={e => setEditReport(r => ({
                                  ...r, open_states: e.target.checked ? [...(r.open_states ?? []), s] : (r.open_states ?? []).filter(x => x !== s)
                                }))}
                              />
                              {s}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <input type="text" value={(editReport.open_states ?? []).join(', ')} onChange={e => setEditReport(r => ({ ...r, open_states: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} className="wc-input wc-input-full" placeholder="In Progress, Backlog, STAGE…" />
                      )}
                    </div>

                    {/* Blocked States */}
                    <div className="wc-report-block">
                      <div className="wc-report-block-title">Blocked States</div>
                      <p className="int-label-hint">Columns that count as "blocked" in reports.</p>
                      {reportAvailableStates.length > 0 ? (
                        <div className="wc-chip-group">
                          {reportAvailableStates.map(s => (
                            <label key={s} className="wc-chip-label">
                              <input
                                type="checkbox"
                                checked={(editReport.blocked_states ?? []).includes(s)}
                                onChange={e => setEditReport(r => ({
                                  ...r, blocked_states: e.target.checked ? [...(r.blocked_states ?? []), s] : (r.blocked_states ?? []).filter(x => x !== s)
                                }))}
                              />
                              {s}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <input type="text" value={(editReport.blocked_states ?? []).join(', ')} onChange={e => setEditReport(r => ({ ...r, blocked_states: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} className="wc-input wc-input-full" placeholder="Blocked" />
                      )}
                    </div>

                    {/* Report Sections */}
                    <div className="wc-report-block wc-report-block-full">
                      <div className="wc-report-block-title">Report Sections</div>
                      <p className="int-label-hint">Which sections appear in the generated PM report.</p>
                      <div className="wc-chip-group">
                        {REPORT_SECTIONS.map(s => (
                          <label key={s} className="wc-chip-label">
                            <input
                              type="checkbox"
                              checked={(editReport.sections ?? []).length === 0 || (editReport.sections ?? []).includes(s)}
                              onChange={e => setEditReport(r => {
                                const current = (r.sections ?? []).length === 0 ? REPORT_SECTIONS : (r.sections ?? [])
                                return { ...r, sections: e.target.checked ? [...current.filter(x => x !== s), s] : current.filter(x => x !== s) }
                              })}
                            />
                            {s}
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Tracked Columns */}
                    <div className="wc-report-block wc-report-block-full">
                      <div className="wc-report-block-title">Tracked Columns</div>
                      <p className="int-label-hint">Which workflow states appear in the Tracking tab. Empty = show all.</p>
                      <div className="wc-chip-group">
                        {COLUMN_ROLES.map(role => (
                          <label key={role} className="wc-chip-label">
                            <input
                              type="checkbox"
                              checked={(editReport.tracked_column_roles ?? []).includes(role)}
                              onChange={e => setEditReport(r => {
                                const current = r.tracked_column_roles ?? []
                                return { ...r, tracked_column_roles: e.target.checked ? [...current.filter(x => x !== role), role] : current.filter(x => x !== role) }
                              })}
                            />
                            {role}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="wc-actions">
                    <button className="int-btn int-btn-primary int-btn-sm" onClick={handleSaveReport} disabled={wcSaving}>
                      {wcSaving ? 'Saving…' : <><Save size={13} /> Save</>}
                    </button>
                  </div>
                </div>
              )}

              <div className="wc-footer">
                <button className="int-btn int-btn-ghost int-btn-sm" onClick={handleResetWorkflow} disabled={wcSaving}>
                  <RotateCcw size={13} /> Reset to Defaults
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════ DEVELOPERS ══════════════ */}
      {mainTab === 'developers' && <DevelopersTab />}
    </div>
  )
}

// ─── Developers Tab ──────────────────────────────────────────────────────────

function DevelopersTab() {
  const [users, setUsers] = useState<YouTrackUser[]>([])
  const [subsystems, setSubsystems] = useState<string[]>([])
  const [configs, setConfigs] = useState<DeveloperSubsystemConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      api.getYouTrackFormMeta(),
      api.getDeveloperConfigs(),
    ]).then(([metaRes, configRes]) => {
      if (metaRes.success && metaRes.data) {
        setUsers(metaRes.data.users)
        setSubsystems(metaRes.data.subsystems.map(s => s.name))
        const saved = configRes.success && configRes.data ? configRes.data as DeveloperSubsystemConfig[] : []
        const savedMap = new Map(saved.map((c: DeveloperSubsystemConfig) => [c.developer_login, c]))
        setConfigs(metaRes.data.users.map(u => ({
          developer_login: u.login,
          developer_name:  u.fullName || u.login,
          subsystems:      savedMap.get(u.login)?.subsystems ?? [],
          is_qa:           savedMap.get(u.login)?.is_qa ?? false,
        })))
      }
    }).catch(() => setError('Failed to load developers')).finally(() => setLoading(false))
  }, [])

  const toggle = (login: string, subsystem: string) => {
    setConfigs(prev => prev.map(c => {
      if (c.developer_login !== login) return c
      const has = c.subsystems.includes(subsystem)
      return { ...c, subsystems: has ? c.subsystems.filter(s => s !== subsystem) : [...c.subsystems, subsystem] }
    }))
    setSaved(false)
  }

  const toggleQA = (login: string) => {
    setConfigs(prev => prev.map(c =>
      c.developer_login === login ? { ...c, is_qa: !c.is_qa } : c
    ))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.saveDeveloperConfigs(configs)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="int-content"><div className="int-loading">Loading developers…</div></div>

  return (
    <div className="int-content">
      <div className="int-service-header">
        <div>
          <div className="int-service-name">Developer Subsystem Config</div>
          <div className="int-service-desc">
            Map each developer to the subsystems they own. AI Fill uses this to auto-assign tickets to the right person based on the ticket subsystem.
          </div>
        </div>
        <button className={`int-btn int-btn-primary${saving ? ' int-btn-loading' : ''}`} onClick={handleSave} disabled={saving}>
          {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && <div className="int-error-banner">{error}</div>}

      {subsystems.length === 0 ? (
        <div className="dev-cfg-empty">No subsystems found — connect YouTrack first.</div>
      ) : (
        <div className="dev-cfg-wrap">
          <div className="dev-cfg-table">
            <div className="dev-cfg-header">
              <div className="dev-cfg-col-dev">Developer</div>
              {subsystems.map(s => (
                <div key={s} className="dev-cfg-col-sub" title={s}>{s}</div>
              ))}
              <div className="dev-cfg-col-qa" title="Mark as QA — excluded from AI auto-assign">QA</div>
            </div>
            {configs.map(cfg => {
              const user = users.find(u => u.login === cfg.developer_login)
              return (
                <div key={cfg.developer_login} className={`dev-cfg-row${cfg.is_qa ? ' dev-cfg-row--qa' : ''}`}>
                  <div className="dev-cfg-col-dev">
                    {user?.avatarUrl
                      ? <img src={user.avatarUrl} alt="" className="dev-cfg-avatar" />
                      : <span className="dev-cfg-avatar-init">{(cfg.developer_name || cfg.developer_login).charAt(0).toUpperCase()}</span>
                    }
                    <span className="dev-cfg-name">{cfg.developer_name || cfg.developer_login}</span>
                    {cfg.is_qa && <span className="dev-cfg-qa-badge">QA</span>}
                  </div>
                  {subsystems.map(s => (
                    <div key={s} className="dev-cfg-col-sub">
                      <button
                        className={`dev-cfg-check${cfg.subsystems.includes(s) && !cfg.is_qa ? ' dev-cfg-check--on' : ''}`}
                        onClick={() => !cfg.is_qa && toggle(cfg.developer_login, s)}
                        disabled={cfg.is_qa}
                        title={cfg.is_qa ? 'QA — not assigned to subsystems' : cfg.subsystems.includes(s) ? `Remove ${s}` : `Add ${s}`}
                      />
                    </div>
                  ))}
                  <div className="dev-cfg-col-qa">
                    <button
                      className={`dev-cfg-check dev-cfg-check--qa${cfg.is_qa ? ' dev-cfg-check--on' : ''}`}
                      onClick={() => toggleQA(cfg.developer_login)}
                      title={cfg.is_qa ? 'Remove QA flag' : 'Mark as QA team (excluded from auto-assign)'}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
