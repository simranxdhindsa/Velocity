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
// Codex) that listen on a local port. MCP_OAUTH_EXTRA_REDIRECT_HOSTS adds more (comma separated).
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
	for _, h := range hosts {
		if host == h || strings.HasSuffix(host, "."+h) {
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
