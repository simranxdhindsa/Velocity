import { memo } from 'react'
import { BellOff, Link2, Search } from 'lucide-react'
import type { SlackChat } from '@/services/api'
import { chatAgo, chatName, previewLine } from './slack-chats-utils'
import { ChatAvatar } from './ChatAvatar'

const W = [55, 70, 48, 65, 58, 72]

export function SlackChatListSkeleton() {
  return (
    <div className="slchat-list-body" aria-hidden="true">
      {Array.from({ length: 7 }).map((_, i) => (
        <div className="slchat-item slchat-item--skeleton" key={i}>
          <div className="skeleton slchat-sk-avatar" />
          <div className="slchat-item-main">
            <div className="skeleton slchat-sk-line" style={{ width: `${W[i % 6]}%`, height: 12 }} />
            <div className="skeleton slchat-sk-line" style={{ width: `${W[(i + 2) % 6]}%`, height: 10, marginTop: 8 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

const ChatRow = memo(function ChatRow({ chat, active, onSelect }: { chat: SlackChat; active: boolean; onSelect: (id: string) => void }) {
  const name = chatName(chat)
  return (
    <button
      type="button"
      className={`slchat-item${active ? ' slchat-item--active' : ''}${chat.needs_attention ? ' slchat-item--attn' : ''}`}
      onClick={() => onSelect(chat.channel_id)}
      aria-current={active ? 'true' : undefined}
    >
      <ChatAvatar name={name} image={chat.slack_user_image} />
      <span className="slchat-item-main">
        <span className="slchat-item-top">
          <span className="slchat-item-name">{name}</span>
          <span className="slchat-item-time">{chatAgo(chat.last_message_at)}</span>
        </span>
        <span className="slchat-item-preview">{previewLine(chat) || 'No messages yet'}</span>
        <span className="slchat-item-tags">
          {chat.needs_attention && <span className="slchat-tag slchat-tag--attn">Waiting for you</span>}
          {chat.relay_active && (
            <span className="slchat-tag" title="Their answers are being passed on to this person">
              <Link2 size={10} aria-hidden="true" /> {chat.relay_owner_name || 'Relay'}
            </span>
          )}
          {chat.mode === 'muted' && (
            <span className="slchat-tag" title="The bot never answers this person">
              <BellOff size={10} aria-hidden="true" /> Muted
            </span>
          )}
        </span>
      </span>
    </button>
  )
})

export function SlackChatList({ chats, selectedId, onSelect, search, onSearch, loading }: {
  chats: SlackChat[]
  selectedId: string
  onSelect: (id: string) => void
  search: string
  onSearch: (v: string) => void
  loading: boolean
}) {
  const q = search.trim().toLowerCase()
  const shown = q
    ? chats.filter(c => `${chatName(c)} ${c.slack_user_email} ${c.last_preview}`.toLowerCase().includes(q))
    : chats

  return (
    <aside className="slchat-list" aria-label="People">
      <div className="slchat-list-head">
        <label className="slchat-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Search people and messages"
            aria-label="Search chats"
          />
        </label>
      </div>
      {loading ? (
        <SlackChatListSkeleton />
      ) : shown.length === 0 ? (
        <div className="slchat-empty slchat-empty--list">
          {chats.length === 0
            ? 'No chats yet. They show up here once Velocity DMs someone for you, or someone DMs the bot.'
            : 'Nobody matches that search.'}
        </div>
      ) : (
        <div className="slchat-list-body">
          {shown.map(c => (
            <ChatRow key={c.channel_id} chat={c} active={c.channel_id === selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </aside>
  )
}
