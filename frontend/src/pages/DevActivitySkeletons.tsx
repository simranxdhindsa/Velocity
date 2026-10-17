// Loading skeletons for every Dev Activity subtab. Each one reuses its view's real
// container/row classes (da-summary-bar, da-dev-section, da-cards-scroll, da-log-row,
// da-heatmap-body, dr-results…) so it occupies exactly the space the content will.
// Kept in their own file because DevActivityPage.tsx is already far past the size limit.
import '../styles/pages/dev-activity-skeleton.css'

const W = [55, 70, 48, 65, 58, 72] // vary bar widths so rows look organic

const Sk = ({ w, h, r = 4 }: { w: number | string; h: number; r?: number | string }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r, flexShrink: 0 }} />
)

// ── Shared: KPI chip row (Touched / Dev Done / Active / Blocked / Bounced) ──
function SkSummaryBar() {
  return (
    <div className="da-summary-bar">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="da-kpi-chip">
          <Sk w={14} h={14} r={4} />
          <Sk w={18} h={14} />
          <Sk w={44 + (i % 3) * 8} h={10} />
        </div>
      ))}
    </div>
  )
}

// ── Activity Feed: one section per developer with ticket rows ──
function SkFeed() {
  return (
    <>
      <div className="da-view-controls">
        <div className="da-density-toggle">
          <Sk w={44} h={10} />
          <Sk w={62} h={24} r={6} />
          <Sk w={66} h={24} r={6} />
        </div>
      </div>
      <SkSummaryBar />
      <div className="da-feed-scroll da-sk-pad-top">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="da-dev-section">
            <div className="da-dev-header">
              <Sk w={8} h={8} r="50%" />
              <Sk w={`${W[i % 6] * 2}px`} h={13} />
              <div className="da-sk-push" />
              <Sk w={52} h={18} r={6} />
              <Sk w={52} h={18} r={6} />
              <Sk w={52} h={18} r={6} />
            </div>
            {Array.from({ length: 3 - (i % 2) }).map((_, j) => (
              <div key={j} className="da-ticket-row">
                <div className="da-ticket-main-row">
                  <Sk w={64} h={13} />
                  <Sk w={72} h={18} r={9} />
                  <Sk w={`${W[(i + j) % 6]}%`} h={13} />
                  <div className="da-sk-push" />
                  <Sk w={34} h={12} />
                </div>
                <div className="da-journey-row da-sk-row">
                  {Array.from({ length: 2 + ((i + j) % 4) }).map((_, k) => <Sk key={k} w={58} h={16} r={8} />)}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

// ── Developer Cards: bento grid of cards ──
function SkCards() {
  return (
    <>
      <div className="da-cards-scroll">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="da-dev-card da-sk-card">
            <div className="da-card-header">
              <Sk w={36} h={36} r="50%" />
              <div className="da-sk-col">
                <Sk w={`${W[i % 6]}%`} h={14} />
                <Sk w="40%" h={10} />
              </div>
            </div>
            <div className="da-card-kpis">
              {Array.from({ length: 4 }).map((_, k) => <Sk key={k} w={62} h={24} r={7} />)}
            </div>
            <div className="da-card-progress-wrap">
              <div className="da-sk-row da-sk-between">
                <Sk w={70} h={10} />
                <Sk w={30} h={10} />
              </div>
              <div className="da-sk-bar-track"><Sk w={`${W[(i + 2) % 6]}%`} h={5} r={3} /></div>
            </div>
            <div className="da-card-ticket-list">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="da-card-ticket-row">
                  <Sk w={7} h={7} r="50%" />
                  <Sk w={58} h={12} />
                  <Sk w={`${W[(i + j + 1) % 6]}%`} h={12} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ── Transition Log: audit table ──
function SkLog() {
  return (
    <>
      <div className="da-view-controls">
        <div className="da-sk-row">
          <Sk w={40} h={24} r={7} />
          <Sk w={118} h={24} r={7} />
          <Sk w={100} h={24} r={7} />
        </div>
        <div className="da-sk-push" />
        <Sk w={96} h={26} r={7} />
      </div>
      <div className="da-log-legend">
        <div className="da-sk-row"><Sk w={14} h={2} r={1} /><Sk w={92} h={10} /></div>
        <div className="da-sk-row"><Sk w={14} h={2} r={1} /><Sk w={104} h={10} /></div>
        <Sk w={130} h={10} />
      </div>
      <div className="da-log-body">
        <div className="da-log-col-header">
          {[70, 50, 56, 90, 110, 50].map((w, i) => <Sk key={i} w={w} h={10} />)}
        </div>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="da-log-row">
            <Sk w={84} h={12} />
            <div className="da-sk-row"><Sk w={18} h={18} r="50%" /><Sk w={46} h={11} /></div>
            <Sk w={62} h={12} />
            <Sk w={`${W[i % 6] + 20}%`} h={12} />
            <div className="da-sk-row"><Sk w={70} h={18} r={9} /><Sk w={12} h={10} /><Sk w={70} h={18} r={9} /></div>
            <Sk w={40} h={12} />
          </div>
        ))}
      </div>
    </>
  )
}

// ── Lifecycle Heatmap: developer list on the left, ticket × state grid on the right ──
function SkHeatmap() {
  return (
    <>
      <div className="da-view-controls">
        <Sk w={130} h={28} r={8} />
      </div>
      <div className="da-heatmap-body">
        <div className="da-heatmap-left">
          <Sk w={100} h={11} />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="da-heatmap-dev-row">
              <div className="da-sk-row da-sk-between">
                <div className="da-sk-row"><Sk w={22} h={22} r="50%" /><Sk w={W[i % 6] + 30} h={12} /></div>
                <Sk w={30} h={11} />
              </div>
              <div className="da-sk-bar-track da-sk-mt"><Sk w={`${W[(i + 3) % 6]}%`} h={4} r={2} /></div>
              <div className="da-sk-mt"><Sk w="60%" h={9} /></div>
            </div>
          ))}
          <div className="da-heatmap-legend">
            <Sk w={80} h={10} />
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="da-sk-row da-sk-mt"><Sk w={14} h={10} r={3} /><Sk w={56 + (i % 3) * 14} h={9} /></div>
            ))}
          </div>
        </div>
        <div className="da-heatmap-right">
          <div className="da-heatmap-grid-scroll da-sk-grid">
            <div className="da-sk-heat-row">
              <Sk w={170} h={10} />
              {Array.from({ length: 7 }).map((_, c) => <Sk key={c} w="100%" h={10} />)}
            </div>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="da-sk-heat-row">
                <div className="da-sk-row"><Sk w={52} h={11} /><Sk w={W[i % 6] + 20} h={11} /></div>
                {Array.from({ length: 7 }).map((_, c) => (
                  <Sk key={c} w="100%" h={26} r={5} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

/** One skeleton per Dev Activity subtab. */
export function DevActivityViewSkeleton({ view }: { view: string }) {
  switch (view) {
    case 'feed':    return <SkFeed />
    case 'cards':   return <SkCards />
    case 'log':     return <SkLog />
    case 'heatmap': return <SkHeatmap />
    default:        return <SkFeed />
  }
}

// ── Dev Report: results while the report is generated ──
export function DevReportResultsSkeleton() {
  return (
    <div className="dr-results">
      <div className="dr-results-header">
        <div className="da-sk-col">
          <Sk w={260} h={16} />
          <Sk w={180} h={11} />
        </div>
        <Sk w={110} h={30} r={8} />
      </div>
      <div className="dr-stats-strip">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="dr-stat-chip">
            <Sk w={46} h={20} />
            <Sk w={70} h={10} />
          </div>
        ))}
      </div>
      {Array.from({ length: 2 }).map((_, d) => (
        <div key={d} className="dr-dev-section">
          <div className="dr-dev-header">
            <Sk w={26} h={26} r="50%" />
            <Sk w={W[d] * 2} h={13} />
            <div className="da-sk-push" />
            <Sk w={80} h={11} />
          </div>
          <div className="dr-table-wrap">
            <table className="dr-table">
              <tbody>
                {Array.from({ length: 4 - d }).map((_, i) => (
                  <tr key={i}>
                    <td><Sk w={60} h={12} /></td>
                    <td><Sk w={`${W[(i + d) % 6] + 20}%`} h={12} /></td>
                    <td><Sk w={70} h={12} /></td>
                    <td><div className="da-sk-row"><Sk w={46} h={16} r={8} /><Sk w={46} h={16} r={8} /><Sk w={46} h={16} r={8} /></div></td>
                    <td><Sk w={34} h={12} /></td>
                    <td><Sk w={20} h={12} /></td>
                    <td><Sk w={80} h={12} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Dev Report: developer pills while the list loads ──
export function DevPillsSkeleton() {
  return (
    <div className="dr-dev-grid">
      {Array.from({ length: 8 }).map((_, i) => <Sk key={i} w={70 + W[i % 6]} h={28} r={14} />)}
    </div>
  )
}
