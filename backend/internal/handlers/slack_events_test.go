package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func signBody(secret, ts, body string) string {
	base := "v0:" + ts + ":" + body
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(base))
	return "v0=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifySlackSignature_Valid(t *testing.T) {
	t.Setenv("SLACK_SIGNING_SECRET", "test-secret")
	body := `{"type":"event_callback"}`
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := signBody("test-secret", ts, body)

	req := httptest.NewRequest(http.MethodPost, "/api/slack/events", nil)
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", sig)

	if !verifySlackSignature(req, []byte(body)) {
		t.Fatal("expected a correctly signed request to verify")
	}
}

func TestVerifySlackSignature_WrongSecret(t *testing.T) {
	t.Setenv("SLACK_SIGNING_SECRET", "test-secret")
	body := `{"type":"event_callback"}`
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := signBody("wrong-secret", ts, body)

	req := httptest.NewRequest(http.MethodPost, "/api/slack/events", nil)
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", sig)

	if verifySlackSignature(req, []byte(body)) {
		t.Fatal("expected a request signed with the wrong secret to fail verification")
	}
}

func TestVerifySlackSignature_TamperedBody(t *testing.T) {
	t.Setenv("SLACK_SIGNING_SECRET", "test-secret")
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := signBody("test-secret", ts, `{"type":"event_callback"}`)

	req := httptest.NewRequest(http.MethodPost, "/api/slack/events", nil)
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", sig)

	// Verifying against a DIFFERENT body than what was signed must fail.
	if verifySlackSignature(req, []byte(`{"type":"event_callback","injected":true}`)) {
		t.Fatal("expected a tampered body to fail verification")
	}
}

func TestVerifySlackSignature_StaleTimestamp(t *testing.T) {
	t.Setenv("SLACK_SIGNING_SECRET", "test-secret")
	body := `{"type":"event_callback"}`
	staleTS := strconv.FormatInt(time.Now().Add(-10*time.Minute).Unix(), 10)
	sig := signBody("test-secret", staleTS, body)

	req := httptest.NewRequest(http.MethodPost, "/api/slack/events", nil)
	req.Header.Set("X-Slack-Request-Timestamp", staleTS)
	req.Header.Set("X-Slack-Signature", sig)

	if verifySlackSignature(req, []byte(body)) {
		t.Fatal("expected a stale (>5min old) timestamp to fail verification (replay protection)")
	}
}

func TestVerifySlackSignature_MissingSecret(t *testing.T) {
	os.Unsetenv("SLACK_SIGNING_SECRET")
	body := `{"type":"event_callback"}`
	ts := strconv.FormatInt(time.Now().Unix(), 10)

	req := httptest.NewRequest(http.MethodPost, "/api/slack/events", nil)
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", "v0=anything")

	if verifySlackSignature(req, []byte(body)) {
		t.Fatal("expected verification to fail closed when SLACK_SIGNING_SECRET is unset")
	}
}

func TestSanitizeDashes(t *testing.T) {
	cases := map[string]string{
		"hey there — nice work":    "hey there ,  nice work",
		"double--dash here":        "double, dash here",
		"en dash – also stripped":  "en dash ,  also stripped",
		"no dashes here, all good": "no dashes here, all good",
	}
	for in, want := range cases {
		if got := sanitizeDashes(in); got != want {
			t.Errorf("sanitizeDashes(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHandle_URLVerificationChallenge(t *testing.T) {
	t.Setenv("SLACK_SIGNING_SECRET", "test-secret")
	body := `{"type":"url_verification","challenge":"abc123"}`
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := signBody("test-secret", ts, body)

	req := httptest.NewRequest(http.MethodPost, "/api/slack/events", strings.NewReader(body))
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", sig)

	rr := httptest.NewRecorder()
	h := NewSlackEventsHandler()
	h.Handle(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"challenge":"abc123"`) {
		t.Fatalf("expected challenge echoed back, got %s", rr.Body.String())
	}
}
