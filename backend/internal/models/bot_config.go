package models

import "time"

// BotType represents the type of bot
type BotType string

const (
	BotTypeSlackAnalysis    BotType = "slack_analysis"
	BotTypeDailyReport      BotType = "daily_report"
	BotTypeCustom           BotType = "custom"
	BotTypePMAssistant      BotType = "pm_assistant"
	BotTypeStageReport      BotType = "stage_report"
	BotTypeDeploymentReport BotType = "deployment_report"
	BotTypeTicketParser     BotType = "ticket_parser"
)

// BotConfig represents a configurable bot
type BotConfig struct {
	ID          string    `json:"id" db:"id"`
	Name        string    `json:"name" db:"name"`
	Description string    `json:"description" db:"description"`
	BotType     BotType   `json:"bot_type" db:"bot_type"`
	Prompt      string    `json:"prompt" db:"prompt"`
	Variables   string    `json:"variables" db:"variables"` // JSON string of variable definitions
	IsActive    bool      `json:"is_active" db:"is_active"`
	CreatedBy   string    `json:"created_by" db:"created_by"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time `json:"updated_at" db:"updated_at"`
}

// BotVariable represents a configurable variable in a bot prompt
type BotVariable struct {
	Name        string `json:"name"`         // e.g., "TOPIC", "jobrole"
	Label       string `json:"label"`        // Display label
	Type        string `json:"type"`         // "text", "select", "date", "team_member"
	Default     string `json:"default"`      // Default value
	Options     []string `json:"options,omitempty"` // For select type
	Required    bool   `json:"required"`
	Description string `json:"description,omitempty"`
}

// BotTemplate represents a predefined bot template
type BotTemplate struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	BotType     BotType       `json:"bot_type"`
	Prompt      string        `json:"prompt"`
	Variables   []BotVariable `json:"variables"`
}

// CreateBotConfigRequest represents the request to create a bot config
type CreateBotConfigRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	BotType     BotType `json:"bot_type"`
	Prompt      string `json:"prompt"`
	Variables   string `json:"variables"` // JSON string
}

// UpdateBotConfigRequest represents the request to update a bot config
type UpdateBotConfigRequest struct {
	Name        *string  `json:"name,omitempty"`
	Description *string  `json:"description,omitempty"`
	Prompt      *string  `json:"prompt,omitempty"`
	Variables   *string  `json:"variables,omitempty"`
	IsActive    *bool    `json:"is_active,omitempty"`
}
