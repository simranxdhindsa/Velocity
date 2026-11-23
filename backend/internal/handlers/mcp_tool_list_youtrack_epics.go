package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

var listYoutrackEpicsToolSchema = map[string]interface{}{
	"name": "list_youtrack_epics",
	"description": "Read-only. Lists the open feature epics in the YouTrack project (Type Epic, Subsystem Epic), how many there are, and for each one its tickets with their status, type and subsystem. " +
		"Use it when the user asks which epics exist or what is in one, and before create_youtrack_ticket so you can suggest the right epic for a new feature, enhancement or bug.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"include_tickets": map[string]interface{}{
				"type":        "boolean",
				"description": "Default true: list each epic's tickets. false returns just the epics and their ticket counts, for a shorter answer.",
			},
		},
		"required": []string{},
	},
}

func mcpListYoutrackEpics(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		IncludeTickets *bool `json:"include_tickets"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &a); err != nil {
			return rpcErr(id, -32602, "invalid arguments: "+err.Error())
		}
	}
	yt := mcpYTClient(ctx, userID)
	if yt == nil {
		return toolError(id, "YouTrack not configured. Add your YouTrack integration in Velocity > Integrations")
	}
	epics, err := openEpics(ctx, yt)
	if err != nil {
		slog.ErrorContext(ctx, "Could not load open epics from YouTrack", "error", err)
		return toolError(id, "could not load epics: "+err.Error())
	}
	withTickets := a.IncludeTickets == nil || *a.IncludeTickets
	base := strings.TrimRight(yt.GetBaseURL(), "/")

	out := make([]map[string]interface{}, 0, len(epics))
	for _, e := range epics {
		// shortcut: one query per epic, capped at 200 tickets each; fine for a handful of epics, batch it if there are dozens.
		children, cErr := yt.SearchIssues(ctx, fmt.Sprintf("subtask of: %s", e.IDReadable), 200)
		row := map[string]interface{}{
			"id_readable": e.IDReadable,
			"summary":     e.Summary,
			"status":      youtrack.GetStatus(e),
			"url":         base + "/issue/" + e.IDReadable,
		}
		if cErr != nil {
			slog.WarnContext(ctx, "Could not load an epic's tickets, listing it without them", "epic", e.IDReadable, "error", cErr)
			row["tickets_error"] = cErr.Error()
			out = append(out, row)
			continue
		}
		row["ticket_count"] = len(children)
		if withTickets {
			tickets := make([]map[string]string, 0, len(children))
			for _, c := range children {
				tickets = append(tickets, map[string]string{
					"id_readable": c.IDReadable,
					"summary":     c.Summary,
					"status":      youtrack.GetStatus(c),
					"type":        youtrack.GetCustomFieldValue(c, "Type"),
					"subsystem":   youtrack.GetSubsystem(c),
				})
			}
			row["tickets"] = tickets
		}
		out = append(out, row)
	}
	slog.InfoContext(ctx, "Listed open epics", "count", len(out))
	data, _ := json.Marshal(map[string]interface{}{"epic_count": len(out), "epics": out})
	return toolOK(id, string(data))
}
