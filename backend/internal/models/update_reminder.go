package models

import "time"

type UpdateReminderDetectionMode string

const (
	DetectionModeAny            UpdateReminderDetectionMode = "any_message"
	DetectionModeKeywords       UpdateReminderDetectionMode = "keywords"
	DetectionModePattern        UpdateReminderDetectionMode = "pattern"
	DetectionModeMentionMissing UpdateReminderDetectionMode = "mention_missing" // @mentions in window = missing; everyone else = posted
)

type UpdateReminderLeaveAction string

const (
	LeaveActionExclude        UpdateReminderLeaveAction = "exclude"
	LeaveActionListSeparately UpdateReminderLeaveAction = "list_separately"
)

type UpdateReminderTriggeredBy string

const (
	TriggeredByScheduler UpdateReminderTriggeredBy = "scheduler"
	TriggeredByManual    UpdateReminderTriggeredBy = "manual"
	TriggeredByDryRun    UpdateReminderTriggeredBy = "dry_run"
)

// ChannelRef is a lightweight {id, name} pair stored as JSONB
type ChannelRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SnapshotMember is one team member entry inside a snapshot
type SnapshotMember struct {
	SlackUserID string `json:"slack_user_id"`
	DisplayName string `json:"display_name"`
}

// UpdateReminderSnapshot is the computed result of one check pass
type UpdateReminderSnapshot struct {
	Posted     []SnapshotMember `json:"posted"`
	Missing    []SnapshotMember `json:"missing"`
	OnLeave    []SnapshotMember `json:"on_leave"`
	ComputedAt time.Time        `json:"computed_at"`
}

// SnapshotDiff describes what changed between two snapshots
type SnapshotDiff struct {
	NowPosted   []SnapshotMember `json:"now_posted"`   // were missing, now posted
	NowMissing  []SnapshotMember `json:"now_missing"`  // were posted, now missing
	NowOnLeave  []SnapshotMember `json:"now_on_leave"` // newly on leave
	HasChanges  bool             `json:"has_changes"`
}

// UpdateReminderRule is one configured reminder rule per user
type UpdateReminderRule struct {
	ID   string `json:"id"`
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	Enabled bool  `json:"enabled"`

	// Schedule
	ScheduleTime string `json:"schedule_time"` // HH:MM
	ScheduleDays []int  `json:"schedule_days"` // 0=Sun … 6=Sat
	Timezone     string `json:"timezone"`

	// Source channels + detection
	SourceChannelIDs []ChannelRef                `json:"source_channel_ids"`
	DetectionMode    UpdateReminderDetectionMode `json:"detection_mode"`
	DetectionValue   string                      `json:"detection_value"` // keywords CSV or regex

	// Check window
	CheckDayOffset          int    `json:"check_day_offset"`              // day for window start (0=today, -1=yesterday)
	CheckWindowStart        string `json:"check_window_start"`            // HH:MM
	CheckWindowEndDayOffset int    `json:"check_window_end_day_offset"`   // day for window end (0=today, default; can be same or later than start day)
	CheckWindowEnd          string `json:"check_window_end"`              // HH:MM

	// Leave handling
	LeaveChannelID   string                    `json:"leave_channel_id"`
	LeaveChannelName string                    `json:"leave_channel_name"`
	LeaveKeywords    []string                  `json:"leave_keywords"`
	LeaveAction      UpdateReminderLeaveAction `json:"leave_action"`

	// Delivery
	DeliveryChannel     bool   `json:"delivery_channel"`
	DeliveryDM          bool   `json:"delivery_dm"`
	DeliveryChannelID   string `json:"delivery_channel_id"`
	DeliveryChannelName string `json:"delivery_channel_name"`

	// Templates
	ChannelTemplate string `json:"channel_template"`
	DMTemplate      string `json:"dm_template"`

	// Last computed snapshot
	LastSnapshot   *UpdateReminderSnapshot `json:"last_snapshot,omitempty"`
	LastSnapshotAt *time.Time              `json:"last_snapshot_at,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// UpdateReminderRosterMember is one team member in a rule's roster
type UpdateReminderRosterMember struct {
	ID          string    `json:"id"`
	RuleID      string    `json:"rule_id"`
	DisplayName string    `json:"display_name"`
	SlackUserID string    `json:"slack_user_id"`
	Enabled     bool      `json:"enabled"`
	CreatedAt   time.Time `json:"created_at"`
}

// UpdateReminderRun is one execution log entry (scheduled or manual)
type UpdateReminderRun struct {
	ID           string                    `json:"id"`
	RuleID       string                    `json:"rule_id"`
	UserID       string                    `json:"user_id"`
	TriggeredBy  UpdateReminderTriggeredBy `json:"triggered_by"`
	RanAt        time.Time                 `json:"ran_at"`
	PostedNames  []string                  `json:"posted_names"`
	OnLeaveNames []string                  `json:"on_leave_names"`
	SkippedNames []string                  `json:"skipped_names"`
	DeliveredTo  []string                  `json:"delivered_to"`
	Error        *string                   `json:"error,omitempty"`
	SnapshotUsed *UpdateReminderSnapshot   `json:"snapshot_used,omitempty"`
	ExpiresAt    time.Time                 `json:"expires_at"`
}

// CreateUpdateReminderRuleRequest is the create/update body for a rule
type CreateUpdateReminderRuleRequest struct {
	Name             string                      `json:"name"`
	Enabled          bool                        `json:"enabled"`
	ScheduleTime     string                      `json:"schedule_time"`
	ScheduleDays     []int                       `json:"schedule_days"`
	Timezone         string                      `json:"timezone"`
	SourceChannelIDs []ChannelRef                `json:"source_channel_ids"`
	DetectionMode    UpdateReminderDetectionMode `json:"detection_mode"`
	DetectionValue   string                      `json:"detection_value"`
	CheckDayOffset          int                         `json:"check_day_offset"`
	CheckWindowStart        string                      `json:"check_window_start"`
	CheckWindowEndDayOffset int                         `json:"check_window_end_day_offset"`
	CheckWindowEnd          string                      `json:"check_window_end"`
	LeaveChannelID   string                      `json:"leave_channel_id"`
	LeaveChannelName string                      `json:"leave_channel_name"`
	LeaveKeywords    []string                    `json:"leave_keywords"`
	LeaveAction      UpdateReminderLeaveAction   `json:"leave_action"`
	DeliveryChannel     bool                     `json:"delivery_channel"`
	DeliveryDM          bool                     `json:"delivery_dm"`
	DeliveryChannelID   string                   `json:"delivery_channel_id"`
	DeliveryChannelName string                   `json:"delivery_channel_name"`
	ChannelTemplate  string                      `json:"channel_template"`
	DMTemplate       string                      `json:"dm_template"`
}

// AddRosterMemberRequest is the body for adding a roster member
type AddRosterMemberRequest struct {
	DisplayName string `json:"display_name"`
	SlackUserID string `json:"slack_user_id"`
	Enabled     bool   `json:"enabled"`
}

// UpdateRosterMemberRequest patches display_name and/or enabled on a member
type UpdateRosterMemberRequest struct {
	DisplayName *string `json:"display_name,omitempty"`
	Enabled     *bool   `json:"enabled,omitempty"`
}

// QuickSendRequest is the body for the one-off quick-send endpoint
type QuickSendRequest struct {
	ChannelID  string `json:"channel_id"`
	Message    string `json:"message"`
	DmUserID   string `json:"dm_user_id,omitempty"` // if set, send as DM instead of channel
}
