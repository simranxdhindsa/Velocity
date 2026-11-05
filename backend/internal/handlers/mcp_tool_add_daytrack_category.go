package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

var addDaytrackCategoryToolSchema = map[string]interface{}{
	"name": "add_daytrack_category",
	"description": "Creates a custom Day Track category for the caller. Call this ONLY when the user explicitly asks to create a category. " +
		"Never create one on your own to fit a task: leave the category out of add_daytrack_entries and Velocity picks from the existing list. " +
		"`icon` must be one emoji from the allowed list, and an invalid icon returns that list, so pick a neutral one that suits the name.",
	"inputSchema": map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"name": map[string]interface{}{"type": "string", "description": "Category name, at most 40 characters."},
			"icon": map[string]interface{}{"type": "string", "description": "One emoji from the allowed list, e.g. 📌."},
		},
		"required": []string{"name", "icon"},
	},
}

func mcpAddDaytrackCategory(ctx context.Context, h *MCPHandler, userID string, id interface{}, args json.RawMessage) rpcResponse {
	var a struct {
		Name string `json:"name"`
		Icon string `json:"icon"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return toolError(id, mcpDTArgsError(err))
	}
	name := mcpDayTrackOneLine(a.Name)
	icon := strings.TrimSpace(a.Icon)
	if name == "" {
		return toolError(id, "name is required")
	}
	if n := len([]rune(name)); n > mcpDayTrackMaxCategoryName {
		return toolError(id, fmt.Sprintf("name is %d characters, the limit is %d", n, mcpDayTrackMaxCategoryName))
	}
	if !isAllowedCategoryEmoji(icon) {
		icons := make([]string, 0, len(allowedCustomCategoryEmoji))
		for e := range allowedCustomCategoryEmoji {
			icons = append(icons, e)
		}
		sort.Strings(icons)
		return toolError(id, fmt.Sprintf("%q isn't an allowed icon. Use one of: %s", icon, strings.Join(icons, " ")))
	}
	cats, err := mcpDayTrackCategories(ctx, userID)
	if err != nil {
		return toolError(id, "failed to read your categories: "+err.Error())
	}
	if existing, ok := mcpMatchDayTrackCategory(name, cats); ok {
		return toolError(id, fmt.Sprintf("%q already exists, so there is nothing to add", existing))
	}
	if err := mcpDayTrackRepo.AddCategory(ctx, userID, name, icon); err != nil {
		return toolError(id, "failed to add the category: "+err.Error())
	}
	return mcpDTResult(id, fmt.Sprintf("Added the Day Track category %s %s.", icon, name),
		map[string]interface{}{"name": name, "icon": icon, "categories": append(cats, name)})
}
