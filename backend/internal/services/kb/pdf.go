package kb

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
)

// pdfToText reads a PDF's text layer and rebuilds its paragraphs, which a
// PDF does not store: a paragraph break is a blank row, or a vertical gap
// clearly larger than the page's normal line spacing (pdfParagraphGap).
// Lines inside a paragraph are re-joined into flowing text, so a fact is not
// cut by the line wrap and words hyphenated across lines ("fifty-" / "one")
// stay searchable. Poppler reads the file when installed, the Go reader
// otherwise or when it reads the file more cleanly (pickPDFText). Scanned
// PDFs (images only, no text layer) come back empty and are reported as
// such, since OCR is not supported.
func pdfToText(data []byte) (Extracted, error) {
	goText, pages, goErr := pdfGoText(data)
	popText, popOK := popplerText(data)
	text := pickPDFText(popText, popOK, goText)
	if text == "" {
		if goErr != nil && !popOK {
			return Extracted{}, goErr
		}
		return Extracted{}, errors.New("this PDF has no selectable text (probably a scan). Export it with text or upload the source document instead")
	}
	return Extracted{Text: text, Kind: KindText, Pages: pages}, nil
}

// pickPDFText prefers Poppler's text unless it is empty or clearly more
// garbled than the Go reader's (see gluedWordRatio).
func pickPDFText(popRaw string, popOK bool, goText string) string {
	pop := pdfSymbolBullets(unglueSentences(cleanText(popRaw)))
	if !popOK || pop == "" {
		return goText
	}
	if goText != "" && gluedWordRatio(pop) > gluedWordRatio(goText)+0.01 {
		return goText
	}
	return pop
}

// pdfGoText is the pure-Go reader (ledongthuc/pdf), also returning the
// page count.
func pdfGoText(data []byte) (text string, pages int, err error) {
	defer func() {
		if r := recover(); r != nil { // the parser panics on some malformed files
			err = fmt.Errorf("could not read PDF: %v", r)
		}
	}()
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", 0, fmt.Errorf("could not read PDF: %w", err)
	}
	var paras []string
	for i := 1; i <= r.NumPage(); i++ {
		p := r.Page(i)
		if p.V.IsNull() {
			continue
		}
		paras = appendPageParagraphs(paras, pdfParagraphs(pdfLinesForPage(p)))
	}
	return pdfSymbolBullets(unglueSentences(cleanText(strings.Join(paras, "\n\n")))), r.NumPage(), nil
}

// symbolBulletRe matches a lone private-use glyph: a bullet from a Symbol or
// Wingdings font (U+F0B7, U+F0D8 in Word exports), which has no Unicode
// meaning of its own.
var symbolBulletRe = regexp.MustCompile(`(^|\s)[\x{E000}-\x{F8FF}](\s|$)`)

// pdfSymbolBullets turns lone Symbol-font bullets into "•", so they read as
// bullets and don't count as undecodable text in the quality check.
func pdfSymbolBullets(s string) string {
	return symbolBulletRe.ReplaceAllString(s, "${1}•${2}")
}

// pdfLinesForPage picks the better of two line readers per page. The
// library's row grouping (GetTextByRow) reads most PDFs well but collapses
// on PDFs that position text with transformation matrices: the Ardoise ops
// log v3 gave ~5 "rows" for ~50 lines, gluing lines together without spaces.
// Rebuilding lines from glyph coordinates fixes those, but garbles other
// PDFs whose glyph runs carry kerning quirks (split, reordered words in the
// first Ardoise log). So glyph lines are used only when the rows clearly
// collapsed: fewer than half as many rows as real glyph lines.
func pdfLinesForPage(p pdf.Page) []pdfLine {
	var rowLines []pdfLine
	if rows, err := p.GetTextByRow(); err == nil {
		for _, row := range rows {
			var b strings.Builder
			for _, w := range row.Content {
				b.WriteString(w.S)
			}
			rowLines = append(rowLines, pdfLine{y: row.Position, text: strings.TrimSpace(b.String())})
		}
	}
	glyphLines := pdfPageLines(p.Content().Text)
	nonEmpty := 0
	for _, l := range glyphLines {
		if l.text != "" {
			nonEmpty++
		}
	}
	if len(rowLines)*2 < nonEmpty {
		return glyphLines
	}
	return rowLines
}

// pdfPageLines rebuilds a page's lines from individual glyphs: grouped by
// baseline (within pdfSameLine points), ordered left to right, with a space
// inserted where glyphs are visibly apart. The library's own GetTextByRow
// was not used: on PDFs that position text with transformation matrices
// (e.g. the Ardoise operations log v3) it lumps many lines into one "row"
// with no spaces between them ("priorityitem", "alsoreported") and in the
// wrong order, while the glyph coordinates themselves are correct.
func pdfPageLines(glyphs []pdf.Text) []pdfLine {
	if len(glyphs) == 0 {
		return nil
	}
	gs := make([]pdf.Text, len(glyphs))
	copy(gs, glyphs)
	sort.SliceStable(gs, func(i, j int) bool {
		if math.Abs(gs[i].Y-gs[j].Y) > pdfSameLine {
			return gs[i].Y > gs[j].Y // top of the page first
		}
		return gs[i].X < gs[j].X
	})
	var lines []pdfLine
	var cur strings.Builder
	lineY := gs[0].Y
	var prev *pdf.Text
	boldChars, chars := 0, 0
	flush := func() {
		lines = append(lines, pdfLine{
			y:    int64(math.Round(lineY)),
			text: strings.TrimSpace(cur.String()),
			bold: chars > 0 && boldChars*2 > chars,
		})
		cur.Reset()
		prev = nil
		boldChars, chars = 0, 0
	}
	for i := range gs {
		g := &gs[i]
		if math.Abs(g.Y-lineY) > pdfSameLine {
			flush()
			lineY = g.Y
		}
		if prev != nil && g.S != " " && prev.S != " " {
			gap := g.X - (prev.X + prev.W)
			if gap > 0.2*math.Max(g.FontSize, 1) {
				cur.WriteString(" ")
			}
		}
		cur.WriteString(g.S)
		if g.S != " " {
			chars++
			if isBoldFont(g.Font) {
				boldChars++
			}
		}
		prev = g
	}
	flush()
	return lines
}

func isBoldFont(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "bold") || strings.Contains(n, "black") || strings.Contains(n, "heavy") || strings.Contains(n, "semibold")
}

// pdfSameLine: glyphs whose baselines differ by at most this many points are
// on the same line (covers sub/superscripts and rounding).
const pdfSameLine = 2.0

var gluedSentenceRe = regexp.MustCompile(`([a-z\)])([.!?])([A-Z][a-z])`)

// unglueSentences puts a space back after sentence punctuation that runs
// straight into a capitalised word ("office life.Sandeep" -> "office life.
// Sandeep"). PDFs sometimes lose that space, and Postgres full-text search
// then indexes "life.sandeep" as one host-like token, so searching "sandeep"
// found nothing (measured on production with the Ardoise ops log v3).
// Lowercase continuations (apyhub.com, e.g.) are left alone.
func unglueSentences(s string) string {
	return gluedSentenceRe.ReplaceAllString(s, "$1$2 $3")
}

type pdfLine struct {
	y    int64 // baseline, larger is higher on the page
	text string
	bold bool // mostly bold glyphs, i.e. a heading line
}

// pdfParagraphGap: a gap this many times the page's typical line spacing
// starts a new paragraph (normal spacing varies by about 10%, a paragraph
// gap is usually 1.5x or more).
const pdfParagraphGap = 1.6

// pdfParagraphs groups one page's rows (top to bottom) into paragraphs.
func pdfParagraphs(lines []pdfLine) []string {
	// Typical line spacing: median gap between consecutive non-blank rows.
	var gaps []int64
	var prevY int64 = -1
	for _, l := range lines {
		if l.text == "" {
			prevY = -1 // a blank row is itself a break, don't measure across it
			continue
		}
		if prevY >= 0 && prevY > l.y {
			gaps = append(gaps, prevY-l.y)
		}
		prevY = l.y
	}
	// Normal line spacing from the tight end (25th percentile), not the
	// median: on a page of short profiles, heading-to-text gaps (16.5pt) are
	// so common the median drifted up and real paragraph gaps (26pt) no
	// longer cleared 1.6x of it (measured on the Ardoise ops log v3).
	var typical int64
	if len(gaps) > 0 {
		sort.Slice(gaps, func(i, j int) bool { return gaps[i] < gaps[j] })
		typical = gaps[len(gaps)/4]
	}

	var paras []string
	var cur strings.Builder
	flush := func() {
		if t := strings.TrimSpace(cur.String()); t != "" {
			paras = append(paras, t)
		}
		cur.Reset()
	}
	prevY = -1
	prevBold := false
	for _, l := range lines {
		if l.text == "" {
			flush()
			prevY = -1
			continue
		}
		bigGap := prevY >= 0 && typical > 0 && float64(prevY-l.y) > pdfParagraphGap*float64(typical)
		// A bold line after normal text is a new heading ("Kanav, Developer
		// Advocate, ApyHub"): start a paragraph even without a big gap.
		newHeading := l.bold && !prevBold && cur.Len() > 0
		if bigGap || newHeading {
			flush()
		}
		prevBold = l.bold
		switch s := cur.String(); {
		case s == "":
		case strings.HasSuffix(s, "-"):
			// hyphen at a line end: keep it, join without a space
		default:
			cur.WriteString(" ")
		}
		cur.WriteString(l.text)
		prevY = l.y
	}
	flush()
	return paras
}

// appendPageParagraphs adds one page's paragraphs, re-joining a paragraph
// that runs over the page break: the page ended mid-sentence (no closing
// punctuation) and the next page goes on with it. Without this a long
// paragraph became one chunk per page, each cut mid-sentence.
func appendPageParagraphs(all, page []string) []string {
	if len(all) > 0 && len(page) > 0 {
		last := strings.TrimSpace(all[len(all)-1])
		if r, _ := utf8.DecodeLastRuneInString(last); last != "" && !strings.ContainsRune(".!?:;\"”)]", r) {
			sep := " "
			if strings.HasSuffix(last, "-") {
				sep = ""
			}
			all[len(all)-1] = last + sep + strings.TrimSpace(page[0])
			page = page[1:]
		}
	}
	return append(all, page...)
}
