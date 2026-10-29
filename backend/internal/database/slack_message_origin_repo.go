package database

import (
	"context"
	"time"
)

// SlackMessageOrigin describes where a message the Velocity bot posted came
// from: which feature sent it and on whose behalf. The Slack bot uses it
// when someone replies to that message, so it can answer "what is this?"
// with real context instead of guessing.
type SlackMessageOrigin struct {
	Source     string // e.g. "claude_queue" (sent via Claude/MCP), "daily_digest"
	SenderName string // Velocity user the message was sent for, may be empty
	Message    string // full original text as Velocity sent it
	SentAt     time.Time
}

// FindSlackMessageOrigin looks a posted message up by its Slack ts in both
// send logs: pending_slack_messages (Claude Queue and instant MCP sends,
// including DMs, which store no channel ID) and sent_slack_messages (every
// other feature, channel posts only). Returns nil when Velocity has no
// record of it. channelID narrows the sent_slack_messages match.
func FindSlackMessageOrigin(ctx context.Context, channelID, ts string) *SlackMessageOrigin {
	pool := GetPool()
	if pool == nil || ts == "" {
		return nil
	}
	o := &SlackMessageOrigin{}
	err := pool.QueryRow(ctx, `
		SELECT source, sender, message, sent_at FROM (
			SELECT 'claude_queue' AS source, COALESCE(u.name, '') AS sender, p.message,
			       COALESCE(p.sent_at, p.created_at) AS sent_at, 1 AS pri
			FROM pending_slack_messages p
			LEFT JOIN users u ON u.id = p.user_id
			WHERE p.slack_ts = $2 AND p.status = 'sent'
			UNION ALL
			SELECT s.source, COALESCE(u.name, ''), s.message, s.sent_at, 2
			FROM sent_slack_messages s
			LEFT JOIN users u ON u.id = s.user_id
			WHERE s.slack_ts = $2 AND ($1 = '' OR s.channel_id = $1)
		) x
		ORDER BY pri
		LIMIT 1
	`, channelID, ts).Scan(&o.Source, &o.SenderName, &o.Message, &o.SentAt)
	if err != nil {
		return nil
	}
	return o
}
