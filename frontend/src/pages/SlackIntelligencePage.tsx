import { useState, useEffect, useCallback, useRef } from 'react'
import {
  RefreshCw, CheckCircle, Clock, X, MessageSquare, Search, Zap,
} from 'lucide-react'
import api from '../services/api'
import type { SlackMention, SlackThread, ReminderItem } from '../services/api'
import { SlackIcon, MentionCard, ThreadCard, isSnoozed, cleanSlackText, timeAgo } from './SlackCards'
import { SprintPulseTab, SavedItemsTab, SettingsTabContent, RemindersTabContent, getPresetDate } from './SlackTabs'
import type { Preset } from './SlackTabs'
import '../styles/pages/slack.css'

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = 'inbox' | 'threads' | 'reminders' | 'pulse' | 'saved' | 'settings'
type InboxFilter = 'Needs Action' | 'Pinned' | 'All' | 'Snoozed' | 'Resolved'

// ── Props ─────────────────────────────────────────────────────────────────────
interface SlackIntelligencePageProps {
  initialTab?: Tab
  onTabChange?: (tab: Tab) => void
  onOpenPMAssistant?: () => void
}

// ── Main Component ────────────────────────────────────────────────────────────
export function SlackIntelligencePage({
  initialTab = 'inbox',
  onTabChange,
  onOpenPMAssistant,
}: SlackIntelligencePageProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>('Needs Action')
  const [search, setSearch] = useState('')

  useEffect(() => { setTab(initialTab) }, [initialTab])
  const handleTabChange = (t: Tab) => { setTab(t); onTabChange?.(t) }

  // ── Data ──────────────────────────────────────────────────────────────────
  const [mentions, setMentions] = useState<SlackMention[]>([])
  const [threads, setThreads] = useState<SlackThread[]>([])
  const [remindersAll, setRemindersAll] = useState<ReminderItem[]>([])
  const [savedTemplates, setSavedTemplates] = useState<Array<{ id: string; body: string }>>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // ── Settings state ────────────────────────────────────────────────────────
  const [slackTeamId, setSlackTeamId] = useState('T03Q9638YJJ')
  const [monitorChannelId, setMonitorChannelId] = useState('')
  const [monitorChannelName, setMonitorChannelName] = useState('')
  const [resolvedMonitorChannelName, setResolvedMonitorChannelName] = useState('')
  const [ytBaseUrl, setYtBaseUrl] = useState('')

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
      if (res.monitor_channel_name) {
        setMonitorChannelName(res.monitor_channel_name)
        setResolvedMonitorChannelName(res.monitor_channel_name)
      }
    }).catch(() => {})
    api.getYouTrackStatus().then(res => {
      if (res.base_url) setYtBaseUrl(res.base_url.replace(/\/$/, ''))
    }).catch(() => {})
  }, [fetchAll])

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
    + threads.filter(t => !t.has_reply && !isSnoozed(t.snoozed_until)).length

  const upcomingReminders = remindersAll.filter(r => r.status === 'pending' && r.type === 'custom')

  const visibleMentions = (() => {
    let list = mentions
    if (inboxFilter === 'Needs Action') list = list.filter(m => !m.replied && !isSnoozed(m.snoozed_until))
    else if (inboxFilter === 'Pinned') list = list.filter(m => m.pinned)
    else if (inboxFilter === 'Snoozed') list = list.filter(m => isSnoozed(m.snoozed_until))
    else if (inboxFilter === 'Resolved') list = list.filter(m => m.replied)
    if (search.trim()) list = list.filter(m =>
      cleanSlackText(m.message_text).toLowerCase().includes(search.toLowerCase()) ||
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
    if (inboxFilter === 'Needs Action') list = list.filter(t => !t.has_reply && !isSnoozed(t.snoozed_until))
    else if (inboxFilter === 'Snoozed') list = list.filter(t => isSnoozed(t.snoozed_until))
    if (search.trim()) list = list.filter(t => cleanSlackText(t.message_text).toLowerCase().includes(search.toLowerCase()))
    return list
  })()

  const lastScanLabel = lastScan ? `Last scan ${timeAgo(lastScan.toISOString())}` : 'Last scan 4m ago'

  const TABS: Array<{ id: Tab; label: string; badge?: number | 'dot' }> = [
    { id: 'inbox',    label: 'Priority Inbox', badge: needsActionCount > 0 ? needsActionCount : undefined },
    { id: 'threads',  label: 'My Threads',     badge: threads.filter(t => !t.has_reply && !isSnoozed(t.snoozed_until)).length || undefined },
    { id: 'reminders',label: 'Reminders',      badge: upcomingReminders.length || undefined },
    { id: 'pulse',    label: 'Sprint Pulse',   badge: 'dot' },
    { id: 'saved',    label: 'Saved' },
    { id: 'settings', label: 'Settings' },
  ]

  const INBOX_FILTERS: InboxFilter[] = ['Needs Action', 'Pinned', 'All', 'Snoozed', 'Resolved']
  const THREAD_FILTERS: InboxFilter[] = ['Needs Action', 'All', 'Snoozed']

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
          { label: 'TOTAL MENTIONS',  value: mentions.length,                                  color: '#93c5fd', glow: '#3b82f6', sub: 'unreplied @mentions', tabTarget: 'inbox' as Tab,    filterTarget: 'All' as InboxFilter },
          { label: 'NEEDS ACTION',    value: needsActionCount,                                  color: '#f87171', glow: '#ef4444', sub: 'follow up needed',    tabTarget: 'inbox' as Tab,    filterTarget: 'Needs Action' as InboxFilter },
          { label: 'SNOOZED',         value: mentions.filter(m => isSnoozed(m.snoozed_until)).length, color: '#fcd34d', glow: '#f59e0b', sub: 'check later',  tabTarget: 'inbox' as Tab,    filterTarget: 'Snoozed' as InboxFilter },
          { label: 'MY THREADS',      value: threads.length,                                    color: '#c4b5fd', glow: '#8b5cf6', sub: 'unanswered threads',  tabTarget: 'threads' as Tab,  filterTarget: null },
        ].map((k, i) => (
          <div
            key={k.label}
            className="si2-kpi-card"
            style={{ animationDelay: `${i * 60}ms`, cursor: 'pointer' }}
            onClick={() => {
              handleTabChange(k.tabTarget)
              if (k.filterTarget) setInboxFilter(k.filterTarget)
            }}
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

      {/* Search + filter row (inbox / threads only) */}
      {(tab === 'inbox' || tab === 'threads') && (
        <div className="si2-controls">
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
            {(tab === 'inbox' ? INBOX_FILTERS : THREAD_FILTERS).map(f => (
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

        {tab === 'inbox' && (
          loading
            ? <div className="si2-empty"><RefreshCw size={20} className="spin" /><p>Loading…</p></div>
            : visibleMentions.length === 0
              ? <div className="si2-empty">
                  <CheckCircle size={36} />
                  <p>Inbox zero — no unread @mentions</p>
                  <p className="si2-empty-sub">Click Scan Now to check for new mentions.</p>
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
                    />
                  ))}
                </div>
        )}

        {tab === 'threads' && (
          loading
            ? <div className="si2-empty"><RefreshCw size={20} className="spin" /><p>Loading…</p></div>
            : visibleThreads.length === 0
              ? <div className="si2-empty"><MessageSquare size={36} /><p>No unanswered threads</p></div>
              : <div className="si2-card-list">
                  {visibleThreads.map(t => (
                    <ThreadCard
                      key={t.id}
                      t={t}
                      slackTeamId={slackTeamId}
                      channelName={resolvedMonitorChannelName}
                      savedTemplates={savedTemplates.map(t => t.body)}
                      onSnooze={(ts, until) => handleSnooze('thread', ts, until)}
                      onRemind={t => setReminderModal({ thread: t })}
                    />
                  ))}
                </div>
        )}

        {tab === 'reminders' && (
          <RemindersTabContent
            remindersAll={remindersAll}
            savedTemplates={savedTemplates}
            onAddTemplate={handleAddTemplate}
            onDeleteTemplate={handleDeleteTemplate}
            onDismiss={async id => { await api.dismissReminder(id).catch(() => {}); setRemindersAll(prev => prev.filter(r => r.id !== id)) }}
            onDelete={async id => { await api.deleteReminder(id).catch(() => {}); setRemindersAll(prev => prev.filter(r => r.id !== id)) }}
            onQuickAdd={handleQuickAdd}
          />
        )}

        {tab === 'pulse' && <SprintPulseTab onOpenPMAssistant={onOpenPMAssistant} ytBaseUrl={ytBaseUrl} />}

        {tab === 'saved' && <SavedItemsTab slackTeamId={slackTeamId} />}

        {tab === 'settings' && (
          <SettingsTabContent
            monitorChannelId={monitorChannelId}
            monitorChannelName={monitorChannelName}
            lastScan={lastScan}
            onSaveChannel={handleSaveChannel}
            onChannelIdChange={setMonitorChannelId}
            onChannelNameChange={setMonitorChannelName}
          />
        )}
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
                  (reminderModal.mention?.message_text ?? reminderModal.thread?.message_text ?? '').slice(0, 100)
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
    </div>
  )
}
