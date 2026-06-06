package cache

import (
	"strings"
	"sync"
	"time"
)

type entry struct {
	data      interface{}
	expiresAt time.Time
}

// TTLCache is a thread-safe in-memory cache with per-entry TTL expiry.
type TTLCache struct {
	mu      sync.RWMutex
	entries map[string]*entry
}

func New() *TTLCache {
	c := &TTLCache{entries: make(map[string]*entry)}
	go c.runCleanup()
	return c
}

func (c *TTLCache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	e, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.data, true
}

func (c *TTLCache) Set(key string, data interface{}, ttl time.Duration) {
	c.mu.Lock()
	c.entries[key] = &entry{data: data, expiresAt: time.Now().Add(ttl)}
	c.mu.Unlock()
}

func (c *TTLCache) Invalidate(key string) {
	c.mu.Lock()
	delete(c.entries, key)
	c.mu.Unlock()
}

// InvalidatePrefix deletes all entries whose key starts with the given prefix.
func (c *TTLCache) InvalidatePrefix(prefix string) {
	c.mu.Lock()
	for k := range c.entries {
		if strings.HasPrefix(k, prefix) {
			delete(c.entries, k)
		}
	}
	c.mu.Unlock()
}

func (c *TTLCache) runCleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		c.mu.Lock()
		for k, e := range c.entries {
			if now.After(e.expiresAt) {
				delete(c.entries, k)
			}
		}
		c.mu.Unlock()
	}
}
