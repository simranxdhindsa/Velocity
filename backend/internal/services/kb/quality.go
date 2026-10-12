package kb

import (
	"fmt"
	"strings"
	"unicode"
)

// Extraction quality check, run after every index. Files that read badly
// (words run together, undecodable fonts, scanned pages, one giant block of
// text) get a warning on the document row, so an admin notices on upload,
// not when someone asks the bot and gets nothing.

const (
	gluedWordMinLen    = 18   // letters-only "words" this long are almost always several words run together
	gluedWarnRatio     = 0.02 // share of such words that triggers the warning
	badCharWarnRatio   = 0.005
	minCharsPerPage    = 200 // below this a PDF page is probably an image
	wallOfTextMinChars = 4000
)

// gluedWordRatio is the share of letters-only words that are implausibly
// long ("priorityitemalsoreported"), the signature of a PDF whose spaces
// were lost on extraction.
func gluedWordRatio(text string) float64 {
	words, glued := 0, 0
	for _, f := range strings.Fields(text) {
		w := strings.TrimFunc(f, func(r rune) bool { return !unicode.IsLetter(r) })
		if w == "" || strings.IndexFunc(w, func(r rune) bool { return !unicode.IsLetter(r) }) >= 0 {
			continue // URLs, IDs, numbers
		}
		words++
		if len([]rune(w)) >= gluedWordMinLen {
			glued++
		}
	}
	if words == 0 {
		return 0
	}
	return float64(glued) / float64(words)
}

// badCharRatio is the share of characters that could not be decoded:
// U+FFFD replacement characters and private-use glyphs from custom fonts.
func badCharRatio(text string) float64 {
	total, bad := 0, 0
	for _, r := range text {
		if unicode.IsSpace(r) {
			continue
		}
		total++
		if r == unicode.ReplacementChar || unicode.In(r, unicode.Co) {
			bad++
		}
	}
	if total == 0 {
		return 0
	}
	return float64(bad) / float64(total)
}

// QualityWarnings describes problems with how a file was read, as one
// admin-facing message ("" when it read cleanly).
func QualityWarnings(ex Extracted, chunks []Chunk, contextLines bool) string {
	var w []string
	text := ex.Text
	if r := gluedWordRatio(text); r >= gluedWarnRatio {
		w = append(w, fmt.Sprintf("Some words ran together when this file was read (%.0f%% of words), so searches for them can miss. Check the chunk preview, or upload it as DOCX or Markdown.", r*100))
	}
	if badCharRatio(text) >= badCharWarnRatio {
		w = append(w, "Some characters could not be decoded (the file uses a custom font encoding). Check the chunk preview, or upload it as DOCX or Markdown.")
	}
	if ex.Pages >= 2 && len(text)/ex.Pages < minCharsPerPage {
		w = append(w, fmt.Sprintf("Only %d characters were found across %d pages, so some pages are probably scanned images, which cannot be read yet.", len(text), ex.Pages))
	}
	// A wall of text is only worth a warning when nothing compensates for
	// it: with an AI key every part gets a summary line (the row shows
	// "Writing AI summaries" meanwhile), so the file is fine as it is.
	if !contextLines && len(text) >= wallOfTextMinChars && windowedShare(chunks) >= 0.5 {
		w = append(w, "This file is mostly long text without paragraph breaks, so it was split into smaller overlapping parts. Adding paragraph breaks or headings to the file gives better answers.")
	}
	return strings.Join(w, " ")
}

// windowedShare is the share of chunks cut from oversized paragraphs.
func windowedShare(chunks []Chunk) float64 {
	if len(chunks) == 0 {
		return 0
	}
	n := 0
	for _, c := range chunks {
		if c.Windowed {
			n++
		}
	}
	return float64(n) / float64(len(chunks))
}
