// Links a ticket with no epic to its type's catch-all epic, so it never shows
// as Uncategorized. Runs when a ticket is created or its Type changes only, so
// older tickets are left as they are. A ticket under a feature epic keeps it.
const entities = require('@jetbrains/youtrack-scripting-api/entities');
const search = require('@jetbrains/youtrack-scripting-api/search');
const workflow = require('@jetbrains/youtrack-scripting-api/workflow');
const catchAll = require('./catch-all-epics');

function epicParent(issue) {
  let found = null;
  issue.links['subtask of'].forEach((p) => {
    if (!found && p.fields.Type && p.fields.Type.name === 'Epic') found = p;
  });
  return found;
}

exports.rule = entities.Issue.onChange({
  title: 'Every ticket goes under an epic',
  guard: (ctx) => {
    const issue = ctx.issue;
    const type = issue.fields.Type && issue.fields.Type.name;
    if (!issue.isReported || !type || type === 'Epic') return false;
    return issue.becomesReported || issue.fields.isChanged(ctx.Type);
  },
  action: (ctx) => {
    const issue = ctx.issue;
    const name = catchAll.BUCKETS[issue.fields.Type.name];
    const parent = epicParent(issue);
    if (!name || (parent && !catchAll.isCatchAll(parent)) || (parent && parent.summary === name)) return;
    let epic = null;
    search.search(issue.project, 'Type: {Epic} Subsystem: {Epic} summary: ' + name, ctx.currentUser).forEach((e) => {
      if (!epic && e.summary === name) epic = e;
    });
    if (!epic) {
      workflow.message('The ' + name + ' epic is missing, so this ticket has no swimlane. Ask Velocity to create a sprint, or create an epic named ' + name + '.');
      return;
    }
    if (parent) issue.links['subtask of'].delete(parent); // one parent per ticket
    issue.links['subtask of'].add(epic);
  },
  requirements: {
    Type: { type: entities.EnumField.fieldType },
  },
});
