package logging

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRedactPath(t *testing.T) {
	cases := []struct{ host, in, want string }{
		{"hooks.slack.com", "/services/T0/B0/xyz", "/services/[redacted]"},
		{"x.com", "/api/v1/issues", "/api/v1/issues"},
		{"x.com", "/bot/abcdefghij1234567890/send", "/bot/[redacted]/send"},
		{"x.com", "/auth/xoxb-123", "/auth/[redacted]"},
		{"x.com", "/averyveryverylongwordwithoutdigits", "/averyveryverylongwordwithoutdigits"},
	}
	for _, c := range cases {
		if got := redactPath(c.host, c.in); got != c.want {
			t.Errorf("%s: got %s want %s", c.in, got, c.want)
		}
	}
}

func TestTransportLogsAndCounts(t *testing.T) {
	buf := setup(t, -4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fail" {
			w.WriteHeader(500)
		}
	}))
	defer srv.Close()
	cl := &http.Client{Transport: &loggingTransport{base: &http.Transport{}}}
	in := &info{id: "reqid-1234"}
	ctx := context.WithValue(context.Background(), infoKey, in)
	for _, p := range []string{"/ok?token=SECRET", "/fail"} {
		req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+p, nil)
		resp, err := cl.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	if in.outCount != 2 {
		t.Errorf("outCount %d", in.outCount)
	}
	if strings.Contains(buf.raw(), "SECRET") {
		t.Error("query leaked")
	}
	ls := buf.lines(t)
	if ls[0]["level"] != "DEBUG" || ls[1]["level"] != "WARN" || ls[1]["status"].(float64) != 500 || ls[0]["request_id"] != "reqid-1234" {
		t.Errorf("%v", ls)
	}
}

func TestTransportErrors(t *testing.T) {
	buf := setup(t, -4)
	cl := &http.Client{Transport: &loggingTransport{base: &http.Transport{}}}
	req, _ := http.NewRequest("GET", "http://127.0.0.1:1/x?token=SECRET", nil)
	if _, err := cl.Do(req); err == nil {
		t.Fatal("expected error")
	}
	l := find(buf.lines(t), "outbound request failed")
	if l == nil || l["level"] != "ERROR" || strings.Contains(buf.raw(), "SECRET") {
		t.Errorf("%s", buf.raw())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req, _ = http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:1/y", nil)
	cl.Do(req)
	for _, ln := range buf.lines(t) {
		if ln["path"] == "/y" && ln["level"] != "DEBUG" {
			t.Errorf("canceled should be debug: %v", ln)
		}
	}
}

func TestInstallIdempotent(t *testing.T) {
	InstallHTTPTransport()
	InstallHTTPTransport()
	lt, ok := http.DefaultTransport.(*loggingTransport)
	if !ok {
		t.Fatal("not installed")
	}
	if _, nested := lt.base.(*loggingTransport); nested {
		t.Error("double wrapped")
	}
}
