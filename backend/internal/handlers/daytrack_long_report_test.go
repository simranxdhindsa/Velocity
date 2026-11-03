package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// A 260-entry Day Track report went to Slack as one message cut off at 3,800 characters
// with a "message truncated" note. This runs the real report formatter into the real
// Slack client path against a fake Slack and checks every entry now arrives.
func TestDayTrackLongReportReachesSlackInFull(t *testing.T) {
	var mu sync.Mutex
	var texts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		defer mu.Unlock()
		texts = append(texts, body["text"].(string))
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "ts": fmt.Sprintf("1700000000.%06d", len(texts))})
	}))
	defer srv.Close()
	old := slacksvc.BaseURL
	slacksvc.BaseURL = srv.URL
	defer func() { slacksvc.BaseURL = old }()

	var items []string
	for i := 1; i <= 260; i++ {
		items = append(items, fmt.Sprintf("Worked on ticket APY-%d: reviewed the change and verified it on dev", i))
	}
	text := "*Simran*\nMon, Nov 2\n\n" + standupFormatMrkdwn([]PersonUpdate{{
		IsOwner:  true,
		Sections: []UpdateSection{{Label: "Development", Items: items}},
	}})

	tss, err := slacksvc.NewClient("xoxb-test").SyncParts(context.Background(), "C123", nil, text, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tss) < 2 {
		t.Fatalf("a %d-char report must span several messages, got %d", len(text), len(tss))
	}
	joined := strings.Join(texts, "\n")
	if strings.Contains(joined, "truncated") {
		t.Error("no message may carry the truncation note")
	}
	for i := 1; i <= 260; i++ {
		if !strings.Contains(joined, fmt.Sprintf("APY-%d:", i)) {
			t.Fatalf("entry APY-%d never reached Slack", i)
		}
	}
}

// Pressing "Post to Slack" twice at once (double-click, or the button overlapping the
// 11:50 PM auto-send) must run one send at a time per user and date.
func TestLockDayTrackPostSerialisesSameUserAndDate(t *testing.T) {
	var running, peak int
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer lockDayTrackPost("u1", "2026-11-02")()
			mu.Lock()
			running++
			if running > peak {
				peak = running
			}
			mu.Unlock()
			mu.Lock()
			running--
			mu.Unlock()
		}()
	}
	wg.Wait()
	if peak != 1 {
		t.Errorf("sends for the same user+date overlapped (peak %d)", peak)
	}

	// A different date is independent: holding one must not block the other.
	release := lockDayTrackPost("u1", "2026-11-03")
	done := make(chan struct{})
	go func() { defer close(done); defer lockDayTrackPost("u1", "2026-11-04")() }()
	<-done
	release()
}
