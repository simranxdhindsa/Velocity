package handlers

import (
	"testing"
)

// ============================================================
// Fuzzy Match Score Tests
// ============================================================

func TestFuzzyMatchScore_ExactMatch(t *testing.T) {
	score := fuzzyMatchScore("Fix login bug", "Fix login bug")
	if score != 1.0 {
		t.Errorf("Expected exact match score 1.0, got %f", score)
	}
}

func TestFuzzyMatchScore_CaseInsensitive(t *testing.T) {
	score := fuzzyMatchScore("Fix Login Bug", "fix login bug")
	if score != 1.0 {
		t.Errorf("Expected case-insensitive match score 1.0, got %f", score)
	}
}

func TestFuzzyMatchScore_SubstringMatch(t *testing.T) {
	score := fuzzyMatchScore("Fix login bug in auth module", "Fix login bug")
	if score < 0.7 {
		t.Errorf("Expected substring match score >= 0.7, got %f", score)
	}
}

func TestFuzzyMatchScore_EmptyString(t *testing.T) {
	score := fuzzyMatchScore("", "something")
	if score != 0 {
		t.Errorf("Expected 0 for empty string, got %f", score)
	}
	score = fuzzyMatchScore("something", "")
	if score != 0 {
		t.Errorf("Expected 0 for empty string, got %f", score)
	}
}

func TestFuzzyMatchScore_SimilarStrings(t *testing.T) {
	score := fuzzyMatchScore("Update user profile page", "Update user profile pages")
	if score < 0.7 {
		t.Errorf("Expected similar strings score >= 0.7, got %f", score)
	}
}

func TestFuzzyMatchScore_DissimilarStrings(t *testing.T) {
	score := fuzzyMatchScore("Fix login bug", "Deploy to production")
	if score >= 0.4 {
		t.Errorf("Expected dissimilar strings score < 0.4, got %f", score)
	}
}

func TestFuzzyMatchScore_WithPunctuation(t *testing.T) {
	score := fuzzyMatchScore("FE UI: Avatar Bug", "FE UI Avatar Bug")
	if score < 0.7 {
		t.Errorf("Expected match ignoring punctuation >= 0.7, got %f", score)
	}
}

func TestFuzzyMatchScore_WithDashesUnderscores(t *testing.T) {
	score := fuzzyMatchScore("fix-login-bug", "fix login bug")
	if score != 1.0 {
		t.Errorf("Expected dashes to equal spaces, score 1.0, got %f", score)
	}
	score = fuzzyMatchScore("fix_login_bug", "fix login bug")
	if score != 1.0 {
		t.Errorf("Expected underscores to equal spaces, score 1.0, got %f", score)
	}
}

// ============================================================
// Normalize Fuzzy Tests
// ============================================================

func TestNormalizeFuzzy(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"  Hello World  ", "hello world"},
		{"Hello-World", "hello world"},
		{"Hello_World", "hello world"},
		{"FE UI: Avatar Bug", "fe ui avatar bug"},
		{"Fix (urgent) bug!", "fix urgent bug"},
		{"", ""},
		{"  multiple   spaces  ", "multiple spaces"},
	}

	for _, tt := range tests {
		result := normalizeFuzzy(tt.input)
		if result != tt.expected {
			t.Errorf("normalizeFuzzy(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

// ============================================================
// Levenshtein Distance Tests
// ============================================================

func TestLevenshtein(t *testing.T) {
	tests := []struct {
		a, b     string
		expected int
	}{
		{"", "", 0},
		{"hello", "", 5},
		{"", "hello", 5},
		{"hello", "hello", 0},
		{"hello", "hallo", 1},
		{"kitten", "sitting", 3},
		{"sunday", "saturday", 3},
	}

	for _, tt := range tests {
		result := levenshtein(tt.a, tt.b)
		if result != tt.expected {
			t.Errorf("levenshtein(%q, %q) = %d, want %d", tt.a, tt.b, result, tt.expected)
		}
	}
}

// ============================================================
// State Index / Backward Movement Tests
// ============================================================

func TestGetStateIndex(t *testing.T) {
	tests := []struct {
		state    string
		expected int
	}{
		{"Open", 0},
		{"Backlog", 0},
		{"Submitted", 0},
		{"In Progress", 1},
		{"Blocked", 1},
		{"DEV", 2},
		{"Ready for Stage", 3},
		{"Stage", 4},
		{"Ready for PROD", 5},
		{"PROD", 6},
		{"Mobile Done", 6},
		{"Done", 7}, // past the full DEV → Stage → PROD pipeline
		{"Fixed", 7},
		{"Unknown", 0}, // default
	}

	for _, tt := range tests {
		result := getStateIndex(tt.state)
		if result != tt.expected {
			t.Errorf("getStateIndex(%q) = %d, want %d", tt.state, result, tt.expected)
		}
	}
}

func TestIsBackwardMove(t *testing.T) {
	tests := []struct {
		current  string
		proposed string
		backward bool
	}{
		{"DEV", "In Progress", true},       // DEV(2) -> In Progress(1) = backward
		{"Done", "Open", true},             // Done(3) -> Open(0) = backward
		{"Fixed", "In Progress", true},     // Fixed(3) -> In Progress(1) = backward
		{"DEV", "Open", true},              // DEV(2) -> Open(0) = backward
		{"Open", "In Progress", false},     // Open(0) -> In Progress(1) = forward
		{"In Progress", "DEV", false},      // In Progress(1) -> DEV(2) = forward
		{"DEV", "Done", false},             // DEV(2) -> Done(3) = forward
		{"Open", "Open", false},            // same state = not backward
		{"In Progress", "Blocked", false},  // same index(1) = not backward
	}

	for _, tt := range tests {
		result := isBackwardMove(tt.current, tt.proposed)
		if result != tt.backward {
			t.Errorf("isBackwardMove(%q, %q) = %v, want %v", tt.current, tt.proposed, result, tt.backward)
		}
	}
}

// ============================================================
// Priority Extraction Tests
// ============================================================

func TestExtractPriorityFromSummary(t *testing.T) {
	tests := []struct {
		summary      string
		expectedPri  string
		expectedTitle string
	}{
		{"P0 Critical server crash", "P0", "P0 Critical server crash"},
		{"P1 Fix login page", "P1", "P1 Fix login page"},
		{"P2 FE UI: Avatar Bug", "P2", "P2 FE UI: Avatar Bug"},
		{"P3 Update docs", "P3", "P3 Update docs"},
		{"Fix login page", "", "Fix login page"},          // no priority
		{"P4 Something", "", "P4 Something"},              // P4 not in range
		{"P2Fix without space", "", "P2Fix without space"}, // need space after P#
		{"", "", ""},                                       // empty
	}

	for _, tt := range tests {
		pri, title := extractPriorityFromSummary(tt.summary)
		if pri != tt.expectedPri {
			t.Errorf("extractPriorityFromSummary(%q) priority = %q, want %q", tt.summary, pri, tt.expectedPri)
		}
		if title != tt.expectedTitle {
			t.Errorf("extractPriorityFromSummary(%q) title = %q, want %q", tt.summary, title, tt.expectedTitle)
		}
	}
}

// ============================================================
// Min Helper Tests
// ============================================================

func TestMin(t *testing.T) {
	if min(3, 5) != 3 {
		t.Error("min(3,5) should be 3")
	}
	if min(5, 3) != 3 {
		t.Error("min(5,3) should be 3")
	}
	if min(3, 3) != 3 {
		t.Error("min(3,3) should be 3")
	}
	if min(-1, 0) != -1 {
		t.Error("min(-1,0) should be -1")
	}
}

// ============================================================
// Fuzzy Match Threshold Tests (40% threshold for matching)
// ============================================================

func TestFuzzyMatchThreshold(t *testing.T) {
	// These should match (>= 0.4)
	shouldMatch := []struct{ a, b string }{
		{"P2 FE UI: Avatar Bug", "FE UI Avatar Bug"},
		{"Fix authentication flow", "Fix auth flow"},
		{"Update user profile", "Update user profile page"},
	}
	for _, tt := range shouldMatch {
		score := fuzzyMatchScore(tt.a, tt.b)
		if score < 0.4 {
			t.Errorf("Expected %q and %q to match (score >= 0.4), got %f", tt.a, tt.b, score)
		}
	}

	// These should NOT match (< 0.4)
	shouldNotMatch := []struct{ a, b string }{
		{"Fix login bug", "Deploy production server"},
		{"Backend API refactor", "Frontend CSS styling"},
	}
	for _, tt := range shouldNotMatch {
		score := fuzzyMatchScore(tt.a, tt.b)
		if score >= 0.4 {
			t.Errorf("Expected %q and %q to NOT match (score < 0.4), got %f", tt.a, tt.b, score)
		}
	}
}
