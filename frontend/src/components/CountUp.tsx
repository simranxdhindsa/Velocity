import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { animate } from 'framer-motion'

interface CountUpProps {
  /** Number or text containing numbers (e.g. "4d 11h"); every numeric part counts up. */
  value: number | string
  /** Animation length in seconds */
  duration?: number
  className?: string
}

const NUM = /\d+(?:\.\d+)?/g

function parse(text: string) {
  const parts = text.split(NUM)
  const nums = (text.match(NUM) ?? []).map(Number)
  const decimals = (text.match(NUM) ?? []).map(n => (n.split('.')[1] ?? '').length)
  return { parts, nums, decimals }
}

function build(parts: string[], nums: number[], decimals: number[], p: number, from: number[]) {
  let out = parts[0]
  for (let i = 0; i < nums.length; i++) {
    const v = from[i] + (nums[i] - from[i]) * p
    out += (decimals[i] ? v.toFixed(decimals[i]) : String(Math.round(v))) + parts[i + 1]
  }
  return out
}

/**
 * Counts every number in `value` up from 0 whenever it scrolls or switches into view
 * (tabs stay mounted but hidden, so the count must wait until they are shown), and from
 * the previous value when it changes while visible. Writes straight to the DOM, so it
 * adds no per-frame React renders.
 */
export function CountUp({ value, duration = 2.2, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef<number[] | null>(null)
  const visible = useRef(false)
  const replay = useRef(true) // next time we're visible, count up from 0
  const stop = useRef<(() => void) | null>(null)
  const text = String(value)
  const textRef = useRef(text)
  const handled = useRef<string | null>(null) // last text acted on (effects run twice in StrictMode)
  textRef.current = text

  const run = useCallback((from: number[] | null) => {
    const el = ref.current
    if (!el) return
    stop.current?.()
    const t = textRef.current
    const { parts, nums, decimals } = parse(t)
    const start = from && from.length === nums.length ? from : nums.map(() => 0)
    prev.current = nums
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce || nums.length === 0 || start.every((f, i) => f === nums[i])) {
      el.textContent = t
      return
    }
    el.textContent = build(parts, nums, decimals, 0, start)
    const controls = animate(0, 1, {
      duration,
      ease: [0.33, 1, 0.68, 1],
      onUpdate: p => { el.textContent = build(parts, nums, decimals, p, start) },
      onComplete: () => { el.textContent = t },
    })
    stop.current = () => { controls.stop(); el.textContent = textRef.current; stop.current = null }
  }, [duration])

  // Value changed
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || handled.current === text) return
    handled.current = text
    visible.current = el.getClientRects().length > 0 // false inside a hidden (display: none) tab
    if (visible.current) {
      run(replay.current ? null : prev.current)
      replay.current = false
    } else {
      el.textContent = text // hidden: show the final value, replay when shown
      prev.current = parse(text).nums
      replay.current = true
    }
  }, [text, run])

  // Visibility changes (tab switch, scroll)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      const on = entries[entries.length - 1].isIntersecting
      visible.current = on
      if (on && replay.current) { replay.current = false; run(null) }
      if (!on) { stop.current?.(); replay.current = true }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [run])

  return <span ref={ref} className={className} />
}
