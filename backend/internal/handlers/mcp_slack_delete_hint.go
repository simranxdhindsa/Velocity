package handlers

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

// sentElsewhereHint is appended to delete/edit_slack_message's "couldn't find" error. When
// the message isn't in the destination Claude looked in, it lists Velocity's recent
// sends to other destinations (matching `needle` first, if given) with the exact
// channel/dm_user value to retry with, so Claude can say where the message actually
// went instead of asking for a permalink. Read-only: it never deletes anything itself.
// excludeChannelID / excludeDmUserID identify the destination already searched.
func (h *MCPHandler) sentElsewhereHint(ctx context.Context, userID, verb, needle, excludeChannelID, excludeDmUserID, searchedLabel string) string {
	// Always say how to target an unlogged message: DMs sent before 27 Oct 2026 were
	// never recorded, so they can exist in Slack yet not match here.
	linkTip := " If the user says it was sent to " + searchedLabel + ", it may predate Velocity recording DMs " +
		"(before 27 Oct 2026): ask for its Slack link (Copy link) and pass it as `link`. Do not tell the user it was never sent."
	rows, err := h.msgRepo.ListByUser(ctx, userID)
	if err != nil || len(rows) == 0 {
		return linkTip
	}
	needle = strings.ToLower(strings.TrimSpace(needle))

	var matches, recent []database.PendingSlackMessage
	for _, r := range rows {
		if r.Status != "sent" || r.SlackTs == "" {
			continue
		}
		if (excludeDmUserID != "" && r.DmUserID == excludeDmUserID) ||
			(excludeChannelID != "" && r.ChannelID == excludeChannelID) {
			continue
		}
		if needle != "" && strings.Contains(strings.ToLower(r.Message), needle) {
			matches = append(matches, r)
		} else if len(recent) < 3 {
			recent = append(recent, r)
		}
	}
	list, intro := matches, "Velocity sent a matching message somewhere else:"
	if len(list) == 0 {
		if len(recent) == 0 {
			return linkTip
		}
		list, intro = recent, "Velocity's recent sends to other places (this list leaves out "+searchedLabel+" itself, it is not a full history):"
	}
	if len(list) > 3 {
		list = list[:3]
	}

	channelNames, userNames := h.slackNameMaps(ctx, userID)
	var b strings.Builder
	b.WriteString(" " + intro)
	for _, r := range list {
		dest, retry := describeSendDestination(r, channelNames, userNames)
		at := r.CreatedAt
		if r.SentAt != nil {
			at = *r.SentAt
		}
		fmt.Fprintf(&b, "\n- %s, %s: \"%s\" (to %s it, retry with %s)", dest, sendAgo(at), previewText(r.Message, 80), verb, retry)
	}
	b.WriteString("\nTell the user where the message actually went before changing anything.")
	b.WriteString(linkTip)
	return b.String()
}

// slackNameMaps returns channel ID → name and user ID → display name for labelling
// sends. Either map may be empty if Slack can't be reached.
func (h *MCPHandler) slackNameMaps(ctx context.Context, userID string) (map[string]string, map[string]string) {
	channels := map[string]string{}
	if list, err := h.slackSvc.GetChannels(ctx, userID); err == nil {
		for _, c := range list {
			channels[c.ID] = c.Name
		}
	}
	users := map[string]string{}
	if list, err := h.slackSvc.GetWorkspaceUsers(ctx, userID); err == nil {
		for _, u := range list {
			name := u.Profile.DisplayName
			if name == "" {
				name = u.RealName
			}
			users[u.ID] = name
		}
	}
	return channels, users
}

// describeSendDestination labels where a queued send went ("#project-managers",
// "DM with Rohit") and the argument Claude should retry delete_slack_message with.
func describeSendDestination(r database.PendingSlackMessage, channels, users map[string]string) (dest, retry string) {
	if r.DmUserID != "" {
		name := users[r.DmUserID]
		if name == "" {
			return "a DM (Slack user " + r.DmUserID + ")", "the recipient's name as dm_user"
		}
		return "DM with " + name, "dm_user: '" + name + "'"
	}
	if name, ok := channels[r.ChannelID]; ok {
		return "#" + name, "channel: '" + name + "'"
	}
	label := r.ChannelLabel
	if label == "" {
		label = r.ChannelID
	}
	return label, "channel: '" + r.ChannelID + "'"
}

func previewText(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		return strings.TrimSpace(string(r[:max])) + "…"
	}
	return s
}

func sendAgo(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
