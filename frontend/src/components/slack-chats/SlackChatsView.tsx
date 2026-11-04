import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, MessagesSquare } from 'lucide-react'
import api from '@/services/api'
import type { SlackChat, SlackChatMessage, SlackChatMode } from '@/services/api'
import { SlackChatList } from './SlackChatList'
import { SlackChatThread } from './SlackChatThread'
import { mergeConversation } from './slack-chats-utils'
import '@/styles/pages/slack-chats.css'

const LIST_POLL_MS = 10_000
const THREAD_POLL_MS = 5_000

// Admin-only "Chats" tab of the Slack page: every DM between people and the Velocity bot as a
// Slack-style people list and thread, with a reply box. The backend (/api/slack-chats, behind
// AdminOnly) is the access boundary, this component only renders what it is allowed to fetch.
export function SlackChatsView({ alertPermission, onEnableAlerts, onChanged }: {
  alertPermission: NotificationPermission | 'unsupported'
  onEnableAlerts: () => void
  /** Called after anything that changes what needs the admin, so the tab badge refreshes. */
  onChanged: () => void
}) {
  const [chats, setChats] = useState<SlackChat[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('') // not persisted: on a phone it would skip the people list
  const [messages, setMessages] = useState<SlackChatMessage[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [threadError, setThreadError] = useState('')
  const [sending, setSending] = useState(false)
  const activeId = useRef('') // the chat the admin is looking at now, to drop answers for one they left
  const lastMsgId = useRef(0)

  const selected = chats.find(c => c.channel_id === selectedId) ?? null

  const loadChats = useCallback(async () => {
    try {
      const res = await api.getSlackChats()
      if (res.success && res.data) {
        setChats(res.data)
        setListError('')
      } else {
        setListError(res.message || 'Could not load chats.')
      }
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Could not load chats.')
    } finally {
      setLoadingList(false)
    }
  }, [])

  /** Fetch a chat's messages. First call loads the latest; later ones only what is new. */
  const loadMessages = useCallback(async (id: string, first: boolean) => {
    try {
      const res = await api.getSlackChatMessages(id, { afterId: first ? 0 : lastMsgId.current, markRead: true })
      if (activeId.current !== id || !res.success || !res.data) return
      const fresh = res.data
      if (fresh.length > 0) {
        lastMsgId.current = Math.max(lastMsgId.current, ...fresh.map(m => m.id))
        setMessages(prev => {
          if (first) return fresh
          const seen = new Set(prev.map(m => m.id))
          return [...prev, ...fresh.filter(m => !seen.has(m.id))]
        })
      }
      if (res.conversation) {
        const conv = res.conversation
        setChats(prev => prev.map(c => (c.channel_id === id ? mergeConversation(c, conv) : c)))
      }
      setThreadError('')
    } catch (e) {
      if (activeId.current === id && first) setThreadError(e instanceof Error ? e.message : 'Could not load this chat.')
    } finally {
      if (activeId.current === id) setLoadingMsgs(false)
    }
  }, [])

  // People list: load now, then keep fresh while the tab is visible.
  useEffect(() => {
    loadChats()
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') loadChats() }, LIST_POLL_MS)
    return () => window.clearInterval(t)
  }, [loadChats])

  // Open a chat: load it, then poll for new messages.
  useEffect(() => {
    activeId.current = selectedId
    lastMsgId.current = 0
    setMessages([])
    setThreadError('')
    if (!selectedId) { setLoadingMsgs(false); return }
    setLoadingMsgs(true)
    loadMessages(selectedId, true).then(onChanged)
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') loadMessages(selectedId, false) }, THREAD_POLL_MS)
    return () => window.clearInterval(t)
  // onChanged is a stable callback from the parent; re-running on its identity would reload the chat.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, loadMessages])

  async function send(text: string): Promise<boolean> {
    if (!selectedId) return false
    setSending(true)
    setThreadError('')
    try {
      await api.replySlackChat(selectedId, text)
      await Promise.all([loadMessages(selectedId, false), loadChats()])
      onChanged()
      return true
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : 'The message was not sent.')
      return false
    } finally {
      setSending(false)
    }
  }

  async function changeMode(mode: SlackChatMode) {
    if (!selected) return
    const previous = selected.mode
    setChats(prev => prev.map(c => (c.channel_id === selected.channel_id ? { ...c, mode } : c)))
    try {
      await api.setSlackChatMode(selected.channel_id, mode)
    } catch (e) {
      setChats(prev => prev.map(c => (c.channel_id === selected.channel_id ? { ...c, mode: previous } : c)))
      setThreadError(e instanceof Error ? e.message : 'Could not change that.')
    }
  }

  async function resolve() {
    if (!selected) return
    try {
      await api.resolveSlackChat(selected.channel_id)
      await loadChats()
      onChanged()
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : 'Could not hand this back.')
    }
  }

  return (
    <div className="slchat-page">
      <div className="slchat-toolbar">
        <div>
          <h2><MessagesSquare size={18} aria-hidden="true" /> Chats</h2>
          <p>Direct messages between people and the Velocity bot. Only admins can see this page.</p>
        </div>
        {alertPermission === 'default' && (
          <button type="button" className="slchat-btn" onClick={onEnableAlerts}>
            <Bell size={14} aria-hidden="true" /> Turn on browser alerts
          </button>
        )}
      </div>
      {listError && <div className="slchat-error" role="alert">{listError}</div>}

      <div className={`slchat-wrap${selected ? ' slchat-wrap--thread' : ''}`}>
        <SlackChatList
          chats={chats}
          selectedId={selectedId}
          onSelect={setSelectedId}
          search={search}
          onSearch={setSearch}
          loading={loadingList}
        />
        <div className="slchat-main">
          {selected ? (
            <SlackChatThread
              chat={selected}
              messages={messages}
              loading={loadingMsgs}
              error={threadError}
              sending={sending}
              onBack={() => setSelectedId('')}
              onSend={send}
              onMode={changeMode}
              onResolve={resolve}
            />
          ) : (
            <div className="slchat-empty slchat-empty--main">
              <MessagesSquare size={28} aria-hidden="true" />
              <strong>Pick a chat</strong>
              <span>Choose someone on the left to read the conversation and reply.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
