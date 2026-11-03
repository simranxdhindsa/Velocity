package database

import (
	"context"
	"log"
)

// RunSlackDMMigrations creates the Slack DM chat tables. Kept out of migrations.go (already
// very long). Called at the end of RunMigrations (exported for tests).
//
// One row per DM between a person and the Velocity bot, plus every message in it: what the
// person sent, what Velocity sent on someone's behalf (Claude, the queue, the dashboard), the
// bot's own replies and notices. Admin-only in the app. mode: smart (stay quiet while a relayed
// conversation is open) | auto (always let the bot answer) | muted (never). A relay opens when
// Velocity DMs a person for a user and closes when relay_until passes or an admin resolves it.
// User ids are NOT foreign keys, same as slack_bot_conversations, so a deleted user never
// breaks the log.
func RunSlackDMMigrations(ctx context.Context) {
	pool := GetPool()
	if pool == nil {
		return
	}
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS slack_dm_conversations (
			channel_id       VARCHAR(64) PRIMARY KEY,
			slack_user_id    VARCHAR(64) NOT NULL DEFAULT '',
			slack_user_name  VARCHAR(255) NOT NULL DEFAULT '',
			slack_user_email VARCHAR(255) NOT NULL DEFAULT '',
			mode             VARCHAR(10) NOT NULL DEFAULT 'smart',
			relay_owner_id   VARCHAR(255) NOT NULL DEFAULT '',
			relay_until      TIMESTAMPTZ,
			relay_acked      BOOLEAN NOT NULL DEFAULT false,
			needs_attention  BOOLEAN NOT NULL DEFAULT false,
			last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_dm_conversations_last ON slack_dm_conversations(last_message_at DESC)`,
		// kind: human | claude | dashboard | auto_reply | ack | notice. UNIQUE (channel_id,
		// slack_ts) makes Slack's event redeliveries harmless and lets the bot reply once per message.
		`CREATE TABLE IF NOT EXISTS slack_dm_messages (
			id              BIGSERIAL PRIMARY KEY,
			channel_id      VARCHAR(64) NOT NULL,
			slack_ts        VARCHAR(32) NOT NULL,
			thread_ts       VARCHAR(32) NOT NULL DEFAULT '',
			direction       VARCHAR(3) NOT NULL,
			kind            VARCHAR(12) NOT NULL,
			author_slack_id VARCHAR(64) NOT NULL DEFAULT '',
			sent_by_user_id VARCHAR(255) NOT NULL DEFAULT '',
			text            TEXT NOT NULL DEFAULT '',
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE (channel_id, slack_ts)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_dm_messages_channel ON slack_dm_messages(channel_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_dm_messages_created ON slack_dm_messages(created_at)`,
	}
	for i, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			log.Printf("[slack-dm] migration %d skipped: %v", i+1, err)
		}
	}
}
