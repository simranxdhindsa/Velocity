package handlers

// mcpTools is the tool list returned for the MCP "tools/list" method.
// Each schema is defined alongside its handler in mcp_tool_<name>.go —
// add a new tool by creating that file and registering both here and in
// mcpToolHandlers (mcp_dispatch.go).
var mcpTools = []map[string]interface{}{
	getDeveloperConfigsToolSchema,
	getSprintsToolSchema,
	getDeveloperLoadToolSchema,
	getYoutrackTicketToolSchema,
	searchYoutrackTicketsToolSchema,
	createYoutrackTicketToolSchema,
	deleteYoutrackTicketToolSchema,
	editYoutrackTicketToolSchema,
	createAttachmentUploadURLToolSchema,
	uploadYoutrackAttachmentToolSchema,
	linkYoutrackTicketsToolSchema,
	bulkUpdateTicketsToolSchema,
	createSprintToolSchema,
	addYoutrackCommentToolSchema,
	editYoutrackCommentToolSchema,
	deleteYoutrackCommentToolSchema,
	queueSlackMessageToolSchema,
	sendSlackMessageNowToolSchema,
	deleteSlackMessageToolSchema,
	editSlackMessageToolSchema,
	getSlackReplyConfigToolSchema,
	updateSlackReplyConfigToolSchema,
	getDaytrackToolSchema,
	whoamiToolSchema,
	readSlackMessagesToolSchema,
	getSlackMentionsToolSchema,
}
