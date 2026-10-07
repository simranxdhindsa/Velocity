package youtrack

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"time"
)

// LatestSprint picks the current sprint from a board's sprints: the most
// recently started sprint that is not completed, or, if none has started, the
// sprint with the highest start date. sprints must be non-empty.
// This is the rule GetLatestSprintName (and so the whole app) uses.
func LatestSprint(sprints []Sprint, now time.Time) *Sprint {
	nowMS := now.UnixMilli()
	var best *Sprint
	for i := range sprints {
		s := &sprints[i]
		if s.IsCompleted {
			continue
		}
		if s.Start > 0 && s.Start <= nowMS {
			if best == nil || s.Start > best.Start {
				best = s
			}
		}
	}
	if best != nil {
		return best
	}
	best = &sprints[0]
	for i := range sprints[1:] {
		if sprints[i+1].Start > best.Start {
			best = &sprints[i+1]
		}
	}
	return best
}

// NextSprint returns the first non-completed sprint that starts after current,
// ordered by start date, or nil when the board has no later sprint.
func NextSprint(sprints []Sprint, current *Sprint) *Sprint {
	if current == nil {
		return nil
	}
	sorted := make([]Sprint, len(sprints))
	copy(sorted, sprints)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Start < sorted[j].Start })
	for i := range sorted {
		s := sorted[i]
		if s.ID == current.ID || s.IsCompleted {
			continue
		}
		if s.Start > current.Start {
			return &s
		}
	}
	return nil
}

// GetAllBoardSprints returns every sprint on the resolved board (no 50-sprint
// cap like GetSprints), plus the board ID it used.
func (c *Client) GetAllBoardSprints(ctx context.Context) ([]Sprint, string, error) {
	boardID, err := c.resolveBoard(ctx)
	if err != nil {
		return nil, "", err
	}
	path := fmt.Sprintf("/api/agiles/%s/sprints?fields=id,name,start,finish,isCompleted&$top=-1", url.PathEscape(boardID))
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, boardID, err
	}
	var sprints []Sprint
	if err := json.Unmarshal(body, &sprints); err != nil {
		return nil, boardID, fmt.Errorf("failed to unmarshal sprints: %w", err)
	}
	return sprints, boardID, nil
}

// RemoveIssueFromSprint removes an issue from a sprint on the resolved board.
// issueID is the internal database ID (e.g. "3-671").
func (c *Client) RemoveIssueFromSprint(ctx context.Context, sprintID, issueID string) error {
	boardID, err := c.resolveBoard(ctx)
	if err != nil {
		return fmt.Errorf("failed to resolve board: %w", err)
	}
	path := fmt.Sprintf("/api/agiles/%s/sprints/%s/issues/%s",
		url.PathEscape(boardID), url.PathEscape(sprintID), url.PathEscape(issueID))
	_, err = c.doRequest(ctx, http.MethodDelete, path, nil)
	return err
}
