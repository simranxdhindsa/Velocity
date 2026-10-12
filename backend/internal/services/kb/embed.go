package kb

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// Embeddings come from Gemini (Groq, the chat provider, has no embedding
// API). gemini-embedding-001 truncated to 768 dimensions matches
// database.KBEmbeddingDims; the model can be overridden with
// KB_EMBEDDING_MODEL, but a model with different output needs a re-index.
const (
	defaultEmbeddingModel = "gemini-embedding-001"
	embeddingDims         = 768
	embedBatchSize        = 100 // Gemini's batchEmbedContents limit
)

// ErrNoEmbeddingKey means GEMINI_API_KEY is not set: documents are still
// indexed for keyword search, just without vectors.
var ErrNoEmbeddingKey = errors.New("GEMINI_API_KEY is not set")

var embedHTTP = &http.Client{Timeout: 60 * time.Second}

func embeddingModel() string {
	if m := os.Getenv("KB_EMBEDDING_MODEL"); m != "" {
		return m
	}
	return defaultEmbeddingModel
}

// EmbeddingsAvailable reports whether an embedding key is configured.
func EmbeddingsAvailable() bool { return os.Getenv("GEMINI_API_KEY") != "" }

// EmbedDocuments embeds chunk texts for storage (task RETRIEVAL_DOCUMENT),
// batching and retrying on rate limits. title is the document title, which
// Gemini uses as extra context for document embeddings.
func EmbedDocuments(ctx context.Context, title string, texts []string) ([][]float32, error) {
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += embedBatchSize {
		end := start + embedBatchSize
		if end > len(texts) {
			end = len(texts)
		}
		vecs, err := embedBatch(ctx, "RETRIEVAL_DOCUMENT", title, texts[start:end])
		if err != nil {
			return nil, err
		}
		out = append(out, vecs...)
	}
	return out, nil
}

// EmbedQuery embeds a search query (task RETRIEVAL_QUERY).
func EmbedQuery(ctx context.Context, q string) ([]float32, error) {
	vecs, err := embedBatch(ctx, "RETRIEVAL_QUERY", "", []string{q})
	if err != nil {
		return nil, err
	}
	return vecs[0], nil
}

func embedBatch(ctx context.Context, task, title string, texts []string) ([][]float32, error) {
	key := os.Getenv("GEMINI_API_KEY")
	if key == "" {
		return nil, ErrNoEmbeddingKey
	}
	model := embeddingModel()
	type part struct {
		Text string `json:"text"`
	}
	type request struct {
		Model   string `json:"model"`
		Content struct {
			Parts []part `json:"parts"`
		} `json:"content"`
		TaskType             string `json:"taskType"`
		Title                string `json:"title,omitempty"`
		OutputDimensionality int    `json:"outputDimensionality"`
	}
	reqs := make([]request, len(texts))
	for i, t := range texts {
		reqs[i].Model = "models/" + model
		reqs[i].Content.Parts = []part{{Text: t}}
		reqs[i].TaskType = task
		if task == "RETRIEVAL_DOCUMENT" {
			reqs[i].Title = title
		}
		reqs[i].OutputDimensionality = embeddingDims
	}
	body, _ := json.Marshal(map[string]interface{}{"requests": reqs})
	url := "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":batchEmbedContents"

	var lastErr error
	backoff := 2 * time.Second
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
			backoff *= 2
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-goog-api-key", key) // header, never the URL, so the key stays out of logs
		resp, err := embedHTTP.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("embedding API %d", resp.StatusCode)
			continue
		}
		var parsed struct {
			Embeddings []struct {
				Values []float32 `json:"values"`
			} `json:"embeddings"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return nil, fmt.Errorf("embedding API: bad response (%d)", resp.StatusCode)
		}
		if parsed.Error != nil {
			return nil, fmt.Errorf("embedding API: %s", parsed.Error.Message)
		}
		if len(parsed.Embeddings) != len(texts) {
			return nil, fmt.Errorf("embedding API returned %d vectors for %d texts", len(parsed.Embeddings), len(texts))
		}
		out := make([][]float32, len(texts))
		for i, e := range parsed.Embeddings {
			if len(e.Values) != embeddingDims {
				return nil, fmt.Errorf("embedding has %d dims, expected %d", len(e.Values), embeddingDims)
			}
			out[i] = e.Values
		}
		return out, nil
	}
	return nil, fmt.Errorf("embedding failed after retries: %w", lastErr)
}

// EmbeddingText is what gets embedded for a chunk: the section path gives a
// short chunk the context it lacks on its own ("Backend > Amrinder" + "owns
// payments").
func EmbeddingText(heading, content string) string {
	if heading == "" {
		return content
	}
	return heading + "\n\n" + content
}
