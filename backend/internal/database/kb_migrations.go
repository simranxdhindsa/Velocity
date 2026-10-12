package database

import (
	"context"
	"log"
	"sync/atomic"
)

// kbVectorEnabled reports whether the pgvector extension and the
// kb_chunks.embedding column exist. When false the knowledge base still
// works, with keyword (full-text) search only.
var kbVectorEnabled atomic.Bool

// KBVectorEnabled is read by the KB repository to decide between hybrid
// (vector + keyword) and keyword-only search.
func KBVectorEnabled() bool { return kbVectorEnabled.Load() }

// KBEmbeddingDims is the embedding size stored in kb_chunks.embedding. Changing
// it needs a new column plus a re-index of every document.
const KBEmbeddingDims = 768

// RunKBMigrations creates the admin knowledge base tables. Kept out of
// migrations.go (already very long). Called at the end of RunMigrations (exported for tests).
func RunKBMigrations(ctx context.Context) {
	pool := GetPool()
	if pool == nil {
		return
	}
	stmts := []string{
		// One row per uploaded file or pasted note. The original bytes are kept
		// so a document can be re-indexed after a parser or chunking change
		// without asking the admin to upload it again.
		`CREATE TABLE IF NOT EXISTS kb_documents (
			id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			title        TEXT NOT NULL,
			filename     TEXT NOT NULL DEFAULT '',
			mime_type    TEXT NOT NULL DEFAULT '',
			size_bytes   INTEGER NOT NULL DEFAULT 0,
			original     BYTEA,
			content_hash TEXT NOT NULL DEFAULT '',
			visibility   VARCHAR(16) NOT NULL DEFAULT 'everyone',
			status       VARCHAR(16) NOT NULL DEFAULT 'processing',
			error        TEXT NOT NULL DEFAULT '',
			chunk_count  INTEGER NOT NULL DEFAULT 0,
			char_count   INTEGER NOT NULL DEFAULT 0,
			embedded     BOOLEAN NOT NULL DEFAULT false,
			uploaded_by  VARCHAR(255) NOT NULL DEFAULT '',
			created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS kb_chunks (
			id          BIGSERIAL PRIMARY KEY,
			document_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
			chunk_index INTEGER NOT NULL,
			heading     TEXT NOT NULL DEFAULT '',
			content     TEXT NOT NULL,
			tsv         TSVECTOR GENERATED ALWAYS AS (
			                setweight(to_tsvector('simple', coalesce(heading, '')), 'A') ||
			                setweight(to_tsvector('simple', content), 'B')
			            ) STORED
		)`,
		`CREATE INDEX IF NOT EXISTS idx_kb_chunks_document ON kb_chunks(document_id, chunk_index)`,
		`CREATE INDEX IF NOT EXISTS idx_kb_chunks_tsv ON kb_chunks USING GIN(tsv)`,
	}
	for i, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			log.Printf("[kb] migration %d skipped: %v", i+1, err)
		}
	}

	// Vector search is optional: hosts without pgvector fall back to keyword
	// search instead of failing startup.
	vectorStmts := []string{
		`CREATE EXTENSION IF NOT EXISTS vector`,
		`ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS embedding vector(768)`,
		`CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops)`,
	}
	for _, s := range vectorStmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			log.Printf("[kb] pgvector unavailable, knowledge base will use keyword search only: %v", err)
			kbVectorEnabled.Store(false)
			return
		}
	}
	kbVectorEnabled.Store(true)
	log.Println("[kb] knowledge base ready (vector + keyword search)")
}
