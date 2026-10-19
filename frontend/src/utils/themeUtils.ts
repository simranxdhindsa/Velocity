// themeUtils.ts — color math + CSS variable injection for per-user theme customisation

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('')
}

function darken(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r * (1 - factor), g * (1 - factor), b * (1 - factor))
}

function lighten(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r + (255 - r) * factor, g + (255 - g) * factor, b + (255 - b) * factor)
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6
  else if (max === gf) h = ((bf - rf) / d + 2) / 6
  else h = ((rf - gf) / d + 4) / 6
  return [h * 360, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360
  const hf = h / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number) => {
    t = ((t % 1) + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [
    Math.round(hue2rgb(hf + 1 / 3) * 255),
    Math.round(hue2rgb(hf) * 255),
    Math.round(hue2rgb(hf - 1 / 3) * 255),
  ]
}

function hueShift(hex: string, degrees: number): string {
  const [r, g, b] = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(r, g, b)
  const [nr, ng, nb] = hslToRgb(h + degrees, s, l)
  return rgbToHex(nr, ng, nb)
}

/** Shades derived from the chosen background, like the accent's base/hover/muted:
 *  page = the background itself, panel = cards, sidebar, header and menus,
 *  hover = row/button hover on top of a panel. */
export function deriveBgShades(bg: string, mode: 'dark' | 'light'): { page: string; panel: string; hover: string } {
  return mode === 'dark'
    ? { page: bg, panel: lighten(bg, 0.04), hover: lighten(bg, 0.10) }
    : { page: bg, panel: lighten(bg, 0.6), hover: darken(bg, 0.04) }
}

function buildThemeCssVars(accent: string, bg: string, textColor: string, mode: 'dark' | 'light'): string {
  const [r, g, b] = hexToRgb(accent)
  const secondary = hueShift(accent, 30)
  const [rs, gs, bs] = hexToRgb(secondary)
  const [tr, tg, tb] = hexToRgb(textColor)

  const shades = deriveBgShades(bg, mode)
  const [pr, pg, pb] = hexToRgb(shades.panel)

  // Sidebar and header tinted slightly toward bg (light mode: the bg-derived panel tone)
  const sidebarBg = mode === 'dark'
    ? `rgba(${Math.round(tr*0.03 + hexToRgb(bg)[0]*0.97)},${Math.round(tg*0.03 + hexToRgb(bg)[1]*0.97)},${Math.round(tb*0.03 + hexToRgb(bg)[2]*0.97)},0.95)`
    : `rgba(${pr},${pg},${pb},0.92)`
  const headerBg = mode === 'dark' ? sidebarBg.replace('0.95', '0.82') : `rgba(${pr},${pg},${pb},0.82)`

  const accentVars = `
  --color-primary: ${accent};
  --color-primary-end: ${lighten(hueShift(accent, 20), 0.12)};
  --color-accent-cyan: #a5f3fc;
  --color-background: ${bg};
  --color-surface: ${mode === 'dark' ? lighten(bg, 0.04) : darken(bg, 0.02)};
  --color-text-primary: ${textColor};
  --color-primary-hover: ${darken(accent, 0.12)};
  --color-primary-light: ${lighten(accent, 0.18)};
  --color-primary-deep: ${darken(accent, 0.30)};
  --color-primary-rgb: ${r}, ${g}, ${b};
  --color-secondary: ${secondary};
  --color-secondary-rgb: ${rs}, ${gs}, ${bs};
  --color-secondary-light: ${lighten(secondary, 0.15)};
  --gradient-primary: linear-gradient(135deg, ${accent} 0%, ${secondary} 100%);
  --shadow-glow: 0 0 24px rgba(${r},${g},${b},0.4);
  --shadow-glow-sm: 0 0 12px rgba(${r},${g},${b},0.3);
  --shadow-glow-strong: 0 0 40px rgba(${r},${g},${b},0.6);
  --glass-border-glow: rgba(${r},${g},${b},0.35);
  --text-primary: ${textColor};
  --text-secondary: ${mode === 'dark' ? darken(textColor, 0.18) : lighten(textColor, 0.25)};
  --sidebar-bg: ${sidebarBg};
  --header-bg: ${headerBg};
  --panel-rgb: ${pr}, ${pg}, ${pb};`

  if (mode === 'dark') {
    return `${accentVars}
  --bg-base: ${bg};
  --bg-surface: ${lighten(bg, 0.04)};
  --bg-elevated: ${lighten(bg, 0.10)};
  --bg-gradient: linear-gradient(160deg, ${darken(bg, 0.02)} 0%, ${lighten(bg, 0.04)} 30%, ${darken(bg, 0.01)} 65%, ${bg} 100%);
  --gradient-bg: radial-gradient(ellipse 80% 50% at 20% 0%, rgba(${r},${g},${b},0.13) 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 80% 100%, rgba(${rs},${gs},${bs},0.10) 0%, transparent 60%), radial-gradient(ellipse 50% 60% at 50% 50%, rgba(6,182,212,0.04) 0%, transparent 70%), linear-gradient(160deg, ${darken(bg, 0.02)} 0%, ${lighten(bg, 0.04)} 30%, ${darken(bg, 0.01)} 65%, ${bg} 100%);`
  }

  const lightGrad = `radial-gradient(ellipse 80% 50% at 20% 0%, rgba(${r},${g},${b},0.07) 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 80% 100%, rgba(${rs},${gs},${bs},0.05) 0%, transparent 60%), linear-gradient(160deg, ${lighten(bg, 0.01)} 0%, ${bg} 50%, ${darken(bg, 0.01)} 100%)`
  return `${accentVars}
  --bg-base: ${bg};
  --bg-surface: ${darken(bg, 0.02)};
  --bg-elevated: ${darken(bg, 0.05)};
  --bg-gradient: ${lightGrad};
  --gradient-bg: ${lightGrad};
  --panel-soft-rgb: ${hexToRgb(bg).join(', ')};
  --panel-sunk-rgb: ${hexToRgb(darken(bg, 0.03)).join(', ')};
  --panel-deep-rgb: ${hexToRgb(darken(bg, 0.09)).join(', ')};
  --bg-hover: rgba(${r},${g},${b},0.06);
  --bg-active: rgba(${r},${g},${b},0.11);
  --border-color: rgba(${r},${g},${b},0.12);
  --glass-bg-hover: rgba(${r},${g},${b},0.10);
  --glass-bg-active: rgba(${r},${g},${b},0.15);
  --glass-border: rgba(${r},${g},${b},0.14);
  --glass-border-hover: rgba(${r},${g},${b},0.28);`
}

export function applyUserTheme(
  darkAccent: string,
  darkBg: string,
  lightAccent: string,
  lightBg: string,
  darkText = '#f1f5f9',
  lightText = '#0f172a',
): void {
  const darkVars = buildThemeCssVars(darkAccent, darkBg, darkText, 'dark')
  const lightVars = buildThemeCssVars(lightAccent, lightBg, lightText, 'light')

  const css = `:root {\n${darkVars}\n}\n[data-theme="light"] {\n${lightVars}\n}`

  let tag = document.getElementById('user-theme-custom') as HTMLStyleElement | null
  if (!tag) {
    tag = document.createElement('style')
    tag.id = 'user-theme-custom'
    document.head.appendChild(tag)
  }
  tag.textContent = css
}

export function clearUserTheme(): void {
  const tag = document.getElementById('user-theme-custom')
  if (tag) tag.remove()
}
