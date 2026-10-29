package youtrack

import (
	"regexp"
	"strings"
)

// VelocityFooter is the signature line stamped at the bottom of every ticket
// created through Velocity's MCP, like a GitHub PR's "Resolves #123" line.
const VelocityFooter = "#Created by [Velocity](https://velocity.apyverse.dev) 🤖"

// footerSpacer is an empty paragraph above the footer. YouTrack collapses a
// plain blank line into normal paragraph spacing, so "&nbsp;" makes the gap
// visible.
const footerSpacer = "&nbsp;"

// footerLineRe matches the footer line, including copies an AI agent may
// have reworded or wrapped in markdown (e.g. "_created by velocity_").
var footerLineRe = regexp.MustCompile(`(?i)^[\s*_>~#-]*created by \[?velocity(?:[^a-z0-9]|$).*$`)

// HasVelocityFooter reports whether a description carries the footer.
func HasVelocityFooter(desc string) bool {
	for _, line := range strings.Split(desc, "\n") {
		if footerLineRe.MatchString(strings.TrimSpace(line)) {
			return true
		}
	}
	return false
}

// StripVelocityFooter removes every footer line and the trailing whitespace
// left behind.
func StripVelocityFooter(desc string) string {
	lines := strings.Split(desc, "\n")
	var kept []string
	afterFooter := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if footerLineRe.MatchString(trimmed) {
			// Drop the blank line(s) and spacer that separated the footer from the body.
			for len(kept) > 0 && isFooterGap(kept[len(kept)-1]) {
				kept = kept[:len(kept)-1]
			}
			afterFooter = true
			continue
		}
		if afterFooter {
			if trimmed == "" {
				continue
			}
			if len(kept) > 0 {
				kept = append(kept, "")
			}
			afterFooter = false
		}
		kept = append(kept, line)
	}
	return strings.TrimRight(strings.Join(kept, "\n"), " \t\r\n")
}

func isFooterGap(line string) bool {
	t := strings.TrimSpace(line)
	return t == "" || t == footerSpacer
}

// WithVelocityFooter returns desc with exactly one footer at the very end,
// separated from the body by one visible blank line.
func WithVelocityFooter(desc string) string {
	body := StripVelocityFooter(desc)
	if body == "" {
		return VelocityFooter
	}
	return body + "\n\n" + footerSpacer + "\n\n" + VelocityFooter
}
