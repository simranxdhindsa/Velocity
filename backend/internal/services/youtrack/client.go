package youtrack

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
"mime/multipart"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Client is the YouTrack API client
type Client struct {
	baseURL         string
	token           string
	projectID       string
	boardID         string
	resolvedBoardID string // auto-detected board, cached after first resolution
	httpClient      *http.Client
}

// NewClient creates a new YouTrack API client
func NewClient(baseURL, token, projectID string) *Client {
	// Ensure baseURL doesn't have trailing slash
	baseURL = strings.TrimSuffix(baseURL, "/")

	return &Client{
		baseURL:   baseURL,
		token:     token,
		projectID: projectID,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// SetBoardID sets the agile board ID
func (c *Client) SetBoardID(boardID string) {
	c.boardID = boardID
}

// ResolveBoard exposes resolveBoard for handlers that need the board ID directly.
func (c *Client) ResolveBoard(ctx context.Context) (string, error) {
	return c.resolveBoard(ctx)
}

// resolveBoard returns the board ID to use for sprint operations.
// Priority: explicit boardID > cached resolvedBoardID > auto-detected from project.
func (c *Client) resolveBoard(ctx context.Context) (string, error) {
	if c.boardID != "" {
		return c.boardID, nil
	}
	if c.resolvedBoardID != "" {
		return c.resolvedBoardID, nil
	}

	// Fetch all agile boards with their project associations and sprint settings
	body, err := c.doRequest(ctx, http.MethodGet,
		"/api/agiles?$top=-1&fields=id,name,projects(id,shortName),sprintsSettings(disableSprints)", nil)
	if err != nil {
		return "", fmt.Errorf("failed to fetch agile boards: %w", err)
	}

	var rawBoards []map[string]interface{}
	if err := json.Unmarshal(body, &rawBoards); err != nil {
		return "", fmt.Errorf("failed to unmarshal agile boards: %w", err)
	}

	// Find boards that belong to our project; prefer sprint-enabled ones
	var firstMatch, firstSprintMatch string
	for _, board := range rawBoards {
		id, _ := board["id"].(string)
		if id == "" {
			continue
		}
		projects, _ := board["projects"].([]interface{})
		for _, p := range projects {
			pm, _ := p.(map[string]interface{})
			pid, _ := pm["id"].(string)
			pshort, _ := pm["shortName"].(string)
			if pid == c.projectID || pshort == c.projectID {
				if firstMatch == "" {
					firstMatch = id
				}
				// Prefer boards that have sprints enabled
				sprintsDisabled := false
				if ss, ok := board["sprintsSettings"].(map[string]interface{}); ok {
					sprintsDisabled, _ = ss["disableSprints"].(bool)
				}
				if !sprintsDisabled && firstSprintMatch == "" {
					firstSprintMatch = id
				}
			}
		}
	}

	chosen := firstSprintMatch
	if chosen == "" {
		chosen = firstMatch
	}
	if chosen == "" {
		return "", fmt.Errorf("no agile board found for project %q — configure one in Integrations → YouTrack", c.projectID)
	}

	c.resolvedBoardID = chosen
	return chosen, nil
}

// GetBaseURL returns the YouTrack instance base URL (used for prefixing relative avatar URLs)
func (c *Client) GetBaseURL() string {
	return c.baseURL
}

// GetProjectID returns the project ID/short-name used in YQL queries
func (c *Client) GetProjectID() string {
	return c.projectID
}

// SearchIssues executes an arbitrary YQL query against YouTrack and returns matching issues.
func (c *Client) SearchIssues(ctx context.Context, yqlQuery string, limit int) ([]Issue, error) {
	if limit <= 0 {
		limit = 100
	}
	fields := "id,idReadable,summary,description,created,updated,reporter(id,fullName,login,avatarUrl),customFields(name,value(name,presentation,fullName,login,email,avatarUrl,id)),project(shortName)"
	path := fmt.Sprintf("/api/issues?fields=%s&query=%s&$top=%d", fields, url.QueryEscape(yqlQuery), limit)
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var issues []Issue
	if err := json.Unmarshal(body, &issues); err != nil {
		return nil, fmt.Errorf("failed to unmarshal search results: %w", err)
	}
	return issues, nil
}

// GetToken returns the YouTrack API token (used by the attachment proxy handler)
func (c *Client) GetToken() string {
	return c.token
}

// Issue represents a YouTrack issue
type Issue struct {
	ID           string        `json:"id"`           // internal id e.g. "3-671"
	IDReadable   string        `json:"idReadable"`   // human-readable e.g. "ARD-628" (Cloud format)
	Summary      string        `json:"summary"`      // Issue title
	Description  string        `json:"description"`  // Issue description
	Created      int64         `json:"created"`      // Unix timestamp ms
	Updated      int64         `json:"updated"`      // Unix timestamp ms
	Reporter     *User         `json:"reporter,omitempty"` // who created the issue
	CustomFields []CustomField `json:"customFields"` // State, Subsystem, Priority, etc.
	Attachments  []Attachment  `json:"attachments,omitempty"`
	Project      *Project      `json:"project,omitempty"`
}

// CustomField represents a YouTrack custom field
type CustomField struct {
	Name  string      `json:"name"`            // "State", "Subsystem", "Priority", "Assignee"
	Type  string      `json:"$type,omitempty"` // YouTrack entity type e.g. "StateIssueCustomField"
	Value interface{} `json:"value"`           // Can be string, map, or array
}

// Attachment represents a file attachment
type Attachment struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	MimeType  string `json:"mimeType"`
	URL       string `json:"url"`
	Extension string `json:"extension"`
}

// User represents a YouTrack user
type User struct {
	ID        string `json:"id"`
	Login     string `json:"login"`
	FullName  string `json:"fullName"`
	Email     string `json:"email,omitempty"`
	AvatarUrl string `json:"avatarUrl,omitempty"`
}

// Board represents an agile board
type Board struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Sprint represents a YouTrack agile sprint
type Sprint struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Start       int64  `json:"start"`
	Finish      int64  `json:"finish"`
	IsCompleted bool   `json:"isCompleted"`
}

// State represents a workflow state
type State struct {
	Name string `json:"name"` // "Open", "In Progress", "Done", etc.
}

// Project represents a YouTrack project
type Project struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ShortName string `json:"shortName"` // Project key like "PM"
	Archived  bool   `json:"archived,omitempty"`
}

// Column represents a kanban column from an agile board
type Column struct {
	Name        string   `json:"name"`
	FieldValues []string `json:"fieldValues"` // Status values mapped to this column
}

// doRequest performs an HTTP request to the YouTrack API
func (c *Client) doRequest(ctx context.Context, method, path string, body interface{}) ([]byte, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBody)
	}

	fullURL := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, fullURL, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		switch resp.StatusCode {
		case 401:
			return nil, fmt.Errorf("YouTrack authentication failed. Please check your token")
		case 403:
			return nil, fmt.Errorf("YouTrack access forbidden. Your token may not have sufficient permissions")
		case 404:
			return nil, fmt.Errorf("YouTrack resource not found")
		default:
			return nil, fmt.Errorf("YouTrack API error: status %d - %s", resp.StatusCode, string(respBody))
		}
	}

	return respBody, nil
}

// GetProjects returns all available projects
func (c *Client) GetProjects(ctx context.Context) ([]Project, error) {
	// Try multiple API endpoints for compatibility
	endpoints := []string{
		"/api/admin/projects?fields=id,name,shortName,archived&$top=50&archived=false",
		"/api/projects?fields=id,name,shortName,archived&$top=50",
		"/api/admin/projects?fields=shortName,name&$top=50",
		"/api/admin/projects",
	}

	var lastError error
	for _, endpoint := range endpoints {
		body, err := c.doRequest(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			lastError = err
			continue
		}

		var projects []Project
		if err := json.Unmarshal(body, &projects); err != nil {
			lastError = err
			continue
		}

		return projects, nil
	}

	return nil, fmt.Errorf("all YouTrack endpoints failed: %v", lastError)
}

// GetBoards returns all agile boards
func (c *Client) GetBoards(ctx context.Context) ([]Board, error) {
	path := "/api/agiles?$top=-1&fields=id,name,sprintsSettings(disableSprints),projects(id)"
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var rawBoards []map[string]interface{}
	if err := json.Unmarshal(body, &rawBoards); err != nil {
		return nil, fmt.Errorf("failed to unmarshal boards: %w", err)
	}

	var boards []Board
	for _, board := range rawBoards {
		id, _ := board["id"].(string)
		name, _ := board["name"].(string)
		if id != "" && name != "" {
			boards = append(boards, Board{ID: id, Name: name})
		}
	}

	return boards, nil
}

// GetBoardColumns returns columns (states) from an agile board, sorted by board ordinal.
func (c *Client) GetBoardColumns(ctx context.Context, boardID string) ([]Column, error) {
	path := fmt.Sprintf("/api/agiles/%s?fields=columnSettings(columns(ordinal,fieldValues(name,presentation)))", boardID)
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var agileBoard map[string]interface{}
	if err := json.Unmarshal(body, &agileBoard); err != nil {
		return nil, fmt.Errorf("failed to unmarshal board: %w", err)
	}

	type rawCol struct {
		ordinal     int
		fieldValues []string
	}
	var rawCols []rawCol

	if columnSettings, ok := agileBoard["columnSettings"].(map[string]interface{}); ok {
		if cols, ok := columnSettings["columns"].([]interface{}); ok {
			for _, col := range cols {
				column, ok := col.(map[string]interface{})
				if !ok {
					continue
				}
				ordinal := 0
				if o, ok := column["ordinal"].(float64); ok {
					ordinal = int(o)
				}
				var fieldValues []string
				if fvs, ok := column["fieldValues"].([]interface{}); ok {
					for _, fv := range fvs {
						if fieldValue, ok := fv.(map[string]interface{}); ok {
							if name, ok := fieldValue["name"].(string); ok && name != "" {
								fieldValues = append(fieldValues, name)
							} else if presentation, ok := fieldValue["presentation"].(string); ok {
								fieldValues = append(fieldValues, presentation)
							}
						}
					}
				}
				if len(fieldValues) > 0 {
					rawCols = append(rawCols, rawCol{ordinal: ordinal, fieldValues: fieldValues})
				}
			}
		}
	}

	// Sort by ordinal to match YouTrack board column order
	sort.Slice(rawCols, func(i, j int) bool { return rawCols[i].ordinal < rawCols[j].ordinal })

	columns := make([]Column, len(rawCols))
	for i, rc := range rawCols {
		columns[i] = Column{Name: rc.fieldValues[0], FieldValues: rc.fieldValues}
	}
	return columns, nil
}

// GetStates returns workflow states for the project
func (c *Client) GetStates(ctx context.Context) ([]State, error) {
	path := fmt.Sprintf("/api/admin/projects/%s/customFields?fields=field(name,fieldType(id)),bundle(values(name))",
		c.projectID)

	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var customFields []map[string]interface{}
	if err := json.Unmarshal(body, &customFields); err != nil {
		return nil, fmt.Errorf("failed to unmarshal custom fields: %w", err)
	}

	var states []State
	for _, field := range customFields {
		if fieldInfo, ok := field["field"].(map[string]interface{}); ok {
			if fieldName, ok := fieldInfo["name"].(string); ok && fieldName == "State" {
				if bundle, ok := field["bundle"].(map[string]interface{}); ok {
					if values, ok := bundle["values"].([]interface{}); ok {
						for _, val := range values {
							if valMap, ok := val.(map[string]interface{}); ok {
								if stateName, ok := valMap["name"].(string); ok {
									states = append(states, State{Name: stateName})
								}
							}
						}
					}
				}
			}
		}
	}

	// If no states found from custom fields, try board columns
	if len(states) == 0 {
		if bid, berr := c.resolveBoard(ctx); berr == nil {
			columns, err := c.GetBoardColumns(ctx, bid)
			if err == nil {
				seen := make(map[string]bool)
				for _, col := range columns {
					for _, fv := range col.FieldValues {
						if !seen[fv] {
							seen[fv] = true
							states = append(states, State{Name: fv})
						}
					}
				}
			}
		}
	}

	return states, nil
}

// PriorityValue represents a YouTrack priority with its display color
type PriorityValue struct {
	Name       string `json:"name"`
	Background string `json:"background,omitempty"`
	Foreground string `json:"foreground,omitempty"`
}

// GetPriorities returns the Priority field values with colors from YouTrack
func (c *Client) GetPriorities(ctx context.Context) ([]PriorityValue, error) {
	path := fmt.Sprintf("/api/admin/projects/%s/customFields?fields=field(name,fieldType(id)),bundle(values(name,color(background,foreground)))",
		c.projectID)

	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var customFields []map[string]interface{}
	if err := json.Unmarshal(body, &customFields); err != nil {
		return nil, fmt.Errorf("failed to unmarshal custom fields: %w", err)
	}

	for _, field := range customFields {
		if fieldInfo, ok := field["field"].(map[string]interface{}); ok {
			if fieldName, ok := fieldInfo["name"].(string); ok && fieldName == "Priority" {
				if bundle, ok := field["bundle"].(map[string]interface{}); ok {
					if values, ok := bundle["values"].([]interface{}); ok {
						var priorities []PriorityValue
						for _, val := range values {
							if valMap, ok := val.(map[string]interface{}); ok {
								name, _ := valMap["name"].(string)
								pv := PriorityValue{Name: name}
								if colorMap, ok := valMap["color"].(map[string]interface{}); ok {
									pv.Background, _ = colorMap["background"].(string)
									pv.Foreground, _ = colorMap["foreground"].(string)
								}
								priorities = append(priorities, pv)
							}
						}
						return priorities, nil
					}
				}
			}
		}
	}

	return []PriorityValue{}, nil
}

// GetCustomFieldValues returns enum values (with colors) for any named custom field.
// Works identically to GetPriorities but parameterised by field name.
func (c *Client) GetCustomFieldValues(ctx context.Context, fieldName string) ([]PriorityValue, error) {
	path := fmt.Sprintf("/api/admin/projects/%s/customFields?fields=field(name,fieldType(id)),bundle(values(name,color(background,foreground)))",
		c.projectID)

	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var customFields []map[string]interface{}
	if err := json.Unmarshal(body, &customFields); err != nil {
		return nil, fmt.Errorf("failed to unmarshal custom fields: %w", err)
	}

	for _, field := range customFields {
		if fieldInfo, ok := field["field"].(map[string]interface{}); ok {
			if name, ok := fieldInfo["name"].(string); ok && strings.EqualFold(name, fieldName) {
				if bundle, ok := field["bundle"].(map[string]interface{}); ok {
					if values, ok := bundle["values"].([]interface{}); ok {
						var result []PriorityValue
						for _, val := range values {
							if valMap, ok := val.(map[string]interface{}); ok {
								vName, _ := valMap["name"].(string)
								pv := PriorityValue{Name: vName}
								if colorMap, ok := valMap["color"].(map[string]interface{}); ok {
									pv.Background, _ = colorMap["background"].(string)
									pv.Foreground, _ = colorMap["foreground"].(string)
								}
								result = append(result, pv)
							}
						}
						return result, nil
					}
				}
			}
		}
	}
	return []PriorityValue{}, nil
}

// GetIssues returns all issues from the project
func (c *Client) GetIssues(ctx context.Context) ([]Issue, error) {
	query := url.QueryEscape(fmt.Sprintf("project: %s", c.projectID))
	fields := "id,idReadable,summary,description,created,updated,customFields(name,value(name,presentation,fullName,login,email,avatarUrl,id)),attachments(id,name,size,mimeType,url,extension),project(shortName)"
	var all []Issue
	skip := 0
	pageSize := 500
	for {
		path := fmt.Sprintf("/api/issues?fields=%s&query=%s&$top=%d&$skip=%d", fields, query, pageSize, skip)
		body, err := c.doRequest(ctx, http.MethodGet, path, nil)
		if err != nil {
			return nil, err
		}
		var page []Issue
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("failed to unmarshal issues: %w", err)
		}
		all = append(all, page...)
		if len(page) < pageSize {
			break
		}
		skip += pageSize
	}
	return all, nil
}

// GetSprints returns all sprints for the configured agile board.
func (c *Client) GetSprints(ctx context.Context) ([]Sprint, error) {
	boardID, err := c.resolveBoard(ctx)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/api/agiles/%s/sprints?fields=id,name,start,finish,isCompleted&$top=50", boardID)
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var sprints []Sprint
	if err := json.Unmarshal(body, &sprints); err != nil {
		return nil, fmt.Errorf("failed to unmarshal sprints: %w", err)
	}
	return sprints, nil
}

// GetIssuesByStatePaginated returns paginated issues for a single workflow state.
// Fetches top+1 to determine hasMore, then returns only top items.
func (c *Client) GetIssuesByStatePaginated(ctx context.Context, state string, skip, top int) ([]Issue, bool, error) {
	query := url.QueryEscape(fmt.Sprintf("project: %s State: {%s}", c.projectID, state))
	fields := "id,idReadable,summary,description,created,updated,customFields(name,value(name,presentation,fullName,login,email,avatarUrl,id)),attachments(id,name,size,mimeType,url,extension),project(shortName)"
	path := fmt.Sprintf("/api/issues?fields=%s&query=%s&$top=%d&$skip=%d", fields, query, top+1, skip)

	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, false, err
	}

	var issues []Issue
	if err := json.Unmarshal(body, &issues); err != nil {
		return nil, false, fmt.Errorf("failed to unmarshal issues: %w", err)
	}

	hasMore := len(issues) > top
	if hasMore {
		issues = issues[:top]
	}
	return issues, hasMore, nil
}

// GetSprintIssuesByStatePaginated returns paginated issues for a sprint column.
// It fetches ALL sprint issues via the paginated agile endpoint (same as GetAllSprintIssues),
// filters by state in Go, then applies skip/top — guaranteeing correct counts regardless
// of how many states exist in the sprint.
func (c *Client) GetSprintIssuesByStatePaginated(ctx context.Context, sprintID, state string, skip, top int) ([]Issue, bool, error) {
	// Fetch every issue in the sprint (handles pagination internally)
	all, err := c.GetAllSprintIssues(ctx, sprintID)
	if err != nil {
		return nil, false, err
	}

	// Filter to the requested state
	var filtered []Issue
	for _, issue := range all {
		if GetStatus(issue) == state {
			filtered = append(filtered, issue)
		}
	}

	// Apply skip/top pagination over the filtered slice
	total := len(filtered)
	if skip >= total {
		return nil, false, nil
	}
	end := skip + top
	hasMore := end < total
	if end > total {
		end = total
	}
	return filtered[skip:end], hasMore, nil
}

// GetAllSprintIssues returns all issues in a sprint (all states) without pagination.
// Used for assignee stats, daily brief, time tracking and report filtering.
func (c *Client) GetAllSprintIssues(ctx context.Context, sprintID string) ([]Issue, error) {
	boardID, err := c.resolveBoard(ctx)
	if err != nil {
		return nil, err
	}
	fields := "id,idReadable,summary,description,created,updated,reporter(id,fullName,login,avatarUrl),customFields(name,value(name,presentation,fullName,login,email,avatarUrl,id)),attachments(id,name,size,mimeType,url,extension),project(shortName)"
	var all []Issue
	skip := 0
	pageSize := 500
	for {
		path := fmt.Sprintf("/api/agiles/%s/sprints/%s/issues?fields=%s&$top=%d&$skip=%d",
			boardID, sprintID, fields, pageSize, skip)
		body, err := c.doRequest(ctx, http.MethodGet, path, nil)
		if err != nil {
			return nil, err
		}
		var page []Issue
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("failed to unmarshal sprint issues: %w", err)
		}
		all = append(all, page...)
		if len(page) < pageSize {
			break
		}
		skip += pageSize
	}
	return all, nil
}

// GetIssue returns a single issue by ID
func (c *Client) GetIssue(ctx context.Context, issueID string) (*Issue, error) {
	fields := "id,idReadable,summary,description,created,updated,reporter(id,fullName,login,avatarUrl),customFields(name,value(name,presentation,fullName,login,email,avatarUrl,id)),attachments(id,name,size,mimeType,url,extension),project(shortName)"
	path := fmt.Sprintf("/api/issues/%s?fields=%s", url.PathEscape(issueID), fields)

	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var issue Issue
	if err := json.Unmarshal(body, &issue); err != nil {
		return nil, fmt.Errorf("failed to unmarshal issue: %w", err)
	}

	return &issue, nil
}

// CreateIssueRequest contains the fields for creating an issue
type CreateIssueRequest struct {
	Summary      string        `json:"summary"`
	Description  string        `json:"description,omitempty"`
	Project      ProjectRef    `json:"project"`
	CustomFields []CustomField `json:"customFields,omitempty"`
}

// ProjectRef is a reference to a project by ID
type ProjectRef struct {
	ID string `json:"id"`
}

// CreateIssue creates a new issue in YouTrack
func (c *Client) CreateIssue(ctx context.Context, req CreateIssueRequest) (*Issue, error) {
	// Set project ID if not provided
	if req.Project.ID == "" {
		req.Project.ID = c.projectID
	}

	// YouTrack requires the internal DB id (e.g. "0-2"), not the short name ("ARD").
	// If the stored projectID looks like a short name (no "-"), resolve it via the projects list.
	if !strings.Contains(req.Project.ID, "-") {
		shortName := req.Project.ID
		if projects, err := c.GetProjects(ctx); err == nil {
			for _, p := range projects {
				if strings.EqualFold(p.ShortName, shortName) || strings.EqualFold(p.Name, shortName) {
					req.Project.ID = p.ID
					break
				}
			}
		}
	}

	path := "/api/issues?fields=id,summary,description,created,updated,customFields(name,value(name,presentation)),project(shortName)"
	body, err := c.doRequest(ctx, http.MethodPost, path, req)
	if err != nil {
		return nil, err
	}

	var issue Issue
	if err := json.Unmarshal(body, &issue); err != nil {
		return nil, fmt.Errorf("failed to unmarshal created issue: %w", err)
	}

	return &issue, nil
}

// UpdateIssueRequest contains the fields for updating an issue
type UpdateIssueRequest struct {
	Summary      string        `json:"summary,omitempty"`
	Description  string        `json:"description,omitempty"`
	CustomFields []CustomField `json:"customFields,omitempty"`
}

// UpdateIssue updates an existing issue
func (c *Client) UpdateIssue(ctx context.Context, issueID string, req UpdateIssueRequest) (*Issue, error) {
	path := fmt.Sprintf("/api/issues/%s?fields=id,summary,description,created,updated,customFields(name,value(name,presentation)),project(shortName)", issueID)
	body, err := c.doRequest(ctx, http.MethodPost, path, req)
	if err != nil {
		return nil, err
	}

	var issue Issue
	if err := json.Unmarshal(body, &issue); err != nil {
		return nil, fmt.Errorf("failed to unmarshal updated issue: %w", err)
	}

	return &issue, nil
}

// DeleteIssue deletes an issue from YouTrack
func (c *Client) DeleteIssue(ctx context.Context, issueID string) error {
	path := fmt.Sprintf("/api/issues/%s", issueID)
	_, err := c.doRequest(ctx, http.MethodDelete, path, nil)
	return err
}

// GetUsers returns all YouTrack users with avatar URLs
func (c *Client) GetUsers(ctx context.Context) ([]User, error) {
	path := "/api/users?fields=id,login,fullName,email,avatarUrl&$top=200"
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var users []User
	if err := json.Unmarshal(body, &users); err != nil {
		return nil, fmt.Errorf("failed to unmarshal users: %w", err)
	}

	// Prefix relative avatarUrl with baseURL
	for i := range users {
		if users[i].AvatarUrl != "" && !strings.HasPrefix(users[i].AvatarUrl, "http") {
			users[i].AvatarUrl = c.baseURL + users[i].AvatarUrl
		}
	}

	return users, nil
}

// AssignToBoard assigns an issue to an agile board
func (c *Client) AssignToBoard(ctx context.Context, issueID, boardName string) error {
	commandReq := map[string]interface{}{
		"issues": []map[string]string{{"id": issueID}},
		"query":  fmt.Sprintf("add Board %s", boardName),
	}

	_, err := c.doRequest(ctx, http.MethodPost, "/api/commands", commandReq)
	return err
}

// UpdateIssueState updates the state of an issue
func (c *Client) UpdateIssueState(ctx context.Context, issueID, newState string) error {
	req := UpdateIssueRequest{
		CustomFields: []CustomField{
			{
				Name:  "State",
				Type:  "StateIssueCustomField",
				Value: map[string]string{
					"name":  newState,
					"$type": "StateBundleElement",
				},
			},
		},
	}

	_, err := c.UpdateIssue(ctx, issueID, req)
	return err
}

// GetStatus extracts the status/state from an issue's custom fields
// GetCustomFieldValue returns the string value of any named custom field on an issue.
// Works for enum, state, and simple string fields. Returns "" if not found.
func GetCustomFieldValue(issue Issue, fieldName string) string {
	for _, field := range issue.CustomFields {
		if strings.EqualFold(field.Name, fieldName) {
			if valueMap, ok := field.Value.(map[string]interface{}); ok {
				if name, ok := valueMap["name"].(string); ok {
					return name
				}
				if presentation, ok := valueMap["presentation"].(string); ok {
					return presentation
				}
			}
			if str, ok := field.Value.(string); ok {
				return str
			}
		}
	}
	return ""
}

// GetCustomFieldValueAsTime returns the time.Time value of a date custom field.
// Returns nil if the field is not found or not a date (millisecond timestamp).
func GetCustomFieldValueAsTime(issue Issue, fieldName string) *time.Time {
	for _, field := range issue.CustomFields {
		if strings.EqualFold(field.Name, fieldName) {
			switch v := field.Value.(type) {
			case float64:
				if v > 0 {
					t := time.UnixMilli(int64(v))
					return &t
				}
			case int64:
				if v > 0 {
					t := time.UnixMilli(v)
					return &t
				}
			}
		}
	}
	return nil
}

func GetStatus(issue Issue) string {
	for _, field := range issue.CustomFields {
		if field.Name == "State" {
			if valueMap, ok := field.Value.(map[string]interface{}); ok {
				if name, ok := valueMap["name"].(string); ok {
					return name
				}
				if presentation, ok := valueMap["presentation"].(string); ok {
					return presentation
				}
			}
			if str, ok := field.Value.(string); ok {
				return str
			}
		}
	}
	return "Unknown"
}

// GetSubsystem extracts the subsystem from an issue's custom fields
func GetSubsystem(issue Issue) string {
	for _, field := range issue.CustomFields {
		if field.Name == "Subsystem" {
			if valueMap, ok := field.Value.(map[string]interface{}); ok {
				if name, ok := valueMap["name"].(string); ok {
					return name
				}
			}
			if str, ok := field.Value.(string); ok {
				return str
			}
		}
	}
	return ""
}

// GetAssignee extracts the assignee from an issue's custom fields
func GetAssignee(issue Issue) *User {
	for _, field := range issue.CustomFields {
		if field.Name == "Assignee" {
			if valueMap, ok := field.Value.(map[string]interface{}); ok {
				user := &User{}
				if id, ok := valueMap["id"].(string); ok {
					user.ID = id
				}
				if login, ok := valueMap["login"].(string); ok {
					user.Login = login
				}
				if fullName, ok := valueMap["fullName"].(string); ok {
					user.FullName = fullName
				}
				if email, ok := valueMap["email"].(string); ok {
					user.Email = email
				}
				if avatarUrl, ok := valueMap["avatarUrl"].(string); ok {
					user.AvatarUrl = avatarUrl
				}
				return user
			}
		}
	}
	return nil
}

// GetPriority extracts the priority from an issue's custom fields
func GetPriority(issue Issue) string {
	for _, field := range issue.CustomFields {
		if field.Name == "Priority" {
			if valueMap, ok := field.Value.(map[string]interface{}); ok {
				if name, ok := valueMap["name"].(string); ok {
					return name
				}
			}
			if str, ok := field.Value.(string); ok {
				return str
			}
		}
	}
	return "Normal"
}

// TestConnection tests the connection to YouTrack
func (c *Client) TestConnection(ctx context.Context) error {
	_, err := c.GetProjects(ctx)
	return err
}

// IssueComment is a full comment object with author info
type IssueComment struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Created int64  `json:"created"`
	Author  struct {
		FullName  string `json:"fullName"`
		Login     string `json:"login"`
		AvatarUrl string `json:"avatarUrl"`
	} `json:"author"`
}

// GetIssueComments returns the text of all comments on an issue (newest last).
// Used internally by webhook/blocker analysis — returns plain strings.
func (c *Client) GetIssueComments(ctx context.Context, issueID string) ([]string, error) {
	path := fmt.Sprintf("/api/issues/%s/comments?fields=id,text,created&$top=10", issueID)
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var comments []struct {
		ID      string `json:"id"`
		Text    string `json:"text"`
		Created int64  `json:"created"`
	}
	if err := json.Unmarshal(body, &comments); err != nil {
		return nil, fmt.Errorf("failed to unmarshal comments: %w", err)
	}

	var texts []string
	for _, c := range comments {
		if c.Text != "" {
			texts = append(texts, c.Text)
		}
	}
	return texts, nil
}

// GetIssueCommentsFull returns full comment objects including author for the detail panel.
func (c *Client) GetIssueCommentsFull(ctx context.Context, issueID string) ([]IssueComment, error) {
	path := fmt.Sprintf("/api/issues/%s/comments?fields=id,text,created,author(fullName,login,avatarUrl)&$top=50", issueID)
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var comments []IssueComment
	if err := json.Unmarshal(body, &comments); err != nil {
		return nil, fmt.Errorf("failed to unmarshal comments: %w", err)
	}
	return comments, nil
}

// AddIssueComment posts a new comment on an issue.
func (c *Client) AddIssueComment(ctx context.Context, issueID, text string) error {
	path := fmt.Sprintf("/api/issues/%s/comments", issueID)
	_, err := c.doRequest(ctx, http.MethodPost, path, map[string]string{"text": text})
	return err
}

// GetIssuesByState returns issues filtered by one or more states (live from YouTrack)
func (c *Client) GetIssuesByState(ctx context.Context, states []string) ([]Issue, error) {
	if len(states) == 0 {
		return nil, nil
	}

	// Build query: project: ARD State: {In Progress, Backlog}
	stateFilters := make([]string, len(states))
	for i, s := range states {
		stateFilters[i] = "{" + s + "}"
	}
	query := fmt.Sprintf("project: %s State: %s", c.projectID, strings.Join(stateFilters, ", "))
	fields := "id,idReadable,summary,created,updated,customFields(name,value(name,presentation,fullName,login,email,avatarUrl,id)),project(shortName)"
	path := fmt.Sprintf("/api/issues?fields=%s&query=%s&$top=200", fields, url.QueryEscape(query))

	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var issues []Issue
	if err := json.Unmarshal(body, &issues); err != nil {
		return nil, fmt.Errorf("failed to unmarshal issues: %w", err)
	}
	return issues, nil
}

// GetIssuesByStateForSprint returns issues in a sprint filtered by state using YouTrack's query API.
// Uses sprint name in the query (e.g. "project: ARD sprint: {Sprint 1} State: {To Do}, {In Progress}").
// This is more reliable than the agile endpoint when the board ID is uncertain.
// Pass nil/empty states to get ALL issues in the sprint (excluding none by state).
func (c *Client) GetIssuesByStateForSprint(ctx context.Context, sprintName string, states []string) ([]Issue, error) {
	var query string
	if len(states) > 0 {
		stateFilters := make([]string, len(states))
		for i, s := range states {
			stateFilters[i] = "{" + s + "}"
		}
		query = fmt.Sprintf("project: %s sprint: {%s} State: %s", c.projectID, sprintName, strings.Join(stateFilters, ", "))
	} else {
		query = fmt.Sprintf("project: %s sprint: {%s}", c.projectID, sprintName)
	}
	fields := "id,idReadable,summary,created,updated,reporter(id,fullName,login,avatarUrl),customFields(name,value(name,presentation,fullName,login,email,avatarUrl,id)),project(shortName)"
	path := fmt.Sprintf("/api/issues?fields=%s&query=%s&$top=500", fields, url.QueryEscape(query))

	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var issues []Issue
	if err := json.Unmarshal(body, &issues); err != nil {
		return nil, fmt.Errorf("failed to unmarshal sprint issues: %w", err)
	}
	return issues, nil
}

// GetCurrentUser returns the YouTrack user associated with the client's token.
func (c *Client) GetCurrentUser(ctx context.Context) (*User, error) {
	body, err := c.doRequest(ctx, http.MethodGet, "/api/users/me?fields=id,login,fullName,email", nil)
	if err != nil {
		return nil, fmt.Errorf("GetCurrentUser: %w", err)
	}
	var u User
	if err := json.Unmarshal(body, &u); err != nil {
		return nil, fmt.Errorf("GetCurrentUser unmarshal: %w", err)
	}
	return &u, nil
}

// GetIssuesCreatedToday returns all issues in the project created on the given date (YYYY-MM-DD)
// by a reporter whose login or full name matches reporterLogin.
// Pass empty reporterLogin to get all reporters.
func (c *Client) GetIssuesCreatedToday(ctx context.Context, date, reporterLogin string) ([]Issue, error) {
	dateYMD := date // e.g. "2026-05-06"
	queryStr := fmt.Sprintf("project: %s created: %s .. %s", c.projectID, dateYMD, dateYMD)
	if reporterLogin != "" {
		queryStr += fmt.Sprintf(" reporter: %s", reporterLogin)
	}
	fields := "id,idReadable,summary,created,reporter(id,fullName,login),customFields(name,value(name,presentation,fullName,login,email,avatarUrl,id))"
	path := fmt.Sprintf("/api/issues?fields=%s&query=%s&$top=100", fields, url.QueryEscape(queryStr))
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, fmt.Errorf("GetIssuesCreatedToday: %w", err)
	}
	var issues []Issue
	if err := json.Unmarshal(body, &issues); err != nil {
		return nil, fmt.Errorf("GetIssuesCreatedToday unmarshal: %w", err)
	}
	return issues, nil
}

// WebhookEvent represents a YouTrack webhook event payload.
// Supports two formats:
//   Format A (YouTrack Cloud): {"author":{...}, "issue":{...}, "changes":[{"field":{"name":"State"},"from":"X","to":"Y"}]}
//   Format B (self-hosted/older): {"type":"IssueEvent", "issue":{...}, "updater":{...}, "fieldChanges":[{"name":"State","oldValue":...,"newValue":...}]}
type WebhookEvent struct {
	// Format A (YouTrack Cloud)
	Author  *User           `json:"author"`
	IssueID string          `json:"issueId"` // readable ID like "ARD-628"
	Changes []WebhookChange `json:"changes"` // YouTrack Cloud format

	// Format B (self-hosted)
	Type         string        `json:"type"`
	Timestamp    int64         `json:"timestamp"`
	Updater      *User         `json:"updater"`
	FieldChanges []FieldChange `json:"fieldChanges"`

	// Common
	Issue *Issue `json:"issue"`
}

// WebhookChange is the YouTrack Cloud webhook change format
type WebhookChange struct {
	Field    WebhookChangeField `json:"field"`
	From     interface{}        `json:"from"` // string or object with "name"
	To       interface{}        `json:"to"`   // string or object with "name"
	Added    interface{}        `json:"added"`
	Removed  interface{}        `json:"removed"`
}

// WebhookChangeField identifies the changed field
type WebhookChangeField struct {
	Name string `json:"name"` // "State", "Assignee", etc.
}

// FieldChange represents a changed field in a webhook event (self-hosted format)
type FieldChange struct {
	Name     string      `json:"name"`     // "State", "Assignee", etc.
	OldValue interface{} `json:"oldValue"` // previous value
	NewValue interface{} `json:"newValue"` // new value
}

// NormalizedChanges returns all field changes in a unified format regardless of
// which webhook format was received.
func (e *WebhookEvent) NormalizedChanges() []FieldChange {
	var result []FieldChange

	// Format A: YouTrack Cloud "changes" array
	for _, c := range e.Changes {
		name := c.Field.Name
		if name == "" {
			continue
		}
		old := ExtractFieldChangeValue(c.From)
		if old == "" {
			old = ExtractFieldChangeValue(c.Removed)
		}
		new := ExtractFieldChangeValue(c.To)
		if new == "" {
			new = ExtractFieldChangeValue(c.Added)
		}
		result = append(result, FieldChange{Name: name, OldValue: old, NewValue: new})
	}

	// Format B: self-hosted "fieldChanges" array (only if format A had nothing)
	if len(result) == 0 {
		result = append(result, e.FieldChanges...)
	}

	return result
}

// GetUpdater returns the user who made the change, supporting both formats.
func (e *WebhookEvent) GetUpdater() *User {
	if e.Updater != nil {
		return e.Updater
	}
	return e.Author
}

// ExtractFieldChangeValue extracts a string value from a webhook field change value
func ExtractFieldChangeValue(val interface{}) string {
	if val == nil {
		return ""
	}
	// Could be a string directly
	if s, ok := val.(string); ok {
		return s
	}
	// Could be an object with "name" field (state/enum value)
	if m, ok := val.(map[string]interface{}); ok {
		if name, ok := m["name"].(string); ok {
			return name
		}
		// Could be a user object with "fullName"
		if fullName, ok := m["fullName"].(string); ok {
			return fullName
		}
		if login, ok := m["login"].(string); ok {
			return login
		}
	}
	// Could be an array (e.g., multi-value fields) — take first element
	if arr, ok := val.([]interface{}); ok && len(arr) > 0 {
		return ExtractFieldChangeValue(arr[0])
	}
	return fmt.Sprintf("%v", val)
}

// IssueActivityItem represents a single activity entry from the YouTrack activities API
type IssueActivityItem struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"` // Unix ms
	Author    *User  `json:"author"`
	Field     struct {
		Presentation string `json:"presentation"` // "State", "Assignee", etc.
	} `json:"field"`
	Added   ActivityValues `json:"added"`
	Removed ActivityValues `json:"removed"`
	Target  struct {
		ID         string `json:"id"`         // internal issue id, e.g. "3-884"
		IDReadable string `json:"idReadable"` // human-readable id, e.g. "ARD-801"
		Summary    string `json:"summary"`    // issue title (only set when fetching project-wide)
	} `json:"target"`
}

// ActivityValue is the value inside added/removed arrays of an activity item.
// YouTrack can return either an object {id,name} or a bare number/string for
// numeric custom fields. The custom unmarshaler silently ignores non-object entries
// so the caller never gets a parse error.
type ActivityValue struct {
	Name string `json:"name"`
}

// ActivityValues is a slice of ActivityValue with a resilient JSON unmarshaler.
// YouTrack returns arrays of objects for enum fields but bare numbers/strings for
// numeric fields. We parse what we can and skip the rest — no parse errors.
type ActivityValues []ActivityValue

func (av *ActivityValues) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		*av = nil
		return nil
	}
	// Not an array (bare number, string, bool) — silently skip.
	if data[0] != '[' {
		*av = nil
		return nil
	}
	// Array: iterate raw elements, extract only JSON objects with a "name" field.
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		*av = nil
		return nil
	}
	*av = (*av)[:0] // reset without reallocating
	for _, elem := range raw {
		if len(elem) > 0 && elem[0] == '{' {
			var v ActivityValue
			if err := json.Unmarshal(elem, &v); err == nil && v.Name != "" {
				*av = append(*av, v)
			}
		}
		// Skip numbers, strings, booleans inside the array.
	}
	return nil
}

// GetIssueActivities fetches the full state-change history for an issue using
// the activitiesPage API. Returns activities in chronological order (oldest first).
func (c *Client) GetIssueActivities(ctx context.Context, issueID string) ([]IssueActivityItem, error) {
	path := fmt.Sprintf("/api/issues/%s/activitiesPage?categories=CustomFieldCategory&reverse=false&fields=id,activities(id,timestamp,author(id,fullName,login),field(id,presentation),added(id,name),removed(id,name),target(id,idReadable))&%%24top=1000", url.PathEscape(issueID))
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var page struct {
		Activities []IssueActivityItem `json:"activities"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, fmt.Errorf("failed to unmarshal activities: %w", err)
	}
	return page.Activities, nil
}

// GetProjectActivities fetches CustomField activities (State + Assignee changes) across
// the project. When date is non-empty (YYYY-MM-DD) the YouTrack query is scoped to
// issues updated on that date, dramatically reducing result size and making the top
// limit effective for a single day. Pass "" to fetch across all time.
func (c *Client) GetProjectActivities(ctx context.Context, top int, date string) ([]IssueActivityItem, error) {
	if top <= 0 {
		top = 500
	}
	q := fmt.Sprintf("project: %s", c.projectID)
	if date != "" {
		q += fmt.Sprintf(" updated: %s", date)
	}
	query := url.QueryEscape(q)
	// Note: fields must NOT be URL-encoded — YouTrack parses the parentheses literally.
	// $top must be encoded as %24top to avoid shell/framework misinterpretation.
	path := fmt.Sprintf(
		"/api/activitiesPage?categories=CustomFieldCategory&query=%s&reverse=true"+
			"&fields=id,activities(id,timestamp,author(id,fullName,login),field(id,presentation),added(id,name),removed(id,name),target(id,idReadable,summary))"+
			"&%%24top=%d",
		query, top,
	)
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var page struct {
		Activities []IssueActivityItem `json:"activities"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, fmt.Errorf("failed to unmarshal project activities: %w", err)
	}
	return page.Activities, nil
}

// GetIssuesUpdatedByUserToday returns issues in the project whose state field currently
// matches a tested state (Ready For Prod, Ready for Stage, Verified, Mobile Done) and
// that were last updated by the given user login on the specified date (YYYY-MM-DD).
// This is the primary path for the DayTrack tested-ticket sync; the activities stream
// is used as a secondary sweep to catch tickets moved on by someone else afterward.
func (c *Client) GetIssuesUpdatedByUserToday(ctx context.Context, date, userLogin string) ([]Issue, error) {
	if date == "" || userLogin == "" {
		return nil, nil
	}
	queryStr := fmt.Sprintf("project: %s updated by: %s updated: %s", c.projectID, userLogin, date)
	fields := "id,idReadable,summary,updated,customFields(name,value(name))"
	path := fmt.Sprintf("/api/issues?fields=%s&query=%s&$top=300", fields, url.QueryEscape(queryStr))
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, fmt.Errorf("GetIssuesUpdatedByUserToday: %w", err)
	}
	var issues []Issue
	if err := json.Unmarshal(body, &issues); err != nil {
		return nil, fmt.Errorf("GetIssuesUpdatedByUserToday unmarshal: %w", err)
	}
	return issues, nil
}

// IssueStateName extracts the "State" custom-field value name from an Issue.
func IssueStateName(issue Issue) string {
	for _, cf := range issue.CustomFields {
		if cf.Name != "State" {
			continue
		}
		switch v := cf.Value.(type) {
		case map[string]interface{}:
			if name, ok := v["name"].(string); ok {
				return name
			}
		case string:
			return v
		}
	}
	return ""
}

// IsDuplicateIssue checks if an issue with the same summary already exists
func (c *Client) IsDuplicateIssue(ctx context.Context, summary string) (bool, error) {
	issues, err := c.GetIssues(ctx)
	if err != nil {
		return false, err
	}

	normalizedSummary := strings.ToLower(strings.TrimSpace(summary))
	for _, issue := range issues {
		if strings.ToLower(strings.TrimSpace(issue.Summary)) == normalizedSummary {
			return true, nil
		}
	}

	return false, nil
}

// UploadAttachment uploads a file to a YouTrack issue.
func (c *Client) UploadAttachment(ctx context.Context, issueID, filename, mimeType string, content []byte) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return fmt.Errorf("failed to create form file: %w", err)
	}
	if _, err = part.Write(content); err != nil {
		return fmt.Errorf("failed to write file content: %w", err)
	}
	writer.Close()

	path := fmt.Sprintf("/api/issues/%s/attachments?fields=id,name", url.PathEscape(issueID))
	fullURL := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, &body)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("upload request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("YouTrack attachment upload error: status %d - %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// IssueLink represents a linked issue returned by GetIssueLinks.
type IssueLink struct {
	IDReadable string `json:"id_readable"`
	Summary    string `json:"summary"`
	State      string `json:"state"`
	Resolved   bool   `json:"resolved"`
}

// GetIssueLinks fetches YouTrack native "Relates To" links for an issue.
// Only link types whose name contains "relate" (case-insensitive) are returned.
func (c *Client) GetIssueLinks(ctx context.Context, issueID string) ([]IssueLink, error) {
	fields := "id,linkType(name,sourceToTarget,targetToSource),trimmedIssues(id,idReadable,summary,resolved,fields(value(name),$type,projectCustomField(field(name))))"
	path := fmt.Sprintf("/api/issues/%s/links?$topLinks=50&fields=%s", url.PathEscape(issueID), fields)
	body, err := c.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var raw []struct {
		LinkType struct {
			Name string `json:"name"`
		} `json:"linkType"`
		TrimmedIssues []struct {
			ID         string `json:"id"`
			IDReadable string `json:"idReadable"`
			Summary    string `json:"summary"`
			Resolved   bool   `json:"resolved"`
			Fields     []struct {
				Type  string          `json:"$type"`
				Value json.RawMessage `json:"value"`
				ProjectCustomField struct {
					Field struct {
						Name string `json:"name"`
					} `json:"field"`
				} `json:"projectCustomField"`
			} `json:"fields"`
		} `json:"trimmedIssues"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("failed to unmarshal issue links: %w", err)
	}

	var result []IssueLink
	for _, group := range raw {
		if !strings.Contains(strings.ToLower(group.LinkType.Name), "relate") {
			continue
		}
		for _, issue := range group.TrimmedIssues {
			state := ""
			for _, f := range issue.Fields {
				if f.Type == "StateIssueCustomField" {
					var v struct {
						Name string `json:"name"`
					}
					if json.Unmarshal(f.Value, &v) == nil {
						state = v.Name
					}
				}
			}
			result = append(result, IssueLink{
				IDReadable: issue.IDReadable,
				Summary:    issue.Summary,
				State:      state,
				Resolved:   issue.Resolved,
			})
		}
	}
	return result, nil
}

// AddIssueToSprint adds an existing issue to a sprint.
func (c *Client) AddIssueToSprint(ctx context.Context, sprintID, issueID string) error {
	boardID, err := c.resolveBoard(ctx)
	if err != nil {
		return fmt.Errorf("failed to resolve board: %w", err)
	}
	path := fmt.Sprintf("/api/agiles/%s/sprints/%s/issues", url.PathEscape(boardID), url.PathEscape(sprintID))
	_, err = c.doRequest(ctx, http.MethodPost, path, map[string]string{"id": issueID})
	return err
}
