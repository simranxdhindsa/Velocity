package database

import (
	"context"
	"time"
)

// DeveloperSubsystemConfig maps a YouTrack developer login to the subsystems they own.
type DeveloperSubsystemConfig struct {
	DeveloperLogin string    `json:"developer_login"`
	DeveloperName  string    `json:"developer_name"`
	Subsystems     []string  `json:"subsystems"`
	IsQA           bool      `json:"is_qa"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// DeveloperConfigRepository handles developer-subsystem config persistence.
type DeveloperConfigRepository struct{}

func NewDeveloperConfigRepository() *DeveloperConfigRepository {
	return &DeveloperConfigRepository{}
}

// GetAll returns every developer config row.
func (r *DeveloperConfigRepository) GetAll(ctx context.Context) ([]*DeveloperSubsystemConfig, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx, `
		SELECT developer_login, developer_name, subsystems, is_qa, updated_at
		FROM developer_subsystem_configs
		ORDER BY developer_name ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*DeveloperSubsystemConfig
	for rows.Next() {
		var c DeveloperSubsystemConfig
		if err := rows.Scan(&c.DeveloperLogin, &c.DeveloperName, &c.Subsystems, &c.IsQA, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, nil
}

// BulkSave upserts all provided configs in a single transaction.
// Rows not in the provided list are left untouched (partial updates are fine).
func (r *DeveloperConfigRepository) BulkSave(ctx context.Context, configs []*DeveloperSubsystemConfig) error {
	pool := GetPool()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, c := range configs {
		_, err := tx.Exec(ctx, `
			INSERT INTO developer_subsystem_configs (developer_login, developer_name, subsystems, is_qa, updated_at)
			VALUES ($1, $2, $3, $4, NOW())
			ON CONFLICT (developer_login) DO UPDATE
			SET developer_name = EXCLUDED.developer_name,
			    subsystems     = EXCLUDED.subsystems,
			    is_qa          = EXCLUDED.is_qa,
			    updated_at     = NOW()
		`, c.DeveloperLogin, c.DeveloperName, c.Subsystems, c.IsQA)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
