import { useState, useEffect, useRef } from 'react'
import { Brain, Sparkles, TrendingUp, AlertCircle, CheckCircle, Clock, XCircle, Save, Link2, RefreshCw, ArrowRight, AlertTriangle, FilePlus, MessageSquare } from 'lucide-react'
import api from '../services/api'
import { matchAnalysis } from '../services/pmDataService'
import { MatchConfirmationModal } from '../components/MatchConfirmationModal'
import { QuantumOrbitLoader } from '@/components/brand/VelocityLoaders'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

interface AnalysisResult {
  task_title: string
  detected_status: string
  confidence: number
  evidence: string[]
}

interface PersonBreakdown {
  name: string
  assigned: string[]
  completed: string[]
  pending: string[]
  blocked: string[]
  not_mentioned?: string[]
  no_update_received?: boolean
  stats: {
    total: number
    completed: number
    pending: number
    blocked: number
    not_mentioned?: number
  }
}

interface Summary {
  total_tasks: number
  completed: number
  in_progress: number
  blocked: number
  not_mentioned: number
}

interface AIAnalysisPageProps {
  onNavigateToDailyAnalysis?: () => void
}

export function AIAnalysisPage({ onNavigateToDailyAnalysis }: AIAnalysisPageProps) {
  const [morningAssignments, setMorningAssignments] = useState('')
  const [eveningUpdates, setEveningUpdates] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [analysisDate, setAnalysisDate] = useState(new Date().toISOString().split('T')[0]) // Today's date in YYYY-MM-DD

  const [results, setResults] = useState<{
    analysis: AnalysisResult[]
    person_breakdown: PersonBreakdown[]
    summary: Summary
  } | null>(null)
  const [loadingSaved, setLoadingSaved] = useState(false)
  const [loadedFromSaved, setLoadedFromSaved] = useState(false)
  const justAnalyzed = useRef(false)
  const [slackConnected, setSlackConnected] = useState(false)
  const [importingSlack, setImportingSlack] = useState(false)

  // Check Slack connectivity on mount
  useEffect(() => {
    const checkSlack = async () => {
      try {
        const response = await api.getSlackStatus()
        if (response.success && response.data?.connected && response.data?.channel_id) {
          setSlackConnected(true)
        }
      } catch {
        // Slack not configured — that's fine
      }
    }
    checkSlack()
  }, [])

  // Auto-load saved analysis when date changes
  useEffect(() => {
    if (justAnalyzed.current) {
      justAnalyzed.current = false
      return
    }
    const loadSaved = async () => {
      try {
        setLoadingSaved(true)
        const response = await api.getAnalysisByDate(analysisDate)
        if (response.success && response.data) {
          setMorningAssignments(response.data.morning_message || '')
          setEveningUpdates(response.data.evening_message || '')
          const ar = response.data.analysis_result
          if (ar && ar.analysis && ar.person_breakdown && ar.summary) {
            setResults({
              analysis: ar.analysis,
              person_breakdown: ar.person_breakdown,
              summary: ar.summary,
            })
            setLoadedFromSaved(true)
          } else {
            setResults(null)
            setLoadedFromSaved(false)
          }
        } else {
          setLoadedFromSaved(false)
        }
      } catch {
        // No saved analysis for this date — that's fine
        setLoadedFromSaved(false)
      } finally {
        setLoadingSaved(false)
      }
    }
    loadSaved()
  }, [analysisDate])

  // YouTrack matching state
  const [matching, setMatching] = useState(false)
  const [matchResults, setMatchResults] = useState<{
    matches: any[]
    unmatched_tasks: any[]
    unmatched_issues: any[]
  } | null>(null)

  // Sync recommendations state
  const [syncing, setSyncing] = useState(false)
  const [syncRecommendations, setSyncRecommendations] = useState<{
    issue_id: string
    summary: string
    person: string
    current_state: string
    proposed_state: string
    reason: string
    backward: boolean
    confidence: number
  }[] | null>(null)
  const [syncSelections, setSyncSelections] = useState<Record<string, boolean>>({})
  const [applyingSync, setApplyingSync] = useState(false)

  const exampleMorning = `\`todays task list\`

\`@Rajvir Singh\`
• PDF page numbers deprecation (High)
• No confirmation modal for quit course
• Mic/audio playback conflict

\`@Harpinder Singh\`
• Report API first access issue
• AI display mode changes
• Skeleton loading on onboarding

\`@Vishal\`
• BE Studio: Evaluation Bot config
• FE MC: Duplicate user error message`

  const exampleEvening = `Updates for today:

@Rajvir: Completed the PDF deprecation task and the quit modal. Still working on the mic conflict.

@Harpinder: Fixed the Report API issue. The AI display and skeleton loading are done.

@Vishal: BE Bot config is complete. The FE duplicate error is blocked - waiting for design approval.`

  const handleAnalyze = async () => {
    if (!morningAssignments.trim() || !eveningUpdates.trim()) {
      setError('Please enter both morning assignments and evening updates')
      return
    }

    try {
      setAnalyzing(true)
      setError(null)
      const response = await api.analyzeManualInput(morningAssignments, eveningUpdates)
      if (response.success && response.data) {
        justAnalyzed.current = true
        setLoadedFromSaved(false)
        setResults({
          analysis: response.data.analysis || [],
          person_breakdown: response.data.person_breakdown || [],
          summary: response.data.summary || { total_tasks: 0, completed: 0, in_progress: 0, blocked: 0, not_mentioned: 0 },
        })
      } else {
        setError('No analysis results received')
      }
    } catch (err) {
      console.error('Analysis error:', err)
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  const loadExample = () => {
    setMorningAssignments(exampleMorning)
    setEveningUpdates(exampleEvening)
    setResults(null)
    setSuccessMessage(null)
    setLoadedFromSaved(false)
  }

  const handleNewAnalysis = () => {
    setMorningAssignments('')
    setEveningUpdates('')
    setResults(null)
    setError(null)
    setSuccessMessage(null)
    setLoadedFromSaved(false)
    setMatchResults(null)
    setSyncRecommendations(null)
  }

  const handleImportFromSlack = async () => {
    try {
      setImportingSlack(true)
      setError(null)
      const response = await api.getSlackMessages({ from: analysisDate, to: analysisDate })
      if (response.success && response.data?.messages?.length > 0) {
        const formatted = response.data.messages
          .map((msg: any) => `[${new Date(msg.timestamp).toLocaleTimeString()}] @${msg.user_name}: ${msg.text}`)
          .join('\n\n')
        setMorningAssignments(formatted)
        setSuccessMessage(`Imported ${response.data.messages.length} messages from Slack`)
        setTimeout(() => setSuccessMessage(null), 3000)
      } else {
        setError(`No messages found in Slack for ${analysisDate}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import from Slack')
    } finally {
      setImportingSlack(false)
    }
  }

  const handleSaveAnalysis = async () => {
    if (!results) {
      setError('No analysis to save. Please run analysis first.')
      return
    }

    try {
      setSaving(true)
      setError(null)
      setSuccessMessage(null)

      const response = await api.saveAnalysis(
        analysisDate,
        morningAssignments,
        eveningUpdates,
        {
          analysis: results.analysis,
          person_breakdown: results.person_breakdown,
          summary: results.summary
        }
      )

      if (response.success) {
        setSuccessMessage(`Analysis saved successfully for ${analysisDate}!`)
        // Redirect to Daily Analysis page after 1.5 seconds
        setTimeout(() => {
          setSuccessMessage(null)
          if (onNavigateToDailyAnalysis) {
            onNavigateToDailyAnalysis()
          }
        }, 1500)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save analysis')
    } finally {
      setSaving(false)
    }
  }

  const handleMatchWithYouTrack = async () => {
    if (!results) return
    try {
      setMatching(true)
      setError(null)
      const response = await matchAnalysis(
        results.person_breakdown,
        results.analysis
      )
      setMatchResults({
        matches: response.data?.matches || [],
        unmatched_tasks: response.data?.unmatched_tasks || [],
        unmatched_issues: response.data?.unmatched_issues || [],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to match with YouTrack')
    } finally {
      setMatching(false)
    }
  }

  const handleSyncWithYouTrack = async () => {
    if (!results) return
    try {
      setSyncing(true)
      setError(null)
      const response = await api.getSyncRecommendations(
        results.person_breakdown,
        results.analysis
      )
      const recs = response.data?.recommendations || []
      setSyncRecommendations(recs)
      // Pre-select all non-backward recommendations
      const selections: Record<string, boolean> = {}
      for (const rec of recs) {
        selections[rec.issue_id] = !rec.backward
      }
      setSyncSelections(selections)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get sync recommendations')
    } finally {
      setSyncing(false)
    }
  }

  const handleApplySync = async () => {
    if (!syncRecommendations) return
    const updates = syncRecommendations
      .filter(rec => syncSelections[rec.issue_id])
      .map(rec => ({ issue_id: rec.issue_id, new_state: rec.proposed_state }))

    if (updates.length === 0) {
      setSyncRecommendations(null)
      return
    }

    try {
      setApplyingSync(true)
      setError(null)
      const response = await api.bulkUpdateYouTrackStates(updates)
      if (response.data && response.data.succeeded > 0) {
        setSuccessMessage(`Synced ${response.data.succeeded} issue(s) with YouTrack!${response.data.failed > 0 ? ` (${response.data.failed} failed)` : ''}`)
        setTimeout(() => setSuccessMessage(null), 3000)
      }
      setSyncRecommendations(null)
      setSyncSelections({})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply sync')
    } finally {
      setApplyingSync(false)
    }
  }

  const getStatusColor = (status: string) => {
    const normalized = status.toLowerCase()
    if (normalized.includes('complete') || normalized.includes('done')) return 'var(--color-success)'
    if (normalized.includes('progress') || normalized.includes('working')) return 'var(--color-warning)'
    if (normalized.includes('block')) return 'var(--color-danger)'
    if (normalized.includes('not_mentioned') || normalized.includes('not mentioned')) return 'var(--text-secondary)'
    return 'var(--color-secondary)'
  }

  const getStatusIcon = (status: string) => {
    const normalized = status.toLowerCase()
    if (normalized.includes('complete') || normalized.includes('done')) return <CheckCircle size={16} />
    if (normalized.includes('progress') || normalized.includes('working')) return <Clock size={16} />
    if (normalized.includes('block')) return <XCircle size={16} />
    if (normalized.includes('not_mentioned') || normalized.includes('not mentioned')) return <AlertTriangle size={16} />
    return <AlertCircle size={16} />
  }

  return (
    <div className="ai-analysis-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            <Brain size={28} style={{ color: 'var(--color-primary)' }} />
            AI Task Analysis
          </h1>
          <p className="page-subtitle">
            Paste morning task assignments and evening updates to analyze completion status with AI
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Analysis Date</label>
            <input
              type="date"
              value={analysisDate}
              onChange={(e) => setAnalysisDate(e.target.value)}
              className="btn btn-ghost btn-sm"
              style={{ padding: '0.5rem', minWidth: '150px' }}
            />
            {loadingSaved && (
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Loading saved...</span>
            )}
            {loadedFromSaved && !loadingSaved && (
              <span style={{ fontSize: '0.65rem', color: 'var(--color-success)' }}>Loaded from saved</span>
            )}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={loadExample} style={{ marginTop: '1.2rem' }}>
            <Sparkles size={16} /> Load Example
          </button>
          {(results || morningAssignments || eveningUpdates) && (
            <button className="btn btn-ghost btn-sm" onClick={handleNewAnalysis} style={{ marginTop: '1.2rem' }}>
              <FilePlus size={16} /> New Analysis
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <AlertCircle size={20} />
          {error}
          <button className="alert-close" onClick={() => setError(null)}>
            &times;
          </button>
        </div>
      )}

      {successMessage && (
        <div className="alert alert-success">
          <CheckCircle size={20} />
          {successMessage}
          <button className="alert-close" onClick={() => setSuccessMessage(null)}>
            &times;
          </button>
        </div>
      )}

      <div className="ai-input-section glass-card">
        <div className="ai-input-grid">
          <div className="ai-input-column">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="ai-input-label">
                <TrendingUp size={18} />
                Morning Task Assignments
              </label>
              {slackConnected && (
                <button
                  className="btn btn-ghost btn-sm slack-import-btn"
                  onClick={handleImportFromSlack}
                  disabled={importingSlack}
                >
                  {importingSlack ? (
                    <><RefreshCw size={14} className="spin" /> Importing...</>
                  ) : (
                    <><MessageSquare size={14} /> Import from Slack</>
                  )}
                </button>
              )}
            </div>
            <textarea
              className="ai-textarea"
              value={morningAssignments}
              onChange={(e) => setMorningAssignments(e.target.value.slice(0, 5000))}
              maxLength={5000}
              placeholder="Paste your morning 'todays task list' message here..."
              rows={15}
            />
            <p className="ai-input-hint">
              Supports Slack format with <code>`@Person Name`</code> and bullet points
              {slackConnected && ' — or use "Import from Slack" to pull messages automatically'}
            </p>
          </div>

          <div className="ai-input-column">
            <label className="ai-input-label">
              <CheckCircle size={18} />
              Evening Task Updates
            </label>
            <textarea
              className="ai-textarea"
              value={eveningUpdates}
              onChange={(e) => setEveningUpdates(e.target.value.slice(0, 5000))}
              maxLength={5000}
              placeholder="Paste your evening status update message here..."
              rows={15}
            />
            <p className="ai-input-hint">
              Include what was completed, what's in progress, and any blockers
            </p>
          </div>
        </div>

        <div className="ai-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={handleAnalyze}
            disabled={analyzing || !morningAssignments.trim() || !eveningUpdates.trim()}
          >
            {analyzing ? (
              <>
                <QuantumOrbitLoader size={18} />
                Analyzing with AI...
              </>
            ) : (
              <>
                <Brain size={18} />
                Analyze with AI
              </>
            )}
          </button>
        </div>
      </div>

      {results && (
        <>
          {/* Save Analysis & Match & Sync Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-lg"
              onClick={handleMatchWithYouTrack}
              disabled={matching}
              style={{
                background: '#8250df',
                color: 'white',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              {matching ? (
                <>
                  <QuantumOrbitLoader size={16} />
                  Matching...
                </>
              ) : (
                <>
                  <Link2 size={18} />
                  Match with YouTrack
                </>
              )}
            </button>
            <button
              className="btn btn-lg btn-sync-yt"
              onClick={handleSyncWithYouTrack}
              disabled={syncing}
            >
              {syncing ? (
                <>
                  <QuantumOrbitLoader size={16} />
                  Checking...
                </>
              ) : (
                <>
                  <RefreshCw size={18} />
                  Sync with YouTrack
                </>
              )}
            </button>
            <button
              className="btn btn-success btn-lg"
              onClick={handleSaveAnalysis}
              disabled={saving}
            >
              {saving ? (
                <>
                  <QuantumOrbitLoader size={16} />
                  Saving...
                </>
              ) : (
                <>
                  <Save size={18} />
                  Save Analysis for {analysisDate}
                </>
              )}
            </button>
          </div>

          {/* Summary Cards */}
          <div className="ai-summary-grid">
            <div className="ai-summary-card glass-card">
              <div className="ai-summary-icon" style={{ backgroundColor: 'var(--color-primary-light)' }}>
                <TrendingUp size={24} color="var(--color-primary)" />
              </div>
              <div className="ai-summary-content">
                <span className="ai-summary-value">{results.summary.total_tasks}</span>
                <span className="ai-summary-label">Total Tasks</span>
              </div>
            </div>

            <div className="ai-summary-card glass-card">
              <div className="ai-summary-icon" style={{ backgroundColor: 'var(--color-success-light)' }}>
                <CheckCircle size={24} color="var(--color-success)" />
              </div>
              <div className="ai-summary-content">
                <span className="ai-summary-value">{results.summary.completed}</span>
                <span className="ai-summary-label">Completed</span>
              </div>
            </div>

            <div className="ai-summary-card glass-card">
              <div className="ai-summary-icon" style={{ backgroundColor: 'var(--color-warning-light)' }}>
                <Clock size={24} color="var(--color-warning)" />
              </div>
              <div className="ai-summary-content">
                <span className="ai-summary-value">{results.summary.in_progress}</span>
                <span className="ai-summary-label">In Progress</span>
              </div>
            </div>

            <div className="ai-summary-card glass-card">
              <div className="ai-summary-icon" style={{ backgroundColor: 'var(--color-danger-light)' }}>
                <XCircle size={24} color="var(--color-danger)" />
              </div>
              <div className="ai-summary-content">
                <span className="ai-summary-value">{results.summary.blocked}</span>
                <span className="ai-summary-label">Blocked</span>
              </div>
            </div>

            {(results.summary.not_mentioned || 0) > 0 && (
              <div className="ai-summary-card glass-card">
                <div className="ai-summary-icon" style={{ backgroundColor: 'rgba(128,128,128,0.15)' }}>
                  <AlertTriangle size={24} color="var(--text-secondary)" />
                </div>
                <div className="ai-summary-content">
                  <span className="ai-summary-value">{results.summary.not_mentioned}</span>
                  <span className="ai-summary-label">Not Mentioned</span>
                </div>
              </div>
            )}
          </div>

          {/* Per-Person Breakdown */}
          <div className="ai-person-section">
            <h2 className="section-title">Per-Person Analysis</h2>
            <div className="ai-person-grid">
              {(results.person_breakdown || []).map((person) => (
                <div key={person.name} className={`ai-person-card glass-card ${person.no_update_received ? 'ai-person-no-update' : ''}`}>
                  <div className="ai-person-header">
                    <h3 className="ai-person-name">@{person.name}</h3>
                    <div className="ai-person-stats">
                      {person.no_update_received ? (
                        <span className="ai-stat-badge ai-stat-danger">
                          No Update Received
                        </span>
                      ) : (
                        <span className="ai-stat-badge ai-stat-success">
                          {person.stats.completed}/{person.stats.total} done
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="ai-person-body">
                    {person.no_update_received && (
                      <div className="ai-task-group">
                        <span className="ai-task-group-label" style={{ color: 'var(--color-danger)' }}>
                          <AlertTriangle size={14} /> Assigned but no update shared ({person.assigned?.length || 0})
                        </span>
                        <ul className="ai-task-list">
                          {(person.assigned || []).map((task, idx) => (
                            <li key={idx} className="ai-task-item ai-task-not-mentioned">{task}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {!person.no_update_received && (person.completed?.length || 0) > 0 && (
                      <div className="ai-task-group">
                        <span className="ai-task-group-label" style={{ color: 'var(--color-success)' }}>
                          <CheckCircle size={14} /> Completed ({person.completed.length})
                        </span>
                        <ul className="ai-task-list">
                          {person.completed.map((task, idx) => (
                            <li key={idx} className="ai-task-item ai-task-completed">{task}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {!person.no_update_received && (person.pending?.length || 0) > 0 && (
                      <div className="ai-task-group">
                        <span className="ai-task-group-label" style={{ color: 'var(--color-warning)' }}>
                          <Clock size={14} /> In Progress / Pending ({person.pending.length})
                        </span>
                        <ul className="ai-task-list">
                          {person.pending.map((task, idx) => (
                            <li key={idx} className="ai-task-item ai-task-pending">{task}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {!person.no_update_received && (person.blocked?.length || 0) > 0 && (
                      <div className="ai-task-group">
                        <span className="ai-task-group-label" style={{ color: 'var(--color-danger)' }}>
                          <XCircle size={14} /> Blocked ({person.blocked.length})
                        </span>
                        <ul className="ai-task-list">
                          {person.blocked.map((task, idx) => (
                            <li key={idx} className="ai-task-item ai-task-blocked">{task}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {!person.no_update_received && (person.not_mentioned?.length || 0) > 0 && (
                      <div className="ai-task-group">
                        <span className="ai-task-group-label" style={{ color: 'var(--text-secondary)' }}>
                          <AlertCircle size={14} /> Not Mentioned ({person.not_mentioned!.length})
                        </span>
                        <ul className="ai-task-list">
                          {person.not_mentioned!.map((task, idx) => (
                            <li key={idx} className="ai-task-item ai-task-not-mentioned">{task}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Detailed Analysis */}
          <div className="ai-detail-section">
            <h2 className="section-title">Detailed AI Analysis</h2>
            <div className="ai-detail-table glass-card">
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Status</th>
                    <th>Confidence</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {results.analysis.map((item, idx) => (
                    <tr key={idx}>
                      <td className="ai-task-title">{item.task_title}</td>
                      <td>
                        <span
                          className="ai-status-badge"
                          style={{ backgroundColor: getStatusColor(item.detected_status) }}
                        >
                          {getStatusIcon(item.detected_status)}
                          {item.detected_status.replace('_', ' ')}
                        </span>
                      </td>
                      <td>
                        <div className="ai-confidence">
                          <div
                            className="ai-confidence-bar"
                            style={{
                              width: `${item.confidence * 100}%`,
                              backgroundColor: item.confidence > 0.7 ? 'var(--color-success)' : 'var(--color-warning)',
                            }}
                          />
                          <span className="ai-confidence-text">{Math.round(item.confidence * 100)}%</span>
                        </div>
                      </td>
                      <td className="ai-evidence">
                        {item.evidence.length > 0 ? (
                          <span className="ai-evidence-text">"{item.evidence[0]}"</span>
                        ) : (
                          <span className="ai-no-evidence">No direct evidence</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {/* YouTrack Match Confirmation Modal */}
      {matchResults && (
        <MatchConfirmationModal
          matches={matchResults.matches}
          unmatchedTasks={matchResults.unmatched_tasks}
          unmatchedIssues={matchResults.unmatched_issues}
          onClose={() => setMatchResults(null)}
          onSuccess={() => {
            setMatchResults(null)
            setSuccessMessage('YouTrack tickets updated successfully!')
            setTimeout(() => setSuccessMessage(null), 3000)
          }}
        />
      )}

      {/* Sync Recommendations Modal */}
      {syncRecommendations && (
        <div className="modal-overlay" onClick={() => setSyncRecommendations(null)}>
          <div className="sync-modal glass-card" onClick={(e) => e.stopPropagation()}>
            <div className="sync-modal-header">
              <h3><RefreshCw size={18} /> Sync Recommendations</h3>
              <span className="sync-modal-subtitle">
                {syncRecommendations.length} recommendation(s) based on AI analysis
              </span>
            </div>

            {syncRecommendations.length === 0 ? (
              <div className="sync-modal-empty">
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
                </div>
                <CheckCircle size={32} className="sync-empty-icon" />
                <p>Everything is in sync! No state changes needed.</p>
              </div>
            ) : (
              <div className="sync-modal-body">
                {syncRecommendations.map((rec) => (
                  <div
                    key={rec.issue_id}
                    className={`sync-rec-item ${rec.backward ? 'sync-backward' : ''} ${syncSelections[rec.issue_id] ? 'sync-selected' : ''}`}
                    onClick={() => setSyncSelections(prev => ({ ...prev, [rec.issue_id]: !prev[rec.issue_id] }))}
                  >
                    <div className="sync-rec-checkbox">
                      {syncSelections[rec.issue_id]
                        ? <CheckCircle size={18} className="sync-checkbox-checked" />
                        : <div className="sync-checkbox-unchecked" />
                      }
                    </div>
                    <div className="sync-rec-content">
                      <div className="sync-rec-title">
                        <span className="sync-rec-summary">{rec.summary}</span>
                        {rec.backward && (
                          <span className="sync-backward-badge">
                            <AlertTriangle size={12} /> Backward
                          </span>
                        )}
                      </div>
                      <div className="sync-rec-person">
                        {rec.person} &middot; {rec.issue_id}
                      </div>
                      <div className="sync-rec-states">
                        <span className="badge sync-rec-badge-sm">{rec.current_state}</span>
                        <ArrowRight size={14} className="sync-arrow" />
                        <span className={`badge ${rec.backward ? 'sync-rec-badge-backward' : 'sync-rec-badge-forward'}`}>
                          {rec.proposed_state}
                        </span>
                      </div>
                      <div className="sync-rec-reason">
                        {rec.reason}
                      </div>
                      <div className="sync-rec-confidence">
                        Confidence: {Math.round(rec.confidence * 100)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setSyncRecommendations(null)}>
                Cancel
              </button>
              {syncRecommendations.length > 0 && (
                <button
                  className="btn btn-primary"
                  onClick={handleApplySync}
                  disabled={applyingSync || Object.values(syncSelections).every(v => !v)}
                >
                  {applyingSync ? 'Applying...' : `Apply Selected (${Object.values(syncSelections).filter(Boolean).length})`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
