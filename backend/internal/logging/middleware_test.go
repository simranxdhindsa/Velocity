package logging

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

func serve(h http.Handler, method, target string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestMiddlewareAccessLine(t *testing.T) {
	buf := setup(t, -4)
	r := mux.NewRouter()
	r.Use(RouteTagger)
	r.HandleFunc("/api/tasks/{id}", func(w http.ResponseWriter, req *http.Request) {
		SetUser(req.Context(), "user-1")
		AddField(req.Context(), "mcp_method", "tools/call")
		w.Write([]byte("ok"))
	})
	rec := serve(Middleware(r), "GET", "/api/tasks/42?token=SECRET", map[string]string{
		"X-Forwarded-For": " 1.2.3.4 , 5.6.7.8", "Authorization": "Bearer SECRET"})
	if rec.Header().Get("X-Request-ID") == "" {
		t.Error("no request id header")
	}
	if strings.Contains(buf.raw(), "SECRET") {
		t.Errorf("secret leaked: %s", buf.raw())
	}
	l := find(buf.lines(t), "request")
	if l == nil {
		t.Fatal("no access line")
	}
	if l["path"] != "/api/tasks/42" || l["route"] != "/api/tasks/{id}" || l["status"].(float64) != 200 ||
		l["ip"] != "1.2.3.4" || l["user_id"] != "user-1" || l["mcp_method"] != "tools/call" || l["level"] != "INFO" {
		t.Errorf("bad line %v", l)
	}
	if l["request_id"] != rec.Header().Get("X-Request-ID") {
		t.Error("request id mismatch")
	}
}

func TestRequestIDHonoured(t *testing.T) {
	setup(t, -4)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	if got := serve(h, "GET", "/api/x", map[string]string{"X-Request-ID": "abc-12345678"}).Header().Get("X-Request-ID"); got != "abc-12345678" {
		t.Errorf("got %s", got)
	}
	got := serve(h, "GET", "/api/x", map[string]string{"X-Request-ID": "bad id!"}).Header().Get("X-Request-ID")
	if len(got) != 16 {
		t.Errorf("expected generated id, got %q", got)
	}
}

func TestErrorStatusLevelsAndBody(t *testing.T) {
	buf := setup(t, -4)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/bad" {
			w.WriteHeader(400)
			w.Write([]byte("{\"message\":\n  \"nope  nope\"}"))
			return
		}
		w.WriteHeader(502)
	}))
	serve(h, "GET", "/api/bad", nil)
	serve(h, "GET", "/api/up", nil)
	ls := buf.lines(t)
	if ls[0]["level"] != "INFO" || ls[0]["error"] != `{"message": "nope nope"}` {
		t.Errorf("%v", ls[0])
	}
	if ls[1]["level"] != "ERROR" {
		t.Errorf("%v", ls[1])
	}
}

func TestQuietPaths(t *testing.T) {
	buf := setup(t, 0)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	serve(h, "GET", "/api/health", nil)
	serve(h, "OPTIONS", "/api/tasks", nil)
	serve(h, "GET", "/assets/app.js", nil)
	if len(buf.lines(t)) != 0 {
		t.Errorf("expected nothing at info: %s", buf.raw())
	}
	if !quietPath("GET", "/") || quietPath("GET", "/oauth/x") || quietPath("GET", "/.well-known/a") {
		t.Error("quietPath wrong")
	}
}

func TestPanicRecovery(t *testing.T) {
	buf := setup(t, -4)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { panic("boom") }))
	rec := serve(h, "GET", "/api/p", nil)
	if rec.Code != 500 || !strings.Contains(rec.Body.String(), `"request_id":"`+rec.Header().Get("X-Request-ID")+`"`) ||
		!strings.Contains(rec.Body.String(), "Internal server error") {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
	ls := buf.lines(t)
	p := find(ls, "panic recovered")
	if p == nil || p["panic"] != "boom" || !strings.Contains(p["stack"].(string), "goroutine") {
		t.Errorf("bad panic line %v", p)
	}
	a := find(ls, "request")
	if a["status"].(float64) != 500 || a["panic"] != true || a["level"] != "ERROR" {
		t.Errorf("bad access %v", a)
	}
}

func TestAbortHandlerRepanics(t *testing.T) {
	setup(t, -4)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { panic(http.ErrAbortHandler) }))
	defer func() {
		if recover() != http.ErrAbortHandler {
			t.Error("expected re-panic")
		}
	}()
	serve(h, "GET", "/api/p", nil)
}

func TestFlusherPreserved(t *testing.T) {
	setup(t, -4)
	var ok bool
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, ok = w.(http.Flusher)
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		if http.NewResponseController(w).Flush() != nil {
			t.Error("ResponseController flush failed")
		}
	}))
	serve(h, "GET", "/api/sse", nil)
	if !ok {
		t.Error("not a Flusher")
	}
}

func TestSlowRequestWarn(t *testing.T) {
	buf := setup(t, -4)
	slowRequestMS.Store(0)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// duration must exceed 0ms
		for i := 0; i < 3; i++ {
			sleepMs()
		}
	}))
	serve(h, "GET", "/api/slow", nil)
	l := find(buf.lines(t), "request")
	if l["level"] != "WARN" || l["slow"] != true {
		t.Errorf("%v", l)
	}
}

func TestAnonymous4xxNotWarnButUserIs(t *testing.T) {
	buf := setup(t, -4)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/mine" {
			SetUser(r.Context(), "u1")
		}
		w.WriteHeader(404)
	}))
	serve(h, "GET", "/api/scan", nil)
	serve(h, "GET", "/api/mine", nil)
	ls := buf.lines(t)
	if ls[0]["level"] != "INFO" || ls[1]["level"] != "WARN" {
		t.Errorf("%v %v", ls[0], ls[1])
	}
}

func TestPathAndIPBounded(t *testing.T) {
	buf := setup(t, 0)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	serve(h, "GET", "/api/"+strings.Repeat("a", 3000), map[string]string{"X-Forwarded-For": strings.Repeat("9", 2000)})
	l := buf.lines(t)[0]
	if len([]rune(l["path"].(string))) > 210 || len(l["ip"].(string)) > 50 {
		t.Errorf("not bounded: %d %d", len(l["path"].(string)), len(l["ip"].(string)))
	}
}

func TestPanicAfterHeadersKeepsStatus(t *testing.T) {
	buf := setup(t, 0)
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		panic("late")
	}))
	serve(h, "GET", "/api/x", nil)
	l := find(buf.lines(t), "request")
	if l["status"] != float64(200) {
		t.Errorf("%v", l)
	}
}
