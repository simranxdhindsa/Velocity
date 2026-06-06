package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
)

// DeveloperConfigHandler handles developer-to-subsystem mapping CRUD.
type DeveloperConfigHandler struct{}

func NewDeveloperConfigHandler() *DeveloperConfigHandler {
	return &DeveloperConfigHandler{}
}

// GetDeveloperConfigs returns all developer-subsystem mappings.
func (h *DeveloperConfigHandler) GetDeveloperConfigs(w http.ResponseWriter, r *http.Request) {
	if middleware.GetUserID(r.Context()) == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	repo := database.NewDeveloperConfigRepository()
	configs, err := repo.GetAll(r.Context())
	if err != nil {
		http.Error(w, "Failed to load developer configs: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if configs == nil {
		configs = []*database.DeveloperSubsystemConfig{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": configs})
}

// SaveDeveloperConfigs bulk-upserts developer-subsystem mappings.
func (h *DeveloperConfigHandler) SaveDeveloperConfigs(w http.ResponseWriter, r *http.Request) {
	if middleware.GetUserID(r.Context()) == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	var configs []*database.DeveloperSubsystemConfig
	if err := json.NewDecoder(r.Body).Decode(&configs); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	repo := database.NewDeveloperConfigRepository()
	if err := repo.BulkSave(r.Context(), configs); err != nil {
		http.Error(w, "Failed to save developer configs: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}
