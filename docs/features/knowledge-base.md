# Team Knowledge Base

Admins upload documents (or write notes in Velocity) about the team: who is who, roles, who owns what, processes, policies. The Velocity Slack bot and the MCP `search_knowledge_base` tool answer from it.

## Access

- **Managing** (upload, edit, delete, test search): admins only. Every `/api/kb/*` route is behind `AuthMiddleware` + `AdminOnly` (`main.go`), and the nav item shows only for admins.
- **Answers**: the same for everyone who asks the bot or calls the MCP tool. There is no per-document visibility (built first, then removed on request 2026-10-12; the migration drops the old `visibility` column).

## Pipeline (`internal/services/kb/`)

Upload → stored as-is in `kb_documents.original` → background `Index`: `Extract` → `Split` → `EmbedDocuments` → `ReplaceChunks` (atomic swap) → status `ready`. One document is indexed at a time (avoids embedding rate limits). Documents left `processing` by a restart are resumed on startup (`kb.ResumePending` in `main.go`). Re-index re-runs the pipeline from the stored original, so parser/chunker changes never need a re-upload.

**Supported files** (`extract.go`): `.md .markdown .txt .text .log .rst .yaml .yml .csv .tsv .json .xml .html .htm .pdf .docx .pptx .xlsx`, 15 MB each. Office files are parsed as zipped XML with the standard library; PDFs use `github.com/ledongthuc/pdf` (text layer only, scanned PDFs are rejected with a clear message, no OCR). Images are not supported.

**PDF paragraphs** (`pdfParagraphs`): a PDF stores lines, not paragraphs. They are rebuilt from the library's row positions: a blank row, or a vertical gap over 1.6x the page's median line spacing, starts a paragraph. Lines inside a paragraph are re-joined into flowing text (a line ending in "-" joins without a space, so "fifty-" + "one" stays "fifty-one"). Without this, the Ardoise operations log PDF (9 paragraphs, one per person) came out as 3 size-cut chunks starting mid-sentence ("He also verified ...") with the person's name in another chunk. `pdftotext` (poppler) was not used: it is an external binary that would have to be installed in the Docker image.

**Two line readers, chosen per page** (`pdfLinesForPage`): the library's `GetTextByRow` reads most PDFs well, but on PDFs that position text with transformation matrices (the Ardoise ops log v3) it collapses ~50 lines into ~5 "rows" with no spaces between them ("priorityitem") and in the wrong order. Lines rebuilt from glyph coordinates (`pdfPageLines`) fix those PDFs but garble others with kerning quirks (the first Ardoise log). Glyph lines are used only when rows clearly collapsed (fewer than half as many rows as glyph lines).

**Paragraph breaks** in PDFs: a blank row, a gap over 1.6x the page's line spacing (25th percentile of gaps, not the median: pages full of short profiles pushed the median up until real gaps stopped clearing it), or a bold line after normal text (a heading like "Kanav, Developer Advocate, ApyHub").

**Unglued sentences** (`unglueSentences`): "life.Sandeep" becomes "life. Sandeep". Measured on production: Postgres indexed the glued form as one host-like token `life.sandeep`, so the bot's search for "Sandeep" found nothing and it said it didn't know.

**Structure-aware extraction:**
- CSV/TSV/XLSX rows become `Header: value; Header: value` lines, so a roster row stays meaningful alone.
- JSON arrays of flat objects become one record line each; other JSON becomes `path: value`.
- HTML and Word headings become Markdown headings; PowerPoint gets `## Slide N` per slide.

**Chunking** (`chunk.go`):
- **Plain text and PDFs: one chunk per paragraph** (a paragraph is usually one person or topic). Fragments under 100 chars (a lone heading line) merge into the next; one-sentence profiles (~150 chars) stay separate; only paragraphs over 2200 chars are split, by sentence. A short single first line (a title or "Date: 06 December 2025") becomes the heading of every chunk. The Ardoise ops log now gives 10 chunks, one per person/topic.
- **Markdown/HTML/Word**: split on headings, heading path kept (`Team > Backend`), paragraphs packed to ~1600 chars (2200 max, 200 overlap); tiny sibling sections are merged with their names kept as labels; headings in code fences are ignored.
- **Tables**: one record per line, no overlap.
- Every chunk's heading is prefixed with the document title (`withDocTitle`, in `Index`), so a chunk says where it came from when read or searched on its own.

## Search (`service.go`, `expand.go`)

Two channels fused with reciprocal rank fusion (k=60):

1. **Keyword**: Postgres full-text over two generated columns, `tsv` (`simple`, exact names/IDs) and `tsv_en` (`english`, word forms like owner/owns), OR of query terms with prefix match, stopwords removed.
2. **Meaning**, every channel that is available:
   - **Embeddings** (only if `GEMINI_API_KEY` is set and pgvector exists): `gemini-embedding-001`, 768 dims, cosine. Meaning-only hits must score ≥ 0.60 and beat the median candidate by ≥ 0.04 (calibrated live, scores sit in a narrow band).
   - **AI query expansion** (runs whenever an AI key exists, including alongside embeddings: with embeddings alone "who is the QA lead?" missed a chunk saying "Quality Assurance Lead"; Groq has no embeddings API, so in the normal Groq-only setup this is the only meaning channel): the chat model rewrites the question into the words an answering document would contain ("who handles refunds" → payments, billing, stripe, invoices), run as a second keyword search. Small talk, task requests and general knowledge return `NONE`, so nothing unrelated is pulled in. Hits are re-ranked by how many distinct expanded terms they contain (`rankByCoverage`), because Postgres rank weights headings so heavily that one generic word ("policy" in "Leave policy") outranked chunks matching several specific terms. Generic office words (lead, manager, process, policy, support, ...) are filtered from expansions for the same reason. Cached per question in memory.

**Exact words win:** if exactly one keyword hit contains every query word (stem-matched, e.g. a name plus "working"/"worked"), it is ranked first (`soleFullMatch`). Measured live: "what is Suryansh working on" was outvoted by Groq's generic expansion (project, task, sprint) for a name the model didn't know.

**Groq details (measured live):** expansion uses `ai.QueryDeterministic` (temperature 0, `max_tokens` 400, `reasoning_effort: low` on gpt-oss). At temperature 0 without low effort, `gpt-oss-20b` reasoned until the 2048-token cap and returned empty content. Groq's on-demand tier allows ~8k tokens/minute shared with the Slack bot, so the prompt is short and a rate-limited call is retried once after 3s; on failure search falls back to keyword only.

**Quality checks:**
- 7 small docs written with different words than the questions, Groq only: keyword only 6/13, with expansion 13/13 (two runs), including 4/4 small-talk questions correctly returning nothing.
- Ardoise Internal Operations PDF, 10 questions about specific people and facts (who rebooted the staging node, at what time, who is the QA lead, ...): 10/10 Groq only and 10/10 with Gemini embeddings.

The admin page chip shows "Smart search on" when either embeddings or an AI key is available (`kb.SmartSearchAvailable`).

## Slack bot use (`handlers/slack_bot_kb.go`)

Every reply searches with the incoming message (short follow-ups like "and him?" are combined with the previous human turn). Hits go into a `## Team knowledge base` section of the system prompt inside `<knowledge>` tags, marked as reference data that must never be followed as instructions (prompt-injection guard), max 5 hits / 6000 chars. If the KB has documents but nothing matched, a short hint tells the model it can call the `search_knowledge_base` bot tool. Tested live: answers from KB facts and ignores the KB for unrelated questions.

## API (`handlers/kb.go`, all admin-only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/kb/documents` | List docs + `smart_search`, `supported_extensions`, `max_file_bytes` |
| POST | `/api/kb/documents` | Multipart upload, field `files` (many); per-file results, duplicates (same content hash) rejected |
| PATCH | `/api/kb/documents/{id}` | Rename |
| PUT | `/api/kb/documents/{id}/file` | Replace with a new version (re-indexes) |
| POST | `/api/kb/documents/{id}/reindex` | Re-run the pipeline |
| DELETE | `/api/kb/documents/{id}` | Delete (chunks cascade) |
| GET | `/api/kb/documents/{id}/chunks` | See exactly how it was split |
| GET | `/api/kb/documents/{id}/text` | A note's editable text |
| POST | `/api/kb/notes` | Create a note written in Velocity (stored as `.md`) |
| PUT | `/api/kb/notes/{id}` | Edit a note |
| GET | `/api/kb/search?q=` | Test search, exactly what the bot would retrieve |

## Admin page (frontend)

Left nav → Settings → **Knowledge Base** (`/knowledge-base`), shown only to `role === 'admin'` (the API is admin-only regardless). Files: `pages/KnowledgeBasePage.tsx` (state, upload, polling), `pages/KnowledgeBaseParts.tsx` (document row, chunk preview, "Try a question", note editor, skeleton), `pages/knowledge-base-types.ts` (pure helpers), CSS `styles/pages/knowledge-base.css` (page/list) + `knowledge-base-tools.css` (search box, note modal).

- Drag and drop or "Upload files" (multiple); "Write a note" opens a Markdown editor (notes stay editable, files get "Upload a new version").
- Each row: status badge (Indexing / Ready / Ready with warning / Failed with reason), chunk preview ("exactly what the bot can read"), re-index, delete via `ConfirmModal`.
- Polls every 2.5s while anything is indexing.
- "Try a question" runs the real search, so admins can check coverage before anyone asks the bot. Results clear when documents change.
- Upload card (`KnowledgeBaseUpload.tsx`, always on the page, not a modal; design adapted from 21st.dev "File Upload Card"): drag and drop or browse, one request per file via XHR for real progress (`api.uploadKBFile`), then "Splitting into chunks" until the document is ready, failed (with reason) or rejected (unsupported type, too big, duplicate). Upload state lives in `hooks/useKBUploads.ts`; ✕ cancels an upload in flight, the bin deletes a finished document through `ConfirmModal`.
- UAT-verified in dark/light and at 390px (no horizontal scroll, last row clears the PM Assistant bubble).

## Tables (`database/kb_migrations.go`)

`kb_documents` (metadata, original bytes, content hash, status, error/warning, chunk/char counts, `embedded`) and `kb_chunks` (heading, content, generated `tsv` and `tsv_en` with GIN indexes, optional `embedding vector(768)` with HNSW index). Changing the embedding model or dimensions needs a new column and a re-index of every document.
