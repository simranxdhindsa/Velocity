package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	"github.com/gorilla/mux"
)

// ── fakes ────────────────────────────────────────────────────────────────────

type fakeChatStore struct {
	mu        sync.Mutex
	items     []database.SlackDMListItem
	convs     map[string]*database.SlackDMConversation
	msgs      map[string][]database.SlackDMMessage
	afterSeen int64
	cleared   []string
	resolved  []string
	modes     map[string]string
	latestIn  *time.Time
}

func newFakeChatStore() *fakeChatStore {
	return &fakeChatStore{convs: map[string]*database.SlackDMConversation{}, msgs: map[string][]database.SlackDMMessage{}, modes: map[string]string{}}
}
func (s *fakeChatStore) ListConversations(context.Context, int) ([]database.SlackDMListItem, error) {
	return s.items, nil
}
func (s *fakeChatStore) GetConversation(_ context.Context, ch string) (*database.SlackDMConversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.convs[ch]; c != nil {
		cp := *c
		return &cp, nil
	}
	return nil, nil
}
func (s *fakeChatStore) ListMessages(_ context.Context, ch string, after int64, _ int) ([]database.SlackDMMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.afterSeen = after
	var out []database.SlackDMMessage
	for _, m := range s.msgs[ch] {
		if m.ID > after {
			out = append(out, m)
		}
	}
	return out, nil
}
func (s *fakeChatStore) SetMode(_ context.Context, ch, mode string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.convs[ch] == nil {
		return false, nil
	}
	s.modes[ch] = mode
	return true, nil
}
func (s *fakeChatStore) ClearAttention(_ context.Context, ch string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleared = append(s.cleared, ch)
	return nil
}
func (s *fakeChatStore) LatestInboundAt(context.Context) (*time.Time, error) { return s.latestIn, nil }
func (s *fakeChatStore) ResolveRelay(_ context.Context, ch string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.convs[ch] == nil {
		return false, nil
	}
	s.resolved = append(s.resolved, ch)
	return true, nil
}
func (s *fakeChatStore) CountNeedingAttention(context.Context) (int, error) {
	n := 0
	for _, c := range s.convs {
		if c.NeedsAttention {
			n++
		}
	}
	return n, nil
}

type sentDM struct{ userID, message, dmUserID, source string }
type fakeChatSender struct {
	sent []sentDM
	err  error
}

func (f *fakeChatSender) QuickSend(_ context.Context, userID, _ string, message, dmUserID, source string) (string, string, error) {
	if f.err != nil {
		return "", "", f.err
	}
	f.sent = append(f.sent, sentDM{userID, message, dmUserID, source})
	return "1.1", "D_H", nil
}

// chatsRouter wires the handler exactly like main.go (AdminOnly in front), with a tiny
// stand-in for AuthMiddleware that puts the user named in X-Test-Role on the context.
func chatsRouter(h *SlackChatsHandler) http.Handler {
	r := mux.NewRouter()
	api := r.PathPrefix("/api/slack-chats").Subrouter()
	api.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if role := req.Header.Get("X-Test-Role"); role != "" {
				u := &models.User{ID: "user-simran", Name: "Simran", Role: models.Role(role)}
				req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, u))
			}
			next.ServeHTTP(w, req)
		})
	})
	api.Use(middleware.AdminOnly)
	api.HandleFunc("", h.List).Methods("GET")
	api.HandleFunc("/summary", h.Summary).Methods("GET")
	api.HandleFunc("/rephrase", h.Rephrase).Methods("POST")
	api.HandleFunc("/{channel}/messages", h.Messages).Methods("GET")
	api.HandleFunc("/{channel}/reply", h.Reply).Methods("POST")
	api.HandleFunc("/{channel}/mode", h.SetMode).Methods("PUT")
	api.HandleFunc("/{channel}/resolve", h.Resolve).Methods("POST")
	return r
}

func newTestChats() (*SlackChatsHandler, *fakeChatStore, *fakeChatSender) {
	store, sender := newFakeChatStore(), &fakeChatSender{}
	until := time.Now().Add(time.Hour)
	store.convs["D_H"] = &database.SlackDMConversation{ChannelID: "D_H", SlackUserID: "UHARPREET", SlackUserName: "Harpreet",
		Mode: "smart", RelayOwnerID: "user-simran", RelayUntil: &until, NeedsAttention: true}
	h := &SlackChatsHandler{store: store, sender: sender, userName: func(_ context.Context, id string) string {
		if id == "user-simran" {
			return "Simran"
		}
		return ""
	}}
	return h, store, sender
}

func do(h http.Handler, method, path, role, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if role != "" {
		req.Header.Set("X-Test-Role", role)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad JSON %q: %v", rec.Body.String(), err)
	}
	return out
}

// ── access control: these are private conversations ─────────────────────────

func TestChatsAreAdminOnlyOnEveryRoute(t *testing.T) {
	h, store, sender := newTestChats()
	router := chatsRouter(h)
	routes := []struct{ method, path, body string }{
		{"GET", "/api/slack-chats", ""},
		{"GET", "/api/slack-chats/summary", ""},
		{"POST", "/api/slack-chats/rephrase", `{"text":"hi","style":"polite"}`},
		{"GET", "/api/slack-chats/D_H/messages", ""},
		{"POST", "/api/slack-chats/D_H/reply", `{"text":"hi"}`},
		{"PUT", "/api/slack-chats/D_H/mode", `{"mode":"muted"}`},
		{"POST", "/api/slack-chats/D_H/resolve", ""},
	}
	for _, role := range []string{"", string(models.RoleProjectManager), "developer", "qa"} {
		for _, rt := range routes {
			rec := do(router, rt.method, rt.path, role, rt.body)
			if rec.Code != http.StatusForbidden && rec.Code != http.StatusUnauthorized {
				t.Errorf("role %q %s %s: got %d, want 401/403", role, rt.method, rt.path, rec.Code)
			}
		}
	}
	if len(sender.sent) != 0 || len(store.modes) != 0 || len(store.resolved) != 0 || len(store.cleared) != 0 {
		t.Errorf("a refused request must change nothing: sent=%v modes=%v resolved=%v cleared=%v", sender.sent, store.modes, store.resolved, store.cleared)
	}
	if rec := do(router, "GET", "/api/slack-chats", string(models.RoleAdmin), ""); rec.Code != http.StatusOK {
		t.Errorf("an admin must get in: %d", rec.Code)
	}
}

// ── list and messages ────────────────────────────────────────────────────────

func TestChatsListShowsWhoIsHandlingTheRelay(t *testing.T) {
	h, store, _ := newTestChats()
	until := time.Now().Add(time.Hour)
	past := time.Now().Add(-time.Hour)
	store.items = []database.SlackDMListItem{
		{SlackDMConversation: database.SlackDMConversation{ChannelID: "D_H", SlackUserName: "Harpreet", RelayOwnerID: "user-simran", RelayUntil: &until, NeedsAttention: true}, LastPreview: "ETA tomorrow", LastKind: "human"},
		{SlackDMConversation: database.SlackDMConversation{ChannelID: "D_R", SlackUserName: "Rohit", RelayOwnerID: "user-simran", RelayUntil: &past}, LastPreview: "ok"},
	}
	rec := do(chatsRouter(h), "GET", "/api/slack-chats", "admin", "")
	data := decode(t, rec)["data"].([]any)
	if len(data) != 2 {
		t.Fatalf("want 2 chats, got %d", len(data))
	}
	first, second := data[0].(map[string]any), data[1].(map[string]any)
	if first["relay_active"] != true || first["relay_owner_name"] != "Simran" || first["last_preview"] != "ETA tomorrow" {
		t.Errorf("open relay should name its owner: %+v", first)
	}
	if second["relay_active"] != false || second["relay_owner_name"] != "" {
		t.Errorf("a lapsed relay is not active: %+v", second)
	}
}

func TestChatMessagesLabelAuthorsAndOnlyMarkReadWhenAsked(t *testing.T) {
	h, store, _ := newTestChats()
	store.msgs["D_H"] = []database.SlackDMMessage{
		{ID: 1, Direction: "out", Kind: "claude", SentByUserID: "user-simran", Text: "status of ARD-3033?"},
		{ID: 2, Direction: "in", Kind: "human", Text: "blocked on the API"},
		{ID: 3, Direction: "out", Kind: "ack", Text: "Thanks, I have passed this on to Simran."},
		{ID: 4, Direction: "out", Kind: "auto_reply", Text: "Noted."},
		{ID: 5, Direction: "out", Kind: "dashboard", SentByUserID: "someone-deleted", Text: "ok"},
	}
	router := chatsRouter(h)

	rec := do(router, "GET", "/api/slack-chats/D_H/messages", "admin", "")
	body := decode(t, rec)
	var labels []string
	for _, m := range body["data"].([]any) {
		labels = append(labels, m.(map[string]any)["author_label"].(string))
	}
	if got := strings.Join(labels, ","); got != "Simran,Harpreet,Velocity,Velocity,A Velocity user" {
		t.Errorf("author labels wrong: %s", got)
	}
	if len(store.cleared) != 0 {
		t.Error("just polling must not clear the flag")
	}
	conv := body["conversation"].(map[string]any)
	if conv["needs_attention"] != true || conv["relay_owner_name"] != "Simran" || conv["relay_active"] != true {
		t.Errorf("conversation header wrong: %+v", conv)
	}

	rec = do(router, "GET", "/api/slack-chats/D_H/messages?after_id=3&mark_read=1", "admin", "")
	body = decode(t, rec)
	if store.afterSeen != 3 || len(body["data"].([]any)) != 2 {
		t.Errorf("polling should only return messages after the cursor (seen after_id=%d)", store.afterSeen)
	}
	if len(store.cleared) != 1 || body["conversation"].(map[string]any)["needs_attention"] != false {
		t.Errorf("mark_read=1 means the admin is looking: the flag clears (%v)", store.cleared)
	}
}

func TestChatEndpointsRejectBadOrUnknownConversations(t *testing.T) {
	h, _, sender := newTestChats()
	router := chatsRouter(h)
	for _, bad := range []string{"a%20b", "a.b", "..%2F..", strings.Repeat("A", 65)} {
		if rec := do(router, "GET", "/api/slack-chats/"+bad+"/messages", "admin", ""); rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound && rec.Code != http.StatusMovedPermanently {
			// (the router redirects "../" style paths to a cleaned URL before any handler runs)
			t.Errorf("conversation id %q should be refused, got %d", bad, rec.Code)
		}
	}
	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/slack-chats/D_NOPE/messages", ""},
		{"POST", "/api/slack-chats/D_NOPE/reply", `{"text":"hi"}`},
		{"PUT", "/api/slack-chats/D_NOPE/mode", `{"mode":"muted"}`},
		{"POST", "/api/slack-chats/D_NOPE/resolve", ""},
	} {
		if rec := do(router, c.method, c.path, "admin", c.body); rec.Code != http.StatusNotFound {
			t.Errorf("%s %s: unknown conversation should be 404, got %d", c.method, c.path, rec.Code)
		}
	}
	if len(sender.sent) != 0 {
		t.Error("nothing may be sent to a conversation that does not exist")
	}
}

// ── reply ────────────────────────────────────────────────────────────────────

func TestChatReplyGoesOutExactlyAsWrittenAndClearsTheFlag(t *testing.T) {
	h, store, sender := newTestChats()
	rec := do(chatsRouter(h), "POST", "/api/slack-chats/D_H/reply", "admin", `{"text":"  Thanks Harpreet, can you share the ETA?  "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("reply failed: %d %s", rec.Code, rec.Body.String())
	}
	if len(sender.sent) != 1 {
		t.Fatalf("want one send, got %+v", sender.sent)
	}
	s := sender.sent[0]
	if s.userID != "user-simran" || s.dmUserID != "UHARPREET" || s.source != "quick_send" {
		t.Errorf("must go to Harpreet's Slack user as a dashboard send for the admin: %+v", s)
	}
	if s.message != "Thanks Harpreet, can you share the ETA?" {
		t.Errorf("must be the trimmed text only, with no name or signature added: %q", s.message)
	}
	if strings.Contains(s.message, "—") {
		t.Error("no em dash in text that goes to people")
	}
	if len(store.cleared) != 1 {
		t.Error("answering clears the needs-you flag")
	}
}

func TestChatReplyValidationAndSlackFailure(t *testing.T) {
	h, store, sender := newTestChats()
	router := chatsRouter(h)
	for name, body := range map[string]string{
		"empty":      `{"text":""}`,
		"whitespace": `{"text":"   \n "}`,
		"not json":   `nope`,
		"too long":   `{"text":"` + strings.Repeat("x", maxChatReplyRunes+1) + `"}`,
	} {
		if rec := do(router, "POST", "/api/slack-chats/D_H/reply", "admin", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", name, rec.Code)
		}
	}
	if len(sender.sent) != 0 {
		t.Error("invalid replies must not be sent")
	}

	sender.err = errors.New("slack API error: channel_not_found")
	rec := do(router, "POST", "/api/slack-chats/D_H/reply", "admin", `{"text":"hi"}`)
	if rec.Code != http.StatusBadGateway || !strings.Contains(decode(t, rec)["message"].(string), "channel_not_found") {
		t.Errorf("a Slack failure must be reported, not swallowed: %d %s", rec.Code, rec.Body.String())
	}
	if len(store.cleared) != 0 {
		t.Error("a failed send must NOT clear the needs-you flag, the person is still waiting")
	}
}

// ── mode, resolve and the badge ─────────────────────────────────────────────

func TestChatModeAndResolve(t *testing.T) {
	h, store, _ := newTestChats()
	router := chatsRouter(h)
	if rec := do(router, "PUT", "/api/slack-chats/D_H/mode", "admin", `{"mode":"loud"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("an unknown mode is a 400, got %d", rec.Code)
	}
	if len(store.modes) != 0 {
		t.Error("an invalid mode must not be stored")
	}
	for _, m := range []string{"muted", "auto", "smart"} {
		if rec := do(router, "PUT", "/api/slack-chats/D_H/mode", "admin", `{"mode":"`+m+`"}`); rec.Code != http.StatusOK || store.modes["D_H"] != m {
			t.Errorf("mode %s: %d, stored %q", m, rec.Code, store.modes["D_H"])
		}
	}
	if rec := do(router, "POST", "/api/slack-chats/D_H/resolve", "admin", ""); rec.Code != http.StatusOK || len(store.resolved) != 1 {
		t.Errorf("resolve: %d %v", rec.Code, store.resolved)
	}
}

func TestChatSummaryCountsConversationsNeedingTheAdmin(t *testing.T) {
	h, store, _ := newTestChats()
	store.convs["D_R"] = &database.SlackDMConversation{ChannelID: "D_R", NeedsAttention: false}
	data := decode(t, do(chatsRouter(h), "GET", "/api/slack-chats/summary", "admin", ""))["data"].(map[string]any)
	if data["needs_attention"] != float64(1) {
		t.Errorf("badge count wrong: %+v", data)
	}
}

// A chat Velocity opened only knows the Slack ID; the list must still show the person's real
// name and photo, and a failed Slack lookup must not break the page.
func TestChatListFillsNameAndPhotoFromSlack(t *testing.T) {
	h, store, _ := newTestChats()
	store.items = []database.SlackDMListItem{{SlackDMConversation: database.SlackDMConversation{ChannelID: "D_X", SlackUserID: "U08V0GRUQLU"}}}
	store.convs["D_X"] = &store.items[0].SlackDMConversation
	h.profile = func(_ context.Context, _, id string) (slackProfile, bool) {
		if id == "U08V0GRUQLU" {
			return slackProfile{Name: "Simranjot Singh", Image: "https://img/p.png"}, true
		}
		return slackProfile{}, false
	}
	router := chatsRouter(h)

	list := decode(t, do(router, "GET", "/api/slack-chats", "admin", ""))["data"].([]any)[0].(map[string]any)
	if list["slack_user_name"] != "Simranjot Singh" || list["slack_user_image"] != "https://img/p.png" {
		t.Fatalf("list item = %v", list)
	}
	conv := decode(t, do(router, "GET", "/api/slack-chats/D_X/messages", "admin", ""))["conversation"].(map[string]any)
	if conv["slack_user_name"] != "Simranjot Singh" || conv["slack_user_image"] != "https://img/p.png" {
		t.Fatalf("conversation = %v", conv)
	}

	h.profile = func(context.Context, string, string) (slackProfile, bool) { return slackProfile{}, false }
	rec := do(router, "GET", "/api/slack-chats", "admin", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("Slack lookup failure broke the list: %d", rec.Code)
	}
}

func TestRephrase(t *testing.T) {
	h, _, sender := newTestChats()
	router := chatsRouter(h)
	var gotSystem, gotUser string
	h.rewrite = func(_ context.Context, system, user string) (string, error) {
		gotSystem, gotUser = system, user
		return `"Hey, could you send the report when you get a moment — it's blocking us - thanks! I'm waiting -- really."`, nil
	}
	rec := do(router, "POST", "/api/slack-chats/rephrase", "admin", `{"text":"send report now","style":"polite"}`)
	data := decode(t, rec)["data"].(map[string]any)
	if rec.Code != 200 || data["text"] != "Hey, could you send the report when you get a moment, its blocking us, thanks! im waiting, really." {
		t.Fatalf("got %d %v (quotes, dashes and apostrophes must be cleaned)", rec.Code, data)
	}
	if !strings.Contains(gotSystem, "polite and warm") || !strings.Contains(gotSystem, "No apostrophes") || !strings.Contains(gotUser, "send report now") {
		t.Errorf("prompt not built from style and draft: %q / %q", gotSystem, gotUser)
	}
	if !strings.Contains(chatRephraseStyles["human"], "real person") || strings.Contains(chatRephraseStyles["human"], "Never use dashes") == false {
		t.Error("human style missing")
	}
	if len(sender.sent) != 0 {
		t.Error("rephrase must never send anything")
	}

	for name, body := range map[string]string{"empty": `{"text":"  ","style":"polite"}`, "bad style": `{"text":"hi","style":"rude"}`, "bad json": `{`} {
		if rec := do(router, "POST", "/api/slack-chats/rephrase", "admin", body); rec.Code != 400 {
			t.Errorf("%s: code %d, want 400", name, rec.Code)
		}
	}
	if rec := do(router, "POST", "/api/slack-chats/rephrase", "", `{"text":"hi","style":"polite"}`); rec.Code == 200 {
		t.Error("non-admin could rephrase")
	}
	h.rewrite = func(context.Context, string, string) (string, error) { return "", errors.New("groq down") }
	if rec := do(router, "POST", "/api/slack-chats/rephrase", "admin", `{"text":"hi","style":"human"}`); rec.Code != 502 {
		t.Errorf("AI failure: code %d, want 502", rec.Code)
	}
	h.rewrite = nil
	if rec := do(router, "POST", "/api/slack-chats/rephrase", "admin", `{"text":"hi","style":"human"}`); rec.Code != 503 {
		t.Errorf("no AI: code %d, want 503", rec.Code)
	}
}

// The prompt follows the bot by its fixed key, so a rename on the Bots page changes nothing.
func TestRephrasePromptFollowsTheKeyNotTheName(t *testing.T) {
	key := chatRephraseBotKeys["polite"]
	renamed := &models.BotConfig{Name: "My polite rewrite", CreatedBy: key, IsActive: true, Prompt: "edited"}
	if got := pickRephrasePrompt([]*models.BotConfig{renamed}, "polite"); got != "edited" {
		t.Errorf("renamed bot ignored: %q", got)
	}
	if got := pickRephrasePrompt([]*models.BotConfig{renamed}, "human"); got != chatRephraseHuman {
		t.Errorf("polite bot used for human: %q", got)
	}
	off := &models.BotConfig{CreatedBy: key, IsActive: false, Prompt: "edited"}
	empty := &models.BotConfig{CreatedBy: key, IsActive: true, Prompt: "  "}
	impostor := &models.BotConfig{Name: "Chat Rephrase: Polite", CreatedBy: "someone", IsActive: true, Prompt: "evil"}
	if got := pickRephrasePrompt([]*models.BotConfig{off, empty, impostor}, "polite"); got != chatRephrasePolite {
		t.Errorf("should fall back to the built-in text: %q", got)
	}
}

// Each message carries the right photo: the person's, the sender's, or none for Velocity itself.
func TestChatMessagesCarryAuthorPhotos(t *testing.T) {
	h, store, _ := newTestChats()
	store.msgs["D_H"] = []database.SlackDMMessage{
		{ID: 1, ChannelID: "D_H", Kind: database.DMKindHuman, Text: "hi"},
		{ID: 2, ChannelID: "D_H", Kind: database.DMKindDashboard, SentByUserID: "user-simran", Text: "a"},
		{ID: 3, ChannelID: "D_H", Kind: database.DMKindClaude, SentByUserID: "user-simran", Text: "b"},
		{ID: 4, ChannelID: "D_H", Kind: database.DMKindAutoReply, Text: "c"},
		{ID: 5, ChannelID: "D_H", Kind: database.DMKindDashboard, Text: "no sender"},
	}
	h.profile = func(context.Context, string, string) (slackProfile, bool) {
		return slackProfile{Name: "Harpreet", Image: "https://img/harpreet.png"}, true
	}
	lookups := 0
	h.userImage = func(_ context.Context, _, id string) string {
		lookups++
		if id == "user-simran" {
			return "https://img/simran.png"
		}
		return ""
	}
	data := decode(t, do(chatsRouter(h), "GET", "/api/slack-chats/D_H/messages", "admin", ""))["data"].([]any)
	want := []string{"https://img/harpreet.png", "https://img/simran.png", "https://img/simran.png", "", ""}
	for i, w := range want {
		if got := data[i].(map[string]any)["author_image"]; got != w {
			t.Errorf("message %d: photo %q, want %q", i+1, got, w)
		}
	}
	if lookups != 1 {
		t.Errorf("one sender should be looked up once per request, got %d", lookups)
	}

	// Without any photo source the messages still load.
	h.profile, h.userImage = nil, nil
	rec := do(chatsRouter(h), "GET", "/api/slack-chats/D_H/messages", "admin", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("messages failed without photos: %d", rec.Code)
	}
}

func TestWaitingMessageLooksPastTheBotsOwnNotes(t *testing.T) {
	human := database.SlackDMMessage{ID: 1, Kind: database.DMKindHuman, Text: "my question"}
	ack := database.SlackDMMessage{ID: 2, Kind: database.DMKindAck}
	notice := database.SlackDMMessage{ID: 3, Kind: database.DMKindNotice}
	cases := map[string]struct {
		msgs []database.SlackDMMessage
		want bool
	}{
		"person spoke last":        {[]database.SlackDMMessage{human}, true},
		"ack and alert after them": {[]database.SlackDMMessage{human, ack, notice}, true},
		"admin already replied":    {[]database.SlackDMMessage{human, {Kind: database.DMKindDashboard}}, false},
		"sent through Claude":      {[]database.SlackDMMessage{human, {Kind: database.DMKindClaude}}, false},
		"bot already answered":     {[]database.SlackDMMessage{human, {Kind: database.DMKindAutoReply}, ack}, false},
		"nothing from the person":  {[]database.SlackDMMessage{ack}, false},
		"empty chat":               {nil, false},
	}
	for name, c := range cases {
		if got := waitingMessage(c.msgs); (got != nil) != c.want {
			t.Errorf("%s: got %+v", name, got)
		} else if got != nil && got.Text != "my question" {
			t.Errorf("%s: wrong message %+v", name, got)
		}
	}
}

func TestPassToBotAnswersTheWaitingMessageOnce(t *testing.T) {
	h, store, _ := newTestChats()
	store.msgs["D_H"] = []database.SlackDMMessage{
		{ID: 1, ChannelID: "D_H", Kind: database.DMKindHuman, SlackTS: "111.1", Text: "what was my availability"},
		{ID: 2, ChannelID: "D_H", Kind: database.DMKindAck, Text: "Thanks, passed on"},
	}
	h.botToken = func(context.Context, string) string { return "xoxb-test" }
	got := make(chan slackInnerEvent, 2)
	release := make(chan struct{})
	h.answer = func(_ context.Context, token string, ev slackInnerEvent) {
		if token != "xoxb-test" {
			t.Errorf("token %q", token)
		}
		got <- ev
		<-release
	}
	router := chatsRouter(h)

	rec := do(router, "POST", "/api/slack-chats/D_H/resolve", "admin", "")
	if rec.Code != 200 || decode(t, rec)["answering"] != true {
		t.Fatalf("want answering true: %d %s", rec.Code, rec.Body.String())
	}
	select {
	case ev := <-got:
		if ev.Channel != "D_H" || ev.User != "UHARPREET" || ev.Text != "what was my availability" || ev.TS != "111.1" || ev.Type != "message" {
			t.Errorf("wrong event: %+v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bot was never asked to answer")
	}

	// A second click while the bot is still writing must not answer again.
	if rec := do(router, "POST", "/api/slack-chats/D_H/resolve", "admin", ""); decode(t, rec)["answering"] != false {
		t.Errorf("double click answered twice: %s", rec.Body.String())
	}
	close(release)
	if len(store.resolved) != 2 {
		t.Errorf("relay should be cleared each time: %v", store.resolved)
	}
}

func TestPassToBotStaysQuietWhenItShould(t *testing.T) {
	waiting := []database.SlackDMMessage{{ID: 1, ChannelID: "D_H", Kind: database.DMKindHuman, Text: "hi"}}
	cases := map[string]func(h *SlackChatsHandler, s *fakeChatStore){
		"muted chat": func(_ *SlackChatsHandler, s *fakeChatStore) { s.convs["D_H"].Mode = "muted" },
		"already answered": func(_ *SlackChatsHandler, s *fakeChatStore) {
			s.msgs["D_H"] = append(waiting, database.SlackDMMessage{ID: 2, ChannelID: "D_H", Kind: database.DMKindDashboard})
		},
		"no Slack connection": func(h *SlackChatsHandler, _ *fakeChatStore) {
			h.botToken = func(context.Context, string) string { return "" }
		},
		"not held for anyone": func(_ *SlackChatsHandler, s *fakeChatStore) {
			s.convs["D_H"].RelayOwnerID = ""
			s.convs["D_H"].NeedsAttention = false
		},
	}
	for name, setup := range cases {
		h, store, _ := newTestChats()
		store.msgs["D_H"] = waiting
		h.botToken = func(context.Context, string) string { return "xoxb-test" }
		h.answer = func(context.Context, string, slackInnerEvent) { t.Errorf("%s: bot must not answer", name) }
		setup(h, store)
		rec := do(chatsRouter(h), "POST", "/api/slack-chats/D_H/resolve", "admin", "")
		if rec.Code != 200 || decode(t, rec)["answering"] != false {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
}

// The nav dot needs to know when the newest message from a person arrived.
func TestChatSummaryReportsTheLatestInboundMessage(t *testing.T) {
	h, store, _ := newTestChats()
	router := chatsRouter(h)
	data := decode(t, do(router, "GET", "/api/slack-chats/summary", "admin", ""))["data"].(map[string]any)
	if data["latest_inbound_at"] != nil {
		t.Errorf("no messages yet should be null: %v", data)
	}
	at := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	store.latestIn = &at
	data = decode(t, do(router, "GET", "/api/slack-chats/summary", "admin", ""))["data"].(map[string]any)
	if data["latest_inbound_at"] != "2026-11-04T12:00:00Z" {
		t.Errorf("latest_inbound_at = %v", data["latest_inbound_at"])
	}
}
