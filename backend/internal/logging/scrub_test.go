package logging

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestScrubPatterns(t *testing.T) {
	cases := map[string]string{
		`Post "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12": dial tcp`: "AIzaSy",
		`GET https://oauth2.googleapis.com/tokeninfo?id_token=abc.def.ghi&x=1`:                                                                "abc.def.ghi",
		`postgres://velocity:SuperSecretPw@db.example.com:5432/dev`:                                                                           "SuperSecretPw",
		`Authorization: Bearer abcdefghijklmnop1234`:                                                                                          "abcdefghijklmnop1234",
		`posting to https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX failed`:                                                       "XXXXXXXXXXXXXXXX",
		`slack token xoxb-1234567890-abcdefghij rejected`:                                                                                     "xoxb-1234567890",
		`groq key gsk_ABCDEFGHIJKLMNOPQRSTUVWX invalid`:                                                                                       "gsk_ABCDEFGHIJ",
		`jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`:                                    "eyJhbGciOiJIUzI1NiJ9",
	}
	for in, secret := range cases {
		out := Scrub(in)
		if strings.Contains(out, secret) {
			t.Errorf("secret %q survived: %q", secret, out)
		}
		if !strings.Contains(out, "[redacted]") {
			t.Errorf("no redaction marker: %q", out)
		}
	}
	for _, keep := range []string{"GET /api/issues/ABC-123/comments 200", "pruned 4 entries older than 7 days", "status=ok count=3"} {
		if Scrub(keep) != keep {
			t.Errorf("changed harmless text %q -> %q", keep, Scrub(keep))
		}
	}
}

// Reproduces the leak path found in review: Gemini puts its key in ?key=, a
// network failure returns a *url.Error whose text includes that URL, and the
// error is logged through an old log.Printf line and slog attrs. The key must
// reach neither stdout nor the store.
func TestRealURLErrorKeyNeverLoggedOrStored(t *testing.T) {
	buf := setup(t, slog.LevelDebug)
	sink := &fakeSink{}
	w := startStore(sink, time.Hour)
	defer w.close()

	const key = "AIzaSyLEAKLEAKLEAKLEAKLEAKLEAKLEAK99"
	client := &http.Client{Timeout: 2 * time.Second}
	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:1/v1beta/models/m:generateContent?key="+key, nil)
	_, err := client.Do(req)
	if err == nil {
		t.Fatal("expected a connection error")
	}
	wrapped := fmt.Errorf("request failed: %w", err)
	if !strings.Contains(wrapped.Error(), key) {
		t.Fatalf("precondition: Go error text should contain the key, got %q", wrapped.Error())
	}

	log.Printf("❌ AI call error: %v", wrapped)
	slog.ErrorContext(context.Background(), "ai call failed", "error", wrapped, "detail", wrapped.Error())
	slog.Default().With("upstream", wrapped.Error()).Warn("retrying")
	_ = Flush(context.Background())

	if out := buf.raw(); strings.Contains(out, key) {
		t.Fatalf("key reached stdout:\n%s", out)
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.recs) < 3 {
		t.Fatalf("expected 3 stored records, got %d", len(sink.recs))
	}
	for _, r := range sink.recs {
		if strings.Contains(r.Message, key) || strings.Contains(fmt.Sprint(r.Attrs), key) {
			t.Fatalf("key reached the store: %+v", r)
		}
	}
}
