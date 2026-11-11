package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/middleware"
	"github.com/dhindsa/project-management/internal/models"
	"github.com/gorilla/mux"
)

// DailyTaskHandler handles daily task management API requests
type DailyTaskHandler struct {
	dailyRepo *database.DailyTaskRepository
}

// NewDailyTaskHandler creates a new DailyTaskHandler
func NewDailyTaskHandler() *DailyTaskHandler {
	return &DailyTaskHandler{
		dailyRepo: database.NewDailyTaskRepository(),
	}
}

// ===== ANALYSIS ENDPOINTS =====

// SaveAnalysis saves AI analysis results to database
func (h *DailyTaskHandler) SaveAnalysis(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	var req models.SaveAnalysisRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body: " + err.Error(),
		})
		return
	}

	// Validate required fields
	if req.Date == "" || req.MorningMessage == "" || req.AnalysisResult == nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "date, morning_message, and analysis_result are required",
		})
		return
	}

	// Save analysis
	analysis, err := h.dailyRepo.SaveAnalysis(r.Context(), &req)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to save analysis: " + err.Error(),
		})
		return
	}

	// Extract tasks from analysis result and save to daily_tasks
	tasks := extractTasksFromAnalysis(req.AnalysisResult, req.Date)
	if len(tasks) > 0 {
		if err := h.dailyRepo.SaveDailyTasks(r.Context(), analysis.ID, req.Date, tasks); err != nil {
			// Log error but don't fail the request
			log.Printf("Warning: Failed to save daily tasks: %v", err)
		}
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    analysis,
		Message: "Analysis saved successfully",
	})
}

// GetAnalysisByDate retrieves analysis for a specific date
func (h *DailyTaskHandler) GetAnalysisByDate(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	date := vars["date"]

	analysis, err := h.dailyRepo.GetAnalysisByDate(r.Context(), date)
	if err != nil {
		sendJSON(w, http.StatusNotFound, Response{
			Success: false,
			Message: "No analysis found for this date",
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    analysis,
	})
}

// ===== DAILY TASKS ENDPOINTS =====

// GetTodaysTasks retrieves today's tasks with their status
func (h *DailyTaskHandler) GetTodaysTasks(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	date := vars["date"]

	// Get tasks by assignee
	tasksByAssignee, err := h.dailyRepo.GetTasksByAssignee(r.Context(), date)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to fetch tasks: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    tasksByAssignee,
	})
}

// ===== NEXT DAY TASKS ENDPOINTS =====

// GetNextDayTasks retrieves all tasks for a specific target date
func (h *DailyTaskHandler) GetNextDayTasks(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	targetDate := vars["date"]

	taskList, err := h.dailyRepo.GetNextDayTasksGroupedByAssignee(r.Context(), targetDate)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to fetch next day tasks: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    taskList,
	})
}

// GenerateNextDayTasks generates next day tasks from pending/skipped tasks
func (h *DailyTaskHandler) GenerateNextDayTasks(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	var req models.GenerateNextDayRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body: " + err.Error(),
		})
		return
	}

	if req.SourceDate == "" || req.TargetDate == "" {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "source_date and target_date are required",
		})
		return
	}

	// Generate tasks from pending/skipped tasks
	if err := h.dailyRepo.GenerateNextDayTasksFromPending(r.Context(), req.SourceDate, req.TargetDate); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to generate next day tasks: " + err.Error(),
		})
		return
	}

	// Fetch the generated task list
	taskList, err := h.dailyRepo.GetNextDayTasksGroupedByAssignee(r.Context(), req.TargetDate)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Generated tasks but failed to fetch them: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    taskList,
		Message: "Next day tasks generated successfully",
	})
}

// CreateNextDayTask creates a new task for tomorrow
func (h *DailyTaskHandler) CreateNextDayTask(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	var req models.CreateNextDayTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body: " + err.Error(),
		})
		return
	}

	if req.TargetDate == "" || req.Assignee == "" || req.TaskTitle == "" {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "target_date, assignee, and task_title are required",
		})
		return
	}

	task, err := h.dailyRepo.CreateNextDayTask(r.Context(), &req, user.ID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to create task: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusCreated, Response{
		Success: true,
		Data:    task,
		Message: "Task created successfully",
	})
}

// UpdateNextDayTask updates an existing next day task
func (h *DailyTaskHandler) UpdateNextDayTask(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	taskID := vars["taskId"]

	var req models.UpdateNextDayTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body: " + err.Error(),
		})
		return
	}

	if err := h.dailyRepo.UpdateNextDayTask(r.Context(), taskID, &req); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to update task: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Task updated successfully",
	})
}

// DeleteNextDayTask deletes a next day task
func (h *DailyTaskHandler) DeleteNextDayTask(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	taskID := vars["taskId"]

	if err := h.dailyRepo.DeleteNextDayTask(r.Context(), taskID); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to delete task: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Task deleted successfully",
	})
}

// ReorderNextDayTasks reorders tasks for a specific assignee
func (h *DailyTaskHandler) ReorderNextDayTasks(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	var req models.ReorderTasksRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body: " + err.Error(),
		})
		return
	}

	if req.TargetDate == "" || req.Assignee == "" || len(req.TaskIDs) == 0 {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "target_date, assignee, and task_ids are required",
		})
		return
	}

	if err := h.dailyRepo.ReorderNextDayTasks(r.Context(), req.TargetDate, req.Assignee, req.TaskIDs); err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to reorder tasks: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Message: "Tasks reordered successfully",
	})
}

// BulkCreateNextDayTasks creates multiple tasks at once from YouTrack pull
func (h *DailyTaskHandler) BulkCreateNextDayTasks(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	var req models.BulkCreateNextDayTasksRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "Invalid request body: " + err.Error(),
		})
		return
	}

	if req.TargetDate == "" || len(req.Tasks) == 0 {
		sendJSON(w, http.StatusBadRequest, Response{
			Success: false,
			Message: "target_date and tasks are required",
		})
		return
	}

	skipped, err := h.dailyRepo.BulkCreateNextDayTasks(r.Context(), req.TargetDate, req.Tasks, user.ID)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to create tasks: " + err.Error(),
		})
		return
	}

	// Return updated task list
	taskList, err := h.dailyRepo.GetNextDayTasksGroupedByAssignee(r.Context(), req.TargetDate)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Tasks created but failed to fetch them: " + err.Error(),
		})
		return
	}

	created := len(req.Tasks) - skipped
	msg := fmt.Sprintf("Created %d tasks successfully", created)
	if skipped > 0 {
		msg += fmt.Sprintf(" (%d duplicates skipped)", skipped)
	}

	sendJSON(w, http.StatusCreated, Response{
		Success: true,
		Data:    taskList,
		Message: msg,
	})
}

// GetFormattedSlackMessage returns Slack-formatted text for copy/paste
func (h *DailyTaskHandler) GetFormattedSlackMessage(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r)
	if user == nil {
		sendJSON(w, http.StatusUnauthorized, Response{Success: false, Message: "Unauthorized"})
		return
	}

	vars := mux.Vars(r)
	targetDate := vars["date"]

	formatted, err := h.dailyRepo.FormatSlackMessage(r.Context(), targetDate)
	if err != nil {
		sendJSON(w, http.StatusInternalServerError, Response{
			Success: false,
			Message: "Failed to format Slack message: " + err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]string{
			"formatted_message": formatted,
			"date":              targetDate,
		},
	})
}

// ===== HELPER FUNCTIONS =====

// extractTasksFromAnalysis extracts DailyTask records from AI analysis result
func extractTasksFromAnalysis(analysisResult map[string]interface{}, date string) []models.DailyTask {
	var tasks []models.DailyTask

	// Extract from "analysis" array
	if analysisArray, ok := analysisResult["analysis"].([]interface{}); ok {
		for _, item := range analysisArray {
			if taskMap, ok := item.(map[string]interface{}); ok {
				task := models.DailyTask{
					Date:      date,
					TaskTitle: getString(taskMap, "task_title"),
					Status:    getString(taskMap, "detected_status"),
				}

				// Extract confidence
				if conf, ok := taskMap["confidence"].(float64); ok {
					task.Confidence = conf
				}

				// Extract evidence
				if evidence, ok := taskMap["evidence"].([]interface{}); ok && len(evidence) > 0 {
					evidenceStr := fmt.Sprintf("%v", evidence[0])
					task.Evidence = &evidenceStr
				}

				// We don't have assignee in this format, will be populated from person_breakdown
				tasks = append(tasks, task)
			}
		}
	}

	// Extract from "person_breakdown" for better assignee mapping
	if personBreakdown, ok := analysisResult["person_breakdown"].([]interface{}); ok {
		tasksByTitle := make(map[string]*models.DailyTask)
		for i := range tasks {
			tasksByTitle[tasks[i].TaskTitle] = &tasks[i]
		}

		for _, person := range personBreakdown {
			if personMap, ok := person.(map[string]interface{}); ok {
				assignee := getString(personMap, "name")

				// Process completed tasks
				if completed, ok := personMap["completed"].([]interface{}); ok {
					for _, taskTitle := range completed {
						title := fmt.Sprintf("%v", taskTitle)
						if task, exists := tasksByTitle[title]; exists {
							task.Assignee = assignee
							task.Status = "done"
						} else {
							tasks = append(tasks, models.DailyTask{
								Date:       date,
								Assignee:   assignee,
								TaskTitle:  title,
								Status:     "done",
								Confidence: 1.0,
							})
						}
					}
				}

				// Process pending tasks
				if pending, ok := personMap["pending"].([]interface{}); ok {
					for _, taskTitle := range pending {
						title := fmt.Sprintf("%v", taskTitle)
						if task, exists := tasksByTitle[title]; exists {
							task.Assignee = assignee
						} else {
							tasks = append(tasks, models.DailyTask{
								Date:       date,
								Assignee:   assignee,
								TaskTitle:  title,
								Status:     "pending",
								Confidence: 0.8,
							})
						}
					}
				}

				// Process blocked tasks
				if blocked, ok := personMap["blocked"].([]interface{}); ok {
					for _, taskTitle := range blocked {
						title := fmt.Sprintf("%v", taskTitle)
						tasks = append(tasks, models.DailyTask{
							Date:       date,
							Assignee:   assignee,
							TaskTitle:  title,
							Status:     "blocked",
							Confidence: 0.9,
						})
					}
				}

				// Process assigned tasks (catch any that weren't in completed/pending/blocked)
				if assigned, ok := personMap["assigned"].([]interface{}); ok {
					processedTitles := make(map[string]bool)
					for _, task := range tasks {
						processedTitles[task.TaskTitle] = true
					}

					for _, taskTitle := range assigned {
						title := fmt.Sprintf("%v", taskTitle)
						if !processedTitles[title] {
							// Task was assigned but not mentioned in updates
							tasks = append(tasks, models.DailyTask{
								Date:       date,
								Assignee:   assignee,
								TaskTitle:  title,
								Status:     "skipped", // or "not_mentioned"
								Confidence: 0.5,
							})
						}
					}
				}
			}
		}
	}

	// Remove tasks with empty assignee
	filteredTasks := []models.DailyTask{}
	for _, task := range tasks {
		if task.Assignee != "" {
			// Clean up assignee name (remove @ if present)
			task.Assignee = strings.TrimPrefix(task.Assignee, "@")
			filteredTasks = append(filteredTasks, task)
		}
	}

	return filteredTasks
}

// getString safely extracts a string from a map
func getString(m map[string]interface{}, key string) string {
	if val, ok := m[key]; ok {
		return fmt.Sprintf("%v", val)
	}
	return ""
}
