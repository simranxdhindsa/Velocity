import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { type GanttRow, type GanttIssueRow, type GanttGroupRow, priorityColor, roleColor, rowKey } from '../../pages/gantt-types'
import { ROW_H, HDR_H } from './GanttGrid'

// Left pane of the Gantt: Task / Owner / Status columns, one collapsible
// group row per workflow state. Scroll position is synced with the timeline
// by GanttPage, so rows here must stay exactly ROW_H tall.

const GroupRow = React.memo(function GroupRow({ row, onToggle }: { row: GanttGroupRow; onToggle: (key: string) => void }) {
  return (
    <div className="gt-tb-row gt-tb-row--group" style={{ height: ROW_H }} onClick={() => onToggle(row.key)}>
      <div className="gt-tb-cell gt-tb-task">
        <ChevronRight size={14} className={`gt-tb-chevron${row.collapsed ? '' : ' gt-tb-chevron--open'}`} />
        <span className="gt-tb-group-dot" style={{ background: roleColor(row.role) }} />
        <span className="gt-tb-group-name">{row.label}</span>
        <span className="gt-tb-count">{row.count}</span>
      </div>
    </div>
  )
})

const IssueRow = React.memo(function IssueRow({ row, onClick }: { row: GanttIssueRow; onClick: (row: GanttIssueRow) => void }) {
  const { issue } = row
  const [imgFailed, setImgFailed] = useState(false)
  const initials = issue.assignee.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div className="gt-tb-row" style={{ height: ROW_H }} onClick={() => onClick(row)}>
      <div className="gt-tb-cell gt-tb-task gt-tb-task--issue" title={`${issue.idReadable} ${issue.summary}`}>
        <span className="gt-tb-prio" style={{ background: priorityColor(issue.priority) }} title={issue.priority} />
        <span className="gt-tb-id">{issue.idReadable}</span>
        <span className="gt-tb-name">{issue.summary}</span>
      </div>
      <div className="gt-tb-cell gt-tb-owner">
        {issue.assignee ? (
          <>
            {issue.avatarUrl && !imgFailed
              ? <img className="gt-tb-avatar" src={issue.avatarUrl} alt="" onError={() => setImgFailed(true)} />
              : <span className="gt-tb-avatar gt-tb-avatar--initials">{initials}</span>}
            <span className="gt-tb-owner-name">{issue.assignee}</span>
          </>
        ) : <span className="gt-tb-muted">Unassigned</span>}
      </div>
      <div className="gt-tb-cell gt-tb-status">
        <span className="gt-tb-badge" style={{ '--badge-color': roleColor(row.role) } as React.CSSProperties}>
          {issue.state || 'No state'}
        </span>
      </div>
    </div>
  )
})

interface Props {
  rows: GanttRow[]
  onToggleGroup: (key: string) => void
  onIssueClick: (row: GanttIssueRow) => void
}

export function GanttTable({ rows, onToggleGroup, onIssueClick }: Props) {
  return (
    <div className="gt-tb">
      <div className="gt-tb-hdr" style={{ height: HDR_H }}>
        <div className="gt-tb-cell gt-tb-task">Tasks</div>
        <div className="gt-tb-cell gt-tb-owner">Owner</div>
        <div className="gt-tb-cell gt-tb-status">Status</div>
      </div>
      {rows.map(r => (r.kind === 'group'
        ? <GroupRow key={rowKey(r)} row={r} onToggle={onToggleGroup} />
        : <IssueRow key={rowKey(r)} row={r} onClick={onIssueClick} />
      ))}
    </div>
  )
}
