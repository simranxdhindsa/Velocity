import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, Bot, Link2, Zap } from 'lucide-react'
import type { SlackChat, SlackChatMessage, SlackChatMode } from '@/services/api'
import { CustomDropdown } from '@/components/CustomDropdown'
import { ConfirmModal } from '@/components/ConfirmModal'
import { SlackMessageText } from '@/components/SlackMessageText'
import { ChatAvatar } from './ChatAvatar'
import { SlackChatComposer } from './SlackChatComposer'
import {
  MODE_OPTIONS, bubbleCaption, bubbleSide, chatDateTime, chatName, chatTime, dayLabel, needsCaption, sameAuthor,
  type BubbleSide,
} from './slack-chats-utils'

const W = [55, 70, 48, 65, 58, 72]

export function SlackChatThreadSkeleton() {
  return (
    <div className="slchat-messages" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <div className={`slchat-row ${i % 2 ? 'slchat-row--you' : 'slchat-row--them'}`} key={i}>
          <div className="skeleton slchat-sk-avatar-sm" />
          <div className="skeleton slchat-sk-bubble" style={{ width: `${W[i % 6]}%`, height: 44 + (i % 3) * 14 }} />
        </div>
      ))}
    </div>
  )
}

// The photo beside a message: the author's, or the Velocity mark for the bot's own messages.
function BubbleAvatar({ m, side }: { m: SlackChatMessage; side: BubbleSide }) {
  if (side === 'bot') {
    return <span className="slchat-avatar slchat-avatar--sm slchat-avatar--bot" aria-hidden="true"><Zap size={14} /></span>
  }
  return <ChatAvatar name={m.author_label} image={m.author_image} small />
}

// The photo shows once per run of messages from the same author, level with the last one.
const Bubble = memo(function Bubble({ m, first, last, caption }: { m: SlackChatMessage; first: boolean; last: boolean; caption: boolean }) {
  const side = bubbleSide(m)
  return (
    <div className={`slchat-row slchat-row--${side}${first ? ' slchat-row--first' : ''}${last ? ' slchat-row--last' : ''}`}>
      {last ? <BubbleAvatar m={m} side={side} /> : <span className="slchat-avatar-gap" aria-hidden="true" />}
      <div className={`slchat-bubble slchat-bubble--${side}`}>
        {caption && <div className="slchat-bubble-cap">{bubbleCaption(m)}</div>}
        <SlackMessageText text={m.text} className="slchat-bubble-text" />
        <div className="slchat-bubble-time" title={chatDateTime(m.created_at)}>{chatTime(m.created_at)}</div>
      </div>
    </div>
  )
})

export function SlackChatThread({ chat, messages, loading, error, sending, notice, onBack, onSend, onMode, onResolve }: {
  chat: SlackChat
  messages: SlackChatMessage[]
  loading: boolean
  error: string
  sending: boolean
  notice: string
  onBack: () => void
  onSend: (text: string) => Promise<boolean>
  onMode: (mode: SlackChatMode) => void
  onResolve: () => void
}) {
  const [confirmResolve, setConfirmResolve] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // follow new messages only while the admin is at the bottom
  // Where the admin scrolled away from, so the jump button can count what arrived since.
  const [awayFrom, setAwayFrom] = useState<{ chat: string; id: number } | null>(null)
  const name = chatName(chat)
  const modeHint = MODE_OPTIONS.find(o => o.value === chat.mode)?.hint ?? ''

  // New chat: start at the bottom again.
  useLayoutEffect(() => { stick.current = true }, [chat.channel_id])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  // Stay on the latest message when the area shrinks, like a growing draft or a rotated phone.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const watcher = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight })
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [])

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

  const away = awayFrom?.chat === chat.channel_id ? awayFrom : null
  const unread = away ? messages.filter(m => m.id > away.id).length : 0

  function onScroll(el: HTMLDivElement) {
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = near
    const lastId = messages[messages.length - 1]?.id ?? 0
    setAwayFrom(prev => {
      if (near) return null
      return prev?.chat === chat.channel_id ? prev : { chat: chat.channel_id, id: lastId }
    })
  }

  function jumpToLatest() {
    const el = scroller.current
    if (!el) return
    stick.current = true
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: calm ? 'auto' : 'smooth' })
  }

  // While a relay is open the button sits in its banner, otherwise in the header.
  const canPassInHeader = !chat.relay_active && chat.needs_attention

  return (
    <section className="slchat-thread" aria-label={`Chat with ${name}`}>
      <header className="slchat-thread-head">
        <button type="button" className="slchat-back" onClick={onBack} aria-label="Back to people">
          <ArrowLeft size={18} />
        </button>
        <ChatAvatar name={name} image={chat.slack_user_image} large />
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
          {canPassInHeader && (
            <button type="button" className="slchat-btn" onClick={() => setConfirmResolve(true)}>
              <Bot size={14} aria-hidden="true" /> Pass to bot
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
          <button type="button" className="slchat-btn slchat-relay-btn" onClick={() => setConfirmResolve(true)}>
            <Bot size={14} aria-hidden="true" /> Pass to bot
          </button>
        </div>
      )}
      {notice && <div className="slchat-relay slchat-relay--done" role="status"><Bot size={14} aria-hidden="true" /><span>{notice}</span></div>}

      <div className="slchat-messages-wrap">
      <div className="slchat-messages" ref={scroller} onScroll={e => onScroll(e.currentTarget)}>
        {loading ? (
          <SlackChatThreadSkeleton />
        ) : messages.length === 0 ? (
          <div className="slchat-empty">No messages in this chat yet.</div>
        ) : (
          groups.map(g => (
            <div key={g.label} className="slchat-day">
              <div className="slchat-day-label"><span>{g.label}</span></div>
              {g.items.map((m, i) => (
                <Bubble
                  key={m.id}
                  m={m}
                  first={i === 0 || !sameAuthor(g.items[i - 1], m)}
                  last={i === g.items.length - 1 || !sameAuthor(m, g.items[i + 1])}
                  caption={needsCaption(g.items[i - 1], m)}
                />
              ))}
            </div>
          ))
        )}
      </div>
      {away && (
        <button type="button" className="slchat-jump" onClick={jumpToLatest}>
          <ArrowDown size={14} aria-hidden="true" />
          {unread > 0 ? `${unread} new ${unread === 1 ? 'message' : 'messages'}` : 'Jump to latest'}
        </button>
      )}
      </div>

      <SlackChatComposer key={chat.channel_id} name={name} error={error} sending={sending} onSend={text => { stick.current = true; return onSend(text) }} />

      <ConfirmModal
        open={confirmResolve}
        variant="info"
        title="Pass this chat to the bot?"
        message={chat.mode === 'muted'
          ? `This chat stops waiting for you. It is muted, so the bot stays quiet until you change the mode.`
          : `The bot will answer ${name}'s last message if it is still waiting, then keep answering from here. This chat stops waiting for you.`}
        confirmLabel="Pass to bot"
        onConfirm={() => { setConfirmResolve(false); onResolve() }}
        onCancel={() => setConfirmResolve(false)}
      />
    </section>
  )
}
