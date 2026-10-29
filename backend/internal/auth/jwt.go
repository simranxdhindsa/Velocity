package auth

import (
	"errors"
	"log"
	"os"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/models"
	"github.com/golang-jwt/jwt/v5"
)

var (
	jwtSecret []byte
	jwtOnce   sync.Once
)

// getSecret returns the JWT signing key, initializing it lazily on first use.
// Lazy init is required because godotenv.Load() runs in main.go's init() which
// fires AFTER sub-package init() functions — so os.Getenv is empty during init().
func getSecret() []byte {
	jwtOnce.Do(func() {
		secret := os.Getenv("JWT_SECRET")
		if secret == "" {
			if os.Getenv("ENVIRONMENT") != "development" {
				log.Fatal("FATAL: JWT_SECRET environment variable must be set in production (min 32 chars)")
			}
			// Local development only — Dockerfile sets ENVIRONMENT=production so this never runs in deploys
			secret = "development-secret-key-change-in-production"
		}
		jwtSecret = []byte(secret)
	})
	return jwtSecret
}

// Token duration constants
const (
	ShortTokenDuration = 24 * time.Hour      // 1 day for non-remember-me
	LongTokenDuration  = 30 * 24 * time.Hour // 30 days for remember-me
)

// CustomClaims extends jwt.RegisteredClaims with user info
type CustomClaims struct {
	UserID     string      `json:"user_id"`
	Email      string      `json:"email"`
	Name       string      `json:"name"`
	Role       models.Role `json:"role"`
	RememberMe bool        `json:"remember_me"`
	jwt.RegisteredClaims
}

// GenerateToken creates a new JWT token for a user (default: 24 hours)
func GenerateToken(user *models.User) (string, error) {
	return GenerateTokenWithDuration(user, false)
}

// GenerateTokenWithDuration creates a JWT token with configurable duration
func GenerateTokenWithDuration(user *models.User, rememberMe bool) (string, error) {
	duration := ShortTokenDuration
	if rememberMe {
		duration = LongTokenDuration
	}

	claims := CustomClaims{
		UserID:     user.ID,
		Email:      user.Email,
		Name:       user.Name,
		Role:       user.Role,
		RememberMe: rememberMe,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(duration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Issuer:    "project-management",
			Subject:   user.ID,
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(getSecret())
}

// ValidateToken verifies a JWT token and returns the claims
func ValidateToken(tokenString string) (*CustomClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &CustomClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return getSecret(), nil
	})

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*CustomClaims); ok && token.Valid {
		return claims, nil
	}

	return nil, errors.New("invalid token")
}

// RefreshToken generates a new token if the current one is valid
// It preserves the remember_me setting from the original token
func RefreshToken(tokenString string) (string, error) {
	claims, err := ValidateToken(tokenString)
	if err != nil {
		return "", err
	}

	user := &models.User{
		ID:    claims.UserID,
		Email: claims.Email,
		Role:  claims.Role,
	}

	return GenerateTokenWithDuration(user, claims.RememberMe)
}

// GetTokenRemainingTime returns how much time is left before token expires
func GetTokenRemainingTime(tokenString string) (time.Duration, error) {
	claims, err := ValidateToken(tokenString)
	if err != nil {
		return 0, err
	}

	if claims.ExpiresAt == nil {
		return 0, errors.New("token has no expiration")
	}

	return time.Until(claims.ExpiresAt.Time), nil
}
