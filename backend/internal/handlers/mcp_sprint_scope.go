package handlers

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	"github.com/dhindsa/project-management/internal/models"
	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// mcpBoardContext is everything the sprint/board write tools need about the
// user's selected YouTrack board: its sprints, which one is current, the
// project's real states and the user's workflow config.
type mcpBoardContext struct {
	BoardID    string
	BoardName  string
	Sprints    []youtrack.Sprint
	Current    *youtrack.Sprint
	RealStates map[string]string // lowercase → exact YouTrack state name
	Workflow   *models.WorkflowConfig
}

// loadMCPBoardContext resolves the board from the user's YouTrack integration
// (BoardID set by mcpYTClient, else auto-detected for the project) and loads
// its sprints, current sprint, states and workflow config.
func loadMCPBoardContext(ctx context.Context, yt *youtrack.Client, userID string) (*mcpBoardContext, error) {
	sprints, boardID, err := yt.GetAllBoardSprints(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch sprints for board %s: %w", boardID, err)
	}
	bc := &mcpBoardContext{BoardID: boardID, Sprints: sprints, RealStates: map[string]string{}}
	if boards, err := yt.GetBoards(ctx); err == nil {
		for _, b := range boards {
			if b.ID == boardID {
				bc.BoardName = b.Name
			}
		}
	}
	if len(sprints) > 0 {
		bc.Current = youtrack.LatestSprint(sprints, time.Now())
	}
	states, err := yt.GetStates(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch project states: %w", err)
	}
	for _, st := range states {
		bc.RealStates[strings.ToLower(st.Name)] = st.Name
	}
	if cfg, err := database.NewWorkflowConfigRepository().GetEffective(ctx, userID, "youtrack"); err == nil {
		bc.Workflow = cfg
	}
	return bc, nil
}

// findSprint resolves a sprint reference: "current", "next" (the sprint after
// the current one by start date) or a sprint name (case-insensitive).
func (bc *mcpBoardContext) findSprint(ref string) (*youtrack.Sprint, error) {
	ref = strings.TrimSpace(ref)
	switch strings.ToLower(ref) {
	case "current", "latest":
		if bc.Current == nil {
			return nil, fmt.Errorf("board %s has no sprints", bc.boardLabel())
		}
		return bc.Current, nil
	case "next":
		next := youtrack.NextSprint(bc.Sprints, bc.Current)
		if next == nil {
			cur := ""
			if bc.Current != nil {
				cur = fmt.Sprintf(" after %q", bc.Current.Name)
			}
			return nil, fmt.Errorf("there is no next sprint%s on board %s. Ask the user whether to create one with create_sprint (it needs a start and finish date), then retry with to_sprint set to its name", cur, bc.boardLabel())
		}
		return next, nil
	}
	for i := range bc.Sprints {
		if strings.EqualFold(bc.Sprints[i].Name, ref) {
			return &bc.Sprints[i], nil
		}
	}
	names := make([]string, 0, len(bc.Sprints))
	for _, s := range bc.Sprints {
		names = append(names, s.Name)
	}
	return nil, fmt.Errorf("sprint %q not found on board %s. Available sprints: %s", ref, bc.boardLabel(), strings.Join(names, ", "))
}

func (bc *mcpBoardContext) boardLabel() string {
	if bc.BoardName != "" {
		return fmt.Sprintf("%q (%s)", bc.BoardName, bc.BoardID)
	}
	return bc.BoardID
}

// resolveState maps a user-supplied state or column name to the exact
// YouTrack state, accepting workflow-config aliases (e.g. an alias that the
// config maps onto a real column). Errors list the real states.
func (bc *mcpBoardContext) resolveState(name string) (string, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	if actual, ok := bc.RealStates[key]; ok {
		return actual, nil
	}
	if bc.Workflow != nil {
		for _, col := range bc.Workflow.ColumnHierarchy {
			for _, alias := range col.Aliases {
				if strings.ToLower(alias) == key {
					if actual, ok := bc.RealStates[strings.ToLower(col.State)]; ok {
						return actual, nil
					}
				}
			}
		}
	}
	return "", fmt.Errorf("%q is not a state in this YouTrack project. Valid states: %s", name, strings.Join(bc.stateNames(), ", "))
}

func (bc *mcpBoardContext) stateNames() []string {
	out := make([]string, 0, len(bc.RealStates))
	for _, v := range bc.RealStates {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// mcpWorkflowRoles are the roles a column can have in the workflow config.
// "backlog" also matches columns whose role is left empty (e.g. To Do).
var mcpWorkflowRoles = []string{"backlog", "active", "blocked", "findings", "dev_done", "verified", "deployed", "closed"}

// statesForRole returns the real YouTrack states (and aliases) the user's
// workflow config gives a role. For "blocked" it also includes the report
// config's blocked_states.
func (bc *mcpBoardContext) statesForRole(role string) ([]string, error) {
	role = strings.ToLower(strings.TrimSpace(role))
	valid := false
	for _, r := range mcpWorkflowRoles {
		if r == role {
			valid = true
		}
	}
	if !valid {
		return nil, fmt.Errorf("unknown from_role %q. Use one of: %s", role, strings.Join(mcpWorkflowRoles, ", "))
	}
	if bc.Workflow == nil {
		return nil, fmt.Errorf("no workflow config found, so from_role can't be resolved. Use from_state instead")
	}
	seen := map[string]bool{}
	var out []string
	add := func(name string) {
		if actual, ok := bc.RealStates[strings.ToLower(name)]; ok && !seen[actual] {
			seen[actual] = true
			out = append(out, actual)
		}
	}
	for _, col := range bc.Workflow.ColumnHierarchy {
		r := strings.ToLower(col.Role)
		if r == role || (role == "backlog" && r == "") {
			add(col.State)
			for _, a := range col.Aliases {
				add(a)
			}
		}
	}
	if role == "blocked" {
		for _, s := range bc.Workflow.ReportConfig.BlockedStates {
			add(s)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("the workflow config has no column with role %q that matches a real YouTrack state", role)
	}
	return out, nil
}
