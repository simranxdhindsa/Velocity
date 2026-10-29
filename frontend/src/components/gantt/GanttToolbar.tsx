import { ChevronLeft, ChevronRight, Edit2, GitBranch } from 'lucide-react'
import { CustomDropdown } from '@/components/CustomDropdown'
import type { GanttChartSummary, GanttView } from '../../pages/gantt-types'

// Gantt toolbar: chart picker, Today, scale, prev/next and the period on
// screen ("October 2026"), plus the edit-mode toggle.

const SCALES: { value: GanttView; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

interface Props {
  charts: GanttChartSummary[]
  activeChartId: string
  onChartChange: (id: string) => void
  view: GanttView
  onViewChange: (v: GanttView) => void
  periodLabel: string
  onToday: () => void
  onStep: (dir: -1 | 1) => void
  editMode: boolean
  onEditToggle: () => void
  disabled: boolean
}

export function GanttToolbar({
  charts, activeChartId, onChartChange, view, onViewChange,
  periodLabel, onToday, onStep, editMode, onEditToggle, disabled,
}: Props) {
  return (
    <div className="gt-toolbar">
      <div className="gt-toolbar-nav">
        <button className="gt-tool-btn" onClick={onToday} disabled={disabled}>Today</button>
        <CustomDropdown
          className="gt-scale-dropdown"
          options={SCALES}
          value={view}
          onChange={onViewChange}
        />
        <div className="gt-step">
          <button className="gt-icon-btn" onClick={() => onStep(-1)} disabled={disabled} aria-label="Earlier">
            <ChevronLeft size={16} />
          </button>
          <button className="gt-icon-btn" onClick={() => onStep(1)} disabled={disabled} aria-label="Later">
            <ChevronRight size={16} />
          </button>
        </div>
        <span className="gt-period">{periodLabel}</span>
      </div>

      <div className="gt-toolbar-actions">
        {charts.length > 0 && (
          <CustomDropdown
            className="gt-chart-dropdown"
            icon={<GitBranch size={13} />}
            options={charts.map(c => ({ value: c.id, label: c.name }))}
            value={activeChartId}
            onChange={onChartChange}
            placeholder="Select chart"
          />
        )}
        <button
          className={`gt-tool-btn${editMode ? ' gt-tool-btn--active' : ''}`}
          onClick={onEditToggle}
          title="Drag bars to reschedule, drag their edges to resize, draw dependencies"
        >
          <Edit2 size={13} />
          {editMode ? 'Done editing' : 'Edit'}
        </button>
      </div>
    </div>
  )
}
