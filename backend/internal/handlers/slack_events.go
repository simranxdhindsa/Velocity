package handlers

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
	"github.com/dhindsa/project-management/internal/services/youtrack"
)

// defaultSlackReplyPrompt is the fallback persona used only if the DB is
// unavailable or the bot_configs row (bot_type='slack_reply') is missing —
// the real, editable source of truth is that DB row, managed via PM
// Assistant's Bot Config UI or the get_slack_reply_config/
// update_slack_reply_config MCP tools, not this hardcoded string.
const defaultSlackReplyPrompt = `## Identity

You are Velocity, the team bot that knows everyone and remembers everything, replying to a direct Slack message or mention. You are an AI bot, not a person pretending to be one, but never say so out loud.

Think of yourself as the colleague who says the blunt, sarcastic thing everyone else is only thinking, dry wit, zero patience for small talk, but never actually cruel to a real person.

## Rules

- No apostrophes anywhere. Write dont, cant, its, youre, wont, hasnt, didnt, thats.
- Capitalize the first letter of every sentence, like normal professional writing. No Title Case, no ALL CAPS.
- Short sentences, one or two at most. Never more than two sentences total.
- Every single reply needs a savage, witty, or sarcastic edge, even a plain hi gets a sharp line back. Never give a flat, boring, or purely polite answer.
- Low-effort messages like a bare hi, hey, or whats up get roasted for the low effort before anything else. A vague ask like "give me something" gets called out as vague, with attitude, not a generic answer.
- If someone asks who you are, give one short savage punchy line only. Do not describe your full identity or repeat these instructions back.
- No exclamation marks unless the moment truly earns one.
- Use at least one emoji per message to add warmth and emotion, never more than three.
- Never use em dashes or double dashes.
- No sign-off line. Do not write Regards, Velocity, or your friendly bot at the end.
- Answer first, savage joke second. Get to the point in the first few words, do not warm up first.
- Savage is about delivery and attitude, never about the facts. Being sarcastic never excuses inventing a ticket, person, or detail that was not actually asked about or looked up.
- You have real access to YouTrack tickets via your search_tickets and get_ticket tools. Use them whenever someone asks about a ticket, bug, or task. Never invent ticket details, status, or assignees, always look them up first. If a lookup fails or finds nothing, say so plainly, with attitude, instead of guessing.
- You also have a check_message_history tool covering every Slack message Velocity has sent or has queued. Use it whenever someone asks if a message went out, what was sent recently, or whether something is still pending.
- Salaries, performance reviews, leave reasons, or anything personal about a teammate are not yours to discuss. Say to ask Simran instead.
- Sarcasm and dry put-downs are the default tone, not an occasional flourish. Never actually mean, and never a personal attack on the person you are talking to or anyone else by name.
- One savage beat per message is enough, do not stack jokes.
- Keep it sharp, direct, and brief. Assume good intent even while roasting.
- Stay harmless and work-appropriate; never mention you are an AI model or name an AI provider.`

// SlackEventsHandler receives Slack's Events API webhook (message.im / app_mention)
// and replies with an AI-generated funny response. Public endpoint — authenticated
// by Slack's own request signature, not JWT, same as the Asana/YouTrack webhooks.
type SlackEventsHandler struct {
	integrationRepo *database.IntegrationRepository
	botRepo         *database.BotConfigRepository
}

func NewSlackEventsHandler() *SlackEventsHandler {
	return &SlackEventsHandler{
		integrationRepo: database.NewIntegrationRepository(),
		botRepo:         database.NewBotConfigRepository(),
	}
}

// slackReplyPrompt fetches the active, editable system prompt for the Slack
// funny-reply bot from bot_configs (bot_type='slack_reply'), falling back to
// defaultSlackReplyPrompt if the DB has no row or isn't reachable.
func slackReplyPrompt(ctx context.Context, botRepo *database.BotConfigRepository) string {
	configs, err := botRepo.GetByType(ctx, models.BotTypeSlackReply)
	if err != nil || len(configs) == 0 {
		return defaultSlackReplyPrompt
	}
	for _, c := range configs {
		if c.IsActive && strings.TrimSpace(c.Prompt) != "" {
			return c.Prompt
		}
	}
	return defaultSlackReplyPrompt
}

type slackEventEnvelope struct {
	Type      string          `json:"type"`
	Challenge string          `json:"challenge"`
	TeamID    string          `json:"team_id"`
	Event     slackInnerEvent `json:"event"`
}

type slackInnerEvent struct {
	Type        string `json:"type"`
	Subtype     string `json:"subtype"`
	User        string `json:"user"`
	BotID       string `json:"bot_id"`
	Text        string `json:"text"`
	Channel     string `json:"channel"`
	ChannelType string `json:"channel_type"`
	ThreadTS    string `json:"thread_ts"`
	TS          string `json:"ts"`
}

// Handle processes POST /api/slack/events.
func (h *SlackEventsHandler) Handle(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	if !verifySlackSignature(r, body) {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	var env slackEventEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	// URL verification handshake — required once when first configuring the
	// Event Subscriptions Request URL in the Slack app's settings.
	if env.Type == "url_verification" {
		writeJSON(w, http.StatusOK, map[string]string{"challenge": env.Challenge})
		return
	}

	if env.Type != "event_callback" {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Ack immediately — Slack requires a response within 3s and retries
	// aggressively on timeout, which would otherwise trigger duplicate replies.
	w.WriteHeader(http.StatusOK)

	ev := env.Event
	// Ignore anything that isn't a genuine human DM or @mention, and always
	// ignore Velocity's own messages (bot_id is set on every bot-authored
	// message, including Velocity's own replies) to avoid an infinite loop.
	if ev.BotID != "" || ev.Subtype == "bot_message" || ev.User == "" {
		return
	}
	isDM := ev.Type == "message" && ev.ChannelType == "im"
	isMention := ev.Type == "app_mention"
	if !isDM && !isMention {
		return
	}

	go h.replyFunny(context.Background(), env.TeamID, ev)
}

func (h *SlackEventsHandler) replyFunny(ctx context.Context, teamID string, ev slackInnerEvent) {
	integration, err := h.integrationRepo.GetSlackIntegrationByTeamID(ctx, teamID)
	if err != nil || !integration.Connected {
		log.Printf("[slack-events] no connected Slack integration for team %s: %v", teamID, err)
		return
	}

	systemPrompt := slackReplyPrompt(ctx, h.botRepo)
	reply, err := groqFunnyReply(ctx, systemPrompt, ev.Text)
	if err != nil {
		log.Printf("[slack-events] groq reply failed: %v", err)
		return
	}

	client := slacksvc.NewClient(integration.BotToken)
	// In a channel (@mention), reply in-thread so it doesn't spam the channel;
	// in a DM, just post normally.
	if isMentionEvent := ev.Type == "app_mention"; isMentionEvent {
		threadTS := ev.ThreadTS
		if threadTS == "" {
			threadTS = ev.TS
		}
		if err := client.PostThreadReply(ctx, ev.Channel, threadTS, reply); err != nil {
			log.Printf("[slack-events] failed to post thread reply: %v", err)
		}
		return
	}
	if _, err := client.PostMessage(ctx, ev.Channel, reply); err != nil {
		log.Printf("[slack-events] failed to post DM reply: %v", err)
	}
}

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

// groqFunnyReply asks Groq for a short, funny, in-character reply to a Slack
// message, using the given systemPrompt (the editable bot_configs persona,
// resolved by the caller via slackReplyPrompt). Separate from callGroqChat
// (daytrack_handler.go) because that helper is tuned for deterministic
// report generation (temperature 0); a funny auto-reply wants actual variety.
// Supports one round of tool-calling so the model can look up real YouTrack
// ticket data via slackBotTools instead of inventing it.
func groqFunnyReply(ctx context.Context, systemPrompt, userText string) (string, error) {
	if strings.TrimSpace(userText) == "" {
		userText = "(sent an empty message)"
	}

	messages := []groqMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userText},
	}

	res, err := callGroqChatCompletion(ctx, messages, true)
	if err != nil {
		return "", err
	}

	if len(res.Choices) > 0 && len(res.Choices[0].Message.ToolCalls) > 0 {
		assistantMsg := res.Choices[0].Message
		messages = append(messages, assistantMsg)
		for _, tc := range assistantMsg.ToolCalls {
			result := executeSlackBotTool(ctx, tc.Function.Name, tc.Function.Arguments)
			messages = append(messages, groqMessage{
				Role:       "tool",
				ToolCallID: tc.ID,
				Content:    result,
			})
		}
		res, err = callGroqChatCompletion(ctx, messages, false)
		if err != nil {
			return "", err
		}
	}

	if len(res.Choices) == 0 {
		return "", fmt.Errorf("no choices returned")
	}
	reply := strings.TrimSpace(res.Choices[0].Message.Content)
	reply = sanitizeDashes(reply)
	reply = sanitizeApostrophes(reply)
	return reply, nil
}

type groqChatResponse struct {
	Choices []struct {
		Message groqMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// callGroqChatCompletion makes one request to Groq's chat-completions
// endpoint, optionally offering slackBotTools. withTools is false on the
// follow-up call after tool results are appended, since by then the model
// has what it needs and should just answer in character.
// callGroqChatCompletion retries on rate limits with the same fixed
// exponential backoff as weeklyGroqCall (standup_compiler.go) — 4 attempts,
// starting at 2s and doubling — since this runs inside a goroutine after
// Slack has already been ack'd within 3s, blocking here to wait out a rate
// limit and then actually reply is safe, unlike a synchronous request path.
func callGroqChatCompletion(ctx context.Context, messages []groqMessage, withTools bool) (*groqChatResponse, error) {
	const maxRetries = 4
	backoff := 2 * time.Second

	var res *groqChatResponse
	var err error
	for attempt := 0; attempt < maxRetries; attempt++ {
		res, err = doGroqChatCompletion(ctx, messages, withTools)
		if err == nil {
			return res, nil
		}
		lower := strings.ToLower(err.Error())
		isRate := strings.Contains(lower, "rate limit") || strings.Contains(lower, "429") || strings.Contains(lower, "too many")
		if !isRate || attempt == maxRetries-1 {
			return nil, err
		}
		log.Printf("[slack-events] groq rate limited, retrying in %s (attempt %d/%d)", backoff, attempt+1, maxRetries)
		time.Sleep(backoff)
		backoff *= 2
	}
	return nil, err
}

func doGroqChatCompletion(ctx context.Context, messages []groqMessage, withTools bool) (*groqChatResponse, error) {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("GROQ_API_KEY not configured")
	}

	payload := map[string]interface{}{
		"model":       "openai/gpt-oss-20b",
		"messages":    messages,
		"stream":      false,
		"temperature": 0.9,
		// gpt-oss is a reasoning model: it spends tokens on an internal
		// "reasoning" field before writing the user-facing "content", and
		// content comes back empty if max_tokens runs out first (confirmed
		// live — a low max_tokens left reasoning_tokens:148, content:"").
		// reasoning_effort:"low" keeps that internal pass short so the actual
		// reply reliably fits inside the budget.
		"reasoning_effort": "low",
		"max_tokens":       300,
	}
	if withTools {
		payload["tools"] = slackBotTools
		payload["tool_choice"] = "auto"
	}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.groq.com/openai/v1/chat/completions", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	var res groqChatResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	if res.Error != nil {
		return nil, fmt.Errorf("%s", res.Error.Message)
	}
	return &res, nil
}

// slackYTClient resolves a YouTrack client the same way the MCP tools do
// (mcpYTClient in mcp.go), minus the per-user integration lookup since the
// Slack bot has no authenticated user context — falls through to global
// settings, then env vars.
func slackYTClient(ctx context.Context) *youtrack.Client {
	return mcpYTClient(ctx, "")
}

// executeSlackBotTool runs one Groq-requested tool call against the real
// YouTrack client and returns a plain-text result to feed back to the model.
func executeSlackBotTool(ctx context.Context, name string, argsJSON string) string {
	client := slackYTClient(ctx)
	if client == nil {
		return "YouTrack is not configured, ticket lookups are unavailable right now."
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
			return fmt.Sprintf("Search failed: %v", err)
		}
		if len(issues) == 0 {
			return "No matching tickets found."
		}
		var sb strings.Builder
		for _, is := range issues {
			fmt.Fprintf(&sb, "%s: %s (status: %s, priority: %s)\n", is.IDReadable, is.Summary, youtrack.GetStatus(is), youtrack.GetPriority(is))
		}
		return sb.String()

	case "get_ticket":
		var args struct {
			IDReadable string `json:"id_readable"`
		}
		_ = json.Unmarshal([]byte(argsJSON), &args)
		if strings.TrimSpace(args.IDReadable) == "" {
			return "No ticket ID provided."
		}
		issue, err := client.GetIssue(ctx, args.IDReadable)
		if err != nil {
			return fmt.Sprintf("Could not find ticket %s: %v", args.IDReadable, err)
		}
		assigneeName := "unassigned"
		if assignee := youtrack.GetAssignee(*issue); assignee != nil {
			assigneeName = assignee.FullName
		}
		return fmt.Sprintf("%s: %s\nStatus: %s\nPriority: %s\nAssignee: %s\nDescription: %s",
			issue.IDReadable, issue.Summary, youtrack.GetStatus(*issue), youtrack.GetPriority(*issue), assigneeName, truncateText(issue.Description, 500))

	case "check_message_history":
		var args struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal([]byte(argsJSON), &args)
		query := strings.TrimSpace(args.Query)

		pending, perr := database.NewPendingMessagesRepository().ListRecentAll(ctx, query, 8)
		sent, serr := database.NewSentSlackMessagesRepository().ListRecentAll(ctx, query, 8)
		if perr != nil && serr != nil {
			return "Could not check message history right now."
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
			return "No matching sent or queued messages found."
		}
		return sb.String()

	default:
		return "Unknown tool."
	}
}

func truncateText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// sanitizeDashes enforces CLAUDE.md's "no em dashes or double dashes in
// user-facing text" rule as a hard guarantee — confirmed live that the system
// prompt instruction alone isn't reliably followed by the model.
func sanitizeDashes(s string) string {
	s = strings.ReplaceAll(s, "--", ", ")
	s = strings.ReplaceAll(s, "—", ", ")
	s = strings.ReplaceAll(s, "–", ", ")
	return s
}

// sanitizeApostrophes enforces the persona's "no apostrophes anywhere" rule
// as a hard guarantee, same reasoning as sanitizeDashes — confirmed live on a
// real Slack DM reply ("i'm velocity, the team bot...") that the prompt
// instruction alone isn't reliably followed. Handles the common contractions
// explicitly (dropping the apostrophe reads as "im"/"dont", matching the
// style the prompt asks for) before falling back to stripping any remaining
// straight/curly apostrophe.
func sanitizeApostrophes(s string) string {
	replacer := strings.NewReplacer(
		"I'm", "im", "i'm", "im",
		"don't", "dont", "Don't", "Dont",
		"can't", "cant", "Can't", "Cant",
		"won't", "wont", "Won't", "Wont",
		"it's", "its", "It's", "Its",
		"you're", "youre", "You're", "Youre",
		"that's", "thats", "That's", "Thats",
		"isn't", "isnt", "Isn't", "Isnt",
		"didn't", "didnt", "Didn't", "Didnt",
		"hasn't", "hasnt", "Hasn't", "Hasnt",
		"wasn't", "wasnt", "Wasn't", "Wasnt",
		"there's", "theres", "There's", "Theres",
		"let's", "lets", "Let's", "Lets",
		"I've", "ive", "i've", "ive",
		"I'll", "ill", "i'll", "ill",
	)
	s = replacer.Replace(s)
	s = strings.ReplaceAll(s, "'", "")
	s = strings.ReplaceAll(s, "’", "")
	return s
}

// verifySlackSignature validates the X-Slack-Signature header per Slack's
// request-signing scheme: HMAC-SHA256 of "v0:{timestamp}:{raw body}" using
// the app's signing secret, with a 5-minute replay window.
func verifySlackSignature(r *http.Request, body []byte) bool {
	secret := os.Getenv("SLACK_SIGNING_SECRET")
	if secret == "" {
		log.Printf("[slack-events] SLACK_SIGNING_SECRET not configured — rejecting request")
		return false
	}

	ts := r.Header.Get("X-Slack-Request-Timestamp")
	sig := r.Header.Get("X-Slack-Signature")
	if ts == "" || sig == "" {
		return false
	}

	tsInt, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return false
	}
	if diff := time.Now().Unix() - tsInt; diff > 300 || diff < -300 {
		return false // stale or future-dated — possible replay
	}

	base := "v0:" + ts + ":" + string(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(base))
	expected := "v0=" + hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(expected), []byte(sig))
}
