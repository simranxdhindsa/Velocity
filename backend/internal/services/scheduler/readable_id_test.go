package scheduler

import (
	"testing"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

func TestReadableIssueID(t *testing.T) {
	if got := readableIssueID(youtrack.Issue{ID: "3-7279", IDReadable: "ARD-7279"}); got != "ARD-7279" {
		t.Fatalf("got %q, want ARD-7279", got)
	}
	if got := readableIssueID(youtrack.Issue{ID: "3-7279"}); got != "3-7279" {
		t.Fatalf("fallback: got %q", got)
	}
}
