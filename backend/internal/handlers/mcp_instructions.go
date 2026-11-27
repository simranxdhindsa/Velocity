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
1. The user explicitly asks in this conversation to add or log work to Day Track. First draft every entry as "<Project>: <what changed>", project name first, for example "Velocity: new feature added to the MCP". Then call add_daytrack_entries with those drafts, user_requested: true and without confirmed. Nothing is saved: you get back a preview of the entries.
2. Show the user that preview and ask them to add it as is or edit it. If they edit, call again without confirmed and show the new preview. Only after they reply yes, call add_daytrack_entries again with the same entries, user_requested: true and confirmed: true. If they say no or don't answer, add nothing.

Never set confirmed: true in the same turn as the preview, and never set either flag unless the user actually said it. Use one entry per bullet, leaving out the bullet character. Leave out category and times unless the user stated them, Velocity fills them in.

Never create a Day Track category unless the user explicitly asks for one.

YouTrack feature epics.

A feature epic is a ticket with Type Epic and Subsystem Epic. It is a feature heading, not work, and its tickets link to it as "subtask of". Open feature epics sit in the current and upcoming sprints only so the board shows one row per epic. When you count, list or report a sprint's tickets, leave feature epics out, and never move one out of a sprint or close it as cleanup. Older tickets with Type Epic and another subsystem are deployment checklists and count as normal work. Every ticket belongs to an epic, so none is left in Uncategorized: the feature epic it is part of, or else its type's epic (Bugs, Regressions, Hotfixes, or Enhancements for enhancements, features and tasks). Bugs, Regressions, Hotfixes and Enhancements are the default swimlanes of every sprint: create_sprint always adds them and recreates any that is missing, and they are never closed, renamed or deleted. Before creating a ticket, call list_youtrack_epics and suggest the matching epic.

Creating a sprint.

When the user asks for a new sprint, never create it straight away:
1. Call create_sprint with plan: true. It changes nothing.
2. Ask the user three questions, all at once in your question pop-up if you have one (otherwise as a short numbered list in chat), each with a custom answer allowed:
   a. Name: offer suggested_name first (recommended).
   b. Dates: offer suggested_dates.two_weeks first (Monday of week 1 to Friday of week 2, recommended), then suggested_dates.one_week. A custom answer is converted to YYYY-MM-DD.
   c. Which columns of last_sprint to move into the new sprint (multi-select): offer up to three columns with suggested_to_move true (to do, in progress and blocked), each with its ticket count, plus "Don't move anything". Name the other columns and their counts in the question text, so a custom answer can pick any of them.
   Don't ask about swimlanes: Bugs, Regressions, Hotfixes and Enhancements are always added, so just say so.
3. Show one summary: name, dates, the four default swimlanes, and the tickets that will move, listed by column. Ask the user to confirm it.
4. Only after they confirm: call create_sprint with the name and dates. Then, if any columns were picked, call bulk_update_tickets (in batches of at most 100 ticket_ids) with sprint_name set to last_sprint's name, to_sprint set to the new sprint's name, ticket_ids set to the IDs listed for the picked columns, and dry_run: false. The confirmed summary is that call's preview.
5. Report the sprint, its swimlanes (epics_added), how many tickets moved and any that failed.`
