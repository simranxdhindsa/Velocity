package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	"github.com/gorilla/mux"
)

// WhitelistHandler handles whitelist management API requests
type WhitelistHandler struct{}

// NewWhitelistHandler creates a new whitelist handler
func NewWhitelistHandler() *WhitelistHandler {
	return &WhitelistHandler{}
}

// AllowedEmailResponse represents an allowed email in the response
type AllowedEmailResponse struct {
	Email     string      `json:"email"`
	Role      models.Role `json:"role"`
	IsDefault bool        `json:"is_default"`
	AddedAt   time.Time   `json:"added_at,omitempty"`
}

// AllowedDomainResponse represents an allowed domain in the response
type AllowedDomainResponse struct {
	Domain  string      `json:"domain"`
	Role    models.Role `json:"role"`
	AddedAt time.Time   `json:"added_at,omitempty"`
}

// GetAllowedEmailsHandler returns all allowed emails
func (h *WhitelistHandler) GetAllowedEmailsHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Admin access required",
		})
		return
	}

	emails := GetAllowedEmails()
	result := make([]AllowedEmailResponse, 0, len(emails))

	for email, role := range emails {
		result = append(result, AllowedEmailResponse{
			Email:     email,
			Role:      role,
			IsDefault: strings.ToLower(email) == strings.ToLower(models.DefaultAdminEmail),
		})
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    result,
	})
}

// AddAllowedEmailHandler adds an email to the whitelist
func (h *WhitelistHandler) AddAllowedEmailHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Admin access required",
		})
		return
	}

	var req struct {
		Email string      `json:"email"`
		Role  models.Role `json:"role"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body",
		})
		return
	}

	if req.Email == "" {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Email is required",
		})
		return
	}

	// Validate email format
	if !strings.Contains(req.Email, "@") {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid email format",
		})
		return
	}

	// Default role to member
	if req.Role == "" {
		req.Role = models.RoleMember
	}

	// Validate role
	validRoles := map[models.Role]bool{
		models.RoleAdmin:          true,
		models.RoleProjectManager: true,
		models.RoleMember:         true,
		models.RoleViewer:         true,
	}
	if !validRoles[req.Role] {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid role. Valid roles: admin, project_manager, member, viewer",
		})
		return
	}

	AddAllowedEmail(req.Email, req.Role)

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Email added to whitelist",
		Data: AllowedEmailResponse{
			Email:     strings.ToLower(req.Email),
			Role:      req.Role,
			IsDefault: false,
		},
	})
}

// RemoveAllowedEmailHandler removes an email from the whitelist
func (h *WhitelistHandler) RemoveAllowedEmailHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Admin access required",
		})
		return
	}

	vars := mux.Vars(r)
	email := vars["email"]

	if email == "" {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Email is required",
		})
		return
	}

	// Check if it's the default admin
	if strings.ToLower(email) == strings.ToLower(models.DefaultAdminEmail) {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Cannot remove the default administrator email",
		})
		return
	}

	if !RemoveAllowedEmail(email) {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Failed to remove email",
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Email removed from whitelist",
	})
}

// GetAllowedDomainsHandler returns all allowed domains
func (h *WhitelistHandler) GetAllowedDomainsHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Admin access required",
		})
		return
	}

	domains := GetAllowedDomains()
	result := make([]AllowedDomainResponse, 0, len(domains))

	for domain, role := range domains {
		result = append(result, AllowedDomainResponse{
			Domain: domain,
			Role:   role,
		})
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    result,
	})
}

// AddAllowedDomainHandler adds a domain to the whitelist
func (h *WhitelistHandler) AddAllowedDomainHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Admin access required",
		})
		return
	}

	var req struct {
		Domain string      `json:"domain"`
		Role   models.Role `json:"role"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body",
		})
		return
	}

	if req.Domain == "" {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Domain is required",
		})
		return
	}

	// Remove @ if present
	req.Domain = strings.TrimPrefix(req.Domain, "@")

	// Default role to member
	if req.Role == "" {
		req.Role = models.RoleMember
	}

	AddAllowedDomain(req.Domain, req.Role)

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Domain added to whitelist",
		Data: AllowedDomainResponse{
			Domain: strings.ToLower(req.Domain),
			Role:   req.Role,
		},
	})
}

// RemoveAllowedDomainHandler removes a domain from the whitelist
func (h *WhitelistHandler) RemoveAllowedDomainHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Admin access required",
		})
		return
	}

	vars := mux.Vars(r)
	domain := vars["domain"]

	if domain == "" {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Domain is required",
		})
		return
	}

	RemoveAllowedDomain(domain)

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Domain removed from whitelist",
	})
}

// GetDeniedEmailsHandler returns all denied emails
func (h *WhitelistHandler) GetDeniedEmailsHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{Success: false, Message: "Admin access required"})
		return
	}

	// Prefer DB list; fall back to in-memory
	if database.GetPool() != nil {
		list, err := whitelistRepo.GetDeniedEmails(r.Context())
		if err == nil {
			if list == nil {
				list = []map[string]interface{}{}
			}
			sendJSON(w, http.StatusOK, Response{Success: true, Data: list})
			return
		}
	}

	// In-memory fallback
	emails := GetDeniedEmails()
	result := make([]map[string]interface{}, 0, len(emails))
	for _, e := range emails {
		result = append(result, map[string]interface{}{"email": e, "reason": ""})
	}
	sendJSON(w, http.StatusOK, Response{Success: true, Data: result})
}

// AddDeniedEmailHandler adds an email to the deny list
func (h *WhitelistHandler) AddDeniedEmailHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{Success: false, Message: "Admin access required"})
		return
	}

	var req struct {
		Email  string `json:"email"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "Valid email required"})
		return
	}

	// Cannot deny the default admin
	if strings.ToLower(req.Email) == strings.ToLower(models.DefaultAdminEmail) {
		sendJSON(w, http.StatusForbidden, Response{Success: false, Message: "Cannot block the default administrator"})
		return
	}

	AddDeniedEmail(req.Email)
	if database.GetPool() != nil {
		_ = whitelistRepo.AddDeniedEmail(r.Context(), req.Email, req.Reason, user.Email)
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Email blocked",
		Data:    map[string]string{"email": strings.ToLower(req.Email), "reason": req.Reason},
	})
}

// RemoveDeniedEmailHandler removes an email from the deny list
func (h *WhitelistHandler) RemoveDeniedEmailHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{Success: false, Message: "Admin access required"})
		return
	}

	vars := mux.Vars(r)
	email := vars["email"]
	if email == "" {
		sendJSON(w, http.StatusBadRequest, Response{Success: false, Message: "Email required"})
		return
	}

	RemoveDeniedEmail(email)
	if database.GetPool() != nil {
		_ = whitelistRepo.RemoveDeniedEmail(r.Context(), email)
	}

	sendJSON(w, http.StatusOK, Response{Success: true, Message: "Email unblocked"})
}

// GetWhitelistSettingsHandler returns the current whitelist settings including the deny list
func (h *WhitelistHandler) GetWhitelistSettingsHandler(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil || user.Role != models.RoleAdmin {
		sendJSON(w, http.StatusForbidden, Response{
			Success: false,
			Message: "Admin access required",
		})
		return
	}

	emails := GetAllowedEmails()
	domains := GetAllowedDomains()

	emailsList := make([]AllowedEmailResponse, 0, len(emails))
	for email, role := range emails {
		emailsList = append(emailsList, AllowedEmailResponse{
			Email:     email,
			Role:      role,
			IsDefault: strings.ToLower(email) == strings.ToLower(models.DefaultAdminEmail),
		})
	}

	domainsList := make([]AllowedDomainResponse, 0, len(domains))
	for domain, role := range domains {
		domainsList = append(domainsList, AllowedDomainResponse{
			Domain: domain,
			Role:   role,
		})
	}

	// Fetch deny list
	var deniedList []map[string]interface{}
	if database.GetPool() != nil {
		if list, err := whitelistRepo.GetDeniedEmails(r.Context()); err == nil && list != nil {
			deniedList = list
		}
	}
	if deniedList == nil {
		inMem := GetDeniedEmails()
		deniedList = make([]map[string]interface{}, 0, len(inMem))
		for _, e := range inMem {
			deniedList = append(deniedList, map[string]interface{}{"email": e, "reason": ""})
		}
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"default_admin_email": models.DefaultAdminEmail,
			"allowed_emails":      emailsList,
			"allowed_domains":     domainsList,
			"denied_emails":       deniedList,
		},
	})
}
