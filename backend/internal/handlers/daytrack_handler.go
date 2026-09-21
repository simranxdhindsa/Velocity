package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
	"github.com/gorilla/mux"
)

// ── Transcription ─────────────────────────────────────────────────────────────

// Transcribe proxies an audio blob to Groq's Whisper API and returns the transcribed text.
func (h *DayTrackHandler) Transcribe(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(25 << 20); err != nil {
		http.Error(w, "failed to parse form", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("audio")
	if err != nil {
		http.Error(w, "audio file required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	groqKey := os.Getenv("GROQ_API_KEY")
	if groqKey == "" {
		http.Error(w, "groq not configured", http.StatusServiceUnavailable)
		return
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", header.Filename)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(fw, file); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = mw.WriteField("model", "whisper-large-v3")
	_ = mw.WriteField("language", "en")
	_ = mw.WriteField("response_format", "json")
	mw.Close()

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		"https://api.groq.com/openai/v1/audio/transcriptions", &buf)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+groqKey)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		http.Error(w, string(body), resp.StatusCode)
		return
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, map[string]string{"text": strings.TrimSpace(result.Text)})
}

// ── Slack config endpoints ────────────────────────────────────────────────────

// GetSlackConfig returns the user's DayTrack Slack auto-logging config.
// If no config exists yet, returns default keyword rules with empty channel fields.
func (h *DayTrackHandler) GetSlackConfig(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	cfg, err := h.repo.GetSlackConfig(r.Context(), userID)
	if err != nil {
		// Not found — return defaults
		dtJSON(w, map[string]interface{}{
			"channel_id":        "",
			"channel_name":      "",
			"slack_user_id":     "",
			"enabled":           true,
			"keyword_rules":     DefaultKeywordRules(),
			"dest_channel_id":   "",
			"dest_channel_name": "",
			"timezone":          "Asia/Kolkata",
			"auto_send_enabled": false,
		})
		return
	}
	dtJSON(w, cfg)
}

// UpsertSlackConfig saves the user's DayTrack Slack config.
func (h *DayTrackHandler) UpsertSlackConfig(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var body database.DayTrackSlackConfig
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	body.UserID = userID
	if len(body.KeywordRules) == 0 {
		body.KeywordRules = DefaultKeywordRules()
	}
	if err := h.repo.UpsertSlackConfig(r.Context(), &body); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, map[string]bool{"ok": true})
}

// TriggerSlackScan manually triggers a scan for the calling user only.
func (h *DayTrackHandler) TriggerSlackScan(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	cfg, err := h.repo.GetSlackConfig(r.Context(), userID)
	if err != nil || cfg.ChannelID == "" || cfg.SlackUserID == "" {
		http.Error(w, "no slack config or missing channel/user", http.StatusBadRequest)
		return
	}
	// Get bot token from slack_integrations
	pool := database.GetPool()
	var botToken string
	_ = pool.QueryRow(r.Context(),
		`SELECT bot_token FROM slack_integrations WHERE user_id=$1 AND connected=true`, userID,
	).Scan(&botToken)
	if botToken == "" {
		http.Error(w, "slack not connected", http.StatusBadRequest)
		return
	}
	scanCfg := database.SlackScanConfig{
		UserID:        userID,
		ChannelID:     cfg.ChannelID,
		SlackUserID:   cfg.SlackUserID,
		LastScannedTS: cfg.LastScannedTS,
		BotToken:      botToken,
		KeywordRules:  cfg.KeywordRules,
	}
	// Use a detached context — r.Context() is cancelled as soon as the HTTP response is sent.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		scanUserChannel(ctx, h.repo, scanCfg)
	}()
	dtJSON(w, map[string]bool{"ok": true})
}

// ResetSlackScan clears last_scanned_ts so the next scan picks up messages from today's start.
func (h *DayTrackHandler) ResetSlackScan(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if err := h.repo.ResetSlackConfigLastScanned(r.Context(), userID); err != nil {
		http.Error(w, "reset failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, map[string]bool{"ok": true})
}

// ResolveSlackUser looks up the calling user's Slack member ID via their email.
func (h *DayTrackHandler) ResolveSlackUser(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	pool := database.GetPool()
	var botToken, email string
	_ = pool.QueryRow(r.Context(),
		`SELECT si.bot_token, u.email
		 FROM slack_integrations si JOIN users u ON u.id=si.user_id
		 WHERE si.user_id=$1 AND si.connected=true`, userID,
	).Scan(&botToken, &email)
	if botToken == "" {
		http.Error(w, "slack not connected", http.StatusBadRequest)
		return
	}
	slackUID := SlackUserIDFromEmail(r.Context(), botToken, email)
	dtJSON(w, map[string]string{"slack_user_id": slackUID})
}

// timeToMins converts "2:30 PM" or "14:30" to total minutes for comparison
func timeToMins(t string) int {
	t = strings.TrimSpace(t)
	if t == "" {
		return -1
	}
	isPM := strings.Contains(strings.ToUpper(t), "PM")
	isAM := strings.Contains(strings.ToUpper(t), "AM")
	t = strings.ToUpper(strings.ReplaceAll(strings.ReplaceAll(t, "PM", ""), "AM", ""))
	t = strings.TrimSpace(t)
	parts := strings.Split(t, ":")
	if len(parts) != 2 {
		return -1
	}
	h, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
	m, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
	if isPM && h != 12 {
		h += 12
	}
	if isAM && h == 12 {
		h = 0
	}
	return h*60 + m
}

type DayTrackHandler struct {
	repo      *database.DayTrackRepository
	userRepo  *database.UserRepository
	ytHandler *YouTrackHandler
}

func NewDayTrackHandler(ytHandler *YouTrackHandler) *DayTrackHandler {
	return &DayTrackHandler{
		repo:      database.NewDayTrackRepository(),
		userRepo:  database.NewUserRepository(),
		ytHandler: ytHandler,
	}
}

// istToday returns today's date ("2006-01-02") in Asia/Kolkata, DayTrack's default timezone.
func istToday() string {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		return time.Now().Format("2006-01-02")
	}
	return time.Now().In(loc).Format("2006-01-02")
}

// pruneDeletedYouTrackEntries checks every distinct YouTrack issue ID referenced by today's
// entries against YouTrack and deletes (both the DayTrack entry and its issue_state_log
// history) any whose ticket was confirmed deleted (404). Deliberately conservative: any
// other outcome — YouTrack not configured, a transient/auth/network error — leaves the
// entry alone rather than risk deleting real data on an ambiguous signal.
//
// Scoped to today only, and skipped entirely once today's update has already been posted
// to Slack — an entry that's part of a sent record must not silently disappear. Past dates
// are never touched (deleting historical entries retroactively is out of scope).
func (h *DayTrackHandler) pruneDeletedYouTrackEntries(ctx context.Context, userID string, entries []database.DayTrackEntry) []database.DayTrackEntry {
	if h.ytHandler == nil {
		return entries
	}
	client, err := h.ytHandler.getYouTrackClient(ctx)
	if err != nil || client == nil {
		return entries
	}

	today := istToday()
	alreadyPosted := false
	if post, postErr := h.repo.GetDailyPost(ctx, userID, today); postErr == nil && post != nil {
		alreadyPosted = true
	}

	checked := make(map[string]bool) // issueID -> exists
	deleted := make(map[string]bool)
	for _, e := range entries {
		if e.EntrySource != "youtrack" || e.YoutrackIssueID == nil || *e.YoutrackIssueID == "" {
			continue
		}
		if e.EntryDate != today || alreadyPosted {
			continue
		}
		issueID := *e.YoutrackIssueID
		if _, done := checked[issueID]; done {
			continue
		}
		_, err := client.GetIssue(ctx, issueID)
		if err == nil {
			checked[issueID] = true
			continue
		}
		if err.Error() == "YouTrack resource not found" {
			checked[issueID] = false
			deleted[issueID] = true
			if pruneErr := h.repo.PruneEntriesForDeletedIssue(ctx, issueID); pruneErr != nil {
				log.Printf("[DayTrack Webhook] ✗ %s confirmed deleted on YouTrack (page load check) but failed to prune: %v", issueID, pruneErr)
			} else {
				log.Printf("[DayTrack Webhook] ✓ %s deleted on YouTrack → removed its DayTrack entries (page load check)", issueID)
			}
		} else {
			// Ambiguous failure (network/auth/rate-limit) — keep the entry, don't guess.
			checked[issueID] = true
		}
	}
	if len(deleted) == 0 {
		return entries
	}
	out := entries[:0]
	for _, e := range entries {
		if e.YoutrackIssueID != nil && deleted[*e.YoutrackIssueID] {
			continue
		}
		out = append(out, e)
	}
	return out
}

func dtJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// ── AI Summarize ──────────────────────────────────────────────────────────────

type summarizeRequest struct {
	DateLabel string `json:"date_label"`
	Lines     []struct {
		Category string `json:"category"`
		Name     string `json:"name"`
		Duration string `json:"duration"`
		Notes    string `json:"notes"`
	} `json:"lines"`
}

// Summarize calls Groq to produce a natural-language standup summary from DayTrack entries.
// Ticket entries (marked is_ticket=true on the frontend) are passed through unchanged.
func (h *DayTrackHandler) Summarize(w http.ResponseWriter, r *http.Request) {
	var req summarizeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.Lines) == 0 {
		dtJSON(w, map[string]string{"summary": ""})
		return
	}

	groqKey := os.Getenv("GROQ_API_KEY")
	if groqKey == "" {
		http.Error(w, "AI not configured (GROQ_API_KEY missing)", http.StatusServiceUnavailable)
		return
	}

	// Build a compact bullet list for the prompt
	var sb strings.Builder
	for _, l := range req.Lines {
		sb.WriteString("- [")
		sb.WriteString(l.Category)
		sb.WriteString("] ")
		sb.WriteString(l.Name)
		if l.Duration != "" {
			sb.WriteString(" (")
			sb.WriteString(l.Duration)
			sb.WriteString(")")
		}
		if l.Notes != "" {
			sb.WriteString(" — ")
			sb.WriteString(l.Notes)
		}
		sb.WriteString("\n")
	}

	systemPrompt := `You are a work log editor. Fix grammar and clarity only — do NOT change structure, tone, or length.

RULES (non-negotiable):
- Every input bullet → exactly one output bullet starting with "- "
- NEVER merge two bullets into one. NEVER split one bullet into two.
- NEVER write paragraphs. NEVER add intros or closing lines.
- Keep entries SHORT and direct — 1 line per bullet, no filler words
- Do not add "I" at the start. Keep lowercase action verbs.
- Expand abbreviations: FE→Frontend, BE→Backend, MC→Mission Control, SW/Studio→Studio-Web, UI→UI app
- Omit Sign In, Sign Off, and break entries entirely

TONE — casual and direct (not formal):
  BAD:  "investigated and resolved the Postman running issue on Rohit's laptop"
  GOOD: "fixed Postman issue on Rohit's laptop"

  BAD:  "gave a KT session to Rohit on how to create a JSON collection in Postman"
  GOOD: "gave KT to Rohit on creating JSON collection in Postman"

  BAD:  "tested and validated SCORM scraping behaviour on the DEV environment"
  GOOD: "tested SCORM scraping on DEV"

EXAMPLE (input → output, bullet-for-bullet):
Input:
- [Testing] Tested SCORM scraping on DEV and STAGE
- [Testing] ARD-1700: Verified publish flow on Studio-Web
- [Meetings] KT to Rohit on Voiden

Output:
- tested SCORM scraping on DEV and STAGE
- verified publish flow on Studio-Web (ARD-1700)
- gave KT to Rohit on Voiden

Output only the bullets — nothing else.`

	userPrompt := "Work entries for " + req.DateLabel + ":\n" + sb.String() + "\nOutput one bullet per entry:"

	body, err := callGroqChat(r.Context(), groqKey, "llama-3.3-70b-versatile", systemPrompt, userPrompt)
	if err != nil {
		http.Error(w, "AI call failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, map[string]string{"summary": body})
}

func callGroqChat(ctx context.Context, apiKey, model, system, user string, maxTokens ...int) (string, error) {
	tokens := 1024
	if len(maxTokens) > 0 && maxTokens[0] > 0 {
		tokens = maxTokens[0]
	}
	payload := map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"stream":      false,
		"temperature": 0,
		"max_tokens":  tokens,
	}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.groq.com/openai/v1/chat/completions", bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
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
	return strings.TrimSpace(res.Choices[0].Message.Content), nil
}

// ── Entries ───────────────────────────────────────────────────────────────────

func (h *DayTrackHandler) GetEntries(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	date := r.URL.Query().Get("date")
	if date == "" {
		http.Error(w, "date required", http.StatusBadRequest)
		return
	}
	entries, err := h.repo.GetEntries(r.Context(), userID, date)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	entries = h.pruneDeletedYouTrackEntries(r.Context(), userID, entries)
	dtJSON(w, entries)
}

func (h *DayTrackHandler) CreateEntry(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var body struct {
		Date          string  `json:"entry_date"`
		Name          string  `json:"name"`
		Category      string  `json:"category"`
		StartTime     string  `json:"start_time"`
		EndTime       string  `json:"end_time"`
		DurationMins  *int    `json:"duration_mins"`
		Notes         string  `json:"notes"`
		Status        string  `json:"status"`
		ParentEntryID *string `json:"parent_entry_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if body.Name == "" || body.Date == "" {
		http.Error(w, "name and entry_date required", http.StatusBadRequest)
		return
	}
	if body.Category == "" {
		body.Category = "General"
	}
	if body.Status == "" {
		body.Status = "done"
	}
	// Validate subtask start time is not earlier than parent start time
	if body.ParentEntryID != nil {
		parent, err := h.repo.GetEntryByID(r.Context(), *body.ParentEntryID, userID)
		if err == nil && parent != nil && parent.StartTime != "" && body.StartTime != "" {
			if timeToMins(body.StartTime) < timeToMins(parent.StartTime) {
				http.Error(w, "subtask start time cannot be earlier than parent start time", http.StatusBadRequest)
				return
			}
		}
	}
	entry, err := h.repo.CreateEntry(r.Context(), userID, body.Date, body.Name, body.Category, body.StartTime, body.EndTime, body.DurationMins, body.Notes, body.Status, body.ParentEntryID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(entry)
}

func (h *DayTrackHandler) UpdateEntry(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	id := mux.Vars(r)["id"]
	var body struct {
		Name         string `json:"name"`
		Category     string `json:"category"`
		StartTime    string `json:"start_time"`
		EndTime      string `json:"end_time"`
		DurationMins *int   `json:"duration_mins"`
		Notes        string `json:"notes"`
		Status       string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	entry, err := h.repo.UpdateEntry(r.Context(), id, userID, body.Name, body.Category, body.StartTime, body.EndTime, body.DurationMins, body.Notes, body.Status)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, entry)
}

func (h *DayTrackHandler) DeleteEntry(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	id := mux.Vars(r)["id"]
	if err := h.repo.DeleteEntry(r.Context(), id, userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *DayTrackHandler) GetEntriesRange(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	start := r.URL.Query().Get("start")
	end := r.URL.Query().Get("end")
	if start == "" || end == "" {
		http.Error(w, "start and end required", http.StatusBadRequest)
		return
	}
	entries, err := h.repo.GetEntriesRange(r.Context(), userID, start, end)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	entries = h.pruneDeletedYouTrackEntries(r.Context(), userID, entries)
	dtJSON(w, entries)
}

// ── Planned ───────────────────────────────────────────────────────────────────

func (h *DayTrackHandler) GetPlanned(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	date := r.URL.Query().Get("date")
	if date == "" {
		http.Error(w, "date required", http.StatusBadRequest)
		return
	}
	items, err := h.repo.GetPlanned(r.Context(), userID, date)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, items)
}

func (h *DayTrackHandler) CreatePlanned(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var body struct {
		Date          string `json:"entry_date"`
		Name          string `json:"name"`
		Category      string `json:"category"`
		ScheduledTime string `json:"scheduled_time"`
		StartTime     string `json:"start_time"`
		EndTime       string `json:"end_time"`
		WhenType      string `json:"when_type"`
		Notes         string `json:"notes"`
		Status        string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if body.Name == "" || body.Date == "" {
		http.Error(w, "name and entry_date required", http.StatusBadRequest)
		return
	}
	if body.Category == "" {
		body.Category = "General"
	}
	if body.WhenType == "" {
		body.WhenType = "today"
	}
	if body.Status == "" {
		body.Status = "planned"
	}
	item, err := h.repo.CreatePlanned(r.Context(), userID, body.Date, body.Name, body.Category, body.ScheduledTime, body.StartTime, body.EndTime, body.WhenType, body.Notes, body.Status)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(item)
}

func (h *DayTrackHandler) UpdatePlanned(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	id := mux.Vars(r)["id"]
	var body struct {
		Name          string `json:"name"`
		Category      string `json:"category"`
		ScheduledTime string `json:"scheduled_time"`
		StartTime     string `json:"start_time"`
		EndTime       string `json:"end_time"`
		WhenType      string `json:"when_type"`
		Notes         string `json:"notes"`
		Status        string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	item, err := h.repo.UpdatePlanned(r.Context(), id, userID, body.Name, body.Category, body.ScheduledTime, body.StartTime, body.EndTime, body.WhenType, body.Notes, body.Status)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, item)
}

func (h *DayTrackHandler) DeletePlanned(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	id := mux.Vars(r)["id"]
	if err := h.repo.DeletePlanned(r.Context(), id, userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Suggestions ──────────────────────────────────────────────────────────────

func (h *DayTrackHandler) GetSuggestions(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	names, err := h.repo.GetSuggestions(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, names)
}

// ── Categories ────────────────────────────────────────────────────────────────

func (h *DayTrackHandler) GetCategories(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	cats, err := h.repo.GetCategories(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if cats == nil {
		cats = []string{}
	}
	dtJSON(w, cats)
}

func (h *DayTrackHandler) AddCategory(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	if err := h.repo.AddCategory(r.Context(), userID, name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"name": name})
}

func (h *DayTrackHandler) DeleteCategory(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	name := mux.Vars(r)["name"]
	if err := h.repo.DeleteCategory(r.Context(), userID, name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// daytracBuildSlackSections builds structured sections from DayTrack entries for Slack posting.
// Uses original category names as-is and correctly separates yt-tested entries into "Tickets Tested".
// Subtasks are rendered as indented nested bullets (◦) under their parent.
func daytracBuildSlackSections(entries []database.DayTrackEntry, displayName string) PersonUpdate {
	skipCat := map[string]bool{
		"sign in": true, "sign off": true, "signing in": true, "signing off": true,
		"time on": true, "time off": true, "time on/off": true,
		"break": true, "breaks": true,
	}

	// Build parent → subtasks lookup first
	subtaskMap := map[string][]database.DayTrackEntry{}
	for _, e := range entries {
		if e.ParentEntryID != nil && *e.ParentEntryID != "" {
			subtaskMap[*e.ParentEntryID] = append(subtaskMap[*e.ParentEntryID], e)
		}
	}

	sectionMap := map[string][]string{}
	var order []string

	for _, e := range entries {
		if e.ParentEntryID != nil && *e.ParentEntryID != "" {
			continue // rendered under parent below
		}
		cat := strings.ToLower(strings.TrimSpace(e.Category))
		if skipCat[cat] {
			continue
		}

		// yt-tested entries live in Testing category in DB; separate them here
		sec := e.Category
		if strings.HasPrefix(e.ExternalRef, "yt-tested-") {
			sec = "Tickets Tested"
		} else if sec == "Tickets" {
			sec = "Tickets Created" // legacy category name from older YouTrack sync
		}

		if _, seen := sectionMap[sec]; !seen {
			order = append(order, sec)
		}

		item := e.Name
		if e.Notes != "" {
			item += " — " + e.Notes
		}
		// Append subtasks as indented nested bullets
		for _, sub := range subtaskMap[e.ID] {
			subLine := "\n    ◦ " + sub.Name
			if sub.Notes != "" {
				subLine += " — " + sub.Notes
			}
			item += subLine
		}
		sectionMap[sec] = append(sectionMap[sec], item)
	}

	var sections []UpdateSection
	for _, label := range order {
		if len(sectionMap[label]) > 0 {
			sections = append(sections, UpdateSection{Label: label, Items: sectionMap[label]})
		}
	}
	return PersonUpdate{DisplayName: displayName, Sections: sections}
}

// errDayTrackNoEntries means there's nothing reportable for that user+date — not a failure,
// just nothing to send (e.g. the auto-send job hits a day with no entries yet).
var errDayTrackNoEntries = errors.New("no entries for date")

// postDayTrackUpdate refreshes entries against YouTrack (same prune the page does on load,
// so a ticket deleted after the page was last viewed doesn't get sent), builds the Slack
// report for userID+date, and posts it — or edits the existing post for that date in place.
// Shared by the manual "Post to Slack" button and the daily auto-send scheduler so both
// paths always send the exact same thing.
func (h *DayTrackHandler) postDayTrackUpdate(ctx context.Context, userID, date, destChannelID, displayName string) (updated bool, err error) {
	entries, err := h.repo.GetEntries(ctx, userID, date)
	if err != nil {
		return false, err
	}
	entries = h.pruneDeletedYouTrackEntries(ctx, userID, entries)

	ownerUpdate := daytracBuildSlackSections(entries, "")
	ownerUpdate.IsOwner = true
	if len(ownerUpdate.Sections) == 0 {
		return false, errDayTrackNoEntries
	}

	dateParsed, _ := time.Parse("2006-01-02", date)
	header := fmt.Sprintf("*%s*\n%s\n\n", displayName, dateParsed.Format("Mon, Jan 2"))
	text := header + standupFormatMrkdwn([]PersonUpdate{ownerUpdate})
	slackSvc := slacksvc.NewService()

	// Post once per (user, date); every later send for the same date edits that same
	// message in place instead of spamming a new one, so the channel always reflects
	// this day's latest entries under a single message.
	existing, _ := h.repo.GetDailyPost(ctx, userID, date)
	if existing != nil && existing.ChannelID == destChannelID {
		if err := slackSvc.UpdateMessage(ctx, userID, destChannelID, existing.SlackTS, text); err != nil {
			return false, err
		}
		if err := h.repo.UpsertDailyPost(ctx, userID, date, destChannelID, existing.SlackTS); err != nil {
			log.Printf("[DayTrack] failed to bump daily post updated_at: %v", err)
		}
		return true, nil
	}

	ts, err := slackSvc.PostMessage(ctx, userID, destChannelID, "daytrack", text)
	if err != nil {
		return false, err
	}
	if err := h.repo.UpsertDailyPost(ctx, userID, date, destChannelID, ts); err != nil {
		log.Printf("[DayTrack] failed to record daily post: %v", err)
	}
	return false, nil
}

// PostToSlack formats DayTrack entries for a given date and posts to the configured destination channel.
func (h *DayTrackHandler) PostToSlack(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	cfg, err := h.repo.GetSlackConfig(r.Context(), user.ID)
	if err != nil || cfg.DestChannelID == "" {
		http.Error(w, "no destination channel configured", http.StatusBadRequest)
		return
	}
	var reqBody struct {
		Date string `json:"date"`
	}
	_ = json.NewDecoder(r.Body).Decode(&reqBody)
	date := strings.TrimSpace(reqBody.Date)
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	displayName := user.Name
	if dbUser, err2 := h.userRepo.GetByID(r.Context(), user.ID); err2 == nil && dbUser.Name != "" {
		displayName = dbUser.Name
	}

	updated, err := h.postDayTrackUpdate(r.Context(), user.ID, date, cfg.DestChannelID, displayName)
	if err != nil {
		if errors.Is(err, errDayTrackNoEntries) {
			http.Error(w, "no entries for "+date, http.StatusBadRequest)
			return
		}
		http.Error(w, "failed to post: "+err.Error(), http.StatusInternalServerError)
		return
	}
	dtJSON(w, map[string]interface{}{"ok": true, "updated": updated})
}

// GetSlackPostStatus reports whether today's (or the given date's) DayTrack update has
// already been posted to Slack, so the frontend can show "Posted" vs "Post to Slack" and
// swap the button to an edit-in-place action.
func (h *DayTrackHandler) GetSlackPostStatus(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	date := strings.TrimSpace(r.URL.Query().Get("date"))
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	post, err := h.repo.GetDailyPost(r.Context(), user.ID, date)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if post == nil {
		dtJSON(w, map[string]interface{}{"posted": false})
		return
	}
	dtJSON(w, map[string]interface{}{
		"posted":     true,
		"posted_at":  post.PostedAt,
		"updated_at": post.UpdatedAt,
	})
}

// DeleteSlackPost deletes the Slack message posted for a given date (manually or via
// auto-send) and clears the daily-post record, so a mistaken send can be undone and the
// next "Post to Slack" starts a fresh message instead of trying to edit the deleted one.
func (h *DayTrackHandler) DeleteSlackPost(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	date := strings.TrimSpace(r.URL.Query().Get("date"))
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	post, err := h.repo.GetDailyPost(r.Context(), user.ID, date)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if post == nil {
		http.Error(w, "no post found for "+date, http.StatusBadRequest)
		return
	}
	slackSvc := slacksvc.NewService()
	if err := slackSvc.DeleteMessage(r.Context(), user.ID, post.ChannelID, post.SlackTS); err != nil {
		http.Error(w, "failed to delete from Slack: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.repo.DeleteDailyPost(r.Context(), user.ID, date); err != nil {
		log.Printf("[DayTrack] failed to clear daily post record: %v", err)
	}
	dtJSON(w, map[string]bool{"ok": true})
}

// ── Daily auto-send scheduler ─────────────────────────────────────────────────

// autoSendHour/autoSendMinute are hardcoded (11:50 PM IST) and deliberately not
// user-configurable — only whether auto-send is on is exposed on the frontend.
const (
	autoSendHour   = 23
	autoSendMinute = 50
)

// RunDayTrackAutoSendScheduler starts a background goroutine that, once a day at the fixed
// IST time above, posts each opted-in user's DayTrack update for today (IST) to their
// configured Slack channel — refreshed against YouTrack first (same prune the page does on
// load) so the auto-sent update matches what a manual click would send, and always scoped
// to today's date only, never a leftover previous day or a future one.
func RunDayTrackAutoSendScheduler(h *DayTrackHandler) {
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		lastSentDate := ""
		for range ticker.C {
			loc, err := time.LoadLocation("Asia/Kolkata")
			if err != nil {
				loc = time.UTC
			}
			now := time.Now().In(loc)
			if now.Hour() != autoSendHour || now.Minute() != autoSendMinute {
				continue
			}
			today := now.Format("2006-01-02")
			if today == lastSentDate {
				continue // already ran for this date this minute-window
			}
			lastSentDate = today
			runDayTrackAutoSend(h, today)
		}
	}()
}

func runDayTrackAutoSend(h *DayTrackHandler, date string) {
	listCtx, listCancel := context.WithTimeout(context.Background(), 30*time.Second)
	configs, err := h.repo.GetAllAutoSendConfigs(listCtx)
	listCancel()
	if err != nil {
		log.Printf("[DayTrack AutoSend] failed to load configs: %v", err)
		return
	}

	for _, cfg := range configs {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		displayName := ""
		if dbUser, err := h.userRepo.GetByID(ctx, cfg.UserID); err == nil {
			displayName = dbUser.Name
		}

		// Pull in newly created / tested / dev-moved tickets first — the same YouTrack
		// sync the manual sync-icon button runs — so the auto-sent update includes
		// today's latest ticket activity, not just whatever was already logged.
		if h.ytHandler != nil {
			if added, _, tested, dev, err := h.ytHandler.scanYouTrackTicketsForUser(ctx, cfg.UserID, date); err != nil {
				log.Printf("[DayTrack AutoSend] YouTrack sync failed for user %s: %v", cfg.UserID, err)
			} else if added+tested+dev > 0 {
				log.Printf("[DayTrack AutoSend] YouTrack sync for user %s: +%d created, +%d tested, +%d dev", cfg.UserID, added, tested, dev)
			}
		}

		if _, err := h.postDayTrackUpdate(ctx, cfg.UserID, date, cfg.DestChannelID, displayName); err != nil {
			if !errors.Is(err, errDayTrackNoEntries) {
				log.Printf("[DayTrack AutoSend] failed for user %s: %v", cfg.UserID, err)
			}
		} else {
			log.Printf("[DayTrack AutoSend] posted %s update for user %s", date, cfg.UserID)
		}
		cancel()
	}
}
