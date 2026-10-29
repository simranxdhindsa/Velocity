package slack

import (
	"strings"
	"testing"
)

func TestBuildSendParts_NoTable(t *testing.T) {
	msg := "Hey @Simran, just a plain reminder with *bold* and _italic_ text, no table here."
	parts := BuildSendParts(msg)
	if len(parts) != 1 {
		t.Fatalf("expected 1 part, got %d", len(parts))
	}
	if parts[0].Blocks != nil {
		t.Fatalf("expected no blocks for a plain message, got %d blocks", len(parts[0].Blocks))
	}
	if parts[0].Text != msg {
		t.Fatalf("expected text unchanged, got %q", parts[0].Text)
	}
}

func TestBuildSendParts_TableBecomesNativeTableBlock(t *testing.T) {
	msg := strings.Join([]string{
		"📋 *Daily Update — ARDOISE* (30 Sep 2026, Wednesday)",
		"",
		"| Section | Details |",
		"|:---|:---|",
		"| **🔷 <@U123>** | |",
		"| ⏳ *In Progress* | — |",
		"| 🧪 *Flow Tested* | Studio flows |",
		"",
		"✅ *All members submitted their updates today.*",
	}, "\n")

	parts := BuildSendParts(msg)
	if len(parts) != 1 {
		t.Fatalf("expected a single message, got %d", len(parts))
	}
	blocks := parts[0].Blocks
	if len(blocks) != 3 {
		t.Fatalf("expected [markdown header, table, markdown footer] = 3 blocks, got %d: %+v", len(blocks), blocks)
	}
	if blocks[0]["type"] != "markdown" {
		t.Errorf("expected first block to be markdown (header line), got %v", blocks[0]["type"])
	}
	if blocks[1]["type"] != "table" {
		t.Fatalf("expected second block to be a native table, got %v", blocks[1]["type"])
	}
	if blocks[2]["type"] != "markdown" {
		t.Errorf("expected third block to be markdown (footer line), got %v", blocks[2]["type"])
	}

	rows, ok := blocks[1]["rows"].([]interface{})
	if !ok || len(rows) != 4 { // header + 3 data rows (name, in-progress, flow tested)
		t.Fatalf("expected 4 table rows (header + 3 data), got %v", blocks[1]["rows"])
	}

	// First data row's first cell should contain a bold text run and a user mention.
	nameRow := rows[1].([]interface{})
	nameCell := nameRow[0].(map[string]interface{})
	els := nameCell["elements"].([]map[string]interface{})[0]["elements"].([]map[string]interface{})
	var sawBoldText, sawMention bool
	for _, el := range els {
		if el["type"] == "text" {
			if style, ok := el["style"].(map[string]interface{}); ok && style["bold"] == true {
				sawBoldText = true
			}
		}
		if el["type"] == "user" && el["user_id"] == "U123" {
			sawMention = true
		}
	}
	if !sawBoldText {
		t.Error("expected a bold text run in the name cell")
	}
	if !sawMention {
		t.Error("expected a real user mention element for <@U123>, not literal text")
	}

	// Pipes and ** markers must never leak through as literal text anywhere.
	var dump func(v interface{}) string
	dump = func(v interface{}) string {
		switch x := v.(type) {
		case map[string]interface{}:
			s := ""
			for _, vv := range x {
				s += dump(vv)
			}
			return s
		case []interface{}:
			s := ""
			for _, vv := range x {
				s += dump(vv)
			}
			return s
		case []map[string]interface{}:
			s := ""
			for _, vv := range x {
				s += dump(vv)
			}
			return s
		case string:
			return x
		}
		return ""
	}
	full := dump(blocks[1])
	if strings.Contains(full, "**") {
		t.Error("literal ** markers should not survive into the table block")
	}
}

func TestBuildSendParts_LongPlainTextSplitsInsteadOfTruncating(t *testing.T) {
	line := strings.Repeat("a", 100) + "\n"
	var sb strings.Builder
	for i := 0; i < 50; i++ { // ~5050 chars, over the 3800 limit
		sb.WriteString(line)
	}
	msg := sb.String()

	parts := BuildSendParts(msg)
	if len(parts) < 2 {
		t.Fatalf("expected the long message to split into multiple parts, got %d", len(parts))
	}
	for _, p := range parts {
		if strings.Contains(p.Text, "truncated") {
			t.Error("expected split messages, not a truncation notice")
		}
	}
	var combined strings.Builder
	for _, p := range parts {
		combined.WriteString(strings.TrimPrefix(p.Text, "_(continued)_\n\n"))
	}
	if strings.Count(combined.String(), "a") != strings.Count(msg, "a") {
		t.Error("expected no content loss when splitting long plain text")
	}
}

func TestBuildSendParts_LargeTableSplitsAtSpacerBoundary(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("| Section | Details |\n|:---|:---|\n")
	for person := 0; person < 40; person++ {
		sb.WriteString("| **🔷 @Person** | item |\n")
		sb.WriteString("| ⏳ *In Progress* | item |\n")
		sb.WriteString("|  |  |\n") // spacer
	}
	msg := sb.String()

	parts := BuildSendParts(msg)
	var tableBlockCount int
	for _, p := range parts {
		for _, b := range p.Blocks {
			if b["type"] == "table" {
				tableBlockCount++
				rows := b["rows"].([]interface{})
				if len(rows) > maxTableRowsPerBlock+1 { // +1 for repeated header
					t.Errorf("table block exceeds row cap: %d rows", len(rows))
				}
			}
		}
	}
	if tableBlockCount < 2 {
		t.Fatalf("expected a large table to split into multiple table blocks, got %d", tableBlockCount)
	}
}

func TestParseInline_BoldItalicMentionPlain(t *testing.T) {
	els := parseInline("plain **bold** _italic_ <@U999> end", nil)
	var texts []string
	var sawMention bool
	for _, el := range els {
		if el["type"] == "text" {
			texts = append(texts, el["text"].(string))
		}
		if el["type"] == "user" && el["user_id"] == "U999" {
			sawMention = true
		}
	}
	if !sawMention {
		t.Fatal("expected a mention element for <@U999>")
	}
	joined := strings.Join(texts, "")
	if strings.Contains(joined, "*") || strings.Contains(joined, "_") || strings.Contains(joined, "<@") {
		t.Errorf("markdown syntax leaked into plain text runs: %q", joined)
	}
}
