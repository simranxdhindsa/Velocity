package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/mux"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
	updatesvc "github.com/dhindsa/project-management/internal/services/update_reminder"
)

// PendingMessagesHandler handles /api/slack/queued routes (JWT-protected).
type PendingMessagesHandler struct {
	repo      *database.PendingMessagesRepository
	updateSvc *updatesvc.Service
	slackSvc  *slacksvc.Service
}

func NewPendingMessagesHandler() *PendingMessagesHandler {
	return &PendingMessagesHandler{
		repo:      database.NewPendingMessagesRepository(),
		updateSvc: updatesvc.NewService(),
		slackSvc:  slacksvc.NewService(),
	}
}

// GET /api/slack/queued — list all messages (pending + recent sent/failed)
func (h *PendingMessagesHandler) List(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	msgs, err := h.repo.ListByUser(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

// PUT /api/slack/queued/{id} — edit message text and/or scheduled_at
func (h *PendingMessagesHandler) Update(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := mux.Vars(r)["id"]

	var req struct {
		Message      string `json:"message"`
		ScheduledAt  string `json:"scheduled_at"`
		ChannelID    string `json:"channel_id"`
		ChannelLabel string `json:"channel_label"`
		DmUserID     string `json:"dm_user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	var scheduledAt *time.Time
	if req.ScheduledAt != "" {
		t, err := time.Parse(time.RFC3339, req.ScheduledAt)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid scheduled_at"})
			return
		}
		scheduledAt = &t
	}

	message := resolveSlackMentions(r.Context(), h.slackSvc, u.ID, req.Message)
	msg, err := h.repo.Update(r.Context(), id, u.ID, message, scheduledAt, req.ChannelID, req.ChannelLabel, req.DmUserID)
	if err != nil || msg == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found or already sent"})
		return
	}
	writeJSON(w, http.StatusOK, msg)
}

// DELETE /api/slack/queued/{id} — cancel and remove
func (h *PendingMessagesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := mux.Vars(r)["id"]
	if err := h.repo.Delete(r.Context(), id, u.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// RunPendingMessagesScheduler starts a background goroutine that fires due messages every 60s.
func RunPendingMessagesScheduler(notifHandler *NotificationHandler) {
	repo := database.NewPendingMessagesRepository()
	svc := updatesvc.NewService()
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			ctx := context.Background()
			msgs, err := repo.GetDueMessages(ctx)
			if err != nil {
				log.Printf("⚠️  pending-messages scheduler: query error: %v", err)
				continue
			}
			for _, msg := range msgs {
				_, _, sendErr := sendQueuedMessage(ctx, svc, repo, msg)
				if sendErr != nil {
					log.Printf("⚠️  pending-messages scheduler: send failed for %s: %v", msg.ID, sendErr)
					if notifHandler != nil {
						_ = notifHandler.CreateAndBroadcast(ctx, &models.Notification{
							UserID:  msg.UserID,
							Type:    "update_reminder_failed",
							Title:   "Claude Queue message failed",
							Message: truncateStr(msg.Message, 120) + ": " + sendErr.Error(),
						})
					}
				} else {
					log.Printf("✅ pending-messages scheduler: sent %s to %s", msg.ID, msg.ChannelLabel)
					if notifHandler != nil {
						_ = notifHandler.CreateAndBroadcast(ctx, &models.Notification{
							UserID:  msg.UserID,
							Type:    "update_reminder_sent",
							Title:   "Claude Queue message sent",
							Message: truncateStr(msg.Message, 120) + " → " + msg.ChannelLabel,
						})
					}
				}
			}
		}
	}()
}

// sendQueuedMessage sends one Claude Queue row now and records the outcome: the real
// message ts plus the conversation it landed in (for a DM, the D-channel, which the row
// didn't have), or the error. Shared by the scheduler and "Send now" so the two can't
// drift apart again; both used to read QuickSend's (ts, channel) the wrong way round
// for DMs, storing the channel ID as the ts.
func sendQueuedMessage(ctx context.Context, svc *updatesvc.Service, repo *database.PendingMessagesRepository, msg database.PendingSlackMessage) (slackTS, channelID string, err error) {
	chArg := msg.ChannelID
	if msg.DmUserID != "" {
		chArg = ""
	}
	slackTS, channelID, err = svc.QuickSend(ctx, msg.UserID, chArg, msg.Message, msg.DmUserID, "claude_queue")
	if err != nil {
		_ = repo.MarkFailed(ctx, msg.ID, err.Error())
		return "", "", err
	}
	_ = repo.MarkSentTo(ctx, msg.ID, slackTS, channelID)
	return slackTS, channelID, nil
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// POST /api/slack/queued — manually schedule a new message
func (h *PendingMessagesHandler) Create(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req struct {
		Message      string `json:"message"`
		ScheduledAt  string `json:"scheduled_at"`
		ChannelID    string `json:"channel_id"`
		ChannelLabel string `json:"channel_label"`
		DmUserID     string `json:"dm_user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if req.Message == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message required"})
		return
	}

	var scheduledAt *time.Time
	if req.ScheduledAt != "" {
		t, err := time.Parse(time.RFC3339, req.ScheduledAt)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid scheduled_at"})
			return
		}
		scheduledAt = &t
	}

	message := resolveSlackMentions(r.Context(), h.slackSvc, u.ID, req.Message)
	msg, err := h.repo.Create(r.Context(), u.ID, message, req.ChannelID, req.ChannelLabel, req.DmUserID, scheduledAt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, msg)
}

// POST /api/slack/queued/{id}/send-now — send immediately regardless of scheduled_at
func (h *PendingMessagesHandler) SendNow(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := mux.Vars(r)["id"]

	msgs, err := h.repo.ListByUser(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	var target *database.PendingSlackMessage
	for i := range msgs {
		if msgs[i].ID == id && msgs[i].Status == "pending" {
			target = &msgs[i]
			break
		}
	}
	if target == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "pending message not found"})
		return
	}

	slackTS, sentChannel, e := sendQueuedMessage(r.Context(), h.updateSvc, h.repo, *target)
	if e != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": e.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"slack_ts": slackTS, "channel_id": sentChannel})
}
