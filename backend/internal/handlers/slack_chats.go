package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/logging"
	"github.com/dhindsa/project-management/internal/middleware"
	updatesvc "github.com/dhindsa/project-management/internal/services/update_reminder"
	"github.com/gorilla/mux"
)

// Admin Chats: the Slack-style view of every DM between people and the Velocity bot, with a
// reply box. Registered behind middleware.AdminOnly in main.go. These are private employee
// conversations, so there is no per-user variant of any of these routes.

const maxChatReplyRunes = 3000

var chatChannelRe = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)

// chatStore is the slice of database.SlackDMRepository the Chats routes use.
type chatStore interface {
	ListConversations(ctx context.Context, limit int) ([]database.SlackDMListItem, error)
	GetConversation(ctx context.Context, channelID string) (*database.SlackDMConversation, error)
	ListMessages(ctx context.Context, channelID string, afterID int64, limit int) ([]database.SlackDMMessage, error)
	SetMode(ctx context.Context, channelID, mode string) (bool, error)
	ClearAttention(ctx context.Context, channelID string) error
	ResolveRelay(ctx context.Context, channelID string) (bool, error)
	CountNeedingAttention(ctx context.Context) (int, error)
	LatestInboundAt(ctx context.Context) (*time.Time, error)
}

// chatSender posts a DM as Velocity for a user and records it (update_reminder.Service).
type chatSender interface {
	QuickSend(ctx context.Context, userID, channelID, message, dmUserID, source string) (slackTS, resolvedChannelID string, err error)
}

type SlackChatsHandler struct {
	store    chatStore
	sender   chatSender
	userName func(ctx context.Context, velocityUserID string) string
	// profile looks up a Slack person's name and photo for the signed-in admin (nil = skip).
	profile func(ctx context.Context, adminID, slackUserID string) (slackProfile, bool)
	// userImage finds a Velocity user's photo, for messages sent through Velocity (nil = skip).
	userImage func(ctx context.Context, adminID, velocityUserID string) string
	// rewrite asks the AI to rewrite a draft (nil = AI not configured).
	rewrite func(ctx context.Context, system, user string) (string, error)
	// botToken and answer let the bot reply to a message still waiting when a chat is passed back.
	botToken func(ctx context.Context, adminID string) string
	answer   func(ctx context.Context, botToken string, ev slackInnerEvent)
	// answering holds the channels the bot is replying in right now, so it never answers twice.
	answering sync.Map
	// prompt returns the rephrase prompt for a style (nil = built-in text).
	prompt func(ctx context.Context, style string) string
}

func NewSlackChatsHandler() *SlackChatsHandler {
	users := database.NewUserRepository()
	integrations := database.NewIntegrationRepository()
	events := NewSlackEventsHandler()
	return &SlackChatsHandler{
		answer: events.AnswerWaitingDM,
		botToken: func(ctx context.Context, adminID string) string {
			if integ, err := integrations.GetSlackIntegration(ctx, adminID); err == nil && integ != nil && integ.Connected {
				return integ.BotToken
			}
			return ""
		},
		store:     database.NewSlackDMRepository(),
		sender:    updatesvc.NewService(),
		profile:   slackProfileLookup(integrations),
		userImage: velocityUserImage(users, integrations),
		rewrite:   groqRewrite,
		prompt:    rephrasePrompt,
		userName: func(ctx context.Context, id string) string {
			if u, err := users.GetByID(ctx, id); err == nil && u != nil {
				return u.Name
			}
			return ""
		},
	}
}

type chatListItem struct {
	database.SlackDMListItem
	RelayActive    bool   `json:"relay_active"`
	RelayOwnerName string `json:"relay_owner_name"`
	SlackUserImage string `json:"slack_user_image"`
}

type chatMessage struct {
	database.SlackDMMessage
	AuthorLabel string `json:"author_label"`
	AuthorImage string `json:"author_image"`
}

func chatFail(w http.ResponseWriter, status int, msg string) {
	sendJSON(w, status, map[string]any{"success": false, "message": msg})
}

// channelParam returns the validated conversation id from the URL, or writes a 400.
func channelParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	ch := mux.Vars(r)["channel"]
	if !chatChannelRe.MatchString(ch) {
		chatFail(w, http.StatusBadRequest, "invalid conversation")
		return "", false
	}
	return ch, true
}

func relayActive(c database.SlackDMConversation, now time.Time) bool {
	return c.RelayOwnerID != "" && c.RelayUntil != nil && now.Before(*c.RelayUntil)
}

// List handles GET /api/slack-chats -> the people list, conversations needing attention first.
func (h *SlackChatsHandler) List(w http.ResponseWriter, r *http.Request) {
	items, err := h.store.ListConversations(r.Context(), 200)
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to load chats")
		return
	}
	now := time.Now()
	names := map[string]string{}
	profiles := h.profiles(r, slackIDsOf(items))
	out := make([]chatListItem, 0, len(items))
	for _, it := range items {
		li := chatListItem{SlackDMListItem: it, RelayActive: relayActive(it.SlackDMConversation, now)}
		if p, ok := profiles[it.SlackUserID]; ok {
			li.SlackUserImage = p.Image
			if li.SlackUserName == "" {
				li.SlackUserName = p.Name
			}
		}
		if li.RelayActive {
			if _, ok := names[it.RelayOwnerID]; !ok {
				names[it.RelayOwnerID] = h.userName(r.Context(), it.RelayOwnerID)
			}
			li.RelayOwnerName = names[it.RelayOwnerID]
		}
		out = append(out, li)
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": out})
}

// Summary handles GET /api/slack-chats/summary -> how many chats need the admin (the badge), and
// when the newest message from a person arrived (the dot on Slack in the left nav).
func (h *SlackChatsHandler) Summary(w http.ResponseWriter, r *http.Request) {
	n, err := h.store.CountNeedingAttention(r.Context())
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to load summary")
		return
	}
	latest, err := h.store.LatestInboundAt(r.Context())
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to load summary")
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": map[string]any{"needs_attention": n, "latest_inbound_at": latest}})
}

// Messages handles GET /api/slack-chats/{channel}/messages?after_id=N&limit=N&mark_read=1.
// Without after_id it returns the latest messages; with it, only newer ones (polling).
// mark_read=1 says the admin is looking at the conversation, which clears its "needs you" flag.
func (h *SlackChatsHandler) Messages(w http.ResponseWriter, r *http.Request) {
	ch, ok := channelParam(w, r)
	if !ok {
		return
	}
	conv, err := h.store.GetConversation(r.Context(), ch)
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to load chat")
		return
	}
	if conv == nil {
		chatFail(w, http.StatusNotFound, "conversation not found")
		return
	}
	q := r.URL.Query()
	afterID, _ := strconv.ParseInt(q.Get("after_id"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	msgs, err := h.store.ListMessages(r.Context(), ch, afterID, limit)
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to load messages")
		return
	}
	if q.Get("mark_read") == "1" && conv.NeedsAttention {
		if err := h.store.ClearAttention(r.Context(), ch); err == nil {
			conv.NeedsAttention = false
		}
	}

	prof, hasProf := h.profiles(r, []string{conv.SlackUserID})[conv.SlackUserID]
	if hasProf && conv.SlackUserName == "" {
		conv.SlackUserName = prof.Name
	}
	names := map[string]string{}
	images := map[string]string{}
	out := make([]chatMessage, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, chatMessage{SlackDMMessage: m, AuthorLabel: h.authorLabel(r.Context(), conv, m, names),
			AuthorImage: h.authorImage(r, prof, m, images)})
	}
	now := time.Now()
	ownerName := ""
	if relayActive(*conv, now) {
		ownerName = h.userName(r.Context(), conv.RelayOwnerID)
	}
	sendJSON(w, http.StatusOK, map[string]any{
		"success": true, "data": out,
		"conversation": chatListItem{
			SlackDMListItem: database.SlackDMListItem{SlackDMConversation: *conv},
			RelayActive:     relayActive(*conv, now), RelayOwnerName: ownerName,
			SlackUserImage: prof.Image,
		},
	})
}

// authorImage finds the photo for a message: the person's Slack photo, or the Velocity user's for
// messages sent through Claude or the dashboard. Velocity's own messages have none, and the page
// shows the Velocity mark for those.
func (h *SlackChatsHandler) authorImage(r *http.Request, person slackProfile, m database.SlackDMMessage, cache map[string]string) string {
	switch m.Kind {
	case database.DMKindHuman:
		return person.Image
	case database.DMKindClaude, database.DMKindDashboard:
		user := middleware.GetUserFromContext(r)
		if h.userImage == nil || user == nil || m.SentByUserID == "" {
			return ""
		}
		if _, ok := cache[m.SentByUserID]; !ok {
			cache[m.SentByUserID] = h.userImage(r.Context(), user.ID, m.SentByUserID)
		}
		return cache[m.SentByUserID]
	default:
		return ""
	}
}

// authorLabel names who wrote a message: the person, a Velocity user (for messages sent through
// Claude or the dashboard), or Velocity itself (auto-replies, acks and alerts).
func (h *SlackChatsHandler) authorLabel(ctx context.Context, conv *database.SlackDMConversation, m database.SlackDMMessage, cache map[string]string) string {
	switch m.Kind {
	case database.DMKindHuman:
		if conv.SlackUserName != "" {
			return conv.SlackUserName
		}
		return "Unknown person"
	case database.DMKindClaude, database.DMKindDashboard:
		if m.SentByUserID == "" {
			return "Velocity"
		}
		if _, ok := cache[m.SentByUserID]; !ok {
			cache[m.SentByUserID] = h.userName(ctx, m.SentByUserID)
		}
		if cache[m.SentByUserID] != "" {
			return cache[m.SentByUserID]
		}
		return "A Velocity user"
	default:
		return "Velocity"
	}
}

// Reply handles POST /api/slack-chats/{channel}/reply {text}. The message goes out as Velocity,
// exactly as written with no name added, and opens a relay so the person's answer comes back
// here instead of getting a joke from the bot.
func (h *SlackChatsHandler) Reply(w http.ResponseWriter, r *http.Request) {
	ch, ok := channelParam(w, r)
	if !ok {
		return
	}
	user := middleware.GetUserFromContext(r)
	if user == nil {
		chatFail(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		chatFail(w, http.StatusBadRequest, "invalid request")
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		chatFail(w, http.StatusBadRequest, "write a message first")
		return
	}
	if len([]rune(text)) > maxChatReplyRunes {
		chatFail(w, http.StatusBadRequest, "that message is too long, keep it under "+strconv.Itoa(maxChatReplyRunes)+" characters")
		return
	}
	conv, err := h.store.GetConversation(r.Context(), ch)
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to load chat")
		return
	}
	if conv == nil || conv.SlackUserID == "" {
		chatFail(w, http.StatusNotFound, "conversation not found")
		return
	}

	// Finish the send even if the browser tab closes midway, same as the Day Track send.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 45*time.Second)
	defer cancel()
	if _, _, err := h.sender.QuickSend(ctx, user.ID, "", text, conv.SlackUserID, "quick_send"); err != nil {
		chatFail(w, http.StatusBadGateway, "Slack did not accept the message: "+err.Error())
		return
	}
	// Answering means the admin has dealt with what the person said.
	_ = h.store.ClearAttention(ctx, ch)
	sendJSON(w, http.StatusOK, map[string]any{"success": true})
}

// SetMode handles PUT /api/slack-chats/{channel}/mode {mode: smart|auto|muted}.
func (h *SlackChatsHandler) SetMode(w http.ResponseWriter, r *http.Request) {
	ch, ok := channelParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		chatFail(w, http.StatusBadRequest, "invalid request")
		return
	}
	switch body.Mode {
	case database.DMModeSmart, database.DMModeAuto, database.DMModeMuted:
	default:
		chatFail(w, http.StatusBadRequest, "mode must be smart, auto or muted")
		return
	}
	found, err := h.store.SetMode(r.Context(), ch, body.Mode)
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to change mode")
		return
	}
	if !found {
		chatFail(w, http.StatusNotFound, "conversation not found")
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true})
}

// Resolve handles POST /api/slack-chats/{channel}/resolve: passes the chat back to the bot. The
// relay ends, the "needs you" flag clears, and the bot answers a message that is still waiting.
func (h *SlackChatsHandler) Resolve(w http.ResponseWriter, r *http.Request) {
	ch, ok := channelParam(w, r)
	if !ok {
		return
	}
	conv, err := h.store.GetConversation(r.Context(), ch)
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to resolve")
		return
	}
	found, err := h.store.ResolveRelay(r.Context(), ch)
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to resolve")
		return
	}
	if !found {
		chatFail(w, http.StatusNotFound, "conversation not found")
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true, "answering": h.answerIfWaiting(r, conv)})
}

// answerIfWaiting has the bot answer the person's latest message when nobody has yet. It only runs
// when the chat was being held for an admin, so a repeated click cannot make the bot answer twice.
func (h *SlackChatsHandler) answerIfWaiting(r *http.Request, conv *database.SlackDMConversation) bool {
	user := middleware.GetUserFromContext(r)
	if h.answer == nil || h.botToken == nil || user == nil || conv == nil || conv.Mode == database.DMModeMuted {
		return false
	}
	if conv.RelayOwnerID == "" && !conv.NeedsAttention {
		return false
	}
	msgs, err := h.store.ListMessages(r.Context(), conv.ChannelID, 0, 20)
	if err != nil {
		return false
	}
	waiting := waitingMessage(msgs)
	if waiting == nil {
		return false
	}
	token := h.botToken(r.Context(), user.ID)
	if token == "" {
		return false
	}
	if _, busy := h.answering.LoadOrStore(conv.ChannelID, true); busy {
		return false
	}
	ev := slackInnerEvent{Type: "message", ChannelType: "im", Channel: conv.ChannelID, User: conv.SlackUserID,
		Text: waiting.Text, TS: waiting.SlackTS, ThreadTS: waiting.ThreadTS}
	go func() {
		defer h.answering.Delete(conv.ChannelID)
		defer logging.Recover(logging.Detach(r.Context()), "slack_chat_answer")
		ctx, cancel := context.WithTimeout(logging.Detach(r.Context()), 2*time.Minute)
		defer cancel()
		h.answer(ctx, token, ev)
	}()
	return true
}

// waitingMessage returns the person's latest message if nothing has answered it yet. The bot's
// "passed this on" line and the alert to the admin are not answers, so they are skipped.
func waitingMessage(msgs []database.SlackDMMessage) *database.SlackDMMessage {
	for i := len(msgs) - 1; i >= 0; i-- {
		switch msgs[i].Kind {
		case database.DMKindAck, database.DMKindNotice:
			continue
		case database.DMKindHuman:
			return &msgs[i]
		default:
			return nil
		}
	}
	return nil
}
