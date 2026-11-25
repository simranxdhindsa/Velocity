// The four catch-all epics, the board's default swimlanes. Keep in sync with
// bucketEpicNames / bucketEpicOrder in backend/internal/handlers/mcp_epics.go.
// Features and tasks with no feature epic go under Enhancements.
exports.BUCKETS = { Bug: 'Bugs', Regression: 'Regressions', Hotfix: 'Hotfixes', Enhancement: 'Enhancements', Feature: 'Enhancements', Task: 'Enhancements' };
exports.NAMES = ['Bugs', 'Regressions', 'Hotfixes', 'Enhancements'];

exports.isCatchAll = (issue) =>
  !!issue && !!issue.fields.Type && issue.fields.Type.name === 'Epic' && exports.NAMES.indexOf(issue.summary) >= 0;
