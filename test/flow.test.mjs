// The whole flow in a sandbox repository: each gate's allow and refuse cases, with gh stubbed.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ALL_WORKFLOWS, baseConfig, builtRun, ciScript, CLI, sandbox, SLUG, WORDS, WORKFLOWS, workflowsRule } from './helpers.mjs';

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
    // R4 sweep: a ledger entry that cannot be read may be the one this review needs.
    writeFileSync(join(box.env.AGENT_REVIEW_LEDGER, 'broken.json'), '{ nope');
    assert.match(box.gate('agent-review ask --topic darkdesign --to darkdesign-model --from me').err, /review ledger entry \S+broken\.json cannot be read/);
    rmSync(join(box.env.AGENT_REVIEW_LEDGER, 'broken.json'));
  });

  test('design passes once agent-review records consensus, and a note changed after it is refused', () => {
    writeFileSync(join(box.env.AGENT_REVIEW_LEDGER, 'darkdesign.json'), JSON.stringify({ topic: 'darkdesign', repo: null, identity: null, folder: join(box.root, 'review-darkdesign'), status: 'consensus', rounds: [{ n: 1 }, { n: 2 }], consensus: { tip: null, commits: [], reviewers: 'model-a xhigh, model-b xhigh', rounds: 2 } }));
    const passed = box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md']);
    assert.equal(passed.code, 0);
    assert.match(passed.out, /passed.*consensus after 2 rounds/);
    box.write('docs/design-dark.md', '# Dark mode\n## Rules\n## UI and UX\n## Tests\nA late edit.\n');
    const changed = box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md']);
    assert.equal(changed.code, 1);
    assert.match(changed.out, /changed after its design review reached consensus \(round 2\)/);
    // The binding survives the refusal: trying again, or claiming a re-review, changes nothing.
    assert.equal(box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md']).code, 1);
    assert.match(box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md', '--re-review']).out, /needs a consensus newer than the one the note was bound to \(round 2 of darkdesign\)/);
    // Another review's consensus, however recent, says nothing about this note.
    writeFileSync(join(box.env.AGENT_REVIEW_LEDGER, 'otherdesign.json'), JSON.stringify({ topic: 'otherdesign', repo: null, identity: null, folder: join(box.root, 'review-other'), status: 'consensus', rounds: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], consensus: { tip: null, commits: [], reviewers: 'a, b', rounds: 4, at: '2099-01-01T00:00:00Z' } }));
    for (let attempt = 0; attempt < 2; attempt++) assert.match(box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md', '--review-topic', 'otherdesign', '--re-review']).out, /needs a newer consensus of this run's design review, darkdesign, not of otherdesign/);
    writeFileSync(join(box.env.AGENT_REVIEW_LEDGER, 'darkdesign.json'), JSON.stringify({ topic: 'darkdesign', repo: null, identity: null, folder: join(box.root, 'review-darkdesign'), status: 'consensus', rounds: [{ n: 1 }, { n: 2 }, { n: 3 }], consensus: { tip: null, commits: [], reviewers: 'model-a xhigh, model-b xhigh', rounds: 3 } }));
    const again = box.cli(['design', '--run', 'feat', '--note', 'docs/design-dark.md', '--re-review']);
    assert.equal(again.code, 0, again.all);
    assert.equal(box.run('feat').stages.design.reviewed.rounds, 3);
  });
});

// PA-49: a note bound to the user's skip could never take a real review of its changed text.
describe('a design bound to a skip', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());
  const consensus = (topic, rounds, at = '2099-01-01T00:00:00Z') => writeFileSync(join(box.env.AGENT_REVIEW_LEDGER, `${topic}.json`), JSON.stringify({ topic, repo: null, identity: null, folder: join(box.root, `review-${topic}`), status: 'consensus', rounds: Array.from({ length: rounds }, (_, n) => ({ n: n + 1 })), consensus: { tip: null, commits: [], reviewers: 'a, b', rounds, at } }));

  test('takes a consensus of the run\'s own design review for the changed note, and no other topic\'s', () => {
    mkdirSync(box.env.AGENT_REVIEW_LEDGER, { recursive: true });
    box.cli(['intake', '--run', 'skp', '--words', WORDS, '--ui']);
    box.write('docs/design-skp.md', '# Skip\n## Rules\n## UI and UX\n## Build plan\n## Tests\n');
    assert.equal(box.cli(['design', '--run', 'skp', '--note', 'docs/design-skp.md', '--review-topic', 'skpdesign']).code, 0);
    const skipped = box.cli(['design', '--run', 'skp', '--note', 'docs/design-skp.md', '--review-skip', 'The user said to skip the design review.']);
    assert.equal(skipped.code, 0, skipped.all);
    assert.equal(box.run('skp').stages.design.reviewed.kind, 'skip');
    box.write('docs/design-skp.md', '# Skip\n## Rules\n## UI and UX\n## Build plan\n## Tests\nA change the review saw.\n');
    consensus('otherskp', 3);
    assert.match(box.cli(['design', '--run', 'skp', '--note', 'docs/design-skp.md', '--review-topic', 'otherskp', '--re-review']).out, /needs a newer consensus of this run's design review/);
    consensus('skpdesign', 2);
    const reviewed = box.cli(['design', '--run', 'skp', '--note', 'docs/design-skp.md', '--re-review']);
    assert.equal(reviewed.code, 0, reviewed.all);
    assert.deepEqual([box.run('skp').stages.design.reviewed.kind, box.run('skp').stages.design.reviewed.topic], ['review', 'skpdesign']);
  });

  // PA-62: a consensus recorded while the skipped note is unchanged binds it, so it cannot approve a
  // later edit. A consensus with no time cannot prove it came after the skip.
  test('binds a review of the unchanged skipped note, so an edit needs a newer one', () => {
    box.cli(['intake', '--run', 'skp2', '--words', WORDS, '--ui']);
    box.write('docs/design-skp2.md', '# Skip\n## Rules\n## UI and UX\n## Build plan\n## Tests\n');
    assert.equal(box.cli(['design', '--run', 'skp2', '--note', 'docs/design-skp2.md', '--review-topic', 'skp2design']).code, 0);
    assert.equal(box.cli(['design', '--run', 'skp2', '--note', 'docs/design-skp2.md', '--review-skip', 'The user said to skip it.']).code, 0);
    consensus('skp2design', 2);
    const bound = box.cli(['design', '--run', 'skp2', '--note', 'docs/design-skp2.md']);
    assert.equal(bound.code, 0, bound.all);
    assert.deepEqual([box.run('skp2').stages.design.reviewed.kind, box.run('skp2').stages.design.reviewed.rounds], ['review', 2]);
    box.write('docs/design-skp2.md', '# Skip\n## Rules\n## UI and UX\n## Build plan\n## Tests\nAn edit after the review.\n');
    assert.match(box.cli(['design', '--run', 'skp2', '--note', 'docs/design-skp2.md', '--re-review']).out, /needs a consensus newer than the one the note was bound to \(round 2 of skp2design\)/);
    consensus('skp2design', 3, '2099-01-02T00:00:00Z');
    assert.equal(box.cli(['design', '--run', 'skp2', '--note', 'docs/design-skp2.md', '--re-review']).code, 0);
  });

  test('refuses a consensus with no time to take over from a skip', () => {
    box.cli(['intake', '--run', 'skp3', '--words', WORDS, '--ui']);
    box.write('docs/design-skp3.md', '# Skip\n## Rules\n## UI and UX\n## Build plan\n## Tests\n');
    box.cli(['design', '--run', 'skp3', '--note', 'docs/design-skp3.md', '--review-topic', 'skp3design']);
    box.cli(['design', '--run', 'skp3', '--note', 'docs/design-skp3.md', '--review-skip', 'The user said to skip it.']);
    box.write('docs/design-skp3.md', '# Skip\n## Rules\n## UI and UX\n## Build plan\n## Tests\nAn edit.\n');
    consensus('skp3design', 2, null);
    assert.match(box.cli(['design', '--run', 'skp3', '--note', 'docs/design-skp3.md', '--re-review']).out, /recorded after the skip, and this one has no time recorded/);
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
    box.sh('jj bookmark set main -r @- && jj git push --bookmark main');
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

  // R4 sweep: a run without the fix that is killed or times out shows nothing about the test.
  test('a mutation check refuses a run without the fix that never finished', () => {
    const tip = box.run('one').lanes.a.tip;
    const result = box.cli(['mutation', '--run', 'one', '--lane', 'a', '--commit', tip, '--test', 'src/a.test.mjs', '--cmd', 'grep -q true src/a.mjs || kill -9 $$'], { cwd: ws });
    assert.equal(result.code, 64);
    assert.match(result.err, /did not finish without the fix \(signal SIGKILL\)/);
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
    assert.match(box.gate('jj bookmark set feature -r @- && jj git push --all', ws).err, /feature is not a branch agents push to/);
    assert.match(box.gate('jj git push -c @-', ws).err, /push-[a-z]+ is not a branch agents push to/);
    assert.match(box.gate('jj git push', ws).err, /whatever bookmarks jj picks/);
    assert.match(box.gate('git push --force origin ci/dark', ws).err, /force push/);
    assert.match(box.gate('git push origin +ci/dark', ws).err, /force push/);
    assert.match(box.gate('git push --no-verify origin ci/dark', ws).err, /skips the pre-push hook/);
    assert.match(box.gate('jj git push --remote fork --bookmark ci/dark', ws).err, /pushes to fork/);
    assert.match(box.gate(`cd "$SOMEWHERE" && jj git push --bookmark ci/dark`, ws).err, /built at run time/);
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

  test('CI records only a run of ci.workflow on the exact commit, in this repository', () => {
    const view = (id, fields) => ({ match: `run view ${id}`, stdout: { databaseId: id, status: 'completed', conclusion: 'success', url: `https://github.com/${SLUG}/actions/runs/${id}`, headSha: tip, workflowName: 'CI', workflowDatabaseId: 7, jobs: [], ...fields } });
    box.ghScript([workflowsRule(), view(78, { headSha: 'f'.repeat(40) }), view(79, { workflowName: 'Lint', workflowDatabaseId: 9 }), view(80, { url: 'https://github.com/other-owner/other/actions/runs/80' })]);
    assert.match(box.cli(['ci', '--run', 'dark', '--run-id', '78']).err, /ran on ffffffffffff, not/);
    assert.match(box.cli(['ci', '--run', 'dark', '--run-id', '79']).err, /run of Lint \(workflow 9\), which is not in ci.workflow \(.github\/workflows\/ci.yml\)/);
    assert.match(box.cli(['ci', '--run', 'dark', '--run-id', '80']).err, /is not in example-owner\/demo/);
    // A second workflow that calls itself CI makes the name ambiguous, and its runs never count for ci.yml.
    const impostor = { id: 9, name: 'CI', path: '.github/workflows/fake.yml', state: 'active' };
    box.ghScript([workflowsRule([...WORKFLOWS, impostor])]);
    assert.match(box.cli(['ci', '--run', 'dark']).err, /ci.workflow: CI names 2 workflows .*Name it by its file/);
    box.ghScript([]);
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
    // The deletion and its push are separate commands, and the gate allows the push of a deleted ci/* branch.
    assert.match(left.out, /jj git push --remote origin --bookmark ci\/dark/);
    box.sh('jj bookmark delete ci/dark');
    assert.equal(box.gate('jj git push --remote origin --bookmark ci/dark').code, 0);
    box.sh('jj git push --remote origin --bookmark ci/dark && jj workspace forget demo-dark');
    box.sh(`rm -rf ${JSON.stringify(ws)}`);
    const done = box.cli(['cleanup', '--run', 'dark']);
    assert.equal(done.code, 0, done.all);
    assert.equal(box.run('dark').lanesReleased, true);
    // R4 sweep: a database list that fails cannot show the scratch databases were dropped.
    const runFile = join(box.env.AGENT_PIPELINE_STATE, 'runs', 'dark.json');
    const saved = JSON.parse(readFileSync(runFile, 'utf8'));
    saved.lanes.a.dbs = ['scratch_a'];
    writeFileSync(runFile, JSON.stringify(saved));
    box.write('pipeline.local.json', JSON.stringify({ cleanup: { databaseList: 'echo scratch_a; exit 3' } }));
    const unlisted = box.cli(['cleanup', '--run', 'dark']);
    assert.equal(unlisted.code, 1);
    assert.match(unlisted.out, /cleanup\.databaseList failed \(exit 3\)/);
    box.write('pipeline.local.json', JSON.stringify({ cleanup: { databaseList: 'echo other_db' } }));
    assert.equal(box.cli(['cleanup', '--run', 'dark']).code, 0);
    box.sh('rm pipeline.local.json');
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
    box.sh('jj bookmark set main -r @- && jj git push --bookmark main');
    box.sh('jj rebase -b @ -d main', ws);
    const moved = box.sh('jj log --no-graph -r @- -T commit_id', ws).trim();
    const carried = box.cli(['rebase', '--run', 'dark', '--tip', moved], { cwd: ws });
    assert.match(carried.out, /2 commits keep their patch-id, 0 commits changed, 0 commits lack review consensus/);
    assert.equal(box.run('dark').stages.build.state, 'passed');
    box.cli(['scan', '--run', 'dark'], { cwd: ws });
    assert.equal(box.run('dark').stages.scan.state, 'passed');
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
    // New commit ids: the scan and CI run again on them.
    assert.equal(box.run('dark').stages.scan.state, 'stale');
    // The lane's evidence covered the old commits, so the build does not pass again on the new ones.
    const build = box.cli(['build', '--run', 'dark']);
    assert.equal(build.code, 1);
    assert.match(build.out, /not in the rebased range/);
    assert.match(build.out, /has no mutation check/);
  });
});

describe('a rebase that changes the lane tip\'s diff', () => {
  const box = sandbox({ config: { ...baseConfig, review: { provider: 'agent-review' } } });
  after(() => box.cleanup());

  test('moves the lane to the new commits, but not its checks', () => {
    const { ws, tip } = builtRun(box);
    box.sh(`jj edit ${tip}`, ws);
    box.write('FEATURES.md', '- Dark mode, remembered per device\n', ws);
    box.sh('jj new', ws);
    const changed = box.sh('jj log --no-graph -r @- -T commit_id', ws).trim();
    assert.match(box.cli(['rebase', '--run', 'dark', '--tip', changed], { cwd: ws }).out, /1 commit changed/);
    assert.equal(box.run('dark').lanes.a.tip, changed);
    const build = box.cli(['build', '--run', 'dark']);
    assert.equal(build.code, 1);
    assert.match(build.out, /lane a: unit has not run/);
  });
});

describe('the user runs deploys, and prod is never an agent\'s', () => {
  const box = sandbox({ config: { ...baseConfig, deploy: { ...baseConfig.deploy, runBy: 'user', allowedWorkflows: ['.github/workflows/lint.yml'] } } });
  after(() => box.cleanup());

  test('the deploy command and deploy workflows are refused, and the check hands over the command', () => {
    box.ghScript([workflowsRule(ALL_WORKFLOWS)]);
    assert.match(box.gate('./deploy.sh b1 main').err, /The user runs deploys/);
    assert.match(box.gate('gh workflow run deploy.yml --ref main').err, /allowedWorkflows/);
    assert.match(box.gate('gh workflow run deploy-prod.yml --ref main').err, /never run a production deploy/);
    assert.match(box.gate('gh workflow run release.yml -f environment=production').err, /never run a production deploy/);
    assert.match(box.gate('gh workflow run 12345').err, /No workflow/);
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
    box.sh('jj bookmark set main -r @-');
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

  test('the git pre-push hook refuses when the local view of the remote is stale', () => {
    const sha = box.sh('jj log --no-graph -r @- -T commit_id').trim();
    box.sh(`git update-ref refs/remotes/origin/ci/fake ${sha}`);
    try {
      const result = box.cli(['git-pre-push', '--remote', 'origin'], { input: `refs/heads/ci/x ${sha} refs/heads/ci/x ${'0'.repeat(40)}\n` });
      assert.equal(result.code, 1);
      assert.match(result.err, /differs from what origin holds\. Run jj git fetch/);
    } finally {
      box.sh('git update-ref -d refs/remotes/origin/ci/fake');
    }
  });

  test('the git pre-push hook refuses when git and the remote disagree on the branch tip', () => {
    const sha = box.sh('jj log --no-graph -r @- -T commit_id').trim();
    const main = box.sh('jj log --no-graph -r main@origin -T commit_id').trim();
    const result = box.cli(['git-pre-push', '--remote', 'origin'], { input: `refs/heads/ci/x ${sha} refs/heads/ci/x ${main}\n` });
    assert.equal(result.code, 1);
    assert.match(result.err, /ci\/x: git says origin has [0-9a-f]{12}, but the remote reported nothing to the gate\. Fetch first/);
  });

  test('a repository without a pipeline config is never gated', () => {
    box.sh('mkdir -p ../plain && cd ../plain && jj git init --colocate >/dev/null 2>&1');
    assert.equal(box.gate('jj git push --all', join(box.root, 'plain')).code, 0);
  });
});

describe('the scan reads each commit on its own', () => {
  const box = sandbox({ config: baseConfig, local: { scan: { private: ['secret-host.example'] } } });
  after(() => box.cleanup());

  test('a private string one commit adds and the next removes still refuses the scan, and is never printed', () => {
    const { ws } = builtRun(box);
    box.commit('docs: a note', { 'notes.md': 'see secret-host.example\n' }, ws);
    box.commit('docs: the note without the host', { 'notes.md': 'see the host\n' }, ws);
    const result = box.cli(['scan', '--run', 'dark', '--tip', '@-'], { cwd: ws });
    assert.equal(result.code, 1);
    assert.match(result.out, /error private [0-9a-f]{12} notes.md:1: a string from scan.private/);
    assert.ok(!result.all.includes('secret-host.example'));
  });
});

describe('CI without a designated workflow', () => {
  const box = sandbox({ config: { ...baseConfig, ci: { workflow: null } } });
  after(() => box.cleanup());

  test('pipeline ci refuses to count any run', () => {
    box.cli(['intake', '--run', 'noci', '--kind', 'fast', '--words', WORDS]);
    assert.match(box.cli(['ci', '--run', 'noci']).err, /Set ci.workflow/);
  });
});

describe('statuses stay on the commit their evidence covers', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());

  test('a new tip gets pending statuses for the stages recorded on the old one', () => {
    const { ws, tip } = builtRun(box);
    assert.equal(box.cli(['scan', '--run', 'dark'], { cwd: ws }).code, 0);
    box.commit('fix(ui): a later fix', { 'src/theme.mjs': 'export const dark = () => !false;\n' }, ws);
    box.cli(['commits', '--run', 'dark', '--lane', 'a'], { cwd: ws });
    const next = box.run('dark').tip;
    assert.notEqual(next, tip);
    assert.equal(box.run('dark').stages.scan.state, 'stale');
    box.sh('jj bookmark set ci/next -r @- && jj git push -b ci/next', ws);
    box.cli(['mirror', '--run', 'dark'], { cwd: ws });
    const onNext = box.ghCalls().filter((args) => args[0] === 'api' && args[3] === `repos/${SLUG}/statuses/${next}`).map((args) => Object.fromEntries(args.filter((arg, i) => args[i - 1] === '-f').map((field) => field.split(/=(.*)/s).slice(0, 2))));
    assert.deepEqual(onNext.filter((status) => ['pipeline/scan', 'pipeline/build'].includes(status.context)).map((status) => status.state), ['pending', 'pending']);
    assert.ok(!onNext.some((status) => status.state === 'success' && status.context !== 'pipeline/intake' && status.context !== 'pipeline/design'));
  });
});

describe('a review status from GitHub counts only from a trusted writer', () => {
  const box = sandbox({ config: { ...baseConfig, review: { provider: 'builtin', trustGithubStatus: true } } });
  after(() => box.cleanup());

  test('the newest review status on the tip, set by the repository owner, attests the range', () => {
    const { ws, tip } = builtRun(box);
    const statuses = (list) => box.ghScript([{ match: `commits/${tip}/statuses`, stdout: list }]);
    const review = () => box.cli(['review', 'status', '--run', 'dark'], { cwd: ws }).out;
    statuses([{ context: 'pipeline/review', state: 'success', creator: { login: 'someone-else' } }]);
    assert.match(review(), /: none, 2 none/);
    statuses([{ context: 'agent-review', state: 'failure', creator: { login: 'example-owner' } }, { context: 'agent-review', state: 'success', creator: { login: 'example-owner' } }]);
    assert.match(review(), /: none, 2 none/);
    statuses([{ context: 'agent-review', state: 'success', creator: { login: 'example-owner' } }]);
    assert.match(review(), /: passed, 2 consensus \(github agent-review by example-owner\)/);
  });
});

describe('several lanes integrate into one tip', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());

  test('the build passes only once pipeline integrate records a tip that holds every lane commit', () => {
    const { ws } = builtRun(box);
    const other = join(box.root, 'demo-dark-b');
    box.sh(`jj workspace add --name demo-dark-b ${other} -r main`);
    assert.equal(box.cli(['lane', '--run', 'dark', '--lane', 'b', '--workspace', other, '--owns', 'lib/**']).code, 0);
    box.commit('fix(lib): a helper', { 'lib/help.mjs': 'export const help = 1;\n' }, other);
    assert.equal(box.cli(['commits', '--run', 'dark', '--lane', 'b'], { cwd: other }).code, 0);
    assert.equal(box.cli(['check', '--run', 'dark', '--lane', 'b'], { cwd: other }).code, 0);
    box.cli(['report', '--run', 'dark', '--lane', 'b', '--file', '../dark-report.md']);
    const unintegrated = box.cli(['build', '--run', 'dark']);
    assert.equal(unintegrated.code, 1);
    assert.match(unintegrated.out, /not integrated: stack the lanes and run pipeline integrate/);
    const laneA = box.sh('jj log --no-graph -r @- -T commit_id', ws).trim();
    assert.match(box.cli(['integrate', '--run', 'dark', '--tip', laneA]).err, /does not hold every lane commit.*lane b/s);
    const change = box.sh('jj log --no-graph -r @- -T change_id', other).trim();
    box.sh(`jj rebase -r ${change} -d ${laneA}`);
    const stacked = box.sh(`jj log --no-graph -r ${change} -T commit_id`).trim();
    const integrated = box.cli(['integrate', '--run', 'dark', '--tip', stacked]);
    assert.equal(integrated.code, 0, integrated.all);
    assert.equal(box.run('dark').tip, stacked);
    const built = box.cli(['build', '--run', 'dark']);
    assert.equal(built.code, 0, built.all);
  });
});

describe('a fix for a hole live on the server', () => {
  // The lane runs e2e file a only. Deploying without CI needs b too, on the exact tip.
  const checks = { parallel: [{ name: 'unit', run: 'echo "# pass 3"' }], e2e: { command: 'echo "# pass 1 {file}"', files: ['a', 'b'], always: ['a'] }, keepAwake: false };
  const box = sandbox({ config: { ...baseConfig, push: { public: true }, checks }, local: { scan: { private: ['private-host.example'] } } });
  after(() => box.cleanup());
  let ws;
  let tip;

  test('stays off the public remote, by id, by patch-id and by ancestry', () => {
    ({ ws, tip } = builtRun(box, { intake: ['--live-hole'] }));
    assert.equal(box.cli(['scan', '--run', 'dark'], { cwd: ws }).code, 0);
    const LIVE = /fixes a hole that is live on the deployed server/;
    assert.match(box.gate('jj bookmark set ci/hole -r @- && jj git push -b ci/hole', ws).err, LIVE);
    // A copy of the fix has new commit ids and the same patch-ids, and a merge carries the fix itself.
    box.sh(`jj duplicate ${tip} -d main`, ws);
    const copy = box.sh(`jj log --no-graph -r 'children(main) & description(substring:"docs: dark mode") ~ ${tip}' -T commit_id`, ws).trim();
    box.sh(`jj bookmark set ci/copy -r ${copy}`, ws);
    box.cli(['scan', '--run', 'dark', '--tip', copy], { cwd: ws });
    assert.match(box.gate('jj git push -b ci/copy', ws).err, LIVE);
    box.sh(`jj new ${tip} main -m "chore: merge" && jj new`, ws);
    assert.match(box.gate(`jj bookmark set ci/merge -r @- && jj git push -b ci/merge`, ws).err, LIVE);
    box.sh(`jj edit ${tip} && jj new`, ws);
  });

  test('deploys on every local check on the exact tip, in place of CI', () => {
    assert.match(box.cli(['ci', '--run', 'dark']).err, /deploys on local checks in place of CI/);
    box.cli(['review', 'skip', '--run', 'dark', '--reason', 'the user said to skip review for this test']);
    const before = box.cli(['deploy', 'check', '--run', 'dark']);
    assert.equal(before.code, 1);
    assert.match(before.out, /deploys on local checks in place of CI.*e2e:b has not run/);
    assert.doesNotMatch(before.out, /No CI result/);
    const checked = box.cli(['check', '--run', 'dark', '--tip', tip, '--workspace', ws]);
    assert.equal(checked.code, 0, checked.all);
    const ready = box.cli(['deploy', 'check', '--run', 'dark']);
    assert.equal(ready.code, 0, ready.all);
    const recorded = box.cli(['deploy', 'record', '--run', 'dark', '--name', 'hole', '--shipped', 'the fix', '--backup', 'b', '--health', 'healthy', '--load', '1/1', '--http', '200'], { extra: { NOTES: join(box.root, 'n.txt') } });
    assert.equal(recorded.code, 0, recorded.all);
    assert.equal(box.gate('jj bookmark set ci/hole -r @- && jj git push -b ci/hole', ws).code, 0);
  });
});


describe('abandoning a run', () => {
  const box = sandbox({ config: { ...baseConfig, push: { public: true } } });
  after(() => box.cleanup());

  test('records who and why, frees its files, never deploys, and keeps a live hole private', () => {
    const { ws } = builtRun(box, { intake: ['--live-hole'] });
    assert.match(box.cli(['abandon', '--run', 'dark', '--by', 'owner']).err, /--reason is required/);
    const abandoned = box.cli(['abandon', '--run', 'dark', '--reason', 'the user dropped the toggle', '--by', 'owner']);
    assert.equal(abandoned.code, 0, abandoned.all);
    assert.match(abandoned.out, /abandoned by owner: the user dropped the toggle[\s\S]*still stay off the public remote[\s\S]*jj workspace forget demo-dark/);
    assert.match(box.cli(['abandon', '--run', 'dark', '--reason', 'again', '--by', 'owner']).err, /already abandoned/);
    assert.equal(box.run('dark').events.at(-1).action, 'abandoned');
    box.cli(['intake', '--run', 'two', '--kind', 'fast', '--words', WORDS]);
    box.cli(['spec', '--run', 'two', '--file', '../dark-spec.md']);
    box.sh('jj workspace add --name demo-two ../demo-two -r main');
    const lane = box.cli(['lane', '--run', 'two', '--lane', 'a', '--workspace', join(box.root, 'demo-two'), '--owns', 'src/**']);
    assert.equal(lane.code, 0, lane.all);
    assert.match(box.cli(['deploy', 'check', '--run', 'dark']).out, /was abandoned by owner/);
    assert.doesNotMatch(box.cli(['status']).out, /^dark /m);
    assert.match(box.cli(['status', '--all']).out, /^dark .* abandoned$/m);
    box.cli(['scan', '--run', 'dark'], { cwd: ws });
    assert.match(box.gate('jj bookmark set ci/hole -r @- && jj git push -b ci/hole', ws).err, /was abandoned, but its commits fix a hole/);
  });
});

describe('a live-hole run with a commit no lane made', () => {
  const box = sandbox({ config: { ...baseConfig, push: { public: true } } });
  after(() => box.cleanup());

  test('a copy of the integration commit stays off the public remote too', () => {
    const { ws } = builtRun(box, { intake: ['--live-hole'] });
    const extra = box.commit('chore: integration note', { 'src/extra.mjs': 'export const extra = 1;\n' }, ws);
    const integrated = box.cli(['integrate', '--run', 'dark', '--tip', extra]);
    assert.equal(integrated.code, 0, integrated.all);
    assert.equal(box.cli(['build', '--run', 'dark']).code, 0);
    box.sh(`jj duplicate ${extra} -d main`);
    const copy = box.sh(`jj log --no-graph -r 'children(main) & description(substring:"chore: integration note") ~ ${extra}' -T commit_id`).trim();
    box.sh(`jj bookmark set ci/copy -r ${copy}`);
    const scanned = box.cli(['scan', '--run', 'dark', '--tip', copy]);
    assert.equal(scanned.code, 0, scanned.all);
    assert.match(box.gate('jj git push -b ci/copy', box.repo).err, /Run dark fixes a hole that is live on the deployed server/);
  });
});

describe('the scan reads commits whatever bytes they hold', () => {
  const box = sandbox({ config: baseConfig, local: { scan: { private: ['secret-host.example'] } } });
  after(() => box.cleanup());

  test('a byte that once split records hides nothing: a private string after it is still found', () => {
    const { ws } = builtRun(box);
    box.commit('docs: a framed note', { 'framed.md': 'start\x1e\x1f then secret-host.example\n' }, ws);
    box.commit('docs: a framed message \x1e secret-host.example', {}, ws);
    const result = box.cli(['scan', '--run', 'dark', '--tip', '@-'], { cwd: ws });
    assert.equal(result.code, 1);
    assert.match(result.out, /error private [0-9a-f]{12} framed.md:1: a string from scan.private/);
    assert.match(result.out, /error private [0-9a-f]{12} message: a string from scan.private/);
  });
});

describe('a build recorded while the lane moves', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());

  test('is judged on the run as it is under the lock, not as it was read before', async () => {
    const { ws } = builtRun(box);
    const later = box.commit('fix(ui): a later change no check saw', { 'src/theme.mjs': 'export const dark = () => !false;\n' }, ws);
    // Hold the run's lock, as a pipeline commits in another process would, while the build reads the run.
    const runFile = join(box.env.AGENT_PIPELINE_STATE, 'runs', 'dark.json');
    mkdirSync(`${runFile}.lock`);
    writeFileSync(join(`${runFile}.lock`, 'owner.json'), JSON.stringify({ token: 'test', pid: process.pid, host: hostname() }));
    const child = spawn(process.execPath, [CLI, 'build', '--run', 'dark'], { cwd: box.repo, env: box.env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const exited = new Promise((done) => child.on('exit', done));
    await new Promise((done) => setTimeout(done, 1500));
    const run = JSON.parse(readFileSync(runFile, 'utf8'));
    Object.assign(run.lanes.a, { tip: later });
    run.tip = later;
    writeFileSync(runFile, JSON.stringify(run));
    // Moved aside first, so the waiting build's own lock taking its place is never removed with it.
    renameSync(`${runFile}.lock`, `${runFile}.released`);
    rmSync(`${runFile}.released`, { recursive: true });
    assert.equal(await exited, 1, out);
    assert.match(out, /Build for dark: in-progress/);
    assert.equal(box.run('dark').stages.build.state, 'in-progress');
  });
});

describe('a live-hole run across a rebase', () => {
  const box = sandbox({ config: { ...baseConfig, push: { public: true } } });
  after(() => box.cleanup());
  let ws;
  let moved;
  const LIVE = /fixes a hole that is live on the deployed server/;

  test('counts only checks that ran on the deploy tip, never lane checks copied onto a rebased one', () => {
    ({ ws } = builtRun(box, { intake: ['--live-hole'] }));
    box.cli(['review', 'skip', '--run', 'dark', '--reason', 'the user said to skip review for this test']);
    box.commit('chore: unrelated work on main', { 'other.txt': 'x\n' });
    box.sh('jj bookmark set main -r @- && jj git push --bookmark main');
    box.sh('jj rebase -b @ -d main', ws);
    moved = box.sh('jj log --no-graph -r @- -T commit_id', ws).trim();
    assert.match(box.cli(['rebase', '--run', 'dark', '--tip', moved], { cwd: ws }).out, /2 commits keep their patch-id/);
    assert.ok(box.run('dark').lanes.a.checks.some((result) => result.tip === moved && result.remappedFrom));
    box.cli(['build', '--run', 'dark']);
    box.cli(['scan', '--run', 'dark'], { cwd: ws });
    const before = box.cli(['deploy', 'check', '--run', 'dark']);
    assert.equal(before.code, 1, before.all);
    assert.match(before.out, /deploys on local checks in place of CI.*unit has not run/);
    const checked = box.cli(['check', '--run', 'dark', '--tip', moved, '--workspace', ws]);
    assert.equal(checked.code, 0, checked.all);
    assert.equal(box.cli(['deploy', 'check', '--run', 'dark']).code, 0);
  });

  test('keeps trunk private too: moving main before the deploy is publishing the hole', () => {
    assert.match(box.gate(`jj bookmark set main -r ${moved} && jj git push -b main`, box.repo).err, LIVE);
    assert.match(box.gate(`git push origin ${moved}:refs/heads/main`, box.repo).err, LIVE);
  });

  test('keeps a merge into trunk private too, from a branch or a pull request', () => {
    box.ghScript([{ match: 'pr view 7 ', stdout: { baseRefName: 'main', headRefName: 'ci/hole', headRefOid: moved, isDraft: false } }]);
    assert.match(box.gate('gh pr merge 7 --squash', box.repo).err, LIVE);
    assert.match(box.gate('gh pr merge 7 --auto', box.repo).err, LIVE);
  });
});

describe('a live-hole run whose fix is amended', () => {
  const box = sandbox({ config: { ...baseConfig, push: { public: true } } });
  after(() => box.cleanup());

  test('keeps the commit it recorded before the amend private', () => {
    const { ws, tip } = builtRun(box, { intake: ['--live-hole'] });
    const fix = box.sh(`jj log --no-graph -r '${tip}-' -T commit_id`, ws).trim();
    box.sh(`jj edit ${fix}`, ws);
    box.write('src/theme.mjs', 'export const dark = () => 1 === 1;\n', ws);
    box.sh('jj new && jj edit @- && jj new', ws);
    box.cli(['commits', '--run', 'dark', '--lane', 'a'], { cwd: ws });
    assert.ok(!box.run('dark').lanes.a.commits.some((commit) => commit.id === fix));
    box.cli(['scan', '--run', 'dark', '--tip', fix], { cwd: ws });
    assert.match(box.gate(`jj git push --named ci/old=${fix}`, ws).err, /fixes a hole that is live on the deployed server/);
  });
});

describe('pipeline doctor', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());
  const repoRule = (admin) => ({ match: `api repos/${SLUG}`, stdout: { default_branch: 'main', permissions: { admin, push: true } } });
  const required = [{ context: 'pipeline/scan', integration_id: 1234 }, { context: 'pipeline/ci', integration_id: 1234 }, { context: 'pipeline/review', integration_id: 1234 }];
  const ruleset = (id, target, include, rules, exclude = []) => ({ match: `rulesets/${id}`, stdout: { id, name: `set ${id}`, target, enforcement: 'active', current_user_can_bypass: 'never', conditions: { ref_name: { include, exclude } }, rules } });
  const rulesets = (sets) => [...sets, { match: 'rulesets?', stdout: sets.map((set) => ({ id: set.stdout.id })) }];
  const complete = rulesets([
    ruleset(1, 'branch', ['~DEFAULT_BRANCH'], [{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: required } }, { type: 'non_fast_forward' }, { type: 'deletion' }]),
    ruleset(2, 'branch', ['~ALL'], [{ type: 'non_fast_forward' }, { type: 'deletion' }]),
    ruleset(3, 'tag', ['~ALL'], [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }]),
  ]);
  const environments = (preventSelfReview) => ({ match: 'environments?', stdout: { environments: [{ name: 'production', protection_rules: [{ type: 'required_reviewers', prevent_self_review: preventSelfReview, reviewers: [{ type: 'User' }] }] }] } });
  const hook = join(import.meta.dirname, '..', 'git-hooks', 'pre-push');

  test('finds nothing missing when GitHub and this machine enforce it, and still names what the API cannot show', () => {
    box.sh(`ln -sf ${JSON.stringify(hook)} .git/hooks/pre-push`);
    box.ghScript([...complete, environments(true), repoRule(false)]);
    const result = box.cli(['doctor']);
    assert.equal(result.code, 0, result.all);
    assert.match(result.out, /Nothing missing that doctor can read\. 3 cannot be read from the API/);
    assert.match(result.out, /unverified agents use their own credential/);
    assert.match(result.out, /unverified no release starts a production deploy outside a protected environment/);
    assert.doesNotMatch(result.out, /All present/);
    assert.ok(!box.ghCalls().some((args) => args.includes('-X') || args.includes('--method')), 'doctor only reads');
  });

  // PA-46: rules on sample names, an unrelated required status and self-review allowed.
  test('reads coverage across every ref, the pipeline\'s contexts and self-review, not sample names', () => {
    box.ghScript([...rulesets([
      ruleset(1, 'branch', ['refs/heads/main'], [{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint', integration_id: 9 }, { context: 'e2e' }] } }, { type: 'non_fast_forward' }, { type: 'deletion' }]),
      ruleset(2, 'branch', ['refs/heads/any-branch-name'], [{ type: 'non_fast_forward' }, { type: 'deletion' }]),
      ruleset(3, 'branch', ['~ALL'], [{ type: 'non_fast_forward' }], ['refs/heads/ci/**']),
      ruleset(4, 'tag', ['refs/tags/v1'], [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }]),
    ]), environments(false), repoRule(false)]);
    const result = box.cli(['doctor']);
    assert.equal(result.code, 1);
    for (const missing of [/missing +main requires the pipeline's checks \(pipeline\/scan, pipeline\/ci, pipeline\/review\)\. Require pipeline\/scan, pipeline\/ci, pipeline\/review/, /missing +no branch can be force pushed/, /missing +no branch can be deleted/, /missing +tags can be created/, /missing +the production environment prevents self-review/, /missing +every required check on main names the GitHub App that must set it\. Set the expected source of e2e to its GitHub App/]) assert.match(result.out, missing);
  });

  test('names a production environment no reviewer guards', () => {
    box.ghScript([...complete, { match: 'environments?', stdout: { environments: [{ name: 'production', protection_rules: [] }] } }, repoRule(false)]);
    const result = box.cli(['doctor']);
    assert.equal(result.code, 1);
    assert.match(result.out, /missing +the production environment requires a reviewer\. Add the user as a required reviewer on production/);
  });

  // PA-61: a hook that holds the right words but never runs the pipeline, or is not executable.
  test('accepts only the executable hook install.sh links', () => {
    box.ghScript([...complete, environments(true), repoRule(false)]);
    box.sh("rm -f .git/hooks/pre-push && printf '#!/bin/sh\\n# pipeline git-pre-push\\nexit 0\\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push");
    assert.match(box.cli(['doctor']).out, /unverified \S+ runs the pipeline's pre-push hook\. \S+pre-push is not the hook install\.sh links/);
    box.sh('chmod -x .git/hooks/pre-push');
    assert.match(box.cli(['doctor']).out, /missing +\S+ runs the pipeline's pre-push hook\. \S+pre-push is not executable, so git skips it/);
    box.sh(`rm -f .git/hooks/pre-push && ln -s ${JSON.stringify(hook)} .git/hooks/pre-push`);
    assert.match(box.cli(['doctor']).out, /ok +\S+ runs the pipeline's pre-push hook/);
  });

  // R4 sweep: a ruleset doctor cannot read may be one the token bypasses, and a missing permission is unknown.
  test('says the token cannot bypass and is no admin only from answers it read', () => {
    const listed = complete.filter((rule) => rule.match !== 'rulesets?');
    box.ghScript([...listed, { match: 'rulesets/9', exit: 1, stderr: 'gh: Not Found (HTTP 404)' }, { match: 'rulesets?', stdout: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 9, name: 'hidden' }] }, environments(true), { match: `api repos/${SLUG}`, stdout: { default_branch: 'main' } }]);
    const result = box.cli(['doctor']);
    assert.match(result.out, /unverified +doctor could read every ruleset \(hidden could not be read\)/);
    assert.match(result.out, /unverified +the token in use cannot bypass any ruleset/);
    assert.match(result.out, /unverified +the token in use is not a repository admin/);
    assert.doesNotMatch(result.out, /ok +the token in use/);
  });

  test('names each missing backstop and how to add it, the pre-push hook included', () => {
    box.sh('rm -f .git/hooks/pre-push');
    box.ghScript([{ match: 'rulesets?', stdout: [] }, { match: 'environments?', stdout: { environments: [] } }, repoRule(true)]);
    const result = box.cli(['doctor']);
    assert.equal(result.code, 1);
    for (const missing of [/missing +\S+ runs the pipeline's pre-push hook\. \S+pre-push does not exist\. Run install\.sh --project/, /missing +main requires a pull request/, /missing +no branch can be force pushed/, /missing +tags can be created/, /missing +the token in use is not a repository admin/, /missing +a production environment/]) assert.match(result.out, missing);
  });
});

