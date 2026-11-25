// The Subtasks workflow marks a parent Fixed once all its subtasks are
// resolved. A catch-all epic is a fixed board row, not work, so it goes
// straight back to Backlog and its row never disappears.
const entities = require('@jetbrains/youtrack-scripting-api/entities');
const catchAll = require('./catch-all-epics');

exports.rule = entities.Issue.onChange({
  title: 'Catch-all epics stay open',
  guard: (ctx) => ctx.issue.isReported && ctx.issue.becomesResolved && catchAll.isCatchAll(ctx.issue),
  action: (ctx) => {
    ctx.issue.fields.State = ctx.State.Backlog;
  },
  requirements: {
    State: { type: entities.State.fieldType, Backlog: {} },
    Type: { type: entities.EnumField.fieldType },
  },
});
