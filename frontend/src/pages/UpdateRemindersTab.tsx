import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus, X, ChevronDown, Send, Clock, Users, Calendar,
  Play, Eye, History, Trash2, AlertTriangle, CheckCircle, CheckCircle2,
  ToggleLeft, ToggleRight, Zap, Pencil,
} from 'lucide-react'
import api from '../services/api'
import { usePersistedState, PERSIST } from '../hooks/usePersistedState'
import type {
  UpdateReminderRule, UpdateReminderRosterMember, UpdateReminderRun,
  UpdateReminderRunResult, SlackWorkspaceUser, ChannelRef,
} from '../services/api'
import { CustomDropdown } from '../components/CustomDropdown'
import { ClockTimePicker, displayTime, upperAmPm } from '../components/ClockTimePicker'
import { ConfirmModal } from '../components/ConfirmModal'
import { ClaudeQueueCard, toYMD } from './ClaudeQueueCard'
import { CalendarPicker } from '../components/CalendarPicker'
import '../styles/pages/slack-update-reminders.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PLACEHOLDERS = ['{names}', '{mentions}', '{date}', '{count}', '{on_leave_names}']

const DEFAULT_RULE: Partial<UpdateReminderRule> = {
  name: 'New Reminder',
  enabled: true,
  schedule_time: '11:00',
  schedule_days: [1, 2, 3, 4, 5],
  timezone: 'Asia/Kolkata',
  source_channel_ids: [],
  detection_mode: 'any_message',
  detection_value: '',
  check_day_offset: -1,
  check_window_start: '09:00',
  check_window_end_day_offset: 0,
  check_window_end: '09:00',
  leave_channel_id: '',
  leave_channel_name: '',
  leave_keywords: ['leave', 'wfh', 'sick', 'holiday', 'off', 'vacation', 'pto'],
  leave_action: 'exclude',
  delivery_channel: true,
  delivery_dm: false,
  delivery_channel_id: '',
  delivery_channel_name: '',
  channel_template: "Hey team! The following members haven't posted their update yet: {mentions}. Please share your update when you get a chance.",
  dm_template: 'Hi! Just a reminder to post your daily update in the team channel.',
}

// ── Shared portal channel menu ────────────────────────────────────────────────
// Used by both SourceChannelPicker (multi) and SearchableChannelDd (single).

function useChannelMenuPos(triggerRef: React.RefObject<HTMLButtonElement>, open: boolean) {
  const [style, setStyle] = useState<React.CSSProperties>({})
  useEffect(() => {
    if (!open) return
    const pos = () => {
      if (!triggerRef.current) return
      const r = triggerRef.current.getBoundingClientRect()
      setStyle({ position: 'fixed', top: r.bottom + 4, left: r.left, width: r.width, zIndex: 9999 })
    }
    pos()
    window.addEventListener('scroll', pos, true)
    window.addEventListener('resize', pos)
    return () => { window.removeEventListener('scroll', pos, true); window.removeEventListener('resize', pos) }
  }, [open, triggerRef])
  return style
}

function ChannelMenu({ style, search, onSearch, items, activeId, onPick, manualId, onManualId, onManualAdd }: {
  style: React.CSSProperties
  search: string
  onSearch: (v: string) => void
  items: ChannelRef[]
  activeId?: string
  onPick: (c: ChannelRef) => void
  manualId: string
  onManualId: (v: string) => void
  onManualAdd: () => void
}) {
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { requestAnimationFrame(() => searchRef.current?.focus()) }, [])

  return createPortal(
    <div className="cd-portal-menu ur-ch-picker-menu" style={style}>
      <div className="cd-search-row">
        <input ref={searchRef} className="cd-search-input" placeholder="Search channels…" value={search} onChange={e => onSearch(e.target.value)} />
      </div>
      <div className="cd-option-list" style={{ maxHeight: 180 }}>
        {items.length === 0
          ? <div className="cd-no-results">No channels found</div>
          : items.map(c => (
            <button key={c.id} type="button" className={`pm-dropdown-item${activeId === c.id ? ' active' : ''}`} onClick={() => onPick(c)}>
              #{c.name}
            </button>
          ))
        }
      </div>
      <div className="ur-ch-picker-manual">
        <div className="ur-ch-picker-manual-label">Enter channel ID manually</div>
        <div className="ur-ch-picker-manual-row">
          <input
            className="ur-ch-picker-manual-input"
            placeholder="e.g. C0123456789"
            value={manualId}
            onChange={e => onManualId(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onManualAdd() } }}
          />
          <button type="button" className="ur-ch-picker-add-btn" onClick={onManualAdd} disabled={!manualId.trim()}>Add</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Multi-select (source channels)
function SourceChannelPicker({ channels, selected, onAdd }: {
  channels: ChannelRef[]
  selected: ChannelRef[]
  onAdd: (ch: ChannelRef) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [manualId, setManualId] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuPos = useChannelMenuPos(triggerRef, open)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      const menu = document.querySelector('.ur-ch-picker-menu')
      if (menu?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const available = useMemo(() =>
    channels.filter(c => !selected.find(s => s.id === c.id) && (!search || c.name.toLowerCase().includes(search.toLowerCase()))),
    [channels, selected, search]
  )

  const addManual = () => {
    const id = manualId.trim()
    if (!id || selected.find(s => s.id === id)) { setManualId(''); return }
    onAdd({ id, name: id }); setManualId(''); setOpen(false)
  }

  return (
    <div className="pm-custom-dropdown ur-channel-dd">
      <button ref={triggerRef} type="button" className="pm-custom-dropdown-trigger" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--text-muted)' }}>Add channel…</span>
        <ChevronDown size={11} className={`dropdown-chevron${open ? ' open' : ''}`} />
      </button>
      {open && <ChannelMenu style={menuPos} search={search} onSearch={setSearch} items={available} onPick={c => { onAdd(c); setSearch(''); setOpen(false) }} manualId={manualId} onManualId={setManualId} onManualAdd={addManual} />}
    </div>
  )
}

// Single-select (leave channel, delivery channel, quick send)
function SearchableChannelDd({ channels, value, onChange, placeholder = 'Select channel…' }: {
  channels: ChannelRef[]
  value: string
  onChange: (id: string, name: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [manualId, setManualId] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuPos = useChannelMenuPos(triggerRef, open)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      const menu = document.querySelector('.ur-ch-picker-menu')
      if (menu?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const filtered = useMemo(() =>
    channels.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase())),
    [channels, search]
  )

  const selectedName = channels.find(c => c.id === value)?.name
  const triggerLabel = selectedName ? `#${selectedName}` : (value || placeholder)

  const pick = (id: string, name: string) => { onChange(id, name); setSearch(''); setOpen(false) }
  const addManual = () => { const id = manualId.trim(); if (!id) return; pick(id, id); setManualId('') }

  return (
    <div className="pm-custom-dropdown ur-channel-dd">
      <button ref={triggerRef} type="button" className="pm-custom-dropdown-trigger" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setOpen(o => !o)}>
        <span style={{ color: value ? 'var(--text-primary)' : 'var(--text-muted)' }}>{triggerLabel}</span>
        <ChevronDown size={11} className={`dropdown-chevron${open ? ' open' : ''}`} />
      </button>
      {open && <ChannelMenu style={menuPos} search={search} onSearch={setSearch} items={filtered} activeId={value} onPick={c => pick(c.id, c.name)} manualId={manualId} onManualId={setManualId} onManualAdd={addManual} />}
    </div>
  )
}

// Render message text with mention tokens as blue pills (used in history).
// Handles both Slack raw format <@ID|Name> and plain @Name inserted by the mention picker.
function renderMentions(text: string): React.ReactNode {
  // Split on <@ID|Name> OR <@ID> OR @Word tokens
  const parts = text.split(/(<@[A-Z0-9]+(?:\|[^>]*)?>|@\S+)/g)
  return parts.map((part, i) => {
    if (part.startsWith('<@')) {
      // Extract display name from <@ID|Name> or fall back to ID
      const match = part.match(/^<@([A-Z0-9]+)(?:\|([^>]*))?>$/)
      const label = match ? `@${match[2] || match[1]}` : part
      return <span key={i} className="ur-qs-mention-pill">{label}</span>
    }
    if (part.startsWith('@')) {
      return <span key={i} className="ur-qs-mention-pill">{part}</span>
    }
    return part
  })
}

// ── Quick Send card ───────────────────────────────────────────────────────────

function QuickSendCard({ channels, autoOpen = false }: { channels: ChannelRef[]; autoOpen?: boolean }) {
  const [open, setOpen] = useState(autoOpen)
  const [mode, setMode] = useState<'channel' | 'dm'>('channel')
  const [channelId, setChannelId] = useState('')
  const [dmUserId, setDmUserId] = useState('')
  const [hasContent, setHasContent] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [users, setUsers] = useState<SlackWorkspaceUser[]>([])
  const [usersLoaded, setUsersLoaded] = useState(false)
  const [dmSearch, setDmSearch] = useState('')
  const [showDmDrop, setShowDmDrop] = useState(false)
  const [history, setHistory] = usePersistedState<Array<{ channel: string; channelId: string; msg: string; ts: string; slackTs: string }>>(PERSIST.QUICK_SEND_HISTORY, [])
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingIdx, setDeletingIdx] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionDropStyle, setMentionDropStyle] = useState<React.CSSProperties>({})
  const [mentionIdx, setMentionIdx] = useState(0)
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [scheduleMode, setScheduleMode] = useState(false)
  const [schedDate, setSchedDate] = useState(toYMD(new Date()))
  const [schedTime, setSchedTime] = useState('10:00')
  const [schedErr, setSchedErr] = useState('')
  const [scheduled, setScheduled] = useState(false)
  const dmRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)

  useEffect(() => {
    if (open && !usersLoaded) {
      api.getWorkspaceUsers().then(r => { if (Array.isArray(r)) { setUsers(r as SlackWorkspaceUser[]); setUsersLoaded(true) } }).catch(() => {})
    }
  }, [open, usersLoaded])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dmRef.current && !dmRef.current.contains(e.target as Node)) setShowDmDrop(false)
      if (mentionQuery !== null && editRef.current && !editRef.current.contains(e.target as Node)) setMentionQuery(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [mentionQuery])

  const filteredDmUsers = users.filter(u =>
    !u.is_bot && !u.deleted &&
    ((u.profile.display_name || u.real_name).toLowerCase().includes(dmSearch.toLowerCase()))
  )

  const mentionResults = mentionQuery !== null
    ? users.filter(u => !u.is_bot && !u.deleted && (u.profile.display_name || u.real_name).toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8)
    : []

  const selectedUser = users.find(u => u.id === dmUserId)
  const selectedChannel = channels.find(c => c.id === channelId)

  // Walk the contenteditable DOM to build the Slack-format message
  const getSlackMessage = (): string => {
    if (!editRef.current) return ''
    let result = ''
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement
        if (el.dataset.mention) {
          result += el.dataset.mention
        } else if (el.tagName === 'BR') {
          result += '\n'
        } else {
          el.childNodes.forEach(walk)
          if (el.tagName === 'DIV') result += '\n'
        }
      }
    }
    editRef.current.childNodes.forEach(walk)
    return result.trim()
  }

  const getDisplayText = (): string => editRef.current?.textContent?.trim() || ''

  const handleInput = () => {
    setHasContent(!!(editRef.current?.textContent?.trim()))
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) { setMentionQuery(null); return }
    const range = sel.getRangeAt(0)
    if (range.startContainer.nodeType !== Node.TEXT_NODE) { setMentionQuery(null); return }
    const textBefore = (range.startContainer.textContent || '').slice(0, range.startOffset)
    const atIdx = textBefore.lastIndexOf('@')
    if (atIdx !== -1) {
      const query = textBefore.slice(atIdx + 1)
      if (!query.includes(' ') && !query.includes('\n')) {
        setMentionQuery(query)
        setMentionIdx(0)
        if (editRef.current) {
          const r = editRef.current.getBoundingClientRect()
          setMentionDropStyle({ position: 'fixed', top: r.bottom + 4, left: r.left, width: Math.min(r.width, 320), zIndex: 9999 })
        }
        return
      }
    }
    setMentionQuery(null)
  }

  const handleMentionSelect = (u: SlackWorkspaceUser) => {
    const name = u.profile.display_name || u.real_name
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return

    const textNode = range.startContainer as Text
    const textBefore = (textNode.textContent || '').slice(0, range.startOffset)
    const atIdx = textBefore.lastIndexOf('@')
    if (atIdx === -1) return

    // Delete @partial text from the text node
    const delRange = document.createRange()
    delRange.setStart(textNode, atIdx)
    delRange.setEnd(textNode, range.startOffset)
    delRange.deleteContents()

    // Build mention span (non-editable, styled, carries Slack token as data attr)
    const span = document.createElement('span')
    span.className = 'ur-qs-mention-pill'
    span.contentEditable = 'false'
    span.dataset.mention = `<@${u.id}|${name}>`
    span.textContent = `@${name}`

    // Insert at cursor (now at atIdx of the text node)
    const insertRange = window.getSelection()!.getRangeAt(0)
    insertRange.insertNode(span)

    // Add a trailing space and move cursor after it
    const space = document.createTextNode(' ')
    span.after(space)
    const newRange = document.createRange()
    newRange.setStart(space, 1)
    newRange.collapse(true)
    sel.removeAllRanges()
    sel.addRange(newRange)

    setHasContent(true)
    setMentionQuery(null)
    editRef.current?.focus()
  }

  // Strip HTML on paste — only accept plain text
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }

  const handleSend = async () => {
    const slackMsg = getSlackMessage()
    if (!slackMsg || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    try {
      const payload = mode === 'dm'
        ? { message: slackMsg, dm_user_id: dmUserId }
        : { message: slackMsg, channel_id: channelId }
      const res = await api.quickSend(payload)
      const label = mode === 'dm' ? (selectedUser?.profile.display_name || selectedUser?.real_name || dmUserId) : (selectedChannel?.name || channelId)
      setHistory(h => [{ channel: label, channelId: res?.channel_id || channelId, msg: getDisplayText(), ts: upperAmPm(new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })), slackTs: res?.slack_ts || '' }, ...h.slice(0, 19)])
      if (editRef.current) editRef.current.innerHTML = ''
      setHasContent(false)
      setSent(true)
      setTimeout(() => setSent(false), 2500)
    } catch {
      // error shown inline
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const handleSchedule = async () => {
    const slackMsg = getSlackMessage()
    if (!slackMsg || sendingRef.current) return
    const [y, mo, d] = schedDate.split('-').map(Number)
    const [hh, mm] = schedTime.split(':').map(Number)
    const base = new Date(y, mo - 1, d, hh, mm, 0, 0)
    if (base <= new Date()) { setSchedErr('Selected date and time is in the past'); return }
    setSchedErr('')
    sendingRef.current = true
    setSending(true)
    try {
      const label = mode === 'dm' ? (selectedUser?.profile.display_name || selectedUser?.real_name || dmUserId) : (selectedChannel?.name || channelId)
      await api.createQueuedMessage(
        slackMsg, base.toISOString(),
        mode === 'channel' ? channelId : '',
        mode === 'channel' ? `#${label}` : label,
        mode === 'dm' ? dmUserId : undefined,
      )
      if (editRef.current) editRef.current.innerHTML = ''
      setHasContent(false)
      setScheduled(true)
      setTimeout(() => setScheduled(false), 2500)
    } catch {
      setSchedErr('Failed to schedule message')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <div className="cq-card">
      <button className={`cq-header${open ? ' cq-header--open' : ''}`} onClick={() => setOpen(o => !o)}>
        <div className="cq-header-left">
          <div className="cq-header-icon"><Zap size={14} /></div>
          <span className="cq-header-title">Quick Send</span>
        </div>
        <ChevronDown size={14} className={`cq-caret${open ? ' cq-caret--open' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="qs-body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          style={{ overflow: 'hidden' }}
        >
        <div className="ur-qs-body">
          <div className="ur-qs-target">
            <button className={`ur-qs-mode-btn${mode === 'channel' ? ' active' : ''}`} onClick={() => setMode('channel')}># Channel</button>
            <button className={`ur-qs-mode-btn${mode === 'dm' ? ' active' : ''}`} onClick={() => setMode('dm')}>@ DM</button>
          </div>

          {mode === 'channel' ? (
            <SearchableChannelDd channels={channels} value={channelId} onChange={id => setChannelId(id)} />
          ) : (
            <div className="ur-user-search" ref={dmRef}>
              <input
                className="ur-user-search-input"
                placeholder="Search workspace member…"
                value={selectedUser ? (selectedUser.profile.display_name || selectedUser.real_name) : dmSearch}
                onChange={e => { setDmSearch(e.target.value); setDmUserId(''); setShowDmDrop(true) }}
                onFocus={() => setShowDmDrop(true)}
              />
              {showDmDrop && filteredDmUsers.length > 0 && (
                <div className="ur-user-dropdown">
                  {filteredDmUsers.slice(0, 20).map(u => (
                    <div key={u.id} className="ur-user-option" onMouseDown={() => { setDmUserId(u.id); setDmSearch(''); setShowDmDrop(false) }}>
                      {u.profile.image_48 && <img src={u.profile.image_48} className="ur-user-avatar" alt="" />}
                      <div className="ur-user-meta">
                        <span className="ur-user-name">{u.profile.display_name || u.real_name}</span>
                        <span className="ur-user-handle">@{u.name}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div
            ref={editRef}
            className="ur-qs-editor"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Type your message… use @ to mention a member"
            onInput={handleInput}
            onKeyDown={e => {
              if (mentionQuery !== null && mentionResults.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'Tab') {
                  e.preventDefault()
                  setMentionIdx(i => (i + 1) % mentionResults.length)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIdx(i => (i - 1 + mentionResults.length) % mentionResults.length)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  handleMentionSelect(mentionResults[mentionIdx])
                } else if (e.key === 'Escape') {
                  setMentionQuery(null)
                }
              }
            }}
            onPaste={handlePaste}
          />

          {/* @mention portal dropdown */}
          {mentionQuery !== null && mentionResults.length > 0 && createPortal(
            <div className="cd-portal-menu ur-ch-picker-menu" style={mentionDropStyle}>
              <div className="cd-option-list" style={{ maxHeight: 200 }}>
                {mentionResults.map((u, idx) => {
                  const name = u.profile.display_name || u.real_name
                  return (
                    <button key={u.id} type="button" className={`pm-dropdown-item${idx === mentionIdx ? ' active' : ''}`} onMouseDown={e => { e.preventDefault(); handleMentionSelect(u) }} onMouseEnter={() => setMentionIdx(idx)}>
                      {u.profile.image_48 && <img src={u.profile.image_48} className="ur-user-avatar" alt="" style={{ marginRight: 6 }} />}
                      <span>{name}</span>
                      <span style={{ marginLeft: 4, color: 'var(--text-muted)', fontSize: 11 }}>@{u.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>,
            document.body
          )}

          <div className="ur-qs-send-row">
            <div className="ur-qs-target">
              <button className={`ur-qs-mode-btn${!scheduleMode ? ' active' : ''}`} onClick={() => setScheduleMode(false)}>Send now</button>
              <button className={`ur-qs-mode-btn${scheduleMode ? ' active' : ''}`} onClick={() => setScheduleMode(true)}>Schedule</button>
            </div>

            {scheduleMode && (
              <div className="ur-qs-sched-row">
                <CalendarPicker value={schedDate} onChange={setSchedDate} minDate={toYMD(new Date())} />
                <ClockTimePicker value={schedTime} onChange={setSchedTime} />
                {schedErr && <span className="cq-compose-err">{schedErr}</span>}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              {scheduleMode ? (
                <button
                  className="ur-qs-send-btn"
                  onClick={handleSchedule}
                  disabled={sending || !hasContent || (mode === 'channel' ? !channelId : !dmUserId)}
                >
                  {scheduled ? <CheckCircle size={13} /> : <Clock size={13} />}
                  {scheduled ? 'Scheduled!' : sending ? 'Scheduling…' : 'Schedule'}
                </button>
              ) : (
                <button
                  className="ur-qs-send-btn"
                  onClick={handleSend}
                  disabled={sending || !hasContent || (mode === 'channel' ? !channelId : !dmUserId)}
                >
                  {sent ? <CheckCircle size={13} /> : <Send size={13} />}
                  {sent ? 'Sent!' : sending ? 'Sending…' : 'Send Now'}
                </button>
              )}
            </div>
          </div>

          {history.length > 0 && (
            <div className="ur-qs-history">
              <div className="ur-qs-history-header">
                <span>Sent History</span>
                <button className="ur-qs-history-clear" onClick={() => setShowClearConfirm(true)}>Clear all</button>
              </div>
              {history.map((h, i) => (
                <div key={i} className="ur-qs-history-item">
                  <div className="ur-qs-history-meta">
                    <span className="ur-qs-history-ch">
                      {h.channelId?.match(/^[UW]/) ? h.channel : `#${h.channel}`}
                    </span>
                    <span className="ur-qs-history-time"><Clock size={9} />{h.ts}</span>
                    <span className="ur-qs-history-sent-badge"><CheckCircle2 size={10} />Sent</span>
                  </div>
                  {editingIdx === i ? (
                    <div className="ur-qs-history-edit">
                      <textarea
                        className="ur-qs-history-edit-input"
                        value={editingText}
                        onChange={e => setEditingText(e.target.value)}
                        rows={3}
                      />
                      <div className="ur-qs-history-edit-actions">
                        <button className="ur-btn-secondary ur-btn-xs" onClick={() => setEditingIdx(null)}>Cancel</button>
                        <button
                          className="ur-btn-primary ur-btn-xs"
                          disabled={savingEdit || !editingText.trim()}
                          onClick={async () => {
                            if (!h.slackTs || !h.channelId) return
                            setSavingEdit(true)
                            try {
                              await api.updateSlackMessage(h.channelId, h.slackTs, editingText.trim())
                              setHistory(prev => prev.map((x, j) => j === i ? { ...x, msg: editingText.trim() } : x))
                              setEditingIdx(null)
                            } catch { /* ignore */ } finally { setSavingEdit(false) }
                          }}
                        >
                          {savingEdit ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="ur-qs-history-msg-row">
                      <span className="ur-qs-history-msg">{renderMentions(h.msg)}</span>
                      {h.slackTs && (
                        <div className="ur-qs-history-actions">
                          <button
                            className="ur-qs-history-action-btn"
                            title="Edit in Slack"
                            onClick={() => { setEditingIdx(i); setEditingText(h.msg) }}
                          ><Pencil size={12} /></button>
                          <button
                            className="ur-qs-history-action-btn ur-qs-history-action-btn--danger"
                            title="Delete from Slack"
                            disabled={deletingIdx === i}
                            onClick={() => setConfirmDeleteIdx(i)}
                          ><Trash2 size={12} /></button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      {confirmDeleteIdx !== null && (() => {
        const target = history[confirmDeleteIdx]
        return (
          <ConfirmModal
            variant="danger"
            title="Delete from Slack?"
            message="This will permanently delete the message from the Slack channel."
            confirmLabel="Delete"
            onConfirm={async () => {
              const idx = confirmDeleteIdx
              setConfirmDeleteIdx(null)
              if (!target?.slackTs || !target?.channelId) return
              setDeletingIdx(idx)
              try {
                await api.deleteSlackMessage(target.channelId, target.slackTs)
                setHistory(prev => prev.filter((_, j) => j !== idx))
              } catch { /* ignore */ } finally { setDeletingIdx(null) }
            }}
            onCancel={() => setConfirmDeleteIdx(null)}
          />
        )
      })()}

      {showClearConfirm && (
        <ConfirmModal
          variant="warning"
          title="Clear sent history?"
          message="This clears your local history only — messages already sent stay in Slack."
          confirmLabel="Clear all"
          onConfirm={() => { setHistory([]); setShowClearConfirm(false) }}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  )
}

// ── Chip keyword input ────────────────────────────────────────────────────────

function ChipInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [input, setInput] = useState('')
  const addChip = () => {
    const t = input.trim()
    if (t && !value.includes(t)) onChange([...value, t])
    setInput('')
  }
  return (
    <div className="ur-chip-input" onClick={e => { const inp = (e.currentTarget as HTMLElement).querySelector('input'); inp?.focus() }}>
      {value.map(v => (
        <span key={v} className="ur-chip">
          {v}
          <button type="button" onClick={() => onChange(value.filter(x => x !== v))}>×</button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addChip() } if (e.key === 'Backspace' && !input && value.length) onChange(value.slice(0, -1)) }}
        onBlur={addChip}
        placeholder={placeholder}
      />
    </div>
  )
}

// ── Roster member picker ──────────────────────────────────────────────────────

function RosterManager({ ruleId, members, onChange, workspaceUsers }: {
  ruleId: string
  members: UpdateReminderRosterMember[]
  onChange: () => void
  workspaceUsers: SlackWorkspaceUser[]
}) {
  const [search, setSearch] = useState('')
  const [showDrop, setShowDrop] = useState(false)
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setShowDrop(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const filtered = workspaceUsers.filter(u =>
    !u.is_bot && !u.deleted &&
    !pendingIds.has(u.id) &&
    !members.find(m => m.slack_user_id === u.id) &&
    (u.profile.display_name || u.real_name).toLowerCase().includes(search.toLowerCase())
  )

  const addMember = async (u: SlackWorkspaceUser) => {
    if (pendingIds.has(u.id)) return
    setPendingIds(prev => new Set(prev).add(u.id))
    setSearch('')
    setShowDrop(false)
    try {
      await api.addUpdateReminderRosterMember(ruleId, {
        display_name: u.profile.display_name || u.real_name,
        slack_user_id: u.id,
        enabled: true,
      })
      onChange()
    } finally {
      setPendingIds(prev => { const s = new Set(prev); s.delete(u.id); return s })
    }
  }

  const removeMember = async (m: UpdateReminderRosterMember) => {
    await api.deleteUpdateReminderRosterMember(ruleId, m.id)
    onChange()
  }

  const toggleMember = async (m: UpdateReminderRosterMember) => {
    await api.updateUpdateReminderRosterMember(ruleId, m.id, { enabled: !m.enabled })
    onChange()
  }

  return (
    <div>
      <div className="ur-roster-list">
        {members.map(m => (
          <div key={m.id} className="ur-roster-item">
            <span className="ur-roster-name" style={{ opacity: m.enabled ? 1 : 0.45 }}>{m.display_name}</span>
            <span className="ur-roster-id">@{m.slack_user_id}</span>
            <label className="ur-toggle" title={m.enabled ? 'Disable' : 'Enable'}>
              <input type="checkbox" checked={m.enabled} onChange={() => toggleMember(m)} />
              <span className="ur-toggle-slider" />
            </label>
            <button className="ur-roster-remove" onClick={() => removeMember(m)}><X size={12} /></button>
          </div>
        ))}
        {members.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No members yet — add from workspace below.</div>}
      </div>
      <div className="ur-add-member">
        <div className="ur-user-search" style={{ flex: 1 }} ref={ref}>
          <input
            className="ur-user-search-input"
            placeholder="Add workspace member…"
            value={search}
            onChange={e => { setSearch(e.target.value); setShowDrop(true) }}
            onFocus={() => setShowDrop(true)}
          />
          {showDrop && filtered.length > 0 && (
            <div className="ur-user-dropdown">
              {filtered.slice(0, 15).map(u => (
                <div key={u.id} className="ur-user-option" onMouseDown={() => addMember(u)}>
                  {u.profile.image_48 && <img src={u.profile.image_48} className="ur-user-avatar" alt="" />}
                  <div className="ur-user-meta">
                    <span className="ur-user-name">{u.profile.display_name || u.real_name}</span>
                    <span className="ur-user-handle">@{u.name}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Rule editor panel ─────────────────────────────────────────────────────────

function RuleEditor({
  rule,
  channels,
  onClose,
  onSaved,
}: {
  rule: Partial<UpdateReminderRule> | null
  channels: ChannelRef[]
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = !rule?.id
  const [form, setForm] = useState<Partial<UpdateReminderRule>>(rule ?? DEFAULT_RULE)
  const [saving, setSaving] = useState(false)
  const [roster, setRoster] = useState<UpdateReminderRosterMember[]>([])
  const [templateTab, setTemplateTab] = useState<'channel' | 'dm'>('channel')
  const [workspaceUsers, setWorkspaceUsers] = useState<SlackWorkspaceUser[]>([])

  useEffect(() => {
    if (rule?.id) {
      api.listUpdateReminderRoster(rule.id).then(r => { if (Array.isArray(r)) setRoster(r as UpdateReminderRosterMember[]) }).catch(() => {})
    }
    // Fetch workspace users lazily — only when editor opens, freed when it closes
    api.getWorkspaceUsers().then(r => { if (Array.isArray(r)) setWorkspaceUsers(r as SlackWorkspaceUser[]) }).catch(() => {})
  }, [rule?.id])

  const set = (patch: Partial<UpdateReminderRule>) => setForm(f => ({ ...f, ...patch }))

  const toggleDay = (d: number) => {
    const days = form.schedule_days ?? []
    set({ schedule_days: days.includes(d) ? days.filter(x => x !== d) : [...days, d] })
  }

  const previewMsg = (tmpl: string) => {
    const m: Record<string, string> = {
      '{names}': 'Alice, Bob', '{mentions}': '@Alice @Bob',
      '{date}': new Date().toLocaleDateString('en-IN'), '{count}': '2', '{on_leave_names}': 'Carol',
    }
    return tmpl.replace(/\{[^}]+\}/g, tag => m[tag] ?? tag)
  }

  const insertPlaceholder = (ph: string) => {
    const field = templateTab === 'channel' ? 'channel_template' : 'dm_template'
    set({ [field]: ((form[field] as string) ?? '') + ph })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      if (isNew) {
        await api.createUpdateReminderRule(form)
      } else {
        await api.updateUpdateReminderRule(rule!.id!, form)
      }
      onSaved()
      onClose()
    } catch {
      // error shown inline
    } finally {
      setSaving(false)
    }
  }

  const curTemplate = templateTab === 'channel' ? (form.channel_template ?? '') : (form.dm_template ?? '')

  return (
    <div className="ur-editor-overlay" onClick={onClose}>
      <div className="ur-editor-panel" onClick={e => e.stopPropagation()}>
        <div className="ur-editor-header">
          <div className="ur-editor-title">{isNew ? 'New Reminder Rule' : `Edit: ${form.name}`}</div>
          <button className="ur-editor-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="ur-editor-body">

          {/* Basics */}
          <div>
            <div className="ur-section-title">Basics</div>
            <div className="ur-field">
              <label className="ur-label">Rule name</label>
              <input className="ur-input" value={form.name ?? ''} onChange={e => set({ name: e.target.value })} placeholder="e.g. Morning Standup Check" />
            </div>
          </div>

          {/* Schedule */}
          <div>
            <div className="ur-section-title">Schedule</div>
            <div className="ur-field" style={{ marginBottom: 10 }}>
              <label className="ur-label">Fire at time</label>
              <ClockTimePicker value={form.schedule_time ?? '11:00'} onChange={v => set({ schedule_time: v })} />
            </div>
            <div className="ur-field" style={{ marginBottom: 10 }}>
              <label className="ur-label">Timezone</label>
              <CustomDropdown
                value={(form.timezone ?? 'Asia/Kolkata') as string}
                options={[
                  { value: 'Asia/Kolkata',       label: 'Asia/Kolkata (IST)' },
                  { value: 'UTC',                label: 'UTC' },
                  { value: 'America/New_York',   label: 'America/New_York (ET)' },
                  { value: 'America/Los_Angeles',label: 'America/Los_Angeles (PT)' },
                  { value: 'Europe/London',      label: 'Europe/London (GMT)' },
                ]}
                onChange={v => set({ timezone: v })}
                className="ur-channel-dd"
              />
            </div>
            <div className="ur-field">
              <label className="ur-label">Days</label>
              <div className="ur-day-pills">
                {DAYS.map((d, i) => (
                  <button key={d} type="button" className={`ur-day-pill${(form.schedule_days ?? []).includes(i) ? ' active' : ''}`} onClick={() => toggleDay(i)}>{d}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Channels to watch */}
          <div>
            <div className="ur-section-title">Channels to watch</div>
            <div className="ur-field" style={{ marginBottom: 10 }}>
              <label className="ur-label">Source channels (posting ANY one counts)</label>
              <SourceChannelPicker
                channels={channels}
                selected={form.source_channel_ids ?? []}
                onAdd={ch => set({ source_channel_ids: [...(form.source_channel_ids ?? []), ch] })}
              />
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                {(form.source_channel_ids ?? []).map(c => (
                  <span key={c.id} className="ur-chip">#{c.name}<button type="button" onClick={() => set({ source_channel_ids: (form.source_channel_ids ?? []).filter(x => x.id !== c.id) })}>×</button></span>
                ))}
              </div>
            </div>
            <div className="ur-input-row" style={{ alignItems: 'flex-end' }}>
              <div className="ur-field" style={{ flex: 1 }}>
                <label className="ur-label">Window start</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <CustomDropdown
                    value={String(form.check_day_offset ?? -1)}
                    options={[
                      { value: '0',  label: 'Today' },
                      { value: '-1', label: 'Yesterday' },
                      { value: '-2', label: '2 days ago' },
                      { value: '-3', label: '3 days ago' },
                    ]}
                    onChange={v => set({ check_day_offset: Number(v) })}
                    className="ur-channel-dd"
                  />
                  <ClockTimePicker value={form.check_window_start ?? '09:00'} onChange={v => set({ check_window_start: v })} />
                </div>
              </div>
              <div className="ur-field" style={{ flex: 1 }}>
                <label className="ur-label">Window end</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <CustomDropdown
                    value={String(form.check_window_end_day_offset ?? 0)}
                    options={[
                      { value: '0',  label: 'Today' },
                      { value: '-1', label: 'Yesterday' },
                      { value: '-2', label: '2 days ago' },
                      { value: '-3', label: '3 days ago' },
                    ]}
                    onChange={v => set({ check_window_end_day_offset: Number(v) })}
                    className="ur-channel-dd"
                  />
                  <ClockTimePicker value={form.check_window_end ?? '09:00'} onChange={v => set({ check_window_end: v })} />
                </div>
              </div>
            </div>
          </div>

          {/* Detection */}
          <div>
            <div className="ur-section-title">What counts as "posted"</div>
            <div className="ur-radio-group" style={{ marginBottom: 10 }}>
              {(['any_message', 'keywords', 'pattern', 'mention_missing'] as const).map(m => (
                <label key={m} className="ur-radio">
                  <input type="radio" name="detection" value={m} checked={form.detection_mode === m} onChange={() => set({ detection_mode: m })} />
                  {m === 'any_message' ? 'Any message' : m === 'keywords' ? 'Contains keywords' : m === 'pattern' ? 'Matches pattern (regex)' : '@Mentioned as missing (PM curated)'}
                </label>
              ))}
            </div>
            {form.detection_mode === 'mention_missing' && (
              <div className="ur-field" style={{ background: 'rgba(var(--color-primary-rgb),0.07)', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                PM posts a message in the source channel mentioning who hasn't sent their update (e.g. <em>"No update from @Suryansh @Vishal"</em>). The system reads those <strong>@mentions</strong> as the missing list and reminds only them. Everyone else in the roster is considered posted.
              </div>
            )}
            {(form.detection_mode === 'keywords' || form.detection_mode === 'pattern') && (
              <div className="ur-field">
                <label className="ur-label">{form.detection_mode === 'keywords' ? 'Keywords (press Enter to add)' : 'Regex pattern'}</label>
                {form.detection_mode === 'keywords'
                  ? <ChipInput value={(form.detection_value ?? '').split(',').filter(Boolean)} onChange={chips => set({ detection_value: chips.join(',') })} placeholder="Add keyword…" />
                  : <input className="ur-input" value={form.detection_value ?? ''} onChange={e => set({ detection_value: e.target.value })} placeholder="e.g. (update|standup|eod)" />
                }
              </div>
            )}
          </div>

          {/* Roster */}
          {!isNew && (
            <div>
              <div className="ur-section-title">Team Roster</div>
              <RosterManager
                ruleId={rule!.id!}
                members={roster}
                workspaceUsers={workspaceUsers}
                onChange={() => api.listUpdateReminderRoster(rule!.id!).then(r => { if (Array.isArray(r)) setRoster(r as UpdateReminderRosterMember[]) })}
              />
            </div>
          )}
          {isNew && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Save the rule first, then add team members to the roster.</div>}

          {/* Leave handling */}
          <div>
            <div className="ur-section-title">Leave handling</div>
            <div className="ur-field" style={{ marginBottom: 10 }}>
              <label className="ur-label">Leave / availability channel (optional)</label>
              <SearchableChannelDd
                channels={channels}
                value={form.leave_channel_id ?? ''}
                onChange={(id, name) => set({ leave_channel_id: id, leave_channel_name: name })}
                placeholder="None"
              />
            </div>
            {(form.leave_channel_id ?? '') !== '' && (
              <>
                <div className="ur-field" style={{ marginBottom: 10 }}>
                  <label className="ur-label">Leave keywords</label>
                  <ChipInput value={form.leave_keywords ?? []} onChange={v => set({ leave_keywords: v })} placeholder="Add keyword…" />
                </div>
                <div className="ur-field">
                  <label className="ur-label">If someone is on leave…</label>
                  <div className="ur-radio-group">
                    <label className="ur-radio">
                      <input type="radio" name="leave_action" value="exclude" checked={form.leave_action === 'exclude'} onChange={() => set({ leave_action: 'exclude' })} />
                      Exclude from reminder entirely
                    </label>
                    <label className="ur-radio">
                      <input type="radio" name="leave_action" value="list_separately" checked={form.leave_action === 'list_separately'} onChange={() => set({ leave_action: 'list_separately' })} />
                      List separately as "on leave"
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Delivery */}
          <div>
            <div className="ur-section-title">Delivery</div>
            <div className="ur-field" style={{ marginBottom: 10 }}>
              <label className="ur-radio" style={{ marginBottom: 8 }}>
                <input type="checkbox" checked={form.delivery_channel ?? true} onChange={e => set({ delivery_channel: e.target.checked })} />
                Post to channel
              </label>
              {form.delivery_channel && (
                <div style={{ marginTop: 4 }}>
                  <SearchableChannelDd
                    channels={channels}
                    value={form.delivery_channel_id ?? ''}
                    onChange={(id, name) => set({ delivery_channel_id: id, delivery_channel_name: name })}
                    placeholder="Select channel…"
                  />
                </div>
              )}
            </div>
            <label className="ur-radio">
              <input type="checkbox" checked={form.delivery_dm ?? false} onChange={e => set({ delivery_dm: e.target.checked })} />
              DM each missing member individually
            </label>
          </div>

          {/* Templates */}
          <div>
            <div className="ur-section-title">Message Templates</div>
            <div className="ur-template-tabs">
              <button className={`ur-template-tab${templateTab === 'channel' ? ' active' : ''}`} onClick={() => setTemplateTab('channel')}>Channel</button>
              <button className={`ur-template-tab${templateTab === 'dm' ? ' active' : ''}`} onClick={() => setTemplateTab('dm')}>DM</button>
            </div>
            <textarea
              className="ur-textarea"
              value={curTemplate}
              onChange={e => set({ [templateTab === 'channel' ? 'channel_template' : 'dm_template']: e.target.value })}
              style={{ minHeight: 90 }}
            />
            <div className="ur-placeholder-chips">
              {PLACEHOLDERS.map(ph => <button key={ph} type="button" className="ur-ph-chip" onClick={() => insertPlaceholder(ph)}>{ph}</button>)}
            </div>
            <div style={{ marginTop: 8 }}>
              <div className="ur-label" style={{ marginBottom: 4 }}>Preview</div>
              <div className="ur-preview">{previewMsg(curTemplate)}</div>
            </div>
          </div>

        </div>

        <div className="ur-editor-footer">
          <button className="ur-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="ur-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create Rule' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Run result modal ──────────────────────────────────────────────────────────

function RunResultModal({ result, isDryRun, loading, onSendOriginal, onSendUpdated, onClose }: {
  result: UpdateReminderRunResult | null
  isDryRun: boolean
  loading?: boolean
  onSendOriginal: () => void
  onSendUpdated: () => void
  onClose: () => void
}) {
  const { snapshot, diff, rendered_msg, channel_errors } = result ?? {}
  const hasChanges = diff?.has_changes
  const missing = snapshot?.missing ?? []
  const posted = snapshot?.posted ?? []
  const onLeave = snapshot?.on_leave ?? []

  // Replace <@SLACK_ID> with @DisplayName for human-readable preview
  const allMembers = [...missing, ...posted, ...onLeave]
  const idToName = Object.fromEntries(allMembers.map(m => [m.slack_user_id, m.display_name]))
  const previewMsg = rendered_msg?.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${idToName[id] ?? id}`) ?? ''

  return (
    <div className="ur-result-overlay" onClick={onClose}>
      <div className="ur-result-modal" onClick={e => e.stopPropagation()}>
        <div className="ur-result-header">
          <Eye size={16} style={{ color: 'var(--color-primary)' }} />
          <div className="ur-result-title">{isDryRun ? 'Dry Run Preview' : 'Run Result'}</div>
          <button className="ur-editor-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ur-result-body">
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="skeleton" style={{ width: '100%', height: 44, borderRadius: 8 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="skeleton" style={{ width: 90, height: 11, borderRadius: 4 }} />
                <div style={{ display: 'flex', gap: 6 }}>
                  {[70, 85, 65].map((w, i) => <div key={i} className="skeleton" style={{ width: w, height: 26, borderRadius: 20 }} />)}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="skeleton" style={{ width: 70, height: 11, borderRadius: 4 }} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[80, 65, 90, 55, 75].map((w, i) => <div key={i} className="skeleton" style={{ width: w, height: 26, borderRadius: 20 }} />)}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="skeleton" style={{ width: 115, height: 11, borderRadius: 4 }} />
                <div className="skeleton" style={{ width: '100%', height: 52, borderRadius: 8 }} />
              </div>
            </div>
          )}
          {!loading && hasChanges && isDryRun && (
            <div className="ur-diff-banner">
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              <span>
                {(diff.now_posted?.length ?? 0) > 0 && `${diff.now_posted.map(m => m.display_name).join(', ')} posted since last snapshot. `}
                {(diff.now_missing?.length ?? 0) > 0 && `${diff.now_missing.map(m => m.display_name).join(', ')} newly missing. `}
                Sending will use the fresh snapshot.
              </span>
            </div>
          )}

          {!loading && channel_errors && channel_errors.length > 0 && (
            <div className="ur-diff-banner" style={{ borderColor: 'var(--color-danger)', background: 'var(--color-danger-muted)' }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-danger)' }} />
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Could not read source channel(s) — bot may not be invited:</div>
                {channel_errors.map((e, i) => <div key={i} style={{ fontSize: 11, opacity: 0.85 }}>{e}</div>)}
              </div>
            </div>
          )}

          {!loading && !snapshot && (
            <div className="ur-names-label" style={{ padding: '12px 0' }}>No snapshot data returned — check that the rule has roster members and Slack is connected.</div>
          )}

          {!loading && missing.length > 0 && (
            <div className="ur-names-group">
              <div className="ur-names-label">Missing ({missing.length})</div>
              <div>{missing.map(m => <span key={m.slack_user_id} className="ur-name-pill missing">{m.display_name}</span>)}</div>
            </div>
          )}
          {!loading && posted.length > 0 && (
            <div className="ur-names-group">
              <div className="ur-names-label">Posted ({posted.length})</div>
              <div>{posted.map(m => <span key={m.slack_user_id} className="ur-name-pill">{m.display_name}</span>)}</div>
            </div>
          )}
          {!loading && onLeave.length > 0 && (
            <div className="ur-names-group">
              <div className="ur-names-label">On leave ({onLeave.length})</div>
              <div>{onLeave.map(m => <span key={m.slack_user_id} className="ur-name-pill on-leave">{m.display_name}</span>)}</div>
            </div>
          )}

          {!loading && (
            <div>
              <div className="ur-names-label" style={{ marginBottom: 6 }}>Rendered message</div>
              <div className="ur-preview">{previewMsg}</div>
            </div>
          )}
        </div>
        <div className="ur-result-footer">
          <button className="ur-btn-secondary" onClick={onClose}>Close</button>
          {!loading && isDryRun && hasChanges && (
            <>
              <button className="ur-btn-secondary" onClick={onSendOriginal}>Send Original Snapshot</button>
              <button className="ur-btn-primary" onClick={onSendUpdated}>Send Updated</button>
            </>
          )}
          {!loading && isDryRun && !hasChanges && (
            <button className="ur-btn-primary" onClick={onSendUpdated}>Send Now</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── History modal ─────────────────────────────────────────────────────────────

function HistoryModal({ ruleId, ruleName, onClose }: { ruleId: string; ruleName: string; onClose: () => void }) {
  const [runs, setRuns] = useState<UpdateReminderRun[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getUpdateReminderHistory(ruleId).then(r => { if (Array.isArray(r)) setRuns(r as UpdateReminderRun[]) }).catch(() => {}).finally(() => setLoading(false))
  }, [ruleId])

  return (
    <div className="ur-result-overlay" onClick={onClose}>
      <div className="ur-result-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="ur-result-header">
          <History size={16} style={{ color: 'var(--color-primary)' }} />
          <div className="ur-result-title">Run History — {ruleName}</div>
          <button className="ur-editor-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ur-result-body">
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[0, 1, 2].map(i => (
                <div key={i} className="ur-history-row" style={{ gap: 8 }}>
                  <div className="skeleton" style={{ width: 110, height: 12, borderRadius: 4 }} />
                  <div className="skeleton" style={{ width: 52, height: 18, borderRadius: 4 }} />
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div className="skeleton" style={{ width: 68, height: 12, borderRadius: 4 }} />
                    <div className="skeleton" style={{ width: 72, height: 12, borderRadius: 4 }} />
                  </div>
                </div>
              ))}
            </div>
          ) : runs.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No runs yet.</div>
          : runs.map(run => (
            <div key={run.id} className="ur-history-row">
              <div className="ur-history-date">{upperAmPm(new Date(run.ran_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short', hour12: true, timeZone: 'Asia/Kolkata' }))}</div>
              <span className="ur-history-by">{run.triggered_by}</span>
              <div className="ur-history-counts">
                <span className="ur-history-count-item" style={{ color: 'var(--color-success)' }}><CheckCircle size={11} />{run.posted_names.length} posted</span>
                <span className="ur-history-count-item" style={{ color: 'var(--color-danger)' }}><AlertTriangle size={11} />{run.skipped_names.length} missing</span>
              </div>
              {run.error && <div className="ur-history-error">{run.error}</div>}
            </div>
          ))}
        </div>
        <div className="ur-result-footer">
          <button className="ur-btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ── Rule card ─────────────────────────────────────────────────────────────────

const RuleCard = React.memo(function RuleCard({ rule, channels, onRefresh }: {
  rule: UpdateReminderRule
  channels: ChannelRef[]
  onRefresh: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [dryRunResult, setDryRunResult] = useState<UpdateReminderRunResult | null>(null)
  const [dryRunLoading, setDryRunLoading] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [running, setRunning] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const handleToggle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await api.toggleUpdateReminderRule(rule.id, e.target.checked).catch(() => {})
    onRefresh()
  }

  const handleDelete = async () => {
    await api.deleteUpdateReminderRule(rule.id).catch(() => {})
    setConfirmDelete(false)
    onRefresh()
  }

  const handleDryRun = async () => {
    setRunning(true)
    setDryRunResult(null)
    setDryRunLoading(true)
    try {
      const r = await api.dryRunUpdateReminder(rule.id)
      if (r && typeof r === 'object' && 'snapshot' in r) setDryRunResult(r as unknown as UpdateReminderRunResult)
    } finally {
      setDryRunLoading(false)
      setRunning(false)
    }
  }

  const handleRunNow = async (forceSnapshot: boolean) => {
    setDryRunResult(null)
    setRunning(true)
    try {
      await api.runNowUpdateReminder(rule.id, forceSnapshot)
      onRefresh()
    } finally {
      setRunning(false)
    }
  }

  const schedLabel = (() => {
    const days = (rule.schedule_days ?? []).sort().map(d => DAYS[d]).join(' ')
    return `${days} at ${displayTime(rule.schedule_time)} ${rule.timezone.split('/')[1] ?? rule.timezone}`
  })()

  const srcLabel = (rule.source_channel_ids ?? []).map(c => `#${c.name}`).join(', ') || 'No channels'

  return (
    <>
      <div className="ur-card">
        <div className="ur-card-top">
          <label className="ur-toggle">
            <input type="checkbox" checked={rule.enabled} onChange={handleToggle} />
            <span className="ur-toggle-slider" />
          </label>
          <span className="ur-card-name">{rule.name}</span>
        </div>
        <div className="ur-card-meta">
          <span className="ur-card-meta-item"><Clock size={11} />{schedLabel}</span>
          <span className="ur-card-meta-item"><Users size={11} />{srcLabel}</span>
          {rule.last_snapshot_at && (
            <span className="ur-card-meta-item"><Calendar size={11} />Last: {new Date(rule.last_snapshot_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
          )}
        </div>
        <div className="ur-card-actions">
          <button className="ur-action-btn" onClick={() => setEditing(true)}><Plus size={12} />Edit</button>
          <button className="ur-action-btn" onClick={handleDryRun} disabled={running}><Eye size={12} />Dry Run</button>
          <button className="ur-action-btn" onClick={() => handleRunNow(true)} disabled={running}><Play size={12} />Run Now</button>
          <button className="ur-action-btn" onClick={() => setShowHistory(true)}><History size={12} />History</button>
          <button className="ur-action-btn danger" onClick={() => setConfirmDelete(true)}><Trash2 size={12} />Delete</button>
        </div>
      </div>

      {editing && (
        <RuleEditor
          rule={rule}
          channels={channels}
          onClose={() => setEditing(false)}
          onSaved={onRefresh}
        />
      )}

      {(dryRunLoading || dryRunResult) && (
        <RunResultModal
          result={dryRunResult}
          isDryRun
          loading={dryRunLoading}
          onSendOriginal={() => { setDryRunResult(null); handleRunNow(false) }}
          onSendUpdated={() => { setDryRunResult(null); handleRunNow(true) }}
          onClose={() => { setDryRunResult(null); setDryRunLoading(false) }}
        />
      )}

      {showHistory && <HistoryModal ruleId={rule.id} ruleName={rule.name} onClose={() => setShowHistory(false)} />}

      {confirmDelete && (
        <ConfirmModal
          message={`Delete "${rule.name}"?`}
          detail="This will remove the rule and all its run history. This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  )
})

// ── Main tab component ────────────────────────────────────────────────────────

const UR_TABS = ['claude-queue', 'quick-send', 'rules'] as const
type URTab = typeof UR_TABS[number]

export function UpdateRemindersTab({
  channels: channelsProp,
  initialTab = 'claude-queue',
  onTabChange,
}: {
  channels?: ChannelRef[]
  initialTab?: string
  onTabChange?: (tab: string) => void
}) {
  const [rules, setRules] = useState<UpdateReminderRule[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [channels, setChannels] = useState<ChannelRef[]>(channelsProp ?? [])
  const [activeTab, setActiveTab] = useState<URTab>(
    UR_TABS.includes(initialTab as URTab) ? (initialTab as URTab) : 'claude-queue'
  )
  const [queueStats, setQueueStats] = useState({ pending: 0, sentToday: 0 })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.listUpdateReminderRules()
      if (Array.isArray(r)) setRules(r as UpdateReminderRule[])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (channelsProp) { setChannels(channelsProp); return }
    api.getSlackChannels().then(r => {
      if (Array.isArray(r)) setChannels(r.map((c: any) => ({ id: c.id, name: c.name })))
    }).catch(() => {})
  }, [channelsProp])

  useEffect(() => {
    api.listQueuedMessages().then(r => {
      const list = Array.isArray(r) ? r : Array.isArray((r as any)?.data) ? (r as any).data : []
      const today = new Date().toDateString()
      setQueueStats({
        pending: list.filter((m: any) => m.status === 'pending').length,
        sentToday: list.filter((m: any) => m.status === 'sent' && m.sent_at && new Date(m.sent_at).toDateString() === today).length,
      })
    }).catch(() => {})
  }, [])

  useEffect(() => { setActiveTab(UR_TABS.includes(initialTab as URTab) ? (initialTab as URTab) : 'claude-queue') }, [initialTab])

  const handleTabChange = (tab: URTab) => { setActiveTab(tab); onTabChange?.(tab) }
  const activeRules = rules.filter(r => r.enabled).length

  return (
    <div className="ur-root">
      {/* KPI row */}
      <div className="ur-kpi-row">
        <div className="ur-kpi-card" onClick={() => handleTabChange('claude-queue')} style={{ cursor: 'pointer' }}>
          <div className="ur-kpi-glow" />
          <div className="ur-kpi-label">QUEUE</div>
          <div className="ur-kpi-value ur-kpi-value--primary">{queueStats.pending}</div>
          <div className="ur-kpi-sub">pending messages</div>
        </div>
        <div className="ur-kpi-card">
          <div className="ur-kpi-glow ur-kpi-glow--success" />
          <div className="ur-kpi-label">ACTIVE RULES</div>
          <div className="ur-kpi-value ur-kpi-value--success">{activeRules}</div>
          <div className="ur-kpi-sub">of {rules.length} total</div>
        </div>
        <div className="ur-kpi-card" onClick={() => handleTabChange('quick-send')} style={{ cursor: 'pointer' }}>
          <div className="ur-kpi-glow ur-kpi-glow--warning" />
          <div className="ur-kpi-label">SENT TODAY</div>
          <div className="ur-kpi-value ur-kpi-value--warning">{queueStats.sentToday}</div>
          <div className="ur-kpi-sub">via Claude queue</div>
        </div>
      </div>

      {/* Inner tab bar */}
      <div className="ur-inner-tabs">
        <button className={`ur-inner-tab${activeTab === 'claude-queue' ? ' active' : ''}`} onClick={() => handleTabChange('claude-queue')}>
          Claude Queue
          {queueStats.pending > 0 && <span className="ur-tab-badge">{queueStats.pending}</span>}
        </button>
        <button className={`ur-inner-tab${activeTab === 'quick-send' ? ' active' : ''}`} onClick={() => handleTabChange('quick-send')}>
          Quick Send
        </button>
        <button className={`ur-inner-tab${activeTab === 'rules' ? ' active' : ''}`} onClick={() => handleTabChange('rules')}>
          Reminder Rules
          {activeRules > 0 && <span className="ur-tab-badge-dot" />}
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'claude-queue' && (
        <div className="ur-tab-inline">
          <ClaudeQueueCard channels={channels} autoOpen />
        </div>
      )}
      {activeTab === 'quick-send' && (
        <div className="ur-tab-inline">
          <QuickSendCard channels={channels} autoOpen />
        </div>
      )}
      {activeTab === 'rules' && (
        <>
          <div className="ur-list-header">
            <span className="ur-list-title">Reminder Rules</span>
            <button className="ur-new-btn" onClick={() => setShowNew(true)}>
              <Plus size={13} /> New Rule
            </button>
          </div>
          {loading ? (
            [0, 1, 2].map(i => (
              <div key={i} className="ur-skeleton-card">
                <div className="skeleton" style={{ width: '40%', height: 14, borderRadius: 4 }} />
                <div className="skeleton" style={{ width: '65%', height: 11, borderRadius: 4 }} />
                <div style={{ display: 'flex', gap: 6 }}>
                  {[80, 70, 75, 70].map((w, j) => <div key={j} className="skeleton" style={{ width: w, height: 26, borderRadius: 6 }} />)}
                </div>
              </div>
            ))
          ) : rules.length === 0 ? (
            <div className="ur-empty">
              <ToggleLeft size={28} style={{ marginBottom: 8, color: 'var(--text-muted)' }} />
              <div>No reminder rules yet.</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>Create your first rule to start automating update checks.</div>
            </div>
          ) : (
            rules.map(rule => (
              <RuleCard key={rule.id} rule={rule} channels={channels} onRefresh={load} />
            ))
          )}
        </>
      )}

      {showNew && (
        <RuleEditor rule={null} channels={channels} onClose={() => setShowNew(false)} onSaved={load} />
      )}
    </div>
  )
}
