package youtrack

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// CreatedSprint is the sprint returned by CreateSprint.
type CreatedSprint struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Goal   string `json:"goal"`
	Start  int64  `json:"start"`
	Finish int64  `json:"finish"`
}

// CreateSprint creates a sprint on the resolved board. start/finish are Unix ms.
func (c *Client) CreateSprint(ctx context.Context, name, goal string, startMS, finishMS int64) (*CreatedSprint, error) {
	boardID, err := c.resolveBoard(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve board: %w", err)
	}
	body := map[string]interface{}{"name": name, "start": startMS, "finish": finishMS}
	if goal != "" {
		body["goal"] = goal
	}
	path := fmt.Sprintf("/api/agiles/%s/sprints?fields=id,name,goal,start,finish", url.PathEscape(boardID))
	resp, err := c.doRequest(ctx, http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	var s CreatedSprint
	if err := json.Unmarshal(resp, &s); err != nil {
		return nil, fmt.Errorf("failed to unmarshal created sprint: %w", err)
	}
	return &s, nil
}

// DeleteSprint deletes a sprint from the resolved board.
func (c *Client) DeleteSprint(ctx context.Context, sprintID string) error {
	boardID, err := c.resolveBoard(ctx)
	if err != nil {
		return fmt.Errorf("failed to resolve board: %w", err)
	}
	path := fmt.Sprintf("/api/agiles/%s/sprints/%s", url.PathEscape(boardID), url.PathEscape(sprintID))
	_, err = c.doRequest(ctx, http.MethodDelete, path, nil)
	return err
}
