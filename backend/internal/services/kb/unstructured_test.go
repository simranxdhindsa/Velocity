package kb

import (
	"strings"
	"testing"
	"time"

	"github.com/dhindsa/project-management/internal/database"
)

// Tests for unstructured files: walls of text, letter-spaced and glued PDF
// text, page breaks, and the extraction quality warnings.

func profile(name, pron string, n int) string {
	s := []string{name + " is the engineer on the gateway team."}
	for i := 0; i < n; i++ {
		s = append(s, pron+" finished the alpha beta gamma delta task for the sprint.")
	}
	return strings.Join(s, " ")
}

func TestWindowTextStartsWindowAtNewName(t *testing.T) {
	text := profile("Meher Bajwa", "She", 6) + " " + profile("Tarun Sekhon", "He", 6)
	chunks := windowText("Notes", text)
	if len(chunks) != 2 {
		t.Fatalf("want one window per person, got %d: %+v", len(chunks), chunks)
	}
	if !strings.HasPrefix(chunks[1].Content, "Tarun Sekhon") || strings.Contains(chunks[0].Content, "Tarun") {
		t.Fatalf("second window should start at Tarun: %q", chunks[1].Content[:40])
	}
	for _, c := range chunks {
		if !c.Windowed || c.Heading != "Notes" {
			t.Fatalf("window not marked: %+v", c)
		}
	}
}

func TestWindowTextMidSentenceName(t *testing.T) {
	text := profile("Meher Bajwa", "She", 6) + " The mobile side was handled by Tarun Sekhon, who builds the app. He shipped the dark theme."
	chunks := windowText("", text)
	last := chunks[len(chunks)-1].Content
	if !strings.HasPrefix(last, "The mobile side was handled by Tarun Sekhon") {
		t.Fatalf("a full name introduced mid-sentence should start a window, last = %q", last)
	}
}

func TestWindowTextLongTextOverlapsAndStaysSmall(t *testing.T) {
	var s []string
	for i := 0; i < 80; i++ {
		s = append(s, "she reviewed the deployment checklist and noted the result in the tracker again.")
	}
	chunks := windowText("", strings.Join(s, " "))
	if len(chunks) < 5 {
		t.Fatalf("want several windows, got %d", len(chunks))
	}
	for i, c := range chunks {
		if len(c.Content) > WindowMaxChars {
			t.Fatalf("window %d too long: %d", i, len(c.Content))
		}
		if i > 0 {
			prevLast := chunks[i-1].Content[strings.LastIndex(chunks[i-1].Content[:len(chunks[i-1].Content)-1], ".")+2:]
			if !strings.HasPrefix(c.Content, prevLast) {
				t.Fatalf("window %d should repeat the previous window's last sentence %q", i, prevLast)
			}
		}
	}
}

func TestWindowTextGiantSentence(t *testing.T) {
	chunks := windowText("", strings.Repeat("word ", 1000)) // no punctuation at all
	for _, c := range chunks {
		if len(c.Content) > WindowMaxChars {
			t.Fatalf("window too long: %d", len(c.Content))
		}
	}
	if len(chunks) < 4 {
		t.Fatalf("want the text cut at spaces, got %d windows", len(chunks))
	}
}

func TestSplitWindowsOnlyLongParagraphs(t *testing.T) {
	short := "Simran Dhindsa, QA lead, prepared the test cases for backend retrieval and coordinated the open tickets."
	long := profile("Meher Bajwa", "She", 30)
	chunks := Split(KindText, short+"\n\n"+long)
	if chunks[0].Windowed || chunks[0].Content != short {
		t.Fatalf("a normal paragraph stays one whole chunk: %+v", chunks[0])
	}
	for _, c := range chunks[1:] {
		if !c.Windowed {
			t.Fatalf("parts of a long paragraph should be windows: %+v", c)
		}
	}
}

func TestStartsNewSubject(t *testing.T) {
	window := "Meher Bajwa is the payments engineer. She moved the invoice generator."
	cases := map[string]bool{
		"Tarun Sekhon builds the Android app.":                  true,
		"The mobile side was handled by Tarun Sekhon.":          true,
		"She also fixed the Stripe reconciliation.":             false,
		"He owns the Play Store release checklist.":             false, // pronoun: same subject
		"Meher also wrote the runbook.":                         false, // already in the window
		"However, the release slipped a week.":                  false,
		"API latency fell by half.":                             false, // acronym, not a name
		"In December the team moved to Frankfurt.":              false,
		"Overall the gateway work was done by Rajveer Dhillon.": true,
	}
	for s, want := range cases {
		if got := startsNewSubject(s, window); got != want {
			t.Errorf("startsNewSubject(%q) = %v, want %v", s, got, want)
		}
	}
}

func TestJoinOverlap(t *testing.T) {
	a := "Meher moved the invoices to a queue. She cut reconciliation to forty minutes."
	b := "She cut reconciliation to forty minutes. She wrote the runbook."
	if got, ok := joinOverlap(a, b); !ok || got != "Meher moved the invoices to a queue. She cut reconciliation to forty minutes. She wrote the runbook." {
		t.Fatalf("overlap not removed: %q", got)
	}
	if _, ok := joinOverlap("Meher wrote the runbook for retries.", "Tarun Sekhon builds the Android app."); ok {
		t.Fatal("windows split at a new person must not be joined")
	}
}

func TestAppendPageParagraphs(t *testing.T) {
	all := appendPageParagraphs(nil, []string{"Intro.", "Meher moved the invoice generator to a"})
	all = appendPageParagraphs(all, []string{"queue worker last month.", "Next paragraph."})
	want := []string{"Intro.", "Meher moved the invoice generator to a queue worker last month.", "Next paragraph."}
	if strings.Join(all, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q", all)
	}
	// A page that ends a sentence is not joined.
	all = appendPageParagraphs([]string{"Done."}, []string{"New page."})
	if len(all) != 2 {
		t.Fatalf("finished paragraph should stay separate: %q", all)
	}
	// Hyphenated word over the page break.
	all = appendPageParagraphs([]string{"a total of fifty-"}, []string{"one people."})
	if all[0] != "a total of fifty-one people." {
		t.Fatalf("hyphen join: %q", all[0])
	}
}

func TestJoinBBoxWordsLetterSpaced(t *testing.T) {
	// "Me as" letters 2.3pt apart, a 7.7pt gap between the words.
	var ws []bboxWord
	x := 0.0
	for i, l := range []string{"M", "e", "a", "s", "|", "t", "h", "e"} {
		if l == "|" {
			x += 5.4
			continue
		}
		_ = i
		ws = append(ws, bboxWord{text: l, x0: x, x1: x + 8})
		x += 8 + 2.3
	}
	if got := joinBBoxWords(ws); got != "Meas the" {
		t.Fatalf("got %q", got)
	}
	normal := []bboxWord{{"Simran", 0, 30}, {"leads", 33, 50}, {"QA", 53, 60}, {"for", 63, 70}, {"Ardoise", 73, 100}}
	if got := joinBBoxWords(normal); got != "Simran leads QA for Ardoise" {
		t.Fatalf("normal line changed: %q", got)
	}
}

func TestParsePopplerBBox(t *testing.T) {
	x := `<html><body><doc>
<page width="600" height="800"><flow><block>
<line yMax="100"><word xMin="10" xMax="40">Tom &amp; Jerry</word><word xMin="45" xMax="60">run</word></line>
<line yMax="115"><word xMin="10" xMax="40">QA.</word></line>
</block></flow></page>
<page width="600" height="800"><flow><block><line yMax="100"><word xMin="10" xMax="20">Two</word></line></block></flow></page>
</doc></body></html>`
	pages, err := parsePopplerBBox(strings.NewReader(x))
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 2 || len(pages[0]) != 2 {
		t.Fatalf("pages = %+v", pages)
	}
	if pages[0][0].text != "Tom & Jerry run" || pages[0][0].y != 700 || pages[0][1].y != 685 {
		t.Fatalf("line = %+v", pages[0])
	}
}

func TestPDFSymbolBullets(t *testing.T) {
	in := " MBA, LPU\n Marks: 8.23"
	if got := pdfSymbolBullets(in); got != "• MBA, LPU\n• Marks: 8.23" {
		t.Fatalf("got %q", got)
	}
}

func TestPickPDFText(t *testing.T) {
	good := "Simran leads quality assurance for the Ardoise project and the team."
	glued := "Simranleadsqualityassurance fortheArdoiseprojectandtheteam always."
	if got := pickPDFText(good, true, glued); got != good {
		t.Fatalf("should prefer poppler: %q", got)
	}
	if got := pickPDFText(glued, true, good); got != good {
		t.Fatalf("should fall back when poppler is more glued: %q", got)
	}
	if got := pickPDFText("", false, good); got != good {
		t.Fatalf("no poppler: %q", got)
	}
}

func TestQualityWarnings(t *testing.T) {
	clean := Extracted{Text: strings.Repeat("Simran prepared the test cases for the release. ", 20), Pages: 2}
	if w := QualityWarnings(clean, Split(KindText, clean.Text), true); w != "" {
		t.Fatalf("clean text warned: %q", w)
	}
	glued := Extracted{Text: strings.Repeat("thepriorityitemalsoreported was fixed today by the team. ", 20)}
	if w := QualityWarnings(glued, nil, true); !strings.Contains(w, "ran together") {
		t.Fatalf("glued text not flagged: %q", w)
	}
	scan := Extracted{Text: "Page 1 header", Pages: 5}
	if w := QualityWarnings(scan, nil, true); !strings.Contains(w, "scanned") {
		t.Fatalf("scanned pages not flagged: %q", w)
	}
	bad := Extracted{Text: strings.Repeat("ab�cd x ", 50)}
	if w := QualityWarnings(bad, nil, true); !strings.Contains(w, "could not be decoded") {
		t.Fatalf("bad chars not flagged: %q", w)
	}
	wall := Extracted{Text: profile("Meher Bajwa", "She", 80)}
	chunks := Split(KindText, wall.Text)
	if w := QualityWarnings(wall, chunks, true); w != "" {
		t.Fatalf("wall of text with AI summaries is fine, got %q", w)
	}
	if w := QualityWarnings(wall, chunks, false); !strings.Contains(w, "paragraph breaks or headings") {
		t.Fatalf("no-AI wording: %q", w)
	}
}

func TestCleanContextLine(t *testing.T) {
	cases := map[string]string{
		"Summary: Meher Bajwa, payments engineer, billing work\nextra": "Meher Bajwa, payments engineer, billing work",
		"\n\n\"Tarun Sekhon, Android developer\"":                      "Tarun Sekhon, Android developer",
		"": "",
	}
	for in, want := range cases {
		if got := cleanContextLine(in); got != want {
			t.Errorf("cleanContextLine(%q) = %q, want %q", in, got, want)
		}
	}
	if got := cleanContextLine(strings.Repeat("word ", 200)); len(got) > contextLineMax {
		t.Fatalf("not capped: %d", len(got))
	}
}

func TestFormatForPromptShowsContext(t *testing.T) {
	h := Hit{}
	h.DocTitle, h.Content, h.Context = "Notes", "She wrote the runbook.", "Meher Bajwa, payments engineer"
	out := FormatForPrompt([]Hit{h}, 1000)
	if !strings.Contains(out, "About: Meher Bajwa, payments engineer\nShe wrote the runbook.") {
		t.Fatalf("got %q", out)
	}
}

func TestRareTermMatches(t *testing.T) {
	hits := []database.KBHit{
		{ChunkID: 1, Content: "She added a nightly job that compares invoices."},
		{ChunkID: 2, Content: "Background jobs were killed by the battery saver."},
		{ChunkID: 3, Content: "Mandeep plays the dhol at every celebration, and his job is the gateway."},
	}
	if got := rareTermMatches(hits, []string{"dhol", "player", "job"}); len(got) != 1 || got[0] != 3 {
		t.Fatalf("want the only chunk with dhol, got %v", got)
	}
	if got := rareTermMatches(hits[:2], []string{"dhol"}); got != nil {
		t.Fatalf("too few candidates to judge rarity, got %v", got)
	}
}

func TestContextBudgetWait(t *testing.T) {
	defer func() { contextCalls = nil }()
	now := time.Now()
	contextCalls = nil
	for i := 0; i < contextDailyCalls; i++ {
		contextCalls = append(contextCalls, now.Add(-23*time.Hour+time.Duration(i)*time.Minute))
	}
	if w := contextBudgetWait(now); w < 59*time.Minute || w > 61*time.Minute {
		t.Fatalf("full budget: want ~1h until the oldest call expires, got %v", w)
	}
	contextCalls[0] = now.Add(-25 * time.Hour) // one call older than a day drops out
	if w := contextBudgetWait(now); w != 0 {
		t.Fatalf("budget freed: got %v", w)
	}
}
