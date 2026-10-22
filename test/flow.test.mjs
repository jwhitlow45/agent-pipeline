// The whole flow in a sandbox repository: each gate's allow and refuse cases, with gh stubbed.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, SLUG, WORDS } from './helpers.mjs';

const TEST_FILE = "import { test } from 'node:test'; import assert from 'node:assert'; import { dark } from './theme.mjs'; test('dark', () => assert.equal(dark(), true));\n";

const baseConfig = {
  push: { public: false },
  review: { provider: 'builtin' },
  ci: { workflow: 'CI' },
  deploy: { command: './deploy.sh {name} {tip}', match: 'deploy\\.sh', tipArg: 2, runBy: 'agent' },
  notify: { command: ['sh', '-c', 'echo "$1" >> "$NOTES"', 'sh', '{message}'] },
  docs: { featureList: 'FEATURES.md', behaviorPaths: ['src/**'] },
};

// A fast run built to the point of a pushed, scanned tip, shared by the tests that start there.
function builtRun(box, { run = 'dark', lane = 'a' } = {}) {
  box.cli(['intake', '--run', run, '--kind', 'fast', '--words', WORDS]);
  box.write(`../${run}-spec.md`, `The user's words: ${WORDS}\n`);
  box.cli(['spec', '--run', run, '--file', `../${run}-spec.md`]);
  const ws = join(box.root, `demo-${run}`);
  box.sh(`jj workspace add --name demo-${run} ../demo-${run} -r main`);
  assert.equal(box.cli(['lane', '--run', run, '--lane', lane, '--workspace', ws, '--owns', 'src/**,FEATURES.md']).code, 0);
  box.commit('feat(ui): dark mode toggle', { 'src/theme.mjs': 'export const dark = () => true;\n', 'src/theme.test.mjs': TEST_FILE }, ws);
  box.commit('docs: dark mode in the feature list', { 'FEATURES.md': '- Dark mode\n' }, ws);
  assert.equal(box.cli(['commits', '--run', run, '--lane', lane], { cwd: ws }).code, 0);
  assert.equal(box.cli(['check', '--run', run, '--lane', lane], { cwd: ws }).code, 0);
  const fix = box.sh('jj log --no-graph -r @-- -T commit_id', ws).trim();
  assert.equal(box.cli(['mutation', '--run', run, '--lane', lane, '--commit', fix, '--test', 'src/theme.test.mjs'], { cwd: ws }).code, 0);
  box.write(`../${run}-report.md`, '# Report\n');
  box.cli(['report', '--run', run, '--lane', lane, '--file', `../${run}-report.md`]);
  box.cli(['signoff', '--run', run, '--stage', 'build', '--item', 'scope', '--by', 'owner', '--note', 'one commit per item']);
  assert.equal(box.cli(['build', '--run', run]).code, 0);
  return { ws, tip: box.run(run).tip };
}

const ciScript = (tip, { jobs = [{ name: 'e2e (1)', status: 'completed', conclusion: 'success' }], conclusion = 'success' } = {}) => [
  { match: 'run list', stdout: [{ databaseId: 77, status: 'completed', conclusion, workflowName: 'CI', headSha: tip, url: `https://github.com/${SLUG}/actions/runs/77`, createdAt: '2026-01-01T00:00:00Z' }] },
  { match: 'run view 77', stdout: { databaseId: 77, status: 'completed', conclusion, url: `https://github.com/${SLUG}/actions/runs/77`, headSha: tip, jobs } },
];

describe('intake, briefs and design', () => {
  const box = sandbox({ config: { ...baseConfig, brief: { preamble: 'agent-preamble.md' }, design: { requiredSections: ['Tests'] }, review: { provider: 'agent-review' } } });
  after(() => box.cleanup());

  test('intake records the words, and a brief must quote them verbatim and point at the preamble', () => {
    assert.equal(box.cli(['intake', '--run', 'feat', '--words', WORDS, '--ui']).code, 0);
    assert.equal(box.cli(['intake', '--run', 'feat', '--words', WORDS]).code, 64);
    box.write('../brief-bad.md', 'Build the dark mode toggle.\n');
    const bad = box.cli(['brief', '--run', 'feat', '--file', '../brief-bad.md']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /does not quote the user's words verbatim/);
    assert.match(bad.out, /does not point at the shared preamble/);
    box.write('../brief-ok.md', `Read agent-preamble.md first.\n\nThe owner's words:\n"${WORDS.replace('toggle to the', 'toggle to\n  the')}"\n`);
    assert.equal(box.cli(['brief', '--run', 'feat', '--file', '../brief-ok.md']).code, 0);
    // A fix brief points at the review, which quotes the words, so it need not quote them itself.
    assert.equal(box.cli(['brief', '--run', 'feat', '--file', '../brief-bad.md', '--kind', 'fix']).code, 0);
  });

  test('a brief that names a decision missing from the log is refused', () => {
    box.write('../brief-decided.md', `agent-preamble.md\n${WORDS}\n1. **DM-2, decided:** per device.\n`);
    const result = box.cli(['brief', '--run', 'feat', '--file', '../brief-decided.md']);
    assert.match(result.out, /not in the decision log \(decisions.file is not set\): DM-2/);
  });

  test('a feature run needs a design note, not a spec, and the note needs a UI and UX section for a UI change', () => {
    box.write('../spec.md', WORDS);
    assert.match(box.cli(['spec', '--run', 'feat', '--file', '../spec.md']).err, /needs a reviewed design note/);
    box.write('docs/design-dark.md', '# Dark mode\n## Rules\n## Tests\n');
    const refused = box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md']);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /no UI and UX section/);
    box.write('docs/design-dark.md', '# Dark mode\n## Rules\n## UI and UX\n## Tests\n');
    const noted = box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md', '--review-topic', 'darkdesign']);
    assert.equal(noted.code, 0);
    assert.match(noted.out, /noted/);
    assert.equal(box.run('feat').stages.design.state, 'noted');
  });

  test('a lane cannot start before the design review reaches consensus', () => {
    assert.match(box.cli(['lane', '--run', 'feat', '--lane', 'a', '--workspace', box.repo, '--owns', 'src/**']).err, /needs design \(now noted\)/);
  });

  test('the gate refuses to send round 1 of a review whose request does not quote the words', () => {
    const folder = join(box.root, 'review-darkdesign');
    mkdirSync(join(folder, 'round-1'), { recursive: true });
    mkdirSync(box.env.AGENT_REVIEW_LEDGER, { recursive: true });
    writeFileSync(join(box.env.AGENT_REVIEW_LEDGER, 'darkdesign.json'), JSON.stringify({ topic: 'darkdesign', repo: null, identity: null, folder, status: 'pending', rounds: [{ n: 1 }], consensus: null }));
    writeFileSync(join(folder, 'round-1', 'request.md'), '## The user\'s words\nTODO\n');
    const blocked = box.gate('agent-review ask --topic darkdesign --to darkdesign-model --from me');
    assert.equal(blocked.code, 2);
    assert.match(blocked.err, /does not quote the user's words/);
    writeFileSync(join(folder, 'round-1', 'request.md'), `## The user's words\n${WORDS}\n`);
    assert.equal(box.gate('agent-review ask --topic darkdesign --to darkdesign-model --from me').code, 0);
  });

  test('design passes once agent-review records consensus, and a note changed after it is refused', () => {
    writeFileSync(join(box.env.AGENT_REVIEW_LEDGER, 'darkdesign.json'), JSON.stringify({ topic: 'darkdesign', repo: null, identity: null, folder: join(box.root, 'review-darkdesign'), status: 'consensus', rounds: [{ n: 1 }, { n: 2 }], consensus: { tip: null, commits: [], reviewers: 'model-a xhigh, model-b xhigh', rounds: 2 } }));
    const passed = box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md']);
    assert.equal(passed.code, 0);
    assert.match(passed.out, /passed.*consensus after 2 rounds/);
    box.write('docs/design-dark.md', '# Dark mode\n## Rules\n## UI and UX\n## Tests\nA late edit.\n');
    const changed = box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md']);
    assert.equal(changed.code, 1);
    assert.match(changed.out, /changed after its design review reached consensus/);
  });
});

describe('build lanes', () => {
  const box = sandbox({ config: { ...baseConfig, fastLane: { maxFiles: 3 } } });
  after(() => box.cleanup());
  let ws;

  test('a lane needs its own workspace and files no other open lane owns', () => {
    box.cli(['intake', '--run', 'one', '--kind', 'fast', '--words', WORDS]);
    box.write('../spec.md', WORDS);
    box.cli(['spec', '--run', 'one', '--file', '../spec.md']);
    box.commit('chore: add sources', { 'src/a.mjs': 'a\n', 'src/b.mjs': 'b\n' });
    box.sh('jj bookmark set main -r @-');
    ws = join(box.root, 'demo-one');
    box.sh('jj workspace add --name demo-one ../demo-one -r main');
    assert.match(box.cli(['lane', '--run', 'one', '--lane', 'a', '--workspace', join(box.root, 'nowhere'), '--owns', 'src/**']).err, /not the root of a jj workspace/);
    assert.equal(box.cli(['lane', '--run', 'one', '--lane', 'a', '--workspace', ws, '--owns', 'src/a.mjs,FEATURES.md']).code, 0);
    box.cli(['intake', '--run', 'two', '--kind', 'fast', '--words', WORDS]);
    box.cli(['spec', '--run', 'two', '--file', '../spec.md']);
    const sameFolder = box.cli(['lane', '--run', 'two', '--lane', 'b', '--workspace', ws, '--owns', 'src/b.mjs']);
    assert.match(sameFolder.err, /already builds in/);
    box.sh('jj workspace add --name demo-two ../demo-two -r main');
    const overlap = box.cli(['lane', '--run', 'two', '--lane', 'b', '--workspace', join(box.root, 'demo-two'), '--owns', 'src/**']);
    assert.match(overlap.err, /Lane one\/a already owns src\/a.mjs/);
    assert.equal(box.cli(['lane', '--run', 'two', '--lane', 'b', '--workspace', join(box.root, 'demo-two'), '--owns', 'src/b.mjs']).code, 0);
  });

  test('commits outside the lane, with a capital after the colon or a body, are refused', () => {
    box.commit('Fix: The thing\n\nA body.', { 'src/a.mjs': 'a2\n', 'src/b.mjs': 'b2\n' }, ws);
    const result = box.cli(['commits', '--run', 'one', '--lane', 'a'], { cwd: ws });
    assert.equal(result.code, 1);
    assert.match(result.out, /not a conventional commit/);
    assert.match(result.out, /has a body/);
    assert.match(result.out, /outside the lane's ownership: src\/b.mjs/);
    const build = box.cli(['build', '--run', 'one']);
    assert.equal(build.code, 1);
    assert.match(build.out, /commit rule/);
  });

  test('the fast lane refuses a change across too many files', () => {
    box.sh('jj abandon @-', ws);
    box.commit('fix(ui): many files', { 'src/a.mjs': 'a3\n' }, ws);
    box.commit('docs: the feature list', { 'FEATURES.md': 'y\n' }, ws);
    const ok = box.cli(['commits', '--run', 'one', '--lane', 'a'], { cwd: ws });
    assert.equal(ok.code, 0, ok.all);
    box.write('notes/x.md', 'x', ws);
    box.write('notes/y.md', 'y', ws);
    box.commit('docs: notes', {}, ws);
    const result = box.cli(['commits', '--run', 'one', '--lane', 'a', '--outside', 'notes/x.md: notes', '--outside', 'notes/y.md: notes'], { cwd: ws });
    assert.match(result.out, /changes 4 files, over fastLane.maxFiles \(3\)/);
  });

  test('checks refuse a dirty workspace and record each result in order', () => {
    box.sh('jj abandon @-', ws);
    box.cli(['commits', '--run', 'one', '--lane', 'a'], { cwd: ws });
    box.write('src/a.mjs', 'uncommitted\n', ws);
    assert.match(box.cli(['check', '--run', 'one', '--lane', 'a'], { cwd: ws }).err, /uncommitted changes/);
    box.sh('jj restore', ws);
    const run = box.cli(['check', '--run', 'one', '--lane', 'a'], { cwd: ws });
    assert.equal(run.code, 0, run.all);
    assert.match(run.out, /ok {3}unit: exit 0, pass 3, fail 0/);
    const recorded = box.run('one').lanes.a.checks;
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].tip, box.run('one').lanes.a.tip);
  });

  test('a check recorded from outside must come after the earlier phases passed', () => {
    const cfg = JSON.parse(box.sh('cat pipeline.config.json', ws));
    cfg.checks.integration = [{ name: 'int', run: 'echo "# pass 1"' }];
    box.write('pipeline.config.json', JSON.stringify(cfg), ws);
    box.write('../int.log', '# pass 4\n# fail 1\n');
    box.write('../unit.log', '# pass 4\n');
    box.commit('chore: integration check', {}, ws);
    box.cli(['commits', '--run', 'one', '--lane', 'a', '--outside', 'pipeline.config.json: config'], { cwd: ws });
    assert.match(box.cli(['check', '--run', 'one', '--lane', 'a', '--record', 'int', '--exit', '0', '--log', '../int.log'], { cwd: ws }).err, /Record unit as passing/);
    assert.equal(box.cli(['check', '--run', 'one', '--lane', 'a', '--record', 'unit', '--exit', '0', '--log', '../unit.log'], { cwd: ws }).code, 0);
    const failing = box.cli(['check', '--run', 'one', '--lane', 'a', '--record', 'int', '--exit', '0', '--log', '../int.log'], { cwd: ws });
    assert.equal(failing.code, 1);
    assert.match(failing.out, /fail 1/);
  });

  test('a mutation check refuses a test that still passes without its fix', () => {
    box.commit('fix(ui): theme helper', { 'src/a.mjs': 'export const dark = () => true;\n', 'src/a.test.mjs': "import { test } from 'node:test'; test('nothing', () => {});\n" }, ws);
    box.cli(['commits', '--run', 'one', '--lane', 'a', '--outside', 'pipeline.config.json: config', '--outside', 'src/a.test.mjs: its test'], { cwd: ws });
    const tip = box.run('one').lanes.a.tip;
    const result = box.cli(['mutation', '--run', 'one', '--lane', 'a', '--commit', tip, '--test', 'src/a.test.mjs'], { cwd: ws });
    assert.equal(result.code, 64);
    assert.match(result.err, /still passes with the fix in src\/a.mjs removed/);
    assert.match(box.cli(['build', '--run', 'one']).out, /has no mutation check/);
  });

  test('a file another open lane owns is a conflict, a new file included', () => {
    const other = join(box.root, 'demo-two');
    box.commit('fix(ui): b and the feature list', { 'src/b.mjs': 'b3\n', 'FEATURES.md': 'z\n' }, other);
    const result = box.cli(['commits', '--run', 'two', '--lane', 'b'], { cwd: other });
    assert.equal(result.code, 1);
    assert.match(result.out, /touches files lane one\/a owns: FEATURES.md/);
  });

  test('the gate refuses to start a code review before the build passes', () => {
    box.cli(['build', '--run', 'one', '--review-topic', 'onecode']);
    const blocked = box.gate('agent-review start --topic onecode');
    assert.equal(blocked.code, 2);
    assert.match(blocked.err, /build has not passed/);
    assert.equal(box.gate('agent-review start --topic unrelated').code, 0);
  });
});

describe('scan, push, CI, review and deploy', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());
  let ws;
  let tip;

  test('the gate refuses an unscanned push, then allows it after a passed scan', () => {
    ({ ws, tip } = builtRun(box));
    const blocked = box.gate('jj bookmark set ci/dark -r @- && jj git push --bookmark ci/dark', ws);
    assert.equal(blocked.code, 2);
    assert.match(blocked.err, /without a passed pre-push scan/);
    assert.equal(box.cli(['scan', '--run', 'dark'], { cwd: ws }).code, 0);
    assert.equal(box.gate('jj bookmark set ci/dark -r @- && jj git push --bookmark ci/dark', ws).code, 0);
  });

  test('the gate refuses pushes to other branches, force pushes and pushes it cannot name', () => {
    assert.match(box.gate('jj bookmark set feature -r @- && jj git push --bookmark feature', ws).err, /not a branch agents push to/);
    assert.match(box.gate('jj git push --all', ws).err, /Name each bookmark/);
    assert.match(box.gate('jj git push -c @-', ws).err, /cannot name/);
    assert.match(box.gate('jj git push', ws).err, /whatever bookmarks jj picks/);
    assert.match(box.gate('git push --force origin ci/dark', ws).err, /force push/);
    assert.match(box.gate('git push origin +ci/dark', ws).err, /force push/);
    assert.match(box.gate('git push --no-verify origin ci/dark', ws).err, /skips the pre-push hook/);
    assert.match(box.gate('jj git push --remote fork --bookmark ci/dark', ws).err, /pushes to fork/);
    assert.match(box.gate(`cd "$SOMEWHERE" && jj git push --bookmark ci/dark`, ws).err, /Could not tell which directory/);
    assert.equal(box.gate('echo "jj git push is documented here" > notes.txt', ws).code, 0);
    assert.equal(box.gate('jj git push --bookmark ci/dark --dry-run', ws).code, 0);
  });

  test('a push records the run\'s tip, and mirroring sets statuses only on pushed commits', () => {
    box.sh('jj bookmark set ci/dark -r @- && jj git push --bookmark ci/dark', ws);
    box.cli(['mirror-hook'], { input: JSON.stringify({ tool_input: { command: 'jj git push --bookmark ci/dark' }, cwd: ws }) });
    const run = box.run('dark');
    assert.equal(run.stages.push.state, 'passed');
    assert.deepEqual(run.pushedBranches, ['ci/dark']);
    const statuses = box.statusCalls();
    assert.ok(statuses.some((status) => status.context === 'pipeline/scan' && status.state === 'success'));
    assert.ok(statuses.some((status) => status.context === 'pipeline/build' && status.state === 'success'));
    const posted = box.ghCalls().filter((args) => args[0] === 'api' && /statuses/.test(args[3] ?? ''));
    assert.ok(posted.every((args) => args[3] === `repos/${SLUG}/statuses/${tip}`));
  });

  test('a status GitHub refuses is reported, so the agent can retry', () => {
    box.ghScript([{ match: '/statuses/', exit: 1, stderr: 'HTTP 403: Resource not accessible' }]);
    const result = box.cli(['mirror', '--run', 'dark']);
    assert.equal(result.code, 1);
    assert.match(result.out, /pipeline\/build on [0-9a-f]{12} not set: HTTP 403/);
    const hook = box.cli(['mirror-hook'], { input: JSON.stringify({ tool_input: { command: 'jj git push --bookmark ci/dark' }, cwd: ws }) });
    const context = JSON.parse(hook.out).hookSpecificOutput.additionalContext;
    assert.match(context, /could not set stage statuses on GitHub/);
    assert.match(context, /pipeline mirror --run/);
    box.ghScript([]);
  });

  test('a sideways move of a pushed branch is refused as a force push, with a new name offered', () => {
    box.commit('fix(ui): later fix', { 'src/theme.mjs': 'export const dark = () => !false;\n' }, ws);
    box.sh('jj describe -r @-- -m "docs: reworded after push"', ws);
    const blocked = box.gate('jj bookmark set ci/dark -r @- --allow-backwards && jj git push --bookmark ci/dark', ws);
    assert.equal(blocked.code, 2);
    assert.match(blocked.err, /would be a force push.*ci\/dark-2/s);
    assert.equal(box.cli(['push', '--run', 'dark', '--bookmark', 'ci/dark', '--next-name']).out.trim(), 'ci/dark-2');
    box.sh('jj undo && jj undo', ws);
  });

  test('CI counts only once every job has finished', () => {
    box.ghScript(ciScript(tip, { jobs: [{ name: 'e2e (1)', status: 'in_progress', conclusion: '' }] }));
    const running = box.cli(['ci', '--run', 'dark']);
    assert.equal(running.code, 3);
    assert.match(running.out, /not settled/);
    box.ghScript(ciScript(tip, { conclusion: 'failure', jobs: [{ name: 'e2e (2)', status: 'completed', conclusion: 'failure' }] }));
    const failed = box.cli(['ci', '--run', 'dark']);
    assert.equal(failed.code, 1);
    assert.match(failed.out, /failed: e2e \(2\)/);
    box.ghScript(ciScript(tip));
    const ok = box.cli(['ci', '--run', 'dark']);
    assert.equal(ok.code, 0);
    const ci = box.statusCalls().filter((status) => status.context === 'pipeline/ci');
    assert.deepEqual(ci.map((status) => status.state), ['pending', 'failure', 'success']);
    assert.equal(ci.at(-1).target_url, `https://github.com/${SLUG}/actions/runs/77`);
    assert.equal(box.run('dark').ci[tip].runId, 77);
  });

  test('deploy is refused until code review reaches consensus on every commit', () => {
    const refused = box.cli(['deploy', 'check', '--run', 'dark']);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /Code review consensus .* missing for 2 commits/);
    assert.match(box.gate(`./deploy.sh dark ${tip.slice(0, 12)}`).err, /Code review consensus/);
  });

  test('the builtin review records consensus once every reply is saved', () => {
    const start = box.cli(['review', 'start', '--run', 'dark', '--topic', 'dark'], { cwd: ws });
    assert.equal(start.code, 0, start.all);
    assert.match(box.sh('cat .pipeline/review-dark/round-1/request.md', ws), new RegExp(WORDS.slice(0, 40)));
    assert.match(box.cli(['review', 'done', '--run', 'dark', '--topic', 'dark', '--reviewers', 'a high, b high']).err, /0 saved replies/);
    box.write('.pipeline/review-dark/round-1/replies/a.md', 'consensus\n', ws);
    box.write('.pipeline/review-dark/round-1/replies/b.md', 'consensus\n', ws);
    assert.equal(box.cli(['review', 'done', '--run', 'dark', '--topic', 'dark', '--reviewers', 'a high, b high']).code, 0);
    assert.ok(box.statusCalls().some((status) => status.context === 'pipeline/review' && status.state === 'success'));
  });

  test('deploy check passes, and the gate allows the deploy command on that commit', () => {
    const allowed = box.cli(['deploy', 'check', '--run', 'dark']);
    assert.equal(allowed.code, 0, allowed.all);
    assert.match(allowed.out, /Run: \.\/deploy\.sh dark/);
    assert.equal(box.gate(`./deploy.sh dark ${tip.slice(0, 12)}`).code, 0);
    assert.match(box.gate('./deploy.sh dark main').err, /No pipeline run records/);
  });

  test('deploy record checks the results and sends the notification, a failed one too', () => {
    const notes = join(box.root, 'notes.txt');
    const extra = { NOTES: notes };
    const bad = box.cli(['deploy', 'record', '--run', 'dark', '--name', 'b1', '--shipped', 'dark mode', '--backup', 'db.dump', '--health', 'healthy', '--load', '3/4', '--http', '200'], { extra });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /loaded 3 of 4/);
    const good = box.cli(['deploy', 'record', '--run', 'dark', '--name', 'b1', '--shipped', 'dark mode', '--backup', 'db.dump', '--health', 'healthy', '--load', '4/4', '--http', '200 200'], { extra });
    assert.equal(good.code, 0, good.all);
    assert.deepEqual(box.sh(`cat ${notes}`).trim().split('\n'), ['Deploy of b1 failed: The load check loaded 3 of 4.', 'Deployed b1: dark mode']);
    assert.equal(box.run('dark').stages.deploy.state, 'passed');
  });

  test('cleanup lists what is left and passes once branches, workspaces and folders are gone', () => {
    box.sh(`jj bookmark set main -r ${tip} && jj git push --bookmark main`);
    const left = box.cli(['cleanup', '--run', 'dark']);
    assert.equal(left.code, 1);
    assert.match(left.out, /ci\/dark is merged but still on origin/);
    assert.match(left.out, /Workspace demo-dark/);
    box.sh('jj bookmark delete ci/dark && jj git push --deleted && jj workspace forget demo-dark');
    box.sh(`rm -rf ${JSON.stringify(ws)}`);
    const done = box.cli(['cleanup', '--run', 'dark']);
    assert.equal(done.code, 0, done.all);
    assert.equal(box.run('dark').lanesReleased, true);
  });
});

describe('rebase onto main', () => {
  const box = sandbox({ config: { ...baseConfig, review: { provider: 'agent-review' } } });
  after(() => box.cleanup());

  test('review coverage carries over when patch-ids match, and reopens when a diff changed', () => {
    const { ws, tip } = builtRun(box);
    const ids = box.sh(`jj log --no-graph -r 'main..${tip}' -T 'commit_id ++ "\\n"'`, ws).trim().split('\n');
    const commits = box.run('dark').lanes.a.commits;
    mkdirSync(box.env.AGENT_REVIEW_LEDGER, { recursive: true });
    writeFileSync(join(box.env.AGENT_REVIEW_LEDGER, 'dark.json'), JSON.stringify({ topic: 'dark', repo: ws, identity: `github:${SLUG}`, folder: join(box.root, 'rv'), status: 'consensus', rounds: [{ n: 1, commits }], consensus: { tip, commits, reviewers: 'a, b', rounds: 1 } }));
    assert.equal(ids.length, 2);
    box.commit('chore: unrelated work on main', { 'other.txt': 'x\n' });
    box.sh('jj bookmark set main -r @-');
    box.sh('jj rebase -b @ -d main', ws);
    const moved = box.sh('jj log --no-graph -r @- -T commit_id', ws).trim();
    const carried = box.cli(['rebase', '--run', 'dark', '--tip', moved], { cwd: ws });
    assert.match(carried.out, /2 commits keep their patch-id, 0 commits changed, 0 commits lack review consensus/);
    assert.equal(box.run('dark').stages.build.state, 'passed');
    // New commit ids: the scan and CI run again on them.
    box.cli(['scan', '--run', 'dark'], { cwd: ws });
    box.cli(['rebase', '--run', 'dark', '--tip', moved], { cwd: ws });
    assert.equal(box.run('dark').stages.scan.state, 'stale');
    box.sh('jj edit @--', ws);
    box.write('src/theme.mjs', 'export const dark = () => 1 === 1;\n', ws);
    box.sh('jj new', ws);
    box.sh('jj edit @-', ws);
    box.sh('jj new', ws);
    const changed = box.sh('jj log --no-graph -r @- -T commit_id', ws).trim();
    const reopened = box.cli(['rebase', '--run', 'dark', '--tip', changed], { cwd: ws });
    assert.match(reopened.out, /1 commit changed, 1 commit lack review consensus/);
    assert.match(reopened.out, /agent-review round --topic/);
    assert.equal(box.run('dark').stages.build.state, 'stale');
  });
});

describe('the user runs deploys, and prod is never an agent\'s', () => {
  const box = sandbox({ config: { ...baseConfig, deploy: { ...baseConfig.deploy, runBy: 'user' } } });
  after(() => box.cleanup());

  test('the deploy command and deploy workflows are refused, and the check hands over the command', () => {
    assert.match(box.gate('./deploy.sh b1 main').err, /The user runs deploys/);
    assert.match(box.gate('gh workflow run deploy.yml --ref main').err, /The user runs deploys/);
    assert.match(box.gate('gh workflow run deploy-prod.yml --ref main').err, /never run a production deploy/);
    assert.match(box.gate('gh workflow run release.yml -f environment=production').err, /never run a production deploy/);
    assert.match(box.gate('gh workflow run 12345').err, /Name the workflow by its file name/);
    assert.equal(box.gate('gh workflow run lint.yml --ref main').code, 0);
  });
});

describe('live play, follow-ups and docs', () => {
  const box = sandbox({ config: { ...baseConfig, decisions: { file: '../decisions.md' } } });
  after(() => box.cleanup());

  test('live play starts only on a deployed build, and each bug ends fixed and shipped or decided', () => {
    const { ws, tip } = builtRun(box);
    assert.match(box.cli(['live-play', 'start', '--run', 'dark', '--prefix', 'LP1']).err, /needs deploy/);
    box.cli(['scan', '--run', 'dark'], { cwd: ws });
    box.sh('jj bookmark set ci/dark -r @- && jj git push --bookmark ci/dark', ws);
    box.ghScript(ciScript(tip));
    box.cli(['ci', '--run', 'dark']);
    box.cli(['review', 'skip', '--run', 'dark', '--reason', 'the user said to skip review for this test']);
    const recorded = box.cli(['deploy', 'record', '--run', 'dark', '--name', 'b1', '--shipped', 'dark mode', '--backup', 'b', '--health', 'healthy', '--load', '1/1', '--http', '200'], { extra: { NOTES: join(box.root, 'n.txt') } });
    assert.equal(recorded.code, 0, recorded.all);
    box.sh(`jj bookmark set main -r ${tip} && jj git push --bookmark main`);
    assert.equal(box.cli(['live-play', 'start', '--run', 'dark', '--prefix', 'LP1', '--workspace', ws]).code, 0);
    box.sh('jj new main', ws);
    const fix = box.commit('fix(ui): the toggle remembers its state', { 'src/theme.mjs': 'export const dark = () => Boolean(1);\n' }, ws);
    box.write('../lp1.md', ['| ID | Sev | Area | Bug | Status |', '|---|---|---|---|---|', `| LP1-UI-1 | P2 | settings | toggle forgets | fixed ${fix.slice(0, 12)} |`, '| LP1-UI-2 | P3 | settings | label wording | needs owner: say "Dark" |'].join('\n'));
    const imported = box.cli(['live-play', 'import', '--run', 'dark', '--report', '../lp1.md'], { cwd: ws });
    assert.equal(imported.code, 0, imported.all);
    assert.match(imported.out, /LP1-UI-1: its fix .* has not shipped/);
    assert.match(imported.out, /LP1-UI-2: needs the owner/);
    box.cli(['decide', '--run', 'dark', '--id', 'LP1-UI-2', '--chose', 'say Dark', '--why', 'shorter on phones', '--rejected', 'Dark mode (wraps at 320 px)']);
    assert.equal(box.cli(['live-play', 'resolve', '--run', 'dark', '--id', 'LP1-UI-2', '--decision', 'LP1-UI-2']).code, 0);
    box.sh(`jj bookmark set main -r ${fix} && jj git push --bookmark main`);
    box.cli(['signoff', '--run', 'dark', '--stage', 'live-play', '--item', 'bug-fix-only', '--by', 'owner', '--note', 'both fixes keep documented behavior']);
    const done = box.cli(['live-play', 'done', '--run', 'dark']);
    assert.equal(done.code, 0, done.all);
    assert.match(done.out, /LP1: 2 bugs \(1 P2, 1 P3\), 1 fixed/);
  });

  test('follow-ups plan into lanes that share no file', () => {
    for (const [id, files] of [['F-1', 'src/a.ts'], ['F-2', 'src/b.ts'], ['F-3', 'src/a.ts,src/c.ts']]) {
      assert.equal(box.cli(['followup', 'add', '--run', 'dark', '--id', id, '--severity', 'P3', '--source', 'review r2', '--text', `fix ${id}`, '--files', files]).code, 0);
    }
    assert.match(box.cli(['followup', 'add', '--run', 'dark', '--id', 'F-4', '--severity', 'P1', '--text', 'x']).err, /blocks review/);
    const plan = box.cli(['followup', 'plan', '--run', 'dark', '--lanes', '2']);
    assert.match(plan.out, /lane a: F-1, F-3\n {4}owns src\/a.ts, src\/c.ts/);
    assert.match(plan.out, /lane b: F-2/);
  });

});

describe('docs', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());

  test('a feat without the feature list fails the docs check', () => {
    box.write('../dark-spec.md', `The user's words: ${WORDS}\n`);
    box.cli(['intake', '--run', 'nodocs', '--kind', 'fast', '--words', WORDS]);
    box.cli(['spec', '--run', 'nodocs', '--file', '../dark-spec.md']);
    const ws = join(box.root, 'demo-nodocs');
    box.sh(`jj workspace add --name demo-nodocs ${ws} -r main`);
    box.cli(['lane', '--run', 'nodocs', '--lane', 'a', '--workspace', ws, '--owns', 'src/**']);
    box.commit('feat(ui): a new switch', { 'src/switch.mjs': 'export const on = 1;\n' }, ws);
    box.cli(['commits', '--run', 'nodocs', '--lane', 'a'], { cwd: ws });
    box.cli(['check', '--run', 'nodocs', '--lane', 'a'], { cwd: ws });
    box.write('../r.md', '# r\n');
    box.cli(['report', '--run', 'nodocs', '--lane', 'a', '--file', '../r.md']);
    box.cli(['signoff', '--run', 'nodocs', '--stage', 'build', '--item', 'scope', '--by', 'owner', '--note', 'ok']);
    assert.equal(box.cli(['build', '--run', 'nodocs']).code, 0);
    const docs = box.cli(['docs', '--run', 'nodocs'], { cwd: ws });
    assert.equal(docs.code, 1);
    assert.match(docs.out, /FEATURES.md is not updated in this range/);
  });
});

describe('hooks for agents without them', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());

  test('exec runs an allowed command, and refuses a gated one without running it', () => {
    const allowed = box.cli(['exec', '--', 'sh', '-c', 'echo ran > ran.txt']);
    assert.equal(allowed.code, 0);
    assert.equal(box.sh('cat ran.txt').trim(), 'ran');
    box.commit('feat: x', { 'x.txt': 'x\n' });
    const blocked = box.cli(['exec', '--', 'jj', 'git', 'push', '--bookmark', 'main']);
    assert.equal(blocked.code, 2);
    assert.match(blocked.err, /Moving main is a deploy step/);
  });

  test('the git pre-push hook refuses an unscanned push', () => {
    const sha = box.sh('jj log --no-graph -r @- -T commit_id').trim();
    const result = box.cli(['git-pre-push', '--remote', 'origin'], { input: `refs/heads/ci/x ${sha} refs/heads/ci/x ${'0'.repeat(40)}\n` });
    assert.equal(result.code, 1);
    assert.match(result.err, /without a passed pre-push scan/);
  });

  test('a real git push runs the pre-push hook and is refused', () => {
    box.sh(`ln -s ${JSON.stringify(join(import.meta.dirname, '..', 'git-hooks', 'pre-push'))} .git/hooks/pre-push`);
    const sha = box.commit('feat: hooked', { 'hooked.txt': 'x\n' });
    assert.throws(() => box.sh(`git push origin ${sha}:refs/heads/ci/hooked`), /without a passed pre-push scan/);
    assert.equal(box.sh(`git --git-dir=${JSON.stringify(box.bare)} branch --list ci/hooked`).trim(), '');
  });

  test('a repository without a pipeline config is never gated', () => {
    box.sh('mkdir -p ../plain && cd ../plain && jj git init --colocate >/dev/null 2>&1');
    assert.equal(box.gate('jj git push --all', join(box.root, 'plain')).code, 0);
  });
});
