package handlers

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// dtCallText runs add_daytrack_entries with the given args and returns its text and error flag.
func dtCallText(t *testing.T, args map[string]any) (string, bool) {
	t.Helper()
	raw, _ := json.Marshal(args)
	resp := mcpAddDaytrackEntries(context.Background(), nil, "user-1", 1, raw)
	res, _ := resp.Result.(map[string]interface{})
	blocks, _ := res["content"].([]map[string]string)
	isErr, _ := res["isError"].(bool)
	if len(blocks) == 0 {
		t.Fatalf("no content in %v", resp)
	}
	return blocks[0]["text"], isErr
}

// Day Track is never written unless the user asked: these calls are refused before any
// database or Slack work happens.
func TestAddDaytrackEntriesNeedsUserRequest(t *testing.T) {
	task := []map[string]any{{"name": "Velocity: fixed the login redirect"}}
	for name, args := range map[string]map[string]any{
		"agent adds on its own":            {"entries": task},
		"user_requested false":             {"user_requested": false, "confirmed": true, "entries": task},
		"confirmed without user_requested": {"confirmed": true, "entries": task},
	} {
		text, isErr := dtCallText(t, args)
		if !isErr || !strings.HasPrefix(text, "Nothing was added") {
			t.Errorf("%s: want refusal, got isError=%v %q", name, isErr, text)
		}
	}
}

func TestDaytrackPreviewListsEntriesAndAsksToConfirm(t *testing.T) {
	got := mcpDTPreview("2026-11-11", []mcpDTTask{
		{mcpDTAddInput: mcpDTAddInput{Name: "Velocity: fixed the login redirect", Category: "Development", Status: "done"}},
		{mcpDTAddInput: mcpDTAddInput{Name: "Velocity: write the release notes", Status: "planned"}},
	})
	for _, want := range []string{
		"Nothing was added yet",
		"2 Day Track entries for 2026-11-11",
		"• Velocity: fixed the login redirect (Development)\n",
		"• Velocity: write the release notes [planned]\n",
		"confirmed: true",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("preview missing %q:\n%s", want, got)
		}
	}
}
