import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
} from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import { useAuth } from '@/contexts/AuthContext'
import { StatCarousel } from '@/components/StatCarousel'
import { PERSIST } from '@/hooks/usePersistedState'
import api from '@/services/api'
import { ConfirmModal } from '@/components/ConfirmModal'
import CreateIssueModal from '@/components/CreateIssueModal'
import { useYouTrackEvents } from '@/services/useYouTrackEvents'
import {
  LayoutDashboard,
  KanbanSquare,
  List,
  Calendar,
  Bot,
  Bell,
  BarChart3,
  Settings,
  Users,
  Search,
  Plus,
  ChevronRight,
  LogOut,
  Link2,
  Brain,
  CheckCircle,
  AlertCircle,
  Clock,
  Code2,
  Archive,
  RefreshCw,
  User,
  AlertTriangle,
  X,
  MessageSquare,
  Sparkles,
  Maximize2,
  Minimize2,
  Activity,
  Zap,
  Palette,
} from 'lucide-react'
import { PMAssistantTab } from './PMReportsPage'
import { SprintDashboardPage } from './SprintDashboardPage'
import { IntegrationsPage } from './IntegrationsPage'
import { SettingsPage } from './SettingsPage'
import { BoardPage } from './BoardPage'
import { DailyOpsPage } from './DailyOpsTab'
import { DailyAnalysisViewPage } from './DailyAnalysisViewPage'
import { BotConfigPage } from './BotConfigPage'
import { AIAnalysisPage } from './AIAnalysisPage'
import { PMReportsPage } from './PMReportsPage'
import { ListViewPage } from './ListViewPage'
import { SlackIntelligencePage } from './SlackIntelligencePage'
import { ActivityPage } from './ActivityPage'
import { DayTrackPage } from './DayTrackPage'
import { JellySwitch } from '../components/JellySwitch'
import { ThemeSettingsPage } from './ThemeSettingsPage'
import { applyUserTheme } from '../utils/themeUtils'
import { RightPanel } from '../components/notifications/RightPanel'
import type { LocalNotification } from '../components/notifications/RightPanel'

type Page = 'dashboard' | 'board' | 'list' | 'daily-ops' | 'daily-analysis' | 'calendar' | 'reports' | 'ai-analysis' | 'pm-reports' | 'bots' | 'team' | 'settings' | 'integrations' | 'slack' | 'activity' | 'daytrack' | 'theme'

// Pages accessible by members/viewers (limited access)
const MEMBER_PAGES: Page[] = ['dashboard', 'board', 'list', 'daily-ops', 'activity', 'calendar', 'ai-analysis', 'daily-analysis', 'pm-reports', 'daytrack', 'integrations']

// YouTrack issue with extracted fields
interface YTIssue {
  id: string
  summary: string
  description: string
  status: string
  priority: string
  assignee?: { id: string; login: string; fullName: string; email?: string }
}

// Column config for the 3 dashboard columns
const DASHBOARD_COLUMNS = [
  { id: 'backlog', label: 'Backlog', ytState: 'Open' },
  { id: 'in_progress', label: 'In Progress', ytState: 'In Progress' },
  { id: 'dev', label: 'DEV', ytState: 'DEV' },
] as const

const COLUMN_ORDER: Record<string, number> = {
  backlog: 0,
  in_progress: 1,
  dev: 2,
}

type DashboardNotification = LocalNotification

// Droppable column wrapper
function DroppableColumn({ id, children }: { id: string; children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      className="kanban-column"
      style={{
        outline: isOver ? '2px solid #8250df' : 'none',
        outlineOffset: '-2px',
        borderRadius: '12px',
        transition: 'outline 0.15s ease',
      }}
    >
      {children}
    </div>
  )
}

// Draggable card wrapper
function DraggableCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        opacity: isDragging ? 0.4 : 1,
        cursor: 'grab',
        touchAction: 'none',
      }}
    >
      {children}
    </div>
  )
}

// Map URL path segments to Page values
const PATH_TO_PAGE: Record<string, Page> = {
  '': 'dashboard',
  'dashboard': 'dashboard',
  'board': 'board',
  'list': 'list',
  'daily-ops': 'daily-ops',
  'daily-analysis': 'daily-analysis',
  'calendar': 'calendar',
  'reports': 'reports',
  'ai-analysis': 'ai-analysis',
  'pm-reports': 'pm-reports',
  'bots': 'bots',
  'team': 'team',
  'settings': 'settings',
  'integrations': 'integrations',
  'slack': 'slack',
  'activity': 'activity',
  'daytrack': 'daytrack',
  'theme': 'theme',
}

const PM_REPORTS_TABS = ['tracking', 'daily', 'assignees', 'dailyops', 'deployment'] as const
type PMReportsTab = typeof PM_REPORTS_TABS[number]

const SLACK_TABS = ['inbox', 'threads', 'reminders', 'settings'] as const
type SlackTab = typeof SLACK_TABS[number]

const INTEGRATIONS_TABS = ['youtrack', 'slack', 'workflow', 'developers'] as const
type IntegrationsTab = typeof INTEGRATIONS_TABS[number]

export default function Dashboard() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // Derive current page from URL path
  const pathSegments = location.pathname.replace(/^\//, '').split('/')
  const currentPage: Page = PATH_TO_PAGE[pathSegments[0]] ?? 'dashboard'
  const subTab: string | undefined = pathSegments[1]

  // Derived sub-tab for pm-reports (with validation)
  const pmReportsTab: PMReportsTab = (PM_REPORTS_TABS as readonly string[]).includes(subTab ?? '')
    ? (subTab as PMReportsTab)
    : 'tracking'

  // Derived sub-tab for slack (with validation)
  const slackTab: SlackTab = (SLACK_TABS as readonly string[]).includes(subTab ?? '')
    ? (subTab as SlackTab)
    : 'inbox'

  // Derived sub-tab for integrations (with validation)
  const integrationsTab: IntegrationsTab = (INTEGRATIONS_TABS as readonly string[]).includes(subTab ?? '')
    ? (subTab as IntegrationsTab)
    : 'youtrack'

  // Navigate wrapper — updates URL and persists last page
  const setCurrentPage = (page: Page) => {
    if (page !== 'dashboard') localStorage.setItem(PERSIST.LAST_PAGE, page)
    navigate(`/${page}`)
  }

  // On fresh load at root (/), restore the last visited page
  useEffect(() => {
    const path = location.pathname
    if (path === '/' || path === '') {
      const last = localStorage.getItem(PERSIST.LAST_PAGE) as Page | null
      const valid: Page[] = ['board', 'list', 'daily-ops', 'pm-reports', 'slack', 'activity', 'daytrack', 'ai-analysis', 'daily-analysis', 'integrations', 'settings', 'bots', 'theme']
      if (last && valid.includes(last)) {
        navigate(`/${last}`, { replace: true })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep-alive: track which tabs have ever been visited so we can keep them
  // mounted (hidden via CSS) instead of unmounting on tab switch.
  const [mountedTabs, setMountedTabs] = useState<Set<Page>>(() => new Set([currentPage]))
  useEffect(() => {
    setMountedTabs(prev => {
      if (prev.has(currentPage)) return prev
      const next = new Set(prev)
      next.add(currentPage)
      return next
    })
  }, [currentPage])

  const [showNotifications, setShowNotifications] = useState(false)
  const [notifAnchorRect, setNotifAnchorRect] = useState<DOMRect | null>(null)
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return localStorage.getItem('theme') !== 'light'
  })

  useEffect(() => {
    const theme = darkMode ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [darkMode])

  // Load and apply per-user theme — apply cached immediately, then update from backend
  useEffect(() => {
    if (!user) return
    // Apply cached theme instantly to avoid flash of default colors
    const THEME_CACHE_KEY = 'user-theme-cache'
    try {
      const cached = localStorage.getItem(THEME_CACHE_KEY)
      if (cached) {
        const { dark_accent, dark_bg, light_accent, light_bg } = JSON.parse(cached)
        applyUserTheme(dark_accent, dark_bg, light_accent, light_bg)
      }
    } catch { /* ignore bad cache */ }

    api.getUserTheme().then(res => {
      if (res.data) {
        const { dark_accent, dark_bg, light_accent, light_bg } = res.data
        const fresh = JSON.stringify({ dark_accent, dark_bg, light_accent, light_bg })
        const cached = localStorage.getItem(THEME_CACHE_KEY)
        if (fresh !== cached) {
          localStorage.setItem(THEME_CACHE_KEY, fresh)
          applyUserTheme(dark_accent, dark_bg, light_accent, light_bg)
        }
      }
    }).catch(() => { /* keep cached theme if backend unreachable */ })
  }, [user])

  useEffect(() => {
    const PAGE_TITLES: Record<string, string> = {
      'dashboard':      'Dashboard',
      'board':          'Board View',
      'list':           'List View',
      'daily-ops':      'DailyOps',
      'daily-analysis': 'Daily Analysis',
      'calendar':       'Calendar',
      'reports':        'Reports',
      'ai-analysis':    'AI Analysis',
      'pm-reports':     'PM Reports',
      'bots':           'Bot Config',
      'team':           'Team',
      'settings':       'Settings',
      'integrations':   'Integrations',
      'reminders':      'Reminders',
      'slack':          'Slack Intelligence',
      'activity':       'Activity',
      'daytrack':       'DayTrack',
      'theme':          'Theme Customizer',
    }
    const title = PAGE_TITLES[currentPage] || 'Velocity'
    document.title = currentPage === 'dashboard' ? 'Velocity' : `${title} | Velocity`
  }, [currentPage])

  // YouTrack state
  const [ytIssues, setYtIssues] = useState<YTIssue[]>([])
  const [ytLoading, setYtLoading] = useState(true)
  const [ytConnected, setYtConnected] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const sseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activeIssue, setActiveIssue] = useState<YTIssue | null>(null)
  const [dashboardView, setDashboardView] = useState<'board' | 'assignees'>('board')

  // New task modal state
  const [showNewTask, setShowNewTask] = useState(false)


  // Role-based access
  const isFullAccess = user?.role === 'admin' || user?.role === 'project_manager'

  // Search state
  const [searchQuery, setSearchQuery] = useState('')

  // Notification state — persist to sessionStorage
  const [notifications, setNotifications] = useState<DashboardNotification[]>(() => {
    try {
      const saved = sessionStorage.getItem('pm_notifications')
      if (saved) {
        const parsed = JSON.parse(saved)
        return parsed.map((n: DashboardNotification) => ({ ...n, timestamp: new Date(n.timestamp) }))
      }
    } catch { /* ignore */ }
    return []
  })
  const [toast, setToast] = useState<{ message: string; type: 'warning' | 'info' } | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatFullscreen, setChatFullscreen] = useState(false)
  const chatPanelRef = useRef<HTMLDivElement>(null)
  const notifRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    sessionStorage.setItem('pm_notifications', JSON.stringify(notifications))
  }, [notifications])

  // Close notification panel on outside click
  useEffect(() => {
    if (!showNotifications) return
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showNotifications])

  // Guard: redirect members to allowed pages
  useEffect(() => {
    if (!isFullAccess && !MEMBER_PAGES.includes(currentPage)) {
      navigate('/dashboard', { replace: true })
    }
  }, [currentPage, isFullAccess, navigate])

  const unreadCount = notifications.filter(n => !n.read).length

  const addNotification = (notif: Omit<DashboardNotification, 'id' | 'timestamp' | 'read'>) => {
    setNotifications(prev => [{
      ...notif,
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date(),
      read: false,
    }, ...prev])
  }

  const dismissNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }

  const handleMoveToBlocked = async (notif: DashboardNotification) => {
    try {
      await api.bulkUpdateYouTrackStates([{ issue_id: notif.issueId, new_state: 'Blocked' }])
      setYtIssues(prev => prev.map(i =>
        i.id === notif.issueId ? { ...i, status: 'Blocked' } : i
      ))
      dismissNotification(notif.id)
      setToast({ message: `${notif.issueId} moved to Blocked`, type: 'info' })
      setTimeout(() => setToast(null), 3000)
    } catch {
      setToast({ message: `Failed to move ${notif.issueId} to Blocked`, type: 'warning' })
      setTimeout(() => setToast(null), 3000)
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  const handleDragStart = (event: DragStartEvent) => {
    const issue = ytIssues.find(i => i.id === event.active.id)
    if (issue) setActiveIssue(issue)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveIssue(null)
    const { active, over } = event
    if (!over) return

    const issueId = active.id as string
    const targetColumnId = over.id as string

    // Find which column the issue currently belongs to
    const issue = ytIssues.find(i => i.id === issueId)
    if (!issue) return

    const currentCol = getColumnForIssue(issue)
    if (currentCol === targetColumnId) return

    // Find the target YouTrack state
    const targetCol = DASHBOARD_COLUMNS.find(c => c.id === targetColumnId)
    if (!targetCol) return

    // Detect backward movement
    const currentOrder = COLUMN_ORDER[currentCol] ?? 0
    const targetOrder = COLUMN_ORDER[targetColumnId] ?? 0
    const isBackward = targetOrder < currentOrder

    if (isBackward) {
      const fromLabel = DASHBOARD_COLUMNS.find(c => c.id === currentCol)?.label || currentCol
      const toLabel = targetCol.label
      addNotification({
        type: 'backward_move',
        issueId,
        summary: issue.summary,
        fromState: fromLabel,
        toState: toLabel,
      })
      setToast({ message: `${issueId} moved backward: ${fromLabel} → ${toLabel}`, type: 'warning' })
      setTimeout(() => setToast(null), 4000)
    }

    // Optimistic update: move the issue locally (even if backward)
    setYtIssues(prev => prev.map(i =>
      i.id === issueId ? { ...i, status: targetCol.ytState } : i
    ))

    // Call YouTrack API to update state
    try {
      await api.bulkUpdateYouTrackStates([{ issue_id: issueId, new_state: targetCol.ytState }])
    } catch (err) {
      console.error('Failed to update issue state:', err)
      // Revert on failure
      fetchYouTrackIssues()
    }
  }

  const getColumnForIssue = (issue: YTIssue): string => {
    const s = issue.status?.toLowerCase() || ''
    if (s === 'in progress') return 'in_progress'
    if (s === 'dev') return 'dev'
    return 'backlog'
  }

  useEffect(() => {
    fetchYouTrackIssues()
  }, [])

  const fetchYouTrackIssues = async () => {
    try {
      setYtLoading(true)
      const status = await api.getYouTrackStatus()
      if (status.configured) {
        setYtConnected(true)
        const response = await api.getYouTrackIssues()
        if (response.success && response.data) {
          setYtIssues(response.data as YTIssue[])
        }
      }
    } catch (err) {
      console.error('Failed to fetch YouTrack issues:', err)
    } finally {
      setYtLoading(false)
    }
  }

  // SSE: auto-refresh when YouTrack changes arrive via webhook.
  // Debounced 3s to avoid a full re-fetch on every rapid field change.
  useYouTrackEvents(useCallback((event) => {
    setToast({
      message: `YouTrack: ${event.issue_id} ${event.field} → ${event.new_value}`,
      type: 'info',
    })
    setTimeout(() => setToast(null), 4000)

    if (sseDebounceRef.current) clearTimeout(sseDebounceRef.current)
    sseDebounceRef.current = setTimeout(() => {
      fetchYouTrackIssues()
    }, 3000)
  }, []))

  const handleSync = async () => {
    setSyncing(true)
    await fetchYouTrackIssues()
    setSyncing(false)
  }


  const handleLogout = async () => {
    await logout()
  }

  // Get user initials for avatar
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  const filteredIssues = searchQuery.trim()
    ? ytIssues.filter(i =>
        i.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
        i.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        i.assignee?.fullName?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : ytIssues

  // Group YouTrack issues by the 3 columns + Backlog
  const inProgressIssues = filteredIssues.filter(i => i.status?.toLowerCase() === 'in progress')
  const devIssues = filteredIssues.filter(i => i.status?.toLowerCase() === 'dev')
  const backlogIssues = filteredIssues.filter(i => {
    const s = i.status?.toLowerCase() || ''
    return s !== 'in progress' && s !== 'dev' && s !== 'done' && s !== 'fixed'
  })
  const doneIssues = filteredIssues.filter(i => {
    const s = i.status?.toLowerCase() || ''
    return s === 'done' || s === 'fixed'
  })

  // Group issues by assignee for Assignee View
  const assigneeGroups = useMemo(() => {
    const groups: Record<string, YTIssue[]> = {}
    const unassigned: YTIssue[] = []

    const activeIssues = filteredIssues.filter(i => {
      const s = i.status?.toLowerCase() || ''
      return s !== 'done' && s !== 'fixed'
    })

    for (const issue of activeIssues) {
      if (issue.assignee?.fullName) {
        const name = issue.assignee.fullName
        if (!groups[name]) groups[name] = []
        groups[name].push(issue)
      } else {
        unassigned.push(issue)
      }
    }

    const statusOrder = (s: string) => {
      const lower = s?.toLowerCase() || ''
      if (lower === 'in progress') return 0
      if (lower === 'dev') return 2
      return 1
    }

    for (const name of Object.keys(groups)) {
      groups[name].sort((a, b) => statusOrder(a.status) - statusOrder(b.status))
    }
    unassigned.sort((a, b) => statusOrder(a.status) - statusOrder(b.status))

    return { groups, unassigned }
  }, [filteredIssues])

  const getStatusBadge = (status: string) => {
    const s = status?.toLowerCase() || ''
    if (s === 'in progress') return { label: 'In Progress', bg: 'rgba(234, 179, 8, 0.15)', color: '#eab308' }
    if (s === 'dev') return { label: 'DEV', bg: 'rgba(130, 80, 223, 0.15)', color: '#8250df' }
    return { label: status || 'Backlog', bg: 'rgba(128, 128, 128, 0.15)', color: '#888' }
  }

  const getBadgeClass = (status: string) => {
    const s = status?.toLowerCase() || ''
    if (s === 'in progress') return 'badge-progress'
    if (s === 'dev') return 'badge-review'
    return 'badge-todo'
  }

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar animate-slide-in-left">
        <div className="sidebar-logo">
          <div className="logo-icon">
            <KanbanSquare size={24} />
          </div>
          <span className="logo-text text-gradient">Velocity</span>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section">
            <span className="nav-section-title">Main</span>
            <button
              className={`sidebar-nav-item ${currentPage === 'dashboard' ? 'active' : ''}`}
              onClick={() => setCurrentPage('dashboard')}
            >
              <LayoutDashboard size={20} />
              <span>Dashboard</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'board' ? 'active' : ''}`}
              onClick={() => setCurrentPage('board')}
            >
              <KanbanSquare size={20} />
              <span>Board View</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'list' ? 'active' : ''}`}
              onClick={() => setCurrentPage('list')}
            >
              <List size={20} />
              <span>List View</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'daily-ops' ? 'active' : ''}`}
              onClick={() => setCurrentPage('daily-ops')}
            >
              <Zap size={20} />
              <span>DailyOps</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'daytrack' ? 'active' : ''}`}
              onClick={() => setCurrentPage('daytrack')}
            >
              <Clock size={20} />
              <span>DayTrack</span>
            </button>

            <button
              className={`sidebar-nav-item ${currentPage === 'activity' ? 'active' : ''}`}
              onClick={() => setCurrentPage('activity')}
            >
              <Activity size={20} />
              <span>Activity</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'calendar' ? 'active' : ''}`}
              onClick={() => setCurrentPage('calendar')}
            >
              <Calendar size={20} />
              <span>Calendar</span>
            </button>
          </div>

          <div className="nav-section">
            <span className="nav-section-title">Analytics</span>
            <button
              className={`sidebar-nav-item ${currentPage === 'ai-analysis' ? 'active' : ''}`}
              onClick={() => setCurrentPage('ai-analysis')}
            >
              <Brain size={20} />
              <span>AI Analysis</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'daily-analysis' ? 'active' : ''}`}
              onClick={() => setCurrentPage('daily-analysis')}
            >
              <CheckCircle size={20} />
              <span>Daily Status</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'pm-reports' ? 'active' : ''}`}
              onClick={() => setCurrentPage('pm-reports')}
            >
              <MessageSquare size={20} />
              <span>PM Reports</span>
            </button>
            {isFullAccess && (
              <button
                className={`sidebar-nav-item ${currentPage === 'slack' ? 'active' : ''}`}
                onClick={() => setCurrentPage('slack')}
              >
                <svg width="20" height="20" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19.7 32.5a4.9 4.9 0 1 1-4.9-4.9h4.9v4.9Z" fill="#E01E5A"/>
                  <path d="M22.2 32.5a4.9 4.9 0 0 1 9.8 0v12.3a4.9 4.9 0 0 1-9.8 0V32.5Z" fill="#E01E5A"/>
                  <path d="M27.1 19.7a4.9 4.9 0 1 1 4.9-4.9v4.9H27.1Z" fill="#36C5F0"/>
                  <path d="M27.1 22.2a4.9 4.9 0 0 1 0 9.8H14.8a4.9 4.9 0 0 1 0-9.8H27.1Z" fill="#36C5F0"/>
                  <path d="M39.9 27.1a4.9 4.9 0 1 1 4.9 4.9H39.9V27.1Z" fill="#2EB67D"/>
                  <path d="M37.4 27.1a4.9 4.9 0 0 1-9.8 0V14.8a4.9 4.9 0 0 1 9.8 0V27.1Z" fill="#2EB67D"/>
                  <path d="M32.5 39.9a4.9 4.9 0 1 1-4.9 4.9V39.9h4.9Z" fill="#ECB22E"/>
                  <path d="M32.5 37.4a4.9 4.9 0 0 1 0-9.8h12.3a4.9 4.9 0 0 1 0 9.8H32.5Z" fill="#ECB22E"/>
                </svg>
                <span>Slack</span>
              </button>
            )}
          </div>

          <div className="nav-section">
            {isFullAccess && <span className="nav-section-title">Settings</span>}
            {user?.role === 'admin' && (
              <button
                className={`sidebar-nav-item ${currentPage === 'team' ? 'active' : ''}`}
                onClick={() => setCurrentPage('team')}
              >
                <Users size={20} />
                <span>Team</span>
              </button>
            )}
            {isFullAccess && (
              <button
                className={`sidebar-nav-item ${currentPage === 'bots' ? 'active' : ''}`}
                onClick={() => setCurrentPage('bots')}
              >
                <Bot size={20} />
                <span>Bot Config</span>
              </button>
            )}
            <button
              className={`sidebar-nav-item ${currentPage === 'integrations' ? 'active' : ''}`}
              onClick={() => setCurrentPage('integrations')}
            >
              <Link2 size={20} />
              <span>Integrations</span>
            </button>
            {user?.role === 'admin' && (
              <button
                className={`sidebar-nav-item ${currentPage === 'settings' ? 'active' : ''}`}
                onClick={() => setCurrentPage('settings')}
              >
                <Settings size={20} />
                <span>Access Control</span>
              </button>
            )}
            <button
              className={`sidebar-nav-item ${currentPage === 'theme' ? 'active' : ''}`}
              onClick={() => setCurrentPage('theme')}
            >
              <Palette size={20} />
              <span>Theme</span>
            </button>
            <button className="sidebar-nav-item logout-button" onClick={handleLogout}>
              <LogOut size={20} />
              <span>Logout</span>
            </button>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile">
            {user?.picture ? (
              <img src={user.picture} alt={user.name} className="avatar-image" />
            ) : (
              <div className="avatar">{user ? getInitials(user.name) : 'U'}</div>
            )}
            <div className="user-info">
              <span className="user-name">{user?.name || 'User'}</span>
              <span className="user-role">{user?.role?.replace('_', ' ') || 'Member'}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Header */}
      <header className="header animate-fade-in-down">
        <div className="header-left">
          <h1 className="header-title">
            {currentPage === 'dashboard' && 'Dashboard'}
            {currentPage === 'board' && 'Board View'}
            {currentPage === 'list' && 'List View'}
            {currentPage === 'daily-ops' && 'DailyOps'}
            {currentPage === 'calendar' && 'Calendar'}
            {currentPage === 'ai-analysis' && 'AI Task Analysis'}
            {currentPage === 'daily-analysis' && 'Daily Status'}
            {currentPage === 'pm-reports' && 'Reports'}
            {currentPage === 'team' && 'Team Management'}
            {currentPage === 'bots' && 'Bot Configuration'}
            {currentPage === 'settings' && 'Access Control'}
            {currentPage === 'integrations' && 'Integrations'}
            {currentPage === 'slack' && 'Slack Intelligence'}
            {currentPage === 'activity' && 'Activity'}
            {currentPage === 'daytrack' && 'DayTrack'}
            {currentPage === 'theme' && 'Theme'}
          </h1>
        </div>
        <div className="header-center">
          <StatCarousel onNavigate={(target) => {
            if (target === 'dashboard') setCurrentPage('dashboard')
            if (target === 'daily-ops') setCurrentPage('daily-ops')
            if (target === 'sprint-dashboard') setCurrentPage('dashboard')
            if (target === 'pm-reports') setCurrentPage('pm-reports')
          }} />
        </div>
        <div className="header-actions">
          <JellySwitch
            checked={darkMode}
            onChange={setDarkMode}
            label="Dark Mode"
          />
          <div className="notification-bell-container">
            <button
              data-np-bell
              ref={notifRef as React.RefObject<HTMLButtonElement>}
              className={`notification-bell${showNotifications ? ' active' : ''}${unreadCount > 0 && !showNotifications ? ' notification-bell--wiggle' : ''}`}
              onClick={(e) => {
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setNotifAnchorRect(rect)
                setShowNotifications(o => !o)
              }}
              aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
            >
              <Bell size={20} />
              {unreadCount > 0 && (
                <span className="notification-badge" style={{
                  position: 'absolute', top: 7, right: 7,
                  minWidth: 8, height: 8, borderRadius: 99,
                  background: '#ef4444', border: '1.5px solid var(--bg-primary)',
                }} />
              )}
            </button>
            {showNotifications && notifAnchorRect && (
              <RightPanel
                anchorRect={notifAnchorRect}
                onClose={() => setShowNotifications(false)}
                localNotifications={notifications}
                onMoveToBlocked={handleMoveToBlocked}
                onDismissLocal={dismissNotification}
              />
            )}
          </div>
          <button
            className="btn-primary btn-md btn-new-task"
            onClick={() => setShowNewTask(true)}
          >
            <Plus size={18} />
            <span>New Task</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        {/* Keep-alive tabs: mount on first visit, hide (not unmount) when inactive */}
        {mountedTabs.has('dashboard') && (
          <div className={currentPage !== 'dashboard' ? 'dash-tab-hidden' : undefined}>
            <SprintDashboardPage />
          </div>
        )}
        {mountedTabs.has('board') && (
          <div className={currentPage !== 'board' ? 'dash-tab-hidden' : undefined}>
            <BoardPage />
          </div>
        )}
        {mountedTabs.has('list') && (
          <div className={currentPage !== 'list' ? 'dash-tab-hidden' : undefined}>
            <ListViewPage />
          </div>
        )}
        {mountedTabs.has('daily-ops') && (
          <div className={currentPage !== 'daily-ops' ? 'dash-tab-hidden' : undefined}>
            <DailyOpsPage />
          </div>
        )}
        {mountedTabs.has('daytrack') && (
          <div className={currentPage !== 'daytrack' ? 'dash-tab-hidden' : undefined}>
            <DayTrackPage />
          </div>
        )}
        {mountedTabs.has('activity') && (
          <div className={currentPage !== 'activity' ? 'dash-tab-hidden' : undefined}>
            <ActivityPage />
          </div>
        )}
        {mountedTabs.has('pm-reports') && (
          <div className={currentPage !== 'pm-reports' ? 'dash-tab-hidden' : undefined}>
            <PMReportsPage
              initialTab={pmReportsTab}
              onTabChange={(tab) => navigate(`/pm-reports/${tab}`)}
            />
          </div>
        )}
        {mountedTabs.has('slack') && (
          <div className={currentPage !== 'slack' ? 'dash-tab-hidden' : undefined}>
            <SlackIntelligencePage
              initialTab={slackTab}
              onTabChange={(tab) => navigate(`/slack/${tab}`)}
              onOpenPMAssistant={() => setChatOpen(true)}
            />
          </div>
        )}
        {mountedTabs.has('ai-analysis') && (
          <div className={currentPage !== 'ai-analysis' ? 'dash-tab-hidden' : undefined}>
            <AIAnalysisPage onNavigateToDailyAnalysis={() => setCurrentPage('daily-analysis')} />
          </div>
        )}
        {mountedTabs.has('daily-analysis') && (
          <div className={currentPage !== 'daily-analysis' ? 'dash-tab-hidden' : undefined}>
            <DailyAnalysisViewPage />
          </div>
        )}
        {mountedTabs.has('integrations') && (
          <div className={currentPage !== 'integrations' ? 'dash-tab-hidden' : undefined}>
            <IntegrationsPage
              initialTab={integrationsTab}
              onTabChange={(tab) => navigate(`/integrations/${tab}`)}
              userRole={user?.role}
            />
          </div>
        )}
        {mountedTabs.has('settings') && (
          <div className={currentPage !== 'settings' ? 'dash-tab-hidden' : undefined}>
            <SettingsPage />
          </div>
        )}
        {mountedTabs.has('bots') && (
          <div className={currentPage !== 'bots' ? 'dash-tab-hidden' : undefined}>
            <BotConfigPage />
          </div>
        )}
        {mountedTabs.has('theme') && (
          <div className={currentPage !== 'theme' ? 'dash-tab-hidden' : undefined}>
            <ThemeSettingsPage />
          </div>
        )}

        {/* Calendar Placeholder */}
        {currentPage === 'calendar' && (
          <div className="cal-soon-wrap">
            {/* Background orbs */}
            <div className="cal-soon-orb cal-soon-orb--1" />
            <div className="cal-soon-orb cal-soon-orb--2" />
            <div className="cal-soon-orb cal-soon-orb--3" />

            {/* Floating date tiles */}
            {([
              { day: 14, cls: 'a' }, { day: 22, cls: 'b' }, { day: 7, cls: 'c' },
              { day: 3,  cls: 'd' }, { day: 29, cls: 'e' }, { day: 18, cls: 'f' },
              { day: 11, cls: 'g' }, { day: 25, cls: 'h' },
            ] as { day: number; cls: string }[]).map(({ day, cls }) => (
              <div key={day} className={`cal-soon-tile cal-soon-tile--${cls}`}>{day}</div>
            ))}

            <div className="cal-soon-card">
              <div className="cal-soon-icon-wrap">
                <Calendar size={28} />
              </div>

              <span className="cal-soon-badge">
                <span className="cal-soon-badge-dot" />
                Coming Soon
              </span>

              <h2 className="cal-soon-title">
                {'Calendar View'.split('').map((ch, i) => (
                  <span key={i} className="cal-soon-letter" style={{ animationDelay: `${0.04 * i}s` }}>
                    {ch === ' ' ? ' ' : ch}
                  </span>
                ))}
              </h2>

              <p className="cal-soon-sub">Smart scheduling &amp; task timeline</p>

              <ul className="cal-soon-features">
                <li style={{ animationDelay: '0.6s' }}>
                  <span className="cal-soon-check">✓</span> Drag &amp; drop task scheduling
                </li>
                <li style={{ animationDelay: '0.75s' }}>
                  <span className="cal-soon-check">✓</span> Sprint deadline overlays
                </li>
                <li style={{ animationDelay: '0.9s' }}>
                  <span className="cal-soon-check">✓</span> Team availability view
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* Lightweight placeholder pages — no data fetching, no keep-alive needed */}
        {currentPage === 'team' && (
          <div className="coming-soon">
            <Users size={48} />
            <h2>Team Management</h2>
            <p>Team management features coming soon!</p>
          </div>
        )}
      </main>

      {/* New Task Modal */}
      {showNewTask && (
        <CreateIssueModal
          onClose={() => setShowNewTask(false)}
          onCreated={() => {}}
        />
      )}


      {/* Toast Notification */}
      {toast && (
        <div className={`dashboard-toast ${toast.type === 'warning' ? 'toast-warning' : 'toast-info'}`}>
          {toast.type === 'warning' ? <AlertTriangle size={16} /> : <CheckCircle size={16} />}
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* Floating PM Assistant */}
      {chatOpen && (
        <div className={`pm-chat-panel${chatFullscreen ? ' pm-chat-panel--fullscreen' : ''}`} ref={chatPanelRef}>
          <div className="pm-chat-panel-header">
            <div className="pm-chat-panel-title">
              <Sparkles size={16} className="pm-chat-panel-title-icon" />
              <span>PM Assistant</span>
            </div>
            <div className="pm-chat-panel-actions">
              <button
                className="pm-chat-panel-close"
                onClick={() => setChatFullscreen(v => !v)}
                title={chatFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {chatFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
              <button className="pm-chat-panel-close" onClick={() => { setChatOpen(false); setChatFullscreen(false) }}>
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="pm-chat-panel-body">
            <PMAssistantTab />
          </div>
        </div>
      )}

      <button
        className={`pm-float-bubble${chatOpen ? ' pm-float-bubble--open' : ''}`}
        onClick={() => setChatOpen(v => !v)}
        aria-label="PM Assistant"
      >
        <span className="pm-float-bubble-glow" />
        {chatOpen ? <X size={22} /> : <Sparkles size={22} />}
      </button>
    </div>
  )
}
