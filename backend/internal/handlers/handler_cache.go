package handlers

import "github.com/dhindsa/project-management/internal/cache"

// apiCache is the shared TTL cache for expensive handler responses.
// Entries are invalidated by YouTrack webhooks and expire automatically via TTL.
// Keys: "board:{userID}:{sprintID}", "sprints:{userID}"
var apiCache = cache.New()
