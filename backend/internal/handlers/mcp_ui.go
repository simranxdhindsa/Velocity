package handlers

import (
	"embed"
	"encoding/json"
)

// uiResourcesFS embeds the MCP Apps widget HTML served via resources/read.
// See docs/features/mcp-apps.md for the wire protocol this implements.
//
//go:embed mcpui/*.html
var uiResourcesFS embed.FS

const mcpUIMimeType = "text/html;profile=mcp-app"

type mcpUIResource struct {
	URI  string
	Name string
	File string
}

var mcpUIResources = []mcpUIResource{
	{URI: "ui://velocity/create-ticket", Name: "create_ticket_card", File: "mcpui/create_ticket.html"},
	{URI: "ui://velocity/developer-load", Name: "developer_load_chart", File: "mcpui/developer_load.html"},
}

func findMCPUIResource(uri string) *mcpUIResource {
	for i := range mcpUIResources {
		if mcpUIResources[i].URI == uri {
			return &mcpUIResources[i]
		}
	}
	return nil
}

// handleResourcesList implements the "resources/list" JSON-RPC method.
func handleResourcesList(id interface{}) rpcResponse {
	resources := make([]map[string]interface{}, 0, len(mcpUIResources))
	for _, res := range mcpUIResources {
		resources = append(resources, map[string]interface{}{
			"uri":      res.URI,
			"name":     res.Name,
			"mimeType": mcpUIMimeType,
		})
	}
	return rpcOK(id, map[string]interface{}{"resources": resources})
}

// handleResourcesRead implements the "resources/read" JSON-RPC method,
// serving the embedded widget HTML for a given ui:// URI.
func handleResourcesRead(id interface{}, raw json.RawMessage) rpcResponse {
	var p struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.URI == "" {
		return rpcErr(id, -32602, "invalid params: uri is required")
	}
	res := findMCPUIResource(p.URI)
	if res == nil {
		return rpcErr(id, -32602, "unknown resource: "+p.URI)
	}
	content, err := uiResourcesFS.ReadFile(res.File)
	if err != nil {
		return rpcErr(id, -32603, "failed to load resource: "+err.Error())
	}
	return rpcOK(id, map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"uri":      res.URI,
				"mimeType": mcpUIMimeType,
				"text":     string(content),
			},
		},
	})
}

// toolOKWithUI is like toolOK but also attaches structuredContent, which the
// host forwards to the tool's associated ui:// widget (if any) as a
// ui/notifications/tool-result message.
func toolOKWithUI(id interface{}, text string, structuredContent interface{}) rpcResponse {
	return rpcOK(id, map[string]interface{}{
		"content":           []map[string]string{{"type": "text", "text": text}},
		"isError":           false,
		"structuredContent": structuredContent,
	})
}
