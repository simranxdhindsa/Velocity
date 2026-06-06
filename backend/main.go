package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/handlers"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	"github.com/dhindsa/project-management/internal/services/scheduler"
	"github.com/gorilla/mux"
	"github.com/joho/godotenv"
	"github.com/rs/cors"
)

func init() {
	// Load .env file before anything else
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using environment variables")
	}
}

// Response represents a standard API response
type Response struct {
	Success bool        `json:"success"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
}

func main() {
	// Connect to database
	log.Println("📦 Connecting to database...")
	if err := database.Connect(); err != nil {
		log.Printf("⚠️  Database connection failed: %v", err)
		log.Println("⚠️  Running without database - using in-memory storage")
	} else {
		log.Println("✅ Database connected successfully")
		defer database.Close()

		// Run auto-migrations (creates tables, adds missing columns)
		if err := database.RunMigrations(); err != nil {
			log.Printf("⚠️  Migration warning: %v", err)
		}
	}

	// Initialize router
	r := mux.NewRouter()

	// API routes
	api := r.PathPrefix("/api").Subrouter()

	// Health check (public)
	api.HandleFunc("/health", healthHandler).Methods("GET")

	// Auth routes (public)
	api.HandleFunc("/auth/google", handlers.HandleGoogleAuth).Methods("POST")
	api.HandleFunc("/auth/google/url", handlers.HandleGetAuthURL).Methods("GET")

	// Protected auth routes
	authProtected := api.PathPrefix("/auth").Subrouter()
	authProtected.Use(middleware.AuthMiddleware)
	authProtected.HandleFunc("/me", handlers.HandleGetMe).Methods("GET")
	authProtected.HandleFunc("/logout", handlers.HandleLogout).Methods("POST")
	authProtected.HandleFunc("/refresh", handlers.HandleRefreshToken).Methods("POST")

	// Task routes (protected)
	taskHandler := handlers.NewTaskHandler()
	taskRoutes := api.PathPrefix("/tasks").Subrouter()
	taskRoutes.Use(middleware.AuthMiddleware)
	taskRoutes.HandleFunc("", taskHandler.GetTasks).Methods("GET")
	taskRoutes.HandleFunc("", taskHandler.CreateTask).Methods("POST")
	taskRoutes.HandleFunc("/yesterday-pending", taskHandler.GetYesterdayPending).Methods("GET")
	taskRoutes.HandleFunc("/stats", taskHandler.GetStats).Methods("GET")
	taskRoutes.HandleFunc("/bulk-status", taskHandler.BulkUpdateStatus).Methods("PATCH")
	taskRoutes.HandleFunc("/by-date/{date}", taskHandler.GetTasksByDate).Methods("GET")
	taskRoutes.HandleFunc("/{id}", taskHandler.GetTask).Methods("GET")
	taskRoutes.HandleFunc("/{id}", taskHandler.UpdateTask).Methods("PUT")
	taskRoutes.HandleFunc("/{id}", taskHandler.DeleteTask).Methods("DELETE")
	taskRoutes.HandleFunc("/{id}/status", taskHandler.UpdateTaskStatus).Methods("PATCH")
	taskRoutes.HandleFunc("/{id}/section", taskHandler.UpdateTaskSection).Methods("PATCH")

	// Asana PM routes (protected) — MUST be registered BEFORE the /asana subrouter
	// because gorilla/mux PathPrefix("/asana") would otherwise swallow /asana/pm/* first.
	asanaPMHandler := handlers.NewAsanaPMHandler()
	asanaPMRoutes := api.PathPrefix("/asana/pm").Subrouter()
	asanaPMRoutes.Use(middleware.AuthMiddleware)
	asanaPMRoutes.HandleFunc("/status", asanaPMHandler.GetStatus).Methods("GET")
	asanaPMRoutes.HandleFunc("/projects", asanaPMHandler.GetProjects).Methods("GET")
	asanaPMRoutes.HandleFunc("/boards", asanaPMHandler.GetBoards).Methods("GET")
	asanaPMRoutes.HandleFunc("/boards/{board_id}/columns", asanaPMHandler.GetBoardColumns).Methods("GET")
	asanaPMRoutes.HandleFunc("/states", asanaPMHandler.GetStates).Methods("GET")
	asanaPMRoutes.HandleFunc("/priorities", asanaPMHandler.GetPriorities).Methods("GET")
	asanaPMRoutes.HandleFunc("/users", asanaPMHandler.GetUsers).Methods("GET")
	asanaPMRoutes.HandleFunc("/issues/grouped-by-assignee", asanaPMHandler.GetIssuesGroupedByAssignee).Methods("GET")
	asanaPMRoutes.HandleFunc("/issues", asanaPMHandler.GetIssues).Methods("GET")
	asanaPMRoutes.HandleFunc("/issues", asanaPMHandler.CreateIssue).Methods("POST")
	asanaPMRoutes.HandleFunc("/issues/{issue_id}", asanaPMHandler.GetIssue).Methods("GET")
	asanaPMRoutes.HandleFunc("/issues/{issue_id}", asanaPMHandler.UpdateIssue).Methods("PUT", "PATCH")
	asanaPMRoutes.HandleFunc("/issues/{issue_id}", asanaPMHandler.DeleteIssue).Methods("DELETE")
	asanaPMRoutes.HandleFunc("/issues/{issue_id}/state", asanaPMHandler.UpdateIssueState).Methods("PATCH")
	asanaPMRoutes.HandleFunc("/sections", asanaPMHandler.GetProjectSectionsFromDB).Methods("GET")
	asanaPMRoutes.HandleFunc("/import", asanaPMHandler.ImportFromAsana).Methods("POST")
	asanaPMRoutes.HandleFunc("/match-analysis", asanaPMHandler.MatchAnalysis).Methods("POST")
	asanaPMRoutes.HandleFunc("/pm-query", asanaPMHandler.PMAssistantQuery).Methods("POST")
	asanaPMRoutes.HandleFunc("/daily-brief", asanaPMHandler.GetDailyBrief).Methods("GET")
	asanaPMRoutes.HandleFunc("/eod-summary", asanaPMHandler.GetEODSummary).Methods("GET")
	asanaPMRoutes.HandleFunc("/developer-load", asanaPMHandler.GetDeveloperLoad).Methods("GET")
	asanaPMRoutes.HandleFunc("/blocker-reasons", asanaPMHandler.GetBlockerReasons).Methods("GET")
	asanaPMRoutes.HandleFunc("/save-plan", asanaPMHandler.SaveCarryoverPlan).Methods("POST")
	asanaPMRoutes.HandleFunc("/carryover", asanaPMHandler.GetCarryover).Methods("GET")
	asanaPMRoutes.HandleFunc("/project", asanaPMHandler.SaveProjectGID).Methods("PATCH")
	// PM Reports endpoints
	asanaPMRoutes.HandleFunc("/assignee-stats", asanaPMHandler.GetAssigneeStats).Methods("GET")
	asanaPMRoutes.HandleFunc("/users/avatars", asanaPMHandler.GetUserAvatars).Methods("GET")
	asanaPMRoutes.HandleFunc("/time-tracking", asanaPMHandler.GetTimeTracking).Methods("GET")
	asanaPMRoutes.HandleFunc("/issue-timelines", asanaPMHandler.GetIssueTimelines).Methods("GET")
	asanaPMRoutes.HandleFunc("/report/weekly/{weekStart}", asanaPMHandler.GenerateWeeklyPMReport).Methods("GET")
	asanaPMRoutes.HandleFunc("/report/{date}", asanaPMHandler.GeneratePMReport).Methods("GET")
	asanaPMRoutes.HandleFunc("/stage-report/columns", asanaPMHandler.GetStageReportColumns).Methods("GET")
	asanaPMRoutes.HandleFunc("/stage-report/generate", asanaPMHandler.GenerateStageReport).Methods("POST")
	asanaPMRoutes.HandleFunc("/deployment/task", asanaPMHandler.GetDeploymentTask).Methods("POST")
	asanaPMRoutes.HandleFunc("/deployment/generate", asanaPMHandler.GenerateDeploymentReport).Methods("POST")
	asanaPMRoutes.HandleFunc("/deployment/config", asanaPMHandler.GetDeploymentConfig).Methods("GET")
	asanaPMRoutes.HandleFunc("/deployment/config", asanaPMHandler.PutDeploymentConfig).Methods("PUT")
	asanaPMRoutes.HandleFunc("/deployment/project/sections", asanaPMHandler.GetDeploymentProjectSections).Methods("GET")
	asanaPMRoutes.HandleFunc("/deployment/sections/{sectionGid}/tasks", asanaPMHandler.GetSectionTasksForDeployment).Methods("GET")
	asanaPMRoutes.HandleFunc("/backfill", asanaPMHandler.BackfillAsanaLog).Methods("POST")

	// User data source preference routes (protected)
	userPrefRoutes := api.PathPrefix("/user").Subrouter()
	userPrefRoutes.Use(middleware.AuthMiddleware)
	userPrefRoutes.HandleFunc("/data-source", asanaPMHandler.GetDataSource).Methods("GET")
	userPrefRoutes.HandleFunc("/data-source", asanaPMHandler.SetDataSource).Methods("PUT")

	// Asana routes (protected) — registered AFTER /asana/pm so they don't conflict
	asanaHandler := handlers.NewAsanaHandler()
	asanaRoutes := api.PathPrefix("/asana").Subrouter()
	asanaRoutes.Use(middleware.AuthMiddleware)
	asanaRoutes.HandleFunc("/connect", asanaHandler.ConnectAsana).Methods("POST")
	asanaRoutes.HandleFunc("/disconnect", asanaHandler.DisconnectAsana).Methods("POST")
	asanaRoutes.HandleFunc("/status", asanaHandler.GetAsanaStatus).Methods("GET")
	asanaRoutes.HandleFunc("/workspaces", asanaHandler.GetAsanaWorkspaces).Methods("GET")
	asanaRoutes.HandleFunc("/projects", asanaHandler.GetAsanaProjects).Methods("GET")
	asanaRoutes.HandleFunc("/projects/{asana_project_id}/sections", asanaHandler.GetAsanaSections).Methods("GET")
	asanaRoutes.HandleFunc("/sections", asanaHandler.GetProjectSectionsFromDB).Methods("GET")
	asanaRoutes.HandleFunc("/import", asanaHandler.ImportFromEnv).Methods("POST")

	// Project-specific Asana routes (protected)
	projectAsanaRoutes := api.PathPrefix("/projects/{id}/asana").Subrouter()
	projectAsanaRoutes.Use(middleware.AuthMiddleware)
	projectAsanaRoutes.HandleFunc("/link", asanaHandler.LinkProject).Methods("POST")
	projectAsanaRoutes.HandleFunc("/sync", asanaHandler.SyncProject).Methods("POST")
	projectAsanaRoutes.HandleFunc("/webhook", asanaHandler.SetupWebhook).Methods("POST")

	// Task-specific Asana routes (protected)
	taskAsanaRoutes := api.PathPrefix("/tasks/{id}/asana").Subrouter()
	taskAsanaRoutes.Use(middleware.AuthMiddleware)
	taskAsanaRoutes.HandleFunc("/sync", asanaHandler.SyncTaskStatus).Methods("POST")
	taskAsanaRoutes.HandleFunc("/push", asanaHandler.PushToAsana).Methods("POST")

	// Asana webhook endpoint (public - called by Asana)
	api.HandleFunc("/webhooks/asana", asanaHandler.HandleWebhook).Methods("POST")

	// SSE hub for real-time updates
	sseHub := handlers.NewSSEHub()
	api.HandleFunc("/events", sseHub.HandleEvents).Methods("GET")

	// YouTrack routes (protected)
	youtrackHandler := handlers.NewYouTrackHandler(sseHub)

	// YouTrack webhook endpoint (public - called by YouTrack server)
	api.HandleFunc("/webhooks/youtrack", youtrackHandler.HandleWebhook).Methods("POST")
	youtrackRoutes := api.PathPrefix("/youtrack").Subrouter()
	youtrackRoutes.Use(middleware.AuthMiddleware)
	youtrackRoutes.HandleFunc("/status", youtrackHandler.GetStatus).Methods("GET")
	youtrackRoutes.HandleFunc("/test", youtrackHandler.TestConnection).Methods("POST")
	youtrackRoutes.HandleFunc("/projects", youtrackHandler.GetProjects).Methods("GET")
	youtrackRoutes.HandleFunc("/boards", youtrackHandler.GetBoards).Methods("GET")
	youtrackRoutes.HandleFunc("/board/columns", youtrackHandler.GetDefaultBoardColumns).Methods("GET")
	youtrackRoutes.HandleFunc("/boards/{board_id}/columns", youtrackHandler.GetBoardColumns).Methods("GET")
	youtrackRoutes.HandleFunc("/sprints", youtrackHandler.GetSprints).Methods("GET")
	youtrackRoutes.HandleFunc("/states", youtrackHandler.GetStates).Methods("GET")
	youtrackRoutes.HandleFunc("/priorities", youtrackHandler.GetPriorities).Methods("GET")
	youtrackRoutes.HandleFunc("/type-field-values", youtrackHandler.GetTypeFieldValues).Methods("GET")
	youtrackRoutes.HandleFunc("/users", youtrackHandler.GetUsers).Methods("GET")
	youtrackRoutes.HandleFunc("/form-meta", youtrackHandler.GetIssueFormMeta).Methods("GET")
	youtrackRoutes.HandleFunc("/ai/parse-ticket", youtrackHandler.AIParseTicket).Methods("POST")
	youtrackRoutes.HandleFunc("/issues", youtrackHandler.GetIssues).Methods("GET")
	youtrackRoutes.HandleFunc("/issues", youtrackHandler.CreateIssue).Methods("POST")
	youtrackRoutes.HandleFunc("/issues/grouped-by-assignee", youtrackHandler.GetIssuesGroupedByAssignee).Methods("GET") // Must be before {issue_id} wildcard
	youtrackRoutes.HandleFunc("/issues/{issue_id}", youtrackHandler.GetIssue).Methods("GET")
	youtrackRoutes.HandleFunc("/issues/{issue_id}", youtrackHandler.UpdateIssue).Methods("PUT", "PATCH")
	youtrackRoutes.HandleFunc("/issues/{issue_id}", youtrackHandler.DeleteIssue).Methods("DELETE")
	youtrackRoutes.HandleFunc("/issues/{issue_id}/state", youtrackHandler.UpdateIssueState).Methods("PATCH")
	youtrackRoutes.HandleFunc("/issues/{issue_id}/attachments", youtrackHandler.UploadIssueAttachment).Methods("POST")
	youtrackRoutes.HandleFunc("/issues/{issue_id}/comments", youtrackHandler.GetIssueComments).Methods("GET")
	youtrackRoutes.HandleFunc("/issues/{issue_id}/comments", youtrackHandler.AddIssueComment).Methods("POST")
	// Proxy is public (no JWT) — browser <img> tags can't send Authorization headers.
	// Security is enforced inside ProxyAttachment by checking the URL matches the YouTrack instance.
	api.HandleFunc("/youtrack/proxy", youtrackHandler.ProxyAttachment).Methods("GET", "HEAD")
	youtrackRoutes.HandleFunc("/sections", youtrackHandler.GetProjectSectionsFromDB).Methods("GET") // Get synced sections from DB
	youtrackRoutes.HandleFunc("/import", youtrackHandler.ImportFromYouTrack).Methods("POST")       // Import issues from YouTrack
	youtrackRoutes.HandleFunc("/match-analysis", youtrackHandler.MatchAnalysis).Methods("POST")
	youtrackRoutes.HandleFunc("/bulk-update-states", youtrackHandler.BulkUpdateStates).Methods("POST")
	youtrackRoutes.HandleFunc("/sync-recommendations", youtrackHandler.GetSyncRecommendations).Methods("POST")
	youtrackRoutes.HandleFunc("/pm-query", youtrackHandler.PMAssistantQuery).Methods("POST")
	youtrackRoutes.HandleFunc("/daily-brief", youtrackHandler.GetDailyBrief).Methods("GET")
	youtrackRoutes.HandleFunc("/eod-summary", youtrackHandler.GetEODSummary).Methods("GET")
	youtrackRoutes.HandleFunc("/developer-load", youtrackHandler.GetDeveloperLoad).Methods("GET")
	youtrackRoutes.HandleFunc("/blocker-reasons", youtrackHandler.GetBlockerReasons).Methods("GET")
	youtrackRoutes.HandleFunc("/save-plan", youtrackHandler.SaveCarryoverPlan).Methods("POST")
	youtrackRoutes.HandleFunc("/carryover", youtrackHandler.GetCarryover).Methods("GET")
	youtrackRoutes.HandleFunc("/feature-groups", youtrackHandler.GetFeatureGroups).Methods("GET")

	// Task-specific YouTrack routes (protected)
	taskYouTrackRoutes := api.PathPrefix("/tasks/{id}/youtrack").Subrouter()
	taskYouTrackRoutes.Use(middleware.AuthMiddleware)
	taskYouTrackRoutes.HandleFunc("/sync", youtrackHandler.SyncTaskToYouTrack).Methods("POST")

	// Notification handler must be created before Slack handler (Slack needs it for SSE broadcast)
	notifHandler := handlers.NewNotificationHandler(sseHub)
	notifRoutes := api.PathPrefix("/notifications").Subrouter()
	notifRoutes.Use(middleware.AuthMiddleware)
	notifRoutes.HandleFunc("", notifHandler.GetNotifications).Methods("GET")
	notifRoutes.HandleFunc("/unread-count", notifHandler.GetUnreadCount).Methods("GET")
	notifRoutes.HandleFunc("/{id}/read", notifHandler.MarkAsRead).Methods("PATCH")
	notifRoutes.HandleFunc("/{id}", notifHandler.Delete).Methods("DELETE")
	notifRoutes.HandleFunc("/read-all", notifHandler.MarkAllAsRead).Methods("PATCH")
	notifRoutes.HandleFunc("/clear-all", notifHandler.ClearAll).Methods("DELETE")

	// Activity log routes (protected)
	activityHandler := handlers.NewActivityHandler()
	activityRoutes := api.PathPrefix("/activity").Subrouter()
	activityRoutes.Use(middleware.AuthMiddleware)
	activityRoutes.HandleFunc("", activityHandler.GetActivity).Methods("GET")

	// Standup Compiler routes (admin-only)
	standupHandler := handlers.NewStandupCompilerHandler()
	standupRoutes := api.PathPrefix("/standup").Subrouter()
	standupRoutes.Use(middleware.AuthMiddleware)
	standupRoutes.Use(middleware.AdminOnly)
	standupRoutes.HandleFunc("/config", standupHandler.GetConfig).Methods("GET")
	standupRoutes.HandleFunc("/config", standupHandler.SaveConfig).Methods("PUT")
	standupRoutes.HandleFunc("/compile", standupHandler.Compile).Methods("POST")
	standupRoutes.HandleFunc("/parse-one", standupHandler.ParseOne).Methods("POST")
	standupRoutes.HandleFunc("/post", standupHandler.Post).Methods("POST")
	standupRoutes.HandleFunc("/weekly", standupHandler.Weekly).Methods("POST")

	// Slack routes (protected)
	slackHandler := handlers.NewSlackHandler(notifHandler)
	slackRoutes := api.PathPrefix("/slack").Subrouter()
	slackRoutes.Use(middleware.AuthMiddleware)
	slackRoutes.HandleFunc("/connect", slackHandler.Connect).Methods("POST")
	slackRoutes.HandleFunc("/disconnect", slackHandler.Disconnect).Methods("POST")
	slackRoutes.HandleFunc("/status", slackHandler.GetStatus).Methods("GET")
	slackRoutes.HandleFunc("/channels", slackHandler.GetChannels).Methods("GET")
	slackRoutes.HandleFunc("/channel", slackHandler.SetChannel).Methods("POST")
	slackRoutes.HandleFunc("/monitor-channel", slackHandler.SetMonitorChannel).Methods("POST")
	slackRoutes.HandleFunc("/messages", slackHandler.GetMessages).Methods("GET")
	slackRoutes.HandleFunc("/messages/yesterday", slackHandler.GetYesterdayMessages).Methods("GET")
	// Slack intelligence routes
	slackRoutes.HandleFunc("/scan", slackHandler.Scan).Methods("POST")
	slackRoutes.HandleFunc("/mentions", slackHandler.GetMentions).Methods("GET")
	slackRoutes.HandleFunc("/mentions/{messageTS}/dismiss", slackHandler.DismissMention).Methods("POST")
	slackRoutes.HandleFunc("/mentions/{messageTS}/snooze", slackHandler.SnoozeMention).Methods("POST")
	slackRoutes.HandleFunc("/threads", slackHandler.GetUnansweredThreads).Methods("GET")
	slackRoutes.HandleFunc("/threads/{threadTS}/snooze", slackHandler.SnoozeThread).Methods("POST")
	slackRoutes.HandleFunc("/digest", slackHandler.PostDigest).Methods("POST")
	slackRoutes.HandleFunc("/reminders", slackHandler.CreateFollowupReminder).Methods("POST")
	slackRoutes.HandleFunc("/post-morning-report", slackHandler.PostMorningReport).Methods("POST")
	// Slack Intelligence v2
	slackRoutes.HandleFunc("/reply", slackHandler.ReplyToThread).Methods("POST")
	slackRoutes.HandleFunc("/thread-replies", slackHandler.GetThreadRepliesHandler).Methods("GET")
	slackRoutes.HandleFunc("/mentions/{messageTS}/pin", slackHandler.PinMention).Methods("POST")
	slackRoutes.HandleFunc("/templates", slackHandler.GetTemplates).Methods("GET")
	slackRoutes.HandleFunc("/templates", slackHandler.CreateTemplate).Methods("POST")
	slackRoutes.HandleFunc("/templates/{id}", slackHandler.DeleteTemplate).Methods("DELETE")
	slackRoutes.HandleFunc("/saved-items", slackHandler.GetSavedItems).Methods("GET")

	// AI Analysis routes (protected)
	aiHandler := handlers.NewAIHandler()
	aiRoutes := api.PathPrefix("/ai").Subrouter()
	aiRoutes.Use(middleware.AuthMiddleware)
	aiRoutes.HandleFunc("/analyze", aiHandler.AnalyzeSlackMessages).Methods("POST")
	aiRoutes.HandleFunc("/analyze-manual", aiHandler.AnalyzeManualInput).Methods("POST")
	aiRoutes.HandleFunc("/discrepancies", aiHandler.GetDiscrepancies).Methods("GET")
	aiRoutes.HandleFunc("/eod-plan", aiHandler.GenerateEODPlan).Methods("POST")

	// Daily Task Management routes (protected)
	dailyTaskHandler := handlers.NewDailyTaskHandler()
	dailyTaskRoutes := api.PathPrefix("/daily-tasks").Subrouter()
	dailyTaskRoutes.Use(middleware.AuthMiddleware)

	// Analysis endpoints
	dailyTaskRoutes.HandleFunc("/analysis", dailyTaskHandler.SaveAnalysis).Methods("POST")
	dailyTaskRoutes.HandleFunc("/analysis/{date}", dailyTaskHandler.GetAnalysisByDate).Methods("GET")

	// Today's tasks (from analysis)
	dailyTaskRoutes.HandleFunc("/today/{date}", dailyTaskHandler.GetTodaysTasks).Methods("GET")

	// Next day tasks (editable)
	dailyTaskRoutes.HandleFunc("/next-day/{date}", dailyTaskHandler.GetNextDayTasks).Methods("GET")
	dailyTaskRoutes.HandleFunc("/next-day/generate", dailyTaskHandler.GenerateNextDayTasks).Methods("POST")
	dailyTaskRoutes.HandleFunc("/next-day/task", dailyTaskHandler.CreateNextDayTask).Methods("POST")
	dailyTaskRoutes.HandleFunc("/next-day/bulk-create", dailyTaskHandler.BulkCreateNextDayTasks).Methods("POST")
	dailyTaskRoutes.HandleFunc("/next-day/task/{taskId}", dailyTaskHandler.UpdateNextDayTask).Methods("PATCH")
	dailyTaskRoutes.HandleFunc("/next-day/task/{taskId}", dailyTaskHandler.DeleteNextDayTask).Methods("DELETE")
	dailyTaskRoutes.HandleFunc("/next-day/reorder", dailyTaskHandler.ReorderNextDayTasks).Methods("PATCH")
	dailyTaskRoutes.HandleFunc("/next-day/{date}/slack-format", dailyTaskHandler.GetFormattedSlackMessage).Methods("GET")

	// Developer-subsystem config routes (protected)
	devConfigHandler := handlers.NewDeveloperConfigHandler()
	devConfigRoutes := api.PathPrefix("/developer-config").Subrouter()
	devConfigRoutes.Use(middleware.AuthMiddleware)
	devConfigRoutes.HandleFunc("", devConfigHandler.GetDeveloperConfigs).Methods("GET")
	devConfigRoutes.HandleFunc("", devConfigHandler.SaveDeveloperConfigs).Methods("POST")

	// Bot Config routes (protected)
	botConfigHandler := handlers.NewBotConfigHandler()
	botRoutes := api.PathPrefix("/bots").Subrouter()
	botRoutes.Use(middleware.AuthMiddleware)
	botRoutes.HandleFunc("", botConfigHandler.ListBots).Methods("GET")
	botRoutes.HandleFunc("", botConfigHandler.CreateBot).Methods("POST")
	botRoutes.HandleFunc("/templates", botConfigHandler.GetTemplates).Methods("GET")
	botRoutes.HandleFunc("/stage-report/columns", botConfigHandler.GetStageColumns).Methods("GET")
	botRoutes.HandleFunc("/stage-report/generate", botConfigHandler.GenerateStageReport).Methods("POST")
	botRoutes.HandleFunc("/deployment/tickets", botConfigHandler.GetDeploymentTickets).Methods("GET")
	botRoutes.HandleFunc("/deployment/generate-ticket", botConfigHandler.GenerateDeploymentTicket).Methods("POST")
	botRoutes.HandleFunc("/{id}", botConfigHandler.GetBot).Methods("GET")
	botRoutes.HandleFunc("/{id}", botConfigHandler.UpdateBot).Methods("PUT")
	botRoutes.HandleFunc("/{id}", botConfigHandler.DeleteBot).Methods("DELETE")

	// Workflow Config routes (protected)
	workflowConfigHandler := handlers.NewWorkflowConfigHandler()
	wcRoutes := api.PathPrefix("/workflow-config").Subrouter()
	wcRoutes.Use(middleware.AuthMiddleware)
	wcRoutes.HandleFunc("", workflowConfigHandler.Get).Methods("GET")
	wcRoutes.HandleFunc("", workflowConfigHandler.Update).Methods("PUT")
	wcRoutes.HandleFunc("/priorities", workflowConfigHandler.UpdatePriorities).Methods("PUT")
	wcRoutes.HandleFunc("/columns", workflowConfigHandler.UpdateColumns).Methods("PUT")
	wcRoutes.HandleFunc("/hotfix-rules", workflowConfigHandler.UpdateHotfixRules).Methods("PUT")
	wcRoutes.HandleFunc("/report", workflowConfigHandler.UpdateReportConfig).Methods("PUT")
	wcRoutes.HandleFunc("/reset", workflowConfigHandler.Reset).Methods("POST")
	wcRoutes.HandleFunc("/defaults", workflowConfigHandler.GetDefaults).Methods("GET")

	// Calendar routes (protected)
	calendarRoutes := api.PathPrefix("/calendar").Subrouter()
	calendarRoutes.Use(middleware.AuthMiddleware)
	calendarRoutes.HandleFunc("/{year}/{month}", calendarHandler).Methods("GET")

	// Reminder routes (protected)
	reminderHandler := handlers.NewReminderHandler()
	reminderRoutes := api.PathPrefix("/reminders").Subrouter()
	reminderRoutes.Use(middleware.AuthMiddleware)
	reminderRoutes.HandleFunc("", reminderHandler.GetReminders).Methods("GET")
	reminderRoutes.HandleFunc("", reminderHandler.CreateReminder).Methods("POST")
	reminderRoutes.HandleFunc("/{id}/dismiss", reminderHandler.DismissReminder).Methods("PATCH")
	reminderRoutes.HandleFunc("/{id}", reminderHandler.DeleteReminder).Methods("DELETE")

	// Start the PM scheduler (background goroutine)
	pmScheduler := scheduler.NewService(notifHandler)
	pmScheduler.Start()
	defer pmScheduler.Stop()


	// Wire notification handler into YouTrack handler for overdue/blocked notifications
	youtrackHandler.SetNotificationHandler(notifHandler)

	// Report handler (PM reports, time tracking, assignee stats)
	reportHandler := handlers.NewReportHandler(notifHandler)

	// Reports routes (protected)
	reportRoutes := api.PathPrefix("/reports").Subrouter()
	reportRoutes.Use(middleware.AuthMiddleware)
	reportRoutes.HandleFunc("/pm-report/weekly/{weekStart}", reportHandler.GenerateWeeklyPMReport).Methods("GET")
	reportRoutes.HandleFunc("/pm-reports/weekly", reportHandler.ListWeeklyReports).Methods("GET")
	reportRoutes.HandleFunc("/pm-report/{date}/saved", reportHandler.GetSavedReport).Methods("GET")
	reportRoutes.HandleFunc("/pm-report/{date}", reportHandler.GeneratePMReport).Methods("GET")
	reportRoutes.HandleFunc("/pm-reports", reportHandler.ListReports).Methods("GET")
	reportRoutes.HandleFunc("/pm-report/{id}/delete", reportHandler.DeletePMReport).Methods("DELETE")
	reportRoutes.HandleFunc("/assignee-stats", reportHandler.GetAssigneeStats).Methods("GET")
	reportRoutes.HandleFunc("/time-tracking", reportHandler.GetTimeTracking).Methods("GET")
	reportRoutes.HandleFunc("/pins", reportHandler.GetPins).Methods("GET")
	reportRoutes.HandleFunc("/pins", reportHandler.PinIssue).Methods("POST")
	reportRoutes.HandleFunc("/pins/{issueID}", reportHandler.UnpinIssue).Methods("DELETE")
	reportRoutes.HandleFunc("/issue-timelines", reportHandler.GetIssueTimelines).Methods("GET")
	reportRoutes.HandleFunc("/alerts/dismiss", reportHandler.DismissAlert).Methods("POST")
	reportRoutes.HandleFunc("/alerts/dismiss/{issueID}", reportHandler.UndismissAlert).Methods("DELETE")
	reportRoutes.HandleFunc("/backfill", reportHandler.BackfillStateLog).Methods("POST")
	reportRoutes.HandleFunc("/import-history", reportHandler.ImportHistory).Methods("POST")
	reportRoutes.HandleFunc("/reconcile", reportHandler.ReconcileStateLog).Methods("POST")
	reportRoutes.HandleFunc("/reset-state-log", reportHandler.ResetStateLog).Methods("DELETE")
	reportRoutes.HandleFunc("/sprint-board-status", reportHandler.GetSprintBoardStatus).Methods("GET")
	reportRoutes.HandleFunc("/sprint-qa-summary", reportHandler.GetSprintQASummary).Methods("GET")
	reportRoutes.HandleFunc("/issue-transitions", reportHandler.GetIssueTransitions).Methods("GET")

	// DayTrack routes (protected)
	dayTrackHandler := handlers.NewDayTrackHandler()
	dayTrackRoutes := api.PathPrefix("/daytrack").Subrouter()
	dayTrackRoutes.Use(middleware.AuthMiddleware)
	dayTrackRoutes.HandleFunc("/entries/range", dayTrackHandler.GetEntriesRange).Methods("GET")
	dayTrackRoutes.HandleFunc("/entries", dayTrackHandler.GetEntries).Methods("GET")
	dayTrackRoutes.HandleFunc("/entries", dayTrackHandler.CreateEntry).Methods("POST")
	dayTrackRoutes.HandleFunc("/entries/{id}", dayTrackHandler.UpdateEntry).Methods("PUT")
	dayTrackRoutes.HandleFunc("/entries/{id}", dayTrackHandler.DeleteEntry).Methods("DELETE")
	dayTrackRoutes.HandleFunc("/planned", dayTrackHandler.GetPlanned).Methods("GET")
	dayTrackRoutes.HandleFunc("/planned", dayTrackHandler.CreatePlanned).Methods("POST")
	dayTrackRoutes.HandleFunc("/planned/{id}", dayTrackHandler.UpdatePlanned).Methods("PUT")
	dayTrackRoutes.HandleFunc("/planned/{id}", dayTrackHandler.DeletePlanned).Methods("DELETE")
	dayTrackRoutes.HandleFunc("/suggestions", dayTrackHandler.GetSuggestions).Methods("GET")
	dayTrackRoutes.HandleFunc("/categories", dayTrackHandler.GetCategories).Methods("GET")
	dayTrackRoutes.HandleFunc("/categories", dayTrackHandler.AddCategory).Methods("POST")
	dayTrackRoutes.HandleFunc("/categories/{name}", dayTrackHandler.DeleteCategory).Methods("DELETE")
	// Slack auto-logging config
	dayTrackRoutes.HandleFunc("/slack-config", dayTrackHandler.GetSlackConfig).Methods("GET")
	dayTrackRoutes.HandleFunc("/slack-config", dayTrackHandler.UpsertSlackConfig).Methods("PUT")
	dayTrackRoutes.HandleFunc("/slack-scan", dayTrackHandler.TriggerSlackScan).Methods("POST")
	dayTrackRoutes.HandleFunc("/slack-reset-scan", dayTrackHandler.ResetSlackScan).Methods("POST")
	dayTrackRoutes.HandleFunc("/summarize", dayTrackHandler.Summarize).Methods("POST")
	dayTrackRoutes.HandleFunc("/yt-scan", youtrackHandler.ScanYouTrackTickets).Methods("POST")
	dayTrackRoutes.HandleFunc("/slack-resolve-user", dayTrackHandler.ResolveSlackUser).Methods("GET")
	dayTrackRoutes.HandleFunc("/transcribe", dayTrackHandler.Transcribe).Methods("POST")
	dayTrackRoutes.HandleFunc("/post-to-slack", dayTrackHandler.PostToSlack).Methods("POST")

	// Start DayTrack Slack background scanner (5-min polling)
	handlers.RunDayTrackSlackScanner(database.NewDayTrackRepository())

	// User management routes (protected - admin only)
	userRoutes := api.PathPrefix("/users").Subrouter()
	userRoutes.Use(middleware.AuthMiddleware)
	userRoutes.Use(middleware.AdminOnly)
	userRoutes.HandleFunc("", getUsersHandler).Methods("GET")
	userRoutes.HandleFunc("/invite", inviteUserHandler).Methods("POST")
	userRoutes.HandleFunc("/{id}/role", updateUserRoleHandler).Methods("PATCH")
	userRoutes.HandleFunc("/{id}", deleteUserHandler).Methods("DELETE")

	// Whitelist/Access Control routes (protected - admin only)
	whitelistHandler := handlers.NewWhitelistHandler()
	whitelistRoutes := api.PathPrefix("/settings/access").Subrouter()
	whitelistRoutes.Use(middleware.AuthMiddleware)
	whitelistRoutes.HandleFunc("", whitelistHandler.GetWhitelistSettingsHandler).Methods("GET")
	whitelistRoutes.HandleFunc("/emails", whitelistHandler.GetAllowedEmailsHandler).Methods("GET")
	whitelistRoutes.HandleFunc("/emails", whitelistHandler.AddAllowedEmailHandler).Methods("POST")
	whitelistRoutes.HandleFunc("/emails/{email}", whitelistHandler.RemoveAllowedEmailHandler).Methods("DELETE")
	whitelistRoutes.HandleFunc("/domains", whitelistHandler.GetAllowedDomainsHandler).Methods("GET")
	whitelistRoutes.HandleFunc("/domains", whitelistHandler.AddAllowedDomainHandler).Methods("POST")
	whitelistRoutes.HandleFunc("/domains/{domain}", whitelistHandler.RemoveAllowedDomainHandler).Methods("DELETE")
	whitelistRoutes.HandleFunc("/denied", whitelistHandler.GetDeniedEmailsHandler).Methods("GET")
	whitelistRoutes.HandleFunc("/denied", whitelistHandler.AddDeniedEmailHandler).Methods("POST")
	whitelistRoutes.HandleFunc("/denied/{email}", whitelistHandler.RemoveDeniedEmailHandler).Methods("DELETE")

	// Integration Settings routes
	settingsHandler := handlers.NewSettingsHandler()

	// Public route for checking if Asana is configured (all authenticated users)
	integrationStatusRoutes := api.PathPrefix("/settings/integrations").Subrouter()
	integrationStatusRoutes.Use(middleware.AuthMiddleware)
	integrationStatusRoutes.HandleFunc("/asana/status", settingsHandler.GetAsanaConfigStatus).Methods("GET")

	// Admin-only routes for managing Asana settings
	integrationSettingsRoutes := api.PathPrefix("/settings/integrations").Subrouter()
	integrationSettingsRoutes.Use(middleware.AuthMiddleware)
	integrationSettingsRoutes.Use(middleware.AdminOnly)
	integrationSettingsRoutes.HandleFunc("/asana", settingsHandler.GetAsanaSettings).Methods("GET")
	integrationSettingsRoutes.HandleFunc("/asana", settingsHandler.UpdateAsanaSettings).Methods("PUT")
	integrationSettingsRoutes.HandleFunc("/asana/test", settingsHandler.TestAsanaConnection).Methods("POST")
	integrationSettingsRoutes.HandleFunc("/asana/projects", settingsHandler.GetAsanaProjects).Methods("GET")

	// Per-user YouTrack integration routes (any authenticated user)
	ytIntegrationRoutes := api.PathPrefix("/settings/integrations").Subrouter()
	ytIntegrationRoutes.Use(middleware.AuthMiddleware)
	ytIntegrationRoutes.HandleFunc("/youtrack", settingsHandler.GetYouTrackIntegration).Methods("GET")
	ytIntegrationRoutes.HandleFunc("/youtrack", settingsHandler.SaveYouTrackIntegration).Methods("PUT")
	ytIntegrationRoutes.HandleFunc("/youtrack/disconnect", settingsHandler.DisconnectYouTrackIntegration).Methods("POST")

	// Per-user theme preference routes (any authenticated user)
	userThemeRoutes := api.PathPrefix("/settings/theme").Subrouter()
	userThemeRoutes.Use(middleware.AuthMiddleware)
	userThemeRoutes.HandleFunc("", settingsHandler.GetUserTheme).Methods("GET")
	userThemeRoutes.HandleFunc("", settingsHandler.SaveUserTheme).Methods("PUT")

	// Serve Vite SPA static files from ./public (production: built into the container image).
	// Any path not matched by /api routes falls through to here.
	// For client-side routes (non-asset paths), serve index.html so the React router takes over.
	publicDir := os.Getenv("PUBLIC_DIR")
	if publicDir == "" {
		publicDir = "./public"
	}
	fs := http.FileServer(http.Dir(publicDir))
	r.PathPrefix("/").HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		fullPath := filepath.Join(publicDir, filepath.Clean("/"+req.URL.Path))
		if _, err := os.Stat(fullPath); err == nil && fullPath != publicDir {
			fs.ServeHTTP(w, req)
			return
		}
		http.ServeFile(w, req, filepath.Join(publicDir, "index.html"))
	})

	// CORS configuration
	frontendURL := os.Getenv("FRONTEND_URL")
	allowedOrigins := []string{"http://localhost:5173", "http://localhost:3000"}
	if frontendURL != "" {
		allowedOrigins = append(allowedOrigins, frontendURL)
	}
	c := cors.New(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	})

	handler := c.Handler(r)

	// Get port from environment or default to 8080
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// 30-day rolling cleanup: runs daily, deletes notifications + activity older than 30 days
	go func() {
		notifRepo := database.NewNotificationRepository()
		activityRepo := database.NewActivityRepository()
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			ctx := context.Background()
			if n, err := notifRepo.DeleteOld(ctx, 30); err != nil {
				log.Printf("⚠️  Notification cleanup error: %v", err)
			} else if n > 0 {
				log.Printf("🗑️  Cleaned up %d notifications older than 30 days", n)
			}
			if n, err := activityRepo.DeleteOld(ctx, 30); err != nil {
				log.Printf("⚠️  Activity log cleanup error: %v", err)
			} else if n > 0 {
				log.Printf("🗑️  Cleaned up %d activity entries older than 30 days", n)
			}
		}
	}()

	log.Printf("🚀 Velocity API server starting on port %s", port)
	log.Printf("📍 Health check: http://localhost:%s/api/health", port)

	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal("Server failed to start:", err)
	}
}

// Health check handler
func healthHandler(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Velocity API is running",
		Data: map[string]string{
			"version": "1.0.0",
			"status":  "healthy",
		},
	})
}

// NOTE: Task handlers moved to internal/handlers/tasks.go

// NOTE: Asana handlers moved to internal/handlers/asana.go
// NOTE: Slack handlers moved to internal/handlers/slack.go
// NOTE: AI handlers moved to internal/handlers/ai.go

// Calendar handlers

func calendarHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)

	// Return task summary per day for the month
	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"year":  vars["year"],
			"month": vars["month"],
			"days": map[string]interface{}{
				"1":  map[string]string{"status": "green", "count": "3"},
				"2":  map[string]string{"status": "yellow", "count": "2"},
				"15": map[string]string{"status": "red", "count": "1"},
			},
		},
	})
}

// (Notification handlers moved to handlers/notification.go)
// (Report handlers moved to handlers/report.go)

// User management handlers

func getUsersHandler(w http.ResponseWriter, r *http.Request) {
	users := []map[string]interface{}{
		{"id": "1", "email": "admin@apyhub.com", "name": "Admin", "role": models.RoleAdmin},
		{"id": "2", "email": "pm@apyhub.com", "name": "Project Manager", "role": models.RoleProjectManager},
		{"id": "3", "email": "dev@apyhub.com", "name": "Developer", "role": models.RoleMember},
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    users,
	})
}

func inviteUserHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string      `json:"email"`
		Role  models.Role `json:"role"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Invitation sent to " + body.Email,
	})
}

func updateUserRoleHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	var body struct {
		Role models.Role `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Role == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "role is required"})
		return
	}

	userID := vars["id"]
	if database.GetPool() != nil {
		repo := database.NewUserRepository()
		if err := repo.UpdateRole(r.Context(), userID, body.Role); err != nil {
			sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: "failed to update role: " + err.Error()})
			return
		}
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "User " + userID + " role updated to " + string(body.Role),
	})
}

func deleteUserHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "User " + vars["id"] + " removed",
	})
}

// Helper function to send JSON response
func sendJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
