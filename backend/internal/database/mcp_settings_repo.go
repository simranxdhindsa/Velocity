package database

import "context"

// MCPSettingsRepository holds per-user MCP preferences (default send time/tz).
// Split out from MCPTokenRepository because these are per-user, not per-client
// — a user can have several connected MCP clients (Claude, Codex, ...) sharing
// one set of preferences.
type MCPSettingsRepository struct{}

func NewMCPSettingsRepository() *MCPSettingsRepository {
	return &MCPSettingsRepository{}
}

// GetDefaultSendSettings returns the user's default send time (HH:MM) and IANA timezone.
func (r *MCPSettingsRepository) GetDefaultSendSettings(ctx context.Context, userID string) (hhmm, tz string) {
	pool := GetPool()
	if pool == nil {
		return "10:00", "UTC"
	}
	if err := pool.QueryRow(ctx, `
		SELECT default_send_time, default_send_timezone FROM user_mcp_settings WHERE user_id = $1
	`, userID).Scan(&hhmm, &tz); err != nil || hhmm == "" {
		return "10:00", "UTC"
	}
	if tz == "" {
		tz = "UTC"
	}
	return hhmm, tz
}

// UpdateDefaultSendSettings persists the user's preferred send time and timezone.
func (r *MCPSettingsRepository) UpdateDefaultSendSettings(ctx context.Context, userID, hhmm, tz string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	if tz == "" {
		tz = "UTC"
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO user_mcp_settings (user_id, default_send_time, default_send_timezone)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE
			SET default_send_time = EXCLUDED.default_send_time,
			    default_send_timezone = EXCLUDED.default_send_timezone
	`, userID, hhmm, tz)
	return err
}
