import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { StatCarousel } from '@/components/StatCarousel'
import WorldClock from '@/components/WorldClock'
import { PERSIST } from '@/hooks/usePersistedState'
import api from '@/services/api'
import { ConfirmModal } from '@/components/ConfirmModal'
import CreateIssueModal from '@/components/CreateIssueModal'
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
  Plus,
  LogOut,
  Link2,
  Brain,
  CheckCircle,
  AlertTriangle,
  Clock,
  X,
  MessageSquare,
  Sparkles,
  Megaphone,
  Maximize2,
  Minimize2,
  Activity,
  Zap,
  Palette,
  Menu,
} from 'lucide-react'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { GlobalHoverCard } from '@/components/HoverCard'
import { PMAssistantTab } from './PMReportsPage'
import { SprintDashboardPage } from './SprintDashboardPage'
import { IntegrationsPage } from './IntegrationsPage'
import { SettingsPage } from './SettingsPage'
import { BoardPage } from './BoardPage'
import { DailyOpsPage } from './DailyOpsTab'
import { BotConfigPage } from './BotConfigPage'
import { AIAnalysisPage } from './AIAnalysisPage'
import { DevActivityPage } from './DevActivityPage'
import { PMReportsPage } from './PMReportsPage'
import { ListViewPage } from './ListViewPage'
import { SprintPulsePage } from './SprintPulsePage'
import { SlackIntelligencePage } from './SlackIntelligencePage'
import { UpdateRemindersTab } from './UpdateRemindersTab'
import { ActivityPage } from './ActivityPage'
import { DayTrackPage } from './DayTrackPage'
import { GanttPage } from './GanttPage'
import { JellySwitch } from '../components/JellySwitch'
import { ThemeSettingsPage } from './ThemeSettingsPage'
import { applyUserTheme } from '../utils/themeUtils'
import { RightPanel } from '../components/notifications/RightPanel'
import type { LocalNotification } from '../components/notifications/RightPanel'
import ChangelogPanel from '../components/changelog/ChangelogPanel'
import type { ChangelogEntry } from '../services/api'

type Page = 'dashboard' | 'board' | 'list' | 'sprint-pulse' | 'daily-ops' | 'calendar' | 'reports' | 'ai-analysis' | 'dev-activity' | 'pm-reports' | 'bots' | 'team' | 'settings' | 'integrations' | 'slack' | 'activity' | 'daytrack' | 'theme' | 'gantt' | 'update-reminders'

// Pages accessible by members/viewers (limited access)
const MEMBER_PAGES: Page[] = ['dashboard', 'board', 'list', 'sprint-pulse', 'daily-ops', 'activity', 'calendar', 'ai-analysis', 'dev-activity', 'pm-reports', 'daytrack', 'integrations', 'gantt', 'slack', 'update-reminders']

type DashboardNotification = LocalNotification

// Map URL path segments to Page values
const PATH_TO_PAGE: Record<string, Page> = {
  '': 'dashboard',
  'dashboard': 'dashboard',
  'board': 'board',
  'list': 'list',
  'sprint-pulse': 'sprint-pulse',
  'daily-ops': 'daily-ops',
  'calendar': 'calendar',
  'reports': 'reports',
  'ai-analysis': 'ai-analysis',
  'dev-activity': 'dev-activity',
  'pm-reports': 'pm-reports',
  'bots': 'bots',
  'team': 'team',
  'settings': 'settings',
  'integrations': 'integrations',
  'slack': 'slack',
  'activity': 'activity',
  'daytrack': 'daytrack',
  'theme': 'theme',
  'gantt': 'gantt',
  'update-reminders': 'update-reminders',
}

const PM_REPORTS_TABS = ['tracking', 'daily', 'assignees', 'deployment'] as const
type PMReportsTab = typeof PM_REPORTS_TABS[number]

const SLACK_TABS = ['inbox', 'threads', 'reminders', 'messages', 'settings'] as const
type SlackTab = typeof SLACK_TABS[number]

const UPDATE_REMINDERS_TABS = ['claude-queue', 'quick-send', 'rules'] as const
type UpdateRemindersTab_Tab = typeof UPDATE_REMINDERS_TABS[number]

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

  // Derived sub-tab for update-reminders (with validation)
  const updateRemindersSubTab: UpdateRemindersTab_Tab = (UPDATE_REMINDERS_TABS as readonly string[]).includes(subTab ?? '')
    ? (subTab as UpdateRemindersTab_Tab)
    : 'claude-queue'

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
      const valid: Page[] = ['board', 'list', 'sprint-pulse', 'daily-ops', 'pm-reports', 'slack', 'activity', 'daytrack', 'ai-analysis', 'dev-activity', 'integrations', 'settings', 'bots', 'theme', 'gantt']
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

  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Close sidebar on mobile whenever page changes (nav click)
  useEffect(() => { setSidebarOpen(false) }, [currentPage])

  // Lock body scroll when sidebar is open on mobile
  useEffect(() => {
    document.body.classList.toggle('sidebar-open', sidebarOpen)
    return () => { document.body.classList.remove('sidebar-open') }
  }, [sidebarOpen])

  // ── Update Reminders: unread queue indicator + browser notifications ─────────
  const [unreadQueueCount, setUnreadQueueCount] = useState(0)
  const notifiedQueueCountRef = useRef(0)

  // Poll for new Claude queue messages every 30s
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await api.listQueuedMessages()
        const list: any[] = Array.isArray(r) ? r : Array.isArray((r as any)?.data) ? (r as any).data : []
        const lastSeen = parseInt(localStorage.getItem('ur_queue_last_seen_ts') || '0', 10)
        const newCount = list.filter((m: any) => m.status === 'pending' && new Date(m.created_at).getTime() > lastSeen).length
        setUnreadQueueCount(newCount)
        if (newCount > 0 && newCount > notifiedQueueCountRef.current && Notification.permission === 'granted') {
          notifiedQueueCountRef.current = newCount
          new Notification('Velocity — Claude Queue', {
            body: newCount === 1 ? 'Claude queued a message for review' : `Claude queued ${newCount} messages for review`,
            icon: '/favicon.ico',
          })
        }
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [])

  // Clear unread badge and request notification permission when visiting the page
  useEffect(() => {
    if (currentPage === 'update-reminders') {
      setUnreadQueueCount(0)
      notifiedQueueCountRef.current = 0
      localStorage.setItem('ur_queue_last_seen_ts', Date.now().toString())
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission()
      }
    }
  }, [currentPage])

  const [showNotifications, setShowNotifications] = useState(false)
  const [notifAnchorRect, setNotifAnchorRect] = useState<DOMRect | null>(null)
  const [showChangelog, setShowChangelog] = useState(false)
  const [changelogAnchorRect, setChangelogAnchorRect] = useState<DOMRect | null>(null)
  const [hasNewChangelog, setHasNewChangelog] = useState(false)
  const [changelogEntries, setChangelogEntries] = useState<ChangelogEntry[]>([])

  useEffect(() => {
    api.getChangelogStatus().then(res => {
      setHasNewChangelog(res.has_new)
      setChangelogEntries(res.entries)
    }).catch(() => {})
  }, [])
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
    const titles: Record<string, string> = {
      dashboard: 'Overview — Velocity',
      board: 'Sprint Board — Velocity',
      list: 'List View — Velocity',
      'sprint-pulse': 'Sprint Pulse — Velocity',
      'daily-ops': 'Daily Ops — Velocity',
      daytrack: 'DayTrack — Velocity',
      activity: 'Activity — Velocity',
      calendar: 'Calendar — Velocity',
      'ai-analysis': 'AI Analysis — Velocity',
      'dev-activity': 'Dev Activity — Velocity',
      'pm-reports': 'PM Reports — Velocity',
      slack: 'Slack Intelligence — Velocity',
      integrations: 'Integrations — Velocity',
      team: 'Team — Velocity',
      settings: 'Settings — Velocity',
      bots: 'Bot Config — Velocity',
      theme: 'Theme — Velocity',
    }
    document.title = titles[currentPage] || 'Velocity'
  }, [currentPage])

  const [dashboardView, setDashboardView] = useState<'board' | 'assignees'>('board')

  // New task modal state
  const [showNewTask, setShowNewTask] = useState(false)


  // Role-based access
  const isFullAccess = user?.role === 'admin' || user?.role === 'project_manager'

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
      dismissNotification(notif.id)
      setToast({ message: `${notif.issueId} moved to Blocked`, type: 'info' })
      setTimeout(() => setToast(null), 3000)
    } catch {
      setToast({ message: `Failed to move ${notif.issueId} to Blocked`, type: 'warning' })
      setTimeout(() => setToast(null), 3000)
    }
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

  return (
    <div className="app-container">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`sidebar animate-slide-in-left${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <VelocityLogo variant="sidebar" size="sm" showStatusDot={true} mark="chevron" />
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
              className={`sidebar-nav-item ${currentPage === 'sprint-pulse' ? 'active' : ''}`}
              onClick={() => setCurrentPage('sprint-pulse')}
            >
              <Zap size={20} />
              <span>Sprint Pulse</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'daily-ops' ? 'active' : ''}`}
              onClick={() => setCurrentPage('daily-ops')}
            >
              <Activity size={20} />
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
              className={`sidebar-nav-item ${currentPage === 'gantt' ? 'active' : ''}`}
              onClick={() => setCurrentPage('gantt')}
            >
              <BarChart3 size={20} />
              <span>Gantt</span>
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
              className={`sidebar-nav-item ${currentPage === 'dev-activity' ? 'active' : ''}`}
              onClick={() => setCurrentPage('dev-activity')}
            >
              <Activity size={20} />
              <span>Dev Activity</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'pm-reports' ? 'active' : ''}`}
              onClick={() => setCurrentPage('pm-reports')}
            >
              <MessageSquare size={20} />
              <span>PM Reports</span>
            </button>
            <button
              className={`sidebar-nav-item ${currentPage === 'update-reminders' ? 'active' : ''}`}
              onClick={() => setCurrentPage('update-reminders')}
            >
              <span className="sidebar-nav-icon-rel">
                <Bell size={20} />
                {unreadQueueCount > 0 && <span className="sidebar-nav-badge-dot" />}
              </span>
              <span>Update Reminders</span>
            </button>
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
          <button className="hamburger-btn" onClick={() => setSidebarOpen(o => !o)} aria-label="Toggle menu">
            <Menu size={20} />
          </button>
          <h1 className="header-title">
            {currentPage === 'dashboard' && 'Dashboard'}
            {currentPage === 'board' && 'Board View'}
            {currentPage === 'list' && 'List View'}
            {currentPage === 'sprint-pulse' && 'Sprint Pulse'}
            {currentPage === 'daily-ops' && 'DailyOps'}
            {currentPage === 'calendar' && 'Calendar'}
            {currentPage === 'ai-analysis' && 'AI Task Analysis'}
            {currentPage === 'dev-activity' && 'Dev Activity'}
            {currentPage === 'pm-reports' && 'Reports'}
            {currentPage === 'team' && 'Team Management'}
            {currentPage === 'bots' && 'Bot Configuration'}
            {currentPage === 'settings' && 'Access Control'}
            {currentPage === 'integrations' && 'Integrations'}
            {currentPage === 'slack' && 'Slack Intelligence'}
            {currentPage === 'update-reminders' && 'Update Reminders'}
            {currentPage === 'activity' && 'Activity'}
            {currentPage === 'daytrack' && 'DayTrack'}
            {currentPage === 'gantt' && 'Gantt'}
            {currentPage === 'theme' && 'Theme'}
          </h1>
          <WorldClock />
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
          <div className="changelog-btn-wrap">
            <button
              className="changelog-btn"
              aria-label="What's New"
              onClick={(e) => {
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setChangelogAnchorRect(rect)
                setShowChangelog(o => !o)
                if (hasNewChangelog) setHasNewChangelog(false)
              }}
            >
              <Megaphone size={18} />
              {hasNewChangelog && <span className="changelog-dot" />}
            </button>
            {showChangelog && changelogAnchorRect && (
              <ChangelogPanel
                anchorRect={changelogAnchorRect}
                entries={changelogEntries}
                onClose={() => setShowChangelog(false)}
              />
            )}
          </div>
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
        {mountedTabs.has('sprint-pulse') && (
          <div className={currentPage !== 'sprint-pulse' ? 'dash-tab-hidden' : undefined}>
            <SprintPulsePage />
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
        {mountedTabs.has('gantt') && (
          <div className={currentPage !== 'gantt' ? 'dash-tab-hidden' : undefined} style={{ height: '100%' }}>
            <GanttPage />
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
            />
          </div>
        )}
        {mountedTabs.has('update-reminders') && (
          <div className={currentPage !== 'update-reminders' ? 'dash-tab-hidden' : undefined}>
            <UpdateRemindersTab
              initialTab={updateRemindersSubTab}
              onTabChange={(tab) => navigate(`/update-reminders/${tab}`)}
            />
          </div>
        )}
        {mountedTabs.has('ai-analysis') && (
          <div className={currentPage !== 'ai-analysis' ? 'dash-tab-hidden' : undefined}>
            <AIAnalysisPage onNavigateToDailyAnalysis={() => setCurrentPage('dev-activity')} />
          </div>
        )}
        {mountedTabs.has('dev-activity') && (
          <div className={currentPage !== 'dev-activity' ? 'dash-tab-hidden' : undefined}>
            <DevActivityPage />
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

      {/* Singleton hover card — one portal for the whole app */}
      <GlobalHoverCard />
    </div>
  )
}
