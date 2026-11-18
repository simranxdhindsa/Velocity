package handlers

import (
	"context"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// Who fills what on a new ticket: developers write the testing scenarios
// (they know what their code can affect), QA writes the acceptance criteria.
const (
	ticketRoleDeveloper = "developer"
	ticketRoleQA        = "qa"

	testingPendingNote    = "_Pending from the developer._"
	acceptancePendingNote = "_Pending from QA._"
)

// ticketCreatorRole: the QA flag wins, anyone owning a subsystem is a developer,
// and someone with no subsystems (or no config at all) is treated as QA.
func ticketCreatorRole(cfg *database.DeveloperSubsystemConfig) string {
	if cfg == nil || cfg.IsQA || len(cfg.Subsystems) == 0 {
		return ticketRoleQA
	}
	return ticketRoleDeveloper
}

// withTestingSections appends the Testing Scenarios and Acceptance Criteria
// sections, with a pending note for whichever one is still missing.
func withTestingSections(desc, testing, acceptance string) string {
	section := func(title, body, pending string) string {
		if body = strings.TrimSpace(body); body == "" {
			body = pending
		}
		return "## " + title + "\n" + body
	}
	parts := []string{}
	if d := strings.TrimSpace(desc); d != "" {
		parts = append(parts, d)
	}
	parts = append(parts,
		section("Testing Scenarios", testing, testingPendingNote),
		section("Acceptance Criteria", acceptance, acceptancePendingNote))
	return strings.Join(parts, "\n\n")
}

// mcpCallerYouTrackUser finds the caller in YouTrack. With a personal token
// /api/users/me is the caller; with shared credentials it is the token owner,
// so match the Velocity email against YouTrack users instead.
func mcpCallerYouTrackUser(ctx context.Context, yt *youtrack.Client, personal bool, email string) (*youtrack.User, string) {
	if personal {
		if u, err := yt.GetCurrentUser(ctx); err == nil && u != nil {
			return u, "personal token (/api/users/me)"
		}
	}
	if users, err := yt.GetUsers(ctx); err == nil {
		for i := range users {
			if users[i].Email != "" && strings.EqualFold(users[i].Email, email) {
				return &users[i], "email match against YouTrack users"
			}
		}
	}
	return nil, ""
}

// mcpDevConfigFor returns the developer config row for a YouTrack login, or nil.
func mcpDevConfigFor(ctx context.Context, login string) *database.DeveloperSubsystemConfig {
	cfgs, err := devConfigRepo.GetAll(ctx)
	if err != nil {
		return nil
	}
	for _, c := range cfgs {
		if strings.EqualFold(c.DeveloperLogin, login) {
			return c
		}
	}
	return nil
}

// mcpCallerTicketRole works out whether the caller files tickets as a developer or QA.
func mcpCallerTicketRole(ctx context.Context, yt *youtrack.Client, userID string) string {
	user, err := mcpUserRepo.GetByID(ctx, userID)
	if err != nil || user == nil {
		return ticketRoleQA
	}
	integ, iErr := mcpSettingsRepo.GetYouTrackIntegration(ctx, userID)
	personal := iErr == nil && integ != nil && integ.Connected
	me, _ := mcpCallerYouTrackUser(ctx, yt, personal, user.Email)
	if me == nil {
		return ticketRoleQA
	}
	return ticketCreatorRole(mcpDevConfigFor(ctx, me.Login))
}

// qaReviewers returns the configured QA people.
func qaReviewers(ctx context.Context) []*database.DeveloperSubsystemConfig {
	cfgs, err := devConfigRepo.GetAll(ctx)
	if err != nil {
		return nil
	}
	var qa []*database.DeveloperSubsystemConfig
	for _, c := range cfgs {
		if c.IsQA && c.DeveloperLogin != "" {
			qa = append(qa, c)
		}
	}
	return qa
}
