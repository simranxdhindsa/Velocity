package database

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type OAuthRepository struct{}

func NewOAuthRepository() *OAuthRepository { return &OAuthRepository{} }

type OAuthClient struct {
	ClientID     string
	ClientName   string
	RedirectURIs []string
	CreatedAt    time.Time
}

func (r *OAuthRepository) RegisterClient(ctx context.Context, name string, redirectURIs []string) (*OAuthClient, error) {
	pool := GetPool()
	if pool == nil {
		return nil, fmt.Errorf("database not available")
	}
	id := oauthRandHex(16)
	uriBytes, _ := json.Marshal(redirectURIs)
	_, err := pool.Exec(ctx, `
		INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris)
		VALUES ($1, $2, $3)
	`, id, name, string(uriBytes))
	if err != nil {
		return nil, err
	}
	return &OAuthClient{ClientID: id, ClientName: name, RedirectURIs: redirectURIs, CreatedAt: time.Now()}, nil
}

func (r *OAuthRepository) GetClient(ctx context.Context, clientID string) (*OAuthClient, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	var c OAuthClient
	var uriJSON string
	err := pool.QueryRow(ctx, `
		SELECT client_id, client_name, redirect_uris::text, created_at
		FROM mcp_oauth_clients WHERE client_id = $1
	`, clientID).Scan(&c.ClientID, &c.ClientName, &uriJSON, &c.CreatedAt)
	if err != nil {
		return nil, nil
	}
	_ = json.Unmarshal([]byte(uriJSON), &c.RedirectURIs)
	return &c, nil
}

func (r *OAuthRepository) CreateCode(ctx context.Context, userID, clientID, redirectURI, challenge, method string) (string, error) {
	pool := GetPool()
	if pool == nil {
		return "", fmt.Errorf("database not available")
	}
	code := oauthRandHex(24)
	expires := time.Now().Add(5 * time.Minute)
	_, err := pool.Exec(ctx, `
		INSERT INTO mcp_oauth_codes (code, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, code, userID, clientID, redirectURI, challenge, method, expires)
	if err != nil {
		return "", err
	}
	return code, nil
}

// ConsumeCode atomically marks the code used and verifies PKCE. Returns the user_id.
// The UPDATE...WHERE...RETURNING prevents TOCTOU replay: two simultaneous exchanges
// both try to flip used from FALSE to TRUE; only one succeeds.
func (r *OAuthRepository) ConsumeCode(ctx context.Context, code, clientID, redirectURI, verifier string) (string, error) {
	pool := GetPool()
	if pool == nil {
		return "", fmt.Errorf("database not available")
	}

	var userID, challenge, method string
	// Atomically claim the code — only succeeds if not yet used and not expired.
	err := pool.QueryRow(ctx, `
		UPDATE mcp_oauth_codes
		SET used = TRUE
		WHERE code = $1 AND client_id = $2 AND redirect_uri = $3
		  AND used = FALSE AND expires_at > NOW()
		RETURNING user_id, code_challenge, code_challenge_method
	`, code, clientID, redirectURI).Scan(&userID, &challenge, &method)
	if err != nil {
		return "", fmt.Errorf("invalid_grant")
	}

	// Verify PKCE S256
	if challenge != "" {
		if !strings.EqualFold(method, "S256") {
			return "", fmt.Errorf("invalid_grant")
		}
		h := sha256.Sum256([]byte(verifier))
		computed := base64.RawURLEncoding.EncodeToString(h[:])
		if computed != challenge {
			return "", fmt.Errorf("invalid_grant")
		}
	}
	return userID, nil
}

func oauthRandHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}
