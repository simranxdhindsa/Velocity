package scheduler

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/handlers"
	"github.com/dhindsa/project-management/internal/models"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
	"github.com/dhindsa/project-management/internal/services/youtrack"
)

// Service runs scheduled PM checks and creates notifications
type Service struct {
	notifHandler *handlers.NotificationHandler
	reminderRepo *database.ReminderRepository
	settingsRepo *database.SettingsRepository
	dailyRepo    *database.DailyTaskRepository
	reportRepo   *database.ReportRepository
	slackRepo    *database.SlackRepository
	configRepo   *database.WorkflowConfigRepository
	slackService *slacksvc.Service
	stop         chan struct{}
	// Track which one-per-day checks have fired today (reset at midnight)
	firedToday map[string]bool
	// Track which issue IDs have had an overdue notification sent today
	firedOverdueToday map[string]bool
	lastDate          string
	// Last time we synced the state log from YouTrack activity feed
	lastStateLogSync  time.Time
	// Last time we auto-scanned Slack for all users
	lastSlackScan     time.Time
}

// NewService creates a new scheduler service
func NewService(notifHandler *handlers.NotificationHandler) *Service {
	return &Service{
		notifHandler:      notifHandler,
		reminderRepo:      database.NewReminderRepository(),
		settingsRepo:      database.NewSettingsRepository(),
		dailyRepo:         database.NewDailyTaskRepository(),
		reportRepo:        database.NewReportRepository(),
		slackRepo:         database.NewSlackRepository(),
		configRepo:        database.NewWorkflowConfigRepository(),
		slackService:      slacksvc.NewService(),
		stop:              make(chan struct{}),
		firedToday:        make(map[string]bool),
		firedOverdueToday: make(map[string]bool),
	}
}

// Start begins the scheduler loop
func (s *Service) Start() {
	log.Println("[Scheduler] Starting PM scheduler...")
	go s.run()
}

// Stop stops the scheduler
func (s *Service) Stop() {
	close(s.stop)
}

func (s *Service) run() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	// Run once immediately
	s.tick()

	for {
		select {
		case <-ticker.C:
			s.tick()
		case <-s.stop:
			log.Println("[Scheduler] Stopped")
			return
		}
	}
}

func (s *Service) tick() {
	if database.GetPool() == nil {
		return
	}

	ctx := context.Background()

	// Check if scheduler is enabled
	enabled := s.getSetting("scheduler_enabled", "true")
	if enabled != "true" {
		return
	}

	now := time.Now()
	today := now.Format("2006-01-02")
	currentTime := now.Format("15:04")

	// Reset fired checks at midnight
	if today != s.lastDate {
		s.firedToday = make(map[string]bool)
		s.firedOverdueToday = make(map[string]bool)
		s.lastDate = today
	}

	// 0. Auto-sync state log from YouTrack activity feed every 2 minutes
	//    This ensures time tracking stays current without needing a webhook.
	s.autoSyncStateLog(ctx)

	// 0b. Auto-scan Slack for all connected users every 15 minutes
	s.autoScanSlack(ctx)

	// 1. Process due reminders
	s.processDueReminders(ctx)

	// 1b. Check for overdue In Progress tickets (runs every tick, deduped per ticket per day)
	s.checkOverdueInProgress(ctx)

	// 2. Mid-day update check (default 2 PM)
	middayTime := s.getSetting("scheduler_midday_check_time", "14:00")
	if !s.firedToday["midday"] && currentTime >= middayTime {
		s.firedToday["midday"] = true
		s.checkMissingUpdates(ctx, "midday", "12:00", "Mid-day task updates not received")
	}

	// 3. Evening update check (default 6 PM)
	eveningTime := s.getSetting("scheduler_evening_check_time", "18:00")
	if !s.firedToday["evening"] && currentTime >= eveningTime {
		s.firedToday["evening"] = true
		s.checkMissingUpdates(ctx, "evening", "16:00", "Evening task updates pending")
	}

	// 4. Blocked issue reminder (default 10 AM)
	blockerTime := s.getSetting("scheduler_blocker_check_time", "10:00")
	if !s.firedToday["blockers"] && currentTime >= blockerTime {
		s.firedToday["blockers"] = true
		s.checkBlockedIssues(ctx)
	}
}

// processDueReminders handles reminders that have reached their target time
func (s *Service) processDueReminders(ctx context.Context) {
	reminders, err := s.reminderRepo.GetDueReminders(ctx)
	if err != nil {
		log.Printf("[Scheduler] Error fetching due reminders: %v", err)
		return
	}

	for _, rem := range reminders {
		message := rem.Title
		if rem.Message != nil {
			message = *rem.Message
		}

		notif := &models.Notification{
			UserID:  rem.UserID,
			Type:    models.NotificationTaskOverdue,
			Title:   "Reminder: " + rem.Title,
			Message: message,
			TaskID:  rem.RelatedTaskID,
		}

		if err := s.notifHandler.CreateAndBroadcast(ctx, notif); err != nil {
			log.Printf("[Scheduler] Error creating notification for reminder %s: %v", rem.ID, err)
			continue
		}

		// Mark as sent
		if err := s.reminderRepo.MarkAsSent(ctx, rem.ID); err != nil {
			log.Printf("[Scheduler] Error marking reminder %s as sent: %v", rem.ID, err)
		}

		// Reschedule if recurring
		if rem.Recurring != models.RecurringNone {
			if err := s.reminderRepo.RescheduleRecurring(ctx, rem); err != nil {
				log.Printf("[Scheduler] Error rescheduling reminder %s: %v", rem.ID, err)
			}
		}

		log.Printf("[Scheduler] Fired reminder: %s for user %s", rem.Title, rem.UserID)
	}
}

// checkMissingUpdates checks if developers have posted updates in Slack
func (s *Service) checkMissingUpdates(ctx context.Context, checkType, sinceTime, alertTitle string) {
	log.Printf("[Scheduler] Running %s update check...", checkType)

	// Get today's task list to find expected assignees
	today := time.Now().Format("2006-01-02")
	taskList, err := s.dailyRepo.GetNextDayTasks(ctx, today)
	if err != nil || len(taskList) == 0 {
		log.Printf("[Scheduler] No task list found for today, skipping %s check", checkType)
		return
	}

	// Collect unique assignees from today's task list
	assigneeSet := make(map[string]bool)
	for _, task := range taskList {
		assigneeSet[task.Assignee] = true
	}

	if len(assigneeSet) == 0 {
		return
	}

	// Check Slack messages for updates since the given time
	pool := database.GetPool()
	now := time.Now()
	sinceDateTime, _ := time.Parse("2006-01-02 15:04", today+" "+sinceTime)

	// Query slack_messages for messages from today after sinceTime
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT user_name FROM slack_messages
		WHERE timestamp >= $1 AND timestamp <= $2
		AND text != ''
	`, sinceDateTime, now)
	if err != nil {
		log.Printf("[Scheduler] Error querying Slack messages: %v", err)
		return
	}
	defer rows.Close()

	postedUsers := make(map[string]bool)
	for rows.Next() {
		var userName string
		if err := rows.Scan(&userName); err == nil {
			postedUsers[strings.ToLower(userName)] = true
		}
	}

	// Find assignees who haven't posted
	var missingDevs []string
	for assignee := range assigneeSet {
		if !postedUsers[strings.ToLower(assignee)] {
			missingDevs = append(missingDevs, assignee)
		}
	}

	if len(missingDevs) == 0 {
		log.Printf("[Scheduler] All developers have posted %s updates", checkType)
		return
	}

	// Create notification for PM (admin users)
	message := fmt.Sprintf("%s. Developers who haven't posted: %s",
		alertTitle, strings.Join(missingDevs, ", "))

	// Get all admin/PM users to notify
	adminRows, err := pool.Query(ctx, `
		SELECT id FROM users WHERE role IN ('admin', 'project_manager')
	`)
	if err != nil {
		log.Printf("[Scheduler] Error finding admin users: %v", err)
		return
	}
	defer adminRows.Close()

	for adminRows.Next() {
		var userID string
		if err := adminRows.Scan(&userID); err == nil {
			notif := &models.Notification{
				UserID:  userID,
				Type:    models.NotificationTaskUpdated,
				Title:   alertTitle,
				Message: message,
			}
			if err := s.notifHandler.CreateAndBroadcast(ctx, notif); err != nil {
				log.Printf("[Scheduler] Error creating update check notification: %v", err)
			}
		}
	}

	log.Printf("[Scheduler] %s check: %d developers missing updates: %s",
		checkType, len(missingDevs), strings.Join(missingDevs, ", "))
}

// checkBlockedIssues checks YouTrack for blocked issues and creates daily reminders
func (s *Service) checkBlockedIssues(ctx context.Context) {
	log.Println("[Scheduler] Checking blocked issues...")

	baseURL := os.Getenv("YOUTRACK_BASE_URL")
	token := os.Getenv("YOUTRACK_TOKEN")
	projectID := os.Getenv("YOUTRACK_PROJECT_ID")
	if baseURL == "" || token == "" {
		log.Println("[Scheduler] YouTrack not configured, skipping blocked check")
		return
	}
	ytClient := youtrack.NewClient(baseURL, token, projectID)

	issues, err := ytClient.GetIssues(ctx)
	if err != nil {
		log.Printf("[Scheduler] Error fetching YouTrack issues: %v", err)
		return
	}

	var blockedIssues []struct {
		ID       string
		Summary  string
		Assignee string
	}

	for _, issue := range issues {
		status := youtrack.GetStatus(issue)
		if strings.EqualFold(status, "Blocked") || strings.EqualFold(status, "blocked") {
			assigneeName := ""
			if user := youtrack.GetAssignee(issue); user != nil {
				assigneeName = user.FullName
				if assigneeName == "" {
					assigneeName = user.Login
				}
			}
			blockedIssues = append(blockedIssues, struct {
				ID       string
				Summary  string
				Assignee string
			}{
				ID:       issue.ID,
				Summary:  issue.Summary,
				Assignee: assigneeName,
			})
		}
	}

	if len(blockedIssues) == 0 {
		log.Println("[Scheduler] No blocked issues found")
		return
	}

	// Build notification message
	var lines []string
	for _, bi := range blockedIssues {
		line := fmt.Sprintf("• %s: %s", bi.ID, bi.Summary)
		if bi.Assignee != "" {
			line += fmt.Sprintf(" (Assigned: %s)", bi.Assignee)
		}
		lines = append(lines, line)
	}

	message := fmt.Sprintf("%d blocked issue(s) need attention:\n%s",
		len(blockedIssues), strings.Join(lines, "\n"))

	// Notify all admin/PM users
	pool := database.GetPool()
	rows, err := pool.Query(ctx, `SELECT id FROM users WHERE role IN ('admin', 'project_manager')`)
	if err != nil {
		log.Printf("[Scheduler] Error finding admin users: %v", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err == nil {
			notif := &models.Notification{
				UserID:  userID,
				Type:    models.NotificationTaskOverdue,
				Title:   fmt.Sprintf("%d Blocked Issues — Action Needed", len(blockedIssues)),
				Message: message,
			}
			if err := s.notifHandler.CreateAndBroadcast(ctx, notif); err != nil {
				log.Printf("[Scheduler] Error creating blocked issue notification: %v", err)
			}
		}
	}

	log.Printf("[Scheduler] Found %d blocked issues, notifications sent", len(blockedIssues))
}

// checkOverdueInProgress runs every scheduler tick and fires a notification for
// any ticket that has been In Progress longer than its priority threshold.
//
// Dedup logic: each issue_id is only notified ONCE per day (tracked in firedOverdueToday).
// This means: even though the ticker runs every 60s, the PM gets at most one
// "ticket X is overdue" notification per day per ticket — not 480 per day.
//
// Thresholds: P0=4h, P1=24h, P2=48h, P3/Other=72h
func (s *Service) checkOverdueInProgress(ctx context.Context) {
	// Load system default config for SLA thresholds
	sysCfg, _ := s.configRepo.GetSystemDefault(ctx, "youtrack")

	// Query the lowest threshold so we catch all overdue tickets in one pass.
	// We check all tickets older than 4h and then filter by their specific threshold.
	overdueIssues, err := s.reportRepo.GetInProgressOlderThan(ctx, 4.0)
	if err != nil {
		log.Printf("[Scheduler] Error checking overdue In Progress tickets: %v", err)
		return
	}

	for _, issue := range overdueIssues {
		// Skip if already notified today for this issue
		if s.firedOverdueToday[issue.IssueID] {
			continue
		}

		// Compute the threshold for this ticket's priority using config (falls back to hardcoded)
		threshold := overdueThresholdForPriority(issue.Priority)
		if sysCfg != nil {
			for _, tag := range sysCfg.PriorityTags {
				if strings.EqualFold(tag.Label, issue.Priority) {
					threshold = tag.SLAHours
					break
				}
				for _, yt := range tag.YTMappings {
					if strings.EqualFold(yt, issue.Priority) {
						threshold = tag.SLAHours
						break
					}
				}
			}
		}

		// Check elapsed hours
		elapsed := 0.0
		if issue.DurationInPrevStateHours != nil {
			elapsed = *issue.DurationInPrevStateHours
		}

		if elapsed < threshold {
			continue // Not yet overdue for this priority
		}

		// Mark as notified today so we don't spam
		s.firedOverdueToday[issue.IssueID] = true

		assigneeStr := issue.Assignee
		if assigneeStr == "" {
			assigneeStr = "Unassigned"
		}

		msg := fmt.Sprintf(
			"%s (%s) has been In Progress for %.1f hours (threshold: %.0fh for %s priority). Assignee: %s — follow up needed.",
			issue.IssueID, issue.IssueSummary, elapsed, threshold, issue.Priority, assigneeStr,
		)

		notif := &models.Notification{
			Type:    "warning",
			Title:   fmt.Sprintf("⏰ Overdue In Progress: %s", issue.IssueID),
			Message: msg,
		}
		if err := s.notifHandler.CreateAndBroadcast(ctx, notif); err != nil {
			log.Printf("[Scheduler] Error creating overdue notification for %s: %v", issue.IssueID, err)
		} else {
			log.Printf("[Scheduler] Overdue alert sent: %s (%.1fh in progress, threshold %.0fh)", issue.IssueID, elapsed, threshold)
		}
	}
}

// overdueThresholdForPriority returns the overdue threshold in hours for a given priority label.
func overdueThresholdForPriority(priority string) float64 {
	switch strings.ToUpper(priority) {
	case "P0", "CRITICAL":
		return 4
	case "P1":
		return 24
	case "P2":
		return 48
	default: // P3, Normal, Other
		return 72
	}
}

// autoSyncStateLog pulls the YouTrack project-wide activity feed in ONE API call
// and inserts any new state transitions into issue_state_log. Runs at most every 2 minutes.
func (s *Service) autoSyncStateLog(ctx context.Context) {
	if time.Since(s.lastStateLogSync) < 2*time.Minute {
		return
	}
	s.lastStateLogSync = time.Now()

	baseURL := os.Getenv("YOUTRACK_BASE_URL")
	token := os.Getenv("YOUTRACK_TOKEN")
	projectID := os.Getenv("YOUTRACK_PROJECT_ID")
	if baseURL == "" || token == "" || projectID == "" {
		return
	}
	ytClient := youtrack.NewClient(baseURL, token, projectID)

	// Single project-wide call — no per-issue loop
	activities, err := ytClient.GetProjectActivities(ctx, 500, "")
	if err != nil {
		log.Printf("[Scheduler] autoSyncStateLog: failed to fetch activities: %v", err)
		return
	}

	// First pass: build assignee map per issue from Assignee activity items
	assigneeByIssue := make(map[string]string)
	for _, act := range activities {
		if !strings.EqualFold(act.Field.Presentation, "Assignee") || len(act.Added) == 0 {
			continue
		}
		id := act.Target.IDReadable
		if id == "" {
			id = act.Target.ID
		}
		assigneeByIssue[id] = act.Added[0].Name
	}

	inserted := 0
	for _, act := range activities {
		if !strings.EqualFold(act.Field.Presentation, "State") {
			continue
		}
		if len(act.Added) == 0 || len(act.Removed) == 0 {
			continue
		}
		fromState := act.Removed[0].Name
		toState := act.Added[0].Name
		if fromState == "" || toState == "" || fromState == toState {
			continue
		}

		issueID := act.Target.IDReadable
		if issueID == "" {
			issueID = act.Target.ID
		}

		movedBy := ""
		if act.Author != nil {
			if act.Author.FullName != "" {
				movedBy = act.Author.FullName
			} else {
				movedBy = act.Author.Login
			}
		}

		assignee := assigneeByIssue[issueID]
		if assignee == "" {
			assignee = movedBy
		}

		priority := "Other"
		for _, p := range []string{"P0 ", "P1 ", "P2 ", "P3 "} {
			if strings.HasPrefix(act.Target.Summary, p) {
				priority = strings.TrimSuffix(p, " ")
				break
			}
		}

		transitionedAt := time.Unix(act.Timestamp/1000, (act.Timestamp%1000)*int64(time.Millisecond))

		logEntry := &database.IssueStateLog{
			IssueID:        issueID,
			IssueSummary:   act.Target.Summary,
			Assignee:       assignee,
			MovedBy:        movedBy,
			FromState:      fromState,
			ToState:        toState,
			Priority:       priority,
			TransitionedAt: transitionedAt,
			Comment:        "activity:" + act.ID,
		}

		if err := s.reportRepo.InsertStateLogIfNotExists(ctx, logEntry, act.ID); err == nil {
			inserted++
		}
	}

	if inserted > 0 {
		log.Printf("[Scheduler] autoSyncStateLog: inserted %d new transitions", inserted)
	}
}

// autoScanSlack scans Slack for @mentions and unanswered threads for all connected users.
// Runs at most every 15 minutes. Creates SSE notifications for any new mentions found.
func (s *Service) autoScanSlack(ctx context.Context) {
	if time.Since(s.lastSlackScan) < 15*time.Minute {
		return
	}
	s.lastSlackScan = time.Now()

	// Get all users with an active Slack connection
	userIDs, err := s.slackRepo.GetAllConnectedSlackUsers(ctx)
	if err != nil || len(userIDs) == 0 {
		return
	}

	pool := database.GetPool()

	for _, userID := range userIDs {
		// Look up the user's email from the users table
		var email string
		err := pool.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, userID).Scan(&email)
		if err != nil || email == "" {
			continue
		}

		newMentions, err := s.slackService.ScanMentions(ctx, userID, email)
		if err != nil {
			log.Printf("[Scheduler] autoScanSlack: ScanMentions failed for user %s: %v", userID, err)
			continue
		}

		_, _ = s.slackService.ScanUserThreads(ctx, userID, email)

		// Fire SSE notifications for each new @mention
		for _, mention := range newMentions {
			notif := &models.Notification{
				UserID:  userID,
				Type:    "slack_mention",
				Title:   "New @mention in Slack",
				Message: fmt.Sprintf("From %s: %s", mention.SenderName, truncateStr(mention.MessageText, 100)),
			}
			_ = s.notifHandler.CreateAndBroadcast(ctx, notif)
		}

		if len(newMentions) > 0 {
			log.Printf("[Scheduler] autoScanSlack: %d new mention(s) for user %s", len(newMentions), userID)
		}
	}
}

// truncateStr is a local helper for scheduler log messages
func truncateStr(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "…"
}

// getSetting retrieves a setting value with a default
func (s *Service) getSetting(key, defaultValue string) string {
	val := s.settingsRepo.GetValue(context.Background(), key)
	if val == "" {
		return defaultValue
	}
	return val
}
