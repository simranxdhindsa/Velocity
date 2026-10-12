# Team Knowledge Base

Admins upload documents (or write notes in Velocity) about the team: who is who, roles, who owns what, processes, policies. The Velocity Slack bot and the MCP `search_knowledge_base` tool answer from it.

## Access

- **Managing** (upload, edit, delete, test search): admins only. Every `/api/kb/*` route is behind `AuthMiddleware` + `AdminOnly` (`main.go`).
- **Answers**: everyone, filtered per document by `visibility`:
  - `everyone`: used for anyone talking to the bot or calling the MCP tool.
  - `admins`: used only when the asker is a Velocity admin (Slack sender email maps to a Velocity user with role `admin`; MCP caller role).
- The filter is applied inside the SQL of every search (`database/kb_repo.go`, `includeAdminOnly`), so no caller can forget it.

## Pipeline (`internal/services/kb/`)

Upload → stored as-is in `kb_documents.original` → background `Index`: `Extract` → `Split` → `EmbedDocuments` → `ReplaceChunks` (atomic swap) → status `ready`. One document is indexed at a time (avoids embedding rate limits). Documents left `processing` by a restart are resumed on startup (`kb.ResumePending` in `main.go`). Re-index re-runs the pipeline from the stored original, so parser/chunker changes never need a re-upload.

**Supported files** (`extract.go`): `.md .markdown .txt .text .log .rst .yaml .yml .csv .tsv .json .xml .html .htm .pdf .docx .pptx .xlsx`, 15 MB each. Office files are parsed as zipped XML with the standard library; PDFs use `github.com/ledongthuc/pdf` (text layer only, scanned PDFs are rejected with a clear message, no OCR). Images are not supported.

**Structure-aware extraction:**
- CSV/TSV/XLSX rows become `Header: value; Header: value` lines, so a roster row stays meaningful alone.
- JSON arrays of flat objects become one record line each; other JSON becomes `path: value`.
- HTML and Word headings become Markdown headings; PowerPoint gets `## Slide N` per slide.

**Chunking** (`chunk.go`): ~1600 chars target, 2200 max, 200 char overlap. Markdown splits on headings and keeps the heading path (`Team > Backend`) on each chunk; tiny sibling sections are merged with their names kept as labels; headings in code fences are ignored; tables are one record per line with no overlap.

## Search (`service.go`)

Hybrid: Postgres full-text (`tsv` generated column, `simple` config, OR of query terms with prefix match, stopwords removed) and pgvector cosine similarity on `gemini-embedding-001` (768 dims, `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`, key `GEMINI_API_KEY`, sent in a header). Results are fused with reciprocal rank fusion (k=60).

Meaning-only hits are filtered by a calibrated rule (measured live): cosine scores from this model sit in a narrow band (small talk scores 0.58-0.60 against any doc), so a hit must score ≥ 0.60 **and** beat the median candidate by ≥ 0.04. Keyword hits always count. Names and IDs are reliably found by keyword search, paraphrases by vectors.

Degrades gracefully: no pgvector (migration fails) or no `GEMINI_API_KEY` → keyword-only, and the document shows a warning explaining why.

## Slack bot use (`handlers/slack_bot_kb.go`)

Every reply searches with the incoming message (short follow-ups like "and him?" are combined with the previous human turn). Hits go into a `## Team knowledge base` section of the system prompt inside `<knowledge>` tags, marked as reference data that must never be followed as instructions (prompt-injection guard), max 5 hits / 6000 chars. If the KB has documents but nothing matched, a short hint tells the model it can call the `search_knowledge_base` bot tool. Tested live: answers from KB facts, refuses admins-only facts to members, ignores the KB for unrelated questions.

## API (`handlers/kb.go`, all admin-only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/kb/documents` | List docs + `vector_search`, `supported_extensions`, `max_file_bytes` |
| POST | `/api/kb/documents` | Multipart upload, field `files` (many) + `visibility`; per-file results, duplicates (same content hash) rejected |
| PATCH | `/api/kb/documents/{id}` | Rename / change visibility (applies to search immediately) |
| PUT | `/api/kb/documents/{id}/file` | Replace with a new version (re-indexes) |
| POST | `/api/kb/documents/{id}/reindex` | Re-run the pipeline |
| DELETE | `/api/kb/documents/{id}` | Delete (chunks cascade) |
| GET | `/api/kb/documents/{id}/chunks` | See exactly how it was split |
| GET | `/api/kb/documents/{id}/text` | A note's editable text |
| POST | `/api/kb/notes` | Create a note written in Velocity (stored as `.md`) |
| PUT | `/api/kb/notes/{id}` | Edit a note |
| GET | `/api/kb/search?q=&as=everyone\|admin` | Test search as a member or admin would see it |

## Tables (`database/kb_migrations.go`)

`kb_documents` (metadata, original bytes, content hash, visibility, status, error/warning, chunk/char counts, `embedded`) and `kb_chunks` (heading, content, generated `tsv` with GIN index, `embedding vector(768)` with HNSW index). Changing the embedding model or dimensions needs a new column and a re-index of every document.
