package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

// Helpers shared by the Day Track write tools (add, update, delete, send). The tools only ever
// touch the caller's own log: every lookup is scoped by the authenticated userID.

var mcpDayTrackIDRe = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// mcpDayTrackClock is the current moment in the user's Day Track timezone.
type mcpDayTrackClock struct {
	Loc     *time.Location
	Today   string
	NowMins int
}

func mcpDayTrackClockFor(ctx context.Context, userID string) mcpDayTrackClock {
	loc, _ := mcpDayTrackTimezone(ctx, userID)
	now := time.Now().In(loc)
	return mcpDayTrackClock{Loc: loc, Today: now.Format("2006-01-02"), NowMins: now.Hour()*60 + now.Minute()}
}

// mcpDayTrackCategories is the list the page offers: the built-ins, then the user's custom ones.
func mcpDayTrackCategories(ctx context.Context, userID string) ([]string, error) {
	custom, err := mcpDayTrackRepo.GetCategories(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := append([]string{}, dayTrackBuiltInCategories...)
	for _, c := range custom {
		if _, dup := mcpMatchDayTrackCategory(c.Name, dayTrackBuiltInCategories); !dup {
			out = append(out, c.Name)
		}
	}
	return out, nil
}

func mcpDayTrackIcons(ctx context.Context, userID string) map[string]string {
	icons := map[string]string{}
	if cats, err := mcpDayTrackRepo.GetCategories(ctx, userID); err == nil {
		for _, c := range cats {
			icons[strings.ToLower(strings.TrimSpace(c.Name))] = c.Icon
		}
	}
	return icons
}

// mcpDayTrackLatestEnd is the latest end time logged in entries, or -1 when none has one.
// It feeds the page's rule that the next task starts one minute after the last one ended.
func mcpDayTrackLatestEnd(entries []database.DayTrackEntry) int {
	latest := -1
	for _, e := range entries {
		if m := timeToMins(e.EndTime); m > latest {
			latest = m
		}
	}
	return latest
}

// mcpDayTrackPostNote warns when date's report already sits in Slack: the post is not edited
// until send_daytrack runs again or the 11:50 PM auto-send picks the change up.
func mcpDayTrackPostNote(ctx context.Context, userID, date string) string {
	post, err := mcpDayTrackRepo.GetDailyPost(ctx, userID, date)
	if err != nil || post == nil {
		return ""
	}
	return "The Slack post for " + date + " still shows the old report. Call send_daytrack to refresh it."
}

// mcpDTItem is one Day Track row as the write tools report it. List says where it lives:
// todays_log (finished work) or planned (Planned & Carry Over).
type mcpDTItem struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Category       string `json:"category"`
	Emoji          string `json:"emoji"`
	Status         string `json:"status"`
	List           string `json:"list"`
	Date           string `json:"date"`
	When           string `json:"when,omitempty"`
	StartTime      string `json:"start_time,omitempty"`
	EndTime        string `json:"end_time,omitempty"`
	DurationMins   *int   `json:"duration_mins,omitempty"`
	Duration       string `json:"duration,omitempty"`
	Notes          string `json:"notes,omitempty"`
	Source         string `json:"source,omitempty"`
	ParentEntryID  string `json:"parent_entry_id,omitempty"`
	CategorySource string `json:"category_source,omitempty"`
	TimeSource     string `json:"time_source,omitempty"`
}

func mcpDTItemFromEntry(e *database.DayTrackEntry, icons map[string]string) mcpDTItem {
	item := mcpDTItem{
		ID: e.ID, Name: e.Name, Category: e.Category, Emoji: categoryEmoji(e.Category, icons),
		Status: e.Status, List: "todays_log", Date: e.EntryDate,
		StartTime: mcpFmt12h(e.StartTime), EndTime: mcpFmt12h(e.EndTime),
		DurationMins: e.DurationMins, Notes: e.Notes, Source: e.EntrySource,
	}
	if e.DurationMins != nil {
		item.Duration = fmtDurMins(*e.DurationMins)
	}
	if e.ParentEntryID != nil {
		item.ParentEntryID = *e.ParentEntryID
	}
	return item
}

func mcpDTItemFromPlanned(p *database.DayTrackPlanned, icons map[string]string) mcpDTItem {
	start := p.StartTime
	if start == "" {
		start = p.ScheduledTime
	}
	return mcpDTItem{
		ID: p.ID, Name: p.Name, Category: p.Category, Emoji: categoryEmoji(p.Category, icons),
		Status: p.Status, List: "planned", Date: p.EntryDate, When: p.WhenType,
		StartTime: mcpFmt12h(start), Notes: p.Notes, Source: p.EntrySource,
	}
}

// mcpDTResult answers with a plain sentence first, which is what the Claude actions log shows,
// then the details as JSON for the agent.
func mcpDTResult(id interface{}, sentence string, details map[string]interface{}) rpcResponse {
	data, err := json.Marshal(details)
	if err != nil {
		return toolOK(id, sentence)
	}
	return toolOKContent(id, []map[string]interface{}{mcpTextBlock(sentence), mcpTextBlock(string(data))})
}

// mcpDTArgsError turns a JSON decoding failure into something a person or agent can act on,
// without the Go type names the decoder puts in its own message.
func mcpDTArgsError(err error) string {
	var typeErr *json.UnmarshalTypeError
	if !errors.As(err, &typeErr) {
		return "the arguments are not valid JSON"
	}
	if typeErr.Field == "" {
		return "arguments must be an object"
	}
	want := "a different type"
	switch typeErr.Type.Kind() {
	case reflect.Int, reflect.Int64:
		want = "a whole number"
	case reflect.String:
		want = "text"
	case reflect.Bool:
		want = "true or false"
	case reflect.Slice:
		want = "a list"
	case reflect.Struct, reflect.Map:
		want = "an object"
	}
	return fmt.Sprintf("%s must be %s", typeErr.Field, want)
}

// mcpDayTrackCheckLine enforces the one-line rule on a single value, naming the field.
func mcpDayTrackCheckLine(field, value string) error {
	if n := len([]rune(value)); n > mcpDayTrackMaxLine {
		return fmt.Errorf("%s is %d characters, the limit is %d so it stays on one line. Shorten it, or split it into separate entries: %q",
			field, n, mcpDayTrackMaxLine, value)
	}
	return nil
}

// mcpDayTrackStatus normalises a status argument to done, in_progress or planned.
func mcpDayTrackStatus(s string) (string, error) {
	v := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), " ", "_")
	switch v {
	case "", "done":
		return "done", nil
	case "in_progress", "active":
		return "in_progress", nil
	case "planned":
		return "planned", nil
	}
	return "", fmt.Errorf("unknown status %q. Use done, in_progress or planned", s)
}

// mcpDayTrackWhen normalises a planned item's when_type.
func mcpDayTrackWhen(s string) (string, error) {
	v := strings.ToLower(strings.TrimSpace(s))
	switch v {
	case "", "today":
		return "today", nil
	case "tomorrow":
		return "tomorrow", nil
	}
	return "", fmt.Errorf("unknown when %q. Use today or tomorrow", s)
}
