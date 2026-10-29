import { useState } from 'react'
import { CheckCircle, Clock, XCircle, AlertTriangle, ArrowRight, X } from 'lucide-react'
import api from '../services/api'
import { QuantumOrbitLoader } from './brand/VelocityLoaders'

interface MatchedTicket {
  task_title: string
  person: string
  status: string
  youtrack_issue: { id: string; summary: string; current_state: string }
  proposed_state: string
  confidence: number
}

interface UnmatchedTask {
  task_title: string
  person: string
  status: string
}

interface UnmatchedIssue {
  id: string
  summary: string
  current_state: string
}

interface MatchConfirmationModalProps {
  matches: MatchedTicket[]
  unmatchedTasks: UnmatchedTask[]
  unmatchedIssues: UnmatchedIssue[]
  onClose: () => void
  onSuccess: () => void
}

export function MatchConfirmationModal({
  matches,
  unmatchedTasks,
  unmatchedIssues,
  onClose,
  onSuccess,
}: MatchConfirmationModalProps) {
  const [selected, setSelected] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {}
    matches.forEach((m, i) => {
      initial[i] = m.confidence >= 0.7
    })
    return initial
  })
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedCount = Object.values(selected).filter(Boolean).length

  const toggleSelect = (index: number) => {
    setSelected(prev => ({ ...prev, [index]: !prev[index] }))
  }

  const selectAll = () => {
    const allSelected = Object.values(selected).every(Boolean)
    const next: Record<number, boolean> = {}
    matches.forEach((_, i) => { next[i] = !allSelected })
    setSelected(next)
  }

  const handleMove = async () => {
    const updates = matches
      .filter((_, i) => selected[i])
      .map(m => ({ issue_id: m.youtrack_issue.id, new_state: m.proposed_state }))

    if (updates.length === 0) return

    try {
      setMoving(true)
      setError(null)
      const response = await api.bulkUpdateYouTrackStates(updates) as any
      const data = response.data || response
      if (data.failed > 0) {
        setError(`${data.succeeded} updated, ${data.failed} failed`)
      } else {
        onSuccess()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tickets')
    } finally {
      setMoving(false)
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle size={14} />
      case 'in_progress': return <Clock size={14} />
      case 'blocked': return <XCircle size={14} />
      default: return <AlertTriangle size={14} />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'var(--color-success)'
      case 'in_progress': return 'var(--color-warning)'
      case 'blocked': return 'var(--color-danger)'
      default: return 'var(--color-secondary)'
    }
  }

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'var(--color-success)'
    if (confidence >= 0.6) return 'var(--color-warning)'
    return 'var(--color-danger)'
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal glass-card"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '720px', width: '95%', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div className="modal-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.25rem' }}>
              <span style={{ color: '#8250df' }}>Match YouTrack Tickets</span>
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              {matches.length} matched · {unmatchedTasks.length} unmatched tasks · {unmatchedIssues.length} unmatched issues
            </p>
          </div>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '1rem 0' }}>
          {error && (
            <div className="alert alert-error" style={{ margin: '0 0 1rem 0' }}>
              <AlertTriangle size={16} />
              {error}
            </div>
          )}

          {/* Matched Tickets */}
          {matches.length > 0 && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h3 style={{ fontSize: '0.9rem', fontWeight: 600 }}>Matched Tickets ({matches.length})</h3>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={selectAll}
                  style={{ fontSize: '0.8rem' }}
                >
                  {Object.values(selected).every(Boolean) ? 'Deselect All' : 'Select All'}
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {matches.map((match, i) => (
                  <div
                    key={i}
                    onClick={() => toggleSelect(i)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem',
                      borderRadius: '8px',
                      border: `1px solid ${selected[i] ? '#8250df40' : 'var(--border-color)'}`,
                      background: selected[i] ? 'rgba(130, 80, 223, 0.05)' : 'transparent',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {/* Checkbox */}
                    <div style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '4px',
                      border: `2px solid ${selected[i] ? '#8250df' : 'var(--border-color)'}`,
                      background: selected[i] ? '#8250df' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      marginTop: '2px',
                    }}>
                      {selected[i] && <CheckCircle size={14} color="white" />}
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>{match.task_title}</span>
                        <ArrowRight size={14} style={{ color: 'var(--text-secondary)' }} />
                        <span style={{
                          color: '#8250df',
                          fontWeight: 600,
                          fontSize: '0.85rem',
                          background: 'rgba(130, 80, 223, 0.1)',
                          padding: '1px 6px',
                          borderRadius: '4px',
                        }}>
                          {match.youtrack_issue.id}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.35rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        <span>@{match.person}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '3px', color: getStatusColor(match.status) }}>
                          {getStatusIcon(match.status)}
                          {match.status}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <ArrowRight size={12} />
                          <span style={{ fontWeight: 600 }}>{match.proposed_state}</span>
                        </span>
                      </div>

                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                        YT: "{match.youtrack_issue.summary}" · Current: {match.youtrack_issue.current_state}
                      </div>
                    </div>

                    {/* Confidence badge */}
                    <div style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: getConfidenceColor(match.confidence),
                      background: `${getConfidenceColor(match.confidence)}15`,
                      padding: '2px 8px',
                      borderRadius: '12px',
                      flexShrink: 0,
                    }}>
                      {Math.round(match.confidence * 100)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unmatched Tasks */}
          {unmatchedTasks.length > 0 && (
            <div style={{ marginTop: '1.5rem' }}>
              <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                Unmatched Tasks ({unmatchedTasks.length})
              </h3>
              <div style={{
                padding: '0.75rem',
                borderRadius: '8px',
                border: '1px solid var(--border-color)',
                background: 'var(--bg-secondary)',
              }}>
                {unmatchedTasks.map((task, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.35rem 0',
                    fontSize: '0.85rem',
                    color: 'var(--text-secondary)',
                    borderBottom: i < unmatchedTasks.length - 1 ? '1px solid var(--border-color)' : 'none',
                  }}>
                    <AlertTriangle size={14} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
                    <span>{task.task_title}</span>
                    <span style={{ marginLeft: 'auto', fontSize: '0.75rem' }}>@{task.person}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid var(--border-color)',
          paddingTop: '1rem',
          marginTop: '0.5rem',
        }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleMove}
            disabled={moving || selectedCount === 0}
            style={{
              background: '#8250df',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            {moving ? (
              <>
                <QuantumOrbitLoader size={18} />
                Moving...
              </>
            ) : (
              <>Move Selected ({selectedCount})</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
