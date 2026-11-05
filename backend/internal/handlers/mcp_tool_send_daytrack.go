package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

var sendDaytrackToolSchema = map[string]interface{}{
	"name": "send_daytrack",
	"description": "Posts the caller's Day Track report for a date to the Slack channel saved in their Day Track settings, the same as the page's Post to Slack button. " +
		"The first send posts a new message and every later send for that date edits it in place, so sending again never spams the channel. The destination can't be changed here. " +
		"Pass `preview: true` to get the exact text and the channel without posting. Show that to the user first unless they clearly asked to send now. " +
		"Sign In, Sign Off and Breaks are left out of the report, plain planned items too, and in-progress items appear under In Progress. Today's YouTrack activity is pulled in first.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"date": map[string]interface{}{
				"type":        "string",
				"description": "YYYY-MM-DD, 'today' or 'yesterday', in the user's Day Track timezone. Defaults to today.",
			},
			"preview": map[string]interface{}{
				"type":        "boolean",
				"description": "true returns the report without posting. Default false.",
			},
		},
		"required": []string{},
	},
}

// mcpDTHandler returns the real Day Track handler when the server wired one in (see
// UseDayTrack), or one without YouTrack access otherwise, which skips the sync and prune steps.
func (h *MCPHandler) mcpDTHandler() *DayTrackHandler {
	if h.dayTrack != nil {
		return h.dayTrack
	}
	return &DayTrackHandler{repo: mcpDayTrackRepo, userRepo: mcpUserRepo}
}

func mcpSendDaytrack(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Date    string `json:"date"`
		Preview bool   `json:"preview"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return toolError(id, mcpDTArgsError(err))
		}
	}
	user, err := mcpUserRepo.GetByID(ctx, userID)
	if err != nil || user == nil {
		return toolError(id, "could not load your Velocity user")
	}

	now := mcpDayTrackClockFor(ctx, userID)
	dateArg := a.Date
	if strings.TrimSpace(dateArg) == "" {
		dateArg = "today"
	}
	day, err := mcpParseDayTrackDate(dateArg, now.Loc)
	if err != nil {
		return toolError(id, err.Error())
	}
	date := day.Format("2006-01-02")
	if date > now.Today {
		return toolError(id, date+" is in the future, so there is nothing to send")
	}

	cfg, err := mcpDayTrackRepo.GetSlackConfig(ctx, userID)
	if err != nil || cfg == nil || cfg.DestChannelID == "" {
		return toolError(id, "no Slack channel is set for Day Track. Pick one in the Day Track page's Slack settings first")
	}
	channel := cfg.DestChannelName
	if channel == "" {
		channel = cfg.DestChannelID
	} else if !strings.HasPrefix(channel, "#") {
		channel = "#" + channel
	}

	dt := h.mcpDTHandler()
	var warnings []string
	// Nobody may have opened the page today, so pull in ticket activity first, the same as
	// the daily auto-send. A preview does this too, or it could differ from the real send.
	if dt.ytHandler != nil && date == now.Today {
		syncCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		_, _, _, _, _, syncErr := dt.ytHandler.scanYouTrackTicketsForUser(syncCtx, userID, date)
		cancel()
		if syncErr != nil && !errors.Is(syncErr, errYTScanNotConfigured) {
			log.Printf("[MCP DayTrack] YouTrack sync failed for user %s: %v", userID, syncErr)
			warnings = append(warnings, "Could not refresh from YouTrack, so the newest ticket activity may be missing.")
		}
	}

	existing, err := mcpDayTrackRepo.GetDailyPost(ctx, userID, date)
	if err != nil {
		return toolError(id, "failed to read the post record: "+err.Error())
	}
	text, err := dt.buildDayTrackReportText(ctx, userID, date, user.Name)
	if errors.Is(err, errDayTrackNoEntries) {
		return toolError(id, "nothing to send for "+date+". Only Sign In, Sign Off and Breaks are logged, or nothing is")
	}
	if err != nil {
		return toolError(id, "failed to build the report: "+err.Error())
	}

	details := map[string]interface{}{"date": date, "channel": channel, "report_text": text, "already_posted": existing != nil}
	if len(warnings) > 0 {
		details["warnings"] = warnings
	}
	if a.Preview {
		verb := "post it to"
		if existing != nil {
			verb = "edit the existing post in"
		}
		return mcpDTResult(id, fmt.Sprintf("Preview only. Sending would %s %s.", verb, channel), details)
	}

	updated, err := dt.postDayTrackUpdate(ctx, userID, date, cfg.DestChannelID, user.Name)
	if err != nil {
		if errors.Is(err, errDayTrackNoEntries) {
			return toolError(id, "nothing to send for "+date)
		}
		return toolError(id, "failed to post to "+channel+": "+err.Error())
	}
	details["action"] = "posted"
	sentence := fmt.Sprintf("Posted the %s Day Track report to %s.", date, channel)
	if updated {
		details["action"] = "updated"
		sentence = fmt.Sprintf("Updated the %s Day Track report in %s.", date, channel)
	}
	return mcpDTResult(id, sentence, details)
}
