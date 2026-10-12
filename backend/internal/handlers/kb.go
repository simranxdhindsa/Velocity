package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/services/kb"
	"github.com/gorilla/mux"
)

// KBHandler serves the admin knowledge base API under /api/kb. Every route
// is admin-only at the router (main.go); answers from it reach everyone
// through the Slack bot and MCP, the same for every asker.
type KBHandler struct {
	repo *database.KBRepository
}

func NewKBHandler() *KBHandler {
	return &KBHandler{repo: database.NewKBRepository()}
}

func kbFail(w http.ResponseWriter, status int, msg string) {
	sendJSON(w, status, map[string]interface{}{"success": false, "message": msg})
}

// List handles GET /api/kb/documents.
func (h *KBHandler) List(w http.ResponseWriter, r *http.Request) {
	docs, err := h.repo.ListDocuments(r.Context())
	if err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	pending := h.repo.PendingContextCount(r.Context())
	for i := range docs {
		docs[i].ContextPending = pending[docs[i].ID]
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{
		"success":              true,
		"data":                 docs,
		"smart_search":         kb.SmartSearchAvailable(),
		"supported_extensions": kb.SupportedExtensions,
		"max_file_bytes":       kb.MaxFileBytes,
	})
}

type kbUploadResult struct {
	Filename string               `json:"filename"`
	Document *database.KBDocument `json:"document,omitempty"`
	Error    string               `json:"error,omitempty"`
}

// Upload handles POST /api/kb/documents (multipart: one or more "files",
// "file"). Each file is validated, stored and indexed in the
// background; per-file errors don't fail the whole batch.
func (h *KBHandler) Upload(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		kbFail(w, http.StatusBadRequest, "upload too large or malformed (100 MB per request)")
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		files = r.MultipartForm.File["file"]
	}
	if len(files) == 0 {
		kbFail(w, http.StatusBadRequest, "no files in the upload")
		return
	}

	results := make([]kbUploadResult, 0, len(files))
	for _, fh := range files {
		res := kbUploadResult{Filename: fh.Filename}
		data, err := readUpload(fh)
		if err != nil {
			res.Error = err.Error()
			results = append(results, res)
			continue
		}
		doc, err := h.createDocument(r, user.ID, kbTitleFromFilename(fh.Filename), fh.Filename, fh.Header.Get("Content-Type"), data)
		if err != nil {
			res.Error = err.Error()
		} else {
			res.Document = doc
		}
		results = append(results, res)
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{"success": true, "data": results})
}

func readUpload(fh *multipart.FileHeader) ([]byte, error) {
	if fh.Size > kb.MaxFileBytes {
		return nil, fmt.Errorf("file is larger than %d MB", kb.MaxFileBytes>>20)
	}
	f, err := fh.Open()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, kb.MaxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > kb.MaxFileBytes {
		return nil, fmt.Errorf("file is larger than %d MB", kb.MaxFileBytes>>20)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("file is empty")
	}
	return data, nil
}

// createDocument validates the type up front (so an unsupported file is
// rejected immediately instead of failing later in the background),
// rejects exact duplicates, stores the file and queues indexing.
func (h *KBHandler) createDocument(r *http.Request, userID, title, filename, mime string, data []byte) (*database.KBDocument, error) {
	if !kbSupported(filename) {
		return nil, fmt.Errorf("unsupported file type, supported: %s", strings.Join(kb.SupportedExtensions, " "))
	}
	hash := kb.ContentHash(data)
	if dup, _ := h.repo.FindByHash(r.Context(), hash); dup != nil {
		return nil, fmt.Errorf("already in the knowledge base as %q", dup.Title)
	}
	doc, err := h.repo.CreateDocument(r.Context(), &database.KBDocument{
		Title: title, Filename: filename, MimeType: mime, Original: data,
		UploadedBy: userID,
	}, hash)
	if err != nil {
		return nil, err
	}
	kb.IndexAsync(doc.ID)
	return doc, nil
}

func kbSupported(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	for _, e := range kb.SupportedExtensions {
		if e == ext {
			return true
		}
	}
	return false
}

var kbTitleSepRe = regexp.MustCompile(`[_\-]+`)

// kbTitleFromFilename turns "team_roster-2026.csv" into "team roster 2026".
func kbTitleFromFilename(name string) string {
	base := strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
	base = strings.TrimSpace(kbTitleSepRe.ReplaceAllString(base, " "))
	if base == "" {
		return name
	}
	return base
}

type kbNoteRequest struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

// CreateNote handles POST /api/kb/notes: a document written in Velocity
// itself (stored and indexed as Markdown), e.g. a quick team roster.
func (h *KBHandler) CreateNote(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	var req kbNoteRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, kb.MaxFileBytes)).Decode(&req); err != nil {
		kbFail(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || strings.TrimSpace(req.Content) == "" {
		kbFail(w, http.StatusBadRequest, "title and content are required")
		return
	}
	doc, err := h.createDocument(r, user.ID, req.Title, kbNoteFilename(req.Title), "text/markdown", []byte(req.Content))
	if err != nil {
		kbFail(w, http.StatusBadRequest, err.Error())
		return
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{"success": true, "data": doc})
}

var kbUnsafeNameRe = regexp.MustCompile(`[^A-Za-z0-9 ._-]+`)

func kbNoteFilename(title string) string {
	n := strings.TrimSpace(kbUnsafeNameRe.ReplaceAllString(title, ""))
	if n == "" {
		n = "note"
	}
	return truncateText(n, 80) + ".md"
}

// UpdateNote handles PUT /api/kb/notes/{id}: edit a note's text in place.
func (h *KBHandler) UpdateNote(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	doc, err := h.repo.GetDocument(r.Context(), id, false)
	if err != nil || doc == nil {
		kbFail(w, http.StatusNotFound, "document not found")
		return
	}
	if doc.MimeType != "text/markdown" || !strings.HasSuffix(doc.Filename, ".md") {
		kbFail(w, http.StatusBadRequest, "only notes written in Velocity can be edited here, replace the file instead")
		return
	}
	var req kbNoteRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, kb.MaxFileBytes)).Decode(&req); err != nil {
		kbFail(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		kbFail(w, http.StatusBadRequest, "content is required")
		return
	}
	if err := h.repo.Rename(r.Context(), id, strings.TrimSpace(req.Title)); err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	data := []byte(req.Content)
	if err := h.repo.ReplaceOriginal(r.Context(), id, doc.Filename, doc.MimeType, data, kb.ContentHash(data)); err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	kb.IndexAsync(id)
	h.respondDoc(w, r, id)
}

// Update handles PATCH /api/kb/documents/{id} (rename).
func (h *KBHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	var req struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		kbFail(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if doc, _ := h.repo.GetDocument(r.Context(), id, false); doc == nil {
		kbFail(w, http.StatusNotFound, "document not found")
		return
	}
	if err := h.repo.Rename(r.Context(), id, strings.TrimSpace(req.Title)); err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.respondDoc(w, r, id)
}

// ReplaceFile handles PUT /api/kb/documents/{id}/file (multipart "file"):
// upload a new version, keeping the title.
func (h *KBHandler) ReplaceFile(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if doc, _ := h.repo.GetDocument(r.Context(), id, false); doc == nil {
		kbFail(w, http.StatusNotFound, "document not found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, kb.MaxFileBytes+(1<<20))
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		kbFail(w, http.StatusBadRequest, "upload too large or malformed")
		return
	}
	file, fh, err := r.FormFile("file")
	if err != nil {
		kbFail(w, http.StatusBadRequest, "no file in the upload")
		return
	}
	file.Close()
	if !kbSupported(fh.Filename) {
		kbFail(w, http.StatusBadRequest, "unsupported file type, supported: "+strings.Join(kb.SupportedExtensions, " "))
		return
	}
	data, err := readUpload(fh)
	if err != nil {
		kbFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.repo.ReplaceOriginal(r.Context(), id, fh.Filename, fh.Header.Get("Content-Type"), data, kb.ContentHash(data)); err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	kb.IndexAsync(id)
	h.respondDoc(w, r, id)
}

// Reindex handles POST /api/kb/documents/{id}/reindex.
func (h *KBHandler) Reindex(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if doc, _ := h.repo.GetDocument(r.Context(), id, false); doc == nil {
		kbFail(w, http.StatusNotFound, "document not found")
		return
	}
	if err := h.repo.SetStatus(r.Context(), id, database.KBStatusProcessing, ""); err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	kb.IndexAsync(id)
	h.respondDoc(w, r, id)
}

// Delete handles DELETE /api/kb/documents/{id}.
func (h *KBHandler) Delete(w http.ResponseWriter, r *http.Request) {
	ok, err := h.repo.DeleteDocument(r.Context(), mux.Vars(r)["id"])
	if err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		kbFail(w, http.StatusNotFound, "document not found")
		return
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// Chunks handles GET /api/kb/documents/{id}/chunks: how a document was
// split, so an admin can check what the bot will actually see.
func (h *KBHandler) Chunks(w http.ResponseWriter, r *http.Request) {
	chunks, err := h.repo.ListChunks(r.Context(), mux.Vars(r)["id"], 500)
	if err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{"success": true, "data": chunks})
}

// Text handles GET /api/kb/documents/{id}/text: a note's original text,
// for editing it in place.
func (h *KBHandler) Text(w http.ResponseWriter, r *http.Request) {
	doc, err := h.repo.GetDocument(r.Context(), mux.Vars(r)["id"], true)
	if err != nil || doc == nil {
		kbFail(w, http.StatusNotFound, "document not found")
		return
	}
	if !strings.HasSuffix(doc.Filename, ".md") || doc.MimeType != "text/markdown" {
		kbFail(w, http.StatusBadRequest, "only notes written in Velocity have editable text")
		return
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{"success": true, "data": map[string]string{
		"title": doc.Title, "content": string(doc.Original),
	}})
}

// Search handles GET /api/kb/search?q=...: the "try a question" box,
// showing exactly what the bot would retrieve for that question.
func (h *KBHandler) Search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		kbFail(w, http.StatusBadRequest, "q is required")
		return
	}
	hits, err := kb.Search(r.Context(), q, 8)
	if err != nil {
		kbFail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if hits == nil {
		hits = []kb.Hit{}
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{"success": true, "data": hits})
}

func (h *KBHandler) respondDoc(w http.ResponseWriter, r *http.Request, id string) {
	doc, err := h.repo.GetDocument(r.Context(), id, false)
	if err != nil || doc == nil {
		kbFail(w, http.StatusNotFound, "document not found")
		return
	}
	sendJSON(w, http.StatusOK, map[string]interface{}{"success": true, "data": doc})
}
