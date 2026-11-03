package handlers

import (
	"context"
	"log"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

// RunSlackBotConversationPruner deletes Slack bot conversation rows older
// than 30 days on a daily tick, so the "Bot Conversations" view never holds
// more than a month of chat history and the table never grows unbounded.
func RunSlackBotConversationPruner(repo *database.SlackBotConversationRepository) {
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		pruneSlackBotConversations(repo) // once on startup
		for range ticker.C {
			pruneSlackBotConversations(repo)
		}
	}()
}

func pruneSlackBotConversations(repo *database.SlackBotConversationRepository) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if n, err := repo.PruneOlderThan30Days(ctx); err != nil {
		log.Printf("[Slack Bot Chat] ⚠ prune failed: %v", err)
	} else if n > 0 {
		log.Printf("[Slack Bot Chat] pruned %d conversations older than 30 days", n)
	}

	// The admin DM chat log keeps 90 days, so private DMs are not stored longer than that.
	// Runs even if the pruning above failed, so private text is never kept by a bug there.
	dm := database.NewSlackDMRepository()
	if m, err := dm.PruneMessagesOlderThan(ctx, 90); err != nil {
		log.Printf("[Slack DM] ⚠ prune failed: %v", err)
	} else if m > 0 {
		log.Printf("[Slack DM] pruned %d messages older than 90 days", m)
	}
	if c, err := dm.PruneIdleConversations(ctx, 90); err != nil {
		log.Printf("[Slack DM] ⚠ conversation prune failed: %v", err)
	} else if c > 0 {
		log.Printf("[Slack DM] pruned %d idle conversations older than 90 days", c)
	}
}
