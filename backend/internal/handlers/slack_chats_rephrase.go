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
)

// "Rephrase with AI" for the Chats reply box: the admin writes a draft and asks for a politer or
// more natural version before sending. Nothing is sent here, the text just comes back.

// Same model as the Slack bot. It is a reasoning model, so max_tokens must leave room for its
// thinking as well as the answer.
const chatRephraseModel = "openai/gpt-oss-20b"

const chatRephraseBase = `You rewrite a short Slack direct message that a manager is about to send to a teammate.
Rules:
- Keep the meaning, every name, number, date, link and @mention exactly as written. Add no new facts, promises or questions.
- Keep it about the same length or shorter. Plain words, no corporate filler, no emojis unless the draft already has them.
- Never use em dashes or double dashes. Use a comma, "and", or a new sentence.
- Write in the same language as the draft. Keep line breaks sensible.
- Reply with the rewritten message only. No quotes, no preface, no explanation.`

var chatRephraseStyles = map[string]string{
	"polite": chatRephraseBase + `
Style: polite and warm. Friendly and respectful, never stiff or pushy. Soften commands into requests ("could you", "when you get a moment") and say thanks where it fits.`,
	"human": chatRephraseBase + `
Style: sound like a real person typing in Slack. Casual, natural, contractions, short sentences. Remove robotic or formal phrasing, and anything that reads like AI wrote it (no "I hope this finds you well", no "kindly", no lists unless the draft is a list).`,
}

func groqRewrite(ctx context.Context, system, user string) (string, error) {
	key := os.Getenv("GROQ_API_KEY")
	if key == "" {
		return "", errors.New("AI is not configured")
	}
	return callGroqChat(ctx, key, chatRephraseModel, system, user, 2000)
}

// cleanRephrase tidies the model's answer: no wrapping quotes, no em dashes.
func cleanRephrase(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	return strings.TrimSpace(sanitizeDashes(s))
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
	system, ok := chatRephraseStyles[body.Style]
	if text == "" || !ok {
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
