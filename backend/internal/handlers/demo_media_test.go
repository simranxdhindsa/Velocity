package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dhindsa/project-management/internal/middleware"
)

func TestDemoMediaServesGuideImagesOnlyWhenLoggedIn(t *testing.T) {
	protected := middleware.AuthMiddleware(DemoMedia())

	// No login token: refused, so the board screenshots are never public.
	rec := httptest.NewRecorder()
	protected.ServeHTTP(rec, httptest.NewRequest("GET", "/api/demo-media/epic-swimlanes/demo.gif", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("without a token got %d, want 401", rec.Code)
	}

	// The handler itself serves the embedded files.
	for path, want := range map[string]int{
		"/api/demo-media/epic-swimlanes/demo.gif":    http.StatusOK,
		"/api/demo-media/epic-swimlanes/result.jpg":  http.StatusOK,
		"/api/demo-media/epic-swimlanes/missing.gif": http.StatusNotFound,
	} {
		rec := httptest.NewRecorder()
		DemoMedia().ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Errorf("%s: got %d, want %d", path, rec.Code, want)
		}
		if want == http.StatusOK && rec.Header().Get("Cache-Control") != "private, max-age=3600" {
			t.Errorf("%s: Cache-Control %q", path, rec.Header().Get("Cache-Control"))
		}
	}
}
