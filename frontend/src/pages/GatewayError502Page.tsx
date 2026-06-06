import { useCallback, useEffect, useRef, useState } from 'react'
import { KanbanSquare, RefreshCw, Wifi } from 'lucide-react'
import { useGatewayError } from '@/contexts/GatewayErrorContext'

const DEPLOY_MESSAGES = [
  'Deploying something new — hang tight.',
  'The server is warming up... like a slow Monday morning.',
  'Reticulating splines in the backend.',
  'kubectl apply -f greatness.yaml is running.',
  'Docker container woke up and chose chaos (briefly).',
  'npm install vibes — almost there.',
  'Database migrations chugging along.',
  'Compiling the good stuff.',
  'Patience — shipping code, not pizza.',
  'CI passed. Deploy is catching up.',
  'Server had a nap. We\'re waking it up.',
  'Spinning up fresh containers.',
]

const RETRY_DELAYS = [5, 10, 20, 40]
const MAX_AUTO_RETRIES = RETRY_DELAYS.length

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api'

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

export default function GatewayError502Page() {
  const { clear } = useGatewayError()
  const [attempt, setAttempt] = useState(0)
  const [countdown, setCountdown] = useState(RETRY_DELAYS[0])
  const [msgQueue] = useState(() => shuffle(DEPLOY_MESSAGES))
  const [msgIndex, setMsgIndex] = useState(0)
  const [checking, setChecking] = useState(false)
  const [gaveUp, setGaveUp] = useState(false)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const msgRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const probe = useCallback(async () => {
    setChecking(true)
    try {
      const res = await fetch(`${API_URL}/health`, { method: 'GET', cache: 'no-store' })
      if (res.ok || res.status < 500) {
        clear()
        return true
      }
    } catch {
      // still down
    }
    setChecking(false)
    return false
  }, [clear])

  const scheduleNext = useCallback((attemptNum: number) => {
    if (attemptNum >= MAX_AUTO_RETRIES) {
      setGaveUp(true)
      return
    }
    const delay = RETRY_DELAYS[attemptNum]
    setCountdown(delay)
    if (countdownRef.current) clearInterval(countdownRef.current)
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current!)
          setAttempt(a => {
            const next = a + 1
            probe().then(ok => { if (!ok) scheduleNext(next) })
            return next
          })
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [probe])

  useEffect(() => {
    scheduleNext(0)
    msgRef.current = setInterval(() => {
      setMsgIndex(i => (i + 1) % msgQueue.length)
    }, 3500)
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
      if (msgRef.current) clearInterval(msgRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleManualRetry = async () => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    const ok = await probe()
    if (!ok) {
      const nextAttempt = attempt + 1
      setAttempt(nextAttempt)
      if (nextAttempt < MAX_AUTO_RETRIES) {
        scheduleNext(nextAttempt)
      } else {
        setGaveUp(true)
      }
    }
  }

  const pct = gaveUp ? 100 : ((RETRY_DELAYS[attempt] - countdown) / RETRY_DELAYS[attempt]) * 100

  return (
    <div className="g5-root">
      <div className="g5-blob g5-blob-1" />
      <div className="g5-blob g5-blob-2" />

      <div className="g5-card">
        <div className="g5-wordmark">
          <KanbanSquare size={18} />
          <span>Velocity</span>
        </div>

        <div className="g5-icon-wrap">
          <Wifi size={36} className={checking ? 'g5-icon-pulse' : ''} />
        </div>

        <h1 className="g5-heading">Server Unreachable</h1>

        <p className="g5-message">{msgQueue[msgIndex]}</p>

        {!gaveUp && (
          <div className="g5-progress-wrap">
            <div className="g5-progress-bar">
              <div className="g5-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="g5-countdown">
              {checking
                ? 'Checking…'
                : `Retry ${attempt + 1} of ${MAX_AUTO_RETRIES} in ${countdown}s`}
            </span>
          </div>
        )}

        {gaveUp && (
          <p className="g5-gave-up">
            Still having trouble reaching the server. It may be a longer deployment.
          </p>
        )}

        <div className="g5-actions">
          <button
            className="g5-btn-retry"
            onClick={handleManualRetry}
            disabled={checking}
          >
            <RefreshCw size={14} className={checking ? 'g5-spin' : ''} />
            {checking ? 'Checking…' : 'Retry now'}
          </button>
        </div>

        <p className="g5-footnote">
          502 · Bad Gateway · Auto-retrying
        </p>
      </div>
    </div>
  )
}
