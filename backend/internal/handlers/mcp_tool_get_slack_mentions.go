package handlers

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

var getSlackMentionsToolSchema = map[string]interface{}{
	"name": "get_slack_mentions",
	"description": "Read-only. Finds Slack messages that @mention you (the authenticated Velocity user, matched to Slack by " +
		"email) across every channel the Velocity bot is in, including mentions inside threads. Each mention says whether " +
		"you've replied in that thread since, so `awaiting_reply` lists what you still owe an answer on. Use " +
		"`unanswered_only: true` for \"what am I being asked that I haven't answered?\". Private channels you aren't in " +
		"are skipped. Does NOT post anything.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"since": map[string]string{
				"type":        "string",
				"description": "Look back window: '2h', '1d', '3d', '1w', 'today', 'yesterday' or 'YYYY-MM-DD'. Default '3d', max 30 days.",
			},
			"channel": map[string]string{
				"type":        "string",
				"description": "Optional. Only scan this channel (name or raw ID). Default: all channels the bot is in.",
			},
			"unanswered_only": map[string]string{
				"type":        "boolean",
				"description": "Only return mentions you haven't replied to (and haven't dismissed in Velocity).",
			},
			"limit": map[string]string{
				"type":        "integer",
				"description": "Max mentions to return, newest first (default 30, max 100).",
			},
		},
	},
}

const (
	mentionsDefaultSince   = "3d"
	mentionsMaxWindow      = 30 * 24 * time.Hour
	mentionsDefaultLimit   = 30
	mentionsMaxLimit       = 100
	mentionsHistoryPerChan = 1000
	// conversations.replies is Tier 3 (~50/min); stay well under it.
	mentionsMaxThreadFetch = 40
)

type mentionHit struct {
	channelID, label string
	msg              slacksvc.Message
	inThread         bool
	replied          bool
	repliedKnown     bool // false when inferred from reply_users only
}

func mcpGetSlackMentions(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Since          string `json:"since"`
		Channel        string `json:"channel"`
		UnansweredOnly bool   `json:"unanswered_only"`
		Limit          int    `json:"limit"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return rpcErr(id, -32602, "invalid arguments")
		}
	}
	limit := a.Limit
	if limit <= 0 {
		limit = mentionsDefaultLimit
	}
	if limit > mentionsMaxLimit {
		limit = mentionsMaxLimit
	}

	r, errMsg := newSlackReader(ctx, h, userID)
	if r == nil {
		return toolError(id, errMsg)
	}
	sinceArg := a.Since
	if sinceArg == "" {
		sinceArg = mentionsDefaultSince
	}
	since, err := parseSlackSince(sinceArg, r.loc)
	if err != nil {
		return toolError(id, err.Error())
	}
	if time.Since(since) > mentionsMaxWindow {
		since = time.Now().Add(-mentionsMaxWindow)
	}
	oldest := since.Unix()

	// Which channels to scan.
	type chanRef struct{ id, name string }
	var targets []chanRef
	var skipped []map[string]string
	if a.Channel != "" {
		chID, _ := h.resolveChannel(ctx, userID, a.Channel)
		if chID == "" {
			return toolError(id, "couldn't find a Slack channel matching '"+a.Channel+"'")
		}
		label, denied := r.authorize(ctx, chID)
		if denied != "" {
			return toolError(id, denied)
		}
		targets = append(targets, chanRef{chID, label})
	} else {
		chans, err := r.client.GetBotMemberChannels(ctx)
		if err != nil {
			return toolError(id, "couldn't list the channels the Velocity bot is in: "+err.Error())
		}
		for _, c := range chans {
			if c.IsPrivate {
				members, merr := r.client.GetConversationMembers(ctx, c.ID)
				if merr != nil {
					skipped = append(skipped, map[string]string{"channel": "#" + c.Name, "reason": merr.Error()})
					continue
				}
				if !containsStr(members, r.callerSlackID) {
					continue // not the caller's channel; don't even mention it
				}
			}
			targets = append(targets, chanRef{c.ID, "#" + c.Name})
		}
	}

	tag := "<@" + r.callerSlackID
	var hits []*mentionHit
	type threadRef struct {
		channelID, label, ts string
		latest               float64
		root                 *mentionHit // set when the root itself mentions the caller
	}
	var threads []threadRef
	scanned := make([]string, 0, len(targets))

	for _, c := range targets {
		msgs, _, err := r.client.GetHistoryPaged(ctx, c.id, oldest, 0, mentionsHistoryPerChan)
		if err != nil {
			skipped = append(skipped, map[string]string{"channel": c.name, "reason": err.Error()})
			continue
		}
		scanned = append(scanned, c.name)
		for _, m := range msgs {
			if m.Type != "message" || slackNoiseSubtypes[m.Subtype] {
				continue
			}
			var hit *mentionHit
			if m.User != r.callerSlackID && m.User != "USLACKBOT" && strings.Contains(m.Text, tag) {
				hit = &mentionHit{channelID: c.id, label: c.name, msg: m,
					inThread: m.ThreadTS != "" && m.ThreadTS != m.TS,
					replied:  containsStr(m.ReplyUsers, r.callerSlackID)}
				hits = append(hits, hit)
			}
			if m.ReplyCount > 0 && slackTSFloat(m.LatestReply) >= float64(oldest) {
				threads = append(threads, threadRef{c.id, c.name, m.TS, slackTSFloat(m.LatestReply), hit})
			}
		}
	}

	// Scan the most recently active threads for in-thread mentions and to
	// confirm whether the caller replied after being mentioned.
	sort.Slice(threads, func(i, j int) bool { return threads[i].latest > threads[j].latest })
	threadsScanned, threadsSkipped := 0, 0
	for _, t := range threads {
		if threadsScanned >= mentionsMaxThreadFetch {
			threadsSkipped++
			continue
		}
		replies, err := r.client.GetThreadPaged(ctx, t.channelID, t.ts, 1000)
		if err != nil {
			if strings.Contains(err.Error(), "ratelimited") {
				threadsSkipped = len(threads) - threadsScanned
				break
			}
			threadsSkipped++
			continue
		}
		threadsScanned++
		if t.root != nil {
			t.root.replied = callerRepliedAfter(replies, r.callerSlackID, t.ts)
			t.root.repliedKnown = true
		}
		for _, m := range replies {
			if m.TS == t.ts || slackTSFloat(m.TS) < float64(oldest) {
				continue
			}
			if m.User == r.callerSlackID || m.User == "USLACKBOT" || !strings.Contains(m.Text, tag) {
				continue
			}
			hits = append(hits, &mentionHit{channelID: t.channelID, label: t.label, msg: m, inThread: true,
				replied: callerRepliedAfter(replies, r.callerSlackID, m.TS), repliedKnown: true})
		}
	}

	// Mentions the user dismissed in Velocity's Slack tab count as handled.
	dismissed := map[string]bool{}
	if stored, err := database.NewSlackRepository().GetAllMentions(ctx, userID, 500); err == nil {
		for _, m := range stored {
			if m.Replied {
				dismissed[m.MessageTS] = true
			}
		}
	}

	sort.Slice(hits, func(i, j int) bool { return slackTSFloat(hits[i].msg.TS) > slackTSFloat(hits[j].msg.TS) })
	seen := map[string]bool{}
	var out []map[string]interface{}
	awaiting := 0
	for _, hit := range hits {
		key := hit.channelID + hit.msg.TS
		if seen[key] {
			continue // broadcast replies show up in both history and the thread
		}
		seen[key] = true
		isDismissed := dismissed[hit.msg.TS]
		waiting := !hit.replied && !isDismissed
		if waiting {
			awaiting++
		}
		if a.UnansweredOnly && !waiting {
			continue
		}
		if len(out) >= limit {
			continue
		}
		fm := r.formatMessage(ctx, hit.channelID, hit.msg)
		fm["channel"] = hit.label
		fm["in_thread"] = hit.inThread
		fm["you_replied"] = hit.replied
		fm["awaiting_reply"] = waiting
		fm["looks_like_question"] = strings.Contains(hit.msg.Text, "?")
		if reactedBy(hit.msg, r.callerSlackID) {
			fm["you_reacted"] = true
		}
		if isDismissed {
			fm["dismissed_in_velocity"] = true
		}
		if !hit.repliedKnown && !hit.inThread && hit.msg.ReplyCount > 0 {
			fm["reply_status_note"] = "inferred from Slack's reply_users list, thread not scanned"
		}
		out = append(out, fm)
	}

	result := map[string]interface{}{
		"slack_user":           r.callerName,
		"since":                upperAmPmTime(since.In(r.loc)),
		"channels_scanned":     scanned,
		"threads_scanned":      threadsScanned,
		"total_mentions":       len(seen),
		"awaiting_reply_count": awaiting,
		"count":                len(out),
		"order":                "newest first",
		"mentions":             out,
	}
	if threadsSkipped > 0 {
		result["threads_not_scanned"] = threadsSkipped
		result["threads_note"] = "older active threads were not scanned (rate limit budget). Narrow `since` or pass `channel` to cover them."
	}
	if len(skipped) > 0 {
		result["channels_skipped"] = skipped
	}
	result["coverage_note"] = "Covers channels the Velocity bot is a member of. Group DMs, your personal DMs with other people and @group/@here mentions are not included."
	data, _ := json.Marshal(result)
	return toolOK(id, string(data))
}

// callerRepliedAfter reports whether the caller posted in the thread after ts.
func callerRepliedAfter(thread []slacksvc.Message, callerID, ts string) bool {
	after := slackTSFloat(ts)
	for _, m := range thread {
		if m.User == callerID && slackTSFloat(m.TS) > after {
			return true
		}
	}
	return false
}

func reactedBy(m slacksvc.Message, callerID string) bool {
	for _, re := range m.Reactions {
		if containsStr(re.Users, callerID) {
			return true
		}
	}
	return false
}

func slackTSFloat(ts string) float64 {
	f, _ := strconv.ParseFloat(ts, 64)
	return f
}
