// Pure parts: checks, coverage, follow-up lanes, decisions, live play tables, docs rules, CI settling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docsRuleGaps, parseBugTable } from '../lib/after.mjs';
import { commitProblems, needsMutation } from '../lib/build.mjs';
import { checkGaps, plan, readCounts, runChecks } from '../lib/checks.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { appendDecision, decidedIdsInBrief, missingDecisions } from '../lib/decisions.mjs';
import { addItem, planLanes } from '../lib/followups.mjs';
import { settle } from '../lib/github.mjs';
import { checkNote, noteLines } from '../lib/plan.mjs';
import { coverage, reviewPassed } from '../lib/review.mjs';
import { globToRegExp, matchesAny } from '../lib/util.mjs';
import { deployCheckProblems } from '../lib/ship.mjs';

const EM = '\u2014';
const config = (overrides = {}) => structuredClone({ ...DEFAULTS, ...overrides });

test('globs: ** crosses folders, * does not, and a bare name matches anywhere', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.js'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/x.ts'));
  assert.ok(!globToRegExp('src/*').test('src/a/b.js'));
  assert.ok(matchesAny('deep/folder/shot.webp', ['*.webp']));
  assert.ok(matchesAny('ci/fu20a', ['ci/*']));
  assert.ok(!matchesAny('main', ['ci/*']));
});

test('counts come from the last match of each pattern', () => {
  const text = 'ℹ tests 9\nℹ pass 7\nℹ fail 2\n# pass 8\n';
  assert.deepEqual(readCounts(text, DEFAULTS.checks.resultPatterns), { pass: 8, fail: 2 });
});

test('the plan runs the parallel phase, then integration, then each e2e file, with the always files added', () => {
  const steps = plan(config({ checks: { ...DEFAULTS.checks, parallel: [{ name: 'typecheck', run: 'tc' }, { name: 'unit', run: 'u' }], integration: [{ name: 'int', run: 'i' }], e2e: { ...DEFAULTS.checks.e2e, command: 'run {file}', files: ['a', 'b', 'reach'], always: ['reach'] } } }), ['a']);
  assert.deepEqual(steps.map((step) => `${step.phase}:${step.name}`), ['parallel:typecheck', 'parallel:unit', 'integration:int', 'e2e:e2e:a', 'e2e:e2e:reach']);
  assert.equal(steps.at(-1).command, 'run reach');
});

test('check gaps name what has not run, what failed, and a phase that ran before an earlier one finished', () => {
  const steps = [{ phase: 'parallel', name: 'unit' }, { phase: 'integration', name: 'int' }, { phase: 'e2e', name: 'e2e:a' }];
  assert.deepEqual(checkGaps(steps, []), ['unit has not run on this tip', 'int has not run on this tip', 'e2e:a has not run on this tip']);
  const results = [
    { name: 'unit', phase: 'parallel', exit: 0, counts: { fail: 0 }, at: '2026-01-01T00:00:05Z', log: 'u.log' },
    { name: 'int', phase: 'integration', exit: 0, counts: {}, at: '2026-01-01T00:00:01Z', log: 'i.log' },
    { name: 'e2e:a', phase: 'e2e', exit: 0, counts: { fail: 1 }, at: '2026-01-01T00:00:09Z', log: 'a.log' },
  ];
  const gaps = checkGaps(steps, results);
  assert.ok(gaps.some((gap) => /e2e:a failed \(exit 0, 1 failed\)/.test(gap)));
  assert.ok(gaps.some((gap) => /int ran before an earlier phase finished/.test(gap)));
  assert.deepEqual(checkGaps(steps.slice(0, 1), results), []);
});

test('runChecks runs the parallel phase side by side, logs each check, and stops after a failed phase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-checks-'));
  const marker = join(dir, 'order.txt');
  const cfg = config({ checks: { ...DEFAULTS.checks, keepAwake: false } });
  const steps = [
    { phase: 'parallel', name: 'slow', command: `sleep 0.3; echo slow >> ${marker}; echo "# pass 2"` },
    { phase: 'parallel', name: 'fast', command: `echo fast >> ${marker}; echo "# pass 1"; exit 1` },
    { phase: 'integration', name: 'int', command: `echo int >> ${marker}` },
  ];
  const results = await runChecks(steps, { cwd: dir, env: {}, dir, config: cfg });
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['fast', 'slow']);
  assert.deepEqual(results.map((result) => [result.name, result.exit, result.counts.pass]), [['slow', 0, 2], ['fast', 1, 1]]);
  assert.match(readFileSync(results[0].log, 'utf8'), /pass 2/);
});

test('review coverage: consensus, skip, started and none, by patch-id, and empty commits pass', () => {
  const entries = [
    { topic: 'done-one', status: 'consensus', rounds: [{ commits: [{ patchId: 'p1' }, { patchId: 'p2' }] }], consensus: { commits: [{ patchId: 'p1' }] } },
    { topic: 'skip-x', status: 'skipped', rounds: [], consensus: { commits: [{ patchId: 'p3' }] } },
  ];
  const covered = coverage([{ id: '1', patchId: 'p1' }, { id: '2', patchId: 'p2' }, { id: '3', patchId: 'p3' }, { id: '4', patchId: 'p4' }, { id: '5', patchId: null }], entries);
  assert.deepEqual(covered.map((commit) => commit.review), ['consensus', 'started', 'skipped', 'none', 'empty']);
  assert.deepEqual(covered.map(reviewPassed), [true, false, true, false, true]);
});

test('follow-up lanes never share a file, and items sharing a file land in one lane', () => {
  const items = [
    { id: 'A', files: ['x.ts'] }, { id: 'B', files: ['y.ts'] }, { id: 'C', files: ['x.ts', 'z.ts'] }, { id: 'D', files: ['z.ts'] }, { id: 'E', files: ['w.ts'] },
  ];
  const lanes = planLanes(items, 2);
  const laneOf = (id) => lanes.find((lane) => lane.items.some((item) => item.id === id)).lane;
  assert.equal(laneOf('A'), laneOf('C'));
  assert.equal(laneOf('C'), laneOf('D'));
  const files = lanes.flatMap((lane) => lane.files);
  assert.equal(new Set(files).size, files.length);
  assert.equal(lanes.length, 2);
});

test('a blocking finding goes to the backlog only with a logged decision', () => {
  const backlog = { identity: 'x', items: [] };
  const cfg = config();
  assert.throws(() => addItem(backlog, { id: 'R-1', severity: 'P2', text: 't' }, cfg, () => true), /blocks review/);
  assert.throws(() => addItem(backlog, { id: 'R-1', severity: 'P2', text: 't', decision: 'D-1' }, cfg, () => false), /not in the decision log/);
  addItem(backlog, { id: 'R-1', severity: 'P2', text: 't', decision: 'D-1' }, cfg, () => true);
  addItem(backlog, { id: 'R-2', severity: 'P3', text: 't' }, cfg, () => false);
  assert.throws(() => addItem(backlog, { id: 'R-2', severity: 'P3', text: 't' }, cfg, () => false), /already in the backlog/);
  assert.equal(backlog.items.length, 2);
});

test('a brief names decisions on lines that say decided, and on a Decisions line', () => {
  const brief = ['1. **LP12-AT-2:** the search treats towed creatures as the walker.', '8. **AT-HIDDENPATH, decided:** a player sees their own path.', '2. **FU20A-OP-7 / CONFER-1, decided.** Only a walk off the holder.', 'Decisions: RS-O-37, UTF-8', 'Every item is decided.'].join('\n');
  assert.deepEqual(decidedIdsInBrief(brief, DEFAULTS), ['AT-HIDDENPATH', 'FU20A-OP-7', 'CONFER-1', 'RS-O-37']);
});

test('a decision is logged with what was chosen, why and what was rejected, and its ID is then found', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pipeline-decisions-')), 'decisions.md');
  const cfg = config({ decisions: { ...DEFAULTS.decisions, file } });
  assert.throws(() => appendDecision({ id: 'RS-O-1', chose: 'a', why: 'b' }, cfg), /--rejected is required/);
  assert.throws(() => appendDecision({ id: 'RS-O-1', chose: `a ${EM} b`, why: 'b', rejected: 'c' }, cfg), /em dash/);
  assert.throws(() => appendDecision({ id: 'lowercase', chose: 'a', why: 'b', rejected: 'c' }, cfg), /does not match/);
  appendDecision({ id: 'RS-O-1', title: 'the toggle', chose: 'per device', why: 'the user said so', rejected: 'per account', run: 'dark' }, cfg);
  assert.match(readFileSync(file, 'utf8'), /## \d{4}-\d\d-\d\d: RS-O-1, the toggle \(run dark\)\n- Chosen: per device\n- Why: the user said so\n- Rejected: per account/);
  assert.throws(() => appendDecision({ id: 'RS-O-1', chose: 'a', why: 'b', rejected: 'c' }, cfg), /already in/);
  assert.deepEqual(missingDecisions(['RS-O-1', 'RS-O-2'], cfg), ['RS-O-2']);
});

test('a design note: the appendix does not count, and a UI change needs a UI and UX section', () => {
  const body = ['# Note', '## 1. Rules', ...Array(30).fill('text'), '## Tests', '## Build plan'].join('\n');
  const long = `${body}\n## Appendix A. Sizes\n${Array(900).fill('n').join('\n')}`;
  assert.equal(noteLines(long), 34);
  const cfg = config();
  assert.deepEqual(checkNote(long, { ui: false, config: cfg }).problems, []);
  assert.match(checkNote(long, { ui: true, config: cfg }).problems[0], /no UI and UX section/);
  assert.deepEqual(checkNote(`${body}\n## 3. UI/UX\n`, { ui: true, config: cfg }).problems, []);
  const tooLong = ['## Tests', '## Build plan', ...Array(600).fill('x')].join('\n');
  assert.match(checkNote(tooLong, { ui: false, config: cfg }).problems[0], /over design.maxLines/);
  assert.deepEqual(checkNote(tooLong, { ui: false, config: cfg, allowLong: 'split later' }).problems, []);
  assert.match(checkNote('## Tests\n', { ui: false, config: cfg }).problems[0], /no "Build plan" section/);
});

test('commit rules: conventional, lowercase, one line, no em dash, no trailer, signed, owned files, docs apart from code', () => {
  const cfg = config({ docs: { ...DEFAULTS.docs, featureList: 'FEATURES.md', behaviorPaths: ['src/**'] } });
  const lane = { owns: ['src/**', 'FEATURES.md'] };
  const check = (fields, outside = {}) => commitProblems({ description: 'fix(ui): a thing', signature: 'good', files: [{ source: 'src/a.js', path: 'src/a.js' }], ...fields }, { config: cfg, lane, kind: 'feature', outside });
  assert.deepEqual(check({}), []);
  assert.match(check({ description: 'Fix the thing' })[0], /not a conventional commit/);
  assert.match(check({ description: 'fix(ui): Fix the thing' })[0], /capital letter/);
  assert.match(check({ description: 'fix(ui): a\n\nbody' })[0], /has a body/);
  assert.match(check({ description: `fix(ui): a ${EM} b` })[0], /em dash/);
  assert.match(check({ description: 'fix(ui): a\nCo-authored-by: x' }).join(' '), /forbidden trailer/);
  assert.match(check({ signature: 'none' })[0], /not signed/);
  assert.match(check({ files: [{ source: 'lib/b.js', path: 'lib/b.js' }] })[0], /outside the lane's ownership: lib\/b.js/);
  assert.deepEqual(check({ files: [{ source: 'lib/b.js', path: 'lib/b.js' }] }, { 'lib/b.js': 'shared helper' }), []);
  assert.match(check({ files: [{ source: 'src/a.js', path: 'src/a.js' }, { source: 'FEATURES.md', path: 'FEATURES.md' }] })[0], /mixes feature list/);
});

test('a commit needs a mutation check when it changes code and a test together', () => {
  const cfg = config();
  assert.equal(needsMutation({ files: ['src/a.js', 'src/a.test.js'] }, cfg), true);
  assert.equal(needsMutation({ files: ['src/a.test.js'] }, cfg), false);
  assert.equal(needsMutation({ files: ['src/a.js', 'README.md'] }, cfg), false);
  assert.equal(needsMutation({ files: ['e2e/flow.e2e.ts', 'src/a.js'] }, cfg), true);
});

test('docs rules: a feat that changes behavior updates the feature list, and shortcut changes update the sheet', () => {
  const cfg = config({ docs: { ...DEFAULTS.docs, featureList: 'FEATURES.md', behaviorPaths: ['src/**'], shortcutSources: ['src/keys.ts'], shortcutDocs: ['FEATURES.md', 'docs/keys.md'] } });
  const commit = (description, paths) => ({ id: 'c'.repeat(40), description, files: paths.map((path) => ({ source: path, path })) });
  assert.match(docsRuleGaps([commit('feat(ui): toggle', ['src/a.ts'])], cfg)[0], /FEATURES.md is not updated/);
  assert.deepEqual(docsRuleGaps([commit('feat(ui): toggle', ['src/a.ts']), commit('docs: toggle', ['FEATURES.md'])], cfg), []);
  assert.deepEqual(docsRuleGaps([commit('fix(ui): toggle', ['src/a.ts'])], cfg), []);
  assert.match(docsRuleGaps([commit('fix(ui): key', ['src/keys.ts']), commit('docs: keys', ['FEATURES.md'])], cfg)[0], /docs\/keys.md/);
});

test('a live play report table gives each bug its status, commit and recommendation', () => {
  const text = ['| ID | Sev | Area | Bug | Status |', '|---|---|---|---|---|', '| LP14-RS-1 | P1 | resync | crash | fixed oqnkkukr |', '| **LP14-RS-2** | P2 | resync | slow | needs owner: cap it at 10 s |', '| LP13-X-1 | P3 | old | x | fixed abcdefgh |'].join('\n');
  const rows = parseBugTable(text, DEFAULTS, 'LP14');
  assert.deepEqual(rows.map((row) => [row.id, row.status, row.commit, row.recommend]), [['LP14-RS-1', 'fixed', 'oqnkkukr', null], ['LP14-RS-2', 'needs-owner', null, 'cap it at 10 s']]);
});

test('CI settles only when the run and every job have completed', () => {
  const ok = ['success', 'skipped'];
  assert.deepEqual(settle({ status: 'completed', conclusion: 'success', jobs: [{ name: 'e2e', status: 'in_progress', conclusion: '' }] }, ok).settled, false);
  const done = settle({ status: 'completed', conclusion: 'success', jobs: [{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'completed', conclusion: 'skipped' }] }, ok);
  assert.deepEqual([done.settled, done.ok], [true, true]);
  const failed = settle({ status: 'completed', conclusion: 'failure', jobs: [{ name: 'e2e (3)', status: 'completed', conclusion: 'failure' }] }, ok);
  assert.deepEqual([failed.ok, failed.failedJobs], [false, ['e2e (3)']]);
});

test('deploy checks: backup, health, a full load check and HTTP answers', () => {
  const cfg = config();
  assert.deepEqual(deployCheckProblems({ backup: 'db.dump', health: 'healthy', load: '12/12', http: '200 200 301' }, cfg), []);
  const problems = deployCheckProblems({ backup: '', health: 'starting', load: '11/12', http: '200 502' }, cfg);
  assert.equal(problems.length, 4);
  assert.match(deployCheckProblems({ backup: 'b', health: 'ok', load: 'all', http: '200' }, cfg)[0], /loaded\/total/);
});

test('the decision log file is plain markdown the user can read', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pipeline-decisions-')), 'log.md');
  writeFileSync(file, '- 2026-10-22 (coordinator, LP12-AT-3): a press in the middle starts on the holder.\n');
  assert.deepEqual(missingDecisions(['LP12-AT-3'], config({ decisions: { ...DEFAULTS.decisions, file } })), []);
});

test('a decision is logged only by an entry that starts with its ID, never by a mention in the text', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pipeline-decisions-')), 'log.md');
  writeFileSync(file, [
    '## 2026-10-22: RS-O-1, keeps RS-O-9 in mind (run dark)',
    '- Chosen: per device, as in RS-O-2.',
    '- Rejected: the AT-O-3 rule.',
    '- FU20B-OP-5: a close from a panel skips the focus.',
    '- FU20B-OP-11 adopted into the fixes, after LP16-PT-1.',
    '- **AT-HIDDENPATH / AT-O-35, decided:** a player sees their own path.',
    '- Item 2 (LP13-TR-6): the alerts column folds.',
    '1. LP12-AT-7 = LP12-AT-8: one rule.',
    'A plain line that names RS-O-4.',
  ].join('\n'));
  const cfg = config({ decisions: { ...DEFAULTS.decisions, file } });
  const ids = ['RS-O-1', 'RS-O-9', 'FU20B-OP-5', 'FU20B-OP-11', 'AT-HIDDENPATH', 'AT-O-35', 'LP13-TR-6', 'LP12-AT-7', 'LP12-AT-8', 'RS-O-2', 'AT-O-3', 'LP16-PT-1', 'RS-O-4'];
  assert.deepEqual(missingDecisions(ids, cfg), ['RS-O-2', 'AT-O-3', 'LP16-PT-1', 'RS-O-4']);
  appendDecision({ id: 'RS-O-2', chose: 'a', why: 'b', rejected: 'c' }, cfg);
  assert.deepEqual(missingDecisions(['RS-O-2'], cfg), []);
});
