package database

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Knowledge base chunk context: AI one-line summaries for windowed chunks
// (filled by kb's context worker) and neighbouring-chunk lookups for search.

// KBContextJob is one windowed chunk waiting for its context line, with the
// chunk before it so pronouns ("she") can be resolved.
type KBContextJob struct {
	ChunkID     int64
	DocumentID  string
	DocTitle    string
	Heading     string
	Content     string
	PrevContent string
	PrevContext string
}

// NextPendingContext returns the earliest windowed chunk without a context
// line, in document order so the previous chunk's line is already written.
// skip lists chunk IDs that failed this run. Returns nil when none is left.
func (r *KBRepository) NextPendingContext(ctx context.Context, skip []int64) (*KBContextJob, error) {
	pool := GetPool()
	if pool == nil {
		return nil, errNoDB
	}
	if skip == nil {
		skip = []int64{}
	}
	j := &KBContextJob{}
	err := pool.QueryRow(ctx, `
		SELECT c.id, d.id::text, d.title, c.heading, c.content,
		       COALESCE(p.content, ''), COALESCE(p.context, '')
		FROM kb_chunks c
		JOIN kb_documents d ON d.id = c.document_id
		LEFT JOIN kb_chunks p ON p.document_id = c.document_id AND p.chunk_index = c.chunk_index - 1
		WHERE c.windowed AND c.context = '' AND d.status = 'ready' AND NOT (c.id = ANY($1))
		ORDER BY d.created_at, c.chunk_index
		LIMIT 1`, skip).Scan(&j.ChunkID, &j.DocumentID, &j.DocTitle, &j.Heading, &j.Content, &j.PrevContent, &j.PrevContext)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return j, nil
}

// SetChunkContext stores a chunk's context line, and its re-computed
// embedding when one is given.
func (r *KBRepository) SetChunkContext(ctx context.Context, chunkID int64, line string, embedding []float32) error {
	pool := GetPool()
	if pool == nil {
		return errNoDB
	}
	if embedding != nil && KBVectorEnabled() {
		_, err := pool.Exec(ctx, `UPDATE kb_chunks SET context = $2, embedding = $3::vector WHERE id = $1`,
			chunkID, line, vectorLiteral(embedding))
		return err
	}
	_, err := pool.Exec(ctx, `UPDATE kb_chunks SET context = $2 WHERE id = $1`, chunkID, line)
	return err
}

// ExistingContexts maps a document's chunk text to its context line, so a
// re-index keeps lines for unchanged chunks instead of asking the AI again.
func (r *KBRepository) ExistingContexts(ctx context.Context, docID string) map[string]string {
	out := map[string]string{}
	pool := GetPool()
	if pool == nil {
		return out
	}
	rows, err := pool.Query(ctx, `SELECT heading, content, context FROM kb_chunks
		WHERE document_id::text = $1 AND context <> ''`, docID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var h, c, line string
		if rows.Scan(&h, &c, &line) == nil {
			out[h+"\x00"+c] = line
		}
	}
	return out
}

// PendingContextCount reports how many of a document's chunks still wait
// for their context line (shown on the admin page while it fills in).
func (r *KBRepository) PendingContextCount(ctx context.Context) map[string]int {
	out := map[string]int{}
	pool := GetPool()
	if pool == nil {
		return out
	}
	rows, err := pool.Query(ctx, `SELECT document_id::text, COUNT(*) FROM kb_chunks
		WHERE windowed AND context = '' GROUP BY document_id`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		if rows.Scan(&id, &n) == nil {
			out[id] = n
		}
	}
	return out
}

// ChunksAt returns a document's chunks at the given positions, for adding
// neighbours to a search hit.
func (r *KBRepository) ChunksAt(ctx context.Context, docID string, indices []int) ([]KBHit, error) {
	pool := GetPool()
	if pool == nil || len(indices) == 0 {
		return []KBHit{}, nil
	}
	rows, err := pool.Query(ctx, `SELECT `+kbHitColumns+`, 0::float8
		FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
		WHERE d.id::text = $1 AND c.chunk_index = ANY($2)
		ORDER BY c.chunk_index`, docID, indices)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}
