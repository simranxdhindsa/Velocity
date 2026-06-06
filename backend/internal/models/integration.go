package models

import "time"

// AsanaIntegration represents the Asana connection for a user/organization
type AsanaIntegration struct {
	ID           string    `json:"id" db:"id"`
	UserID       string    `json:"user_id" db:"user_id"`
	AccessToken  string    `json:"-" db:"access_token"` // Hidden in JSON
	RefreshToken *string   `json:"-" db:"refresh_token"`
	WorkspaceID   string    `json:"workspace_id" db:"workspace_id"`
	WorkspaceName string    `json:"workspace_name" db:"workspace_name"`
	ProjectID     string    `json:"project_gid" db:"project_gid"`
	Connected     bool      `json:"connected" db:"connected"`
	LastSyncAt   *time.Time `json:"last_sync_at,omitempty" db:"last_sync_at"`
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time `json:"updated_at" db:"updated_at"`
}

// AsanaProject represents a synced Asana project
type AsanaProject struct {
	ID        string    `json:"id" db:"id"`
	AsanaID   string    `json:"asana_id" db:"asana_id"`
	ProjectID string    `json:"project_id" db:"project_id"` // Local project ID
	Name      string    `json:"name" db:"name"`
	SyncEnabled bool    `json:"sync_enabled" db:"sync_enabled"`
	LastSyncAt *time.Time `json:"last_sync_at,omitempty" db:"last_sync_at"`
}

// SlackIntegration represents the Slack connection
type SlackIntegration struct {
	ID                 string    `json:"id" db:"id"`
	UserID             string    `json:"user_id" db:"user_id"`
	BotToken           string    `json:"-" db:"bot_token"` // Hidden in JSON
	TeamID             string    `json:"team_id" db:"team_id"`
	TeamName           string    `json:"team_name" db:"team_name"`
	ChannelID          *string   `json:"channel_id,omitempty" db:"channel_id"`
	ChannelName        *string   `json:"channel_name,omitempty" db:"channel_name"`
	MonitorChannelID   *string   `json:"monitor_channel_id,omitempty" db:"monitor_channel_id"`
	MonitorChannelName *string   `json:"monitor_channel_name,omitempty" db:"monitor_channel_name"`
	Connected          bool      `json:"connected" db:"connected"`
	CreatedAt          time.Time `json:"created_at" db:"created_at"`
	UpdatedAt          time.Time `json:"updated_at" db:"updated_at"`
}

// SlackMention represents a message where the user was @mentioned
type SlackMention struct {
	ID              string     `json:"id" db:"id"`
	UserID          string     `json:"user_id" db:"user_id"`
	SlackUserID     string     `json:"slack_user_id" db:"slack_user_id"`
	MessageTS       string     `json:"message_ts" db:"message_ts"`
	ThreadTS        *string    `json:"thread_ts,omitempty" db:"thread_ts"`
	ChannelID       string     `json:"channel_id" db:"channel_id"`
	MessageText     string     `json:"message_text" db:"message_text"`
	SenderName      string     `json:"sender_name" db:"sender_name"`
	SenderAvatar    string     `json:"sender_avatar" db:"sender_avatar"`
	RequiresReply   bool       `json:"requires_reply" db:"requires_reply"`
	Replied         bool       `json:"replied" db:"replied"`
	ReplyCheckedAt  *time.Time `json:"reply_checked_at,omitempty" db:"reply_checked_at"`
	SnoozedUntil   *time.Time `json:"snoozed_until,omitempty" db:"snoozed_until"`
	Pinned         bool       `json:"pinned" db:"pinned"`
	CreatedAt       time.Time  `json:"created_at" db:"created_at"`
}

// SlackUserThread represents a thread the user started — track reply counts
type SlackUserThread struct {
	ID            string     `json:"id" db:"id"`
	UserID        string     `json:"user_id" db:"user_id"`
	ChannelID     string     `json:"channel_id" db:"channel_id"`
	ThreadTS      string     `json:"thread_ts" db:"thread_ts"`
	MessageText   string     `json:"message_text" db:"message_text"`
	ReplyCount    int        `json:"reply_count" db:"reply_count"`
	LastCheckedAt *time.Time `json:"last_checked_at,omitempty" db:"last_checked_at"`
	HasReply      bool       `json:"has_reply" db:"has_reply"`
	ReminderSent  bool       `json:"reminder_sent" db:"reminder_sent"`
	SnoozedUntil  *time.Time `json:"snoozed_until,omitempty" db:"snoozed_until"`
	CreatedAt     time.Time  `json:"created_at" db:"created_at"`
}

// SlackMessage represents a message fetched from Slack
type SlackMessage struct {
	ID        string    `json:"id" db:"id"`
	ChannelID string    `json:"channel_id" db:"channel_id"`
	UserID    string    `json:"user_id" db:"user_id"`
	UserName  string    `json:"user_name" db:"user_name"`
	Text      string    `json:"text" db:"text"`
	Timestamp time.Time `json:"timestamp" db:"timestamp"`
	ThreadTS  *string   `json:"thread_ts,omitempty" db:"thread_ts"`
	FetchedAt time.Time `json:"fetched_at" db:"fetched_at"`
}

// SlackAnalysisResult represents AI analysis of Slack messages
type SlackAnalysisResult struct {
	ID          string    `json:"id" db:"id"`
	TaskID      *string   `json:"task_id,omitempty" db:"task_id"`
	TaskTitle   string    `json:"task_title" db:"task_title"`
	SlackStatus string    `json:"slack_status" db:"slack_status"` // AI interpreted status
	AsanaStatus *string   `json:"asana_status,omitempty" db:"asana_status"`
	Confidence  float64   `json:"confidence" db:"confidence"`
	MessageIDs  []string  `json:"message_ids" db:"message_ids"`
	Discrepancy bool      `json:"discrepancy" db:"discrepancy"`
	AnalyzedAt  time.Time `json:"analyzed_at" db:"analyzed_at"`
}

// SyncLog represents a sync operation log
type SyncLog struct {
	ID          string     `json:"id" db:"id"`
	Type        string     `json:"type" db:"type"`           // "asana", "slack"
	Direction   string     `json:"direction" db:"direction"` // "push", "pull", "both"
	Status      string     `json:"status" db:"status"`       // "success", "failed", "partial"
	TasksSynced int        `json:"tasks_synced" db:"tasks_synced"`
	Errors      []string   `json:"errors,omitempty" db:"errors"`
	StartedAt   time.Time  `json:"started_at" db:"started_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty" db:"completed_at"`
	TriggeredBy string     `json:"triggered_by" db:"triggered_by"`
}

// ConnectAsanaRequest represents the request to connect Asana
type ConnectAsanaRequest struct {
	AccessToken string `json:"access_token" validate:"required"`
	WorkspaceID string `json:"workspace_id"`
}

// ConnectSlackRequest represents the request to connect Slack
type ConnectSlackRequest struct {
	BotToken  string `json:"bot_token" validate:"required"`
	ChannelID string `json:"channel_id"`
}
