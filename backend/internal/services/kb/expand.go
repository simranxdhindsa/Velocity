package kb

import (
	"context"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/services/ai"
)

// Query expansion: the stand-in for meaning-based search when no embedding
// provider is configured (Groq, the team's AI provider, has no embeddings
// API). The chat model rewrites a question into the words a document that
// answers it would likely contain ("who handles refunds" -> payments,
// billing, stripe, invoices), and those words run as a second keyword
// search. For small talk it returns NONE, so nothing unrelated is pulled in.

// Kept short on purpose: Groq's on-demand tier allows ~8k tokens a minute
// shared with the Slack bot, and this runs once per new question.
const expansionPrompt = `Turn the question into search keywords for a company's internal team knowledge base.
Reply ONLY with 6-12 lowercase comma-separated keywords a document answering it would contain: the question's key words plus specific synonyms and related systems, tools, domains or policy names. No generic words (team, person, lead, manager, owner, process, policy, department, support, contact, issues).
If it is small talk, a greeting, a request to do a task, or general knowledge, reply exactly: NONE

who handles refunds -> refunds, payments, billing, stripe, invoices, chargebacks
can you fix my bug -> NONE`

// expansionGeneric are words the model still tends to add that match many
// documents (a "Release process" heading, any "lead") and drown the
// specific terms. Measured live: "who is in charge of the UI" expanded to
// "... lead, manager, owner, process" and ranked the release process first.
var expansionGeneric = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`lead leads leader manager managers owner owners ownership process processes
		policy policies department departments support contact contacts issue issues inquiries inquiry
		responsibilities responsibility responsible role roles staff employee employees company organization
		office general information info help service services problem problems`) {
		expansionGeneric[w] = true
	}
}

const (
	expansionTimeout  = 8 * time.Second
	expansionMaxTerms = 15
	expansionCacheMax = 500
)

var (
	expansionCache   = map[string][]string{}
	expansionCacheMu sync.Mutex
)

// expansionAvailable reports whether the configured chat provider has a key,
// i.e. whether query expansion can run (same provider rules as ai.QueryWithContext).
func expansionAvailable() bool {
	switch os.Getenv("AI_PROVIDER") {
	case "openai":
		return os.Getenv("OPENAI_API_KEY") != ""
	case "gemini":
		return os.Getenv("GEMINI_API_KEY") != ""
	default:
		return os.Getenv("GROQ_API_KEY") != ""
	}
}

// SmartSearchAvailable reports whether paraphrased questions can be matched:
// by embeddings, or by AI query expansion when there are none.
func SmartSearchAvailable() bool {
	return (database.KBVectorEnabled() && EmbeddingsAvailable()) || expansionAvailable()
}

// expandQuery returns extra search terms for q, excluding terms already in
// base. Returns nil for small talk, on error, or when no AI key is set; the
// caller then relies on the plain keyword search alone.
func expandQuery(ctx context.Context, q string, base []string) []string {
	key := strings.ToLower(strings.TrimSpace(q))
	expansionCacheMu.Lock()
	cached, ok := expansionCache[key]
	expansionCacheMu.Unlock()
	if !ok {
		cctx, cancel := context.WithTimeout(ctx, expansionTimeout)
		defer cancel()
		out, err := ai.QueryDeterministic(cctx, expansionPrompt, q)
		if err != nil && strings.Contains(strings.ToLower(err.Error()), "rate limit") {
			// Groq asks for a short wait (usually 1-4s); one retry within the timeout.
			select {
			case <-cctx.Done():
			case <-time.After(3 * time.Second):
				out, err = ai.QueryDeterministic(cctx, expansionPrompt, q)
			}
		}
		if err != nil {
			log.Printf("[kb] query expansion unavailable: %v", err)
			return nil // not cached: a transient failure shouldn't stick
		}
		cached = parseExpansion(out)
		expansionCacheMu.Lock()
		if len(expansionCache) >= expansionCacheMax {
			expansionCache = map[string][]string{} // crude reset, plenty for a team KB
		}
		expansionCache[key] = cached
		expansionCacheMu.Unlock()
	}
	have := map[string]bool{}
	for _, t := range base {
		have[t] = true
	}
	var extra []string
	for _, t := range cached {
		if !have[t] {
			have[t] = true
			extra = append(extra, t)
		}
	}
	return extra
}

// parseExpansion turns the model's comma-separated reply into clean search
// terms (multi-word terms are split into words, stopwords dropped).
func parseExpansion(out string) []string {
	out = strings.TrimSpace(out)
	if out == "" || strings.EqualFold(strings.Trim(out, ". "), "NONE") {
		return nil
	}
	if i := strings.LastIndex(out, "->"); i >= 0 { // model echoed the example format
		out = out[i+2:]
	}
	var terms []string
	for _, part := range strings.Split(out, ",") {
		terms = append(terms, QueryTerms(part)...)
	}
	seen := map[string]bool{}
	var uniq []string
	for _, t := range terms {
		if !seen[t] && len(t) <= 40 && !expansionGeneric[t] {
			seen[t] = true
			uniq = append(uniq, t)
			if len(uniq) == expansionMaxTerms {
				break
			}
		}
	}
	return uniq
}
