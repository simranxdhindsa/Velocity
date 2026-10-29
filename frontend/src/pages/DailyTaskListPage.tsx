import { useState, useEffect, useCallback } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  RefreshCw,
  Plus,
  Trash2,
  GripVertical,
  UserPlus,
  X,
  Link2,
  CheckSquare,
  Square,
  AlertCircle,
} from 'lucide-react'
import api from '../services/api'
import { ConfirmModal } from '../components/ConfirmModal'
import { SprintScanLoader } from '@/components/brand/VelocityLoaders'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

// NextDayTask interface for new API
interface NextDayTask {
  id: string
  target_date: string
  assignee: string
  task_title: string
  priority: string
  position: number
  is_carried_forward: boolean
  source_date?: string
  notes?: string
}

interface NextDayAssignment {
  user_name: string
  slack_handle: string
  tasks: NextDayTask[]
}

interface NextDayTaskList {
  date: string
  assignments: NextDayAssignment[]
}

// YouTrack Pull interfaces
interface YTPullIssue {
  id: string
  idReadable?: string
  summary: string
  priority_tag: string
  clean_title: string
  status: string
  selected: boolean
}

interface YTPullAssignment {
  user_name: string
  slack_handle: string
  issues: YTPullIssue[]
}

// ====== Sortable Task Item Component ======
function SortableTaskItem({
  item,
  onDelete,
}: {
  item: NextDayTask
  onDelete: (id: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="daily-task-item"
    >
      <div
        className="drag-handle"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </div>
      <div className="daily-task-item-content">
        <span className="daily-task-title">{item.task_title}</span>
        <div className="daily-task-badges">
          {item.priority === 'high' && (
            <span
              className="priority-tag priority-high"
            >
              HIGH
            </span>
          )}
          {item.is_carried_forward && (
            <span className="carried-over-tag">carried over</span>
          )}
        </div>
        {item.notes && (
          <div className="task-notes">{item.notes}</div>
        )}
      </div>
      <button
        className="daily-task-delete"
        onClick={() => onDelete(item.id)}
        title="Remove task"
      >
        <X size={14} />
      </button>
    </div>
  )
}

// ====== Drag Overlay Item ======
function DragOverlayItem({ item }: { item: NextDayTask }) {
  return (
    <div className="daily-task-item dragging-overlay">
      <div className="drag-handle">
        <GripVertical size={14} />
      </div>
      <div className="daily-task-item-content">
        <span className="daily-task-title">{item.task_title}</span>
      </div>
    </div>
  )
}

// ====== Main Page Component ======
export function DailyTaskListPage() {
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date()
    return today.toISOString().split('T')[0]
  })
  const [taskList, setTaskList] = useState<NextDayTaskList | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [activeItem, setActiveItem] = useState<NextDayTask | null>(null)
  const [showAddPerson, setShowAddPerson] = useState(false)
  const [newPersonName, setNewPersonName] = useState('')
  const [newPersonHandle, setNewPersonHandle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [addingTaskFor, setAddingTaskFor] = useState<string | null>(null)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskPriority, setNewTaskPriority] = useState<'high' | 'medium' | 'low'>('medium')
  const [newTaskNotes, setNewTaskNotes] = useState('')

  // YouTrack pull state
  const [pullingFromYT, setPullingFromYT] = useState(false)
  const [ytPullData, setYtPullData] = useState<YTPullAssignment[] | null>(null)
  const [ytSelections, setYtSelections] = useState<Record<string, Record<string, boolean>>>({})
  const [addingFromYT, setAddingFromYT] = useState(false)

  // Calendar state
  const [calendarDate, setCalendarDate] = useState(() => new Date())

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Fetch task list for selected date
  const fetchTaskList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.getNextDayTasks(selectedDate)
      if (response.success && response.data) {
        setTaskList({ ...response.data, assignments: response.data.assignments ?? [] })
      } else {
        setTaskList(null)
      }
    } catch (err) {
      setTaskList(null)
      setError(err instanceof Error ? err.message : 'Failed to load task list')
    } finally {
      setLoading(false)
    }
  }, [selectedDate])

  useEffect(() => {
    fetchTaskList()
  }, [fetchTaskList])

  // Generate task list from previous day's pending tasks
  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    try {
      // Calculate yesterday's date
      const yesterday = new Date(selectedDate)
      yesterday.setDate(yesterday.getDate() - 1)
      const sourceDate = yesterday.toISOString().split('T')[0]

      const response = await api.generateNextDayTasks(sourceDate, selectedDate)
      if (response.success && response.data) {
        setTaskList({ ...response.data, assignments: response.data.assignments ?? [] })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate task list')
    } finally {
      setGenerating(false)
    }
  }

  // Copy to clipboard with Slack formatting
  const handleCopy = async () => {
    try {
      const response = await api.getFormattedSlackMessage(selectedDate)
      if (response.success && response.data) {
        await navigator.clipboard.writeText(response.data.formatted_message)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch {
      // Fallback: generate text client-side
      if (taskList) {
        const text = generateSlackText(taskList)
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }
  }

  // Client-side Slack text generation
  const generateSlackText = (list: NextDayTaskList): string => {
    let text = 'todays task list\n'
    for (const assignment of list.assignments) {
      text += `\n${assignment.slack_handle} \n`
      for (const task of assignment.tasks) {
        text += `${task.task_title}\n`
      }
    }
    return text
  }

  // Pull from YouTrack
  const handlePullFromYouTrack = async () => {
    setPullingFromYT(true)
    try {
      const response = await api.getYouTrackIssuesGroupedByAssignee()
      if (response.success && response.data?.assignments) {
        const assignments = response.data.assignments
        setYtPullData(assignments)
        // Pre-select all issues
        const selections: Record<string, Record<string, boolean>> = {}
        for (const group of assignments) {
          selections[group.user_name] = {}
          for (const issue of group.issues) {
            selections[group.user_name][issue.id] = true
          }
        }
        setYtSelections(selections)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pull from YouTrack')
    } finally {
      setPullingFromYT(false)
    }
  }

  // Toggle issue selection
  const toggleIssueSelection = (assignee: string, issueId: string) => {
    setYtSelections(prev => ({
      ...prev,
      [assignee]: {
        ...prev[assignee],
        [issueId]: !prev[assignee]?.[issueId],
      },
    }))
  }

  // Toggle all issues for an assignee
  const toggleAssigneeSelection = (assignee: string, issues: YTPullIssue[]) => {
    const allSelected = issues.every(i => ytSelections[assignee]?.[i.id])
    setYtSelections(prev => ({
      ...prev,
      [assignee]: Object.fromEntries(issues.map(i => [i.id, !allSelected])),
    }))
  }

  // Get count of selected issues
  const getSelectedCount = () => {
    let count = 0
    for (const assignee of Object.keys(ytSelections)) {
      for (const selected of Object.values(ytSelections[assignee])) {
        if (selected) count++
      }
    }
    return count
  }

  // Accept selected YT issues and add to task list
  const handleAcceptYTPull = async () => {
    if (!ytPullData) return
    setAddingFromYT(true)
    try {
      const tasks: { assignee: string; task_title: string; priority?: string; youtrack_id?: string }[] = []
      for (const group of ytPullData) {
        for (const issue of group.issues) {
          if (ytSelections[group.user_name]?.[issue.id]) {
            tasks.push({
              assignee: group.user_name,
              task_title: issue.clean_title,
              priority: issue.priority_tag === 'P0' || issue.priority_tag === 'P1' ? 'high' : 'medium',
              youtrack_id: issue.id,
            })
          }
        }
      }

      if (tasks.length > 0) {
        const response = await api.bulkCreateNextDayTasks(selectedDate, tasks)
        if (response.success && response.data) {
          setTaskList({ ...response.data, assignments: response.data.assignments ?? [] })
        } else {
          await fetchTaskList()
        }
      }

      setYtPullData(null)
      setYtSelections({})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add YouTrack tasks')
    } finally {
      setAddingFromYT(false)
    }
  }

  // Drag handlers
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event
    if (!taskList) return
    for (const assignment of taskList.assignments) {
      const item = assignment.tasks.find((t) => t.id === active.id)
      if (item) {
        setActiveItem(item)
        break
      }
    }
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    setActiveItem(null)
    if (!over || !taskList || active.id === over.id) return

    // Find which assignment contains both items
    const updatedAssignments = taskList.assignments.map((assignment) => {
      const activeIndex = assignment.tasks.findIndex((t) => t.id === active.id)
      const overIndex = assignment.tasks.findIndex((t) => t.id === over.id)

      if (activeIndex !== -1 && overIndex !== -1) {
        const newTasks = arrayMove(assignment.tasks, activeIndex, overIndex)
        // Update positions
        const reorderedTasks = newTasks.map((t, i) => ({ ...t, position: i }))

        // Save to backend - use the assignee (user_name) as identifier
        api.reorderNextDayTasks(
          selectedDate,
          assignment.user_name,
          reorderedTasks.map((t) => t.id)
        ).catch(console.error)

        return { ...assignment, tasks: reorderedTasks }
      }
      return assignment
    })

    setTaskList({ ...taskList, assignments: updatedAssignments })
  }

  // Delete task item
  const handleDeleteItem = async (itemId: string) => {
    if (!taskList) return
    try {
      await api.deleteNextDayTask(itemId)
      const updatedAssignments = taskList.assignments.map((a) => ({
        ...a,
        tasks: a.tasks.filter((t) => t.id !== itemId),
      }))
      setTaskList({ ...taskList, assignments: updatedAssignments })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task')
    }
  }

  // Add task item
  const handleAddTaskItem = async (assignee: string) => {
    if (!newTaskTitle.trim() || !taskList) return
    try {
      const response = await api.createNextDayTask(
        selectedDate,
        assignee,
        newTaskTitle.trim(),
        newTaskPriority,
        newTaskNotes.trim() || undefined
      )
      if (response.success && response.data) {
        const updatedAssignments = taskList.assignments.map((a) =>
          a.user_name === assignee
            ? { ...a, tasks: [...a.tasks, response.data as NextDayTask] }
            : a
        )
        setTaskList({ ...taskList, assignments: updatedAssignments })
        setNewTaskTitle('')
        setNewTaskPriority('medium')
        setNewTaskNotes('')
        setAddingTaskFor(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add task')
    }
  }

  // Add person/assignment
  const handleAddPerson = async () => {
    if (!newPersonName.trim() || !newPersonHandle.trim() || !taskList) return

    const handle = newPersonHandle.startsWith('@')
      ? newPersonHandle
      : `@${newPersonHandle}`

    // Add new assignment to the list with empty tasks
    const newAssignment: NextDayAssignment = {
      user_name: newPersonName.trim(),
      slack_handle: handle,
      tasks: []
    }

    setTaskList({
      ...taskList,
      assignments: [...taskList.assignments, newAssignment],
    })

    setNewPersonName('')
    setNewPersonHandle('')
    setShowAddPerson(false)
  }

  // Delete assignment - remove all tasks for this person
  const handleDeleteAssignment = async (assignee: string) => {
    if (!taskList) return

    // Get all task IDs for this assignee
    const assignment = taskList.assignments.find((a) => a.user_name === assignee)
    if (!assignment) return

    try {
      // Delete all tasks for this assignee
      await Promise.all(assignment.tasks.map((task) => api.deleteNextDayTask(task.id)))

      // Remove assignment from list
      setTaskList({
        ...taskList,
        assignments: taskList.assignments.filter((a) => a.user_name !== assignee),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove person')
    }
  }

  // Calendar helpers
  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay()
  }

  const formatDateStr = (year: number, month: number, day: number) => {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const isToday = (dateStr: string) => {
    return dateStr === new Date().toISOString().split('T')[0]
  }

  const navigateMonth = (direction: number) => {
    setCalendarDate(
      new Date(calendarDate.getFullYear(), calendarDate.getMonth() + direction, 1)
    )
  }

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]

  const daysInMonth = getDaysInMonth(calendarDate)
  const firstDay = getFirstDayOfMonth(calendarDate)

  return (
    <div className="daily-task-page">
      {/* Left Side - Calendar + Controls */}
      <div className="daily-task-sidebar">
        {/* Mini Calendar */}
        <div className="daily-calendar glass-card">
          <div className="calendar-nav">
            <button className="calendar-nav-btn" onClick={() => navigateMonth(-1)}>
              <ChevronLeft size={16} />
            </button>
            <span className="calendar-month-label">
              {monthNames[calendarDate.getMonth()]} {calendarDate.getFullYear()}
            </span>
            <button className="calendar-nav-btn" onClick={() => navigateMonth(1)}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="calendar-grid">
            <div className="calendar-header-row">
              {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
                <span key={d} className="calendar-day-label">{d}</span>
              ))}
            </div>
            <div className="calendar-body">
              {Array.from({ length: firstDay }).map((_, i) => (
                <span key={`empty-${i}`} className="calendar-day empty" />
              ))}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1
                const dateStr = formatDateStr(
                  calendarDate.getFullYear(),
                  calendarDate.getMonth(),
                  day
                )
                const selected = dateStr === selectedDate
                const today = isToday(dateStr)
                return (
                  <button
                    key={day}
                    className={`calendar-day ${selected ? 'selected' : ''} ${today ? 'today' : ''}`}
                    onClick={() => setSelectedDate(dateStr)}
                  >
                    {day}
                  </button>
                )
              })}
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm calendar-today-btn"
            onClick={() => {
              const today = new Date()
              setSelectedDate(today.toISOString().split('T')[0])
              setCalendarDate(today)
            }}
          >
            <Calendar size={14} />
            Today
          </button>
        </div>

        {/* Action Buttons */}
        <div className="daily-actions">
          <button
            className="btn btn-primary daily-action-btn"
            onClick={handleGenerate}
            disabled={generating}
          >
            <RefreshCw size={16} className={generating ? 'animate-spin' : ''} />
            {generating ? 'Generating...' : 'Generate List'}
          </button>
          <button
            className="btn btn-secondary daily-action-btn"
            onClick={handleCopy}
            disabled={!taskList || taskList.assignments.length === 0}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? 'Copied!' : 'Copy for Slack'}
          </button>
          <button
            className="btn btn-secondary daily-action-btn yt-pull-btn"
            onClick={handlePullFromYouTrack}
            disabled={pullingFromYT}
          >
            <Link2 size={16} className={pullingFromYT ? 'animate-spin' : ''} />
            {pullingFromYT ? 'Pulling...' : 'Pull from YouTrack'}
          </button>
        </div>

        {/* Slack Preview */}
        {taskList && taskList.assignments.length > 0 && (
          <div className="slack-preview glass-card">
            <h4 className="slack-preview-title">Slack Preview</h4>
            <pre className="slack-preview-text">
              {generateSlackText(taskList)}
            </pre>
          </div>
        )}
      </div>

      {/* Right Side - Task List */}
      <div className="daily-task-main">
        {error && (
          <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
            <AlertCircle size={18} />
            <span>{error}</span>
            <button className="alert-close" onClick={() => setError(null)}>&times;</button>
          </div>
        )}

        <div className="daily-task-header">
          <h2 className="daily-task-date-title">
            {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </h2>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowAddPerson(true)}
            disabled={!taskList}
          >
            <UserPlus size={16} />
            Add Person
          </button>
        </div>

        {loading && (
          <div className="daily-loading">
            <SprintScanLoader size={48} />
            <p>Loading task list...</p>
          </div>
        )}

        {!loading && !taskList && (
          <div className="daily-empty-state glass-card">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <VelocityLogo variant="icon" size="lg" showStatusDot={false} style={{ opacity: 0.3 }} />
            </div>
            <h3>No Task List Yet</h3>
            <p>
              Click "Generate List" to create today's task list from pending tasks,
              or add people manually.
            </p>
            <button className="btn btn-primary" onClick={handleGenerate} disabled={generating}>
              <RefreshCw size={16} className={generating ? 'animate-spin' : ''} />
              Generate Task List
            </button>
          </div>
        )}

        {!loading && taskList && taskList.assignments.length === 0 && (
          <div className="daily-empty-state glass-card">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <VelocityLogo variant="icon" size="lg" showStatusDot={false} style={{ opacity: 0.3 }} />
            </div>
            <h3>No Tasks Found</h3>
            <p>
              No pending tasks found for this date. You can add people and tasks
              manually.
            </p>
          </div>
        )}

        {!loading && taskList && taskList.assignments.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="daily-assignments">
              {taskList.assignments.map((assignment, idx) => (
                <div key={`${assignment.user_name}-${idx}`} className="daily-assignment-card glass-card">
                  <div className="assignment-header">
                    <div className="assignment-info">
                      <span className="assignment-handle">{assignment.slack_handle}</span>
                      <span className="assignment-name">{assignment.user_name}</span>
                      <span className="assignment-task-count">
                        {assignment.tasks.length} tasks
                      </span>
                    </div>
                    <div className="assignment-actions">
                      <button
                        className="btn-icon-sm"
                        onClick={() => {
                          setAddingTaskFor(
                            addingTaskFor === assignment.user_name ? null : assignment.user_name
                          )
                          setNewTaskTitle('')
                          setNewTaskPriority('medium')
                          setNewTaskNotes('')
                        }}
                        title="Add task"
                      >
                        <Plus size={14} />
                      </button>
                      <button
                        className="btn-icon-sm btn-danger-ghost"
                        onClick={() => setConfirmDelete(assignment.user_name)}
                        title="Remove person"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <SortableContext
                    items={assignment.tasks.map((t) => t.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="assignment-tasks">
                      {assignment.tasks.map((item) => (
                        <SortableTaskItem
                          key={item.id}
                          item={item}
                          onDelete={handleDeleteItem}
                        />
                      ))}
                    </div>
                  </SortableContext>

                  {/* Add Task Form */}
                  {addingTaskFor === assignment.user_name && (
                    <div className="add-task-form">
                      <input
                        type="text"
                        className="add-task-input"
                        placeholder="Task title..."
                        value={newTaskTitle}
                        onChange={(e) => setNewTaskTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newTaskTitle.trim()) handleAddTaskItem(assignment.user_name)
                          if (e.key === 'Escape') setAddingTaskFor(null)
                        }}
                        autoFocus
                      />
                      <select
                        className="add-task-priority"
                        value={newTaskPriority}
                        onChange={(e) => setNewTaskPriority(e.target.value as 'high' | 'medium' | 'low')}
                      >
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                      <input
                        type="text"
                        className="add-task-input"
                        placeholder="Notes (optional)..."
                        value={newTaskNotes}
                        onChange={(e) => setNewTaskNotes(e.target.value)}
                      />
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleAddTaskItem(assignment.user_name)}
                        disabled={!newTaskTitle.trim()}
                      >
                        Add
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setAddingTaskFor(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <DragOverlay>
              {activeItem ? <DragOverlayItem item={activeItem} /> : null}
            </DragOverlay>
          </DndContext>
        )}

        {/* Add Person Modal */}
        {showAddPerson && (
          <div className="modal-overlay" onClick={() => setShowAddPerson(false)}>
            <div className="daily-add-person-modal glass-card" onClick={(e) => e.stopPropagation()}>
              <h3>Add Person</h3>
              <div className="form-group">
                <label>Name</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Rajvir Singh"
                  value={newPersonName}
                  onChange={(e) => setNewPersonName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Slack Handle</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. @Rajvir Singh"
                  value={newPersonHandle}
                  onChange={(e) => setNewPersonHandle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddPerson()
                  }}
                />
              </div>
              <div className="modal-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowAddPerson(false)}
                >
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={handleAddPerson}>
                  Add Person
                </button>
              </div>
            </div>
          </div>
        )}

        {/* YouTrack Pull Modal */}
        {ytPullData && (
          <div className="modal-overlay" onClick={() => { setYtPullData(null); setYtSelections({}) }}>
            <div className="yt-pull-modal glass-card" onClick={(e) => e.stopPropagation()}>
              <div className="yt-pull-modal-header">
                <h3>Pull from YouTrack</h3>
                <span className="yt-pull-count">{getSelectedCount()} selected</span>
              </div>

              <div className="yt-pull-modal-body">
                {ytPullData.map((group) => {
                  const allSelected = group.issues.every(i => ytSelections[group.user_name]?.[i.id])
                  return (
                    <div key={group.user_name} className="yt-pull-group">
                      <div
                        className="yt-pull-group-header"
                        onClick={() => toggleAssigneeSelection(group.user_name, group.issues)}
                      >
                        {allSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                        <span className="yt-pull-assignee">{group.slack_handle}</span>
                        <span className="yt-pull-group-count">{group.issues.length} issues</span>
                      </div>
                      <div className="yt-pull-issues">
                        {group.issues.map((issue) => (
                          <div
                            key={issue.id}
                            className={`yt-pull-issue ${ytSelections[group.user_name]?.[issue.id] ? 'selected' : ''}`}
                            onClick={() => toggleIssueSelection(group.user_name, issue.id)}
                          >
                            {ytSelections[group.user_name]?.[issue.id]
                              ? <CheckSquare size={14} />
                              : <Square size={14} />
                            }
                            {issue.priority_tag && (
                              <span
                                className={`yt-priority-tag yt-priority-${issue.priority_tag.toLowerCase()}`}
                              >
                                {issue.priority_tag}
                              </span>
                            )}
                            <span className="yt-issue-title">{issue.summary}</span>
                            <span className="yt-issue-id">{issue.idReadable || issue.id}</span>
                            <span className="yt-issue-status badge">{issue.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="modal-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => { setYtPullData(null); setYtSelections({}) }}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleAcceptYTPull}
                  disabled={addingFromYT || getSelectedCount() === 0}
                >
                  {addingFromYT ? 'Adding...' : `Add Selected (${getSelectedCount()})`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!confirmDelete}
        title="Remove Person"
        message={`Remove ${confirmDelete} and all their tasks?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => {
          if (confirmDelete) handleDeleteAssignment(confirmDelete)
          setConfirmDelete(null)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
