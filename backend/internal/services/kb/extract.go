// Package kb is Velocity's admin knowledge base: text extraction from
// uploaded files, chunking, embeddings and hybrid search. Storage lives in
// database/kb_repo.go; HTTP in handlers/kb.go.
package kb

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
)

// Kind is how a document's text is structured, which decides how it is
// chunked (see Chunk).
type Kind string

const (
	KindMarkdown Kind = "markdown" // split on headings
	KindText     Kind = "text"     // split on paragraphs
	KindTable    Kind = "table"    // one record per line ("Header: value; ...")
)

// MaxFileBytes caps a single upload.
const MaxFileBytes = 15 << 20

// ErrUnsupported is returned for file types the KB cannot read.
var ErrUnsupported = errors.New("unsupported file type")

// SupportedExtensions lists every extension Extract understands, for the
// upload UI and error messages.
var SupportedExtensions = []string{
	".md", ".markdown", ".txt", ".text", ".log", ".rst",
	".csv", ".tsv", ".json", ".yaml", ".yml", ".xml",
	".html", ".htm", ".pdf", ".docx", ".pptx", ".xlsx",
}

// Extracted is a document's plain text plus its structure kind.
type Extracted struct {
	Text string
	Kind Kind
}

// Extract returns the readable text of a file, chosen by extension.
func Extract(filename string, data []byte) (Extracted, error) {
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".md", ".markdown":
		return Extracted{Text: cleanText(string(data)), Kind: KindMarkdown}, nil
	case ".txt", ".text", ".log", ".rst", ".yaml", ".yml":
		return Extracted{Text: cleanText(string(data)), Kind: KindText}, nil
	case ".csv":
		return delimitedToRecords(data, ',')
	case ".tsv":
		return delimitedToRecords(data, '\t')
	case ".json":
		return jsonToText(data)
	case ".html", ".htm":
		return Extracted{Text: htmlToText(string(data)), Kind: KindMarkdown}, nil
	case ".xml":
		return Extracted{Text: cleanText(xmlText(data)), Kind: KindText}, nil
	case ".pdf":
		return pdfToText(data)
	case ".docx":
		return docxToText(data)
	case ".pptx":
		return pptxToText(data)
	case ".xlsx":
		return xlsxToRecords(data)
	}
	return Extracted{}, fmt.Errorf("%w %q, supported: %s", ErrUnsupported, ext, strings.Join(SupportedExtensions, " "))
}

// cleanText normalizes line endings, drops invalid UTF-8 and NUL bytes, and
// collapses runs of blank lines.
func cleanText(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	s = strings.ReplaceAll(s, "\x00", "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	lines := strings.Split(s, "\n")
	var out []string
	blank := 0
	for _, l := range lines {
		l = strings.TrimRight(l, " \t")
		if strings.TrimSpace(l) == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, l)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// delimitedToRecords turns a CSV/TSV into one line per row, each cell
// labeled by its header ("Name: Amrinder; Role: Backend"), so a row stays
// meaningful on its own after chunking. A team roster spreadsheet is the
// main use case.
func delimitedToRecords(data []byte, sep rune) (Extracted, error) {
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = sep
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	rows, err := r.ReadAll()
	if err != nil {
		return Extracted{}, fmt.Errorf("could not parse table: %w", err)
	}
	return Extracted{Text: recordsText(rows), Kind: KindTable}, nil
}

func recordsText(rows [][]string) string {
	if len(rows) == 0 {
		return ""
	}
	header := rows[0]
	var b strings.Builder
	for _, row := range rows[1:] {
		var cells []string
		for i, v := range row {
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			h := ""
			if i < len(header) {
				h = strings.TrimSpace(header[i])
			}
			if h != "" {
				cells = append(cells, h+": "+v)
			} else {
				cells = append(cells, v)
			}
		}
		if len(cells) > 0 {
			b.WriteString(strings.Join(cells, "; "))
			b.WriteString("\n")
		}
	}
	return cleanText(b.String())
}

// jsonToText flattens JSON into "path: value" lines, which reads and
// searches far better than raw braces.
func jsonToText(data []byte) (Extracted, error) {
	var v interface{}
	if err := json.Unmarshal(data, &v); err != nil {
		return Extracted{}, fmt.Errorf("invalid JSON: %w", err)
	}
	var lines []string
	var walk func(prefix string, v interface{})
	walk = func(prefix string, v interface{}) {
		switch t := v.(type) {
		case map[string]interface{}:
			keys := make([]string, 0, len(t))
			for k := range t {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				p := k
				if prefix != "" {
					p = prefix + "." + k
				}
				walk(p, t[k])
			}
		case []interface{}:
			// An array of objects is usually a list of records (people,
			// services): one line per record keeps each one together.
			for i, item := range t {
				if m, ok := item.(map[string]interface{}); ok && isFlat(m) {
					lines = append(lines, flatRecord(prefix, m))
					continue
				}
				walk(prefix+"["+strconv.Itoa(i)+"]", item)
			}
		default:
			lines = append(lines, prefix+": "+fmt.Sprint(t))
		}
	}
	walk("", v)
	return Extracted{Text: cleanText(strings.Join(lines, "\n")), Kind: KindTable}, nil
}

func isFlat(m map[string]interface{}) bool {
	for _, v := range m {
		switch v.(type) {
		case map[string]interface{}, []interface{}:
			return false
		}
	}
	return true
}

func flatRecord(prefix string, m map[string]interface{}) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		if s := strings.TrimSpace(fmt.Sprint(m[k])); s != "" && m[k] != nil {
			parts = append(parts, k+": "+s)
		}
	}
	line := strings.Join(parts, "; ")
	if prefix != "" {
		line = prefix + " - " + line
	}
	return line
}

var (
	htmlDropRe    = regexp.MustCompile(`(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\s*(script|style|noscript|svg|head)>`)
	htmlHeadingRe = regexp.MustCompile(`(?is)<h([1-6])[^>]*>(.*?)</h[1-6]>`)
	htmlBlockRe   = regexp.MustCompile(`(?i)</?(p|div|br|li|tr|section|article|ul|ol|table|blockquote)[^>]*>`)
	htmlTagRe     = regexp.MustCompile(`(?s)<[^>]+>`)
)

// htmlToText keeps headings as Markdown headings (so chunking can follow
// the page structure) and turns block tags into line breaks.
func htmlToText(s string) string {
	s = htmlDropRe.ReplaceAllString(s, "")
	s = htmlHeadingRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := htmlHeadingRe.FindStringSubmatch(m)
		level, _ := strconv.Atoi(sub[1])
		text := strings.TrimSpace(htmlTagRe.ReplaceAllString(sub[2], ""))
		return "\n\n" + strings.Repeat("#", level) + " " + text + "\n\n"
	})
	s = htmlBlockRe.ReplaceAllString(s, "\n")
	s = htmlTagRe.ReplaceAllString(s, "")
	return cleanText(html.UnescapeString(s))
}

// xmlText collects every text node of an XML document.
func xmlText(data []byte) string {
	dec := xml.NewDecoder(bytes.NewReader(data))
	var b strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		if cd, ok := tok.(xml.CharData); ok {
			if t := strings.TrimSpace(string(cd)); t != "" {
				b.WriteString(t)
				b.WriteString("\n")
			}
		}
	}
	return b.String()
}

// pdfToText reads a PDF's text layer and rebuilds its paragraphs, which a
// PDF does not store: a paragraph break is a blank row, or a vertical gap
// clearly larger than the page's normal line spacing (pdfParagraphGap).
// Lines inside a paragraph are re-joined into flowing text, so a fact is not
// cut by the line wrap and words hyphenated across lines ("fifty-" / "one")
// stay searchable. Scanned PDFs (images only, no text layer) come back empty
// and are reported as such, since OCR is not supported.
func pdfToText(data []byte) (ex Extracted, err error) {
	defer func() {
		if r := recover(); r != nil { // the parser panics on some malformed files
			err = fmt.Errorf("could not read PDF: %v", r)
		}
	}()
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Extracted{}, fmt.Errorf("could not read PDF: %w", err)
	}
	var paras []string
	for i := 1; i <= r.NumPage(); i++ {
		p := r.Page(i)
		if p.V.IsNull() {
			continue
		}
		paras = append(paras, pdfParagraphs(pdfLinesForPage(p))...)
	}
	text := unglueSentences(cleanText(strings.Join(paras, "\n\n")))
	if text == "" {
		return Extracted{}, errors.New("this PDF has no selectable text (probably a scan). Export it with text or upload the source document instead")
	}
	return Extracted{Text: text, Kind: KindText}, nil
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

// readZipFile returns one member of an Office (zip) file.
func readZipFile(zr *zip.Reader, name string) ([]byte, bool) {
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil, false
			}
			defer rc.Close()
			b, err := io.ReadAll(io.LimitReader(rc, 64<<20))
			return b, err == nil
		}
	}
	return nil, false
}

func openOffice(data []byte, kind string) (*zip.Reader, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("could not open %s file: %w", kind, err)
	}
	return zr, nil
}

// docxToText walks word/document.xml paragraph by paragraph. Heading styles
// become Markdown headings so chunks follow the document's sections.
func docxToText(data []byte) (Extracted, error) {
	zr, err := openOffice(data, "Word")
	if err != nil {
		return Extracted{}, err
	}
	body, ok := readZipFile(zr, "word/document.xml")
	if !ok {
		return Extracted{}, errors.New("not a valid .docx (word/document.xml missing)")
	}
	dec := xml.NewDecoder(bytes.NewReader(body))
	var out []string
	var para strings.Builder
	heading := 0
	inText := false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				para.Reset()
				heading = 0
			case "pStyle":
				for _, a := range t.Attr {
					if a.Name.Local == "val" {
						v := strings.ToLower(a.Value)
						if strings.HasPrefix(v, "heading") {
							heading, _ = strconv.Atoi(strings.TrimPrefix(v, "heading"))
							if heading == 0 {
								heading = 1
							}
						} else if v == "title" {
							heading = 1
						}
					}
				}
			case "t":
				inText = true
			case "tab":
				para.WriteString("\t")
			case "br":
				para.WriteString("\n")
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p":
				line := strings.TrimSpace(para.String())
				if line != "" {
					if heading > 0 && heading <= 6 {
						line = strings.Repeat("#", heading) + " " + line
						out = append(out, "")
					}
					out = append(out, line)
				}
			case "tr":
				out = append(out, "")
			}
		case xml.CharData:
			if inText {
				para.Write(t)
			}
		}
	}
	return Extracted{Text: cleanText(strings.Join(out, "\n")), Kind: KindMarkdown}, nil
}

var slideNumRe = regexp.MustCompile(`^ppt/slides/slide(\d+)\.xml$`)

// pptxToText gives each slide a "## Slide N" heading with its text below.
func pptxToText(data []byte) (Extracted, error) {
	zr, err := openOffice(data, "PowerPoint")
	if err != nil {
		return Extracted{}, err
	}
	type slide struct {
		n    int
		name string
	}
	var slides []slide
	for _, f := range zr.File {
		if m := slideNumRe.FindStringSubmatch(f.Name); m != nil {
			n, _ := strconv.Atoi(m[1])
			slides = append(slides, slide{n, f.Name})
		}
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].n < slides[j].n })
	var b strings.Builder
	for _, s := range slides {
		body, ok := readZipFile(zr, s.name)
		if !ok {
			continue
		}
		text := strings.TrimSpace(xmlText(body))
		if text == "" {
			continue
		}
		fmt.Fprintf(&b, "## Slide %d\n\n%s\n\n", s.n, text)
	}
	return Extracted{Text: cleanText(b.String()), Kind: KindMarkdown}, nil
}

// xlsxToRecords reads every sheet; the first row of each is the header and
// each following row becomes a labeled record line (see recordsText).
func xlsxToRecords(data []byte) (Extracted, error) {
	zr, err := openOffice(data, "Excel")
	if err != nil {
		return Extracted{}, err
	}
	var shared []string
	if b, ok := readZipFile(zr, "xl/sharedStrings.xml"); ok {
		var sst struct {
			SI []struct {
				T string `xml:"t"`
				R []struct {
					T string `xml:"t"`
				} `xml:"r"`
			} `xml:"si"`
		}
		if xml.Unmarshal(b, &sst) == nil {
			for _, si := range sst.SI {
				s := si.T
				for _, r := range si.R {
					s += r.T
				}
				shared = append(shared, s)
			}
		}
	}
	sheetRe := regexp.MustCompile(`^xl/worksheets/sheet(\d+)\.xml$`)
	type sheetFile struct {
		n    int
		name string
	}
	var sheets []sheetFile
	for _, f := range zr.File {
		if m := sheetRe.FindStringSubmatch(f.Name); m != nil {
			n, _ := strconv.Atoi(m[1])
			sheets = append(sheets, sheetFile{n, f.Name})
		}
	}
	sort.Slice(sheets, func(i, j int) bool { return sheets[i].n < sheets[j].n })

	var parts []string
	for _, sh := range sheets {
		b, ok := readZipFile(zr, sh.name)
		if !ok {
			continue
		}
		var ws struct {
			Rows []struct {
				Cells []struct {
					Ref  string `xml:"r,attr"`
					Type string `xml:"t,attr"`
					V    string `xml:"v"`
					IS   struct {
						T string `xml:"t"`
					} `xml:"is"`
				} `xml:"c"`
			} `xml:"sheetData>row"`
		}
		if xml.Unmarshal(b, &ws) != nil {
			continue
		}
		var rows [][]string
		for _, r := range ws.Rows {
			var row []string
			for _, c := range r.Cells {
				col := colIndex(c.Ref)
				for len(row) < col {
					row = append(row, "")
				}
				v := c.V
				switch c.Type {
				case "s":
					if i, err := strconv.Atoi(c.V); err == nil && i < len(shared) {
						v = shared[i]
					}
				case "inlineStr":
					v = c.IS.T
				}
				row = append(row, v)
			}
			rows = append(rows, row)
		}
		if t := recordsText(rows); t != "" {
			parts = append(parts, t)
		}
	}
	return Extracted{Text: cleanText(strings.Join(parts, "\n\n")), Kind: KindTable}, nil
}

// colIndex converts a cell reference like "C7" to a 0-based column index.
func colIndex(ref string) int {
	n := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' {
			break
		}
		n = n*26 + int(r-'A'+1)
	}
	if n == 0 {
		return 0
	}
	return n - 1
}
