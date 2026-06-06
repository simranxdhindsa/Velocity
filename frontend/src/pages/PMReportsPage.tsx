import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { usePersistedState, PERSIST } from '@/hooks/usePersistedState'
import HoverCard, { HCRow, HCBar, HCDivider, HCBadge } from '../components/HoverCard'
import DeploymentProjectBrowser from '../components/deployment/DeploymentProjectBrowser'
import DeploymentTicketInput from '../components/deployment/DeploymentTicketInput'
import DeploymentTicketList from '../components/deployment/DeploymentTicketList'
import DeploymentReportPreview from '../components/deployment/DeploymentReportPreview'
import DeploymentExportButtons from '../components/deployment/DeploymentExportButtons'
import type { LoadedDeploymentTicket } from '../components/deployment/DeploymentProjectBrowser'
import type { TicketLine } from '../components/deployment/DeploymentTicketInput'
import type { DeploymentTicket, Platform } from '../components/deployment/types'
import { extractPriority, detectPlatform, stripPrefix } from '../components/deployment/types'
import type { DeploymentBotConfig, DeploymentSectionConfig } from '../services/api'
import { createPortal } from 'react-dom'
import {
  MessageSquare, Send, Bot, Loader2,
  FileText, Users, Clock, Copy, Check,
  RefreshCw, ChevronDown, AlertTriangle, TrendingUp,
  Calendar, Pin, PinOff, ChevronLeft, ChevronRight,
  Search, RotateCcw, Save, ArrowDownUp, ArrowUpNarrowWide,
  ArrowDownNarrowWide, Star, Activity, X, TriangleAlert,
  CheckCircle2, Timer, Zap, Filter, Trash2,
  Brain, ScanSearch, BarChart2, GitBranch, Layers,
  Cpu, Database, Radar, Gauge, ListChecks,
  Workflow, Telescope, FlaskConical, Network, Compass,
  Rocket, ShieldCheck, Shield,
} from 'lucide-react'
import { DAILY_LIMIT_MSGS, GENERIC_LIMIT_MSGS } from '../data/assistantMessages'
import api from '../services/api'
import type { IssueTimeline, IssueStint, YouTrackSprint, SprintBoardColumn, SprintBoardIssue, IssueStateLogEntry } from '../services/api'
import {
  pmAssistantQuery, getCarryover, saveCarryoverPlan,
  getAssigneeStats, getAvatarMap,
  getTimeTracking, getIssueTimelines,
  generatePMReport, generateWeeklyPMReport, listPMReports, listWeeklyPMReports, deletePMReport,
  getStageReportColumns, generateStageReport,
  getActiveSource,
} from '../services/pmDataService'
import DailyOpsTab from './DailyOpsTab'
import { StandupCompilerPage } from './StandupCompilerPage'
import { IssueDetailPanel } from '../components/IssueDetailPanel'
import DevTimeView from '../components/DevTimeView'
import type { DevTimeVariant } from '../components/DevTimeView'
import FeatureGroupsView from '../components/FeatureGroupsView'
import { useWorkflowConfig } from '../hooks/useWorkflowConfig'
import { useAuth } from '../contexts/AuthContext'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface PMReport {
  id: string
  date: string
  report_type?: string  // e.g. "daily-full", "daily-summary", "weekly-full", "weekly-summary"
  report_text: string
  done_count: number
  open_count: number
  blocked_count: number
  generated_at: string
  updated_at: string
}

interface AssigneeStat {
  assignee: string
  open: number
  in_progress: number
  done: number
  blocked: number
  avg_hours_in_progress: number | null
  issues: string[]
}

interface TimeTrackingRow {
  id: string
  issue_id: string
  issue_summary: string
  assignee: string
  moved_by: string
  moved_by_mismatch: boolean
  from_state: string
  to_state: string
  priority: string
  transitioned_at: string
  duration_in_prev_state_hours: number | null
  comment: string
  overdue: boolean
  threshold_hours: number
  due_date?: string
  pinned: boolean
}

// State order for moved-back detection (lower = earlier in workflow)
const STATE_ORDER: Record<string, number> = {
  'backlog': 0, 'open': 0,
  'in progress': 1,
  'dev': 2,
  'stage': 3, 'ready for stage': 3,
  'prod': 4, 'ready for prod': 4,
  'done': 5, 'closed': 5, "won't fix": 5, 'duplicate': 5, 'mobile done': 5,
}

function isMovedBack(fromState: string, toState: string): boolean {
  const from = STATE_ORDER[fromState.toLowerCase()] ?? 1
  const to = STATE_ORDER[toState.toLowerCase()] ?? 1
  return to < from
}

// Get Monday of the week containing the given date
function getMondayOf(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day // adjust so Monday=0
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function formatWeekRange(monday: Date): string {
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
  return `${monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${sunday.toLocaleDateString(undefined, opts)}`
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'tracking',    label: 'Tracking',          icon: Activity  },
  { id: 'daily',       label: 'Reports',            icon: FileText  },
  { id: 'assignees',   label: 'Assignee Stats',     icon: Users     },
  { id: 'dailyops',    label: 'Daily Ops',          icon: Zap       },
  { id: 'deployment',  label: 'Deployment Report',  icon: Rocket    },
  { id: 'standup',     label: 'Compiler',           icon: Send      },
] as const

type TabId = typeof TABS[number]['id']

const SUGGESTED_QUERIES = [
  'Which tickets have been bounced back this sprint?',
  'Show me all blocked tickets and why they\'re stuck',
  'Who has the most overdue tickets right now?',
  'Which tickets are past their SLA deadline?',
  'Show cycle time per developer this sprint',
  'Which hotfixes are still in progress?',
  'Show QA verification status — what\'s pending DEV, STAGE, PROD?',
  'Which tickets have the highest bounce count?',
  'Developer workload — active vs blocked vs done per person',
  'Show me all at-risk tickets sorted by delay severity',
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function formatHours(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  return `${h.toFixed(1)}h`
}

function priorityBadgeClass(priority: string): string {
  const p = priority.toUpperCase()
  if (p === 'P0' || p === 'CRITICAL') return 'priority-badge p0'
  if (p === 'P1') return 'priority-badge p1'
  if (p === 'P2') return 'priority-badge p2'
  if (p === 'P3') return 'priority-badge p3'
  return 'priority-badge other'
}

// ─── Markdown renderer (preserved from original) ─────────────────────────────

function escapeHtml(str: string) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderInline(text: string) {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
}

function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const htmlParts: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim().startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(escapeHtml(lines[i]))
        i++
      }
      i++
      htmlParts.push(`<pre class="pm-code-block"><code>${codeLines.join('\n')}</code></pre>`)
      continue
    }

    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableRows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const row = lines[i].trim()
        if (/^\|[\s\-:|]+\|$/.test(row)) { i++; continue }
        const cells = row.slice(1, -1).split('|').map(c => c.trim())
        tableRows.push(cells)
        i++
      }
      if (tableRows.length > 0) {
        let tableHtml = '<table class="pm-report-table"><thead><tr>'
        for (const cell of tableRows[0]) tableHtml += `<th>${escapeHtml(cell)}</th>`
        tableHtml += '</tr></thead><tbody>'
        for (let r = 1; r < tableRows.length; r++) {
          tableHtml += '<tr>'
          for (const cell of tableRows[r]) tableHtml += `<td>${renderInline(cell)}</td>`
          tableHtml += '</tr>'
        }
        tableHtml += '</tbody></table>'
        htmlParts.push(tableHtml)
      }
      continue
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/)
    if (headingMatch) {
      const level = headingMatch[1].length + 1
      htmlParts.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`)
      i++; continue
    }

    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      const listItems: string[] = []
      while (i < lines.length && (lines[i].trim().startsWith('- ') || lines[i].trim().startsWith('* '))) {
        listItems.push(`<li>${renderInline(lines[i].trim().slice(2))}</li>`)
        i++
      }
      htmlParts.push(`<ul>${listItems.join('')}</ul>`)
      continue
    }

    if (/^\d+\.\s/.test(line.trim())) {
      const listItems: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        listItems.push(`<li>${renderInline(lines[i].trim().replace(/^\d+\.\s/, ''))}</li>`)
        i++
      }
      htmlParts.push(`<ol>${listItems.join('')}</ol>`)
      continue
    }

    if (line.trim() === '') { htmlParts.push('<br/>'); i++; continue }

    htmlParts.push(`<p>${renderInline(line)}</p>`)
    i++
  }

  return htmlParts.join('')
}

// ─── Tab: PM Assistant ────────────────────────────────────────────────────────

const THINKING_PHRASES: { text: string; Icon: React.ElementType; key: string }[] = [
  { text: 'Thinking…',                    Icon: Brain,         key: 'brain' },
  { text: 'Analyzing your tickets…',      Icon: ScanSearch,    key: 'scan-search' },
  { text: 'Checking workload data…',      Icon: BarChart2,     key: 'bar-chart' },
  { text: 'Scanning issue history…',      Icon: Radar,         key: 'radar' },
  { text: 'Crunching the numbers…',       Icon: Cpu,           key: 'cpu' },
  { text: 'Looking through state logs…',  Icon: Database,      key: 'database' },
  { text: 'Reviewing assignee activity…', Icon: Users,         key: 'users' },
  { text: 'Checking for blockers…',       Icon: AlertTriangle, key: 'alert' },
  { text: 'Fetching live data…',          Icon: Network,       key: 'network' },
  { text: 'Correlating timelines…',       Icon: GitBranch,     key: 'git-branch' },
  { text: 'Inspecting ticket flow…',      Icon: Workflow,      key: 'workflow' },
  { text: 'Reading sprint context…',      Icon: Layers,        key: 'layers' },
  { text: 'Identifying patterns…',        Icon: TrendingUp,    key: 'trending-up' },
  { text: 'Pulling YouTrack data…',       Icon: Telescope,     key: 'telescope' },
  { text: 'Cross-referencing issues…',    Icon: ListChecks,    key: 'list-checks' },
  { text: 'Running diagnostics…',         Icon: FlaskConical,  key: 'flask' },
  { text: 'Processing context…',          Icon: Compass,       key: 'compass' },
  { text: 'Reviewing open items…',        Icon: FileText,      key: 'file-text' },
  { text: 'Checking delayed tickets…',    Icon: Timer,         key: 'timer' },
  { text: 'Almost there…',               Icon: Gauge,         key: 'gauge' },
]

export function PMAssistantTab() {
  const { user } = useAuth()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [thinkingIdx, setThinkingIdx] = useState(0)
  const [thinkingVisible, setThinkingVisible] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sprint selector state
  const [sprints, setSprints] = useState<YouTrackSprint[]>([])
  const [assistantSprint, setAssistantSprint] = useState<YouTrackSprint | null>(null)
  const [sprintDropOpen, setSprintDropOpen] = useState(false)
  const [actionNotif, setActionNotif] = useState<string | null>(null)
  const sprintDropRef = useRef<HTMLDivElement>(null)

  // Load sprints + restore last selected sprint
  useEffect(() => {
    api.getYouTrackSprints().then(res => {
      const list = ((res as any).data as YouTrackSprint[]) ?? []
      setSprints(list)
      const savedId = localStorage.getItem('pm_active_sprint_id')
      if (savedId) {
        const found = list.find(s => s.id === savedId)
        if (found) setAssistantSprint(found)
      }
    }).catch(() => {})
  }, [])

  // Outside-click to close sprint dropdown
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sprintDropRef.current && !sprintDropRef.current.contains(e.target as Node)) {
        setSprintDropOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Auto-dismiss action notification
  useEffect(() => {
    if (!actionNotif) return
    const t = setTimeout(() => setActionNotif(null), 3500)
    return () => clearTimeout(t)
  }, [actionNotif])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!loading) { setThinkingIdx(0); setThinkingVisible(true); return }
    const cycle = () => {
      setThinkingVisible(false)
      thinkingTimerRef.current = setTimeout(() => {
        setThinkingIdx(i => (i + 1) % THINKING_PHRASES.length)
        setThinkingVisible(true)
        thinkingTimerRef.current = setTimeout(cycle, 2200)
      }, 350)
    }
    thinkingTimerRef.current = setTimeout(cycle, 2200)
    return () => { if (thinkingTimerRef.current) clearTimeout(thinkingTimerRef.current) }
  }, [loading])

  const handleSprintSelect = (sprint: YouTrackSprint | null) => {
    setAssistantSprint(sprint)
    setSprintDropOpen(false)
    if (sprint) {
      localStorage.setItem('pm_active_sprint_id', sprint.id)
      localStorage.setItem('pm_active_sprint_name', sprint.name)
    } else {
      localStorage.removeItem('pm_active_sprint_id')
      localStorage.removeItem('pm_active_sprint_name')
    }
  }

  const handleSend = async (query?: string) => {
    const text = query || input.trim()
    if (!text || loading) return

    const userMsg: ChatMessage = { id: `msg-${Date.now()}-user`, role: 'user', content: text, timestamp: new Date() }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setInput('')
    setLoading(true)

    const history = updatedMessages.map(m => ({ role: m.role, content: m.content }))
    const historyWithoutLast = history.slice(0, -1)

    const sprintId = assistantSprint?.id
    const sprintName = assistantSprint?.name
    const sprintFinishMs = assistantSprint?.finish ?? undefined
    const doQuery = () => pmAssistantQuery(text, historyWithoutLast, sprintId, sprintName, sprintFinishMs)

    const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]

    const friendlyError = (msg: string): string => {
      const tpdMatch = msg.match(/try again in (\d+)m(\d+(?:\.\d+)?)?s?/i)
      if (tpdMatch) {
        const mins = parseInt(tpdMatch[1])
        const secs = tpdMatch[2] ? Math.round(parseFloat(tpdMatch[2])) : 0
        const timeStr = secs > 0 ? `${mins}m ${secs}s` : `${mins} minute${mins !== 1 ? 's' : ''}`
        return pick(DAILY_LIMIT_MSGS).replace(/{time}/g, timeStr)
      }
      const perMinMatch = msg.match(/try again in (\d+(?:\.\d+)?)(ms|s)\b/i)
      if (perMinMatch) return pick(GENERIC_LIMIT_MSGS)
      if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('token')) {
        return pick(GENERIC_LIMIT_MSGS)
      }
      return "Something went wrong on my end. Please try again."
    }

    try {
      let response
      try {
        response = await doQuery()
      } catch (firstErr) {
        const errMsg = firstErr instanceof Error ? firstErr.message : ''
        const retryMatch = errMsg.match(/try again in (\d+(?:\.\d+)?)(ms|s)\b/i)
        if (retryMatch) {
          const value = parseFloat(retryMatch[1])
          const unit = retryMatch[2].toLowerCase()
          const delayMs = unit === 'ms' ? value : value * 1000
          if (delayMs <= 5000) {
            await new Promise(resolve => setTimeout(resolve, Math.ceil(delayMs) + 100))
            response = await doQuery()
          } else {
            throw firstErr
          }
        } else {
          throw firstErr
        }
      }

      // Handle structured action responses from AI
      const data = response.data as any
      if (data?.action === 'select_sprint' && data.payload?.sprint_id) {
        const targetSprint = sprints.find((s: YouTrackSprint) => s.id === data.payload.sprint_id)
          ?? { id: data.payload.sprint_id, name: data.payload.sprint_name ?? data.payload.sprint_id, start: 0, finish: 0, isCompleted: false }
        handleSprintSelect(targetSprint)
        setActionNotif(`Switched to ${targetSprint.name}`)
      }

      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        role: 'assistant',
        content: data?.response || 'No response received.',
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, assistantMsg])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : ''
      const errorMsg: ChatMessage = {
        id: `msg-${Date.now()}-error`,
        role: 'assistant',
        content: friendlyError(errMsg),
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, errorMsg])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const clearChat = () => setMessages([])

  const fmtSprintDate = (ms: number) => ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''

  return (
    <div className="pm-tab-content pm-assistant-tab">
      {/* Header: sprint selector + context badge + clear */}
      <div className="pm-assistant-header">
        <div className="pm-assistant-header-left">
          {/* Sprint selector dropdown */}
          <div className="pm-custom-dropdown pm-assistant-sprint-drop" ref={sprintDropRef}>
            <button
              className="pm-custom-dropdown-trigger pm-assistant-sprint-trigger"
              onClick={() => setSprintDropOpen(o => !o)}
            >
              <GitBranch size={11} />
              <span>{assistantSprint ? assistantSprint.name : 'All sprints'}</span>
              <ChevronDown size={10} />
            </button>
            {sprintDropOpen && createPortal(
              <div
                className="pm-custom-dropdown-menu"
                style={{
                  position: 'fixed',
                  top: (sprintDropRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                  left: sprintDropRef.current?.getBoundingClientRect().left ?? 0,
                  minWidth: 220,
                  zIndex: 9999,
                }}
              >
                <div
                  className={`pm-dropdown-item${!assistantSprint ? ' active' : ''}`}
                  onClick={() => handleSprintSelect(null)}
                >
                  All sprints
                </div>
                {sprints.map(s => (
                  <div
                    key={s.id}
                    className={`pm-dropdown-item${assistantSprint?.id === s.id ? ' active' : ''}`}
                    onClick={() => handleSprintSelect(s)}
                    style={{ opacity: s.isCompleted ? 0.6 : 1 }}
                  >
                    <span style={{ flex: 1 }}>{s.name}</span>
                    {s.start && s.finish && (
                      <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 8 }}>
                        {fmtSprintDate(s.start)}–{fmtSprintDate(s.finish)}
                      </span>
                    )}
                  </div>
                ))}
              </div>,
              document.body
            )}
          </div>
          <div className="pm-assistant-context-badge">
            <Bot size={12} />
            <span>Live context{assistantSprint ? ` · ${assistantSprint.name}` : ''}</span>
          </div>
        </div>
        {messages.length > 0 && (
          <button className="btn-sm btn-secondary" onClick={clearChat} title="Start a new conversation">
            Clear chat
          </button>
        )}
      </div>

      {/* Action notification banner */}
      {actionNotif && (
        <div className="pm-assistant-action-notif">
          <Check size={12} />
          <span>{actionNotif}</span>
        </div>
      )}

      <div className="pm-chat-messages">
        {messages.length === 0 && (
          <div className="pm-chat-empty">
            <MessageSquare size={48} />
            <h3>PM Assistant</h3>
            <p>Ask about overdue tickets, regressions, workload, or anything about your project.</p>
            <div className="pm-suggested-queries">
              {SUGGESTED_QUERIES.map(q => (
                <button key={q} className="pm-suggested-chip" onClick={() => handleSend(q)}>{q}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`pm-chat-message pm-chat-${msg.role}`}>
            <div className="pm-chat-avatar">
              {msg.role === 'user'
                ? user?.picture
                  ? <img src={user.picture} alt={user.name ?? 'You'} className="pm-chat-avatar-img" />
                  : <span style={{ fontSize: '0.7rem', fontWeight: 700, lineHeight: 1 }}>{user?.name?.charAt(0).toUpperCase() ?? 'U'}</span>
                : <Bot size={16} />}
            </div>
            <div className="pm-chat-bubble">
              {msg.role === 'assistant' ? (
                <div className="pm-chat-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
              ) : (
                <div className="pm-chat-content">{msg.content}</div>
              )}
              <span className="pm-chat-time">
                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })}
              </span>
            </div>
          </div>
        ))}

        {loading && (() => {
          const phrase = THINKING_PHRASES[thinkingIdx]
          const PhIcon = phrase.Icon
          return (
            <div className="pm-chat-message pm-chat-assistant">
              <div className="pm-chat-avatar"><Bot size={16} /></div>
              <div className="pm-chat-bubble pm-chat-loading">
                <span className={`pm-thinking-icon pm-ti-${phrase.key}${thinkingVisible ? ' pm-thinking-visible' : ''}`}>
                  <PhIcon size={15} />
                </span>
                <span className={`pm-thinking-text${thinkingVisible ? ' pm-thinking-visible' : ''}`}>
                  {phrase.text}
                </span>
              </div>
            </div>
          )
        })()}

        <div ref={messagesEndRef} />
      </div>

      <div className="pm-chat-input-bar">
        {messages.length > 0 && (
          <div className="pm-suggested-queries pm-suggested-inline">
            {SUGGESTED_QUERIES.slice(0, 4).map(q => (
              <button key={q} className="pm-suggested-chip pm-suggested-sm" onClick={() => handleSend(q)} disabled={loading}>{q}</button>
            ))}
          </div>
        )}
        <div className="pm-chat-input-row">
          <input
            ref={inputRef}
            type="text"
            className="pm-chat-input"
            placeholder={assistantSprint ? `Ask about ${assistantSprint.name}…` : 'Ask about overdue tickets, workload, regressions…'}
            value={input}
            onChange={e => setInput(e.target.value.slice(0, 500))}
            maxLength={500}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            disabled={loading}
          />
          <button className="pm-chat-send-btn" onClick={() => handleSend()} disabled={loading || !input.trim()}>
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Tab: Daily Report ────────────────────────────────────────────────────────

const drMonthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']

function drFormatDisplay(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return `${String(d).padStart(2,'0')}-${String(m).padStart(2,'0')}-${y}`
}

function getMondayOfWeek(d: Date): string {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(d)
  monday.setDate(d.getDate() + diff)
  return monday.toISOString().slice(0, 10)
}

function getWeekEnd(mondayStr: string): string {
  const monday = new Date(mondayStr + 'T00:00:00')
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return sunday.toISOString().slice(0, 10)
}

function formatWeekLabel(mondayStr: string): string {
  const monday = new Date(mondayStr + 'T00:00:00')
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const mo = monday.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
  const su = sunday.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
  return `${mo} – ${su}`
}

function DailyReportTab({ sprintId, sprintName }: {
  sprintId?: string
  sprintName?: string
}) {
  const [mode, setMode] = useState<'daily' | 'weekly'>('daily')
  const [reportScope, setReportScope] = useState<'full' | 'summary'>('full')
  const [date, setDate] = useState(todayStr())
  const [weekStart, setWeekStart] = useState(() => getMondayOfWeek(new Date()))
  const [report, setReport] = useState<PMReport | null>(null)
  const [history, setHistory] = useState<PMReport[]>([])
  const [weekHistory, setWeekHistory] = useState<PMReport[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Report config overrides
  const [configOpen, setConfigOpen] = useState(false)
  const [cfgPriorities, setCfgPriorities] = useState<string[]>([])
  const [cfgSections, setCfgSections] = useState<string[]>(['done', 'hotfixes', 'open', 'blocked', 'overdue'])
  const [cfgOpenStates, setCfgOpenStates] = useState<string[]>([])
  const [wfConfig, setWfConfig] = useState<{ priority_tags?: { label: string; color: string }[]; report_config?: { open_states?: string[]; sections?: string[]; priority_filters?: string[] } } | null>(null)
  const [ytStatesList, setYtStatesList] = useState<string[]>([])
  const [ytPrioritiesList, setYtPrioritiesList] = useState<{ name: string; background?: string; foreground?: string }[]>([])
  const [cfgSprintId, setCfgSprintId] = useState<string | undefined>(sprintId)
  const [cfgSprintName, setCfgSprintName] = useState<string | undefined>(sprintName)
  const [cfgSaveState, setCfgSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  // snapshot of what's currently saved in DB — used to detect unsaved changes
  const [savedSnapshot, setSavedSnapshot] = useState<{ priorities: string[]; sections: string[]; openStates: string[] } | null>(null)

  useEffect(() => {
    api.getWorkflowConfig().then(res => {
      if (res.success && res.data) {
        const cfg = res.data as typeof wfConfig
        setWfConfig(cfg)
        const rc = cfg?.report_config
        const p = rc?.priority_filters ?? []
        const s = rc?.sections ?? ['done','hotfixes','open','blocked','overdue']
        const o = rc?.open_states ?? []
        if (o.length) setCfgOpenStates(o)
        if (rc?.sections?.length) setCfgSections(s)
        if (rc?.priority_filters?.length) setCfgPriorities(p)
        setSavedSnapshot({ priorities: p, sections: s, openStates: o })
      }
    }).catch(() => {})
    // Priorities
    import('../services/pmDataService').then(({ getPMPriorities }) => {
      getPMPriorities().then(res => {
        if ((res as any).success && (res as any).data) {
          const data = (res as any).data as Array<{ name: string; background?: string; foreground?: string }>
          if (Array.isArray(data) && data.length > 0)
            setYtPrioritiesList(data.map(p => ({ name: p.name, background: p.background, foreground: p.foreground })))
        }
      }).catch(() => {})
    })
  }, [])

  // Sync page-level sprint prop into cfg state
  useEffect(() => {
    setCfgSprintId(sprintId)
    setCfgSprintName(sprintName)
  }, [sprintId, sprintName])

  // Load Open States dynamically — board columns when sprint selected, all states otherwise
  useEffect(() => {
    setCfgOpenStates([])
    if (cfgSprintId) {
      import('../services/pmDataService').then(({ getPMDefaultBoardColumns }) => {
        getPMDefaultBoardColumns().then(res => {
          if ((res as any).success && (res as any).data) {
            const cols = (res as any).data as Array<{ name: string; fieldValues: string[] }>
            const seen = new Set<string>()
            const states: string[] = []
            cols.forEach(col => col.fieldValues.forEach(v => {
              if (!seen.has(v)) { seen.add(v); states.push(v) }
            }))
            setYtStatesList(states)
          }
        }).catch(() => {})
      })
    } else {
      import('../services/pmDataService').then(({ getPMStates }) => {
        getPMStates().then(res => {
          if ((res as any).success && (res as any).data)
            setYtStatesList(((res as any).data as Array<{ name: string }>).map((s: { name: string }) => s.name))
        }).catch(() => {})
      })
    }
  }, [cfgSprintId])

  // Calendar dropdown state
  const [calOpen, setCalOpen] = useState(false)
  const [calDate, setCalDate] = useState(() => new Date())
  const calRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!calOpen) return
    function handler(e: MouseEvent) {
      if (calRef.current && !calRef.current.contains(e.target as Node)) setCalOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [calOpen])

  function drSelectDate(d: string) {
    setDate(d)
    setReport(null)
    setCalOpen(false)
  }

  function drSelectWeek(ds: string) {
    setWeekStart(getMondayOfWeek(new Date(ds + 'T00:00:00')))
    setReport(null)
    setCalOpen(false)
  }

  function drNavigateMonth(dir: number) {
    setCalDate(new Date(calDate.getFullYear(), calDate.getMonth() + dir, 1))
  }

  const drDaysInMonth = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 0).getDate()
  const drFirstDay   = new Date(calDate.getFullYear(), calDate.getMonth(), 1).getDay()
  const drTodayStr   = todayStr()

  // Carry-over from yesterday's EOD plan — only shown when viewing today
  const [carryoverItems, setCarryoverItems] = useState<{ text: string; done: boolean }[]>([])

  useEffect(() => {
    if (date !== todayStr()) { setCarryoverItems([]); return }
    getCarryover().then(res => {
      if (res.data?.yesterday?.length) setCarryoverItems(res.data.yesterday)
    }).catch(() => {})
  }, [date])

  async function handleCarryoverToggle(idx: number) {
    const updated = carryoverItems.map((item, i) => i === idx ? { ...item, done: !item.done } : item)
    setCarryoverItems(updated)
    try { await saveCarryoverPlan(updated) } catch { setCarryoverItems(carryoverItems) }
  }

  const fetchHistory = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const res = await listPMReports()
      setHistory((res as any).data || [])
    } catch {
      // non-fatal
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  const fetchWeeklyHistory = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const res = await listWeeklyPMReports()
      setWeekHistory((res as any).data || [])
    } catch {
      // non-fatal
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    fetchHistory()
  }, [fetchHistory])

  useEffect(() => {
    if (mode === 'weekly') fetchWeeklyHistory()
  }, [mode, fetchWeeklyHistory])

  const generateReport = async () => {
    setLoading(true)
    setError(null)
    const overrides = {
      priorities: cfgPriorities.length ? cfgPriorities : undefined,
      open_states: cfgOpenStates.length ? cfgOpenStates : undefined,
      sections: cfgSections.length > 0 ? cfgSections : undefined,
    }
    try {
      const res = mode === 'daily'
        ? await generatePMReport(date, reportScope, overrides, cfgSprintId, cfgSprintName)
        : await generateWeeklyPMReport(weekStart as any, reportScope, overrides, cfgSprintId, cfgSprintName)
      setReport((res as any).data)
      mode === 'daily' ? fetchHistory() : fetchWeeklyHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate report')
    } finally {
      setLoading(false)
    }
  }

  const copyReport = async () => {
    if (!report) return
    await navigator.clipboard.writeText(report.report_text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const loadHistoricReport = (r: PMReport) => {
    const rt = r.report_type ?? ''
    const isWeekly = rt.startsWith('weekly')
    if (isWeekly) {
      setWeekStart(r.date)
      setMode('weekly')
    } else {
      setDate(r.date)
      setMode('daily')
    }

    // Prefer full report — if user clicked summary but full exists for same date, load full instead
    const pool = isWeekly ? weekHistory : history
    const prefix = isWeekly ? 'weekly' : 'daily'
    const fullVersion = pool.find(h => h.date === r.date && h.report_type === `${prefix}-full`)
    const summaryVersion = pool.find(h => h.date === r.date && h.report_type === `${prefix}-summary`)
    const toLoad = fullVersion ?? summaryVersion ?? r
    setReportScope(toLoad.report_type?.includes('summary') ? 'summary' : 'full')
    setReport(toLoad)
  }

  // Switch scope using already-saved reports — never regenerates
  const switchScope = (newScope: 'full' | 'summary') => {
    if (newScope === reportScope) return
    if (!report) { setReportScope(newScope); return }
    const rt = report.report_type ?? ''
    const isWeekly = rt.startsWith('weekly')
    const pool = isWeekly ? weekHistory : history
    const prefix = isWeekly ? 'weekly' : 'daily'
    const target = pool.find(h => h.date === report.date && h.report_type === `${prefix}-${newScope}`)
    setReportScope(newScope)
    if (target) {
      setReport(target)
    } else {
      // Show placeholder — user can generate this scope if desired
      setReport(null)
    }
  }

  // Format the slack-style report text for display
  const renderReportText = (text: string) => {
    const lines = text.split('\n')
    return lines.map((line, i) => {
      if (line.startsWith('*') && line.endsWith('*')) {
        return <div key={i} className="pm-report-section-header">{line.slice(1, -1)}</div>
      }
      if (line.startsWith('•')) {
        return <div key={i} className="pm-report-bullet">{line}</div>
      }
      if (line.startsWith('_') && line.endsWith('_')) {
        return <div key={i} className="pm-report-italic">{line.slice(1, -1)}</div>
      }
      if (line.trim() === '') {
        return <div key={i} className="pm-report-spacer" />
      }
      return <div key={i} className="pm-report-line">{line}</div>
    })
  }

  return (
    <div className="pm-tab-content pm-daily-tab">
      <div className="pm-daily-layout">
        {/* Left: Report Viewer */}
        <div className="pm-daily-main glass-card">
          <div className="pm-daily-toolbar">
            <div className="pm-report-mode-toggle">
              <button
                className={`pm-mode-btn ${mode === 'daily' ? 'active' : ''}`}
                onClick={() => { setMode('daily'); setReport(null) }}
              >Daily</button>
              <button
                className={`pm-mode-btn ${mode === 'weekly' ? 'active' : ''}`}
                onClick={() => { setMode('weekly'); setReport(null) }}
              >Weekly</button>
            </div>
            <div className="pm-report-scope-toggle">
              {(() => {
                const pool = mode === 'weekly' ? weekHistory : history
                const prefix = mode === 'weekly' ? 'weekly' : 'daily'
                const activeDate = mode === 'weekly' ? weekStart : date
                const hasFullSaved = pool.some(h => h.date === activeDate && h.report_type === `${prefix}-full`)
                const hasSummarySaved = pool.some(h => h.date === activeDate && h.report_type === `${prefix}-summary`)
                return (
                  <>
                    <button
                      className={`pm-scope-btn ${reportScope === 'full' ? 'active' : ''}`}
                      onClick={() => report ? switchScope('full') : setReportScope('full')}
                    >Full Report</button>
                    <button
                      className={`pm-scope-btn ${reportScope === 'summary' ? 'active' : ''}`}
                      onClick={() => report ? switchScope('summary') : setReportScope('summary')}
                    >Summary</button>
                  </>
                )
              })()}
            </div>
            <div className="pm-daily-date-row">
              <div className="dr-cal-wrap" ref={calRef}>
                <button className="dr-cal-trigger" onClick={() => setCalOpen(o => !o)}>
                  <Calendar size={14} />
                  {mode === 'daily' ? drFormatDisplay(date) : formatWeekLabel(weekStart)}
                  <ChevronDown size={13} style={{ marginLeft: '0.15rem', opacity: 0.6 }} />
                </button>
                {calOpen && (
                  <div className="dr-cal-dropdown daily-calendar glass-card">
                    <div className="calendar-nav">
                      <button className="calendar-nav-btn" onClick={() => drNavigateMonth(-1)}>
                        <ChevronLeft size={16} />
                      </button>
                      <span className="calendar-month-label">
                        {drMonthNames[calDate.getMonth()]} {calDate.getFullYear()}
                      </span>
                      <button className="calendar-nav-btn" onClick={() => drNavigateMonth(1)}>
                        <ChevronRight size={16} />
                      </button>
                    </div>
                    <div className="calendar-grid">
                      <div className="calendar-header-row">
                        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
                          <span key={d} className="calendar-day-label">{d}</span>
                        ))}
                      </div>
                      <div className="calendar-body">
                        {Array.from({ length: drFirstDay }).map((_, i) => (
                          <span key={`e-${i}`} className="calendar-day empty" />
                        ))}
                        {Array.from({ length: drDaysInMonth }).map((_, i) => {
                          const day = i + 1
                          const ds = `${calDate.getFullYear()}-${String(calDate.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
                          const isFuture = ds > drTodayStr
                          const weekEnd = getWeekEnd(weekStart)
                          const isInWeek = mode === 'weekly' && ds >= weekStart && ds <= weekEnd
                          const isWeekStart = mode === 'weekly' && ds === weekStart
                          const isWeekEnd = mode === 'weekly' && ds === weekEnd
                          return (
                            <button
                              key={day}
                              className={`calendar-day ${mode === 'daily' && ds === date ? 'selected' : ''} ${ds === drTodayStr ? 'today' : ''} ${isFuture ? 'empty' : ''} ${isInWeek ? 'week-range' : ''} ${isWeekStart ? 'week-range-start' : ''} ${isWeekEnd ? 'week-range-end' : ''}`}
                              disabled={isFuture}
                              onClick={() => !isFuture && (mode === 'daily' ? drSelectDate(ds) : drSelectWeek(ds))}
                            >
                              {day}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm calendar-today-btn"
                      onClick={() => {
                        if (mode === 'daily') { drSelectDate(drTodayStr); setCalDate(new Date()) }
                        else { drSelectWeek(drTodayStr); setCalDate(new Date()) }
                      }}
                    >
                      <Calendar size={14} />
                      {mode === 'daily' ? 'Today' : 'This Week'}
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="pm-daily-actions">
              <button className="btn-primary pm-generate-btn" onClick={() => setConfigOpen(o => !o)} disabled={loading}>
                <Filter size={15} />
                Generate Report{cfgPriorities.length || cfgSections.length < 5 ? ' •' : ''}
              </button>
              {report && (
                <button className="btn-secondary pm-copy-btn" onClick={copyReport}>
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              )}
            </div>

            {/* Config + Generate panel */}
            {configOpen && (() => {
              const allSections = ['done','hotfixes','open','blocked','overdue']
              // Build priority list: use YouTrack colors if available, fall back to workflow config
              const wfColorMap: Record<string, string> = {}
              ;(wfConfig?.priority_tags ?? []).forEach(t => { wfColorMap[t.label] = t.color })
              const fallbackColors: Record<string, string> = { P0:'#ef4444', P1:'#f97316', P2:'#eab308', P3:'#6366f1', A0:'#8b5cf6', A1:'#06b6d4' }
              const basePriorities: { label: string; color: string }[] = ytPrioritiesList.length > 0
                ? ytPrioritiesList.map(p => ({ label: p.name, color: p.background ?? wfColorMap[p.name] ?? fallbackColors[p.name] ?? '#94a3b8' }))
                : (wfConfig?.priority_tags ?? [{label:'P0',color:'#ef4444'},{label:'P1',color:'#f97316'},{label:'P2',color:'#eab308'},{label:'P3',color:'#6366f1'}])
              // Always include "Other" for unassigned issues
              const allPriorities = [...basePriorities, { label: 'Other', color: '#94a3b8' }]
              const allPriorityLabels = allPriorities.map(t => t.label)
              const allSectionsOn = cfgSections.length === allSections.length
              // "All" means cfgPriorities is empty (backend default = all) OR every label is included
              const allPrioritiesOn = cfgPriorities.length === 0 || allPriorityLabels.every(l => cfgPriorities.includes(l))
              return (
                <div className="pm-config-panel">
                  <div className="pm-config-grid">
                    <div className="pm-config-card">
                      <div className="pm-config-card-title">Sections</div>
                      <div className="pm-config-chips">
                        <label className="cfg-chip" style={{ gap: '0.35rem' }}>
                          <input type="checkbox" checked={allSectionsOn} onChange={() => setCfgSections(allSectionsOn ? [] : [...allSections])} style={{ accentColor: 'var(--color-primary)', margin: 0 }} />
                          All
                        </label>
                        {allSections.map(s => (
                          <button key={s} className={`cfg-chip${cfgSections.includes(s) ? ' on' : ''}`}
                            onClick={() => setCfgSections(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}>
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="pm-config-card">
                      <div className="pm-config-card-title">Priorities</div>
                      <div className="pm-config-chips">
                        <label className="cfg-chip" style={{ gap: '0.35rem' }}>
                          <input type="checkbox" checked={allPrioritiesOn}
                            onChange={() => {
                              if (allPrioritiesOn) {
                                setCfgPriorities([...allPriorityLabels])
                              } else {
                                setCfgPriorities([])
                              }
                            }}
                            style={{ accentColor: 'var(--color-primary)', margin: 0 }} />
                          All
                        </label>
                        {allPriorities.map(t => {
                          const isOn = cfgPriorities.length === 0 || cfgPriorities.includes(t.label)
                          return (
                            <button key={t.label} className={`cfg-chip${isOn ? ' on' : ''}`}
                              onClick={() => setCfgPriorities(prev => {
                                const effective = prev.length === 0 ? allPriorityLabels : prev
                                const next = effective.includes(t.label) ? effective.filter(x => x !== t.label) : [...effective, t.label]
                                return next.length === allPriorityLabels.length ? [] : next
                              })}>
                              <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color, display: 'inline-block', flexShrink: 0 }} />
                              {t.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    {(() => {
                      const availableStates = ytStatesList.length > 0 ? ytStatesList : (wfConfig?.report_config?.open_states ?? [])
                      return availableStates.length > 0 ? (
                        <div className="pm-config-card">
                          <div className="pm-config-card-title">Open States</div>
                          <div className="pm-config-chips pm-config-chips--scroll">
                            {availableStates.map(s => (
                              <button key={s} className={`cfg-chip${cfgOpenStates.includes(s) ? ' on' : ''}`}
                                onClick={() => setCfgOpenStates(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}>
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null
                    })()}
                  </div>
                  <div className="pm-config-actions">
                    <button className="btn-primary pm-generate-btn" disabled={loading} onClick={() => { setConfigOpen(false); generateReport() }}>
                      {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                      {loading ? 'Generating...' : 'Generate'}
                    </button>
                    <div className="pm-config-actions-right">
                      <button className="btn-ghost btn-sm" onClick={() => {
                        const snap = savedSnapshot
                        setCfgPriorities(snap?.priorities ?? [])
                        setCfgSections(snap?.sections?.length ? snap.sections : [...allSections])
                        setCfgOpenStates(snap?.openStates ?? [])
                        setCfgSaveState('idle')
                      }}>
                        <RotateCcw size={13} /> Reset
                      </button>
                      {(() => {
                        const isDirty = savedSnapshot && (
                          JSON.stringify([...cfgPriorities].sort()) !== JSON.stringify([...(savedSnapshot.priorities)].sort()) ||
                          JSON.stringify([...cfgSections].sort()) !== JSON.stringify([...(savedSnapshot.sections)].sort()) ||
                          JSON.stringify([...cfgOpenStates].sort()) !== JSON.stringify([...(savedSnapshot.openStates)].sort())
                        )
                        return (
                          <button
                            className={`btn-sm ${cfgSaveState === 'saved' ? 'btn-success' : 'btn-primary'}`}
                            disabled={cfgSaveState === 'saving' || !isDirty}
                            onClick={async () => {
                              setCfgSaveState('saving')
                              await api.updateReportConfig({ done_role: wfConfig?.report_config ? 'dev_done' : 'dev_done', blocked_states: [], open_states: cfgOpenStates, priority_filters: cfgPriorities, sections: cfgSections })
                              setSavedSnapshot({ priorities: cfgPriorities, sections: cfgSections, openStates: cfgOpenStates })
                              setCfgSaveState('saved')
                              setTimeout(() => setCfgSaveState('idle'), 2500)
                            }}>
                            {cfgSaveState === 'saving' ? <Loader2 size={13} className="animate-spin" /> : cfgSaveState === 'saved' ? <Check size={13} /> : <Save size={13} />}
                            {cfgSaveState === 'saving' ? 'Saving…' : cfgSaveState === 'saved' ? 'Saved!' : 'Save as Default'}
                          </button>
                        )
                      })()}
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>

          <div className="pm-report-scroll">
            {error && (
              <div className="pm-report-error">
                <AlertTriangle size={16} />
                {error}
              </div>
            )}

            {loading && (() => {
              const sk = (w: number | string, h: number, r = 5) => <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
              const lineW = ['92%','78%','85%','60%','88%','70%','95%','55%','80%','65%','90%','72%','83%','58%','76%']
              return (
                <div className="pm-report-viewer" style={{ pointerEvents: 'none' }}>
                  <div className="pm-report-meta">
                    {sk(60, 26, 8)}{sk(60, 26, 8)}{sk(60, 26, 8)}{sk(140, 14, 4)}
                  </div>
                  <div className="pm-report-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {sk('45%', 16, 4)}
                    {lineW.slice(0, 5).map((w, i) => <div key={i}>{sk(w, 13, 4)}</div>)}
                    <div style={{ height: 8 }} />
                    {sk('38%', 16, 4)}
                    {lineW.slice(5, 10).map((w, i) => <div key={i}>{sk(w, 13, 4)}</div>)}
                    <div style={{ height: 8 }} />
                    {sk('42%', 16, 4)}
                    {lineW.slice(10, 15).map((w, i) => <div key={i}>{sk(w, 13, 4)}</div>)}
                  </div>
                </div>
              )
            })()}

            {/* Carry-over checklist — shown at top when viewing today in daily mode */}
            {mode === 'daily' && date === todayStr() && carryoverItems.length > 0 && (
              <div className="pm-carryover-block">
                <div className="pm-carryover-header">
                  <Pin size={13} />
                  <span>Carry-over from yesterday's plan</span>
                  <span className="pm-carryover-count">
                    {carryoverItems.filter(i => i.done).length}/{carryoverItems.length} done
                  </span>
                </div>
                <div className="pm-carryover-list">
                  {carryoverItems.map((item, idx) => (
                    <label
                      key={idx}
                      className={`pm-carryover-item ${item.done ? 'pm-carryover-item--done' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={() => handleCarryoverToggle(idx)}
                      />
                      <span>{item.text}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {!loading && report ? (
              <div className="pm-report-viewer">
                <div className="pm-report-meta">
                  <div className="pm-report-stat-chip done">
                    <span className="chip-num">{report.done_count}</span> Done
                  </div>
                  <div className="pm-report-stat-chip open">
                    <span className="chip-num">{report.open_count}</span> Open
                  </div>
                  <div className="pm-report-stat-chip blocked">
                    <span className="chip-num">{report.blocked_count}</span> Blocked
                  </div>
                  <span className="pm-report-date-label">
                    {report.report_type === 'weekly'
                      ? `Week of ${formatWeekLabel(report.date)}`
                      : new Date(report.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
                <div className="pm-report-body">
                  {renderReportText(report.report_text)}
                </div>
              </div>
            ) : !loading ? (() => {
              const pool = mode === 'weekly' ? weekHistory : history
              const activeDate = mode === 'weekly' ? weekStart : date
              const prefix = mode === 'weekly' ? 'weekly' : 'daily'
              const hasAnyForDate = pool.some(h => h.date === activeDate)
              const hasSiblingScope = pool.some(h => h.date === activeDate && h.report_type === `${prefix}-${reportScope === 'full' ? 'summary' : 'full'}`)
              if (hasAnyForDate) {
                return (
                  <div className="pm-report-empty pm-report-scope-missing">
                    <FileText size={40} />
                    <p>No <strong>{reportScope === 'full' ? 'full' : 'summary'} report</strong> generated for this {mode === 'weekly' ? 'week' : 'date'}.</p>
                    {hasSiblingScope && (
                      <p className="pm-scope-hint">Switch to <strong>{reportScope === 'full' ? 'Summary' : 'Full Report'}</strong> to view the saved version, or click <strong>Generate Report</strong> to create this one.</p>
                    )}
                    {!hasSiblingScope && (
                      <p className="pm-scope-hint">Click <strong>Generate Report</strong> to create it.</p>
                    )}
                  </div>
                )
              }
              return (
                <div className="pm-report-empty">
                  <FileText size={40} />
                  {mode === 'daily'
                    ? <p>Select a date and click <strong>Generate Report</strong> to create today's Slack-style PM report.</p>
                    : <p>Select a week and click <strong>Generate Report</strong> to create a weekly PM report.</p>
                  }
                </div>
              )
            })() : null}
          </div>
        </div>

        {/* Right: History Sidebar */}
        <div className="pm-daily-sidebar glass-card">
          <div className="pm-sidebar-header">
            <h4>{mode === 'daily' ? 'Report History' : 'Weekly History'}</h4>
            <button className="pm-sidebar-refresh" onClick={mode === 'daily' ? fetchHistory : fetchWeeklyHistory} disabled={loadingHistory}>
              {loadingHistory ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
          <div className="pm-history-list">
            {(mode === 'daily' ? history : weekHistory).length === 0 && !loadingHistory && (
              <p className="pm-history-empty">No saved reports yet.</p>
            )}
            {(mode === 'daily' ? history : weekHistory).map(r => (
              <div key={r.id} className={`pm-history-item ${report?.id === r.id ? 'active' : ''}`}>
                <button className="pm-history-item-btn" onClick={() => loadHistoricReport(r)}>
                  <div className="pm-history-date">
                    {mode === 'weekly' ? formatWeekLabel(r.date) : r.date}
                    <span className={`pm-history-scope-badge ${r.report_type?.includes('summary') ? 'summary' : 'full'}`}>
                      {r.report_type?.includes('summary') ? 'Summary' : 'Full'}
                    </span>
                  </div>
                  <div className="pm-history-counts">
                    <span className="hc done">{r.done_count} done</span>
                    <span className="hc blocked">{r.blocked_count} blocked</span>
                  </div>
                </button>
                <div className="pm-history-actions">
                  {confirmDeleteId === r.id ? (
                    <>
                      <button
                        className="pm-history-confirm-btn confirm-yes"
                        title="Confirm delete"
                        onClick={async (e) => {
                          e.stopPropagation()
                          await deletePMReport(r.id)
                          if (mode === 'daily') setHistory(prev => prev.filter(h => h.id !== r.id))
                          else setWeekHistory(prev => prev.filter(h => h.id !== r.id))
                          if (report?.id === r.id) setReport(null)
                          setConfirmDeleteId(null)
                        }}
                      >
                        <Check size={12} />
                      </button>
                      <button
                        className="pm-history-confirm-btn confirm-no"
                        title="Cancel"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null) }}
                      >
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <button
                      className="pm-history-delete-btn"
                      title="Delete report"
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(r.id) }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Tab: Assignee Stats ──────────────────────────────────────────────────────

function AssigneeStatsTab({ sprintId }: { sprintId?: string }) {
  const [stats, setStats] = useState<AssigneeStat[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({})

  const fetchStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getAssigneeStats(sprintId)
      setStats((res as any).data || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
    } finally {
      setLoading(false)
    }
  }, [sprintId])

  useEffect(() => { fetchStats() }, [fetchStats])
  useEffect(() => { getAvatarMap().then(setAvatarMap) }, [])

  const maxTotal = Math.max(...stats.map(s => s.open + s.in_progress + s.done + s.blocked), 1)

  return (
    <div className="pm-tab-content pm-assignees-tab">
      <div className="pm-tab-header">
        <h3 className="pm-section-title"><TrendingUp size={18} /> Assignee Stats</h3>
        <button className="btn-secondary btn-sm" onClick={fetchStats} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      {error && <div className="pm-report-error"><AlertTriangle size={16} />{error}</div>}

      {loading && stats.length === 0 ? (() => {
        const sk = (w: number | string, h: number, r = 5) => <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
        const nameW = ['72%','58%','80%','65%','50%','75%','62%','70%','55%','68%']
        const barW  = [72, 45, 88, 55, 63, 78, 40, 95, 50, 67]
        return (
          <div className="pm-card-list glass-card">
            <div className="pm-list-summary">{sk(110, 13, 4)}</div>
            <div className="pm-col-header">
              <span className="pm-col-as-name">Assignee</span>
              <span className="pm-col-as-stat">Open</span>
              <span className="pm-col-as-stat">In Progress</span>
              <span className="pm-col-as-stat">Done</span>
              <span className="pm-col-as-stat">Blocked</span>
              <span className="pm-col-as-avg">Avg Time</span>
              <span className="pm-col-as-workload">Workload</span>
              <span className="pm-col-chevron" />
            </div>
            <div className="pm-rows-scroll">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="pm-row">
                  <div className="pm-row-main" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.6rem 0.75rem', cursor: 'default' }}>
                    <div className="pm-col-as-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {sk(28, 28, '50%')}{sk(nameW[i % nameW.length], 12, 4)}
                    </div>
                    <span className="pm-col-as-stat">{sk(22, 18, 10)}</span>
                    <span className="pm-col-as-stat">{sk(22, 18, 10)}</span>
                    <span className="pm-col-as-stat">{sk(22, 18, 10)}</span>
                    <span className="pm-col-as-stat">{sk(22, 18, 10)}</span>
                    <span className="pm-col-as-avg">{sk(50, 12, 4)}</span>
                    <span className="pm-col-as-workload">
                      <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.06)', width: '100%', overflow: 'hidden' }}>
                        <div className="skeleton" style={{ height: '100%', width: `${barW[i % barW.length]}%`, borderRadius: 4 }} />
                      </div>
                    </span>
                    <span className="pm-col-chevron" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()
      : stats.length === 0 ? (
        <div className="pm-empty-state"><Users size={40} /><p>No assignee data yet. Stats populate from webhook events or after a Backfill.</p></div>
      ) : (
        <div className="pm-card-list glass-card">
          <div className="pm-list-summary">
            <span>{stats.length} assignees</span>
          </div>

          {/* Column headers */}
          <div className="pm-col-header">
            <span className="pm-col-as-name">Assignee</span>
            <span className="pm-col-as-stat">Open</span>
            <span className="pm-col-as-stat">In Progress</span>
            <span className="pm-col-as-stat">Done</span>
            <span className="pm-col-as-stat">Blocked</span>
            <span className="pm-col-as-avg">Avg Time</span>
            <span className="pm-col-as-workload">Workload</span>
            <span className="pm-col-chevron" />
          </div>

          <div className="pm-rows-scroll">
          {stats.map(s => {
            const total = s.open + s.in_progress + s.done + s.blocked
            const pct = Math.round((total / maxTotal) * 100)
            const isExpanded = expandedRow === s.assignee

            return (
              <div key={s.assignee} className={`pm-row ${isExpanded ? 'pm-row-expanded' : ''}`}>
                <div className="pm-row-main" onClick={() => setExpandedRow(isExpanded ? null : s.assignee)}>
                  {/* Assignee */}
                  <div className="pm-col-as-name tt-assignee">
                    {avatarMap[s.assignee]
                      ? <img src={avatarMap[s.assignee]} alt={s.assignee} className="filter-avatar-img" />
                      : <span className="filter-avatar-placeholder">{s.assignee.charAt(0).toUpperCase()}</span>
                    }
                    <span className="tt-assignee-name">{s.assignee}</span>
                  </div>

                  {/* Stat badges */}
                  <span className="pm-col-as-stat">
                    <span className={`tt-badge ${s.open > 0 ? 'tt-badge-open' : 'tt-badge-zero'}`}>{s.open}</span>
                  </span>
                  <span className="pm-col-as-stat">
                    <span className={`tt-badge ${s.in_progress > 0 ? 'tt-badge-live' : 'tt-badge-zero'}`}>{s.in_progress}</span>
                  </span>
                  <span className="pm-col-as-stat">
                    <span className={`tt-badge ${s.done > 0 ? 'tt-badge-done' : 'tt-badge-zero'}`}>{s.done}</span>
                  </span>
                  <span className="pm-col-as-stat">
                    <span className={`tt-badge ${s.blocked > 0 ? 'tt-badge-blocked' : 'tt-badge-zero'}`}>{s.blocked}</span>
                  </span>

                  {/* Avg time */}
                  <span className="pm-col-as-avg tt-time-label">{formatHours(s.avg_hours_in_progress)}</span>

                  {/* Workload bar */}
                  <div className="pm-col-as-workload workload-cell">
                    <div className="tt-time-bar">
                      <div className="tt-time-bar-fill" style={{ width: `${pct}%`, background: '#6366f1' }} />
                    </div>
                    <span className="tt-threshold">{total}</span>
                  </div>

                  <ChevronDown size={13} className={`tt-chevron ${isExpanded ? 'open' : ''}`} />
                </div>

                {/* Expanded: open issues */}
                {isExpanded && s.issues && s.issues.length > 0 && (
                  <div className="tt-row-detail">
                    <div className="pm-issue-tags">
                      <span className="tt-detail-label">Open Issues</span>
                      <div className="pm-issue-tags-list">
                        {s.issues.map((issue, idx) => (
                          <span key={idx} className="pm-issue-tag">{issue}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Helpers for IssueTimeline (stint view) ──────────────────────────────────

function formatHoursDetailed(h: number | null): string {
  if (h === null || h === undefined) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  const days = Math.floor(h / 24)
  const hrs = Math.floor(h % 24)
  const mins = Math.round((h % 1) * 60)
  if (days > 0 && hrs > 0) return `${days}d ${hrs}h`
  if (days > 0) return `${days}d`
  if (mins > 0 && hrs === 0) return `${mins}m`
  return `${hrs}h`
}

function stintStatusClass(stint: IssueStint): string {
  if (!stint.exited_at) return 'stint-live'
  if (stint.moved_back) return 'stint-moved-back'
  const toL = stint.exited_to.toLowerCase()
  if (['dev', 'done', 'mobile done', 'stage', 'prod'].includes(toL)) return 'stint-completed'
  return 'stint-other'
}

function stintLabel(stint: IssueStint): string {
  if (!stint.exited_at) return '● Live'
  if (stint.moved_back) return `↩ → ${stint.exited_to}`
  return `→ ${stint.exited_to}`
}

// ─── Tab: Tracking (Sprint Column-Section View) ──────────────────────────────

function fmtHoursCompact(h: number): string {
  if (h <= 0) return '0h'
  const d = Math.floor(h / 24)
  const hrs = Math.floor(h % 24)
  if (d > 0) return `${d}d ${hrs}h`
  return `${hrs}h`
}

function getInitialsFromName(name: string): string {
  return (name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

// ── Hover card content builders ──────────────────────────────────────────────

function ticketHoverContent(issue: SprintBoardIssue, slaHours?: number) {
  const cycleLabel = issue.cycle_time_hours > 0 ? fmtHoursCompact(issue.cycle_time_hours) : null
  const devLabel   = issue.total_active_hours > 0 ? fmtHoursCompact(issue.total_active_hours) : null
  const stateLabel = issue.hours_in_state > 0 ? fmtHoursCompact(issue.hours_in_state) : null
  const overdueAccent = issue.overdue_level === 'deadline' ? 'danger'
    : (issue.overdue_level === 'sprint' || issue.is_delayed) ? 'warn' : undefined
  const slaUsedPct = slaHours && slaHours > 0 ? Math.min(100, (issue.total_active_hours / slaHours) * 100) : null
  const hasVerif = issue.verified_on_dev || issue.verified_on_stage || issue.verified_on_prod
  return (
    <div>
      <div className="hc-title" style={{ marginBottom: 2 }}>
        {issue.idReadable}
        {issue.is_hotfix && <HCBadge label="HF" variant="warn" />}
        {issue.issue_type && issue.issue_type.toLowerCase() !== 'task' && <HCBadge label={issue.issue_type} />}
      </div>
      <div className="hc-subtitle">{issue.summary}</div>
      <HCDivider />
      {stateLabel && <HCRow label="In state" value={stateLabel} accent={overdueAccent} />}
      {slaUsedPct !== null && (
        <div className="hc-row" style={{ gap: 6 }}>
          <span className="hc-label">SLA</span>
          <HCBar pct={slaUsedPct} color={slaUsedPct >= 100 ? '#f87171' : slaUsedPct > 70 ? '#fbbf24' : '#4ade80'} />
          <span className="hc-value" style={{ fontSize: '0.65rem', whiteSpace: 'nowrap' }}>
            {fmtHoursCompact(slaHours!)} limit
          </span>
        </div>
      )}
      {cycleLabel && <HCRow label="Cycle time" value={cycleLabel} />}
      {devLabel && <HCRow label="Dev active" value={devLabel} />}
      {issue.bounce_count > 0 && (
        <HCRow
          label="Bounces"
          value={`${issue.bounce_count}×${issue.stint_count > 1 ? ` (${issue.stint_count} stints)` : ''}`}
          accent="warn"
        />
      )}
      {issue.move_type === 'qa_rejected' && <HCRow label="Flag" value="QA Rejected" accent="danger" />}
      {issue.move_type === 'dev_stalled'  && <HCRow label="Flag" value="Dev Stalled"  accent="warn" />}
      {hasVerif && (
        <>
          <HCDivider />
          <div style={{ display: 'flex', gap: 4 }}>
            {issue.verified_on_dev   && <HCBadge label={`DEV✓ ${issue.verified_on_dev}`}   variant="dev" />}
            {issue.verified_on_stage && <HCBadge label={`STG✓ ${issue.verified_on_stage}`} variant="stg" />}
            {issue.verified_on_prod  && <HCBadge label={`PRD✓ ${issue.verified_on_prod}`}  variant="prd" />}
          </div>
        </>
      )}
      {issue.from_state && issue.current_state && issue.from_state !== issue.current_state && (
        <>
          <HCDivider />
          <div className="hc-label" style={{ fontSize: '0.65rem' }}>
            {issue.from_state} → {issue.current_state}
          </div>
        </>
      )}
      {issue.assignee && (
        <div className="hc-label" style={{ marginTop: 4 }}>👤 {issue.assignee}</div>
      )}
    </div>
  )
}

function assigneeHoverContent(name: string, issues: SprintBoardIssue[]) {
  const active  = issues.filter(i => i.current_state?.toLowerCase().includes('progress')).length
  const blocked = issues.filter(i => i.current_state?.toLowerCase().includes('block')).length
  const done    = issues.filter(i => {
    const s = i.current_state?.toLowerCase() || ''
    return s.includes('done') || s.includes('verified') || s.includes('deployed') || s.includes('closed')
  }).length
  const total = issues.length
  const totalWork = issues.reduce((s, i) => s + (i.total_active_hours || 0), 0)
  const overdue   = issues.filter(i => i.is_delayed && !i.current_state?.toLowerCase().includes('block')).length
  return (
    <div>
      <div className="hc-title">{name}</div>
      <div className="hc-subtitle">{total} ticket{total !== 1 ? 's' : ''} this sprint</div>
      <HCDivider />
      <HCRow label="Active"  value={active}  accent={active > 4 ? 'warn' : undefined} />
      <HCRow label="Blocked" value={blocked} accent={blocked > 0 ? 'danger' : undefined} />
      <HCRow label="Done"    value={done}    accent={done > 0 ? 'ok' : undefined} />
      {overdue > 0 && <HCRow label="Overdue" value={overdue} accent="danger" />}
      {totalWork > 0 && <HCRow label="Dev hours" value={fmtHoursCompact(totalWork)} />}
      {total > 0 && (
        <>
          <HCDivider />
          <div className="hc-stack">
            {active  > 0 && <div className="hc-stack-seg hc-stack-seg--active"  style={{ flex: active }}  />}
            {blocked > 0 && <div className="hc-stack-seg hc-stack-seg--blocked" style={{ flex: blocked }} />}
            {done    > 0 && <div className="hc-stack-seg hc-stack-seg--done"    style={{ flex: done }}    />}
            {Math.max(0, total - active - blocked - done) > 0 && (
              <div className="hc-stack-seg hc-stack-seg--other" style={{ flex: total - active - blocked - done }} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

function columnHeaderHoverContent(col: SprintBoardColumn) {
  const overdue  = col.issues.filter(i => i.overdue_level === 'deadline').length
  const atrisk   = col.issues.filter(i => i.overdue_level === 'sprint' || (i.is_delayed && i.overdue_level !== 'deadline')).length
  const blocked  = col.issues.filter(i => i.current_state?.toLowerCase().includes('block')).length
  const ontrack  = col.issues.length - overdue - atrisk
  const avgHrs   = col.issues.length > 0
    ? col.issues.reduce((s, i) => s + (i.hours_in_state || 0), 0) / col.issues.length
    : 0
  return (
    <div>
      <div className="hc-title">{col.name}</div>
      <div className="hc-subtitle">{col.issues.length} issue{col.issues.length !== 1 ? 's' : ''}</div>
      {col.issues.length > 0 && (
        <>
          <HCDivider />
          {overdue > 0  && <HCRow label="Overdue"  value={overdue}  accent="danger" />}
          {atrisk  > 0  && <HCRow label="At risk"  value={atrisk}   accent="warn" />}
          {blocked > 0  && <HCRow label="Blocked"  value={blocked}  accent="danger" />}
          {ontrack > 0  && <HCRow label="On track" value={ontrack}  accent="ok" />}
          {avgHrs  > 0  && <HCRow label="Avg time" value={fmtHoursCompact(avgHrs)} />}
        </>
      )}
    </div>
  )
}

function heatmapCellHoverContent(person: string, col: SprintBoardColumn, issues: SprintBoardIssue[]) {
  return (
    <div>
      <div className="hc-title">{person} × {col.name}</div>
      <div className="hc-subtitle">{issues.length} issue{issues.length !== 1 ? 's' : ''}</div>
      <div className="hc-issue-list">
        {issues.slice(0, 6).map(i => {
          const dotClass = i.overdue_level === 'deadline' ? 'hc-issue-dot--overdue'
            : (i.overdue_level === 'sprint' || i.is_delayed) ? 'hc-issue-dot--atrisk'
            : i.current_state?.toLowerCase().includes('block') ? 'hc-issue-dot--blocked'
            : 'hc-issue-dot--ok'
          return (
            <div key={i.idReadable} className="hc-issue-item">
              <div className={`hc-issue-dot ${dotClass}`} />
              <span className="hc-issue-id">{i.idReadable}</span>
              <span className="hc-issue-summary">{i.summary}</span>
              <span className="hc-label" style={{ whiteSpace: 'nowrap' }}>{fmtHoursCompact(i.hours_in_state)}</span>
            </div>
          )
        })}
        {issues.length > 6 && (
          <div className="hc-label" style={{ marginTop: 2 }}>+{issues.length - 6} more</div>
        )}
      </div>
    </div>
  )
}

function delayBarHoverContent(issue: SprintBoardIssue, workDays: number, bounceDays: number, reviewDays: number, slaDays: number) {
  const totalDays = workDays + bounceDays + reviewDays
  const overSla = slaDays > 0 && totalDays > slaDays
  return (
    <div>
      <div className="hc-title">{issue.idReadable} — time breakdown</div>
      <div className="hc-subtitle">{issue.summary}</div>
      <HCDivider />
      {workDays > 0 && (
        <div>
          <HCRow label="Working"     value={`${workDays.toFixed(1)}d`} />
          <HCBar pct={(workDays / Math.max(totalDays, slaDays || totalDays)) * 100} color="#6366f1" />
        </div>
      )}
      {bounceDays > 0 && (
        <div style={{ marginTop: 4 }}>
          <HCRow label="Bounce rework" value={`${bounceDays.toFixed(1)}d (${issue.bounce_count}×)`} accent="warn" />
          <HCBar pct={(bounceDays / Math.max(totalDays, slaDays || totalDays)) * 100} color="#f59e0b" />
        </div>
      )}
      {reviewDays > 0 && (
        <div style={{ marginTop: 4 }}>
          <HCRow label="Review/Idle" value={`${reviewDays.toFixed(1)}d`} />
          <HCBar pct={(reviewDays / Math.max(totalDays, slaDays || totalDays)) * 100} color="#818cf8" />
        </div>
      )}
      {slaDays > 0 && (
        <>
          <HCDivider />
          <HCRow
            label={`SLA (${issue.priority})`}
            value={`${slaDays.toFixed(1)}d`}
          />
          <HCRow
            label="Status"
            value={overSla ? `+${(totalDays - slaDays).toFixed(1)}d over` : `${(slaDays - totalDays).toFixed(1)}d left`}
            accent={overSla ? 'danger' : 'ok'}
          />
        </>
      )}
    </div>
  )
}

function qaStageHoverContent(stage: 'DEV' | 'STAGE' | 'PROD', verifier: string, issue: SprintBoardIssue) {
  const stageLabel = stage === 'DEV' ? 'Development' : stage === 'STAGE' ? 'Staging' : 'Production'
  return (
    <div>
      <div className="hc-title">{stageLabel} Verification</div>
      <HCDivider />
      {verifier ? (
        <>
          <HCRow label="Verified by" value={verifier} accent="ok" />
          <div className="hc-label" style={{ marginTop: 4 }}>✓ Passed {stageLabel}</div>
        </>
      ) : (
        <div className="hc-label" style={{ marginTop: 2 }}>
          ○ Awaiting {stageLabel} verification
          {issue.total_active_hours > 0 && (
            <div style={{ marginTop: 4 }}>
              {fmtHoursCompact(issue.total_active_hours)} active dev time
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ttPriorityClass(p: string): string {
  const s = (p || '').toLowerCase()
  if (s === 'p0' || s.includes('critical') || s.includes('show-stopper')) return 'tt-pri tt-pri-p0'
  if (s === 'p1' || s.includes('major')) return 'tt-pri tt-pri-p1'
  if (s === 'p2' || s.includes('normal') || s.includes('medium')) return 'tt-pri tt-pri-p2'
  return 'tt-pri tt-pri-p3'
}

// ── IssueTransitionInline: fetches + renders full transition history for one issue ──
function IssueTransitionInline({
  issueId,
  onViewDetails,
  columnHierarchy,
}: {
  issueId: string
  onViewDetails: (logs: IssueStateLogEntry[]) => void
  columnHierarchy?: { state: string; rank: number }[]
}) {
  const [logs, setLogs] = useState<IssueStateLogEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getIssueTransitions(issueId)
      .then(res => { setLogs((res as any).data || []) })
      .catch(() => setLogs([]))
      .finally(() => setLoading(false))
  }, [issueId])

  const isBounce = (entry: IssueStateLogEntry) => {
    if (!columnHierarchy) return false
    const fromRank = columnHierarchy.find(c => c.state.toLowerCase() === entry.from_state.toLowerCase())?.rank ?? -1
    const toRank = columnHierarchy.find(c => c.state.toLowerCase() === entry.to_state.toLowerCase())?.rank ?? -1
    return toRank < fromRank && fromRank !== -1 && toRank !== -1
  }

  const sk = (w: number | string, h: number, r = 4) => (
    <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
  )

  return (
    <div className="pm-tracking-expand-area">
      {loading ? (
        <div className="pm-tracking-timeline-list">
          {[1, 2, 3].map(i => (
            <div key={i} className="pm-tracking-timeline-entry">
              {sk(80, 11)}{sk(60, 11)}{sk(60, 11)}{sk('30%', 11)}{sk(50, 11)}
            </div>
          ))}
        </div>
      ) : logs.length === 0 ? (
        <p className="pm-tracking-expand-empty">No transition history found in state log.</p>
      ) : (
        <div className="pm-tracking-timeline-list">
          {logs.map((entry, i) => {
            const bounce = isBounce(entry)
            return (
              <div key={i} className={`pm-tracking-timeline-entry${bounce ? ' pm-tracking-timeline-entry--bounce' : ''}`}>
                <span className="pm-tracking-tl-time">
                  {new Date(entry.transitioned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="pm-tracking-tl-states">
                  <span className="pm-tracking-tl-from">{entry.from_state || '—'}</span>
                  <span className="pm-tracking-tl-arrow">→</span>
                  <span className="pm-tracking-tl-to">{entry.to_state}</span>
                </span>
                {entry.duration_in_prev_state_hours != null && (
                  <span className="pm-tracking-tl-dur">{fmtHoursCompact(entry.duration_in_prev_state_hours)}</span>
                )}
                {entry.moved_by && (
                  <span className="pm-tracking-tl-mover">{entry.moved_by}</span>
                )}
                {bounce && <span className="pm-tracking-tl-bounce-label">↩ Bounce</span>}
              </div>
            )
          })}
        </div>
      )}
      {!loading && logs.length > 0 && (
        <button className="pm-tracking-view-details-btn" onClick={() => onViewDetails(logs)}>
          View full details →
        </button>
      )}
    </div>
  )
}

// ── IssueDetailModal: full transition history modal ──────────────────────────
function IssueDetailModal({
  issue,
  logs,
  onClose,
  columnHierarchy,
  ytBaseUrl,
}: {
  issue: SprintBoardIssue
  logs: IssueStateLogEntry[]
  onClose: () => void
  columnHierarchy?: { state: string; rank: number }[]
  ytBaseUrl?: string
}) {
  const isBounce = (entry: IssueStateLogEntry) => {
    if (!columnHierarchy) return false
    const fromRank = columnHierarchy.find(c => c.state.toLowerCase() === entry.from_state.toLowerCase())?.rank ?? -1
    const toRank = columnHierarchy.find(c => c.state.toLowerCase() === entry.to_state.toLowerCase())?.rank ?? -1
    return toRank < fromRank && fromRank !== -1 && toRank !== -1
  }

  const bounceCount = logs.filter(isBounce).length
  const firstEntry = logs[0]
  const lastEntry = logs[logs.length - 1]

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return createPortal(
    <div className="pm-tracking-detail-overlay" onClick={onClose}>
      <div className="pm-tracking-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="pm-tracking-detail-header">
          <div className="pm-tracking-detail-title">
            <span
              className="pm-tracking-detail-id pm-tracking-issue-id--link"
              onClick={() => {
                const url = ytBaseUrl ? `${ytBaseUrl}/issue/${issue.idReadable}` : null
                if (url) window.open(url, '_blank', 'noopener,noreferrer')
              }}
              title={`Open ${issue.idReadable} in YouTrack`}
            >{issue.idReadable}</span>
            <span className="pm-tracking-detail-summary">{issue.summary}</span>
          </div>
          <button className="pm-tracking-detail-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="pm-tracking-detail-stats">
          <div className="pm-tracking-detail-stat">
            <span className="pm-tracking-detail-stat-label">Active time</span>
            <span className="pm-tracking-detail-stat-value">{fmtHoursCompact(issue.total_active_hours)}</span>
          </div>
          <div className="pm-tracking-detail-stat">
            <span className="pm-tracking-detail-stat-label">Bounces</span>
            <span className="pm-tracking-detail-stat-value pm-tracking-detail-stat--bounce">{bounceCount}</span>
          </div>
          <div className="pm-tracking-detail-stat">
            <span className="pm-tracking-detail-stat-label">First seen</span>
            <span className="pm-tracking-detail-stat-value">
              {firstEntry ? new Date(firstEntry.transitioned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
            </span>
          </div>
          <div className="pm-tracking-detail-stat">
            <span className="pm-tracking-detail-stat-label">Last moved</span>
            <span className="pm-tracking-detail-stat-value">
              {lastEntry ? new Date(lastEntry.transitioned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
            </span>
          </div>
          <div className="pm-tracking-detail-stat">
            <span className="pm-tracking-detail-stat-label">Current state</span>
            <span className="pm-tracking-detail-stat-value">{issue.current_state}</span>
          </div>
          <div className="pm-tracking-detail-stat">
            <span className="pm-tracking-detail-stat-label">Assignee</span>
            <span className="pm-tracking-detail-stat-value">{issue.assignee || '—'}</span>
          </div>
        </div>

        <div className="pm-tracking-detail-timeline">
          <div className="pm-tracking-detail-tl-header">
            <span>Time</span>
            <span>From → To</span>
            <span>Duration in prev state</span>
            <span>Moved by</span>
            <span></span>
          </div>
          {logs.map((entry, i) => {
            const bounce = isBounce(entry)
            return (
              <div key={i} className={`pm-tracking-detail-tl-row${bounce ? ' pm-tracking-detail-tl-row--bounce' : ''}`}>
                <span className="pm-tracking-detail-tl-ts">
                  {new Date(entry.transitioned_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="pm-tracking-detail-tl-states">
                  <span className="pm-tracking-tl-from">{entry.from_state || '—'}</span>
                  <span className="pm-tracking-tl-arrow">→</span>
                  <span className="pm-tracking-tl-to">{entry.to_state}</span>
                </span>
                <span className="pm-tracking-detail-tl-dur">
                  {entry.duration_in_prev_state_hours != null ? fmtHoursCompact(entry.duration_in_prev_state_hours) : '—'}
                </span>
                <span className="pm-tracking-detail-tl-mover">{entry.moved_by || '—'}</span>
                <span>{bounce && <span className="pm-tracking-tl-bounce-label">↩ Bounce</span>}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}

type SortField = 'default' | 'priority' | 'time_in_state' | 'cycle_time' | 'bounces' | 'assignee'

function getColumnType(col: SprintBoardColumn): 'inprogress' | 'blocked' | 'compact' | 'todo' {
  const n = col.name?.toLowerCase() || ''
  if (n.includes('progress') || n === 'inprogress') return 'inprogress'
  if (n.includes('block')) return 'blocked'
  if (n === 'to do' || n === 'todo' || n.includes('backlog') || n.includes('uvr') || n === 'open' || n === 'new') return 'todo'
  return 'compact'
}

function TrackingTab({ blockerIssueIds, sprintId, sprintStartMs, sprintFinishMs }: { blockerIssueIds?: Set<string>; sprintId?: string; sprintStartMs?: number; sprintFinishMs?: number }) {
  const [boardColumns, setBoardColumns] = useState<SprintBoardColumn[]>([])
  const [summary, setSummary] = useState<import('../services/api').SprintSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [filterAssignee, setFilterAssignee] = useState('')
  const [assigneeOpen, setAssigneeOpen] = useState(false)
  const [sortField, setSortField] = useState<SortField>('default')
  const [sortOpen, setSortOpen] = useState(false)
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set())
  const [allCollapsed, setAllCollapsed] = useState(false)
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({})
  const [viewMode, setViewMode] = usePersistedState(PERSIST.TRACKING_VIEW, 'column' as 'column' | 'assignee' | 'swimlane' | 'sidebar' | 'heatmap' | 'delay-bars' | 'alert-first' | 'split-pane' | 'focus' | 'qa-pipeline' | 'dev-time' | 'feature-groups', {
    validate: ['column', 'assignee', 'swimlane', 'sidebar', 'heatmap', 'delay-bars', 'alert-first', 'split-pane', 'focus', 'qa-pipeline', 'dev-time', 'feature-groups'],
  })
  const [devTimeVariant, setDevTimeVariant] = useState<DevTimeVariant>('a')
  const [devTimeTimelines, setDevTimeTimelines] = useState<IssueTimeline[]>([])
  const [featureGroups, setFeatureGroups] = useState<import('../services/api').FeatureGroup[]>([])
  const [featureGroupsLoading, setFeatureGroupsLoading] = useState(false)
  const featureGroupsSprintRef = useRef<string | undefined>(undefined)
  const [qaFilterMode, setQaFilterMode] = useState<'all' | 'needs-qa'>('all')
  const [viewModeOpen, setViewModeOpen] = useState(false)
  const [sidebarPerson, setSidebarPerson] = useState<string>('')
  const [showAllFocus, setShowAllFocus] = useState(false)
  const [expandedIssue, setExpandedIssue] = useState<string | null>(null)
  const [detailIssue, setDetailIssue] = useState<{ issue: SprintBoardIssue; logs: IssueStateLogEntry[] } | null>(null)
  const [ytDetailIssue, setYtDetailIssue] = useState<import('../services/api').YouTrackIssue | null>(null)
  const [ytDetailLoading, setYtDetailLoading] = useState(false)
  const [ytBaseUrl, setYtBaseUrl] = useState('')
  const [kpiDrawer, setKpiDrawer] = useState<'blocked' | 'bounced' | 'sprint' | 'completion' | 'in-progress' | null>(null)
  const assigneeRef = useRef<HTMLDivElement>(null)
  const sortRef = useRef<HTMLDivElement>(null)
  const viewModeRef = useRef<HTMLDivElement>(null)

  // ── Data fetching ─────────────────────────────────────────────────────────
  const fetchBoardStatus = useCallback(async () => {
    if (!sprintId) { setBoardColumns([]); setSummary(null); return }
    setLoading(true)
    setError(null)
    try {
      const res = await api.getSprintBoardStatus({ sprint_id: sprintId, sprint_finish_ms: sprintFinishMs })
      const data = (res as any).data as import('../services/api').SprintBoardStatusResponse
      setBoardColumns(data?.columns || [])
      setSummary(data?.summary || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sprint board status')
    } finally {
      setLoading(false)
    }
  }, [sprintId, sprintFinishMs])

  useEffect(() => { fetchBoardStatus() }, [fetchBoardStatus])
  useEffect(() => { getAvatarMap().then(setAvatarMap) }, [])

  // Reset feature groups cache when sprint changes so next switch re-fetches
  useEffect(() => {
    featureGroupsSprintRef.current = undefined
    setFeatureGroups([])
  }, [sprintId])

  useEffect(() => {
    if (viewMode !== 'dev-time') return
    setDevTimeTimelines([])
    getIssueTimelines(sprintStartMs, sprintFinishMs).then(res => setDevTimeTimelines(res.data ?? [])).catch(() => {})
  }, [viewMode, sprintId, sprintStartMs, sprintFinishMs])

  useEffect(() => {
    if (viewMode !== 'feature-groups') return
    if (!sprintId) return
    // skip if we already have data for this sprint
    if (featureGroupsSprintRef.current === sprintId) return
    featureGroupsSprintRef.current = sprintId
    setFeatureGroupsLoading(true)
    api.getFeatureGroups(sprintId)
      .then(res => setFeatureGroups((res as any).data ?? []))
      .catch(() => {})
      .finally(() => setFeatureGroupsLoading(false))
  }, [viewMode, sprintId])

  useEffect(() => {
    api.getYouTrackIntegration().then(res => {
      const d = (res as any)
      setYtBaseUrl((d?.base_url || d?.data?.base_url || '').replace(/\/$/, ''))
    }).catch(() => {})
  }, [])

  // ── Close dropdowns on outside click ─────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node))
        setAssigneeOpen(false)
      if (sortRef.current && !sortRef.current.contains(e.target as Node))
        setSortOpen(false)
      if (viewModeRef.current && !viewModeRef.current.contains(e.target as Node))
        setViewModeOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Action handlers ───────────────────────────────────────────────────────
  // Sprint deadline countdown
  const sprintDeadlineLabel = useMemo(() => {
    if (!sprintFinishMs) return null
    const diff = sprintFinishMs - Date.now()
    if (diff <= 0) return 'OVERDUE'
    const d = Math.floor(diff / 86400000)
    const h = Math.floor((diff % 86400000) / 3600000)
    return d > 0 ? `${d}d ${h}h left` : `${h}h left`
  }, [sprintFinishMs])

  const { config: wfConfig } = useWorkflowConfig()
  const columnHierarchy = useMemo(
    () => wfConfig?.column_hierarchy?.map((c: any) => ({ state: c.state, rank: c.rank })) ?? [],
    [wfConfig]
  )

  // ── Priority color map from workflow config ───────────────────────────────
  const priorityColorMap = useMemo(() => {
    const map: Record<string, { bg: string; text: string }> = {}
    if (!wfConfig?.priority_tags) return map
    wfConfig.priority_tags.forEach((pt: import('../services/api').PriorityTag) => {
      const entry = { bg: pt.color + '28', text: pt.color }
      map[pt.label.toLowerCase()] = entry
      pt.yt_mappings?.forEach((m: string) => { map[m.toLowerCase()] = entry })
    })
    return map
  }, [wfConfig])

  // ── Sort function ──────────────────────────────────────────────────────────
  const PRIORITY_ORDER: Record<string, number> = useMemo(() => {
    const order: Record<string, number> = {}
    if (wfConfig?.priority_tags) {
      wfConfig.priority_tags.forEach((pt: import('../services/api').PriorityTag, i: number) => {
        order[pt.label.toLowerCase()] = i
        pt.yt_mappings?.forEach((m: string) => { order[m.toLowerCase()] = i })
      })
    }
    return order
  }, [wfConfig])

  const sortIssues = useCallback((issues: SprintBoardIssue[]) => {
    if (sortField === 'default') return issues
    return [...issues].sort((a, b) => {
      switch (sortField) {
        case 'priority': {
          const pa = PRIORITY_ORDER[a.priority?.toLowerCase()] ?? 999
          const pb = PRIORITY_ORDER[b.priority?.toLowerCase()] ?? 999
          return pa - pb
        }
        case 'time_in_state': return b.hours_in_state - a.hours_in_state
        case 'cycle_time': return b.cycle_time_hours - a.cycle_time_hours
        case 'bounces': return b.bounce_count - a.bounce_count
        case 'assignee': return (a.assignee || '').localeCompare(b.assignee || '')
        default: return 0
      }
    })
  }, [sortField, PRIORITY_ORDER])

  // ── Open YT issue detail panel (title click) ──────────────────────────────
  const openYtIssue = useCallback(async (idReadable: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (ytDetailLoading) return
    setYtDetailLoading(true)
    try {
      const res = await api.getYouTrackIssue(idReadable)
      const issue = (res as any).data as import('../services/api').YouTrackIssue
      if (issue) setYtDetailIssue(issue)
    } catch {}
    finally { setYtDetailLoading(false) }
  }, [ytDetailLoading])

  // ── Open ticket ID in YouTrack (ID click) ────────────────────────────────
  const openInYouTrack = useCallback((idReadable: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!idReadable) return
    const url = ytBaseUrl ? `${ytBaseUrl}/issue/${idReadable}` : null
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }, [ytBaseUrl])

  // ── Derived ───────────────────────────────────────────────────────────────
  const allAssignees = useMemo(() => {
    const s = new Set<string>()
    boardColumns.forEach(col => col.issues.forEach(i => { if (i.assignee) s.add(i.assignee) }))
    return Array.from(s).sort()
  }, [boardColumns])

  const filteredColumns = useMemo(() => {
    const cols = filterAssignee
      ? boardColumns
          .map(col => ({ ...col, issues: col.issues.filter(i => i.assignee === filterAssignee) }))
          .filter(col => col.issues.length > 0)
      : boardColumns
    return cols.map(col => ({ ...col, issues: sortIssues(col.issues) }))
  }, [boardColumns, filterAssignee, sortIssues])

  const byAssignee = useMemo(() => {
    const map = new Map<string, { assignee: string; login: string; avatarUrl: string; issues: SprintBoardIssue[] }>()
    const src = filterAssignee
      ? filteredColumns.flatMap(c => c.issues)
      : boardColumns.flatMap(c => c.issues)
    src.forEach(issue => {
      const key = issue.assignee || 'Unassigned'
      if (!map.has(key)) map.set(key, { assignee: key, login: issue.assigneeLogin, avatarUrl: issue.avatarUrl, issues: [] })
      map.get(key)!.issues.push(issue)
    })
    return Array.from(map.values())
      .sort((a, b) => a.assignee.localeCompare(b.assignee))
      .map(g => ({ ...g, issues: sortIssues(g.issues) }))
  }, [boardColumns, filteredColumns, filterAssignee, sortIssues])

  const toggleColCollapse = useCallback((name: string) => {
    setCollapsedCols(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const toggleAllCollapse = useCallback(() => {
    if (allCollapsed) {
      setCollapsedCols(new Set())
      setAllCollapsed(false)
    } else {
      const allNames = new Set([
        ...filteredColumns.map(c => c.name),
        ...byAssignee.map(g => g.assignee),
      ])
      setCollapsedCols(allNames)
      setAllCollapsed(true)
    }
  }, [allCollapsed, filteredColumns, byAssignee])

  const sk = (w: number | string, h: number, r = 5) => (
    <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
  )

  const trackingSkeleton = (
    <div className="pm-tracking-board" style={{ pointerEvents: 'none' }}>
      {[8, 5, 12, 6].map((count, ci) => (
        <div key={ci} className="pm-tracking-column-section">
          <div className="pm-tracking-col-header">
            {sk(['90px','70px','110px','80px'][ci], 14, 6)}
            {sk(22, 18, 10)}
          </div>
          <div className="pm-tracking-issue-row pm-tracking-col-header-row">
            {sk(52, 11, 3)}{sk(36, 11, 3)}{sk('55%', 11, 3)}{sk(32, 11, 3)}{sk(80, 11, 3)}
          </div>
          {Array.from({ length: count }).map((_, i) => {
            const titleW = ['65%','80%','72%','58%','75%','68%','82%','61%','70%','77%']
            return (
              <div key={i} className="pm-tracking-issue-row">
                {sk(52, 13, 4)}
                {sk(36, 18, 12)}
                {sk(titleW[i % titleW.length], 13, 4)}
                {sk(38, 13, 4)}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {sk(22, 22, 11)}
                  {sk(54, 12, 4)}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )

  // ── QA by person map ─────────────────────────────────────────────────────
  const qaByPerson = useMemo(() => {
    const map = new Map<string, { devVerified: SprintBoardIssue[]; stageVerified: SprintBoardIssue[]; prodVerified: SprintBoardIssue[] }>()
    const ensure = (name: string) => {
      if (!map.has(name)) map.set(name, { devVerified: [], stageVerified: [], prodVerified: [] })
      return map.get(name)!
    }
    boardColumns.flatMap(c => c.issues).forEach(issue => {
      if (issue.verified_on_dev) ensure(issue.verified_on_dev).devVerified.push(issue)
      if (issue.verified_on_stage) ensure(issue.verified_on_stage).stageVerified.push(issue)
      if (issue.verified_on_prod) ensure(issue.verified_on_prod).prodVerified.push(issue)
    })
    return map
  }, [boardColumns])

  // ── SLA map from workflow config ─────────────────────────────────────────
  const slaMap = useMemo(() => {
    const m: Record<string, number> = {}
    wfConfig?.priority_tags?.forEach((pt: any) => {
      if (pt.sla_hours) {
        m[pt.label.toLowerCase()] = pt.sla_hours
        pt.yt_mappings?.forEach((yt: string) => { m[yt.toLowerCase()] = pt.sla_hours })
      }
    })
    return m
  }, [wfConfig])

  // ── All issues sorted by delay severity (delay-bars + focus) ─────────────
  const allIssuesByDelay = useMemo(() => {
    const score = (i: SprintBoardIssue) =>
      i.overdue_level === 'deadline' ? 4 : i.overdue_level === 'sprint' ? 3 : i.is_delayed ? 2 : i.bounce_count > 0 ? 1 : 0
    return filteredColumns.flatMap(c => c.issues).sort((a, b) => {
      const d = score(b) - score(a)
      return d !== 0 ? d : (b.bounce_count || 0) - (a.bounce_count || 0)
    })
  }, [filteredColumns])

  // ── Per-person list (swimlane, sidebar, split-pane) ──────────────────────
  const byPersonList = useMemo(() => {
    const map = new Map<string, { name: string; login: string; avatarUrl: string; issues: SprintBoardIssue[] }>()
    filteredColumns.flatMap(c => c.issues).forEach(issue => {
      const key = issue.assignee || 'Unassigned'
      if (!map.has(key)) map.set(key, { name: key, login: issue.assigneeLogin || '', avatarUrl: issue.avatarUrl || '', issues: [] })
      map.get(key)!.issues.push(issue)
    })
    return Array.from(map.values()).sort((a, b) => {
      const aHasCrit = a.issues.some(i => i.overdue_level === 'deadline')
      const bHasCrit = b.issues.some(i => i.overdue_level === 'deadline')
      if (aHasCrit !== bHasCrit) return bHasCrit ? 1 : -1
      return b.issues.length - a.issues.length
    })
  }, [filteredColumns])

  // ── Blocked / in-progress issues (alert-first) ───────────────────────────
  const allBlockedIssues = useMemo(() =>
    filteredColumns.filter(c => c.name?.toLowerCase().includes('block')).flatMap(c => c.issues),
  [filteredColumns])

  const allBouncedIssues = useMemo(() =>
    filteredColumns.flatMap(c => c.issues).filter(i => i.bounce_count > 0)
      .sort((a, b) => b.bounce_count - a.bounce_count),
  [filteredColumns])

  const allInProgressIssues = useMemo(() =>
    filteredColumns.filter(c => {
      const n = c.name?.toLowerCase() || ''
      return n.includes('progress') || n === 'inprogress'
    }).flatMap(c => c.issues),
  [filteredColumns])

  // ── Feature delivery alert (alert-first view) ────────────────────────────
  const featureAlertData = useMemo(() => {
    if (!sprintFinishMs) return null
    const daysLeft = Math.ceil((sprintFinishMs - Date.now()) / 86400000)
    if (daysLeft > 4 || daysLeft < 0) return null

    const allIssues = filteredColumns.flatMap(c => c.issues)
    const hasTypes  = allIssues.some(i => !!i.issue_type)
    if (!hasTypes) return null

    const isTypeFeat = (t: string) => {
      const s = (t || '').toLowerCase()
      return s.includes('feature') || s.includes('story') || s.includes('epic')
    }
    const isDone = (state: string) => {
      const s = (state || '').toLowerCase()
      return s.includes('done') || s.includes('clos') || s.includes('deploy') ||
             s.includes('verif') || s.includes('prod') || s.includes('stage')
    }
    const isActive = (state: string) => (state || '').toLowerCase().includes('progress')

    const notStarted = allIssues.filter(i =>
      isTypeFeat(i.issue_type) && !isDone(i.current_state) && !isActive(i.current_state)
    )
    if (notStarted.length === 0) return null
    return { daysLeft, notStarted }
  }, [filteredColumns, sprintFinishMs])

  // ── QA Pipeline: all issues sorted for the QA view ──────────────────────
  const qaAllIssues = useMemo(() => {
    const qaScore = (i: SprintBoardIssue) => {
      let s = 0
      if (i.verified_on_dev) s++
      if (i.verified_on_stage) s++
      if (i.verified_on_prod) s++
      return s
    }
    const issues = filteredColumns.flatMap(c => c.issues)
    return [...issues].sort((a, b) => {
      const sa = qaScore(a), sb = qaScore(b)
      const aPartial = sa > 0 && sa < 3
      const bPartial = sb > 0 && sb < 3
      const aWorked = (a.total_active_hours || 0) > 0 || (a.bounce_count || 0) > 0
      const bWorked = (b.total_active_hours || 0) > 0 || (b.bounce_count || 0) > 0
      // Partial first → none-but-worked → fully-verified last
      if (aPartial && !bPartial) return -1
      if (!aPartial && bPartial) return 1
      if (sa === 0 && sb === 0) {
        if (aWorked && !bWorked) return -1
        if (!aWorked && bWorked) return 1
      }
      if (sa === 3 && sb !== 3) return 1
      if (sb === 3 && sa !== 3) return -1
      return 0
    })
  }, [filteredColumns])

  // ── Issue row renderer (shared by column + assignee views) ────────────────
  const renderIssueRow = (issue: SprintBoardIssue, showState = false) => {
    const avatarUrl = issue.avatarUrl || avatarMap[issue.assignee] || avatarMap[issue.assigneeLogin]
    const isExpanded = expandedIssue === issue.idReadable
    const overdueClass = issue.overdue_level === 'deadline' ? ' pm-tracking-issue-row--overdue-deadline'
      : issue.overdue_level === 'sprint' ? ' pm-tracking-issue-row--overdue-sprint'
      : issue.is_delayed ? ' pm-tracking-issue-row--delayed' : ''
    const bounceClass = issue.bounce_count > 0 ? ' pm-tracking-issue-row--bounced' : ''
    const hotfixClass = issue.is_hotfix ? ' pm-tracking-issue-row--hotfix' : ''
    const priColors = priorityColorMap[issue.priority?.toLowerCase()] || null
    // Time display: show dev time (total active) + cycle time separately
    const devTimeLabel = issue.total_active_hours > 0 ? fmtHoursCompact(issue.total_active_hours) : null
    const cycleLabel = issue.cycle_time_hours > 0 ? fmtHoursCompact(issue.cycle_time_hours) : null
    return (
      <HoverCard key={issue.id} content={ticketHoverContent(issue)}>
      <React.Fragment>
        <div
          className={`pm-tracking-issue-row pm-tracking-issue-row--clickable${overdueClass}${bounceClass}${hotfixClass}${blockerIssueIds?.has(issue.idReadable) ? ' pm-tracking-issue-row--blocked' : ''}${isExpanded ? ' pm-tracking-issue-row--expanded' : ''}`}
          onClick={() => setExpandedIssue(isExpanded ? null : issue.idReadable)}
        >
          {/* Ticket ID — click opens in YouTrack */}
          <span
            className="pm-tracking-issue-id pm-tracking-issue-id--link"
            title={`Open ${issue.idReadable} in YouTrack`}
            onClick={(e) => openInYouTrack(issue.idReadable || issue.id, e)}
          >
            {issue.idReadable || issue.id}
          </span>
          {/* Priority — dynamic YT colors */}
          <span
            className="tt-pri"
            style={priColors ? { background: priColors.bg, color: priColors.text } : undefined}
          >
            {issue.priority}
          </span>
          <span
            className="pm-tracking-issue-summary pm-tracking-issue-summary--clickable"
            title={`Open ${issue.idReadable} details`}
            onClick={(e) => openYtIssue(issue.idReadable || issue.id, e)}
          >
            {issue.summary}
            {issue.bounce_count > 0 && (
              <span className="pm-tracking-bounce-badge" title={`${issue.bounce_count} backward move${issue.bounce_count > 1 ? 's' : ''}${issue.stint_count > 1 ? ` · picked up ${issue.stint_count}×` : ''}`}>
                ↩{issue.bounce_count}{issue.stint_count > 1 && <span className="pm-tracking-stint-count">×{issue.stint_count}</span>}
              </span>
            )}
            {issue.is_hotfix && (
              <span className="pm-tracking-hotfix-chip" title="Hotfix — deployed directly">
                <Zap size={9} /> HF
              </span>
            )}
            {issue.issue_type && (
              <span className={`pm-tracking-type-badge pm-tracking-type-badge--${issue.issue_type.toLowerCase().replace(/\s+/g, '-')}`}>
                {issue.issue_type}
              </span>
            )}
            {issue.move_type === 'qa_rejected' && <span className="pm-tracking-move-badge pm-tracking-move-badge--qa">QA Rej</span>}
            {issue.move_type === 'dev_stalled' && <span className="pm-tracking-move-badge pm-tracking-move-badge--dev">Stalled</span>}
          </span>
          {/* Cycle time (calendar: first active → done) with dev time tooltip */}
          <span
            className={`pm-tracking-cycle-time${cycleLabel ? '' : ' pm-tracking-cycle-time--empty'}`}
            title={devTimeLabel ? `Dev time (active only): ${devTimeLabel}\nCalendar (first seen → done): ${cycleLabel ?? 'ongoing'}` : ''}
          >
            {cycleLabel ?? '—'}
            {devTimeLabel && cycleLabel && devTimeLabel !== cycleLabel && (
              <span className="pm-tracking-dev-time"> ({devTimeLabel})</span>
            )}
          </span>
          {/* Time in current state */}
          <span className={`pm-tracking-time${issue.is_delayed ? ' pm-tracking-time--overdue' : ''}`}>
            {fmtHoursCompact(issue.hours_in_state)}
            {issue.is_delayed && <AlertTriangle size={10} style={{ marginLeft: 3 }} />}
          </span>
          {/* Verification badges */}
          <span className="pm-tracking-verif-badges">
            {issue.verified_on_dev && (
              <span className="pm-tracking-verif-chip pm-tracking-verif-chip--dev" title={`DEV verified by ${issue.verified_on_dev}`}>DEV✓</span>
            )}
            {issue.verified_on_stage && (
              <span className="pm-tracking-verif-chip pm-tracking-verif-chip--stage" title={`Stage verified by ${issue.verified_on_stage}`}>STG✓</span>
            )}
            {issue.verified_on_prod && (
              <span className="pm-tracking-verif-chip pm-tracking-verif-chip--prod" title={`Prod verified by ${issue.verified_on_prod}`}>PRD✓</span>
            )}
          </span>
          {showState ? (
            <span className="pm-tracking-assignee-cell pm-tracking-state-chip" data-state-role={
              (issue.current_state || '').toLowerCase().includes('progress') ? 'active'
              : (issue.current_state || '').toLowerCase().includes('block') ? 'blocked'
              : (issue.current_state || '').toLowerCase().includes('verified') ? 'verified'
              : (issue.current_state || '').toLowerCase().includes('prod') ? 'prod'
              : (issue.current_state || '').toLowerCase().includes('dev') ? 'dev'
              : (issue.current_state || '').toLowerCase().includes('done') ? 'done'
              : 'default'
            }>
              {issue.current_state || '—'}
            </span>
          ) : issue.assignee ? (
            <div className="pm-tracking-assignee-cell">
              {avatarUrl
                ? <img className="pm-tracking-avatar" src={avatarUrl} alt={issue.assignee} onError={(e) => { (e.target as HTMLImageElement).style.display='none'; (e.target as HTMLImageElement).nextElementSibling?.removeAttribute('style') }} />
                : null}
              <div className="pm-tracking-avatar pm-tracking-avatar--initials" style={avatarUrl ? { display: 'none' } : undefined}>{getInitialsFromName(issue.assignee)}</div>
              <span className="pm-tracking-assignee-name">{issue.assignee}</span>
            </div>
          ) : <span className="pm-tracking-assignee-cell" />}
          <span className="pm-tracking-expand-chevron">
            <ChevronDown size={12} className={`dropdown-chevron${isExpanded ? ' open' : ''}`} />
          </span>
        </div>
        {isExpanded && (
          <div className="pm-tracking-expand-wrapper">
            <IssueTransitionInline
              issueId={issue.idReadable || issue.id}
              columnHierarchy={columnHierarchy}
              onViewDetails={(logs) => setDetailIssue({ issue, logs })}
            />
          </div>
        )}
      </React.Fragment>
      </HoverCard>
    )
  }

  // ── IN PROGRESS card renderer ────────────────────────────────────────────
  const renderIssueCard = (issue: SprintBoardIssue) => {
    const isExpanded = expandedIssue === issue.idReadable
    const avatarUrl = issue.avatarUrl || avatarMap[issue.assignee] || avatarMap[issue.assigneeLogin]
    const priColors = priorityColorMap[issue.priority?.toLowerCase()] || null
    const urgencyClass = issue.overdue_level === 'deadline' ? ' pm-tracking-ip-card--crit'
      : (issue.overdue_level === 'sprint' || issue.is_delayed) ? ' pm-tracking-ip-card--warn'
      : ' pm-tracking-ip-card--ok'
    const cycleLabel = issue.cycle_time_hours > 0 ? fmtHoursCompact(issue.cycle_time_hours) : null
    const statClass = issue.overdue_level === 'deadline' ? ' pm-tracking-ip-stat-value--crit'
      : (issue.overdue_level === 'sprint' || issue.is_delayed) ? ' pm-tracking-ip-stat-value--warn' : ''
    return (
      <HoverCard key={issue.id || issue.idReadable} content={ticketHoverContent(issue)} maxWidth={280}>
      <React.Fragment>
        <div className={`pm-tracking-ip-card${urgencyClass}`} onClick={() => setExpandedIssue(isExpanded ? null : issue.idReadable)}>
          <div className="pm-tracking-ip-card-top">
            <span
              className="pm-tracking-ip-card-id"
              onClick={(e) => openInYouTrack(issue.idReadable || issue.id, e)}
              title={`Open ${issue.idReadable} in YouTrack`}
            >
              {issue.idReadable}
            </span>
            <div className="pm-tracking-ip-card-badges">
              {issue.priority && (
                <span className="pm-tracking-pri-badge" style={priColors ? { background: priColors.bg, color: priColors.text } : undefined}>
                  {issue.priority}
                </span>
              )}
              {issue.is_hotfix && <span className="pm-tracking-hotfix-chip"><Zap size={8} /> HF</span>}
            </div>
          </div>
          <div
            className="pm-tracking-ip-card-title pm-tracking-ip-card-title--clickable"
            onClick={(e) => openYtIssue(issue.idReadable || issue.id, e)}
            title={`View ${issue.idReadable} details`}
          >{issue.summary}</div>
          <div className="pm-tracking-ip-card-tags">
            {issue.bounce_count > 0 && <span className="pm-tracking-ip-card-tag pm-tracking-ip-card-tag--bounce">↩ Bounced ×{issue.bounce_count}</span>}
            {issue.move_type === 'qa_rejected' && <span className="pm-tracking-ip-card-tag pm-tracking-ip-card-tag--qa">QA Rejected</span>}
            {issue.move_type === 'dev_stalled' && <span className="pm-tracking-ip-card-tag pm-tracking-ip-card-tag--stall">Dev Stalled</span>}
            {issue.overdue_level === 'deadline' && <span className="pm-tracking-ip-card-tag pm-tracking-ip-card-tag--overdue">Overdue</span>}
            {!issue.bounce_count && !issue.move_type && issue.overdue_level !== 'deadline' && (
              <span className="pm-tracking-ip-card-tag pm-tracking-ip-card-tag--noflag">No flags</span>
            )}
          </div>
          <div className="pm-tracking-ip-card-stats">
            <div className="pm-tracking-ip-stat-cell">
              <span className="pm-tracking-ip-stat-label">Cycle Time</span>
              <span className={`pm-tracking-ip-stat-value${statClass}`}>{cycleLabel ?? '—'}</span>
            </div>
            <div className="pm-tracking-ip-stat-cell">
              <span className="pm-tracking-ip-stat-label">In State</span>
              <span className={`pm-tracking-ip-stat-value${statClass}`}>{fmtHoursCompact(issue.hours_in_state)}</span>
            </div>
            <div className="pm-tracking-ip-stat-cell">
              <span className="pm-tracking-ip-stat-label">Verified</span>
              <div className="pm-tracking-verif-badges" style={{ marginTop: 2 }}>
                {issue.verified_on_dev && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--dev" title={issue.verified_on_dev}>DEV</span>}
                {issue.verified_on_stage && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--stage" title={issue.verified_on_stage}>STG</span>}
                {issue.verified_on_prod && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--prod" title={issue.verified_on_prod}>PRD</span>}
                {!issue.verified_on_dev && !issue.verified_on_stage && !issue.verified_on_prod && (
                  <span className="pm-tracking-ip-stat-value pm-tracking-ip-stat-value--dim">—</span>
                )}
              </div>
            </div>
          </div>
          <div className="pm-tracking-ip-card-footer">
            <div className="pm-tracking-ip-card-assignee-row">
              {avatarUrl
                ? <img className="pm-tracking-avatar" src={avatarUrl} alt={issue.assignee} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.removeAttribute('style') }} />
                : null}
              <div className="pm-tracking-avatar pm-tracking-avatar--initials" style={avatarUrl ? { display: 'none' } : undefined}>{getInitialsFromName(issue.assignee)}</div>
              <span className="pm-tracking-ip-card-assignee">{issue.assignee || 'Unassigned'}</span>
            </div>
          </div>
          {isExpanded && (
            <div className="pm-tracking-ip-card-expand">
              <IssueTransitionInline
                issueId={issue.idReadable || issue.id}
                columnHierarchy={columnHierarchy}
                onViewDetails={(logs) => setDetailIssue({ issue, logs })}
              />
            </div>
          )}
        </div>
      </React.Fragment>
      </HoverCard>
    )
  }

  // ── BLOCKED row renderer ─────────────────────────────────────────────────
  const renderBlockedRow = (issue: SprintBoardIssue) => {
    const priColors = priorityColorMap[issue.priority?.toLowerCase()] || null
    const avatarUrl = issue.avatarUrl || avatarMap[issue.assignee] || avatarMap[issue.assigneeLogin]
    const timeClass = issue.overdue_level === 'deadline' ? ' pm-tracking-blocked-time--crit'
      : (issue.overdue_level === 'sprint' || issue.is_delayed) ? ' pm-tracking-blocked-time--warn' : ''
    const rowClass = issue.overdue_level === 'deadline' ? ' pm-tracking-blocked-row--crit'
      : (issue.overdue_level === 'sprint' || issue.is_delayed) ? ' pm-tracking-blocked-row--warn' : ''
    return (
      <HoverCard key={issue.idReadable} content={ticketHoverContent(issue)} maxWidth={280}>
      <div className={`pm-tracking-blocked-row${rowClass}`}
        onClick={() => setExpandedIssue(expandedIssue === issue.idReadable ? null : issue.idReadable)}>
        <span
          className="pm-tracking-blocked-id pm-tracking-issue-id--link"
          onClick={(e) => openInYouTrack(issue.idReadable, e)}
          title={`Open ${issue.idReadable} in YouTrack`}
        >{issue.idReadable}</span>
        <span className="pm-tracking-blocked-pri">
          {issue.priority && (
            <span className="pm-tracking-pri-badge" style={priColors ? { background: priColors.bg, color: priColors.text } : undefined}>
              {issue.priority}
            </span>
          )}
        </span>
        <div className="pm-tracking-blocked-title">
          <span
            className="pm-tracking-blocked-title-text pm-tracking-issue-summary--clickable"
            title={`View ${issue.idReadable} details`}
            onClick={(e) => openYtIssue(issue.idReadable, e)}
          >{issue.summary}</span>
          {issue.bounce_count > 0 && <span className="pm-tracking-bounce-badge">↩{issue.bounce_count}</span>}
          {issue.is_hotfix && <span className="pm-tracking-hotfix-chip"><Zap size={8} /></span>}
        </div>
        <span className={`pm-tracking-blocked-time${timeClass}`}>{fmtHoursCompact(issue.hours_in_state)}</span>
        <div className="pm-tracking-blocked-assignee">
          {avatarUrl
            ? <img className="pm-tracking-avatar" src={avatarUrl} alt={issue.assignee} style={{ width: 20, height: 20 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
            : <div className="pm-tracking-avatar pm-tracking-avatar--initials" style={{ width: 20, height: 20, fontSize: 8 }}>{getInitialsFromName(issue.assignee)}</div>
          }
          <span className="pm-tracking-blocked-assignee-name">{issue.assignee}</span>
        </div>
      </div>
      </HoverCard>
    )
  }

  return (
    <div className="pm-tab-content pm-tracking-tab">
      {/* ── Toolbar row ── */}
      <div className="pm-tracking-toolbar">
        <div className="pm-tracking-toolbar-left">
          <Activity size={15} className="pm-tracking-toolbar-icon" />
          <span className="pm-tracking-toolbar-title">Sprint Tracking</span>
        </div>
        <div className="pm-tracking-toolbar-right">
          {/* View mode dropdown */}
          {(() => {
            const VIEW_MODES = [
              { id: 'column',      label: 'By Column',   icon: <Layers size={11} /> },
              { id: 'assignee',    label: 'By Assignee', icon: <Users size={11} /> },
              { id: 'swimlane',    label: 'Swimlane',    icon: <Layers size={11} /> },
              { id: 'sidebar',     label: 'Sidebar',     icon: <Users size={11} /> },
              { id: 'heatmap',     label: 'Heat Map',    icon: <BarChart2 size={11} /> },
              { id: 'delay-bars',  label: 'Delay Bars',  icon: <Timer size={11} /> },
              { id: 'alert-first', label: 'Alert First', icon: <AlertTriangle size={11} /> },
              { id: 'split-pane',  label: 'Split Pane',  icon: <Gauge size={11} /> },
              { id: 'focus',       label: 'Focus Mode',  icon: <ScanSearch size={11} /> },
              { id: 'qa-pipeline', label: 'QA Pipeline', icon: <ShieldCheck size={11} /> },
              { id: 'dev-time',       label: 'Dev Time',       icon: <Clock size={11} /> },
              { id: 'feature-groups', label: 'Feature Groups', icon: <Network size={11} /> },
            ] as const
            const current = VIEW_MODES.find(m => m.id === viewMode) || VIEW_MODES[0]
            return (
              <div className="pm-custom-dropdown pm-tracking-viewmode-dropdown" ref={viewModeRef}>
                <button className={`pm-custom-dropdown-trigger${viewModeOpen ? ' open' : ''}`} onClick={() => setViewModeOpen(o => !o)}>
                  {current.icon}<span>{current.label}</span>
                  <ChevronDown size={11} className={`dropdown-chevron${viewModeOpen ? ' open' : ''}`} />
                </button>
                {viewModeOpen && (
                  <div className="pm-custom-dropdown-menu">
                    {VIEW_MODES.map(m => (
                      <button key={m.id} className={`pm-dropdown-item${viewMode === m.id ? ' active' : ''}`}
                        onClick={() => { setViewMode(m.id as typeof viewMode); setViewModeOpen(false) }}>
                        {m.icon} {m.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
          {/* Sort */}
          <div className="pm-custom-dropdown" ref={sortRef}>
            <button className="pm-custom-dropdown-trigger" onClick={() => setSortOpen(o => !o)}>
              <ArrowDownUp size={11} />
              <span>{sortField === 'default' ? 'Sort' : { priority: 'Priority', time_in_state: 'In State', cycle_time: 'Cycle', bounces: 'Bounces', assignee: 'Assignee' }[sortField]}</span>
              <ChevronDown size={11} className={`dropdown-chevron ${sortOpen ? 'open' : ''}`} />
            </button>
            {sortOpen && (
              <div className="pm-custom-dropdown-menu">
                {(['default', 'priority', 'time_in_state', 'cycle_time', 'bounces', 'assignee'] as SortField[]).map(f => (
                  <button key={f} className={`pm-dropdown-item ${sortField === f ? 'active' : ''}`}
                    onClick={() => { setSortField(f); setSortOpen(false) }}>
                    {{ default: 'Default', priority: 'By Priority', time_in_state: 'By Time in State ↓', cycle_time: 'By Cycle Time ↓', bounces: 'By Bounces ↓', assignee: 'By Assignee A–Z' }[f]}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Assignee filter */}
          {allAssignees.length > 0 && (
            <div className="pm-custom-dropdown" ref={assigneeRef}>
              <button className="pm-custom-dropdown-trigger" onClick={() => setAssigneeOpen(o => !o)}>
                <Users size={11} />
                <span>{filterAssignee || 'All Assignees'}</span>
                <ChevronDown size={11} className={`dropdown-chevron ${assigneeOpen ? 'open' : ''}`} />
              </button>
              {assigneeOpen && (
                <div className="pm-custom-dropdown-menu">
                  <button className={`pm-dropdown-item ${!filterAssignee ? 'active' : ''}`}
                    onClick={() => { setFilterAssignee(''); setAssigneeOpen(false) }}>All Assignees</button>
                  {allAssignees.map(a => (
                    <button key={a} className={`pm-dropdown-item ${filterAssignee === a ? 'active' : ''}`}
                      onClick={() => { setFilterAssignee(a); setAssigneeOpen(false) }}>{a}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="pm-tracking-toolbar-btn" onClick={toggleAllCollapse} title={allCollapsed ? 'Expand all' : 'Collapse all'}>
            {allCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          <button className="pm-tracking-toolbar-btn" onClick={fetchBoardStatus} disabled={loading} title="Refresh">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>

      {/* ── KPI cards ── */}
      {summary && (
        <div className="pm-tracking-kpi-row">
          {/* Completion */}
          <button className={`pm-tracking-kpi pm-tracking-kpi--green pm-tracking-kpi--clickable${kpiDrawer === 'completion' ? ' pm-tracking-kpi--active' : ''}`}
            onClick={() => setKpiDrawer(kpiDrawer === 'completion' ? null : 'completion')}>
            <div className="pm-tracking-kpi-lbl">Completion</div>
            <div className="pm-tracking-kpi-val">
              {Math.round(summary.completion_pct)}<span className="pm-tracking-kpi-unit">%</span>
            </div>
            <div className="pm-tracking-kpi-prog">
              <div className="pm-tracking-kpi-prog-f" style={{ width: `${Math.round(summary.completion_pct)}%` }} />
            </div>
            <div className="pm-tracking-kpi-note">{summary.done_issues} / {summary.total_issues} tickets</div>
          </button>
          {/* In Progress */}
          <button className={`pm-tracking-kpi pm-tracking-kpi--blue pm-tracking-kpi--clickable${kpiDrawer === 'in-progress' ? ' pm-tracking-kpi--active' : ''}`}
            onClick={() => setKpiDrawer(kpiDrawer === 'in-progress' ? null : 'in-progress')}>
            <div className="pm-tracking-kpi-lbl">In Progress</div>
            <div className="pm-tracking-kpi-val">{summary.in_progress_count}</div>
            <div className="pm-tracking-kpi-note">{summary.overdue_count} overdue · {summary.blocked_count} blocked</div>
          </button>
          {/* Blocked */}
          <button className={`pm-tracking-kpi pm-tracking-kpi--red pm-tracking-kpi--clickable${kpiDrawer === 'blocked' ? ' pm-tracking-kpi--active' : ''}`}
            onClick={() => setKpiDrawer(kpiDrawer === 'blocked' ? null : 'blocked')}>
            <div className="pm-tracking-kpi-lbl">Blocked</div>
            <div className="pm-tracking-kpi-val">{summary.blocked_count}</div>
            <div className="pm-tracking-kpi-note">{summary.in_progress_count} in progress · {summary.overdue_count} overdue</div>
          </button>
          {/* Bounced */}
          <button className={`pm-tracking-kpi pm-tracking-kpi--amber pm-tracking-kpi--clickable${kpiDrawer === 'bounced' ? ' pm-tracking-kpi--active' : ''}`}
            onClick={() => setKpiDrawer(kpiDrawer === 'bounced' ? null : 'bounced')}>
            <div className="pm-tracking-kpi-lbl">Bounced</div>
            <div className="pm-tracking-kpi-val">{summary.bounced_count}</div>
            <div className="pm-tracking-kpi-note">{summary.hotfix_count} hotfix{summary.hotfix_count !== 1 ? 'es' : ''} · backward moves</div>
          </button>
          {/* Sprint Ends */}
          <button className={`pm-tracking-kpi pm-tracking-kpi--clickable${kpiDrawer === 'sprint' ? ' pm-tracking-kpi--active' : ''}${sprintDeadlineLabel === 'OVERDUE' ? ' pm-tracking-kpi--red' : ' pm-tracking-kpi--amber'}`}
            onClick={() => setKpiDrawer(kpiDrawer === 'sprint' ? null : 'sprint')}>
            <div className="pm-tracking-kpi-lbl">Sprint Ends</div>
            <div className={`pm-tracking-kpi-val${sprintDeadlineLabel === 'OVERDUE' ? ' pm-tracking-kpi-val--danger' : ''}`}>
              {sprintDeadlineLabel ?? '—'}
            </div>
            <div className="pm-tracking-kpi-note">{summary.overdue_count} ticket{summary.overdue_count !== 1 ? 's' : ''} overdue</div>
          </button>
        </div>
      )}

      {/* ── KPI Drawer ── */}
      {kpiDrawer && summary && (
        <div className="pm-kpi-drawer">
          <div className="pm-kpi-drawer-header">
            <span className="pm-kpi-drawer-title">
              {kpiDrawer === 'in-progress' && `In Progress (${allInProgressIssues.length})`}
              {kpiDrawer === 'blocked' && `Blocked Tickets (${allBlockedIssues.length})`}
              {kpiDrawer === 'bounced' && `Bounced Tickets (${allBouncedIssues.length})`}
              {kpiDrawer === 'completion' && 'Sprint Progress'}
              {kpiDrawer === 'sprint' && 'Sprint Timeline'}
            </span>
            <button className="pm-kpi-drawer-close" onClick={() => setKpiDrawer(null)}><X size={13} /></button>
          </div>
          <div className="pm-kpi-drawer-body">

            {/* ── In Progress ── */}
            {kpiDrawer === 'in-progress' && (
              allInProgressIssues.length === 0
                ? <div className="pm-kpi-drawer-empty">No tickets in progress.</div>
                : allInProgressIssues.map(issue => (
                  <div key={issue.id} className="pm-kpi-drawer-row">
                    <span className="pm-kpi-drawer-id pm-tracking-issue-id--link"
                      onClick={(e) => openInYouTrack(issue.idReadable || issue.id, e)}>
                      {issue.idReadable || issue.id}
                    </span>
                    <span className="pm-kpi-drawer-summary pm-tracking-issue-summary--clickable"
                      onClick={(e) => openYtIssue(issue.idReadable || issue.id, e)}>
                      {issue.summary}
                    </span>
                    {issue.assignee && <span className="pm-kpi-drawer-assignee">{issue.assignee}</span>}
                    {issue.is_delayed && (
                      <span className={`pm-kpi-drawer-chip pm-kpi-drawer-chip--${issue.overdue_level === 'deadline' ? 'danger' : 'warn'}`}>
                        {issue.overdue_level || 'overdue'}
                      </span>
                    )}
                    {issue.bounce_count > 0 && (
                      <span className="pm-kpi-drawer-chip pm-kpi-drawer-chip--warn">↩ {issue.bounce_count}</span>
                    )}
                  </div>
                ))
            )}

            {/* ── Blocked ── */}
            {kpiDrawer === 'blocked' && (
              allBlockedIssues.length === 0
                ? <div className="pm-kpi-drawer-empty">No blocked tickets right now.</div>
                : allBlockedIssues.map(issue => (
                  <div key={issue.id} className="pm-kpi-drawer-row">
                    <span className="pm-kpi-drawer-id pm-tracking-issue-id--link"
                      onClick={(e) => openInYouTrack(issue.idReadable || issue.id, e)}>
                      {issue.idReadable || issue.id}
                    </span>
                    <span className="pm-kpi-drawer-summary pm-tracking-issue-summary--clickable"
                      onClick={(e) => openYtIssue(issue.idReadable || issue.id, e)}>
                      {issue.summary}
                    </span>
                    {issue.assignee && <span className="pm-kpi-drawer-assignee">{issue.assignee}</span>}
                    {(issue.total_active_hours || 0) > 0 && (
                      <span className="pm-kpi-drawer-chip pm-kpi-drawer-chip--danger">
                        {Math.round(issue.total_active_hours || 0)}h blocked
                      </span>
                    )}
                  </div>
                ))
            )}

            {/* ── Bounced ── */}
            {kpiDrawer === 'bounced' && (
              allBouncedIssues.length === 0
                ? <div className="pm-kpi-drawer-empty">No bounced tickets.</div>
                : allBouncedIssues.map(issue => (
                  <div key={issue.id} className="pm-kpi-drawer-row">
                    <span className="pm-kpi-drawer-id pm-tracking-issue-id--link"
                      onClick={(e) => openInYouTrack(issue.idReadable || issue.id, e)}>
                      {issue.idReadable || issue.id}
                    </span>
                    <span className="pm-kpi-drawer-summary pm-tracking-issue-summary--clickable"
                      onClick={(e) => openYtIssue(issue.idReadable || issue.id, e)}>
                      {issue.summary}
                    </span>
                    {issue.assignee && <span className="pm-kpi-drawer-assignee">{issue.assignee}</span>}
                    <span className="pm-kpi-drawer-chip pm-kpi-drawer-chip--warn">↩ {issue.bounce_count}</span>
                  </div>
                ))
            )}

            {/* ── Completion ── */}
            {kpiDrawer === 'completion' && (() => {
              const pct = Math.round(summary.completion_pct)
              const doneIds = new Set(
                filteredColumns.filter(c => getColumnType(c) === 'compact').flatMap(c => c.issues.map(i => i.id))
              )
              const activeIds = new Set(
                filteredColumns.filter(c => getColumnType(c) === 'inprogress').flatMap(c => c.issues.map(i => i.id))
              )
              return (
                <div className="pm-kpi-drawer-completion">
                  <div className="pm-kpi-drawer-prog-row">
                    <span className="pm-kpi-drawer-prog-label">{summary.done_issues} / {summary.total_issues} done</span>
                    <span className="pm-kpi-drawer-prog-pct">{pct}%</span>
                  </div>
                  <div className="pm-kpi-drawer-prog-track">
                    <div className="pm-kpi-drawer-prog-fill pm-kpi-drawer-prog-fill--green" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="pm-kpi-drawer-person-list">
                    {byPersonList.map(person => {
                      const done   = person.issues.filter(i => doneIds.has(i.id)).length
                      const active = person.issues.filter(i => activeIds.has(i.id)).length
                      const total  = person.issues.length
                      const personPct = total > 0 ? Math.round((done / total) * 100) : 0
                      const avatarSrc = person.avatarUrl || avatarMap[person.name] || avatarMap[person.login]
                      return (
                        <div key={person.name} className="pm-kpi-drawer-person-row">
                          <div className="pm-kpi-drawer-avatar">
                            {avatarSrc ? <img src={avatarSrc} alt="" /> : <span>{(person.name || '?')[0]}</span>}
                          </div>
                          <span className="pm-kpi-drawer-person-name">{person.name}</span>
                          <div className="pm-kpi-drawer-mini-track">
                            <div className="pm-kpi-drawer-mini-fill" style={{ width: `${personPct}%` }} />
                          </div>
                          <span className="pm-kpi-drawer-person-stats">{done} done · {active} active</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}

            {/* ── Sprint ── */}
            {kpiDrawer === 'sprint' && (() => {
              const notStarted = Math.max(0, summary.total_issues - summary.done_issues - summary.in_progress_count - summary.blocked_count)
              const segments = [
                { label: 'Done', count: summary.done_issues, cls: 'green' },
                { label: 'In Progress', count: summary.in_progress_count, cls: 'blue' },
                { label: 'Blocked', count: summary.blocked_count, cls: 'red' },
                { label: 'Not Started', count: notStarted, cls: 'muted' },
              ]
              const atRisk = allIssuesByDelay.filter(i => i.is_delayed)
              return (
                <div className="pm-kpi-drawer-sprint">
                  <div className={`pm-kpi-drawer-sprint-countdown${sprintDeadlineLabel === 'OVERDUE' ? ' pm-kpi-drawer-sprint-countdown--danger' : ''}`}>
                    {sprintDeadlineLabel === 'OVERDUE' ? '⚠ Sprint Overdue' : `⏱ ${sprintDeadlineLabel}`}
                  </div>
                  <div className="pm-kpi-drawer-sprint-segs">
                    {segments.map(seg => (
                      <div key={seg.label} className="pm-kpi-drawer-sprint-seg">
                        <span className={`pm-kpi-drawer-sprint-seg-count pm-kpi-drawer-sprint-seg-count--${seg.cls}`}>{seg.count}</span>
                        <div className="pm-kpi-drawer-sprint-bar">
                          <div className={`pm-kpi-drawer-sprint-bar-fill pm-kpi-drawer-sprint-bar-fill--${seg.cls}`}
                            style={{ width: `${summary.total_issues > 0 ? Math.round((seg.count / summary.total_issues) * 100) : 0}%` }} />
                        </div>
                        <span className="pm-kpi-drawer-sprint-seg-label">{seg.label}</span>
                      </div>
                    ))}
                  </div>
                  {atRisk.length > 0 && (
                    <>
                      <div className="pm-kpi-drawer-at-risk-header">At Risk ({atRisk.length})</div>
                      {atRisk.slice(0, 6).map(issue => (
                        <div key={issue.id} className="pm-kpi-drawer-row">
                          <span className="pm-kpi-drawer-id pm-tracking-issue-id--link"
                            onClick={(e) => openInYouTrack(issue.idReadable || issue.id, e)}>
                            {issue.idReadable || issue.id}
                          </span>
                          <span className="pm-kpi-drawer-summary pm-tracking-issue-summary--clickable"
                            onClick={(e) => openYtIssue(issue.idReadable || issue.id, e)}>
                            {issue.summary}
                          </span>
                          {issue.assignee && <span className="pm-kpi-drawer-assignee">{issue.assignee}</span>}
                          {issue.overdue_level && (
                            <span className={`pm-kpi-drawer-chip pm-kpi-drawer-chip--${issue.overdue_level === 'deadline' ? 'danger' : 'warn'}`}>
                              {issue.overdue_level}
                            </span>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                  {atRisk.length === 0 && <div className="pm-kpi-drawer-empty">No at-risk tickets.</div>}
                </div>
              )
            })()}

          </div>
        </div>
      )}

      {error && <div className="pm-report-error"><AlertTriangle size={14} />{error}</div>}
      {statusMsg && <div className="pm-report-status">{statusMsg}</div>}

      {!sprintId && (
        <div className="pm-empty-state"><Activity size={36} /><p>Select a sprint to view board status</p></div>
      )}

      {sprintId && loading && trackingSkeleton}

      {sprintId && !loading && filteredColumns.length === 0 && !error && (
        <div className="pm-empty-state"><Activity size={36} /><p>No issues found for this sprint.</p></div>
      )}

      {/* ── Column view ── */}
      {!loading && viewMode === 'column' && (
        <div className="pm-tracking-board">
          {filteredColumns.map(col => {
            const colType = getColumnType(col)
            const isCollapsed = collapsedCols.has(col.name)
            const delayedCount = col.issues.filter(i => i.is_delayed).length
            const bouncedCount = col.issues.filter(i => i.bounce_count > 0).length
            const dotColor = colType === 'inprogress'
              ? 'var(--accent-primary, #6366f1)'
              : colType === 'blocked' ? '#ef4444'
              : colType === 'todo' ? '#4b5563' : '#3b82f6'
            return (
              <div key={col.name} className="pm-tracking-sec">
                <HoverCard content={columnHeaderHoverContent(col)} delay={400}>
                <div className="pm-tracking-sec-hdr" onClick={() => toggleColCollapse(col.name)}>
                  <div className="pm-tracking-sec-title">
                    <span className="pm-tracking-sec-dot" style={{ background: dotColor, boxShadow: colType === 'inprogress' ? `0 0 6px ${dotColor}` : colType === 'blocked' ? '0 0 6px #ef4444' : 'none' }} />
                    {col.name.toUpperCase()}
                    <span className="pm-tracking-sec-count">{col.issues.length}</span>
                  </div>
                  <div className="pm-tracking-sec-meta">
                    {delayedCount > 0 && (
                      <span className="pm-tracking-sec-warn"><AlertTriangle size={11} /> {delayedCount} overdue</span>
                    )}
                    {bouncedCount > 0 && (
                      <span className="pm-tracking-sec-bounce">↩ {bouncedCount} bounced</span>
                    )}
                    <ChevronDown size={13} className={`dropdown-chevron${isCollapsed ? '' : ' open'}`} />
                  </div>
                </div>
                </HoverCard>
                {!isCollapsed && (
                  <div className="pm-tracking-sec-body">
                    {colType === 'inprogress' && (
                      <div className="pm-tracking-ip-grid">
                        {col.issues.map(issue => renderIssueCard(issue))}
                      </div>
                    )}
                    {colType === 'blocked' && (
                      <div className="pm-tracking-blocked-strip">
                        {col.issues.map(issue => renderBlockedRow(issue))}
                      </div>
                    )}
                    {(colType === 'compact' || colType === 'todo') && (
                      <>
                        <div className="pm-tracking-issue-row pm-tracking-col-header-row">
                          <span className="pm-tracking-issue-id pm-tracking-col-heading">Ticket</span>
                          <span className="pm-tracking-col-heading">Pri</span>
                          <span className="pm-tracking-issue-summary pm-tracking-col-heading">Title</span>
                          <span className="pm-tracking-cycle-time pm-tracking-col-heading">Cycle</span>
                          <span className="pm-tracking-time pm-tracking-col-heading">In State</span>
                          <span className="pm-tracking-verif-badges pm-tracking-col-heading">Verified</span>
                          <span className="pm-tracking-assignee-cell pm-tracking-col-heading">Assignee</span>
                        </div>
                        {col.issues.map(issue => renderIssueRow(issue))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Swimlane view (Design 02) ── */}
      {!loading && viewMode === 'swimlane' && (
        <>
        {/* Color legend */}
        <div className="pm-tracking-swimlane-legend">
          <span className="pm-tracking-swimlane-legend-item pm-tracking-swimlane-chip--overdue">Overdue</span>
          <span className="pm-tracking-swimlane-legend-item pm-tracking-swimlane-chip--atrisk">At Risk</span>
          <span className="pm-tracking-swimlane-legend-item pm-tracking-swimlane-chip--blocked">Blocked</span>
          <span className="pm-tracking-swimlane-legend-item pm-tracking-swimlane-chip--bounced">↩ Bounced 3+</span>
          <span className="pm-tracking-swimlane-legend-item pm-tracking-swimlane-chip--dev">In Dev / Verified</span>
          <span className="pm-tracking-swimlane-legend-item pm-tracking-swimlane-chip--normal">Normal</span>
          <span className="pm-tracking-swimlane-legend-sep">·</span>
          <span className="pm-tracking-swimlane-legend-hint">↩N = bounces &nbsp;·&nbsp; Nd = active time &nbsp;·&nbsp; ✓DEV/STG/PRD = QA verified</span>
        </div>
        <div className="pm-tracking-swimlane-board">
          {byPersonList.map(person => {
            const avatarSrc = person.avatarUrl || avatarMap[person.name] || avatarMap[person.login]
            const total = person.issues.length
            const activeCount = person.issues.filter(i => { const n = i.current_state?.toLowerCase() || ''; return n.includes('progress') }).length
            const blockedCount = person.issues.filter(i => i.current_state?.toLowerCase().includes('block')).length
            const otherCount = total - activeCount - blockedCount
            const getChipClass = (i: SprintBoardIssue) => {
              if (i.overdue_level === 'deadline') return 'pm-tracking-swimlane-chip--overdue'
              if (i.overdue_level === 'sprint' || i.is_delayed) return 'pm-tracking-swimlane-chip--atrisk'
              if (i.current_state?.toLowerCase().includes('block')) return 'pm-tracking-swimlane-chip--blocked'
              if (i.bounce_count >= 3) return 'pm-tracking-swimlane-chip--bounced'
              if (i.current_state?.toLowerCase().includes('dev') || i.verified_on_dev) return 'pm-tracking-swimlane-chip--dev'
              return 'pm-tracking-swimlane-chip--normal'
            }
            const isActive = (i: SprintBoardIssue) => {
              const s = i.current_state?.toLowerCase() || ''
              return s.includes('progress') || s === 'in progress'
            }
            const qaLabel = (i: SprintBoardIssue) => {
              if (i.verified_on_prod) return '✓PRD'
              if (i.verified_on_stage) return '✓STG'
              if (i.verified_on_dev) return '✓DEV'
              return null
            }
            return (
              <div key={person.name} className="pm-tracking-swimlane-row">
                <HoverCard content={assigneeHoverContent(person.name, person.issues)} delay={350} maxWidth={240}>
                <div className="pm-tracking-swimlane-person">
                  <div className="pm-tracking-swimlane-person-header">
                    {avatarSrc
                      ? <img className="pm-tracking-swimlane-avatar" src={avatarSrc} alt={person.name} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      : <div className="pm-tracking-swimlane-avatar">{getInitialsFromName(person.name)}</div>
                    }
                    <span className="pm-tracking-swimlane-name">{person.name}</span>
                  </div>
                  <span className="pm-tracking-swimlane-count">{total} ticket{total !== 1 ? 's' : ''}</span>
                </div>
                </HoverCard>
                <div className="pm-tracking-swimlane-chips">
                  {person.issues.map(i => (
                    <HoverCard key={i.idReadable} content={ticketHoverContent(i)} maxWidth={280}>
                      <span
                        className={`pm-tracking-swimlane-chip ${getChipClass(i)}`}
                        onClick={(e) => openInYouTrack(i.idReadable, e)}
                      >
                        {i.idReadable}
                        {i.bounce_count > 0 && <span className="pm-tracking-chip-bounce">↩{i.bounce_count}</span>}
                        {i.total_active_hours > 0 && isActive(i) && <span className="pm-tracking-chip-time">{fmtHoursCompact(i.total_active_hours)}</span>}
                        {qaLabel(i) && <span className="pm-tracking-chip-qa">{qaLabel(i)}</span>}
                      </span>
                    </HoverCard>
                  ))}
                </div>
                <HoverCard content={assigneeHoverContent(person.name, person.issues)} delay={350}>
                <div className="pm-tracking-swimlane-loadbar-wrap">
                  <div className="pm-tracking-swimlane-loadbar">
                    {total > 0 && <div className="pm-tracking-swimlane-seg pm-tracking-swimlane-seg--active" style={{ width: `${(activeCount / total) * 100}%` }} />}
                    {total > 0 && <div className="pm-tracking-swimlane-seg pm-tracking-swimlane-seg--blocked" style={{ width: `${(blockedCount / total) * 100}%` }} />}
                    {total > 0 && <div className="pm-tracking-swimlane-seg pm-tracking-swimlane-seg--other" style={{ width: `${(otherCount / total) * 100}%` }} />}
                  </div>
                  <div className="pm-tracking-swimlane-loadbar-labels">
                    <span>{activeCount} active</span>
                    {blockedCount > 0 && <span>{blockedCount} blocked</span>}
                    <span>{total} total</span>
                  </div>
                </div>
                </HoverCard>
              </div>
            )
          })}
        </div>
        </>
      )}

      {/* ── Sidebar view (Design 03) ── */}
      {!loading && viewMode === 'sidebar' && (() => {
        const activePerson = sidebarPerson || byPersonList[0]?.name || ''
        const selectedPersonData = byPersonList.find(p => p.name === activePerson)
        return (
          <div className="pm-tracking-sidebar-layout">
            <div className="pm-tracking-sidebar-panel">
              {byPersonList.map(person => {
                const total = person.issues.length
                const activeCount = person.issues.filter(i => i.current_state?.toLowerCase().includes('progress')).length
                const blockedCount = person.issues.filter(i => i.current_state?.toLowerCase().includes('block')).length
                const devCount = person.issues.filter(i => i.verified_on_dev).length
                const idleCount = total - activeCount - blockedCount - devCount
                const avatarSrc = person.avatarUrl || avatarMap[person.name] || avatarMap[person.login]
                return (
                  <HoverCard key={person.name} content={assigneeHoverContent(person.name, person.issues)} delay={350} maxWidth={230}>
                  <div
                    className={`pm-tracking-sidebar-person${activePerson === person.name ? ' active' : ''}`}
                    onClick={() => setSidebarPerson(person.name)}
                  >
                    {avatarSrc
                      ? <img className="pm-tracking-swimlane-avatar" src={avatarSrc} alt={person.name} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      : <div className="pm-tracking-swimlane-avatar">{getInitialsFromName(person.name)}</div>
                    }
                    <div className="pm-tracking-sidebar-person-info">
                      <div className="pm-tracking-sidebar-person-name">{person.name}</div>
                      <div className="pm-tracking-sidebar-person-count">{total} ticket{total !== 1 ? 's' : ''}</div>
                      <div className="pm-tracking-sidebar-loadbar">
                        {total > 0 && <div className="pm-tracking-sidebar-seg pm-tracking-sidebar-seg--active" style={{ width: `${(activeCount / total) * 100}%` }} />}
                        {total > 0 && <div className="pm-tracking-sidebar-seg pm-tracking-sidebar-seg--blocked" style={{ width: `${(blockedCount / total) * 100}%` }} />}
                        {total > 0 && <div className="pm-tracking-sidebar-seg pm-tracking-sidebar-seg--dev" style={{ width: `${(devCount / total) * 100}%` }} />}
                        {total > 0 && <div className="pm-tracking-sidebar-seg pm-tracking-sidebar-seg--idle" style={{ width: `${(idleCount / total) * 100}%` }} />}
                      </div>
                    </div>
                  </div>
                  </HoverCard>
                )
              })}
            </div>
            <div className="pm-tracking-sidebar-main">
              {selectedPersonData ? (
                <>
                  <div className="pm-tracking-issue-row pm-tracking-col-header-row">
                    <span className="pm-tracking-issue-id pm-tracking-col-heading">Ticket</span>
                    <span className="pm-tracking-col-heading">Pri</span>
                    <span className="pm-tracking-issue-summary pm-tracking-col-heading">Title</span>
                    <span className="pm-tracking-cycle-time pm-tracking-col-heading">Cycle</span>
                    <span className="pm-tracking-time pm-tracking-col-heading">In State</span>
                    <span className="pm-tracking-verif-badges pm-tracking-col-heading">Verified</span>
                    <span className="pm-tracking-assignee-cell pm-tracking-col-heading">Column</span>
                  </div>
                  {selectedPersonData.issues.map(issue => renderIssueRow(issue, true))}
                </>
              ) : (
                <div className="pm-tracking-sidebar-empty">Select a person to view their tickets</div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Heatmap view (Design 04) ── */}
      {!loading && viewMode === 'heatmap' && (() => {
        const colNames = filteredColumns.map(c => c.name)
        return (
          <div className="pm-tracking-heatmap-wrap">
            <div className="pm-tracking-heatmap-grid-wrap">
              <div
                className="pm-tracking-heatmap-grid"
                style={{ gridTemplateColumns: `180px repeat(${colNames.length}, minmax(52px, 1fr))` }}
              >
                {/* Header row */}
                <div className="pm-tracking-heatmap-header-cell">Person</div>
                {colNames.map(n => (
                  <div key={n} className="pm-tracking-heatmap-header-cell" title={n}>
                    {n.length > 10 ? n.slice(0, 9) + '…' : n}
                  </div>
                ))}
                {/* Data rows */}
                {byPersonList.map(person => {
                  const hasDeadline = person.issues.some(i => i.overdue_level === 'deadline')
                  const hasSprint = person.issues.some(i => i.overdue_level === 'sprint' || i.is_delayed)
                  const avatarSrc = person.avatarUrl || avatarMap[person.name] || avatarMap[person.login]
                  return (
                    <React.Fragment key={person.name}>
                      <HoverCard content={assigneeHoverContent(person.name, person.issues)} delay={350} maxWidth={230}>
                      <div className="pm-tracking-heatmap-row-label">
                        {avatarSrc
                          ? <img className="pm-tracking-swimlane-avatar" src={avatarSrc} alt={person.name} style={{ width: 20, height: 20 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                          : <div className="pm-tracking-swimlane-avatar" style={{ width: 20, height: 20, fontSize: 8 }}>{getInitialsFromName(person.name)}</div>
                        }
                        {person.name}
                      </div>
                      </HoverCard>
                      {filteredColumns.map(col => {
                        const count = col.issues.filter(i => (i.assignee || 'Unassigned') === person.name).length
                        const issues = col.issues.filter(i => (i.assignee || 'Unassigned') === person.name)
                        const hasOver = issues.some(i => i.overdue_level === 'deadline')
                        const hasRisk = issues.some(i => i.overdue_level === 'sprint' || i.is_delayed)
                        const cellClass = count === 0 ? 'pm-tracking-heatmap-cell--empty'
                          : hasOver ? 'pm-tracking-heatmap-cell--overdue'
                          : hasRisk ? 'pm-tracking-heatmap-cell--atrisk'
                          : 'pm-tracking-heatmap-cell--ok'
                        return (
                          <HoverCard key={col.name} content={count > 0 ? heatmapCellHoverContent(person.name, col, issues) : null} delay={300} maxWidth={260}>
                          <div className={`pm-tracking-heatmap-cell ${cellClass}`}>
                            {count > 0 ? count : '·'}
                          </div>
                          </HoverCard>
                        )
                      })}
                    </React.Fragment>
                  )
                })}
              </div>
            </div>
            {/* Full ticket list below heatmap */}
            <div className="pm-tracking-board">
              {filteredColumns.map(col => (
                <div key={col.name} className="pm-tracking-column-section">
                  <div className="pm-tracking-col-header">
                    <span className="pm-tracking-col-name">{col.name}</span>
                    <span className="pm-tracking-col-count">{col.issues.length}</span>
                  </div>
                  {col.issues.map(issue => renderIssueRow(issue))}
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* ── Delay Bars view (Design 05) ── */}
      {!loading && viewMode === 'delay-bars' && (() => {
        const SCALE_DAYS = 10
        return (
          <div className="pm-tracking-delay-board">
            <div className="pm-tracking-delay-legend">
              <span className="pm-tracking-delay-legend-item">
                <span className="pm-tracking-delay-legend-dot pm-tracking-delay-legend-dot--work" /> Working
              </span>
              <span className="pm-tracking-delay-legend-item">
                <span className="pm-tracking-delay-legend-dot pm-tracking-delay-legend-dot--bounce" /> Bounce
              </span>
              <span className="pm-tracking-delay-legend-item">
                <span className="pm-tracking-delay-legend-dot pm-tracking-delay-legend-dot--review" /> Review/Idle
              </span>
              <span className="pm-tracking-delay-legend-item">
                <span className="pm-tracking-delay-legend-sla" /> SLA limit
              </span>
            </div>
            <div className="pm-tracking-delay-headers">
              <span />
              <span>Ticket</span>
              <span>Pri</span>
              <span>Title</span>
              <span>Time Bar (10d scale)</span>
              <span>Delay</span>
            </div>
            {allIssuesByDelay.map(issue => {
              const slaHours = slaMap[issue.priority?.toLowerCase()] || 0
              const workDays = (issue.total_active_hours || 0) / 24
              const bounceDays = (issue.bounce_count || 0) * 0.4
              const reviewDays = Math.max(0, ((issue.cycle_time_hours || 0) - (issue.total_active_hours || 0)) / 24 - bounceDays)
              const totalDays = workDays + bounceDays + reviewDays
              const slaDays = slaHours / 24
              const overSla = slaDays > 0 && totalDays > slaDays
              const overDays = totalDays - slaDays
              const workPct = Math.min((workDays / SCALE_DAYS) * 100, 100)
              const bouncePct = Math.min((bounceDays / SCALE_DAYS) * 100, 100 - workPct)
              const reviewPct = Math.min((reviewDays / SCALE_DAYS) * 100, 100 - workPct - bouncePct)
              const slaPct = slaDays > 0 ? Math.min((slaDays / SCALE_DAYS) * 100, 100) : null
              const overPct = slaPct ? Math.max(0, 100 - slaPct) : 0
              const rowClass = issue.overdue_level === 'deadline' ? ' pm-tracking-delay-row--over'
                : (issue.overdue_level === 'sprint' || issue.is_delayed) ? ' pm-tracking-delay-row--risk' : ''
              const isExpanded = expandedIssue === issue.idReadable
              const priColors = priorityColorMap[issue.priority?.toLowerCase()] || null
              return (
                <HoverCard key={issue.idReadable} content={delayBarHoverContent(issue, workDays, bounceDays, reviewDays, slaDays)} maxWidth={290}>
                <React.Fragment>
                  <div
                    className={`pm-tracking-delay-row${rowClass}`}
                    onClick={() => setExpandedIssue(isExpanded ? null : issue.idReadable)}
                  >
                    <span>{isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                    <span
                      className="pm-tracking-issue-id pm-tracking-issue-id--link"
                      onClick={(e) => openInYouTrack(issue.idReadable, e)}
                      title={`Open ${issue.idReadable} in YouTrack`}
                    >{issue.idReadable}</span>
                    <span>
                      {issue.priority && (
                        <span className="pm-tracking-pri-badge" style={priColors ? { background: priColors.bg, color: priColors.text } : undefined}>
                          {issue.priority}
                        </span>
                      )}
                    </span>
                    <div className="pm-tracking-delay-title-cell">
                      <span
                        className="pm-tracking-delay-title-text pm-tracking-delay-title-text--clickable"
                        title={`View ${issue.idReadable} details`}
                        onClick={(e) => openYtIssue(issue.idReadable, e)}
                      >{issue.summary}</span>
                      {issue.bounce_count > 0 && <span className="pm-tracking-bounce-badge">↩{issue.bounce_count}</span>}
                      {issue.is_hotfix && <span className="pm-tracking-hotfix-chip">HF</span>}
                      {(issue.verified_on_dev || issue.verified_on_stage || issue.verified_on_prod) && (
                        <span className="pm-tracking-verif-badges">
                          {issue.verified_on_dev && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--dev" title={`DEV verified by ${issue.verified_on_dev}`}>DEV✓</span>}
                          {issue.verified_on_stage && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--stage" title={`Stage verified by ${issue.verified_on_stage}`}>STG✓</span>}
                          {issue.verified_on_prod && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--prod" title={`Prod verified by ${issue.verified_on_prod}`}>PRD✓</span>}
                        </span>
                      )}
                    </div>
                    <div className="pm-tracking-timebar-wrap">
                      <div className="pm-tracking-timebar-track">
                        {workPct > 0 && <div className="pm-tracking-timebar-seg pm-tracking-timebar-seg--work" style={{ left: 0, width: `${workPct}%` }} />}
                        {bouncePct > 0 && <div className="pm-tracking-timebar-seg pm-tracking-timebar-seg--bounce" style={{ left: `${workPct}%`, width: `${bouncePct}%` }} />}
                        {reviewPct > 0 && <div className="pm-tracking-timebar-seg pm-tracking-timebar-seg--review" style={{ left: `${workPct + bouncePct}%`, width: `${reviewPct}%` }} />}
                        {slaPct && <div className="pm-tracking-timebar-sla" style={{ left: `${slaPct}%` }} />}
                        {overSla && overPct > 0 && <div className="pm-tracking-timebar-overzone" style={{ left: `${slaPct}%`, width: `${overPct}%` }} />}
                      </div>
                      <div className="pm-tracking-timebar-scale">
                        <span>0d</span>
                        {slaPct && <span style={{ position: 'absolute', left: `${slaPct}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>SLA</span>}
                        <span>10d</span>
                      </div>
                    </div>
                    <div className="pm-tracking-delay-badge">
                      {slaDays > 0 ? (
                        <>
                          <span className={`pm-tracking-delay-badge-num ${overSla ? 'pm-tracking-delay-badge-num--over' : 'pm-tracking-delay-badge-num--ok'}`}>
                            {overSla ? `+${overDays.toFixed(1)}d` : `${(slaDays - totalDays).toFixed(1)}d`}
                          </span>
                          <span className="pm-tracking-delay-badge-label">{overSla ? 'over SLA' : 'left'}</span>
                        </>
                      ) : (
                        <span className="pm-tracking-delay-badge-label">{totalDays.toFixed(1)}d elapsed</span>
                      )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="pm-tracking-delay-row-expand">
                      <IssueTransitionInline
                        issueId={issue.idReadable}
                        columnHierarchy={columnHierarchy}
                        onViewDetails={(logs) => setDetailIssue({ issue, logs })}
                      />
                    </div>
                  )}
                </React.Fragment>
                </HoverCard>
              )
            })}
          </div>
        )
      })()}

      {/* ── Alert-first view (Design 07) ── */}
      {!loading && viewMode === 'alert-first' && (
        <div className="pm-tracking-alert-layout">

          {/* Feature delivery alert — shows when features haven't started and sprint ends soon */}
          {featureAlertData && (
            <div className="pm-tracking-feature-alert">
              <div className="pm-tracking-feature-alert-header">
                ⚠ {featureAlertData.notStarted.length} feature{featureAlertData.notStarted.length !== 1 ? 's' : ''} not started — sprint ends in {featureAlertData.daysLeft}d
              </div>
              <div className="pm-tracking-feature-alert-list">
                {featureAlertData.notStarted.slice(0, 4).map(iss => (
                  <div key={iss.idReadable} className="pm-tracking-feature-alert-row">
                    <span
                      className="pm-tracking-issue-id--link"
                      onClick={(e) => openInYouTrack(iss.idReadable, e)}
                      style={{ cursor: 'pointer', flexShrink: 0 }}
                    >{iss.idReadable}</span>
                    <span className="pm-tracking-feature-alert-title" title={iss.summary}>{iss.summary}</span>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', flexShrink: 0 }}>{iss.assignee?.split(' ')[0] || '—'}</span>
                  </div>
                ))}
                {featureAlertData.notStarted.length > 4 && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginTop: 4 }}>
                    +{featureAlertData.notStarted.length - 4} more
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="pm-tracking-alert-banner">
            <div className="pm-tracking-alert-banner-header">
              <span className="pm-tracking-alert-count">{allBlockedIssues.length}</span>
              <span className="pm-tracking-alert-count-label">ticket{allBlockedIssues.length !== 1 ? 's' : ''} blocked</span>
            </div>
            {allBlockedIssues.length > 0 && (
              <div className="pm-tracking-alert-grid">
                {allBlockedIssues.map(issue => {
                  const rowUrgency = issue.overdue_level === 'deadline' ? '--critical' : '--atrisk'
                  const avatarSrc = issue.avatarUrl || avatarMap[issue.assignee] || avatarMap[issue.assigneeLogin]
                  return (
                    <HoverCard key={issue.idReadable} content={ticketHoverContent(issue)} maxWidth={280}>
                    <div className={`pm-tracking-alert-blocked-row pm-tracking-alert-blocked-row${rowUrgency}`}>
                      {avatarSrc
                        ? <img className="pm-tracking-swimlane-avatar" src={avatarSrc} alt={issue.assignee} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                        : <div className="pm-tracking-swimlane-avatar">{getInitialsFromName(issue.assignee)}</div>
                      }
                      <div className="pm-tracking-alert-blocked-info">
                        <div className="pm-tracking-alert-blocked-id">
                          <span
                            className="pm-tracking-issue-id--link"
                            onClick={(e) => openInYouTrack(issue.idReadable, e)}
                            title={`Open ${issue.idReadable} in YouTrack`}
                            style={{ cursor: 'pointer' }}
                          >{issue.idReadable}</span>
                          {issue.issue_type && (
                            <span className={`pm-tracking-type-badge pm-tracking-type-badge--${issue.issue_type.toLowerCase().replace(/\s+/g, '-')}`} style={{ marginLeft: 4 }}>
                              {issue.issue_type}
                            </span>
                          )}
                          {issue.bounce_count > 0 && <span className="pm-tracking-bounce-badge" style={{ marginLeft: 4 }}>↩{issue.bounce_count}</span>}
                        </div>
                        <div
                          className="pm-tracking-alert-blocked-title"
                          title={`View ${issue.idReadable} details`}
                          onClick={(e) => openYtIssue(issue.idReadable, e)}
                          style={{ cursor: 'pointer' }}
                        >{issue.summary}</div>
                        {(issue.verified_on_dev || issue.verified_on_stage || issue.verified_on_prod) && (
                          <div className="pm-tracking-verif-badges" style={{ marginTop: 3 }}>
                            {issue.verified_on_dev && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--dev" title={`DEV verified by ${issue.verified_on_dev}`}>DEV✓</span>}
                            {issue.verified_on_stage && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--stage" title={`Stage verified by ${issue.verified_on_stage}`}>STG✓</span>}
                            {issue.verified_on_prod && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--prod" title={`Prod verified by ${issue.verified_on_prod}`}>PRD✓</span>}
                          </div>
                        )}
                      </div>
                      <div className="pm-tracking-alert-blocked-time">{fmtHoursCompact(issue.hours_in_state)}</div>
                    </div>
                    </HoverCard>
                  )
                })}
              </div>
            )}
          </div>
          <div className="pm-tracking-alert-inprogress">
            <div className="pm-tracking-alert-section-header">
              <Activity size={13} /> In Progress <span className="pm-tracking-col-count">{allInProgressIssues.length}</span>
            </div>
            {allInProgressIssues.length > 0 ? (
              <div className="pm-tracking-alert-cards">
                {allInProgressIssues.map(issue => {
                  const urgency = issue.overdue_level === 'deadline' ? '--overdue'
                    : (issue.overdue_level === 'sprint' || issue.is_delayed) ? '--atrisk' : '--normal'
                  const priColors = priorityColorMap[issue.priority?.toLowerCase()] || null
                  const isExpanded = expandedIssue === issue.idReadable
                  const avatarSrc = issue.avatarUrl || avatarMap[issue.assignee] || avatarMap[issue.assigneeLogin]
                  return (
                    <div
                      key={issue.idReadable}
                      className={`pm-tracking-alert-card pm-tracking-alert-card${urgency}`}
                      onClick={() => setExpandedIssue(isExpanded ? null : issue.idReadable)}
                    >
                      <div className="pm-tracking-alert-card-header">
                        <span
                          className="pm-tracking-alert-card-id pm-tracking-issue-id--link"
                          onClick={(e) => openInYouTrack(issue.idReadable, e)}
                          title={`Open ${issue.idReadable} in YouTrack`}
                        >{issue.idReadable}</span>
                        {issue.priority && (
                          <span className="pm-tracking-pri-badge" style={priColors ? { background: priColors.bg, color: priColors.text } : undefined}>
                            {issue.priority}
                          </span>
                        )}
                        {issue.bounce_count > 0 && <span className="pm-tracking-bounce-badge">↩{issue.bounce_count}</span>}
                      </div>
                      <div
                        className="pm-tracking-alert-card-title pm-tracking-ip-card-title--clickable"
                        onClick={(e) => openYtIssue(issue.idReadable, e)}
                        title={`View ${issue.idReadable} details`}
                      >{issue.summary}</div>
                      <div className="pm-tracking-alert-card-footer">
                        <div className="pm-tracking-alert-card-stats">
                          {issue.cycle_time_hours > 0 && (
                            <span className="pm-tracking-alert-card-stat">Cycle <span>{fmtHoursCompact(issue.cycle_time_hours)}</span></span>
                          )}
                          <span className="pm-tracking-alert-card-stat">In state <span>{fmtHoursCompact(issue.hours_in_state)}</span></span>
                          {issue.total_active_hours > 0 && (
                            <span className="pm-tracking-alert-card-stat">Active <span>{fmtHoursCompact(issue.total_active_hours)}</span></span>
                          )}
                        </div>
                        {(issue.verified_on_dev || issue.verified_on_stage || issue.verified_on_prod) && (
                          <div className="pm-tracking-verif-badges" style={{ marginTop: 4 }}>
                            {issue.verified_on_dev && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--dev" title={`DEV verified by ${issue.verified_on_dev}`}>DEV✓</span>}
                            {issue.verified_on_stage && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--stage" title={`Stage verified by ${issue.verified_on_stage}`}>STG✓</span>}
                            {issue.verified_on_prod && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--prod" title={`Prod verified by ${issue.verified_on_prod}`}>PRD✓</span>}
                          </div>
                        )}
                        <div className="pm-tracking-focus-assignee">
                          {avatarSrc
                            ? <img className="pm-tracking-swimlane-avatar" src={avatarSrc} alt={issue.assignee} style={{ width: 18, height: 18 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                            : null
                          }
                          <span>{issue.assignee}</span>
                        </div>
                      </div>
                      {isExpanded && (
                        <div style={{ marginTop: 10 }}>
                          <IssueTransitionInline
                            issueId={issue.idReadable}
                            columnHierarchy={columnHierarchy}
                            onViewDetails={(logs) => setDetailIssue({ issue, logs })}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="pm-tracking-sidebar-empty">No in-progress tickets</div>
            )}
            {/* Remaining columns collapsed */}
            {filteredColumns
              .filter(c => !c.name?.toLowerCase().includes('block') && !c.name?.toLowerCase().includes('progress'))
              .map(col => (
                <div key={col.name} className="pm-tracking-column-section" style={{ marginTop: 10 }}>
                  <div
                    className="pm-tracking-col-header pm-tracking-col-header--clickable"
                    onClick={() => toggleColCollapse(col.name)}
                  >
                    <ChevronDown size={13} className={`dropdown-chevron pm-tracking-col-chevron${collapsedCols.has(col.name) ? '' : ' open'}`} />
                    <span className="pm-tracking-col-name">{col.name}</span>
                    <span className="pm-tracking-col-count">{col.issues.length}</span>
                  </div>
                  {!collapsedCols.has(col.name) && col.issues.map(issue => renderIssueRow(issue))}
                </div>
              ))
            }
          </div>
        </div>
      )}

      {/* ── Split Pane view (Design 09) ── */}
      {!loading && viewMode === 'split-pane' && (() => {
        const totalIssues = filteredColumns.flatMap(c => c.issues).length
        const doneIssues = summary?.done_issues || 0
        const pct = totalIssues > 0 ? Math.round((doneIssues / (summary?.total_issues || totalIssues)) * 100) : 0
        const r = 38, stroke = 12, circ = 2 * Math.PI * r
        const arc = circ - (pct / 100) * circ
        const sectionOrder = filteredColumns
        return (
          <div className="pm-tracking-split-layout">
            <div className="pm-tracking-split-left">
              <div>
                <div className="pm-tracking-split-sprint-name">{summary ? `${summary.done_issues} / ${summary.total_issues} done` : 'Sprint'}</div>
                {sprintDeadlineLabel && <div className="pm-tracking-split-sprint-range">{sprintDeadlineLabel}</div>}
              </div>
              <div className="pm-tracking-split-donut-wrap">
                <svg width="100" height="100" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} />
                  <circle
                    cx="50" cy="50" r={r} fill="none"
                    stroke="#6366f1" strokeWidth={stroke}
                    strokeDasharray={circ}
                    strokeDashoffset={arc}
                    strokeLinecap="round"
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <div className="pm-tracking-split-donut-center">
                  <div className="pm-tracking-split-donut-pct">{pct}%</div>
                  <div className="pm-tracking-split-donut-label">done</div>
                </div>
              </div>
              <div className="pm-tracking-split-kpi-row">
                {summary && (
                  <>
                    <div className="pm-tracking-split-kpi-line">
                      <span className="pm-tracking-split-kpi-key">Done</span>
                      <span className="pm-tracking-split-kpi-val">{summary.done_issues} / {summary.total_issues}</span>
                    </div>
                    <div className="pm-tracking-split-kpi-line">
                      <span className="pm-tracking-split-kpi-key">Blocked</span>
                      <span className={`pm-tracking-split-kpi-val${summary.blocked_count > 0 ? ' pm-tracking-split-kpi-val--danger' : ''}`}>{summary.blocked_count}</span>
                    </div>
                    <div className="pm-tracking-split-kpi-line">
                      <span className="pm-tracking-split-kpi-key">Bounced</span>
                      <span className={`pm-tracking-split-kpi-val${summary.bounced_count > 0 ? ' pm-tracking-split-kpi-val--warn' : ''}`}>{summary.bounced_count}</span>
                    </div>
                    <div className="pm-tracking-split-kpi-line">
                      <span className="pm-tracking-split-kpi-key">Ends</span>
                      <span className={`pm-tracking-split-kpi-val${sprintDeadlineLabel === 'OVERDUE' ? ' pm-tracking-split-kpi-val--danger' : ''}`}>{sprintDeadlineLabel ?? '—'}</span>
                    </div>
                  </>
                )}
              </div>
              <hr className="pm-tracking-split-divider" />
              <div>
                <div className="pm-tracking-split-section-title">Load per person</div>
                {byPersonList.map(person => {
                  const total = person.issues.length
                  const activeCount = person.issues.filter(i => i.current_state?.toLowerCase().includes('progress')).length
                  const blockedCount = person.issues.filter(i => i.current_state?.toLowerCase().includes('block')).length
                  const otherCount = total - activeCount - blockedCount
                  const avatarSrc = person.avatarUrl || avatarMap[person.name] || avatarMap[person.login]
                  return (
                    <HoverCard key={person.name} content={assigneeHoverContent(person.name, person.issues)} delay={350} maxWidth={230}>
                    <div className="pm-tracking-split-person-row">
                      {avatarSrc
                        ? <img className="pm-tracking-swimlane-avatar" src={avatarSrc} alt={person.name} style={{ width: 22, height: 22 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                        : <div className="pm-tracking-swimlane-avatar" style={{ width: 22, height: 22, fontSize: 9 }}>{getInitialsFromName(person.name)}</div>
                      }
                      <div className="pm-tracking-split-person-info">
                        <div className="pm-tracking-split-person-name">{person.name}</div>
                      </div>
                      <div className="pm-tracking-split-bar" style={{ width: 80 }}>
                        {total > 0 && <div className="pm-tracking-split-bar-seg pm-tracking-split-bar-seg--active" style={{ width: `${(activeCount / total) * 100}%` }} />}
                        {total > 0 && <div className="pm-tracking-split-bar-seg pm-tracking-split-bar-seg--blocked" style={{ width: `${(blockedCount / total) * 100}%` }} />}
                        {total > 0 && <div className="pm-tracking-split-bar-seg pm-tracking-split-bar-seg--other" style={{ width: `${(otherCount / total) * 100}%` }} />}
                      </div>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 16, textAlign: 'right' }}>{total}</span>
                    </div>
                    </HoverCard>
                  )
                })}
              </div>
            </div>
            <div className="pm-tracking-split-right">
              {sectionOrder.map(col => (
                <div key={col.name} className="pm-tracking-column-section">
                  <div className="pm-tracking-col-header">
                    <span className="pm-tracking-col-name">{col.name}</span>
                    <span className="pm-tracking-col-count">{col.issues.length}</span>
                  </div>
                  {col.issues.map(issue => renderIssueRow(issue))}
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* ── Focus Mode view (Design 10) ── */}
      {!loading && viewMode === 'focus' && (() => {
        const critical = allIssuesByDelay.filter(i => i.overdue_level === 'deadline' || i.overdue_level === 'sprint' || i.is_delayed)
        const topIssues = allIssuesByDelay.slice(0, 3)
        const restIssues = allIssuesByDelay.slice(3)
        const getUrgencyClass = (i: SprintBoardIssue) =>
          i.overdue_level === 'deadline' ? '--overdue' : (i.overdue_level === 'sprint' || i.is_delayed) ? '--atrisk' : '--normal'
        return (
          <div className="pm-tracking-focus-board">
            <div className="pm-tracking-focus-header">
              <div>
                <div className="pm-tracking-focus-header-title">Sprint Focus — {critical.length} critical</div>
                {sprintDeadlineLabel && <div className="pm-tracking-focus-header-meta">Sprint ends {sprintDeadlineLabel}</div>}
              </div>
            </div>
            {topIssues.map(issue => {
              const urgency = getUrgencyClass(issue)
              const priColors = priorityColorMap[issue.priority?.toLowerCase()] || null
              const isExpanded = expandedIssue === issue.idReadable
              const avatarSrc = issue.avatarUrl || avatarMap[issue.assignee] || avatarMap[issue.assigneeLogin]
              return (
                <HoverCard key={issue.idReadable} content={ticketHoverContent(issue)} maxWidth={290} delay={350}>
                <div className={`pm-tracking-focus-card pm-tracking-focus-card${urgency}`}>
                  <div className="pm-tracking-focus-card-top">
                    <span
                      className="pm-tracking-focus-id pm-tracking-issue-id--link"
                      onClick={(e) => openInYouTrack(issue.idReadable, e)}
                      title={`Open ${issue.idReadable} in YouTrack`}
                    >{issue.idReadable}</span>
                    {issue.overdue_level === 'deadline' && <span className="pm-tracking-overdue-badge">Overdue</span>}
                    {(issue.overdue_level === 'sprint' || issue.is_delayed) && issue.overdue_level !== 'deadline' && (
                      <span className="pm-tracking-atrisk-badge">At Risk</span>
                    )}
                    {issue.priority && (
                      <span className="pm-tracking-pri-badge" style={priColors ? { background: priColors.bg, color: priColors.text } : undefined}>
                        {issue.priority}
                      </span>
                    )}
                    {issue.is_hotfix && <span className="pm-tracking-hotfix-chip">HF</span>}
                    {issue.bounce_count > 0 && <span className="pm-tracking-bounce-badge">↩{issue.bounce_count}</span>}
                  </div>
                  <div
                    className="pm-tracking-focus-title pm-tracking-ip-card-title--clickable"
                    onClick={(e) => openYtIssue(issue.idReadable, e)}
                    title={`View ${issue.idReadable} details`}
                  >{issue.summary}</div>
                  <div className="pm-tracking-focus-stats">
                    {issue.cycle_time_hours > 0 && (
                      <div className="pm-tracking-focus-stat">
                        <span className="pm-tracking-focus-stat-label">Cycle</span>
                        <span className="pm-tracking-focus-stat-value">{fmtHoursCompact(issue.cycle_time_hours)}</span>
                      </div>
                    )}
                    <div className="pm-tracking-focus-stat">
                      <span className="pm-tracking-focus-stat-label">In State</span>
                      <span className="pm-tracking-focus-stat-value">{fmtHoursCompact(issue.hours_in_state)}</span>
                    </div>
                    {issue.bounce_count > 0 && (
                      <div className="pm-tracking-focus-stat">
                        <span className="pm-tracking-focus-stat-label">Bounces</span>
                        <span className="pm-tracking-focus-stat-value">{issue.bounce_count}</span>
                      </div>
                    )}
                    {(issue.verified_on_dev || issue.verified_on_stage || issue.verified_on_prod) && (
                      <div className="pm-tracking-focus-stat">
                        <span className="pm-tracking-focus-stat-label">Verified</span>
                        <div className="pm-tracking-verif-badges">
                          {issue.verified_on_dev && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--dev" title={issue.verified_on_dev}>DEV</span>}
                          {issue.verified_on_stage && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--stage" title={issue.verified_on_stage}>STG</span>}
                          {issue.verified_on_prod && <span className="pm-tracking-verif-chip pm-tracking-verif-chip--prod" title={issue.verified_on_prod}>PRD</span>}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="pm-tracking-focus-footer">
                    <div className="pm-tracking-focus-assignee">
                      {avatarSrc
                        ? <img className="pm-tracking-swimlane-avatar" src={avatarSrc} alt={issue.assignee} style={{ width: 20, height: 20 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                        : null
                      }
                      <span>{issue.assignee}</span>
                    </div>
                    <button className="pm-tracking-focus-expand-btn" onClick={() => setExpandedIssue(isExpanded ? null : issue.idReadable)}>
                      {isExpanded ? 'Collapse' : 'View Timeline'}
                    </button>
                  </div>
                  {isExpanded && (
                    <div style={{ marginTop: 12 }}>
                      <IssueTransitionInline
                        issueId={issue.idReadable}
                        columnHierarchy={columnHierarchy}
                        onViewDetails={(logs) => setDetailIssue({ issue, logs })}
                      />
                    </div>
                  )}
                </div>
                </HoverCard>
              )
            })}
            {!showAllFocus && restIssues.length > 0 && (
              <button className="pm-tracking-focus-show-more" onClick={() => setShowAllFocus(true)}>
                Show {restIssues.length} more ticket{restIssues.length !== 1 ? 's' : ''}
              </button>
            )}
            {showAllFocus && restIssues.length > 0 && (
              <div className="pm-tracking-focus-rest">
                {restIssues.map(issue => renderIssueRow(issue))}
              </div>
            )}
          </div>
        )
      })()}

      {/* ── QA Pipeline view ── */}
      {!loading && viewMode === 'qa-pipeline' && (() => {
        const qaPersonEntries = Array.from(qaByPerson.entries()).sort((a, b) => {
          const ta = a[1].devVerified.length + a[1].stageVerified.length + a[1].prodVerified.length
          const tb = b[1].devVerified.length + b[1].stageVerified.length + b[1].prodVerified.length
          return tb - ta
        })
        const isPendingDev = (i: SprintBoardIssue) =>
          !i.verified_on_dev && ((i.total_active_hours || 0) > 0 || (i.bounce_count || 0) > 0)
        const isPendingStg = (i: SprintBoardIssue) =>
          !!i.verified_on_dev && !i.verified_on_stage
        const isPendingPrd = (i: SprintBoardIssue) =>
          !!i.verified_on_stage && !i.verified_on_prod
        const qaScore = (i: SprintBoardIssue) =>
          (i.verified_on_dev ? 1 : 0) + (i.verified_on_stage ? 1 : 0) + (i.verified_on_prod ? 1 : 0)
        const displayIssues = qaFilterMode === 'needs-qa'
          ? qaAllIssues.filter(i => isPendingDev(i) || isPendingStg(i) || isPendingPrd(i))
          : qaAllIssues
        const totalVerified = qaAllIssues.filter(i => qaScore(i) === 3).length
        const totalPending = qaAllIssues.filter(i => isPendingDev(i) || isPendingStg(i) || isPendingPrd(i)).length
        const totalNone = qaAllIssues.filter(i => qaScore(i) === 0 && !isPendingDev(i)).length

        const VerifCell = ({ verified, pending, name }: { verified: string; pending: boolean; name: string }) => {
          const initials = verified ? verified.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : ''
          if (verified) return (
            <div className="pm-qa-verif-cell pm-qa-verif-cell--yes">
              <div className="pm-qa-verif-avatar">{initials}</div>
              <div className="pm-qa-verif-info">
                <span className="pm-qa-verif-name">{verified}</span>
                <span className="pm-qa-verif-badge pm-qa-verif-badge--done"><Check size={9} /> verified</span>
              </div>
            </div>
          )
          if (pending) return (
            <div className="pm-qa-verif-cell pm-qa-verif-cell--pending">
              <div className="pm-qa-verif-pending-icon"><Clock size={12} /></div>
              <div className="pm-qa-verif-info">
                <span className="pm-qa-verif-name pm-qa-verif-name--pending">Pending</span>
                <span className="pm-qa-verif-badge pm-qa-verif-badge--wait">awaiting {name}</span>
              </div>
            </div>
          )
          return (
            <div className="pm-qa-verif-cell pm-qa-verif-cell--none">
              <span className="pm-qa-verif-dash">—</span>
            </div>
          )
        }

        return (
          <div className="pm-qa-pipeline">
            {/* QA Load section */}
            {qaPersonEntries.length > 0 && (
              <div className="pm-qa-load-section">
                <div className="pm-qa-load-title">
                  <ShieldCheck size={13} />
                  <span>QA Load This Sprint</span>
                </div>
                <div className="pm-qa-load-cards">
                  {qaPersonEntries.map(([name, qa]) => {
                    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
                    return (
                      <div key={name} className="pm-qa-load-card">
                        <div className="pm-qa-load-card-person">
                          <div className="pm-qa-load-avatar">{initials}</div>
                          <span className="pm-qa-load-name">{name}</span>
                        </div>
                        <div className="pm-qa-load-counts">
                          {qa.devVerified.length > 0 && (
                            <span className="pm-qa-load-count pm-qa-load-count--dev">
                              DEV ×{qa.devVerified.length}
                            </span>
                          )}
                          {qa.stageVerified.length > 0 && (
                            <span className="pm-qa-load-count pm-qa-load-count--stg">
                              STG ×{qa.stageVerified.length}
                            </span>
                          )}
                          {qa.prodVerified.length > 0 && (
                            <span className="pm-qa-load-count pm-qa-load-count--prd">
                              PRD ×{qa.prodVerified.length}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {/* Summary stats card */}
                  <div className="pm-qa-load-card pm-qa-load-card--summary">
                    <div className="pm-qa-load-summary-row">
                      <span className="pm-qa-summary-dot pm-qa-summary-dot--green" />
                      <span className="pm-qa-summary-label">Fully verified</span>
                      <span className="pm-qa-summary-val">{totalVerified}</span>
                    </div>
                    <div className="pm-qa-load-summary-row">
                      <span className="pm-qa-summary-dot pm-qa-summary-dot--amber" />
                      <span className="pm-qa-summary-label">Needs QA</span>
                      <span className="pm-qa-summary-val">{totalPending}</span>
                    </div>
                    <div className="pm-qa-load-summary-row">
                      <span className="pm-qa-summary-dot pm-qa-summary-dot--gray" />
                      <span className="pm-qa-summary-label">Not started</span>
                      <span className="pm-qa-summary-val">{totalNone}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Filter toggle */}
            <div className="pm-qa-filter-bar">
              <button
                className={`pm-qa-filter-btn${qaFilterMode === 'all' ? ' active' : ''}`}
                onClick={() => setQaFilterMode('all')}
              >
                All tickets <span className="pm-qa-filter-count">{qaAllIssues.length}</span>
              </button>
              <button
                className={`pm-qa-filter-btn${qaFilterMode === 'needs-qa' ? ' active' : ''}`}
                onClick={() => setQaFilterMode('needs-qa')}
              >
                <Shield size={11} /> Needs QA <span className="pm-qa-filter-count pm-qa-filter-count--amber">{totalPending}</span>
              </button>
            </div>

            {/* Matrix table */}
            <div className="pm-qa-matrix">
              {/* Header */}
              <div className="pm-qa-matrix-header">
                <div className="pm-qa-col-ticket">Ticket</div>
                <div className="pm-qa-col-assignee">Assignee</div>
                <div className="pm-qa-col-stage pm-qa-col-stage--dev">
                  <span className="pm-qa-stage-dot pm-qa-stage-dot--dev" /> DEV
                </div>
                <div className="pm-qa-col-stage pm-qa-col-stage--stg">
                  <span className="pm-qa-stage-dot pm-qa-stage-dot--stg" /> STAGE
                </div>
                <div className="pm-qa-col-stage pm-qa-col-stage--prd">
                  <span className="pm-qa-stage-dot pm-qa-stage-dot--prd" /> PROD
                </div>
              </div>

              {/* Rows */}
              {displayIssues.length === 0 && (
                <div className="pm-qa-empty">
                  <ShieldCheck size={28} style={{ opacity: 0.2 }} />
                  <span>No tickets match the current filter</span>
                </div>
              )}
              {displayIssues.map(issue => {
                const score = qaScore(issue)
                const edgeClass = score === 3 ? ' pm-qa-row--full'
                  : (isPendingDev(issue) || isPendingStg(issue) || isPendingPrd(issue)) ? ' pm-qa-row--pending'
                  : score > 0 ? ' pm-qa-row--partial'
                  : ''
                const priColors = priorityColorMap[issue.priority?.toLowerCase()] || null
                const avatarSrc = issue.avatarUrl || avatarMap[issue.assignee] || avatarMap[issue.assigneeLogin]
                const isExpanded = expandedIssue === issue.idReadable
                return (
                  <React.Fragment key={issue.id || issue.idReadable}>
                    <div className={`pm-qa-row${edgeClass}`} onClick={() => setExpandedIssue(isExpanded ? null : issue.idReadable)}>
                      {/* Ticket cell */}
                      <div className="pm-qa-cell pm-qa-cell--ticket">
                        <div className="pm-qa-ticket-top">
                          <span
                            className="pm-qa-ticket-id pm-tracking-issue-id--link"
                            onClick={(e) => openInYouTrack(issue.idReadable || issue.id, e)}
                            title={`Open ${issue.idReadable} in YouTrack`}
                          >
                            {issue.idReadable}
                          </span>
                          {issue.priority && (
                            <span className="pm-tracking-pri-badge" style={priColors ? { background: priColors.bg, color: priColors.text } : undefined}>
                              {issue.priority}
                            </span>
                          )}
                          {issue.is_hotfix && <span className="pm-tracking-hotfix-chip"><Zap size={9} /> HF</span>}
                          {issue.bounce_count > 0 && (
                            <span className="pm-tracking-bounce-badge">↩{issue.bounce_count}</span>
                          )}
                        </div>
                        <div
                          className="pm-qa-ticket-title pm-tracking-ip-card-title--clickable"
                          title={`View ${issue.idReadable} details`}
                          onClick={(e) => openYtIssue(issue.idReadable || issue.id, e)}
                        >{issue.summary}</div>
                        <div className="pm-qa-ticket-state">{issue.current_state}</div>
                      </div>

                      {/* Assignee cell */}
                      <div className="pm-qa-cell pm-qa-cell--assignee">
                        {avatarSrc
                          ? <img className="pm-tracking-avatar" src={avatarSrc} alt={issue.assignee} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.removeAttribute('style') }} />
                          : null}
                        <div className="pm-tracking-avatar pm-tracking-avatar--initials" style={avatarSrc ? { display: 'none' } : undefined}>
                          {getInitialsFromName(issue.assignee)}
                        </div>
                        <span className="pm-qa-assignee-name">{issue.assignee || 'Unassigned'}</span>
                      </div>

                      {/* DEV cell */}
                      <div className="pm-qa-cell pm-qa-cell--stage">
                        <HoverCard content={qaStageHoverContent('DEV', issue.verified_on_dev, issue)} maxWidth={220}>
                          <VerifCell verified={issue.verified_on_dev} pending={isPendingDev(issue)} name="DEV" />
                        </HoverCard>
                      </div>

                      {/* STAGE cell */}
                      <div className="pm-qa-cell pm-qa-cell--stage">
                        <HoverCard content={qaStageHoverContent('STAGE', issue.verified_on_stage, issue)} maxWidth={220}>
                          <VerifCell verified={issue.verified_on_stage} pending={isPendingStg(issue)} name="STAGE" />
                        </HoverCard>
                      </div>

                      {/* PROD cell */}
                      <div className="pm-qa-cell pm-qa-cell--stage">
                        <HoverCard content={qaStageHoverContent('PROD', issue.verified_on_prod, issue)} maxWidth={220}>
                          <VerifCell verified={issue.verified_on_prod} pending={isPendingPrd(issue)} name="PROD" />
                        </HoverCard>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="pm-qa-expand-row">
                        <IssueTransitionInline
                          issueId={issue.idReadable || issue.id}
                          columnHierarchy={columnHierarchy}
                          onViewDetails={(logs) => setDetailIssue({ issue, logs })}
                        />
                      </div>
                    )}
                  </React.Fragment>
                )
              })}
            </div>

            {qaPersonEntries.length === 0 && qaAllIssues.every(i => !i.verified_on_dev && !i.verified_on_stage && !i.verified_on_prod) && (
              <div className="pm-qa-no-data">
                <ShieldCheck size={32} style={{ opacity: 0.15 }} />
                <div className="pm-qa-no-data-title">No QA verifications recorded yet</div>
                <div className="pm-qa-no-data-hint">
                  Verifications are attributed when someone moves a ticket to Ready for Stage, Ready for Prod, or Verified.
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Assignee view ── */}
      {!loading && viewMode === 'assignee' && (
        <div className="pm-tracking-board">
          {byAssignee.map(group => {
            const isCollapsed = collapsedCols.has(group.assignee)
            const avatarSrc = group.avatarUrl || avatarMap[group.assignee] || avatarMap[group.login]
            return (
            <div key={group.assignee} className="pm-tracking-column-section">
              <div className="pm-tracking-col-header pm-tracking-assignee-group-header pm-tracking-col-header--clickable" onClick={() => toggleColCollapse(group.assignee)}>
                <ChevronDown size={13} className={`dropdown-chevron pm-tracking-col-chevron${isCollapsed ? '' : ' open'}`} />
                {avatarSrc
                  ? <img className="pm-tracking-avatar" src={avatarSrc} alt={group.assignee} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  : <div className="pm-tracking-avatar pm-tracking-avatar--initials">{getInitialsFromName(group.assignee)}</div>
                }
                <span className="pm-tracking-col-name">{group.assignee}</span>
                <span className="pm-tracking-col-count">{group.issues.length}</span>
                {group.issues.filter(i => i.is_delayed).length > 0 && (
                  <span className="pm-tracking-col-delayed">
                    <AlertTriangle size={11} /> {group.issues.filter(i => i.is_delayed).length} delayed
                  </span>
                )}
                {group.issues.filter(i => i.bounce_count > 0).length > 0 && (
                  <span className="pm-tracking-col-bounced">
                    ↩ {group.issues.filter(i => i.bounce_count > 0).length} bounced
                  </span>
                )}
              </div>
              {!isCollapsed && (
                <>
                  <div className="pm-tracking-assignee-stats">
                    <span>{group.issues.length} ticket{group.issues.length !== 1 ? 's' : ''}</span>
                    {group.issues.reduce((s, i) => s + (i.total_active_hours || 0), 0) > 0 && (
                      <span>{fmtHoursCompact(group.issues.reduce((s, i) => s + (i.total_active_hours || 0), 0))} dev time</span>
                    )}
                    {group.issues.filter(i => i.bounce_count > 0).length > 0 && (
                      <span>↩{group.issues.reduce((s, i) => s + (i.bounce_count || 0), 0)} bounces</span>
                    )}
                  </div>
                  <div className="pm-tracking-issue-row pm-tracking-col-header-row">
                    <span className="pm-tracking-issue-id pm-tracking-col-heading">Ticket</span>
                    <span className="pm-tracking-col-heading">Pri</span>
                    <span className="pm-tracking-issue-summary pm-tracking-col-heading">Title</span>
                    <span className="pm-tracking-cycle-time pm-tracking-col-heading">Cycle</span>
                    <span className="pm-tracking-time pm-tracking-col-heading">In State</span>
                    <span className="pm-tracking-verif-badges pm-tracking-col-heading">Verified</span>
                    <span className="pm-tracking-assignee-cell pm-tracking-col-heading">Column</span>
                  </div>
                  {group.issues.map(issue => renderIssueRow(issue, true))}
                  {/* QA verified subsection */}
                  {(() => {
                    const qa = qaByPerson.get(group.assignee)
                    if (!qa || (qa.devVerified.length + qa.stageVerified.length + qa.prodVerified.length === 0)) return null
                    return (
                      <div className="pm-tracking-qa-section">
                        <span className="pm-tracking-qa-label">QA Verified by {group.assignee}:</span>
                        {qa.devVerified.length > 0 && (
                          <div className="pm-tracking-qa-row">
                            <span className="pm-tracking-verif-chip pm-tracking-verif-chip--dev">DEV</span>
                            <span>{qa.devVerified.map(i => i.idReadable).join(', ')}</span>
                          </div>
                        )}
                        {qa.stageVerified.length > 0 && (
                          <div className="pm-tracking-qa-row">
                            <span className="pm-tracking-verif-chip pm-tracking-verif-chip--stage">STG</span>
                            <span>{qa.stageVerified.map(i => i.idReadable).join(', ')}</span>
                          </div>
                        )}
                        {qa.prodVerified.length > 0 && (
                          <div className="pm-tracking-qa-row">
                            <span className="pm-tracking-verif-chip pm-tracking-verif-chip--prod">PRD</span>
                            <span>{qa.prodVerified.map(i => i.idReadable).join(', ')}</span>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </>
              )}
            </div>
            )
          })}
        </div>
      )}

      {/* ── Dev Time view ── */}
      {viewMode === 'dev-time' && (() => {
        const sk = (w: number | string, h: number, r = 5) => (
          <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
        )
        return (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Variant tab strip */}
            <div style={{ display: 'flex', gap: 4, padding: '6px 20px', borderBottom: '1px solid var(--border-color)', flexShrink: 0, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4 }}>View</span>
              {([
                { id: 'a' as DevTimeVariant, label: 'Time Ledger' },
                { id: 'b' as DevTimeVariant, label: 'Dev Cards' },
                { id: 'c' as DevTimeVariant, label: 'Gantt' },
              ]).map(v => (
                <button
                  key={v.id}
                  className="pm-tt-variant-tab"
                  data-active={String(devTimeVariant === v.id)}
                  onClick={() => setDevTimeVariant(v.id)}
                >
                  {v.label}
                </button>
              ))}
              <button
                style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => { setDevTimeTimelines([]); getIssueTimelines(sprintStartMs, sprintFinishMs).then(res => setDevTimeTimelines(res.data ?? [])).catch(() => {}) }}
              >
                <RefreshCw size={11} /> Refresh
              </button>
            </div>

            {devTimeTimelines.length === 0 ? (
              /* Skeleton loader */
              <div style={{ flex: 1, overflow: 'hidden', padding: '10px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* KPI chips skeleton */}
                <div style={{ display: 'flex', gap: 8, paddingBottom: 10, borderBottom: '1px solid var(--border-color)' }}>
                  {[110, 110, 120, 130].map((w, i) => (
                    <div key={i} className="skeleton" style={{ width: w, height: 36, borderRadius: 8 }} />
                  ))}
                </div>
                {/* Content skeleton — changes by variant */}
                {devTimeVariant === 'b' ? (
                  /* Dev Cards grid skeleton */
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))', gap: 14 }}>
                    {[0,1,2].map(ci => (
                      <div key={ci} className="skeleton" style={{ height: 220, borderRadius: 14 }} />
                    ))}
                  </div>
                ) : devTimeVariant === 'c' ? (
                  /* Gantt skeleton */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {sk('100%', 32, 6)}
                    {[0,1,2,3].map(ri => (
                      <div key={ri} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        {sk(140, 44, 8)}
                        {sk('70%', 24, 6)}
                      </div>
                    ))}
                  </div>
                ) : (
                  /* Time Ledger (A) table skeleton */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {sk('100%', 32, 6)}
                    {[0,1,2].map(gi => (
                      <React.Fragment key={gi}>
                        {sk('100%', 36, 6)}
                        {[0,1,2,3].map(ri => (
                          <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 0 28px' }}>
                            {sk(10, 10, 2)}
                            {sk(80, 20, 4)}
                            {sk(44, 18, 4)}
                            {sk('40%', 12, 4)}
                            {sk(72, 20, 4)}
                            {sk(24, 12, 3)}
                            {sk(50, 12, 3)}
                          </div>
                        ))}
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <DevTimeView
                timelines={devTimeTimelines}
                variant={devTimeVariant}
                sprintStartMs={sprintStartMs}
                sprintFinishMs={sprintFinishMs}
                boardIssues={boardColumns.flatMap(col => col.issues)}
                onTicketClick={async (issueId) => {
                  setYtDetailLoading(true)
                  try {
                    const res = await api.getYouTrackIssue(issueId)
                    const issue = (res as any).data as import('../services/api').YouTrackIssue
                    if (issue) setYtDetailIssue(issue)
                  } catch {}
                  finally { setYtDetailLoading(false) }
                }}
                ytBaseUrl={ytBaseUrl}
              />
            )}
          </div>
        )
      })()}

      {/* ── Feature Groups view ── */}
      {viewMode === 'feature-groups' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '0 20px' }}>
          <FeatureGroupsView
            sprintId={sprintId || undefined}
            groups={featureGroups}
            loading={featureGroupsLoading}
            onRefresh={() => {
              if (!sprintId) return
              featureGroupsSprintRef.current = undefined
              setFeatureGroups([])
              setFeatureGroupsLoading(true)
              api.getFeatureGroups(sprintId)
                .then(res => setFeatureGroups((res as any).data ?? []))
                .catch(() => {})
                .finally(() => setFeatureGroupsLoading(false))
            }}
          />
        </div>
      )}

      {/* ── Transition history modal ── */}
      {detailIssue && (
        <IssueDetailModal
          issue={detailIssue.issue}
          logs={detailIssue.logs}
          columnHierarchy={columnHierarchy}
          onClose={() => setDetailIssue(null)}
          ytBaseUrl={ytBaseUrl}
        />
      )}

      {/* ── YouTrack issue detail panel ── */}
      {ytDetailIssue && (
        <IssueDetailPanel
          issue={ytDetailIssue}
          onClose={() => setYtDetailIssue(null)}
          ytBaseUrl={ytBaseUrl}
        />
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

// ─── Deployment Report Tab ───────────────────────────────────────────────────

// ─── YouTrack Deployment Report ──────────────────────────────────────────────

type DRTicketStatus = 'pending' | 'generating' | 'done' | 'failed'

interface DRTicket {
  id: string
  idReadable: string
  summary: string
  description: string
  issueType: string
  subsystem: string
  ytUrl: string
  updatedAt: number
  fixStatement: string | null
  status: DRTicketStatus
  error?: string
}

// Type → display category label, in render order
const TYPE_CATEGORY_ORDER = ['Features', 'Enhancements', 'Bug Fixes', 'Hotfixes', 'Other']

const DR_TYPE_CATEGORIES: Record<string, string> = {
  bug:         'Bug Fixes',
  regression:  'Bug Fixes',
  feature:     'Features',
  epic:        'Features',
  enhancement: 'Enhancements',
  hotfix:      'Hotfixes',
}

function drCategory(issueType: string): string {
  return DR_TYPE_CATEGORIES[issueType.toLowerCase()] ?? 'Other'
}

const DR_TYPE_COLORS: Record<string, string> = {
  Bug:         'drt-type--bug',
  Regression:  'drt-type--bug',
  Feature:     'drt-type--feature',
  Epic:        'drt-type--feature',
  Enhancement: 'drt-type--enhancement',
  Hotfix:      'drt-type--hotfix',
}

function drTypeClass(issueType: string): string {
  return DR_TYPE_COLORS[issueType] ?? 'drt-type--other'
}

// Subsystem sort order used within each type section
const SUBSYSTEM_ORDER = ['FE UI', 'BE UI', 'FE Studio', 'BE Studio', 'FE MC', 'BE MC', 'BE RAG']

function subsystemRank(subsystem: string): number {
  const idx = SUBSYSTEM_ORDER.indexOf((subsystem ?? '').trim())
  return idx === -1 ? SUBSYSTEM_ORDER.length : idx
}

// Returns subsystem label to display (pass-through known ones, "Others" for unknown)
function subsystemLabel(subsystem: string): string {
  const norm = (subsystem ?? '').trim()
  return norm || 'Others'
}

// Sections are TYPE-based (Features / Enhancements / Bug Fixes / Hotfixes / Other).
// Within each section tickets are sorted by subsystem order.
function buildTypeSections(tickets: DRTicket[]): Array<{ label: string; items: DRTicket[] }> {
  const map = new Map<string, DRTicket[]>()
  for (const t of tickets) {
    if (t.status !== 'done' || !t.fixStatement) continue
    const cat = drCategory(t.issueType)
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(t)
  }
  const sections: Array<{ label: string; items: DRTicket[] }> = []
  for (const label of TYPE_CATEGORY_ORDER) {
    const items = map.get(label)
    if (!items?.length) continue
    items.sort((a, b) => subsystemRank(a.subsystem) - subsystemRank(b.subsystem))
    sections.push({ label, items })
  }
  return sections
}

// Line format: "ARD-123 FE UI: fix statement"
function formatLine(t: DRTicket): string {
  const sub = subsystemLabel(t.subsystem)
  return `${t.idReadable} ${sub}: ${t.fixStatement}`
}

function buildDeployReport(tickets: DRTicket[]): string {
  const sections = buildTypeSections(tickets)
  const parts: string[] = ['Hey team 👋 here is the list of changes in this deployment:']
  for (const { label, items } of sections) {
    parts.push(`${label}\n${items.map(t => formatLine(t)).join('\n')}`)
  }
  return parts.join('\n\n')
}

function buildDeployReportHtml(tickets: DRTicket[]): string {
  const sections = buildTypeSections(tickets)
  const parts: string[] = ['<p>Hey team 👋 here is the list of changes in this deployment:</p>']
  for (const { label, items } of sections) {
    parts.push(`<p>${label}</p><ul>`)
    for (const t of items) {
      const sub = subsystemLabel(t.subsystem)
      const idPart = t.ytUrl
        ? `<a href="${t.ytUrl}">${t.idReadable}</a>`
        : t.idReadable
      parts.push(`<li>${idPart} ${sub}: ${t.fixStatement}</li>`)
    }
    parts.push('</ul><p>&nbsp;</p>')
  }
  return parts.join('')
}

function YouTrackStageReport({ sprintId, sprintName }: { sprintId?: string; sprintName?: string }) {
  const [columns, setColumns] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadingCols, setLoadingCols] = useState(true)
  const [loadingTickets, setLoadingTickets] = useState(false)
  const [tickets, setTickets] = useState<DRTicket[]>([])
  const [genStatus, setGenStatus] = useState<'idle' | 'generating' | 'waiting' | 'retrying' | 'done'>('idle')
  const [progress, setProgress] = useState(0)
  const [countdown, setCountdown] = useState(0)
  const [report, setReport] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'yesterday'>('all')
  const abortRef = useRef(false)

  const fetchColumns = useCallback(async () => {
    setLoadingCols(true)
    try {
      const res = await getStageReportColumns()
      if ((res as any).success && (res as any).data) setColumns((res as any).data)
    } catch {
      setError('Failed to load columns. Check YouTrack connection.')
    } finally {
      setLoadingCols(false)
    }
  }, [])

  useEffect(() => { fetchColumns() }, [fetchColumns])

  const toggleColumn = (col: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(col)) next.delete(col)
      else next.add(col)
      return next
    })
    // Clear previous results when columns change
    setTickets([])
    setReport(null)
    setGenStatus('idle')
    setProgress(0)
  }

  const handleLoadTickets = async () => {
    if (selected.size === 0) return
    setLoadingTickets(true)
    setError(null)
    setTickets([])
    setReport(null)
    setGenStatus('idle')
    setProgress(0)
    try {
      const res = await api.getDeploymentTickets([...selected], sprintId)
      const payload = (res as any).data as { tickets: Array<{ id: string; id_readable: string; summary: string; description: string; issue_type: string; subsystem: string; updated_at?: number }>; base_url: string } | undefined
      const data = payload?.tickets
      const baseUrl = (payload?.base_url ?? '').replace(/\/$/, '')
      if (!data?.length) {
        setError(`No tickets found${sprintName ? ` in ${sprintName}` : ''} for the selected columns.`)
        return
      }
      setTickets(data.map(t => ({
        id: t.id,
        idReadable: t.id_readable,
        summary: t.summary,
        description: t.description,
        issueType: t.issue_type,
        subsystem: t.subsystem ?? '',
        ytUrl: baseUrl ? `${baseUrl}/issue/${t.id_readable}` : '',
        updatedAt: t.updated_at ?? 0,
        fixStatement: null,
        status: 'pending',
      })))
    } catch {
      setError('Failed to load tickets.')
    } finally {
      setLoadingTickets(false)
    }
  }

  const isGenerating = genStatus === 'generating' || genStatus === 'waiting' || genStatus === 'retrying'

  const filteredTickets = useMemo(() => {
    if (dateFilter === 'all') return tickets
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const yestStart = new Date(todayStart); yestStart.setDate(yestStart.getDate() - 1)
    const todayMs = todayStart.getTime()
    const yestMs  = yestStart.getTime()
    return tickets.filter(t => {
      if (!t.updatedAt) return false
      if (dateFilter === 'today')     return t.updatedAt >= todayMs
      if (dateFilter === 'yesterday') return t.updatedAt >= yestMs && t.updatedAt < todayMs
      return true
    })
  }, [tickets, dateFilter])

  const donePct = filteredTickets.length > 0 ? Math.round((progress / filteredTickets.length) * 100) : 0
  const typeCounts = filteredTickets.reduce<Record<string, number>>((acc, t) => {
    acc[t.issueType] = (acc[t.issueType] ?? 0) + 1
    return acc
  }, {})

  const handleGenerate = useCallback(async () => {
    if (!filteredTickets.length) return
    abortRef.current = false
    setGenStatus('generating')
    setReport(null)
    setError(null)
    setProgress(0)

    const queue: DRTicket[] = filteredTickets.map(t => ({ ...t, status: 'pending' as DRTicketStatus, fixStatement: null, error: undefined }))
    setTickets([...queue])

    const processTicket = async (idx: number): Promise<void> => {
      if (abortRef.current) return
      const t = queue[idx]

      // Mark as generating
      queue[idx] = { ...t, status: 'generating' }
      setTickets([...queue])

      while (true) {
        const res = await api.generateDeploymentTicket({
          id: t.id,
          id_readable: t.idReadable,
          summary: t.summary,
          description: t.description,
          issue_type: t.issueType,
        })

        if (res.rateLimited) {
          const secs = res.retryAfter ?? 30
          setGenStatus('waiting')
          setCountdown(secs)
          for (let s = secs; s > 0; s--) {
            if (abortRef.current) return
            setCountdown(s)
            await new Promise(r => setTimeout(r, 1000))
          }
          setCountdown(0)
          setGenStatus('generating')
          continue // retry same ticket
        }

        if (res.fixStatement) {
          queue[idx] = { ...t, status: 'done', fixStatement: res.fixStatement }
        } else {
          queue[idx] = { ...t, status: 'failed', error: res.error ?? 'Failed' }
        }
        setTickets([...queue])
        setProgress(queue.filter(x => x.status === 'done' || x.status === 'failed').length)
        break
      }
    }

    // Process all tickets sequentially
    for (let i = 0; i < queue.length; i++) {
      if (abortRef.current) break
      await processTicket(i)
    }

    if (abortRef.current) return

    // Retry failed tickets once
    const failedIdxs = queue.map((t, i) => i).filter(i => queue[i].status === 'failed')
    if (failedIdxs.length > 0) {
      setGenStatus('retrying')
      for (const idx of failedIdxs) {
        if (abortRef.current) break
        await processTicket(idx)
      }
    }

    setGenStatus('done')
    setReport(buildDeployReport(queue))
    setProgress(queue.filter(x => x.status === 'done').length)
  }, [filteredTickets])

  const handleCopy = async () => {
    if (!report) return
    try {
      const htmlContent = buildDeployReportHtml(tickets)
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html':  new Blob([htmlContent], { type: 'text/html' }),
          'text/plain': new Blob([report],       { type: 'text/plain' }),
        }),
      ])
    } catch {
      // Fallback: plain text only (unsupported browser / denied permission)
      navigator.clipboard.writeText(report)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <div className="pm-tab-header">
        <div className="pm-tab-header-row">
          <h3 className="pm-section-title"><Rocket size={18} /> Deployment Report</h3>
          {sprintName && <span className="drt-sprint-badge">{sprintName}</span>}
        </div>
        <p className="sr-subtitle">Select columns{sprintName ? ` from ${sprintName}` : ''}, load tickets, then generate AI fix statements categorised by type.</p>
      </div>

      {/* Column selector */}
      <div className="sr-section">
        <div className="sr-section-header">
          <span className="sr-section-title">Select Columns</span>
          <span className="sr-section-hint">Pick one or more columns to include</span>
        </div>
        {loadingCols ? (() => {
          const pillW = [88, 110, 72, 95, 80, 65, 105, 78, 92, 60]
          return (
            <div className="sr-columns" style={{ pointerEvents: 'none' }}>
              {pillW.map((w, i) => <div key={i} className="skeleton" style={{ width: w, height: 32, borderRadius: 20, flexShrink: 0 }} />)}
            </div>
          )
        })()
        : columns.length === 0 ? (
          <div className="sr-empty">No columns found. Ensure YouTrack is connected in Integrations.</div>
        ) : (
          <div className="sr-columns">
            {columns.map(col => (
              <button key={col} className={`sr-column-pill${selected.has(col) ? ' selected' : ''}`} onClick={() => toggleColumn(col)}>
                {selected.has(col) && <Check size={12} />}{col}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Load tickets action */}
      <div className="sr-actions">
        <button className="btn btn-secondary" onClick={handleLoadTickets} disabled={selected.size === 0 || loadingTickets || isGenerating}>
          {loadingTickets ? <RefreshCw size={14} className="sr-spin" /> : <Filter size={14} />}
          {loadingTickets ? 'Loading…' : 'Load Tickets'}
        </button>
        {selected.size > 0 && <span className="sr-selected-hint">{selected.size} column{selected.size !== 1 ? 's' : ''} selected</span>}
      </div>

      {error && <div className="sr-error">{error}</div>}

      {/* Ticket list + type summary */}
      {tickets.length > 0 && (
        <div className="drt-ticket-panel">
          <div className="drt-ticket-panel-header">
            <div className="drt-ticket-panel-left">
              <span className="drt-ticket-count">
                {filteredTickets.length !== tickets.length
                  ? <>{filteredTickets.length} <span className="drt-ticket-count-total">of {tickets.length}</span></>
                  : <>{tickets.length}</>
                } tickets
              </span>
              <div className="drt-date-filter">
                {(['all', 'today', 'yesterday'] as const).map(f => (
                  <button key={f} className={`drt-date-pill${dateFilter === f ? ' active' : ''}`} onClick={() => setDateFilter(f)}>
                    {f === 'all' ? 'All' : f === 'today' ? 'Updated today' : 'Yesterday'}
                  </button>
                ))}
              </div>
            </div>
            <div className="drt-type-pills">
              {Object.entries(typeCounts).map(([type, n]) => (
                <span key={type} className={`drt-type-pill ${drTypeClass(type)}`}>{type} {n}</span>
              ))}
            </div>
          </div>
          <div className="drt-ticket-list">
            {filteredTickets.map(t => (
              <div key={t.id} className={`drt-ticket-row drt-ticket-row--${t.status}`}>
                {t.ytUrl
                  ? <a href={t.ytUrl} target="_blank" rel="noreferrer" className="drt-ticket-id drt-ticket-id--link">{t.idReadable}</a>
                  : <span className="drt-ticket-id">{t.idReadable}</span>
                }
                <span className={`drt-type-badge ${drTypeClass(t.issueType)}`}>{t.subsystem || t.issueType}</span>
                <span className="drt-ticket-summary">{t.summary}</span>
                <span className="drt-ticket-status">
                  {t.status === 'pending'    && <span className="drt-status-dot drt-status-dot--pending" />}
                  {t.status === 'generating' && <RefreshCw size={12} className="sr-spin drt-status-spin" />}
                  {t.status === 'done'       && <Check size={13} className="drt-status-done" />}
                  {t.status === 'failed'     && <X size={13} className="drt-status-fail" />}
                </span>
              </div>
            ))}
          </div>

          {/* Generate button + progress */}
          <div className="drt-gen-controls">
            {genStatus === 'idle' || genStatus === 'done' ? (
              <button className="btn btn-primary" onClick={handleGenerate} disabled={isGenerating || filteredTickets.length === 0}>
                <Rocket size={14} /> Generate Report ({filteredTickets.length} tickets)
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => { abortRef.current = true; setGenStatus('idle') }}>
                <X size={14} /> Cancel
              </button>
            )}

            {(isGenerating || genStatus === 'done') && (
              <div className="drt-progress-wrap">
                <div className="drt-progress-bar">
                  <div className="drt-progress-fill" style={{ width: `${donePct}%` }} />
                </div>
                <span className="drt-progress-label">
                  {genStatus === 'waiting'
                    ? <><Timer size={12} /> Rate limit — resuming in {countdown}s</>
                    : genStatus === 'retrying'
                    ? <><RefreshCw size={12} className="sr-spin" /> Retrying failed tickets…</>
                    : genStatus === 'done'
                    ? <><Check size={12} /> Done — {progress} / {filteredTickets.length} generated</>
                    : <><RefreshCw size={12} className="sr-spin" /> {progress} / {filteredTickets.length} processed</>
                  }
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Report output */}
      {report !== null && (
        <div className="sr-result">
          <div className="sr-result-header">
            <span className="sr-result-meta">{tickets.filter(t => t.status === 'done').length} fix statements generated</span>
            <button className="sr-copy-btn" onClick={handleCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="drt-report-preview">
            {buildTypeSections(tickets).map(({ label, items }) => (
              <div key={label} className="drt-report-section">
                <div className="drt-report-section-title">{label} <span className="drt-report-section-count">{items.length}</span></div>
                <ul className="drt-report-list">
                  {items.map(t => (
                    <li key={t.id} className="drt-report-item">
                      {t.ytUrl
                        ? <a href={t.ytUrl} target="_blank" rel="noreferrer" className="drt-report-id">{t.idReadable}</a>
                        : <span className="drt-report-id">{t.idReadable}</span>
                      }
                      <span className="drt-report-subsystem">{subsystemLabel(t.subsystem)}:</span>
                      <span>{t.fixStatement}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {tickets.filter(t => t.status === 'failed').length > 0 && (
              <div className="drt-report-section drt-report-section--failed">
                <div className="drt-report-section-title"><AlertTriangle size={13} /> Failed ({tickets.filter(t => t.status === 'failed').length})</div>
                <ul className="drt-report-list">
                  {tickets.filter(t => t.status === 'failed').map(t => (
                    <li key={t.id} className="drt-failed-item">{t.idReadable} — {t.summary}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

const DEFAULT_SECTIONS: DeploymentSectionConfig[] = [
  { platform: 'UI', header: 'UI', enabled: true },
  { platform: 'Studio', header: 'Studio', enabled: true },
  { platform: 'Mission Control', header: 'Mission Control', enabled: true },
  { platform: 'Backend', header: 'Backend / Platform', enabled: true },
  { platform: 'Uncategorized', header: 'Other', enabled: true },
]

const DR_PAGE_SIZE = 8

async function drRequestNotificationPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') await Notification.requestPermission()
}

function drShowCompletionNotification(succeeded: number, failed: number) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const body = failed > 0
    ? `${succeeded} fix statements generated, ${failed} failed.`
    : `All ${succeeded} fix statements generated successfully.`
  new Notification('Deployment Report Ready', { body, icon: '/favicon.ico', tag: 'deployment-report-done' })
}

function AsanaDeploymentReport() {
  const [tickets, setTickets] = useState<DeploymentTicket[]>([])
  const [botConfig, setBotConfig] = useState<DeploymentBotConfig>({ systemPrompt: '', sections: DEFAULT_SECTIONS })
  const [isFetching, setIsFetching] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [reportReady, setReportReady] = useState(false)

  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number } | null>(null)
  const [genProgress, setGenProgress] = useState<{ current: number; total: number; retryCountdown: number } | null>(null)
  const [preloadTickets, setPreloadTickets] = useState<LoadedDeploymentTicket[]>([])

  useEffect(() => {
    api.getAsanaDeploymentConfig().then(res => {
      if (res.success && res.data) setBotConfig(res.data)
    }).catch(() => {})
  }, [])

  const readyCount = useMemo(() => tickets.filter(t => t.status === 'ready').length, [tickets])
  const sections = botConfig.sections?.length ? botConfig.sections : DEFAULT_SECTIONS

  // ── Fetch tickets (matches DR App.tsx handleFetchTickets exactly) ───────────
  const handleFetch = async (lines: TicketLine[]) => {
    if (!lines.length) return
    setIsFetching(true)
    setReportReady(false)

    // Count lines that need an Asana API call
    const total = lines.filter(l => !(l.title !== null && l.manualDesc !== null)).length
    let done = 0
    setFetchProgress(total > 0 ? { done: 0, total } : null)

    // Add placeholders immediately (status: fetching)
    const placeholders: DeploymentTicket[] = lines.map(({ url, title, manualDesc, gid }) => ({
      url, gid: gid || '', name: title ?? '',
      notes: '', manualDescription: false,
      platform: title ? detectPlatform(title) : ('Uncategorized' as Platform),
      priority: title ? extractPriority(title) : null,
      cleanName: title ? stripPrefix(title) : '',
      fixStatement: null, status: 'fetching' as const,
    }))
    setTickets(prev => {
      const existing = new Set(prev.map(t => t.url))
      return [...prev, ...placeholders.filter(p => !existing.has(p.url))]
    })

    // Fire all fetches concurrently — increment counter as each settles
    const results = await Promise.allSettled(
      lines.map(async ({ url, title, manualDesc, gid }) => {
        // Immediate: title + manualDesc both known — no Asana call needed
        if (title !== null && manualDesc !== null) {
          return { gid: gid || url, name: title, notes: manualDesc, manualDescription: true }
        }

        const afterFetch = () => { done++; setFetchProgress({ done, total }) }

        try {
          const res = await api.getAsanaDeploymentTask(url)
          afterFetch()
          if (!res.success || !res.data) throw new Error('Fetch failed')
          return {
            gid: res.data.gid,
            name: title ?? res.data.name,
            notes: manualDesc ?? res.data.notes,
            manualDescription: !!manualDesc,
          }
        } catch (e) {
          afterFetch()
          throw e
        }
      })
    )

    // Apply results back to tickets array
    setTickets(prev => {
      const updated = [...prev]
      results.forEach((result, i) => {
        const idx = updated.findIndex(t => t.url === lines[i].url)
        if (idx === -1) return
        if (result.status === 'fulfilled') {
          const { gid, name, notes, manualDescription } = result.value
          updated[idx] = {
            ...updated[idx], gid, name, notes, manualDescription,
            platform: detectPlatform(name), priority: extractPriority(name),
            cleanName: stripPrefix(name), fixStatement: null, status: 'ready' as const,
          }
        } else {
          updated[idx] = { ...updated[idx], status: 'error' as const, error: 'Failed to fetch ticket' }
        }
      })
      return updated
    })

    setIsFetching(false)
    setFetchProgress(null)
  }

  // Load from ProjectBrowser → populate textarea only; user edits then clicks Fetch Tickets
  const handleProjectLoad = (loaded: LoadedDeploymentTicket[]) => {
    setTickets([])
    setReportReady(false)
    setPreloadTickets(loaded)
  }

  // ── Generate fix statements (matches DR App.tsx handleGenerateReport) ───────
  const handleGenerate = async () => {
    const toGenerate = tickets.filter(t => t.status === 'ready' && t.gid)
    if (!toGenerate.length) return

    // Request notification permission inside user gesture (required by browsers)
    drRequestNotificationPermission()

    setIsGenerating(true)
    setReportReady(false)

    const makeBatches = (list: typeof toGenerate) => {
      const batches: typeof toGenerate[] = []
      for (let i = 0; i < list.length; i += DR_PAGE_SIZE) batches.push(list.slice(i, i + DR_PAGE_SIZE))
      return batches
    }
    const pages = makeBatches(toGenerate)
    setGenProgress({ current: 0, total: pages.length, retryCountdown: 0 })

    // Mark all as generating
    setTickets(prev => prev.map(t =>
      toGenerate.find(g => g.gid === t.gid) ? { ...t, status: 'generating' as const } : t
    ))

    let totalSucceeded = 0
    let totalFailed = 0

    const retriedPages = new Set<number>()

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      const page = pages[pageIdx]
      setGenProgress({ current: pageIdx, total: pages.length, retryCountdown: 0 })

      try {
        const res = await api.generateAsanaDeploymentReport(
          page.map(t => ({ gid: t.gid, name: t.name, notes: t.notes, manualDescription: t.manualDescription }))
        )

        if (res.success && res.data) {
          setTickets(prev => prev.map(t => {
            const result = res.data!.results.find(r => r.gid === t.gid)
            if (!result) return t
            if (result.fixStatement) {
              totalSucceeded++
              return { ...t, fixStatement: result.fixStatement, status: 'ready' as const }
            }
            totalFailed++
            return { ...t, status: 'ready' as const }
          }))

          const waitSecs = res.data.retryAfter ?? 0
          if (waitSecs > 0 && !retriedPages.has(pageIdx)) {
            // Rate limited — countdown then retry this batch once
            retriedPages.add(pageIdx)
            for (let s = waitSecs; s > 0; s--) {
              setGenProgress({ current: pageIdx, total: pages.length, retryCountdown: s })
              await new Promise(r => setTimeout(r, 1000))
            }
            pageIdx-- // re-run this page in the next iteration
          }
        }
      } catch (err: any) {
        const is429 = err?.response?.status === 429 || err?.status === 429
        const pageGids = new Set(page.map(t => t.gid))
        setTickets(prev => prev.map(t =>
          pageGids.has(t.gid) && t.status === 'generating' ? { ...t, status: 'ready' as const } : t
        ))
        totalFailed += page.length
        if (is429 && !retriedPages.has(pageIdx)) {
          retriedPages.add(pageIdx)
          for (let s = 10; s > 0; s--) {
            setGenProgress({ current: pageIdx, total: pages.length, retryCountdown: s })
            await new Promise(r => setTimeout(r, 1000))
          }
          pageIdx--
        }
      }

      setGenProgress({ current: pageIdx + 1, total: pages.length, retryCountdown: 0 })
    }

    // Revert any still-generating tickets back to 'ready' (never show error)
    setTickets(prev => prev.map(t =>
      t.status === 'generating' ? { ...t, status: 'ready' as const } : t
    ))

    setIsGenerating(false)
    setGenProgress(null)
    setReportReady(true)
    drShowCompletionNotification(totalSucceeded, totalFailed)
  }

  const handleClearAll = () => {
    setTickets([])
    setReportReady(false)
    setPreloadTickets([])
  }

  const genButtonLabel = () => {
    if (!isGenerating) return <><Rocket size={14} /> Generate Report ({readyCount} tickets)</>
    if (genProgress) {
      if (genProgress.retryCountdown > 0) {
        return <><Loader2 size={14} className="animate-spin" /> Cooking up brilliance… resuming in {genProgress.retryCountdown}s</>
      }
      return <><Loader2 size={14} className="animate-spin" /> Batch {genProgress.current + 1} of {genProgress.total}…</>
    }
    return <><Loader2 size={14} className="animate-spin" /> Generating…</>
  }


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <>
          {/* Step 1: ProjectBrowser + TicketInput (combined, like DR) */}
          <div className="dr-card">
            <div className="dr-step-label"><span className="dr-step-num">1</span>Paste Asana ticket URLs</div>
            <DeploymentProjectBrowser onLoad={handleProjectLoad} isLoading={isFetching} />
            <hr className="dr-divider" />
            <DeploymentTicketInput onFetch={handleFetch} isLoading={isFetching} preloadTickets={preloadTickets} />
            {isFetching && fetchProgress && (
              <div className="dr-gen-progress" style={{ marginTop: '0.6rem' }}>
                <div className="dr-progress-track">
                  <div className="dr-progress-fill" style={{ width: `${Math.round((fetchProgress.done / fetchProgress.total) * 100)}%` }} />
                </div>
                <span className="dr-progress-label">Fetching tickets… {fetchProgress.done}/{fetchProgress.total}</span>
              </div>
            )}
          </div>

          {/* Step 2: Ticket list + Generate (like DR) */}
          {tickets.length > 0 && (
            <div className="dr-card">
              <div className="dr-step-label"><span className="dr-step-num">2</span>Review fetched tickets</div>
              <DeploymentTicketList tickets={tickets} />

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleGenerate}
                  disabled={isGenerating || readyCount === 0}
                >
                  {genButtonLabel()}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={handleClearAll} disabled={isGenerating}>
                  Clear All
                </button>
              </div>

              {isGenerating && genProgress && (
                <div className="dr-gen-progress" style={{ marginTop: '0.6rem' }}>
                  <div className="dr-progress-track">
                    <div className="dr-progress-fill" style={{ width: `${Math.round((genProgress.current / genProgress.total) * 100)}%` }} />
                  </div>
                  {genProgress.retryCountdown > 0
                    ? <span className="dr-progress-countdown">✦ Hang tight — crafting your report… resuming in {genProgress.retryCountdown}s</span>
                    : <span className="dr-progress-label">Batch {genProgress.current + 1} of {genProgress.total} · {DR_PAGE_SIZE} tickets per batch</span>
                  }
                </div>
              )}
            </div>
          )}

          {/* Step 3: Report preview + export (like DR) */}
          {reportReady && (
            <div className="dr-card">
              <div className="dr-step-label"><span className="dr-step-num">3</span>Export deployment report</div>
              <DeploymentExportButtons tickets={tickets} sections={sections} disabled={!reportReady} />
              <hr className="dr-divider" />
              <DeploymentReportPreview tickets={tickets} sections={sections} />
            </div>
          )}
        </>
    </div>
  )
}

function DeploymentReportTab({ activeSprint }: { activeSprint: YouTrackSprint | null }) {
  const isAsana = getActiveSource() === 'asana'

  return (
    <div className="pm-tab-content sr-panel">
      {isAsana ? (
        <>
          <div className="pm-tab-header">
            <h3 className="pm-section-title"><Rocket size={18} /> Deployment Report</h3>
            <p className="sr-subtitle">Generate a client-ready deployment report from Asana tickets with AI-polished fix statements.</p>
          </div>
          <AsanaDeploymentReport />
        </>
      ) : (
        <YouTrackStageReport sprintId={activeSprint?.id} sprintName={activeSprint?.name} />
      )}
    </div>
  )
}

interface PMReportsPageProps {
  initialTab?: TabId
  onTabChange?: (tab: TabId) => void
}

const SPRINT_ID_KEY = 'pm_active_sprint_id'
const SPRINT_NAME_KEY = 'pm_active_sprint_name'

function fmtSprintDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function PMReportsPage({ initialTab = 'tracking', onTabChange }: PMReportsPageProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab)
  const [blockerIssueIds, setBlockerIssueIds] = useState<Set<string>>(new Set())

  // ── Sprint state ────────────────────────────────────────────────────────────
  const [sprints, setSprints] = useState<YouTrackSprint[]>([])
  const [activeSprint, setActiveSprint] = useState<YouTrackSprint | null>(null)
  const [sprintDropdownOpen, setSprintDropdownOpen] = useState(false)
  const sprintDropdownRef = useRef<HTMLDivElement>(null)
  const sprintMenuRef = useRef<HTMLDivElement>(null)
  const isYouTrack = getActiveSource() === 'youtrack'

  useEffect(() => {
    if (!isYouTrack) return
    api.getYouTrackSprints().then(res => {
      const list = ((res as any).data as YouTrackSprint[]) ?? []
      setSprints(list)
      const now = Date.now()
      const active = list
        .filter(s => !s.isCompleted && s.finish > now)
        .sort((a, b) => a.finish - b.finish)[0] ?? null
      setActiveSprint(active)
      localStorage.setItem(SPRINT_ID_KEY, active?.id ?? '')
      localStorage.setItem(SPRINT_NAME_KEY, active?.name ?? '')
    }).catch(() => {})
  }, [isYouTrack])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const insideTrigger = sprintDropdownRef.current?.contains(target)
      const insideMenu = sprintMenuRef.current?.contains(target)
      if (!insideTrigger && !insideMenu) setSprintDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSprintChange = (sprint: YouTrackSprint | null) => {
    setActiveSprint(sprint)
    setSprintDropdownOpen(false)
    localStorage.setItem(SPRINT_ID_KEY, sprint?.id ?? '')
    localStorage.setItem(SPRINT_NAME_KEY, sprint?.name ?? '')
  }

  const sortedSprints = [...sprints].sort((a, b) => b.finish - a.finish)

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab)
    onTabChange?.(tab)
  }

  useEffect(() => { setActiveTab(initialTab) }, [initialTab])

  return (
    <div className="pm-reports-page">
      <div className="pm-reports-container">
        <div style={{ display: 'flex', alignItems: 'flex-end', overflow: 'visible' }}>
          <div className="pm-tab-bar glass-card" style={{ flex: 1, marginBottom: 0 }}>
            {TABS.map(tab => {
              const Icon = tab.icon
              return (
                <button key={tab.id} className={`pm-tab-btn ${activeTab === tab.id ? 'active' : ''}`} onClick={() => handleTabChange(tab.id)}>
                  <Icon size={16} />
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </div>
          {isYouTrack && (
            <div ref={sprintDropdownRef} style={{ position: 'relative', paddingBottom: '0.5rem', paddingLeft: 8, flexShrink: 0 }}>
              <button
                onClick={() => setSprintDropdownOpen(o => !o)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}
              >
                <GitBranch size={13} />
                {activeSprint
                  ? <>{activeSprint.name} <span style={{ opacity: 0.55, fontWeight: 400, marginLeft: 3 }}>{fmtSprintDate(activeSprint.start)}–{fmtSprintDate(activeSprint.finish)}</span></>
                  : <span>All sprints</span>
                }
                <ChevronDown size={12} style={{ opacity: 0.5 }} />
              </button>
              {sprintDropdownOpen && createPortal(
                <div
                  ref={sprintMenuRef}
                  className="pm-custom-dropdown-menu"
                  style={{
                    position: 'fixed',
                    top: (sprintDropdownRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                    left: (sprintDropdownRef.current?.getBoundingClientRect().right ?? 0) - 220,
                    minWidth: 220,
                    zIndex: 9999,
                  }}
                >
                  <button className={`pm-dropdown-item${!activeSprint ? ' active' : ''}`} onClick={() => handleSprintChange(null)}>
                    <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>{!activeSprint && <Check size={12} />}</span>
                    All sprints
                  </button>
                  {sortedSprints.length === 0 && (
                    <div style={{ padding: '9px 14px', fontSize: 13, opacity: 0.5 }}>No sprints found</div>
                  )}
                  {sortedSprints.map(s => (
                    <button
                      key={s.id}
                      className={`pm-dropdown-item${activeSprint?.id === s.id ? ' active' : ''}`}
                      onClick={() => handleSprintChange(s)}
                      style={{ opacity: s.isCompleted ? 0.6 : 1 }}
                    >
                      <span style={{ width: 13, display: 'inline-flex', alignItems: 'center' }}>{activeSprint?.id === s.id && <Check size={12} />}</span>
                      <span style={{ flex: 1 }}>{s.name}</span>
                      <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 8 }}>{fmtSprintDate(s.start)}–{fmtSprintDate(s.finish)}</span>
                      {s.isCompleted && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>✓</span>}
                    </button>
                  ))}
                </div>,
                document.body
              )}
            </div>
          )}
        </div>
        <div className={`pm-tab-panel glass-card${activeTab === 'daily' ? ' pm-tab-panel--daily' : ''}`}>
          {activeTab === 'daily'      && <DailyReportTab sprintId={activeSprint?.id} sprintName={activeSprint?.name} />}
          {activeTab === 'assignees'  && <AssigneeStatsTab sprintId={activeSprint?.id} />}
          {activeTab === 'tracking'   && <TrackingTab blockerIssueIds={blockerIssueIds} sprintId={activeSprint?.id} sprintStartMs={activeSprint?.start} sprintFinishMs={activeSprint?.finish} />}
          {activeTab === 'dailyops'   && <DailyOpsTab onBlockersChange={setBlockerIssueIds} sprintId={activeSprint?.id} />}
          {activeTab === 'deployment' && <DeploymentReportTab activeSprint={activeSprint} />}
          {activeTab === 'standup'    && <StandupCompilerPage />}
        </div>
      </div>
    </div>
  )
}
