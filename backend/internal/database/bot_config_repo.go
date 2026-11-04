package database

import (
	"context"
	"time"

	"github.com/dhindsa/project-management/internal/models"
)

// BotConfigRepository handles bot configuration database operations
type BotConfigRepository struct{}

// NewBotConfigRepository creates a new BotConfigRepository
func NewBotConfigRepository() *BotConfigRepository {
	return &BotConfigRepository{}
}

// List returns all bot configurations
func (r *BotConfigRepository) List(ctx context.Context) ([]*models.BotConfig, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, name, description, bot_type, prompt, variables, is_active, created_by, created_at, updated_at
		FROM bot_configs
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var configs []*models.BotConfig
	for rows.Next() {
		var c models.BotConfig
		err := rows.Scan(&c.ID, &c.Name, &c.Description, &c.BotType, &c.Prompt,
			&c.Variables, &c.IsActive, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt)
		if err != nil {
			return nil, err
		}
		configs = append(configs, &c)
	}

	return configs, nil
}

// GetByID retrieves a bot config by ID
func (r *BotConfigRepository) GetByID(ctx context.Context, id string) (*models.BotConfig, error) {
	pool := GetPool()

	var c models.BotConfig
	err := pool.QueryRow(ctx, `
		SELECT id, name, description, bot_type, prompt, variables, is_active, created_by, created_at, updated_at
		FROM bot_configs WHERE id = $1
	`, id).Scan(&c.ID, &c.Name, &c.Description, &c.BotType, &c.Prompt,
		&c.Variables, &c.IsActive, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt)

	if err != nil {
		return nil, err
	}
	return &c, nil
}

// GetByType retrieves bot configs by type
func (r *BotConfigRepository) GetByType(ctx context.Context, botType models.BotType) ([]*models.BotConfig, error) {
	pool := GetPool()

	rows, err := pool.Query(ctx, `
		SELECT id, name, description, bot_type, prompt, variables, is_active, created_by, created_at, updated_at
		FROM bot_configs WHERE bot_type = $1
		ORDER BY created_at ASC
	`, botType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var configs []*models.BotConfig
	for rows.Next() {
		var c models.BotConfig
		err := rows.Scan(&c.ID, &c.Name, &c.Description, &c.BotType, &c.Prompt,
			&c.Variables, &c.IsActive, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt)
		if err != nil {
			return nil, err
		}
		configs = append(configs, &c)
	}

	return configs, nil
}

// Create creates a new bot config
func (r *BotConfigRepository) Create(ctx context.Context, config *models.BotConfig) error {
	pool := GetPool()

	config.CreatedAt = time.Now()
	config.UpdatedAt = time.Now()

	err := pool.QueryRow(ctx, `
		INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id
	`, config.Name, config.Description, config.BotType, config.Prompt,
		config.Variables, config.IsActive, config.CreatedBy,
		config.CreatedAt, config.UpdatedAt).Scan(&config.ID)

	return err
}

// EnsureSystemBot makes sure a system-managed bot exists. c.CreatedBy is its fixed key, so an
// admin can rename the bot freely. A row seeded before keys existed is adopted by name, and a
// prompt still equal to previousPrompt (never edited) is upgraded. Edited prompts are left alone.
func (r *BotConfigRepository) EnsureSystemBot(ctx context.Context, c *models.BotConfig, previousPrompt string) error {
	pool := GetPool()
	if _, err := pool.Exec(ctx, `
		UPDATE bot_configs SET created_by = $1
		WHERE bot_type = $2 AND name = $3 AND created_by = 'system'
		  AND NOT EXISTS (SELECT 1 FROM bot_configs WHERE created_by = $1)
	`, c.CreatedBy, c.BotType, c.Name); err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT DO NOTHING
	`, c.Name, c.Description, c.BotType, c.Prompt, c.Variables, c.IsActive, c.CreatedBy); err != nil {
		return err
	}
	_, err := pool.Exec(ctx, `UPDATE bot_configs SET prompt = $2, updated_at = NOW() WHERE created_by = $1 AND prompt = $3`,
		c.CreatedBy, c.Prompt, previousPrompt)
	return err
}

// Update updates an existing bot config
func (r *BotConfigRepository) Update(ctx context.Context, config *models.BotConfig) error {
	pool := GetPool()

	config.UpdatedAt = time.Now()

	_, err := pool.Exec(ctx, `
		UPDATE bot_configs
		SET name = $2, description = $3, prompt = $4, variables = $5, is_active = $6, updated_at = $7
		WHERE id = $1
	`, config.ID, config.Name, config.Description, config.Prompt,
		config.Variables, config.IsActive, config.UpdatedAt)

	return err
}

// Delete deletes a bot config
func (r *BotConfigRepository) Delete(ctx context.Context, id string) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `DELETE FROM bot_configs WHERE id = $1`, id)
	return err
}

// ToggleActive toggles the active status of a bot config
func (r *BotConfigRepository) ToggleActive(ctx context.Context, id string, active bool) error {
	pool := GetPool()

	_, err := pool.Exec(ctx, `
		UPDATE bot_configs SET is_active = $2, updated_at = NOW() WHERE id = $1
	`, id, active)

	return err
}
