package handlers

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/logging"
	"github.com/dhindsa/project-management/internal/middleware"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// Names and photos for the Chats list. A conversation Velocity opens for a user only knows the
// person's Slack ID, so the profile is asked of Slack and remembered for a while.

type slackProfile struct {
	Name  string
	Image string
}

const (
	slackProfileTTL     = 6 * time.Hour
	slackProfileRetry   = time.Minute // after a failed lookup, wait before asking Slack again
	slackProfileWorkers = 8
)

type cachedProfile struct {
	p  slackProfile
	ok bool
	at time.Time
}

var (
	slackProfileMu    sync.Mutex
	slackProfileCache = map[string]cachedProfile{}
)

func cachedSlackProfile(id string) (slackProfile, bool, bool) {
	slackProfileMu.Lock()
	defer slackProfileMu.Unlock()
	c, found := slackProfileCache[id]
	if !found {
		return slackProfile{}, false, false
	}
	ttl := slackProfileTTL
	if !c.ok {
		ttl = slackProfileRetry
	}
	if time.Since(c.at) > ttl {
		return slackProfile{}, false, false
	}
	return c.p, c.ok, true
}

func storeSlackProfile(id string, p slackProfile, ok bool) {
	slackProfileMu.Lock()
	slackProfileCache[id] = cachedProfile{p: p, ok: ok, at: time.Now()}
	slackProfileMu.Unlock()
}

// slackProfileLookup builds the real lookup: Slack users.info with the admin's own bot token.
func slackProfileLookup(integrations *database.IntegrationRepository) func(context.Context, string, string) (slackProfile, bool) {
	return func(ctx context.Context, adminID, slackUserID string) (slackProfile, bool) {
		if p, ok, hit := cachedSlackProfile(slackUserID); hit {
			return p, ok
		}
		integ, err := integrations.GetSlackIntegration(ctx, adminID)
		if err != nil || integ == nil || integ.BotToken == "" {
			return slackProfile{}, false
		}
		u, err := slacksvc.NewClient(integ.BotToken).GetUser(ctx, slackUserID)
		if err != nil || u == nil {
			storeSlackProfile(slackUserID, slackProfile{}, false)
			return slackProfile{}, false
		}
		p := slackProfile{Name: u.Profile.DisplayName, Image: u.Profile.Image72}
		if p.Name == "" {
			p.Name = u.RealName
		}
		if p.Name == "" {
			p.Name = u.Name
		}
		if p.Image == "" {
			p.Image = u.Profile.Image48
		}
		storeSlackProfile(slackUserID, p, true)
		return p, true
	}
}

// velocityUserImage finds a Velocity user's Slack photo by their email, falling back to the photo
// from their Velocity account. The cache key is prefixed so it can never clash with a Slack ID.
func velocityUserImage(users *database.UserRepository, integrations *database.IntegrationRepository) func(context.Context, string, string) string {
	return func(ctx context.Context, adminID, velocityUserID string) string {
		key := "velocity:" + velocityUserID
		if p, _, hit := cachedSlackProfile(key); hit {
			return p.Image
		}
		u, err := users.GetByID(ctx, velocityUserID)
		if err != nil || u == nil {
			storeSlackProfile(key, slackProfile{}, false)
			return ""
		}
		image := u.Picture
		if integ, err := integrations.GetSlackIntegration(ctx, adminID); err == nil && integ != nil && integ.BotToken != "" && u.Email != "" {
			if su, err := slacksvc.NewClient(integ.BotToken).GetUserByEmail(ctx, u.Email); err == nil && su != nil {
				if su.Profile.Image72 != "" {
					image = su.Profile.Image72
				} else if su.Profile.Image48 != "" {
					image = su.Profile.Image48
				}
			}
		}
		storeSlackProfile(key, slackProfile{Image: image}, image != "")
		return image
	}
}

func slackIDsOf(items []database.SlackDMListItem) []string {
	ids := make([]string, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.SlackUserID)
	}
	return ids
}

// profiles looks up each distinct Slack ID (a few at a time, within a short deadline) and
// returns the ones Slack answered for. A person Slack could not be asked about just keeps the
// stored name, so the page never fails because of this.
func (h *SlackChatsHandler) profiles(r *http.Request, ids []string) map[string]slackProfile {
	out := map[string]slackProfile{}
	user := middleware.GetUserFromContext(r)
	if h.profile == nil || user == nil {
		return out
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	seen := map[string]bool{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, slackProfileWorkers)
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer logging.Recover(ctx, "slack_profile_fetch")
			defer func() { <-sem }()
			if p, ok := h.profile(ctx, user.ID, id); ok {
				mu.Lock()
				out[id] = p
				mu.Unlock()
			}
		}(id)
	}
	wg.Wait()
	return out
}
