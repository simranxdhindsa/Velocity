package kb

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/dhindsa/project-management/internal/database"
)

// Indexing pipeline: extract text, split into chunks, embed, store.
// Documents are indexed one at a time in the background (see IndexAsync) so
// a batch upload never trips the embedding API's rate limit.

var (
	repo      = database.NewKBRepository()
	indexMu   sync.Mutex // one document indexed at a time
	indexWG   sync.WaitGroup
	maxChunks = 2000 // per document; larger files are almost always a mistake
)

// ContentHash identifies identical uploads.
func ContentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// IndexAsync indexes a document in the background.
func IndexAsync(docID string) {
	indexWG.Add(1)
	go func() {
		defer indexWG.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if err := Index(ctx, docID); err != nil {
			log.Printf("[kb] indexing %s failed: %v", docID, err)
		}
	}()
}

// WaitIdle blocks until queued background indexing has finished (tests).
func WaitIdle() { indexWG.Wait() }

// ResumePending re-queues documents left in "processing" by a restart.
func ResumePending() {
	ids, err := repo.ListProcessing(context.Background())
	if err != nil {
		log.Printf("[kb] could not list pending documents: %v", err)
		return
	}
	for _, id := range ids {
		IndexAsync(id)
	}
	if len(ids) > 0 {
		log.Printf("[kb] resumed indexing of %d document(s)", len(ids))
	}
	kickContext() // context lines left unfinished by a restart
}

// Index (re)builds one document's chunks. Failures are recorded on the
// document so the admin page can show them.
func Index(ctx context.Context, docID string) error {
	indexMu.Lock()
	defer indexMu.Unlock()

	doc, err := repo.GetDocument(ctx, docID, true)
	if err != nil {
		return err
	}
	if doc == nil {
		return nil // deleted while queued
	}
	fail := func(msg string) error {
		_ = repo.SetStatus(ctx, docID, database.KBStatusFailed, msg)
		return fmt.Errorf("%s", msg)
	}

	ex, err := Extract(doc.Filename, doc.Original)
	if err != nil {
		return fail(err.Error())
	}
	if strings.TrimSpace(ex.Text) == "" {
		return fail("no readable text found in this file")
	}
	chunks := Split(ex.Kind, ex.Text)
	if len(chunks) > maxChunks {
		return fail(fmt.Sprintf("file is too large (%d chunks, limit %d). Split it into smaller documents", len(chunks), maxChunks))
	}

	// Every chunk carries the document title in its heading, so a chunk
	// still says where it came from ("Ardoise Internal Operations > Date:
	// 06 December 2025") when it is read, searched or embedded on its own.
	for i := range chunks {
		chunks[i].Heading = withDocTitle(doc.Title, chunks[i].Heading)
	}
	// Context lines of unchanged windows survive a re-index, so "Index
	// again" doesn't spend the AI budget writing them again.
	known := repo.ExistingContexts(ctx, docID)
	inputs := make([]database.KBChunkInput, len(chunks))
	pendingContext := false
	for i, c := range chunks {
		inputs[i] = database.KBChunkInput{Heading: c.Heading, Content: c.Content, Windowed: c.Windowed}
		if c.Windowed {
			inputs[i].Context = known[c.Heading+"\x00"+c.Content]
			pendingContext = pendingContext || inputs[i].Context == ""
		}
	}

	// Without embeddings (no pgvector or no GEMINI_API_KEY, the normal
	// Groq-only setup) there is nothing to compute here: search covers
	// paraphrases with AI query expansion instead, so no warning either.
	warning := ""
	if database.KBVectorEnabled() && EmbeddingsAvailable() {
		texts := make([]string, len(chunks))
		for i, c := range inputs {
			body := c.Content
			if c.Context != "" {
				body = c.Context + "\n" + body
			}
			texts[i] = EmbeddingText(c.Heading, body)
		}
		vecs, eerr := EmbedDocuments(ctx, doc.Title, texts)
		if eerr != nil {
			// Still usable through keyword search; say why meaning-based
			// search is missing so the admin can re-index later.
			warning = "Indexed without embeddings (search still works through AI keywords): " + eerr.Error()
		} else {
			for i := range inputs {
				inputs[i].Embedding = vecs[i]
			}
		}
	}

	if q := QualityWarnings(ex, chunks, expansionAvailable()); q != "" {
		warning = strings.TrimSpace(q + " " + warning)
	}
	if err := repo.ReplaceChunks(ctx, docID, inputs, len(ex.Text), warning); err != nil {
		return fail("could not save chunks: " + err.Error())
	}
	embedded := len(inputs) > 0 && inputs[0].Embedding != nil
	log.Printf("[kb] indexed %q: %d chunks, %d chars, embedded=%v", doc.Title, len(inputs), len(ex.Text), embedded)
	if pendingContext {
		kickContext()
	}
	return nil
}

// withDocTitle prefixes a chunk heading with the document title unless the
// heading already starts with it (Markdown docs often repeat it as # Title).
func withDocTitle(title, heading string) string {
	title = strings.TrimSpace(title)
	switch {
	case title == "":
		return heading
	case heading == "":
		return title
	case strings.HasPrefix(strings.ToLower(heading), strings.ToLower(title)):
		return heading
	}
	return title + " > " + heading
}

// ── Search ──────────────────────────────────────────────────────────────────

// Search tuning, calibrated live against gemini-embedding-001 at 768 dims.
// Cosine scores sit in a narrow band (small talk like "lol" or "can you fix
// my bug" still reaches 0.58-0.60 against any document), so a fixed cutoff
// cannot separate real matches. What does: a real match stands out from the
// other candidates ("how do I get on the VPN": 0.638 vs 0.53 for the rest),
// noise is flat (0.598, 0.596, 0.594). A meaning-only hit (one keyword
// search did not also find) must clear minVectorScore AND beat the median
// candidate by minVectorLead.
const (
	rrfK           = 60
	candidatePool  = 20
	minVectorScore = 0.60
	minVectorLead  = 0.04
)

func medianScore(hits []database.KBHit) float64 {
	if len(hits) == 0 {
		return 0
	}
	s := make([]float64, len(hits))
	for i, h := range hits {
		s[i] = h.Score
	}
	sort.Float64s(s)
	return s[len(s)/2]
}

// Hit is a search result with the fused relevance score.
type Hit struct {
	database.KBHit
	Matched string `json:"matched"` // "keyword", "meaning" or "both"
}

// Search runs hybrid retrieval: full-text (exact names, IDs, jargon) and
// vector similarity or Groq query expansion (paraphrases), fused with
// reciprocal rank fusion.
func Search(ctx context.Context, query string, limit int) ([]Hit, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 5
	}

	var (
		kwHits, vecHits, expHits []database.KBHit
		kwErr, vecErr, expErr    error
		wg                       sync.WaitGroup
	)
	terms := QueryTerms(query)
	wg.Add(1)
	go func() {
		defer wg.Done()
		kwHits, kwErr = repo.KeywordSearch(ctx, terms, candidatePool)
	}()
	// Meaning channels, each fused with the plain keyword hits below:
	// vectors when an embedding provider is configured, and AI query
	// expansion whenever an AI key exists. Expansion runs even alongside
	// vectors: measured live, "who is the QA lead?" missed a chunk saying
	// "Quality Assurance Lead" with embeddings alone (cosine below the
	// cutoff), while the expansion supplied "quality assurance".
	if database.KBVectorEnabled() && EmbeddingsAvailable() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			vec, err := EmbedQuery(ctx, query)
			if err != nil {
				vecErr = err
				return
			}
			vecHits, vecErr = repo.VectorSearch(ctx, vec, candidatePool)
		}()
	}
	if expansionAvailable() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if extra := expandQuery(ctx, query, terms); len(extra) > 0 {
				expHits, expErr = repo.KeywordSearch(ctx, extra, candidatePool)
				rankByCoverage(expHits, extra)
			}
		}()
	}
	wg.Wait()
	if kwErr != nil && len(vecHits) == 0 && len(expHits) == 0 {
		return nil, kwErr
	}
	if vecErr != nil {
		log.Printf("[kb] vector search unavailable: %v", vecErr)
	}
	if expErr != nil {
		log.Printf("[kb] expansion search failed: %v", expErr)
	}

	type fused struct {
		hit     database.KBHit
		score   float64
		kw, sem bool
	}
	byID := map[int64]*fused{}
	for rank, h := range kwHits {
		f := &fused{hit: h, kw: true}
		f.score += 1.0 / float64(rrfK+rank+1)
		byID[h.ChunkID] = f
	}
	addSemantic := func(hits []database.KBHit, filter func(database.KBHit) bool) {
		for rank, h := range hits {
			f, ok := byID[h.ChunkID]
			if !ok {
				if filter != nil && !filter(h) {
					continue
				}
				f = &fused{hit: h}
				byID[h.ChunkID] = f
			}
			f.sem = true
			f.score += 1.0 / float64(rrfK+rank+1)
		}
	}
	// The cosine cutoff only applies to vectors; expansion hits are keyword
	// matches the model already judged relevant.
	median := medianScore(vecHits)
	addSemantic(vecHits, func(h database.KBHit) bool {
		return h.Score >= minVectorScore && h.Score-median >= minVectorLead
	})
	addSemantic(expHits, nil)

	all := make([]*fused, 0, len(byID))
	for _, f := range byID {
		all = append(all, f)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].score > all[j].score })
	// The words the asker typed beat guessed synonyms: if exactly one chunk
	// contains every query word (e.g. a name plus "working"), it goes first.
	// Measured live: "what is Suryansh working on" was outvoted by Groq's
	// generic expansion (project, task, sprint) for a name it didn't know.
	if id, ok := soleFullMatch(kwHits, terms); ok {
		for i, f := range all {
			if f.hit.ChunkID == id && i > 0 {
				copy(all[1:i+1], all[:i])
				all[0] = f
				break
			}
		}
	}
	// A word only one candidate contains ("dhol" in "what is the dhol
	// player's job?") is the most specific thing asked: keep that chunk
	// second at worst. Measured live, Groq only: common words ("job" in
	// "nightly job", "background jobs") outranked it and the bot said it
	// didn't know. Embeddings had covered this; the Groq-only setup has none.
	for _, id := range rareTermMatches(kwHits, terms) {
		for i, f := range all {
			if f.hit.ChunkID == id && i > 1 {
				copy(all[2:i+1], all[1:i])
				all[1] = f
				break
			}
		}
	}
	// A few spare results, since withNeighbors folds neighbouring windows
	// into the top hits and drops them from the list.
	if len(all) > limit+2*neighborHits {
		all = all[:limit+2*neighborHits]
	}
	out := make([]Hit, 0, len(all))
	for _, f := range all {
		h := Hit{KBHit: f.hit}
		h.Score = f.score
		switch {
		case f.kw && f.sem:
			h.Matched = "both"
		case f.kw:
			h.Matched = "keyword"
		default:
			h.Matched = "meaning"
		}
		out = append(out, h)
	}
	out = withNeighbors(ctx, out)
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// rareTermMatches returns keyword hits that are the only candidate
// containing one of the query words (at most two), when there are enough
// candidates for "only one" to mean something.
func rareTermMatches(hits []database.KBHit, terms []string) []int64 {
	if len(hits) < 3 {
		return nil
	}
	var ids []int64
	for _, t := range terms {
		if len(t) < 3 {
			continue
		}
		stem := stemPrefix(t)
		var only int64
		n := 0
		for _, h := range hits {
			if strings.Contains(strings.ToLower(h.Heading+" "+h.Context+" "+h.Content), stem) {
				only = h.ChunkID
				if n++; n > 1 {
					break
				}
			}
		}
		if n == 1 && len(ids) < 2 && !containsID(ids, only) {
			ids = append(ids, only)
		}
	}
	return ids
}

func containsID(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// rankByCoverage reorders expansion hits by how many distinct expanded
// terms each chunk contains. Postgres rank weights headings heavily, so one
// generic term that hits a heading ("policy" in "Leave policy") would
// otherwise outrank a chunk matching several specific terms (payments,
// stripe, invoices). Measured live: that was the only kind of miss left.
func rankByCoverage(hits []database.KBHit, terms []string) {
	cover := make(map[int64]int, len(hits))
	for _, h := range hits {
		text := strings.ToLower(h.Heading + " " + h.Content)
		n := 0
		for _, t := range terms {
			if strings.Contains(text, stemPrefix(t)) {
				n++
			}
		}
		cover[h.ChunkID] = n
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if cover[hits[i].ChunkID] != cover[hits[j].ChunkID] {
			return cover[hits[i].ChunkID] > cover[hits[j].ChunkID]
		}
		return hits[i].Score > hits[j].Score
	})
}

// soleFullMatch returns the one keyword hit that contains every query term,
// if exactly one does.
func soleFullMatch(hits []database.KBHit, terms []string) (int64, bool) {
	if len(terms) == 0 {
		return 0, false
	}
	var id int64
	n := 0
	for _, h := range hits {
		text := strings.ToLower(h.Heading + " " + h.Content)
		all := true
		for _, t := range terms {
			if !strings.Contains(text, stemPrefix(t)) {
				all = false
				break
			}
		}
		if all {
			id = h.ChunkID
			n++
		}
	}
	return id, n == 1
}

// stemPrefix is a cheap stand-in for stemming when checking whether a
// chunk contains a term: one common suffix is stripped so "working" finds
// "worked", "invoices" finds "invoice" and "payments" finds "payment".
func stemPrefix(t string) string {
	for _, suf := range []string{"ing", "ed", "es", "er", "ly", "s"} {
		if strings.HasSuffix(t, suf) && len(t)-len(suf) >= 4 {
			return t[:len(t)-len(suf)]
		}
	}
	return t
}

// stopwords are dropped from keyword queries so "who is working on the
// payments service" searches for "working payments service", not "the".
var stopwords = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`a an the and or but if of to in on at by for with from about as into
		is are was were be been being am do does did doing have has had having can could should would will
		shall may might must i me my we our you your he him his she her it its they them their this that these
		those what which who whom whose when where why how all any both each few more most other some such no
		not only own same so than too very just also there here then now please tell know give show find get
		let lets want need like hey hi hello velocity bot dont cant im ive whats whos does
		after before our ours us go goes going look looks looking talk much many charge someone anyone
		thing things stuff person people team`) {
		stopwords[w] = true
	}
}

// QueryTerms extracts lowercase search words (letters/digits, plus hyphens
// inside IDs like ARD-123), without stopwords, at most 12.
func QueryTerms(q string) []string {
	seen := map[string]bool{}
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(q), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '-'
	}) {
		w = strings.Trim(w, "-")
		if len([]rune(w)) < 2 || stopwords[w] || seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
		if len(out) == 12 {
			break
		}
	}
	return out
}

// HasDocuments reports whether there is anything to search.
func HasDocuments(ctx context.Context) bool {
	return repo.CountReady(ctx) > 0
}

// FormatForPrompt renders hits as a reference block for an LLM prompt,
// capped at maxChars. Each chunk is labeled with its source so answers can
// say where a fact came from.
func FormatForPrompt(hits []Hit, maxChars int) string {
	if len(hits) == 0 {
		return ""
	}
	var b strings.Builder
	for _, h := range hits {
		// Headings already start with the document title (see withDocTitle).
		src := h.DocTitle
		if strings.HasPrefix(h.Heading, h.DocTitle) {
			src = h.Heading
		} else if h.Heading != "" {
			src += " > " + h.Heading
		}
		about := ""
		if h.Context != "" {
			about = "About: " + h.Context + "\n"
		}
		entry := fmt.Sprintf("[Source: %s]\n%s%s\n\n", src, about, strings.TrimSpace(h.Content))
		if b.Len()+len(entry) > maxChars {
			if b.Len() == 0 {
				b.WriteString(entry[:maxChars])
			}
			break
		}
		b.WriteString(entry)
	}
	return strings.TrimSpace(b.String())
}
