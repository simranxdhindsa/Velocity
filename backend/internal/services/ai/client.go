package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// AIClient interface for different AI providers
type AIClient interface {
	AnalyzeMessages(ctx context.Context, messages []SlackMessageForAnalysis, taskTitles []string) ([]TaskStatusAnalysis, error)
	AnalyzeFullInput(ctx context.Context, morningText, eveningText string) (*FullAnalysisResponse, error)
}

// NewAIClient creates an AI client based on environment configuration
func NewAIClient() AIClient {
	provider := os.Getenv("AI_PROVIDER") // Options: "groq", "openai", "gemini"
	if provider == "" {
		provider = "groq" // Default to Groq (best free tier)
	}

	switch provider {
	case "groq":
		return NewGroqClient()
	case "openai":
		return NewOpenAIClient()
	case "gemini":
		return NewGeminiClient()
	default:
		return NewGroqClient()
	}
}

// GroqClient for Groq AI (free tier: 30 requests/minute, 14,400/day)
type GroqClient struct {
	apiKey     string
	httpClient *http.Client
}

// NewGroqClient creates a new Groq AI client
func NewGroqClient() *GroqClient {
	apiKey := os.Getenv("GROQ_API_KEY")
	return &GroqClient{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// OpenAIRequest represents an OpenAI-compatible API request
type OpenAIRequest struct {
	Model    string          `json:"model"`
	Messages []OpenAIMessage `json:"messages"`
	Stream   bool            `json:"stream"`
}

// OpenAIMessage represents a chat message
type OpenAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// OpenAIResponse represents the API response
type OpenAIResponse struct {
	Choices []struct {
		Message OpenAIMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error,omitempty"`
}

// AnalyzeMessages implements AIClient interface for Groq
func (c *GroqClient) AnalyzeMessages(ctx context.Context, messages []SlackMessageForAnalysis, taskTitles []string) ([]TaskStatusAnalysis, error) {
	if c.apiKey == "" {
		return nil, fmt.Errorf("GROQ_API_KEY environment variable not set. Get free API key from https://console.groq.com")
	}

	prompt := buildAnalysisPrompt(messages, taskTitles)

	req := OpenAIRequest{
		Model: "llama-3.3-70b-versatile", // Fast and accurate
		Messages: []OpenAIMessage{
			{
				Role:    "user",
				Content: prompt,
			},
		},
		Stream: false,
	}

	jsonBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.groq.com/openai/v1/chat/completions", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var openaiResp OpenAIResponse
	if err := json.Unmarshal(body, &openaiResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if openaiResp.Error != nil {
		return nil, fmt.Errorf("API error: %s", openaiResp.Error.Message)
	}

	if len(openaiResp.Choices) == 0 {
		return nil, fmt.Errorf("no response from AI")
	}

	responseText := openaiResp.Choices[0].Message.Content
	return parseAnalysisResponse(responseText, taskTitles)
}

// OpenAIClient for OpenAI API
type OpenAIClient struct {
	apiKey     string
	httpClient *http.Client
}

// NewOpenAIClient creates a new OpenAI client
func NewOpenAIClient() *OpenAIClient {
	apiKey := os.Getenv("OPENAI_API_KEY")
	return &OpenAIClient{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// AnalyzeMessages implements AIClient interface for OpenAI
func (c *OpenAIClient) AnalyzeMessages(ctx context.Context, messages []SlackMessageForAnalysis, taskTitles []string) ([]TaskStatusAnalysis, error) {
	if c.apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY environment variable not set")
	}

	prompt := buildAnalysisPrompt(messages, taskTitles)

	req := OpenAIRequest{
		Model: "gpt-4o-mini",
		Messages: []OpenAIMessage{
			{
				Role:    "user",
				Content: prompt,
			},
		},
		Stream: false,
	}

	jsonBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var openaiResp OpenAIResponse
	if err := json.Unmarshal(body, &openaiResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if openaiResp.Error != nil {
		return nil, fmt.Errorf("API error: %s", openaiResp.Error.Message)
	}

	if len(openaiResp.Choices) == 0 {
		return nil, fmt.Errorf("no response from AI")
	}

	responseText := openaiResp.Choices[0].Message.Content
	return parseAnalysisResponse(responseText, taskTitles)
}

// AnalyzeFullInput implements AIClient interface for OpenAI
func (c *OpenAIClient) AnalyzeFullInput(ctx context.Context, morningText, eveningText string) (*FullAnalysisResponse, error) {
	if c.apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY environment variable not set")
	}

	prompt := buildFullAnalysisPrompt(morningText, eveningText)

	req := OpenAIRequest{
		Model: "gpt-4o-mini",
		Messages: []OpenAIMessage{
			{
				Role:    "user",
				Content: prompt,
			},
		},
		Stream: false,
	}

	jsonBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var openaiResp OpenAIResponse
	if err := json.Unmarshal(body, &openaiResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if openaiResp.Error != nil {
		return nil, fmt.Errorf("API error: %s", openaiResp.Error.Message)
	}

	if len(openaiResp.Choices) == 0 {
		return nil, fmt.Errorf("no response from AI")
	}

	responseText := openaiResp.Choices[0].Message.Content
	return parseFullAnalysisResponse(responseText)
}

// buildAnalysisPrompt creates the prompt for AI analysis
func buildAnalysisPrompt(messages []SlackMessageForAnalysis, taskTitles []string) string {
	var sb strings.Builder

	sb.WriteString("You are a TASK STATUS ANALYZER that analyzes Slack messages to determine task completion status.\n\n")

	sb.WriteString("## Task List:\n")
	for i, title := range taskTitles {
		sb.WriteString(fmt.Sprintf("%d. %s\n", i+1, title))
	}

	sb.WriteString("\n## Slack Messages:\n")
	for _, msg := range messages {
		sb.WriteString(fmt.Sprintf("[%s] %s: %s\n", msg.Timestamp, msg.UserName, msg.Text))
	}

	sb.WriteString("\n## Analysis Instructions\n\n")
	sb.WriteString("Analyze each task and determine its status:\n\n")

	sb.WriteString("### Status Definitions:\n")
	sb.WriteString("- **completed** / **done**: Task explicitly marked as done, finished, fixed, resolved, closed, merged, deployed\n")
	sb.WriteString("- **in_progress**: Task mentioned as \"working on\", \"still doing\", \"in progress\", \"almost done\", \"halfway\", \"debugging\"\n")
	sb.WriteString("- **blocked**: Task marked as \"blocked\", \"stuck\", \"waiting\", \"need help\", \"can't proceed\"\n")
	sb.WriteString("- **pending**: Task mentioned but not started, or in \"pending\" section\n")
	sb.WriteString("- **not_mentioned**: Task was assigned but not mentioned in any update\n\n")

	sb.WriteString("### Evidence Rules:\n")
	sb.WriteString("- Extract exact quotes from messages that show task status\n")
	sb.WriteString("- If task not mentioned: use \"Task not mentioned in evening updates\"\n")
	sb.WriteString("- Match task titles using fuzzy matching (handle abbreviations and partial titles)\n\n")

	sb.WriteString("## Output Format\n\n")
	sb.WriteString("Output ONLY valid JSON in this exact format (no markdown, no code blocks):\n\n")
	sb.WriteString("[\n")
	sb.WriteString("  {\n")
	sb.WriteString("    \"task_title\": \"exact task title from list\",\n")
	sb.WriteString("    \"detected_status\": \"completed|in_progress|blocked|pending|not_mentioned\",\n")
	sb.WriteString("    \"confidence\": 0.9,\n")
	sb.WriteString("    \"evidence\": [\"exact quote from message\"]\n")
	sb.WriteString("  }\n")
	sb.WriteString("]\n\n")

	sb.WriteString("## Critical Rules:\n")
	sb.WriteString("1. Include ALL tasks from the task list\n")
	sb.WriteString("2. Use fuzzy matching for task titles\n")
	sb.WriteString("3. Confidence scoring: 0.9-1.0 (explicit), 0.7-0.9 (strong), 0.5-0.7 (weak), 0.3-0.5 (not mentioned)\n")
	sb.WriteString("4. Output ONLY the JSON array - no other text\n")

	return sb.String()
}

// parseAnalysisResponse parses the AI's response into structured data
func parseAnalysisResponse(response string, taskTitles []string) ([]TaskStatusAnalysis, error) {
	// Extract JSON from response (it might have markdown code blocks)
	jsonStr := response
	if idx := strings.Index(response, "["); idx != -1 {
		jsonStr = response[idx:]
	}
	if idx := strings.LastIndex(jsonStr, "]"); idx != -1 {
		jsonStr = jsonStr[:idx+1]
	}

	var analyses []TaskStatusAnalysis
	if err := json.Unmarshal([]byte(jsonStr), &analyses); err != nil {
		// If JSON parsing fails, return empty results with low confidence
		results := make([]TaskStatusAnalysis, 0, len(taskTitles))
		for _, title := range taskTitles {
			results = append(results, TaskStatusAnalysis{
				TaskTitle:      title,
				DetectedStatus: "unknown",
				Confidence:     0.0,
				Evidence:       []string{"Unable to analyze"},
			})
		}
		return results, nil
	}

	return analyses, nil
}

// TaskStatusAnalysis represents the AI's analysis of a task's status
type TaskStatusAnalysis struct {
	TaskTitle      string   `json:"task_title"`
	DetectedStatus string   `json:"detected_status"` // "completed", "in_progress", "blocked", "not_started"
	Confidence     float64  `json:"confidence"`       // 0.0 to 1.0
	Evidence       []string `json:"evidence"`         // Relevant message snippets
	MessageIDs     []string `json:"message_ids"`      // IDs of messages that contributed to this analysis
}

// SlackMessageForAnalysis represents a message for AI analysis
type SlackMessageForAnalysis struct {
	ID        string `json:"id"`
	UserName  string `json:"user_name"`
	Text      string `json:"text"`
	Timestamp string `json:"timestamp"`
}

// FullAnalysisResponse represents the complete AI analysis with person breakdown
type FullAnalysisResponse struct {
	PersonBreakdown []PersonBreakdownItem `json:"person_breakdown"`
	Analysis        []TaskStatusAnalysis  `json:"analysis"`
	Summary         AnalysisSummary       `json:"summary"`
}

// PersonBreakdownItem represents one person's task breakdown
type PersonBreakdownItem struct {
	Name             string   `json:"name"`
	Assigned         []string `json:"assigned"`
	Completed        []string `json:"completed"`
	Pending          []string `json:"pending"`
	Blocked          []string `json:"blocked"`
	InProgress       []string `json:"in_progress"`
	NotMentioned     []string `json:"not_mentioned"`
	NoUpdateReceived bool     `json:"no_update_received"`
}

// AnalysisSummary represents the summary counts
type AnalysisSummary struct {
	TotalTasks   int `json:"total_tasks"`
	Completed    int `json:"completed"`
	InProgress   int `json:"in_progress"`
	Pending      int `json:"pending"`
	Blocked      int `json:"blocked"`
	NotMentioned int `json:"not_mentioned"`
}

// AnalyzeFullInput sends both morning and evening text to AI for complete structured analysis
func (c *GroqClient) AnalyzeFullInput(ctx context.Context, morningText, eveningText string) (*FullAnalysisResponse, error) {
	if c.apiKey == "" {
		return nil, fmt.Errorf("GROQ_API_KEY environment variable not set")
	}

	prompt := buildFullAnalysisPrompt(morningText, eveningText)

	req := OpenAIRequest{
		Model: "llama-3.3-70b-versatile",
		Messages: []OpenAIMessage{
			{
				Role:    "user",
				Content: prompt,
			},
		},
		Stream: false,
	}

	jsonBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.groq.com/openai/v1/chat/completions", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var openaiResp OpenAIResponse
	if err := json.Unmarshal(body, &openaiResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if openaiResp.Error != nil {
		return nil, fmt.Errorf("API error: %s", openaiResp.Error.Message)
	}

	if len(openaiResp.Choices) == 0 {
		return nil, fmt.Errorf("no response from AI")
	}

	responseText := openaiResp.Choices[0].Message.Content
	return parseFullAnalysisResponse(responseText)
}

// buildFullAnalysisPrompt creates a prompt that asks AI to return structured person breakdown
func buildFullAnalysisPrompt(morningText, eveningText string) string {
	var sb strings.Builder

	sb.WriteString("You are a TASK STATUS ANALYZER for a development team.\n\n")

	sb.WriteString("## Input\n\n")
	sb.WriteString("### MORNING TASK ASSIGNMENTS (posted by team lead):\n")
	sb.WriteString(morningText)
	sb.WriteString("\n\n### EVENING STATUS UPDATES (posted by each team member):\n")
	sb.WriteString(eveningText)

	sb.WriteString("\n\n## Instructions\n\n")
	sb.WriteString("1. First, parse the MORNING TASK ASSIGNMENTS to build a list of ALL persons and their assigned tasks\n")
	sb.WriteString("2. Then, parse the EVENING STATUS UPDATES to identify which persons posted updates\n")
	sb.WriteString("3. Each evening update typically follows this pattern:\n")
	sb.WriteString("   - A header like \"Task update @PersonName\"\n")
	sb.WriteString("   - A \"Done:\" or \"Done\" section listing completed tasks\n")
	sb.WriteString("   - An \"In Progress:\" or \"In progress\" section listing ongoing tasks\n")
	sb.WriteString("   - A \"Pending:\" section listing not-started tasks\n")
	sb.WriteString("   - A \"Blocked:\" section listing stuck tasks\n")
	sb.WriteString("4. Extract each INDIVIDUAL task (one task per line in the original update)\n")
	sb.WriteString("5. Determine status from which section each task appears under\n")
	sb.WriteString("6. If a person appears in MORNING assignments but did NOT post any evening update, they MUST still be included with:\n")
	sb.WriteString("   - \"no_update_received\": true\n")
	sb.WriteString("   - All their morning-assigned tasks listed in \"assigned\" and \"not_mentioned\" arrays\n")
	sb.WriteString("   - \"completed\", \"in_progress\", \"pending\", \"blocked\" all empty\n")
	sb.WriteString("7. For persons WHO DID post evening updates: cross-reference with morning assignments to find tasks they were assigned but did NOT mention in their evening update — add those to \"not_mentioned\" array\n")
	sb.WriteString("8. If a person posts an update about a task NOT in the morning list (extra work), still include it\n\n")

	sb.WriteString("## Output Format\n\n")
	sb.WriteString("Return ONLY valid JSON (no markdown, no code blocks, no extra text):\n\n")
	sb.WriteString("{\n")
	sb.WriteString("  \"person_breakdown\": [\n")
	sb.WriteString("    {\n")
	sb.WriteString("      \"name\": \"Person Name (without @)\",\n")
	sb.WriteString("      \"assigned\": [\"task1\", \"task2\"],\n")
	sb.WriteString("      \"completed\": [\"task1\"],\n")
	sb.WriteString("      \"pending\": [\"task2\"],\n")
	sb.WriteString("      \"blocked\": [],\n")
	sb.WriteString("      \"in_progress\": [],\n")
	sb.WriteString("      \"not_mentioned\": [\"task3\"],\n")
	sb.WriteString("      \"no_update_received\": false\n")
	sb.WriteString("    }\n")
	sb.WriteString("  ],\n")
	sb.WriteString("  \"analysis\": [\n")
	sb.WriteString("    {\n")
	sb.WriteString("      \"task_title\": \"exact task text\",\n")
	sb.WriteString("      \"detected_status\": \"completed|in_progress|pending|blocked|not_mentioned\",\n")
	sb.WriteString("      \"confidence\": 0.9,\n")
	sb.WriteString("      \"evidence\": [\"exact quote showing this status\"]\n")
	sb.WriteString("    }\n")
	sb.WriteString("  ],\n")
	sb.WriteString("  \"summary\": {\n")
	sb.WriteString("    \"total_tasks\": 0,\n")
	sb.WriteString("    \"completed\": 0,\n")
	sb.WriteString("    \"in_progress\": 0,\n")
	sb.WriteString("    \"pending\": 0,\n")
	sb.WriteString("    \"blocked\": 0,\n")
	sb.WriteString("    \"not_mentioned\": 0\n")
	sb.WriteString("  }\n")
	sb.WriteString("}\n\n")

	sb.WriteString("## Critical Rules\n\n")
	sb.WriteString("1. Each task MUST be a SEPARATE string in the arrays - NEVER concatenate multiple tasks into one string\n")
	sb.WriteString("2. EVERY person from the MORNING list MUST appear in person_breakdown — even if they posted NO evening update\n")
	sb.WriteString("3. If a person appears multiple times in evening updates, MERGE their tasks into one entry (take the LATEST status for each task)\n")
	sb.WriteString("4. Status headers like \"Done:\", \"In Progress:\", \"Inprogress:\" are NOT tasks - skip them\n")
	sb.WriteString("5. Timestamps like \"4:54 PM\", \"7:09 PM\" are NOT tasks - skip them\n")
	sb.WriteString("6. Slack display names that appear alone on a line (like \"Vishal\", \"Parv\") before timestamps are NOT tasks\n")
	sb.WriteString("7. The \"assigned\" array should contain ALL tasks for that person (union of morning assigned + any extra evening tasks)\n")
	sb.WriteString("8. Messages like \"just following up\" or \"please share an update\" are NOT task updates - skip them\n")
	sb.WriteString("9. Output ONLY the JSON object - no other text before or after\n")
	sb.WriteString("10. A task must appear in EXACTLY ONE status category per person (completed OR in_progress OR pending OR blocked OR not_mentioned) — NEVER in multiple categories\n")
	sb.WriteString("11. The \"analysis\" array must include EVERY task from EVERY person (including not_mentioned ones) — each task appears EXACTLY ONCE\n")
	sb.WriteString("12. If the same task is assigned to multiple persons, track it separately per person but in the analysis array include it once with the most advanced status\n")
	sb.WriteString("13. If a morning task text and evening task text refer to the same work but have slightly different wording, treat them as the SAME task and use the morning wording\n")

	return sb.String()
}

// parseFullAnalysisResponse parses the AI response into FullAnalysisResponse
func parseFullAnalysisResponse(response string) (*FullAnalysisResponse, error) {
	// Extract JSON from response (might have markdown code blocks)
	jsonStr := response

	// Try to find JSON object
	if idx := strings.Index(response, "{"); idx != -1 {
		jsonStr = response[idx:]
	}
	if idx := strings.LastIndex(jsonStr, "}"); idx != -1 {
		jsonStr = jsonStr[:idx+1]
	}

	var result FullAnalysisResponse
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		return nil, fmt.Errorf("failed to parse AI response as JSON: %w\nRaw response: %s", err, response[:min(len(response), 500)])
	}

	return &result, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ConvMessage is a single turn in a multi-turn conversation (role = "user" | "assistant").
type ConvMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// QueryWithHistory sends a full conversation history to the AI and returns the response.
// It builds the messages array as: [system] + [history turns...] + [new user message].
func QueryWithHistory(ctx context.Context, systemPrompt string, history []ConvMessage, userQuery string) (string, error) {
	provider := os.Getenv("AI_PROVIDER")
	if provider == "" {
		provider = "groq"
	}

	var apiURL, apiKey, model string
	switch provider {
	case "openai":
		apiURL = "https://api.openai.com/v1/chat/completions"
		apiKey = os.Getenv("OPENAI_API_KEY")
		model = "gpt-4o-mini"
	case "gemini":
		apiURL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
		apiKey = os.Getenv("GEMINI_API_KEY")
		model = "gemini-2.0-flash"
	default:
		apiURL = "https://api.groq.com/openai/v1/chat/completions"
		apiKey = os.Getenv("GROQ_API_KEY")
		// Allow overriding the Groq model via env var (useful when one model hits its daily quota)
		model = os.Getenv("GROQ_MODEL")
		if model == "" {
			model = "llama-3.3-70b-versatile"
		}
	}

	if apiKey == "" {
		return "", fmt.Errorf("AI API key not configured for provider %s", provider)
	}

	messages := []OpenAIMessage{{Role: "system", Content: systemPrompt}}
	for _, h := range history {
		messages = append(messages, OpenAIMessage{Role: h.Role, Content: h.Content})
	}
	messages = append(messages, OpenAIMessage{Role: "user", Content: userQuery})

	req := OpenAIRequest{Model: model, Messages: messages, Stream: false}

	jsonBody, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response: %w", err)
	}

	// Some providers (e.g. Gemini on quota error) return a JSON array instead of an object.
	// Detect this and extract the error message before attempting struct unmarshal.
	trimmed := strings.TrimSpace(string(body))
	if strings.HasPrefix(trimmed, "[") {
		var arrResp []struct {
			Error *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &arrResp) == nil && len(arrResp) > 0 && arrResp[0].Error != nil {
			return "", fmt.Errorf("API error: %s", arrResp[0].Error.Message)
		}
		return "", fmt.Errorf("unexpected array response from AI provider")
	}

	var openaiResp OpenAIResponse
	if err := json.Unmarshal(body, &openaiResp); err != nil {
		return "", fmt.Errorf("failed to parse response: %w", err)
	}

	if openaiResp.Error != nil {
		return "", fmt.Errorf("API error: %s", openaiResp.Error.Message)
	}

	if len(openaiResp.Choices) == 0 {
		return "", fmt.Errorf("no response from AI")
	}

	return openaiResp.Choices[0].Message.Content, nil
}

// QueryWithContext sends a system prompt + user query to the AI and returns the raw response text.
// Used for free-form PM assistant queries.
func QueryWithContext(ctx context.Context, systemPrompt, userQuery string) (string, error) {
	provider := os.Getenv("AI_PROVIDER")
	if provider == "" {
		provider = "groq"
	}

	var apiURL, apiKey, model string
	switch provider {
	case "openai":
		apiURL = "https://api.openai.com/v1/chat/completions"
		apiKey = os.Getenv("OPENAI_API_KEY")
		model = "gpt-4o-mini"
	case "gemini":
		apiURL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
		apiKey = os.Getenv("GEMINI_API_KEY")
		model = "gemini-2.0-flash"
	default:
		apiURL = "https://api.groq.com/openai/v1/chat/completions"
		apiKey = os.Getenv("GROQ_API_KEY")
		model = "llama-3.3-70b-versatile"
	}

	if apiKey == "" {
		return "", fmt.Errorf("AI API key not configured for provider %s", provider)
	}

	req := OpenAIRequest{
		Model: model,
		Messages: []OpenAIMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userQuery},
		},
		Stream: false,
	}

	jsonBody, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response: %w", err)
	}

	var openaiResp OpenAIResponse
	if err := json.Unmarshal(body, &openaiResp); err != nil {
		return "", fmt.Errorf("failed to parse response: %w", err)
	}

	if openaiResp.Error != nil {
		return "", fmt.Errorf("API error: %s", openaiResp.Error.Message)
	}

	if len(openaiResp.Choices) == 0 {
		return "", fmt.Errorf("no response from AI")
	}

	return openaiResp.Choices[0].Message.Content, nil
}
