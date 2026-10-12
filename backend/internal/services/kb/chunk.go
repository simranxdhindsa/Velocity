package kb

import (
	"regexp"
	"strings"
)

// Chunking targets: about 400 tokens per chunk (roughly 4 characters per
// token), with a short overlap so a fact split across a boundary is still
// findable from either side.
const (
	ChunkTargetChars  = 1600
	ChunkMaxChars     = 2200
	ChunkOverlapChars = 200
)

// Chunk is one searchable piece of a document.
type Chunk struct {
	Heading  string // section path, e.g. "Team > Backend"
	Content  string
	Windowed bool // cut from an oversized paragraph (see windowText), gets an AI context line
}

var (
	mdHeadingRe = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*#*\s*$`)
	blankLineRe = regexp.MustCompile(`\n\s*\n`)
)

// Split cuts a document into chunks that follow its structure:
// Markdown/HTML/Word by heading sections, tables one record per line,
// everything else by paragraph. Small neighbouring pieces are packed
// together up to ChunkTargetChars, and nothing exceeds ChunkMaxChars.
func Split(kind Kind, text string) []Chunk {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	switch kind {
	case KindMarkdown:
		return splitMarkdown(text)
	case KindTable:
		return pack("", strings.Split(text, "\n"), false)
	default:
		return splitParagraphs(paragraphs(text))
	}
}

// Plain text and PDFs are chunked paragraph-first: a paragraph is usually
// one person or one topic ("Arpit, the DevOps engineer, ..."), so keeping
// each whole keeps every fact next to its subject. Packing paragraphs up to
// the size target instead cut a real operations log mid-paragraph, leaving
// chunks that started "He also verified ..." with the name in another chunk.
const (
	ChunkMinChars   = 100 // smaller fragments (a lone heading line) merge into the next paragraph
	titleLineMaxLen = 100
)

func splitParagraphs(paras []string) []Chunk {
	if len(paras) == 0 {
		return nil
	}
	// A short single first line ("Date: 06 December 2025", a title) is
	// context for the whole document: make it the heading of every chunk.
	heading := ""
	if len(paras) > 1 && len(paras[0]) <= titleLineMaxLen && !strings.Contains(paras[0], "\n") {
		heading = paras[0]
		paras = paras[1:]
	}
	var out []Chunk
	var pending string // tiny paragraphs waiting to join the next one
	for _, p := range paras {
		if pending != "" {
			p = pending + "\n\n" + p
			pending = ""
		}
		if len(p) < ChunkMinChars {
			pending = p
			continue
		}
		if len(p) > WindowFromChars {
			out = append(out, windowText(heading, p)...)
			continue
		}
		out = append(out, Chunk{Heading: heading, Content: p})
	}
	if pending != "" {
		if n := len(out); n > 0 && len(out[n-1].Content)+len(pending) <= ChunkMaxChars {
			out[n-1].Content += "\n\n" + pending
		} else {
			out = append(out, Chunk{Heading: heading, Content: pending})
		}
	}
	return out
}

type section struct {
	path []string
	body []string
}

func splitMarkdown(text string) []Chunk {
	var sections []section
	var stack []string // heading path by level
	cur := section{}
	inFence := false
	flush := func() {
		if len(strings.TrimSpace(strings.Join(cur.body, "\n"))) > 0 {
			sections = append(sections, cur)
		}
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
		}
		if m := mdHeadingRe.FindStringSubmatch(line); m != nil && !inFence {
			flush()
			level := len(m[1])
			for len(stack) >= level {
				stack = stack[:len(stack)-1]
			}
			for len(stack) < level-1 {
				stack = append(stack, "")
			}
			stack = append(stack, strings.TrimSpace(m[2]))
			cur = section{path: compact(stack)}
			continue
		}
		cur.body = append(cur.body, line)
	}
	flush()

	var out []Chunk
	for _, s := range sections {
		heading := strings.Join(s.path, " > ")
		out = append(out, pack(heading, paragraphs(strings.Join(s.body, "\n")), true)...)
	}
	return mergeTiny(out)
}

func compact(path []string) []string {
	var out []string
	for _, p := range path {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// paragraphs splits on blank lines, keeping list blocks together.
func paragraphs(text string) []string {
	var out []string
	for _, p := range blankLineRe.Split(text, -1) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// pack greedily joins pieces into chunks of about ChunkTargetChars. Pieces
// larger than ChunkMaxChars are split at sentence, then word, boundaries.
// overlap carries the tail of the previous chunk into the next one.
func pack(heading string, pieces []string, overlap bool) []Chunk {
	sep := "\n\n"
	if !overlap {
		sep = "\n" // table records: one per line, no overlap needed
	}
	var expanded []string
	for _, p := range pieces {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if len(p) > ChunkMaxChars {
			expanded = append(expanded, splitLong(p)...)
		} else {
			expanded = append(expanded, p)
		}
	}
	var out []Chunk
	var cur strings.Builder
	emit := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			out = append(out, Chunk{Heading: heading, Content: s})
		}
		cur.Reset()
	}
	for _, p := range expanded {
		if cur.Len() > 0 && cur.Len()+len(sep)+len(p) > ChunkTargetChars {
			prev := cur.String()
			emit()
			if overlap {
				if tail := overlapTail(prev); tail != "" && len(tail)+len(p) < ChunkMaxChars {
					cur.WriteString(tail)
				}
			}
		}
		if cur.Len() > 0 {
			cur.WriteString(sep)
		}
		cur.WriteString(p)
	}
	emit()
	return out
}

var sentenceEndRe = regexp.MustCompile(`([.!?])\s+`)

// splitLong breaks one oversized paragraph into sentence-sized pieces.
func splitLong(p string) []string {
	marked := sentenceEndRe.ReplaceAllString(p, "$1\x00")
	var out []string
	var cur strings.Builder
	for _, s := range strings.Split(marked, "\x00") {
		for len(s) > ChunkMaxChars { // a single giant "sentence": cut at a space
			cut := strings.LastIndex(s[:ChunkTargetChars], " ")
			if cut <= 0 {
				cut = ChunkTargetChars
			}
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
			out = append(out, strings.TrimSpace(s[:cut]))
			s = strings.TrimSpace(s[cut:])
		}
		if cur.Len() > 0 && cur.Len()+1+len(s) > ChunkTargetChars {
			out = append(out, cur.String())
			cur.Reset()
		}
		if cur.Len() > 0 {
			cur.WriteString(" ")
		}
		cur.WriteString(s)
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// overlapTail is the last ~ChunkOverlapChars of a chunk, starting at a
// sentence or word boundary.
func overlapTail(s string) string {
	if len(s) <= ChunkOverlapChars {
		return ""
	}
	tail := s[len(s)-ChunkOverlapChars:]
	if i := strings.IndexAny(tail, ".!?\n"); i >= 0 && i < len(tail)-20 {
		return strings.TrimSpace(tail[i+1:])
	}
	if i := strings.Index(tail, " "); i >= 0 {
		return strings.TrimSpace(tail[i+1:])
	}
	return ""
}

// mergeTiny folds very small sections (a heading with one short line) into
// the next chunk of the same top-level section, so a list of short "Name:
// role" sections doesn't become dozens of near-empty chunks.
func mergeTiny(chunks []Chunk) []Chunk {
	const tiny = 300
	var out []Chunk
	for _, c := range chunks {
		if n := len(out); n > 0 {
			last := &out[n-1]
			if len(last.Content) < tiny || len(c.Content) < tiny {
				combined := len(last.Content) + len(c.Content) + len(c.Heading) + 4
				if sameTop(last.Heading, c.Heading) && combined <= ChunkTargetChars {
					newHeading := commonPrefix(last.Heading, c.Heading)
					if newHeading != last.Heading && last.Heading != "" {
						// The first section's own name is about to drop out of
						// the heading, so keep it as a label in the text.
						last.Content = lastSegment(last.Heading) + ":\n" + last.Content
					}
					if c.Heading != last.Heading && c.Heading != "" {
						last.Content += "\n\n" + lastSegment(c.Heading) + ":\n" + c.Content
					} else {
						last.Content += "\n\n" + c.Content
					}
					last.Heading = newHeading
					continue
				}
			}
		}
		out = append(out, c)
	}
	return out
}

func sameTop(a, b string) bool {
	return strings.SplitN(a, " > ", 2)[0] == strings.SplitN(b, " > ", 2)[0]
}

func lastSegment(h string) string {
	parts := strings.Split(h, " > ")
	return parts[len(parts)-1]
}

func commonPrefix(a, b string) string {
	pa, pb := strings.Split(a, " > "), strings.Split(b, " > ")
	var out []string
	for i := 0; i < len(pa) && i < len(pb) && pa[i] == pb[i]; i++ {
		out = append(out, pa[i])
	}
	return strings.Join(out, " > ")
}
