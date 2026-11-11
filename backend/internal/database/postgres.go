package database

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/logging"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var pool *pgxpool.Pool

// Connect establishes a connection to the PostgreSQL database
func Connect() error {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL environment variable is required")
	}

	// Log masked URL for debugging
	if parsed, err := url.Parse(databaseURL); err == nil {
		log.Printf("📡 Connecting to: %s@%s%s", parsed.User.Username(), parsed.Host, parsed.Path)
	}

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("failed to parse database URL: %w", err)
	}

	// Configure pool settings
	config.MaxConns = 10
	config.MinConns = 2
	config.MaxConnLifetime = time.Hour
	config.MaxConnIdleTime = 30 * time.Minute
	config.HealthCheckPeriod = 1 * time.Minute

	// Increase timeout for Supabase connections
	config.ConnConfig.ConnectTimeout = 30 * time.Second

	// Log failed and slow queries (SQL text only, never arguments)
	config.ConnConfig.Tracer = logging.DBTracer{}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err = pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return fmt.Errorf("failed to create connection pool: %w", err)
	}

	// Test the connection with retries
	maxRetries := 3
	var pingErr error
	for i := 0; i < maxRetries; i++ {
		pingErr = pool.Ping(ctx)
		if pingErr == nil {
			return nil
		}
		if i < maxRetries-1 {
			log.Printf("Database ping attempt %d failed, retrying in 2 seconds...", i+1)
			time.Sleep(2 * time.Second)
		} else {
			return fmt.Errorf("failed to ping database after %d attempts: %w", maxRetries, pingErr)
		}
	}

	return nil
}

// GetPool returns the database connection pool
func GetPool() *pgxpool.Pool {
	return pool
}

// Close closes the database connection pool
func Close() {
	if pool != nil {
		pool.Close()
	}
}

// Transaction executes a function within a database transaction
func Transaction(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			tx.Rollback(ctx)
			panic(p)
		}
	}()

	if err := fn(tx); err != nil {
		tx.Rollback(ctx)
		return err
	}

	return tx.Commit(ctx)
}
