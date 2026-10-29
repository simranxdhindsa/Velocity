// PM Assistant thinking orb. Three modes:
//  idle   faint, slowly turning sphere for the empty state
//  think  assembles (optionally after a ball flies in from the input pill), lights up in
//         four patterns while the labels rotate
//  done   green sweep + "Done", collapses into a green ball, then calls onFinished so the
//         answer card can unfold from the same spot
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createOrb, play, sleep, resolveColor, T, E, type Track } from './orb-engine'

const THINK_LABELS = ['Thinking', 'Searching tickets', 'Analyzing', 'Composing']

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const ASSEMBLE: Track[] = [
  T('k', 0, 1, 0, 800, E.out),
  T('alpha', 0, 1, 0, 800, E.out),
  T('spin', 0, 0.9, 0, 800, E.out),
  T('pop', 1, 1.05, 0, 420, E.out),
  T('pop', 1.05, 1, 420, 800, E.io),
]
const RESOLVE: Track[] = [
  T('sweep', 0, 1, 0, 650, E.io),
  T('spin', 0.9, 0.3, 0, 650, E.out),
  T('gain', 1, 0, 0, 650, E.out),
  T('floor', 0, 0.95, 350, 800, E.out),
  T('rad', 0, 0.15, 350, 800, E.out),
]
const CONDENSE: Track[] = [
  T('pop', 1, 1.06, 0, 120, E.out),
  T('k', 1, 0, 120, 600, E.vortex),
  T('vortex', 0, 1.6, 120, 600, E.vortex),
  T('green', 0, 1, 240, 640, E.spring),
  T('alpha', 1, 0, 460, 700, E.out),
]

/** Flies a small ball from `from` (the pill's send button) to the orb, with a short comet trail. */
function flyIn(from: DOMRect, to: DOMRect): Promise<void> {
  const sx = from.left + from.width / 2, sy = from.top + from.height / 2
  const ex = to.left + to.width / 2, ey = to.top + to.height / 2
  const dir = Math.random() < 0.5 ? -1 : 1
  const cx = (sx + ex) / 2 + dir * Math.min(140, Math.abs(sy - ey) * 0.35), cy = (sy + ey) / 2 + 30
  const frames: Keyframe[] = Array.from({ length: 13 }, (_, i) => {
    const t = i / 12
    const x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * ex
    const y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * ey
    const s = 0.45 + 0.75 * Math.sin(t * Math.PI * 0.62)
    return { transform: `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${s.toFixed(3)})`, offset: t }
  })
  const balls = [0, 1, 2, 3].map(i => {
    const el = document.createElement('div')
    el.className = i === 0 ? 'pa-flyball' : 'pa-flyball pa-flyball--ghost'
    el.style.opacity = i === 0 ? '1' : String(0.3 - i * 0.07)
    document.body.appendChild(el)
    return el.animate(frames, { duration: 760, delay: i * 45, easing: 'cubic-bezier(0.5, 0, 0.1, 1)', fill: 'forwards' })
  })
  return balls[0].finished.then(() => undefined, () => undefined).finally(() => {
    // Ghosts finish a few frames later; remove everything once the last one lands
    window.setTimeout(() => balls.forEach(a => (a.effect as KeyframeEffect).target?.remove()), 160)
  })
}

export const ThinkingOrb = memo(function ThinkingOrb({ mode, radius = 40, launchFrom, onFinished }: {
  mode: 'idle' | 'think' | 'done'
  radius?: number
  /** Where the flying ball starts (the pill's send button). Only read on mount. */
  launchFrom?: DOMRect | null
  onFinished?: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const greenRef = useRef<HTMLDivElement>(null)
  const orbRef = useRef<ReturnType<typeof createOrb> | null>(null)
  const setRef = useRef<((ch: string, v: number) => void) | null>(null)
  const lifeRef = useRef<AbortController | null>(null)
  const assembled = useRef<Promise<void>>(Promise.resolve())
  const finishedRef = useRef(onFinished)
  useEffect(() => { finishedRef.current = onFinished }, [onFinished])
  const [label, setLabel] = useState({ cur: THINK_LABELS[0], prev: null as string | null, n: 0 })
  const [visible, setVisible] = useState(() => mode === 'idle' || reducedMotion())
  const [doneLabel, setDoneLabel] = useState(false)

  // Build the orb once, coloured from the theme
  useLayoutEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current
    if (!wrap || !canvas) return
    const life = new AbortController()
    lifeRef.current = life
    const base = resolveColor(wrap, 'var(--text-primary)', [235, 235, 235])
    const done = resolveColor(wrap, 'var(--color-success)', [52, 211, 153])
    const orb = createOrb(canvas, radius, base, done, reducedMotion)
    orbRef.current = orb
    const set = (ch: string, v: number) => {
      if (ch === 'green') { greenRef.current?.style.setProperty('--g', String(v)); return }
      ;(orb.P as unknown as Record<string, number>)[ch] = v
      if (ch === 'alpha') orb.ensure()
    }
    setRef.current = set

    if (mode === 'idle') {
      Object.assign(orb.P, { k: 1, alpha: 0.5, spin: 0.22, gain: 0.45 })
      orb.ensure()
    } else if (reducedMotion()) {
      Object.assign(orb.P, { k: 1, alpha: 1 })
      orb.ensure()
    } else {
      assembled.current = (async () => {
        // Wait a frame: StrictMode's double mount aborts the first run before anything flies
        await new Promise(r => requestAnimationFrame(r))
        if (life.signal.aborted) return
        const target = wrap.getBoundingClientRect()
        if (launchFrom) await flyIn(launchFrom, target)
        if (life.signal.aborted) return
        setVisible(true)
        await play(ASSEMBLE, set, life.signal)
      })()
    }
    return () => { life.abort(); orb.destroy() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Rotate the thinking labels; each label switches the orb's light pattern
  useEffect(() => {
    if (mode !== 'think') return
    let i = 0
    const id = window.setInterval(() => {
      i = (i + 1) % THINK_LABELS.length
      if (orbRef.current) orbRef.current.P.prog = i
      setLabel(l => ({ cur: THINK_LABELS[i], prev: l.cur, n: l.n + 1 }))
    }, 1150)
    return () => window.clearInterval(id)
  }, [mode])

  // Done: green sweep, collapse into a green ball, then hand over to the answer card
  useEffect(() => {
    if (mode !== 'done') return
    const life = lifeRef.current, set = setRef.current
    if (!life || !set) { finishedRef.current?.(); return }
    let cancelled = false
    ;(async () => {
      await assembled.current
      setDoneLabel(true)
      if (!reducedMotion()) {
        await play(RESOLVE, set, life.signal)
        await play(CONDENSE, set, life.signal)
        await sleep(60, life.signal)
      }
      if (!cancelled) finishedRef.current?.()
    })()
    return () => { cancelled = true }
  }, [mode])

  const size = Math.ceil(radius * 3.34)
  return (
    <div className={`pa-orb pa-orb--${mode}${visible ? ' pa-orb--on' : ''}`} ref={wrapRef} style={{ width: size }}>
      <div className="pa-orb-stage" style={{ width: size, height: size }}>
        <div className="pa-orb-halo" aria-hidden="true" />
        <canvas ref={canvasRef} className="pa-orb-canvas" aria-hidden="true" />
        <div ref={greenRef} className="pa-orb-green" aria-hidden="true" style={{ width: radius * 1.5, height: radius * 1.5 }} />
      </div>
      {mode !== 'idle' && (
        <div className="pa-orb-status" role="status" aria-live="polite">
          {doneLabel ? (
            <span key="done" className="pa-lab pa-lab--in pa-lab-done">Done</span>
          ) : (
            <>
              {label.prev !== null && <span key={`p${label.n}`} className="pa-lab pa-lab--out">{label.prev}<Dots /></span>}
              <span key={`c${label.n}`} className="pa-lab pa-lab--in">{label.cur}<Dots /></span>
            </>
          )}
        </div>
      )}
    </div>
  )
})

function Dots() {
  return <span className="pa-dots" aria-hidden="true"><i /><i /><i /></span>
}
