package handlers

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/dhindsa/project-management/internal/database"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// ── Slack markup stripping ────────────────────────────────────────────────────

var (
	reMention = regexp.MustCompile(`<@[A-Z0-9]+>`)
	reLink    = regexp.MustCompile(`<https?://[^|>]*\|([^>]*)>`)
	reURL     = regexp.MustCompile(`<https?://[^>]*>`)
	reEdited  = regexp.MustCompile(`\s*\(edited\)\s*$`)
	reEmoji   = regexp.MustCompile(`:[a-z0-9_+\-]+:`)
)

// stripSlackMarkup removes Slack mrkdwn and returns plain lowercase text.
// Handles: *bold*, _italic_, `code`, >quote, • bullet, (edited), @mentions, URLs, emoji.
func stripSlackMarkup(text string) string {
	// Remove (edited) suffix
	text = reEdited.ReplaceAllString(text, "")
	// Strip @mentions
	text = reMention.ReplaceAllString(text, "")
	// Strip links but keep display text
	text = reLink.ReplaceAllString(text, "$1")
	// Strip bare URLs
	text = reURL.ReplaceAllString(text, "")
	// Strip emoji codes
	text = reEmoji.ReplaceAllString(text, "")
	// Strip mrkdwn characters: *, _, `
	var b strings.Builder
	for _, r := range text {
		if r != '*' && r != '_' && r != '`' {
			b.WriteRune(r)
		}
	}
	text = b.String()
	// Strip leading > (blockquote)
	text = strings.TrimLeft(text, ">")
	// Strip leading bullet •
	text = strings.TrimPrefix(text, "•")
	// Normalise whitespace and lowercase
	return strings.ToLower(strings.TrimSpace(text))
}

// ── Fuzzy word matching (Levenshtein) ─────────────────────────────────────────

func levDist(a, b string) int {
	la, lb := len(a), len(b)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}
	prev := make([]int, lb+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		curr := make([]int, lb+1)
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			curr[j] = min3lev(curr[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev = curr
	}
	return prev[lb]
}

func min3lev(a, b, c int) int {
	if a < b {
		if a < c {
			return a
		}
		return c
	}
	if b < c {
		return b
	}
	return c
}

// maxDist returns the allowed Levenshtein distance for a keyword of given length.
// Longer words tolerate more typos.
func maxDist(kw string) int {
	n := len([]rune(kw))
	switch {
	case n <= 4:
		return 0 // short words must match exactly
	case n <= 7:
		return 1
	default:
		return 2
	}
}

// wordsOf splits text into non-empty lowercase tokens.
func wordsOf(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

// fuzzyContains returns true if every word in kwWords has a fuzzy-matching
// counterpart in msgWords (Levenshtein distance ≤ maxDist of that keyword word).
func fuzzyContains(msgWords, kwWords []string) bool {
	for _, kw := range kwWords {
		found := false
		thresh := maxDist(kw)
		for _, mw := range msgWords {
			if levDist(mw, kw) <= thresh {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// matchKeywords checks whether cleanMsg matches any keyword in the rule.
// Returns true on first match. Uses exact substring first, then word-level fuzzy.
func matchKeywords(cleanMsg string, keywords []string) bool {
	msgWords := wordsOf(cleanMsg)
	for _, kw := range keywords {
		kwClean := strings.ToLower(strings.TrimSpace(kw))
		if kwClean == "" {
			continue
		}
		// Fast path: exact substring
		if strings.Contains(cleanMsg, kwClean) {
			return true
		}
		// Fuzzy path: every keyword word must fuzzy-match a message word
		kwWords := wordsOf(kwClean)
		if len(kwWords) > 0 && fuzzyContains(msgWords, kwWords) {
			return true
		}
	}
	return false
}

// ── Slack TS helpers ──────────────────────────────────────────────────────────

// slackTSToTime converts a Slack timestamp string (e.g. "1714900800.000100") to time.Time
// in the given IANA timezone (e.g. "Asia/Kolkata"). Falls back to UTC on invalid tz.
func slackTSToTime(ts string, tz string) time.Time {
	parts := strings.SplitN(ts, ".", 2)
	sec, _ := strconv.ParseInt(parts[0], 10, 64)
	loc, err := time.LoadLocation(tz)
	if err != nil || tz == "" {
		loc = time.UTC
	}
	return time.Unix(sec, 0).In(loc)
}

// formatTimeAMPM formats a time.Time to "3:04 PM" style.
func formatTimeAMPM(t time.Time) string {
	return t.Format("3:04 PM")
}

// ── Default keyword rules ─────────────────────────────────────────────────────

// DefaultKeywordRules returns the default set of keyword rules.
// User notes:
//   - "Sign In" and "Sign Off" are separate categories
//   - Breaks category tracks "aws …" and "lunch break" messages
//   - "available"/"back" etc. close the open break entry
func DefaultKeywordRules() []database.DayTrackKWRule {
	return []database.DayTrackKWRule{
		{
			Category: "Sign In",
			Keywords: []string{"signing in", "signed in"},
			RuleType: "sign_in",
		},
		{
			Category: "Sign Off",
			Keywords: []string{"signing off", "signed off"},
			RuleType: "sign_off",
		},
		{
			Category: "Breaks",
			Keywords: []string{"aws", "away from screen", "brb", "be right back"},
			RuleType: "break_start",
		},
		{
			Category: "Breaks",
			Keywords: []string{"lunch", "lunch break"},
			RuleType: "break_start",
		},
		{
			Category: "Breaks",
			Keywords: []string{"available", "back", "im back", "i'm back"},
			RuleType: "break_end",
		},
	}
}

// ── Core processing ───────────────────────────────────────────────────────────

// ProcessSlackDaytrackMessage processes a single Slack message for a user and
// creates / updates DayTrack entries according to the user's keyword rules.
// ts is the Slack message timestamp string (e.g. "1714900800.000100").
func ProcessSlackDaytrackMessage(
	ctx context.Context,
	repo *database.DayTrackRepository,
	userID string,
	rawText string,
	ts string,
	rules []database.DayTrackKWRule,
	timezone string,
) {
	// Deduplicate: if we already processed this Slack message, skip.
	if exists, _ := repo.EntryExistsByExternalRef(ctx, userID, ts); exists {
		return
	}

	cleanMsg := stripSlackMarkup(rawText)
	if cleanMsg == "" {
		return
	}

	msgTime := slackTSToTime(ts, timezone)
	timeStr := formatTimeAMPM(msgTime)
	dateStr := msgTime.Format("2006-01-02")

	for _, rule := range rules {
		if !matchKeywords(cleanMsg, rule.Keywords) {
			continue
		}
		switch rule.RuleType {
		case "sign_in":
			_, err := repo.CreateEntrySourced(ctx, userID, dateStr,
				"Signed In", rule.Category,
				timeStr, timeStr, nil, "", "done", nil,
				"slack", ts)
			if err != nil {
				log.Printf("DayTrack Slack sign_in error for user %s: %v", userID, err)
			}

		case "sign_off":
			_, err := repo.CreateEntrySourced(ctx, userID, dateStr,
				"Signed Off", rule.Category,
				timeStr, timeStr, nil, "", "done", nil,
				"slack", ts)
			if err != nil {
				log.Printf("DayTrack Slack sign_off error for user %s: %v", userID, err)
			}

		case "break_start":
			// Use the original (stripped) message as the entry name so e.g. "aws 15 min" is stored
			entryName := titleCase(cleanMsg)
			_, err := repo.CreateEntrySourced(ctx, userID, dateStr,
				entryName, rule.Category,
				timeStr, "", nil, "", "done", nil,
				"slack", ts)
			if err != nil {
				log.Printf("DayTrack Slack break_start error for user %s: %v", userID, err)
			}

		case "break_end":
			// Close the most recent open slack break entry for today.
			open, err := repo.GetOpenBreakEntry(ctx, userID, dateStr)
			if err == nil && open != nil {
				startMins := timeToMins(open.StartTime)
				endMins := timeToMins(timeStr)
				dur := endMins - startMins
				if dur < 0 {
					dur = 0
				}
				_, _ = repo.UpdateEntry(ctx, open.ID, userID,
					open.Name, open.Category,
					open.StartTime, timeStr, &dur, open.Notes, open.Status)
			}
			// Also create a point-in-time "Available" entry with the same TS as dedup key
			_, _ = repo.CreateEntrySourced(ctx, userID, dateStr,
				"Available", rule.Category,
				timeStr, timeStr, nil, "", "done", nil,
				"slack", ts)
		}

		// First matching rule wins
		break
	}
}

// titleCase capitalises the first letter of each word.
func titleCase(s string) string {
	return strings.Title(s) //nolint:staticcheck
}

// ── Background scanner ────────────────────────────────────────────────────────

// RunDayTrackSlackScanner starts a background goroutine that polls the configured
// availability channels every 5 minutes and auto-creates DayTrack entries.
func RunDayTrackSlackScanner(daytrackRepo *database.DayTrackRepository) {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		// Run once immediately on startup, then on every tick.
		runScan(daytrackRepo)
		for range ticker.C {
			runScan(daytrackRepo)
		}
	}()
}

func runScan(repo *database.DayTrackRepository) {
	listCtx, listCancel := context.WithTimeout(context.Background(), 30*time.Second)
	configs, err := repo.GetAllEnabledSlackConfigs(listCtx)
	listCancel()
	if err != nil {
		log.Printf("DayTrack Slack scanner: failed to load configs: %v", err)
		return
	}

	// Each user gets its own context so one slow call can't cancel others.
	for _, cfg := range configs {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		scanUserChannel(ctx, repo, cfg)
		cancel()
	}
}

func scanUserChannel(ctx context.Context, repo *database.DayTrackRepository, cfg database.SlackScanConfig) {
	client := slacksvc.NewClient(cfg.BotToken)

	// oldest = last scanned TS, or start of today if never scanned
	oldest := cfg.LastScannedTS
	var oldestUnix int64
	if oldest != "" {
		t := slackTSToTime(oldest, cfg.Timezone)
		oldestUnix = t.Unix() + 1 // +1 so we don't re-process the last seen message
	} else {
		loc, err := time.LoadLocation(cfg.Timezone)
		if err != nil || cfg.Timezone == "" {
			loc = time.UTC
		}
		now := time.Now().In(loc)
		startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
		oldestUnix = startOfDay.Unix()
	}

	msgs, err := client.GetChannelHistory(ctx, cfg.ChannelID, oldestUnix, 0, 200)
	if err != nil {
		log.Printf("DayTrack Slack scanner: channel history error user=%s: %v", cfg.UserID, err)
		return
	}

	var latestTS string
	for _, msg := range msgs {
		// Only process messages from this user
		if msg.User != cfg.SlackUserID {
			continue
		}
		ProcessSlackDaytrackMessage(ctx, repo, cfg.UserID, msg.Text, msg.TS, cfg.KeywordRules, cfg.Timezone)
		if msg.TS > latestTS {
			latestTS = msg.TS
		}
	}

	if latestTS != "" {
		_ = repo.UpdateSlackConfigLastScanned(ctx, cfg.UserID, latestTS)
	}
}

// slackUserIDFromEmail resolves the user's Slack member ID using their email.
// Returns "" if resolution fails (caller should fall back to manual entry).
func SlackUserIDFromEmail(ctx context.Context, botToken, email string) string {
	if botToken == "" || email == "" {
		return ""
	}
	client := slacksvc.NewClient(botToken)
	u, err := client.GetUserByEmail(ctx, email)
	if err != nil || u == nil {
		return ""
	}
	return u.ID
}

// fmtHHMM formats duration as "Xh Ym" for display.
func fmtDurMins(mins int) string {
	if mins <= 0 {
		return "0m"
	}
	h := mins / 60
	m := mins % 60
	if h == 0 {
		return fmt.Sprintf("%dm", m)
	}
	if m == 0 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dh %dm", h, m)
}
