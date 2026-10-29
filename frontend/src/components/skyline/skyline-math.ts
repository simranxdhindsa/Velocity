// Contribution Skyline: pure date, grid, stats, camera and colour maths.
// Adapted from @kedhareswer/contribution-skyline (21st.dev).

export type ContributionDay = { date: string; count: number }
export type Cell = { date: string; count: number; level: number; week: number; day: number }
export type Streak = { days: number; start: string | null; end: string | null }
export type ContributionStats = {
  total: number
  first: string | null
  last: string | null
  busiest: { count: number; date: string | null }
  longest: Streak
  current: Streak
}
export type RGB = [number, number, number]

export const DAY_MS = 86400000

export const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const easeInOutCubic = (x: number): number => {
  const t = clamp01(x)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
export const easeOutCubic = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3)
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** UTC midnight → "YYYY-MM-DD". */
export const toKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * Any date-ish value → UTC midnight of its calendar day. "YYYY-MM-DD" strings
 * are read literally (no timezone drift), Date objects by their local day,
 * numbers as UTC timestamps.
 */
export const dayMs = (v: string | number | Date): number => {
  if (typeof v === "number") return Math.floor(v / DAY_MS) * DAY_MS
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3])
    v = new Date(v)
  }
  return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())
}

/** mulberry32 — small, fast, deterministic. */

/**
 * The grid: columns are weeks, rows are weekdays (row 0 = `weekStart`). It
 * ends on `endMs` and starts on the week containing the day one year earlier.
 * Levels 1–4 split the non-zero days by their share of a busy day — the 95th
 * percentile, so one freak day can't wash every other day out to level 1.
 */
export const buildGrid = (data: ContributionDay[], endMs: number, weekStart = 0) => {
  const counts = new Map<string, number>()
  for (const d of data) {
    if (!d || typeof d.date !== "string") continue
    const ms = dayMs(d.date)
    const c = Number(d.count)
    if (!Number.isFinite(ms) || !(c > 0) || !Number.isFinite(c)) continue
    const k = toKey(ms)
    counts.set(k, (counts.get(k) ?? 0) + c)
  }
  let start = endMs - 364 * DAY_MS
  start -= ((new Date(start).getUTCDay() - weekStart + 7) % 7) * DAY_MS
  const cells: Cell[] = []
  for (let ms = start, i = 0; ms <= endMs; ms += DAY_MS, i++) {
    const date = toKey(ms)
    cells.push({ date, count: counts.get(date) ?? 0, level: 0, week: Math.floor(i / 7), day: i % 7 })
  }
  const nz = cells.map((c) => c.count).filter((c) => c > 0).sort((a, b) => a - b)
  const busy = nz.length ? nz[Math.floor(0.95 * (nz.length - 1))] : 0
  for (const c of cells) c.level = levelOf(c.count, busy)
  return { cells, weeks: cells.length ? cells[cells.length - 1].week + 1 : 0, max: nz.length ? nz[nz.length - 1] : 0 }
}

/** 0 for an empty day, else 1–4 by quarters of `busy`. Anything at or past `busy` is 4. */
export const levelOf = (count: number, busy: number): number =>
  count <= 0 ? 0 : busy <= 0 ? 4 : 1 + Math.min(3, Math.floor((count / busy) * 4))

/** Total, busiest day, longest run, and the run that reaches today (or yesterday — today isn't over). */
export const computeStats = (cells: Cell[]): ContributionStats => {
  let total = 0
  let best = 0
  let bestDate: string | null = null
  let run = 0
  let runStart: string | null = null
  let longest: Streak = { days: 0, start: null, end: null }
  for (const c of cells) {
    total += c.count
    if (c.count > best) {
      best = c.count
      bestDate = c.date
    }
    if (c.count > 0) {
      if (run === 0) runStart = c.date
      run++
      if (run > longest.days) longest = { days: run, start: runStart, end: c.date }
    } else run = 0
  }
  let j = cells.length - 1
  if (j >= 0 && cells[j].count === 0) j--
  const endAt = j
  while (j >= 0 && cells[j].count > 0) j--
  const days = endAt - j
  const current: Streak = days > 0 ? { days, start: cells[j + 1].date, end: cells[endAt].date } : { days: 0, start: null, end: null }
  return {
    total,
    first: cells.length ? cells[0].date : null,
    last: cells.length ? cells[cells.length - 1].date : null,
    busiest: { count: best, date: bestDate },
    longest,
    current,
  }
}

/** A label on each week whose first day starts a new month; a cramped first label is dropped. */
export const monthLabels = (cells: Cell[], weeks: number, locale = "en-US") => {
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" })
  const out: { week: number; label: string }[] = []
  let prev = -1
  for (let w = 0; w < weeks; w++) {
    const c = cells[w * 7]
    if (!c) break
    const m = +c.date.slice(5, 7)
    if (m !== prev) out.push({ week: w, label: fmt.format(dayMs(c.date)) })
    prev = m
  }
  if (out.length > 1 && out[1].week - out[0].week < 3) out.shift()
  return out
}

/** Box height in grid units. Empty days are thin slabs; the busiest day is ~7.6 cells tall. */
export const barHeight = (count: number, max: number, scale = 1): number =>
  count > 0 && max > 0 ? 0.4 + Math.pow(count / max, 0.85) * 7.2 * scale : 0.2

/** Share of the morph each bar spends waiting — the wave sweeps oldest week → newest. */
export const WAVE = 0.42

/** 0 → 1 as a bar rises during the morph. Every bar is flat at t=0 and fully up at t=1. */
export const riseAt = (t: number, week: number, weeks: number, day: number): number => {
  const d = (weeks > 1 ? week / (weeks - 1) : 0) * 0.36 + (day / 6) * 0.06
  return easeOutCubic((t - d) / (1 - WAVE))
}

export const YAW_3D = Math.PI / 4
export const ELEV_3D = (34 * Math.PI) / 180
export const YAW_RANGE: [number, number] = [(8 * Math.PI) / 180, (82 * Math.PI) / 180]
export const ELEV_RANGE: [number, number] = [(18 * Math.PI) / 180, (62 * Math.PI) / 180]

export type Cam = { cs: number; sn: number; se: number; ce: number }

/**
 * e=0 looks straight down (yaw 0, elevation 90°): x across, y down, height
 * invisible — a plain heat map. e=1 is the isometric corner view. Orbit
 * offsets only apply in proportion to e, so the flat view never tilts.
 */
export const camera = (e: number, dYaw = 0, dElev = 0): Cam => {
  const yaw = Math.min(YAW_RANGE[1], Math.max(0, lerp(0, YAW_3D + dYaw, e)))
  const elev = lerp(Math.PI / 2, Math.min(ELEV_RANGE[1], Math.max(ELEV_RANGE[0], ELEV_3D + dElev)), e)
  return { cs: Math.cos(yaw), sn: Math.sin(yaw), se: Math.sin(elev), ce: Math.cos(elev) }
}

/** World (x = week, y = weekday, z = up) → screen, before scale/offset. */
export const project = (c: Cam, x: number, y: number, z: number): [number, number] => [
  x * c.cs - y * c.sn,
  (x * c.sn + y * c.cs) * c.se - z * c.ce,
]

/** Painter's depth for yaw in [0°, 90°]: larger is nearer the viewer, so draw ascending. */
export const depthOf = (c: Cam, x: number, y: number): number => x * c.sn + y * c.cs

export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const luminance = (c: RGB): number => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255


/** Accent-tinted levels, lightest → heaviest. Re-resolved whenever the theme or accent changes. */
export const ACCENT_PALETTE = [
  'color-mix(in srgb, var(--color-primary) 28%, var(--bg-surface))',
  'color-mix(in srgb, var(--color-primary) 52%, var(--bg-surface))',
  'color-mix(in srgb, var(--color-primary) 76%, var(--bg-surface))',
  'var(--color-primary)',
]

/** Four colours, lightest activity → heaviest. Any CSS colour, including var() and color-mix(). */
export const resolvePalette = (p: string[]): string[] => [0, 1, 2, 3].map((i) => p[i] ?? p[p.length - 1] ?? 'currentColor')

// ── Canvas helpers ──
export const FG_FALLBACK: RGB = [23, 23, 23]
export const BG_FALLBACK: RGB = [255, 255, 255]

// Any CSS colour → sRGB, by letting the browser paint it. Handles oklch, color-mix, names…
let probe: CanvasRenderingContext2D | null = null
export const toRGB = (color: string, fallback: RGB | null): RGB | null => {
  if (!probe) {
    const c = document.createElement("canvas")
    c.width = c.height = 1
    probe = c.getContext("2d", { willReadFrequently: true })
  }
  if (!probe) return fallback
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = "rgba(0,0,0,0)"
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const d = probe.getImageData(0, 0, 1, 1).data
  if (d[3] < 8) return fallback
  return [d[0], d[1], d[2]]
}

export const rgbString = (r: number, g: number, b: number) => "rgb(" + Math.round(r) + "," + Math.round(g) + "," + Math.round(b) + ")"

export const pointInQuad = (p: Float32Array, o: number, x: number, y: number): boolean => {
  let sign = 0
  for (let k = 0; k < 4; k++) {
    const ax = p[o + k * 2]
    const ay = p[o + k * 2 + 1]
    const bx = p[o + ((k + 1) % 4) * 2]
    const by = p[o + ((k + 1) % 4) * 2 + 1]
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    if (Math.abs(cross) < 1e-9) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return sign !== 0
}

export const quadPath = (ctx: CanvasRenderingContext2D, p: Float32Array, o: number, r: number) => {
  if (r < 0.3) {
    ctx.moveTo(p[o], p[o + 1])
    ctx.lineTo(p[o + 2], p[o + 3])
    ctx.lineTo(p[o + 4], p[o + 5])
    ctx.lineTo(p[o + 6], p[o + 7])
    ctx.closePath()
    return
  }
  ctx.moveTo((p[o + 6] + p[o]) / 2, (p[o + 7] + p[o + 1]) / 2)
  for (let k = 0; k < 4; k++) {
    const b = (k + 1) % 4
    ctx.arcTo(p[o + k * 2], p[o + k * 2 + 1], p[o + b * 2], p[o + b * 2 + 1], r)
  }
  ctx.closePath()
}
