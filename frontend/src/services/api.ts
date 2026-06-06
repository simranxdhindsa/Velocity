const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api'

export class GatewayError extends Error {
  status: number
  constructor(status: number) {
    super(`Gateway error ${status}`)
    this.name = 'GatewayError'
    this.status = status
  }
}

interface ApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
}

class ApiService {
  private token: string | null = null

  constructor() {
    // Load token from localStorage on init
    this.token = localStorage.getItem('token')
  }

  setToken(token: string | null) {
    this.token = token
    if (token) {
      localStorage.setItem('token', token)
    } else {
      localStorage.removeItem('token')
    }
  }

  getToken() {
    return this.token
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Merge existing headers if any
    if (options.headers) {
      const existingHeaders = options.headers as Record<string, string>
      Object.assign(headers, existingHeaders)
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    const response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers,
    })

    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new GatewayError(response.status)
    }

    const text = await response.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      if (!response.ok) {
        throw new Error(text || `Request failed with status ${response.status}`)
      }
      throw new Error('Invalid JSON response from server')
    }

    if (!response.ok) {
      throw new Error(data.message || 'An error occurred')
    }

    return data
  }

  // Auth endpoints
  async googleAuth(credential: string, rememberMe: boolean = false) {
    return this.request<{ user: User; token: string }>('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential, remember_me: rememberMe }),
    })
  }

  async refreshToken() {
    return this.request<{ token: string }>('/auth/refresh', {
      method: 'POST',
    })
  }

  async getMe() {
    return this.request<User>('/auth/me')
  }

  async logout() {
    return this.request('/auth/logout', { method: 'POST' })
  }

  // Task endpoints
  async getTasks(filters?: { status?: string; date?: string }) {
    const params = new URLSearchParams()
    if (filters?.status) params.append('status', filters.status)
    if (filters?.date) params.append('date', filters.date)
    const query = params.toString() ? `?${params}` : ''
    return this.request<Task[]>(`/tasks${query}`)
  }

  async getYesterdayPending() {
    return this.request<Task[]>('/tasks/yesterday-pending')
  }

  async getTasksByDate(date: string) {
    return this.request<Task[]>(`/tasks/by-date/${date}`)
  }

  async createTask(task: Partial<Task>) {
    return this.request<Task>('/tasks', {
      method: 'POST',
      body: JSON.stringify(task),
    })
  }

  async updateTaskStatus(taskId: string, status: string) {
    return this.request(`/tasks/${taskId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
  }

  // Asana endpoints
  async connectAsana(accessToken: string, workspaceId?: string) {
    return this.request('/asana/connect', {
      method: 'POST',
      body: JSON.stringify({ access_token: accessToken, workspace_id: workspaceId }),
    })
  }

  async disconnectAsana() {
    return this.request('/asana/disconnect', { method: 'POST' })
  }

  async getAsanaStatus() {
    return this.request<{
      connected: boolean
      workspace_id?: string
      workspace_name?: string
      last_sync_at?: string
    }>('/asana/status')
  }

  async getAsanaProjects() {
    return this.request<AsanaProject[]>('/asana/projects')
  }

  async linkProjectToAsana(projectId: string, asanaProjectId: string) {
    return this.request(`/projects/${projectId}/asana/link`, {
      method: 'POST',
      body: JSON.stringify({ asana_project_id: asanaProjectId }),
    })
  }

  async syncProjectWithAsana(projectId: string) {
    return this.request<{
      tasks_synced: number
      tasks_created: number
      tasks_updated: number
      errors?: string[]
    }>(`/projects/${projectId}/asana/sync`, { method: 'POST' })
  }

  async syncTaskToAsana(taskId: string, status: string) {
    return this.request(`/tasks/${taskId}/asana/sync`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
  }

  // Import tasks from Asana using env PAT (quick sync)
  async importFromAsana() {
    return this.request<{
      tasks_synced: number
      tasks_created: number
      tasks_updated: number
      errors?: string[]
    }>('/asana/import', { method: 'POST' })
  }

  // Push single task to Asana
  async pushTaskToAsana(taskId: string) {
    return this.request(`/tasks/${taskId}/asana/push`, { method: 'POST' })
  }

  // Get synced sections (columns) from database
  async getProjectSections() {
    return this.request<AsanaSection[]>('/asana/sections')
  }

  // Get live sections for a specific Asana project (from Asana API)
  async getAsanaProjectSections(projectGid: string) {
    return this.request<AsanaSection[]>(`/asana/projects/${projectGid}/sections`)
  }

  // Update task section (move to different column)
  async updateTaskSection(taskId: string, sectionGid: string, sectionName: string) {
    return this.request(`/tasks/${taskId}/section`, {
      method: 'PATCH',
      body: JSON.stringify({ section_gid: sectionGid, section_name: sectionName }),
    })
  }

  // YouTrack endpoints
  async getYouTrackStatus() {
    return this.request<{
      connected: boolean
      configured: boolean
      base_url?: string
      project_id?: string
      board_id?: string
      error?: string
    }>('/youtrack/status')
  }

  // Per-user YouTrack integration (saved in DB)
  async getYouTrackIntegration() {
    return this.request<{
      configured: boolean
      connected: boolean
      base_url?: string
      token?: string
      project_id?: string
      board_id?: string
    }>('/settings/integrations/youtrack')
  }

  async saveYouTrackIntegration(data: { base_url: string; token: string; project_id: string; board_id?: string }) {
    return this.request('/settings/integrations/youtrack', {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async disconnectYouTrackIntegration() {
    return this.request('/settings/integrations/youtrack/disconnect', { method: 'POST' })
  }

  async getUserTheme() {
    return this.request<{
      dark_accent: string
      dark_bg: string
      dark_text: string
      light_accent: string
      light_bg: string
      light_text: string
    }>('/settings/theme')
  }

  async saveUserTheme(prefs: {
    dark_accent: string
    dark_bg: string
    dark_text: string
    light_accent: string
    light_bg: string
    light_text: string
  }) {
    return this.request('/settings/theme', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    })
  }

  async testYouTrackConnection(baseUrl: string, token: string, projectId: string) {
    return this.request<{ success: boolean; error?: string }>('/youtrack/test', {
      method: 'POST',
      body: JSON.stringify({ base_url: baseUrl, token, project_id: projectId }),
    })
  }

  async getYouTrackProjects() {
    return this.request<YouTrackProject[]>('/youtrack/projects')
  }

  async getYouTrackBoards() {
    return this.request<YouTrackBoard[]>('/youtrack/boards')
  }

  async getYouTrackBoardColumns(boardId: string) {
    return this.request<YouTrackColumn[]>(`/youtrack/boards/${boardId}/columns`)
  }

  async getYouTrackDefaultBoardColumns() {
    return this.request<YouTrackColumn[]>('/youtrack/board/columns')
  }

  async getYouTrackSprints() {
    return this.request<YouTrackSprint[]>('/youtrack/sprints')
  }

  async getYouTrackStates() {
    return this.request<YouTrackState[]>('/youtrack/states')
  }

  async getYouTrackPriorities() {
    return this.request<{ name: string; background?: string; foreground?: string }[]>('/youtrack/priorities')
  }

  async getYouTrackTypeFieldValues(fieldName: string) {
    return this.request<{ name: string; background?: string; foreground?: string }[]>(`/youtrack/type-field-values?field_name=${encodeURIComponent(fieldName)}`)
  }

  async getYouTrackUsers() {
    return this.request<YouTrackUser[]>('/youtrack/users')
  }

  async getYouTrackIssues(sprintId?: string) {
    const params = sprintId ? `?sprint_id=${encodeURIComponent(sprintId)}` : ''
    return this.request<YouTrackIssue[]>(`/youtrack/issues${params}`)
  }

  async getYouTrackIssuesByState(state: string, skip = 0, top = 20, sprintId?: string) {
    const params = new URLSearchParams({ state, skip: String(skip), top: String(top) })
    if (sprintId) params.set('sprint_id', sprintId)
    return this.request<{ issues: YouTrackIssue[]; hasMore: boolean }>(`/youtrack/issues?${params}`)
  }

  async getYouTrackIssue(issueId: string) {
    return this.request<YouTrackIssue>(`/youtrack/issues/${issueId}`)
  }

  async getYouTrackIssueComments(issueId: string) {
    return this.request<YouTrackComment[]>(`/youtrack/issues/${issueId}/comments`)
  }

  async addYouTrackIssueComment(issueId: string, text: string) {
    return this.request<{ success: boolean }>(`/youtrack/issues/${issueId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  }

  buildProxyUrl(attachmentUrl: string): string {
    return `${API_URL}/youtrack/proxy?url=${btoa(attachmentUrl)}`
  }

  async fetchAttachmentBlob(attachmentUrl: string): Promise<Blob> {
    const resp = await fetch(this.buildProxyUrl(attachmentUrl), {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.blob()
  }

  async fetchAttachmentText(attachmentUrl: string): Promise<string> {
    const resp = await fetch(this.buildProxyUrl(attachmentUrl), {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.text()
  }

  async getYouTrackFormMeta() {
    return this.request<{
      states: YouTrackState[]
      priorities: { name: string; background: string; foreground: string }[]
      types: { name: string; background: string; foreground: string }[]
      subsystems: { name: string; background: string; foreground: string }[]
      users: YouTrackUser[]
      sprints: { id: string; name: string; start: number; finish: number; isCompleted: boolean }[]
      developer_configs: DeveloperSubsystemConfig[]
      errors: string[]
    }>('/youtrack/form-meta')
  }

  async getDeveloperConfigs() {
    return this.request<DeveloperSubsystemConfig[]>('/developer-config')
  }

  async saveDeveloperConfigs(configs: DeveloperSubsystemConfig[]) {
    return this.request('/developer-config', {
      method: 'POST',
      body: JSON.stringify(configs),
    })
  }

  async createYouTrackIssue(params: {
    summary: string
    description?: string
    state?: string
    priority?: string
    type_name?: string
    assignee_login?: string
    subsystem?: string
    sprint_id?: string
    due_date?: number
    estimation_minutes?: number
  }) {
    return this.request<YouTrackIssue>('/youtrack/issues', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  async uploadYouTrackAttachment(issueId: string, file: File) {
    const fd = new FormData()
    fd.append('file', file, file.name)
    const res = await fetch(`${API_URL}/youtrack/issues/${issueId}/attachments`, {
      method: 'POST',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      body: fd,
    })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    return res.json() as Promise<{ success: boolean }>
  }

  async aiParseTicket(rawText: string, context: {
    users: { login: string; fullName: string }[]
    types: string[]
    subsystems: string[]
    priorities: string[]
    sprints: { id: string; name: string }[]
  }) {
    return this.request<{
      summary: string
      description: string
      priority: string
      type_name: string
      subsystem: string
      assignee_login: string
      sprint_id: string
    }>('/youtrack/ai/parse-ticket', {
      method: 'POST',
      body: JSON.stringify({ raw_text: rawText, ...context }),
    })
  }

  async updateYouTrackIssue(issueId: string, payload: {
    summary?: string; description?: string; state?: string; priority?: string
    type_name?: string; assignee_login?: string; subsystem?: string; sprint_id?: string
    due_date?: number; estimation_minutes?: number
  }) {
    return this.request<YouTrackIssue>(`/youtrack/issues/${issueId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  }

  async updateYouTrackIssueState(issueId: string, state: string) {
    return this.request(`/youtrack/issues/${issueId}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    })
  }

  async deleteYouTrackIssue(issueId: string) {
    return this.request(`/youtrack/issues/${issueId}`, { method: 'DELETE' })
  }

  async importFromYouTrack() {
    return this.request<{
      tasks_synced: number
      tasks_created: number
      tasks_updated: number
      errors?: string[]
    }>('/youtrack/import', { method: 'POST' })
  }

  async syncTaskToYouTrack(taskId: string) {
    return this.request(`/tasks/${taskId}/youtrack/sync`, { method: 'POST' })
  }

  async getYouTrackSections() {
    return this.request<YouTrackState[]>('/youtrack/sections')
  }

  async matchAnalysisWithYouTrack(personBreakdown: any[], analysis: any[]) {
    return this.request<{
      matches: {
        task_title: string
        person: string
        status: string
        youtrack_issue: { id: string; summary: string; current_state: string }
        proposed_state: string
        confidence: number
      }[]
      unmatched_tasks: { task_title: string; person: string; status: string }[]
      unmatched_issues: { id: string; summary: string; current_state: string }[]
    }>('/youtrack/match-analysis', {
      method: 'POST',
      body: JSON.stringify({ person_breakdown: personBreakdown, analysis }),
    })
  }

  async bulkUpdateYouTrackStates(updates: { issue_id: string; new_state: string }[]) {
    return this.request<{
      succeeded: number
      failed: number
      errors: string[]
      message: string
    }>('/youtrack/bulk-update-states', {
      method: 'POST',
      body: JSON.stringify({ updates }),
    })
  }

  async getYouTrackIssuesGroupedByAssignee() {
    return this.request<{
      assignments: {
        user_name: string
        slack_handle: string
        issues: {
          id: string
          summary: string
          priority_tag: string
          clean_title: string
          status: string
          selected: boolean
        }[]
      }[]
    }>('/youtrack/issues/grouped-by-assignee')
  }

  async getSyncRecommendations(personBreakdown: any[], analysis: any[]) {
    return this.request<{
      recommendations: {
        issue_id: string
        summary: string
        person: string
        current_state: string
        proposed_state: string
        reason: string
        backward: boolean
        confidence: number
      }[]
    }>('/youtrack/sync-recommendations', {
      method: 'POST',
      body: JSON.stringify({ person_breakdown: personBreakdown, analysis }),
    })
  }

  async bulkCreateNextDayTasks(targetDate: string, tasks: { assignee: string; task_title: string; priority?: string; youtrack_id?: string }[]) {
    return this.request<{
      date: string
      assignments: any[]
    }>('/daily-tasks/next-day/bulk-create', {
      method: 'POST',
      body: JSON.stringify({ target_date: targetDate, tasks }),
    })
  }

  // PM Assistant
  async pmAssistantQuery(query: string, history: { role: string; content: string }[] = [], sprintId?: string, sprintName?: string, sprintFinishMs?: number) {
    return this.request<{ response: string; action?: string; payload?: { sprint_id?: string; sprint_name?: string } }>('/youtrack/pm-query', {
      method: 'POST',
      body: JSON.stringify({ query, history, sprint_id: sprintId, sprint_name: sprintName, sprint_finish_ms: sprintFinishMs }),
    })
  }

  // Daily Ops endpoints
  async getDailyBrief(sprintId?: string) {
    const qs = sprintId ? `?sprint_id=${encodeURIComponent(sprintId)}` : ''
    return this.request<DailyBrief>(`/youtrack/daily-brief${qs}`)
  }

  async getEODSummary() {
    return this.request<EODSummary>('/youtrack/eod-summary')
  }

  async getDeveloperLoad(sprintId?: string) {
    const qs = sprintId ? `?sprint_id=${encodeURIComponent(sprintId)}` : ''
    return this.request<DeveloperLoad[]>(`/youtrack/developer-load${qs}`)
  }

  async postMorningReport(reportText: string, channelIds: string[]) {
    return this.request<{ posted_channels: string[]; errors: string[] }>('/slack/post-morning-report', {
      method: 'POST',
      body: JSON.stringify({ report_text: reportText, channel_ids: channelIds }),
    })
  }

  async generateEODPlan(summary: EODSummary) {
    return this.request<{ plan_text: string }>('/ai/eod-plan', {
      method: 'POST',
      body: JSON.stringify(summary),
    })
  }

  async getBlockerReasons(issueIds: string[]) {
    return this.request<Record<string, string>>(`/youtrack/blocker-reasons?ids=${issueIds.join(',')}`)
  }

  async saveCarryoverPlan(items: CarryoverItem[]) {
    return this.request<{ success: boolean }>('/youtrack/save-plan', {
      method: 'POST',
      body: JSON.stringify({ items }),
    })
  }

  async getCarryover() {
    return this.request<CarryoverData>('/youtrack/carryover')
  }

  async createIssueReminder(issueId: string, issueSummary: string, targetDate: string) {
    return this.request<{ id: string }>('/reminders', {
      method: 'POST',
      body: JSON.stringify({
        type: 'blocked_issue',
        title: `Follow up: ${issueSummary}`,
        related_issue_id: issueId,
        target_date: targetDate,
        recurring: 'none',
      }),
    })
  }

  // Slack endpoints
  async connectSlack(botToken: string, channelId?: string) {
    return this.request('/slack/connect', {
      method: 'POST',
      body: JSON.stringify({ bot_token: botToken, channel_id: channelId || '' }),
    })
  }

  async disconnectSlack() {
    return this.request('/slack/disconnect', {
      method: 'POST',
    })
  }

  async getSlackStatus() {
    return this.request<{
      connected: boolean
      team_id?: string
      team_name?: string
      channel_id?: string
      channel_name?: string
    }>('/slack/status')
  }

  async getSlackChannels() {
    return this.request<{
      id: string
      name: string
      is_private: boolean
      is_member: boolean
    }[]>('/slack/channels')
  }

  async setSlackChannel(channelId: string, channelName: string) {
    return this.request('/slack/channel', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, channel_name: channelName }),
    })
  }

  async getSlackMessages(dateRange?: { from: string; to: string }) {
    const params = new URLSearchParams()
    if (dateRange?.from) params.append('from', dateRange.from)
    if (dateRange?.to) params.append('to', dateRange.to)
    const query = params.toString() ? `?${params}` : ''
    return this.request<{ messages: SlackMessage[]; count: number }>(`/slack/messages${query}`)
  }

  async getYesterdaySlackMessages() {
    return this.request<{ messages: SlackMessage[]; count: number }>('/slack/messages/yesterday')
  }

  async setSlackMonitorChannel(channelId: string, channelName: string) {
    return this.request('/slack/monitor-channel', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, channel_name: channelName }),
    })
  }

  // Slack Intelligence endpoints
  async scanSlack() {
    return this.request<{ success: boolean; new_mentions: number; new_threads: number }>('/slack/scan', {
      method: 'POST',
    })
  }

  async getSlackMentions() {
    return this.request<{ success: boolean; mentions: SlackMention[]; count: number; unreplied_count: number }>('/slack/mentions')
  }

  async dismissSlackMention(messageTS: string) {
    return this.request(`/slack/mentions/${encodeURIComponent(messageTS)}/dismiss`, {
      method: 'POST',
    })
  }

  async snoozeSlackMention(messageTS: string, until: '2h' | 'tomorrow') {
    return this.request(`/slack/mentions/${encodeURIComponent(messageTS)}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ until }),
    })
  }

  async snoozeSlackThread(threadTS: string, until: '2h' | 'tomorrow') {
    return this.request(`/slack/threads/${encodeURIComponent(threadTS)}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ until }),
    })
  }

  async getSlackThreads() {
    return this.request<{ success: boolean; threads: SlackThread[]; count: number }>('/slack/threads')
  }

  async postSlackDigest(issues: DigestIssue[]) {
    return this.request<{ success: boolean; thread_ts: string; message: string }>('/slack/digest', {
      method: 'POST',
      body: JSON.stringify({ issues }),
    })
  }

  async createSlackFollowupReminder(params: SlackReminderParams) {
    return this.request<{ success: boolean; reminder: ReminderItem }>('/slack/reminders', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  // ── Slack Intelligence v2 ──────────────────────────────────────────────────
  async slackReplyToThread(channelId: string, threadTs: string, text: string, mentionTs?: string) {
    return this.request<{ ok: boolean }>('/slack/reply', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, thread_ts: threadTs, text, mention_ts: mentionTs }),
    })
  }

  async getSlackThreadReplies(channelId: string, threadTs: string) {
    return this.request<{ replies: Array<{ sender_name: string; text: string; timestamp: string }> }>(
      `/slack/thread-replies?channel_id=${encodeURIComponent(channelId)}&thread_ts=${encodeURIComponent(threadTs)}`
    )
  }

  async pinSlackMention(messageTs: string, pinned: boolean) {
    return this.request<{ ok: boolean }>(`/slack/mentions/${encodeURIComponent(messageTs)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    })
  }

  async getSlackTemplates() {
    return this.request<{ templates: Array<{ id: string; body: string; sort_order: number }> }>('/slack/templates')
  }

  async createSlackTemplate(body: string) {
    return this.request<{ ok: boolean; id: string }>('/slack/templates', {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
  }

  async deleteSlackTemplate(id: string) {
    return this.request<{ ok: boolean }>(`/slack/templates/${id}`, { method: 'DELETE' })
  }

  async getSlackSavedItems() {
    return this.request<{ items: Array<{ type: string; channel_id: string; text: string; user: string; ts: string }> }>('/slack/saved-items')
  }

  async getSlackPinnedMentions() {
    return this.request<{ mentions: SlackMention[] }>('/slack/mentions?pinned=true')
  }

  async analyzeSlackMessages(projectId: string) {
    return this.request<AIAnalysisResponse>(`/ai/analyze?project_id=${projectId}`, {
      method: 'POST',
    })
  }

  async analyzeManualInput(morningAssignments: string, eveningUpdates: string) {
    return this.request<{
      tasks_detected: string[]
      analysis: {
        task_title: string
        detected_status: string
        confidence: number
        evidence: string[]
      }[]
      person_breakdown: {
        name: string
        assigned: string[]
        completed: string[]
        pending: string[]
        blocked: string[]
        stats: {
          total: number
          completed: number
          pending: number
          blocked: number
        }
      }[]
      summary: {
        total_tasks: number
        completed: number
        in_progress: number
        blocked: number
        not_mentioned: number
      }
    }>('/ai/analyze-manual', {
      method: 'POST',
      body: JSON.stringify({ morning_assignments: morningAssignments, evening_updates: eveningUpdates }),
    })
  }

  async getDiscrepancies() {
    return this.request<{ discrepancies: Discrepancy[] }>('/ai/discrepancies')
  }

  // Daily Tasks Management endpoints
  async saveAnalysis(date: string, morningMessage: string, eveningMessage: string, analysisResult: any) {
    return this.request<{
      id: string
      date: string
      morning_message: string
      evening_message: string
      analysis_result: any
    }>('/daily-tasks/analysis', {
      method: 'POST',
      body: JSON.stringify({
        date,
        morning_message: morningMessage,
        evening_message: eveningMessage,
        analysis_result: analysisResult
      }),
    })
  }

  async getAnalysisByDate(date: string) {
    return this.request<{
      id: string
      date: string
      morning_message: string
      evening_message: string
      analysis_result: any
    }>(`/daily-tasks/analysis/${date}`)
  }

  async getTodaysTasks(date: string) {
    return this.request<{
      assignee: string
      completed: string[]
      pending: string[]
      blocked: string[]
      skipped: string[]
    }[]>(`/daily-tasks/today/${date}`)
  }

  async getNextDayTasks(date: string) {
    return this.request<{
      date: string
      assignments: {
        user_name: string
        slack_handle: string
        tasks: {
          id: string
          target_date: string
          assignee: string
          task_title: string
          priority: string
          position: number
          is_carried_forward: boolean
          source_date?: string
          notes?: string
        }[]
      }[]
    }>(`/daily-tasks/next-day/${date}`)
  }

  async generateNextDayTasks(sourceDate: string, targetDate: string) {
    return this.request<{
      date: string
      assignments: any[]
    }>('/daily-tasks/next-day/generate', {
      method: 'POST',
      body: JSON.stringify({ source_date: sourceDate, target_date: targetDate }),
    })
  }

  async createNextDayTask(targetDate: string, assignee: string, taskTitle: string, priority?: string, notes?: string) {
    return this.request<any>('/daily-tasks/next-day/task', {
      method: 'POST',
      body: JSON.stringify({
        target_date: targetDate,
        assignee,
        task_title: taskTitle,
        priority,
        notes
      }),
    })
  }

  async updateNextDayTask(taskId: string, updates: { task_title?: string; priority?: string; notes?: string }) {
    return this.request<any>(`/daily-tasks/next-day/task/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }

  async deleteNextDayTask(taskId: string) {
    return this.request<any>(`/daily-tasks/next-day/task/${taskId}`, {
      method: 'DELETE',
    })
  }

  async reorderNextDayTasks(targetDate: string, assignee: string, taskIds: string[]) {
    return this.request<any>('/daily-tasks/next-day/reorder', {
      method: 'PATCH',
      body: JSON.stringify({
        target_date: targetDate,
        assignee,
        task_ids: taskIds
      }),
    })
  }

  async getFormattedSlackMessage(date: string) {
    return this.request<{
      formatted_message: string
      date: string
    }>(`/daily-tasks/next-day/${date}/slack-format`)
  }

  // Calendar endpoints
  async getCalendarData(year: number, month: number) {
    return this.request<CalendarData>(`/calendar/${year}/${month}`)
  }

  // Report endpoints
  async getTeamProductivity() {
    return this.request<TeamProductivityReport>('/reports/team-productivity')
  }

  async getIndividualReport(userId: string) {
    return this.request<IndividualReport>(`/reports/individual/${userId}`)
  }

  async getProjectHealth() {
    return this.request<ProjectHealthReport>('/reports/project-health')
  }

  // User management (admin only)
  async getUsers() {
    return this.request<User[]>('/users')
  }

  async inviteUser(email: string, role: string) {
    return this.request('/users/invite', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    })
  }

  async updateUserRole(userId: string, role: string) {
    return this.request(`/users/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    })
  }

  async deleteUser(userId: string) {
    return this.request(`/users/${userId}`, { method: 'DELETE' })
  }

  // Access Control / Whitelist endpoints
  async getAccessSettings() {
    return this.request<AccessSettings>('/settings/access')
  }

  async getAllowedEmails() {
    return this.request<AllowedEmail[]>('/settings/access/emails')
  }

  async addAllowedEmail(email: string, role: string) {
    return this.request<AllowedEmail>('/settings/access/emails', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    })
  }

  async removeAllowedEmail(email: string) {
    return this.request(`/settings/access/emails/${encodeURIComponent(email)}`, {
      method: 'DELETE',
    })
  }

  async getAllowedDomains() {
    return this.request<AllowedDomain[]>('/settings/access/domains')
  }

  async addAllowedDomain(domain: string, role: string) {
    return this.request<AllowedDomain>('/settings/access/domains', {
      method: 'POST',
      body: JSON.stringify({ domain, role }),
    })
  }

  async removeAllowedDomain(domain: string) {
    return this.request(`/settings/access/domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    })
  }

  async getDeniedEmails() {
    return this.request<DeniedEmail[]>('/settings/access/denied')
  }

  async addDeniedEmail(email: string, reason?: string) {
    return this.request<DeniedEmail>('/settings/access/denied', {
      method: 'POST',
      body: JSON.stringify({ email, reason: reason ?? '' }),
    })
  }

  async removeDeniedEmail(email: string) {
    return this.request(`/settings/access/denied/${encodeURIComponent(email)}`, {
      method: 'DELETE',
    })
  }

  // Daily Task List endpoints
  async getDailyTaskList(date: string, projectId?: string) {
    const params = new URLSearchParams()
    if (projectId) params.append('project_id', projectId)
    const query = params.toString() ? `?${params}` : ''
    return this.request<DailyTaskList>(`/daily-tasks/${date}${query}`)
  }

  async generateDailyTaskList(date: string, projectId?: string) {
    return this.request<DailyTaskList>(`/daily-tasks/${date}/generate`, {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId || 'default' }),
    })
  }

  async getDailyTaskListFormatted(date: string, projectId?: string) {
    const params = new URLSearchParams()
    if (projectId) params.append('project_id', projectId)
    const query = params.toString() ? `?${params}` : ''
    return this.request<{ formatted_text: string; date: string }>(
      `/daily-tasks/${date}/formatted${query}`
    )
  }

  async reorderDailyTasks(date: string, assignmentId: string, taskItemIds: string[]) {
    return this.request(`/daily-tasks/${date}/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ assignment_id: assignmentId, task_item_ids: taskItemIds }),
    })
  }

  async addDailyTaskItem(assignmentId: string, title: string, priority: string, taskId?: string) {
    return this.request<DailyTaskItem>('/daily-tasks/items', {
      method: 'POST',
      body: JSON.stringify({ assignment_id: assignmentId, title, priority, task_id: taskId }),
    })
  }

  async deleteDailyTaskItem(itemId: string) {
    return this.request(`/daily-tasks/items/${itemId}`, { method: 'DELETE' })
  }

  async addDailyAssignment(date: string, userName: string, slackHandle: string, projectId?: string) {
    const params = new URLSearchParams()
    if (projectId) params.append('project_id', projectId)
    const query = params.toString() ? `?${params}` : ''
    return this.request<UserTaskAssignment>(`/daily-tasks/${date}/assignments${query}`, {
      method: 'POST',
      body: JSON.stringify({ user_name: userName, slack_handle: slackHandle }),
    })
  }

  async deleteDailyAssignment(assignmentId: string) {
    return this.request(`/daily-tasks/assignments/${assignmentId}`, { method: 'DELETE' })
  }

  // Integration Settings endpoints

  // Get Asana configuration status (all authenticated users)
  async getAsanaConfigStatus() {
    return this.request<{ configured: boolean; has_project: boolean }>('/settings/integrations/asana/status')
  }

  // Get full Asana settings (admin only)
  async getAsanaSettings() {
    return this.request<AsanaSettings>('/settings/integrations/asana')
  }

  async updateAsanaSettings(settings: UpdateAsanaSettingsRequest) {
    return this.request('/settings/integrations/asana', {
      method: 'PUT',
      body: JSON.stringify(settings),
    })
  }

  async testAsanaConnection() {
    return this.request<{
      connected: boolean
      user: string
      projects: AsanaProject[]
    }>('/settings/integrations/asana/test', { method: 'POST' })
  }

  async getAsanaProjectsForSettings() {
    return this.request<AsanaProject[]>('/settings/integrations/asana/projects')
  }

  // Bot Config endpoints
  async listBots() {
    return this.request<BotConfig[]>('/bots')
  }

  async getBot(botId: string) {
    return this.request<BotConfig>(`/bots/${botId}`)
  }

  async createBot(bot: CreateBotConfigRequest) {
    return this.request<BotConfig>('/bots', {
      method: 'POST',
      body: JSON.stringify(bot),
    })
  }

  async updateBot(botId: string, updates: UpdateBotConfigRequest) {
    return this.request<BotConfig>(`/bots/${botId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    })
  }

  async deleteBot(botId: string) {
    return this.request(`/bots/${botId}`, { method: 'DELETE' })
  }

  async getBotTemplates() {
    return this.request<BotConfig[]>('/bots/templates')
  }

  async getStageReportColumns() {
    return this.request<string[]>('/bots/stage-report/columns')
  }

  async generateStageReport(columns: string[]) {
    return this.request<{ report: string; issue_count: number }>('/bots/stage-report/generate', {
      method: 'POST',
      body: JSON.stringify({ columns }),
    })
  }

  async getDeploymentTickets(columns: string[], sprintId?: string) {
    const q = columns.map(c => encodeURIComponent(c)).join(',')
    const sp = sprintId ? `&sprint_id=${encodeURIComponent(sprintId)}` : ''
    return this.request<{ tickets: YTDeployTicket[]; base_url: string }>(`/bots/deployment/tickets?columns=${q}${sp}`)
  }

  async generateDeploymentTicket(ticket: YTDeployTicket): Promise<DeploymentTicketGenResult> {
    const res = await this.request<{ fix_statement?: string; error?: string; retry_after?: number }>('/bots/deployment/generate-ticket', {
      method: 'POST',
      body: JSON.stringify(ticket),
    })
    const d = (res as any)
    if (d.error === 'rate_limited') {
      return { fixStatement: null, rateLimited: true, retryAfter: d.retry_after ?? 30 }
    }
    if (!d.success || d.error) {
      return { fixStatement: null, error: d.message || d.error || 'Unknown error' }
    }
    return { fixStatement: d.data?.fix_statement ?? null }
  }

  // Notification endpoints
  async getNotifications(limit?: number) {
    const query = limit ? `?limit=${limit}` : ''
    return this.request<NotificationItem[]>(`/notifications${query}`)
  }

  async getUnreadNotificationCount() {
    return this.request<{ count: number }>('/notifications/unread-count')
  }

  async markNotificationAsRead(notifId: string) {
    return this.request(`/notifications/${notifId}/read`, { method: 'PATCH' })
  }

  async markAllNotificationsAsRead() {
    return this.request('/notifications/read-all', { method: 'PATCH' })
  }

  async deleteNotification(notifId: string) {
    return this.request(`/notifications/${notifId}`, { method: 'DELETE' })
  }

  async clearAllNotifications() {
    return this.request('/notifications/clear-all', { method: 'DELETE' })
  }

  // Activity endpoints
  async getActivity(limit?: number, offset?: number) {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    if (offset) params.set('offset', String(offset))
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.request<ActivityItem[]>(`/activity${query}`)
  }

  // Reminder endpoints
  async getReminders() {
    return this.request<ReminderItem[]>('/reminders')
  }

  async createReminder(reminder: CreateReminderRequest) {
    return this.request<ReminderItem>('/reminders', {
      method: 'POST',
      body: JSON.stringify(reminder),
    })
  }

  async dismissReminder(reminderId: string) {
    return this.request(`/reminders/${reminderId}/dismiss`, { method: 'PATCH' })
  }

  async deleteReminder(reminderId: string) {
    return this.request(`/reminders/${reminderId}`, { method: 'DELETE' })
  }

  // PM Report endpoints
  async generatePMReport(date: string, scope: 'full' | 'summary' = 'full', overrides?: { priorities?: string[]; open_states?: string[]; sections?: string[] }, sprintId?: string, sprintName?: string) {
    const params = new URLSearchParams({ scope })
    if (overrides?.priorities?.length) params.set('priorities', overrides.priorities.join(','))
    if (overrides?.open_states?.length) params.set('open_states', overrides.open_states.join(','))
    if (overrides?.sections?.length) params.set('sections', overrides.sections.join(','))
    if (sprintId) params.set('sprint_id', sprintId)
    if (sprintName) params.set('sprint_name', encodeURIComponent(sprintName))
    return this.request<PMReport>(`/reports/pm-report/${date}?${params}`)
  }

  async getSavedPMReport(date: string) {
    return this.request<PMReport>(`/reports/pm-report/${date}/saved`)
  }

  async listPMReports() {
    return this.request<PMReport[]>('/reports/pm-reports')
  }

  async deletePMReport(id: string) {
    return this.request<{ message: string }>(`/reports/pm-report/${id}/delete`, { method: 'DELETE' })
  }

  async generateWeeklyPMReport(weekStart: string, scope: 'full' | 'summary' = 'full', overrides?: { priorities?: string[]; open_states?: string[]; sections?: string[] }, sprintId?: string, sprintName?: string) {
    const params = new URLSearchParams({ scope })
    if (overrides?.priorities?.length) params.set('priorities', overrides.priorities.join(','))
    if (overrides?.open_states?.length) params.set('open_states', overrides.open_states.join(','))
    if (overrides?.sections?.length) params.set('sections', overrides.sections.join(','))
    if (sprintId) params.set('sprint_id', sprintId)
    if (sprintName) params.set('sprint_name', encodeURIComponent(sprintName))
    return this.request<PMReport>(`/reports/pm-report/weekly/${weekStart}?${params}`)
  }

  async listWeeklyPMReports() {
    return this.request<PMReport[]>('/reports/pm-reports/weekly')
  }

  async getAssigneeStats(sprintId?: string) {
    const qs = sprintId ? `?sprint_id=${encodeURIComponent(sprintId)}` : ''
    return this.request<AssigneeStat[]>(`/reports/assignee-stats${qs}`)
  }

  async getSprintBoardStatus(params: { sprint_id?: string; sprint_name?: string; sprint_finish_ms?: number }) {
    const qs = new URLSearchParams()
    if (params.sprint_id) qs.set('sprint_id', params.sprint_id)
    if (params.sprint_name) qs.set('sprint_name', encodeURIComponent(params.sprint_name))
    if (params.sprint_finish_ms) qs.set('sprint_finish_ms', String(params.sprint_finish_ms))
    return this.request<SprintBoardStatusResponse>(`/reports/sprint-board-status?${qs.toString()}`)
  }

  async getSprintQaSummary(params: { sprint_id?: string; sprint_name?: string; sprint_finish_ms?: number }) {
    const qs = new URLSearchParams()
    if (params.sprint_id) qs.set('sprint_id', params.sprint_id)
    if (params.sprint_name) qs.set('sprint_name', encodeURIComponent(params.sprint_name))
    if (params.sprint_finish_ms) qs.set('sprint_finish_ms', String(params.sprint_finish_ms))
    return this.request<QAUserSummary[]>(`/reports/sprint-qa-summary?${qs.toString()}`)
  }

  async getIssueTransitions(issueId: string) {
    return this.request<IssueStateLogEntry[]>(`/reports/issue-transitions?issue_id=${encodeURIComponent(issueId)}`)
  }

  async getTimeTracking(params?: { week?: string; assignee?: string; priority?: string; sprint_id?: string }) {
    const qs = new URLSearchParams()
    if (params?.week) qs.set('week', params.week)
    if (params?.assignee) qs.set('assignee', params.assignee)
    if (params?.priority) qs.set('priority', params.priority)
    if (params?.sprint_id) qs.set('sprint_id', params.sprint_id)
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return this.request<TimeTrackingRow[]>(`/reports/time-tracking${query}`)
  }

  async pinIssue(issueID: string) {
    return this.request<void>('/reports/pins', { method: 'POST', body: JSON.stringify({ issue_id: issueID }) })
  }

  async unpinIssue(issueID: string) {
    return this.request<void>(`/reports/pins/${encodeURIComponent(issueID)}`, { method: 'DELETE' })
  }

  async getPinnedIssues() {
    return this.request<string[]>('/reports/pins')
  }

  async getIssueTimelines(sinceMs?: number, untilMs?: number) {
    const params = new URLSearchParams()
    if (sinceMs) params.set('since', String(sinceMs))
    if (untilMs) params.set('until', String(untilMs))
    const qs = params.toString()
    return this.request<IssueTimeline[]>(`/reports/issue-timelines${qs ? `?${qs}` : ''}`)
  }

  async dismissAlert(issueID: string) {
    return this.request<void>('/reports/alerts/dismiss', {
      method: 'POST',
      body: JSON.stringify({ issue_id: issueID }),
    })
  }

  async undismissAlert(issueID: string) {
    return this.request<void>(`/reports/alerts/dismiss/${encodeURIComponent(issueID)}`, { method: 'DELETE' })
  }

  async backfillStateLog() {
    return this.request<{ inserted: number; skipped: number; total: number }>('/reports/backfill', {
      method: 'POST',
    })
  }

  async resetStateLog() {
    return this.request<{ deleted: number }>('/reports/reset-state-log', {
      method: 'DELETE',
    })
  }

  async reconcileStateLog() {
    return this.request<{ reconciled: number; skipped: number; checked: number }>('/reports/reconcile', {
      method: 'POST',
    })
  }

  async importHistory() {
    return this.request<{ inserted: number; skipped: number; errors: number; issues: number }>('/reports/import-history', {
      method: 'POST',
    })
  }

  // ── Workflow Config ────────────────────────────────────────────────────────
  async getWorkflowConfig(source?: string) {
    const qs = source ? `?source=${source}` : ''
    return this.request<WorkflowConfig>(`/workflow-config${qs}`)
  }

  async updateWorkflowConfig(config: Partial<WorkflowConfig>, source?: string) {
    const qs = source ? `?source=${source}` : ''
    return this.request<WorkflowConfig>(`/workflow-config${qs}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    })
  }

  async updatePriorityTags(tags: PriorityTag[], source?: string) {
    const qs = source ? `?source=${source}` : ''
    return this.request<WorkflowConfig>(`/workflow-config/priorities${qs}`, {
      method: 'PUT',
      body: JSON.stringify({ priority_tags: tags }),
    })
  }

  async updateColumnHierarchy(columns: ColumnState[], source?: string) {
    const qs = source ? `?source=${source}` : ''
    return this.request<WorkflowConfig>(`/workflow-config/columns${qs}`, {
      method: 'PUT',
      body: JSON.stringify({ column_hierarchy: columns }),
    })
  }

  async updateHotfixRules(rules: HotfixRules, source?: string) {
    const qs = source ? `?source=${source}` : ''
    return this.request<WorkflowConfig>(`/workflow-config/hotfix-rules${qs}`, {
      method: 'PUT',
      body: JSON.stringify({ hotfix_rules: rules }),
    })
  }

  async updateReportConfig(config: ReportConfig, source?: string) {
    const qs = source ? `?source=${source}` : ''
    return this.request<WorkflowConfig>(`/workflow-config/report${qs}`, {
      method: 'PUT',
      body: JSON.stringify({ report_config: config }),
    })
  }

  async resetWorkflowConfig(source?: string) {
    const qs = source ? `?source=${source}` : ''
    return this.request<{ message: string }>(`/workflow-config/reset${qs}`, {
      method: 'POST',
    })
  }

  async getWorkflowDefaults(source?: string) {
    const qs = source ? `?source=${source}` : ''
    return this.request<WorkflowConfig>(`/workflow-config/defaults${qs}`)
  }

  // ── User data source preference ─────────────────────────────────────────
  async getDataSource() {
    return this.request<{ source: string }>('/user/data-source')
  }

  async setDataSource(source: 'youtrack' | 'asana') {
    return this.request<{ source: string }>('/user/data-source', {
      method: 'PUT',
      body: JSON.stringify({ source }),
    })
  }

  // ── Asana PM endpoints (mirror /youtrack/* with same response shapes) ───
  async getAsanaPMStatus() {
    return this.request<{ connected: boolean; configured: boolean; error?: string }>('/asana/pm/status')
  }

  async getAsanaPMProjects() {
    return this.request<YouTrackProject[]>('/asana/pm/projects')
  }

  async saveAsanaPMProject(projectGID: string) {
    return this.request<{ project_gid: string }>('/asana/pm/project', {
      method: 'PATCH',
      body: JSON.stringify({ project_gid: projectGID }),
    })
  }

  async getAsanaPMBoards() {
    return this.request<YouTrackBoard[]>('/asana/pm/boards')
  }

  async getAsanaPMBoardColumns(boardId: string) {
    return this.request<YouTrackColumn[]>(`/asana/pm/boards/${boardId}/columns`)
  }

  async getAsanaPMStates() {
    return this.request<YouTrackState[]>('/asana/pm/states')
  }

  async getAsanaPMPriorities() {
    return this.request<string[]>('/asana/pm/priorities')
  }

  async getAsanaPMUsers() {
    return this.request<YouTrackUser[]>('/asana/pm/users')
  }

  async getAsanaPMIssues() {
    return this.request<YouTrackIssue[]>('/asana/pm/issues')
  }

  async getAsanaPMIssue(issueId: string) {
    return this.request<YouTrackIssue>(`/asana/pm/issues/${issueId}`)
  }

  async createAsanaPMIssue(params: {
    summary: string
    description?: string
    state?: string
    priority?: string
    assignee_login?: string
    due_date?: number
    estimation_minutes?: number
  }) {
    return this.request<YouTrackIssue>('/asana/pm/issues', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  async updateAsanaPMIssue(issueId: string, summary?: string, description?: string, state?: string) {
    return this.request<YouTrackIssue>(`/asana/pm/issues/${issueId}`, {
      method: 'PUT',
      body: JSON.stringify({ summary, description, state }),
    })
  }

  async updateAsanaPMIssueState(issueId: string, state: string) {
    return this.request(`/asana/pm/issues/${issueId}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    })
  }

  async deleteAsanaPMIssue(issueId: string) {
    return this.request(`/asana/pm/issues/${issueId}`, { method: 'DELETE' })
  }

  async importFromAsanaPM() {
    return this.request<{ tasks_synced: number; tasks_created: number; tasks_updated: number; errors?: string[] }>(
      '/asana/pm/import',
      { method: 'POST' }
    )
  }

  async getAsanaPMSections() {
    return this.request<YouTrackState[]>('/asana/pm/sections')
  }

  async matchAnalysisWithAsana(personBreakdown: any[], analysis: any[]) {
    return this.request<{
      matches: {
        task_title: string
        person: string
        status: string
        youtrack_issue: { id: string; summary: string; current_state: string }
        proposed_state: string
        confidence: number
      }[]
      unmatched_tasks: { task_title: string; person: string; status: string }[]
      unmatched_issues: { id: string; summary: string; current_state: string }[]
    }>('/asana/pm/match-analysis', {
      method: 'POST',
      body: JSON.stringify({ person_breakdown: personBreakdown, analysis }),
    })
  }

  async asanaPMAssistantQuery(query: string, history: { role: string; content: string }[] = []) {
    return this.request<{ response: string }>('/asana/pm/pm-query', {
      method: 'POST',
      body: JSON.stringify({ query, history }),
    })
  }

  async getAsanaPMDailyBrief() {
    return this.request<DailyBrief>('/asana/pm/daily-brief')
  }

  async getAsanaPMEODSummary() {
    return this.request<EODSummary>('/asana/pm/eod-summary')
  }

  async getAsanaPMDeveloperLoad() {
    return this.request<DeveloperLoad[]>('/asana/pm/developer-load')
  }

  async getAsanaPMBlockerReasons(issueIds: string[]) {
    return this.request<Record<string, string>>(`/asana/pm/blocker-reasons?ids=${issueIds.join(',')}`)
  }

  async saveAsanaPMCarryoverPlan(items: CarryoverItem[]) {
    return this.request<{ success: boolean }>('/asana/pm/save-plan', {
      method: 'POST',
      body: JSON.stringify({ items }),
    })
  }

  async getAsanaPMCarryover() {
    return this.request<CarryoverData>('/asana/pm/carryover')
  }

  async getAsanaPMIssuesGroupedByAssignee() {
    return this.request<{
      assignments: {
        user_name: string
        slack_handle: string
        issues: {
          id: string
          summary: string
          priority_tag: string
          clean_title: string
          status: string
          selected: boolean
        }[]
      }[]
    }>('/asana/pm/issues/grouped-by-assignee')
  }

  // ── PM Report endpoints (Asana) ───────────────────────────────────────────

  async getAsanaAssigneeStats() {
    return this.request<AssigneeStat[]>('/asana/pm/assignee-stats')
  }

  async getAsanaUserAvatars() {
    return this.request<Record<string, string>>('/asana/pm/users/avatars')
  }

  async getAsanaTimeTracking(params?: { week?: string; assignee?: string; priority?: string }) {
    const qs = new URLSearchParams()
    if (params?.week) qs.set('week', params.week)
    if (params?.assignee) qs.set('assignee', params.assignee)
    if (params?.priority) qs.set('priority', params.priority)
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return this.request<TimeTrackingRow[]>(`/asana/pm/time-tracking${query}`)
  }

  async getAsanaIssueTimelines() {
    return this.request<IssueTimeline[]>('/asana/pm/issue-timelines')
  }

  async generateAsanaPMReport(date: string, scope: 'full' | 'summary' = 'full', overrides?: { priorities?: string[]; open_states?: string[]; sections?: string[] }) {
    const params = new URLSearchParams({ scope })
    if (overrides?.open_states?.length) params.set('open_states', overrides.open_states.join(','))
    if (overrides?.sections?.length) params.set('sections', overrides.sections.join(','))
    if (overrides?.priorities?.length) params.set('priorities', overrides.priorities.join(','))
    return this.request<PMReport>(`/asana/pm/report/${date}?${params.toString()}`)
  }

  async generateAsanaWeeklyPMReport(weekStart: string, scope: 'full' | 'summary' = 'full') {
    const params = new URLSearchParams({ scope })
    return this.request<PMReport>(`/asana/pm/report/weekly/${weekStart}?${params.toString()}`)
  }

  async getAsanaStageReportColumns() {
    return this.request<string[]>('/asana/pm/stage-report/columns')
  }

  async generateAsanaStageReport(columns: string[]) {
    return this.request<{ report: string; issue_count: number }>('/asana/pm/stage-report/generate', {
      method: 'POST',
      body: JSON.stringify({ columns }),
    })
  }

  async backfillAsanaLog() {
    return this.request<{ message: string; inserted: number; skipped: number }>('/asana/pm/backfill', {
      method: 'POST',
    })
  }

  // ── Deployment Report (Asana) ────────────────────────────────────────────

  async getAsanaDeploymentTask(url: string) {
    return this.request<{ gid: string; name: string; notes: string }>(
      '/asana/pm/deployment/task', { method: 'POST', body: JSON.stringify({ url }) }
    )
  }

  async generateAsanaDeploymentReport(tickets: DeploymentTicketInput[]) {
    return this.request<DeploymentGenerateResponse>(
      '/asana/pm/deployment/generate', { method: 'POST', body: JSON.stringify({ tickets }) }
    )
  }

  async getAsanaDeploymentConfig() {
    return this.request<DeploymentBotConfig>('/asana/pm/deployment/config')
  }

  async putAsanaDeploymentConfig(cfg: DeploymentBotConfig) {
    return this.request<DeploymentBotConfig>(
      '/asana/pm/deployment/config', { method: 'PUT', body: JSON.stringify(cfg) }
    )
  }

  async getAsanaDeploymentProjectSections() {
    return this.request<Array<{ gid: string; name: string }>>(
      '/asana/pm/deployment/project/sections'
    )
  }

  async getAsanaDeploymentSectionTasks(sectionGid: string) {
    return this.request<{ tasks: Array<{ gid: string; name: string; permalink_url: string }> }>(
      `/asana/pm/deployment/sections/${sectionGid}/tasks`
    )
  }

  async getFeatureGroups(sprintId?: string) {
    const qs = sprintId ? `?sprint_id=${encodeURIComponent(sprintId)}` : ''
    return this.request<FeatureGroup[]>(`/youtrack/feature-groups${qs}`)
  }
}

// Types
export interface FeatureIssue {
  id_readable: string
  summary: string
  issue_type: string
  current_state: string
  state_class: string
  assignee: string
  priority: string
  in_sprint: boolean
}

export interface FeatureGroup {
  id: string
  name: string
  issues: FeatureIssue[]
  done_count: number
  total_count: number
  health: 'done' | 'partial' | 'pending'
}

export interface User {
  id: string
  email: string
  name: string
  picture?: string
  role: 'admin' | 'project_manager' | 'member' | 'viewer'
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  title: string
  description: string
  status: 'todo' | 'in_progress' | 'review' | 'done'
  priority: 'low' | 'medium' | 'high'
  project_id: string
  assignee_id?: string
  assignee?: {
    id: string
    name: string
    email: string
    picture?: string
  }
  asana_id?: string
  asana_url?: string
  asana_section_gid?: string
  youtrack_id?: string
  youtrack_url?: string
  section_name?: string
  due_date?: string
  created_at?: string
  updated_at?: string
  created_by?: string
}

export interface AsanaProject {
  gid: string
  name: string
}

export interface AsanaSection {
  gid: string
  name: string
  position: number
  color?: string
}

// YouTrack Types
export interface YouTrackProject {
  id: string
  name: string
  shortName: string
  archived?: boolean
}

export interface YouTrackBoard {
  id: string
  name: string
}

export interface YouTrackSprint {
  id: string
  name: string
  start: number   // unix ms
  finish: number  // unix ms
  isCompleted: boolean
}

export interface YouTrackColumn {
  name: string
  fieldValues: string[]
}

export interface YouTrackState {
  name: string
}

export interface YouTrackUser {
  id: string
  login: string
  fullName: string
  email?: string
  avatarUrl?: string
}

export interface DeveloperSubsystemConfig {
  developer_login: string
  developer_name:  string
  subsystems:      string[]
  is_qa:           boolean
}

export interface YouTrackIssue {
  id: string
  idReadable?: string
  summary: string
  description: string
  status: string
  subsystem?: string
  priority: string
  type?: string
  assignee?: YouTrackUser
  created: number
  updated: number
  attachments?: YouTrackAttachment[]
  permalink?: string
  section?: string
  due_date?: number
}

export interface YouTrackAttachment {
  id: string
  name: string
  size: number
  mimeType: string
  url: string
  extension: string
}

export interface YouTrackComment {
  id: string
  text: string
  created: number
  author: {
    fullName: string
    login: string
    avatarUrl: string
  }
}

export interface YouTrackSettings {
  base_url: string
  token?: string
  project_id: string
  board_id?: string
  configured: boolean
}

export interface UpdateYouTrackSettingsRequest {
  base_url?: string
  token?: string
  project_id?: string
  board_id?: string
}

export interface SlackMessage {
  user: string
  text: string
  timestamp: string
}

export interface SlackAnalysis {
  analysis: Array<{
    task: string
    status: string
    confidence: number
  }>
}

export interface SlackMention {
  id: string
  user_id: string
  slack_user_id: string
  message_ts: string
  thread_ts?: string
  channel_id: string
  message_text: string
  sender_name: string
  sender_avatar?: string
  requires_reply: boolean
  replied: boolean
  reply_checked_at?: string
  snoozed_until?: string
  pinned: boolean
  created_at: string
}

export interface SlackThread {
  id: string
  user_id: string
  channel_id: string
  thread_ts: string
  message_text: string
  reply_count: number
  last_checked_at?: string
  has_reply: boolean
  reminder_sent: boolean
  snoozed_until?: string
  created_at: string
}

export interface DigestIssue {
  id: string
  summary: string
  assignee: string
  status: string
  priority: string
}

export interface SlackReminderParams {
  thread_ts: string
  channel_id: string
  message_text: string
  follow_up_date?: string
  note?: string
}

export interface TaskStatusAnalysis {
  task_title: string
  detected_status: string
  confidence: number
  evidence: string[]
  message_ids: string[]
}

export interface Discrepancy {
  task_title: string
  slack_status: string
  asana_status: string
  confidence: number
  message_ids: string[]
}

export interface AIAnalysisResponse {
  analysis: TaskStatusAnalysis[]
  discrepancies: Discrepancy[]
  summary: {
    tasks_analyzed: number
    messages_read: number
    discrepancies: number
  }
}

export interface DailyTaskItem {
  id: string
  assignment_id: string
  task_id?: string
  title: string
  priority: 'high' | 'medium' | 'low'
  position: number
  carried_over: boolean
  created_at?: string
}

export interface UserTaskAssignment {
  id: string
  daily_list_id: string
  user_id?: string
  user_name: string
  slack_handle: string
  position: number
  tasks: DailyTaskItem[]
  created_at?: string
}

export interface DailyTaskList {
  id: string
  date: string
  project_id: string
  assignments: UserTaskAssignment[]
  created_at?: string
  updated_at?: string
}

export interface CalendarData {
  year: string
  month: string
  days: Record<string, { status: string; count: string }>
}

export interface Notification {
  id: string
  type: string
  message: string
  read: boolean
  time: string
}

export interface NotificationItem {
  id: string
  user_id: string
  type: string
  title: string
  message: string
  task_id?: string
  read: boolean
  created_at: string
}

export interface ActivityItem {
  id: string
  user_id: string
  actor_name?: string
  type: string
  title: string
  description?: string
  entity_type?: string
  entity_id?: string
  metadata?: Record<string, unknown>
  created_at: string
}

export interface ReminderItem {
  id: string
  user_id: string
  type: string
  title: string
  message?: string
  target_date: string
  target_time?: string
  related_task_id?: string
  related_issue_id?: string
  recurring: string
  status: string
  created_at: string
}

export interface CreateReminderRequest {
  type?: string
  title: string
  message?: string
  target_date: string
  target_time?: string
  related_task_id?: string
  related_issue_id?: string
  recurring?: string
}

export interface TeamProductivityReport {
  period: string
  tasks_completed: number
  tasks_created: number
  completion_rate: number
  daily_data: Array<{ date: string; completed: number }>
}

export interface IndividualReport {
  user_id: string
  tasks_completed: number
  tasks_assigned: number
  completion_rate: number
}

export interface ProjectHealthReport {
  overdue_tasks: number
  blocked_tasks: number
  on_track_tasks: number
  health_score: number
}

export interface AllowedEmail {
  email: string
  role: 'admin' | 'project_manager' | 'member' | 'viewer'
  is_default: boolean
  added_at?: string
}

export interface AllowedDomain {
  domain: string
  role: 'admin' | 'project_manager' | 'member' | 'viewer'
  added_at?: string
}

export interface DeniedEmail {
  email: string
  reason?: string
  added_by?: string
  created_at?: string
}

export interface AccessSettings {
  default_admin_email: string
  allowed_emails: AllowedEmail[]
  allowed_domains: AllowedDomain[]
  denied_emails: DeniedEmail[]
}

export interface AsanaSettings {
  pat: string  // Masked PAT (e.g., "****xxxx")
  project_id: string
  workspace_id: string
  configured: boolean
}

export interface UpdateAsanaSettingsRequest {
  pat?: string
  project_id?: string
  workspace_id?: string
}

// Bot Config Types
export interface BotVariable {
  name: string
  label: string
  type: 'text' | 'select' | 'date' | 'team_member'
  default: string
  options?: string[]
  required: boolean
  description?: string
}

export interface BotConfig {
  id: string
  name: string
  description: string
  bot_type: 'slack_analysis' | 'daily_report' | 'custom' | 'pm_assistant'
  prompt: string
  variables: string // JSON string of BotVariable[]
  is_active: boolean
  created_by?: string
  created_at?: string
  updated_at?: string
}

export interface CreateBotConfigRequest {
  name: string
  description: string
  bot_type: string
  prompt: string
  variables: string
}

export interface UpdateBotConfigRequest {
  name?: string
  description?: string
  prompt?: string
  variables?: string
  is_active?: boolean
}

export interface PMReport {
  id: string
  date: string
  report_type?: 'daily' | 'weekly'
  report_text: string
  done_count: number
  open_count: number
  blocked_count: number
  generated_at: string
  updated_at: string
  saved?: boolean
}

export interface PMReportSummary {
  id: string
  date: string
  done_count: number
  open_count: number
  blocked_count: number
  generated_at: string
}

export interface AssigneeStat {
  assignee: string
  open: number
  in_progress: number
  done: number
  blocked: number
  avg_hours_in_progress: number | null
  issues?: string[]
}

export interface IssueStint {
  stint_number: number
  entered_at: string
  exited_at: string | null
  exited_to: string
  duration_hours: number | null
  moved_back: boolean
  moved_by: string
  comment: string
}

export interface DeploymentSectionConfig {
  platform: string
  header: string
  enabled: boolean
}

export interface DeploymentBotConfig {
  systemPrompt: string
  sections: DeploymentSectionConfig[]
}

export interface DeploymentTicketInput {
  gid: string
  name: string
  notes: string
  manualDescription: boolean
}

export interface DeploymentGenerateResponse {
  results: Array<{ gid: string; fixStatement: string | null; error?: string }>
  retryAfter?: number
}

export interface YTDeployTicket {
  id: string
  id_readable: string
  summary: string
  description: string
  issue_type: string
  subsystem: string
  updated_at?: number
}

export interface DeploymentTicketGenResult {
  fixStatement: string | null
  rateLimited?: boolean
  retryAfter?: number
  error?: string
}

export interface IssueTimeline {
  issue_id: string
  issue_summary: string
  assignee: string
  priority: string
  pinned: boolean
  total_stints: number
  total_hours: number
  is_live: boolean
  live_hours: number
  moved_back_count: number
  is_overdue: boolean
  threshold_hours: number
  due_date?: string
  first_entered_at: string
  last_activity_at: string
  stints: IssueStint[]
  alert_dismissed: boolean
}

export interface TimeTrackingRow {
  id: string
  issue_id: string
  issue_summary: string
  assignee: string
  moved_by: string
  moved_by_mismatch: boolean
  from_state: string
  to_state: string
  priority: string
  transitioned_at: string
  duration_in_prev_state_hours: number | null
  comment: string
  overdue: boolean
  threshold_hours: number
  pinned: boolean
}

export interface StintInfo {
  started_at: string         // RFC3339
  ended_at: string           // RFC3339; empty = ongoing
  duration_hours: number
  end_state: string          // where ticket went after this stint; empty = ongoing
}

export interface SprintBoardIssue {
  id: string
  idReadable: string
  summary: string
  priority: string
  assignee: string
  assigneeLogin: string
  avatarUrl: string
  created_by: string         // issue reporter / creator
  issue_type: string
  current_state: string
  from_state: string
  since_date: string
  hours_in_state: number
  is_delayed: boolean
  threshold_hours: number
  move_type: string          // "qa_rejected" | "dev_stalled" | ""
  bounce_count: number
  total_active_hours: number // includes ongoing active time
  cycle_time_hours: number
  verified_on_dev: string
  verified_on_stage: string
  verified_on_prod: string
  is_hotfix: boolean
  stint_count: number
  stints: StintInfo[]        // per-stint time breakdown
  overdue_level: string      // "deadline" | "sprint" | "sla" | ""
}

export interface QAUserSummary {
  name: string
  avatar_url: string
  tickets_created: string[]
  verified_on_dev: string[]
  verified_on_stage: string[]
  verified_on_prod: string[]
  total_verifications: number
}

export interface SprintSummary {
  total_issues: number
  done_issues: number
  in_progress_count: number
  blocked_count: number
  bounced_count: number
  hotfix_count: number
  overdue_count: number
  sprint_finish_ms: number
  completion_pct: number
}

export interface SprintBoardStatusResponse {
  summary: SprintSummary
  columns: SprintBoardColumn[]
}

export interface IssueStateLogEntry {
  id: string
  issue_id: string
  issue_summary: string
  assignee: string
  moved_by: string
  from_state: string
  to_state: string
  priority: string
  transitioned_at: string
  duration_in_prev_state_hours: number | null
  comment: string
  issue_type: string
}

export interface SprintBoardColumn {
  name: string
  issues: SprintBoardIssue[]
  total: number
}

// ── Workflow Config API ───────────────────────────────────────────────────
export interface PriorityTag {
  label: string
  color: string
  display_order: number
  sla_hours: number
  prefixes: string[]
  yt_mappings: string[]
}

export interface ColumnState {
  state: string
  rank: number
  aliases: string[]
  role: string   // backlog | active | blocked | findings | dev_done | verified | deployed | closed
  is_lateral: boolean
}

export interface HotfixRules {
  from_states: string[]
  to_states: string[]
  type_field_name?: string
  hotfix_values?: string[]
  regression_values?: string[]
}

export interface ReportConfig {
  done_role: string
  blocked_states: string[]
  open_states: string[]
  priority_filters: string[]
  sections: string[]
  tracked_column_roles: string[]  // column roles shown in tracking tab (empty = all)
}

export interface WorkflowConfig {
  id: string
  user_id: string | null
  pm_source: string  // "youtrack" | "asana"
  priority_tags: PriorityTag[]
  column_hierarchy: ColumnState[]
  hotfix_rules: HotfixRules
  report_config: ReportConfig
}

// Export singleton instance
export const api = new ApiService()
export default api

// ── DayTrack interfaces ───────────────────────────────────────────────────────

export interface DayTrackEntry {
  id: string
  user_id: string
  entry_date: string
  name: string
  category: string
  start_time: string
  end_time: string
  duration_mins: number | null
  notes: string
  status: string
  parent_entry_id: string | null
  entry_source: string   // manual | slack | youtrack_qa | youtrack_created
  external_ref: string   // Slack TS or YouTrack issue ID
  created_at: string
  updated_at: string
}

export interface DayTrackKWRule {
  category: string
  keywords: string[]
  rule_type: 'sign_in' | 'sign_off' | 'break_start' | 'break_end'
}

export interface DayTrackSlackConfig {
  id?: string
  channel_id: string
  channel_name: string
  slack_user_id: string
  keyword_rules: DayTrackKWRule[]
  enabled: boolean
  last_scanned_ts?: string
  dest_channel_id: string
  dest_channel_name: string
  timezone: string  // IANA tz, e.g. "Asia/Kolkata"
}

export const DEFAULT_KEYWORD_RULES: DayTrackKWRule[] = [
  { category: 'Sign In',  keywords: ['signing in', 'signed in'],            rule_type: 'sign_in'    },
  { category: 'Sign Off', keywords: ['signing off', 'signed off'],           rule_type: 'sign_off'   },
  { category: 'Breaks',   keywords: ['aws', 'away from screen', 'brb'],      rule_type: 'break_start' },
  { category: 'Breaks',   keywords: ['lunch', 'lunch break'],                rule_type: 'break_start' },
  { category: 'Breaks',   keywords: ['available', 'back', "i'm back"],       rule_type: 'break_end'  },
]

export interface DayTrackPlanned {
  id: string
  user_id: string
  entry_date: string
  name: string
  category: string
  scheduled_time: string
  start_time: string
  end_time: string
  when_type: string
  notes: string
  status: string
  created_at: string
  updated_at: string
}

function dtHeaders(): Record<string, string> {
  const token = localStorage.getItem('token')
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

async function dtFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...options, headers: { ...dtHeaders(), ...(options.headers as Record<string, string> || {}) } })
  if (res.status === 204) return undefined as unknown as T
  const text = await res.text()
  if (!res.ok) throw new Error(text || `Request failed ${res.status}`)
  return JSON.parse(text) as T
}

export const dayTrackApi = {
  getEntries: (date: string) =>
    dtFetch<DayTrackEntry[]>(`${API_URL}/daytrack/entries?date=${date}`),
  createEntry: (data: Partial<DayTrackEntry>) =>
    dtFetch<DayTrackEntry>(`${API_URL}/daytrack/entries`, { method: 'POST', body: JSON.stringify(data) }),
  updateEntry: (id: string, data: Partial<DayTrackEntry>) =>
    dtFetch<DayTrackEntry>(`${API_URL}/daytrack/entries/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEntry: (id: string) =>
    dtFetch<void>(`${API_URL}/daytrack/entries/${id}`, { method: 'DELETE' }),

  getPlanned: (date: string) =>
    dtFetch<DayTrackPlanned[]>(`${API_URL}/daytrack/planned?date=${date}`),
  createPlanned: (data: Partial<DayTrackPlanned>) =>
    dtFetch<DayTrackPlanned>(`${API_URL}/daytrack/planned`, { method: 'POST', body: JSON.stringify(data) }),
  updatePlanned: (id: string, data: Partial<DayTrackPlanned>) =>
    dtFetch<DayTrackPlanned>(`${API_URL}/daytrack/planned/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlanned: (id: string) =>
    dtFetch<void>(`${API_URL}/daytrack/planned/${id}`, { method: 'DELETE' }),

  getSuggestions: () =>
    dtFetch<string[]>(`${API_URL}/daytrack/suggestions`),
  getCategories: () =>
    dtFetch<string[]>(`${API_URL}/daytrack/categories`),
  addCategory: (name: string) =>
    dtFetch<{ name: string }>(`${API_URL}/daytrack/categories`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteCategory: (name: string) =>
    dtFetch<void>(`${API_URL}/daytrack/categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  getSlackConfig: () =>
    dtFetch<DayTrackSlackConfig>(`${API_URL}/daytrack/slack-config`),
  saveSlackConfig: (cfg: DayTrackSlackConfig) =>
    dtFetch<{ ok: boolean }>(`${API_URL}/daytrack/slack-config`, { method: 'PUT', body: JSON.stringify(cfg) }),
  triggerSlackScan: () =>
    dtFetch<{ ok: boolean }>(`${API_URL}/daytrack/slack-scan`, { method: 'POST' }),
  resetSlackScanWindow: () =>
    dtFetch<{ ok: boolean }>(`${API_URL}/daytrack/slack-reset-scan`, { method: 'POST' }),
  scanYouTrackTickets: (date?: string) =>
    dtFetch<{ ok: boolean; added: number; skipped: number; tested: number }>(`${API_URL}/daytrack/yt-scan`, { method: 'POST', body: JSON.stringify({ date: date ?? '' }) }),
  summarize: (payload: { date_label: string; lines: { category: string; name: string; duration: string; notes: string }[] }) =>
    dtFetch<{ summary: string }>(`${API_URL}/daytrack/summarize`, { method: 'POST', body: JSON.stringify(payload) }),
  resolveSlackUser: () =>
    dtFetch<{ slack_user_id: string }>(`${API_URL}/daytrack/slack-resolve-user`),
  postToSlack: (date?: string) =>
    dtFetch<{ ok: boolean }>(`${API_URL}/daytrack/post-to-slack`, { method: 'POST', body: JSON.stringify({ date: date ?? '' }) }),
  getEntriesRange: (start: string, end: string) =>
    dtFetch<DayTrackEntry[]>(`${API_URL}/daytrack/entries/range?start=${start}&end=${end}`),

  transcribe: async (blob: Blob): Promise<{ text: string }> => {
    const token = localStorage.getItem('token')
    const fd = new FormData()
    fd.append('audio', blob, 'recording.webm')
    const res = await fetch(`${API_URL}/daytrack/transcribe`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    })
    if (!res.ok) throw new Error(`Transcription failed: ${res.status}`)
    return res.json()
  },
}

// ── YouTrack avatar cache ─────────────────────────────────────────────────
// Maps fullName → absolute avatarUrl. Fetched once per session, reused everywhere.
let _ytAvatarCache: Record<string, string> | null = null
let _ytAvatarPromise: Promise<Record<string, string>> | null = null

export async function getYouTrackAvatarMap(): Promise<Record<string, string>> {
  if (_ytAvatarCache) return _ytAvatarCache
  if (_ytAvatarPromise) return _ytAvatarPromise
  _ytAvatarPromise = api.getYouTrackUsers().then(res => {
    const map: Record<string, string> = {}
    // getYouTrackUsers returns the raw response — handle both array and {data:[]} shapes
    const users: YouTrackUser[] = Array.isArray(res)
      ? res
      : ((res as unknown as { data?: YouTrackUser[] }).data ?? [])
    for (const u of users) {
      if (u.fullName && u.avatarUrl) {
        // YouTrack Cloud returns absolute URLs (https://xxx.youtrack.cloud/hub/...)
        map[u.fullName] = u.avatarUrl
      }
    }
    _ytAvatarCache = map
    return map
  }).catch(() => {
    _ytAvatarCache = {}
    return {}
  })
  return _ytAvatarPromise
}

// Daily Ops interfaces
export interface DailyOpsIssue {
  id: string
  summary: string
  status: string
  priority: string
  assignee: string
  blocker_reason?: string
}

export interface DailyBrief {
  done_yesterday: DailyOpsIssue[]
  p0: DailyOpsIssue[]
  p1: DailyOpsIssue[]
  p2: DailyOpsIssue[]
  p3: DailyOpsIssue[]
  blocked_ours: DailyOpsIssue[]
  blocked_theirs: DailyOpsIssue[]
  open_items: DailyOpsIssue[]
  unassigned: DailyOpsIssue[]
  generated_at: string
}

export interface EODSummary {
  completed_today: DailyOpsIssue[]
  still_in_progress: DailyOpsIssue[]
  no_movement: DailyOpsIssue[]
  new_blockers: DailyOpsIssue[]
  date: string
}

export interface DeveloperLoad {
  assignee: string
  active_issues: DailyOpsIssue[]
  blocked_issues: DailyOpsIssue[]
  done_today: number
  avg_hours_per_p1: number
  avg_hours_per_p2: number
  last_activity_at: string | null
  missing_update: boolean
  overloaded: boolean
}

export interface CarryoverItem {
  text: string
  done: boolean
}

export interface CarryoverData {
  yesterday: CarryoverItem[]
  today: CarryoverItem[]
  yesterday_date: string
  today_date: string
}

// ── Standup Compiler ──────────────────────────────────────────────────────────

export interface StandupChannelRef {
  id: string
  name: string
}

export interface StandupConfig {
  source_channels: StandupChannelRef[]
  dest_channel_id: string
  dest_channel_name: string
  time_window_start: string // HH:MM
  time_window_end: string
}

export interface UpdateSection {
  label: string
  items: string[]
}

export interface PersonUpdate {
  slack_user_id: string
  display_name: string
  raw_text: string
  sections: UpdateSection[]
  is_owner: boolean
}

export const standupApi = {
  getConfig: (): Promise<{ success: boolean; config: StandupConfig }> =>
    dtFetch(`${API_URL}/standup/config`),

  saveConfig: (cfg: Partial<StandupConfig>): Promise<{ success: boolean }> =>
    dtFetch(`${API_URL}/standup/config`, {
      method: 'PUT',
      body: JSON.stringify(cfg),
    }),

  compile: (date?: string): Promise<{ success: boolean; updates: PersonUpdate[] }> =>
    dtFetch(`${API_URL}/standup/compile`, {
      method: 'POST',
      body: JSON.stringify({ date }),
    }),

  parseOne: (rawText: string): Promise<{
    success: boolean
    sections?: UpdateSection[]
    rate_limited?: boolean
    retry_after?: number
    error?: string
  }> =>
    dtFetch(`${API_URL}/standup/parse-one`, {
      method: 'POST',
      body: JSON.stringify({ raw_text: rawText }),
    }),

  post: (updates: PersonUpdate[], channelId: string): Promise<{ success: boolean }> =>
    dtFetch(`${API_URL}/standup/post`, {
      method: 'POST',
      body: JSON.stringify({ updates, channel_id: channelId }),
    }),

  weekly: (weekStart?: string): Promise<{
    success: boolean
    items: string[]
    week_start: string
    week_end: string
    debug?: { channels: { id: string; name: string; messages_found: number; error?: string }[] }
  }> =>
    dtFetch(`${API_URL}/standup/weekly`, {
      method: 'POST',
      body: JSON.stringify({ week_start: weekStart }),
    }),
}
