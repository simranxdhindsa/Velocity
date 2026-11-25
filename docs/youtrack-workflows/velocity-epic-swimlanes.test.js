// Local check of the velocity-epic-swimlanes rules against a fake YouTrack
// scripting API. Run: node docs/youtrack-workflows/velocity-epic-swimlanes.test.js
const assert = require('assert');
const Module = require('module');
const path = require('path');

let epics = [];
const fake = {
  '@jetbrains/youtrack-scripting-api/entities': {
    Issue: { onChange: (r) => r },
    EnumField: { fieldType: 'enum' },
    State: { fieldType: 'state' },
  },
  '@jetbrains/youtrack-scripting-api/search': { search: (_p, q) => fakeSet(epics.filter((e) => q.includes('summary: ' + e.summary))) },
  '@jetbrains/youtrack-scripting-api/workflow': { message: (m) => messages.push(m) },
};
const load = Module._load;
Module._load = function (req, ...rest) { return fake[req] || load.call(this, req, ...rest); };

let messages = [];
function fakeSet(items) {
  const a = [...items];
  return { forEach: (f) => a.forEach(f), add: (x) => a.push(x), delete: (x) => a.splice(a.indexOf(x), 1), isEmpty: () => !a.length, items: a };
}
const issue = ({ type, summary = 'x', parent = null, created = true, typeChanged = false, resolved = false }) => ({
  summary, isReported: true, becomesReported: created, becomesResolved: resolved,
  fields: { Type: type ? { name: type } : null, State: { name: 'To Do' }, isChanged: () => typeChanged },
  links: { 'subtask of': fakeSet(parent ? [parent] : []) },
});
const epic = (summary) => issue({ type: 'Epic', summary, created: false });
const dir = path.join(__dirname, 'velocity-epic-swimlanes');
const link = require(path.join(dir, 'every-ticket-has-an-epic.js')).rule;
const stay = require(path.join(dir, 'catch-all-epics-stay-open.js')).rule;
const ctx = (i) => ({ issue: i, Type: 'Type', State: { Backlog: { name: 'Backlog' } } });
const run = (rule, i) => { const c = ctx(i); if (rule.guard(c)) rule.action(c); return i; };
const parents = (i) => i.links['subtask of'].items.map((p) => p.summary);

const [bugs, regs, hot, enh, composer] = ['Bugs', 'Regressions', 'Hotfixes', 'Enhancements', 'Composer'].map(epic);
epics = [bugs, regs, hot, enh, composer];

assert.deepStrictEqual(parents(run(link, issue({ type: 'Bug' }))), ['Bugs'], 'new bug goes under Bugs');
assert.deepStrictEqual(parents(run(link, issue({ type: 'Hotfix' }))), ['Hotfixes']);
assert.deepStrictEqual(parents(run(link, issue({ type: 'Regression' }))), ['Regressions']);
assert.deepStrictEqual(parents(run(link, issue({ type: 'Feature' }))), ['Enhancements'], 'feature with no epic goes under Enhancements');
assert.deepStrictEqual(parents(run(link, issue({ type: 'Task' }))), ['Enhancements']);
assert.deepStrictEqual(parents(run(link, issue({ type: 'Bug', parent: composer }))), ['Composer'], 'keeps its feature epic');
assert.deepStrictEqual(parents(run(link, issue({ type: 'Regression', parent: bugs, created: false, typeChanged: true }))), ['Regressions'], 'type change moves catch-all');
assert.deepStrictEqual(parents(run(link, issue({ type: 'Bug', created: false }))), [], 'old ticket untouched when nothing relevant changed');
assert.deepStrictEqual(parents(run(link, issue({ type: 'Epic' }))), [], 'epics never get a parent');
assert.deepStrictEqual(parents(run(link, issue({ type: null }))), [], 'no type, no change');
epics = [composer];
messages = [];
assert.deepStrictEqual(parents(run(link, issue({ type: 'Bug' }))), [], 'missing Bugs epic links nothing');
assert.ok(messages[0].includes('Bugs epic is missing'), 'and says so');

const closing = Object.assign(epic('Bugs'), { becomesResolved: true });
assert.strictEqual(run(stay, closing).fields.State.name, 'Backlog', 'catch-all epic goes back to Backlog');
const featureDone = Object.assign(epic('Composer'), { becomesResolved: true });
featureDone.fields.State = { name: 'Fixed' };
assert.strictEqual(run(stay, featureDone).fields.State.name, 'Fixed', 'feature epics may still close');
const bugDone = Object.assign(issue({ type: 'Bug', summary: 'Bugs', created: false }), { becomesResolved: true });
bugDone.fields.State = { name: 'Fixed' };
assert.strictEqual(run(stay, bugDone).fields.State.name, 'Fixed', 'a ticket merely titled Bugs is not a catch-all epic');
console.log('all workflow checks passed');
