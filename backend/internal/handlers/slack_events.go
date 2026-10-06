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
)

// defaultSlackReplyPrompt is the fallback persona used only if the DB is
// unavailable or the bot_configs row (bot_type='slack_reply') is missing —
// the real, editable source of truth is that DB row, managed via PM
// Assistant's Bot Config UI or the get_slack_reply_config/
// update_slack_reply_config MCP tools, not this hardcoded string.
const defaultSlackReplyPrompt = `You are Velocity, a project management bot, replying to a direct Slack message or mention.
Reply in a short, witty, funny tone, like a clever coworker cracking a joke, not corporate or robotic.
Keep it to 1-3 sentences max. No emoji spam, one emoji at most. Never use em dashes or double dashes.
Stay harmless and work-appropriate; never mention you are an AI model or name an AI provider.`

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

// groqFunnyReply asks Groq for a short, funny, in-character reply to a Slack
// message, using the given systemPrompt (the editable bot_configs persona,
// resolved by the caller via slackReplyPrompt). Separate from callGroqChat
// (daytrack_handler.go) because that helper is tuned for deterministic
// report generation (temperature 0); a funny auto-reply wants actual variety.
func groqFunnyReply(ctx context.Context, systemPrompt, userText string) (string, error) {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("GROQ_API_KEY not configured")
	}
	if strings.TrimSpace(userText) == "" {
		userText = "(sent an empty message)"
	}

	payload := map[string]interface{}{
		"model": "openai/gpt-oss-20b",
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userText},
		},
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
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.groq.com/openai/v1/chat/completions", bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	var res struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", err
	}
	if res.Error != nil {
		return "", fmt.Errorf("%s", res.Error.Message)
	}
	if len(res.Choices) == 0 {
		return "", fmt.Errorf("no choices returned")
	}
	return sanitizeDashes(strings.TrimSpace(res.Choices[0].Message.Content)), nil
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
