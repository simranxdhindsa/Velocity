import { useState, useEffect } from 'react'
import api from '../services/api'
import { SprintScanLoader } from '@/components/brand/VelocityLoaders'
import type {
  TeamProductivityReport,
  IndividualReport,
  ProjectHealthReport
} from '../services/api'

type ReportView = 'team' | 'individual' | 'health' | 'accuracy'

export function ReportsPage() {
  const [activeView, setActiveView] = useState<ReportView>('team')
  const [loading, setLoading] = useState(true)
  const [teamData, setTeamData] = useState<TeamProductivityReport | null>(null)
  const [individualData, setIndividualData] = useState<IndividualReport | null>(null)
  const [healthData, setHealthData] = useState<ProjectHealthReport | null>(null)
  const [accuracyData, setAccuracyData] = useState<{ match_rate: number; discrepancies: number; total_comparisons: number } | null>(null)
  const [dateRange, setDateRange] = useState('7d')

  useEffect(() => {
    fetchReportData()
  }, [activeView, dateRange])

  const fetchReportData = async () => {
    try {
      setLoading(true)
      switch (activeView) {
        case 'team':
          const teamResponse = await api.getTeamProductivity()
          if (teamResponse.success && teamResponse.data) {
            setTeamData(teamResponse.data)
          }
          break
        case 'individual':
          const indResponse = await api.getIndividualReport('current')
          if (indResponse.success && indResponse.data) {
            setIndividualData(indResponse.data)
          }
          break
        case 'health':
          const healthResponse = await api.getProjectHealth()
          if (healthResponse.success && healthResponse.data) {
            setHealthData(healthResponse.data)
          }
          break
        case 'accuracy':
          // Use the slack accuracy endpoint
          const response = await fetch('/api/reports/slack-accuracy', {
            headers: {
              'Authorization': `Bearer ${api.getToken()}`,
            }
          })
          const data = await response.json()
          if (data.success && data.data) {
            setAccuracyData(data.data)
          }
          break
      }
    } catch (err) {
      console.error('Error fetching report data:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleExport = async (format: 'pdf' | 'csv') => {
    // In a real implementation, this would download the file
    alert(`Export as ${format.toUpperCase()} - This would download the report`)
  }

  const renderTeamReport = () => {
    if (!teamData) return null

    return (
      <div className="report-section">
        <div className="report-stats-grid">
          <div className="stat-card glass-card">
            <div className="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-value">{teamData.tasks_completed}</span>
              <span className="stat-label">Tasks Completed</span>
            </div>
          </div>
          <div className="stat-card glass-card">
            <div className="stat-icon icon-blue">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-value">{teamData.tasks_created}</span>
              <span className="stat-label">Tasks Created</span>
            </div>
          </div>
          <div className="stat-card glass-card">
            <div className="stat-icon icon-purple">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-value">{teamData.completion_rate}%</span>
              <span className="stat-label">Completion Rate</span>
            </div>
          </div>
        </div>

        <div className="chart-container glass-card">
          <h3>Daily Productivity</h3>
          <div className="simple-chart">
            {teamData.daily_data.map((day, index) => (
              <div key={index} className="chart-bar-group">
                <div
                  className="chart-bar"
                  style={{
                    height: `${Math.max(10, (day.completed / Math.max(...teamData.daily_data.map(d => d.completed))) * 100)}%`
                  }}
                >
                  <span className="bar-value">{day.completed}</span>
                </div>
                <span className="bar-label">
                  {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const renderIndividualReport = () => {
    if (!individualData) return null

    const completionPercentage = Math.round(
      (individualData.tasks_completed / individualData.tasks_assigned) * 100
    )

    return (
      <div className="report-section">
        <div className="report-stats-grid">
          <div className="stat-card glass-card">
            <div className="stat-content">
              <span className="stat-value">{individualData.tasks_completed}</span>
              <span className="stat-label">Completed</span>
            </div>
          </div>
          <div className="stat-card glass-card">
            <div className="stat-content">
              <span className="stat-value">{individualData.tasks_assigned}</span>
              <span className="stat-label">Assigned</span>
            </div>
          </div>
          <div className="stat-card glass-card">
            <div className="stat-content">
              <span className="stat-value">{individualData.completion_rate}%</span>
              <span className="stat-label">Completion Rate</span>
            </div>
          </div>
        </div>

        <div className="progress-container glass-card">
          <h3>Your Progress</h3>
          <div className="progress-ring">
            <svg viewBox="0 0 100 100">
              <circle
                className="progress-bg"
                cx="50"
                cy="50"
                r="45"
                fill="none"
                strokeWidth="10"
              />
              <circle
                className="progress-fill"
                cx="50"
                cy="50"
                r="45"
                fill="none"
                strokeWidth="10"
                strokeDasharray={`${completionPercentage * 2.83} 283`}
                transform="rotate(-90 50 50)"
              />
            </svg>
            <div className="progress-text">
              <span className="progress-value">{completionPercentage}%</span>
              <span className="progress-label">Complete</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderHealthReport = () => {
    if (!healthData) return null

    const getHealthColor = (score: number) => {
      if (score >= 80) return 'var(--color-success)'
      if (score >= 50) return 'var(--color-warning)'
      return 'var(--color-danger)'
    }

    return (
      <div className="report-section">
        <div className="health-score glass-card">
          <h3>Project Health Score</h3>
          <div className="score-display">
            <div
              className="score-circle"
              style={{
                background: `conic-gradient(${getHealthColor(healthData.health_score)} ${healthData.health_score}%, rgba(255,255,255,0.1) ${healthData.health_score}%)`
              }}
            >
              <div className="score-inner">
                <span className="score-value">{healthData.health_score}</span>
                <span className="score-label">/ 100</span>
              </div>
            </div>
          </div>
        </div>

        <div className="report-stats-grid">
          <div className="stat-card glass-card stat-danger">
            <div className="stat-content">
              <span className="stat-value">{healthData.overdue_tasks}</span>
              <span className="stat-label">Overdue Tasks</span>
            </div>
          </div>
          <div className="stat-card glass-card stat-warning">
            <div className="stat-content">
              <span className="stat-value">{healthData.blocked_tasks}</span>
              <span className="stat-label">Blocked Tasks</span>
            </div>
          </div>
          <div className="stat-card glass-card stat-success">
            <div className="stat-content">
              <span className="stat-value">{healthData.on_track_tasks}</span>
              <span className="stat-label">On Track</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderAccuracyReport = () => {
    if (!accuracyData) return null

    return (
      <div className="report-section">
        <div className="accuracy-display glass-card">
          <h3>Slack vs Asana Accuracy</h3>
          <p className="accuracy-description">
            How often does the AI-detected status from Slack match the actual Asana status?
          </p>
          <div className="accuracy-meter">
            <div
              className="accuracy-fill"
              style={{ width: `${accuracyData.match_rate}%` }}
            />
            <span className="accuracy-value">{accuracyData.match_rate}%</span>
          </div>
        </div>

        <div className="report-stats-grid cols-2">
          <div className="stat-card glass-card">
            <div className="stat-content">
              <span className="stat-value">{accuracyData.total_comparisons}</span>
              <span className="stat-label">Total Comparisons</span>
            </div>
          </div>
          <div className="stat-card glass-card stat-warning">
            <div className="stat-content">
              <span className="stat-value">{accuracyData.discrepancies}</span>
              <span className="stat-label">Discrepancies Found</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="reports-page">
      <div className="page-header">
        <div className="header-left">
          <h1 className="page-title">Reports & Analytics</h1>
          <p className="page-subtitle">Track team productivity and project health</p>
        </div>
        <div className="header-right">
          <select
            className="date-range-select"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
          <div className="export-buttons">
            <button className="btn btn-ghost" onClick={() => handleExport('pdf')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              PDF
            </button>
            <button className="btn btn-ghost" onClick={() => handleExport('csv')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              CSV
            </button>
          </div>
        </div>
      </div>

      <div className="report-tabs">
        <button
          className={`tab ${activeView === 'team' ? 'active' : ''}`}
          onClick={() => setActiveView('team')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          Team Productivity
        </button>
        <button
          className={`tab ${activeView === 'individual' ? 'active' : ''}`}
          onClick={() => setActiveView('individual')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          Individual Stats
        </button>
        <button
          className={`tab ${activeView === 'health' ? 'active' : ''}`}
          onClick={() => setActiveView('health')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          Project Health
        </button>
        <button
          className={`tab ${activeView === 'accuracy' ? 'active' : ''}`}
          onClick={() => setActiveView('accuracy')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          AI Accuracy
        </button>
      </div>

      <div className="report-content">
        {loading ? (
          <div className="loading-state">
            <SprintScanLoader size={48} />
            <p>Loading report data...</p>
          </div>
        ) : (
          <>
            {activeView === 'team' && renderTeamReport()}
            {activeView === 'individual' && renderIndividualReport()}
            {activeView === 'health' && renderHealthReport()}
            {activeView === 'accuracy' && renderAccuracyReport()}
          </>
        )}
      </div>
    </div>
  )
}
