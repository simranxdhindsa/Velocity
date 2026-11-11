package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
)

var addDaytrackEntriesToolSchema = map[string]interface{}{
	"name": "add_daytrack_entries",
	"description": "Adds work to the caller's own Day Track. RULE: one entry is one task on one line. When the user did several things, pass one item in `entries` per task, never one line joined with 'and'. " +
		"Multi-line, bulleted or semicolon-separated names are split into separate entries automatically, and a name over 160 characters is refused rather than cut off. " +
		"Write each name as '<Project>: <what changed>', for example 'Velocity: fixed the Chats AI buttons failing, caused by a removed Groq model'. " +
		"Leave out `category` unless the user named one: Velocity picks it from the task, and the result says which it chose in `category_source`. " +
		"Leave out times unless the user stated them: a single task runs from one minute after the last entry until now, several tasks in one call are stamped with the current time and no duration, and on a past date times stay blank. Never invent times or durations. " +
		"`status` done (default) goes to Today's Log. in_progress and planned go to Planned & Carry Over, because Today's Log only holds finished work. " +
		"A task already logged that day is skipped and listed under `skipped`, so retrying is safe. " +
		"NEVER call this on your own after finishing a task. Call it only when the user explicitly asked in this conversation to add work to Day Track, with user_requested: true. " +
		"That first call saves nothing and returns a preview: show it to the user and ask them to confirm. Only after they reply yes, call again with the same entries and confirmed: true. If they say no, add nothing.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"user_requested": map[string]interface{}{
				"type":        "boolean",
				"description": "Must be true, and only when the user explicitly asked in this conversation to add these to Day Track. Finishing a task is not a request.",
			},
			"confirmed": map[string]interface{}{
				"type":        "boolean",
				"description": "Set true only after you showed the user the preview from a call without it and they replied yes. Without it nothing is saved.",
			},
			"date": map[string]interface{}{
				"type":        "string",
				"description": "YYYY-MM-DD, 'today' or 'yesterday', in the user's Day Track timezone. Defaults to today. Finished work can't be logged on a future date.",
			},
			"entries": map[string]interface{}{
				"type":        "array",
				"description": "One item per task, at most 50.",
				"items": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"name": map[string]interface{}{
							"type":        "string",
							"description": "The task, one line, at most 160 characters.",
						},
						"category": map[string]interface{}{
							"type":        "string",
							"description": "Only if the user named one. Must already exist. An unknown category returns the list of real ones. Don't create one unless the user asks.",
						},
						"start_time": map[string]interface{}{
							"type":        "string",
							"description": "Only if the user stated it, e.g. '2:30 PM', '2pm', '14:30' or 'now'. For a planned task this is the scheduled time. Always include AM or PM unless using 24-hour time.",
						},
						"end_time": map[string]interface{}{
							"type":        "string",
							"description": "Only if the user stated it. Same forms as start_time. Not for in_progress or planned tasks.",
						},
						"duration_mins": map[string]interface{}{
							"type":        "integer",
							"description": "Only if the user stated how long it took. Not for in_progress or planned tasks.",
						},
						"notes": map[string]interface{}{
							"type":        "string",
							"description": "Optional one-line note, at most 160 characters. Shown after the name in the Slack report.",
						},
						"status": map[string]interface{}{
							"type":        "string",
							"enum":        []string{"done", "in_progress", "planned"},
							"description": "done (default), in_progress for work still going, planned for work not started.",
						},
						"when": map[string]interface{}{
							"type":        "string",
							"enum":        []string{"today", "tomorrow"},
							"description": "Planned tasks only. Defaults to today.",
						},
						"parent_entry_id": map[string]interface{}{
							"type":        "string",
							"description": "Adds this as a subtask of a Today's Log entry on the same date. Get the id from get_daytrack.",
						},
					},
					"required": []string{"name"},
				},
			},
			"allow_duplicates": map[string]interface{}{
				"type":        "boolean",
				"description": "Log a task even if the same name is already in Today's Log that day. Only when the user really did it twice. Default false.",
			},
		},
		"required": []string{"user_requested", "entries"},
	},
}

type mcpDTAddInput struct {
	Name          string `json:"name"`
	Category      string `json:"category"`
	StartTime     string `json:"start_time"`
	EndTime       string `json:"end_time"`
	DurationMins  *int   `json:"duration_mins"`
	Notes         string `json:"notes"`
	Status        string `json:"status"`
	When          string `json:"when"`
	ParentEntryID string `json:"parent_entry_id"`
}

// mcpDTTask is one input line with everything resolved, ready to save.
type mcpDTTask struct {
	mcpDTAddInput
	Parent         *database.DayTrackEntry
	CategorySource string
	Times          dayTrackTimes
}

// mcpDTPreview lists what a confirmed call would add, so the user can say yes or no first.
func mcpDTPreview(date string, tasks []mcpDTTask) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Nothing was added yet. Show the user these %d Day Track entries for %s and ask them to confirm:\n", len(tasks), date)
	for _, t := range tasks {
		line := "• " + t.Name
		if t.Category != "" {
			line += " (" + t.Category + ")"
		}
		if t.Status != "" && t.Status != "done" {
			line += " [" + t.Status + "]"
		}
		b.WriteString(line + "\n")
	}
	b.WriteString("Only after the user replies yes, call add_daytrack_entries again with the same entries, user_requested: true and confirmed: true. If they say no, add nothing.")
	return b.String()
}

type mcpDTSkipped struct {
	Name       string `json:"name"`
	Reason     string `json:"reason"`
	ExistingID string `json:"existing_id,omitempty"`
}

type mcpDTFailed struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// mcpDTExpandTasks applies the one-line rule: every input becomes one task per line. A split
// name can't share an end time or duration, since that would count the same time several times.
func mcpDTExpandTasks(inputs []mcpDTAddInput) ([]mcpDTAddInput, []string) {
	var tasks []mcpDTAddInput
	var problems []string
	for i, in := range inputs {
		lines := mcpDayTrackTaskLines(in.Name)
		if len(lines) == 0 {
			problems = append(problems, fmt.Sprintf("entry %d has no name", i+1))
			continue
		}
		if len(lines) > 1 && (in.DurationMins != nil || strings.TrimSpace(in.EndTime) != "") {
			problems = append(problems, fmt.Sprintf("%q holds %d tasks but one end time or duration. Pass each task as its own entry with its own time", in.Name, len(lines)))
			continue
		}
		note := mcpDayTrackOneLine(in.Notes)
		for j, line := range lines {
			task := in
			task.Name = line
			task.Notes = ""
			if j == 0 {
				task.Notes = note
			}
			tasks = append(tasks, task)
		}
	}
	return tasks, problems
}

// mcpDTPlanTask resolves one task's category, status and times, or says why it can't be saved.
func mcpDTPlanTask(ctx context.Context, userID, date string, in mcpDTAddInput, cats []string, clock dayTrackClockContext) (mcpDTTask, error) {
	task := mcpDTTask{mcpDTAddInput: in}
	if err := mcpDayTrackCheckLine("name", in.Name); err != nil {
		return task, err
	}
	if err := mcpDayTrackCheckLine("notes", in.Notes); err != nil {
		return task, err
	}
	status, err := mcpDayTrackStatus(in.Status)
	if err != nil {
		return task, err
	}
	task.Status = status
	if task.When, err = mcpDayTrackWhen(in.When); err != nil {
		return task, err
	}
	if status != "done" && (strings.TrimSpace(in.EndTime) != "" || in.DurationMins != nil) {
		return task, fmt.Errorf("%q is %s, so it has no end time or duration yet", in.Name, status)
	}
	if status != "planned" && date > clock.Today {
		return task, fmt.Errorf("%s is in the future. Only planned work can go on a future date", date)
	}

	if id := strings.TrimSpace(in.ParentEntryID); id != "" {
		if status != "done" {
			return task, fmt.Errorf("%q is a subtask, so it can only be logged as done", in.Name)
		}
		if !mcpDayTrackIDRe.MatchString(id) {
			return task, fmt.Errorf("parent_entry_id %q is not an id. Get it from get_daytrack", id)
		}
		parent, err := mcpDayTrackRepo.FindEntry(ctx, id, userID)
		if err != nil {
			return task, fmt.Errorf("failed to read the parent entry: %w", err)
		}
		if parent == nil {
			return task, fmt.Errorf("no entry with id %s in your Day Track", id)
		}
		if parent.ParentEntryID != nil {
			return task, fmt.Errorf("%q is already a subtask, and subtasks can't have subtasks", parent.Name)
		}
		if parent.EntryDate != date {
			return task, fmt.Errorf("the parent entry is on %s, so pass that as the date", parent.EntryDate)
		}
		task.Parent = parent
		clock.Batch = true
	}

	if strings.TrimSpace(in.Category) != "" {
		match, ok := mcpMatchDayTrackCategory(in.Category, cats)
		if !ok {
			return task, fmt.Errorf("category %q doesn't exist. Use one of: %s. Leave it out to let Velocity pick", in.Category, strings.Join(cats, ", "))
		}
		task.Category, task.CategorySource = match, "given"
	} else if task.Parent != nil {
		task.Category, task.CategorySource = task.Parent.Category, "parent"
	} else {
		task.Category, task.CategorySource = mcpDetectDayTrackCategory(in.Name, cats)
	}
	if status != "done" && dayTrackNoInProgressCategories[strings.ToLower(task.Category)] {
		if task.CategorySource == "given" {
			return task, fmt.Errorf("%s entries are instant events, so they can't be %s", task.Category, status)
		}
		task.Category, task.CategorySource = cats[0], "default"
	}

	if status == "done" {
		task.Times, err = mcpResolveDayTrackTimes(dayTrackClockInput{Start: in.StartTime, End: in.EndTime, DurationMins: in.DurationMins}, clock)
		if err != nil {
			return task, fmt.Errorf("%q: %w", in.Name, err)
		}
		if p := task.Parent; p != nil && task.Times.Source == "given" && p.StartTime != "" && task.Times.Start != "" &&
			timeToMins(task.Times.Start) < timeToMins(p.StartTime) {
			return task, fmt.Errorf("%q starts before its parent, which starts at %s", in.Name, p.StartTime)
		}
		return task, nil
	}

	// Planned & Carry Over keeps a start or scheduled time only, the same as the page.
	task.Times = dayTrackTimes{Source: "blank"}
	if strings.TrimSpace(in.StartTime) != "" {
		m, err := mcpParseDayTrackClock(in.StartTime, clock.NowMins, clock.IsToday)
		if err != nil {
			return task, fmt.Errorf("%q start_time: %w", in.Name, err)
		}
		task.Times = dayTrackTimes{Start: mcpMinsTo12h(m), Source: "given"}
	} else if status == "in_progress" && clock.IsToday {
		task.Times = dayTrackTimes{Start: mcpMinsTo12h(clock.NowMins), Source: "logged_at"}
	}
	return task, nil
}

// mcpDTSaveTask writes one resolved task and returns it as reported to the caller.
func mcpDTSaveTask(ctx context.Context, userID, date string, t mcpDTTask, icons map[string]string) (mcpDTItem, error) {
	var item mcpDTItem
	if t.Status == "done" {
		var parentID *string
		if t.Parent != nil {
			parentID = &t.Parent.ID
		}
		entry, err := mcpDayTrackRepo.CreateEntry(ctx, userID, date, t.Name, t.Category,
			t.Times.Start, t.Times.End, t.Times.DurationMins, t.Notes, "done", parentID)
		if err != nil {
			return item, err
		}
		item = mcpDTItemFromEntry(entry, icons)
	} else {
		// A planned task only has a scheduled time. It starts when work starts.
		start := t.Times.Start
		if t.Status == "planned" {
			start = ""
		}
		planned, err := mcpDayTrackRepo.CreatePlanned(ctx, userID, date, t.Name, t.Category,
			t.Times.Start, start, "", t.When, t.Notes, t.Status, "", "", nil)
		if err != nil {
			return item, err
		}
		item = mcpDTItemFromPlanned(planned, icons)
	}
	item.CategorySource, item.TimeSource = t.CategorySource, t.Times.Source
	return item, nil
}

// mcpDTExtendParent mirrors the page: a subtask that ends after its parent stretches the parent.
func mcpDTExtendParent(ctx context.Context, userID string, t mcpDTTask) {
	p := t.Parent
	if p == nil || t.Times.End == "" {
		return
	}
	current, err := mcpDayTrackRepo.FindEntry(ctx, p.ID, userID)
	if err != nil || current == nil {
		return
	}
	if current.EndTime != "" && timeToMins(t.Times.End) <= timeToMins(current.EndTime) {
		return
	}
	dur := current.DurationMins
	if s := timeToMins(current.StartTime); s >= 0 {
		if span := timeToMins(t.Times.End) - s; span > 0 {
			dur = &span
		}
	}
	if _, err := mcpDayTrackRepo.UpdateEntry(ctx, current.ID, userID, current.Name, current.Category,
		current.StartTime, t.Times.End, dur, current.Notes, current.Status); err != nil {
		log.Printf("[MCP DayTrack] failed to extend parent entry: %v", err)
	}
}

func mcpAddDaytrackEntries(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Date            string          `json:"date"`
		Entries         []mcpDTAddInput `json:"entries"`
		AllowDuplicates bool            `json:"allow_duplicates"`
		UserRequested   bool            `json:"user_requested"`
		Confirmed       bool            `json:"confirmed"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return toolError(id, mcpDTArgsError(err))
	}
	// Day Track is only written when the user asked for it, never automatically.
	if !a.UserRequested {
		return toolError(id, "Nothing was added. Day Track is only written when the user asks for it. Ask the user if they want this logged, and call again with user_requested: true only if they say yes")
	}
	if len(a.Entries) == 0 {
		return toolError(id, "entries is empty. Pass one item per task")
	}

	now := mcpDayTrackClockFor(ctx, userID)
	dateArg := a.Date
	if strings.TrimSpace(dateArg) == "" {
		dateArg = "today"
	}
	day, err := mcpParseDayTrackDate(dateArg, now.Loc)
	if err != nil {
		return toolError(id, err.Error())
	}
	date := day.Format("2006-01-02")

	tasks, problems := mcpDTExpandTasks(a.Entries)
	if len(tasks) > mcpDayTrackMaxBatch {
		return toolError(id, fmt.Sprintf("%d tasks in one call, the limit is %d. Split it into smaller calls", len(tasks), mcpDayTrackMaxBatch))
	}
	cats, err := mcpDayTrackCategories(ctx, userID)
	if err != nil {
		return toolError(id, "failed to read your categories: "+err.Error())
	}

	// One add at a time per user and day, so a retry that overlaps the first call can't slip
	// past the duplicate check below.
	defer lockDayTrackPost("add:"+userID, date)()

	entries, err := mcpDayTrackRepo.GetEntries(ctx, userID, date)
	if err != nil {
		return toolError(id, "failed to read your Day Track: "+err.Error())
	}
	planned, err := mcpDayTrackRepo.GetPlanned(ctx, userID, date)
	if err != nil {
		return toolError(id, "failed to read your Day Track: "+err.Error())
	}

	clock := dayTrackClockContext{
		IsToday: date == now.Today, Today: now.Today, NowMins: now.NowMins,
		LatestEndMins: mcpDayTrackLatestEnd(entries), Batch: len(tasks) > 1,
	}

	// Check everything before writing anything: a bad line never leaves half a list saved.
	resolved := make([]mcpDTTask, 0, len(tasks))
	for _, in := range tasks {
		task, err := mcpDTPlanTask(ctx, userID, date, in, cats, clock)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		resolved = append(resolved, task)
	}
	if len(problems) > 0 {
		return toolError(id, "Nothing was saved. "+strings.Join(problems, ". "))
	}
	// Second check: the user confirms the exact list before anything is written.
	if !a.Confirmed {
		return toolOK(id, mcpDTPreview(date, resolved))
	}

	logged := map[string]string{}
	for _, e := range entries {
		parent := ""
		if e.ParentEntryID != nil {
			parent = *e.ParentEntryID
		}
		logged[parent+"|"+strings.ToLower(e.Name)] = e.ID
	}
	open := map[string]string{}
	for _, p := range planned {
		open[strings.ToLower(p.Name)] = p.ID
	}

	icons := mcpDayTrackIcons(ctx, userID)
	created := []mcpDTItem{}
	skipped := []mcpDTSkipped{}
	failed := []mcpDTFailed{}
	var warnings []string
	for _, t := range resolved {
		key := strings.ToLower(t.Name)
		parentID := ""
		if t.Parent != nil {
			parentID = t.Parent.ID
		}
		// Today's Log and Planned & Carry Over never hold the same work at once.
		if existing, ok := open[key]; ok && t.Parent == nil {
			skipped = append(skipped, mcpDTSkipped{t.Name, "already in Planned & Carry Over. To finish it, call update_daytrack_entry with status done", existing})
			continue
		}
		if existing, ok := logged[parentID+"|"+key]; ok && (!a.AllowDuplicates || t.Status != "done") {
			skipped = append(skipped, mcpDTSkipped{t.Name, "already in Today's Log for " + date, existing})
			continue
		}
		item, err := mcpDTSaveTask(ctx, userID, date, t, icons)
		if err != nil {
			failed = append(failed, mcpDTFailed{t.Name, err.Error()})
			continue
		}
		created = append(created, item)
		warnings = append(warnings, t.Times.Warnings...)
		if t.Status == "done" {
			logged[parentID+"|"+key] = item.ID
			mcpDTExtendParent(ctx, userID, t)
		} else {
			open[key] = item.ID
		}
	}

	details := map[string]interface{}{"date": date, "created": created, "skipped": skipped, "failed": failed}
	if len(created) > 0 {
		if note := mcpDayTrackPostNote(ctx, userID, date); note != "" {
			warnings = append(warnings, note)
		}
	}
	if len(warnings) > 0 {
		details["warnings"] = warnings
	}
	return mcpDTAddOutcome(id, date, len(created), len(skipped), len(failed), details)
}

// mcpDTAddOutcome answers an add call. Any failed task makes the whole call an error, even if
// others saved: a save that stops partway must never read as success. Saved tasks are named in
// the details and a retry skips them, so retrying only adds what is missing.
func mcpDTAddOutcome(id interface{}, date string, created, skipped, failed int, details map[string]interface{}) rpcResponse {
	if failed > 0 {
		data, _ := json.Marshal(details)
		return toolError(id, fmt.Sprintf("Only %d of %d tasks were saved for %s, %d failed. Retrying is safe, saved tasks are skipped. %s",
			created, created+failed, date, failed, data))
	}
	noun := "entries"
	if created == 1 {
		noun = "entry"
	}
	s := fmt.Sprintf("Added %d Day Track %s for %s.", created, noun, date)
	if skipped > 0 {
		s += fmt.Sprintf(" Skipped %d already logged.", skipped)
	}
	return mcpDTResult(id, s, details)
}
