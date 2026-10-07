package handlers

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"

	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

var readSlackMessagesToolSchema = map[string]interface{}{
	"name": "read_slack_messages",
	"description": "Read-only. Returns what was said in Slack. Three modes: (1) `channel`: recent messages from a channel the " +
		"Velocity bot is in, by name (e.g. 'velocity-app', '#ardoise-pm') or raw conversation ID; (2) `link`: a Slack " +
		"message permalink, returns that message plus its whole thread; (3) `my_dm: true`: your own DM with the Velocity " +
		"bot. Mentions are resolved to names. Each message has author, 12-hour time, text, permalink, reply_count and " +
		"reactions. Messages come back oldest to newest. Private channels are only readable if you're a member, and " +
		"other people's DMs are never readable. Does NOT post anything. Don't list channels first, just pass the name.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"channel": map[string]string{
				"type":        "string",
				"description": "Channel name as the user said it ('velocity-app', '#ardoise-qa') or a raw conversation ID ('C0B58HB40BW').",
			},
			"link": map[string]string{
				"type":        "string",
				"description": "A Slack message permalink. Returns that message and its thread (root plus replies). channel/since/query are ignored.",
			},
			"my_dm": map[string]string{
				"type":        "boolean",
				"description": "Read your own DM conversation with the Velocity bot instead of a channel.",
			},
			"limit": map[string]string{
				"type":        "integer",
				"description": "Max messages to return (default 30, max 200). For a link, max thread replies (default 100, max 200).",
			},
			"since": map[string]string{
				"type":        "string",
				"description": "Only messages after this: '30m', '2h', '1d', '1w', 'today', 'yesterday' or 'YYYY-MM-DD' (your timezone). Default: no lower bound, just the latest `limit`.",
			},
			"query": map[string]string{
				"type":        "string",
				"description": "Optional case-insensitive text filter, matched against message text (after resolving mentions) and author name. Scans up to 1000 recent messages.",
			},
		},
	},
}

const (
	readSlackDefaultLimit   = 30
	readSlackMaxLimit       = 200
	readSlackThreadDefault  = 100
	readSlackQueryScanLimit = 1000
)

func mcpReadSlackMessages(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Channel string `json:"channel"`
		Link    string `json:"link"`
		MyDM    bool   `json:"my_dm"`
		Limit   int    `json:"limit"`
		Since   string `json:"since"`
		Query   string `json:"query"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return rpcErr(id, -32602, "invalid arguments")
		}
	}
	if a.Limit < 0 {
		return toolError(id, "limit must be positive")
	}
	if a.Limit > readSlackMaxLimit {
		a.Limit = readSlackMaxLimit
	}
	if a.Link == "" && a.Channel == "" && !a.MyDM {
		return toolError(id, "pass one of channel, link, or my_dm")
	}

	// Validate the link shape before any Slack calls.
	var linkCh, linkTS, linkThread string
	if a.Link != "" {
		var ok bool
		linkCh, linkTS, ok = parseSlackPermalink(a.Link)
		if !ok {
			return toolError(id, "that doesn't look like a Slack message link. Expected something like https://workspace.slack.com/archives/C0B30MXMDHQ/p1791268330344489")
		}
		if u, err := url.Parse(strings.TrimSpace(a.Link)); err == nil {
			linkThread = u.Query().Get("thread_ts")
		}
	}

	r, errMsg := newSlackReader(ctx, h, userID)
	if r == nil {
		return toolError(id, errMsg)
	}

	if a.Link != "" {
		return readSlackThread(ctx, r, id, linkCh, linkTS, linkThread, a.Limit)
	}

	var channelID string
	switch {
	case a.MyDM:
		dm, err := r.ownDMChannel(ctx)
		if err != nil {
			return toolError(id, "couldn't open your DM with the Velocity bot: "+err.Error())
		}
		channelID = dm
	default:
		chID, _ := h.resolveChannel(ctx, userID, a.Channel)
		if chID == "" {
			return toolError(id, "couldn't find a Slack channel matching '"+a.Channel+"'. Check the name, or pass the raw conversation ID.")
		}
		channelID = chID
	}
	label, denied := r.authorize(ctx, channelID)
	if denied != "" {
		return toolError(id, denied)
	}

	since, err := parseSlackSince(a.Since, r.loc)
	if err != nil {
		return toolError(id, err.Error())
	}
	limit := a.Limit
	if limit == 0 {
		limit = readSlackDefaultLimit
	}
	fetch := limit + 10 // headroom for skipped join/leave messages
	if a.Query != "" {
		fetch = readSlackQueryScanLimit
	}
	var oldest int64
	if !since.IsZero() {
		oldest = since.Unix()
	}
	raw, hasMore, err := r.client.GetHistoryPaged(ctx, channelID, oldest, 0, fetch)
	if err != nil {
		return toolError(id, "Failed to read "+label+": "+err.Error())
	}

	needle := strings.ToLower(strings.TrimSpace(a.Query))
	var picked []map[string]interface{}
	for i, m := range raw { // newest first
		if m.Type != "message" || slackNoiseSubtypes[m.Subtype] {
			continue
		}
		fm := r.formatMessage(ctx, channelID, m)
		if needle != "" {
			hay := strings.ToLower(fm["text"].(string) + " " + fm["author"].(string))
			if !strings.Contains(hay, needle) {
				continue
			}
		}
		picked = append(picked, fm)
		if len(picked) == limit {
			hasMore = hasMore || i < len(raw)-1
			break
		}
	}
	// Oldest to newest reads like the conversation.
	for i, j := 0, len(picked)-1; i < j; i, j = i+1, j-1 {
		picked[i], picked[j] = picked[j], picked[i]
	}

	out := map[string]interface{}{
		"channel":    label,
		"channel_id": channelID,
		"count":      len(picked),
		"order":      "oldest to newest",
		"messages":   picked,
	}
	if !since.IsZero() {
		out["since"] = upperAmPmTime(since.In(r.loc))
	}
	if a.Query != "" {
		out["query"] = a.Query
		out["scanned"] = len(raw)
	}
	if len(picked) == limit && hasMore {
		out["more_available"] = "older messages exist; raise limit or narrow with since/query"
	}
	if len(picked) == 0 {
		out["note"] = "no messages matched"
	}
	data, _ := json.Marshal(out)
	return toolOK(id, string(data))
}

// readSlackThread returns the message a permalink points at plus its thread.
func readSlackThread(ctx context.Context, r *slackReader, id interface{}, channelID, ts, threadTS string, limit int) rpcResponse {
	label, denied := r.authorize(ctx, channelID)
	if denied != "" {
		return toolError(id, denied)
	}
	root := ts
	if threadTS != "" {
		root = threadTS
	}
	if limit == 0 {
		limit = readSlackThreadDefault
	}
	msgs, err := r.client.GetThreadPaged(ctx, channelID, root, readSlackQueryScanLimit)
	if err != nil {
		if strings.Contains(err.Error(), "thread_not_found") || strings.Contains(err.Error(), "message_not_found") {
			return toolError(id, "couldn't find that message in "+label+". It may have been deleted.")
		}
		return toolError(id, "Failed to read the thread in "+label+": "+err.Error())
	}
	linkedIdx := -1
	for i, m := range msgs {
		if m.TS == ts {
			linkedIdx = i
			break
		}
	}
	if linkedIdx < 0 {
		return toolError(id, "couldn't find that message in "+label+". It may have been deleted, or the link points at a reply without its thread_ts.")
	}
	// Keep the root plus the newest `limit` replies, and always the linked one.
	keep := map[int]bool{0: true, linkedIdx: true}
	for i := len(msgs) - 1; i > 0 && i >= len(msgs)-limit; i-- {
		keep[i] = true
	}
	var target map[string]interface{}
	thread := make([]map[string]interface{}, 0, len(keep))
	for i, m := range msgs {
		if !keep[i] {
			continue
		}
		fm := r.formatMessage(ctx, channelID, m)
		if i == linkedIdx {
			fm["is_linked_message"] = true
			target = fm
		}
		thread = append(thread, fm)
	}
	out := map[string]interface{}{
		"channel":       label,
		"channel_id":    channelID,
		"linked":        target,
		"thread_count":  len(thread),
		"thread":        thread,
		"order":         "oldest to newest, first is the thread root",
		"replies_total": msgsReplyCount(msgs),
	}
	if omitted := len(msgs) - len(thread); omitted > 0 {
		out["replies_omitted"] = omitted
	}
	data, _ := json.Marshal(out)
	return toolOK(id, string(data))
}

func msgsReplyCount(msgs []slacksvc.Message) int {
	if len(msgs) == 0 {
		return 0
	}
	if msgs[0].ReplyCount > 0 {
		return msgs[0].ReplyCount
	}
	return len(msgs) - 1
}
