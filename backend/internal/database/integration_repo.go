package database

import (
	"context"
	"time"

	"github.com/dhindsa/project-management/internal/models"
)

// IntegrationRepository handles integration database operations
type IntegrationRepository struct{}

// NewIntegrationRepository creates a new IntegrationRepository
func NewIntegrationRepository() *IntegrationRepository {
	return &IntegrationRepository{}
}

// --- Asana Integration ---

// SaveAsanaIntegration saves or updates an Asana integration
func (r *IntegrationRepository) SaveAsanaIntegration(ctx context.Context, integration *models.AsanaIntegration) error {
	pool := GetPool()

	integration.UpdatedAt = time.Now()
	if integration.CreatedAt.IsZero() {
		integration.CreatedAt = time.Now()
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO asana_integrations (user_id, access_token, refresh_token, workspace_id, workspace_name, project_gid, connected, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (user_id) DO UPDATE SET
			access_token = $2,
			refresh_token = $3,
			workspace_id = $4,
			workspace_name = $5,
			project_gid = $6,
			connected = $7,
			updated_at = $9
	`, integration.UserID, integration.AccessToken, integration.RefreshToken,
		integration.WorkspaceID, integration.WorkspaceName, integration.ProjectID,
		integration.Connected, integration.CreatedAt, integration.UpdatedAt)

	return err
}

// GetAsanaIntegration retrieves an Asana integration by user ID
func (r *IntegrationRepository) GetAsanaIntegration(ctx context.Context, userID string) (*models.AsanaIntegration, error) {
	pool := GetPool()

	var integration models.AsanaIntegration
	err := pool.QueryRow(ctx, `
		SELECT id, user_id, access_token, refresh_token, workspace_id, workspace_name, COALESCE(project_gid, ''), connected, last_sync_at, created_at, updated_at
		FROM asana_integrations WHERE user_id = $1
	`, userID).Scan(&integration.ID, &integration.UserID, &integration.AccessToken, &integration.RefreshToken,
		&integration.WorkspaceID, &integration.WorkspaceName, &integration.ProjectID,
		&integration.Connected, &integration.LastSyncAt, &integration.CreatedAt, &integration.UpdatedAt)

	if err != nil {
		return nil, err
	}
	return &integration, nil
}

// UpdateAsanaProjectGID saves the user's selected Asana project GID
func (r *IntegrationRepository) UpdateAsanaProjectGID(ctx context.Context, userID, projectGID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `
		UPDATE asana_integrations SET project_gid = $2, updated_at = NOW()
		WHERE user_id = $1
	`, userID, projectGID)
	return err
}

// UpdateAsanaLastSync updates the last sync timestamp
func (r *IntegrationRepository) UpdateAsanaLastSync(ctx context.Context, userID string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE asana_integrations SET last_sync_at = NOW(), updated_at = NOW()
		WHERE user_id = $1
	`, userID)

	return err
}

// GetAdminAsanaIntegration returns the Asana integration belonging to the default admin user.
// Used as a fallback so that member-role users can read Asana data via the admin's credentials.
func (r *IntegrationRepository) GetAdminAsanaIntegration(ctx context.Context) (*models.AsanaIntegration, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	var adminUserID string
	err := pool.QueryRow(ctx, `SELECT id FROM users WHERE email = $1`, models.DefaultAdminEmail).Scan(&adminUserID)
	if err != nil {
		return nil, nil
	}
	return r.GetAsanaIntegration(ctx, adminUserID)
}

// DisconnectAsana marks an Asana integration as disconnected
func (r *IntegrationRepository) DisconnectAsana(ctx context.Context, userID string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE asana_integrations SET connected = false, updated_at = NOW()
		WHERE user_id = $1
	`, userID)

	return err
}

// DeleteAsanaIntegration removes an Asana integration
func (r *IntegrationRepository) DeleteAsanaIntegration(ctx context.Context, userID string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `DELETE FROM asana_integrations WHERE user_id = $1`, userID)
	return err
}

// --- Slack Integration ---

// SaveSlackIntegration saves or updates a Slack integration
func (r *IntegrationRepository) SaveSlackIntegration(ctx context.Context, integration *models.SlackIntegration) error {
	pool := GetPool()

	integration.UpdatedAt = time.Now()
	if integration.CreatedAt.IsZero() {
		integration.CreatedAt = time.Now()
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO slack_integrations (user_id, bot_token, team_id, team_name, channel_id, channel_name, connected, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (user_id) DO UPDATE SET
			bot_token = $2,
			team_id = $3,
			team_name = $4,
			channel_id = $5,
			channel_name = $6,
			connected = $7,
			updated_at = $9
	`, integration.UserID, integration.BotToken, integration.TeamID,
		integration.TeamName, integration.ChannelID, integration.ChannelName,
		integration.Connected, integration.CreatedAt, integration.UpdatedAt)

	return err
}

// GetSlackIntegration retrieves a Slack integration by user ID
func (r *IntegrationRepository) GetSlackIntegration(ctx context.Context, userID string) (*models.SlackIntegration, error) {
	pool := GetPool()

	var integration models.SlackIntegration
	err := pool.QueryRow(ctx, `
		SELECT id, user_id, bot_token, team_id, team_name, channel_id, channel_name,
		       monitor_channel_id, monitor_channel_name, connected, created_at, updated_at
		FROM slack_integrations WHERE user_id = $1
	`, userID).Scan(&integration.ID, &integration.UserID, &integration.BotToken, &integration.TeamID,
		&integration.TeamName, &integration.ChannelID, &integration.ChannelName,
		&integration.MonitorChannelID, &integration.MonitorChannelName,
		&integration.Connected, &integration.CreatedAt, &integration.UpdatedAt)

	if err != nil {
		return nil, err
	}
	return &integration, nil
}

// GetSlackIntegrationByTeamID returns any one connected Slack integration for a
// workspace (team_id). Velocity's Slack integration is stored per-Velocity-user,
// but everyone in the same workspace pastes the same bot token, so any connected
// row is usable as "the" bot credential for workspace-wide inbound events (e.g.
// the Slack Events webhook), which arrive with a team_id but no Velocity user
// context of their own.
func (r *IntegrationRepository) GetSlackIntegrationByTeamID(ctx context.Context, teamID string) (*models.SlackIntegration, error) {
	pool := GetPool()

	var integration models.SlackIntegration
	err := pool.QueryRow(ctx, `
		SELECT id, user_id, bot_token, team_id, team_name, channel_id, channel_name,
		       monitor_channel_id, monitor_channel_name, connected, created_at, updated_at
		FROM slack_integrations WHERE team_id = $1 AND connected = true
		ORDER BY updated_at DESC LIMIT 1
	`, teamID).Scan(&integration.ID, &integration.UserID, &integration.BotToken, &integration.TeamID,
		&integration.TeamName, &integration.ChannelID, &integration.ChannelName,
		&integration.MonitorChannelID, &integration.MonitorChannelName,
		&integration.Connected, &integration.CreatedAt, &integration.UpdatedAt)

	if err != nil {
		return nil, err
	}
	return &integration, nil
}

// UpdateSlackMonitorChannel updates the monitoring channel (for @mention scanning)
func (r *IntegrationRepository) UpdateSlackMonitorChannel(ctx context.Context, userID, channelID, channelName string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE slack_integrations SET monitor_channel_id = $2, monitor_channel_name = $3, updated_at = NOW()
		WHERE user_id = $1
	`, userID, channelID, channelName)

	return err
}

// UpdateSlackChannel updates the monitored channel
func (r *IntegrationRepository) UpdateSlackChannel(ctx context.Context, userID, channelID, channelName string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE slack_integrations SET channel_id = $2, channel_name = $3, updated_at = NOW()
		WHERE user_id = $1
	`, userID, channelID, channelName)

	return err
}

// DisconnectSlack marks a Slack integration as disconnected
func (r *IntegrationRepository) DisconnectSlack(ctx context.Context, userID string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE slack_integrations SET connected = false, updated_at = NOW()
		WHERE user_id = $1
	`, userID)

	return err
}

// DeleteSlackIntegration removes a Slack integration
func (r *IntegrationRepository) DeleteSlackIntegration(ctx context.Context, userID string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `DELETE FROM slack_integrations WHERE user_id = $1`, userID)
	return err
}

// --- Slack Messages ---

// SaveSlackMessage saves a Slack message
func (r *IntegrationRepository) SaveSlackMessage(ctx context.Context, msg *models.SlackMessage) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		INSERT INTO slack_messages (id, channel_id, user_id, user_name, text, timestamp, thread_ts, fetched_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
		ON CONFLICT (id) DO UPDATE SET text = $5, fetched_at = NOW()
	`, msg.ID, msg.ChannelID, msg.UserID, msg.UserName, msg.Text, msg.Timestamp, msg.ThreadTS)

	return err
}

// GetSlackMessages retrieves messages from a channel within a time range
func (r *IntegrationRepository) GetSlackMessages(ctx context.Context, channelID string, from, to time.Time) ([]*models.SlackMessage, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, channel_id, user_id, user_name, text, timestamp, thread_ts, fetched_at
		FROM slack_messages
		WHERE channel_id = $1 AND timestamp BETWEEN $2 AND $3
		ORDER BY timestamp ASC
	`, channelID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []*models.SlackMessage
	for rows.Next() {
		var msg models.SlackMessage
		err := rows.Scan(&msg.ID, &msg.ChannelID, &msg.UserID, &msg.UserName,
			&msg.Text, &msg.Timestamp, &msg.ThreadTS, &msg.FetchedAt)
		if err != nil {
			return nil, err
		}
		messages = append(messages, &msg)
	}

	return messages, nil
}

// --- Analysis Results ---

// SaveAnalysisResult saves a Slack analysis result
func (r *IntegrationRepository) SaveAnalysisResult(ctx context.Context, result *models.SlackAnalysisResult) error {
	pool := GetPool()

	return pool.QueryRow(ctx, `
		INSERT INTO slack_analysis_results (task_id, task_title, slack_status, asana_status, confidence, message_ids, discrepancy, analyzed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
		RETURNING id
	`, result.TaskID, result.TaskTitle, result.SlackStatus, result.AsanaStatus,
		result.Confidence, result.MessageIDs, result.Discrepancy).Scan(&result.ID)
}

// GetAnalysisResults retrieves analysis results for a date range
func (r *IntegrationRepository) GetAnalysisResults(ctx context.Context, from, to time.Time) ([]*models.SlackAnalysisResult, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, task_id, task_title, slack_status, asana_status, confidence, message_ids, discrepancy, analyzed_at
		FROM slack_analysis_results
		WHERE analyzed_at BETWEEN $1 AND $2
		ORDER BY analyzed_at DESC
	`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []*models.SlackAnalysisResult
	for rows.Next() {
		var result models.SlackAnalysisResult
		err := rows.Scan(&result.ID, &result.TaskID, &result.TaskTitle, &result.SlackStatus,
			&result.AsanaStatus, &result.Confidence, &result.MessageIDs, &result.Discrepancy, &result.AnalyzedAt)
		if err != nil {
			return nil, err
		}
		results = append(results, &result)
	}

	return results, nil
}

// GetDiscrepancies retrieves tasks with status discrepancies
func (r *IntegrationRepository) GetDiscrepancies(ctx context.Context) ([]*models.SlackAnalysisResult, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, task_id, task_title, slack_status, asana_status, confidence, message_ids, discrepancy, analyzed_at
		FROM slack_analysis_results
		WHERE discrepancy = true
		ORDER BY analyzed_at DESC
		LIMIT 100
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []*models.SlackAnalysisResult
	for rows.Next() {
		var result models.SlackAnalysisResult
		err := rows.Scan(&result.ID, &result.TaskID, &result.TaskTitle, &result.SlackStatus,
			&result.AsanaStatus, &result.Confidence, &result.MessageIDs, &result.Discrepancy, &result.AnalyzedAt)
		if err != nil {
			return nil, err
		}
		results = append(results, &result)
	}

	return results, nil
}

// --- Sync Logs ---

// CreateSyncLog creates a new sync log entry
func (r *IntegrationRepository) CreateSyncLog(ctx context.Context, log *models.SyncLog) error {
	pool := GetPool()

	return pool.QueryRow(ctx, `
		INSERT INTO sync_logs (type, direction, status, triggered_by, started_at)
		VALUES ($1, $2, $3, $4, NOW())
		RETURNING id
	`, log.Type, log.Direction, log.Status, log.TriggeredBy).Scan(&log.ID)
}

// UpdateSyncLog updates a sync log entry
func (r *IntegrationRepository) UpdateSyncLog(ctx context.Context, log *models.SyncLog) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE sync_logs SET
			status = $2,
			tasks_synced = $3,
			errors = $4,
			completed_at = NOW()
		WHERE id = $1
	`, log.ID, log.Status, log.TasksSynced, log.Errors)

	return err
}

// GetSyncLogs retrieves recent sync logs
func (r *IntegrationRepository) GetSyncLogs(ctx context.Context, limit int) ([]*models.SyncLog, error) {
	pool := GetPool()

	if limit <= 0 {
		limit = 50
	}

	rows, err := pool.Query(ctx, `
		SELECT id, type, direction, status, tasks_synced, errors, started_at, completed_at, triggered_by
		FROM sync_logs
		ORDER BY started_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []*models.SyncLog
	for rows.Next() {
		var log models.SyncLog
		err := rows.Scan(&log.ID, &log.Type, &log.Direction, &log.Status,
			&log.TasksSynced, &log.Errors, &log.StartedAt, &log.CompletedAt, &log.TriggeredBy)
		if err != nil {
			return nil, err
		}
		logs = append(logs, &log)
	}

	return logs, nil
}
