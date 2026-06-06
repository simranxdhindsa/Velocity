import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Download, Loader2, ChevronDown, Shield, Briefcase,
  User as UserIcon, Eye, Mail, Globe, Info,
  Trash2, CheckCircle2, XCircle, Users, Lock, Search, Ban,
} from 'lucide-react'
import api from '../services/api'
import type { AllowedEmail, AllowedDomain, AccessSettings, YouTrackUser, DeniedEmail } from '../services/api'
import { ConfirmModal } from '../components/ConfirmModal'

type UserRole = 'admin' | 'project_manager' | 'member' | 'viewer'

const ROLES: { value: UserRole; label: string; color: string }[] = [
  { value: 'admin',           label: 'Admin',           color: '#a78bfa' },
  { value: 'project_manager', label: 'Project Manager', color: '#818cf8' },
  { value: 'member',          label: 'Member',          color: '#34d399' },
  { value: 'viewer',          label: 'Viewer',          color: '#94a3b8' },
]

const ROLE_ICONS: Record<UserRole, React.ReactNode> = {
  admin:           <Shield size={13} />,
  project_manager: <Briefcase size={13} />,
  member:          <UserIcon size={13} />,
  viewer:          <Eye size={13} />,
}

function getRoleBadgeClass(role: UserRole) {
  switch (role) {
    case 'admin':           return 'role-admin'
    case 'project_manager': return 'role-pm'
    case 'member':          return 'role-member'
    case 'viewer':          return 'role-viewer'
    default:                return ''
  }
}

function getInitial(text: string) { return text.charAt(0).toUpperCase() }

function getInitialBg(role: UserRole) {
  switch (role) {
    case 'admin':           return 'rgba(139,92,246,0.22)'
    case 'project_manager': return 'rgba(99,102,241,0.22)'
    case 'member':          return 'rgba(16,185,129,0.22)'
    case 'viewer':          return 'rgba(100,116,139,0.22)'
    default:                return 'rgba(255,255,255,0.1)'
  }
}

function getInitialColor(role: UserRole) {
  switch (role) {
    case 'admin':           return '#a78bfa'
    case 'project_manager': return '#818cf8'
    case 'member':          return '#34d399'
    case 'viewer':          return '#94a3b8'
    default:                return '#f1f5f9'
  }
}

// ── Reusable role dropdown ─────────────────────────────────────────────────
interface RoleDropdownProps {
  value: UserRole
  onChange: (v: UserRole) => void
  size?: 'sm' | 'md'
}

function RoleDropdown({ value, onChange, size = 'md' }: RoleDropdownProps) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const role = ROLES.find(r => r.value === value)!

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="ac-role-dropdown">
      <button
        ref={btnRef}
        type="button"
        className={`ac-role-trigger ${size === 'sm' ? 'ac-role-trigger-sm' : ''}`}
        onClick={() => {
          if (btnRef.current) setRect(btnRef.current.getBoundingClientRect())
          setOpen(o => !o)
        }}
      >
        <span className="ac-role-icon" style={{ color: role.color }}>{ROLE_ICONS[value]}</span>
        <span className="ac-role-label">{role.label}</span>
        <ChevronDown size={10} className={`ac-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && rect && createPortal(
        <div
          className="pm-custom-dropdown-menu ac-role-menu"
          style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, minWidth: Math.max(rect.width, 170), zIndex: 9999 }}
          onMouseDown={e => e.stopPropagation()}
        >
          {ROLES.map(r => (
            <button
              key={r.value}
              type="button"
              className={`pm-dropdown-item ac-role-menu-item ${value === r.value ? 'active' : ''}`}
              onClick={() => { onChange(r.value); setOpen(false) }}
            >
              <span style={{ color: r.color }}>{ROLE_ICONS[r.value]}</span>
              <span>{r.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Role stat chip ─────────────────────────────────────────────────────────
interface RoleStatProps { role: UserRole; count: number }
function RoleStat({ role, count }: RoleStatProps) {
  const r = ROLES.find(x => x.value === role)!
  return (
    <div className="ac-role-stat">
      <span className="ac-role-stat-icon" style={{ color: r.color }}>{ROLE_ICONS[role]}</span>
      <span className="ac-role-stat-count" style={{ color: r.color }}>{count}</span>
      <span className="ac-role-stat-label">{r.label}{count !== 1 ? 's' : ''}</span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export function SettingsPage() {
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [success, setSuccess]   = useState<string | null>(null)
  const [settings, setSettings] = useState<AccessSettings | null>(null)

  const [newEmail, setNewEmail]         = useState('')
  const [newEmailRole, setNewEmailRole] = useState<UserRole>('member')
  const [addingEmail, setAddingEmail]   = useState(false)
  const [emailSearch, setEmailSearch]   = useState('')

  const [newDomain, setNewDomain]         = useState('')
  const [newDomainRole, setNewDomainRole] = useState<UserRole>('member')
  const [addingDomain, setAddingDomain]   = useState(false)

  const [newBlockedEmail, setNewBlockedEmail]   = useState('')
  const [newBlockedReason, setNewBlockedReason] = useState('')
  const [addingBlocked, setAddingBlocked]       = useState(false)
  const [deniedEmails, setDeniedEmails]         = useState<DeniedEmail[]>([])

  const [updatingRole, setUpdatingRole] = useState<string | null>(null)

  const [confirmAction, setConfirmAction] = useState<{
    title: string; message: string; onConfirm: () => void
  } | null>(null)

  const [showYtImport, setShowYtImport]         = useState(false)
  const [ytUsers, setYtUsers]                   = useState<YouTrackUser[]>([])
  const [ytLoadingUsers, setYtLoadingUsers]     = useState(false)
  const [ytSelectedEmails, setYtSelectedEmails] = useState<Set<string>>(new Set())
  const [ytImporting, setYtImporting]           = useState(false)

  useEffect(() => { fetchSettings() }, [])

  const fetchSettings = async () => {
    try {
      setLoading(true); setError(null)
      const res = await api.getAccessSettings()
      if (res.success && res.data) {
        setSettings(res.data)
        setDeniedEmails(res.data.denied_emails ?? [])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    } finally { setLoading(false) }
  }

  const flash = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000) }

  // ── Email CRUD ─────────────────────────────────────────────────────────
  const handleAddEmail = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newEmail.trim()) return
    try {
      setAddingEmail(true); setError(null)
      const res = await api.addAllowedEmail(newEmail.trim(), newEmailRole)
      if (res.success) { flash('Email added'); setNewEmail(''); setNewEmailRole('member'); fetchSettings() }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add email')
    } finally { setAddingEmail(false) }
  }

  const handleUpdateEmailRole = async (email: string, newRole: UserRole) => {
    setUpdatingRole(email)
    try {
      setError(null)
      await api.addAllowedEmail(email, newRole)
      fetchSettings()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role')
    } finally { setUpdatingRole(null) }
  }

  const handleRemoveEmail = (email: string) => {
    setConfirmAction({
      title: 'Remove Email',
      message: `Remove ${email} from the allowed list?`,
      onConfirm: async () => {
        setConfirmAction(null)
        try { await api.removeAllowedEmail(email); flash('Email removed'); fetchSettings() }
        catch (err) { setError(err instanceof Error ? err.message : 'Failed to remove email') }
      },
    })
  }

  // ── Domain CRUD ────────────────────────────────────────────────────────
  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newDomain.trim()) return
    try {
      setAddingDomain(true); setError(null)
      const domain = newDomain.trim().replace(/^@/, '')
      const res = await api.addAllowedDomain(domain, newDomainRole)
      if (res.success) { flash('Domain added'); setNewDomain(''); setNewDomainRole('member'); fetchSettings() }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add domain')
    } finally { setAddingDomain(false) }
  }

  const handleUpdateDomainRole = async (domain: string, newRole: UserRole) => {
    setUpdatingRole(`domain:${domain}`)
    try {
      setError(null)
      await api.addAllowedDomain(domain, newRole)
      fetchSettings()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role')
    } finally { setUpdatingRole(null) }
  }

  const handleRemoveDomain = (domain: string) => {
    setConfirmAction({
      title: 'Remove Domain',
      message: `Remove @${domain} from the allowed list?`,
      onConfirm: async () => {
        setConfirmAction(null)
        try { await api.removeAllowedDomain(domain); flash('Domain removed'); fetchSettings() }
        catch (err) { setError(err instanceof Error ? err.message : 'Failed to remove domain') }
      },
    })
  }

  // ── Blocked emails ─────────────────────────────────────────────────────
  const handleBlockEmail = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newBlockedEmail.trim()) return
    try {
      setAddingBlocked(true); setError(null)
      await api.addDeniedEmail(newBlockedEmail.trim(), newBlockedReason.trim())
      flash('Email blocked')
      setNewBlockedEmail(''); setNewBlockedReason('')
      fetchSettings()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to block email')
    } finally { setAddingBlocked(false) }
  }

  const handleUnblockEmail = (email: string) => {
    setConfirmAction({
      title: 'Unblock Email',
      message: `Remove ${email} from the blocked list and restore access?`,
      onConfirm: async () => {
        setConfirmAction(null)
        try {
          await api.removeDeniedEmail(email)
          flash('Email unblocked')
          fetchSettings()
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to unblock email')
        }
      },
    })
  }

  // ── YouTrack import ────────────────────────────────────────────────────
  const isEmailAlreadyAllowed = (email: string) =>
    settings?.allowed_emails?.some((e: AllowedEmail) => e.email.toLowerCase() === email.toLowerCase()) ?? false

  const handleYtToggle = (email: string) => {
    setYtSelectedEmails(prev => {
      const next = new Set(prev)
      next.has(email) ? next.delete(email) : next.add(email)
      return next
    })
  }

  const handleOpenYtImport = async () => {
    setShowYtImport(true); setYtLoadingUsers(true); setYtSelectedEmails(new Set())
    try {
      const res = await api.getYouTrackUsers()
      if (res.success && res.data) setYtUsers(res.data as YouTrackUser[])
    } catch { setError('Failed to fetch YouTrack users'); setShowYtImport(false) }
    finally { setYtLoadingUsers(false) }
  }

  const handleYtImport = async () => {
    if (ytSelectedEmails.size === 0) return
    setYtImporting(true)
    try {
      let added = 0
      for (const email of ytSelectedEmails) {
        const res = await api.addAllowedEmail(email, 'member')
        if (res.success) added++
      }
      flash(`Imported ${added} user${added !== 1 ? 's' : ''} from YouTrack`)
      setShowYtImport(false); fetchSettings()
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to import users') }
    finally { setYtImporting(false) }
  }

  const ytEligible = ytUsers.filter(u => u.email && !isEmailAlreadyAllowed(u.email))
  const allSelected = ytEligible.length > 0 && ytEligible.every(u => ytSelectedEmails.has(u.email!))
  const toggleSelectAll = () =>
    allSelected ? setYtSelectedEmails(new Set()) : setYtSelectedEmails(new Set(ytEligible.map(u => u.email!)))

  // ── Derived data ───────────────────────────────────────────────────────
  const allEmails = settings?.allowed_emails ?? []
  const allDomains = settings?.allowed_domains ?? []

  const roleCounts = useMemo(() => {
    const counts: Partial<Record<UserRole, number>> = {}
    for (const e of allEmails) {
      counts[e.role] = (counts[e.role] ?? 0) + 1
    }
    return counts
  }, [allEmails])

  const filteredEmails = useMemo(() => {
    if (!emailSearch.trim()) return allEmails
    const q = emailSearch.toLowerCase()
    return allEmails.filter(e => e.email.toLowerCase().includes(q) || e.role.includes(q))
  }, [allEmails, emailSearch])

  // ── Loading ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="ac-page">
        <div className="ac-loading">
          <div className="ac-spinner" />
          <span>Loading access settings…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="ac-page">

      {/* ── Page header ──────────────────────────────────────── */}
      <div className="ac-header">
        <div className="ac-header-icon"><Lock size={20} /></div>
        <div className="ac-header-text">
          <h1 className="ac-title">Access Control</h1>
          <p className="ac-subtitle">Manage who can sign in via Google OAuth</p>
        </div>
      </div>

      {/* ── Role stats bar ────────────────────────────────────── */}
      {allEmails.length > 0 && (
        <div className="ac-stats-bar glass-card">
          <div className="ac-stats-label"><Users size={14} />Role breakdown</div>
          <div className="ac-stats-chips">
            {(Object.entries(roleCounts) as [UserRole, number][]).map(([role, count]) => (
              <RoleStat key={role} role={role} count={count} />
            ))}
          </div>
        </div>
      )}

      {/* ── Alerts ───────────────────────────────────────────── */}
      {error && (
        <div className="ac-alert ac-alert-error">
          <XCircle size={16} />
          <span>{error}</span>
          <button className="ac-alert-close" onClick={() => setError(null)} aria-label="Dismiss">
            <XCircle size={14} />
          </button>
        </div>
      )}
      {success && (
        <div className="ac-alert ac-alert-success">
          <CheckCircle2 size={16} />
          <span>{success}</span>
        </div>
      )}

      {/* ── Default admin notice ──────────────────────────────── */}
      <div className="ac-notice glass-card">
        <div className="ac-notice-bar" />
        <Info size={15} className="ac-notice-icon" />
        <div className="ac-notice-body">
          <span className="ac-notice-title">Default Administrator</span>
          <span className="ac-notice-text">
            <strong>{settings?.default_admin_email}</strong> always has admin access and cannot be removed.
          </span>
        </div>
      </div>

      {/* ── Allowed Emails ────────────────────────────────────── */}
      <div className="ac-section glass-card">
        <div className="ac-section-head">
          <div className="ac-section-title-wrap">
            <div className="ac-section-icon ac-section-icon-email"><Mail size={15} /></div>
            <div>
              <h2 className="ac-section-title">Allowed Email Addresses</h2>
              <p className="ac-section-desc">Specific addresses that can access the app</p>
            </div>
          </div>
          <button className="ac-import-btn" onClick={handleOpenYtImport} type="button">
            <Download size={13} />
            Import from YouTrack
          </button>
        </div>

        <form className="ac-add-form" onSubmit={handleAddEmail}>
          <input
            type="email"
            className="ac-input"
            placeholder="user@example.com"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            required
          />
          <RoleDropdown value={newEmailRole} onChange={setNewEmailRole} />
          <button type="submit" className="btn btn-primary ac-add-btn" disabled={addingEmail || !newEmail.trim()}>
            {addingEmail ? <Loader2 size={14} className="animate-spin" /> : null}
            {addingEmail ? 'Adding…' : 'Add Email'}
          </button>
        </form>

        {allEmails.length > 4 && (
          <div className="ac-search-wrap">
            <Search size={14} className="ac-search-icon" />
            <input
              type="text"
              className="ac-search-input"
              placeholder="Search emails or roles…"
              value={emailSearch}
              onChange={e => setEmailSearch(e.target.value)}
            />
            {emailSearch && (
              <button className="ac-search-clear" onClick={() => setEmailSearch('')} type="button">
                <XCircle size={13} />
              </button>
            )}
          </div>
        )}

        <div className="ac-list">
          {filteredEmails.length > 0 ? (
            filteredEmails.map(item => (
              <div key={item.email} className="ac-item">
                <div
                  className="ac-item-avatar"
                  style={{ background: getInitialBg(item.role), color: getInitialColor(item.role) }}
                >
                  {getInitial(item.email)}
                </div>
                <div className="ac-item-info">
                  <span className="ac-item-name">{item.email}</span>
                  {item.is_default && <span className="ac-default-badge">Default Admin</span>}
                </div>

                {/* Inline role editor */}
                {item.is_default ? (
                  <span className={`role-badge ${getRoleBadgeClass(item.role)}`}>{item.role.replace('_', ' ')}</span>
                ) : updatingRole === item.email ? (
                  <span className="ac-role-updating"><Loader2 size={13} className="animate-spin" /> Saving…</span>
                ) : (
                  <RoleDropdown
                    value={item.role as UserRole}
                    onChange={newRole => handleUpdateEmailRole(item.email, newRole)}
                    size="sm"
                  />
                )}

                {!item.is_default && (
                  <button
                    className="ac-remove-btn"
                    onClick={() => handleRemoveEmail(item.email)}
                    title="Remove"
                    aria-label={`Remove ${item.email}`}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))
          ) : emailSearch ? (
            <div className="ac-empty">
              <Search size={24} />
              <span>No results for "{emailSearch}"</span>
            </div>
          ) : (
            <div className="ac-empty">
              <Users size={28} />
              <span>No emails configured yet</span>
              <p>Only the default admin has access. Add an email above to grant others access.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Allowed Domains ──────────────────────────────────── */}
      <div className="ac-section glass-card">
        <div className="ac-section-head">
          <div className="ac-section-title-wrap">
            <div className="ac-section-icon ac-section-icon-domain"><Globe size={15} /></div>
            <div>
              <h2 className="ac-section-title">Allowed Email Domains</h2>
              <p className="ac-section-desc">Allow everyone from a domain to sign in (e.g. @company.com)</p>
            </div>
          </div>
        </div>

        <form className="ac-add-form" onSubmit={handleAddDomain}>
          <div className="ac-domain-input-wrap ac-input">
            <span className="ac-domain-at">@</span>
            <input
              type="text"
              className="ac-domain-input"
              placeholder="company.com"
              value={newDomain}
              onChange={e => setNewDomain(e.target.value.replace(/^@/, ''))}
              required
            />
          </div>
          <RoleDropdown value={newDomainRole} onChange={setNewDomainRole} />
          <button type="submit" className="btn btn-primary ac-add-btn" disabled={addingDomain || !newDomain.trim()}>
            {addingDomain ? <Loader2 size={14} className="animate-spin" /> : null}
            {addingDomain ? 'Adding…' : 'Add Domain'}
          </button>
        </form>

        <div className="ac-list">
          {allDomains.length > 0 ? (
            allDomains.map(item => (
              <div key={item.domain} className="ac-item">
                <div className="ac-item-avatar ac-item-avatar-domain">@</div>
                <div className="ac-item-info">
                  <span className="ac-item-name">@{item.domain}</span>
                  <span className="ac-domain-hint">All @{item.domain} addresses</span>
                </div>

                {updatingRole === `domain:${item.domain}` ? (
                  <span className="ac-role-updating"><Loader2 size={13} className="animate-spin" /> Saving…</span>
                ) : (
                  <RoleDropdown
                    value={item.role as UserRole}
                    onChange={newRole => handleUpdateDomainRole(item.domain, newRole)}
                    size="sm"
                  />
                )}

                <button
                  className="ac-remove-btn"
                  onClick={() => handleRemoveDomain(item.domain)}
                  title="Remove"
                  aria-label={`Remove @${item.domain}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          ) : (
            <div className="ac-empty">
              <Globe size={28} />
              <span>No domains configured yet</span>
              <p>Add a domain to let everyone from that organisation sign in automatically.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Blocked Emails ───────────────────────────────────── */}
      <div className="ac-section glass-card">
        <div className="ac-section-head">
          <div className="ac-section-title-wrap">
            <div className="ac-section-icon ac-section-icon-blocked">
              <Ban size={15} />
            </div>
            <div>
              <h2 className="ac-section-title">Blocked Emails</h2>
              <p className="ac-section-desc">These users are denied access even if their domain is allowed</p>
            </div>
          </div>
          {deniedEmails.length > 0 && (
            <span className="ac-chip ac-chip-blocked">
              <Ban size={11} />{deniedEmails.length} blocked
            </span>
          )}
        </div>

        <form className="ac-add-form ac-block-form" onSubmit={handleBlockEmail}>
          <input
            type="email"
            className="ac-input"
            placeholder="user@example.com"
            value={newBlockedEmail}
            onChange={e => setNewBlockedEmail(e.target.value)}
            required
          />
          <input
            type="text"
            className="ac-input ac-reason-input"
            placeholder="Reason (optional)"
            value={newBlockedReason}
            onChange={e => setNewBlockedReason(e.target.value)}
            maxLength={120}
          />
          <button type="submit" className="btn ac-block-btn" disabled={addingBlocked || !newBlockedEmail.trim()}>
            {addingBlocked ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
            {addingBlocked ? 'Blocking…' : 'Block'}
          </button>
        </form>

        <div className="ac-list">
          {deniedEmails.length > 0 ? (
            deniedEmails.map(item => (
              <div key={item.email} className="ac-item ac-item-blocked">
                <div className="ac-item-avatar ac-item-avatar-blocked">
                  {getInitial(item.email)}
                </div>
                <div className="ac-item-info">
                  <span className="ac-item-name">{item.email}</span>
                  {item.reason && <span className="ac-blocked-reason">{item.reason}</span>}
                </div>
                <span className="ac-blocked-badge">Blocked</span>
                <button
                  className="ac-remove-btn"
                  onClick={() => handleUnblockEmail(item.email)}
                  title="Unblock"
                  aria-label={`Unblock ${item.email}`}
                >
                  <XCircle size={14} />
                </button>
              </div>
            ))
          ) : (
            <div className="ac-empty">
              <Ban size={28} />
              <span>No blocked emails</span>
              <p>Add emails here to explicitly deny access regardless of any other rules.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Confirm modal ─────────────────────────────────────── */}
      <ConfirmModal
        open={!!confirmAction}
        title={confirmAction?.title || ''}
        message={confirmAction?.message || ''}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => confirmAction?.onConfirm()}
        onCancel={() => setConfirmAction(null)}
      />

      {/* ── YouTrack import modal ─────────────────────────────── */}
      {showYtImport && createPortal(
        <div className="modal-overlay" onClick={() => setShowYtImport(false)}>
          <div className="modal ac-yt-modal" onClick={e => e.stopPropagation()}>
            <div className="ac-yt-modal-head">
              <div className="ac-yt-modal-title-wrap">
                <div className="ac-section-icon ac-section-icon-email" style={{ width: 34, height: 34 }}>
                  <Download size={15} />
                </div>
                <div>
                  <h3 className="ac-yt-title">Import from YouTrack</h3>
                  <p className="ac-yt-subtitle">Select users to add as members</p>
                </div>
              </div>
              <button className="ac-yt-close" onClick={() => setShowYtImport(false)} aria-label="Close">
                <XCircle size={18} />
              </button>
            </div>

            {ytLoadingUsers ? (
              <div className="ac-yt-loading">
                <Loader2 size={24} className="animate-spin" />
                <span>Loading YouTrack users…</span>
              </div>
            ) : (
              <>
                {ytEligible.length > 0 && (
                  <div className="ac-yt-select-all">
                    <label className="ac-yt-select-all-label">
                      <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="ac-yt-checkbox" />
                      <span>{allSelected ? 'Deselect all' : `Select all ${ytEligible.length} eligible`}</span>
                    </label>
                  </div>
                )}

                <div className="ac-yt-list">
                  {ytUsers.filter(u => u.email).length === 0 ? (
                    <div className="ac-yt-empty">No users with email addresses found in YouTrack</div>
                  ) : (
                    ytUsers.filter(u => u.email).map(user => {
                      const already = isEmailAlreadyAllowed(user.email!)
                      return (
                        <label key={user.id} className={`ac-yt-item ${already ? 'ac-yt-item-disabled' : ''}`}>
                          <input
                            type="checkbox"
                            checked={already || ytSelectedEmails.has(user.email!)}
                            disabled={already}
                            onChange={() => handleYtToggle(user.email!)}
                            className="ac-yt-checkbox"
                          />
                          <div className="ac-yt-avatar">
                            {(user.fullName || user.login || '?').charAt(0).toUpperCase()}
                          </div>
                          <div className="ac-yt-user-info">
                            <span className="ac-yt-name">{user.fullName || user.login}</span>
                            <span className="ac-yt-email">{user.email}</span>
                          </div>
                          {already && <span className="ac-yt-already">Already added</span>}
                        </label>
                      )
                    })
                  )}
                </div>

                <div className="ac-yt-footer">
                  <button className="btn btn-ghost" onClick={() => setShowYtImport(false)}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    onClick={handleYtImport}
                    disabled={ytImporting || ytSelectedEmails.size === 0}
                  >
                    {ytImporting
                      ? <><Loader2 size={14} className="animate-spin" /> Importing…</>
                      : `Add ${ytSelectedEmails.size > 0 ? `${ytSelectedEmails.size} ` : ''}Selected`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
