// Contribution Skyline canvas engine: draws the heat map / 3D skyline, runs the
// morph, orbit, hover and keyboard handling. Plain DOM + canvas, no React.
// Adapted from @kedhareswer/contribution-skyline (21st.dev).
import {
  type Cam, type RGB, type ContributionDay, type Cell, ELEV_3D, ELEV_RANGE, YAW_3D, YAW_RANGE,
  BG_FALLBACK, FG_FALLBACK, barHeight, camera, dayMs, easeInOutCubic, lerp, luminance, mixRGB, pointInQuad, project,
  quadPath, resolvePalette, rgbString, riseAt, smoothstep, toRGB,
} from './skyline-math'

export type SkylineModel = { cells: Cell[]; weeks: number; max: number; months: { week: number; label: string }[] }

export type SkylineTheme = { dark: boolean; swatches: string[]; accent: string }

export interface SkylineConfig {
  model: SkylineModel
  duration: number
  heightScale: number
  orbit: boolean
  palette: string[]
  legendLevel: number
  onCellClick?: (day: ContributionDay) => void
  target: number
  setActive: (i: number) => void
  setWidth: (w: number) => void
  setTheme: (fn: (prev: SkylineTheme) => SkylineTheme) => void
  setAnnounce: (s: string) => void
  describe: (i: number) => string
}

export interface SkylineEngine {
  kick: () => void
  load: () => void
  retheme: () => void
  tipWidth: (w: number) => void
  destroy: () => void
}

// Resolve var()/color-mix() through the DOM, then hand the computed colour to the canvas probe.
const resolveCss = (root: HTMLElement, color: string): string => {
  if (!color.includes('var(') && !color.includes('color-mix(')) return color
  const el = document.createElement('span')
  el.style.color = color
  el.style.display = 'none'
  root.appendChild(el)
  const out = getComputedStyle(el).color
  el.remove()
  return out || color
}

export function createSkylineEngine(
  els: { root: HTMLElement; stage: HTMLDivElement; canvas: HTMLCanvasElement; tip: HTMLDivElement },
  cfg: { current: SkylineConfig },
  locale: string,
): SkylineEngine | null {
  const { root, stage, canvas, tip } = els
  const ctx = canvas.getContext("2d")
  if (!ctx) return null

  const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)")
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)")
  let reduced = reduceMq.matches

  // morph: t is linear time 0 (2D) → 1 (3D); the camera eases it, the bars wave it
  let t = 0
  let target = 0
  let entered = false
  // orbit offsets, eased toward their goals
  let yaw = 0
  let elev = 0
  let yawGoal = 0
  let elevGoal = 0
  // layout
  let W = 0
  let H2 = 0
  let H3 = 0
  let Hmax = 0
  let lastH = -1
  let dpr = 1
  let gutter = 30
  let labelW = 30
  let font = "10px sans-serif"
  // colours: [empty, l1, l2, l3, l4] × rgb, eased toward the goal
  const col = new Float32Array(15)
  const colGoal = new Float32Array(15)
  let colReady = false
  let fg: RGB = FG_FALLBACK
  let bg: RGB = BG_FALLBACK
  let isDark = false
  // cells
  let n = 0
  let weeks = 0
  let wk = new Float32Array(0)
  let dy = new Float32Array(0)
  let lv = new Uint8Array(0)
  let hgt = new Float32Array(0)
  let zs = new Float32Array(0)
  let hover = new Float32Array(0)
  let dim = new Float32Array(0)
  let polys = new Float32Array(0)
  let faces = new Uint8Array(0)
  let order: number[] = []
  let months: { week: number; label: string }[] = []
  let weekdayRows: { day: number; label: string }[] = []
  // interaction
  let hovered = -1
  let pinned = -1
  let activeIdx = -1
  let tipW = 0
  let raf = 0
  let last = 0

  const load = () => {
    const m = cfg.current.model
    n = m.cells.length
    weeks = m.weeks
    if (wk.length !== n) {
      wk = new Float32Array(n)
      dy = new Float32Array(n)
      lv = new Uint8Array(n)
      hgt = new Float32Array(n)
      zs = new Float32Array(n)
      hover = new Float32Array(n)
      dim = new Float32Array(n)
      polys = new Float32Array(n * 24)
      faces = new Uint8Array(n)
      order = Array.from({ length: n }, (_, i) => i)
    }
    for (let i = 0; i < n; i++) {
      const c = m.cells[i]
      wk[i] = c.week
      dy[i] = c.day
      lv[i] = c.level
      hgt[i] = barHeight(c.count, m.max, cfg.current.heightScale)
    }
    months = m.months
    const wf = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
    weekdayRows = []
    for (let d = 0; d < 7 && d < n; d++) {
      const dow = new Date(dayMs(m.cells[d].date)).getUTCDay()
      if (dow === 1 || dow === 3 || dow === 5) weekdayRows.push({ day: d, label: wf.format(dayMs(m.cells[d].date)) })
    }
    if (hovered >= n) hovered = -1
    if (pinned >= n) pinned = -1
  }

  const retheme = () => {
    const cs = getComputedStyle(root)
    fg = toRGB(cs.color, FG_FALLBACK) ?? FG_FALLBACK
    const b = toRGB(cs.backgroundColor, null)
    bg = b ?? (luminance(fg) > 0.5 ? [10, 10, 10] : BG_FALLBACK)
    isDark = luminance(bg) < 0.45
    font = "400 10px " + (cs.fontFamily || "sans-serif")
    const pal = resolvePalette(cfg.current.palette).map((c) => resolveCss(root, c))
    const empty = mixRGB(bg, fg, isDark ? 0.11 : 0.075)
    const all: RGB[] = [empty, ...pal.map((c) => toRGB(c, FG_FALLBACK) ?? FG_FALLBACK)]
    for (let k = 0; k < 5; k++) for (let ch = 0; ch < 3; ch++) colGoal[k * 3 + ch] = all[k][ch]
    if (!colReady || reduced) {
      col.set(colGoal)
      colReady = true
    }
    ctx.font = font
    labelW = Math.ceil(Math.max(20, ...weekdayRows.map((r) => ctx.measureText(r.label).width))) + 8
    const sw = all.map((c) => rgbString(c[0], c[1], c[2]))
    cfg.current.setTheme((prev) =>
      prev.dark === isDark && prev.swatches.join() === sw.join() ? prev : { dark: isDark, swatches: sw, accent: sw[4] },
    )
    kick()
  }

  // Projected extent of the scene for camera e, with each bar at zOf(i).
  const extent = (cam: Cam, e: number, full: boolean) => {
    const w = lerp(0.78, 0.9, e)
    const off = (1 - w) / 2
    let minx = Infinity
    let maxx = -Infinity
    let miny = Infinity
    let maxy = -Infinity
    const add = (x: number, y: number, z: number) => {
      const p = project(cam, x, y, z)
      if (p[0] < minx) minx = p[0]
      if (p[0] > maxx) maxx = p[0]
      if (p[1] < miny) miny = p[1]
      if (p[1] > maxy) maxy = p[1]
    }
    for (let i = 0; i < n; i++) {
      const x0 = wk[i] + off
      const y0 = dy[i] + off
      const z = full ? hgt[i] * e : zs[i]
      add(x0, y0, z)
      add(x0 + w, y0, z)
      add(x0, y0 + w, z)
      add(x0 + w, y0 + w, 0)
      add(x0, y0 + w, 0)
      add(x0 + w, y0, 0)
    }
    // room for the month labels that run along the front edge in 3D
    add(0, 7 + 1.5 * e, 0)
    add(weeks, 7 + 1.5 * e, 0)
    return { minx, maxx, miny, maxy }
  }

  const relayout = () => {
    const w = Math.round(stage.clientWidth)
    if (!w || !n) return
    W = w
    // Narrow cards give the weekday names' column to the grid instead; rows get too tight to label.
    gutter = W < 520 ? 0 : labelW
    dpr = Math.min(2, window.devicePixelRatio || 1)
    const b2 = extent(camera(0), 0, true)
    H2 = 20 + 4 + ((b2.maxy - b2.miny) / (b2.maxx - b2.minx)) * (W - gutter - 4)
    const b3 = extent(camera(1), 1, true)
    const natural = ((b3.maxy - b3.miny) / (b3.maxx - b3.minx)) * (W - 40) + 40
    H3 = Math.max(Math.min(natural, W * 0.72, 620), Math.min(natural, 240))
    Hmax = Math.ceil(Math.max(H2, H3))
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(Hmax * dpr)
    canvas.style.width = W + "px"
    canvas.style.height = Hmax + "px"
    lastH = -1
    cfg.current.setWidth(W)
    draw()
  }

  const draw = () => {
    if (!W || !n) return
    const e = easeInOutCubic(t)
    const cam = camera(e, yaw, elev)
    const Hc = lerp(H2, H3, e)
    if (Math.abs(Hc - lastH) > 0.2) {
      stage.style.height = Hc.toFixed(1) + "px"
      lastH = Hc
    }
    for (let i = 0; i < n; i++) zs[i] = riseAt(t, wk[i], weeks, dy[i]) * hgt[i]
    const b = extent(cam, e, false)
    const pad = lerp(2, 20, e)
    const left = pad + gutter * (1 - e)
    const top = pad + 20 * (1 - e)
    const aw = W - left - pad
    const ah = Hc - top - pad
    const bw = Math.max(1e-6, b.maxx - b.minx)
    const bh = Math.max(1e-6, b.maxy - b.miny)
    const s = Math.min(aw / bw, ah / bh)
    const ox = left + (aw - bw * s) / 2 - b.minx * s
    const oy = top + (ah - bh * s) / 2 - b.miny * s
    const { cs, sn, se, ce } = cam
    const px = (x: number, y: number) => ox + (x * cs - y * sn) * s
    const py = (x: number, y: number, z: number) => oy + ((x * sn + y * cs) * se - z * ce) * s

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, Hmax)

    order.sort((a, c) => (wk[a] + 0.5) * sn + (dy[a] + 0.5) * cs - ((wk[c] + 0.5) * sn + (dy[c] + 0.5) * cs))

    const w = lerp(0.78, 0.9, e)
    const off = (1 - w) / 2
    const radius = lerp(0.17, 0.03, e) * s
    const outline = (1 - e) * 0.07
    const lift = 0.7 * e
    const ex = col[0]
    const ey = col[1]
    const ez = col[2]

    for (let k = 0; k < n; k++) {
      const i = order[k]
      const x0 = wk[i] + off
      const y0 = dy[i] + off
      const x1 = x0 + w
      const y1 = y0 + w
      const z = zs[i] + hover[i] * lift
      const o = i * 24
      // top
      polys[o] = px(x0, y0); polys[o + 1] = py(x0, y0, z)
      polys[o + 2] = px(x1, y0); polys[o + 3] = py(x1, y0, z)
      polys[o + 4] = px(x1, y1); polys[o + 5] = py(x1, y1, z)
      polys[o + 6] = px(x0, y1); polys[o + 7] = py(x0, y1, z)
      // +y face (left on screen)
      polys[o + 8] = px(x0, y1); polys[o + 9] = py(x0, y1, 0)
      polys[o + 10] = px(x1, y1); polys[o + 11] = py(x1, y1, 0)
      polys[o + 12] = polys[o + 4]; polys[o + 13] = polys[o + 5]
      polys[o + 14] = polys[o + 6]; polys[o + 15] = polys[o + 7]
      // +x face (right on screen)
      polys[o + 16] = px(x1, y0); polys[o + 17] = py(x1, y0, 0)
      polys[o + 18] = polys[o + 10]; polys[o + 19] = polys[o + 11]
      polys[o + 20] = polys[o + 4]; polys[o + 21] = polys[o + 5]
      polys[o + 22] = polys[o + 2]; polys[o + 23] = polys[o + 3]

      const tall = z * ce * s
      let f = 0
      if (tall > 0.35 && w * cs * s > 0.35) f |= 1
      if (tall > 0.35 && w * sn * s > 0.35) f |= 2
      faces[i] = f

      const L = lv[i] * 3
      let r = col[L]
      let g = col[L + 1]
      let bl = col[L + 2]
      const d = dim[i]
      if (d > 0.002) {
        r += (ex - r) * 0.72 * d
        g += (ey - g) * 0.72 * d
        bl += (ez - bl) * 0.72 * d
      }
      const hv = hover[i]
      if (hv > 0.002) {
        const m = 0.16 * hv
        r += (fg[0] - r) * m
        g += (fg[1] - g) * m
        bl += (fg[2] - bl) * m
      }
      if (f & 1) {
        ctx.beginPath()
        quadPath(ctx, polys, o + 8, 0)
        ctx.fillStyle = rgbString(r * 0.84, g * 0.84, bl * 0.84)
        ctx.fill()
      }
      if (f & 2) {
        ctx.beginPath()
        quadPath(ctx, polys, o + 16, 0)
        ctx.fillStyle = rgbString(r * 0.68, g * 0.68, bl * 0.68)
        ctx.fill()
      }
      ctx.beginPath()
      quadPath(ctx, polys, o, radius)
      ctx.fillStyle = rgbString(r, g, bl)
      ctx.fill()
      if (outline > 0.004) {
        ctx.strokeStyle = "rgba(" + fg[0] + "," + fg[1] + "," + fg[2] + "," + outline.toFixed(3) + ")"
        ctx.lineWidth = 1
        ctx.stroke()
      }
      if (hv > 0.02) {
        ctx.strokeStyle = "rgba(" + fg[0] + "," + fg[1] + "," + fg[2] + "," + (0.85 * hv).toFixed(3) + ")"
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    // Labels: along the top and left in 2D, along the front edge in 3D. They fade, never pop.
    const muted = mixRGB(bg, fg, 0.55)
    ctx.font = font
    const a2 = 1 - smoothstep(0, 0.4, e)
    const a3 = smoothstep(0.62, 1, e)
    if (a2 > 0.004) {
      ctx.fillStyle = "rgba(" + Math.round(muted[0]) + "," + Math.round(muted[1]) + "," + Math.round(muted[2]) + "," + a2.toFixed(3) + ")"
      ctx.textAlign = "left"
      ctx.textBaseline = "bottom"
      let edge = -Infinity
      for (const m of months) {
        const x = px(m.week + off, -0.3)
        const tw = ctx.measureText(m.label).width
        if (x < edge || x + tw > W) continue
        ctx.fillText(m.label, x, py(m.week + off, -0.3, 0) - 3)
        edge = x + tw + 6
      }
      ctx.textAlign = "right"
      ctx.textBaseline = "middle"
      if (gutter > 0) for (const r of weekdayRows) ctx.fillText(r.label, px(0, r.day + 0.5) - 6, py(0, r.day + 0.5, 0))
    }
    if (a3 > 0.004) {
      ctx.fillStyle = "rgba(" + Math.round(muted[0]) + "," + Math.round(muted[1]) + "," + Math.round(muted[2]) + "," + a3.toFixed(3) + ")"
      ctx.textAlign = "left"
      ctx.textBaseline = "top"
      let edge = -Infinity
      for (const m of months) {
        const x = px(m.week + 0.5, 7.3)
        if (x < edge || x + ctx.measureText(m.label).width > W) continue
        ctx.fillText(m.label, x, py(m.week + 0.5, 7.3, 0) + 2)
        edge = x + ctx.measureText(m.label).width + 10
      }
    }

    // Tooltip rides the active cell through morphs and orbits.
    if (activeIdx >= 0 && activeIdx < n) {
      const i = activeIdx
      const z = zs[i] + hover[i] * lift
      const tx = px(wk[i] + 0.5, dy[i] + 0.5)
      const ty = Math.min(py(wk[i] + off, dy[i] + off, z), py(wk[i] + off + w, dy[i] + off, z), py(wk[i] + off, dy[i] + off + w, z))
      const half = tipW / 2
      const cx = Math.min(W - half - 2, Math.max(half + 2, tx))
      tip.style.transform = "translate(" + (cx - half).toFixed(1) + "px," + (ty - 8).toFixed(1) + "px) translateY(-100%)"
      tip.style.setProperty("--arrow", (tx - cx + half).toFixed(1) + "px")
    }
  }

  const tick = (now: number) => {
    raf = 0
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    let moving = false

    if (t !== target) {
      const step = reduced ? 1 : (dt * 1000) / Math.max(1, cfg.current.duration)
      t = target > t ? Math.min(target, t + step) : Math.max(target, t - step)
      moving = true
    }

    const ko = reduced ? 1 : 1 - Math.exp(-dt * 12)
    yaw += (yawGoal - yaw) * ko
    elev += (elevGoal - elev) * ko
    if (Math.abs(yawGoal - yaw) > 1e-4 || Math.abs(elevGoal - elev) > 1e-4) moving = true
    else {
      yaw = yawGoal
      elev = elevGoal
    }

    const kc = reduced ? 1 : 1 - Math.exp(-dt * 7)
    for (let k = 0; k < 15; k++) {
      const d = colGoal[k] - col[k]
      if (Math.abs(d) > 0.4) {
        col[k] += d * kc
        moving = true
      } else col[k] = colGoal[k]
    }

    const kh = reduced ? 1 : 1 - Math.exp(-dt * 16)
    const kd = reduced ? 1 : 1 - Math.exp(-dt * 10)
    const leg = cfg.current.legendLevel
    for (let i = 0; i < n; i++) {
      const hg = i === activeIdx ? 1 : 0
      const dg = leg >= 0 && lv[i] !== leg ? 1 : 0
      const h = hover[i]
      const d = dim[i]
      if (h !== hg) {
        hover[i] = Math.abs(hg - h) < 0.003 ? hg : h + (hg - h) * kh
        moving = true
      }
      if (d !== dg) {
        dim[i] = Math.abs(dg - d) < 0.003 ? dg : d + (dg - d) * kd
        moving = true
      }
    }

    draw()
    if (moving) raf = requestAnimationFrame(tick)
  }

  const kick = () => {
    if (raf) return
    last = performance.now()
    raf = requestAnimationFrame(tick)
  }

  // The active day is the hovered one, else the pinned one (tap, click or keyboard).
  const refreshActive = () => {
    const next = hovered >= 0 ? hovered : pinned
    if (next === activeIdx) return
    activeIdx = next
    cfg.current.setActive(next)
    kick()
  }

  const hit = (x: number, y: number): number => {
    for (let k = n - 1; k >= 0; k--) {
      const i = order[k]
      const o = i * 24
      if (pointInQuad(polys, o, x, y)) return i
      if (faces[i] & 1 && pointInQuad(polys, o + 8, x, y)) return i
      if (faces[i] & 2 && pointInQuad(polys, o + 16, x, y)) return i
    }
    return -1
  }

  const local = (ev: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect()
    return [ev.clientX - r.left, ev.clientY - r.top] as const
  }

  let drag: { id: number; x: number; y: number; yaw: number; elev: number; moved: boolean; orbit: boolean; mouse: boolean } | null = null

  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return
    const can = cfg.current.orbit && target === 1
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, yaw: yawGoal, elev: elevGoal, moved: false, orbit: can, mouse: ev.pointerType === "mouse" }
    if (can) {
      try {
        canvas.setPointerCapture(ev.pointerId)
      } catch {
        /* capture is a nicety */
      }
    }
  }

  const onMove = (ev: PointerEvent) => {
    if (drag && drag.orbit && ev.pointerId === drag.id) {
      const dx = ev.clientX - drag.x
      const dyy = ev.clientY - drag.y
      if (drag.moved || Math.hypot(dx, dyy) > 4) {
        drag.moved = true
        yawGoal = Math.min(YAW_RANGE[1] - YAW_3D, Math.max(YAW_RANGE[0] - YAW_3D, drag.yaw + dx * 0.006))
        if (drag.mouse) elevGoal = Math.min(ELEV_RANGE[1] - ELEV_3D, Math.max(ELEV_RANGE[0] - ELEV_3D, drag.elev + dyy * 0.004))
        canvas.style.cursor = "grabbing"
        hovered = -1
        refreshActive()
        kick()
        return
      }
    }
    if (ev.pointerType !== "mouse") return
    const [x, y] = local(ev)
    const i = hit(x, y)
    if (i !== hovered) {
      hovered = i
      refreshActive()
    }
    canvas.style.cursor = cfg.current.orbit && target === 1 ? "grab" : i >= 0 ? "pointer" : "default"
  }

  const onUp = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.id) return
    const wasMoved = drag.moved
    drag = null
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId)
    canvas.style.cursor = cfg.current.orbit && target === 1 ? "grab" : "default"
    if (wasMoved) return
    const [x, y] = local(ev)
    const i = hit(x, y)
    pinned = i === pinned ? -1 : i
    if (ev.pointerType !== "mouse") hovered = -1
    refreshActive()
    if (i >= 0) {
      const c = cfg.current.model.cells[i]
      cfg.current.onCellClick?.({ date: c.date, count: c.count })
    }
  }

  const onCancel = () => {
    drag = null
  }

  const onLeave = () => {
    if (drag) return
    hovered = -1
    refreshActive()
  }

  const onDbl = () => {
    yawGoal = 0
    elevGoal = 0
    kick()
  }

  const onKey = (ev: KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape", "Enter", " "]
    if (!keys.includes(ev.key) || !n) return
    ev.preventDefault()
    if (ev.key === "Escape") {
      pinned = -1
      hovered = -1
      refreshActive()
      return
    }
    let i = pinned >= 0 ? pinned : activeIdx >= 0 ? activeIdx : n - 1
    if (ev.key === "Enter" || ev.key === " ") {
      const c = cfg.current.model.cells[i]
      cfg.current.onCellClick?.({ date: c.date, count: c.count })
      return
    }
    if (pinned >= 0 || activeIdx >= 0) {
      if (ev.key === "ArrowLeft") i -= 7
      if (ev.key === "ArrowRight") i += 7
      if (ev.key === "ArrowUp") i -= 1
      if (ev.key === "ArrowDown") i += 1
      if (ev.key === "Home") i = 0
      if (ev.key === "End") i = n - 1
    }
    i = Math.max(0, Math.min(n - 1, i))
    pinned = i
    hovered = -1
    refreshActive()
    cfg.current.setAnnounce(cfg.current.describe(i))
  }

  const onBlur = () => {
    pinned = -1
    refreshActive()
  }

  const setTarget = () => {
    const goal = cfg.current.target
    if (!entered) return
    if (goal !== target) {
      target = goal
      if (goal === 0) {
        yawGoal = 0
        elevGoal = 0
      }
      canvas.style.cursor = cfg.current.orbit && target === 1 ? "grab" : "default"
      kick()
    }
  }

  load()
  retheme()
  relayout()

  // The 3D view rises out of the flat one the first time it is seen.
  const enter = () => {
    if (entered) return
    entered = true
    if (reduced) t = cfg.current.target
    setTarget()
  }
  let io: IntersectionObserver | null = null
  if ("IntersectionObserver" in window) {
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          enter()
          io?.disconnect()
        }
      },
      { threshold: 0.35 },
    )
    io.observe(stage)
  } else enter()

  const ro = new ResizeObserver(() => {
    if (Math.round(stage.clientWidth) !== W) relayout()
  })
  ro.observe(stage)

  const mo = new MutationObserver(retheme)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] })
  const onReduce = () => {
    reduced = reduceMq.matches
    kick()
  }
  reduceMq.addEventListener("change", onReduce)
  darkMq.addEventListener("change", retheme)

  canvas.addEventListener("pointerdown", onDown)
  canvas.addEventListener("pointermove", onMove)
  canvas.addEventListener("pointerup", onUp)
  canvas.addEventListener("pointercancel", onCancel)
  canvas.addEventListener("pointerleave", onLeave)
  canvas.addEventListener("dblclick", onDbl)
  canvas.addEventListener("keydown", onKey)
  canvas.addEventListener("blur", onBlur)

  const handle = {
    kick: () => {
      setTarget()
      kick()
    },
    load: () => {
      load()
      retheme()
      relayout()
    },
    retheme,
    tipWidth: (w: number) => {
      tipW = w
      draw()
    },
  }

  const destroy = () => {
    if (raf) cancelAnimationFrame(raf)
    io?.disconnect()
    ro.disconnect()
    mo.disconnect()
    reduceMq.removeEventListener("change", onReduce)
    darkMq.removeEventListener("change", retheme)
    canvas.removeEventListener("pointerdown", onDown)
    canvas.removeEventListener("pointermove", onMove)
    canvas.removeEventListener("pointerup", onUp)
    canvas.removeEventListener("pointercancel", onCancel)
    canvas.removeEventListener("pointerleave", onLeave)
    canvas.removeEventListener("dblclick", onDbl)
    canvas.removeEventListener("keydown", onKey)
    canvas.removeEventListener("blur", onBlur)
  }

  return { ...handle, destroy }
}
