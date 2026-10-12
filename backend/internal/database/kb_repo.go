package database

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Admin knowledge base storage (tables in kb_migrations.go). Visibility is
// enforced here, in every search query, so no caller can forget it:
// includeAdminOnly must be true only when the person asking is an admin.

const (
	KBVisibilityEveryone = "everyone"
	KBVisibilityAdmins   = "admins"

	KBStatusProcessing = "processing"
	KBStatusReady      = "ready"
	KBStatusFailed     = "failed"
)

type KBDocument struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Filename   string    `json:"filename"`
	MimeType   string    `json:"mime_type"`
	SizeBytes  int       `json:"size_bytes"`
	Visibility string    `json:"visibility"`
	Status     string    `json:"status"`
	Error      string    `json:"error"`
	ChunkCount int       `json:"chunk_count"`
	CharCount  int       `json:"char_count"`
	Embedded   bool      `json:"embedded"`
	UploadedBy string    `json:"uploaded_by"`
	Uploader   string    `json:"uploader_name"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
	Original   []byte    `json:"-"`
}

// KBChunkInput is one chunk to store. Embedding is nil when vectors are
// unavailable (no key or no pgvector).
type KBChunkInput struct {
	Heading   string
	Content   string
	Embedding []float32
}

// KBHit is one search result.
type KBHit struct {
	ChunkID    int64   `json:"chunk_id"`
	DocumentID string  `json:"document_id"`
	DocTitle   string  `json:"document_title"`
	Heading    string  `json:"heading"`
	Content    string  `json:"content"`
	Visibility string  `json:"visibility"`
	Score      float64 `json:"score"`
}

type KBRepository struct{}

func NewKBRepository() *KBRepository { return &KBRepository{} }

var errNoDB = errors.New("database not configured")

const kbDocColumns = `d.id::text, d.title, d.filename, d.mime_type, d.size_bytes, d.visibility, d.status,
	d.error, d.chunk_count, d.char_count, d.embedded, d.uploaded_by, COALESCE(u.name, ''), d.created_at, d.updated_at`

func scanKBDoc(row pgx.Row, d *KBDocument, extra ...interface{}) error {
	dest := []interface{}{&d.ID, &d.Title, &d.Filename, &d.MimeType, &d.SizeBytes, &d.Visibility, &d.Status,
		&d.Error, &d.ChunkCount, &d.CharCount, &d.Embedded, &d.UploadedBy, &d.Uploader, &d.CreatedAt, &d.UpdatedAt}
	return row.Scan(append(dest, extra...)...)
}

// CreateDocument inserts a document in "processing" state and returns it.
func (r *KBRepository) CreateDocument(ctx context.Context, d *KBDocument, contentHash string) (*KBDocument, error) {
	pool := GetPool()
	if pool == nil {
		return nil, errNoDB
	}
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO kb_documents (title, filename, mime_type, size_bytes, original, content_hash, visibility, status, uploaded_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8)
		RETURNING id::text
	`, d.Title, d.Filename, d.MimeType, len(d.Original), d.Original, contentHash, d.Visibility, d.UploadedBy).Scan(&id)
	if err != nil {
		return nil, err
	}
	return r.GetDocument(ctx, id, false)
}

// FindByHash returns a document with identical content, for duplicate
// upload detection.
func (r *KBRepository) FindByHash(ctx context.Context, hash string) (*KBDocument, error) {
	pool := GetPool()
	if pool == nil || hash == "" {
		return nil, nil
	}
	d := &KBDocument{}
	err := scanKBDoc(pool.QueryRow(ctx, `SELECT `+kbDocColumns+`
		FROM kb_documents d LEFT JOIN users u ON u.id = d.uploaded_by
		WHERE d.content_hash = $1 LIMIT 1`, hash), d)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return d, nil
}

// GetDocument loads one document; withOriginal also loads the file bytes.
func (r *KBRepository) GetDocument(ctx context.Context, id string, withOriginal bool) (*KBDocument, error) {
	pool := GetPool()
	if pool == nil {
		return nil, errNoDB
	}
	d := &KBDocument{}
	cols := kbDocColumns
	var extra []interface{}
	if withOriginal {
		cols += `, d.original`
		extra = append(extra, &d.Original)
	}
	err := scanKBDoc(pool.QueryRow(ctx, `SELECT `+cols+`
		FROM kb_documents d LEFT JOIN users u ON u.id = d.uploaded_by
		WHERE d.id::text = $1`, id), d, extra...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return d, nil
}

// ListDocuments returns every document, newest first, without file bytes.
func (r *KBRepository) ListDocuments(ctx context.Context) ([]KBDocument, error) {
	pool := GetPool()
	if pool == nil {
		return []KBDocument{}, nil
	}
	rows, err := pool.Query(ctx, `SELECT `+kbDocColumns+`
		FROM kb_documents d LEFT JOIN users u ON u.id = d.uploaded_by
		ORDER BY d.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	docs := []KBDocument{}
	for rows.Next() {
		var d KBDocument
		if err := scanKBDoc(rows, &d); err != nil {
			return nil, err
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// ListProcessing returns ids of documents left mid-indexing (e.g. by a
// restart), so they can be resumed.
func (r *KBRepository) ListProcessing(ctx context.Context) ([]string, error) {
	pool := GetPool()
	if pool == nil {
		return nil, nil
	}
	rows, err := pool.Query(ctx, `SELECT id::text FROM kb_documents WHERE status = 'processing'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// UpdateMeta changes a document's title and/or visibility (empty = keep).
func (r *KBRepository) UpdateMeta(ctx context.Context, id, title, visibility string) error {
	pool := GetPool()
	if pool == nil {
		return errNoDB
	}
	_, err := pool.Exec(ctx, `
		UPDATE kb_documents SET
			title = COALESCE(NULLIF($2, ''), title),
			visibility = COALESCE(NULLIF($3, ''), visibility),
			updated_at = NOW()
		WHERE id::text = $1`, id, title, visibility)
	return err
}

// ReplaceOriginal swaps in a new file version (Replace in the UI) and
// marks the document for re-indexing.
func (r *KBRepository) ReplaceOriginal(ctx context.Context, id, filename, mime string, data []byte, hash string) error {
	pool := GetPool()
	if pool == nil {
		return errNoDB
	}
	_, err := pool.Exec(ctx, `
		UPDATE kb_documents SET filename = $2, mime_type = $3, original = $4, size_bytes = $5,
			content_hash = $6, status = 'processing', error = '', updated_at = NOW()
		WHERE id::text = $1`, id, filename, mime, data, len(data), hash)
	return err
}

// SetStatus records a status change, with an error message on failure.
func (r *KBRepository) SetStatus(ctx context.Context, id, status, errMsg string) error {
	pool := GetPool()
	if pool == nil {
		return errNoDB
	}
	_, err := pool.Exec(ctx, `UPDATE kb_documents SET status = $2, error = $3, updated_at = NOW() WHERE id::text = $1`,
		id, status, errMsg)
	return err
}

// ReplaceChunks atomically swaps a document's chunks and marks it ready.
func (r *KBRepository) ReplaceChunks(ctx context.Context, id string, chunks []KBChunkInput, charCount int, warning string) error {
	pool := GetPool()
	if pool == nil {
		return errNoDB
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM kb_chunks WHERE document_id::text = $1`, id); err != nil {
		return err
	}
	embedded := len(chunks) > 0
	for i, c := range chunks {
		if c.Embedding != nil && KBVectorEnabled() {
			_, err = tx.Exec(ctx, `INSERT INTO kb_chunks (document_id, chunk_index, heading, content, embedding)
				VALUES ($1::uuid, $2, $3, $4, $5::vector)`, id, i, c.Heading, c.Content, vectorLiteral(c.Embedding))
		} else {
			embedded = false
			_, err = tx.Exec(ctx, `INSERT INTO kb_chunks (document_id, chunk_index, heading, content)
				VALUES ($1::uuid, $2, $3, $4)`, id, i, c.Heading, c.Content)
		}
		if err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE kb_documents SET status = 'ready', error = $2, chunk_count = $3,
		char_count = $4, embedded = $5, updated_at = NOW() WHERE id::text = $1`,
		id, warning, len(chunks), charCount, embedded); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeleteDocument removes a document and (by cascade) its chunks.
func (r *KBRepository) DeleteDocument(ctx context.Context, id string) (bool, error) {
	pool := GetPool()
	if pool == nil {
		return false, errNoDB
	}
	tag, err := pool.Exec(ctx, `DELETE FROM kb_documents WHERE id::text = $1`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ListChunks returns a document's chunks in order (admin preview).
func (r *KBRepository) ListChunks(ctx context.Context, id string, limit int) ([]KBHit, error) {
	pool := GetPool()
	if pool == nil {
		return []KBHit{}, nil
	}
	rows, err := pool.Query(ctx, `SELECT c.id, d.id::text, d.title, c.heading, c.content, d.visibility, 0::float8
		FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
		WHERE d.id::text = $1 ORDER BY c.chunk_index LIMIT $2`, id, limit)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// KeywordSearch ranks chunks by full-text match. terms are already
// normalized words (see kb.QueryTerms); any term may match, and chunks
// matching more terms (or in the heading) rank higher.
func (r *KBRepository) KeywordSearch(ctx context.Context, terms []string, includeAdminOnly bool, limit int) ([]KBHit, error) {
	pool := GetPool()
	if pool == nil || len(terms) == 0 {
		return []KBHit{}, nil
	}
	parts := make([]string, 0, len(terms))
	for _, t := range terms {
		parts = append(parts, quoteLexeme(t)+":*")
	}
	tsq := strings.Join(parts, " | ")
	rows, err := pool.Query(ctx, `
		SELECT c.id, d.id::text, d.title, c.heading, c.content, d.visibility,
		       ts_rank_cd(c.tsv, q, 1)::float8 AS score
		FROM kb_chunks c
		JOIN kb_documents d ON d.id = c.document_id,
		     to_tsquery('simple', $1) q
		WHERE c.tsv @@ q AND d.status = 'ready' AND ($2 OR d.visibility = 'everyone')
		ORDER BY score DESC
		LIMIT $3`, tsq, includeAdminOnly, limit)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// VectorSearch ranks chunks by cosine similarity (score 0..1, higher is
// closer). Returns nothing when pgvector is unavailable.
func (r *KBRepository) VectorSearch(ctx context.Context, vec []float32, includeAdminOnly bool, limit int) ([]KBHit, error) {
	pool := GetPool()
	if pool == nil || !KBVectorEnabled() || len(vec) == 0 {
		return []KBHit{}, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT c.id, d.id::text, d.title, c.heading, c.content, d.visibility,
		       (1 - (c.embedding <=> $1::vector))::float8 AS score
		FROM kb_chunks c
		JOIN kb_documents d ON d.id = c.document_id
		WHERE c.embedding IS NOT NULL AND d.status = 'ready' AND ($2 OR d.visibility = 'everyone')
		ORDER BY c.embedding <=> $1::vector
		LIMIT $3`, vectorLiteral(vec), includeAdminOnly, limit)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// CountReady reports how many ready documents a viewer can see, so callers
// can skip searching an empty knowledge base.
func (r *KBRepository) CountReady(ctx context.Context, includeAdminOnly bool) int {
	pool := GetPool()
	if pool == nil {
		return 0
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM kb_documents
		WHERE status = 'ready' AND chunk_count > 0 AND ($1 OR visibility = 'everyone')`, includeAdminOnly).Scan(&n)
	return n
}

func scanHits(rows pgx.Rows) ([]KBHit, error) {
	defer rows.Close()
	hits := []KBHit{}
	for rows.Next() {
		var h KBHit
		if err := rows.Scan(&h.ChunkID, &h.DocumentID, &h.DocTitle, &h.Heading, &h.Content, &h.Visibility, &h.Score); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// vectorLiteral formats a vector as pgvector text input ("[0.1,0.2]").
func vectorLiteral(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 10)
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(f), 'f', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

// quoteLexeme makes a term safe inside to_tsquery (single-quoted lexeme).
func quoteLexeme(t string) string {
	return "'" + strings.ReplaceAll(t, "'", "''") + "'"
}
