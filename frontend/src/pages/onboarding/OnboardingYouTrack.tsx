import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Link2, CheckCircle2 } from 'lucide-react'
import api from '@/services/api'
import { CustomDropdown } from '@/components/CustomDropdown'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { YouTrackSyncIcon } from '@/components/YouTrackSyncIcon'

export default function OnboardingYouTrack({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [baseUrl,       setBaseUrl]       = useState('')
  const [token,         setToken]         = useState('')
  const [projects,      setProjects]      = useState<Array<{ id: string; name: string }>>([])
  const [projectId,     setProjectId]     = useState('')
  const [boards,        setBoards]        = useState<Array<{ id: string; name: string }>>([])
  const [boardId,       setBoardId]       = useState('')
  const [boardsLoading, setBoardsLoading] = useState(false)
  const [probing,       setProbing]       = useState(false)
  const [probed,        setProbed]        = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [saving,        setSaving]        = useState(false)
  const [saved,         setSaved]         = useState(false)
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (probeTimer.current) clearTimeout(probeTimer.current)
    setProbed(false); setError(null); setProjects([]); setProjectId(''); setBoards([]); setBoardId('')
    if (!baseUrl.trim() || !token.trim()) return
    probeTimer.current = setTimeout(async () => {
      setProbing(true); setError(null)
      try {
        const res = await api.probeYouTrack(baseUrl.trim(), token.trim())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = res as any
        if (r?.success === false) {
          setError(r?.message ?? 'Cannot connect — check URL and token')
          return
        }
        const raw: Array<{ id: string; name: string; shortName: string }> = r?.data ?? []
        setProjects(raw.filter(p => p.shortName).map(p => ({ id: p.shortName, name: `${p.name} (${p.shortName})` })))
        setProbed(true)
      } catch {
        setError('Cannot connect — check URL and token')
      } finally {
        setProbing(false)
      }
    }, 1000)
    return () => { if (probeTimer.current) clearTimeout(probeTimer.current) }
  }, [baseUrl, token])

  const handleProjectSelect = async (id: string) => {
    setProjectId(id)
    setBoardId(''); setBoards([])
    if (!id) return
    setBoardsLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await api.probeYouTrackBoards(baseUrl.trim(), token.trim(), id) as any
      if (res?.success === false) return // boards are optional — silent
      const raw: Array<{ id: string; name: string }> = res?.data ?? []
      setBoards(Array.isArray(raw) ? raw : [])
    } catch { /* boards optional */ }
    finally { setBoardsLoading(false) }
  }

  const handleSave = async () => {
    if (!baseUrl.trim() || !token.trim() || !projectId.trim()) return
    setSaving(true); setError(null)
    try {
      const res = await api.saveYouTrackIntegration({
        base_url: baseUrl.trim(),
        token: token.trim(),
        project_id: projectId.trim(),
        board_id: boardId.trim() || undefined,
      })
      if (res.success) { setSaved(true); setTimeout(onNext, 900) }
      else setError('Failed to save')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <motion.div
      className="ob-step ob-step-connect ob-step-connect--yt"
      initial={{ opacity: 0, x: 24, filter: 'blur(4px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: -24, filter: 'blur(4px)' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <div className="ob-connect-visual">
        <div className="ob-connect-node ob-connect-node--brand">
          <VelocityLogo variant="icon" size="sm" mark="chevron" showStatusDot={false} />
        </div>
        <svg className="ob-connect-line" viewBox="0 0 120 4" preserveAspectRatio="none">
          <motion.line
            x1="0" y1="2" x2="120" y2="2"
            strokeWidth="2" strokeDasharray="6 6"
            className={probed ? 'ob-connect-line-path ob-connect-line-path--active' : 'ob-connect-line-path'}
            animate={probed ? { strokeDashoffset: [0, -24] } : {}}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          />
        </svg>
        <div className="ob-connect-node ob-connect-node--target ob-connect-node--yt-logo">
          <YouTrackSyncIcon size={24} scanning={probing} />
        </div>
      </div>

      <h2 className="ob-heading">Connect YouTrack</h2>
      <p className="ob-sub">Link your YouTrack instance so tickets, sprints, and boards sync automatically.</p>

      <div className="ob-form">
        <input
          className="ob-input"
          placeholder="YouTrack URL (e.g. https://yourteam.youtrack.cloud)"
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          autoComplete="off"
        />
        <input
          className="ob-input"
          type="password"
          placeholder="Permanent token"
          value={token}
          onChange={e => setToken(e.target.value)}
          autoComplete="off"
        />
        {probing && <div className="ob-hint">Checking connection…</div>}
        {error && <div className="ob-error">{error}</div>}
        {projects.length > 0 && (
          <CustomDropdown
            options={projects.map(p => ({ value: p.id, label: p.name }))}
            value={projectId}
            onChange={handleProjectSelect}
            placeholder="Select a project"
          />
        )}
        {projectId && (boardsLoading || boards.length > 0) && (
          <CustomDropdown
            options={boards.map(b => ({ value: b.id, label: b.name }))}
            value={boardId}
            onChange={setBoardId}
            placeholder={boardsLoading ? 'Loading boards…' : boards.length === 0 ? 'No boards for this project' : 'Select a board (optional)'}
          />
        )}
      </div>

      <div className="ob-actions">
        <button className="ob-btn ob-btn-ghost" onClick={onSkip}>Skip for now</button>
        <motion.button
          className="ob-btn ob-btn-primary"
          disabled={!projectId || saving}
          onClick={handleSave}
          whileHover={{ scale: projectId ? 1.03 : 1 }}
          whileTap={{ scale: projectId ? 0.97 : 1 }}
        >
          {saved ? <><CheckCircle2 size={16} /> Connected</> : saving ? 'Connecting…' : <><Link2 size={16} /> Connect</>}
        </motion.button>
      </div>
    </motion.div>
  )
}
