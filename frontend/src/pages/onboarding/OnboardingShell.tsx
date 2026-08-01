import type { ReactNode } from 'react'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

export default function OnboardingShell({
  stepIdx, totalSteps, onBack, onSkipAll, children,
}: {
  stepIdx:     number
  totalSteps:  number
  onBack?:     () => void
  onSkipAll:   () => void
  children:    ReactNode
}) {
  return (
    <div className="ob-root">
      <div className="ob-blob ob-blob-1" />
      <div className="ob-blob ob-blob-2" />
      <div className="ob-blob ob-blob-3" />

      <div className="ob-topbar">
        <div className="ob-brand">
          <VelocityLogo variant="icon" size="sm" mark="chevron" showStatusDot={false} />
          <span>Velocity</span>
        </div>
        <button className="ob-skip-link" onClick={onSkipAll}>Skip for now</button>
      </div>

      <div className="ob-stage">
        {children}
      </div>

      <div className="ob-footer">
        <button
          className="ob-btn ob-btn-ghost ob-btn-sm"
          style={{ visibility: onBack ? 'visible' : 'hidden' }}
          onClick={onBack}
          tabIndex={onBack ? 0 : -1}
        >
          ← Back
        </button>
        <div className="ob-dots">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <span
              key={i}
              className={`ob-dot ${i === stepIdx ? 'ob-dot--active' : i < stepIdx ? 'ob-dot--done' : ''}`}
            />
          ))}
        </div>
        <button className="ob-btn ob-btn-ghost ob-btn-sm" style={{ visibility: 'hidden' }} tabIndex={-1}>
          ← Back
        </button>
      </div>
    </div>
  )
}
