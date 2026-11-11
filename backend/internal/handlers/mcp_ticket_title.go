package handlers

import (
	"regexp"
	"strings"
)

// leadingPriorityRe matches a priority code already sitting at the start of a
// title ("A3 ", "[P1] ", "Show-stopper "), so it can be replaced, not doubled.
var leadingPriorityRe = regexp.MustCompile(`(?i)^\[?(?:[PA]\d|show-?stopper|normal)\]?\s+`)

// buildTicketTitle shapes a ticket title as "<Priority> <Subsystem>: <Title>",
// e.g. "A3 FE MC: Fix login button". Any priority or subsystem prefix already
// on the title is removed first, so re-running it (or changing the priority on
// an edit) never stacks prefixes. oldSubsystems are extra subsystem names to
// strip, used on edits when the subsystem is being changed. "Normal" is the
// default priority and is left out of the title.
func buildTicketTitle(priority, subsystem, title string, oldSubsystems ...string) string {
	t := strings.TrimSpace(title)
	t = strings.TrimSpace(leadingPriorityRe.ReplaceAllString(t, ""))
	for _, s := range append([]string{subsystem}, oldSubsystems...) {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if p := s + ":"; len(t) >= len(p) && strings.EqualFold(t[:len(p)], p) {
			t = strings.TrimSpace(t[len(p):])
			break
		}
	}
	if t == "" {
		return strings.TrimSpace(title)
	}

	var b strings.Builder
	if p := strings.TrimSpace(priority); p != "" && !strings.EqualFold(p, "normal") {
		b.WriteString(p + " ")
	}
	if s := strings.TrimSpace(subsystem); s != "" {
		b.WriteString(s + ": ")
	}
	b.WriteString(t)
	return b.String()
}
