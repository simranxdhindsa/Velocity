package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

var deleteDaytrackEntryToolSchema = map[string]interface{}{
	"name": "delete_daytrack_entry",
	"description": "Permanently removes items from the caller's own Day Track, from Today's Log or Planned & Carry Over. Get ids from get_daytrack. " +
		"Unless the user named exactly what to delete, show them the items and confirm first. Deleting an entry also deletes its subtasks. " +
		"The result lists everything removed, so it can be added back with add_daytrack_entries if needed. It does not edit a report already in Slack: the result says when one exists, then offer send_daytrack.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"entry_ids": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Ids from get_daytrack, at most 50.",
			},
		},
		"required": []string{"entry_ids"},
	},
}

func mcpDeleteDaytrackEntry(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		EntryIDs []string `json:"entry_ids"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return toolError(id, mcpDTArgsError(err))
	}
	if len(a.EntryIDs) == 0 {
		return toolError(id, "entry_ids is empty. Get ids from get_daytrack")
	}
	if len(a.EntryIDs) > mcpDayTrackMaxBatch {
		return toolError(id, fmt.Sprintf("%d ids in one call, the limit is %d", len(a.EntryIDs), mcpDayTrackMaxBatch))
	}

	icons := mcpDayTrackIcons(ctx, userID)
	deleted := []mcpDTItem{}
	notFound := []string{}
	failed := []mcpDTFailed{}
	dates := map[string]bool{}
	var warnings []string
	seen := map[string]bool{} // also holds subtasks already removed with their parent

	for _, raw := range a.EntryIDs {
		entryID := strings.ToLower(strings.TrimSpace(raw))
		if seen[entryID] {
			continue
		}
		seen[entryID] = true
		if !mcpDayTrackIDRe.MatchString(entryID) {
			notFound = append(notFound, raw)
			continue
		}
		entry, err := mcpDayTrackRepo.FindEntry(ctx, entryID, userID)
		if err != nil {
			failed = append(failed, mcpDTFailed{raw, err.Error()})
			continue
		}
		if entry != nil {
			subs, err := mcpDayTrackRepo.GetSubtasks(ctx, entry.ID, userID)
			if err != nil {
				failed = append(failed, mcpDTFailed{entry.Name, err.Error()})
				continue
			}
			if err := mcpDayTrackRepo.DeleteEntry(ctx, entry.ID, userID); err != nil {
				failed = append(failed, mcpDTFailed{entry.Name, err.Error()})
				continue
			}
			deleted = append(deleted, mcpDTItemFromEntry(entry, icons))
			for i := range subs {
				deleted = append(deleted, mcpDTItemFromEntry(&subs[i], icons))
				seen[strings.ToLower(subs[i].ID)] = true
			}
			dates[entry.EntryDate] = true
			// YouTrack rows are rebuilt from ticket activity, so one can return on the next sync.
			if entry.EntrySource == "youtrack" {
				warnings = append(warnings, fmt.Sprintf("%q came from YouTrack, so it can come back on the next sync.", entry.Name))
			}
			continue
		}
		item, err := mcpDayTrackRepo.FindPlanned(ctx, entryID, userID)
		if err != nil {
			failed = append(failed, mcpDTFailed{raw, err.Error()})
			continue
		}
		if item == nil {
			notFound = append(notFound, raw)
			continue
		}
		if err := mcpDayTrackRepo.DeletePlanned(ctx, item.ID, userID); err != nil {
			failed = append(failed, mcpDTFailed{item.Name, err.Error()})
			continue
		}
		deleted = append(deleted, mcpDTItemFromPlanned(item, icons))
		dates[item.EntryDate] = true
		if item.EntrySource == "youtrack" {
			warnings = append(warnings, fmt.Sprintf("%q came from YouTrack, so it comes back on the next sync while the ticket stays in progress.", item.Name))
		}
	}

	for date := range dates {
		if note := mcpDayTrackPostNote(ctx, userID, date); note != "" {
			warnings = append(warnings, note)
		}
	}
	details := map[string]interface{}{"deleted": deleted, "not_found": notFound, "failed": failed}
	if len(warnings) > 0 {
		details["warnings"] = warnings
	}
	if len(failed) > 0 {
		data, _ := json.Marshal(details)
		return toolError(id, fmt.Sprintf("Only %d were deleted, %d failed. %s", len(deleted), len(failed), data))
	}
	if len(deleted) == 0 {
		return toolError(id, "Nothing was deleted. None of those ids are in your Day Track. Ids change when an item moves between lists, so read them again with get_daytrack")
	}
	return mcpDTResult(id, mcpDTDeleteSentence(deleted), details)
}

// mcpDTDeleteSentence names what went, since this line is all the Claude actions log keeps.
func mcpDTDeleteSentence(deleted []mcpDTItem) string {
	if len(deleted) == 1 {
		return fmt.Sprintf("Deleted %q from Day Track.", deleted[0].Name)
	}
	var names []string
	for i := 0; i < len(deleted) && i < 3; i++ {
		names = append(names, fmt.Sprintf("%q", deleted[i].Name))
	}
	s := fmt.Sprintf("Deleted %d Day Track items: %s", len(deleted), strings.Join(names, ", "))
	if extra := len(deleted) - len(names); extra > 0 {
		s += fmt.Sprintf(" and %d more", extra)
	}
	return s + "."
}
