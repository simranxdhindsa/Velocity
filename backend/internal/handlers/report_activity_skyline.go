package handlers

import (
	"net/http"
	"strconv"
	"time"

	"github.com/dhindsa/project-management/internal/middleware"
)

// GetActivityByDay returns per-day ticket moves for the Dev Activity skyline.
// Query: since, until (unix ms, defaults to the last 371 days), tz (IANA name, default UTC),
// or day=YYYY-MM-DD for that day's individual moves.
func (h *ReportHandler) GetActivityByDay(w http.ResponseWriter, r *http.Request) {
	if middleware.GetUserFromContext(r) == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}
	q := r.URL.Query()
	until := time.Now().UTC()
	since := until.AddDate(0, 0, -371)
	if v, err := strconv.ParseInt(q.Get("since"), 10, 64); err == nil {
		since = time.UnixMilli(v).UTC()
	}
	if v, err := strconv.ParseInt(q.Get("until"), 10, 64); err == nil {
		until = time.UnixMilli(v).UTC()
	}
	if until.Sub(since) > 800*24*time.Hour {
		since = until.AddDate(0, 0, -800)
	}
	tz := "UTC"
	if v := q.Get("tz"); v != "" {
		if _, err := time.LoadLocation(v); err == nil {
			tz = v
		}
	}
	// ?day=YYYY-MM-DD → every move on that day (drill-down list)
	if day := q.Get("day"); day != "" {
		if _, err := time.Parse("2006-01-02", day); err != nil {
			sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "day must be YYYY-MM-DD"})
			return
		}
		moves, err := h.reportRepo.GetActivityDayMoves(r.Context(), day, tz)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: "Failed to load day: " + err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, Response{Success: true, Data: moves})
		return
	}
	rows, err := h.reportRepo.GetActivityByDay(r.Context(), since, until, tz)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{Success: false, Message: "Failed to load activity: " + err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: rows})
}
