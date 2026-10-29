import { useState, useEffect } from 'react'
import type { Task, TaskStatus, TaskPriority } from '../types'
import api from '../services/api'
import { SprintScanLoader } from '@/components/brand/VelocityLoaders'

type SortField = 'title' | 'status' | 'priority' | 'due_date' | 'created_at'
type SortDirection = 'asc' | 'desc'

export function ListPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('created_at')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [filterStatus, setFilterStatus] = useState<TaskStatus | 'all'>('all')
  const [filterPriority, setFilterPriority] = useState<TaskPriority | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    fetchTasks()
  }, [])

  const fetchTasks = async () => {
    try {
      setLoading(true)
      const response = await api.getTasks()
      if (response.success && response.data) {
        setTasks(response.data as Task[])
      }
    } catch (err) {
      setError('Failed to load tasks')
      console.error('Error fetching tasks:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const handleStatusChange = async (taskId: string, newStatus: TaskStatus) => {
    // Optimistic update
    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId ? { ...task, status: newStatus } : task
      )
    )

    try {
      await api.updateTaskStatus(taskId, newStatus)
      await api.syncTaskToAsana(taskId, newStatus).catch(() => {})
    } catch (err) {
      fetchTasks()
      console.error('Error updating task status:', err)
    }
  }

  // Filter and sort tasks
  const filteredTasks = tasks
    .filter((task) => {
      if (filterStatus !== 'all' && task.status !== filterStatus) return false
      if (filterPriority !== 'all' && task.priority !== filterPriority) return false
      if (searchQuery && !task.title.toLowerCase().includes(searchQuery.toLowerCase())) return false
      return true
    })
    .sort((a, b) => {
      let comparison = 0
      switch (sortField) {
        case 'title':
          comparison = a.title.localeCompare(b.title)
          break
        case 'status':
          comparison = a.status.localeCompare(b.status)
          break
        case 'priority':
          const priorityOrder = { high: 3, medium: 2, low: 1 }
          comparison = (priorityOrder[a.priority] || 0) - (priorityOrder[b.priority] || 0)
          break
        case 'due_date':
          const dateA = a.due_date ? new Date(a.due_date).getTime() : 0
          const dateB = b.due_date ? new Date(b.due_date).getTime() : 0
          comparison = dateA - dateB
          break
        case 'created_at':
          const createdA = a.created_at ? new Date(a.created_at).getTime() : 0
          const createdB = b.created_at ? new Date(b.created_at).getTime() : 0
          comparison = createdA - createdB
          break
      }
      return sortDirection === 'asc' ? comparison : -comparison
    })

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return '↕'
    return sortDirection === 'asc' ? '↑' : '↓'
  }

  if (loading) {
    return (
      <div className="list-page">
        <div className="loading-screen">
          <SprintScanLoader size={48} />
          <p>Loading tasks...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="list-page">
        <div className="error-state">
          <h3>Error Loading Tasks</h3>
          <p>{error}</p>
          <button className="btn btn-primary" onClick={fetchTasks}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="list-page">
      <div className="list-header">
        <div className="list-header-left">
          <h1 className="list-title">Task List</h1>
          <span className="list-task-count">{filteredTasks.length} of {tasks.length} tasks</span>
        </div>
      </div>

      {/* Filters and Search */}
      <div className="list-controls">
        <div className="search-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="filter-controls">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as TaskStatus | 'all')}
            className="filter-select"
          >
            <option value="all">All Status</option>
            <option value="todo">To Do</option>
            <option value="in_progress">In Progress</option>
            <option value="review">Review</option>
            <option value="done">Done</option>
          </select>

          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value as TaskPriority | 'all')}
            className="filter-select"
          >
            <option value="all">All Priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      {/* Task Table */}
      <div className="list-table-container glass-card">
        <table className="list-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('title')} className="sortable">
                Task {getSortIcon('title')}
              </th>
              <th onClick={() => handleSort('status')} className="sortable">
                Status {getSortIcon('status')}
              </th>
              <th onClick={() => handleSort('priority')} className="sortable">
                Priority {getSortIcon('priority')}
              </th>
              <th onClick={() => handleSort('due_date')} className="sortable">
                Due Date {getSortIcon('due_date')}
              </th>
              <th>Assignee</th>
              <th>Asana</th>
            </tr>
          </thead>
          <tbody>
            {filteredTasks.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-row">
                  No tasks found
                </td>
              </tr>
            ) : (
              filteredTasks.map((task) => (
                <tr key={task.id} className="task-row">
                  <td className="task-title-cell">
                    <div className="task-title-content">
                      <span className="task-title">{task.title}</span>
                      {task.description && (
                        <span className="task-description-preview">
                          {task.description.length > 50
                            ? `${task.description.substring(0, 50)}...`
                            : task.description}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <select
                      value={task.status}
                      onChange={(e) => handleStatusChange(task.id, e.target.value as TaskStatus)}
                      className={`status-select status-${task.status}`}
                    >
                      <option value="todo">To Do</option>
                      <option value="in_progress">In Progress</option>
                      <option value="review">Review</option>
                      <option value="done">Done</option>
                    </select>
                  </td>
                  <td>
                    <span className={`priority-badge priority-${task.priority}`}>
                      {task.priority}
                    </span>
                  </td>
                  <td className="due-date-cell">
                    {task.due_date ? (
                      <span className={isOverdue(task.due_date) ? 'overdue' : ''}>
                        {formatDate(task.due_date)}
                      </span>
                    ) : (
                      <span className="no-date">-</span>
                    )}
                  </td>
                  <td className="assignee-cell">
                    {task.assignee ? (
                      <div className="assignee-info">
                        {task.assignee.picture ? (
                          <img
                            src={task.assignee.picture}
                            alt={task.assignee.name}
                            className="assignee-avatar-sm"
                          />
                        ) : (
                          <div className="assignee-placeholder-sm">
                            {task.assignee.name?.charAt(0).toUpperCase() || '?'}
                          </div>
                        )}
                        <span className="assignee-name">{task.assignee.name}</span>
                      </div>
                    ) : (
                      <span className="unassigned">Unassigned</span>
                    )}
                  </td>
                  <td className="asana-cell">
                    {task.asana_url ? (
                      <a
                        href={task.asana_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="asana-link-icon"
                        title="View in Asana"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M18.77,10.5c-1.99,0-3.62,1.61-3.62,3.6s1.62,3.6,3.62,3.6,3.62-1.61,3.62-3.6-1.62-3.6-3.62-3.6Z"/>
                          <path d="M5.23,10.5c-1.99,0-3.62,1.61-3.62,3.6s1.62,3.6,3.62,3.6,3.62-1.61,3.62-3.6-1.62-3.6-3.62-3.6Z"/>
                          <path d="M12,3.3c-1.99,0-3.62,1.61-3.62,3.6s1.62,3.6,3.62,3.6,3.62-1.61,3.62-3.6-1.62-3.6-3.62-3.6Z"/>
                        </svg>
                      </a>
                    ) : (
                      <span className="no-asana">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  if (date.toDateString() === today.toDateString()) {
    return 'Today'
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return 'Tomorrow'
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function isOverdue(dateString: string): boolean {
  const date = new Date(dateString)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return date < today
}
