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
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// defaultSlackReplyPrompt is the fallback persona used only if the DB is
// unavailable or the bot_configs row (bot_type='slack_reply') is missing —
// the real, editable source of truth is that DB row, managed via PM
// Assistant's Bot Config UI or the get_slack_reply_config/
// update_slack_reply_config MCP tools, not this hardcoded string.
const defaultSlackReplyPrompt = `## Identity

You are Velocity, the team bot that knows everyone and remembers everything, replying to a direct Slack message or mention. You are an AI bot, not a person pretending to be one, but never say so out loud.

Think of yourself as the colleague who says the blunt, dry thing everyone else is only thinking: quick wit, zero patience for small talk, never actually cruel to a real person, and always actually useful.

## Accuracy comes first

- Never invent a ticket, status, assignee, date, person, number, or detail. If you were not told it or did not look it up, you do not know it.
- You have real YouTrack access through search_tickets and get_ticket. Use them whenever someone asks about a ticket, bug, or task, and report what they return. If a lookup fails or finds nothing, say so plainly.
- You have a check_message_history tool covering every Slack message Velocity has sent or queued. Use it when someone asks whether a message went out, what was sent, or whats still pending.
- Reference notes from the team knowledge base may appear below. Use them when they answer the question, and say so when they do not. Never present a guess as if it came from them.
- Never show tool names, function calls, or code syntax to people, they cannot use them. Say what you checked in plain words, like "I looked it up in YouTrack".
- Earlier messages in this chat are real. Use them to understand follow-ups like "what is this" or "and the other one", and do not repeat yourself.
- If you are not sure, say what you do know in one line and who to ask. Do not promise things you cannot do, like reminding someone, passing a message on, or changing a ticket.
- Salaries, performance reviews, leave reasons, or anything personal about a teammate are not yours to discuss. Say to ask Simran instead.

## Reply length

Match the length to what the message needs. Never pad, and never cut a needed answer short just to stay brief.

- A thanks: 1 to 3 words, like "Anytime." An ok, got it, or cool: 1 to 3 words, like "Noted."
- A greeting or small talk: one short line.
- A simple direct question: 1 to 2 sentences.
- A ticket lookup, status, explanation, how-to, or a question with several parts: 3 to 4 short lines. The hard limit is 4 lines, or 5 only if the person asked for steps or a list. Put the answer in the first line, then one short point per line, using real line breaks and never one block of text. No blank lines, no headings. If there is more to say, give the most important points and stop.
- Do not restate the question, and do not end with an offer like "let me know if you need anything".

## Tone

- Dry, sarcastic, quick. The edge sits on top of a correct answer and never replaces one.
- A bare hi or a vague ask gets a short roast for the low effort. A thanks gets a warm, dry one-liner.
- When someone reports a problem, a blocker, or bad news, or asks something serious, answer plainly first and keep any joke tiny or skip it.
- One joke per message at most. Never a personal attack on the person you are talking to or on anyone named.
- Stay work-appropriate. Never mention that you are an AI model or name an AI provider. If someone asks who you are, give one short punchy line, never the whole description.

## Format

- No apostrophes anywhere. Write dont, cant, its, youre, wont, hasnt, didnt, thats.
- Capitalize the first letter of every sentence. No Title Case, no ALL CAPS.
- Never use em dashes or double dashes.
- No exclamation marks unless the moment truly earns one.
- Use at least one emoji per message, never more than three.
- No sign-off line. Do not write Regards or Velocity at the end.`

// SlackEventsHandler receives Slack's Events API webhook (message.im / app_mention)
// and replies with an AI-generated funny response. Public endpoint — authenticated
// by Slack's own request signature, not JWT, same as the Asana/YouTrack webhooks.
type SlackEventsHandler struct {
	integrationRepo *database.IntegrationRepository
	botRepo         *database.BotConfigRepository
	dm              *dmRelay // DM chat log and relay rules (slack_dm_relay.go); nil = bot answers every DM
}

func NewSlackEventsHandler() *SlackEventsHandler {
	return &SlackEventsHandler{
		integrationRepo: database.NewIntegrationRepository(),
		botRepo:         database.NewBotConfigRepository(),
		dm:              newDMRelay(),
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

	client := slacksvc.NewClient(integration.BotToken)

	// Resolve the sender's Velocity app user (via Slack email lookup) before
	// generating the reply, so the full conversation log below can be
	// attributed for per-user access control (see
	// SlackBotConversationsHandler.List).
	senderEmail := resolveSlackSenderEmail(ctx, client, ev.User)
	velocityUserID := resolveVelocityUser(ctx, senderEmail)

	// A DM is stored for the admin Chats view first. If Velocity started this conversation for
	// a user (Claude, queue or dashboard) and they are waiting on the answer, the bot stays
	// quiet instead of joking back, and the user is told what was said (see slack_dm_relay.go).
	if ev.Type == "message" && h.dm != nil {
		relayCtx, cancelRelay := context.WithTimeout(ctx, 30*time.Second)
		answer := h.dm.handleInbound(relayCtx, client, ev, dmSender{
			SlackID: ev.User, Name: resolveSlackSenderName(relayCtx, client, ev.User),
			Email: senderEmail, VelocityUserID: velocityUserID,
		})
		cancelRelay()
		if !answer {
			return
		}
	}

	actorLabel := slackActorLabel(ev)
	start := time.Now()
	// Conversation memory: replay the thread / recent DM so follow-ups like
	// "what is this?" have context (see slack_bot_context.go).
	convo := buildSlackBotContext(ctx, client, ev)
	// Team knowledge base (see slack_bot_kb.go).
	kbSection := slackBotKBSection(ctx, ev.Text, convo.History)
	systemPrompt := systemPromptWithContext(slackReplyPrompt(ctx, h.botRepo), convo, kbSection)
	// Ticket tools use the sender's own YouTrack connection (slackYTClient).
	reply, err := groqFunnyReply(withSlackBotUser(ctx, velocityUserID), systemPrompt, convo.History, convo.framedUserText(ev.Text), actorLabel)
	elapsed := time.Since(start).Round(time.Millisecond)
	logSlackBotReply(actorLabel, ev.Text, reply, err, elapsed)

	// Full-fidelity conversation log (separate from the lossy/truncated
	// summary above) — fires on both the success and failure path.
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if lerr := database.NewSlackBotConversationRepository().Log(logCtx, database.SlackBotConversation{
		UserID:         velocityUserID,
		SlackUserID:    ev.User,
		SlackUserEmail: senderEmail,
		ChannelID:      ev.Channel,
		ChannelLabel:   "",
		EventType:      ev.Type,
		IncomingText:   ev.Text,
		ReplyText:      reply,
		Success:        err == nil,
		ErrorMessage:   errMsg,
	}); lerr != nil {
		log.Printf("[slack-events] failed to log conversation: %v", lerr)
	}
	cancel()

	if err != nil {
		log.Printf("[slack-events] groq reply failed: %v", err)
		return
	}

	// In a channel (@mention), reply in-thread so it doesn't spam the channel.
	if ev.Type == "app_mention" {
		threadTS := ev.ThreadTS
		if threadTS == "" {
			threadTS = ev.TS
		}
		if err := client.PostThreadReply(ctx, ev.Channel, threadTS, reply); err != nil {
			log.Printf("[slack-events] failed to post thread reply: %v", err)
		}
		return
	}
	// In a DM, post normally unless the person replied inside a thread, then answer in that
	// same thread. The reply is stored with the rest of the conversation.
	ts, err := client.PostInThread(ctx, ev.Channel, ev.ThreadTS, reply)
	if err != nil {
		log.Printf("[slack-events] failed to post DM reply: %v", err)
		return
	}
	if h.dm != nil {
		h.dm.record(ctx, ev.Channel, ts, ev.ThreadTS, database.DMKindAutoReply, reply)
	}
}

// slackActorLabel builds a cheap, human-readable label for who triggered a
// Slack bot interaction, using only the raw IDs already present on the event
// (no extra Slack API lookups for a display name).
func slackActorLabel(ev slackInnerEvent) string {
	if ev.Type == "app_mention" {
		return "mention in " + ev.Channel
	}
	return "DM from " + ev.User
}

// slackEmailCache avoids re-hitting Slack's users.info API for every message
// from the same person — the Slack-ID-to-email mapping essentially never
// changes within a process lifetime.
var slackEmailCache sync.Map // map[string]string: slackUserID -> email (may be "")

func resolveSlackSenderEmail(ctx context.Context, client *slacksvc.Client, slackUserID string) string {
	if slackUserID == "" {
		return ""
	}
	if v, ok := slackEmailCache.Load(slackUserID); ok {
		return v.(string)
	}
	email := ""
	if u, err := client.GetUser(ctx, slackUserID); err == nil && u != nil {
		email = u.Profile.Email
	}
	slackEmailCache.Store(slackUserID, email)
	return email
}

var slackNameCache sync.Map // map[string]string: slackUserID -> display name (only real names are cached)

// resolveSlackSenderName returns the person's Slack display name for the chat list, or "" if
// Slack could not be asked right now (not cached, so the next message tries again).
func resolveSlackSenderName(ctx context.Context, client *slacksvc.Client, slackUserID string) string {
	if slackUserID == "" {
		return ""
	}
	if v, ok := slackNameCache.Load(slackUserID); ok {
		return v.(string)
	}
	u, err := client.GetUser(ctx, slackUserID)
	if err != nil || u == nil {
		return ""
	}
	name := u.Profile.DisplayName
	if name == "" {
		name = u.RealName
	}
	if name == "" {
		name = u.Name
	}
	if name != "" {
		slackNameCache.Store(slackUserID, name)
	}
	return name
}

// resolveVelocityUser maps a Slack sender's email to a Velocity app user ID,
// for per-user conversation history access control. Returns "" if no match
// (e.g. an external/unknown Slack account) — conversations with an empty
// user_id are visible only to admins (see SlackBotConversationsHandler).
func resolveVelocityUser(ctx context.Context, email string) string {
	if email == "" {
		return ""
	}
	u, err := database.NewUserRepository().GetByEmail(ctx, email)
	if err != nil || u == nil {
		return ""
	}
	return u.ID
}

// logSlackBotReply records the full "message in -> reply out" round trip for
// the Slack bot, both as a console line and as a row in the shared
// mcp_activity_log table/UI (same standard as the MCP server's own activity
// log, see mcp_dispatch.go callTool).
func logSlackBotReply(actorLabel, incoming, reply string, err error, elapsed time.Duration) {
	success := err == nil
	summary := fmt.Sprintf("%q -> %q", truncateText(incoming, 80), truncateText(reply, 150))
	if !success {
		summary = fmt.Sprintf("%q -> error: %s", truncateText(incoming, 80), err.Error())
	}
	if success {
		log.Printf("[Slack Bot] ✓ reply to %s (%s): %s", actorLabel, elapsed, summary)
	} else {
		log.Printf("[Slack Bot] ✗ reply to %s failed (%s): %s", actorLabel, elapsed, summary)
	}
	logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if lerr := mcpActivityRepo.Log(logCtx, database.MCPActivityEntry{
		ToolName:    "slack_bot_reply",
		ActionLabel: "Slack Bot replied (" + actorLabel + ")",
		Summary:     summary,
		Success:     success,
		DurationMs:  int(elapsed.Milliseconds()),
	}); lerr != nil {
		log.Printf("[Slack Bot] ⚠ failed to record activity log entry: %v", lerr)
	}
}

// groqFunnyReply asks Groq for a short, funny, in-character reply to a Slack
// message, using the given systemPrompt (the editable bot_configs persona,
// resolved by the caller via slackReplyPrompt). Separate from callGroqChat
// (daytrack_handler.go) because that helper is tuned for deterministic
// report generation (temperature 0); a funny auto-reply wants actual variety.
// Supports one round of tool-calling so the model can look up real YouTrack
// ticket data via slackBotTools instead of inventing it.
// history is the earlier conversation (oldest first, from
// buildSlackBotContext), replayed before the new message.
func groqFunnyReply(ctx context.Context, systemPrompt string, history []groqMessage, userText, actorLabel string) (string, error) {
	if strings.TrimSpace(userText) == "" {
		userText = "(sent an empty message)"
	}

	messages := make([]groqMessage, 0, len(history)+2)
	messages = append(messages, groqMessage{Role: "system", Content: systemPrompt})
	messages = append(messages, history...)
	messages = append(messages, groqMessage{Role: "user", Content: userText})

	res, err := callGroqChatCompletion(ctx, messages, true)
	if err != nil {
		return "", err
	}

	if len(res.Choices) > 0 && len(res.Choices[0].Message.ToolCalls) > 0 {
		assistantMsg := res.Choices[0].Message
		messages = append(messages, assistantMsg)
		for _, tc := range assistantMsg.ToolCalls {
			result := executeSlackBotTool(ctx, tc.Function.Name, tc.Function.Arguments, actorLabel)
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
		// reply reliably fits inside the budget. Replies now vary from two words to
		// a few lines, so the budget leaves room for the longer ones too (the
		// persona caps those at about five short lines).
		"reasoning_effort": "low",
		"max_tokens":       600,
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

// sanitizeDashes enforces CLAUDE.md's "no em dashes or double dashes in
// user-facing text" rule as a hard guarantee — confirmed live that the system
// prompt instruction alone isn't reliably followed by the model.
func sanitizeDashes(s string) string {
	// Spaced dashes first, or "step — next" would become "step ,  next".
	return strings.NewReplacer(
		" — ", ", ", " – ", ", ", " -- ", ", ",
		"—", ", ", "–", ", ", "--", ", ",
	).Replace(s)
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
