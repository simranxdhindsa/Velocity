package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// SentSlackMessagesHandler serves the Slack Messages hub — a unified view over
// every message Velocity has sent to Slack, regardless of which feature sent it.
type SentSlackMessagesHandler struct {
	repo     *database.SentSlackMessagesRepository
	slackSvc *slacksvc.Service
}

func NewSentSlackMessagesHandler() *SentSlackMessagesHandler {
	return &SentSlackMessagesHandler{
		repo:     database.NewSentSlackMessagesRepository(),
		slackSvc: slacksvc.NewService(),
	}
}

// GET /api/slack/hub/messages?channel_id=&source=
func (h *SentSlackMessagesHandler) List(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	channelID := r.URL.Query().Get("channel_id")
	source := r.URL.Query().Get("source")

	msgs, err := h.repo.List(r.Context(), u.ID, channelID, source, 100)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

// GET /api/slack/hub/live-messages?channel_id=&thread_ts=
// Returns the real, live channel history from Slack — every sender, not just
// Velocity's own sends. Pass thread_ts to fetch a thread's replies instead.
func (h *SentSlackMessagesHandler) GetLive(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	channelID := r.URL.Query().Get("channel_id")
	threadTS := r.URL.Query().Get("thread_ts")
	if channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel_id is required"})
		return
	}

	messages, err := h.slackSvc.GetLiveChannelMessages(r.Context(), u.ID, channelID, threadTS)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, messages)
}

// POST /api/slack/hub/messages — send a new message to a channel
func (h *SentSlackMessagesHandler) Send(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req struct {
		ChannelID    string `json:"channel_id"`
		ChannelLabel string `json:"channel_label"`
		Message      string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if req.ChannelID == "" || req.Message == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel_id and message are required"})
		return
	}

	message := resolveSlackMentions(r.Context(), h.slackSvc, u.ID, req.Message)
	if err := h.slackSvc.PostMessage(r.Context(), u.ID, req.ChannelID, "hub", message); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// PUT /api/slack/hub/messages/{id} — edit a previously-sent message
func (h *SentSlackMessagesHandler) Update(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := mux.Vars(r)["id"]

	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Message == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message is required"})
		return
	}

	msg, err := h.repo.GetByID(r.Context(), id, u.ID)
	if err != nil || msg == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found"})
		return
	}

	message := resolveSlackMentions(r.Context(), h.slackSvc, u.ID, req.Message)
	if err := h.slackSvc.UpdateMessage(r.Context(), u.ID, msg.ChannelID, msg.SlackTs, message); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := h.repo.UpdateText(r.Context(), id, u.ID, message); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// DELETE /api/slack/hub/messages/{id}
func (h *SentSlackMessagesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := mux.Vars(r)["id"]

	msg, err := h.repo.GetByID(r.Context(), id, u.ID)
	if err != nil || msg == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found"})
		return
	}

	if err := h.slackSvc.DeleteMessage(r.Context(), u.ID, msg.ChannelID, msg.SlackTs); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := h.repo.Delete(r.Context(), id, u.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}
