package database

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"time"
)

type MCPTokenRepository struct{}

func NewMCPTokenRepository() *MCPTokenRepository {
	return &MCPTokenRepository{}
}

// MCPToken is one connected client's access token record. A user can have
// several of these (Claude, Codex, Gemini, ...) — each client gets its own
// row so that one connecting never invalidates another's session.
type MCPToken struct {
	ID         string
	UserID     string
	ClientID   string
	ClientName string
	CreatedAt  time.Time
	LastUsedAt *time.Time
}

// GenerateToken creates (or rotates) the token for one specific client on this
// user's account. Only that client's row is touched — other connected
// clients' tokens are untouched. Returns the plain-text token — shown once,
// never stored.
func (r *MCPTokenRepository) GenerateToken(ctx context.Context, userID, clientID, clientName string) (string, error) {
	pool := GetPool()
	if pool == nil {
		return "", fmt.Errorf("database not available")
	}
	if clientID == "" {
		clientID = "legacy"
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate token bytes: %w", err)
	}
	plain := base64.URLEncoding.EncodeToString(raw)
	hash := sha256sum(plain)

	_, err := pool.Exec(ctx, `
		INSERT INTO user_mcp_tokens (user_id, client_id, client_name, token_hash)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id, client_id) DO UPDATE
			SET token_hash   = EXCLUDED.token_hash,
			    client_name  = EXCLUDED.client_name,
			    created_at   = NOW(),
			    last_used_at = NULL
	`, userID, clientID, clientName, hash)
	if err != nil {
		return "", err
	}
	return plain, nil
}

// GetUserByToken resolves a plain-text token to a userID and records last_used_at.
// Returns "" if not found.
func (r *MCPTokenRepository) GetUserByToken(ctx context.Context, plain string) (string, error) {
	pool := GetPool()
	if pool == nil {
		return "", nil
	}
	hash := sha256sum(plain)
	var userID string
	err := pool.QueryRow(ctx, `
		UPDATE user_mcp_tokens
		SET last_used_at = NOW()
		WHERE token_hash = $1
		RETURNING user_id
	`, hash).Scan(&userID)
	if err != nil {
		return "", nil // not found
	}
	return userID, nil
}

// RevokeToken deletes one client's token for a user, leaving the user's other
// connected clients' sessions intact.
func (r *MCPTokenRepository) RevokeToken(ctx context.Context, userID, clientID string) error {
	pool := GetPool()
	if pool == nil {
		return nil
	}
	if clientID == "" {
		clientID = "legacy"
	}
	_, err := pool.Exec(ctx, `DELETE FROM user_mcp_tokens WHERE user_id = $1 AND client_id = $2`, userID, clientID)
	return err
}

// ListTokens returns metadata (no hashes) for every client connected to this
// user's account, newest first.
func (r *MCPTokenRepository) ListTokens(ctx context.Context, userID string) ([]MCPToken, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text, user_id, client_id, client_name, created_at, last_used_at
		FROM user_mcp_tokens WHERE user_id = $1
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []MCPToken
	for rows.Next() {
		var t MCPToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.ClientID, &t.ClientName, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func sha256sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
