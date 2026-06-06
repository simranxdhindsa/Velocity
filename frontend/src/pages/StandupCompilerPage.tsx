import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, Plus, X, RefreshCw, Send, Hash, ChevronLeft, ChevronRight, Copy, Check } from 'lucide-react'
import { standupApi, type StandupConfig, type PersonUpdate, type UpdateSection } from '@/services/api'
import { CalendarPicker } from '@/components/CalendarPicker'
import '../styles/pages/standup-compiler.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api'

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token')
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' }
}

interface SlackChannel { id: string; name: string }

// ── Week helpers ──────────────────────────────────────────────────────────────

function getMondayOf(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const day = d.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day
  const mon = new Date(d)
  mon.setDate(d.getDate() + diff)
  return mon.toISOString().slice(0, 10)
}

function getFridayOf(mondayStr: string): string {
  const d = new Date(mondayStr + 'T00:00:00')
  d.setDate(d.getDate() + 4)
  return d.toISOString().slice(0, 10)
}

function fmtWeekLabel(mondayStr: string): string {
  const mon = new Date(mondayStr + 'T00:00:00')
  const fri = new Date(mondayStr + 'T00:00:00')
  fri.setDate(fri.getDate() + 4)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  return `${mon.toLocaleDateString('en-US', opts)} – ${fri.toLocaleDateString('en-US', { ...opts, year: 'numeric' })}`
}

function shiftWeek(mondayStr: string, delta: number): string {
  const d = new Date(mondayStr + 'T00:00:00')
  d.setDate(d.getDate() + delta * 7)
  return d.toISOString().slice(0, 10)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function StandupCompilerPage() {
  const today = new Date().toISOString().slice(0, 10)

  // Mode: daily | weekly
  const [mode, setMode] = useState<'daily' | 'weekly'>('daily')

  // Config
  const [configOpen, setConfigOpen] = useState(true)
  const [cfg, setCfg] = useState<StandupConfig>({
    source_channels: [],
    dest_channel_id: '',
    dest_channel_name: '',
    time_window_start: '14:00',
    time_window_end: '23:59',
  })
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  // Slack channels list
  const [allChannels, setAllChannels] = useState<SlackChannel[]>([])
  const [srcPickerOpen, setSrcPickerOpen] = useState(false)
  const [destPickerOpen, setDestPickerOpen] = useState(false)
  const srcRef = useRef<HTMLDivElement>(null)
  const destRef = useRef<HTMLDivElement>(null)

  // Manual add for source channels
  const [manualSrcId, setManualSrcId] = useState('')
  const [manualSrcName, setManualSrcName] = useState('')

  // Compile
  const [compileDate, setCompileDate] = useState(today)
  const [compiling, setCompiling] = useState(false)
  const [compileError, setCompileError] = useState('')
  const [channelWarnings, setChannelWarnings] = useState<string[]>([])
  const [updates, setUpdates] = useState<PersonUpdate[]>([])
  const [parseProgress, setParseProgress] = useState<{ current: number; total: number; name: string; countdown: number } | null>(null)
  const parseAbortRef = useRef(false)
  const [cancelled, setCancelled] = useState(false)

  // Post
  const [posting, setPosting] = useState(false)
  const [postMsg, setPostMsg] = useState('')

  // Weekly
  const [weeklyMonday, setWeeklyMonday] = useState(() => getMondayOf(today))
  const [weeklyCompiling, setWeeklyCompiling] = useState(false)
  const [weeklyError, setWeeklyError] = useState('')
  const [weeklyWarnings, setWeeklyWarnings] = useState<string[]>([])
  const [weeklyItems, setWeeklyItems] = useState<string[]>([])
  const [weeklyPosting, setWeeklyPosting] = useState(false)
  const [weeklyPostMsg, setWeeklyPostMsg] = useState('')
  const [weeklyCopied, setWeeklyCopied] = useState(false)
  const [weeklyCalDate, setWeeklyCalDate] = useState(today)

  useEffect(() => {
    standupApi.getConfig().then(r => { if (r.success) setCfg(r.config) }).catch(() => {})
    fetch(`${API_URL}/slack/channels`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.channels) setAllChannels(d.channels)
        else if (Array.isArray(d)) setAllChannels(d)
      })
      .catch(() => {})
  }, [])

  // Close pickers on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (srcRef.current && !srcRef.current.contains(e.target as Node)) setSrcPickerOpen(false)
      if (destRef.current && !destRef.current.contains(e.target as Node)) setDestPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  function addSourceChannel(ch: SlackChannel) {
    if (!ch.id || cfg.source_channels.some(s => s.id === ch.id)) return
    setCfg(c => ({ ...c, source_channels: [...c.source_channels, { id: ch.id, name: ch.name }] }))
    setSrcPickerOpen(false)
  }

  function addManualSourceChannel() {
    const id = manualSrcId.trim()
    if (!id || cfg.source_channels.some(s => s.id === id)) return
    setCfg(c => ({ ...c, source_channels: [...c.source_channels, { id, name: manualSrcName.trim() || id }] }))
    setManualSrcId('')
    setManualSrcName('')
  }

  function removeSourceChannel(id: string) {
    setCfg(c => ({ ...c, source_channels: c.source_channels.filter(s => s.id !== id) }))
  }

  function setDestChannel(ch: SlackChannel) {
    setCfg(c => ({ ...c, dest_channel_id: ch.id, dest_channel_name: ch.name }))
    setDestPickerOpen(false)
  }

  async function saveConfig() {
    setSaving(true); setSaveMsg('')
    try {
      await standupApi.saveConfig(cfg)
      setSaveMsg('Saved ✓')
      setTimeout(() => setSaveMsg(''), 2500)
      setConfigOpen(false)
    } catch { setSaveMsg('Save failed') }
    finally { setSaving(false) }
  }

  function cancelCompile() {
    parseAbortRef.current = true
    setCancelled(true)
    setTimeout(() => setCancelled(false), 2000)
  }

  async function compile() {
    parseAbortRef.current = false
    setCancelled(false)
    setCompiling(true); setCompileError(''); setUpdates([]); setPostMsg('')
    setChannelWarnings([]); setParseProgress(null)
    try {
      // Step 1: fetch Slack messages (fast — no Groq)
      const res = await standupApi.compile(compileDate !== today ? compileDate : undefined)
      if (!res.success) { setCompileError('Compile failed'); return }

      if (res.debug?.channels) {
        const warns = (res.debug.channels as {id: string; name: string; messages_found: number; error?: string}[])
          .filter(ch => ch.error)
          .map(ch => `#${ch.name || ch.id}: ${ch.error}`)
        setChannelWarnings(warns)
      }

      // Show raw updates immediately so the user sees the list
      setUpdates(res.updates)

      // Step 2: parse each non-owner dev one at a time via /parse-one
      const toProcess = res.updates
        .map((u, i) => ({ ...u, _idx: i }))
        .filter(u => !u.is_owner && u.raw_text?.trim())

      for (let i = 0; i < toProcess.length; i++) {
        if (parseAbortRef.current) break
        const person = toProcess[i]
        setParseProgress({ current: i + 1, total: toProcess.length, name: person.display_name, countdown: 0 })

        let sections: UpdateSection[] = []
        while (!parseAbortRef.current) {
          const pr = await standupApi.parseOne(person.raw_text)
          if (pr.rate_limited) {
            const secs = pr.retry_after ?? 30
            for (let s = secs; s > 0; s--) {
              if (parseAbortRef.current) break
              setParseProgress(p => p ? { ...p, countdown: s } : p)
              await new Promise(r => setTimeout(r, 1000))
            }
            if (parseAbortRef.current) break  // exit while, don't retry
            setParseProgress(p => p ? { ...p, countdown: 0 } : p)
            continue // retry same person after countdown
          }
          sections = pr.sections ?? []
          break
        }

        setUpdates(prev => prev.map((u, i2) => i2 === person._idx ? { ...u, sections } : u))
      }

      setParseProgress(null)
    } catch (e: unknown) {
      setCompileError(e instanceof Error ? e.message : 'Compile failed')
    } finally {
      setCompiling(false)
      setParseProgress(null)
    }
  }

  async function postToSlack() {
    if (!cfg.dest_channel_id) { setPostMsg('Select a destination channel first'); return }
    setPosting(true); setPostMsg('')
    try {
      await standupApi.post(updates, cfg.dest_channel_id)
      setPostMsg(`Posted to #${cfg.dest_channel_name || cfg.dest_channel_id}`)
    } catch (e: unknown) {
      setPostMsg(e instanceof Error ? e.message : 'Post failed')
    } finally { setPosting(false) }
  }

  function updateItem(pi: number, si: number, ii: number, val: string) {
    setUpdates(prev => prev.map((p, _pi) => {
      if (_pi !== pi) return p
      const sections: UpdateSection[] = p.sections.map((sec, _si) => {
        if (_si !== si) return sec
        const items = [...sec.items]; items[ii] = val
        return { ...sec, items }
      })
      return { ...p, sections }
    }))
  }

  const availableSrc = allChannels.filter(ch => !cfg.source_channels.some(s => s.id === ch.id))

  const compileWeekly = useCallback(async () => {
    setWeeklyCompiling(true)
    setWeeklyError('')
    setWeeklyItems([])
    setWeeklyWarnings([])
    setWeeklyPostMsg('')
    try {
      const res = await standupApi.weekly(weeklyMonday)
      if (res.success) {
        setWeeklyItems(res.items ?? [])
        if (res.debug?.channels) {
          const warns = res.debug.channels
            .filter(ch => ch.error)
            .map(ch => `#${ch.name || ch.id}: ${ch.error}`)
          setWeeklyWarnings(warns)
        }
      }
    } catch (e: unknown) {
      setWeeklyError(e instanceof Error ? e.message : 'Compile failed')
    } finally {
      setWeeklyCompiling(false)
    }
  }, [weeklyMonday])

  async function postWeeklyToSlack() {
    if (!cfg.dest_channel_id) { setWeeklyPostMsg('Select a destination channel first'); return }
    setWeeklyPosting(true); setWeeklyPostMsg('')
    try {
      const text = `*Weekly Report — ${fmtWeekLabel(weeklyMonday)}*\n\n` +
        weeklyItems.map(i => `• ${i}`).join('\n')
      const token = localStorage.getItem('token')
      const res = await fetch(`${API_URL}/standup/post`, {
        method: 'POST',
        headers: token
          ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
          : { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: [{
            slack_user_id: '',
            display_name: `Weekly Report — ${fmtWeekLabel(weeklyMonday)}`,
            raw_text: '',
            sections: [{ label: 'Done This Week', items: weeklyItems }],
            is_owner: false,
          }],
          channel_id: cfg.dest_channel_id,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setWeeklyPostMsg(`Posted to #${cfg.dest_channel_name || cfg.dest_channel_id}`)
    } catch (e: unknown) {
      setWeeklyPostMsg(e instanceof Error ? e.message : 'Post failed')
    } finally {
      setWeeklyPosting(false) }
  }

  function copyWeeklyReport() {
    const text = `Weekly Report "${fmtWeekLabel(weeklyMonday)}"\n` +
      weeklyItems.map(i => `${i}`).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setWeeklyCopied(true)
      setTimeout(() => setWeeklyCopied(false), 2000)
    })
  }

  return (
    <div className="sc-page">
      {/* Header */}
      <div className="sc-header">
        <h2 className="sc-title"><Send size={16} /> {mode === 'daily' ? 'Daily Update Compiler' : 'Weekly Report'}</h2>
        <div className="sc-mode-toggle">
          <button className={`sc-mode-btn${mode === 'daily' ? ' active' : ''}`} onClick={() => setMode('daily')}>Daily</button>
          <button className={`sc-mode-btn${mode === 'weekly' ? ' active' : ''}`} onClick={() => setMode('weekly')}>Weekly</button>
        </div>
        {mode === 'daily' && updates.length > 0 && (
          <button className="btn btn-primary btn-sm" onClick={postToSlack} disabled={posting || !cfg.dest_channel_id}>
            <Send size={13} />
            {posting ? 'Posting…' : `Post to #${cfg.dest_channel_name || 'channel'}`}
          </button>
        )}
        {mode === 'weekly' && weeklyItems.length > 0 && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button className="btn btn-secondary btn-sm" onClick={copyWeeklyReport}>
              {weeklyCopied ? <Check size={13} /> : <Copy size={13} />}
              {weeklyCopied ? 'Copied!' : 'Copy'}
            </button>
            <button className="btn btn-primary btn-sm" onClick={postWeeklyToSlack} disabled={weeklyPosting || !cfg.dest_channel_id}>
              <Send size={13} />
              {weeklyPosting ? 'Posting…' : `Post to #${cfg.dest_channel_name || 'channel'}`}
            </button>
          </div>
        )}
      </div>

      {/* Config panel */}
      <div className="sc-config-panel">
        <div
          className={`sc-config-toggle ${configOpen ? 'open' : ''}`}
          onClick={() => setConfigOpen(o => !o)}
        >
          <span className="sc-config-toggle-label">Configuration</span>
          <ChevronDown size={14} />
        </div>

        {configOpen && (
          <div className="sc-config-body">

            {/* Source channels */}
            <div className="sc-field">
              <label className="sc-label">Source Channels — pick from Slack</label>
              <div className="sc-chips-row">
                {cfg.source_channels.map(ch => (
                  <div key={ch.id} className="sc-chip">
                    <Hash size={10} />
                    {ch.name || ch.id}
                    <button className="sc-chip-remove" onClick={() => removeSourceChannel(ch.id)}>
                      <X size={10} />
                    </button>
                  </div>
                ))}

                {/* Dropdown picker */}
                <div className="sc-channel-picker" ref={srcRef}>
                  <button className="sc-picker-trigger" onClick={() => setSrcPickerOpen(o => !o)}>
                    <Plus size={11} /> Add from list
                  </button>
                  {srcPickerOpen && (
                    <div className="sc-picker-menu">
                      {availableSrc.length === 0
                        ? <div className="sc-picker-item" style={{ opacity: 0.5, cursor: 'default' }}>No more channels</div>
                        : availableSrc.map(ch => (
                          <button key={ch.id} className="sc-picker-item" onClick={() => addSourceChannel(ch)}>
                            <Hash size={11} />{ch.name}
                          </button>
                        ))
                      }
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Manual source channel add */}
            <div className="sc-field">
              <label className="sc-label">Or add source channel by ID</label>
              <div className="sc-manual-add-row">
                <input
                  className="sc-input"
                  placeholder="Channel ID (e.g. C08ABC123)"
                  value={manualSrcId}
                  onChange={e => setManualSrcId(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addManualSourceChannel()}
                  style={{ width: 190 }}
                />
                <input
                  className="sc-input"
                  placeholder="Label (optional)"
                  value={manualSrcName}
                  onChange={e => setManualSrcName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addManualSourceChannel()}
                  style={{ width: 140 }}
                />
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={addManualSourceChannel}
                  disabled={!manualSrcId.trim()}
                >
                  <Plus size={13} /> Add
                </button>
              </div>
            </div>

            {/* Destination channel */}
            <div className="sc-field">
              <label className="sc-label">Destination Channel — post compiled update to</label>
              <div className="sc-dest-row">
                <div className="sc-channel-picker" ref={destRef}>
                  <button className="sc-picker-trigger" onClick={() => setDestPickerOpen(o => !o)}>
                    <Hash size={11} />
                    {cfg.dest_channel_name || cfg.dest_channel_id || 'Select channel'}
                    <ChevronDown size={11} />
                  </button>
                  {destPickerOpen && (
                    <div className="sc-picker-menu">
                      {allChannels.map(ch => (
                        <button
                          key={ch.id}
                          className={`sc-picker-item ${ch.id === cfg.dest_channel_id ? 'selected' : ''}`}
                          onClick={() => setDestChannel(ch)}
                        >
                          <Hash size={11} />{ch.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <span className="sc-dest-sep">or</span>
                <input
                  className="sc-input"
                  placeholder="Enter channel ID manually"
                  value={cfg.dest_channel_id}
                  onChange={e => setCfg(c => ({ ...c, dest_channel_id: e.target.value, dest_channel_name: '' }))}
                  style={{ width: 200 }}
                />
              </div>
            </div>

            {/* Time window */}
            <div className="sc-field">
              <label className="sc-label">Time Window (24 h) — when developers post updates</label>
              <div className="sc-time-row">
                <input
                  type="time"
                  className="sc-input sc-time-input"
                  value={cfg.time_window_start}
                  onChange={e => setCfg(c => ({ ...c, time_window_start: e.target.value }))}
                />
                <span className="sc-time-sep">to</span>
                <input
                  type="time"
                  className="sc-input sc-time-input"
                  value={cfg.time_window_end}
                  onChange={e => setCfg(c => ({ ...c, time_window_end: e.target.value }))}
                />
              </div>
            </div>

            <div className="sc-config-actions">
              <button className="btn btn-primary btn-sm" onClick={saveConfig} disabled={saving}>
                {saving ? 'Saving…' : saveMsg || 'Save Configuration'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Daily mode ── */}
      {mode === 'daily' && (
        <>
          {/* Compile bar */}
          <div className="sc-compile-bar">
            <input
              type="date"
              className="sc-input"
              value={compileDate}
              onChange={e => setCompileDate(e.target.value)}
              disabled={compiling}
            />
            {compiling ? (
              <button className="sc-cancel-btn" onClick={cancelCompile}>
                <X size={13} />
                {cancelled ? 'Cancelling…' : 'Cancel'}
              </button>
            ) : (
              <button
                className={`btn btn-secondary btn-sm${cancelled ? ' sc-cancelled-flash' : ''}`}
                onClick={compile}
              >
                <RefreshCw size={13} className={cancelled ? '' : ''} />
                {cancelled ? 'Cancelled' : 'Compile Updates'}
              </button>
            )}
            {postMsg && <span className="sc-status-msg">{postMsg}</span>}
          </div>

          {compileError && <div className="sc-error">{compileError}</div>}

          {channelWarnings.length > 0 && (
            <div className="sc-channel-warnings">
              <strong>Channel access issues</strong> — invite the Slack bot to these channels:
              <ul>{channelWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}

          {compiling && updates.length === 0 && (
            <div className="sc-loading">
              <div className="sc-spinner" />
              Fetching messages from {cfg.source_channels.length} channel{cfg.source_channels.length !== 1 ? 's' : ''}…
            </div>
          )}

          {parseProgress && (
            <div className="sc-parse-progress">
              <div className="sc-parse-bar-wrap">
                <div className="sc-parse-bar-fill" style={{ width: `${Math.round((parseProgress.current / parseProgress.total) * 100)}%` }} />
              </div>
              <span className="sc-parse-label">
                {parseProgress.countdown > 0
                  ? <><RefreshCw size={12} /> Rate limit — resuming in {parseProgress.countdown}s</>
                  : <>{parseProgress.current} / {parseProgress.total} — parsing {parseProgress.name}…</>
                }
              </span>
            </div>
          )}

          {updates.length > 0 && (
            <div className="sc-preview">
              <div className="sc-preview-header">
                <h3 className="sc-preview-title">Preview — {updates.length} developer{updates.length !== 1 ? 's' : ''}</h3>
              </div>
              {updates.map((person, pi) => (
                <PersonCard key={person.slack_user_id || pi} person={person} personIdx={pi} onUpdateItem={updateItem} />
              ))}
            </div>
          )}

          {!compiling && !parseProgress && updates.length === 0 && !compileError && (
            <div className="sc-empty">Configure channels above and click "Compile Updates" to get started.</div>
          )}
        </>
      )}

      {/* ── Weekly mode ── */}
      {mode === 'weekly' && (
        <>
          {/* Week navigator */}
          <div className="sc-week-bar">
            <button className="sc-week-nav-btn" onClick={() => setWeeklyMonday(m => shiftWeek(m, -1))}>
              <ChevronLeft size={14} />
            </button>
            <div className="sc-week-label-wrap">
              <span className="sc-week-label">{fmtWeekLabel(weeklyMonday)}</span>
              <CalendarPicker
                value={weeklyCalDate}
                onChange={d => { setWeeklyCalDate(d); setWeeklyMonday(getMondayOf(d)) }}
                placeholder="Pick a week…"
                className="sc-week-cal"
              />
            </div>
            <button className="sc-week-nav-btn" onClick={() => setWeeklyMonday(m => shiftWeek(m, 1))}>
              <ChevronRight size={14} />
            </button>
            <button className="btn btn-secondary btn-sm" onClick={compileWeekly} disabled={weeklyCompiling}>
              <RefreshCw size={13} />
              {weeklyCompiling ? 'Compiling…' : 'Compile Weekly Report'}
            </button>
            {weeklyPostMsg && <span className="sc-status-msg">{weeklyPostMsg}</span>}
          </div>

          {weeklyError && <div className="sc-error">{weeklyError}</div>}

          {weeklyWarnings.length > 0 && (
            <div className="sc-channel-warnings">
              <strong>Channel access issues</strong> — invite the Slack bot to these channels:
              <ul>{weeklyWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}

          {weeklyCompiling && (
            <div className="sc-loading">
              <div className="sc-spinner" />
              Fetching Mon–Fri from {cfg.source_channels.length} channel{cfg.source_channels.length !== 1 ? 's' : ''} and running AI…
            </div>
          )}

          {!weeklyCompiling && weeklyItems.length > 0 && (
            <div className="sc-weekly-preview">
              <div className="sc-preview-header">
                <h3 className="sc-preview-title">Weekly Report — {weeklyItems.length} items</h3>
              </div>
              <div className="sc-weekly-card">
                <div className="sc-weekly-title">Weekly Report "{fmtWeekLabel(weeklyMonday)}"</div>
                <div className="sc-weekly-items">
                  {weeklyItems.map((item, i) => (
                    <div key={i} className="sc-weekly-item">
                      <span className="sc-item-bullet">•</span>
                      <textarea
                        className="sc-item-text"
                        value={item}
                        rows={1}
                        onChange={e => {
                          const next = [...weeklyItems]; next[i] = e.target.value; setWeeklyItems(next)
                          e.currentTarget.style.height = 'auto'
                          e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'
                        }}
                      />
                      <button className="sc-weekly-remove" onClick={() => setWeeklyItems(prev => prev.filter((_, idx) => idx !== i))}>
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!weeklyCompiling && weeklyItems.length === 0 && !weeklyError && (
            <div className="sc-empty">Select a week and click "Compile Weekly Report" to generate the report.</div>
          )}
        </>
      )}
    </div>
  )
}

// ── PersonCard ────────────────────────────────────────────────────────────────

interface PersonCardProps {
  person: PersonUpdate
  personIdx: number
  onUpdateItem: (pi: number, si: number, ii: number, val: string) => void
}

function PersonCard({ person, personIdx, onUpdateItem }: PersonCardProps) {
  return (
    <div className={`sc-person-card ${person.is_owner ? 'is-owner' : ''}`}>
      <div className="sc-person-name-row">
        <span className={`sc-name-tag ${person.is_owner ? 'owner' : 'dev'}`}>
          {person.display_name}
        </span>
        {person.is_owner && <span className="sc-daytrack-badge">DayTrack</span>}
      </div>

      {(person.sections ?? []).length === 0
        ? <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>No update parsed</span>
        : (
          <div className="sc-sections">
            {(person.sections ?? []).map((sec, si) =>
              (sec.items ?? []).length > 0 && (
                <div key={si}>
                  <div className="sc-section-label">{sec.label}</div>
                  <div className="sc-items">
                    {(sec.items ?? []).map((item, ii) => (
                      <div key={ii} className="sc-item">
                        <span className="sc-item-bullet">•</span>
                        <textarea
                          className="sc-item-text"
                          value={item}
                          rows={1}
                          onChange={e => {
                            onUpdateItem(personIdx, si, ii, e.target.value)
                            e.currentTarget.style.height = 'auto'
                            e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
        )
      }
    </div>
  )
}
