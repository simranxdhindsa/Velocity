package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
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
	// rewrite asks the AI to rewrite a draft (nil = AI not configured).
	rewrite func(ctx context.Context, system, user string) (string, error)
}

func NewSlackChatsHandler() *SlackChatsHandler {
	users := database.NewUserRepository()
	integrations := database.NewIntegrationRepository()
	return &SlackChatsHandler{
		store:   database.NewSlackDMRepository(),
		sender:  updatesvc.NewService(),
		profile: slackProfileLookup(integrations),
		rewrite: groqRewrite,
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

// Summary handles GET /api/slack-chats/summary -> how many chats need the admin (the badge).
func (h *SlackChatsHandler) Summary(w http.ResponseWriter, r *http.Request) {
	n, err := h.store.CountNeedingAttention(r.Context())
	if err != nil {
		chatFail(w, http.StatusInternalServerError, "failed to load summary")
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"success": true, "data": map[string]int{"needs_attention": n}})
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
	out := make([]chatMessage, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, chatMessage{SlackDMMessage: m, AuthorLabel: h.authorLabel(r.Context(), conv, m, names)})
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

// Reply handles POST /api/slack-chats/{channel}/reply {text}. The message goes out as Velocity
// with a short signature naming the admin, and opens a relay so the person's answer comes back
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

	name := h.userName(r.Context(), user.ID)
	if name == "" {
		name = user.Name
	}
	message := text
	if name != "" {
		message += "\n_" + name + " (via Velocity)_"
	}
	// Finish the send even if the browser tab closes midway, same as the Day Track send.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 45*time.Second)
	defer cancel()
	if _, _, err := h.sender.QuickSend(ctx, user.ID, "", message, conv.SlackUserID, "quick_send"); err != nil {
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

// Resolve handles POST /api/slack-chats/{channel}/resolve: ends the relay so the bot answers
// this person again, and clears the "needs you" flag.
func (h *SlackChatsHandler) Resolve(w http.ResponseWriter, r *http.Request) {
	ch, ok := channelParam(w, r)
	if !ok {
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
	sendJSON(w, http.StatusOK, map[string]any{"success": true})
}
