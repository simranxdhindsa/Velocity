package database

import (
	"context"
	"log"
)

// RunAppLogsMigrations creates the app_logs table that holds warnings and errors from the
// backend (see internal/logging). Called at the end of RunMigrations (exported for tests).
// User ids are NOT foreign keys so a deleted user never breaks the log.
func RunAppLogsMigrations(ctx context.Context) {
	pool := GetPool()
	if pool == nil {
		return
	}
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS app_logs (
			id         BIGSERIAL PRIMARY KEY,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			level      VARCHAR(10) NOT NULL,
			message    TEXT NOT NULL,
			request_id VARCHAR(64) NOT NULL DEFAULT '',
			user_id    VARCHAR(255) NOT NULL DEFAULT '',
			route      TEXT NOT NULL DEFAULT '',
			job        VARCHAR(100) NOT NULL DEFAULT '',
			attrs      JSONB NOT NULL DEFAULT '{}'
		)`,
		`CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_app_logs_level_created ON app_logs(level, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_app_logs_request ON app_logs(request_id) WHERE request_id <> ''`,
	}
	for i, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			log.Printf("[app-logs] migration %d skipped: %v", i+1, err)
		}
	}
}
