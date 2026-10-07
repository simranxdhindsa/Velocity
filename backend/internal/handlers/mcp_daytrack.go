package handlers

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
)

// Helpers for the get_daytrack MCP tool (mcp_tool_get_daytrack.go).

const (
	mcpDayTrackDefaultTZ   = "Asia/Kolkata" // same default as daytrack_slack_config.timezone / istToday
	mcpDayTrackMaxRangeDay = 62
)

var mcpDayTrackRepo = database.NewDayTrackRepository()
var mcpUserRepo = database.NewUserRepository()

// mcpTicketIDRe matches readable YouTrack IDs like ARD-2925.
var mcpTicketIDRe = regexp.MustCompile(`\b[A-Z][A-Z0-9]+-\d+\b`)

// mcpDayTrackTimezone returns the user's DayTrack timezone (daytrack_slack_config.timezone),
// falling back to Asia/Kolkata like the rest of DayTrack does.
func mcpDayTrackTimezone(ctx context.Context, userID string) (*time.Location, string) {
	tz := mcpDayTrackDefaultTZ
	if cfg, err := mcpDayTrackRepo.GetSlackConfig(ctx, userID); err == nil && cfg != nil && cfg.Timezone != "" {
		tz = cfg.Timezone
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		tz = mcpDayTrackDefaultTZ
		loc, _ = time.LoadLocation(tz)
	}
	if loc == nil {
		loc = time.UTC
	}
	return loc, tz
}

// mcpParseDayTrackDate accepts YYYY-MM-DD, "today" or "yesterday" (in loc).
func mcpParseDayTrackDate(s string, loc *time.Location) (time.Time, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	now := time.Now().In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	switch s {
	case "today":
		return today, nil
	case "yesterday":
		return today.AddDate(0, 0, -1), nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, loc)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid date %q: use YYYY-MM-DD, 'today' or 'yesterday'", s)
	}
	return t, nil
}

// mcpResolveDayTrackTarget decides whose DayTrack is read. The caller is always
// derived from the authenticated userID. Only admins (models.RoleAdmin, the same
// check as the Slack bot conversations log) may name someone else; a non-admin
// naming anyone but themselves gets an error without any lookup, so the tool
// never reveals whether another user exists.
func mcpResolveDayTrackTarget(ctx context.Context, userID, who string) (caller, target *models.User, err error) {
	caller, err = mcpUserRepo.GetByID(ctx, userID)
	if err != nil || caller == nil {
		return nil, nil, errors.New("could not load the calling Velocity user")
	}
	who = strings.TrimSpace(who)
	if who == "" || strings.EqualFold(who, caller.Email) || strings.EqualFold(who, caller.Name) {
		return caller, caller, nil
	}
	if caller.Role != models.RoleAdmin {
		return caller, nil, errors.New("only admins can read another user's DayTrack. Omit user_email/user to read your own")
	}
	users, err := mcpUserRepo.List(ctx)
	if err != nil {
		return caller, nil, fmt.Errorf("failed to list users: %w", err)
	}
	lw := strings.ToLower(who)
	var exact, partial []*models.User
	for _, u := range users {
		email, name := strings.ToLower(u.Email), strings.ToLower(u.Name)
		local := email
		if i := strings.Index(email, "@"); i > 0 {
			local = email[:i]
		}
		switch {
		case email == lw || name == lw || local == lw:
			exact = append(exact, u)
		case strings.Contains(name, lw) || strings.Contains(email, lw):
			partial = append(partial, u)
		}
	}
	matches := exact
	if len(matches) == 0 {
		matches = partial
	}
	switch len(matches) {
	case 0:
		return caller, nil, fmt.Errorf("no Velocity user matches %q", who)
	case 1:
		return caller, matches[0], nil
	}
	var names []string
	for _, u := range matches {
		names = append(names, fmt.Sprintf("%s <%s>", u.Name, u.Email))
	}
	return caller, nil, fmt.Errorf("%q matches several users: %s. Pass user_email", who, strings.Join(names, ", "))
}

// mcpFmt12h normalises a stored DayTrack time ("12:49 PM" or legacy "14:30") to
// 12-hour "2:30 PM". Empty or unparseable input returns "".
func mcpFmt12h(t string) string {
	m := timeToMins(t)
	if m < 0 {
		return ""
	}
	h, mm := (m/60)%24, m%60
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

// mcpEntryDuration returns the stored duration_mins, or (like the frontend's
// calcDuration) end minus start when only the times were saved.
func mcpEntryDuration(e database.DayTrackEntry) (mins int, computed bool, ok bool) {
	if e.DurationMins != nil {
		return *e.DurationMins, false, true
	}
	s, en := timeToMins(e.StartTime), timeToMins(e.EndTime)
	if s < 0 || en < 0 {
		return 0, false, false
	}
	d := en - s
	if d < 0 {
		d += 24 * 60
	}
	if d <= 0 {
		return 0, false, false
	}
	return d, true, true
}

// mcpYouTrackProjectPrefixes returns the uppercase shortNames of every
// YouTrack project the user's token can see (ARD, APY, ...), so ticket IDs are
// recognised per real project instead of any "WORD-123" text like "GPT-5".
// Returns nil when YouTrack is unavailable.
func mcpYouTrackProjectPrefixes(ctx context.Context, userID string) map[string]bool {
	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return nil
	}
	projects, err := yt.GetProjects(ctx)
	if err != nil || len(projects) == 0 {
		return nil
	}
	out := make(map[string]bool, len(projects))
	for _, p := range projects {
		if p.ShortName != "" {
			out[strings.ToUpper(p.ShortName)] = true
		}
	}
	return out
}

// mcpEntryTicketIDs collects ticket IDs from youtrack_issue_id, external_ref
// (yt-tested-ARD-1-prod, yt-create-ARD-1) and the entry's name/notes. Matches
// in name/notes only count when the prefix is a real YouTrack project
// (prefixes); with no project list, free text is skipped rather than guessed.
func mcpEntryTicketIDs(e database.DayTrackEntry, prefixes map[string]bool) []string {
	seen := map[string]bool{}
	var out []string
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if e.YoutrackIssueID != nil {
		add(strings.TrimSpace(*e.YoutrackIssueID))
	}
	for _, m := range mcpTicketIDRe.FindAllString(e.ExternalRef, -1) {
		add(m)
	}
	if prefixes == nil {
		return out
	}
	for _, src := range []string{e.Name, e.Notes} {
		for _, m := range mcpTicketIDRe.FindAllString(src, -1) {
			if prefixes[m[:strings.LastIndex(m, "-")]] {
				add(m)
			}
		}
	}
	return out
}

// mcpSortEntries orders entries within a day by start time (untimed last), then creation.
func mcpSortEntries(entries []database.DayTrackEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.EntryDate != b.EntryDate {
			return a.EntryDate < b.EntryDate
		}
		ai, bi := timeToMins(a.StartTime), timeToMins(b.StartTime)
		if ai < 0 {
			ai = 1 << 20
		}
		if bi < 0 {
			bi = 1 << 20
		}
		if ai != bi {
			return ai < bi
		}
		return a.CreatedAt.Before(b.CreatedAt)
	})
}
