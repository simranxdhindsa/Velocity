import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import { Send, Bold, Italic, Code, Search, ChevronUp, Clock, UserPlus } from 'lucide-react'
import api from '@/services/api'
import type { LiveSlackMessage, SlackWorkspaceUser } from '@/services/api'
import { ConfirmModal } from '@/components/ConfirmModal'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { MentionDropdown } from '@/components/MentionDropdown'
import { CalendarPicker } from '@/components/CalendarPicker'
import { ClockTimePicker } from '@/components/ClockTimePicker'
import { usePersistedState, PERSIST } from '@/hooks/usePersistedState'
import { useMentionAutocomplete } from '@/hooks/useMentionAutocomplete'
import {
  ChannelListItem, ChannelListSkeleton, MessageRow, MessageListSkeleton,
} from './SlackMessagesShared'
import { groupLiveByDay, type HubChannel } from './slack-messages-types'
import { NewDMModal } from './NewDMModal'
import { toYMD } from './ClaudeQueueCard'
import '../styles/pages/slack-messages.css'

export function SlackMessagesHub() {
  const [channels, setChannels] = useState<HubChannel[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [selectedChannel, setSelectedChannel] = usePersistedState<string>(PERSIST.SLACK_HUB_CHANNEL, '')
  const [channelSearch, setChannelSearch] = useState('')

  const [messages, setMessages] = useState<LiveSlackMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(true)
  // channel_id -> ts of the most recent message seen there — powers the
  // unread-bold indicator without a per-channel history fetch each render.
  const [latestByChannel, setLatestByChannel] = useState<Record<string, string>>({})

  const [lastViewed, setLastViewed] = usePersistedState<Record<string, string>>(PERSIST.SLACK_HUB_LAST_VIEWED, {})

  const [composeText, setComposeText] = useState('')
  const [sending, setSending] = useState(false)
  const [scheduleMode, setScheduleMode] = useState(false)
  const [schedDate, setSchedDate] = useState(toYMD(new Date()))
  const [schedTime, setSchedTime] = useState('10:00')
  const [scheduleConfirm, setScheduleConfirm] = useState(false)
  const [newDMOpen, setNewDMOpen] = useState(false)
  const [workspaceUsers, setWorkspaceUsers] = useState<SlackWorkspaceUser[]>([])
  const mention = useMentionAutocomplete(workspaceUsers)
  // Resolves <@USERID> tokens in message text back to a display name for rendering.
  const userMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of workspaceUsers) m.set(u.id, u.profile.display_name || u.real_name || u.name)
    return m
  }, [workspaceUsers])
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [expandedThread, setExpandedThread] = useState<string | null>(null)
  const [threadReplies, setThreadReplies] = useState<LiveSlackMessage[]>([])
  const [threadLoading, setThreadLoading] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listEndRef = useRef<HTMLDivElement>(null)
  // Tracks which channel the latest fetchMessages call was for, so a slow
  // response for a channel the user has since navigated away from can't
  // clobber the currently displayed channel's messages.
  const fetchChannelRef = useRef<string>('')

  // ── Load channels (authorized/member channels only) ──────────────────────
  useEffect(() => {
    let cancelled = false
    setChannelsLoading(true)
    api.getSlackChannels()
      .then(res => {
        if (cancelled) return
        const list = ((res as unknown as HubChannel[]) ?? []).filter(c => c.is_member)
        setChannels(list)
        if (!selectedChannel && list.length > 0) setSelectedChannel(list[0].id)
      })
      .catch(() => { if (!cancelled) setError('Failed to load channels') })
      .finally(() => { if (!cancelled) setChannelsLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load workspace users for @mention autocomplete in the compose box ────
  useEffect(() => {
    api.getWorkspaceUsers().then(res => setWorkspaceUsers((res as unknown as SlackWorkspaceUser[]) ?? [])).catch(() => {})
  }, [])

  // ── Load the live channel history for the selected channel ───────────────
  // `silent` skips the loading-skeleton flash — used after sending, when the
  // list is already visible and we're just refreshing it in place.
  const fetchMessages = useCallback(async (channelId: string, silent = false) => {
    fetchChannelRef.current = channelId
    if (!channelId) { setMessages([]); return }
    if (!silent) setMessagesLoading(true)
    try {
      const res = await api.getLiveSlackMessages(channelId)
      const list = (res as unknown as LiveSlackMessage[]) ?? []
      if (fetchChannelRef.current !== channelId) return // a newer channel switch superseded this request
      setMessages(list)
      if (list.length > 0) {
        const latestTs = list.reduce((max, m) => (parseFloat(m.ts) > parseFloat(max) ? m.ts : max), list[0].ts)
        setLatestByChannel(prev => ({ ...prev, [channelId]: latestTs }))
      }
    } catch {
      if (fetchChannelRef.current === channelId) setError('Failed to load messages')
    } finally {
      if (!silent && fetchChannelRef.current === channelId) setMessagesLoading(false)
    }
  }, [])

  useEffect(() => {
    setExpandedThread(null)
    if (selectedChannel) fetchMessages(selectedChannel)
  }, [selectedChannel, fetchMessages])

  // Mark the selected channel as viewed (clears its unread bolding)
  useEffect(() => {
    if (!selectedChannel) return
    setLastViewed(prev => ({ ...prev, [selectedChannel]: new Date().toISOString() }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannel, messages.length])

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const filteredChannels = useMemo(() => {
    if (!channelSearch.trim()) return channels
    const q = channelSearch.toLowerCase()
    return channels.filter(c => c.name.toLowerCase().includes(q))
  }, [channels, channelSearch])

  const isChannelUnread = useCallback((channel: HubChannel) => {
    if (channel.id === selectedChannel) return false
    const latest = latestByChannel[channel.id]
    if (!latest) return false // nothing fetched for that channel yet — nothing to flag
    const seen = lastViewed[channel.id]
    if (!seen) return true // has activity, never opened — unread
    return new Date(parseFloat(latest) * 1000) > new Date(seen)
  }, [lastViewed, latestByChannel, selectedChannel])

  const activeChannel = channels.find(c => c.id === selectedChannel)

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!composeText.trim() || !selectedChannel || sending) return

    if (scheduleMode) {
      const [y, mo, d] = schedDate.split('-').map(Number)
      const [hh, mm] = schedTime.split(':').map(Number)
      const when = new Date(y, mo - 1, d, hh, mm, 0, 0)
      if (when <= new Date()) { setError('Selected date and time is in the past'); return }
      setSending(true)
      setError(null)
      try {
        await api.createQueuedMessage(composeText.trim(), when.toISOString(), selectedChannel, `#${activeChannel?.name ?? ''}`)
        setComposeText('')
        setScheduleMode(false)
        setScheduleConfirm(true)
        setTimeout(() => setScheduleConfirm(false), 3000)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to schedule message')
      } finally {
        setSending(false)
      }
      return
    }

    setSending(true)
    setError(null)
    try {
      await api.sendHubMessage(selectedChannel, activeChannel?.name ?? '', composeText.trim())
      setComposeText('')
      await fetchMessages(selectedChannel, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const handleSaveEdit = async (id: string, text: string) => {
    await api.updateHubMessage(id, text)
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, text } : m)))
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const id = deleteTarget
    setDeleteTarget(null)
    const prev = messages
    setMessages(p => p.filter(m => m.id !== id)) // optimistic
    try {
      await api.deleteHubMessage(id)
    } catch {
      setMessages(prev) // revert on failure
      setError('Failed to delete message')
    }
  }

  const handleViewInSlack = (message: LiveSlackMessage) => {
    // Universal archive-link format — redirects to the right workspace without
    // needing the workspace subdomain client-side.
    const tsForUrl = message.ts.replace('.', '')
    const url = `https://slack.com/archives/${selectedChannel}/p${tsForUrl}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleOpenThread = async (message: LiveSlackMessage) => {
    if (expandedThread === message.ts) { setExpandedThread(null); return }
    setExpandedThread(message.ts)
    setThreadLoading(true)
    try {
      const res = await api.getLiveSlackMessages(selectedChannel, message.ts)
      const list = (res as unknown as LiveSlackMessage[]) ?? []
      // First item is the parent itself — only show the replies beneath it.
      setThreadReplies(list.filter(r => r.ts !== message.ts))
    } catch {
      setError('Failed to load thread replies')
    } finally {
      setThreadLoading(false)
    }
  }

  const handleMentionSelect = (u: SlackWorkspaceUser) => {
    const ta = textareaRef.current
    if (!ta) return
    const result = mention.applyMention(composeText, ta.selectionStart, u)
    if (!result) return
    setComposeText(result.text)
    mention.dismissMention()
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(result.cursor, result.cursor) })
  }

  const insertWrap = (marker: string) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart, end = ta.selectionEnd
    const selected = composeText.slice(start, end)
    const next = composeText.slice(0, start) + marker + selected + marker + composeText.slice(end)
    setComposeText(next)
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(start + marker.length, end + marker.length) })
  }

  const dayGroups = useMemo(() => groupLiveByDay(messages), [messages])

  return (
    <div className="smh-root">
      <div className="smh-sidebar">
        <div className="smh-sidebar-top">
          <div className="smh-sidebar-search">
            <Search size={13} />
            <input
              placeholder="Find a channel…"
              value={channelSearch}
              onChange={e => setChannelSearch(e.target.value)}
            />
          </div>
          <button className="smh-new-dm-btn" onClick={() => setNewDMOpen(true)} title="New direct message" aria-label="New direct message">
            <UserPlus size={14} />
          </button>
        </div>
        {channelsLoading ? (
          <ChannelListSkeleton />
        ) : filteredChannels.length === 0 ? (
          <div className="smh-empty-channels">No connected channels</div>
        ) : (
          <div className="smh-chan-list">
            {filteredChannels.map(c => (
              <ChannelListItem
                key={c.id}
                channel={c}
                active={c.id === selectedChannel}
                unread={isChannelUnread(c)}
                onClick={() => setSelectedChannel(c.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="smh-main">
        {!activeChannel ? (
          <div className="smh-empty-state">
            <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.3 }} />
            <p>Select a channel to see its messages</p>
          </div>
        ) : (
          <>
            <div className="smh-main-header">
              <span className="smh-main-header-icon">{activeChannel.is_private ? '🔒' : '#'}</span>
              <span className="smh-main-header-name">{activeChannel.name}</span>
            </div>

            <div className="smh-msg-scroll">
              {messagesLoading ? (
                <MessageListSkeleton />
              ) : messages.length === 0 ? (
                <div className="smh-empty-state">
                  <p>No messages in this channel yet</p>
                </div>
              ) : (
                dayGroups.map(group => (
                  <div key={group.key}>
                    <div className="smh-day-divider"><span>{group.label}</span></div>
                    {group.items.map(m => (
                      <div key={m.ts}>
                        <motion.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.25 }}
                        >
                          <MessageRow
                            message={m}
                            onSaveEdit={handleSaveEdit}
                            onDelete={setDeleteTarget}
                            onViewInSlack={handleViewInSlack}
                            onOpenThread={handleOpenThread}
                            userMap={userMap}
                          />
                        </motion.div>
                        {expandedThread === m.ts && (
                          <div className="smh-thread-block">
                            {threadLoading ? (
                              <MessageListSkeleton />
                            ) : threadReplies.length === 0 ? (
                              <div className="smh-thread-empty">No replies yet</div>
                            ) : (
                              threadReplies.map(reply => (
                                <MessageRow
                                  key={reply.ts}
                                  message={reply}
                                  onSaveEdit={handleSaveEdit}
                                  onDelete={setDeleteTarget}
                                  onViewInSlack={handleViewInSlack}
                                  userMap={userMap}
                                />
                              ))
                            )}
                            <button className="smh-thread-collapse" onClick={() => setExpandedThread(null)}>
                              <ChevronUp size={12} /> Hide replies
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))
              )}
              <div ref={listEndRef} />
            </div>

            {error && <div className="smh-error-banner">{error}</div>}
            {scheduleConfirm && <div className="smh-success-banner">Message scheduled</div>}

            <div className="smh-compose">
              <div className="smh-compose-toolbar">
                <button onClick={() => insertWrap('*')} title="Bold"><Bold size={14} /></button>
                <button onClick={() => insertWrap('_')} title="Italic"><Italic size={14} /></button>
                <button onClick={() => insertWrap('`')} title="Code"><Code size={14} /></button>
                <button
                  className={`smh-schedule-toggle${scheduleMode ? ' active' : ''}`}
                  onClick={() => setScheduleMode(m => !m)}
                  title={scheduleMode ? 'Cancel scheduling' : 'Schedule for later'}
                >
                  <Clock size={14} />
                </button>
              </div>
              {scheduleMode && (
                <div className="smh-schedule-row">
                  <CalendarPicker value={schedDate} onChange={setSchedDate} minDate={toYMD(new Date())} />
                  <ClockTimePicker value={schedTime} onChange={setSchedTime} />
                </div>
              )}
              <textarea
                ref={textareaRef}
                className="smh-compose-input"
                placeholder={`Message #${activeChannel.name}… use @ to mention a member`}
                value={composeText}
                onChange={e => { setComposeText(e.target.value); mention.detectMention(e.target.value, e.target.selectionStart, e.target) }}
                onKeyDown={e => {
                  if (mention.handleMentionKeyDown(e, handleMentionSelect)) return
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                onBlur={() => setTimeout(mention.dismissMention, 150)}
                rows={2}
              />
              <MentionDropdown
                results={mention.mentionResults}
                activeIdx={mention.mentionIdx}
                style={mention.mentionDropStyle}
                onHover={mention.setMentionIdx}
                onSelect={handleMentionSelect}
              />
              <motion.button
                className="smh-send-btn"
                onClick={handleSend}
                disabled={!composeText.trim() || sending}
                title={scheduleMode ? 'Schedule message' : 'Send now'}
                whileHover={{ scale: composeText.trim() ? 1.05 : 1 }}
                whileTap={{ scale: composeText.trim() ? 0.95 : 1 }}
              >
                {scheduleMode ? <Clock size={15} /> : <Send size={15} />}
              </motion.button>
            </div>
          </>
        )}
      </div>

      {deleteTarget && (
        <ConfirmModal
          title="Delete message"
          message="Delete this message from Slack? This cannot be undone."
          variant="danger"
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {newDMOpen && (
        <NewDMModal users={workspaceUsers} onClose={() => setNewDMOpen(false)} />
      )}
    </div>
  )
}
