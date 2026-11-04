package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
)

// "Rephrase with AI" for the Chats reply box: the admin writes a draft and asks for a politer or
// more natural version before sending. Nothing is sent here, the text just comes back.

// Same model as the Slack bot. It is a reasoning model, so max_tokens must leave room for its
// thinking as well as the answer.
const chatRephraseModel = "openai/gpt-oss-20b"

// Added after the first release; seeding upgrades untouched prompts that lack these lines.
const chatRephraseGrammarRules = `- For a possessive, drop only the apostrophe and keep the s: rohit's review becomes rohits review.
- Normal hyphenated words and ticket IDs stay exactly as they are, like follow-up and VEL-123.
`

const chatRephraseBase = `You rewrite a short Slack direct message that a manager is about to send to a teammate.

## Rules
- Keep the meaning, and keep every name, number, date, link and @mention exactly as written. Add no new facts, promises or questions.
- Keep it about the same length or shorter. Plain everyday words, no corporate filler, no emojis unless the draft already has them.
- No apostrophes anywhere. Write dont, cant, its, youre, wont, hasnt, didnt, thats, im.
- Never use dashes of any kind: no em dashes, no en dashes, no double dashes, and no hyphen used as a pause. Use a comma, the word "and", or start a new sentence.
` + chatRephraseGrammarRules + `- Capitalize the first letter of every sentence, like normal professional writing. No Title Case, no ALL CAPS.
- Write in the same language as the draft. Keep line breaks sensible.
- Reply with the rewritten message only. No quotes, no preface, no explanation.`

const chatRephrasePolite = chatRephraseBase + `

## Style: polite and warm
Friendly and respectful, never stiff or pushy. Soften commands into requests ("could you", "when you get a moment") and say thanks where it fits.`

const chatRephraseHuman = chatRephraseBase + `

## Style: sound like a real person
Write like a real person typing in Slack: casual, natural, short sentences. Remove robotic or formal phrasing and anything that reads like an AI wrote it (no "I hope this finds you well", no "kindly", no lists unless the draft is a list).`

// Bot Config entries (type chat_rephrase) hold the editable prompts. Each is found by a fixed key
// in created_by, so renaming one on the Bots page keeps it working. The built-in text above is
// used when an entry is missing, inactive or empty.
var chatRephraseBotKeys = map[string]string{
	"polite": "system:chat_rephrase:polite",
	"human":  "system:chat_rephrase:human",
}

var chatRephraseStyles = map[string]string{"polite": chatRephrasePolite, "human": chatRephraseHuman}

// SeedChatRephraseBots adds the two rephrase prompts to Bot Config when they are not there yet,
// so they show up on the Bots page and can be edited. An admin's edits are never overwritten.
func SeedChatRephraseBots(ctx context.Context) {
	if database.GetPool() == nil {
		return
	}
	repo := database.NewBotConfigRepository()
	seeds := []struct{ style, name, desc string }{
		{"polite", "Chat Rephrase: Polite", "Used by the Chats reply box when you press Make it polite. Rewrites your draft before you send it."},
		{"human", "Chat Rephrase: Human", "Used by the Chats reply box when you press Sound human. Rewrites your draft so it reads like a person typed it."},
	}
	for _, sd := range seeds {
		prompt := chatRephraseStyles[sd.style]
		c := &models.BotConfig{Name: sd.name, Description: sd.desc, BotType: models.BotTypeChatRephrase, Prompt: prompt,
			Variables: "[]", IsActive: true, CreatedBy: chatRephraseBotKeys[sd.style]}
		if err := repo.EnsureSystemBot(ctx, c, strings.Replace(prompt, chatRephraseGrammarRules, "", 1)); err != nil {
			log.Printf("[slack-chats] could not add %q to Bot Config: %v", sd.name, err)
		}
	}
}

// rephrasePrompt returns the Bot Config prompt for a style, or the built-in one.
func rephrasePrompt(ctx context.Context, style string) string {
	fallback := chatRephraseStyles[style]
	if database.GetPool() == nil {
		return fallback
	}
	configs, err := database.NewBotConfigRepository().GetByType(ctx, models.BotTypeChatRephrase)
	if err != nil {
		return fallback
	}
	return pickRephrasePrompt(configs, style)
}

func pickRephrasePrompt(configs []*models.BotConfig, style string) string {
	for _, c := range configs {
		if c.CreatedBy == chatRephraseBotKeys[style] && c.IsActive && strings.TrimSpace(c.Prompt) != "" {
			return c.Prompt
		}
	}
	return chatRephraseStyles[style]
}

func groqRewrite(ctx context.Context, system, user string) (string, error) {
	key := os.Getenv("GROQ_API_KEY")
	if key == "" {
		return "", errors.New("AI is not configured")
	}
	return callGroqChat(ctx, key, chatRephraseModel, system, user, 2000)
}

// cleanRephrase tidies the model's answer: no wrapping quotes, and the no dashes and no
// apostrophes rules enforced for certain, because the prompt alone is not always followed.
func cleanRephrase(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	s = sanitizeDashes(s)
	s = strings.ReplaceAll(s, " - ", ", ")
	return strings.TrimSpace(sanitizeApostrophes(s))
}

// Rephrase handles POST /api/slack-chats/rephrase {text, style: "polite"|"human"}.
func (h *SlackChatsHandler) Rephrase(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text  string `json:"text"`
		Style string `json:"style"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		chatFail(w, http.StatusBadRequest, "invalid request")
		return
	}
	text := strings.TrimSpace(body.Text)
	if _, ok := chatRephraseStyles[body.Style]; text == "" || !ok {
		chatFail(w, http.StatusBadRequest, "write a message first")
		return
	}
	if len([]rune(text)) > maxChatReplyRunes {
		chatFail(w, http.StatusBadRequest, "message is too long to rephrase")
		return
	}
	if h.rewrite == nil {
		chatFail(w, http.StatusServiceUnavailable, "AI is not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	system := h.stylePrompt(ctx, body.Style)
	out, err := h.rewrite(ctx, system, "Draft message:\n"+text)
	out = cleanRephrase(out)
	if err != nil || out == "" {
		log.Printf("[slack-chats] rephrase failed: err=%v empty=%t", err, out == "")
		chatFail(w, http.StatusBadGateway, "AI could not rephrase this right now, try again")
		return
	}
	if len([]rune(out)) > maxChatReplyRunes {
		chatFail(w, http.StatusBadGateway, "AI answer was too long, try again")
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": map[string]string{"text": out}})
}

func (h *SlackChatsHandler) stylePrompt(ctx context.Context, style string) string {
	if h.prompt != nil {
		return h.prompt(ctx, style)
	}
	return chatRephraseStyles[style]
}
