package handlers

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
)

type OAuthHandler struct {
	repo      *database.OAuthRepository
	tokenRepo *database.MCPTokenRepository
}

func NewOAuthHandler() *OAuthHandler {
	return &OAuthHandler{
		repo:      database.NewOAuthRepository(),
		tokenRepo: database.NewMCPTokenRepository(),
	}
}

func frontendBase() string {
	base := strings.TrimRight(os.Getenv("FRONTEND_URL"), "/")
	if base == "" {
		return "http://localhost:5173"
	}
	return base
}

// GET /.well-known/oauth-authorization-server — RFC 8414 Authorization Server Metadata.
// Claude.ai fetches this to discover the auth/token/registration endpoints.
func (h *OAuthHandler) Metadata(w http.ResponseWriter, r *http.Request) {
	base := frontendBase()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"registration_endpoint":                 base + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
	})
}

// GET /.well-known/oauth-protected-resource — RFC 9728 Protected Resource Metadata.
// This is what Claude.ai fetches FIRST (from WWW-Authenticate resource_metadata=).
// Must return the resource URI and which authorization_servers to use — NOT auth server metadata.
func (h *OAuthHandler) ProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	base := frontendBase()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"resource":                 base + "/api/mcp",
		"authorization_servers":    []string{base},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{"mcp"},
	})
}

// POST /oauth/register — RFC 7591 dynamic client registration
func (h *OAuthHandler) RegisterClient(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, oauthRegisterBodyMB)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	if err := validateClientRegistration(body.ClientName, body.RedirectURIs); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_redirect_uri", "error_description": err.Error()})
		return
	}
	body.ClientName = cleanClientName(body.ClientName)
	client, err := h.repo.RegisterClient(r.Context(), body.ClientName, body.RedirectURIs)
	if errors.Is(err, database.ErrTooManyClients) {
		w.Header().Set("Retry-After", "600")
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "temporarily_unavailable"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"client_id":     client.ClientID,
		"client_name":   client.ClientName,
		"redirect_uris": client.RedirectURIs,
	})
}

// POST /oauth/token — authorization code → MCP access token
func (h *OAuthHandler) Token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	grantType := r.FormValue("grant_type")
	if grantType != "authorization_code" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type"})
		return
	}

	code := r.FormValue("code")
	clientID := r.FormValue("client_id")
	redirectURI := r.FormValue("redirect_uri")
	verifier := r.FormValue("code_verifier")

	if code == "" || clientID == "" || redirectURI == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}

	userID, err := h.repo.ConsumeCode(r.Context(), code, clientID, redirectURI, verifier)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// Generate (or rotate) this client's own MCP token and return it as
	// access_token. Keyed by client_id so a second client (e.g. Codex)
	// connecting doesn't overwrite and invalidate an already-connected
	// client's (e.g. Claude's) token.
	clientName := clientID
	if client, _ := h.repo.GetClient(r.Context(), clientID); client != nil && client.ClientName != "" {
		clientName = client.ClientName
	}
	log.Printf("[mcp-oauth] token issued: user=%s client=%q (%s)", userID, clientName, clientID)
	plain, err := h.tokenRepo.GenerateToken(r.Context(), userID, clientID, clientName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"access_token": plain,
		"token_type":   "Bearer",
		"expires_in":   315360000, // 10 years — tokens don't expire, user revokes manually
	})
}

// POST /api/oauth/code — JWT-protected; frontend calls this after user approves
func (h *OAuthHandler) CreateCode(w http.ResponseWriter, r *http.Request) {
	u := middleware.GetUserFromContext(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		ClientID    string `json:"client_id"`
		RedirectURI string `json:"redirect_uri"`
		Challenge   string `json:"code_challenge"`
		Method      string `json:"code_challenge_method"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ClientID == "" || body.RedirectURI == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}

	// Verify client exists
	client, err := h.repo.GetClient(r.Context(), body.ClientID)
	if err != nil || client == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown client"})
		return
	}

	// Verify redirect_uri is registered
	allowed := false
	for _, uri := range client.RedirectURIs {
		if uri == body.RedirectURI {
			allowed = true
			break
		}
	}
	if !allowed {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "redirect_uri mismatch"})
		return
	}

	// Re-check at approval time: clients registered before these rules existed are covered too.
	if err := validateRedirectURI(body.RedirectURI); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "redirect_uri not allowed"})
		return
	}
	// PKCE is mandatory: a code that leaks from the redirect is useless without the verifier.
	method := body.Method
	if method == "" {
		method = "S256"
	}
	if body.Challenge == "" || !strings.EqualFold(method, "S256") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "code_challenge (S256) is required"})
		return
	}

	code, err := h.repo.CreateCode(r.Context(), u.ID, body.ClientID, body.RedirectURI, body.Challenge, method)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}

	log.Printf("[mcp-oauth] consent approved: user=%s client=%q (%s) redirect_host=%s", u.ID, client.ClientName, client.ClientID, redirectHost(body.RedirectURI))
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

func redirectHost(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		return u.Host
	}
	return "?"
}

// GET /oauth/client-info?client_id=&redirect_uri= tells the consent page whether this sign-in
// request is genuine: the client must exist and the redirect must be one it registered and that
// passes the allowlist. The page shows the Approve and Deny buttons only when ok is true, so a
// crafted link can never make the page redirect somewhere unchecked.
func (h *OAuthHandler) ClientInfo(w http.ResponseWriter, r *http.Request) {
	clientID, redirectURI := r.URL.Query().Get("client_id"), r.URL.Query().Get("redirect_uri")
	w.Header().Set("Cache-Control", "no-store")
	bad := func() { writeJSON(w, http.StatusOK, map[string]any{"ok": false}) }
	if clientID == "" || len(clientID) > 128 || validateRedirectURI(redirectURI) != nil {
		bad()
		return
	}
	client, _ := h.repo.GetClient(r.Context(), clientID)
	info, ok := consentInfo(client, redirectURI)
	if !ok {
		bad()
		return
	}
	writeJSON(w, http.StatusOK, info)
}

// consentInfo decides whether a sign-in request may be shown for approval. The redirect must be
// one the client registered and must pass the allowlist.
func consentInfo(client *database.OAuthClient, redirectURI string) (map[string]any, bool) {
	if client == nil || validateRedirectURI(redirectURI) != nil {
		return nil, false
	}
	registered := false
	for _, u := range client.RedirectURIs {
		if u == redirectURI {
			registered = true
			break
		}
	}
	if !registered {
		return nil, false
	}
	host := redirectHost(redirectURI)
	return map[string]any{
		"ok": true, "client_name": cleanClientName(client.ClientName), "redirect_host": host,
		"trusted": oauthTrustedHost(strings.Split(host, ":")[0]),
	}, true
}
