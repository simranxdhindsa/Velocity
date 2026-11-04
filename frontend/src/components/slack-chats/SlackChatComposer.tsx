import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Heart, MessageCircle, Send, Sparkles, Undo2 } from 'lucide-react'
import { api } from '@/services/api'

const MAX_REPLY = 3000
const MAX_ROWS_PX = 140

type Style = 'polite' | 'human'

const STYLES: Array<{ id: Style; label: string; hint: string; Icon: typeof Heart }> = [
  { id: 'polite', label: 'Make it polite', hint: 'Rewrite this as a warm, polite message', Icon: Heart },
  { id: 'human', label: 'Sound human', hint: 'Rewrite this the way a real person would type it', Icon: MessageCircle },
]

/**
 * The reply box: a growing text field, an AI rephrase pair (polite or human) with a one-click
 * undo, and a send button. The draft lives here and starts empty for every chat (the parent
 * keys this component by conversation).
 */
export function SlackChatComposer({ name, error, sending, onSend }: {
  name: string
  error: string
  sending: boolean
  onSend: (text: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<Style | null>(null)
  const [aiError, setAiError] = useState('')
  const [undoText, setUndoText] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // Grow with the text, up to a cap, then scroll.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`
  }, [draft])

  const tooLong = draft.length > MAX_REPLY
  const hasText = draft.trim().length > 0
  const canSend = hasText && !tooLong && !sending && !busy

  async function send() {
    if (!canSend) return
    if (await onSend(draft.trim()) && alive.current) {
      setDraft('')
      setUndoText(null)
    }
  }

  async function rephrase(style: Style) {
    if (!hasText || busy || sending || tooLong) return
    const original = draft
    setBusy(style)
    setAiError('')
    try {
      const res = await api.rephraseSlackChat(original.trim(), style)
      const next = res.data?.text
      if (!alive.current) return
      if (!next) throw new Error('AI sent back an empty message.')
      setDraft(next)
      setUndoText(original)
    } catch (e) {
      if (alive.current) setAiError(e instanceof Error ? e.message : 'AI could not rephrase this right now.')
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  return (
    <footer className="slchat-composer">
      {(error || aiError) && <div className="slchat-error" role="alert">{error || aiError}</div>}
      <div className={`slchat-box${busy ? ' slchat-box--busy' : ''}`}>
        <textarea
          ref={field}
          value={draft}
          onChange={e => { setDraft(e.target.value); setUndoText(null) }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={`Reply to ${name} as Velocity`}
          aria-label={`Reply to ${name}`}
          rows={1}
          disabled={sending || !!busy}
        />
        <div className="slchat-box-bar">
          <div className={`slchat-ai${hasText ? ' slchat-ai--on' : ''}`} aria-hidden={!hasText}>
            {STYLES.map(({ id, label, hint, Icon }) => (
              <button
                key={id}
                type="button"
                className={`slchat-chip${busy === id ? ' slchat-chip--busy' : ''}`}
                onClick={() => rephrase(id)}
                disabled={!hasText || !!busy || sending || tooLong}
                tabIndex={hasText ? 0 : -1}
                title={hint}
              >
                {busy === id ? <Sparkles size={13} aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}
                <span>{busy === id ? 'Rewriting' : label}</span>
              </button>
            ))}
            {undoText !== null && !busy && (
              <button
                type="button"
                className="slchat-chip slchat-chip--undo"
                onClick={() => { setDraft(undoText); setUndoText(null) }}
                title="Put back what you wrote"
              >
                <Undo2 size={13} aria-hidden="true" /> <span>Undo</span>
              </button>
            )}
          </div>
          <button type="button" className="slchat-send" onClick={send} disabled={!canSend} aria-label="Send reply">
            <Send size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="slchat-composer-foot">
        <span>Sent as Velocity, and their answer comes back here.</span>
        {draft.length > MAX_REPLY - 500 && (
          <span className={tooLong ? 'slchat-count slchat-count--over' : 'slchat-count'}>{draft.length}/{MAX_REPLY}</span>
        )}
      </div>
    </footer>
  )
}
