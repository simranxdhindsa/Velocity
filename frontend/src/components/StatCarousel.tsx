import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Clock,
  ShieldAlert,
  CheckCircle,
  Layers,
  User,
  ArrowRight,
  Pause,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import api from '@/services/api'
import type { YouTrackSprint, SprintBoardStatusResponse } from '@/services/api'
import '@/styles/components/stat-carousel.css'

export interface StatCarouselProps {
  onNavigate: (page: string) => void
}

interface CarouselData {
  daysLeft: number
  hoursLeft: number
  sprintName: string
  sprintFinishMs: number
  blockedCount: number
  completionPct: number
  doneIssues: number
  totalIssues: number
  myActive: number
  myBlocked: number
}

const ROTATE_MS = 7000

function getCountdownAccent(daysLeft: number, hoursLeft: number): string {
  const totalHours = daysLeft * 24 + hoursLeft
  if (totalHours < 6) return 'var(--color-danger)'
  if (daysLeft < 2) return 'var(--color-warning)'
  return 'var(--color-success)'
}

function formatCountdown(daysLeft: number, hoursLeft: number): { main: string; sub: string } {
  if (daysLeft > 0) {
    return { main: `${daysLeft}d ${hoursLeft}h`, sub: 'until sprint ends' }
  }
  return { main: `${hoursLeft}h`, sub: 'until sprint ends' }
}

export function StatCarousel({ onNavigate }: StatCarouselProps) {
  const { user } = useAuth()
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<CarouselData | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch data on mount — respects the sprint selected across all pages
  useEffect(() => {
    let cancelled = false

    async function fetchData() {
      try {
        const sprintsRes = await api.getYouTrackSprints()
        if (cancelled) return

        const sprints: YouTrackSprint[] = sprintsRes.data ?? []
        const savedId = localStorage.getItem('pm_active_sprint_id')
        const activeSprint = (savedId ? sprints.find(s => s.id === savedId) : null)
          ?? sprints.find(s => !s.isCompleted)

        if (!activeSprint) {
          setLoading(false)
          return
        }

        const sprintFinishMs = activeSprint.finish
        const sprintName = activeSprint.name
        const now = Date.now()
        const remainingMs = Math.max(0, sprintFinishMs - now)
        const totalHours = Math.floor(remainingMs / (1000 * 60 * 60))
        const daysLeft = Math.floor(totalHours / 24)
        const hoursLeft = totalHours % 24

        const boardRes = await api.getSprintBoardStatus({
          sprint_id: activeSprint.id,
          sprint_finish_ms: sprintFinishMs,
        })
        if (cancelled) return

        const boardData: SprintBoardStatusResponse = boardRes.data
        const summary = boardData.summary

        const isBlocked = (col: string) => col.toLowerCase().includes('block')
        const isActive  = (col: string) => {
          const n = col.toLowerCase()
          return n.includes('progress') || n === 'active' || n.includes('working')
        }

        // Flexible name match: exact → case-insensitive → first-name-only
        const matchesMe = (assignee: string): boolean => {
          if (!user?.name) return false
          if (assignee === user.name) return true
          if (assignee.toLowerCase() === user.name.toLowerCase()) return true
          const myFirst = user.name.split(' ')[0].toLowerCase()
          const theirFirst = assignee.split(' ')[0].toLowerCase()
          return myFirst.length > 2 && myFirst === theirFirst
        }

        let myActive = 0
        let myBlocked = 0

        if (user?.name) {
          for (const col of boardData.columns) {
            for (const issue of col.issues) {
              if (matchesMe(issue.assignee || '')) {
                if (isBlocked(col.name)) myBlocked++
                else if (isActive(col.name)) myActive++
              }
            }
          }
        }

        if (!cancelled) {
          setData({
            daysLeft,
            hoursLeft,
            sprintName,
            sprintFinishMs,
            blockedCount: summary.blocked_count,
            completionPct: summary.completion_pct,
            doneIssues: summary.done_issues,
            totalIssues: summary.total_issues,
            myActive,
            myBlocked,
          })
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }

    fetchData()
    return () => { cancelled = true }
  }, [user?.name])

  // Auto-advance timer
  useEffect(() => {
    if (paused) {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
      return
    }
    timerRef.current = setInterval(() => {
      setIndex(i => (i + 1) % 5)
    }, ROTATE_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [paused])

  const handleDotClick = useCallback((i: number) => {
    setIndex(i)
  }, [])

  const handlePillClick = useCallback(() => {
    if (!data) return
    const targets = ['dashboard', 'pm-reports', 'pm-reports', 'sprint-dashboard', 'daily-ops']
    onNavigate(targets[index] ?? 'dashboard')
  }, [index, onNavigate, data])

  if (loading) {
    return (
      <div className="sc-wrapper">
        <div className="sc-pill sc-pill--loading">
          <div className="sc-skeleton sc-skeleton--icon" />
          <div className="sc-skeleton sc-skeleton--text" />
        </div>
      </div>
    )
  }

  if (!data) {
    return null
  }

  const countdownAccent = getCountdownAccent(data.daysLeft, data.hoursLeft)
  const countdown = formatCountdown(data.daysLeft, data.hoursLeft)
  const blockerAccent = data.blockedCount === 0 ? 'var(--color-success)' : 'var(--color-danger)'

  const slides = [
    {
      key: 'countdown',
      accent: countdownAccent,
      icon: <Clock size={16} />,
      main: countdown.main,
      sub: countdown.sub,
      target: 'dashboard',
    },
    {
      key: 'blockers',
      accent: blockerAccent,
      icon: <ShieldAlert size={16} />,
      main: `${data.blockedCount} blocked`,
      sub: data.blockedCount === 0 ? 'all clear' : 'need attention',
      target: 'pm-reports',
    },
    {
      key: 'completion',
      accent: 'var(--color-primary)',
      icon: <CheckCircle size={16} />,
      main: `${Math.round(data.completionPct)}%`,
      sub: `${data.doneIssues} of ${data.totalIssues} done`,
      target: 'pm-reports',
      showProgress: true,
      progressPct: data.totalIssues > 0 ? (data.doneIssues / data.totalIssues) * 100 : 0,
    },
    {
      key: 'sprint',
      accent: '#8b5cf6',
      icon: <Layers size={16} />,
      main: data.sprintName,
      sub: 'active sprint',
      target: 'sprint-dashboard',
    },
    {
      key: 'myload',
      accent: 'var(--color-info)',
      icon: <User size={16} />,
      main: `${data.myActive} active`,
      sub: data.myBlocked > 0 ? `${data.myBlocked} blocked` : 'no blockers',
      target: 'daily-ops',
    },
  ]

  const slide = slides[index]

  return (
    <div className="sc-wrapper">
      <div
        className="sc-pill"
        style={{ '--sc-accent': slide.accent } as React.CSSProperties}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onClick={handlePillClick}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handlePillClick() }}
        aria-label={`Sprint stat: ${slide.main} — ${slide.sub}`}
      >
        {/* Left accent bar */}
        <div className="sc-accent-bar" />

        {/* Slide content — key changes trigger animation */}
        <div className="sc-content" key={slide.key}>
          <span className="sc-icon">{slide.icon}</span>
          <span className="sc-main">{slide.main}</span>
          <span className="sc-dot-sep">·</span>
          <span className="sc-sub">{slide.sub}</span>
          <span className="sc-arrow">
            {paused ? <Pause size={11} /> : <ArrowRight size={11} />}
          </span>
        </div>

        {/* Segmented progress bar — always at bottom, replaces external dots */}
        <div className="sc-seg-bar">
          {slides.map((s, i) => (
            <button
              key={s.key}
              className={`sc-seg${i === index ? ' sc-seg--active' : ''}`}
              style={i === index ? { '--sc-accent': slide.accent } as React.CSSProperties : undefined}
              onClick={e => { e.stopPropagation(); handleDotClick(i) }}
              aria-label={`Slide ${i + 1}`}
            />
          ))}
        </div>

        {/* Completion progress fill — only on completion slide, above seg bar */}
        {slide.showProgress && (
          <div className="sc-progress-track">
            <div
              className="sc-progress-fill"
              style={{ '--sc-progress-pct': `${slide.progressPct}%` } as React.CSSProperties}
            />
          </div>
        )}
      </div>
    </div>
  )
}
