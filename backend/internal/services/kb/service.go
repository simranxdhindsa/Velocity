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

	inputs := make([]database.KBChunkInput, len(chunks))
	for i, c := range chunks {
		inputs[i] = database.KBChunkInput{Heading: c.Heading, Content: c.Content}
	}

	warning := ""
	switch {
	case !database.KBVectorEnabled():
		warning = "Indexed for keyword search only (the database has no pgvector)."
	case !EmbeddingsAvailable():
		warning = "Indexed for keyword search only (GEMINI_API_KEY is not set)."
	default:
		texts := make([]string, len(chunks))
		for i, c := range chunks {
			texts[i] = EmbeddingText(c.Heading, c.Content)
		}
		vecs, eerr := EmbedDocuments(ctx, doc.Title, texts)
		if eerr != nil {
			// Still usable through keyword search; say why meaning-based
			// search is missing so the admin can re-index later.
			warning = "Indexed for keyword search only, embeddings failed: " + eerr.Error()
		} else {
			for i := range inputs {
				inputs[i].Embedding = vecs[i]
			}
		}
	}

	if err := repo.ReplaceChunks(ctx, docID, inputs, len(ex.Text), warning); err != nil {
		return fail("could not save chunks: " + err.Error())
	}
	log.Printf("[kb] indexed %q: %d chunks, %d chars, embedded=%v", doc.Title, len(inputs), len(ex.Text), warning == "")
	return nil
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
// vector similarity (paraphrases), fused with reciprocal rank fusion.
// includeAdminOnly must be true only for admins (see database.KBRepository).
func Search(ctx context.Context, query string, includeAdminOnly bool, limit int) ([]Hit, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 5
	}

	var (
		kwHits, vecHits []database.KBHit
		kwErr, vecErr   error
		wg              sync.WaitGroup
	)
	terms := QueryTerms(query)
	wg.Add(1)
	go func() {
		defer wg.Done()
		kwHits, kwErr = repo.KeywordSearch(ctx, terms, includeAdminOnly, candidatePool)
	}()
	if database.KBVectorEnabled() && EmbeddingsAvailable() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			vec, err := EmbedQuery(ctx, query)
			if err != nil {
				vecErr = err
				return
			}
			vecHits, vecErr = repo.VectorSearch(ctx, vec, includeAdminOnly, candidatePool)
		}()
	}
	wg.Wait()
	if kwErr != nil && (vecErr != nil || len(vecHits) == 0) {
		return nil, kwErr
	}
	if vecErr != nil {
		log.Printf("[kb] vector search unavailable, keyword only: %v", vecErr)
	}

	type fused struct {
		hit      database.KBHit
		score    float64
		kw, vec  bool
		vecScore float64
	}
	byID := map[int64]*fused{}
	for rank, h := range kwHits {
		f := &fused{hit: h, kw: true}
		f.score += 1.0 / float64(rrfK+rank+1)
		byID[h.ChunkID] = f
	}
	median := medianScore(vecHits)
	for rank, h := range vecHits {
		f, ok := byID[h.ChunkID]
		if !ok {
			if h.Score < minVectorScore || h.Score-median < minVectorLead {
				continue // meaning-only match that doesn't stand out: likely unrelated
			}
			f = &fused{hit: h}
			byID[h.ChunkID] = f
		}
		f.vec = true
		f.vecScore = h.Score
		f.score += 1.0 / float64(rrfK+rank+1)
	}

	all := make([]*fused, 0, len(byID))
	for _, f := range byID {
		all = append(all, f)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].score > all[j].score })
	if len(all) > limit {
		all = all[:limit]
	}
	out := make([]Hit, 0, len(all))
	for _, f := range all {
		h := Hit{KBHit: f.hit}
		h.Score = f.score
		switch {
		case f.kw && f.vec:
			h.Matched = "both"
		case f.kw:
			h.Matched = "keyword"
		default:
			h.Matched = "meaning"
		}
		out = append(out, h)
	}
	return out, nil
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
		let lets want need like hey hi hello velocity bot dont cant im ive whats whos does`) {
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

// HasDocuments reports whether a viewer has anything to search.
func HasDocuments(ctx context.Context, includeAdminOnly bool) bool {
	return repo.CountReady(ctx, includeAdminOnly) > 0
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
		src := h.DocTitle
		if h.Heading != "" {
			src += " > " + h.Heading
		}
		entry := fmt.Sprintf("[Source: %s]\n%s\n\n", src, strings.TrimSpace(h.Content))
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
