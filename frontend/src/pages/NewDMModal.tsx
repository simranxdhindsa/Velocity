import { useState } from 'react'
import { X, Send, Clock, Search } from 'lucide-react'
import api from '@/services/api'
import type { SlackWorkspaceUser } from '@/services/api'
import { CalendarPicker } from '@/components/CalendarPicker'
import { ClockTimePicker } from '@/components/ClockTimePicker'
import { toYMD } from './ClaudeQueueCard'

/**
 * Fire-and-forget DM composer — no conversation history view (the app doesn't
 * fetch/list Slack DM channels), just pick a member, write, send now or
 * schedule. Mirrors what Update Reminders' Quick Send did for DMs.
 */
export function NewDMModal({ users, onClose }: { users: SlackWorkspaceUser[]; onClose: () => void }) {
  const [search, setSearch] = useState('')
  const [selectedUser, setSelectedUser] = useState<SlackWorkspaceUser | null>(null)
  const [text, setText] = useState('')
  const [scheduleMode, setScheduleMode] = useState(false)
  const [schedDate, setSchedDate] = useState(toYMD(new Date()))
  const [schedTime, setSchedTime] = useState('10:00')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  const filtered = users
    .filter(u => !u.is_bot && !u.deleted)
    .filter(u => (u.profile.display_name || u.real_name || u.name).toLowerCase().includes(search.toLowerCase()))
    .slice(0, 20)

  const handleSend = async () => {
    if (!selectedUser || !text.trim() || sending) return
    setSending(true)
    setError('')
    try {
      const name = selectedUser.profile.display_name || selectedUser.real_name || selectedUser.name
      if (scheduleMode) {
        const [y, mo, d] = schedDate.split('-').map(Number)
        const [hh, mm] = schedTime.split(':').map(Number)
        const when = new Date(y, mo - 1, d, hh, mm, 0, 0)
        if (when <= new Date()) { setError('Selected date and time is in the past'); setSending(false); return }
        await api.createQueuedMessage(text.trim(), when.toISOString(), '', name, selectedUser.id)
      } else {
        await api.quickSend({ message: text.trim(), dm_user_id: selectedUser.id })
      }
      setSent(true)
      setTimeout(onClose, 1100)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="si2-modal-overlay" onClick={onClose}>
      <div className="si2-modal" onClick={e => e.stopPropagation()}>
        <div className="si2-modal-header">
          <Send size={16} />
          <h3>New direct message</h3>
          <button className="si2-modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="si2-modal-body">
          {!selectedUser ? (
            <>
              <label className="si2-modal-label">To</label>
              <div className="smh-dm-search-wrap">
                <Search size={13} />
                <input
                  placeholder="Search workspace member…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="smh-dm-user-list">
                {filtered.map(u => (
                  <button key={u.id} className="smh-dm-user-row" onClick={() => setSelectedUser(u)}>
                    {u.profile.image_48
                      ? <img src={u.profile.image_48} alt="" />
                      : <span className="smh-dm-user-fallback">{(u.profile.display_name || u.real_name || '?').charAt(0).toUpperCase()}</span>
                    }
                    <span>{u.profile.display_name || u.real_name || u.name}</span>
                  </button>
                ))}
                {filtered.length === 0 && <p className="si2-empty-sub">No matching members</p>}
              </div>
            </>
          ) : (
            <>
              <label className="si2-modal-label">To</label>
              <div className="smh-dm-selected">
                {selectedUser.profile.image_48
                  ? <img src={selectedUser.profile.image_48} alt="" />
                  : <span className="smh-dm-user-fallback">{(selectedUser.profile.display_name || selectedUser.real_name || '?').charAt(0).toUpperCase()}</span>
                }
                <span>{selectedUser.profile.display_name || selectedUser.real_name || selectedUser.name}</span>
                <button className="smh-dm-selected-clear" onClick={() => setSelectedUser(null)} title="Change recipient"><X size={12} /></button>
              </div>
              <textarea
                className="si2-input smh-dm-textarea"
                placeholder="Write your message…"
                value={text}
                onChange={e => setText(e.target.value)}
                rows={4}
                autoFocus
              />
              <div className="smh-dm-schedule-row">
                <button
                  className={`smh-schedule-toggle${scheduleMode ? ' active' : ''}`}
                  onClick={() => setScheduleMode(m => !m)}
                >
                  <Clock size={13} /> {scheduleMode ? 'Scheduled' : 'Send now'}
                </button>
                {scheduleMode && (
                  <>
                    <CalendarPicker value={schedDate} onChange={setSchedDate} minDate={toYMD(new Date())} />
                    <ClockTimePicker value={schedTime} onChange={setSchedTime} />
                  </>
                )}
              </div>
              {error && <div className="smh-error-banner">{error}</div>}
            </>
          )}
        </div>
        {selectedUser && (
          <div className="si2-modal-footer">
            <button className="si2-cancel-btn" onClick={onClose}>Cancel</button>
            <button className="si2-save-btn" onClick={handleSend} disabled={!text.trim() || sending}>
              {sending ? 'Sending…' : sent ? 'Sent!' : scheduleMode ? 'Schedule' : 'Send'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
