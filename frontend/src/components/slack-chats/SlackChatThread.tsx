import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Link2, Send, UserCheck } from 'lucide-react'
import type { SlackChat, SlackChatMessage, SlackChatMode } from '@/services/api'
import { CustomDropdown } from '@/components/CustomDropdown'
import { ConfirmModal } from '@/components/ConfirmModal'
import { SlackMessageText } from '@/components/SlackMessageText'
import {
  MODE_OPTIONS, bubbleCaption, bubbleSide, chatDateTime, chatName, chatTime, dayLabel, initials,
} from './slack-chats-utils'

const MAX_REPLY = 3000
const W = [55, 70, 48, 65, 58, 72]

export function SlackChatThreadSkeleton() {
  return (
    <div className="slchat-messages" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <div className={`slchat-row ${i % 2 ? 'slchat-row--you' : 'slchat-row--them'}`} key={i}>
          <div className="skeleton slchat-sk-bubble" style={{ width: `${W[i % 6]}%`, height: 44 + (i % 3) * 14 }} />
        </div>
      ))}
    </div>
  )
}

const Bubble = memo(function Bubble({ m }: { m: SlackChatMessage }) {
  const side = bubbleSide(m)
  return (
    <div className={`slchat-row slchat-row--${side}`}>
      <div className={`slchat-bubble slchat-bubble--${side}`}>
        <div className="slchat-bubble-cap">{bubbleCaption(m)}</div>
        <SlackMessageText text={m.text} className="slchat-bubble-text" />
        <div className="slchat-bubble-time" title={chatDateTime(m.created_at)}>{chatTime(m.created_at)}</div>
      </div>
    </div>
  )
})

export function SlackChatThread({ chat, messages, loading, error, sending, onBack, onSend, onMode, onResolve }: {
  chat: SlackChat
  messages: SlackChatMessage[]
  loading: boolean
  error: string
  sending: boolean
  onBack: () => void
  onSend: (text: string) => Promise<boolean>
  onMode: (mode: SlackChatMode) => void
  onResolve: () => void
}) {
  const [draft, setDraft] = useState('')
  const [confirmResolve, setConfirmResolve] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // follow new messages only while the admin is at the bottom
  const name = chatName(chat)
  const modeHint = MODE_OPTIONS.find(o => o.value === chat.mode)?.hint ?? ''

  // New chat: start at the bottom again.
  useLayoutEffect(() => { stick.current = true }, [chat.channel_id])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  const groups = useMemo(() => {
    const out: Array<{ label: string; items: SlackChatMessage[] }> = []
    for (const m of messages) {
      const label = dayLabel(m.created_at)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(m)
      else out.push({ label, items: [m] })
    }
    return out
  }, [messages])

  const canResolve = chat.relay_active || chat.needs_attention
  const tooLong = draft.length > MAX_REPLY
  const canSend = draft.trim().length > 0 && !tooLong && !sending

  async function send() {
    if (!canSend) return
    stick.current = true
    if (await onSend(draft.trim())) setDraft('')
  }

  return (
    <section className="slchat-thread" aria-label={`Chat with ${name}`}>
      <header className="slchat-thread-head">
        <button type="button" className="slchat-back" onClick={onBack} aria-label="Back to people">
          <ArrowLeft size={18} />
        </button>
        <span className="slchat-avatar slchat-avatar--lg" aria-hidden="true">{initials(name)}</span>
        <div className="slchat-thread-title">
          <h3>{name}</h3>
          {chat.slack_user_email && <span className="slchat-thread-sub">{chat.slack_user_email}</span>}
        </div>
        <div className="slchat-thread-actions">
          <CustomDropdown
            options={MODE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
            value={chat.mode}
            onChange={v => onMode(v as SlackChatMode)}
            searchable={false}
            className="slchat-mode"
          />
          {canResolve && (
            <button type="button" className="slchat-btn" onClick={() => setConfirmResolve(true)}>
              <UserCheck size={14} aria-hidden="true" /> Hand back to bot
            </button>
          )}
        </div>
      </header>

      <div className="slchat-mode-hint">{modeHint}</div>
      {chat.relay_active && (
        <div className="slchat-relay" role="status">
          <Link2 size={14} aria-hidden="true" />
          <span>
            Their answers are being passed on to <strong>{chat.relay_owner_name || 'a Velocity user'}</strong>
            {chat.relay_until ? <>, and the bot stays quiet until {chatDateTime(chat.relay_until)}.</> : '.'}
          </span>
        </div>
      )}

      <div className="slchat-messages" ref={scroller} onScroll={e => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}>
        {loading ? (
          <SlackChatThreadSkeleton />
        ) : messages.length === 0 ? (
          <div className="slchat-empty">No messages in this chat yet.</div>
        ) : (
          groups.map(g => (
            <div key={g.label} className="slchat-day">
              <div className="slchat-day-label"><span>{g.label}</span></div>
              {g.items.map(m => <Bubble key={m.id} m={m} />)}
            </div>
          ))
        )}
      </div>

      <footer className="slchat-composer">
        {error && <div className="slchat-error" role="alert">{error}</div>}
        <div className="slchat-composer-row">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={`Reply to ${name} as Velocity`}
            aria-label={`Reply to ${name}`}
            rows={2}
            disabled={sending}
          />
          <button type="button" className="slchat-send" onClick={send} disabled={!canSend} aria-label="Send reply">
            <Send size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="slchat-composer-foot">
          <span>Sent as Velocity with your name, and their answer comes back here.</span>
          {draft.length > MAX_REPLY - 500 && (
            <span className={tooLong ? 'slchat-count slchat-count--over' : 'slchat-count'}>{draft.length}/{MAX_REPLY}</span>
          )}
        </div>
      </footer>

      <ConfirmModal
        open={confirmResolve}
        variant="info"
        title="Hand this chat back to the bot?"
        message={`The bot will answer ${name}'s next message again, and this chat stops waiting for you.`}
        confirmLabel="Hand back"
        onConfirm={() => { setConfirmResolve(false); onResolve() }}
        onCancel={() => setConfirmResolve(false)}
      />
    </section>
  )
}
