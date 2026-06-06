package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

var (
	reStandupMention  = regexp.MustCompile(`<@[A-Z0-9]+>`)
	reStandupLink     = regexp.MustCompile(`<https?://[^|>]*\|([^>]*)>`)
	reStandupURL      = regexp.MustCompile(`<https?://[^>]*>`)
	reStandupEmoji    = regexp.MustCompile(`:[a-z0-9_+\-]+:`)
	reStandupEdited   = regexp.MustCompile(`\s*\(edited\)\s*$`)
	// Matches stray " Groq inserts between sections array close ] and root object close }
	reStrayEndQuote   = regexp.MustCompile(`\](\s*)"\s*}`)
	// Extracts ticket ID from Slack-wrapped YouTrack URLs: <https://...?issue=ARD-1850>
	reYouTrackSlack   = regexp.MustCompile(`<https?://[^>]*[?&]issue=([A-Z]+-\d+)[^>]*>`)
	// Extracts ticket ID from plain-text YouTrack URLs: https://...?issue=ARD-1850
	reYouTrackIssue   = regexp.MustCompile(`https?://\S*[?&]issue=([A-Z]+-\d+)\S*`)
	// Strips any remaining plain-text https?:// URLs after ticket extraction
	rePlainURL        = regexp.MustCompile(`https?://\S+`)
)

// cleanForGroq strips Slack mrkdwn noise before sending to Groq.
// Preserves original casing so ticket IDs (ARD-1234) stay uppercase.
// extractBalancedJSON finds the first `{` and returns the minimal well-formed JSON
// object using brace-depth tracking. Ignores preamble and trailing commentary Groq
// appends. Returns s[start:] (possibly truncated) when no balanced close found.
func extractBalancedJSON(s string) string {
	start := strings.Index(s, "{")
	if start < 0 {
		return s
	}
	depth := 0
	inStr := false
	escaped := false
	for i, r := range s[start:] {
		if escaped {
			escaped = false
			continue
		}
		if r == '\\' && inStr {
			escaped = true
			continue
		}
		if r == '"' {
			inStr = !inStr
			continue
		}
		if inStr {
			continue
		}
		if r == '{' {
			depth++
		} else if r == '}' {
			depth--
			if depth == 0 {
				return s[start : start+i+1]
			}
		}
	}
	return s[start:]
}

// repairJSON attempts to complete a truncated JSON string by closing any unclosed
// strings, arrays, and objects it finds via stack tracking.
func repairJSON(s string) string {
	var stack []byte
	inStr := false
	escaped := false
	for _, r := range s {
		if escaped {
			escaped = false
			continue
		}
		if r == '\\' && inStr {
			escaped = true
			continue
		}
		if r == '"' {
			inStr = !inStr
			continue
		}
		if inStr {
			continue
		}
		switch r {
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	if len(stack) == 0 && !inStr {
		return s // already structurally complete
	}
	var suffix strings.Builder
	if inStr {
		suffix.WriteByte('"')
	}
	for i := len(stack) - 1; i >= 0; i-- {
		suffix.WriteByte(stack[i])
	}
	return s + suffix.String()
}

func cleanForGroq(text string) string {
	text = reStandupEdited.ReplaceAllString(text, "")
	text = reStandupMention.ReplaceAllString(text, "")        // remove <@UXXX>
	text = reStandupLink.ReplaceAllString(text, "$1")         // keep display text of <url|label> links
	// Extract ticket IDs from Slack-wrapped YouTrack URLs BEFORE stripping them
	// e.g. <https://loop.youtrack.cloud/...?issue=ARD-1850> → ARD-1850
	text = reYouTrackSlack.ReplaceAllString(text, "$1")
	text = reStandupURL.ReplaceAllString(text, "")            // strip remaining Slack-wrapped URLs
	// Extract ticket IDs from plain-text YouTrack URLs
	text = reYouTrackIssue.ReplaceAllString(text, "$1")
	text = rePlainURL.ReplaceAllString(text, "")              // strip remaining plain URLs
	text = reStandupEmoji.ReplaceAllString(text, "")          // strip :emoji:
	// Strip mrkdwn formatting chars but keep bullets and structure
	var b strings.Builder
	for _, r := range text {
		if r != '*' && r != '_' && r != '`' {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// StandupCompilerHandler handles the daily update compiler feature.
type StandupCompilerHandler struct {
	integrationRepo *database.IntegrationRepository
	daytrackRepo    *database.DayTrackRepository
	slackService    *slacksvc.Service
}

func NewStandupCompilerHandler() *StandupCompilerHandler {
	return &StandupCompilerHandler{
		integrationRepo: database.NewIntegrationRepository(),
		daytrackRepo:    database.NewDayTrackRepository(),
		slackService:    slacksvc.NewService(),
	}
}

type StandupChannelRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type standupConfigRow struct {
	SourceChannels  []StandupChannelRef
	DestChannelID   string
	DestChannelName string
	TimeWindowStart string
	TimeWindowEnd   string
}

// PersonUpdate is one developer's compiled update returned as preview.
type PersonUpdate struct {
	SlackUserID string          `json:"slack_user_id"`
	DisplayName string          `json:"display_name"`
	RawText     string          `json:"raw_text"`
	Sections    []UpdateSection `json:"sections"`
	IsOwner     bool            `json:"is_owner"`
}

type UpdateSection struct {
	Label string   `json:"label"`
	Items []string `json:"items"`
}

// GetConfig returns the saved config for the logged-in user.
// GET /api/standup/config
func (h *StandupCompilerHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	cfg, err := loadStandupConfig(r.Context(), userID)
	if err != nil {
		cfg = &standupConfigRow{
			SourceChannels:  []StandupChannelRef{},
			TimeWindowStart: "14:00",
			TimeWindowEnd:   "23:59",
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"config": map[string]interface{}{
			"source_channels":   cfg.SourceChannels,
			"dest_channel_id":   cfg.DestChannelID,
			"dest_channel_name": cfg.DestChannelName,
			"time_window_start": cfg.TimeWindowStart,
			"time_window_end":   cfg.TimeWindowEnd,
		},
	})
}

// SaveConfig upserts the compiler config for the logged-in user.
// PUT /api/standup/config
func (h *StandupCompilerHandler) SaveConfig(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var body struct {
		SourceChannels  []StandupChannelRef `json:"source_channels"`
		DestChannelID   string              `json:"dest_channel_id"`
		DestChannelName string              `json:"dest_channel_name"`
		TimeWindowStart string              `json:"time_window_start"`
		TimeWindowEnd   string              `json:"time_window_end"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	srcJSON, _ := json.Marshal(body.SourceChannels)
	pool := database.GetPool()
	_, err := pool.Exec(r.Context(), `
		INSERT INTO standup_config (user_id, source_channels, dest_channel_id, dest_channel_name, time_window_start, time_window_end)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id) DO UPDATE SET
			source_channels   = EXCLUDED.source_channels,
			dest_channel_id   = EXCLUDED.dest_channel_id,
			dest_channel_name = EXCLUDED.dest_channel_name,
			time_window_start = EXCLUDED.time_window_start,
			time_window_end   = EXCLUDED.time_window_end,
			updated_at        = NOW()`,
		userID, srcJSON, body.DestChannelID, body.DestChannelName, body.TimeWindowStart, body.TimeWindowEnd)
	if err != nil {
		http.Error(w, "failed to save config: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

// Compile fetches Slack messages from all source channels within the time window,
// groups by user, runs Groq to structure each person's update, and replaces the
// logged-in user's section with their DayTrack summary.
// POST /api/standup/compile
func (h *StandupCompilerHandler) Compile(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var reqBody struct {
		Date string `json:"date"` // optional YYYY-MM-DD; defaults to today
	}
	_ = json.NewDecoder(r.Body).Decode(&reqBody)
	today := reqBody.Date
	if today == "" {
		today = time.Now().Format("2006-01-02")
	}

	cfg, err := loadStandupConfig(r.Context(), user.ID)
	if err != nil {
		http.Error(w, "no config saved — please configure the compiler first", http.StatusBadRequest)
		return
	}
	if len(cfg.SourceChannels) == 0 {
		http.Error(w, "no source channels configured", http.StatusBadRequest)
		return
	}

	integration, err := h.integrationRepo.GetSlackIntegration(r.Context(), user.ID)
	if err != nil || !integration.Connected {
		http.Error(w, "Slack not connected", http.StatusBadRequest)
		return
	}
	slackClient := slacksvc.NewClient(integration.BotToken)

	// Fetch from 14:00 today to now — anything before 2 PM is yesterday's carryover.
	// If the user configured an earlier start time (e.g. 13:00) we respect that,
	// otherwise we always floor at 14:00 so yesterday's messages are excluded.
	windowStart := cfg.TimeWindowStart
	if windowStart == "" {
		windowStart = "14:00"
	}
	// Floor at 14:00 even if config is earlier
	if floorHour, _ := time.ParseInLocation("2006-01-02 15:04", today+" 14:00", time.Local); true {
		configured, parseErr := time.ParseInLocation("2006-01-02 15:04", today+" "+windowStart, time.Local)
		if parseErr != nil || configured.Before(floorHour) {
			windowStart = "14:00"
		}
	}
	windowEnd := cfg.TimeWindowEnd
	if windowEnd == "" {
		windowEnd = "23:59"
	}

	oldest, latest, err := standupTimeWindowToUnix(today, windowStart, windowEnd)
	if err != nil {
		http.Error(w, "invalid time window: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Collect messages from all source channels, grouped by Slack user ID
	type channelDebug struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Messages int    `json:"messages_found"`
		Error    string `json:"error,omitempty"`
	}
	var channelLog []channelDebug

	userMessages := map[string]string{}
	for _, ch := range cfg.SourceChannels {
		msgs, fetchErr := slackClient.GetChannelHistory(r.Context(), ch.ID, oldest, latest, 500)
		if fetchErr != nil {
			errMsg := fetchErr.Error()
			if strings.Contains(errMsg, "channel_not_found") {
				errMsg = "channel_not_found — bot has no access. If this is a group DM, Slack does not allow bot tokens to read group DMs. Use a private channel instead and invite the bot with /invite."
			}
			channelLog = append(channelLog, channelDebug{ID: ch.ID, Name: ch.Name, Error: errMsg})
			continue
		}
		count := 0
		for _, m := range msgs {
			// Skip bot messages and app posts
			if m.BotID != "" || m.Subtype == "bot_message" || m.Subtype == "app_mention" {
				continue
			}
			if m.User == "" || strings.TrimSpace(m.Text) == "" {
				continue
			}
			cleaned := cleanForGroq(m.Text)
			if cleaned == "" {
				continue
			}
			count++
			if existing := userMessages[m.User]; existing != "" {
				userMessages[m.User] = existing + "\n" + cleaned
			} else {
				userMessages[m.User] = cleaned
			}
		}
		channelLog = append(channelLog, channelDebug{ID: ch.ID, Name: ch.Name, Messages: count})
	}

	// Resolve the logged-in user's own Slack ID (stored alongside the integration)
	ownerSlackID := standupGetOwnerSlackID(r.Context(), user.ID, user.Email, slackClient)

	// Resolve display names for all Slack users
	displayNames := make(map[string]string, len(userMessages))
	for uid := range userMessages {
		u, resolveErr := slackClient.GetUser(r.Context(), uid)
		if resolveErr != nil || u == nil {
			displayNames[uid] = uid
			continue
		}
		name := u.Profile.DisplayName
		if name == "" {
			name = u.RealName
		}
		displayNames[uid] = name
	}

	groqKey := os.Getenv("GROQ_API_KEY")

	// Build raw updates — no Groq here. The frontend calls /parse-one per person
	// sequentially (same pattern as deployment report) with a progress bar.
	var updates []PersonUpdate
	for uid, text := range userMessages {
		if uid == ownerSlackID {
			continue
		}
		updates = append(updates, PersonUpdate{
			SlackUserID: uid,
			DisplayName: displayNames[uid],
			RawText:     text,
			Sections:    []UpdateSection{},
		})
	}

	// Owner section from DayTrack (still processed server-side — uses DB, not Groq rate limit)
	ownerUpdate := standupBuildOwnerSection(r.Context(), user.ID, user.Name, today, groqKey)
	ownerUpdate.SlackUserID = ownerSlackID
	ownerUpdate.IsOwner = true

	// Strip empty items from owner sections
	out := ownerUpdate.Sections[:0]
	for _, sec := range ownerUpdate.Sections {
		if len(sec.Items) > 0 {
			out = append(out, sec)
		}
	}
	ownerUpdate.Sections = out

	result := append([]PersonUpdate{ownerUpdate}, updates...)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"updates": result,
		"debug": map[string]interface{}{
			"window_start":  windowStart,
			"window_end":    windowEnd,
			"oldest_unix":   oldest,
			"latest_unix":   latest,
			"channels":      channelLog,
			"owner_slack_id": ownerSlackID,
		},
	})
}

// Post formats the preview as Slack mrkdwn and posts it to the destination channel.
// POST /api/standup/post
func (h *StandupCompilerHandler) Post(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var body struct {
		Updates   []PersonUpdate `json:"updates"`
		ChannelID string         `json:"channel_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Updates) == 0 || body.ChannelID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	text := standupFormatMrkdwn(body.Updates)
	if err := h.slackService.PostMessage(r.Context(), user.ID, body.ChannelID, text); err != nil {
		http.Error(w, "failed to post: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

// ParseOne runs Groq on a single developer's raw Slack text and returns their
// structured sections. Returns a rate-limited response (with retry_after) when
// Groq throttles, so the frontend can countdown and retry — same as generate-ticket.
// POST /api/standup/parse-one
func (h *StandupCompilerHandler) ParseOne(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		RawText string `json:"raw_text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Try heuristic parse first — skip Groq entirely for clearly-structured messages
	cleaned := cleanForGroq(req.RawText)
	if sections, ok := tryHeuristicParse(cleaned); ok {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "sections": sections})
		return
	}

	groqKey := os.Getenv("GROQ_API_KEY")
	if groqKey == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":  true,
			"sections": []UpdateSection{},
		})
		return
	}

	userMsg := "Developer update:\n" + cleaned
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	result, err := callGroqChat(ctx, groqKey, "llama-3.3-70b-versatile", standupGroqSystem, userMsg, 2048) //nolint:lll
	if err != nil {
		lower := strings.ToLower(err.Error())
		isRate := strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate_limit") ||
			strings.Contains(lower, "429") || strings.Contains(lower, "too many") ||
			strings.Contains(lower, "tokens per minute") || strings.Contains(lower, "try again in")
		if isRate {
			retryAfter := standupParseRetryAfter(err.Error())
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success":     false,
				"rate_limited": true,
				"retry_after": retryAfter,
			})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":  false,
			"sections": []UpdateSection{},
			"error":    err.Error(),
		})
		return
	}

	// Parse + repair JSON
	raw := reStrayEndQuote.ReplaceAllString(strings.TrimSpace(result), `]$1}`)
	clean := extractBalancedJSON(raw)
	var parsed struct {
		Sections []UpdateSection `json:"sections"`
	}
	if err2 := json.Unmarshal([]byte(clean), &parsed); err2 != nil {
		repaired := repairJSON(clean)
		if err3 := json.Unmarshal([]byte(repaired), &parsed); err3 != nil {
			log.Printf("[StandupCompiler/ParseOne] parse failed: %v | raw: %.200s", err3, clean)
		}
	}

	// Filter out In Progress / Blocked / WIP sections and empty items
	var sections []UpdateSection
	for _, sec := range parsed.Sections {
		lower := strings.ToLower(sec.Label)
		if strings.Contains(lower, "in progress") || strings.Contains(lower, "in progess") ||
			strings.Contains(lower, "wip") || strings.Contains(lower, "blocked") {
			continue
		}
		var items []string
		for _, it := range sec.Items {
			if strings.TrimSpace(it) != "" {
				items = append(items, it)
			}
		}
		if len(items) > 0 {
			sections = append(sections, UpdateSection{Label: sec.Label, Items: items})
		}
	}
	if sections == nil {
		sections = []UpdateSection{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"sections": sections,
	})
}

// tryHeuristicParse attempts to parse a clearly-structured developer update without
// calling Groq. Returns (sections, true) when the message has recognisable section
// headers; returns (nil, false) to signal "fall through to Groq".
func tryHeuristicParse(text string) ([]UpdateSection, bool) {
	// Canonical header patterns → output label (empty = skip section)
	type headerRule struct {
		pattern *regexp.Regexp
		label   string // "" = skip (in-progress / blocked)
	}
	rules := []headerRule{
		{regexp.MustCompile(`(?i)^(done today|done|completed|finished)\s*[:\-]?\s*$`), "Done Today"},
		{regexp.MustCompile(`(?i)^(created tickets?|tickets? created)\s*[:\-]?\s*$`), "Tickets Created"},
		{regexp.MustCompile(`(?i)^(verified (stage |prod |production )?tickets?|tickets? (verified|tested))\s*[:\-]?\s*$`), "Tickets Tested"},
		{regexp.MustCompile(`(?i)^(testing|tested)\s*[:\-]?\s*$`), "Testing"},
		{regexp.MustCompile(`(?i)^(development|development done)\s*[:\-]?\s*$`), "Done Today"},
		{regexp.MustCompile(`(?i)^(review|code review)\s*[:\-]?\s*$`), "Done Today"},
		{regexp.MustCompile(`(?i)^(in progress|in progess|in-progress|wip|working on|i am working on|currently working on)\s*[:\-]?\s*$`), ""},
		{regexp.MustCompile(`(?i)^(blocked|blockers?)\s*[:\-]?\s*$`), ""},
	}

	lines := strings.Split(text, "\n")

	// Require at least one recognised header to trust heuristic output.
	// Track whether ALL recognised headers are skip-only (in-progress/blocked) so
	// we can return empty sections and avoid a wasted Groq call.
	foundHeader := false
	foundInclude := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		for _, r := range rules {
			if r.pattern.MatchString(trimmed) {
				foundHeader = true
				if r.label != "" {
					foundInclude = true
				}
				break
			}
		}
	}
	if !foundHeader {
		return nil, false
	}
	// All headers were skip-type (working on / blocked) — return empty, skip Groq
	if !foundInclude {
		return []UpdateSection{}, true
	}

	var sections []UpdateSection
	var order []string
	sectionMap := map[string][]string{}
	currentLabel := ""
	skip := false

	isItem := func(s string) bool {
		// A content line: starts with -, •, *, digit, or a ticket ID, or is non-empty non-header
		if s == "" {
			return false
		}
		return strings.HasPrefix(s, "-") || strings.HasPrefix(s, "•") ||
			strings.HasPrefix(s, "*") || regexp.MustCompile(`^[A-Z]+-\d+`).MatchString(s) ||
			regexp.MustCompile(`^\d+\.`).MatchString(s)
	}

	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}

		// Preamble lines like "Todays Task Update-" — skip
		if regexp.MustCompile(`(?i)^(today'?s?\s*(task\s*)?update|task update)\s*[:\-]?\s*$`).MatchString(line) {
			continue
		}

		matched := false
		for _, r := range rules {
			if r.pattern.MatchString(line) {
				currentLabel = r.label
				skip = r.label == ""
				if !skip {
					if _, seen := sectionMap[currentLabel]; !seen {
						order = append(order, currentLabel)
						sectionMap[currentLabel] = nil
					}
				}
				matched = true
				break
			}
		}
		if matched {
			continue
		}

		// Not a header — treat as item if we have a current section
		if currentLabel != "" && !skip {
			item := strings.TrimLeft(line, "-•* \t")
			item = strings.TrimSpace(item)
			if item != "" {
				sectionMap[currentLabel] = append(sectionMap[currentLabel], item)
			}
		} else if currentLabel == "" && isItem(line) {
			// Items before any header — put under implicit "Done Today"
			if _, seen := sectionMap["Done Today"]; !seen {
				order = append(order, "Done Today")
				sectionMap["Done Today"] = nil
			}
			item := strings.TrimLeft(line, "-•* \t")
			sectionMap["Done Today"] = append(sectionMap["Done Today"], strings.TrimSpace(item))
		}
	}

	for _, label := range order {
		if len(sectionMap[label]) > 0 {
			sections = append(sections, UpdateSection{Label: label, Items: sectionMap[label]})
		}
	}

	if len(sections) == 0 {
		return nil, false
	}
	return sections, true
}

// standupParseRetryAfter extracts the wait seconds from a Groq rate-limit error.
func standupParseRetryAfter(msg string) int {
	// Try to find "try again in Xs" pattern
	re := regexp.MustCompile(`(?i)try again in (\d+)`)
	if m := re.FindStringSubmatch(msg); len(m) > 1 {
		var n int
		fmt.Sscanf(m[1], "%d", &n)
		if n > 0 {
			return n
		}
	}
	return 30 // sensible default
}

// ── internal helpers ──────────────────────────────────────────────────────────

func loadStandupConfig(ctx context.Context, userID string) (*standupConfigRow, error) {
	pool := database.GetPool()
	row := pool.QueryRow(ctx,
		`SELECT source_channels, dest_channel_id, dest_channel_name, time_window_start, time_window_end
		   FROM standup_config WHERE user_id = $1`, userID)

	var cfg standupConfigRow
	var srcRaw []byte
	if err := row.Scan(&srcRaw, &cfg.DestChannelID, &cfg.DestChannelName, &cfg.TimeWindowStart, &cfg.TimeWindowEnd); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(srcRaw, &cfg.SourceChannels)
	if cfg.SourceChannels == nil {
		cfg.SourceChannels = []StandupChannelRef{}
	}
	return &cfg, nil
}

func standupTimeWindowToUnix(date, startHHMM, endHHMM string) (oldest, latest int64, err error) {
	loc := time.Local
	parse := func(hhmm string) (time.Time, error) {
		return time.ParseInLocation("2006-01-02 15:04", date+" "+hhmm, loc)
	}
	s, parseErr := parse(startHHMM)
	if parseErr != nil {
		return 0, 0, parseErr
	}
	e, parseErr := parse(endHHMM)
	if parseErr != nil {
		return 0, 0, parseErr
	}
	return s.Unix(), e.Unix(), nil
}

// standupGetOwnerSlackID resolves the logged-in user's Slack user ID.
// It first checks the slack_user_id column on slack_integrations, then falls back
// to a users.lookupByEmail call.
func standupGetOwnerSlackID(ctx context.Context, userID, email string, client *slacksvc.Client) string {
	pool := database.GetPool()
	var slackUID string
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(slack_user_id, '') FROM slack_integrations WHERE user_id = $1 AND connected = true`,
		userID).Scan(&slackUID)
	if slackUID != "" {
		return slackUID
	}
	if u, err := client.GetUserByEmail(ctx, email); err == nil && u != nil {
		return u.ID
	}
	return ""
}

const standupGroqSystem = `You are a structured parser for developer standup updates.
Given a developer's raw Slack message, extract ONLY the completed ("Done") items into labelled sections.

Standard rules:
- INCLUDE sections whose label contains "Done", "Enhancements", "Bug Fix", "Bugs Fixed", "Moved to Dev Today", "QA Findings", "Tickets Created", "Tickets Tested", "Tickets Verified".
- EXCLUDE entirely any section whose label contains "In Progress", "In Progess", "In-Progress", "WIP", "Blocked", "Note", "Notes".
- IMPORTANT: Preserve the exact section label wording from the original message — do NOT rename or normalise them.
- Preserve ticket IDs exactly (e.g. ARD-1234). Do not invent items. Keep each item to one line.

Condensed sub-section rule — apply this when the message has named sub-sections (e.g. "UI", "Studio", "MC", "Backend", "Mobile", or any product-area name) each followed by a list of short items like feature names, flow names, or test areas (NOT ticket IDs like ARD-1234):
- Do NOT apply this rule to ticket-based sections (Tickets Created, Tickets Tested, etc.) — those stay as separate items.
- For each sub-section, create one output section labelled "Flows Tested on <AreaName>" where <AreaName> is exactly what the developer wrote (e.g. "Flows Tested on UI", "Flows Tested on Studio", "Flows Tested on MC").
- Condense ALL items under that sub-section into a SINGLE comma-separated string on one line.
- Never list each item separately — always join with ", " into one line per area.
- You decide whether this pattern applies — use it whenever you see area-headers + short non-ticket item lists, regardless of what the items are called.

Return ONLY valid JSON with no markdown fences: {"sections": [{"label": "Flows Tested on UI", "items": ["registration flow, onboarding flow, forgot password flow"]}, ...]}.
If there are no done items, return {"sections": []}.`

const standupOwnerGroqSystem = `You are a structured parser for a PM's daily standup update.
Given a list of DayTrack work entries (categories: Testing, PM, Research, Development), group them into labelled sections.
Use labels: "Done Today", "Testing", "PM", "Research", "In Progress", "Tickets Created", "Tickets Tested", "Tickets Verified".
Return ONLY valid JSON with no markdown fences: {"sections": [{"label": "Done Today", "items": ["tested X", ...]}, ...]}.
Keep each item concise. Preserve any ticket IDs (e.g. ARD-1234). Do not invent items. Only include sections that have items.`

func standupGroqParse(groqKey, rawText string) []UpdateSection {
	if groqKey == "" {
		return []UpdateSection{{Label: "Update", Items: []string{rawText}}}
	}

	const maxRetries = 4
	backoff := 2 * time.Second
	userMsg := "Developer update:\n" + rawText

	var result string
	for attempt := 0; attempt < maxRetries; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		var err error
		result, err = callGroqChat(ctx, groqKey, "llama-3.3-70b-versatile", standupGroqSystem, userMsg, 2048)
		cancel()
		if err == nil && strings.TrimSpace(result) != "" {
			break
		}
		if err != nil {
			lower := strings.ToLower(err.Error())
			isRate := strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate_limit") ||
				strings.Contains(lower, "429") || strings.Contains(lower, "too many")
			if isRate && attempt < maxRetries-1 {
				time.Sleep(backoff)
				backoff *= 2
				continue
			}
		}
		break
	}

	// Pre-clean: Groq sometimes inserts a stray " between the sections array ] and
	// the root object }, producing ...]"} which breaks all parsers. Strip it first.
	raw := strings.TrimSpace(result)
	raw = reStrayEndQuote.ReplaceAllString(raw, `]$1}`)

	// 1. Extract the first balanced JSON object (strips pre/post commentary)
	clean := extractBalancedJSON(raw)

	var parsed struct {
		Sections []UpdateSection `json:"sections"`
	}
	if err := json.Unmarshal([]byte(clean), &parsed); err != nil {
		// 2. Attempt to repair truncated JSON (missing closing brackets/strings)
		repaired := repairJSON(clean)
		if err2 := json.Unmarshal([]byte(repaired), &parsed); err2 != nil {
			log.Printf("[StandupCompiler] Groq JSON parse failed (raw+repair): %v | raw: %.300s", err2, clean)
			return []UpdateSection{}
		}
	}
	// Safety net: drop any section Groq still included that looks like In Progress or Blocked
	var filtered []UpdateSection
	for _, sec := range parsed.Sections {
		lower := strings.ToLower(sec.Label)
		if strings.Contains(lower, "in progress") || strings.Contains(lower, "in progess") ||
			strings.Contains(lower, "wip") || strings.Contains(lower, "blocked") {
			continue
		}
		filtered = append(filtered, sec)
	}
	return filtered
}

func standupBuildOwnerSection(ctx context.Context, userID, displayName, date, _ string) PersonUpdate {
	repo := database.NewDayTrackRepository()
	entries, err := repo.GetEntries(ctx, userID, date)
	if err != nil || len(entries) == 0 {
		return PersonUpdate{DisplayName: displayName, Sections: []UpdateSection{}}
	}

	skipCat := map[string]bool{
		"sign in": true, "sign off": true, "signing in": true, "signing off": true,
		"time on": true, "time off": true, "time on/off": true,
		"break": true, "breaks": true,
		"meeting": true, "meetings": true,
	}

	catToSection := map[string]string{
		"development":        "Done Today",
		"review":             "Done Today",
		"pm":                 "PM",
		"project management": "PM",
	}

	sectionMap := map[string][]string{}
	var order []string

	for _, e := range entries {
		if e.ParentEntryID != nil && *e.ParentEntryID != "" {
			continue
		}
		cat := strings.ToLower(strings.TrimSpace(e.Category))
		if skipCat[cat] {
			continue
		}
		sec, ok := catToSection[cat]
		if !ok {
			sec = e.Category
		}
		if _, seen := sectionMap[sec]; !seen {
			order = append(order, sec)
		}
		item := e.Name
		if e.Notes != "" {
			item += " — " + e.Notes
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

// ── Weekly Report ─────────────────────────────────────────────────────────────

const weeklyGroqSystem = `You are a release notes compiler for a software team.
You will receive a full week of developer Slack standup messages (Monday–Friday).
Your job:
1. Collect ONLY items listed under "Done", "Done:", "DONE", "DONE:" sections.
2. Exclude everything under "In Progress", "In Progress:", "IN PROGRESS" sections.
3. Exclude entries that are purely testing/verification with NO feature value:
   - "verified tickets on stage", "verified tickets on prod", "prod testing", "stage testing"
   - "started working on X", "working on X", "begin X", "began X"
   - "Playwright tests", "scout app is online", "working on onboarding tests"
   - Any line that is only a person's name or @mention
4. Deduplicate: if the same ticket ID (e.g. ARD-1234) appears on multiple days, include it ONCE using the most descriptive line.
5. Keep non-ticket done items if they describe real work (refactors, bugfixes, feature work, infrastructure changes).
6. Do NOT include developer names.
7. Clean up language: fix obvious typos, normalise capitalisation of ticket descriptions.
8. Return ONLY valid JSON (no markdown fences): {"items": ["ARD-1234 FE: description", "Some non-ticket work done", ...]}`

// Weekly handles POST /api/standup/weekly
// Body: { week_start: "2026-05-19" }  (Monday of the target week; omit for current week)
func (h *StandupCompilerHandler) Weekly(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var body struct {
		WeekStart string `json:"week_start"` // YYYY-MM-DD of Monday
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	// Resolve target Monday
	var monday time.Time
	if body.WeekStart != "" {
		t, err := time.ParseInLocation("2006-01-02", body.WeekStart, time.Local)
		if err != nil {
			http.Error(w, "invalid week_start", http.StatusBadRequest)
			return
		}
		monday = t
	} else {
		now := time.Now()
		// Walk back to Monday
		wd := int(now.Weekday())
		if wd == 0 {
			wd = 7
		}
		monday = time.Date(now.Year(), now.Month(), now.Day()-wd+1, 0, 0, 0, 0, time.Local)
	}
	friday := monday.AddDate(0, 0, 4)

	oldest := monday.Unix()
	latest := time.Date(friday.Year(), friday.Month(), friday.Day(), 23, 59, 59, 0, time.Local).Unix()

	cfg, err := loadStandupConfig(r.Context(), user.ID)
	if err != nil || len(cfg.SourceChannels) == 0 {
		http.Error(w, "no source channels configured", http.StatusBadRequest)
		return
	}

	integration, err := h.integrationRepo.GetSlackIntegration(r.Context(), user.ID)
	if err != nil || !integration.Connected {
		http.Error(w, "Slack not connected", http.StatusBadRequest)
		return
	}
	slackClient := slacksvc.NewClient(integration.BotToken)

	// Collect all messages Mon–Fri across all channels
	var allRaw strings.Builder
	type chanDebug struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Messages int    `json:"messages_found"`
		Error    string `json:"error,omitempty"`
	}
	var channelLog []chanDebug

	for _, ch := range cfg.SourceChannels {
		msgs, fetchErr := slackClient.GetChannelHistory(r.Context(), ch.ID, oldest, latest, 1000)
		if fetchErr != nil {
			channelLog = append(channelLog, chanDebug{ID: ch.ID, Name: ch.Name, Error: "slack API error: " + fetchErr.Error()})
			continue
		}
		count := 0
		for _, m := range msgs {
			// Skip bot messages and app posts
			if m.BotID != "" || m.Subtype == "bot_message" || m.Subtype == "app_mention" {
				continue
			}
			if m.User == "" || strings.TrimSpace(m.Text) == "" {
				continue
			}
			cleaned := cleanForGroq(m.Text)
			if cleaned == "" {
				continue
			}
			allRaw.WriteString(cleaned + "\n\n")
			count++
		}
		channelLog = append(channelLog, chanDebug{ID: ch.ID, Name: ch.Name, Messages: count})
	}

	groqKey := os.Getenv("GROQ_API_KEY")
	var items []string

	if allRaw.Len() == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"items":   []string{},
			"week_start": monday.Format("2006-01-02"),
			"week_end":   friday.Format("2006-01-02"),
			"debug":      map[string]interface{}{"channels": channelLog},
		})
		return
	}

	// Groq call — potentially large, so chunk if needed (max ~8k tokens of input)
	rawText := allRaw.String()
	const maxChunk = 12000 // chars
	if len(rawText) > maxChunk {
		// Split into chunks, collect items from each, deduplicate at end
		seen := map[string]bool{}
		for start := 0; start < len(rawText); start += maxChunk {
			end := start + maxChunk
			if end > len(rawText) {
				end = len(rawText)
			}
			chunk := rawText[start:end]
			chunkItems := weeklyGroqCall(groqKey, chunk)
			for _, it := range chunkItems {
				key := strings.ToLower(strings.TrimSpace(it))
				if !seen[key] {
					seen[key] = true
					items = append(items, it)
				}
			}
		}
	} else {
		items = weeklyGroqCall(groqKey, rawText)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":    true,
		"items":      items,
		"week_start": monday.Format("2006-01-02"),
		"week_end":   friday.Format("2006-01-02"),
		"debug":      map[string]interface{}{"channels": channelLog},
	})
}

func weeklyGroqCall(groqKey, rawText string) []string {
	if groqKey == "" {
		return nil
	}
	const maxRetries = 4
	backoff := 2 * time.Second
	var result string
	for attempt := 0; attempt < maxRetries; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		var err error
		result, err = callGroqChat(ctx, groqKey, "llama-3.3-70b-versatile", weeklyGroqSystem,
			"Week standup messages:\n\n"+rawText, 2048)
		cancel()
		if err == nil && strings.TrimSpace(result) != "" {
			break
		}
		if err != nil {
			lower := strings.ToLower(err.Error())
			isRate := strings.Contains(lower, "rate limit") || strings.Contains(lower, "429") || strings.Contains(lower, "too many")
			if isRate && attempt < maxRetries-1 {
				time.Sleep(backoff)
				backoff *= 2
				continue
			}
		}
		break
	}
	var parsed struct {
		Items []string `json:"items"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(result)), &parsed); err != nil {
		return nil
	}
	return parsed.Items
}

func standupFormatMrkdwn(updates []PersonUpdate) string {
	var sb strings.Builder
	for i, u := range updates {
		if i > 0 {
			sb.WriteString("\n\n") // blank line between people
		}
		if u.DisplayName != "" {
			sb.WriteString(fmt.Sprintf("*%s*\n", u.DisplayName))
		}
		if len(u.Sections) > 0 {
			sb.WriteString("✅ *Done Today:*\n\n")
		}
		for _, sec := range u.Sections {
			if len(sec.Items) == 0 {
				continue
			}
			label := sec.Label
			if !strings.HasSuffix(label, ":") {
				label += ":"
			}
			sb.WriteString("*" + label + "*\n")
			for _, item := range sec.Items {
				sb.WriteString("• " + item + "\n")
			}
			sb.WriteString("\n") // blank line between sections
		}
	}
	return strings.TrimRight(sb.String(), "\n")
}
