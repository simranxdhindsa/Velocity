package handlers

import "testing"

func TestBuildTicketTitle(t *testing.T) {
	cases := []struct {
		name, priority, subsystem, title string
		old                              []string
		want                             string
	}{
		{"plain", "A3", "FE MC", "Fix login button", nil, "A3 FE MC: Fix login button"},
		{"subsystem already in title", "A3", "FE MC", "FE MC: Fix login button", nil, "A3 FE MC: Fix login button"},
		{"full prefix already there", "A3", "FE MC", "A3 FE MC: Fix login button", nil, "A3 FE MC: Fix login button"},
		{"priority changed", "P1", "FE MC", "A3 FE MC: Fix login button", nil, "P1 FE MC: Fix login button"},
		{"bracketed priority", "P1", "FE MC", "[A3] FE MC: Fix login button", nil, "P1 FE MC: Fix login button"},
		{"subsystem changed", "A3", "BE MC", "A3 FE MC: Fix login button", []string{"FE MC"}, "A3 BE MC: Fix login button"},
		{"case-insensitive subsystem", "A2", "FE MC", "fe mc: Fix login button", nil, "A2 FE MC: Fix login button"},
		{"no subsystem", "A3", "", "Fix login button", nil, "A3 Fix login button"},
		{"no priority", "", "FE MC", "Fix login button", nil, "FE MC: Fix login button"},
		{"normal is left out", "Normal", "FE MC", "Fix login button", nil, "FE MC: Fix login button"},
		{"show-stopper", "Show-stopper", "Mobile", "App crashes on launch", nil, "Show-stopper Mobile: App crashes on launch"},
		{"title starting with a word like Pay is kept", "A1", "FE MC", "Payment page blank", nil, "A1 FE MC: Payment page blank"},
	}
	for _, c := range cases {
		if got := buildTicketTitle(c.priority, c.subsystem, c.title, c.old...); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
