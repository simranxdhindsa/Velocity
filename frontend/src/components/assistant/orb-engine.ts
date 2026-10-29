// Dotted thinking orb (canvas) + a tiny track tweener, ported from the 21st.dev
// "ai thinking orb and input" component (@anark17r). Pure TS, no React.
// Changes from the original: radius is a parameter (it lives inside a chat column, not
// centre stage), and the dot / "done" colours come from the theme instead of fixed
// white and green, so the orb reads in light mode too.

export type Ease = (t: number) => number
const TAU = Math.PI * 2
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t
  const sy = (t: number) => ((ay * t + by) * t + cy) * t
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  const solve = (x: number) => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x
      if (Math.abs(e) < 1e-6) return t
      const d = dx(t)
      if (Math.abs(d) < 1e-6) break
      t -= e / d
    }
    let lo = 0, hi = 1
    t = x
    for (let i = 0; i < 40; i++) {
      const e = sx(t)
      if (Math.abs(e - x) < 1e-6) break
      if (x > e) lo = t; else hi = t
      t = (hi - lo) / 2 + lo
    }
    return t
  }
  return x => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)))
}

export const E = {
  out: cubicBezier(0.22, 1, 0.36, 1),
  io: cubicBezier(0.65, 0, 0.35, 1),
  in: cubicBezier(0.4, 0, 1, 1),
  vortex: cubicBezier(0.6, 0, 0.2, 1),
  spring: cubicBezier(0.34, 1.4, 0.64, 1),
}

/* ── tracks: "animate channel ch from→to between t0..t1 ms" ── */
export interface Track { ch: string; from: number; to: number; t0: number; t1: number; ease: Ease }
export const T = (ch: string, from: number, to: number, t0: number, t1: number, ease: Ease = E.io): Track => ({ ch, from, to, t0, t1, ease })

/** Plays tracks on rAF, calling set(ch, v) each frame. Resolves at the end or on abort. */
export function play(tracks: Track[], set: (ch: string, v: number) => void, sig: AbortSignal): Promise<void> {
  return new Promise(res => {
    if (sig.aborted) return res()
    const end = tracks.reduce((m, k) => Math.max(m, k.t1), 0)
    const done = new Set<Track>()
    let raf = 0, t = 0, last = performance.now()
    const onAbort = () => { cancelAnimationFrame(raf); res() }
    const step = (now: number) => {
      t += Math.max(0, Math.min(100, now - last))
      last = now
      for (const k of tracks) {
        if (done.has(k) || t < k.t0) continue
        const p = Math.min(1, (t - k.t0) / Math.max(1, k.t1 - k.t0))
        set(k.ch, k.from + (k.to - k.from) * k.ease(p))
        if (p === 1) done.add(k)
      }
      if (t >= end) { sig.removeEventListener('abort', onAbort); res() } else raf = requestAnimationFrame(step)
    }
    sig.addEventListener('abort', onAbort, { once: true })
    raf = requestAnimationFrame(step)
  })
}

export function sleep(ms: number, sig: AbortSignal) {
  return new Promise<void>(res => {
    if (sig.aborted) return res()
    const id = window.setTimeout(() => { sig.removeEventListener('abort', onAbort); res() }, Math.max(0, ms))
    const onAbort = () => { window.clearTimeout(id); res() }
    sig.addEventListener('abort', onAbort, { once: true })
  })
}

/* ── sphere of dots (16 latitude rings) ── */
const RINGS = 16
function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const DOTS = (() => {
  const rand = mulberry32(7)
  const out: { x: number; y: number; z: number; u: number; seed: number }[] = []
  for (let k = 0; k < RINGS; k++) {
    const y = 1 - ((k + 0.5) / RINGS) * 2
    const r = Math.sqrt(1 - y * y)
    const m = Math.max(4, Math.round(30 * r))
    for (let j = 0; j < m; j++) {
      const a = (j / m) * TAU + k * 0.35
      out.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, u: (1 - y) / 2, seed: rand() * TAU })
    }
  }
  return out
})()
const N = DOTS.length
const DX = Float32Array.from(DOTS, d => d.x)
const DY = Float32Array.from(DOTS, d => d.y)
const DZ = Float32Array.from(DOTS, d => d.z)
const DU = Float32Array.from(DOTS, d => d.u)
const DS = Float32Array.from(DOTS, d => d.seed)

export type RGB = [number, number, number]
const G_STEPS = 24, A_STEPS = 48

/** Palette from the base dot colour to the "done" colour, at 49 alpha steps each. */
function buildColors(base: RGB, done: RGB): string[] {
  const out: string[] = []
  for (let gi = 0; gi <= G_STEPS; gi++) {
    const g = gi / G_STEPS
    const r = Math.round(lerp(base[0], done[0], g)), gg = Math.round(lerp(base[1], done[1], g)), b = Math.round(lerp(base[2], done[2], g))
    for (let ai = 0; ai <= A_STEPS; ai++) out.push(`rgba(${r},${gg},${b},${(ai / A_STEPS).toFixed(3)})`)
  }
  return out
}

export interface OrbParams {
  k: number; alpha: number; spin: number; rot: number; sweep: number; pop: number
  vortex: number; gain: number; floor: number; rad: number; prog: number
}

export function createOrb(canvas: HTMLCanvasElement, radius: number, base: RGB, done: RGB, isReduced: () => boolean) {
  const size = Math.ceil(radius * 3.34)
  const P: OrbParams = { k: 0, alpha: 0, spin: 0, rot: 0, sweep: 0, pop: 1, vortex: 0, gain: 1, floor: 0, rad: 0, prog: 0 }
  const ctx = canvas.getContext('2d')
  const colors = buildColors(base, done)
  const lit = new Float32Array(N)
  const SX = new Float32Array(N), SY = new Float32Array(N), SR = new Float32Array(N), SD = new Float32Array(N)
  const SC = new Int16Array(N)
  const pw = [1, 0, 0, 0]
  // Dot size scales with the orb; the original was tuned for radius 66
  const dotK = Math.max(0.55, radius / 66)
  let time = isReduced() ? 1.2 : 0, raf = 0, last = 0, dead = false

  if (!ctx) return { P, size, ensure() {}, destroy() {} }
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(size * dpr)
  canvas.height = Math.round(size * dpr)
  canvas.style.width = `${size}px`
  canvas.style.height = `${size}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const S = 0.6, CP = Math.cos(0.35), SP = Math.sin(0.35), C0 = size / 2

  const draw = (dt: number) => {
    ctx.clearRect(0, 0, size, size)
    time += dt
    P.rot += P.spin * dt
    const yaw = P.rot + P.vortex, cyw = Math.cos(yaw), syw = Math.sin(yaw)
    const stepW = dt / 0.35
    for (let q = 0; q < 4; q++) {
      const d = (q === P.prog ? 1 : 0) - pw[q]
      pw[q] += Math.abs(d) <= stepW ? d : d > 0 ? stepW : -stepW
    }
    const decay = Math.exp(-dt / 0.5)
    const h0 = (time * 300) % N, h3 = (time * 480) % N
    const a1 = time * 0.8, b1 = Math.sin(time * 0.5) * 0.9
    const f1x = Math.cos(b1) * Math.cos(a1), f1y = Math.sin(b1), f1z = Math.cos(b1) * Math.sin(a1)
    const a2 = time * 0.55 + 2.1, b2 = Math.cos(time * 0.42) * 0.9
    const f2x = Math.cos(b2) * Math.cos(a2), f2y = Math.sin(b2), f2z = Math.cos(b2) * Math.sin(a2)
    const lat = Math.sin(time * 2.2)
    const swirlK = P.vortex * 1.5

    for (let n = 0; n < N; n++) {
      const dx = DX[n], dy = DY[n], dz = DZ[n], u = DU[n]
      // Four "light programs", one per thinking label: a chasing comet, two roaming
      // spotlights, a scanning latitude band, a fast comet
      let pulse = 0
      if (pw[0] > 0.001) {
        let dd = Math.abs(n - h0); if (dd > N - dd) dd = N - dd
        const v = Math.max(0, 1 - dd / 16); pulse = Math.max(pulse, v * v * pw[0])
      }
      if (pw[1] > 0.001) {
        const v1 = Math.max(0, (dx * f1x + dy * f1y + dz * f1z - 0.72) / 0.28)
        const v2 = Math.max(0, (dx * f2x + dy * f2y + dz * f2z - 0.72) / 0.28)
        const v = Math.max(v1, v2); pulse = Math.max(pulse, v * v * pw[1])
      }
      if (pw[2] > 0.001) {
        const e = dy - lat
        const v = Math.max(0, 1 - (e * e) / 0.02); pulse = Math.max(pulse, v * v * pw[2])
      }
      if (pw[3] > 0.001) {
        let dd = Math.abs(n - h3); if (dd > N - dd) dd = N - dd
        const v = Math.max(0, 1 - dd / 22); pulse = Math.max(pulse, v * v * pw[3])
      }
      const l = Math.max(lit[n] * decay, pulse * P.gain)
      lit[n] = l

      // Appear top-first, collapse bottom-first
      const ki = clamp01(P.k * (1 + S) - S * u)
      if (ki <= 0.001) { SC[n] = -1; continue }
      const eo = E.out(ki), kk = eo * P.pop

      const x1 = dx * cyw + dz * syw, z1 = -dx * syw + dz * cyw
      const y2 = dy * CP - z1 * SP, z2 = dy * SP + z1 * CP
      const f = 2.8 / (2.8 - z2), depth = (z2 + 1) / 2
      let ox = x1 * radius * kk * f, oy = -y2 * radius * kk * f
      if (swirlK > 0.001) {
        const sw = (1 - ki) * swirlK, cc = Math.cos(sw), ss = Math.sin(sw)
        const tx = ox * cc - oy * ss
        oy = ox * ss + oy * cc
        ox = tx
      }

      const g = clamp01((P.sweep * 1.4 - u) / 0.4)
      let a = 0.1 + 0.035 * Math.sin(DS[n] + time * 1.6) * (1 - g) + 0.32 * depth * depth + 0.75 * l * (1 - g) + g * (0.55 + 0.4 * depth) + 2 * g * (1 - g)
      a = Math.max(a, P.floor * (0.7 + 0.3 * depth))
      if (a > 1) a = 1
      a *= eo * P.alpha

      SX[n] = C0 + ox
      SY[n] = C0 + oy
      SD[n] = depth
      SR[n] = (1.15 * (0.45 + 0.75 * depth) * f + 0.9 * l + g * 0.25) * (1 + P.rad) * (0.4 + 0.6 * eo) * dotK
      const ai = Math.round(a * A_STEPS), gi = Math.round(g * G_STEPS)
      SC[n] = ai <= 0 ? -1 : gi * (A_STEPS + 1) + ai
    }

    // Back half first, then the front half on top
    for (let pass = 0; pass < 2; pass++) {
      for (let n = 0; n < N; n++) {
        const c = SC[n]
        if (c < 0 || (SD[n] >= 0.5) !== (pass === 1)) continue
        ctx.fillStyle = colors[c]
        ctx.beginPath()
        ctx.arc(SX[n], SY[n], SR[n], 0, TAU)
        ctx.fill()
      }
    }
  }

  const frame = (now: number) => {
    raf = 0
    if (dead) return
    const dt = isReduced() ? 0 : Math.max(0, Math.min(0.05, (now - last) / 1000))
    last = now
    draw(dt)
    if (P.alpha > 0.002) raf = requestAnimationFrame(frame)
    else ctx.clearRect(0, 0, size, size)
  }

  return {
    P,
    size,
    /** Start the draw loop (it stops itself once alpha reaches 0). */
    ensure() {
      if (raf || dead || P.alpha <= 0.002) return
      last = performance.now()
      raf = requestAnimationFrame(frame)
    },
    destroy() {
      dead = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    },
  }
}

/** Resolves any CSS colour (including var(--token)) to RGB using a probe element. */
export function resolveColor(host: HTMLElement, css: string, fallback: RGB): RGB {
  const probe = document.createElement('span')
  probe.style.color = css
  probe.style.display = 'none'
  host.appendChild(probe)
  const m = getComputedStyle(probe).color.match(/(\d+(?:\.\d+)?)/g)
  probe.remove()
  return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : fallback
}
