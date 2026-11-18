package handlers

import (
	"strings"
	"testing"

	"github.com/dhindsa/project-management/internal/database"
)

func TestTicketCreatorRole(t *testing.T) {
	cases := []struct {
		name string
		cfg  *database.DeveloperSubsystemConfig
		want string
	}{
		{"no config is QA", nil, ticketRoleQA},
		{"no subsystems is QA", &database.DeveloperSubsystemConfig{}, ticketRoleQA},
		{"QA flag wins over subsystems", &database.DeveloperSubsystemConfig{IsQA: true, Subsystems: []string{"FE MC"}}, ticketRoleQA},
		{"frontend developer", &database.DeveloperSubsystemConfig{Subsystems: []string{"FE MC"}}, ticketRoleDeveloper},
		{"backend developer", &database.DeveloperSubsystemConfig{Subsystems: []string{"BE MC", "BE UI"}}, ticketRoleDeveloper},
	}
	for _, c := range cases {
		if got := ticketCreatorRole(c.cfg); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestWithTestingSections(t *testing.T) {
	got := withTestingSections("Login button does nothing.", "- Click login with a valid user\n- Check logout still works", "")
	want := "Login button does nothing.\n\n## Testing Scenarios\n- Click login with a valid user\n- Check logout still works\n\n## Acceptance Criteria\n" + acceptancePendingNote
	if got != want {
		t.Fatalf("developer ticket:\n%s\nwant:\n%s", got, want)
	}
	got = withTestingSections("", "", " - User lands on the dashboard ")
	if !strings.HasPrefix(got, "## Testing Scenarios\n"+testingPendingNote) || !strings.HasSuffix(got, "## Acceptance Criteria\n- User lands on the dashboard") {
		t.Fatalf("QA ticket with no description:\n%s", got)
	}
}
