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
	n, err := repo.PruneOlderThan30Days(ctx)
	if err != nil {
		log.Printf("[Slack Bot Chat] ⚠ prune failed: %v", err)
		return
	}
	if n > 0 {
		log.Printf("[Slack Bot Chat] pruned %d conversations older than 30 days", n)
	}
}
