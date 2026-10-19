// Dot-wheel colour picker (ported from a Motion example): white centre, 6 pastel and 12 vivid
// dots that drift away from the cursor, a conic rim that floods with the chosen colour.
// Uses framer-motion instead of motion-plus: the pointer is tracked relative to the wheel's
// centre on each move, so scrolling the page never puts the push effect out of place.
import { animate, motion, useMotionValue, useSpring, useTransform, type MotionValue, type SpringOptions } from 'framer-motion'
import { memo, useEffect, useRef } from 'react'

const PUSH_SPRING: SpringOptions = { damping: 30, stiffness: 100 }
const PUSH_MAGNITUDE = 5
const RINGS = [1, 6, 12]

function angleFor(index: number, total: number) { return (index / total) * Math.PI * 2 }
function hueFor(angle: number) { return ((((angle * 180) / Math.PI - 270) % 360) + 360) % 360 }

/** hsl → #rrggbb so a wheel pick saves exactly like the classic picker. */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

interface Dot { ring: number; index: number; total: number; x: number; y: number; hex: string }

const DOTS: Dot[] = RINGS.flatMap((total, ring) => Array.from({ length: total }, (_, index) => {
  const angle = angleFor(index, total)
  const r = ring * 20
  const hue = hueFor(angle)
  const hex = ring === 0 ? '#ffffff' : ring === 1 ? hslToHex(hue, 60, 85) : hslToHex(hue, 90, 60)
  return { ring, index, total, x: Math.cos(angle) * r, y: Math.sin(angle) * r, hex }
})).reverse()

const RIM_STOPS = Array.from({ length: 13 }, (_, i) => `hsl(${i * 30}, 90%, 60%)`)

const WheelDot = memo(function WheelDot({ dot, px, py, active, selected, onPick }: {
  dot: Dot
  px: MotionValue<number>
  py: MotionValue<number>
  active: MotionValue<number>
  selected: boolean
  onPick: (hex: string) => void
}) {
  // Push the dot away from the cursor when it comes within 80px, only while the pointer is over the wheel
  const push = useTransform(() => {
    if (!active.get()) return { x: 0, y: 0 }
    const dx = dot.x - px.get(), dy = dot.y - py.get()
    const d = Math.hypot(dx, dy)
    if (d >= 80) return { x: 0, y: 0 }
    const m = (1 - d / 80) * PUSH_MAGNITUDE, a = Math.atan2(dy, dx)
    return { x: Math.cos(a) * m, y: Math.sin(a) * m }
  })
  const sx = useSpring(useTransform(() => push.get().x), PUSH_SPRING)
  const sy = useSpring(useTransform(() => push.get().y), PUSH_SPRING)
  const x = useTransform(() => dot.x + sx.get())
  const y = useTransform(() => dot.y + sy.get())

  return (
    <motion.button
      type="button"
      className={`cwp-dot${selected ? ' cwp-dot--on' : ''}`}
      style={{ x, y, backgroundColor: dot.hex }}
      initial="rest"
      animate={selected ? 'on' : 'rest'}
      whileHover="hover"
      whileTap={{ scale: 1.2 }}
      variants={{ rest: { scale: 1 }, on: { scale: 1.15 }, hover: { scale: 1.5, transition: { duration: 0.13 } } }}
      transition={{ scale: { type: 'spring', damping: 30, stiffness: 200 } }}
      onClick={() => onPick(dot.hex)}
      aria-label={`Pick ${dot.hex}`}
      aria-pressed={selected}
    >
      <motion.span className="cwp-dot-ring" variants={{ rest: { opacity: 0 }, on: { opacity: 0.9 }, hover: { opacity: 0.4 } }} />
    </motion.button>
  )
})

const RimGlow = memo(function RimGlow({ index, px, py, active }: {
  index: number; px: MotionValue<number>; py: MotionValue<number>; active: MotionValue<number>
}) {
  const angle = angleFor(index, 6)
  const gx = Math.cos(angle) * 30, gy = Math.sin(angle) * 30
  const hue = hueFor(angle)
  const near = useTransform(() => active.get() ? Math.max(0, 1 - Math.hypot(px.get() - gx, py.get() - gy) / 100) : 0)
  const opacity = useSpring(useTransform(near, [0, 1], [0.15, 0.35]), PUSH_SPRING)
  const scale = useSpring(useTransform(near, [0, 1], [1, 1.2]), PUSH_SPRING)
  return (
    <motion.div
      className="cwp-glow"
      style={{ x: gx, y: gy, opacity, scale, background: `radial-gradient(circle, hsla(${hue}, 90%, 60%, 1) 0%, hsla(${hue}, 90%, 60%, 0) 66%)` }}
    />
  )
})

export function ColorWheelPicker({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const active = useMotionValue(0)
  const current = value.toLowerCase()
  const picked = DOTS.some(d => d.hex === current) ? current : null

  // Rim floods with the picked colour, and returns to the rainbow when the value isn't a wheel colour
  const stops = RIM_STOPS.map(s => useMotionValue(s)) // eslint-disable-line react-hooks/rules-of-hooks
  const rimScale = useMotionValue(1)
  const rim = useTransform(() => `conic-gradient(from 0deg, ${stops.map(s => s.get()).join(', ')})`)
  useEffect(() => {
    stops.forEach((s, i) => animate(s, picked ?? RIM_STOPS[i], { duration: 0.2 }))
    animate(rimScale, picked ? 1.06 : 1, picked
      ? { type: 'spring', visualDuration: 0.2, bounce: 0.8, velocity: 2 }
      : { type: 'spring', visualDuration: 0.2, bounce: 0 })
  }, [picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    px.set(e.clientX - (r.left + r.width / 2))
    py.set(e.clientY - (r.top + r.height / 2))
    active.set(1)
  }

  return (
    <div className="cwp-wrap" role="group" aria-label={`${label} colour wheel`}>
      <motion.div className="cwp-rim" style={{ background: rim, scale: rimScale }} />
      <motion.div className="cwp-solid" animate={{ scale: picked ? 0.9 : 0.97 }} transition={{ type: 'spring', visualDuration: 0.2, bounce: 0.2 }} />
      <div ref={ref} className="cwp-field" onPointerMove={onMove} onPointerLeave={() => active.set(0)}>
        {Array.from({ length: 6 }, (_, i) => <RimGlow key={i} index={i} px={px} py={py} active={active} />)}
        {DOTS.map(d => (
          <WheelDot key={`${d.ring}-${d.index}`} dot={d} px={px} py={py} active={active} selected={d.hex === picked} onPick={onChange} />
        ))}
      </div>
    </div>
  )
}
