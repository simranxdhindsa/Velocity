import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'
import type { ReminderItem, SlackMention } from '../services/api'
import { SprintScanLoader } from '@/components/brand/VelocityLoaders'
import { Bell, Trash2, Clock, CheckCircle, AlertTriangle, Calendar, X, RefreshCw, MessageSquare } from 'lucide-react'

type Tab = 'upcoming' | 'sent' | 'auto'
type Preset = 'tomorrow' | 'in2days' | 'nextmon' | 'in1week'

function getPresetDate(preset: Preset): string {
  const d = new Date()
  if (preset === 'tomorrow') {
    d.setDate(d.getDate() + 1)
  } else if (preset === 'in2days') {
    d.setDate(d.getDate() + 2)
  } else if (preset === 'nextmon') {
    const day = d.getDay()
    const daysUntilMon = day === 0 ? 1 : 8 - day
    d.setDate(d.getDate() + daysUntilMon)
  } else if (preset === 'in1week') {
    d.setDate(d.getDate() + 7)
  }
  return d.toISOString().split('T')[0]
}

function formatRelDate(dateStr: string) {
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString()
}

const PRESET_LABELS: Record<Preset, string> = {
  tomorrow: 'Tomorrow',
  in2days: 'In 2 days',
  nextmon: 'Next Monday',
  in1week: 'In 1 week',
}

function cleanSlackText(text: string): string {
  return text
    .replace(/<@U[A-Z0-9]+>/g, '@user')
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<#C[A-Z0-9]+>/g, '#channel')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<https?:[^>]+>/g, '[link]')
    .replace(/\n+/g, ' ')
    .trim()
}

function getTypeLabel(type: string) {
  switch (type) {
    case 'task_followup': return 'Follow-up'
    case 'blocked_issue': return 'Blocker'
    case 'update_check': return 'Update Check'
    case 'daily_digest': return 'Daily Digest'
    case 'slack_followup': return 'Slack Follow-up'
    default: return 'Custom'
  }
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'sent': return <CheckCircle size={14} className="icon-success" />
    case 'pending': return <Clock size={14} className="icon-warning" />
    default: return <Bell size={14} />
  }
}

export function RemindersPage() {
  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [mentions, setMentions] = useState<SlackMention[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('upcoming')
  const [slackTeamId, setSlackTeamId] = useState('')

  // Quick-add state
  const [activePreset, setActivePreset] = useState<Preset | null>(null)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickIssueId, setQuickIssueId] = useState('')
  const [creating, setCreating] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [remRes, mentRes] = await Promise.allSettled([
        api.getReminders(),
        api.getSlackMentions(),
      ])
      if (remRes.status === 'fulfilled' && remRes.value.success && remRes.value.data) {
        setReminders(remRes.value.data)
      }
      if (mentRes.status === 'fulfilled') {
        const val = mentRes.value as { success: boolean; mentions?: SlackMention[] }
        if (val.success && val.mentions) {
          setMentions(val.mentions.filter(m => !m.replied))
        }
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    api.getSlackStatus().then((res: any) => {
      if (res.team_id) setSlackTeamId(res.team_id)
    }).catch(() => {})
  }, [fetchAll])

  const openSlack = (channelId: string, messageTs: string) => {
    const ts = messageTs.replace('.', '')
    const appUrl = `slack://channel?team=${slackTeamId}&id=${channelId}&message=${ts}`
    const webUrl = `https://app.slack.com/client/${slackTeamId}/${channelId}/p${ts}`
    window.location.href = appUrl
    setTimeout(() => window.open(webUrl, '_blank', 'noopener,noreferrer'), 1500)
  }

  const handlePresetClick = (preset: Preset) => {
    if (activePreset === preset) {
      setActivePreset(null)
      setQuickTitle('')
      setQuickIssueId('')
    } else {
      setActivePreset(preset)
      setQuickTitle('')
      setQuickIssueId('')
    }
  }

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activePreset || !quickTitle.trim()) return
    setCreating(true)
    setError(null)
    try {
      const res = await api.createReminder({
        title: quickTitle.trim(),
        target_date: getPresetDate(activePreset),
        type: 'custom',
        related_issue_id: quickIssueId.trim() || undefined,
      })
      if (res.success) {
        setActivePreset(null)
        setQuickTitle('')
        setQuickIssueId('')
        setTab('upcoming')
        fetchAll()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create reminder')
    } finally {
      setCreating(false)
    }
  }

  const handleDismiss = async (id: string) => {
    try {
      await api.dismissReminder(id)
      setReminders(prev => prev.filter(r => r.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss reminder')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.deleteReminder(id)
      setReminders(prev => prev.filter(r => r.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete reminder')
    }
  }

  const handleResolveMention = async (messageTS: string) => {
    try {
      await api.dismissSlackMention(messageTS)
      setMentions(prev => prev.filter(m => m.message_ts !== messageTS))
    } catch {
      // silently fail — mention list will refresh on next load
    }
  }

  const upcomingReminders = reminders
    .filter(r => r.status === 'pending')
    .sort((a, b) => a.target_date.localeCompare(b.target_date))

  const sentReminders = reminders
    .filter(r => r.status === 'sent')
    .sort((a, b) => b.target_date.localeCompare(a.target_date))
    .slice(0, 30)

  const autoReminders = reminders
    .filter(r => r.type !== 'custom')
    .sort((a, b) => b.target_date.localeCompare(a.target_date))

  return (
    <div className="reminders-page">
      <div className="reminders-page-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={fetchAll}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && (
        <div className="alert alert-error">
          <AlertTriangle size={16} /> {error}
          <button className="alert-close" onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {/* Quick-Add Preset Bar */}
      <div className="reminder-quick-add-bar glass-card">
        <div className="reminder-quick-add-presets">
          {(Object.keys(PRESET_LABELS) as Preset[]).map(p => (
            <button
              key={p}
              className={`reminder-preset-btn${activePreset === p ? ' active' : ''}`}
              onClick={() => handlePresetClick(p)}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>

        {activePreset && (
          <form className="reminder-quick-add" onSubmit={handleQuickAdd}>
            <div className="reminder-quick-add-date">
              <Clock size={13} />
              <span>{getPresetDate(activePreset)}</span>
            </div>
            <input
              type="text"
              className="form-input"
              placeholder="Reminder title…"
              value={quickTitle}
              onChange={e => setQuickTitle(e.target.value)}
              autoFocus
              required
            />
            <input
              type="text"
              className="form-input reminder-quick-issue"
              placeholder="Issue ID (optional)"
              value={quickIssueId}
              onChange={e => setQuickIssueId(e.target.value)}
            />
            <div className="reminder-quick-actions">
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={creating || !quickTitle.trim()}
              >
                {creating ? 'Setting…' : 'Set Reminder'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => { setActivePreset(null); setQuickTitle(''); setQuickIssueId('') }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Tabs */}
      <div className="reminder-tabs">
        <button
          className={`rp-tab${tab === 'upcoming' ? ' active' : ''}`}
          onClick={() => setTab('upcoming')}
        >
          Upcoming
          {upcomingReminders.length > 0 && (
            <span className="rp-tab-badge">{upcomingReminders.length}</span>
          )}
        </button>
        <button
          className={`rp-tab${tab === 'sent' ? ' active' : ''}`}
          onClick={() => setTab('sent')}
        >
          Sent
        </button>
        <button
          className={`rp-tab${tab === 'auto' ? ' active' : ''}`}
          onClick={() => setTab('auto')}
        >
          Auto-alerts
          {(autoReminders.length > 0 || mentions.length > 0) && (
            <span className="rp-tab-badge">{autoReminders.filter(r => r.status === 'pending').length + mentions.length}</span>
          )}
        </button>
      </div>

      {/* Tab Content */}
      <div className="glass-card reminder-tab-content">
        {loading ? (
          <div className="reminder-empty">
            <SprintScanLoader size={48} />
          </div>
        ) : tab === 'upcoming' ? (
          upcomingReminders.length === 0 ? (
            <div className="reminder-empty">
              <Clock size={36} />
              <p>No upcoming reminders</p>
              <span>Use the quick-add bar above to set one</span>
            </div>
          ) : (
            <div className="reminder-list">
              {upcomingReminders.map(rem => (
                <div key={rem.id} className="reminder-item">
                  <div className="reminder-item-left">
                    {getStatusIcon(rem.status)}
                    <div>
                      <p className="reminder-title">{rem.title}</p>
                      {rem.message && <p className="reminder-message">{rem.message}</p>}
                      <div className="reminder-meta">
                        <span><Calendar size={12} /> {rem.target_date}</span>
                        <span className="reminder-type-badge">{getTypeLabel(rem.type)}</span>
                        {rem.related_issue_id && (
                          <span className="reminder-issue-ref">{rem.related_issue_id}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="reminder-item-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDismiss(rem.id)} title="Dismiss">
                      <X size={14} />
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(rem.id)} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === 'sent' ? (
          sentReminders.length === 0 ? (
            <div className="reminder-empty">
              <CheckCircle size={36} />
              <p>No sent reminders</p>
            </div>
          ) : (
            <div className="reminder-list">
              {sentReminders.map(rem => (
                <div key={rem.id} className="reminder-item reminder-item-sent">
                  <div className="reminder-item-left">
                    {getStatusIcon(rem.status)}
                    <div>
                      <p className="reminder-title">{rem.title}</p>
                      <div className="reminder-meta">
                        <span><Calendar size={12} /> {rem.target_date}</span>
                        <span className="reminder-type-badge">{getTypeLabel(rem.type)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="reminder-item-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(rem.id)} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          /* Auto-alerts tab */
          mentions.length === 0 && autoReminders.length === 0 ? (
            <div className="reminder-empty">
              <Bell size={36} />
              <p>No auto-alerts</p>
              <span>Scheduler-generated alerts and unresolved Slack mentions appear here</span>
            </div>
          ) : (
            <div className="reminder-list">
              {/* Unresolved Slack mentions */}
              {mentions.length > 0 && (
                <>
                  <div className="reminder-section-label">
                    <MessageSquare size={13} /> Slack — needs reply
                  </div>
                  {mentions.map(m => (
                    <div key={m.message_ts} className="reminder-item reminder-slack-item">
                      <div
                        className="reminder-item-left reminder-slack-clickable"
                        onClick={() => openSlack(m.channel_id, m.message_ts)}
                        title="Open in Slack"
                      >
                        {m.sender_avatar
                          ? <img src={m.sender_avatar} alt={m.sender_name} className="reminder-slack-avatar" />
                          : <span className="reminder-slack-avatar reminder-slack-avatar-fallback">{m.sender_name.charAt(0).toUpperCase()}</span>
                        }
                        <div>
                          <p className="reminder-title">
                            <span className="reminder-slack-sender">@{m.sender_name}</span>
                          </p>
                          <p className="reminder-message reminder-slack-text">
                            {cleanSlackText(m.message_text.length > 120 ? m.message_text.slice(0, 120) + '…' : m.message_text)}
                          </p>
                          <div className="reminder-meta">
                            <span>{formatRelDate(m.created_at)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="reminder-item-actions">
                        <label className="reminder-resolve-label">
                          <input
                            type="checkbox"
                            className="reminder-resolve-check"
                            onChange={() => handleResolveMention(m.message_ts)}
                          />
                          <span>Resolved</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </>
              )}

              {/* Scheduler auto-reminders */}
              {autoReminders.length > 0 && (
                <>
                  {mentions.length > 0 && (
                    <div className="reminder-section-label">
                      <Bell size={13} /> Scheduler alerts
                    </div>
                  )}
                  {autoReminders.map(rem => (
                    <div key={rem.id} className={`reminder-item${rem.status === 'sent' ? ' reminder-item-sent' : ''}`}>
                      <div className="reminder-item-left">
                        {getStatusIcon(rem.status)}
                        <div>
                          <p className="reminder-title">{rem.title}</p>
                          {rem.message && <p className="reminder-message">{rem.message}</p>}
                          <div className="reminder-meta">
                            <span><Calendar size={12} /> {rem.target_date}</span>
                            <span className="reminder-type-badge">{getTypeLabel(rem.type)}</span>
                            {rem.related_issue_id && rem.type === 'slack_followup' ? (
                              <span className="reminder-slack-ref">
                                <MessageSquare size={10} /> {rem.related_issue_id.slice(0, 12)}…
                              </span>
                            ) : rem.related_issue_id ? (
                              <span className="reminder-issue-ref">{rem.related_issue_id}</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="reminder-item-actions">
                        {rem.status === 'pending' && (
                          <button className="btn btn-ghost btn-sm" onClick={() => handleDismiss(rem.id)} title="Dismiss">
                            <X size={14} />
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(rem.id)} title="Delete">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )
        )}
      </div>
    </div>
  )
}
