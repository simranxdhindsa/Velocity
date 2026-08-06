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
				var slackTS string
				var sendErr error
				if msg.DmUserID != "" {
					_, ts, e := svc.QuickSend(ctx, msg.UserID, "", msg.Message, msg.DmUserID, "claude_queue")
					slackTS, sendErr = ts, e
				} else {
					ts, _, e := svc.QuickSend(ctx, msg.UserID, msg.ChannelID, msg.Message, "", "claude_queue")
					slackTS, sendErr = ts, e
				}
				if sendErr != nil {
					log.Printf("⚠️  pending-messages scheduler: send failed for %s: %v", msg.ID, sendErr)
					_ = repo.MarkFailed(ctx, msg.ID, sendErr.Error())
					if notifHandler != nil {
						_ = notifHandler.CreateAndBroadcast(ctx, &models.Notification{
							UserID:  msg.UserID,
							Type:    "update_reminder_failed",
							Title:   "Claude Queue message failed",
							Message: truncateStr(msg.Message, 120) + ": " + sendErr.Error(),
						})
					}
				} else {
					_ = repo.MarkSent(ctx, msg.ID, slackTS)
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

	var slackTS string
	if target.DmUserID != "" {
		_, ts, e := h.updateSvc.QuickSend(r.Context(), u.ID, "", target.Message, target.DmUserID, "claude_queue")
		if e != nil {
			_ = h.repo.MarkFailed(r.Context(), id, e.Error())
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": e.Error()})
			return
		}
		slackTS = ts
	} else {
		ts, _, e := h.updateSvc.QuickSend(r.Context(), u.ID, target.ChannelID, target.Message, "", "claude_queue")
		if e != nil {
			_ = h.repo.MarkFailed(r.Context(), id, e.Error())
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": e.Error()})
			return
		}
		slackTS = ts
	}

	_ = h.repo.MarkSent(r.Context(), id, slackTS)
	writeJSON(w, http.StatusOK, map[string]string{"slack_ts": slackTS})
}
