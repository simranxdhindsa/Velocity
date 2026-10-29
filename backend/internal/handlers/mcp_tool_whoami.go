package handlers

import (
	"context"
	"encoding/json"
	"os"
	"strings"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var whoamiToolSchema = map[string]interface{}{
	"name": "whoami",
	"description": "Read-only. Returns who the current Velocity user (the MCP caller) is: Velocity name, email and role; their YouTrack login and full name; " +
		"their Slack user ID; the active PM data source; the YouTrack project and board; the current sprint; and their timezone. " +
		"Call this FIRST whenever the user says 'me', 'my', 'mine' or 'I' (e.g. 'my tickets', 'what's waiting on me', 'assign it to me', 'DM me'), " +
		"then pass the returned youtrack.login as assignee_login to search_youtrack_tickets, slack.user_id as a DM target, or current_sprint as sprint_name. " +
		"The result is stable within a conversation, so call it once and reuse it.",
	"inputSchema": map[string]interface{}{
		"type":       "object",
		"properties": map[string]interface{}{},
		"required":   []string{},
	},
}

var mcpIntegrationRepo = database.NewIntegrationRepository()

func mcpWhoami(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	user, err := mcpUserRepo.GetByID(ctx, userID)
	if err != nil || user == nil {
		return toolError(id, "could not load the calling Velocity user")
	}
	var notes []string

	// ── PM data source: same rule as AsanaPMHandler.GetDataSource (members/viewers follow the admin's).
	ownSource, _ := mcpSettingsRepo.GetUserDataSource(ctx, userID)
	activeSource := ownSource
	sourceFrom := "user setting"
	if user.Role == models.RoleMember || user.Role == models.RoleViewer {
		activeSource = mcpSettingsRepo.GetAdminDataSource(ctx)
		sourceFrom = "admin's setting (members and viewers follow the admin)"
	}

	// ── YouTrack: which credentials mcpYTClient will use, and who the user is in YouTrack.
	ytInfo := map[string]interface{}{"configured": false}
	ytClient := mcpYTClient(ctx, userID)
	if ytClient != nil {
		ytInfo["configured"] = true
		credSource := "env"
		globalBoardID := ""
		var personal *models.YouTrackIntegration
		if integ, iErr := mcpSettingsRepo.GetYouTrackIntegration(ctx, userID); iErr == nil && integ != nil && integ.Connected {
			personal = integ
			credSource = "personal integration"
			ytInfo["project_id"] = integ.ProjectID
			ytInfo["base_url"] = integ.BaseURL
		} else if gs, gErr := mcpSettingsRepo.GetYouTrackSettings(ctx); gErr == nil && gs != nil && gs.Configured {
			credSource = "global settings"
			globalBoardID = gs.BoardID
			ytInfo["project_id"] = gs.ProjectID
			ytInfo["base_url"] = gs.BaseURL
		} else {
			ytInfo["project_id"] = os.Getenv("YOUTRACK_PROJECT_ID")
			ytInfo["base_url"] = os.Getenv("YOUTRACK_BASE_URL")
		}
		ytInfo["credentials"] = credSource

		// Identity. With a personal token, /api/users/me IS the user (the same way
		// DayTrack's YouTrack scan identifies them). With shared credentials, /users/me
		// would be the token owner, so match the Velocity email against YouTrack users.
		var me *youtrack.User
		method := ""
		if personal != nil {
			if u, uErr := ytClient.GetCurrentUser(ctx); uErr == nil && u != nil {
				me, method = u, "personal token (/api/users/me)"
			}
		}
		if me == nil {
			if users, uErr := ytClient.GetUsers(ctx); uErr == nil {
				for i := range users {
					if users[i].Email != "" && strings.EqualFold(users[i].Email, user.Email) {
						me, method = &users[i], "email match against YouTrack users"
						break
					}
				}
			}
		}
		if me != nil {
			ytInfo["login"] = me.Login
			ytInfo["full_name"] = me.FullName
			ytInfo["email"] = me.Email
			ytInfo["matched_by"] = method
			if me.Email != "" && !strings.EqualFold(me.Email, user.Email) {
				notes = append(notes, "YouTrack account email ("+me.Email+") differs from the Velocity email; the personal YouTrack token belongs to that account.")
			}
			if cfgs, cErr := devConfigRepo.GetAll(ctx); cErr == nil {
				for _, c := range cfgs {
					if strings.EqualFold(c.DeveloperLogin, me.Login) {
						ytInfo["developer_config"] = map[string]interface{}{
							"developer_name": c.DeveloperName,
							"subsystems":     c.Subsystems,
							"is_qa":          c.IsQA,
						}
						break
					}
				}
			}
		} else {
			notes = append(notes, "Could not determine the YouTrack login: no personal YouTrack integration and no YouTrack user with the Velocity email.")
		}

		// Board + current sprint: same resolution GetSprints / get_developer_load / search 'current' use.
		if boardID, bErr := ytClient.ResolveBoard(ctx); bErr == nil && boardID != "" {
			board := map[string]string{"id": boardID}
			if boards, gErr := ytClient.GetBoards(ctx); gErr == nil {
				for _, b := range boards {
					if b.ID == boardID {
						board["name"] = b.Name
						break
					}
				}
			}
			ytInfo["board"] = board
			if globalBoardID != "" && globalBoardID != boardID {
				notes = append(notes, "Org YouTrack settings name board "+globalBoardID+", but the MCP tools auto-detect board "+boardID+" for users without a personal YouTrack integration.")
			}
		}
		if sprint, sErr := ytClient.GetLatestSprintName(ctx); sErr == nil && sprint != "" {
			ytInfo["current_sprint"] = sprint
		} else if sErr != nil {
			notes = append(notes, "Could not resolve the current sprint: "+sErr.Error())
		}
	} else {
		notes = append(notes, "YouTrack is not configured for this user (Velocity Integrations > YouTrack).")
	}

	// ── Slack user ID: slack_integrations.slack_user_id, then DayTrack's Slack config,
	// then a users.lookupByEmail with the user's bot token (or SLACK_BOT_TOKEN).
	slackInfo := map[string]interface{}{}
	slackID, slackFrom := "", ""
	pool := database.GetPool()
	if pool != nil {
		_ = pool.QueryRow(ctx,
			`SELECT COALESCE(slack_user_id, '') FROM slack_integrations WHERE user_id = $1 AND connected = true`,
			userID).Scan(&slackID)
		if slackID != "" {
			slackFrom = "slack integration"
		}
	}
	dtCfg, _ := mcpDayTrackRepo.GetSlackConfig(ctx, userID)
	if slackID == "" && dtCfg != nil && dtCfg.SlackUserID != "" {
		slackID, slackFrom = dtCfg.SlackUserID, "DayTrack Slack config"
	}
	if slackID == "" {
		botToken := ""
		if si, sErr := mcpIntegrationRepo.GetSlackIntegration(ctx, userID); sErr == nil && si != nil && si.Connected {
			botToken = si.BotToken
		}
		if botToken == "" {
			botToken = os.Getenv("SLACK_BOT_TOKEN")
		}
		if uid := SlackUserIDFromEmail(ctx, botToken, user.Email); uid != "" {
			slackID, slackFrom = uid, "Slack lookup by email"
		}
	}
	if slackID != "" {
		slackInfo["user_id"] = slackID
		slackInfo["source"] = slackFrom
		slackInfo["mention"] = "<@" + slackID + ">"
	} else {
		notes = append(notes, "Slack user ID unknown.")
	}

	// ── Timezone: DayTrack's per-user timezone (the only stored one).
	_, tzName := mcpDayTrackTimezone(ctx, userID)
	tzInfo := map[string]string{"name": tzName}
	if dtCfg != nil && dtCfg.Timezone != "" {
		tzInfo["source"] = "DayTrack settings"
	} else {
		tzInfo["source"] = "default (not set by user)"
	}

	resp := map[string]interface{}{
		"velocity": map[string]string{
			"user_id": user.ID,
			"name":    user.Name,
			"email":   user.Email,
			"role":    string(user.Role),
		},
		"youtrack": ytInfo,
		"slack":    slackInfo,
		"pm_data_source": map[string]string{
			"active":      activeSource,
			"source":      sourceFrom,
			"own_setting": ownSource,
		},
		"timezone": tzInfo,
	}
	if cs, ok := ytInfo["current_sprint"]; ok {
		resp["current_sprint"] = cs
	}
	if activeSource == "asana" {
		if ai, aErr := mcpIntegrationRepo.GetAsanaIntegration(ctx, userID); aErr == nil && ai != nil {
			resp["asana"] = map[string]interface{}{
				"connected":      ai.Connected,
				"workspace_name": ai.WorkspaceName,
				"project_gid":    ai.ProjectID,
			}
		}
		notes = append(notes, "Active PM source is Asana; the YouTrack tools still use the YouTrack integration shown here.")
	}
	if len(notes) > 0 {
		resp["notes"] = notes
	}
	data, _ := json.Marshal(resp)
	return toolOK(id, string(data))
}
