// The PM Assistant input: a pill with a rotating rainbow rim, an aurora glowing underneath
// that flares while typing, a spark icon and a round send button (from the 21st.dev
// "ai thinking orb and input" component). Empty submits shake; a real submit squeezes the
// pill and reports where the send button is, so the thinking orb can fly out of it.
import { forwardRef, useRef, useState, type KeyboardEvent } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: (text: string, from: DOMRect | null) => void
  busy: boolean
  placeholder: string
  maxLength?: number
}

export const AssistantPill = forwardRef<HTMLInputElement, Props>(function AssistantPill(
  { value, onChange, onSubmit, busy, placeholder, maxLength = 500 }, inputRef,
) {
  const pillRef = useRef<HTMLFormElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const timers = useRef<{ typing?: number; shake?: number; launch?: number }>({})
  const [typing, setTyping] = useState(false)
  const ready = value.trim().length > 0 && !busy

  const flag = (attr: 'shake' | 'launch', ms: number) => {
    const el = pillRef.current
    if (!el) return
    el.removeAttribute(`data-${attr}`)
    void el.offsetWidth // restart the animation
    el.setAttribute(`data-${attr}`, '')
    window.clearTimeout(timers.current[attr])
    timers.current[attr] = window.setTimeout(() => el.removeAttribute(`data-${attr}`), ms)
  }

  const submit = () => {
    if (busy) return
    const text = value.trim()
    if (!text) { flag('shake', 260); return }
    flag('launch', 420)
    onSubmit(text, sendRef.current?.getBoundingClientRect() ?? null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }

  return (
    <form
      ref={pillRef}
      className={`pa-pill${typing ? ' pa-pill--typing' : ''}${busy ? ' pa-pill--busy' : ''}`}
      onSubmit={e => { e.preventDefault(); submit() }}
      autoComplete="off"
    >
      <div className="pa-pill-underglow" aria-hidden="true" />
      <div className="pa-pill-surface" aria-hidden="true">
        <div className="pa-aurora"><i /><i /><i /><i /></div>
      </div>
      <div className="pa-pill-ring" aria-hidden="true" />
      <svg className="pa-spark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 3.5l1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8L3.5 10l4.8-1.7L10 3.5z" />
        <path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
      </svg>
      <input
        ref={inputRef}
        className="pa-field"
        type="text"
        value={value}
        maxLength={maxLength}
        placeholder={busy ? 'Working on it… press Esc to stop' : placeholder}
        aria-label="Ask the PM Assistant"
        spellCheck={false}
        disabled={busy}
        onChange={e => {
          onChange(e.target.value.slice(0, maxLength))
          setTyping(true)
          window.clearTimeout(timers.current.typing)
          timers.current.typing = window.setTimeout(() => setTyping(false), 300)
        }}
        onKeyDown={onKeyDown}
      />
      <button ref={sendRef} type="submit" className="pa-send" aria-label="Send" data-ready={ready ? '' : undefined} disabled={busy}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 19V5" />
          <path d="M5.5 11.5L12 5l6.5 6.5" />
        </svg>
      </button>
    </form>
  )
})
