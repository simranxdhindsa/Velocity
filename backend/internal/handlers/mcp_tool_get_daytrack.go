package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
)

var getDaytrackToolSchema = map[string]interface{}{
	"name": "get_daytrack",
	"description": "Read-only. Returns the caller's DayTrack (Velocity's daily work log): each entry with its 12-hour time range, duration, " +
		"category (with emoji), status, linked YouTrack ticket IDs, notes and subtasks, plus per-day, per-category and grand totals. " +
		"Use it for 'what did I do today/yesterday/last week', 'how long did I spend on testing', or to draft a standup. " +
		"Pass either `date` (YYYY-MM-DD, 'today' or 'yesterday', in the user's DayTrack timezone) or `from` + `to` for a range of at most 62 days. " +
		"For a single date the result also includes `report_text`, the exact text the DayTrack 'Copy DayTrack' button and Slack post use. " +
		"Totals count top-level entries only (subtasks are part of their parent), same as the DayTrack page. " +
		"Admins may pass `user_email` (or `user`, a name) to read someone else's DayTrack; everyone else only ever sees their own.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"date": map[string]interface{}{
				"type":        "string",
				"description": "Single day: YYYY-MM-DD, 'today' or 'yesterday'. Defaults to 'today' when neither date nor from/to is given.",
			},
			"from": map[string]interface{}{
				"type":        "string",
				"description": "Range start (inclusive): YYYY-MM-DD, 'today' or 'yesterday'. Use with `to`.",
			},
			"to": map[string]interface{}{
				"type":        "string",
				"description": "Range end (inclusive). Defaults to `from` if omitted. Max 62 days in the range.",
			},
			"category": map[string]interface{}{
				"type":        "string",
				"description": "Optional. Only entries in this category (case-insensitive, e.g. 'Testing'). Unknown categories return the list of categories present.",
			},
			"user_email": map[string]interface{}{
				"type":        "string",
				"description": "Admins only. Email of the Velocity user whose DayTrack to read. Omit to read your own.",
			},
			"user": map[string]interface{}{
				"type":        "string",
				"description": "Admins only. Name (or email) of the Velocity user whose DayTrack to read, if the email isn't known.",
			},
			"summary_only": map[string]interface{}{
				"type":        "boolean",
				"description": "Return only per-day and per-category totals, no individual entries. Use for long ranges. Default false.",
			},
			"include_report_text": map[string]interface{}{
				"type":        "boolean",
				"description": "Include the Copy DayTrack / Slack report text per day. Default true for a single date, false for ranges.",
			},
		},
		"required": []string{},
	},
}

type mcpDTEntry struct {
	Name            string       `json:"name"`
	Category        string       `json:"category"`
	Emoji           string       `json:"emoji"`
	Status          string       `json:"status"`
	StartTime       string       `json:"start_time,omitempty"`
	EndTime         string       `json:"end_time,omitempty"`
	TimeRange       string       `json:"time_range,omitempty"`
	DurationMins    *int         `json:"duration_mins"`
	Duration        string       `json:"duration,omitempty"`
	DurationFromRng bool         `json:"duration_from_times,omitempty"`
	TicketIDs       []string     `json:"ticket_ids,omitempty"`
	Notes           string       `json:"notes,omitempty"`
	Source          string       `json:"source"`
	Subtasks        []mcpDTEntry `json:"subtasks,omitempty"`
}

type mcpDTDay struct {
	Date       string       `json:"date"`
	Weekday    string       `json:"weekday"`
	Entries    []mcpDTEntry `json:"entries,omitempty"`
	TotalMins  int          `json:"total_mins"`
	Total      string       `json:"total"`
	EntryCount int          `json:"entry_count"`
	DoneCount  int          `json:"done_count"`
	ReportText *string      `json:"report_text,omitempty"`
}

type mcpDTCatTotal struct {
	Category   string `json:"category"`
	Emoji      string `json:"emoji"`
	TotalMins  int    `json:"total_mins"`
	Total      string `json:"total"`
	EntryCount int    `json:"entry_count"`
}

func mcpGetDaytrack(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Date              string `json:"date"`
		From              string `json:"from"`
		To                string `json:"to"`
		Category          string `json:"category"`
		UserEmail         string `json:"user_email"`
		User              string `json:"user"`
		IncludeReportText *bool  `json:"include_report_text"`
		SummaryOnly       bool   `json:"summary_only"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return rpcErr(id, -32602, "invalid arguments: "+err.Error())
		}
	}

	who := a.UserEmail
	if strings.TrimSpace(who) == "" {
		who = a.User
	}
	_, target, err := mcpResolveDayTrackTarget(ctx, userID, who)
	if err != nil {
		return toolError(id, err.Error())
	}

	loc, tzName := mcpDayTrackTimezone(ctx, target.ID)
	if strings.TrimSpace(a.Date) != "" && (strings.TrimSpace(a.From) != "" || strings.TrimSpace(a.To) != "") {
		return toolError(id, "pass either date, or from/to, not both")
	}
	fromStr, toStr := a.From, a.To
	if strings.TrimSpace(fromStr) == "" && strings.TrimSpace(toStr) != "" {
		return toolError(id, "`to` needs a `from`")
	}
	if strings.TrimSpace(fromStr) == "" {
		fromStr = a.Date
		if strings.TrimSpace(fromStr) == "" {
			fromStr = "today"
		}
		toStr = fromStr
	} else if strings.TrimSpace(toStr) == "" {
		toStr = fromStr
	}
	from, err := mcpParseDayTrackDate(fromStr, loc)
	if err != nil {
		return toolError(id, err.Error())
	}
	to, err := mcpParseDayTrackDate(toStr, loc)
	if err != nil {
		return toolError(id, err.Error())
	}
	if to.Before(from) {
		return toolError(id, "`to` is before `from`")
	}
	days := int(to.Sub(from).Hours()/24+0.5) + 1
	if days > mcpDayTrackMaxRangeDay {
		return toolError(id, fmt.Sprintf("range is %d days; the maximum is %d. Split it into smaller ranges", days, mcpDayTrackMaxRangeDay))
	}
	single := days == 1
	includeReport := single
	if a.IncludeReportText != nil {
		includeReport = *a.IncludeReportText
	}

	fromDate, toDate := from.Format("2006-01-02"), to.Format("2006-01-02")
	// Repo read only. The REST handlers also prune entries whose YouTrack ticket was
	// deleted; that is a write, so this read-only tool deliberately skips it.
	entries, err := mcpDayTrackRepo.GetEntriesRange(ctx, target.ID, fromDate, toDate)
	if err != nil {
		return toolError(id, "failed to read DayTrack entries: "+err.Error())
	}
	mcpSortEntries(entries)

	customIcons := map[string]string{}
	if cats, cErr := mcpDayTrackRepo.GetCategories(ctx, target.ID); cErr == nil {
		for _, c := range cats {
			customIcons[strings.ToLower(strings.TrimSpace(c.Name))] = c.Icon
		}
	}

	// Parent/subtask split, same as the DayTrack page: totals count parents only.
	present := map[string]bool{}
	for _, e := range entries {
		present[e.ID] = true
	}
	subs := map[string][]database.DayTrackEntry{}
	var parents []database.DayTrackEntry
	for _, e := range entries {
		if e.ParentEntryID != nil && *e.ParentEntryID != "" && present[*e.ParentEntryID] {
			subs[*e.ParentEntryID] = append(subs[*e.ParentEntryID], e)
			continue
		}
		parents = append(parents, e)
	}

	catFilter := strings.ToLower(strings.TrimSpace(a.Category))
	if catFilter != "" {
		var kept []database.DayTrackEntry
		catsSeen := map[string]bool{}
		var catsList []string
		for _, e := range parents {
			if strings.ToLower(strings.TrimSpace(e.Category)) == catFilter {
				kept = append(kept, e)
			}
			if !catsSeen[e.Category] {
				catsSeen[e.Category] = true
				catsList = append(catsList, e.Category)
			}
		}
		if len(kept) == 0 && len(parents) > 0 {
			sort.Strings(catsList)
			return toolError(id, fmt.Sprintf("no %q entries between %s and %s. Categories present: %s",
				a.Category, fromDate, toDate, strings.Join(catsList, ", ")))
		}
		parents = kept
	}

	build := func(e database.DayTrackEntry) mcpDTEntry {
		out := mcpDTEntry{
			Name:      e.Name,
			Category:  e.Category,
			Emoji:     categoryEmoji(e.Category, customIcons),
			Status:    e.Status,
			StartTime: mcpFmt12h(e.StartTime),
			EndTime:   mcpFmt12h(e.EndTime),
			TicketIDs: mcpEntryTicketIDs(e),
			Notes:     e.Notes,
			Source:    e.EntrySource,
		}
		switch {
		case out.StartTime != "" && out.EndTime != "" && out.StartTime != out.EndTime:
			out.TimeRange = out.StartTime + " to " + out.EndTime
		case out.StartTime != "":
			out.TimeRange = out.StartTime
		case out.EndTime != "":
			out.TimeRange = out.EndTime
		}
		if mins, computed, ok := mcpEntryDuration(e); ok {
			m := mins
			out.DurationMins = &m
			out.Duration = fmtDurMins(mins)
			out.DurationFromRng = computed
		}
		return out
	}

	dayMap := map[string]*mcpDTDay{}
	catMap := map[string]*mcpDTCatTotal{}
	var catOrder []string
	grandMins, grandCount := 0, 0
	for _, e := range parents {
		d := dayMap[e.EntryDate]
		if d == nil {
			d = &mcpDTDay{Date: e.EntryDate, Entries: []mcpDTEntry{}}
			dayMap[e.EntryDate] = d
		}
		item := build(e)
		for _, s := range subs[e.ID] {
			item.Subtasks = append(item.Subtasks, build(s))
		}
		if !a.SummaryOnly {
			d.Entries = append(d.Entries, item)
		}
		d.EntryCount++
		if e.Status == "done" {
			d.DoneCount++
		}
		mins := 0
		if item.DurationMins != nil {
			mins = *item.DurationMins
		}
		d.TotalMins += mins
		grandMins += mins
		grandCount++

		ck := strings.ToLower(strings.TrimSpace(e.Category))
		ct := catMap[ck]
		if ct == nil {
			ct = &mcpDTCatTotal{Category: e.Category, Emoji: item.Emoji}
			catMap[ck] = ct
			catOrder = append(catOrder, ck)
		}
		ct.EntryCount++
		ct.TotalMins += mins
	}

	// One row per calendar day in the range (empty days included for ranges).
	dayList := []mcpDTDay{}
	var dt mcpDayTrackHandlerShim
	for cur := from; !cur.After(to); cur = cur.AddDate(0, 0, 1) {
		ds := cur.Format("2006-01-02")
		d := dayMap[ds]
		if d == nil {
			d = &mcpDTDay{Date: ds, Entries: []mcpDTEntry{}}
		}
		d.Weekday = cur.Weekday().String()
		d.Total = fmtDurMins(d.TotalMins)
		if includeReport {
			text, rErr := dt.reportText(ctx, target.ID, ds, target.Name)
			if rErr == nil {
				d.ReportText = &text
			}
		}
		if single || d.EntryCount > 0 || includeReport {
			dayList = append(dayList, *d)
		}
	}

	catTotals := make([]mcpDTCatTotal, 0, len(catOrder))
	for _, k := range catOrder {
		c := *catMap[k]
		c.Total = fmtDurMins(c.TotalMins)
		catTotals = append(catTotals, c)
	}
	sort.SliceStable(catTotals, func(i, j int) bool { return catTotals[i].TotalMins > catTotals[j].TotalMins })

	resp := map[string]interface{}{
		"user":            map[string]string{"name": target.Name, "email": target.Email},
		"timezone":        tzName,
		"from":            fromDate,
		"to":              toDate,
		"days":            dayList,
		"category_totals": catTotals,
		"total_mins":      grandMins,
		"total":           fmtDurMins(grandMins),
		"entry_count":     grandCount,
	}
	if catFilter != "" {
		resp["category_filter"] = a.Category
	}
	if target.ID != userID {
		resp["admin_view"] = true
	}
	var notes []string
	if grandCount == 0 {
		notes = append(notes, "No DayTrack entries logged in this period.")
	}
	if !single && !includeReport {
		notes = append(notes, "Days with no entries are omitted.")
	}
	if includeReport && catFilter != "" {
		notes = append(notes, "report_text is the full day's report and ignores the category filter.")
	}
	notes = append(notes, "Durations: entries without a stored duration or a start/end span count as 0 in totals (sign in/off and instant ticket events usually have none).")
	resp["notes"] = notes

	data, _ := json.Marshal(resp)
	return toolOK(id, string(data))
}

// mcpDayTrackHandlerShim reuses DayTrackHandler.buildDayTrackReportText (the single source
// of the Copy DayTrack / Slack text) with ytHandler=nil, which turns its deleted-ticket
// pruning step into a no-op, so building the text never writes anything.
type mcpDayTrackHandlerShim struct{}

func (mcpDayTrackHandlerShim) reportText(ctx context.Context, userID, date, displayName string) (string, error) {
	h := &DayTrackHandler{repo: mcpDayTrackRepo, userRepo: mcpUserRepo, ytHandler: nil}
	text, err := h.buildDayTrackReportText(ctx, userID, date, displayName)
	if errors.Is(err, errDayTrackNoEntries) {
		return "", nil
	}
	return text, err
}
