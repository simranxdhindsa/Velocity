package slack

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Read-only Slack Web API helpers used by the MCP read tools
// (read_slack_messages, get_slack_mentions). Kept separate from client.go so
// that file stays focused on the send path and under the size limit.

// Reaction is one emoji reaction on a message, as returned inline by
// conversations.history / conversations.replies (no reactions:read needed).
type Reaction struct {
	Name  string   `json:"name"`
	Count int      `json:"count"`
	Users []string `json:"users,omitempty"`
}

// File is the minimal metadata of a file shared in a message.
type File struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Title string `json:"title"`
}

// ConversationInfo is the subset of conversations.info the read tools need
// for access control.
type ConversationInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsChannel bool   `json:"is_channel"`
	IsGroup   bool   `json:"is_group"`
	IsIM      bool   `json:"is_im"`
	IsMPIM    bool   `json:"is_mpim"`
	IsPrivate bool   `json:"is_private"`
	IsMember  bool   `json:"is_member"`
	User      string `json:"user,omitempty"` // IM only: the other party
}

// slackReadError turns a not-ok Slack response into an error, naming the
// missing OAuth scope when Slack reports one, so callers can surface it
// honestly instead of returning empty data.
func slackReadError(code, needed string) error {
	if code == "missing_scope" && needed != "" {
		return fmt.Errorf("slack API error: missing_scope (bot token needs the %s scope)", needed)
	}
	return fmt.Errorf("slack API error: %s", code)
}

type readResponse struct {
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
	Needed   string `json:"needed,omitempty"`
	Metadata struct {
		NextCursor string `json:"next_cursor"`
	} `json:"response_metadata"`
}

// WorkspaceURL returns the workspace's base URL (e.g.
// "https://apyhub.slack.com/") from auth.test, used to build permalinks
// without a chat.getPermalink call per message.
func (c *Client) WorkspaceURL(ctx context.Context) (string, error) {
	body, err := c.doRequest(ctx, http.MethodPost, "/auth.test", nil)
	if err != nil {
		return "", err
	}
	var resp struct {
		readResponse
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("failed to unmarshal auth.test: %w", err)
	}
	if !resp.OK {
		return "", slackReadError(resp.Error, resp.Needed)
	}
	return resp.URL, nil
}

// GetConversationInfo returns basic info about a conversation
// (conversations.info). Needs channels:read / groups:read, plus im:read or
// mpim:read for DMs and group DMs.
func (c *Client) GetConversationInfo(ctx context.Context, channelID string) (*ConversationInfo, error) {
	params := url.Values{}
	params.Set("channel", channelID)
	body, err := c.doGetRequest(ctx, "/conversations.info", params)
	if err != nil {
		return nil, err
	}
	var resp struct {
		readResponse
		Channel ConversationInfo `json:"channel"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal conversations.info: %w", err)
	}
	if !resp.OK {
		return nil, slackReadError(resp.Error, resp.Needed)
	}
	return &resp.Channel, nil
}

// GetConversationMembers returns every member user ID of a conversation
// (conversations.members, paginated).
func (c *Client) GetConversationMembers(ctx context.Context, channelID string) ([]string, error) {
	var all []string
	cursor := ""
	for {
		params := url.Values{}
		params.Set("channel", channelID)
		params.Set("limit", "1000")
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		body, err := c.doGetRequest(ctx, "/conversations.members", params)
		if err != nil {
			return nil, err
		}
		var resp struct {
			readResponse
			Members []string `json:"members"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			return nil, fmt.Errorf("failed to unmarshal conversations.members: %w", err)
		}
		if !resp.OK {
			return nil, slackReadError(resp.Error, resp.Needed)
		}
		all = append(all, resp.Members...)
		if resp.Metadata.NextCursor == "" {
			return all, nil
		}
		cursor = resp.Metadata.NextCursor
	}
}

// GetBotMemberChannels returns the public and private channels the bot is a
// member of (users.conversations, paginated). DMs and group DMs are not
// included: listing those needs im:read / mpim:read.
func (c *Client) GetBotMemberChannels(ctx context.Context) ([]Channel, error) {
	var all []Channel
	cursor := ""
	for {
		params := url.Values{}
		params.Set("types", "public_channel,private_channel")
		params.Set("exclude_archived", "true")
		params.Set("limit", "1000")
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		body, err := c.doGetRequest(ctx, "/users.conversations", params)
		if err != nil {
			return nil, err
		}
		var resp struct {
			readResponse
			Channels []Channel `json:"channels"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			return nil, fmt.Errorf("failed to unmarshal users.conversations: %w", err)
		}
		if !resp.OK {
			return nil, slackReadError(resp.Error, resp.Needed)
		}
		all = append(all, resp.Channels...)
		if resp.Metadata.NextCursor == "" {
			return all, nil
		}
		cursor = resp.Metadata.NextCursor
	}
}

// GetHistoryPaged returns up to max top-level messages (newest first) from a
// conversation, following pagination. oldest/latest are Unix seconds, 0 for
// unbounded. hasMore reports whether older messages were left unread.
func (c *Client) GetHistoryPaged(ctx context.Context, channelID string, oldest, latest int64, max int) (msgs []Message, hasMore bool, err error) {
	// With only `oldest` set, Slack pages from the oldest end of the window, so
	// a limit would return the earliest messages instead of the newest. Bounding
	// it with latest=now keeps the newest-first order.
	if oldest > 0 && latest == 0 {
		latest = time.Now().Unix() + 1
	}
	cursor := ""
	for len(msgs) < max {
		page := max - len(msgs)
		if page > 200 {
			page = 200
		}
		params := url.Values{}
		params.Set("channel", channelID)
		params.Set("limit", fmt.Sprintf("%d", page))
		if oldest > 0 {
			params.Set("oldest", fmt.Sprintf("%d", oldest))
		}
		if latest > 0 {
			params.Set("latest", fmt.Sprintf("%d", latest))
		}
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		body, gerr := c.doGetRequest(ctx, "/conversations.history", params)
		if gerr != nil {
			return msgs, false, gerr
		}
		var resp struct {
			readResponse
			Messages []Message `json:"messages"`
			HasMore  bool      `json:"has_more"`
		}
		if uerr := json.Unmarshal(body, &resp); uerr != nil {
			return msgs, false, fmt.Errorf("failed to unmarshal conversations.history: %w", uerr)
		}
		if !resp.OK {
			return msgs, false, slackReadError(resp.Error, resp.Needed)
		}
		msgs = append(msgs, resp.Messages...)
		hasMore = resp.HasMore
		if !resp.HasMore || resp.Metadata.NextCursor == "" {
			break
		}
		cursor = resp.Metadata.NextCursor
	}
	if len(msgs) > max {
		msgs = msgs[:max]
		hasMore = true
	}
	return msgs, hasMore, nil
}

// GetThreadPaged returns a thread's root message plus up to max replies
// (conversations.replies, oldest first, paginated). Unlike GetThreadReplies
// it surfaces missing_scope details.
func (c *Client) GetThreadPaged(ctx context.Context, channelID, threadTS string, max int) ([]Message, error) {
	var all []Message
	seen := map[string]bool{} // Slack repeats the root message on every page
	cursor := ""
	for len(all) < max {
		params := url.Values{}
		params.Set("channel", channelID)
		params.Set("ts", threadTS)
		params.Set("limit", "200")
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		body, err := c.doGetRequest(ctx, "/conversations.replies", params)
		if err != nil {
			return all, err
		}
		var resp struct {
			readResponse
			Messages []Message `json:"messages"`
			HasMore  bool      `json:"has_more"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			return all, fmt.Errorf("failed to unmarshal conversations.replies: %w", err)
		}
		if !resp.OK {
			return all, slackReadError(resp.Error, resp.Needed)
		}
		for _, m := range resp.Messages {
			if !seen[m.TS] {
				seen[m.TS] = true
				all = append(all, m)
			}
		}
		if !resp.HasMore || resp.Metadata.NextCursor == "" {
			break
		}
		cursor = resp.Metadata.NextCursor
	}
	if len(all) > max {
		all = all[:max]
	}
	return all, nil
}
