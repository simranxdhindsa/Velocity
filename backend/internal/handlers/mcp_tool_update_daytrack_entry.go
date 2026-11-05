package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
)

var updateDaytrackEntryToolSchema = map[string]interface{}{
	"name": "update_daytrack_entry",
	"description": "Changes one item in the caller's own Day Track, in Today's Log or Planned & Carry Over. Get `entry_id` from get_daytrack. Only the fields you pass change. " +
		"`status` moves it the way the Day Track page does: an in_progress or planned item set to done moves into Today's Log (the result has a NEW id), and a done entry set to in_progress or planned moves to Planned & Carry Over with its subtasks. " +
		"Finishing an in-progress Development item that came from YouTrack also moves that ticket to the Dev column, same as the page. " +
		"A name must stay one line of at most 160 characters. For a second task, use add_daytrack_entries instead of widening this one. " +
		"If that day's report is already in Slack, the result says so. Tell the user and offer send_daytrack.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"entry_id": map[string]interface{}{"type": "string", "description": "The item's id from get_daytrack."},
			"name":     map[string]interface{}{"type": "string", "description": "New name, one line."},
			"category": map[string]interface{}{"type": "string", "description": "New category. Must already exist."},
			"start_time": map[string]interface{}{
				"type":        "string",
				"description": "New start, e.g. '2:30 PM' or 'now'. For a planned item this is the scheduled time. Empty string clears it.",
			},
			"end_time": map[string]interface{}{
				"type":        "string",
				"description": "New end, same forms. Empty string clears it. Today's Log only, unless status is done.",
			},
			"duration_mins": map[string]interface{}{
				"type":        "integer",
				"description": "New duration. 0 clears it. Without this, changing a time recalculates the duration from the two times.",
			},
			"notes":  map[string]interface{}{"type": "string", "description": "New one-line note. Empty string clears it."},
			"status": map[string]interface{}{"type": "string", "enum": []string{"done", "in_progress", "planned"}, "description": "New status, see above."},
			"when":   map[string]interface{}{"type": "string", "enum": []string{"today", "tomorrow"}, "description": "Planned & Carry Over only."},
		},
		"required": []string{"entry_id"},
	},
}

type mcpDTPatch struct {
	EntryID      string  `json:"entry_id"`
	Name         *string `json:"name"`
	Category     *string `json:"category"`
	StartTime    *string `json:"start_time"`
	EndTime      *string `json:"end_time"`
	DurationMins *int    `json:"duration_mins"`
	Notes        *string `json:"notes"`
	Status       *string `json:"status"`
	When         *string `json:"when"`
}

func (p mcpDTPatch) empty() bool {
	return p.Name == nil && p.Category == nil && p.StartTime == nil && p.EndTime == nil &&
		p.DurationMins == nil && p.Notes == nil && p.Status == nil && p.When == nil
}

// mcpDTPatchText applies the name, category and notes parts of a patch to current values.
func mcpDTPatchText(p mcpDTPatch, cats []string, name, category, notes string) (string, string, string, error) {
	if p.Name != nil {
		lines := mcpDayTrackTaskLines(*p.Name)
		switch {
		case len(lines) == 0:
			return "", "", "", errors.New("name can't be empty")
		case len(lines) > 1:
			return "", "", "", fmt.Errorf("that name holds %d tasks, and an entry is one task on one line. Keep one here and add the others with add_daytrack_entries", len(lines))
		}
		if err := mcpDayTrackCheckLine("name", lines[0]); err != nil {
			return "", "", "", err
		}
		name = lines[0]
	}
	if p.Category != nil {
		match, ok := mcpMatchDayTrackCategory(*p.Category, cats)
		if !ok {
			return "", "", "", fmt.Errorf("category %q doesn't exist. Use one of: %s", *p.Category, strings.Join(cats, ", "))
		}
		category = match
	}
	if p.Notes != nil {
		notes = mcpDayTrackOneLine(*p.Notes)
		if err := mcpDayTrackCheckLine("notes", notes); err != nil {
			return "", "", "", err
		}
	}
	return name, category, notes, nil
}

// mcpDTPatchClock reads one optional time argument: nil keeps current, empty clears it.
func mcpDTPatchClock(field string, value *string, current string, clock mcpDayTrackClock, isToday bool) (string, error) {
	if value == nil {
		return current, nil
	}
	if strings.TrimSpace(*value) == "" {
		return "", nil
	}
	m, err := mcpParseDayTrackClock(*value, clock.NowMins, isToday)
	if err != nil {
		return "", fmt.Errorf("%s: %w", field, err)
	}
	return mcpMinsTo12h(m), nil
}

// mcpDTPatchEntryTimes merges a patch into an entry's times. A changed time recalculates the
// duration unless the caller set one, the same as saving the page's edit form.
func mcpDTPatchEntryTimes(p mcpDTPatch, e *database.DayTrackEntry, clock mcpDayTrackClock) (string, string, *int, error) {
	isToday := e.EntryDate == clock.Today
	start, err := mcpDTPatchClock("start_time", p.StartTime, e.StartTime, clock, isToday)
	if err != nil {
		return "", "", nil, err
	}
	end, err := mcpDTPatchClock("end_time", p.EndTime, e.EndTime, clock, isToday)
	if err != nil {
		return "", "", nil, err
	}
	dur := e.DurationMins
	if p.StartTime != nil || p.EndTime != nil {
		dur = nil
		if s, en := timeToMins(start), timeToMins(end); s >= 0 && en >= 0 {
			span := en - s
			if span < 0 {
				span += mcpMinsPerDay
				if span > mcpDayTrackOvernightMaxMins {
					return "", "", nil, fmt.Errorf("end_time %s is before start_time %s", end, start)
				}
			}
			if span > 0 {
				dur = &span
			}
		}
	}
	if p.DurationMins != nil {
		switch d := *p.DurationMins; {
		case d == 0:
			dur = nil
		case d < 0 || d > mcpMinsPerDay:
			return "", "", nil, fmt.Errorf("duration_mins must be between 0 and %d", mcpMinsPerDay)
		default:
			dur = &d
		}
	}
	return start, end, dur, nil
}

// mcpDTMoveTicketToDev moves a finished ticket to the workflow's dev_done column, the same
// thing the page does. If it stayed In Progress the next YouTrack sync would put the item
// straight back into Planned & Carry Over.
func mcpDTMoveTicketToDev(ctx context.Context, userID, issueID string) (string, error) {
	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return "", errors.New("YouTrack is not configured")
	}
	state := "Dev"
	if cfg, err := database.NewWorkflowConfigRepository().GetEffective(ctx, userID, "youtrack"); err == nil && cfg != nil {
		for _, col := range cfg.ColumnHierarchy {
			if col.Role == "dev_done" && col.State != "" {
				state = col.State
				break
			}
		}
	}
	return state, yt.UpdateIssueState(ctx, issueID, state)
}

// mcpDTUpdateEntry changes an entry in Today's Log, or moves it to Planned & Carry Over.
func mcpDTUpdateEntry(ctx context.Context, id interface{}, userID string, p mcpDTPatch, e *database.DayTrackEntry, cats []string) rpcResponse {
	clock := mcpDayTrackClockFor(ctx, userID)
	icons := mcpDayTrackIcons(ctx, userID)
	name, category, notes, err := mcpDTPatchText(p, cats, e.Name, e.Category, e.Notes)
	if err != nil {
		return toolError(id, err.Error())
	}
	start, end, dur, err := mcpDTPatchEntryTimes(p, e, clock)
	if err != nil {
		return toolError(id, err.Error())
	}
	status := e.Status
	if p.Status != nil {
		if status, err = mcpDayTrackStatus(*p.Status); err != nil {
			return toolError(id, err.Error())
		}
	}

	if status == "in_progress" || status == "planned" {
		if e.ParentEntryID != nil {
			return toolError(id, "this is a subtask, so only its parent can move to Planned & Carry Over")
		}
		if dayTrackNoInProgressCategories[strings.ToLower(category)] {
			return toolError(id, category+" entries are instant events, so they can't be "+status)
		}
		when, err := mcpDayTrackWhen(deref(p.When))
		if err != nil {
			return toolError(id, err.Error())
		}
		subs, err := mcpDayTrackRepo.GetSubtasks(ctx, e.ID, userID)
		if err != nil {
			return toolError(id, "failed to read subtasks: "+err.Error())
		}
		moved, err := mcpDayTrackRepo.CarryEntry(ctx, e, subs, database.DayTrackPlanned{
			EntryDate: e.EntryDate, Name: name, Category: category, ScheduledTime: start, StartTime: start,
			WhenType: when, Notes: notes, Status: status,
		})
		if err != nil {
			return toolError(id, "failed to move the entry: "+err.Error())
		}
		details := map[string]interface{}{"item": mcpDTItemFromPlanned(moved, icons), "previous_id": e.ID, "subtasks_moved": len(subs)}
		mcpDTAddPostNote(ctx, userID, e.EntryDate, details)
		return mcpDTResult(id, fmt.Sprintf("Moved %q to Planned & Carry Over as %s.", name, status), details)
	}

	if p.When != nil {
		return toolError(id, "when only applies to Planned & Carry Over items")
	}
	updated, err := mcpDayTrackRepo.UpdateEntry(ctx, e.ID, userID, name, category, start, end, dur, notes, status)
	if err != nil {
		return toolError(id, "failed to update the entry: "+err.Error())
	}
	details := map[string]interface{}{"item": mcpDTItemFromEntry(updated, icons)}
	mcpDTAddPostNote(ctx, userID, e.EntryDate, details)
	return mcpDTResult(id, fmt.Sprintf("Updated %q.", name), details)
}

// mcpDTUpdatePlanned changes a Planned & Carry Over item, or finishes it into Today's Log.
func mcpDTUpdatePlanned(ctx context.Context, id interface{}, userID string, p mcpDTPatch, item *database.DayTrackPlanned, cats []string) rpcResponse {
	clock := mcpDayTrackClockFor(ctx, userID)
	icons := mcpDayTrackIcons(ctx, userID)
	name, category, notes, err := mcpDTPatchText(p, cats, item.Name, item.Category, item.Notes)
	if err != nil {
		return toolError(id, err.Error())
	}
	status := item.Status
	if p.Status != nil {
		if status, err = mcpDayTrackStatus(*p.Status); err != nil {
			return toolError(id, err.Error())
		}
	}

	if status == "done" {
		if p.When != nil {
			return toolError(id, "when only applies to Planned & Carry Over items, and done moves this one to Today's Log")
		}
		// Finished work lands on today. A start time from an earlier day can't be subtracted
		// from now, so it only carries across when the item is from today.
		startIn := deref(p.StartTime)
		if p.StartTime == nil && item.EntryDate == clock.Today {
			startIn = item.StartTime
			if startIn == "" {
				startIn = item.ScheduledTime
			}
		}
		times, err := mcpResolveDayTrackTimes(dayTrackClockInput{Start: startIn, End: deref(p.EndTime), DurationMins: p.DurationMins},
			dayTrackClockContext{IsToday: true, Today: clock.Today, NowMins: clock.NowMins, LatestEndMins: -1, Batch: true})
		if err != nil {
			return toolError(id, err.Error())
		}
		entry, err := mcpDayTrackRepo.CompletePlanned(ctx, item, database.DayTrackEntry{
			EntryDate: clock.Today, Name: name, Category: category, StartTime: times.Start, EndTime: times.End,
			DurationMins: times.DurationMins, Notes: notes,
		})
		if err != nil {
			return toolError(id, "failed to finish the item: "+err.Error())
		}
		details := map[string]interface{}{"item": mcpDTItemFromEntry(entry, icons), "previous_id": item.ID}
		sentence := fmt.Sprintf("Marked %q done in Today's Log.", name)
		warnings := times.Warnings
		if item.EntrySource == "youtrack" && item.Category == "Development" && item.YoutrackIssueID != nil && *item.YoutrackIssueID != "" {
			if state, err := mcpDTMoveTicketToDev(ctx, userID, *item.YoutrackIssueID); err != nil {
				warnings = append(warnings, fmt.Sprintf("%s could not be moved in YouTrack: %v. It may come back as in progress on the next sync.", *item.YoutrackIssueID, err))
			} else {
				sentence += fmt.Sprintf(" Moved %s to %s in YouTrack.", *item.YoutrackIssueID, state)
			}
		}
		if len(warnings) > 0 {
			details["warnings"] = warnings
		}
		mcpDTAddPostNote(ctx, userID, clock.Today, details)
		return mcpDTResult(id, sentence, details)
	}

	if p.EndTime != nil || p.DurationMins != nil {
		return toolError(id, "this item isn't finished, so it has no end time or duration yet. Pass status done with them to finish it")
	}
	if dayTrackNoInProgressCategories[strings.ToLower(category)] {
		return toolError(id, category+" entries are instant events, so they can't be "+status)
	}
	isToday := item.EntryDate == clock.Today
	scheduled, err := mcpDTPatchClock("start_time", p.StartTime, item.ScheduledTime, clock, isToday)
	if err != nil {
		return toolError(id, err.Error())
	}
	start := item.StartTime
	if p.StartTime != nil {
		start = scheduled
	}
	if status == "planned" {
		start = ""
	} else if start == "" {
		start = scheduled
		if start == "" && isToday {
			start = mcpMinsTo12h(clock.NowMins)
		}
	}
	when := item.WhenType
	if p.When != nil {
		if when, err = mcpDayTrackWhen(*p.When); err != nil {
			return toolError(id, err.Error())
		}
	}
	updated, err := mcpDayTrackRepo.UpdatePlanned(ctx, item.ID, userID, name, category, scheduled, start, item.EndTime, when, notes, status)
	if err != nil {
		return toolError(id, "failed to update the item: "+err.Error())
	}
	details := map[string]interface{}{"item": mcpDTItemFromPlanned(updated, icons)}
	if status == "in_progress" {
		mcpDTAddPostNote(ctx, userID, clock.Today, details)
	}
	return mcpDTResult(id, fmt.Sprintf("Updated %q.", name), details)
}

func mcpDTAddPostNote(ctx context.Context, userID, date string, details map[string]interface{}) {
	note := mcpDayTrackPostNote(ctx, userID, date)
	if note == "" {
		return
	}
	warnings, _ := details["warnings"].([]string)
	details["warnings"] = append(warnings, note)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func mcpUpdateDaytrackEntry(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var p mcpDTPatch
	if err := json.Unmarshal(args, &p); err != nil {
		return toolError(id, mcpDTArgsError(err))
	}
	p.EntryID = strings.TrimSpace(p.EntryID)
	if !mcpDayTrackIDRe.MatchString(p.EntryID) {
		return toolError(id, "entry_id is required. Get it from get_daytrack")
	}
	if p.empty() {
		return toolError(id, "nothing to change. Pass at least one field")
	}
	cats, err := mcpDayTrackCategories(ctx, userID)
	if err != nil {
		return toolError(id, "failed to read your categories: "+err.Error())
	}
	entry, err := mcpDayTrackRepo.FindEntry(ctx, p.EntryID, userID)
	if err != nil {
		return toolError(id, "failed to read your Day Track: "+err.Error())
	}
	if entry != nil {
		return mcpDTUpdateEntry(ctx, id, userID, p, entry, cats)
	}
	item, err := mcpDayTrackRepo.FindPlanned(ctx, p.EntryID, userID)
	if err != nil {
		return toolError(id, "failed to read your Day Track: "+err.Error())
	}
	if item != nil {
		return mcpDTUpdatePlanned(ctx, id, userID, p, item, cats)
	}
	return toolError(id, "no item with id "+p.EntryID+" in your Day Track. Ids change when an item moves between lists, so read it again with get_daytrack")
}
