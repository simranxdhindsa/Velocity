import { useState } from 'react'
import { CalendarView } from '../components/calendar/CalendarView'
import type { Task } from '../types'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

export function CalendarPage() {
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [selectedTasks, setSelectedTasks] = useState<Task[]>([])

  const handleDateSelect = (date: Date, tasks: Task[]) => {
    setSelectedDate(date)
    setSelectedTasks(tasks)
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  const getPriorityIcon = (priority: string) => {
    switch (priority) {
      case 'high':
        return '🔴'
      case 'medium':
        return '🟡'
      case 'low':
        return '🟢'
      default:
        return '⚪'
    }
  }

  const getStatusClass = (status: string) => {
    return `status-${status.replace(' ', '_')}`
  }

  return (
    <div className="calendar-page">
      <div className="page-header">
        <h1 className="page-title">Calendar</h1>
        <p className="page-subtitle">View and navigate tasks by date</p>
      </div>

      <div className="calendar-layout">
        <div className="calendar-main">
          <CalendarView
            onDateSelect={handleDateSelect}
            selectedDate={selectedDate || undefined}
          />
        </div>

        <div className="calendar-sidebar glass-card">
          {selectedDate ? (
            <>
              <div className="sidebar-header">
                <h3>{formatDate(selectedDate)}</h3>
                <span className="task-count">
                  {selectedTasks.length} task{selectedTasks.length !== 1 ? 's' : ''}
                </span>
              </div>

              {selectedTasks.length > 0 ? (
                <div className="task-list">
                  {selectedTasks.map((task) => (
                    <div key={task.id} className="task-item">
                      <div className="task-header">
                        <span className="priority-icon">{getPriorityIcon(task.priority)}</span>
                        <span className="task-title">{task.title}</span>
                      </div>
                      <div className="task-meta">
                        <span className={`task-status ${getStatusClass(task.status)}`}>
                          {task.status.replace('_', ' ')}
                        </span>
                        {task.assignee && (
                          <span className="task-assignee">
                            {task.assignee.picture ? (
                              <img src={task.assignee.picture} alt={task.assignee.name} />
                            ) : (
                              <span className="assignee-initial">
                                {task.assignee.name?.charAt(0).toUpperCase()}
                              </span>
                            )}
                            {task.assignee.name}
                          </span>
                        )}
                      </div>
                      {task.asana_url && (
                        <a
                          href={task.asana_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="asana-link"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                          View in Asana
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="no-tasks">
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                    <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
                  </div>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <p>No tasks scheduled for this date</p>
                </div>
              )}
            </>
          ) : (
            <div className="no-selection">
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
              </div>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <p>Select a date to view tasks</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
