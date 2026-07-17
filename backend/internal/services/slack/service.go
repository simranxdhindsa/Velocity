package slack

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
)

// Service handles Slack integration logic
type Service struct {
	integrationRepo *database.IntegrationRepository
	slackRepo       *database.SlackRepository
}

// NewService creates a new Slack service
func NewService() *Service {
	return &Service{
		integrationRepo: database.NewIntegrationRepository(),
		slackRepo:       database.NewSlackRepository(),
	}
}

// DigestIssue represents an issue for the daily digest post
type DigestIssue struct {
	ID       string `json:"id"`
	Summary  string `json:"summary"`
	Assignee string `json:"assignee"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
}

// ScanResult holds the result of a Slack scan
type ScanResult struct {
	NewMentions int `json:"new_mentions"`
	NewThreads  int `json:"new_threads"`
}

// EnrichedMessage contains message with resolved user info
type EnrichedMessage struct {
	ID        string    `json:"id"`
	ChannelID string    `json:"channel_id"`
	UserID    string    `json:"user_id"`
	UserName  string    `json:"user_name"`
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp"`
	ThreadTS  *string   `json:"thread_ts,omitempty"`
}

// Connect connects a Slack bot to the user's account
func (s *Service) Connect(ctx context.Context, userID, botToken, channelID string) (*models.SlackIntegration, error) {
	// Verify the token
	client := NewClient(botToken)
	teamInfo, err := client.AuthTest(ctx)
	if err != nil {
		return nil, fmt.Errorf("invalid bot token: %w", err)
	}

	// Get channel name if channel ID provided
	var channelName *string
	if channelID != "" {
		channels, err := client.GetChannels(ctx)
		if err == nil {
			for _, ch := range channels {
				if ch.ID == channelID {
					channelName = &ch.Name
					break
				}
			}
		}
		// Note: bot should be manually invited to the channel via /invite
	}

	// Save the integration
	integration := &models.SlackIntegration{
		UserID:      userID,
		BotToken:    botToken,
		TeamID:      teamInfo.ID,
		TeamName:    teamInfo.Name,
		ChannelID:   &channelID,
		ChannelName: channelName,
		Connected:   true,
	}

	if err := s.integrationRepo.SaveSlackIntegration(ctx, integration); err != nil {
		return nil, fmt.Errorf("failed to save integration: %w", err)
	}

	return integration, nil
}

// Disconnect disconnects the Slack integration
func (s *Service) Disconnect(ctx context.Context, userID string) error {
	return s.integrationRepo.DisconnectSlack(ctx, userID)
}

// GetStatus returns the current Slack connection status
func (s *Service) GetStatus(ctx context.Context, userID string) (*models.SlackIntegration, error) {
	return s.integrationRepo.GetSlackIntegration(ctx, userID)
}

// GetChannels returns available channels
func (s *Service) GetChannels(ctx context.Context, userID string) ([]Channel, error) {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get integration: %w", err)
	}

	if !integration.Connected {
		return nil, fmt.Errorf("slack not connected")
	}

	client := NewClient(integration.BotToken)
	return client.GetChannels(ctx)
}

// GetWorkspaceUsers returns all non-bot workspace members for the user's Slack integration.
func (s *Service) GetWorkspaceUsers(ctx context.Context, userID string) ([]User, error) {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get integration: %w", err)
	}
	if !integration.Connected {
		return nil, fmt.Errorf("slack not connected")
	}
	client := NewClient(integration.BotToken)
	return client.GetWorkspaceUsers(ctx)
}

// SetChannel sets the channel to monitor
func (s *Service) SetChannel(ctx context.Context, userID, channelID, channelName string) error {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil {
		return fmt.Errorf("failed to get integration: %w", err)
	}

	if !integration.Connected {
		return fmt.Errorf("slack not connected")
	}

	// Note: bot should be manually invited to the channel via /invite
	return s.integrationRepo.UpdateSlackChannel(ctx, userID, channelID, channelName)
}

// GetMessages retrieves messages from the configured channel
func (s *Service) GetMessages(ctx context.Context, userID string, from, to time.Time) ([]EnrichedMessage, error) {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get integration: %w", err)
	}

	if !integration.Connected {
		return nil, fmt.Errorf("slack not connected")
	}

	if integration.ChannelID == nil || *integration.ChannelID == "" {
		return nil, fmt.Errorf("no channel configured")
	}

	client := NewClient(integration.BotToken)

	// Get messages from the channel
	messages, err := client.GetChannelHistory(ctx, *integration.ChannelID, from.Unix(), to.Unix(), 500)
	if err != nil {
		return nil, fmt.Errorf("failed to get messages: %w", err)
	}

	// Cache for user lookups
	userCache := make(map[string]*User)

	// Enrich messages with user info
	enriched := make([]EnrichedMessage, 0, len(messages))
	for _, msg := range messages {
		// Skip non-message types
		if msg.Type != "message" {
			continue
		}

		// Get user info
		var userName string
		if user, ok := userCache[msg.User]; ok {
			userName = user.RealName
			if userName == "" {
				userName = user.Profile.DisplayName
			}
		} else {
			user, err := client.GetUser(ctx, msg.User)
			if err == nil {
				userCache[msg.User] = user
				userName = user.RealName
				if userName == "" {
					userName = user.Profile.DisplayName
				}
			} else {
				userName = msg.User
			}
		}

		// Parse timestamp
		ts, err := parseSlackTimestamp(msg.TS)
		if err != nil {
			continue
		}

		var threadTS *string
		if msg.ThreadTS != "" {
			threadTS = &msg.ThreadTS
		}

		enriched = append(enriched, EnrichedMessage{
			ID:        msg.TS,
			ChannelID: *integration.ChannelID,
			UserID:    msg.User,
			UserName:  userName,
			Text:      msg.Text,
			Timestamp: ts,
			ThreadTS:  threadTS,
		})
	}

	// Save messages to database for AI analysis
	for _, msg := range enriched {
		dbMsg := &models.SlackMessage{
			ID:        msg.ID,
			ChannelID: msg.ChannelID,
			UserID:    msg.UserID,
			UserName:  msg.UserName,
			Text:      msg.Text,
			Timestamp: msg.Timestamp,
			ThreadTS:  msg.ThreadTS,
		}
		s.integrationRepo.SaveSlackMessage(ctx, dbMsg)
	}

	return enriched, nil
}

// GetYesterdayMessages retrieves messages from yesterday
func (s *Service) GetYesterdayMessages(ctx context.Context, userID string) ([]EnrichedMessage, error) {
	now := time.Now()
	yesterday := now.AddDate(0, 0, -1)
	startOfYesterday := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 0, 0, 0, 0, now.Location())
	endOfYesterday := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 23, 59, 59, 0, now.Location())

	return s.GetMessages(ctx, userID, startOfYesterday, endOfYesterday)
}

// ScanMentions fetches recent messages and finds any where the user is @mentioned.
// It saves new mentions to slack_mentions and returns all new ones found.
func (s *Service) ScanMentions(ctx context.Context, userID, email string) ([]models.SlackMention, error) {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return nil, fmt.Errorf("slack not connected")
	}

	// Determine which channel to monitor (prefer monitor_channel, fall back to primary)
	monitorChannelID := ""
	if integration.MonitorChannelID != nil && *integration.MonitorChannelID != "" {
		monitorChannelID = *integration.MonitorChannelID
	} else if integration.ChannelID != nil {
		monitorChannelID = *integration.ChannelID
	}
	if monitorChannelID == "" {
		return nil, fmt.Errorf("no channel configured for monitoring")
	}

	client := NewClient(integration.BotToken)

	// Resolve the user's Slack ID from their email
	slackUser, err := client.GetUserByEmail(ctx, email)
	if err != nil {
		return nil, fmt.Errorf("could not resolve Slack user for email %s: %w", email, err)
	}
	slackUserID := slackUser.ID
	mentionTag := "<@" + slackUserID + ">"

	// Fetch last 24 hours of messages
	to := time.Now()
	from := to.Add(-24 * time.Hour)
	messages, err := client.GetChannelHistory(ctx, monitorChannelID, from.Unix(), to.Unix(), 500)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch messages: %w", err)
	}

	// User cache: slack user ID -> {name, avatar}
	type cachedUser struct {
		name   string
		avatar string
	}
	userCache := make(map[string]cachedUser)

	resolveUser := func(slackID string) cachedUser {
		if c, ok := userCache[slackID]; ok {
			return c
		}
		cu := cachedUser{name: slackID}
		if u, err := client.GetUser(ctx, slackID); err == nil {
			name := u.RealName
			if name == "" {
				name = u.Profile.DisplayName
			}
			cu.name = name
			cu.avatar = u.Profile.Image48
		}
		userCache[slackID] = cu
		return cu
	}

	// Regex to find <@UXXX> mentions in message text
	mentionRe := regexp.MustCompile(`<@([A-Z0-9]+)>`)

	var newMentions []models.SlackMention
	for _, msg := range messages {
		if msg.Type != "message" || msg.User == slackUserID {
			continue // skip own messages
		}
		if !strings.Contains(msg.Text, mentionTag) {
			continue
		}

		// Resolve sender
		sender := resolveUser(msg.User)

		// Resolve all <@UXXX> in message text to real names
		resolvedText := mentionRe.ReplaceAllStringFunc(msg.Text, func(match string) string {
			sub := mentionRe.FindStringSubmatch(match)
			if len(sub) < 2 {
				return match
			}
			u := resolveUser(sub[1])
			return "@" + u.name
		})

		ts, err := parseSlackTimestamp(msg.TS)
		if err != nil {
			continue
		}

		var threadTS *string
		if msg.ThreadTS != "" && msg.ThreadTS != msg.TS {
			threadTS = &msg.ThreadTS
		}

		mention := models.SlackMention{
			UserID:        userID,
			SlackUserID:   slackUserID,
			MessageTS:     msg.TS,
			ThreadTS:      threadTS,
			ChannelID:     monitorChannelID,
			MessageText:   resolvedText,
			SenderName:    sender.name,
			SenderAvatar:  sender.avatar,
			RequiresReply: true,
			Replied:       false,
			CreatedAt:     ts,
		}

		if err := s.slackRepo.SaveMention(ctx, &mention); err == nil {
			newMentions = append(newMentions, mention)
		}
	}

	return newMentions, nil
}

// ScanUserThreads finds messages the user sent that started threads and checks their reply counts.
func (s *Service) ScanUserThreads(ctx context.Context, userID, email string) ([]models.SlackUserThread, error) {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return nil, fmt.Errorf("slack not connected")
	}

	monitorChannelID := ""
	if integration.MonitorChannelID != nil && *integration.MonitorChannelID != "" {
		monitorChannelID = *integration.MonitorChannelID
	} else if integration.ChannelID != nil {
		monitorChannelID = *integration.ChannelID
	}
	if monitorChannelID == "" {
		return nil, fmt.Errorf("no channel configured for monitoring")
	}

	// Resolve the channel name from the already-loaded integration (no extra API call needed)
	channelName := monitorChannelID
	if integration.MonitorChannelName != nil && *integration.MonitorChannelName != "" &&
		integration.MonitorChannelID != nil && *integration.MonitorChannelID == monitorChannelID {
		channelName = *integration.MonitorChannelName
	} else if integration.ChannelName != nil && *integration.ChannelName != "" &&
		integration.ChannelID != nil && *integration.ChannelID == monitorChannelID {
		channelName = *integration.ChannelName
	}

	client := NewClient(integration.BotToken)

	// Resolve the user's Slack ID
	slackUser, err := client.GetUserByEmail(ctx, email)
	if err != nil {
		return nil, fmt.Errorf("could not resolve Slack user: %w", err)
	}
	slackUserID := slackUser.ID

	// User cache for resolving <@UXXX> mention tokens to real names
	userCache := make(map[string]string)
	resolveSlackUser := func(slackID string) string {
		if n, ok := userCache[slackID]; ok {
			return n
		}
		name := slackID
		if u, err := client.GetUser(ctx, slackID); err == nil {
			if u.RealName != "" {
				name = u.RealName
			} else if u.Profile.DisplayName != "" {
				name = u.Profile.DisplayName
			}
		}
		userCache[slackID] = name
		return name
	}
	mentionRe := regexp.MustCompile(`<@([A-Z0-9]+)>`)

	// Fetch last 7 days of messages
	to := time.Now()
	from := to.Add(-7 * 24 * time.Hour)
	messages, err := client.GetChannelHistory(ctx, monitorChannelID, from.Unix(), to.Unix(), 500)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch messages: %w", err)
	}

	var newThreads []models.SlackUserThread
	for _, msg := range messages {
		if msg.Type != "message" || msg.User != slackUserID {
			continue // only user's own messages
		}
		// Only top-level messages that started a thread (or have 0 replies)
		if msg.ThreadTS != "" && msg.ThreadTS != msg.TS {
			continue // this is a reply, not a thread starter
		}

		ts, err := parseSlackTimestamp(msg.TS)
		if err != nil {
			continue
		}

		// Resolve <@UXXX> tokens to real names so the frontend can display them directly
		resolvedText := mentionRe.ReplaceAllStringFunc(msg.Text, func(match string) string {
			sub := mentionRe.FindStringSubmatch(match)
			if len(sub) < 2 {
				return match
			}
			return "@" + resolveSlackUser(sub[1])
		})

		thread := models.SlackUserThread{
			UserID:      userID,
			ChannelID:   monitorChannelID,
			ChannelName: channelName,
			ThreadTS:    msg.TS,
			MessageText: resolvedText,
			ReplyCount:  msg.ReplyCount,
			HasReply:    msg.ReplyCount > 0,
			CreatedAt:   ts,
		}

		if err := s.slackRepo.SaveUserThread(ctx, &thread); err == nil {
			newThreads = append(newThreads, thread)
		}
	}

	return newThreads, nil
}

// PostDailyDigest posts a formatted list of today's issues to the primary digest channel.
// Returns the thread timestamp of the posted message.
func (s *Service) PostDailyDigest(ctx context.Context, userID string, issues []DigestIssue) (string, error) {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return "", fmt.Errorf("slack not connected")
	}

	if integration.ChannelID == nil || *integration.ChannelID == "" {
		return "", fmt.Errorf("no digest channel configured")
	}

	client := NewClient(integration.BotToken)

	// Build the digest message
	now := time.Now()
	text := fmt.Sprintf("*Daily Task Digest — %s*\n", now.Format("Mon Jan 2, 2006"))
	if len(issues) == 0 {
		text += "No active issues today."
	} else {
		for _, issue := range issues {
			priorityEmoji := "⚪"
			switch strings.ToLower(issue.Priority) {
			case "critical", "p0":
				priorityEmoji = "🔴"
			case "major", "p1":
				priorityEmoji = "🟠"
			case "normal", "p2":
				priorityEmoji = "🟡"
			case "minor", "p3":
				priorityEmoji = "🟢"
			}
			text += fmt.Sprintf("%s *%s* — %s _(Assignee: %s, Status: %s)_\n",
				priorityEmoji, issue.ID, issue.Summary, issue.Assignee, issue.Status)
		}
	}

	threadTS, err := client.PostMessage(ctx, *integration.ChannelID, text)
	if err != nil {
		return "", fmt.Errorf("failed to post digest: %w", err)
	}

	return threadTS, nil
}

// TrackDigestReplies checks replies on a digest thread and returns issue IDs that appear resolved.
func (s *Service) TrackDigestReplies(ctx context.Context, userID, threadTS string) ([]string, error) {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return nil, fmt.Errorf("slack not connected")
	}

	if integration.ChannelID == nil || *integration.ChannelID == "" {
		return nil, fmt.Errorf("no digest channel configured")
	}

	client := NewClient(integration.BotToken)
	replies, err := client.GetThreadReplies(ctx, *integration.ChannelID, threadTS)
	if err != nil {
		return nil, err
	}

	// Look for "done", "fixed", "resolved" keywords + issue IDs (e.g. "ARD-123 done")
	resolvedKeywords := []string{"done", "fixed", "resolved", "completed", "✅", "✓"}
	var resolvedIssues []string

	for _, reply := range replies {
		lowerText := strings.ToLower(reply.Text)
		for _, kw := range resolvedKeywords {
			if strings.Contains(lowerText, kw) {
				// Try to extract issue IDs (pattern: word-number like ARD-123 or 3-456)
				words := strings.Fields(reply.Text)
				for _, word := range words {
					// Simple heuristic: contains a hyphen and has digits
					if strings.Contains(word, "-") {
						parts := strings.SplitN(word, "-", 2)
						if len(parts) == 2 && len(parts[1]) > 0 {
							resolvedIssues = append(resolvedIssues, word)
						}
					}
				}
				break
			}
		}
	}

	return resolvedIssues, nil
}

// PostMessage posts a plain text message to a channel.
func (s *Service) PostMessage(ctx context.Context, userID, channelID, text string) error {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return fmt.Errorf("slack not connected")
	}

	client := NewClient(integration.BotToken)
	_, err = client.PostMessage(ctx, channelID, text)
	return err
}

// PostBlockerAlert posts an alert to the monitor channel when an issue is blocked.
func (s *Service) PostBlockerAlert(ctx context.Context, userID, issueID, summary, assigneeEmail string) error {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return fmt.Errorf("slack not connected")
	}

	// Use monitor channel for alerts, fall back to primary
	channelID := ""
	if integration.MonitorChannelID != nil && *integration.MonitorChannelID != "" {
		channelID = *integration.MonitorChannelID
	} else if integration.ChannelID != nil {
		channelID = *integration.ChannelID
	}
	if channelID == "" {
		return fmt.Errorf("no channel configured")
	}

	client := NewClient(integration.BotToken)

	// Try to tag the assignee by email
	assigneeTag := assigneeEmail
	if assigneeEmail != "" {
		if slackUser, err := client.GetUserByEmail(ctx, assigneeEmail); err == nil {
			assigneeTag = "<@" + slackUser.ID + ">"
		}
	}

	text := fmt.Sprintf("🚫 *BLOCKED* — *%s* %s\nAssignee: %s", issueID, summary, assigneeTag)
	_, err = client.PostMessage(ctx, channelID, text)
	return err
}

// PostTimeThresholdAlert posts an alert when an issue exceeds its time threshold.
func (s *Service) PostTimeThresholdAlert(ctx context.Context, userID, issueID, summary string, spentHours, thresholdHours float64) error {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return fmt.Errorf("slack not connected")
	}

	// Post to primary digest channel
	if integration.ChannelID == nil || *integration.ChannelID == "" {
		return fmt.Errorf("no digest channel configured")
	}

	client := NewClient(integration.BotToken)
	text := fmt.Sprintf("⚠️ *Time Threshold Exceeded* — *%s* %s\nSpent: %.1fh  |  Threshold: %.1fh",
		issueID, summary, spentHours, thresholdHours)

	_, err = client.PostMessage(ctx, *integration.ChannelID, text)
	return err
}

// SetMonitorChannel sets the channel to monitor for @mentions (separate from digest channel)
func (s *Service) SetMonitorChannel(ctx context.Context, userID, channelID, channelName string) error {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil {
		return fmt.Errorf("failed to get integration: %w", err)
	}

	if !integration.Connected {
		return fmt.Errorf("slack not connected")
	}

	return s.integrationRepo.UpdateSlackMonitorChannel(ctx, userID, channelID, channelName)
}

// parseSlackTimestamp converts Slack timestamp to time.Time
func parseSlackTimestamp(ts string) (time.Time, error) {
	parts := splitSlackTimestamp(ts)
	if len(parts) == 0 {
		return time.Time{}, fmt.Errorf("invalid timestamp")
	}

	secs, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return time.Time{}, err
	}

	return time.Unix(secs, 0), nil
}

// splitSlackTimestamp splits the Slack timestamp (e.g., "1234567890.123456")
func splitSlackTimestamp(ts string) []string {
	for i, c := range ts {
		if c == '.' {
			return []string{ts[:i], ts[i+1:]}
		}
	}
	return []string{ts}
}
