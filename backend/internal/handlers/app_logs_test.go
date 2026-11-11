package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAppLogsListRejectsBadInput(t *testing.T) {
	h := &AppLogsHandler{}
	for _, qs := range []string{
		"level=loud", "since=yesterday", "until=2024-13-01", "limit=0", "limit=abc", "before_id=-3", "before_id=x",
	} {
		w := httptest.NewRecorder()
		h.List(w, httptest.NewRequest("GET", "/api/admin/logs?"+qs, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d want 400 (%s)", qs, w.Code, w.Body.String())
		}
	}
}

func TestParseAppLogFilterAcceptsGoodInput(t *testing.T) {
	r := httptest.NewRequest("GET", "/x?level=WARN&q=boom&limit=50&before_id=9&since=2025-01-01T00:00:00Z", nil)
	f, bad := parseAppLogFilter(r)
	if bad != "" || f.MinLevel != "warn" || f.Limit != 50 || f.BeforeID != 9 || f.Since == nil || f.Q != "boom" {
		t.Fatalf("unexpected: %+v %q", f, bad)
	}
}
