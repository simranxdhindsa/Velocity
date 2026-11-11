package handlers

// mcpServerInstructions is sent in the MCP initialize response, so every connected agent gets
// the work-log rule without it being repeated in each conversation. Clients are free to ignore
// this field, so add_daytrack_entries carries the same rule in its description and enforces it:
// no user_requested is refused, and without confirmed it only returns a preview. Day Track is
// written only after the user asked and then confirmed the preview.
const mcpServerInstructions = `Velocity work log rule.

After you finish a user's request that used tools and produced real work, report that work as a flat bullet list, one bullet per piece of work, project name first:

• Velocity: fixed the Chats AI buttons failing, caused by a removed Groq model
• Velocity: Chats now show each person's real name and Slack profile photo instead of a raw user ID

Write each bullet in plain words for someone reading it cold: what changed, not how. Merge two bullets about the same change. Use the real project name, which is not always Velocity.

Never add anything to Day Track on your own. Finishing a task is not a request to log it.

Day Track entries are added only in two steps:
1. The user explicitly asks in this conversation to add or log work to Day Track. Then call add_daytrack_entries with user_requested: true and without confirmed. Nothing is saved: you get back a preview of the entries.
2. Show the user that preview and ask them to confirm. Only after they reply yes, call add_daytrack_entries again with the same entries, user_requested: true and confirmed: true. If they say no or don't answer, add nothing.

Never set confirmed: true in the same turn as the preview, and never set either flag unless the user actually said it. Use one entry per bullet, leaving out the bullet character. Leave out category and times unless the user stated them, Velocity fills them in.

Never create a Day Track category unless the user explicitly asks for one.`
