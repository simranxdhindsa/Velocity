import '../styles/components/kpi-skeleton.css'
// Loading skeletons for the Sprint Pulse / PM Reports KPI row and the Delivery pipeline.
// They reuse the real card classes so the row keeps its exact size.

const NOTE_W = ['idp-sk-w-60', 'idp-sk-w-75', 'idp-sk-w-55', 'idp-sk-w-45', 'idp-sk-w-40']

export function KpiRowSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="pm-tracking-kpi-row">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="pm-tracking-kpi kpi-sk-card">
          <div className="skeleton kpi-sk-lbl" />
          <div className="skeleton kpi-sk-val" />
          {i === 0 && <div className="skeleton kpi-sk-bar" />}
          <div className={`skeleton kpi-sk-note ${NOTE_W[i % NOTE_W.length]}`} />
        </div>
      ))}
    </div>
  )
}

export function PipelineSkeleton() {
  return (
    <div className="spl-pipeline">
      <span className="spl-pipeline-label">Delivery</span>
      <div className="spl-pipe-stages">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton kpi-sk-stage" />
        ))}
      </div>
    </div>
  )
}
