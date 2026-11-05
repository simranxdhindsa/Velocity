package handlers

// mcpServerInstructions is sent in the MCP initialize response, so every connected agent gets
// the work-log rule without it being repeated in each conversation. Clients are free to ignore
// this field, so add_daytrack_entries carries the same rule in its description.
const mcpServerInstructions = `Velocity work log rule.

After you finish a user's request that used tools and produced real work, report that work as a flat bullet list, one bullet per piece of work, project name first:

• Velocity: fixed the Chats AI buttons failing, caused by a removed Groq model
• Velocity: Chats now show each person's real name and Slack profile photo instead of a raw user ID

Write each bullet in plain words for someone reading it cold: what changed, not how. Merge two bullets about the same change. Use the real project name, which is not always Velocity.

Then add those bullets to Day Track with add_daytrack_entries, one entry per bullet, in a single call, leaving out the bullet character. Leave out category and times unless the user stated them, Velocity fills them in.

Only log finished research, development and testing work, and work that belongs to one of the user's custom Day Track categories. Do not log answers to questions, lookups, tickets you only read, or changes to Day Track itself. Never create a Day Track category unless the user explicitly asks for one.`
