// Contribution Skyline: a year of daily activity as a GitHub-style heat map that
// folds up into an isometric 3D skyline. Hover or tap a day for its count, arrow
// keys walk the grid, hover a legend swatch to isolate a level, drag to orbit in 3D.
// Adapted from @kedhareswer/contribution-skyline (21st.dev); colours follow the
// Velocity theme (accent + surface tokens), see contribution-skyline.css.
import * as React from 'react'
import '../../styles/components/contribution-skyline.css'
import { type ContributionDay, ACCENT_PALETTE, buildGrid, computeStats, dayMs, monthLabels } from './skyline-math'
import { type SkylineConfig, type SkylineEngine, type SkylineTheme, createSkylineEngine } from './skyline-engine'

export type { ContributionDay }
export { ACCENT_PALETTE }
type View = '2d' | '3d'

export interface ContributionSkylineProps {
  /** One entry per day, `YYYY-MM-DD`. Repeated dates add up. */
  data: ContributionDay[]
  /** Last day shown. Defaults to today. */
  endDate?: string | Date
  view?: View
  defaultView?: View
  onViewChange?: (view: View) => void
  /** Four CSS colours, lightest → heaviest. var() and color-mix() work. */
  palette?: string[]
  title?: React.ReactNode
  /** Default heading text after the total, e.g. "verified by QA in the last year". Ignored when `title` is set. */
  caption?: string
  unit?: string
  unitPlural?: string
  heightScale?: number
  /** Morph length, ms. */
  duration?: number
  /** 0 puts Sunday on the top row, 1 puts Monday there. */
  weekStart?: 0 | 1
  orbit?: boolean
  showStats?: boolean
  showLegend?: boolean
  showToggle?: boolean
  footer?: React.ReactNode
  locale?: string
  onCellClick?: (day: ContributionDay) => void
  className?: string
}

const GridIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" />
    <rect x="9" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" />
  </svg>
)

const CubeIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M8 1.2 14.2 4.6v6.8L8 14.8 1.8 11.4V4.6Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M1.8 4.6 8 8l6.2-3.4M8 8v6.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
)

interface StatProps { label: string; value: string; unit: string; sub: string; size: number; align: 'start' | 'end' | 'stack' }

function Stat({ label, value, unit, sub, size, align }: StatProps) {
  if (align === 'stack') {
    return (
      <div className="min-w-0">
        <div className="cs-muted text-[13px] leading-tight">{label}</div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="cs-accent cs-stat-val font-semibold tabular-nums" style={{ fontSize: size }}>{value}</span>
          <span className="text-[14px]">{unit}</span>
        </div>
        <div className="cs-muted mt-0.5 truncate text-[12px]">{sub}</div>
      </div>
    )
  }
  return (
    <div className={`grid grid-cols-[auto_auto] items-end gap-x-2 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {align === 'end' ? (
        <>
          <div className="cs-muted text-right text-[13px] leading-tight">{label}</div>
          <div />
        </>
      ) : (
        <div className="cs-muted col-span-2 text-[13px] leading-tight">{label}</div>
      )}
      <div className="cs-accent cs-stat-val text-right font-semibold tabular-nums" style={{ fontSize: size, lineHeight: 0.95 }}>{value}</div>
      <div className="pb-[0.15em] leading-tight">
        <div className="text-[15px]">{unit}</div>
        <div className="cs-muted whitespace-nowrap text-[13px]">{sub}</div>
      </div>
    </div>
  )
}

export default function ContributionSkyline({
  data,
  endDate,
  view: viewProp,
  defaultView = '3d',
  onViewChange,
  palette = ACCENT_PALETTE,
  title,
  caption = 'in the last year',
  unit = 'ticket',
  unitPlural,
  heightScale = 1,
  duration = 1300,
  weekStart = 1,
  orbit = true,
  showStats = true,
  showLegend = true,
  showToggle = true,
  footer,
  locale = 'en-US',
  onCellClick,
  className = '',
}: ContributionSkylineProps) {
  const endKey = endDate == null ? null : dayMs(endDate)
  const model = React.useMemo(() => {
    const end = endKey ?? dayMs(new Date())
    const grid = buildGrid(data, end, weekStart)
    return { ...grid, stats: computeStats(grid.cells), months: monthLabels(grid.cells, grid.weeks, locale) }
  }, [data, endKey, weekStart, locale])

  const [innerView, setInnerView] = React.useState<View>(defaultView)
  const view = viewProp ?? innerView
  const setView = (v: View) => {
    if (viewProp === undefined) setInnerView(v)
    onViewChange?.(v)
  }

  const [theme, setTheme] = React.useState<SkylineTheme>({ dark: true, swatches: ['transparent', 'transparent', 'transparent', 'transparent', 'transparent'], accent: 'currentColor' })
  const [width, setWidth] = React.useState(0)
  const [active, setActive] = React.useState(-1)
  const [legendLevel, setLegendLevel] = React.useState(-1)
  const [announce, setAnnounce] = React.useState('')

  const rootRef = React.useRef<HTMLElement>(null)
  const stageRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const tipRef = React.useRef<HTMLDivElement>(null)
  const engine = React.useRef<SkylineEngine | null>(null)

  const plural = unitPlural ?? unit + 's'
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale])
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }), [locale])
  const dfy = React.useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }), [locale])
  const dfl = React.useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }), [locale])
  const noun = (n: number) => (n === 1 ? unit : plural)
  const describe = (i: number) => {
    const c = model.cells[i]
    if (!c) return ''
    return (c.count ? nf.format(c.count) + ' ' + noun(c.count) : 'No ' + plural) + ' on ' + dfl.format(dayMs(c.date))
  }

  // Everything the render loop reads, refreshed every render so it never closes over stale props.
  const target = view === '3d' ? 1 : 0
  const cfg = React.useRef<SkylineConfig>({ model, duration, heightScale, orbit, palette, legendLevel, onCellClick, target, setActive, setWidth, setTheme, setAnnounce, describe })
  // Runs after every render on purpose; it only stores the setters, it never calls them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    cfg.current = { model, duration, heightScale, orbit, palette, legendLevel, onCellClick, target, setActive, setWidth, setTheme, setAnnounce, describe }
  })

  React.useEffect(() => {
    const root = rootRef.current, stage = stageRef.current, canvas = canvasRef.current, tip = tipRef.current
    if (!root || !stage || !canvas || !tip) return
    const eng = createSkylineEngine({ root, stage, canvas, tip }, cfg, locale)
    engine.current = eng
    return () => {
      eng?.destroy()
      engine.current = null
    }
  }, [locale])

  React.useEffect(() => { engine.current?.kick() }, [view, legendLevel])
  React.useEffect(() => { engine.current?.load() }, [model, heightScale])
  React.useEffect(() => { engine.current?.retheme() }, [palette])

  // The tooltip's width keeps it inside the card; measure it when its text changes.
  React.useLayoutEffect(() => {
    const tip = tipRef.current
    if (tip && active >= 0) engine.current?.tipWidth(tip.offsetWidth)
  }, [active, model])

  const { stats } = model
  const range = (a: string | null, b: string | null, withYear = false) => {
    if (!a || !b) return 'None yet'
    const f = withYear ? dfy : df
    return a === b ? f.format(dayMs(a)) : f.format(dayMs(a)) + ' to ' + f.format(dayMs(b))
  }
  const is3d = view === '3d'
  const corners = showStats && width >= 560
  const bigSize = Math.round(Math.max(30, Math.min(56, width * 0.058)))
  const statBlocks = [
    { label: 'Total', value: nf.format(stats.total), unit: noun(stats.total), sub: range(stats.first, stats.last, true) },
    { label: 'Busiest day', value: nf.format(stats.busiest.count), unit: noun(stats.busiest.count), sub: stats.busiest.date ? df.format(dayMs(stats.busiest.date)) : 'None yet' },
    { label: 'Longest streak', value: nf.format(stats.longest.days), unit: stats.longest.days === 1 ? 'day' : 'days', sub: range(stats.longest.start, stats.longest.end) },
    { label: 'Current streak', value: nf.format(stats.current.days), unit: stats.current.days === 1 ? 'day' : 'days', sub: range(stats.current.start, stats.current.end) },
  ]
  const showRow = showStats && !(is3d && corners)
  const levelNames = ['No ' + plural, 'Light', 'Moderate', 'Heavy', 'Heaviest']
  const hints = ['Hover a day for details · click to list its tickets · arrow keys to explore', 'Drag to orbit · double-click to reset · click a day to list its tickets']
  const hint = hints[is3d && orbit ? 1 : 0]

  return (
    <section ref={rootRef} className={'cs-root @container relative w-full rounded-xl border p-4 sm:p-5 ' + className}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="m-0 text-[15px] font-normal leading-snug">
          {title ?? (<><span className="font-semibold tabular-nums">{nf.format(stats.total)}</span> {noun(stats.total)} {caption}</>)}
        </h3>
        {showToggle && (
          <div role="group" aria-label="Chart view" className="cs-border relative inline-flex rounded-md border p-0.5">
            <span aria-hidden="true" className={`cs-toggle-thumb absolute top-0.5 bottom-0.5 left-0.5 w-8 rounded${is3d ? ' cs-toggle-thumb--3d' : ''}`} />
            {(['2d', '3d'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                aria-label={v === '2d' ? 'Flat heat map' : '3D skyline'}
                title={v === '2d' ? 'Flat heat map' : '3D skyline'}
                onClick={() => setView(v)}
                className={`cs-toggle-btn relative z-10 grid h-7 w-8 cursor-pointer place-items-center rounded border-0 bg-transparent p-0${view === v ? ' cs-toggle-btn--on' : ''}`}
              >
                {v === '2d' ? <GridIcon /> : <CubeIcon />}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="cs-border relative rounded-lg border">
        <div className="relative px-3 pt-3 sm:px-4 sm:pt-4">
          <div ref={stageRef} className="cs-stage relative w-full overflow-hidden rounded-md">
            <canvas
              ref={canvasRef}
              tabIndex={0}
              role="img"
              aria-label={nf.format(stats.total) + ' ' + noun(stats.total) + ' between ' + range(stats.first, stats.last, true) + ', shown as a ' + (is3d ? '3D skyline' : 'heat map') + '. Use the arrow keys to read individual days.'}
              className={`cs-canvas absolute top-0 left-0 block outline-none${is3d && orbit ? ' cs-canvas--orbit' : ''}`}
            />
            {showStats && corners && (
              <>
                <div aria-hidden={!is3d} className={`cs-corner cs-corner--top pointer-events-none absolute top-1 right-1 flex flex-col items-end gap-5${is3d ? ' cs-corner--on' : ''}`}>
                  <Stat {...statBlocks[0]} size={bigSize} align="end" />
                  <Stat {...statBlocks[1]} size={bigSize} align="end" />
                </div>
                <div aria-hidden={!is3d} className={`cs-corner cs-corner--bottom pointer-events-none absolute bottom-1 left-1 flex flex-col items-start gap-5${is3d ? ' cs-corner--on' : ''}`}>
                  <Stat {...statBlocks[2]} size={bigSize} align="start" />
                  <Stat {...statBlocks[3]} size={bigSize} align="start" />
                </div>
              </>
            )}
          </div>

          <div ref={tipRef} role="tooltip" aria-hidden={active < 0}
            className={`cs-tip pointer-events-none absolute top-3 left-3 z-20 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12px] leading-none shadow-lg sm:top-4 sm:left-4${active >= 0 ? ' cs-tip--on' : ''}`}>
            {active >= 0 && model.cells[active] ? (
              <>
                <strong className="font-semibold">
                  {model.cells[active].count ? nf.format(model.cells[active].count) + ' ' + noun(model.cells[active].count) : 'No ' + plural}
                </strong>
                <span className="opacity-75"> on {dfy.format(dayMs(model.cells[active].date))}</span>
              </>
            ) : ' '}
            <span aria-hidden="true" className="cs-tip-arrow absolute top-full h-0 w-0" />
          </div>
        </div>

        {showStats && (
          <div aria-hidden={!showRow} className={`cs-stat-row grid${showRow ? ' cs-stat-row--on' : ''}`}>
            <div className="min-h-0 overflow-hidden">
              <div className="grid grid-cols-2 gap-x-4 gap-y-4 px-3 pt-4 pb-1 sm:px-4 @xl:grid-cols-4">
                {statBlocks.map((b) => <Stat key={b.label} {...b} size={28} align="stack" />)}
              </div>
            </div>
          </div>
        )}

        <div className="cs-muted flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 pt-3 pb-3 text-[12px] sm:px-4">
          {footer === undefined ? (
            <span className="relative grid flex-1">
              {hints.map((h) => (
                <span key={h} aria-hidden={h !== hint} className={`cs-hint [grid-area:1/1]${h === hint ? ' cs-hint--on' : ''}`}>{h}</span>
              ))}
            </span>
          ) : <span className="flex-1">{footer}</span>}
          {showLegend && (
            <div className="flex items-center gap-1.5" onMouseLeave={() => setLegendLevel(-1)}>
              <span className="mr-0.5">Less</span>
              {theme.swatches.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={'Highlight ' + levelNames[i].toLowerCase() + ' days'}
                  aria-pressed={legendLevel === i}
                  title={levelNames[i]}
                  onMouseEnter={() => setLegendLevel(i)}
                  onFocus={() => setLegendLevel(i)}
                  onBlur={() => setLegendLevel(-1)}
                  onClick={() => setLegendLevel((l) => (l === i ? -1 : i))}
                  className="cs-swatch h-[11px] w-[11px] cursor-pointer rounded-[2px] border-0 p-0"
                  style={{ background: c }}
                />
              ))}
              <span className="ml-0.5">More</span>
            </div>
          )}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">{announce}</p>
    </section>
  )
}
