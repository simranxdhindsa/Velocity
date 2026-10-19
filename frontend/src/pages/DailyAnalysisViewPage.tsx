import { useState, useEffect, useCallback } from 'react'
import { Calendar, CheckCircle, Clock, XCircle, AlertTriangle, ChevronLeft, ChevronRight, X, User } from 'lucide-react'
import { getYouTrackAvatarMap } from '../services/api'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
} from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import api from '../services/api'
import { SprintScanLoader } from '@/components/brand/VelocityLoaders'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

interface TasksByAssignee {
  assignee: string
  completed: string[]
  pending: string[]
  blocked: string[]
  skipped: string[]
}

interface DailyTaskItem {
  id: string
  title: string
  assignee: string
  status: 'completed' | 'pending' | 'blocked' | 'skipped'
}

type FilterStatus = 'all' | 'completed' | 'pending' | 'blocked' | 'skipped'

// Task List Modal Component
function TaskListModal({
  isOpen,
  onClose,
  title,
  tasks,
  statusColor,
  statusIcon,
}: {
  isOpen: boolean
  onClose: () => void
  title: string
  tasks: DailyTaskItem[]
  statusColor: string
  statusIcon: React.ReactNode
}) {
  if (!isOpen) return null

  // Group tasks by assignee
  const tasksByAssignee = tasks.reduce((acc, task) => {
    if (!acc[task.assignee]) {
      acc[task.assignee] = []
    }
    acc[task.assignee].push(task)
    return acc
  }, {} as Record<string, DailyTaskItem[]>)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content task-list-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ borderBottomColor: statusColor }}>
          <div className="modal-title-group">
            {statusIcon}
            <h2>{title}</h2>
            <span className="modal-count">{tasks.length} tasks</span>
          </div>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          {tasks.length === 0 ? (
            <div className="empty-list">
              <p>No tasks in this category</p>
            </div>
          ) : (
            Object.entries(tasksByAssignee).map(([assignee, assigneeTasks]) => (
              <div key={assignee} className="task-list-group">
                <div className="task-list-assignee">
                  <User size={16} />
                  <span>@{assignee}</span>
                  <span className="assignee-task-count">{assigneeTasks.length}</span>
                </div>
                <ul className="task-list-items">
                  {assigneeTasks.map((task) => (
                    <li key={task.id} className="task-list-item">
                      <span className="task-bullet" style={{ backgroundColor: statusColor }} />
                      <span className="task-text">{task.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// Sortable Task Card - uses same styling as Dashboard TaskCard
function SortableTaskCard({ task, avatarUrl }: { task: DailyTaskItem; avatarUrl?: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard task={task} isDragging={isDragging} avatarUrl={avatarUrl} />
    </div>
  )
}

// Task Card Component - styled exactly like Dashboard TaskCard
function TaskCard({ task, isDragging, avatarUrl }: { task: DailyTaskItem; isDragging?: boolean; avatarUrl?: string }) {
  const getStatusBadgeClass = () => {
    switch (task.status) {
      case 'completed':
        return 'priority-low' // Green
      case 'pending':
        return 'priority-medium' // Yellow/Orange
      case 'blocked':
        return 'priority-high' // Red
      default:
        return 'priority-medium'
    }
  }

  const getStatusLabel = () => {
    switch (task.status) {
      case 'completed':
        return 'Done'
      case 'pending':
        return 'Pending'
      case 'blocked':
        return 'Blocked'
      case 'skipped':
        return 'Not Mentioned'
      default:
        return task.status
    }
  }

  return (
    <div className={`task-card ${isDragging ? 'task-card-dragging' : ''} ${getStatusBadgeClass()}`}>
      <div className="task-card-header">
        <span className={`task-priority-badge ${getStatusBadgeClass()}`}>
          {getStatusLabel()}
        </span>
      </div>

      <h4 className="task-card-title">{task.title}</h4>

      <div className="task-card-footer">
        <div className="task-card-meta"></div>
        <div className="task-assignee" title={task.assignee}>
          {avatarUrl ? (
            <img src={avatarUrl} alt={task.assignee} className="task-assignee-avatar" />
          ) : (
            <div className="task-assignee-placeholder">
              {task.assignee?.charAt(0).toUpperCase() || '?'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Kanban Column Component - styled exactly like Dashboard KanbanColumn
function KanbanColumn({
  id,
  title,
  icon,
  color,
  tasks,
  avatarMap,
}: {
  id: string
  title: string
  icon: React.ReactNode
  color: string
  tasks: DailyTaskItem[]
  avatarMap: Record<string, string>
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const taskIds = tasks.map((t) => t.id)

  return (
    <div
      ref={setNodeRef}
      className={`kanban-column ${isOver ? 'column-drag-over' : ''}`}
      data-status={id}
    >
      <div className="kanban-column-header">
        <div className="column-header-title">
          <span
            className="column-status-dot"
            style={{ backgroundColor: color }}
          />
          <h3 className="column-title">{title}</h3>
          <span className="column-task-count">{tasks.length}</span>
        </div>
      </div>

      <div className="kanban-column-content">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 ? (
            <div className="column-empty-state">
              <p>No tasks</p>
            </div>
          ) : (
            tasks.map((task) => (
              <SortableTaskCard key={task.id} task={task} avatarUrl={avatarMap[task.assignee]} />
            ))
          )}
        </SortableContext>
      </div>
    </div>
  )
}

export function DailyAnalysisViewPage() {
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date()
    return today.toISOString().split('T')[0]
  })
  const [tasksByAssignee, setTasksByAssignee] = useState<TasksByAssignee[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTask, setActiveTask] = useState<DailyTaskItem | null>(null)
  const [modalFilter, setModalFilter] = useState<FilterStatus | null>(null)
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({})

  useEffect(() => { getYouTrackAvatarMap().then(setAvatarMap) }, [])

  // Configure sensors with distance constraint to prevent accidental drags
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  )

  // Convert tasksByAssignee to flat list of DailyTaskItem
  const getAllTasks = useCallback((): DailyTaskItem[] => {
    const tasks: DailyTaskItem[] = []
    let idCounter = 0

    tasksByAssignee.forEach((assignee) => {
      assignee.completed.forEach((title) => {
        tasks.push({
          id: `task-${idCounter++}`,
          title,
          assignee: assignee.assignee,
          status: 'completed',
        })
      })
      assignee.pending.forEach((title) => {
        tasks.push({
          id: `task-${idCounter++}`,
          title,
          assignee: assignee.assignee,
          status: 'pending',
        })
      })
      assignee.blocked.forEach((title) => {
        tasks.push({
          id: `task-${idCounter++}`,
          title,
          assignee: assignee.assignee,
          status: 'blocked',
        })
      })
      assignee.skipped.forEach((title) => {
        tasks.push({
          id: `task-${idCounter++}`,
          title,
          assignee: assignee.assignee,
          status: 'skipped',
        })
      })
    })

    return tasks
  }, [tasksByAssignee])

  const allTasks = getAllTasks()

  // Fetch today's tasks
  useEffect(() => {
    const fetchTodaysTasks = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await api.getTodaysTasks(selectedDate)
        if (response.success && response.data) {
          setTasksByAssignee(response.data as TasksByAssignee[])
        } else {
          setTasksByAssignee([])
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load tasks')
        setTasksByAssignee([])
      } finally {
        setLoading(false)
      }
    }

    fetchTodaysTasks()
  }, [selectedDate])

  // Date navigation
  const navigateDate = (days: number) => {
    const date = new Date(selectedDate + 'T00:00:00')
    date.setDate(date.getDate() + days)
    setSelectedDate(date.toISOString().split('T')[0])
  }

  const setToday = () => {
    setSelectedDate(new Date().toISOString().split('T')[0])
  }

  const isToday = selectedDate === new Date().toISOString().split('T')[0]

  // Calculate summary stats
  const totalCompleted = tasksByAssignee.reduce((sum, a) => sum + a.completed.length, 0)
  const totalPending = tasksByAssignee.reduce((sum, a) => sum + a.pending.length, 0)
  const totalBlocked = tasksByAssignee.reduce((sum, a) => sum + a.blocked.length, 0)
  const totalSkipped = tasksByAssignee.reduce((sum, a) => sum + a.skipped.length, 0)
  const totalTasks = totalCompleted + totalPending + totalBlocked + totalSkipped

  // Drag handlers
  const handleDragStart = (event: DragStartEvent) => {
    const task = allTasks.find((t) => t.id === event.active.id)
    if (task) {
      setActiveTask(task)
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveTask(null)

    if (!over) return

    const taskId = active.id as string
    const newStatus = over.id as 'completed' | 'pending' | 'blocked' | 'skipped'
    const task = allTasks.find((t) => t.id === taskId)

    if (!task || task.status === newStatus) return

    // Update local state optimistically
    setTasksByAssignee((prev) => {
      return prev.map((assignee) => {
        if (assignee.assignee !== task.assignee) return assignee

        // Remove from old status
        const updated = { ...assignee }
        updated[task.status] = updated[task.status].filter((t) => t !== task.title)
        // Add to new status
        updated[newStatus] = [...updated[newStatus], task.title]

        return updated
      })
    })
  }

  // Get tasks by status
  const getTasksByStatus = (status: 'completed' | 'pending' | 'blocked' | 'skipped') => {
    return allTasks.filter((t) => t.status === status)
  }

  // Get modal title and styling based on filter
  const getModalConfig = (filter: FilterStatus) => {
    switch (filter) {
      case 'completed':
        return {
          title: 'Completed Tasks',
          color: 'var(--color-success)',
          icon: <CheckCircle size={24} color="var(--color-success)" />,
          tasks: getTasksByStatus('completed'),
        }
      case 'pending':
        return {
          title: 'Pending Tasks',
          color: 'var(--color-warning)',
          icon: <Clock size={24} color="var(--color-warning)" />,
          tasks: getTasksByStatus('pending'),
        }
      case 'blocked':
        return {
          title: 'Blocked Tasks',
          color: 'var(--color-danger)',
          icon: <XCircle size={24} color="var(--color-danger)" />,
          tasks: getTasksByStatus('blocked'),
        }
      case 'skipped':
        return {
          title: 'Not Mentioned Tasks',
          color: 'var(--color-secondary)',
          icon: <AlertTriangle size={24} color="var(--color-secondary)" />,
          tasks: getTasksByStatus('skipped'),
        }
      default:
        return {
          title: 'All Tasks',
          color: 'var(--color-primary)',
          icon: <CheckCircle size={24} color="var(--color-primary)" />,
          tasks: allTasks,
        }
    }
  }

  const modalConfig = modalFilter ? getModalConfig(modalFilter) : null

  return (
    <div className="daily-analysis-view-page">
      {/* Header with Date Navigation */}
      <div className="page-header">
        <div>
          <h1 className="page-title">
            <CheckCircle size={28} style={{ color: 'var(--color-success)' }} />
            Daily Task Analysis
          </h1>
          <p className="page-subtitle">
            View task completion status from AI analysis
          </p>
        </div>
        <div className="date-navigation">
          <button className="btn btn-ghost btn-sm" onClick={() => navigateDate(-1)}>
            <ChevronLeft size={16} />
          </button>
          <div className="date-display">
            <Calendar size={16} />
            <span>
              {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
                weekday: 'short',
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigateDate(1)}>
            <ChevronRight size={16} />
          </button>
          {!isToday && (
            <button className="btn btn-primary btn-sm" onClick={setToday}>
              Today
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <AlertTriangle size={20} />
          {error}
          <button className="alert-close" onClick={() => setError(null)}>
            &times;
          </button>
        </div>
      )}

      {loading && (
        <div className="daily-loading">
          <SprintScanLoader size={48} />
          <p>Loading analysis...</p>
        </div>
      )}

      {!loading && tasksByAssignee.length === 0 && (
        <div className="daily-empty-state glass-card">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            <VelocityLogo variant="icon" size="lg" showStatusDot={false} style={{ opacity: 0.3 }} />
          </div>
          <h3>No Analysis Available</h3>
          <p>
            No task analysis found for this date. Go to the AI Analysis page to analyze
            tasks for this day.
          </p>
        </div>
      )}

      {!loading && tasksByAssignee.length > 0 && (
        <>
          {/* Summary Cards - Clickable */}
          <div className="ai-summary-grid">
            <div
              className="ai-summary-card glass-card clickable"
              onClick={() => setModalFilter('all')}
            >
              <div className="ai-summary-icon" style={{ backgroundColor: 'rgba(var(--color-primary-rgb), 0.2)' }}>
                <CheckCircle size={24} color="var(--color-primary)" />
              </div>
              <div className="ai-summary-content">
                <span className="ai-summary-value">{totalTasks}</span>
                <span className="ai-summary-label">Total Tasks</span>
              </div>
            </div>

            <div
              className="ai-summary-card glass-card clickable"
              onClick={() => setModalFilter('completed')}
            >
              <div className="ai-summary-icon" style={{ backgroundColor: 'rgba(16, 185, 129, 0.2)' }}>
                <CheckCircle size={24} color="var(--color-success)" />
              </div>
              <div className="ai-summary-content">
                <span className="ai-summary-value">{totalCompleted}</span>
                <span className="ai-summary-label">Completed</span>
              </div>
            </div>

            <div
              className="ai-summary-card glass-card clickable"
              onClick={() => setModalFilter('pending')}
            >
              <div className="ai-summary-icon" style={{ backgroundColor: 'rgba(245, 158, 11, 0.2)' }}>
                <Clock size={24} color="var(--color-warning)" />
              </div>
              <div className="ai-summary-content">
                <span className="ai-summary-value">{totalPending}</span>
                <span className="ai-summary-label">Pending</span>
              </div>
            </div>

            <div
              className="ai-summary-card glass-card clickable"
              onClick={() => setModalFilter('blocked')}
            >
              <div className="ai-summary-icon" style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)' }}>
                <XCircle size={24} color="var(--color-danger)" />
              </div>
              <div className="ai-summary-content">
                <span className="ai-summary-value">{totalBlocked}</span>
                <span className="ai-summary-label">Blocked</span>
              </div>
            </div>
          </div>

          {/* Kanban Board with Drag & Drop - Same styling as Dashboard */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="kanban-board">
              <div className="kanban-columns">
                <KanbanColumn
                  id="completed"
                  title="Completed"
                  icon={<CheckCircle size={20} />}
                  color="var(--status-done)"
                  tasks={getTasksByStatus('completed')}
                  avatarMap={avatarMap}
                />
                <KanbanColumn
                  id="pending"
                  title="Pending"
                  icon={<Clock size={20} />}
                  color="var(--status-in-progress)"
                  tasks={getTasksByStatus('pending')}
                  avatarMap={avatarMap}
                />
                <KanbanColumn
                  id="blocked"
                  title="Blocked"
                  icon={<XCircle size={20} />}
                  color="var(--color-danger)"
                  tasks={getTasksByStatus('blocked')}
                  avatarMap={avatarMap}
                />
                {totalSkipped > 0 && (
                  <KanbanColumn
                    id="skipped"
                    title="Not Mentioned"
                    icon={<AlertTriangle size={20} />}
                    color="var(--color-secondary)"
                    tasks={getTasksByStatus('skipped')}
                    avatarMap={avatarMap}
                  />
                )}
              </div>
            </div>

            {/* Drag Overlay - shows the dragged card */}
            <DragOverlay>
              {activeTask ? (
                <TaskCard task={activeTask} isDragging />
              ) : null}
            </DragOverlay>
          </DndContext>
        </>
      )}

      {/* Task List Modal */}
      {modalConfig && (
        <TaskListModal
          isOpen={!!modalFilter}
          onClose={() => setModalFilter(null)}
          title={modalConfig.title}
          tasks={modalConfig.tasks}
          statusColor={modalConfig.color}
          statusIcon={modalConfig.icon}
        />
      )}
    </div>
  )
}
