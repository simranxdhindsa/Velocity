import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Shield, Briefcase, User as UserIcon, Eye } from 'lucide-react'
import api from '../services/api'
import type { User } from '../services/api'
import { SprintScanLoader } from '@/components/brand/VelocityLoaders'

type UserRole = 'admin' | 'project_manager' | 'member' | 'viewer'

const ROLES: { value: UserRole; label: string; description: string }[] = [
  {
    value: 'admin',
    label: 'Admin',
    description: 'Full access to all features and settings',
  },
  {
    value: 'project_manager',
    label: 'Project Manager',
    description: 'Create/edit projects, assign tasks, view reports',
  },
  {
    value: 'member',
    label: 'Member',
    description: 'View and update assigned tasks',
  },
  {
    value: 'viewer',
    label: 'Viewer',
    description: 'Read-only access to projects',
  },
]

export function AdminPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('member')
  const [inviting, setInviting] = useState(false)
  const [editingUser, setEditingUser] = useState<string | null>(null)
  const [editDropdownRect, setEditDropdownRect] = useState<DOMRect | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false)
  const roleDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchUsers()
  }, [])

  useEffect(() => {
    if (!roleDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (roleDropdownRef.current && !roleDropdownRef.current.contains(e.target as Node)) {
        setRoleDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [roleDropdownOpen])

  useEffect(() => {
    if (!editDropdownRect) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.pm-custom-dropdown') && !target.closest('.pm-custom-dropdown-menu')) {
        setEditingUser(null)
        setEditDropdownRect(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [editDropdownRect])

  const fetchUsers = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await api.getUsers()
      if (response.success && response.data) {
        setUsers(response.data)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch users')
    } finally {
      setLoading(false)
    }
  }

  const handleInviteUser = async () => {
    if (!inviteEmail.trim()) return

    try {
      setInviting(true)
      await api.inviteUser(inviteEmail, inviteRole)
      setShowInviteModal(false)
      setInviteEmail('')
      setInviteRole('member')
      // Refresh user list
      fetchUsers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite user')
    } finally {
      setInviting(false)
    }
  }

  const handleUpdateRole = async (userId: string, newRole: UserRole) => {
    try {
      await api.updateUserRole(userId, newRole)
      setUsers(prev =>
        prev.map(u => (u.id === userId ? { ...u, role: newRole } : u))
      )
      setEditingUser(null)
      setEditDropdownRect(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role')
    }
  }

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to remove this user?')) return

    try {
      await api.deleteUser(userId)
      setUsers(prev => prev.filter(u => u.id !== userId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user')
    }
  }

  const getRoleBadgeClass = (role: UserRole) => {
    switch (role) {
      case 'admin':
        return 'role-admin'
      case 'project_manager':
        return 'role-pm'
      case 'member':
        return 'role-member'
      case 'viewer':
        return 'role-viewer'
      default:
        return ''
    }
  }

  const filteredUsers = users.filter(
    user =>
      user.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.email.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="admin-page">
      <div className="page-header">
        <div className="header-left">
          <h1 className="page-title">User Management</h1>
          <p className="page-subtitle">Manage team members and their roles</p>
        </div>
        <div className="header-right">
          <button
            className="btn btn-primary"
            onClick={() => setShowInviteModal(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <line x1="20" y1="8" x2="20" y2="14" />
              <line x1="23" y1="11" x2="17" y2="11" />
            </svg>
            Invite User
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
          <button className="alert-close" onClick={() => setError(null)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      <div className="admin-content glass-card">
        <div className="admin-toolbar">
          <div className="search-box">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="user-count">
            {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}
          </div>
        </div>

        {loading ? (
          <div className="loading-state">
            <SprintScanLoader size={48} />
            <p>Loading users...</p>
          </div>
        ) : filteredUsers.length > 0 ? (
          <div className="users-table">
            <div className="table-header">
              <div className="col-user">User</div>
              <div className="col-role">Role</div>
              <div className="col-joined">Joined</div>
              <div className="col-actions">Actions</div>
            </div>
            {filteredUsers.map(user => (
              <div key={user.id} className="table-row">
                <div className="col-user">
                  <div className="user-avatar">
                    {user.picture ? (
                      <img src={user.picture} alt={user.name} />
                    ) : (
                      <span>{user.name?.charAt(0).toUpperCase() || user.email.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="user-info">
                    <span className="user-name">{user.name || 'No Name'}</span>
                    <span className="user-email">{user.email}</span>
                  </div>
                </div>
                <div className="col-role">
                  {editingUser === user.id ? (
                    <div className="pm-custom-dropdown">
                      <button
                        className="pm-custom-dropdown-trigger admin-edit-role-trigger"
                        onClick={(e) => {
                          const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                          setEditDropdownRect(r => r ? null : rect)
                        }}
                      >
                        {user.role === 'admin'           && <Shield size={13} />}
                        {user.role === 'project_manager' && <Briefcase size={13} />}
                        {user.role === 'member'          && <UserIcon size={13} />}
                        {user.role === 'viewer'          && <Eye size={13} />}
                        <span>{ROLES.find(r => r.value === user.role)?.label}</span>
                        <ChevronDown size={11} className="dropdown-chevron open" />
                      </button>
                      {editDropdownRect && createPortal(
                        <div
                          className="pm-custom-dropdown-menu"
                          style={{ position: 'fixed', top: editDropdownRect.bottom + 4, left: editDropdownRect.left, minWidth: editDropdownRect.width, zIndex: 9999 }}
                        >
                          {ROLES.map(role => (
                            <button
                              key={role.value}
                              className={`pm-dropdown-item ${user.role === role.value ? 'active' : ''}`}
                              onClick={() => { handleUpdateRole(user.id, role.value); setEditDropdownRect(null) }}
                            >
                              {role.value === 'admin'           && <Shield size={13} />}
                              {role.value === 'project_manager' && <Briefcase size={13} />}
                              {role.value === 'member'          && <UserIcon size={13} />}
                              {role.value === 'viewer'          && <Eye size={13} />}
                              <span>{role.label}</span>
                            </button>
                          ))}
                        </div>,
                        document.body
                      )}
                    </div>
                  ) : (
                    <span
                      className={`role-badge ${getRoleBadgeClass(user.role)}`}
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setEditingUser(user.id)
                        setEditDropdownRect(rect)
                      }}
                      title="Click to edit"
                    >
                      {user.role.replace('_', ' ')}
                    </span>
                  )}
                </div>
                <div className="col-joined">
                  {new Date(user.created_at).toLocaleDateString()}
                </div>
                <div className="col-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setEditingUser(user.id)}
                    title="Edit role"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-danger"
                    onClick={() => handleDeleteUser(user.id)}
                    title="Remove user"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <h3>No users found</h3>
            <p>Try adjusting your search or invite new team members</p>
          </div>
        )}
      </div>

      {/* Role Permissions Reference */}
      <div className="role-permissions glass-card">
        <h2>Role Permissions</h2>
        <div className="permissions-grid">
          {ROLES.map(role => (
            <div key={role.value} className="permission-card">
              <span className={`role-badge ${getRoleBadgeClass(role.value)}`}>
                {role.label}
              </span>
              <p>{role.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Invite Modal */}
      {showInviteModal && (
        <div className="modal-overlay" onClick={() => setShowInviteModal(false)}>
          <div className="modal glass-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Invite User</h2>
              <button
                className="modal-close"
                onClick={() => setShowInviteModal(false)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="invite-email">Email Address</label>
                <input
                  id="invite-email"
                  type="email"
                  placeholder="user@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Role</label>
                <div className="pm-custom-dropdown admin-role-dropdown" ref={roleDropdownRef}>
                  <button
                    type="button"
                    className="pm-custom-dropdown-trigger admin-role-trigger"
                    onClick={() => setRoleDropdownOpen(o => !o)}
                  >
                    {inviteRole === 'admin'           && <Shield size={14} />}
                    {inviteRole === 'project_manager' && <Briefcase size={14} />}
                    {inviteRole === 'member'          && <UserIcon size={14} />}
                    {inviteRole === 'viewer'          && <Eye size={14} />}
                    <span>{ROLES.find(r => r.value === inviteRole)?.label}</span>
                    <ChevronDown size={12} className={`dropdown-chevron ${roleDropdownOpen ? 'open' : ''}`} />
                  </button>
                  {roleDropdownOpen && (
                    <div className="pm-custom-dropdown-menu admin-role-menu">
                      {ROLES.map(role => (
                        <button
                          key={role.value}
                          type="button"
                          className={`pm-dropdown-item ${inviteRole === role.value ? 'active' : ''}`}
                          onClick={() => { setInviteRole(role.value); setRoleDropdownOpen(false) }}
                        >
                          {role.value === 'admin'           && <Shield size={14} />}
                          {role.value === 'project_manager' && <Briefcase size={14} />}
                          {role.value === 'member'          && <UserIcon size={14} />}
                          {role.value === 'viewer'          && <Eye size={14} />}
                          <span>{role.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="form-hint">
                  {ROLES.find(r => r.value === inviteRole)?.description}
                </p>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setShowInviteModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleInviteUser}
                disabled={inviting || !inviteEmail.trim()}
              >
                {inviting ? 'Sending...' : 'Send Invitation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
