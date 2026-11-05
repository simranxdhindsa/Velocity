package handlers

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Pure rules behind the Day Track write tools: one task per line, clock times and category
// choice. No database or network here, so they stay cheap to test.

const (
	// mcpDayTrackMaxLine keeps an entry to one line. Real manual entries sit at a median of
	// 21 characters and a 95th percentile of 122; past this they stop reading as one line.
	mcpDayTrackMaxLine         = 160
	mcpDayTrackMaxBatch        = 50
	mcpDayTrackMaxCategoryName = 40
	// mcpDayTrackOvernightMaxMins is the longest span accepted when the end time is earlier
	// than the start. Beyond it a reversed pair is a mistake, not a late night.
	mcpDayTrackOvernightMaxMins = 12 * 60
	// mcpDayTrackLongSpanMins flags an automatic time range worth a second look.
	mcpDayTrackLongSpanMins = 4 * 60
	mcpMinsPerDay           = 24 * 60
)

// dayTrackBuiltInCategories mirrors DEFAULT_CATS in frontend daytrack-helpers.ts, in order:
// the first one is what the page selects by default.
var dayTrackBuiltInCategories = []string{"Development", "Testing", "Meetings", "Breaks", "Review", "Research", "Sign In", "Sign Off"}

// dayTrackNoInProgressCategories mirrors NOT_IN_PROGRESS_CATS: instant events, so "still in
// progress" doesn't apply to them.
var dayTrackNoInProgressCategories = map[string]bool{"sign in": true, "sign off": true, "breaks": true}

var (
	dtBulletRe      = regexp.MustCompile(`^(?:[-*•◦▪‣·–—]|\d{1,3}[.)]|\[[ xX]?\])(?:\s+|$)`)
	dtInlineSplitRe = regexp.MustCompile(`\s+•\s+|;(?:\s+|$)`)
	dtDashRe        = regexp.MustCompile(`\s*—\s*|(?:^|\s+)--(?:\s+|$)`)
	dtClock12Re     = regexp.MustCompile(`^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?(?:m\.?)?$`)
	dtClock24Re     = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)
)

// mcpDayTrackOneLine flattens text to a single clean line: no control characters or line
// breaks, single spaces, and no em or double dashes (the UI copy rule; a CLI flag like
// --race has no space after the dashes, so it survives).
func mcpDayTrackOneLine(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	s = dtDashRe.ReplaceAllString(s, ", ")
	return strings.Trim(s, " ,;")
}

// mcpDayTrackTaskLines splits raw text into one task per line: line breaks, bullets, numbered
// lists and semicolons all separate tasks, and list markers are dropped.
func mcpDayTrackTaskLines(raw string) []string {
	var out []string
	for _, line := range strings.FieldsFunc(raw, func(r rune) bool { return r == '\n' || r == '\r' }) {
		for _, part := range dtInlineSplitRe.Split(line, -1) {
			part = dtBulletRe.ReplaceAllString(strings.TrimSpace(part), "")
			if clean := mcpDayTrackOneLine(part); clean != "" {
				out = append(out, clean)
			}
		}
	}
	return out
}

// mcpParseDayTrackClock reads a clock time into minutes after midnight. It takes 12-hour
// ("2pm", "2:30 PM"), 24-hour with minutes ("14:30") or "now". A bare "10" is refused:
// guessing AM or PM would quietly log the wrong half of the day.
func mcpParseDayTrackClock(s string, nowMins int, allowNow bool) (int, error) {
	v := strings.ToLower(strings.TrimSpace(s))
	if v == "now" {
		if !allowNow {
			return 0, errors.New(`"now" only works for today, give a clock time`)
		}
		return nowMins, nil
	}
	if m := dtClock12Re.FindStringSubmatch(v); m != nil {
		h, _ := strconv.Atoi(m[1])
		mins := 0
		if m[2] != "" {
			mins, _ = strconv.Atoi(m[2])
		}
		if h < 1 || h > 12 || mins > 59 {
			return 0, fmt.Errorf("%q is not a valid time", s)
		}
		h %= 12
		if m[3] == "p" {
			h += 12
		}
		return h*60 + mins, nil
	}
	if m := dtClock24Re.FindStringSubmatch(v); m != nil {
		h, _ := strconv.Atoi(m[1])
		mins, _ := strconv.Atoi(m[2])
		if h > 23 || mins > 59 {
			return 0, fmt.Errorf("%q is not a valid time", s)
		}
		return h*60 + mins, nil
	}
	return 0, fmt.Errorf(`%q is not a clock time, use a form like "2:30 PM"`, s)
}

// mcpMinsTo12h formats minutes after midnight as "2:30 PM", wrapping past midnight.
func mcpMinsTo12h(m int) string {
	m = ((m % mcpMinsPerDay) + mcpMinsPerDay) % mcpMinsPerDay
	h, mm := m/60, m%60
	suffix := "AM"
	if h >= 12 {
		suffix = "PM"
	}
	h12 := h % 12
	if h12 == 0 {
		h12 = 12
	}
	return fmt.Sprintf("%d:%02d %s", h12, mm, suffix)
}

// dayTrackClockInput is what the caller said about one task's time, all of it optional.
type dayTrackClockInput struct {
	Start, End   string
	DurationMins *int
}

// dayTrackClockContext is what the log already knows when that task is added.
type dayTrackClockContext struct {
	IsToday       bool
	Today         string // YYYY-MM-DD in the user's timezone
	NowMins       int
	LatestEndMins int  // latest end time logged that day, -1 when none
	Batch         bool // several tasks in one call, so none of them owns the gap since the last entry
}

// dayTrackTimes is the outcome. Source says where the times came from: given (the caller),
// chained (last end + 1 minute, the page's next-start rule), logged_at (stamped now, no
// duration, like an instant ticket event) or blank (a past day with nothing to go on).
type dayTrackTimes struct {
	Start, End   string
	DurationMins *int
	Source       string
	Warnings     []string
}

// mcpResolveDayTrackTimes fills in a task's times without inventing work that wasn't
// reported: only a lone task on today's date may claim the gap since the last entry.
func mcpResolveDayTrackTimes(in dayTrackClockInput, c dayTrackClockContext) (dayTrackTimes, error) {
	var out dayTrackTimes
	start, end := -1, -1
	var err error
	if strings.TrimSpace(in.Start) != "" {
		if start, err = mcpParseDayTrackClock(in.Start, c.NowMins, c.IsToday); err != nil {
			return out, fmt.Errorf("start_time: %w", err)
		}
	}
	if strings.TrimSpace(in.End) != "" {
		if end, err = mcpParseDayTrackClock(in.End, c.NowMins, c.IsToday); err != nil {
			return out, fmt.Errorf("end_time: %w", err)
		}
	}
	dur := in.DurationMins
	if dur != nil && (*dur <= 0 || *dur > mcpMinsPerDay) {
		return out, fmt.Errorf("duration_mins must be between 1 and %d", mcpMinsPerDay)
	}
	givenStart := start >= 0
	canChain := func(until int) bool {
		return !c.Batch && c.IsToday && c.LatestEndMins >= 0 && c.LatestEndMins+1 < until
	}

	out.Source = "given"
	switch {
	case start >= 0 && end >= 0:
		span := end - start
		if span < 0 {
			span += mcpMinsPerDay
			if span > mcpDayTrackOvernightMaxMins {
				return out, fmt.Errorf("end_time %s is before start_time %s", mcpMinsTo12h(end), mcpMinsTo12h(start))
			}
			out.Warnings = append(out.Warnings, "This runs past midnight, so it is logged on the day it started.")
		}
		if dur == nil && span > 0 {
			dur = &span
		}
	case start >= 0 && dur != nil:
		end = start + *dur
		if end >= mcpMinsPerDay {
			out.Warnings = append(out.Warnings, "This runs past midnight, so it is logged on the day it started.")
		}
	case end >= 0 && dur != nil:
		start = end - *dur
		if start < 0 {
			start += mcpMinsPerDay
			out.Warnings = append(out.Warnings, "This runs past midnight, so it is logged on the day it ended.")
		}
	case start >= 0:
		if c.IsToday && c.NowMins > start {
			end = c.NowMins
			span := end - start
			dur = &span
		}
	case end >= 0:
		if canChain(end) {
			start = c.LatestEndMins + 1
			span := end - start
			dur = &span
			out.Source = "chained"
		} else {
			start = end
		}
	case dur != nil:
		switch {
		case !c.IsToday:
		case c.Batch:
			start, end = c.NowMins, c.NowMins
			out.Source = "logged_at"
		case *dur > c.NowMins:
			return out, fmt.Errorf("duration_mins %d is longer than today so far, pass start_time too", *dur)
		default:
			start, end = c.NowMins-*dur, c.NowMins
		}
	default:
		switch {
		case !c.IsToday:
			out.Source = "blank"
		case canChain(c.NowMins):
			start, end = c.LatestEndMins+1, c.NowMins
			span := end - start
			dur = &span
			out.Source = "chained"
			if span > mcpDayTrackLongSpanMins {
				out.Warnings = append(out.Warnings, fmt.Sprintf(
					"Automatic time %s to %s covers %s since the last entry. Pass start_time if the task was shorter.",
					mcpMinsTo12h(start), mcpMinsTo12h(end), fmtDurMins(span)))
			}
		default:
			start, end = c.NowMins, c.NowMins
			out.Source = "logged_at"
		}
	}

	if c.IsToday && out.Source == "given" && ((givenStart && start > c.NowMins) || end > c.NowMins) {
		out.Warnings = append(out.Warnings, "This time is still ahead of the clock today. Check the timezone if that looks wrong.")
	}
	if start >= 0 {
		out.Start = mcpMinsTo12h(start)
	}
	if end >= 0 {
		out.End = mcpMinsTo12h(end)
	}
	out.DurationMins = dur
	return out, nil
}

// ── Category choice ───────────────────────────────────────────────────────────

// dtLeadWords maps the first word of a task, usually its verb, to a category. It decides
// before any keyword scan because the verb says what was done: "fixed login bug" is
// Development even though "bug" alone reads as Testing.
var dtLeadWords = map[string]string{
	"test": "Testing", "tests": "Testing", "tested": "Testing", "testing": "Testing", "retested": "Testing",
	"verify": "Testing", "verified": "Testing", "verifying": "Testing", "validate": "Testing", "validated": "Testing",
	"qa": "Testing",

	"fix": "Development", "fixed": "Development", "fixes": "Development", "fixing": "Development",
	"build": "Development", "built": "Development", "building": "Development",
	"implement": "Development", "implemented": "Development", "implementing": "Development",
	"add": "Development", "added": "Development", "adding": "Development",
	"create": "Development", "created": "Development", "wrote": "Development", "write": "Development",
	"update": "Development", "updated": "Development", "remove": "Development", "removed": "Development",
	"refactor": "Development", "refactored": "Development", "develop": "Development", "developed": "Development",
	"migrate": "Development", "migrated": "Development", "resolve": "Development", "resolved": "Development",
	"redesign": "Development", "redesigned": "Development", "rewrote": "Development", "improved": "Development",

	"research": "Research", "researched": "Research", "researching": "Research",
	"investigate": "Research", "investigated": "Research", "investigating": "Research",
	"explore": "Research", "explored": "Research", "analyze": "Research", "analyzed": "Research",
	"analyse": "Research", "analysed": "Research", "studied": "Research", "read": "Research",

	"review": "Review", "reviewed": "Review", "reviewing": "Review",

	"meeting": "Meetings", "met": "Meetings", "attended": "Meetings", "joined": "Meetings", "standup": "Meetings",
	"discussed": "Meetings", "synced": "Meetings", "demoed": "Meetings",
}

// dtScanRules is the page's detectCategory table, matched on whole words so "latest" isn't
// "test" and "recall" isn't "call". Breaks and sign in/off are not here: they count only
// when the whole message is that shorthand (mcpDayTrackShorthand).
var dtScanRules = []struct {
	category string
	phrases  []string
}{
	{"Review", []string{"code review", "pr review"}},
	{"Development", []string{"fix", "fixes", "fixed", "hotfix", "bugfix"}},
	{"Testing", []string{"test", "tests", "tested", "testing", "qa", "uat", "e2e", "regression", "playwright", "cypress", "debug", "debugging", "bug", "bugs"}},
	{"Development", []string{"develop", "development", "implement", "implemented", "build", "feature", "refactor", "commit", "pull request", "code", "coding", "programming"}},
	{"Meetings", []string{"meeting", "meetings", "standup", "stand up", "call", "calls", "sync", "discussion", "demo", "retrospective", "retro", "planning", "kt", "knowledge transfer"}},
	{"Research", []string{"research", "reading", "study", "investigate", "investigation", "explore", "analyze", "analysis", "look into", "looked into"}},
	{"Review", []string{"review", "feedback"}},
}

// dtHasPhrase reports whether phrase appears in tokens as whole, consecutive words.
func dtHasPhrase(tokens []string, phrase string) bool {
	want := wordsOf(phrase)
	if len(want) == 0 {
		return false
	}
	for i := 0; i+len(want) <= len(tokens); i++ {
		match := true
		for j := range want {
			if tokens[i+j] != want[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func dtStartsWith(tokens []string, phrases ...string) bool {
	for _, p := range phrases {
		want := wordsOf(p)
		if len(want) <= len(tokens) && dtHasPhrase(tokens[:len(want)], p) {
			return true
		}
	}
	return false
}

// mcpDayTrackShorthand recognises sign in/off and break messages. These only count as short
// standalone messages, since "fixed users being signed in twice" is work. "aws" means away
// from screen on this team, but only with nothing except a length after it: "aws migration"
// is about the cloud.
func mcpDayTrackShorthand(tokens []string) string {
	if len(tokens) == 0 || len(tokens) > 6 {
		return ""
	}
	switch {
	case dtStartsWith(tokens, "signing in", "signed in", "logging in", "starting work"):
		return "Sign In"
	case dtStartsWith(tokens, "signing off", "signed off", "logging off", "end of day"):
		return "Sign Off"
	case dtStartsWith(tokens, "break", "lunch", "coffee", "brb", "away from screen"):
		return "Breaks"
	}
	if tokens[0] != "aws" {
		return ""
	}
	for _, w := range tokens[1:] {
		if _, err := strconv.Atoi(w); err != nil && w != "min" && w != "mins" && w != "minutes" && w != "for" {
			return ""
		}
	}
	return "Breaks"
}

// dtStripPrefixes drops leading labels such as "Velocity:" or "ARD-123:" so the first word
// left is what was actually done.
func dtStripPrefixes(s string) string {
	for {
		i := strings.Index(s, ": ")
		if i <= 0 || i > 30 {
			return s
		}
		s = s[i+2:]
	}
}

// mcpDetectDayTrackCategory picks a category for a task from the user's list. Source is
// "detected" when something in the text decided it, or "default" for the page's default,
// the first category in the list.
func mcpDetectDayTrackCategory(text string, categories []string) (string, string) {
	available := map[string]string{}
	for _, c := range categories {
		available[strings.ToLower(c)] = c
	}
	pick := func(name string) (string, bool) {
		c, ok := available[strings.ToLower(name)]
		return c, ok
	}

	all := wordsOf(text)
	builtIn := map[string]bool{}
	for _, c := range dayTrackBuiltInCategories {
		builtIn[strings.ToLower(c)] = true
	}
	for _, c := range categories {
		if !builtIn[strings.ToLower(c)] && dtHasPhrase(all, c) {
			return c, "detected"
		}
	}

	tokens := wordsOf(dtStripPrefixes(text))
	if name := mcpDayTrackShorthand(tokens); name != "" {
		if c, ok := pick(name); ok {
			return c, "detected"
		}
	}
	if len(tokens) > 0 {
		if name, ok := dtLeadWords[tokens[0]]; ok {
			if c, ok := pick(name); ok {
				return c, "detected"
			}
		}
	}
	for _, rule := range dtScanRules {
		c, ok := pick(rule.category)
		if !ok {
			continue
		}
		for _, p := range rule.phrases {
			if dtHasPhrase(tokens, p) {
				return c, "detected"
			}
		}
	}
	if len(categories) > 0 {
		return categories[0], "default"
	}
	return "General", "default"
}

// mcpMatchDayTrackCategory finds a category by name, ignoring case and surrounding spaces,
// and returns it spelled the way the user's list spells it.
func mcpMatchDayTrackCategory(name string, categories []string) (string, bool) {
	want := strings.ToLower(strings.TrimSpace(name))
	for _, c := range categories {
		if strings.ToLower(strings.TrimSpace(c)) == want {
			return c, true
		}
	}
	return "", false
}
