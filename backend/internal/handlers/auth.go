package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/auth"
	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	"github.com/google/uuid"
)

// Repositories for database operations
var userRepo = database.NewUserRepository()
var whitelistRepo = database.NewWhitelistRepository()

// In-memory user store (fallback when database is unavailable)
var users = make(map[string]*models.User)
var usersMu sync.RWMutex

// In-memory whitelist (fallback when database is unavailable)
var allowedEmails = map[string]models.Role{
	strings.ToLower(models.DefaultAdminEmail): models.RoleAdmin,
}
var allowedDomains = map[string]models.Role{
	"apyhub.com": models.RoleMember, // Allow all @apyhub.com users
}
var whitelistMu sync.RWMutex

// In-memory deny list — checked before allowlist; takes priority
var deniedEmails = map[string]struct{}{}
var deniedMu sync.RWMutex

// GoogleAuthRequest represents the request body for Google auth
type GoogleAuthRequest struct {
	Credential string `json:"credential"`  // ID token from Google Sign-In
	Code       string `json:"code"`        // Authorization code (alternative flow)
	RememberMe bool   `json:"remember_me"` // If true, token lasts 30 days
}

// Response helper
type Response struct {
	Success bool        `json:"success"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
}

func sendJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// isEmailDenied returns true if the email is on the deny list.
// The deny list is checked before the allowlist — a denied email is always blocked.
func isEmailDenied(email string) bool {
	email = strings.ToLower(email)

	// Default admin can never be denied
	if email == strings.ToLower(models.DefaultAdminEmail) {
		return false
	}

	// Check database first
	if database.GetPool() != nil {
		if whitelistRepo.IsEmailDenied(context.Background(), email) {
			return true
		}
	}

	// Fallback: in-memory deny list
	deniedMu.RLock()
	defer deniedMu.RUnlock()
	_, denied := deniedEmails[email]
	return denied
}

// AddDeniedEmail adds an email to the in-memory deny list
func AddDeniedEmail(email string) {
	deniedMu.Lock()
	defer deniedMu.Unlock()
	deniedEmails[strings.ToLower(email)] = struct{}{}
}

// RemoveDeniedEmail removes an email from the in-memory deny list
func RemoveDeniedEmail(email string) {
	deniedMu.Lock()
	defer deniedMu.Unlock()
	delete(deniedEmails, strings.ToLower(email))
}

// GetDeniedEmails returns a copy of the in-memory deny list
func GetDeniedEmails() []string {
	deniedMu.RLock()
	defer deniedMu.RUnlock()
	result := make([]string, 0, len(deniedEmails))
	for email := range deniedEmails {
		result = append(result, email)
	}
	return result
}

// isEmailAllowed checks if an email is in the whitelist
func isEmailAllowed(email string) (bool, models.Role) {
	email = strings.ToLower(email)

	// Always allow the default admin
	if email == strings.ToLower(models.DefaultAdminEmail) {
		return true, models.RoleAdmin
	}

	// Try database first if available
	if database.GetPool() != nil {
		allowed, role := whitelistRepo.IsEmailAllowed(context.Background(), email)
		if allowed {
			return true, role
		}
	}

	// Fallback to in-memory whitelist
	whitelistMu.RLock()
	defer whitelistMu.RUnlock()

	// Check exact email match
	if role, ok := allowedEmails[email]; ok {
		return true, role
	}

	// Check domain match
	parts := strings.Split(email, "@")
	if len(parts) == 2 {
		domain := parts[1]
		if role, ok := allowedDomains[domain]; ok {
			return true, role
		}
	}

	return false, ""
}

// AddAllowedEmail adds an email to the whitelist
func AddAllowedEmail(email string, role models.Role) {
	whitelistMu.Lock()
	defer whitelistMu.Unlock()
	allowedEmails[strings.ToLower(email)] = role
}

// RemoveAllowedEmail removes an email from the whitelist
func RemoveAllowedEmail(email string) bool {
	email = strings.ToLower(email)
	// Don't allow removing the default admin
	if email == strings.ToLower(models.DefaultAdminEmail) {
		return false
	}
	whitelistMu.Lock()
	defer whitelistMu.Unlock()
	delete(allowedEmails, email)
	return true
}

// AddAllowedDomain adds a domain to the whitelist
func AddAllowedDomain(domain string, role models.Role) {
	whitelistMu.Lock()
	defer whitelistMu.Unlock()
	allowedDomains[strings.ToLower(domain)] = role
}

// RemoveAllowedDomain removes a domain from the whitelist
func RemoveAllowedDomain(domain string) {
	whitelistMu.Lock()
	defer whitelistMu.Unlock()
	delete(allowedDomains, strings.ToLower(domain))
}

// GetAllowedEmails returns all allowed emails
func GetAllowedEmails() map[string]models.Role {
	whitelistMu.RLock()
	defer whitelistMu.RUnlock()
	result := make(map[string]models.Role)
	for k, v := range allowedEmails {
		result[k] = v
	}
	return result
}

// GetAllowedDomains returns all allowed domains
func GetAllowedDomains() map[string]models.Role {
	whitelistMu.RLock()
	defer whitelistMu.RUnlock()
	result := make(map[string]models.Role)
	for k, v := range allowedDomains {
		result[k] = v
	}
	return result
}

// HandleGoogleAuth handles Google OAuth authentication
func HandleGoogleAuth(w http.ResponseWriter, r *http.Request) {
	var req GoogleAuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body",
		})
		return
	}

	var googleUser *models.GoogleUserInfo
	var err error

	// Handle ID token (from Google Sign-In button)
	if req.Credential != "" {
		googleUser, err = auth.ValidateGoogleToken(req.Credential)
		if err != nil {
			sendJSON(w, http.StatusUnauthorized, Response{
				Success: false,
				Message: "Invalid Google token: " + err.Error(),
			})
			return
		}
	} else if req.Code != "" {
		// Handle authorization code flow
		accessToken, err := auth.ExchangeCodeForToken(req.Code)
		if err != nil {
			sendJSON(w, http.StatusUnauthorized, Response{
				Success: false,
				Message: "Failed to exchange code: " + err.Error(),
			})
			return
		}

		googleUser, err = auth.GetGoogleUserInfo(accessToken)
		if err != nil {
			sendJSON(w, http.StatusUnauthorized, Response{
				Success: false,
				Message: "Failed to get user info: " + err.Error(),
			})
			return
		}
	} else {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Either credential or code is required",
		})
		return
	}

	// Deny list is checked first — explicitly blocked users are always rejected
	if isEmailDenied(googleUser.Email) {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Your account has been blocked by an administrator. Please contact your administrator if you believe this is a mistake.",
		})
		return
	}

	// Check if email is allowed
	allowed, assignedRole := isEmailAllowed(googleUser.Email)
	if !allowed {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Access denied. Your email is not authorised to access this application. Please contact an administrator.",
		})
		return
	}

	var user *models.User
	ctx := r.Context()

	// Try database first if available
	if database.GetPool() != nil {
		// Try to find existing user
		existingUser, err := userRepo.GetByEmail(ctx, googleUser.Email)
		if err == nil {
			// Update existing user
			existingUser.Name = googleUser.Name
			existingUser.Picture = googleUser.Picture
			existingUser.UpdatedAt = time.Now()
			// Don't change role for existing users unless they're the default admin
			if strings.ToLower(googleUser.Email) == strings.ToLower(models.DefaultAdminEmail) {
				existingUser.Role = models.RoleAdmin
			}
			userRepo.Update(ctx, existingUser)
			user = existingUser
		} else {
			// Create new user with the role from whitelist
			user = &models.User{
				ID:        uuid.New().String(),
				Email:     googleUser.Email,
				Name:      googleUser.Name,
				Picture:   googleUser.Picture,
				Role:      assignedRole,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			}
			if err := userRepo.Create(ctx, user); err != nil {
				// Log error but continue with in-memory fallback
				user = nil
			}
		}
	}

	// Fallback to in-memory store
	if user == nil {
		usersMu.Lock()
		defer usersMu.Unlock()

		existingUser, exists := users[googleUser.Email]
		if !exists {
			// Create new user with the role from whitelist
			user = &models.User{
				ID:        uuid.New().String(),
				Email:     googleUser.Email,
				Name:      googleUser.Name,
				Picture:   googleUser.Picture,
				Role:      assignedRole,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			}
			users[googleUser.Email] = user
		} else {
			// Update existing user info
			existingUser.Name = googleUser.Name
			existingUser.Picture = googleUser.Picture
			existingUser.UpdatedAt = time.Now()
			// Don't change role for existing users unless they're the default admin
			if strings.ToLower(googleUser.Email) == strings.ToLower(models.DefaultAdminEmail) {
				existingUser.Role = models.RoleAdmin
			}
			user = existingUser
		}
	}

	// Generate JWT token with remember_me setting
	token, err := auth.GenerateTokenWithDuration(user, req.RememberMe)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to generate token",
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: models.AuthResponse{
			User:  user,
			Token: token,
		},
	})
}

// HandleGetMe returns the current authenticated user
func HandleGetMe(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{
			Success: false,
			Message: "Not authenticated",
		})
		return
	}

	var fullUser *models.User

	// Try database first if available
	if database.GetPool() != nil {
		dbUser, err := userRepo.GetByEmail(r.Context(), user.Email)
		if err == nil {
			fullUser = dbUser
		}
	}

	// Fallback to in-memory store
	if fullUser == nil {
		usersMu.RLock()
		memUser, exists := users[user.Email]
		usersMu.RUnlock()

		if !exists {
			sendJSON(w, http.StatusNotFound, Response{
				Success: false,
				Message: "User not found",
			})
			return
		}
		fullUser = memUser
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    fullUser,
	})
}

// HandleLogout handles user logout
func HandleLogout(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Logged out successfully",
	})
}

// HandleRefreshToken refreshes the JWT token, preserving the remember_me setting
func HandleRefreshToken(w http.ResponseWriter, r *http.Request) {
	// Get the original token from header to preserve remember_me setting
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		sendJSON(w, http.StatusUnauthorized, Response{
			Success: false,
			Message: "Authorization header required",
		})
		return
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		sendJSON(w, http.StatusUnauthorized, Response{
			Success: false,
			Message: "Invalid authorization format",
		})
		return
	}

	// Refresh the token - this preserves the remember_me setting and resets the timer
	newToken, err := auth.RefreshToken(parts[1])
	if err != nil {
		sendJSON(w, http.StatusUnauthorized, Response{
			Success: false,
			Message: "Failed to refresh token: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]string{
			"token": newToken,
		},
	})
}

// HandleGetAuthURL returns the Google OAuth URL
func HandleGetAuthURL(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	if state == "" {
		// Caller didn't pass a state — generate a random nonce so the OAuth round-trip
		// is always CSRF-protected. The frontend must echo this value back to validate it.
		state = uuid.NewString()
	}

	authURL := auth.GetGoogleAuthURL(state)

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]string{
			"url": authURL,
		},
	})
}
