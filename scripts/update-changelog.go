package main

// update-changelog: reads a commit-msg file and inserts a bullet into
// CHANGELOG.md under the correct date + section.
//
// Usage: go run scripts/update-changelog.go <commit-msg-file> <changelog-path>

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"
)

var sectionMap = map[string]string{
	"FEATURE":     "Features",
	"ENHANCEMENT": "Enhancements",
	"STYLE":       "Enhancements",
	"BUG":         "Bug Fixes",
	"REFACTOR":    "Refactors",
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: update-changelog <commit-msg-file> <changelog-path>")
		os.Exit(1)
	}
	msgFile := os.Args[1]
	changelogPath := os.Args[2]

	msg := firstLine(msgFile)
	section, body := classify(msg)
	if section == "" {
		return // not a tracked prefix — exit 0
	}

	today := time.Now().Format("2006-01-02")
	entry := "- " + body

	updated := insertEntry(readChangelog(changelogPath), today, section, entry)
	if err := os.WriteFile(changelogPath, []byte(updated), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "write changelog: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("changelog: [%s] %s — %s\n", today, section, entry)
}

func firstLine(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if sc.Scan() {
		return strings.TrimSpace(sc.Text())
	}
	return ""
}

func classify(msg string) (section, body string) {
	for prefix, sec := range sectionMap {
		tag := prefix + ": "
		if strings.HasPrefix(msg, tag) {
			return sec, strings.TrimSpace(strings.TrimPrefix(msg, tag))
		}
	}
	return "", ""
}

func readChangelog(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "# Changelog\n\nAll notable changes to Velocity are listed here. Most recent entries appear first.\n\n---\n"
	}
	// normalise CRLF → LF so index arithmetic works on Windows
	return strings.ReplaceAll(string(data), "\r\n", "\n")
}

// insertEntry places entry under section in today's date block,
// creating the block and/or section when absent.
func insertEntry(content, today, section, entry string) string {
	lines := strings.Split(content, "\n")
	dateLine := "## " + today
	sectionLine := "### " + section

	dateIdx := indexOfLine(lines, dateLine)

	if dateIdx == -1 {
		// No block for today — insert right after the first "---" separator
		insertAt := len(lines)
		for i, l := range lines {
			if strings.TrimSpace(l) == "---" {
				insertAt = i + 1
				break
			}
		}
		block := []string{"", dateLine, "", sectionLine, entry, "", "---"}
		return join(splice(lines, insertAt, block))
	}

	// Find where today's block ends (next ## heading or EOF)
	blockEnd := len(lines)
	for i := dateIdx + 1; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "## ") {
			blockEnd = i
			break
		}
	}

	// Look for the target section inside today's block
	secIdx := -1
	for i := dateIdx + 1; i < blockEnd; i++ {
		if strings.TrimSpace(lines[i]) == sectionLine {
			secIdx = i
			break
		}
	}

	if secIdx != -1 {
		// Section exists — insert entry right after its header
		return join(splice(lines, secIdx+1, []string{entry}))
	}

	// Section missing — add it before the block's trailing separator
	insertAt := blockEnd
	for insertAt > dateIdx+1 && strings.TrimSpace(lines[insertAt-1]) == "" {
		insertAt--
	}
	if insertAt > 0 && strings.TrimSpace(lines[insertAt-1]) == "---" {
		insertAt--
	}
	return join(splice(lines, insertAt, []string{"", sectionLine, entry}))
}

func indexOfLine(lines []string, target string) int {
	for i, l := range lines {
		if strings.TrimSpace(l) == target {
			return i
		}
	}
	return -1
}

func splice(s []string, at int, elems []string) []string {
	out := make([]string, 0, len(s)+len(elems))
	out = append(out, s[:at]...)
	out = append(out, elems...)
	out = append(out, s[at:]...)
	return out
}

func join(lines []string) string { return strings.Join(lines, "\n") }
