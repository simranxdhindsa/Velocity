import { useLayoutEffect, useRef } from 'react'
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
 * Counts every number in `value` up from 0 on first render, and from the previous value
 * when it changes. Writes straight to the DOM, so it adds no per-frame React renders.
 */
export function CountUp({ value, duration = 1.1, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef<number[] | null>(null)
  const text = String(value)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { parts, nums, decimals } = parse(text)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const from = prev.current && prev.current.length === nums.length ? prev.current : nums.map(() => 0)
    prev.current = nums
    if (reduce || nums.length === 0 || from.every((f, i) => f === nums[i])) {
      el.textContent = text
      return
    }
    el.textContent = build(parts, nums, decimals, 0, from)
    const controls = animate(0, 1, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: p => { el.textContent = build(parts, nums, decimals, p, from) },
      onComplete: () => { el.textContent = text },
    })
    return () => { controls.stop(); el.textContent = text }
  }, [text, duration])

  return <span ref={ref} className={className} />
}
