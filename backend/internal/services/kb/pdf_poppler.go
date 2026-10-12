package kb

import (
	"bytes"
	"context"
	"encoding/xml"
	"io"
	"math"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Poppler's pdftotext is the primary PDF reader when it is installed (the
// Docker image adds poppler-utils). It is the most widely used open-source
// text extractor and handles the many ways PDF generators place text far
// better than the pure-Go reader, which needed per-generator fixes (rows
// collapsing on ReportLab files, glued words). The Go reader stays as the
// fallback for hosts without the binary and for the rare file Poppler
// reads worse (see pickPDFText).
//
// Poppler's plain text output drops paragraph breaks on some files (the
// first Ardoise log came out as one block per page and turned "fifty-" /
// "one" into "fiftyone"), so -bbox-layout is used instead: it gives every
// line with its coordinates, and the same gap-based paragraph detection as
// the Go reader (pdfParagraphs) rebuilds the paragraphs. Poppler's own
// blocks are not used as breaks: on the first Ardoise log every line was
// its own block.

const popplerTimeout = 60 * time.Second

var (
	popplerOnce sync.Once
	popplerPath string
)

// popplerAvailable reports whether pdftotext is on PATH (checked once).
func popplerAvailable() bool {
	popplerOnce.Do(func() {
		popplerPath, _ = exec.LookPath("pdftotext")
	})
	return popplerPath != ""
}

// popplerText extracts a PDF's paragraphs with pdftotext. ok is false when
// Poppler is not installed or could not read the file.
func popplerText(data []byte) (string, bool) {
	if !popplerAvailable() {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), popplerTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, popplerPath, "-bbox-layout", "-enc", "UTF-8", "-q", "-", "-")
	cmd.Stdin = bytes.NewReader(data)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", false
	}
	pages, err := parsePopplerBBox(&out)
	if err != nil {
		return "", false
	}
	var paras []string
	for _, lines := range pages {
		paras = appendPageParagraphs(paras, pdfParagraphs(lines))
	}
	return strings.Join(paras, "\n\n"), true
}

// parsePopplerBBox reads pdftotext -bbox-layout XHTML into one []pdfLine per
// page, in Poppler's reading order.
func parsePopplerBBox(r io.Reader) ([][]pdfLine, error) {
	dec := xml.NewDecoder(r)
	dec.Strict = false
	dec.Entity = xml.HTMLEntity
	var (
		pages  [][]pdfLine
		page   []pdfLine
		words  []bboxWord
		wordX  [2]float64
		lineY  float64
		inWord bool
		word   strings.Builder
		pageH  float64
	)
	attr := func(se xml.StartElement, name string) float64 {
		for _, a := range se.Attr {
			if a.Name.Local == name {
				v, _ := strconv.ParseFloat(a.Value, 64)
				return v
			}
		}
		return 0
	}
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "page":
				page = nil
				pageH = attr(t, "height")
			case "line":
				words = words[:0]
				lineY = attr(t, "yMax") // bottom of the line, near the baseline
			case "word":
				inWord = true
				word.Reset()
				wordX = [2]float64{attr(t, "xMin"), attr(t, "xMax")}
			}
		case xml.CharData:
			if inWord {
				word.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "word":
				inWord = false
				if w := strings.TrimSpace(word.String()); w != "" {
					words = append(words, bboxWord{text: w, x0: wordX[0], x1: wordX[1]})
				}
			case "line":
				if len(words) > 0 {
					// pdfLine.y grows upwards like PDF coordinates; Poppler's y grows down.
					page = append(page, pdfLine{y: int64(math.Round(pageH - lineY)), text: joinBBoxWords(words)})
				}
			case "page":
				pages = append(pages, page)
			}
		}
	}
	return pages, nil
}

type bboxWord struct {
	text   string
	x0, x1 float64
}

// joinBBoxWords joins a line's words with spaces, except on letter-spaced
// lines: designed PDFs track headings out so far that Poppler reads every
// letter as a word ("M e a s u r i n g t h e"). There the gaps between
// letters are tight and alike (~2.3pt in the Ardoise guide) and real word
// gaps clearly wider (~7.7pt), so spaces go only at the wide gaps.
func joinBBoxWords(words []bboxWord) string {
	short := 0
	for _, w := range words {
		if len([]rune(w.text)) <= 2 {
			short++
		}
	}
	if len(words) < 4 || short*10 < len(words)*6 {
		parts := make([]string, len(words))
		for i, w := range words {
			parts[i] = w.text
		}
		return strings.Join(parts, " ")
	}
	gaps := make([]float64, 0, len(words)-1)
	for i := 1; i < len(words); i++ {
		gaps = append(gaps, words[i].x0-words[i-1].x1)
	}
	sorted := append([]float64(nil), gaps...)
	sort.Float64s(sorted)
	letterGap := sorted[len(sorted)/4]
	wordGap := math.Max(letterGap*2, letterGap+2)
	var b strings.Builder
	b.WriteString(words[0].text)
	for i := 1; i < len(words); i++ {
		if gaps[i-1] > wordGap {
			b.WriteByte(' ')
		}
		b.WriteString(words[i].text)
	}
	return b.String()
}
