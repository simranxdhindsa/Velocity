package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// SSEEvent represents an event sent to connected clients
type SSEEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// SSEHub manages connected SSE clients and broadcasts events
type SSEHub struct {
	clients map[chan SSEEvent]bool
	mu      sync.RWMutex
}

// NewSSEHub creates a new SSE hub
func NewSSEHub() *SSEHub {
	return &SSEHub{
		clients: make(map[chan SSEEvent]bool),
	}
}

// AddClient registers a new SSE client
func (h *SSEHub) AddClient(ch chan SSEEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[ch] = true
	log.Printf("[SSE] Client connected (total: %d)", len(h.clients))
}

// RemoveClient unregisters an SSE client
func (h *SSEHub) RemoveClient(ch chan SSEEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, ch)
	close(ch)
	log.Printf("[SSE] Client disconnected (total: %d)", len(h.clients))
}

// Broadcast sends an event to all connected clients
func (h *SSEHub) Broadcast(event SSEEvent) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for ch := range h.clients {
		select {
		case ch <- event:
		default:
			// Client buffer full, skip (non-blocking)
		}
	}

	log.Printf("[SSE] Broadcast event '%s' to %d clients", event.Type, len(h.clients))
}

// HandleEvents is the SSE endpoint — keeps connection open, streams events
func (h *SSEHub) HandleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// Create client channel with buffer
	ch := make(chan SSEEvent, 10)
	h.AddClient(ch)

	// Remove client on disconnect
	ctx := r.Context()
	go func() {
		<-ctx.Done()
		h.RemoveClient(ch)
	}()

	// Send initial connection event
	fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n")
	flusher.Flush()

	// Heartbeat ticker to keep connection alive
	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case event := <-ch:
			data, err := json.Marshal(event.Data)
			if err != nil {
				log.Printf("[SSE] Failed to marshal event data: %v", err)
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
			flusher.Flush()

		case <-heartbeat.C:
			// Send comment to keep connection alive
			fmt.Fprintf(w, ":\n\n")
			flusher.Flush()
		}
	}
}
