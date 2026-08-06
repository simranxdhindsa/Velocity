package update_reminder

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// Service handles all update-reminder business logic
type Service struct {
	repo            *database.UpdateReminderRepository
	integrationRepo *database.IntegrationRepository
	sentRepo        *database.SentSlackMessagesRepository
}

func NewService() *Service {
	return &Service{
		repo:            database.NewUpdateReminderRepository(),
		integrationRepo: database.NewIntegrationRepository(),
		sentRepo:        database.NewSentSlackMessagesRepository(),
	}
}

// logSent records a just-sent message in the unified Slack Messages hub log.
// Best-effort: a logging failure never fails the send itself.
func (s *Service) logSent(ctx context.Context, userID, source, channelID, message, slackTs string) {
	if slackTs == "" || channelID == "" {
		return
	}
	if _, err := s.sentRepo.Log(ctx, userID, source, channelID, "", message, slackTs); err != nil {
		fmt.Printf("[update_reminder] warning: failed to log sent message (source=%s): %v\n", source, err)
	}
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

// ComputeSnapshot fetches Slack messages and determines who posted / who is missing / who is on leave.
// It uses the rule owner's bot token from their Slack integration.
func (s *Service) ComputeSnapshot(ctx context.Context, rule *models.UpdateReminderRule) (*models.UpdateReminderSnapshot, []string, error) {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, rule.UserID)
	if err != nil || !integration.Connected {
		return nil, nil, fmt.Errorf("slack not connected for user %s", rule.UserID)
	}

	client := slacksvc.NewClient(integration.BotToken)

	// Resolve the check window in the rule's configured timezone
	loc, err := time.LoadLocation(rule.Timezone)
	if err != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)
	startDay := now.AddDate(0, 0, rule.CheckDayOffset)
	endDay := now.AddDate(0, 0, rule.CheckWindowEndDayOffset)

	windowStart, err := parseHHMM(rule.CheckWindowStart, startDay, loc)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid check_window_start: %w", err)
	}
	windowEnd, err := parseHHMM(rule.CheckWindowEnd, endDay, loc)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid check_window_end: %w", err)
	}

	// Build regex for pattern mode once
	var patternRe *regexp.Regexp
	if rule.DetectionMode == models.DetectionModePattern && rule.DetectionValue != "" {
		patternRe, err = regexp.Compile("(?i)" + rule.DetectionValue)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid detection pattern: %w", err)
		}
	}
	keywords := parseKeywords(rule.DetectionValue)

	// Fetch all enabled roster members
	roster, err := s.repo.ListRoster(ctx, rule.ID)
	if err != nil {
		return nil, nil, fmt.Errorf("load roster: %w", err)
	}

	// Build a set of enabled slack user IDs to check
	type memberInfo struct {
		slackUserID string
		displayName string
	}
	membersByID := make(map[string]memberInfo)
	for _, m := range roster {
		if m.Enabled {
			membersByID[m.SlackUserID] = memberInfo{m.SlackUserID, m.DisplayName}
		}
	}

	// Collect user IDs who posted in ANY of the source channels
	postedIDs := make(map[string]bool)
	missingIDs := make(map[string]bool) // only used in mention_missing mode
	var channelErrors []string
	for _, ch := range rule.SourceChannelIDs {
		msgs, err := client.GetChannelHistory(ctx, ch.ID, windowStart.Unix(), windowEnd.Unix(), 1000)
		if err != nil {
			channelErrors = append(channelErrors, fmt.Sprintf("channel %s (%s): %s", ch.Name, ch.ID, err.Error()))
			continue
		}
		if rule.DetectionMode == models.DetectionModeMentionMissing {
			// Find the most recent message that mentions at least one roster member.
			// That single message defines the missing list — "last curation wins".
			// Slack conversations.history returns newest-first, so msgs[0] is most recent.
			// Skip messages that match this rule's own channel template — they are auto-generated
			// reminders and would create a circular loop (bot sends reminder → reads it back → sends again).
			templateRe := buildTemplatePattern(rule.ChannelTemplate)
			for _, msg := range msgs {
				if msg.Subtype != "" {
					continue
				}
				// Skip auto-generated reminder messages from this rule
				if templateRe != nil && templateRe.MatchString(msg.Text) {
					continue
				}
				mentions := extractMentions(msg.Text)
				hasRosterMention := false
				for _, uid := range mentions {
					if _, inRoster := membersByID[uid]; inRoster {
						hasRosterMention = true
						break
					}
				}
				// Also match plain-text @DisplayName (messages sent via quick-send arrive
				// as raw text — Slack does not auto-convert @Name to <@USER_ID> format).
				textLower := strings.ToLower(msg.Text)
				for uid, info := range membersByID {
					if strings.Contains(textLower, "@"+strings.ToLower(info.displayName)) {
						missingIDs[uid] = true
						hasRosterMention = true
					}
				}

				if hasRosterMention {
					for _, uid := range mentions {
						missingIDs[uid] = true
					}
					break // stop — only use this one message
				}
			}
		} else {
			for _, msg := range msgs {
				if msg.Subtype != "" || msg.BotID != "" {
					continue // skip bot/system messages for other detection modes
				}
				if messageMatchesDetection(msg.Text, rule.DetectionMode, keywords, patternRe) {
					postedIDs[msg.User] = true
				}
			}
		}
	}

	// Collect on-leave user IDs from the leave channel
	onLeaveIDs := make(map[string]bool)
	if rule.LeaveChannelID != "" && len(rule.LeaveKeywords) > 0 {
		leaveMsgs, err := client.GetChannelHistory(ctx, rule.LeaveChannelID, windowStart.Unix(), windowEnd.Unix(), 1000)
		if err == nil {
			leaveKWLower := make([]string, len(rule.LeaveKeywords))
			for i, kw := range rule.LeaveKeywords {
				leaveKWLower[i] = strings.ToLower(kw)
			}
			for _, msg := range leaveMsgs {
				if msg.Subtype != "" || msg.BotID != "" {
					continue
				}
				textLower := strings.ToLower(msg.Text)
				for _, kw := range leaveKWLower {
					if strings.Contains(textLower, kw) {
						onLeaveIDs[msg.User] = true
						break
					}
				}
			}
		}
	}

	// Classify each roster member
	snap := &models.UpdateReminderSnapshot{ComputedAt: time.Now()}
	for id, info := range membersByID {
		member := models.SnapshotMember{SlackUserID: id, DisplayName: info.displayName}
		if onLeaveIDs[id] {
			snap.OnLeave = append(snap.OnLeave, member)
		} else if rule.DetectionMode == models.DetectionModeMentionMissing {
			// In mention_missing mode: mentioned = missing, not mentioned = posted
			if missingIDs[id] {
				snap.Missing = append(snap.Missing, member)
			} else {
				snap.Posted = append(snap.Posted, member)
			}
		} else if postedIDs[id] {
			snap.Posted = append(snap.Posted, member)
		} else {
			snap.Missing = append(snap.Missing, member)
		}
	}

	return snap, channelErrors, nil
}

// DiffSnapshot returns what changed between old and new snapshots
func DiffSnapshot(old, new *models.UpdateReminderSnapshot) *models.SnapshotDiff {
	if old == nil {
		return &models.SnapshotDiff{HasChanges: false}
	}

	oldMissing := memberSet(old.Missing)
	newMissing := memberSet(new.Missing)
	oldPosted := memberSet(old.Posted)

	diff := &models.SnapshotDiff{}

	// Were missing, now posted
	for id, m := range oldMissing {
		if _, stillMissing := newMissing[id]; !stillMissing {
			diff.NowPosted = append(diff.NowPosted, m)
		}
	}
	// Were posted, now missing (shouldn't happen often but handle it)
	for id, m := range oldPosted {
		if _, nowMissing := newMissing[id]; nowMissing {
			diff.NowMissing = append(diff.NowMissing, m)
		}
	}
	// Newly on leave (not in old on_leave)
	oldOnLeave := memberSet(old.OnLeave)
	for id, m := range memberSet(new.OnLeave) {
		if _, wasOnLeave := oldOnLeave[id]; !wasOnLeave {
			diff.NowOnLeave = append(diff.NowOnLeave, m)
		}
	}

	diff.HasChanges = len(diff.NowPosted) > 0 || len(diff.NowMissing) > 0 || len(diff.NowOnLeave) > 0
	return diff
}

// ── Template rendering ────────────────────────────────────────────────────────

// RenderTemplate replaces {names}, {mentions}, {date}, {count}, {on_leave_names}
func RenderTemplate(tmpl string, snap *models.UpdateReminderSnapshot) string {
	missing := snap.Missing
	onLeave := snap.OnLeave

	names := make([]string, len(missing))
	mentions := make([]string, len(missing))
	for i, m := range missing {
		names[i] = m.DisplayName
		mentions[i] = "<@" + m.SlackUserID + ">"
	}

	leaveNames := make([]string, len(onLeave))
	for i, m := range onLeave {
		leaveNames[i] = m.DisplayName
	}

	r := strings.NewReplacer(
		"{names}", strings.Join(names, ", "),
		"{mentions}", strings.Join(mentions, ", "),
		"{date}", snap.ComputedAt.Format("2 Jan 2006"),
		"{count}", fmt.Sprintf("%d", len(missing)),
		"{on_leave_names}", strings.Join(leaveNames, ", "),
	)
	return r.Replace(tmpl)
}

// ── Execute ───────────────────────────────────────────────────────────────────

// ExecuteResult is returned by Execute
type ExecuteResult struct {
	Snapshot       *models.UpdateReminderSnapshot
	Diff           *models.SnapshotDiff
	RenderedMsg    string // channel message (rendered)
	RenderedDM     string // DM message (rendered)
	DeliveredTo    []string
	DeliveryErrors []string // non-fatal errors per destination
	ChannelErrors  []string // errors reading source channels (bot not in channel, etc.)
	SkippedSend    string   // human-readable reason nothing was sent (no missing members, etc.)
	IsDryRun       bool
}

// Execute computes a fresh snapshot, optionally diffs against the saved one,
// sends messages (unless dry-run), and persists the run log.
//
// forceSnapshot=true → always use the freshly computed snapshot (Run Now → "Send updated")
// forceSnapshot=false + rule.LastSnapshot != nil → use the saved snapshot (Run Now → "Send original")
// dryRun=true → compute + diff but do not send or update last_snapshot
func (s *Service) Execute(ctx context.Context, rule *models.UpdateReminderRule, dryRun bool, forceSnapshot bool, triggeredBy models.UpdateReminderTriggeredBy) (*ExecuteResult, error) {
	// Always compute a fresh snapshot for the diff and dry-run preview
	freshSnap, channelErrors, err := s.ComputeSnapshot(ctx, rule)
	if err != nil {
		return nil, err
	}

	diff := DiffSnapshot(rule.LastSnapshot, freshSnap)

	// Decide which snapshot to render into the message
	snapToSend := freshSnap
	if !forceSnapshot && rule.LastSnapshot != nil {
		snapToSend = rule.LastSnapshot
	}

	// Apply leave_action: if "list_separately", missing stays as-is;
	// if "exclude", remove on-leave members from the missing list entirely
	effectiveSnap := applyLeaveAction(snapToSend, rule.LeaveAction)

	renderedChannel := RenderTemplate(rule.ChannelTemplate, effectiveSnap)
	renderedDM := RenderTemplate(rule.DMTemplate, effectiveSnap)

	result := &ExecuteResult{
		Snapshot:      freshSnap,
		Diff:          diff,
		RenderedMsg:   renderedChannel,
		RenderedDM:    renderedDM,
		ChannelErrors: channelErrors,
		IsDryRun:      dryRun,
	}

	if dryRun {
		return result, nil
	}

	// Deliver
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, rule.UserID)
	if err != nil || !integration.Connected {
		return nil, fmt.Errorf("slack not connected")
	}
	client := slacksvc.NewClient(integration.BotToken)

	var delivered []string
	var deliveryErrors []string

	totalMembers := len(effectiveSnap.Missing) + len(effectiveSnap.Posted) + len(effectiveSnap.OnLeave)
	if totalMembers == 0 {
		result.SkippedSend = "roster is empty — add members to the rule before running"
	} else if len(effectiveSnap.Missing) == 0 {
		result.SkippedSend = "no missing members — everyone has posted"
	} else {
		if rule.DeliveryChannel && rule.DeliveryChannelID != "" {
			if ts, err := client.PostMessage(ctx, rule.DeliveryChannelID, renderedChannel); err != nil {
				deliveryErrors = append(deliveryErrors, "channel "+rule.DeliveryChannelID+": "+err.Error())
			} else {
				delivered = append(delivered, "channel:"+rule.DeliveryChannelID)
				s.logSent(ctx, rule.UserID, "rules", rule.DeliveryChannelID, renderedChannel, ts)
			}
		} else if !rule.DeliveryChannel || rule.DeliveryChannelID == "" {
			deliveryErrors = append(deliveryErrors, "channel delivery not configured in rule")
		}

		if rule.DeliveryDM {
			for _, m := range effectiveSnap.Missing {
				if _, _, err := client.PostDirectMessage(ctx, m.SlackUserID, renderedDM); err != nil {
					deliveryErrors = append(deliveryErrors, "dm "+m.DisplayName+": "+err.Error())
				} else {
					delivered = append(delivered, "dm:"+m.SlackUserID)
				}
			}
		}
	}

	result.DeliveredTo = delivered
	result.DeliveryErrors = deliveryErrors

	// Persist snapshot and run log
	_ = s.repo.SaveSnapshot(ctx, rule.ID, freshSnap)

	postedNames := memberNames(freshSnap.Posted)
	onLeaveNames := memberNames(freshSnap.OnLeave)
	missingNames := memberNames(freshSnap.Missing)

	_, _ = s.repo.SaveRun(ctx, &models.UpdateReminderRun{
		RuleID:       rule.ID,
		UserID:       rule.UserID,
		TriggeredBy:  triggeredBy,
		PostedNames:  postedNames,
		OnLeaveNames: onLeaveNames,
		SkippedNames: missingNames,
		DeliveredTo:  delivered,
		SnapshotUsed: snapToSend,
		ExpiresAt:    database.UpdateReminderRunExpiresAt(),
	})

	return result, nil
}

// ExecuteScheduled is called by the scheduler — always uses fresh snapshot, writes triggered_by=scheduler
func (s *Service) ExecuteScheduled(ctx context.Context, rule *models.UpdateReminderRule) (*ExecuteResult, error) {
	result, err := s.Execute(ctx, rule, false, true, models.TriggeredByScheduler)
	if err != nil {
		errStr := err.Error()
		_, _ = s.repo.SaveRun(ctx, &models.UpdateReminderRun{
			RuleID:      rule.ID,
			UserID:      rule.UserID,
			TriggeredBy: models.TriggeredByScheduler,
			Error:       &errStr,
			ExpiresAt:   database.UpdateReminderRunExpiresAt(),
		})
		return nil, err
	}

	return result, nil
}

// QuickSend posts a one-off message to a channel or DM using the user's Slack token.
// source tags who's calling ("quick_send" or "claude_queue") for the Slack Messages hub log.
func (s *Service) QuickSend(ctx context.Context, userID, channelID, message, dmUserID, source string) (slackTS, resolvedChannelID string, err error) {
	integration, ferr := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if ferr != nil || !integration.Connected {
		return "", "", fmt.Errorf("slack not connected")
	}
	client := slacksvc.NewClient(integration.BotToken)

	if dmUserID != "" {
		ch, ts, e := client.PostDirectMessage(ctx, dmUserID, message)
		// DMs aren't shown in the channel-scoped Slack Messages hub — not logged.
		return ts, ch, e
	}
	ts, e := client.PostMessage(ctx, channelID, message)
	if e == nil {
		s.logSent(ctx, userID, source, channelID, message, ts)
	}
	return ts, channelID, e
}

func (s *Service) DeleteSlackMessage(ctx context.Context, userID, channelID, ts string) error {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return fmt.Errorf("slack not connected")
	}
	return slacksvc.NewClient(integration.BotToken).DeleteMessage(ctx, channelID, ts)
}

func (s *Service) UpdateSlackMessage(ctx context.Context, userID, channelID, ts, text string) error {
	integration, err := s.integrationRepo.GetSlackIntegration(ctx, userID)
	if err != nil || !integration.Connected {
		return fmt.Errorf("slack not connected")
	}
	return slacksvc.NewClient(integration.BotToken).UpdateMessage(ctx, channelID, ts, text)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func parseHHMM(hhmm string, day time.Time, loc *time.Location) (time.Time, error) {
	parts := strings.SplitN(hhmm, ":", 2)
	if len(parts) != 2 {
		return time.Time{}, fmt.Errorf("invalid time %q", hhmm)
	}
	var h, m int
	if _, err := fmt.Sscanf(parts[0], "%d", &h); err != nil {
		return time.Time{}, err
	}
	if _, err := fmt.Sscanf(parts[1], "%d", &m); err != nil {
		return time.Time{}, err
	}
	return time.Date(day.Year(), day.Month(), day.Day(), h, m, 0, 0, loc), nil
}

func parseKeywords(value string) []string {
	var kws []string
	for _, kw := range strings.Split(value, ",") {
		if t := strings.TrimSpace(kw); t != "" {
			kws = append(kws, strings.ToLower(t))
		}
	}
	return kws
}

func messageMatchesDetection(text string, mode models.UpdateReminderDetectionMode, keywords []string, re *regexp.Regexp) bool {
	switch mode {
	case models.DetectionModeKeywords:
		lower := strings.ToLower(text)
		for _, kw := range keywords {
			if strings.Contains(lower, kw) {
				return true
			}
		}
		return false
	case models.DetectionModePattern:
		if re == nil {
			return false
		}
		return re.MatchString(text)
	default: // any_message
		return true
	}
}

func applyLeaveAction(snap *models.UpdateReminderSnapshot, action models.UpdateReminderLeaveAction) *models.UpdateReminderSnapshot {
	if action == models.LeaveActionExclude {
		onLeaveIDs := memberSet(snap.OnLeave)
		var filtered []models.SnapshotMember
		for _, m := range snap.Missing {
			if _, onLeave := onLeaveIDs[m.SlackUserID]; !onLeave {
				filtered = append(filtered, m)
			}
		}
		return &models.UpdateReminderSnapshot{
			Posted:     snap.Posted,
			Missing:    filtered,
			OnLeave:    snap.OnLeave,
			ComputedAt: snap.ComputedAt,
		}
	}
	return snap // list_separately: keep missing as-is, template can use {on_leave_names}
}

func memberSet(members []models.SnapshotMember) map[string]models.SnapshotMember {
	m := make(map[string]models.SnapshotMember, len(members))
	for _, mem := range members {
		m[mem.SlackUserID] = mem
	}
	return m
}

func memberNames(members []models.SnapshotMember) []string {
	names := make([]string, len(members))
	for i, m := range members {
		names[i] = m.DisplayName
	}
	return names
}

// buildTemplatePattern converts a channel template into a regex that matches auto-generated
// reminder messages, so they can be skipped during mention_missing scanning.
func buildTemplatePattern(tmpl string) *regexp.Regexp {
	if tmpl == "" {
		return nil
	}
	escaped := regexp.QuoteMeta(tmpl)
	for _, ph := range []string{`\{mentions\}`, `\{names\}`, `\{date\}`, `\{count\}`, `\{on_leave_names\}`} {
		escaped = strings.ReplaceAll(escaped, ph, `.+`)
	}
	re, err := regexp.Compile(`(?s)` + escaped)
	if err != nil {
		return nil
	}
	return re
}

// extractMentions pulls all Slack user IDs from <@USER_ID> or <@USER_ID|display_name> patterns.
func extractMentions(text string) []string {
	re := regexp.MustCompile(`<@([A-Z0-9]+)(?:\|[^>]*)?>`)
	matches := re.FindAllStringSubmatch(text, -1)
	var ids []string
	for _, m := range matches {
		if len(m) > 1 {
			ids = append(ids, m[1])
		}
	}
	return ids
}
