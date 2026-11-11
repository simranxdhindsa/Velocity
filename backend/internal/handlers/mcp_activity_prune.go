package handlers

import (
	"context"
	"log"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/logging"
)

// RunMCPActivityPruner deletes MCP activity log rows older than 7 days on a
// daily tick, so the UI's "MCP Activity" view never holds more than a week
// of transactions and the table never grows unbounded.
func RunMCPActivityPruner(repo *database.MCPActivityRepository) {
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		logging.Job("mcp_activity_prune", func(ctx context.Context) { pruneMCPActivity(ctx, repo) }) // once on startup
		for range ticker.C {
			logging.Job("mcp_activity_prune", func(ctx context.Context) { pruneMCPActivity(ctx, repo) })
		}
	}()
}

func pruneMCPActivity(parent context.Context, repo *database.MCPActivityRepository) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	n, err := repo.PruneOlderThanWeek(ctx)
	if err != nil {
		log.Printf("[MCP Activity] ⚠ prune failed: %v", err)
		return
	}
	if n > 0 {
		log.Printf("[MCP Activity] pruned %d entries older than 7 days", n)
	}
}
