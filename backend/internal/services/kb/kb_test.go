package kb

import (
	"archive/zip"
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/dhindsa/project-management/internal/database"
)

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	zw.Close()
	return buf.Bytes()
}

func TestExtractCSVLabelsEachRow(t *testing.T) {
	ex, err := Extract("team.csv", []byte("Name,Role\nAmrinder,Backend\nSimran,\"QA, PM\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := "Name: Amrinder; Role: Backend\nName: Simran; Role: QA, PM"
	if ex.Text != want || ex.Kind != KindTable {
		t.Fatalf("got %q (%s)", ex.Text, ex.Kind)
	}
}

func TestExtractJSONRecords(t *testing.T) {
	ex, err := Extract("t.json", []byte(`{"team":[{"name":"Amrinder","role":"Backend"}],"lead":"Simran"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ex.Text, "team - name: Amrinder; role: Backend") || !strings.Contains(ex.Text, "lead: Simran") {
		t.Fatalf("got %q", ex.Text)
	}
}

func TestExtractHTMLKeepsHeadingsDropsScripts(t *testing.T) {
	ex, _ := Extract("p.html", []byte(`<html><head><title>x</title></head><body><script>evil()</script><h2>Team</h2><p>Amrinder &amp; Simran</p></body></html>`))
	if strings.Contains(ex.Text, "evil") || !strings.Contains(ex.Text, "## Team") || !strings.Contains(ex.Text, "Amrinder & Simran") {
		t.Fatalf("got %q", ex.Text)
	}
}

func TestExtractDocxHeadingsAndParagraphs(t *testing.T) {
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Backend</w:t></w:r></w:p>
<w:p><w:r><w:t>Amrinder owns </w:t></w:r><w:r><w:t>payments.</w:t></w:r></w:p>
</w:body></w:document>`
	ex, err := Extract("a.docx", zipOf(t, map[string]string{"word/document.xml": doc}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ex.Text, "# Backend") || !strings.Contains(ex.Text, "Amrinder owns payments.") {
		t.Fatalf("got %q", ex.Text)
	}
}

func TestExtractXlsxSharedStrings(t *testing.T) {
	ss := `<sst><si><t>Name</t></si><si><t>Role</t></si><si><t>Amrinder</t></si><si><t>Backend</t></si></sst>`
	sheet := `<worksheet><sheetData>
<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
</sheetData></worksheet>`
	ex, err := Extract("t.xlsx", zipOf(t, map[string]string{"xl/sharedStrings.xml": ss, "xl/worksheets/sheet1.xml": sheet}))
	if err != nil {
		t.Fatal(err)
	}
	if ex.Text != "Name: Amrinder; Role: Backend" {
		t.Fatalf("got %q", ex.Text)
	}
}

func TestExtractPptxSlidesInOrder(t *testing.T) {
	s := func(txt string) string { return `<p:sld><a:t>` + txt + `</a:t></p:sld>` }
	ex, err := Extract("d.pptx", zipOf(t, map[string]string{"ppt/slides/slide2.xml": s("Second"), "ppt/slides/slide10.xml": s("Tenth"), "ppt/slides/slide1.xml": s("First")}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Index(ex.Text, "First") > strings.Index(ex.Text, "Second") || strings.Index(ex.Text, "Second") > strings.Index(ex.Text, "Tenth") {
		t.Fatalf("slides out of order: %q", ex.Text)
	}
}

func TestExtractUnsupported(t *testing.T) {
	if _, err := Extract("photo.png", []byte{1, 2}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("want ErrUnsupported, got %v", err)
	}
	if _, err := Extract("scan.pdf", []byte("not a pdf")); err == nil {
		t.Fatal("garbage PDF must fail, not panic")
	}
}

func TestSplitMarkdownFollowsHeadings(t *testing.T) {
	long := strings.Repeat("Amrinder works on the payments service and reviews backend PRs. ", 40)
	md := "# Team\n\n## Backend\n\n" + long + "\n\n## Frontend\n\n" + long
	chunks := Split(KindMarkdown, md)
	if len(chunks) < 2 {
		t.Fatalf("expected several chunks, got %d", len(chunks))
	}
	sawBackend, sawFrontend := false, false
	for _, c := range chunks {
		if len(c.Content) > ChunkMaxChars {
			t.Fatalf("chunk too large: %d", len(c.Content))
		}
		sawBackend = sawBackend || c.Heading == "Team > Backend"
		sawFrontend = sawFrontend || c.Heading == "Team > Frontend"
	}
	if !sawBackend || !sawFrontend {
		t.Fatalf("headings lost: %+v", chunks)
	}
}

func TestSplitMergesTinySectionsKeepingNames(t *testing.T) {
	md := "# Team\n\n## Amrinder\n\nBackend, payments.\n\n## Simran\n\nQA lead and PM.\n"
	chunks := Split(KindMarkdown, md)
	if len(chunks) != 1 {
		t.Fatalf("tiny sections should merge, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Heading != "Team" || !strings.Contains(c.Content, "Amrinder:\nBackend, payments.") || !strings.Contains(c.Content, "Simran:\nQA lead and PM.") {
		t.Fatalf("names lost in merge: %+v", c)
	}
}

func TestSplitIgnoresHeadingsInCodeFences(t *testing.T) {
	chunks := Split(KindMarkdown, "# Real\n\n```\n# not a heading\n```\n")
	if len(chunks) != 1 || chunks[0].Heading != "Real" {
		t.Fatalf("got %+v", chunks)
	}
}

func TestSplitTableOneRecordPerLineNoOverlap(t *testing.T) {
	var rows []string
	for i := 0; i < 100; i++ {
		rows = append(rows, "Name: Person"+strings.Repeat("x", 30)+"; Role: Backend")
	}
	chunks := Split(KindTable, strings.Join(rows, "\n"))
	total := 0
	for _, c := range chunks {
		total += strings.Count(c.Content, "Name: ")
	}
	if total != 100 {
		t.Fatalf("records duplicated or lost: %d", total)
	}
}

func TestSplitLongParagraphWithoutPunctuation(t *testing.T) {
	chunks := Split(KindText, strings.Repeat("word ", 3000))
	for _, c := range chunks {
		if len(c.Content) > ChunkMaxChars {
			t.Fatalf("chunk too large: %d", len(c.Content))
		}
	}
	if len(chunks) < 5 {
		t.Fatalf("expected the text to be split, got %d chunks", len(chunks))
	}
}

func TestQueryTerms(t *testing.T) {
	got := strings.Join(QueryTerms("Who is working on the Payments service? ARD-123, ARD-123!"), ",")
	if got != "working,payments,service,ard-123" {
		t.Fatalf("got %q", got)
	}
	if len(QueryTerms("hi there what is this")) != 0 {
		t.Fatal("stopword-only query should have no terms")
	}
}

func TestFormatForPromptRespectsBudget(t *testing.T) {
	hits := []Hit{
		{KBHit: database.KBHit{DocTitle: "Team", Heading: "Backend", Content: "Amrinder owns payments."}},
		{KBHit: database.KBHit{DocTitle: "Big", Content: strings.Repeat("x", 5000)}},
	}
	out := FormatForPrompt(hits, 200)
	if !strings.Contains(out, "[Source: Team > Backend]") || strings.Contains(out, "Big") {
		t.Fatalf("got %q", out)
	}
}

func TestMedianScore(t *testing.T) {
	h := []database.KBHit{{Score: 0.5}, {Score: 0.9}, {Score: 0.6}}
	if medianScore(h) != 0.6 || medianScore(nil) != 0 {
		t.Fatal("median wrong")
	}
}

func TestRankByCoverage(t *testing.T) {
	hits := []database.KBHit{
		{ChunkID: 1, Heading: "Leave policy", Content: "18 days of paid leave", Score: 0.9},
		{ChunkID: 2, Heading: "Zorvan", Content: "Owns the payments service and Stripe invoices", Score: 0.2},
	}
	rankByCoverage(hits, []string{"policy", "payments", "stripe", "invoices"})
	if hits[0].ChunkID != 2 {
		t.Fatalf("chunk matching more terms should rank first, got %+v", hits)
	}
}

func TestParseExpansion(t *testing.T) {
	if parseExpansion("NONE") != nil || parseExpansion(" none. ") != nil {
		t.Fatal("NONE must mean no expansion")
	}
	got := strings.Join(parseExpansion("refunds -> Refunds, Stripe, billing team, the invoices"), ",")
	if got != "refunds,stripe,billing,invoices" {
		t.Fatalf("got %q", got)
	}
}

func TestSoleFullMatch(t *testing.T) {
	hits := []database.KBHit{
		{ChunkID: 1, Content: "Harpinder worked on the Lessons Page"},
		{ChunkID: 2, Content: "Suryansh, the backend developer, worked on Nova"},
	}
	if id, ok := soleFullMatch(hits, []string{"suryansh", "working"}); !ok || id != 2 {
		t.Fatalf("want chunk 2, got %d %v", id, ok)
	}
	if _, ok := soleFullMatch(hits, []string{"worked"}); ok {
		t.Fatal("two full matches must not pin either")
	}
	if _, ok := soleFullMatch(hits, []string{"handles", "refunds"}); ok {
		t.Fatal("partial matches must not pin")
	}
}

func TestPDFParagraphsFromBlankRowsAndGaps(t *testing.T) {
	// Blank-row breaks (like the Ardoise ops log) and a gap-only break.
	lines := []pdfLine{
		{800, "Date: 06 December 2025"},
		{776, ""},
		{753, "Arpit, the DevOps engineer, rebooted a staging node at 2:42 PM. A total of fifty-"},
		{732, "one employees attended."},
		{711, ""},
		{690, "Parv tested the onboarding flow."},
		{640, "Amrinder visited the team."}, // 50 vs typical 21: paragraph gap
		{619, "He reviewed integration results."},
	}
	got := pdfParagraphs(lines)
	want := []string{
		"Date: 06 December 2025",
		"Arpit, the DevOps engineer, rebooted a staging node at 2:42 PM. A total of fifty-one employees attended.",
		"Parv tested the onboarding flow.",
		"Amrinder visited the team. He reviewed integration results.",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q", got)
	}
}

func TestSplitTextOneChunkPerParagraphWithTitleHeading(t *testing.T) {
	p := func(name string) string { return name + " " + strings.Repeat("worked on the platform today. ", 9) }
	text := "Date: 06 December 2025\n\n" + p("Arpit") + "\n\n" + p("Parv") + "\n\nShort note.\n\n" + p("Vishal")
	chunks := Split(KindText, text)
	if len(chunks) != 3 {
		t.Fatalf("want one chunk per paragraph (tiny one merged), got %d: %+v", len(chunks), chunks)
	}
	for i, name := range []string{"Arpit", "Parv", "Short note."} {
		if !strings.HasPrefix(chunks[i].Content, name) || chunks[i].Heading != "Date: 06 December 2025" {
			t.Fatalf("chunk %d wrong: %+v", i, chunks[i])
		}
	}
	if !strings.Contains(chunks[2].Content, "Vishal") {
		t.Fatal("tiny paragraph should merge into the next one")
	}
}

func TestWithDocTitle(t *testing.T) {
	if withDocTitle("Ops Log", "") != "Ops Log" || withDocTitle("Ops Log", "Date: 6 Dec") != "Ops Log > Date: 6 Dec" ||
		withDocTitle("Team", "Team > Backend") != "Team > Backend" {
		t.Fatal("withDocTitle wrong")
	}
}
