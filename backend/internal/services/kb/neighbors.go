package kb

import (
	"context"
	"strings"
)

// neighborHits is how many top results get their neighbouring windows.
const neighborHits = 2

// withNeighbors widens the top windowed hits with the windows just before
// and after them. A wall of text is cut by size, so a fact can straddle a
// cut, or a window can say "he also deployed..." with the name in the one
// before; reading the neighbours puts it back together. Only windows cut
// by size are joined (they share an overlapping sentence): a window that
// starts at a new person is a different subject, and joining it only added
// noise (measured: "who plays the dhol" pulled in two other profiles).
// Paragraph and
// section chunks are whole units already and are left alone, which keeps
// the prompt within Groq's small per-minute token budget. A neighbour that
// was itself a result is folded in and dropped from the list.
func withNeighbors(ctx context.Context, hits []Hit) []Hit {
	type key struct {
		doc string
		idx int
	}
	absorbed := map[key]bool{}
	for i := 0; i < len(hits) && i < neighborHits; i++ {
		h := &hits[i]
		if !h.Windowed || absorbed[key{h.DocumentID, h.ChunkIndex}] {
			continue // not a window, or already folded into a better hit
		}
		nb, err := repo.ChunksAt(ctx, h.DocumentID, []int{h.ChunkIndex - 1, h.ChunkIndex + 1})
		if err != nil {
			continue
		}
		content := h.Content
		for _, n := range nb {
			k := key{n.DocumentID, n.ChunkIndex}
			if !n.Windowed || absorbed[k] || isTopHit(hits[:i], k.doc, k.idx) {
				continue
			}
			var joined string
			var ok bool
			if n.ChunkIndex < h.ChunkIndex {
				joined, ok = joinOverlap(n.Content, content)
			} else {
				joined, ok = joinOverlap(content, n.Content)
			}
			if !ok {
				continue // split at a new subject, not a continuation
			}
			content = joined
			absorbed[k] = true
		}
		h.Content = content
	}
	if len(absorbed) == 0 {
		return hits
	}
	out := hits[:0:0]
	for _, h := range hits {
		if !absorbed[key{h.DocumentID, h.ChunkIndex}] {
			out = append(out, h)
		}
	}
	return out
}

func isTopHit(hits []Hit, doc string, idx int) bool {
	for _, h := range hits {
		if h.DocumentID == doc && h.ChunkIndex == idx {
			return true
		}
	}
	return false
}

// joinOverlap joins two consecutive windows, dropping the sentence the
// second repeats from the end of the first (see windowText's overlap). ok
// is false when they don't overlap, i.e. the second starts a new subject.
func joinOverlap(a, b string) (string, bool) {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	max := len(b)
	if len(a) < max {
		max = len(a)
	}
	if max > WindowOverlapChars+1 {
		max = WindowOverlapChars + 1
	}
	for k := max; k >= 20; k-- {
		if strings.HasSuffix(a, b[:k]) {
			return a + b[k:], true
		}
	}
	return "", false
}
