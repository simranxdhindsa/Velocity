package slack

import (
	"regexp"
	"strings"
)

// markdownBlockLimit stays under Slack's cap on a single Block Kit `markdown`
// block's text, with margin.
const markdownBlockLimit = 11000

// plainTextLimit mirrors slackTextLimit (kept separate so this file has no
// dependency on the truncate helper, which intentionally still truncates for
// callers that haven't moved to multi-part sending).
const plainTextLimit = 3800

// maxTableRowsPerBlock keeps a single `table` block from growing unbounded;
// larger tables are split across multiple table blocks (each repeating the
// header row), preferring to split at a spacer-row boundary (the blank row
// the Ardoise report template uses between people).
const maxTableRowsPerBlock = 60

// maxBlocksPerMessage stays comfortably under Slack's 50-block hard cap.
const maxBlocksPerMessage = 45

// SendPart is one chat.postMessage call's worth of content. Exactly one of
// Blocks or Text (as the sole payload) is meaningful: if Blocks is non-empty,
// send via PostMessageBlocks with Text as the fallback notification text;
// otherwise send Text via plain PostMessage.
type SendPart struct {
	Text   string
	Blocks []map[string]interface{}
}

var (
	tableSepRe = regexp.MustCompile(`^\s*\|[\s:|-]+\|\s*$`)
	mentionRe  = regexp.MustCompile(`^<@([A-Z0-9]+)>`)
)

func isTableRow(line string) bool {
	t := strings.TrimSpace(line)
	return len(t) > 1 && strings.HasPrefix(t, "|") && strings.HasSuffix(t, "|")
}

func splitTableRow(line string) []string {
	t := strings.TrimSpace(line)
	t = strings.TrimPrefix(t, "|")
	t = strings.TrimSuffix(t, "|")
	raw := strings.Split(t, "|")
	cells := make([]string, len(raw))
	for i, c := range raw {
		cells[i] = strings.TrimSpace(c)
	}
	return cells
}

// hasMarkdownTable reports whether text contains a GFM pipe-table: a header
// row immediately followed by a `|:---|:---|`-style separator row.
func hasMarkdownTable(text string) bool {
	lines := strings.Split(text, "\n")
	for i := 0; i+1 < len(lines); i++ {
		if isTableRow(lines[i]) && tableSepRe.MatchString(lines[i+1]) {
			return true
		}
	}
	return false
}

// BuildSendParts turns a message into one or more chat.postMessage payloads.
//
// Slack's classic mrkdwn `text` field has no concept of a Markdown table —
// posting `| col | col |` rows as plain text just shows the raw pipe
// characters. A message containing a GFM pipe-table (the format the Ardoise
// daily-update report uses) is instead built as Block Kit blocks: each
// non-table segment becomes a `markdown` block (which — unlike classic
// mrkdwn — correctly parses GFM `**bold**`/`*italic*`) and each table
// becomes a native `table` block with real bordered rows, matching how the
// official Slack MCP connector's own table rendering looks. Plain messages
// (no table) are sent exactly as before, unchanged. Content too long for one
// message is split across several sent in sequence ("continued") instead of
// being cut off.
func BuildSendParts(text string) []SendPart {
	if !hasMarkdownTable(text) {
		return splitPlainText(text)
	}

	lines := strings.Split(text, "\n")
	var blocks []map[string]interface{}
	var plainBuf []string

	flushPlain := func() {
		if len(plainBuf) == 0 {
			return
		}
		joined := strings.TrimRight(strings.Join(plainBuf, "\n"), "\n")
		plainBuf = nil
		if strings.TrimSpace(joined) == "" {
			return
		}
		for _, chunk := range chunkText(joined, markdownBlockLimit) {
			blocks = append(blocks, map[string]interface{}{"type": "markdown", "text": chunk})
		}
	}

	i := 0
	for i < len(lines) {
		if isTableRow(lines[i]) && i+1 < len(lines) && tableSepRe.MatchString(lines[i+1]) {
			flushPlain()
			header := splitTableRow(lines[i])
			i += 2 // skip the separator row — it carries no visual information
			var rows [][]string
			for i < len(lines) && isTableRow(lines[i]) {
				rows = append(rows, splitTableRow(lines[i]))
				i++
			}
			blocks = append(blocks, tableBlocks(header, rows)...)
			continue
		}
		plainBuf = append(plainBuf, lines[i])
		i++
	}
	flushPlain()

	return chunkBlocks(blocks, firstLine(text))
}

// ── Table → Block Kit `table` conversion ────────────────────────────────────

// tableBlocks converts a header row + data rows into one or more native
// `table` blocks, splitting (and repeating the header) when the table is
// long enough to need it.
func tableBlocks(header []string, rows [][]string) []map[string]interface{} {
	headerRow := make([]string, len(header))
	for i, h := range header {
		headerRow[i] = "**" + h + "**"
	}

	var out []map[string]interface{}
	var batch [][]string
	lastSpacer := -1

	flush := func() {
		if len(batch) == 0 {
			return
		}
		allRows := append([][]string{headerRow}, batch...)
		out = append(out, tableBlock(allRows))
		batch = nil
		lastSpacer = -1
	}

	for _, row := range rows {
		if len(batch) >= maxTableRowsPerBlock {
			if lastSpacer > 0 {
				tail := append([][]string{}, batch[lastSpacer+1:]...)
				batch = batch[:lastSpacer+1]
				flush()
				batch = tail
			} else {
				flush()
			}
		}
		if isSpacerRow(row) {
			lastSpacer = len(batch)
		}
		batch = append(batch, row)
	}
	flush()
	return out
}

// isSpacerRow matches the blank/invisible-character divider rows used to
// separate people in the compiled Ardoise-style reports, e.g. "| ㅤ | ㅤ |".
func isSpacerRow(cells []string) bool {
	for _, c := range cells {
		if strings.TrimSpace(strings.ReplaceAll(c, "ㅤ", "")) != "" {
			return false
		}
	}
	return true
}

func tableBlock(rows [][]string) map[string]interface{} {
	tRows := make([]interface{}, 0, len(rows))
	for _, row := range rows {
		cells := make([]interface{}, 0, len(row))
		for _, c := range row {
			cells = append(cells, cellBlock(c))
		}
		tRows = append(tRows, cells)
	}
	return map[string]interface{}{"type": "table", "rows": tRows}
}

func cellBlock(cell string) map[string]interface{} {
	elements := parseInline(cell, nil)
	if len(elements) == 0 {
		elements = []map[string]interface{}{{"type": "text", "text": " "}}
	}
	return map[string]interface{}{
		"type": "rich_text",
		"elements": []map[string]interface{}{
			{"type": "rich_text_section", "elements": elements},
		},
	}
}

// parseInline turns a snippet of inline Markdown into Slack rich_text
// elements: `**bold**` and `*italic*`/`_italic_` spans (nestable), `<@UID>`
// mentions as real mention elements, and everything else as plain text runs.
// style carries bold/italic flags inherited from an enclosing span.
func parseInline(s string, style map[string]interface{}) []map[string]interface{} {
	var out []map[string]interface{}
	i := 0
	for i < len(s) {
		rest := s[i:]

		if strings.HasPrefix(rest, "**") {
			if end := strings.Index(rest[2:], "**"); end >= 0 {
				out = append(out, parseInline(rest[2:2+end], withStyle(style, "bold"))...)
				i += 2 + end + 2
				continue
			}
		}
		if strings.HasPrefix(rest, "*") && !strings.HasPrefix(rest, "**") {
			if end := strings.IndexByte(rest[1:], '*'); end > 0 {
				out = append(out, parseInline(rest[1:1+end], withStyle(style, "italic"))...)
				i += 1 + end + 1
				continue
			}
		}
		if strings.HasPrefix(rest, "_") {
			if end := strings.IndexByte(rest[1:], '_'); end > 0 {
				out = append(out, parseInline(rest[1:1+end], withStyle(style, "italic"))...)
				i += 1 + end + 1
				continue
			}
		}
		if m := mentionRe.FindStringSubmatch(rest); m != nil {
			out = append(out, map[string]interface{}{"type": "user", "user_id": m[1]})
			i += len(m[0])
			continue
		}

		j := i + 1
		for j < len(s) {
			c := s[j]
			if c == '*' || c == '_' {
				break
			}
			if c == '<' && mentionRe.MatchString(s[j:]) {
				break
			}
			j++
		}
		text := s[i:j]
		el := map[string]interface{}{"type": "text", "text": text}
		if len(style) > 0 {
			el["style"] = style
		}
		out = append(out, el)
		i = j
	}
	return out
}

func withStyle(base map[string]interface{}, key string) map[string]interface{} {
	n := make(map[string]interface{}, len(base)+1)
	for k, v := range base {
		n[k] = v
	}
	n[key] = true
	return n
}

// ── Plain-text / length handling ────────────────────────────────────────────

// chunkText breaks s into pieces no longer than limit, cutting on a blank-line
// boundary where possible (falling back to any newline, then a hard cut) so a
// split never lands mid-sentence or mid-table-row.
func chunkText(s string, limit int) []string {
	if len(s) <= limit {
		return []string{s}
	}
	var out []string
	remaining := s
	for len(remaining) > limit {
		window := remaining[:limit]
		cut := strings.LastIndex(window, "\n\n")
		if cut <= 0 {
			cut = strings.LastIndex(window, "\n")
		}
		if cut <= 0 {
			cut = limit
		}
		out = append(out, remaining[:cut])
		remaining = strings.TrimLeft(remaining[cut:], "\n")
	}
	if remaining != "" {
		out = append(out, remaining)
	}
	return out
}

func firstLine(text string) string {
	if i := strings.IndexByte(text, '\n'); i >= 0 {
		return strings.TrimSpace(text[:i])
	}
	return strings.TrimSpace(text)
}

// splitPlainText handles the no-table case: split long plain text across
// multiple whole messages (each tagged "(continued)") instead of truncating.
func splitPlainText(text string) []SendPart {
	chunks := chunkText(text, plainTextLimit)
	parts := make([]SendPart, 0, len(chunks))
	for i, c := range chunks {
		if i > 0 {
			c = "_(continued)_\n\n" + c
		}
		parts = append(parts, SendPart{Text: c})
	}
	return parts
}

// chunkBlocks groups blocks into chat.postMessage-sized batches (Slack caps a
// message at 50 blocks), splitting between top-level blocks only — a single
// `table` block is never split mid-block here since tableBlocks already kept
// each one under maxTableRowsPerBlock.
func chunkBlocks(blocks []map[string]interface{}, title string) []SendPart {
	if len(blocks) == 0 {
		return nil
	}
	var parts []SendPart
	var current []map[string]interface{}

	flush := func() {
		if len(current) == 0 {
			return
		}
		label := title
		if len(parts) > 0 {
			label += " — continued"
		}
		parts = append(parts, SendPart{Text: label, Blocks: current})
		current = nil
	}

	for _, b := range blocks {
		if len(current) >= maxBlocksPerMessage {
			flush()
		}
		current = append(current, b)
	}
	flush()
	return parts
}
