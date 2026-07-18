import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Archive, RotateCcw, ExternalLink } from 'lucide-react'
import { useIgnoredBlockedSafe } from '@/contexts/IgnoredBlockedContext'
import api from '@/services/api'

// ── YouTrack base URL singleton ──────────────────────────────────────────────
let _ytBaseUrl = ''
let _ytFetchStarted = false
function getYtBaseUrl(): string { return _ytBaseUrl }
function fetchYtBaseUrlOnce(onReady: (url: string) => void) {
  if (_ytBaseUrl) { onReady(_ytBaseUrl); return }
  if (_ytFetchStarted) return
  _ytFetchStarted = true
  api.getYouTrackStatus()
    .then(res => {
      const url = ((res as any).base_url || (res as any).data?.base_url || '').replace(/\/$/, '')
      _ytBaseUrl = url
      onReady(url)
    })
    .catch(() => { _ytFetchStarted = false })
}

// ── Global card state singleton ──────────────────────────────────────────────
type CardState = {
  content: React.ReactNode
  issueId?: string
  isBlocked?: boolean
  summary?: string
  contentKey: string
}

let _setGlobalState: ((s: CardState | null) => void) | null = null
let _hideTimer: ReturnType<typeof setTimeout> | null = null
let _counter = 0

function showGlobalCard(state: Omit<CardState, 'contentKey'> & { contentKey?: string }) {
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null }
  _setGlobalState?.({
    ...state,
    contentKey: state.contentKey ?? state.issueId ?? String(++_counter),
  })
}

function hideGlobalCard(delay = 3500) {
  if (_hideTimer) clearTimeout(_hideTimer)
  _hideTimer = setTimeout(() => {
    _setGlobalState?.(null)
    _hideTimer = null
  }, delay)
}

function cancelHideGlobalCard() {
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null }
}

// ── ParkButton ───────────────────────────────────────────────────────────────
function ParkButton({ issueId }: { issueId: string }) {
  const ctx = useIgnoredBlockedSafe()
  if (!ctx) return null
  const { ignoredIds, ignoreTicket, unignoreTicket } = ctx
  const isParked = ignoredIds.has(issueId)
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isParked) unignoreTicket(issueId)
    else { ignoreTicket(issueId); _setGlobalState?.(null) }
  }
  return (
    <button className={`hc-park-btn${isParked ? ' hc-park-btn--parked' : ''}`} onClick={handleClick}>
      {isParked ? <><RotateCcw size={10} /> Unpark</> : <><Archive size={10} /> Park</>}
    </button>
  )
}

// ── GlobalHoverCard — mount once in Dashboard ────────────────────────────────
export function GlobalHoverCard() {
  const [state, setState] = useState<CardState | null>(null)
  const [ytUrl, setYtUrl] = useState(getYtBaseUrl)

  useEffect(() => {
    _setGlobalState = setState
    fetchYtBaseUrlOnce(setYtUrl)
    return () => { _setGlobalState = null }
  }, [])

  const ytHref = state?.issueId && ytUrl ? `${ytUrl}/issue/${state.issueId}` : null

  return createPortal(
    <AnimatePresence>
      {state && (
        <motion.div
          className="hc-card hc-card--below"
          style={{ position: 'fixed', left: 8, top: 8, maxWidth: 300, zIndex: 99999 }}
          initial={{ opacity: 0, y: -6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.97 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onMouseEnter={cancelHideGlobalCard}
          onMouseLeave={() => hideGlobalCard()}
        >
          {/* Content crossfades when key changes */}
          <AnimatePresence mode="wait">
            <motion.div
              key={state.contentKey}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
            >
              {state.content}
              {state.issueId && (
                <>
                  <div className="hc-divider" style={{ margin: '8px 0 6px' }} />
                  <div className="hc-footer">
                    {ytHref ? (
                      <a
                        className="hc-footer-id"
                        href={ytHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                      >
                        <ExternalLink size={10} />
                        {state.issueId}
                      </a>
                    ) : (
                      <span className="hc-footer-id hc-footer-id--plain">{state.issueId}</span>
                    )}
                    {state.summary && <span className="hc-footer-summary">{state.summary}</span>}
                    {state.isBlocked && <ParkButton issueId={state.issueId} />}
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

// ── HoverCard — wraps any trigger element ────────────────────────────────────
interface HoverCardProps {
  content: React.ReactNode | null
  children: React.ReactNode
  delay?: number
  maxWidth?: number
  issueId?: string
  isBlocked?: boolean
  summary?: string
}

export default function HoverCard({
  content, children, delay = 280, issueId, isBlocked, summary,
}: HoverCardProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleEnter = useCallback(() => {
    if (!content && !issueId) return
    cancelHideGlobalCard()
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      showGlobalCard({ content, issueId, isBlocked, summary })
    }, delay)
  }, [content, issueId, isBlocked, summary, delay])

  const handleLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    hideGlobalCard()
  }, [])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return (
    <div onMouseEnter={handleEnter} onMouseLeave={handleLeave} style={{ display: 'contents' }}>
      {children}
    </div>
  )
}

// ── Reusable content blocks ──────────────────────────────────────────────────
export function HCRow({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="hc-row">
      <span className="hc-label">{label}</span>
      <span className={`hc-value${accent ? ` hc-value--${accent}` : ''}`}>{value}</span>
    </div>
  )
}

export function HCBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="hc-bar-track">
      <div className="hc-bar-fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
    </div>
  )
}

export function HCDivider() {
  return <div className="hc-divider" />
}

export function HCBadge({ label, variant }: { label: string; variant?: 'dev' | 'stg' | 'prd' | 'warn' | 'danger' | 'ok' }) {
  return <span className={`hc-badge${variant ? ` hc-badge--${variant}` : ''}`}>{label}</span>
}
