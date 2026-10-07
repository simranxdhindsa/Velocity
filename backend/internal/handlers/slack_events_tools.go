package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// Slack bot function tools (offered to Groq by groqFunnyReply in
// slack_events.go) and their execution against the real YouTrack client.

// slackBotTools are the function tools offered to Groq so it can look up
// real YouTrack ticket data instead of inventing it, same underlying client
// as the get_youtrack_ticket/search_youtrack_tickets MCP tools.
var slackBotTools = []map[string]interface{}{
	{
		"type": "function",
		"function": map[string]interface{}{
			"name":        "search_tickets",
			"description": "Search YouTrack tickets by free-text keyword, assignee name, or status. Use when asked about tickets in general, not a single known ID.",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{
						"type":        "string",
						"description": "Free text search terms, e.g. a title keyword, assignee name, or status like 'open'",
					},
				},
			},
		},
	},
	{
		"type": "function",
		"function": map[string]interface{}{
			"name":        "get_ticket",
			"description": "Get full details for one specific ticket by its ID, e.g. ARD-123.",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"id_readable": map[string]interface{}{
						"type":        "string",
						"description": "The ticket ID, e.g. ARD-123",
					},
				},
				"required": []string{"id_readable"},
			},
		},
	},
	{
		"type": "function",
		"function": map[string]interface{}{
			"name": "check_message_history",
			"description": "Check Velocity's own Slack message history and send queue (Update Reminders / Claude Queue). " +
				"Use when asked whether a message was already sent, what was recently sent, or whether something is " +
				"still queued or scheduled to go out.",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{
						"type":        "string",
						"description": "Optional keyword to search for in the message text or channel/person name, e.g. 'standup' or 'Rohit'. Leave empty for just the most recent.",
					},
				},
			},
		},
	},
}

type groqMessage struct {
	Role       string         `json:"role"`
	Content    string         `json:"content"`
	ToolCalls  []groqToolCall `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
}

type groqToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// slackYTClient resolves a YouTrack client the same way the MCP tools do
// (mcpYTClient in mcp.go), minus the per-user integration lookup since the
// Slack bot has no authenticated user context — falls through to global
// settings, then env vars.
func slackYTClient(ctx context.Context) *youtrack.Client {
	return mcpYTClient(ctx, "")
}

// executeSlackBotTool runs one Groq-requested tool call against the real
// YouTrack client, logs the outcome (console + mcp_activity_log, reusing the
// same shared table/UI as the MCP server's own activity log in
// mcp_dispatch.go), and returns a plain-text result to feed back to the
// model.
func executeSlackBotTool(ctx context.Context, name, argsJSON, actorLabel string) string {
	start := time.Now()
	result, success := executeSlackBotToolInner(ctx, name, argsJSON)
	elapsed := time.Since(start).Round(time.Millisecond)

	mark := "✓"
	if !success {
		mark = "✗"
	}
	log.Printf("[Slack Bot] %s %s(%s) for %s (%s): %s", mark, name, truncateText(argsJSON, 60), actorLabel, elapsed, truncateText(result, 150))

	logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := mcpActivityRepo.Log(logCtx, database.MCPActivityEntry{
		ToolName:    "slack_bot_" + name,
		ActionLabel: slackBotToolActionLabel(name) + " (" + actorLabel + ")",
		Summary:     truncateText(result, 200),
		Success:     success,
		DurationMs:  int(elapsed.Milliseconds()),
	}); err != nil {
		log.Printf("[Slack Bot] ⚠ failed to record activity log entry: %v", err)
	}
	return result
}

// slackBotToolActionLabel gives each Slack bot tool a human-readable label
// for the shared mcp_activity_log UI, mirroring the MCP server's own
// per-tool action labels.
func slackBotToolActionLabel(name string) string {
	switch name {
	case "search_tickets":
		return "Slack Bot searched tickets"
	case "get_ticket":
		return "Slack Bot fetched ticket"
	case "check_message_history":
		return "Slack Bot checked message history"
	default:
		return "Slack Bot tool call"
	}
}

// executeSlackBotToolInner does the actual work for executeSlackBotTool and
// reports an explicit success flag based on what actually happened, rather
// than leaving the caller to infer success/failure from the result string.
func executeSlackBotToolInner(ctx context.Context, name string, argsJSON string) (string, bool) {
	client := slackYTClient(ctx)
	if client == nil {
		return "YouTrack is not configured, ticket lookups are unavailable right now.", false
	}

	switch name {
	case "search_tickets":
		var args struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal([]byte(argsJSON), &args)
		yql := strings.TrimSpace(args.Query)
		if yql == "" {
			yql = "project: " + client.GetProjectID()
		}
		issues, err := client.SearchIssues(ctx, yql, 5)
		if err != nil {
			return fmt.Sprintf("Search failed: %v", err), false
		}
		if len(issues) == 0 {
			return "No matching tickets found.", true
		}
		var sb strings.Builder
		for _, is := range issues {
			fmt.Fprintf(&sb, "%s: %s (status: %s, priority: %s)\n", is.IDReadable, is.Summary, youtrack.GetStatus(is), youtrack.GetPriority(is))
		}
		return sb.String(), true

	case "get_ticket":
		var args struct {
			IDReadable string `json:"id_readable"`
		}
		_ = json.Unmarshal([]byte(argsJSON), &args)
		idReadable := strings.TrimSpace(args.IDReadable)
		if idReadable == "" {
			return "No ticket ID provided.", false
		}
		issue, err := client.GetIssue(ctx, idReadable)
		if err != nil {
			return fmt.Sprintf("Could not find ticket %s: %v", idReadable, err), false
		}
		assigneeName := "unassigned"
		if assignee := youtrack.GetAssignee(*issue); assignee != nil {
			assigneeName = assignee.FullName
		}
		out := fmt.Sprintf("%s: %s\nStatus: %s\nPriority: %s\nAssignee: %s\nDescription: %s",
			issue.IDReadable, issue.Summary, youtrack.GetStatus(*issue), youtrack.GetPriority(*issue), assigneeName, truncateText(issue.Description, 500))
		return out + slackBotRecentComments(ctx, client, issue.ID), true

	case "check_message_history":
		var args struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal([]byte(argsJSON), &args)
		query := strings.TrimSpace(args.Query)

		pending, perr := database.NewPendingMessagesRepository().ListRecentAll(ctx, query, 8)
		sent, serr := database.NewSentSlackMessagesRepository().ListRecentAll(ctx, query, 8)
		if perr != nil && serr != nil {
			return "Could not check message history right now.", false
		}

		var sb strings.Builder
		if len(pending) > 0 {
			sb.WriteString("Queued or scheduled:\n")
			for _, m := range pending {
				when := "no schedule set, sends at the default time"
				if m.ScheduledAt != nil {
					when = m.ScheduledAt.Format("Jan 2 3:04pm")
				}
				dest := m.ChannelLabel
				if dest == "" {
					dest = "a DM"
				}
				fmt.Fprintf(&sb, "- [%s] to %s: %s (%s)\n", m.Status, dest, truncateText(m.Message, 120), when)
			}
		}
		if len(sent) > 0 {
			sb.WriteString("Already sent:\n")
			for _, m := range sent {
				dest := m.ChannelLabel
				if dest == "" {
					dest = "a DM"
				}
				fmt.Fprintf(&sb, "- %s to %s: %s\n", m.SentAt.Format("Jan 2 3:04pm"), dest, truncateText(m.Message, 120))
			}
		}
		if sb.Len() == 0 {
			return "No matching sent or queued messages found.", true
		}
		return sb.String(), true

	default:
		return "Unknown tool.", false
	}
}

// slackBotRecentComments renders the last few comments as compact text so the
// bot can answer "is this resolved / who's pending" without blowing up its
// context. Text only, no images. Lookup failures are silently omitted.
func slackBotRecentComments(ctx context.Context, client *youtrack.Client, issueID string) string {
	const keep, maxLen = 5, 300
	comments, err := client.GetIssueDiscussion(ctx, issueID)
	if err != nil || len(comments) == 0 {
		return "\nComments: none"
	}
	total := len(comments)
	if total > keep {
		comments = comments[total-keep:]
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "\nComments (last %d of %d, oldest first):", len(comments), total)
	for _, c := range comments {
		who := "unknown"
		if c.Author != nil && c.Author.FullName != "" {
			who = c.Author.FullName
		}
		text := strings.Join(strings.Fields(youtrack.ReplaceInlineImageRefs(c.Text)), " ")
		fmt.Fprintf(&sb, "\n- %s, %s: %s", who, time.UnixMilli(c.Created).Format("Jan 2 3:04pm"), truncateText(text, maxLen))
	}
	return sb.String()
}

func truncateText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
