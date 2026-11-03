package handlers

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Rules for who may receive an MCP authorization code. Without them anyone could register a
// client whose redirect goes to their own server, send a signed-in teammate the authorize link,
// and receive a long-lived token for that teammate's account when they click Approve.

const (
	oauthMaxRedirects   = 5
	oauthMaxURILen      = 500
	oauthMaxClientName  = 100
	oauthRegisterBodyMB = 16 << 10
)

// Hosts allowed to receive codes. Loopback addresses cover desktop and CLI clients (Claude Code,
// Codex) that listen on a local port. MCP_OAUTH_EXTRA_REDIRECT_HOSTS adds more exact hosts (comma separated).
var oauthDefaultRedirectHosts = []string{"claude.ai", "claude.com"}

func oauthIsLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func oauthHostAllowed(host string) bool {
	host = strings.ToLower(host)
	hosts := append([]string{}, oauthDefaultRedirectHosts...)
	for _, h := range strings.Split(os.Getenv("MCP_OAUTH_EXTRA_REDIRECT_HOSTS"), ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			hosts = append(hosts, h)
		}
	}
	for _, h := range hosts { // exact match only: a lookalike or sibling subdomain must not qualify
		if host == h {
			return true
		}
	}
	return false
}

// validateRedirectURI accepts https URLs on an allowed host, or http on a loopback address.
// Fragments and embedded credentials are never allowed.
func validateRedirectURI(raw string) error {
	if raw == "" || len(raw) > oauthMaxURILen {
		return fmt.Errorf("redirect_uri is empty or too long")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Fragment != "" || u.User != nil {
		return fmt.Errorf("redirect_uri is not valid")
	}
	host := strings.ToLower(u.Hostname())
	switch u.Scheme {
	case "http":
		if !oauthIsLoopback(host) {
			return fmt.Errorf("http redirect_uri is only allowed for localhost")
		}
	case "https":
		if !oauthIsLoopback(host) && !oauthHostAllowed(host) {
			return fmt.Errorf("redirect_uri host %q is not allowed", host)
		}
	default:
		return fmt.Errorf("redirect_uri must be https")
	}
	return nil
}

func validateClientRegistration(name string, uris []string) error {
	if len(uris) == 0 || len(uris) > oauthMaxRedirects {
		return fmt.Errorf("between 1 and %d redirect_uris are required", oauthMaxRedirects)
	}
	if len([]rune(name)) > oauthMaxClientName {
		return fmt.Errorf("client_name is too long")
	}
	for _, u := range uris {
		if err := validateRedirectURI(u); err != nil {
			return err
		}
	}
	return nil
}

// oauthTrustedHost reports whether the redirect goes to Claude itself or to the user's own machine,
// the two places a normal connector sign-in ends up. Anything else gets a warning on the consent page.
func oauthTrustedHost(host string) bool {
	host = strings.ToLower(host)
	return oauthIsLoopback(host) || host == "claude.ai" || host == "claude.com"
}

// cleanClientName drops control characters and collapses spaces so a registered name cannot
// forge lines in logs or in the consent page.
func cleanClientName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}
