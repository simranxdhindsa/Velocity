package middleware

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/dhindsa/project-management/internal/auth"
	"github.com/dhindsa/project-management/internal/models"
)

// ContextKey type for context values
type ContextKey string

const (
	// UserContextKey is the key for storing user info in context
	UserContextKey ContextKey = "user"
)

// AuthMiddleware validates JWT token and adds user info to context
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Primary: Authorization header. Fallback: ?token= query param for SSE/EventSource
		// (browsers cannot set custom headers on EventSource connections).
		var tokenString string
		authHeader := r.Header.Get("Authorization")
		if authHeader != "" {
			parts := strings.Split(authHeader, " ")
			if len(parts) != 2 || parts[0] != "Bearer" {
				http.Error(w, `{"success":false,"message":"Invalid authorization format"}`, http.StatusUnauthorized)
				return
			}
			tokenString = parts[1]
		} else if q := r.URL.Query().Get("token"); q != "" {
			tokenString = q
		} else {
			http.Error(w, `{"success":false,"message":"Authorization header required"}`, http.StatusUnauthorized)
			return
		}

		var user *models.User

		// Dev-mode bypass — only valid when ENVIRONMENT=development (local only).
		// Dockerfile sets ENVIRONMENT=production, so this is dead in any deployed build.
		if os.Getenv("ENVIRONMENT") == "development" && strings.HasPrefix(tokenString, "dev-mode-token-") {
			user = &models.User{
				ID:    "08938fa6-27b4-446f-a9aa-b8fe5c7b97c4",
				Email: "simranjot@apyhub.com",
				Name:  "Simranjot Singh",
				Role:  models.RoleAdmin,
			}
		} else {
			// Validate JWT token
			claims, err := auth.ValidateToken(tokenString)
			if err != nil {
				http.Error(w, `{"success":false,"message":"Invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			// Create user from claims
			user = &models.User{
				ID:    claims.UserID,
				Email: claims.Email,
				Name:  claims.Name,
				Role:  claims.Role,
			}
		}

		ctx := context.WithValue(r.Context(), UserContextKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetUserFromContext retrieves the user from request context
func GetUserFromContext(r *http.Request) *models.User {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		return nil
	}
	return user
}

// GetUserID retrieves the user ID from context
func GetUserID(ctx context.Context) string {
	user, ok := ctx.Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		return ""
	}
	return user.ID
}

// GetUserFromCtx retrieves the full user from context
func GetUserFromCtx(ctx context.Context) *models.User {
	user, ok := ctx.Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		return nil
	}
	return user
}

// RequireRole middleware checks if user has required role
func RequireRole(roles ...models.Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := GetUserFromContext(r)
			if user == nil {
				http.Error(w, `{"success":false,"message":"User not found in context"}`, http.StatusUnauthorized)
				return
			}

			// Check if user has any of the required roles
			hasRole := false
			for _, role := range roles {
				if user.Role == role {
					hasRole = true
					break
				}
			}

			if !hasRole {
				http.Error(w, `{"success":false,"message":"Insufficient permissions"}`, http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// AdminOnly is a convenience middleware for admin-only routes
func AdminOnly(next http.Handler) http.Handler {
	return RequireRole(models.RoleAdmin)(next)
}

// ManagerOrAbove allows admin and project managers
func ManagerOrAbove(next http.Handler) http.Handler {
	return RequireRole(models.RoleAdmin, models.RoleProjectManager)(next)
}
