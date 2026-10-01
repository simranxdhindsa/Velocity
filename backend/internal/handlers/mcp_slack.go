package handlers

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// slackConvIDRe matches a raw Slack conversation ID: a public/private channel
// (C...), a group DM (G...), or a 1:1 DM channel (D...). These have no
// display name to look up — group DMs in particular are the only way to
// target them — so resolveChannel passes them straight through.
var slackConvIDRe = regexp.MustCompile(`^[CGD][A-Z0-9]{8,}$`)

// resolveChannel looks up a human-readable channel name (e.g. "ardoise-pm", "#general")
// and returns (channelID, "#channelName"). A raw Slack conversation ID (channel, group
// DM, or DM — anything matching slackConvIDRe) is passed through unchanged, skipping
// name resolution entirely, since group DMs have no name to resolve by. Returns ("", "")
// if name is blank or not found.
func (h *MCPHandler) resolveChannel(ctx context.Context, userID, name string) (string, string) {
	if name == "" {
		return "", ""
	}
	trimmed := strings.TrimSpace(name)
	if slackConvIDRe.MatchString(trimmed) {
		return trimmed, trimmed
	}
	name = strings.TrimPrefix(strings.ToLower(trimmed), "#")
	channels, err := h.slackSvc.GetChannels(ctx, userID)
	if err != nil {
		return "", "#" + name // store the label at least
	}
	for _, ch := range channels {
		if strings.ToLower(ch.Name) == name {
			return ch.ID, "#" + ch.Name
		}
	}
	// Not found — store empty ID so frontend shows channel picker
	return "", "#" + name
}

// resolveSlackUser looks up a user by display name or real name and returns their Slack user ID.
// Returns "" if name is blank, service fails, or user is not found.
func (h *MCPHandler) resolveSlackUser(ctx context.Context, userID, name string) string {
	if name == "" {
		return ""
	}
	users, err := h.slackSvc.GetWorkspaceUsers(ctx, userID)
	if err != nil {
		return ""
	}
	nameLower := strings.ToLower(strings.TrimSpace(name))
	for _, u := range users {
		if strings.ToLower(u.Profile.DisplayName) == nameLower ||
			strings.ToLower(u.RealName) == nameLower {
			return u.ID
		}
	}
	return ""
}

// resolveSlackMentions replaces @DisplayName tokens with Slack <@UXXX> format.
// Unknown names are left as-is so the user can correct in Velocity. Shared by the
// MCP tool path (mcp_tool_queue_slack_message.go) and the manual compose form
// (pending_messages.go).
func resolveSlackMentions(ctx context.Context, slackSvc *slacksvc.Service, userID, text string) string {
	if !strings.Contains(text, "@") {
		return text
	}
	users, err := slackSvc.GetWorkspaceUsers(ctx, userID)
	if err != nil || len(users) == 0 {
		return text
	}
	// Build name→ID map (display_name and real_name, case-insensitive). Track the
	// longest name in words so multi-word names (e.g. "Simran Dhindsa") can match.
	nameMap := make(map[string]string, len(users)*3)
	maxWords := 1
	addName := func(name, id string) {
		if name == "" {
			return
		}
		nameMap[strings.ToLower(name)] = id
		if w := len(strings.Fields(name)); w > maxWords {
			maxWords = w
		}
	}
	for _, u := range users {
		if u.ID == "" || u.IsBot || u.Deleted {
			continue
		}
		addName(u.Profile.DisplayName, u.ID)
		addName(u.RealName, u.ID)
		addName(u.Name, u.ID)
	}

	// Replace @Name tokens — try the longest space-separated run of words after @
	// first (so "@Simran Dhindsa" matches before falling back to just "@Simran").
	var result strings.Builder
	i := 0
	for i < len(text) {
		if text[i] != '@' {
			result.WriteByte(text[i])
			i++
			continue
		}
		var tokens []string
		var tokenEnds []int
		pos := i + 1
		for w := 0; w < maxWords; w++ {
			start := pos
			for pos < len(text) && text[pos] != ' ' && text[pos] != '\n' && text[pos] != ',' && text[pos] != ':' {
				pos++
			}
			if pos == start {
				break
			}
			tokens = append(tokens, text[start:pos])
			tokenEnds = append(tokenEnds, pos)
			if pos >= len(text) || text[pos] != ' ' {
				break
			}
			pos++ // skip the space, try to extend the match
		}
		matched := false
		for w := len(tokens); w >= 1; w-- {
			candidate := strings.ToLower(strings.Join(tokens[:w], " "))
			if uid, ok := nameMap[candidate]; ok {
				result.WriteString("<@" + uid + ">")
				i = tokenEnds[w-1]
				matched = true
				break
			}
		}
		if !matched {
			if len(tokens) > 0 {
				result.WriteString("@" + tokens[0]) // leave as-is
				i = tokenEnds[0]
			} else {
				result.WriteByte('@')
				i++
			}
		}
	}
	return result.String()
}

// parseFlexTime parses natural time strings ("3pm", "3:00 PM", "15:30") and
// full ISO 8601 datetimes. Returns a time on today (or tomorrow if past).
func parseFlexTime(s string, loc *time.Location) (time.Time, error) {
	s = strings.TrimSpace(s)
	if loc == nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)

	// Try ISO 8601 first (already timezone-aware via the offset in the string)
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, nil
		}
	}

	// Try time-only formats in user's timezone, rolling to tomorrow if past
	timeLayouts := []string{"3:04 PM", "3:04PM", "15:04", "3 PM", "3PM", "3pm", "15"}
	for _, layout := range timeLayouts {
		if t, err := time.ParseInLocation(layout, strings.ToUpper(s), loc); err == nil {
			candidate := time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), 0, 0, loc)
			if !candidate.After(now) {
				candidate = candidate.Add(24 * time.Hour)
			}
			return candidate, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised time format: %q", s)
}
