package handlers

import (
	"context"
	"fmt"
	"html"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// Shared helpers for the read-only Slack MCP tools (read_slack_messages,
// get_slack_mentions): caller identity, access control, mention/link
// resolution and message formatting.

// slackReader is a per-call context for reading Slack on behalf of one
// Velocity user. Caches user/bot names so a page of messages costs one
// users.list call, not one users.info per author.
type slackReader struct {
	client        *slacksvc.Client
	loc           *time.Location
	baseURL       string // workspace URL from auth.test, for permalinks
	callerSlackID string
	callerName    string
	ownDM         string // caller's DM channel with the bot, opened lazily

	users       map[string]string
	usersLoaded bool
	bots        map[string]string
	channels    map[string]string
}

// newSlackReader builds a reader for the authenticated Velocity user. The
// Slack identity is derived from the user's Velocity email (never from tool
// arguments), so one user can't read as another.
func newSlackReader(ctx context.Context, h *MCPHandler, userID string) (*slackReader, string) {
	status, err := h.slackSvc.GetStatus(ctx, userID)
	if err != nil || status == nil || !status.Connected {
		return nil, "Slack is not connected for this user. Connect it in Velocity → Integrations."
	}
	u, err := database.NewUserRepository().GetByID(ctx, userID)
	if err != nil || u == nil || u.Email == "" {
		return nil, "couldn't load your Velocity account to map it to a Slack user"
	}
	client := slacksvc.NewClient(status.BotToken)
	su, err := client.GetUserByEmail(ctx, u.Email)
	if err != nil || su == nil || su.ID == "" {
		msg := "couldn't find a Slack user with your Velocity email (" + u.Email + ")"
		if err != nil {
			msg += ": " + err.Error()
		}
		return nil, msg
	}
	// Same timezone as DayTrack/whoami (daytrack_slack_config, default
	// Asia/Kolkata). The send-settings timezone defaults to UTC.
	loc, _ := mcpDayTrackTimezone(ctx, userID)
	base, _ := client.WorkspaceURL(ctx) // permalinks are omitted if this fails
	r := &slackReader{
		client:        client,
		loc:           loc,
		baseURL:       base,
		callerSlackID: su.ID,
		users:         map[string]string{},
		bots:          map[string]string{},
		channels:      map[string]string{},
	}
	r.callerName = slackDisplayName(su)
	r.users[su.ID] = r.callerName
	return r, ""
}

func slackDisplayName(u *slacksvc.User) string {
	if u.RealName != "" {
		return u.RealName
	}
	if u.Profile.DisplayName != "" {
		return u.Profile.DisplayName
	}
	return u.Name
}

// userName resolves a Slack user ID to a display name: users.list once, then
// users.info for anything not in it (bots, deactivated accounts).
func (r *slackReader) userName(ctx context.Context, id string) string {
	if n, ok := r.users[id]; ok {
		return n
	}
	if !r.usersLoaded {
		r.usersLoaded = true
		if all, err := r.client.GetWorkspaceUsers(ctx); err == nil {
			for i := range all {
				r.users[all[i].ID] = slackDisplayName(&all[i])
			}
		}
		if n, ok := r.users[id]; ok {
			return n
		}
	}
	name := "unknown user"
	if u, err := r.client.GetUser(ctx, id); err == nil && u != nil {
		name = slackDisplayName(u)
	}
	r.users[id] = name
	return name
}

// author labels who posted a message, including bot/app posts.
func (r *slackReader) author(ctx context.Context, m slacksvc.Message) (string, bool) {
	if m.User != "" && m.BotID == "" {
		return r.userName(ctx, m.User), false
	}
	if m.Username != "" {
		return m.Username, true
	}
	if m.BotID != "" {
		if n, ok := r.bots[m.BotID]; ok {
			return n, true
		}
		name := "Slack app"
		if b, err := r.client.GetBotInfo(ctx, m.BotID); err == nil && b.Name != "" {
			name = b.Name
		}
		r.bots[m.BotID] = name
		return name, true
	}
	if m.User != "" {
		return r.userName(ctx, m.User), false
	}
	return "Slack app", true
}

var slackAngleTokenRe = regexp.MustCompile(`<([^<>]+)>`)

// resolveText rewrites Slack's wire markup into readable text: <@U123> to
// @Name, <#C123|name> to #name, <!here> to @here, <url|label> to
// "label (url)", and unescapes &amp; &lt; &gt;. No raw <@U...> tokens survive.
func (r *slackReader) resolveText(ctx context.Context, text string) string {
	out := slackAngleTokenRe.ReplaceAllStringFunc(text, func(tok string) string {
		inner := tok[1 : len(tok)-1]
		target, label := inner, ""
		if i := strings.Index(inner, "|"); i >= 0 {
			target, label = inner[:i], inner[i+1:]
		}
		switch {
		case strings.HasPrefix(target, "@"):
			return "@" + r.userName(ctx, target[1:])
		case strings.HasPrefix(target, "#"):
			if label != "" {
				return "#" + label
			}
			if n, ok := r.channels[target[1:]]; ok {
				return "#" + n
			}
			if info, err := r.client.GetConversationInfo(ctx, target[1:]); err == nil && info.Name != "" {
				r.channels[target[1:]] = info.Name
				return "#" + info.Name
			}
			return "#channel"
		case strings.HasPrefix(target, "!subteam^"):
			if label != "" {
				return label
			}
			return "@group"
		case strings.HasPrefix(target, "!"):
			if label != "" && !strings.HasPrefix(target, "!here") && !strings.HasPrefix(target, "!channel") {
				return label // e.g. <!date^...|fallback>
			}
			name := strings.TrimPrefix(target, "!")
			if i := strings.Index(name, "^"); i >= 0 {
				name = name[:i]
			}
			return "@" + name
		default:
			link := strings.TrimPrefix(target, "mailto:")
			if label != "" && label != link {
				return label + " (" + link + ")"
			}
			return link
		}
	})
	return html.UnescapeString(out)
}

// permalink builds a message link from the workspace URL (no API call).
func (r *slackReader) permalink(channelID, ts, threadTS string) string {
	if r.baseURL == "" || ts == "" {
		return ""
	}
	link := strings.TrimRight(r.baseURL, "/") + "/archives/" + channelID + "/p" + strings.Replace(ts, ".", "", 1)
	if threadTS != "" && threadTS != ts {
		link += "?thread_ts=" + threadTS + "&cid=" + channelID
	}
	return link
}

// formatTime renders a Slack ts in the user's timezone, 12-hour with AM/PM.
func (r *slackReader) formatTime(ts string) string {
	t := slackTSTime(ts)
	if t.IsZero() {
		return ""
	}
	return upperAmPmTime(t.In(r.loc))
}

// upperAmPmTime formats a time 12-hour with AM/PM, adding the year only when
// it isn't the current one.
func upperAmPmTime(t time.Time) string {
	if t.Year() != time.Now().In(t.Location()).Year() {
		return t.Format("Mon Jan 2 2006, 3:04 PM")
	}
	return t.Format("Mon Jan 2, 3:04 PM")
}

func slackTSTime(ts string) time.Time {
	f, err := strconv.ParseFloat(ts, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(int64(f), 0)
}

// slackNoiseSubtypes are system messages that add nothing to a read.
var slackNoiseSubtypes = map[string]bool{"channel_join": true, "channel_leave": true, "group_join": true, "group_leave": true}

// formatMessage turns a raw Slack message into the tool's output shape.
func (r *slackReader) formatMessage(ctx context.Context, channelID string, m slacksvc.Message) map[string]interface{} {
	name, isBot := r.author(ctx, m)
	text := m.Text
	if text == "" && len(m.Attachments) > 0 {
		text = m.Attachments[0].Fallback
	}
	out := map[string]interface{}{
		"author":    name,
		"time":      r.formatTime(m.TS),
		"ts":        m.TS,
		"text":      r.resolveText(ctx, text),
		"permalink": r.permalink(channelID, m.TS, m.ThreadTS),
	}
	if isBot {
		out["is_bot"] = true
	}
	if m.ThreadTS != "" && m.ThreadTS != m.TS {
		out["thread_ts"] = m.ThreadTS
	}
	if m.ReplyCount > 0 {
		out["reply_count"] = m.ReplyCount
	}
	if len(m.Reactions) > 0 {
		var rs []string
		for _, re := range m.Reactions {
			rs = append(rs, fmt.Sprintf(":%s: x%d", re.Name, re.Count))
		}
		out["reactions"] = rs
	}
	if len(m.Files) > 0 {
		var fs []string
		for _, f := range m.Files {
			n := f.Name
			if n == "" {
				n = f.Title
			}
			fs = append(fs, n)
		}
		out["files"] = fs
	}
	return out
}

// authorize checks the caller may read a conversation and returns a label
// for it. Rules: public channels the bot is in are readable by any Velocity
// user; private channels and group DMs only if the caller is a member; DMs
// only if it is the caller's own DM with the Velocity bot (never someone
// else's DM with the bot).
func (r *slackReader) authorize(ctx context.Context, channelID string) (string, string) {
	if strings.HasPrefix(channelID, "D") {
		return r.authorizeOwnDM(ctx, channelID)
	}
	info, err := r.client.GetConversationInfo(ctx, channelID)
	if err != nil {
		if strings.Contains(err.Error(), "channel_not_found") {
			return "", "the Velocity bot can't see conversation " + channelID + " (channel_not_found). It may not exist, or the bot isn't a member."
		}
		return "", "couldn't look up conversation " + channelID + ": " + err.Error()
	}
	if info.IsIM {
		return r.authorizeOwnDM(ctx, channelID)
	}
	label := "#" + info.Name
	if info.IsMPIM {
		label = "group DM " + channelID
	}
	if info.IsPrivate || info.IsMPIM {
		members, merr := r.client.GetConversationMembers(ctx, channelID)
		if merr != nil {
			return "", "couldn't verify you're a member of " + label + ": " + merr.Error()
		}
		if !containsStr(members, r.callerSlackID) {
			return "", "you're not a member of " + label + ", so Velocity won't show its messages to you"
		}
	}
	if !info.IsMember && !info.IsMPIM {
		return "", "the Velocity bot isn't a member of " + label + ". Invite it in Slack with /invite to read it."
	}
	return label, ""
}

func (r *slackReader) authorizeOwnDM(ctx context.Context, channelID string) (string, string) {
	own, err := r.ownDMChannel(ctx)
	if err != nil {
		return "", "couldn't open your DM with the Velocity bot: " + err.Error()
	}
	if channelID != own {
		return "", "that DM isn't yours. You can only read your own DM with the Velocity bot (other people's DMs are private)."
	}
	return "DM with Velocity bot", ""
}

func (r *slackReader) ownDMChannel(ctx context.Context) (string, error) {
	if r.ownDM != "" {
		return r.ownDM, nil
	}
	id, err := r.client.OpenDirectMessageChannel(ctx, r.callerSlackID)
	if err != nil {
		return "", err
	}
	r.ownDM = id
	return id, nil
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

var slackRelSinceRe = regexp.MustCompile(`^(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days|w|wk|weeks?)$`)

// parseSlackSince parses '30m', '2h', '1d', '1w', 'today', 'yesterday',
// 'YYYY-MM-DD' (midnight in the user's timezone) or RFC3339. Empty means no
// lower bound (zero time).
func parseSlackSince(s string, loc *time.Location) (time.Time, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return time.Time{}, nil
	}
	now := time.Now().In(loc)
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	switch s {
	case "today":
		return midnight, nil
	case "yesterday":
		return midnight.AddDate(0, 0, -1), nil
	}
	if m := slackRelSinceRe.FindStringSubmatch(s); m != nil {
		n, _ := strconv.Atoi(m[1])
		unit := map[byte]time.Duration{'m': time.Minute, 'h': time.Hour, 'd': 24 * time.Hour, 'w': 7 * 24 * time.Hour}[m[2][0]]
		return now.Add(-time.Duration(n) * unit), nil
	}
	if t, err := time.ParseInLocation("2006-01-02", s, loc); err == nil {
		return t, nil
	}
	if t, err := time.Parse(time.RFC3339, strings.ToUpper(s)); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("unrecognised since value %q. Use e.g. '2h', '1d', '1w', 'today' or 'YYYY-MM-DD'", s)
}
