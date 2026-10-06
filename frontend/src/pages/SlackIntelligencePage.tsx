import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  RefreshCw, CheckCircle, Clock, X, MessageSquare, Search, Zap, Settings as SettingsIcon, Bell,
} from 'lucide-react'
import { TerminalLoader, SprintScanLoader, SvgTerminalLoader } from '@/components/brand/VelocityLoaders'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import api from '../services/api'
import type { SlackMention, SlackThread, ReminderItem, ChannelRef, SlackWorkspaceUser } from '../services/api'
import { SlackIcon, MentionCard, ThreadCard, isSnoozed, cleanSlackText, timeAgo } from './SlackCards'
import { SettingsTabContent, RemindersTabContent, getPresetDate } from './SlackTabs'
import type { Preset } from './SlackTabs'
import { SlackMessagesHub } from './SlackMessagesHub'
import { BotConversationsView } from '@/components/SlackBotConversations'
import { useAuth } from '@/contexts/AuthContext'
import '../styles/pages/slack.css'

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = 'inbox' | 'messages' | 'mcp-activity'
type InboxView = 'mentions' | 'threads'
type InboxFilter = 'Needs Action' | 'Pinned' | 'All' | 'Snoozed' | 'Resolved'

// ── Props ─────────────────────────────────────────────────────────────────────
interface SlackIntelligencePageProps {
  initialTab?: Tab
  onTabChange?: (tab: Tab) => void
}

// ── Main Component ────────────────────────────────────────────────────────────
export function SlackIntelligencePage({
  initialTab = 'messages',
  onTabChange,
}: SlackIntelligencePageProps) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [tab, setTab] = useState<Tab>(initialTab)
  const [inboxView, setInboxView] = useState<InboxView>('mentions')
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>('Needs Action')
  const [search, setSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [remindersOpen, setRemindersOpen] = useState(false)

  useEffect(() => { setTab(initialTab) }, [initialTab])
  const handleTabChange = (t: Tab) => { setTab(t); onTabChange?.(t) }
  const goToInbox = (view: InboxView, filter?: InboxFilter) => {
    handleTabChange('inbox')
    setInboxView(view)
    if (filter) setInboxFilter(filter)
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  const [mentions, setMentions] = useState<SlackMention[]>([])
  // Full, unbounded pinned-mentions list — `mentions` above is capped to the
  // 50 most recent, so an older pin would silently vanish from the Pinned
  // filter if we filtered `mentions` alone. Fetched lazily the first time the
  // Pinned filter is selected.
  const [pinnedMentions, setPinnedMentions] = useState<SlackMention[]>([])
  const [pinnedLoaded, setPinnedLoaded] = useState(false)
  const [threads, setThreads] = useState<SlackThread[]>([])
  const [remindersAll, setRemindersAll] = useState<ReminderItem[]>([])
  const [savedTemplates, setSavedTemplates] = useState<Array<{ id: string; body: string }>>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [slackChannels, setSlackChannels] = useState<ChannelRef[]>([])
  const [workspaceUsers, setWorkspaceUsers] = useState<SlackWorkspaceUser[]>([])
  // Resolves <@USERID> mention tokens to real display names — same map shape
  // used in Messages, so a mentioned user's name renders identically (and
  // highlighted, not a raw ID) everywhere Slack text is shown.
  const userMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of workspaceUsers) m.set(u.id, u.profile.display_name || u.real_name || u.name)
    return m
  }, [workspaceUsers])

  // ── Settings state ────────────────────────────────────────────────────────
  const [slackTeamId, setSlackTeamId] = useState('T03Q9638YJJ')
  const [monitorChannelId, setMonitorChannelId] = useState('')
  const [monitorChannelName, setMonitorChannelName] = useState('')
  const [resolvedMonitorChannelName, setResolvedMonitorChannelName] = useState('')

  // ── Scan state ────────────────────────────────────────────────────────────
  const [scanning, setScanning] = useState(false)
  const [lastScan, setLastScan] = useState<Date | null>(null)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const autoScanRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Reminder modal state ──────────────────────────────────────────────────
  const [reminderModal, setReminderModal] = useState<{ mention?: SlackMention; thread?: SlackThread } | null>(null)
  const [reminderDate, setReminderDate] = useState(new Date(Date.now() + 86400000).toISOString().split('T')[0])
  const [reminderNote, setReminderNote] = useState('')
  const [savingReminder, setSavingReminder] = useState(false)

  // ── Data fetchers ─────────────────────────────────────────────────────────
  const fetchMentions = useCallback(async () => {
    try { const res: any = await api.getSlackMentions(); if (res.success) setMentions(res.mentions ?? []) }
    catch { setFetchError('Could not load mentions. Check your Slack connection.') }
  }, [])

  const fetchThreads = useCallback(async () => {
    try { const res: any = await api.getSlackThreads(); if (res.success) setThreads(res.threads ?? []) }
    catch { setFetchError('Could not load threads.') }
  }, [])

  const fetchPinnedMentions = useCallback(async () => {
    try { const res = await api.getSlackPinnedMentions(); setPinnedMentions(res.mentions ?? []) }
    catch {}
    finally { setPinnedLoaded(true) }
  }, [])

  const fetchReminders = useCallback(async () => {
    try { const res = await api.getReminders(); if (res.success && res.data) setRemindersAll(res.data) }
    catch {}
  }, [])

  const fetchTemplates = useCallback(async () => {
    try { const res = await api.getSlackTemplates(); setSavedTemplates(res.templates ?? []) }
    catch {}
  }, [])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    await Promise.all([fetchMentions(), fetchThreads(), fetchReminders(), fetchTemplates()])
    setLoading(false)
  }, [fetchMentions, fetchThreads, fetchReminders, fetchTemplates])

  useEffect(() => {
    fetchAll()
    api.getSlackStatus().then((res: any) => {
      if (res.team_id) setSlackTeamId(res.team_id)
      if (res.monitor_channel_id) setMonitorChannelId(res.monitor_channel_id)
      const resolvedName = res.monitor_channel_name || res.channel_name || ''
      if (resolvedName) {
        setMonitorChannelName(resolvedName)
        setResolvedMonitorChannelName(resolvedName)
      }
    }).catch(() => {})
    api.getSlackChannels().then(res => {
      if (Array.isArray(res)) setSlackChannels(res.map((c: any) => ({ id: c.id, name: c.name })))
    }).catch(() => {})
    api.getWorkspaceUsers().then(res => setWorkspaceUsers((res as unknown as SlackWorkspaceUser[]) ?? [])).catch(() => {})
  }, [fetchAll])

  // Refetch the full pinned list each time the Pinned filter is opened, since
  // pin/unpin toggles happen inside MentionCard and don't update this page's
  // `mentions` array directly.
  useEffect(() => {
    if (tab === 'inbox' && inboxView === 'mentions' && inboxFilter === 'Pinned') fetchPinnedMentions()
  }, [tab, inboxView, inboxFilter, fetchPinnedMentions])

  // Auto-scan every 15 min
  useEffect(() => {
    autoScanRef.current = setInterval(async () => {
      try {
        const res: any = await api.scanSlack()
        if (res.success) {
          setLastScan(new Date())
          if (res.new_mentions > 0 || res.new_threads > 0) {
            await fetchMentions()
            await fetchThreads()
          }
        }
      } catch {}
    }, 15 * 60 * 1000)
    return () => { if (autoScanRef.current) clearInterval(autoScanRef.current) }
  }, [fetchMentions, fetchThreads])

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleScan = async () => {
    setScanning(true); setScanMsg(null)
    try {
      const res: any = await api.scanSlack()
      if (res.success) {
        setLastScan(new Date())
        setScanMsg(res.new_mentions > 0 || res.new_threads > 0
          ? `↑ ${res.new_mentions} new mention(s), ${res.new_threads} new thread(s)`
          : 'All caught up')
        await fetchMentions()
        await fetchThreads()
      }
    } catch (e) { setScanMsg(e instanceof Error ? e.message : 'Scan failed') }
    setScanning(false)
  }

  const handleDismiss = async (messageTS: string) => {
    await api.dismissSlackMention(messageTS).catch(() => {})
    setMentions(prev => prev.map(m => m.message_ts === messageTS ? { ...m, replied: true } : m))
  }

  const handleDismissThread = async (threadTS: string) => {
    await api.dismissSlackThread(threadTS).catch(() => {})
    setThreads(prev => prev.map(t => t.thread_ts === threadTS ? { ...t, dismissed: true } : t))
  }

  const handleSnooze = async (type: 'mention' | 'thread', ts: string, until: '2h' | 'tomorrow') => {
    const snoozedUntil = until === 'tomorrow'
      ? new Date(new Date().setDate(new Date().getDate() + 1)).toISOString()
      : new Date(Date.now() + 2 * 3600000).toISOString()
    if (type === 'mention') {
      await api.snoozeSlackMention(ts, until).catch(() => {})
      setMentions(prev => prev.map(m => m.message_ts === ts ? { ...m, snoozed_until: snoozedUntil } : m))
    } else {
      await api.snoozeSlackThread(ts, until).catch(() => {})
      setThreads(prev => prev.map(t => t.thread_ts === ts ? { ...t, snoozed_until: snoozedUntil } : t))
    }
  }

  const handleSaveReminder = async () => {
    if (!reminderModal) return
    setSavingReminder(true)
    try {
      const { mention, thread } = reminderModal
      const res = await api.createSlackFollowupReminder({
        thread_ts: mention?.thread_ts ?? mention?.message_ts ?? thread?.thread_ts ?? '',
        channel_id: mention?.channel_id ?? thread?.channel_id ?? '',
        message_text: mention?.message_text ?? thread?.message_text ?? '',
        follow_up_date: reminderDate,
        note: reminderNote,
      })
      if (res.success) { await fetchReminders(); setTimeout(() => setReminderModal(null), 1200) }
    } catch {}
    setSavingReminder(false)
  }

  const handleAddTemplate = async (body: string) => {
    try {
      const res = await api.createSlackTemplate(body)
      if (res.ok) setSavedTemplates(prev => [...prev, { id: res.id, body }])
    } catch {}
  }

  const handleDeleteTemplate = async (id: string) => {
    await api.deleteSlackTemplate(id).catch(() => {})
    setSavedTemplates(prev => prev.filter(t => t.id !== id))
  }

  const handleSaveChannel = async () => {
    if (!monitorChannelId.trim()) return
    await api.setSlackMonitorChannel(monitorChannelId.trim(), monitorChannelName.trim() || monitorChannelId.trim())
    setResolvedMonitorChannelName(monitorChannelName.trim() || monitorChannelId.trim())
  }

  const handleQuickAdd = async (preset: Preset, title: string, issueId: string) => {
    try {
      await api.createReminder({ title, target_date: getPresetDate(preset), type: 'custom', related_issue_id: issueId || undefined })
      fetchReminders()
    } catch {}
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const needsActionCount = mentions.filter(m => !m.replied && !isSnoozed(m.snoozed_until)).length
    + threads.filter(t => !t.has_reply && !t.dismissed && !isSnoozed(t.snoozed_until)).length

  const upcomingReminders = remindersAll.filter(r => r.status === 'pending' && r.type === 'custom')

  const visibleMentions = (() => {
    let list = inboxFilter === 'Pinned' ? pinnedMentions : mentions
    if (inboxFilter === 'Needs Action') list = list.filter(m => !m.replied && !isSnoozed(m.snoozed_until))
    else if (inboxFilter === 'Snoozed') list = list.filter(m => isSnoozed(m.snoozed_until))
    else if (inboxFilter === 'Resolved') list = list.filter(m => m.replied)
    if (search.trim()) list = list.filter(m =>
      cleanSlackText(m.message_text, userMap).toLowerCase().includes(search.toLowerCase()) ||
      m.sender_name.toLowerCase().includes(search.toLowerCase())
    )
    return [...list].sort((a, b) => {
      if (!a.replied && b.replied) return -1
      if (a.replied && !b.replied) return 1
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  })()

  const visibleThreads = (() => {
    let list = threads
    if (inboxFilter === 'Needs Action') list = list.filter(t => !t.has_reply && !t.dismissed && !isSnoozed(t.snoozed_until))
    else if (inboxFilter === 'Snoozed') list = list.filter(t => isSnoozed(t.snoozed_until))
    else if (inboxFilter === 'Resolved') list = list.filter(t => t.has_reply || t.dismissed)
    if (search.trim()) list = list.filter(t => cleanSlackText(t.message_text, userMap).toLowerCase().includes(search.toLowerCase()))
    return list
  })()

  const lastScanLabel = lastScan ? `Last scan ${timeAgo(lastScan.toISOString())}` : 'Last scan 4m ago'

  const TABS: Array<{ id: Tab; label: string; badge?: number | 'dot' }> = [
    { id: 'messages', label: 'Messages' },
    { id: 'inbox',    label: 'Inbox', badge: needsActionCount > 0 ? needsActionCount : undefined },
    { id: 'mcp-activity', label: 'MCP Activity' },
  ]

  const INBOX_FILTERS: InboxFilter[] = ['Needs Action', 'Pinned', 'All', 'Snoozed', 'Resolved']
  const THREAD_FILTERS: InboxFilter[] = ['Needs Action', 'All', 'Snoozed', 'Resolved']

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="si2-page">

      {/* Header */}
      <div className="si2-header">
        <div className="si2-header-left">
          <SlackIcon size={22} />
          <span className="si2-header-title">Slack Intelligence</span>
          {needsActionCount > 0 && <span className="si2-header-badge">{needsActionCount} actions</span>}
        </div>
        <div className="si2-header-right">
          <span className="si2-scan-label"><Zap size={11} /> {lastScanLabel}</span>
          <button className={`si2-scan-btn${scanning ? ' scanning' : ''}`} onClick={handleScan} disabled={scanning}>
            <RefreshCw size={13} className={scanning ? 'spin' : ''} />
            {scanning ? 'Scanning…' : 'Scan Now'}
          </button>
          <button className="si2-icon-btn" onClick={() => setRemindersOpen(true)} title="Reminders" aria-label="Reminders">
            <Bell size={15} />
            {upcomingReminders.length > 0 && <span className="si2-icon-btn-dot" />}
          </button>
          <button className="si2-icon-btn" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
            <SettingsIcon size={15} />
          </button>
        </div>
      </div>

      {scanMsg && (
        <div className={`si2-scan-msg${scanMsg === 'All caught up' ? ' ok' : ''}`}>{scanMsg}</div>
      )}

      {fetchError && (
        <div className="si2-scan-msg" style={{ background: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.3)', color: '#f87171' }}>
          {fetchError}
          <button onClick={() => { setFetchError(null); fetchAll() }} style={{ marginLeft: 8, textDecoration: 'underline', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 'inherit' }}>Retry</button>
        </div>
      )}

      {/* KPI row */}
      <div className="si2-kpi-row">
        {[
          { label: 'TOTAL MENTIONS',  value: mentions.length,                                  color: '#93c5fd', glow: '#3b82f6', sub: 'unreplied @mentions', view: 'mentions' as InboxView, filterTarget: 'All' as InboxFilter },
          { label: 'NEEDS ACTION',    value: needsActionCount,                                  color: '#f87171', glow: '#ef4444', sub: 'follow up needed',    view: 'mentions' as InboxView, filterTarget: 'Needs Action' as InboxFilter },
          { label: 'SNOOZED',         value: mentions.filter(m => isSnoozed(m.snoozed_until)).length, color: '#fcd34d', glow: '#f59e0b', sub: 'check later',  view: 'mentions' as InboxView, filterTarget: 'Snoozed' as InboxFilter },
          { label: 'MY THREADS',      value: threads.length,                                    color: '#c4b5fd', glow: '#8b5cf6', sub: 'unanswered threads',  view: 'threads' as InboxView,  filterTarget: undefined },
        ].map((k, i) => (
          <div
            key={k.label}
            className="si2-kpi-card"
            style={{ animationDelay: `${i * 60}ms`, cursor: 'pointer' }}
            onClick={() => goToInbox(k.view, k.filterTarget)}
          >
            <div className="si2-kpi-glow" style={{ background: `radial-gradient(circle, ${k.glow} 0%, transparent 70%)` }} />
            <div className="si2-kpi-label">{k.label}</div>
            <div className="si2-kpi-value" style={{ color: k.color }}>{k.value}</div>
            <div className="si2-kpi-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div className="si2-tabbar">
        {TABS.map(t => (
          <button key={t.id} className={`si2-tab${tab === t.id ? ' active' : ''}`} onClick={() => handleTabChange(t.id)}>
            {t.label}
            {t.badge === 'dot'
              ? <span className="si2-tab-dot" />
              : t.badge ? <span className="si2-tab-badge">{t.badge}</span>
              : null}
          </button>
        ))}
      </div>

      {/* Mentions/Threads toggle + search + filter row (inbox only) */}
      {tab === 'inbox' && (
        <div className="si2-controls">
          <div className="si2-view-toggle">
            <button className={`si2-view-toggle-btn${inboxView === 'mentions' ? ' active' : ''}`} onClick={() => setInboxView('mentions')}>
              Mentions
            </button>
            <button className={`si2-view-toggle-btn${inboxView === 'threads' ? ' active' : ''}`} onClick={() => setInboxView('threads')}>
              Threads
            </button>
          </div>
          <div className="si2-search-wrap">
            <Search size={13} className="si2-search-icon" />
            <input
              className="si2-search"
              placeholder="Search mentions, channels, tickets…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="si2-filters">
            {(inboxView === 'mentions' ? INBOX_FILTERS : THREAD_FILTERS).map(f => (
              <button
                key={f}
                className={`si2-filter-btn${inboxFilter === f ? ' active' : ''}`}
                onClick={() => setInboxFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tab content */}
      <div className="si2-content">

        {tab === 'inbox' && inboxView === 'mentions' && (
          (loading || (inboxFilter === 'Pinned' && !pinnedLoaded))
            ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0' }}>
                <SvgTerminalLoader size={128} />
              </div>
            : visibleMentions.length === 0
              ? <div className="si2-empty">
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                    <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
                  </div>
                  <CheckCircle size={36} />
                  <p>{inboxFilter === 'Pinned' ? 'No pinned messages' : 'Inbox zero — no unread @mentions'}</p>
                  <p className="si2-empty-sub">
                    {inboxFilter === 'Pinned' ? 'Pin any mention using the star icon on the card — it shows up here.' : 'Click Scan Now to check for new mentions.'}
                  </p>
                </div>
              : <div className="si2-card-list">
                  {visibleMentions.map(m => (
                    <MentionCard
                      key={m.id}
                      m={m}
                      slackTeamId={slackTeamId}
                      channelName={resolvedMonitorChannelName}
                      savedTemplates={savedTemplates.map(t => t.body)}
                      onDismiss={handleDismiss}
                      onSnooze={(ts, until) => handleSnooze('mention', ts, until)}
                      onRemind={m => setReminderModal({ mention: m })}
                      userMap={userMap}
                    />
                  ))}
                </div>
        )}

        {tab === 'inbox' && inboxView === 'threads' && (
          loading
            ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0' }}>
                <SvgTerminalLoader size={128} />
              </div>
            : visibleThreads.length === 0
              ? <div className="si2-empty">
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                    <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
                  </div>
                  <MessageSquare size={36} />
                  <p>{inboxFilter === 'Resolved' ? 'No resolved threads' : 'No unanswered threads'}</p>
                </div>
              : <div className="si2-card-list">
                  {visibleThreads.map(t => (
                    <ThreadCard
                      key={t.id}
                      t={t}
                      slackTeamId={slackTeamId}
                      channelName={resolvedMonitorChannelName}
                      savedTemplates={savedTemplates.map(t => t.body)}
                      onDismiss={handleDismissThread}
                      onSnooze={(ts, until) => handleSnooze('thread', ts, until)}
                      onRemind={t => setReminderModal({ thread: t })}
                      userMap={userMap}
                    />
                  ))}
                </div>
        )}

        {tab === 'messages' && <SlackMessagesHub />}

        {tab === 'mcp-activity' && <BotConversationsView isAdmin={isAdmin} />}
      </div>

      {/* Reminder modal */}
      {reminderModal && (
        <div className="si2-modal-overlay" onClick={() => setReminderModal(null)}>
          <div className="si2-modal" onClick={e => e.stopPropagation()}>
            <div className="si2-modal-header">
              <Clock size={16} />
              <h3>Set Follow-up Reminder</h3>
              <button className="si2-modal-close" onClick={() => setReminderModal(null)}><X size={14} /></button>
            </div>
            <div className="si2-modal-body">
              <p className="si2-modal-preview">
                {cleanSlackText(
                  (reminderModal.mention?.message_text ?? reminderModal.thread?.message_text ?? '').slice(0, 100),
                  userMap
                )}
              </p>
              <label className="si2-modal-label">Remind me on</label>
              <input type="date" className="si2-input" value={reminderDate} onChange={e => setReminderDate(e.target.value)} />
              <label className="si2-modal-label">Note (optional)</label>
              <input type="text" className="si2-input" placeholder="What to follow up on…" value={reminderNote} onChange={e => setReminderNote(e.target.value)} />
            </div>
            <div className="si2-modal-footer">
              <button className="si2-cancel-btn" onClick={() => setReminderModal(null)}>Cancel</button>
              <button className="si2-save-btn" onClick={handleSaveReminder} disabled={savingReminder}>
                {savingReminder ? 'Saving…' : 'Save Reminder'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings popover */}
      {settingsOpen && (
        <div className="si2-modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="si2-modal" onClick={e => e.stopPropagation()}>
            <div className="si2-modal-header">
              <SettingsIcon size={16} />
              <h3>Settings</h3>
              <button className="si2-modal-close" onClick={() => setSettingsOpen(false)}><X size={14} /></button>
            </div>
            {loading
              ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0' }}>
                  <SprintScanLoader size={48} />
                </div>
              : <SettingsTabContent
                  monitorChannelId={monitorChannelId}
                  monitorChannelName={monitorChannelName}
                  lastScan={lastScan}
                  onSaveChannel={handleSaveChannel}
                  onChannelIdChange={setMonitorChannelId}
                  onChannelNameChange={setMonitorChannelName}
                />
            }
          </div>
        </div>
      )}

      {/* Reminders panel */}
      {remindersOpen && (
        <div className="si2-modal-overlay" onClick={() => setRemindersOpen(false)}>
          <div className="si2-modal si2-modal--lg" onClick={e => e.stopPropagation()}>
            <div className="si2-modal-header">
              <Bell size={16} />
              <h3>Reminders</h3>
              <button className="si2-modal-close" onClick={() => setRemindersOpen(false)}><X size={14} /></button>
            </div>
            {loading
              ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0' }}>
                  <SprintScanLoader size={48} />
                </div>
              : <RemindersTabContent
                  remindersAll={remindersAll}
                  savedTemplates={savedTemplates}
                  onAddTemplate={handleAddTemplate}
                  onDeleteTemplate={handleDeleteTemplate}
                  onDismiss={async id => { await api.dismissReminder(id).catch(() => {}); setRemindersAll(prev => prev.filter(r => r.id !== id)) }}
                  onDelete={async id => { await api.deleteReminder(id).catch(() => {}); setRemindersAll(prev => prev.filter(r => r.id !== id)) }}
                  onQuickAdd={handleQuickAdd}
                />
            }
          </div>
        </div>
      )}
    </div>
  )
}
