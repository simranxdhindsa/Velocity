package handlers

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/dhindsa/project-management/internal/database"
)

func TestValidateRedirectURI(t *testing.T) {
	t.Setenv("MCP_OAUTH_EXTRA_REDIRECT_HOSTS", "")
	ok := []string{
		"https://claude.ai/api/mcp/auth_callback",
		"https://claude.com/api/mcp/auth_callback",
		"http://localhost:8976/callback",
		"http://127.0.0.1:41233/cb",
		"http://[::1]:5000/cb",
	}
	bad := []string{
		"", "https://evil.example/cb", "https://claude.ai.evil.example/cb", "https://notclaude.ai/cb", "https://www.claude.ai/cb", "https://user-content.claude.ai/cb",
		"http://claude.ai/cb", "http://evil.example/cb", "ftp://claude.ai/x", "javascript:alert(1)",
		"https://claude.ai/cb#frag", "https://user:pw@claude.ai/cb", "https:///nohost", "myapp://callback",
		"https://claude.ai/" + strings.Repeat("a", 600),
	}
	for _, u := range ok {
		if err := validateRedirectURI(u); err != nil {
			t.Errorf("%q should be allowed: %v", u, err)
		}
	}
	for _, u := range bad {
		if err := validateRedirectURI(u); err == nil {
			t.Errorf("%q must be rejected", u)
		}
	}
}

func TestExtraRedirectHostsFromEnv(t *testing.T) {
	t.Setenv("MCP_OAUTH_EXTRA_REDIRECT_HOSTS", "chatgpt.com, example.org")
	if validateRedirectURI("https://chatgpt.com/cb") != nil || validateRedirectURI("https://example.org/cb") != nil {
		t.Error("configured hosts should be allowed")
	}
	if validateRedirectURI("https://evil.example/cb") == nil {
		t.Error("unlisted host allowed")
	}
}

func TestValidateClientRegistration(t *testing.T) {
	good := []string{"https://claude.ai/cb"}
	if validateClientRegistration("Claude", good) != nil {
		t.Error("good registration rejected")
	}
	if validateClientRegistration("Claude", nil) == nil {
		t.Error("no redirect uris accepted")
	}
	if validateClientRegistration("Claude", []string{"https://claude.ai/1", "https://claude.ai/2", "https://claude.ai/3", "https://claude.ai/4", "https://claude.ai/5", "https://claude.ai/6"}) == nil {
		t.Error("too many redirect uris accepted")
	}
	if validateClientRegistration(strings.Repeat("x", 101), good) == nil {
		t.Error("huge client name accepted")
	}
	if validateClientRegistration("Claude", []string{"https://claude.ai/cb", "https://evil.example/cb"}) == nil {
		t.Error("one bad uri among good ones accepted")
	}
}

func TestVerifyPKCE(t *testing.T) {
	verifier := "a-long-random-verifier-string-0123456789"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	if err := database.VerifyPKCE(challenge, "S256", verifier); err != nil {
		t.Fatalf("valid pair rejected: %v", err)
	}
	cases := map[string][3]string{
		"no challenge":   {"", "S256", verifier},
		"no verifier":    {challenge, "S256", ""},
		"wrong verifier": {challenge, "S256", "something-else"},
		"plain method":   {verifier, "plain", verifier},
		"empty method":   {challenge, "", verifier},
	}
	for name, c := range cases {
		if database.VerifyPKCE(c[0], c[1], c[2]) == nil {
			t.Errorf("%s: must be rejected", name)
		}
	}
}

func TestCleanClientNameAndTrust(t *testing.T) {
	if got := cleanClientName("Claude\n\r\x00 Code  \t(evil)"); got != "Claude Code (evil)" {
		t.Errorf("cleanClientName = %q", got)
	}
	for _, h := range []string{"claude.ai", "claude.com", "localhost", "127.0.0.1"} {
		if !oauthTrustedHost(h) {
			t.Errorf("%s should be trusted", h)
		}
	}
	for _, h := range []string{"evil.example", "claude.ai.evil.example", "x.claude.ai"} {
		if oauthTrustedHost(h) {
			t.Errorf("%s must not be trusted", h)
		}
	}
}

func TestConsentInfo(t *testing.T) {
	c := &database.OAuthClient{ClientID: "c1", ClientName: "Claude\n", RedirectURIs: []string{"https://claude.ai/cb", "http://localhost:9/cb"}}
	if info, ok := consentInfo(c, "https://claude.ai/cb"); !ok || info["trusted"] != true || info["client_name"] != "Claude" {
		t.Errorf("claude callback: %v %v", info, ok)
	}
	if info, ok := consentInfo(c, "http://localhost:9/cb"); !ok || info["trusted"] != true {
		t.Errorf("loopback callback: %v %v", info, ok)
	}
	for name, u := range map[string]string{
		"javascript": "javascript:alert(1)//", "unregistered": "https://claude.ai/other", "evil": "https://evil.example/cb", "empty": "",
	} {
		if _, ok := consentInfo(c, u); ok {
			t.Errorf("%s must not be shown for approval", name)
		}
	}
	if _, ok := consentInfo(nil, "https://claude.ai/cb"); ok {
		t.Error("unknown client shown for approval")
	}
	// A client registered with an unlisted host (before the allowlist existed) is refused too.
	old := &database.OAuthClient{ClientID: "c2", RedirectURIs: []string{"https://evil.example/cb"}}
	if _, ok := consentInfo(old, "https://evil.example/cb"); ok {
		t.Error("legacy client with a disallowed host shown for approval")
	}
}
