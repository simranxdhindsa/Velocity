package handlers

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
)

// ChangelogEntry represents one dated release block in CHANGELOG.md
type ChangelogEntry struct {
	Date         string   `json:"date"`
	Features     []string `json:"features"`
	Enhancements []string `json:"enhancements"`
	Bugs         []string `json:"bugs"`
	Refactors    []string `json:"refactors"`
}

// ChangelogStatus is the response for GET /api/changelog/status
type ChangelogStatus struct {
	HasNew     bool             `json:"has_new"`
	LatestDate string           `json:"latest_date"`
	Entries    []ChangelogEntry `json:"entries"`
}

// ChangelogHandler handles changelog endpoints
type ChangelogHandler struct {
	changelogPath string
}

func NewChangelogHandler() *ChangelogHandler {
	return &ChangelogHandler{changelogPath: findChangelogPath()}
}

// findChangelogPath searches several candidate locations for CHANGELOG.md so
// the handler works both in local dev (air running from backend/) and on Render
// (where the binary may run from a different working directory).
func findChangelogPath() string {
	// Honour an explicit env override first.
	if v := os.Getenv("CHANGELOG_PATH"); v != "" {
		return v
	}

	candidates := []string{
		filepath.Join(".", "..", "CHANGELOG.md"), // air from backend/
		filepath.Join(".", "CHANGELOG.md"),        // running from repo root
	}

	// Also search relative to the running binary's location.
	if exe, err := os.Executable(); err == nil {
		exe, _ = filepath.EvalSymlinks(exe)
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "..", "CHANGELOG.md"),       // binary inside backend/
			filepath.Join(dir, "CHANGELOG.md"),              // binary at repo root
			filepath.Join(dir, "..", "..", "CHANGELOG.md"), // binary inside backend/bin/
		)
	}

	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	// Return the most-likely path even if it doesn't exist yet — error surfaces
	// at request time with a clear HTTP 500 rather than silently at startup.
	return filepath.Join(".", "..", "CHANGELOG.md")
}

// GetStatus returns parsed changelog entries and whether the user has unseen entries.
func (h *ChangelogHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	all, err := h.parseChangelog()
	if err != nil {
		http.Error(w, "failed to read changelog", http.StatusInternalServerError)
		return
	}

	// Only surface the last 30 days of entries in the panel.
	cutoff := time.Now().UTC().AddDate(0, 0, -30).Format("2006-01-02")
	var entries []ChangelogEntry
	for _, e := range all {
		if e.Date >= cutoff {
			entries = append(entries, e)
		}
	}

	var seenAt *time.Time
	row := database.GetPool().QueryRow(r.Context(),
		`SELECT changelog_seen_at FROM users WHERE id = $1`, userID)
	var t time.Time
	if err := row.Scan(&t); err == nil {
		seenAt = &t
	}

	hasNew := false
	latestDate := ""
	if len(entries) > 0 {
		latestDate = entries[0].Date
		if seenAt == nil {
			hasNew = true
		} else {
			// Compare date strings only — avoids false negatives when seen_at
			// timestamp is later in the same day as the latest entry date.
			seenDay := seenAt.UTC().Format("2006-01-02")
			hasNew = latestDate > seenDay
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ChangelogStatus{
		HasNew:     hasNew,
		LatestDate: latestDate,
		Entries:    entries,
	})
}

// ResetSeen clears the user's seen state so the dot reappears (dev/testing use).
func (h *ChangelogHandler) ResetSeen(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	_, err := database.GetPool().Exec(r.Context(),
		`UPDATE users SET changelog_seen_at = NULL WHERE id = $1`, userID)
	if err != nil {
		http.Error(w, "failed to reset seen state", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// MarkSeen records that the current user has seen the changelog now.
func (h *ChangelogHandler) MarkSeen(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	_, err := database.GetPool().Exec(r.Context(),
		`UPDATE users SET changelog_seen_at = NOW() WHERE id = $1`, userID)
	if err != nil {
		http.Error(w, "failed to update seen state", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

var dateHeader = regexp.MustCompile(`^## (\d{4}-\d{2}-\d{2})`)

// parseChangelog reads and parses CHANGELOG.md into structured entries.
func (h *ChangelogHandler) parseChangelog() ([]ChangelogEntry, error) {
	f, err := os.Open(h.changelogPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var entries []ChangelogEntry
	var current *ChangelogEntry
	var section string // "features" | "enhancements" | "bugs" | "refactors"

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()

		if m := dateHeader.FindStringSubmatch(line); m != nil {
			if current != nil {
				entries = append(entries, *current)
			}
			current = &ChangelogEntry{Date: m[1]}
			section = ""
			continue
		}

		if current == nil {
			continue
		}

		lower := strings.ToLower(line)
		switch {
		case strings.HasPrefix(lower, "### feature"):
			section = "features"
		case strings.HasPrefix(lower, "### enhancement"):
			section = "enhancements"
		case strings.HasPrefix(lower, "### bug"):
			section = "bugs"
		case strings.HasPrefix(lower, "### refactor"):
			section = "refactors"
		case strings.HasPrefix(line, "- "):
			item := strings.TrimPrefix(line, "- ")
			switch section {
			case "features":
				current.Features = append(current.Features, item)
			case "enhancements":
				current.Enhancements = append(current.Enhancements, item)
			case "bugs":
				current.Bugs = append(current.Bugs, item)
			case "refactors":
				current.Refactors = append(current.Refactors, item)
			}
		}
	}

	if current != nil {
		entries = append(entries, *current)
	}

	return entries, scanner.Err()
}
