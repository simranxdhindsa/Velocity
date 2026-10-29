package kb

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/services/ai"
)

// Context lines: every windowed chunk (cut from a wall of text) gets a
// one-line AI summary of who and what it is about, resolved from the text
// before it ("He also deployed..." -> "Suryansh, backend developer on
// Ardoise: deployment work"). The line is searchable (kb_chunks.tsv_ctx),
// shown to the model with the chunk, and part of its embedding.
//
// Runs in the background after a document is indexed, one chunk at a time
// and paced, because Groq's on-demand tier allows ~8k tokens a minute shared
// with the Slack bot. A 5-page wall of text (~20 windows) takes about three
// minutes. The document is searchable by its own words meanwhile.
//
// Groq's free tier also caps tokens per day (200k for gpt-oss-20b, measured
// 2026-10-12), and a line costs ~800 tokens with reasoning. Lines are
// limited to contextDailyCalls per rolling 24h (about a quarter of the day)
// so a big unstructured upload can never leave the Slack bot without
// budget; the rest are written the next day. A daily-limit error from the
// provider pauses the worker for contextDailyWait.

const (
	contextPace        = 8 * time.Second  // between AI calls, leaves most of the minute's budget to the bot
	contextRateWait    = 30 * time.Second // after a rate-limit error
	contextIdleRecheck = 15 * time.Minute
	contextLineMax     = 300
	contextPrevChars   = 700
	contextDailyCalls  = 60
	contextDailyWait   = 15 * time.Minute
)

// contextCalls holds the times of AI calls in the last 24h (worker only).
var contextCalls []time.Time

// contextBudgetWait returns how long to wait before the next AI call so
// that at most contextDailyCalls are made in any 24h.
func contextBudgetWait(now time.Time) time.Duration {
	cut := now.Add(-24 * time.Hour)
	i := 0
	for i < len(contextCalls) && contextCalls[i].Before(cut) {
		i++
	}
	contextCalls = contextCalls[i:]
	if len(contextCalls) < contextDailyCalls {
		return 0
	}
	return contextCalls[0].Add(24 * time.Hour).Sub(now)
}

const contextPrompt = `You label one passage from a company's internal document so it can be found by search.
Reply with ONE line of at most 30 words naming who and what the passage is about: people's full names with their roles, and the product, project or topic.
Use the earlier text only to work out who "he", "she", "they" or "the team" refers to. Never invent facts that neither text states.
No preamble, no quotes.`

var (
	contextKick     = make(chan struct{}, 1)
	contextOnce     sync.Once
	contextIdleHook func() // tests: called when the queue is empty
)

// startContextWorker launches the worker once, if an AI provider is set up.
func startContextWorker() {
	if !expansionAvailable() {
		return
	}
	contextOnce.Do(func() { go contextLoop() })
}

// kickContext wakes the worker after a document was indexed.
func kickContext() {
	startContextWorker()
	select {
	case contextKick <- struct{}{}:
	default:
	}
}

func contextLoop() {
	for {
		drainContext()
		if contextIdleHook != nil {
			contextIdleHook()
		}
		select {
		case <-contextKick:
		case <-time.After(contextIdleRecheck):
		}
	}
}

// drainContext fills context lines until none is pending. A chunk that
// fails twice is skipped until the next run, so one bad passage can't
// block the queue.
func drainContext() {
	ctx := context.Background()
	failures := map[int64]int{}
	var skip []int64
	for {
		job, err := repo.NextPendingContext(ctx, skip)
		if err != nil {
			log.Printf("[kb] context queue unavailable: %v", err)
			return
		}
		if job == nil {
			return
		}
		if wait := contextBudgetWait(time.Now()); wait > 0 {
			log.Printf("[kb] context lines paused for %v: daily budget of %d AI calls used", wait.Round(time.Minute), contextDailyCalls)
			time.Sleep(wait)
			continue
		}
		contextCalls = append(contextCalls, time.Now())
		line, err := writeContextLine(ctx, job.DocTitle, job.PrevContext, job.PrevContent, job.Content)
		if err != nil {
			msg := strings.ToLower(err.Error())
			if strings.Contains(msg, "per day") || strings.Contains(msg, "(tpd)") || strings.Contains(msg, "(rpd)") {
				log.Printf("[kb] context lines paused for %v: the AI provider's daily limit is reached", contextDailyWait)
				time.Sleep(contextDailyWait)
				continue
			}
			if strings.Contains(msg, "rate limit") {
				time.Sleep(contextRateWait)
				continue
			}
			failures[job.ChunkID]++
			log.Printf("[kb] context line for chunk %d failed: %v", job.ChunkID, err)
			if failures[job.ChunkID] >= 2 {
				skip = append(skip, job.ChunkID)
			}
			time.Sleep(contextPace)
			continue
		}
		var vec []float32
		if EmbeddingsAvailable() {
			if vecs, eerr := EmbedDocuments(ctx, job.DocTitle, []string{EmbeddingText(job.Heading, line+"\n"+job.Content)}); eerr == nil && len(vecs) == 1 {
				vec = vecs[0]
			}
		}
		if err := repo.SetChunkContext(ctx, job.ChunkID, line, vec); err != nil {
			log.Printf("[kb] saving context line for chunk %d failed: %v", job.ChunkID, err)
			skip = append(skip, job.ChunkID)
		}
		time.Sleep(contextPace)
	}
}

// writeContextLine asks the chat model for one chunk's context line.
func writeContextLine(ctx context.Context, title, prevContext, prevContent, content string) (string, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "Document: %s\n\n", title)
	if prevContext != "" {
		fmt.Fprintf(&b, "The part before was about: %s\n\n", prevContext)
	}
	if prevContent != "" {
		if len(prevContent) > contextPrevChars {
			prevContent = "..." + prevContent[len(prevContent)-contextPrevChars:]
		}
		fmt.Fprintf(&b, "Earlier text:\n%s\n\n", prevContent)
	}
	fmt.Fprintf(&b, "Passage:\n%s", content)

	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := ai.QueryDeterministic(cctx, contextPrompt, b.String())
	if err != nil {
		return "", err
	}
	line := cleanContextLine(out)
	if line == "" {
		return "", fmt.Errorf("empty reply")
	}
	return line, nil
}

// cleanContextLine keeps the first non-empty line, without quotes or a
// label the model may add, capped at contextLineMax.
func cleanContextLine(out string) string {
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		for _, p := range []string{"Label:", "Summary:", "Context:"} {
			l = strings.TrimSpace(strings.TrimPrefix(l, p))
		}
		l = strings.Trim(l, "\"'`*")
		if len(l) > contextLineMax {
			cut := strings.LastIndex(l[:contextLineMax], " ")
			if cut <= 0 {
				cut = contextLineMax
			}
			l = l[:cut]
		}
		return strings.TrimSpace(l)
	}
	return ""
}
