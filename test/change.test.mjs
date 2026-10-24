// One rule for "the same change": its definitions, and the ledger rows that depend on it, from
// review consensus and mutation evidence to the live-hole embargo across clones.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseConfig, builtRun, sandbox } from './helpers.mjs';
import { changeRecord, contentKeys, findSuccessor, fullChangeId, hasContent, holeOpen, sameChange } from '../lib/change.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const CHANGE = 'k'.repeat(32);

describe('the definitions', () => {
  test('content keys are the commit id and every patch id, and a record from before patchIds reads as its patchId', () => {
    assert.deepEqual(contentKeys({ id: A, patchId: 'p1', patchIds: ['p1', 'g1'] }), [`id:${A}`, 'patch:p1', 'patch:g1']);
    assert.deepEqual(contentKeys({ id: A, patchId: 'p1' }), [`id:${A}`, 'patch:p1']);
    assert.deepEqual(contentKeys({ id: null, patchId: null, patchIds: [] }), []);
  });

  test('two records are the same change when they share a commit id or any patch id', () => {
    assert.equal(sameChange({ id: A, patchId: 'p1' }, { id: B, patchIds: ['g1', 'p1'] }), true);
    assert.equal(sameChange({ id: A }, { id: A, patchIds: ['other'] }), true);
    assert.equal(sameChange({ id: A, patchId: 'p1' }, { id: B, patchId: 'p2', patchIds: ['g2'] }), false);
    // A change id is never content: the same change id with another diff is another change.
    assert.equal(sameChange({ id: A, changeId: CHANGE, patchId: 'p1' }, { id: B, changeId: CHANGE, patchId: 'p2' }), false);
    assert.equal(sameChange({ id: null, patchId: null }, { id: null, patchId: null }), false);
  });

  test('findSuccessor locates by full change id first, then by the same change, and never by a short or null id', () => {
    const moved = { id: B, changeId: CHANGE, patchId: 'p9' };
    const copy = { id: 'c'.repeat(40), changeId: null, patchId: 'p1' };
    assert.equal(findSuccessor({ id: A, changeId: CHANGE, patchId: 'p1' }, [copy, moved]), moved);
    assert.equal(findSuccessor({ id: A, changeId: CHANGE.slice(0, 8), patchId: 'p1' }, [moved, copy]), copy);
    assert.equal(findSuccessor({ id: A, changeId: null, patchId: 'p1' }, [{ id: B, changeId: null, patchId: 'p2' }, copy]), copy);
    assert.equal(findSuccessor({ id: A, changeId: null, patchId: 'p7' }, [moved, copy]), null);
    assert.equal(fullChangeId(CHANGE.slice(0, 8)), null);
  });

  test('every ledger site stores one projection', () => {
    assert.deepEqual(changeRecord({ id: A, changeId: CHANGE, patchId: 'p1', patchIds: ['p1', 'g1'], gitId: 'g1', description: 'feat: x\n\nbody' }, { files: ['a'] }), { id: A, changeId: CHANGE, patchId: 'p1', patchIds: ['p1', 'g1'], gitId: 'g1', subject: 'feat: x', files: ['a'] });
    assert.equal(hasContent({ patchId: null, patchIds: [] }), false);
    assert.equal(holeOpen({ liveHole: true, stages: {} }), true);
    assert.equal(holeOpen({ liveHole: true, liveHoleClosed: { by: 'user' }, stages: {} }), false);
    assert.equal(holeOpen({ liveHole: true, stages: { deploy: { state: 'passed' } } }), false);
  });
});

const LIVE = /fixes a hole that is live on the deployed server/;
const LEGACY = /was recorded before git ids existed, and this clone lacks commit/;
const runFile = (box, id) => join(box.env.AGENT_PIPELINE_STATE, 'runs', `${id}.json`);
const editRun = (box, id, change) => {
  const run = JSON.parse(readFileSync(runFile(box, id), 'utf8'));
  change(run);
  writeFileSync(runFile(box, id), JSON.stringify(run, null, 2));
};
// A run as written before git ids and full change ids existed.
const legacy = (run) => {
  delete run.gitIds;
  if (run.history) delete run.history.changeIds;
  for (const lane of Object.values(run.lanes ?? {})) {
    for (const commit of lane.commits) {
      delete commit.patchIds;
      delete commit.gitId;
      commit.changeId = commit.changeId?.slice(0, 8) ?? null;
    }
  }
};

describe('an amend that keeps its jj change id and changes content', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());

  test('loses consensus and mutation evidence, while the lane still finds the commit', () => {
    const { ws } = builtRun(box);
    assert.equal(box.cli(['review', 'skip', '--run', 'dark', '--reason', 'the user said to skip review for this test']).code, 0);
    const before = box.run('dark').lanes.a.commits[0];
    assert.match(box.cli(['review', 'status', '--run', 'dark']).out, /review of main\.\.\S+ for dark: passed/i);
    box.sh(`jj edit ${before.id}`, ws);
    box.write('src/theme.mjs', 'export const dark = () => !false;\n', ws);
    box.sh('jj new && jj edit @- && jj new', ws);
    const tip = box.sh('jj log --no-graph -r @- -T commit_id', ws).trim();
    const rebased = box.cli(['rebase', '--run', 'dark', '--tip', tip], { cwd: ws });
    assert.match(rebased.out, /1 commit changed/, rebased.all);
    const after = box.run('dark').lanes.a.commits[0];
    // findSuccessor found it by its change id, and it carries none of the old evidence.
    assert.equal(after.changeId, before.changeId);
    assert.notEqual(after.id, before.id);
    assert.ok(!after.lost);
    assert.match(box.cli(['review', 'status', '--run', 'dark']).out, /none/);
    const build = box.cli(['build', '--run', 'dark']);
    assert.match(build.out, /adds a test with its fix but has no mutation check/, build.all);
  });
});

describe('the live-hole embargo across clones and backfilled git ids', () => {
  const box = sandbox({ config: { ...baseConfig, push: { public: true } } });
  after(() => box.cleanup());
  let ws;
  let tip;
  let homePush;
  const other = join(box.root, 'other-clone');
  const plain = join(box.root, 'plain-clone');
  const UNSCANNED = /without a passed pre-push scan/;
  // A plain git clone pushes its HEAD by full name.
  const plainPush = 'git push origin HEAD:refs/heads/ci/plain';

  test('a legacy run is refused from a clone that lacks its commits, then allowed after pipeline status in its own repository', () => {
    ({ ws, tip } = builtRun(box, { intake: ['--live-hole'] }));
    editRun(box, 'dark', legacy);
    box.sh(`jj git clone --colocate https://github.com/example-owner/demo.git ${JSON.stringify(other)} >/dev/null 2>&1`, box.root);
    box.commit('feat: unrelated', { 'unrelated.txt': 'x\n' }, other);
    box.sh(`git clone -q https://github.com/example-owner/demo.git ${JSON.stringify(plain)} && cd ${JSON.stringify(plain)} && echo x > plain.txt && git add plain.txt && git commit -q -m "feat: unrelated in git"`, box.root);
    const push = 'jj bookmark set ci/other -r @- && jj git push -b ci/other';
    assert.match(box.gate(push, other).err, LEGACY);
    assert.match(box.gate(push, other).err, UNSCANNED);
    assert.match(box.gate(plainPush, plain).err, LEGACY);
    // The source repository holds every commit, so the gate computes their ids there and refuses
    // nothing for them. The push still reaches the other checks.
    box.sh('jj new main');
    homePush = `jj git push --named ci/home=${box.commit('feat: unrelated at home', { 'home.txt': 'x\n' })}`;
    const home = box.gate(homePush, box.repo).err;
    assert.match(home, UNSCANNED);
    assert.doesNotMatch(home, LEGACY);
    assert.equal(box.cli(['status', '--run', 'dark']).code, 0);
    const states = box.run('dark').gitIds;
    for (const commit of box.run('dark').lanes.a.commits) assert.match(states[commit.id], /^[0-9a-f]{40}$/);
    for (const [command, where] of [[push, other], [plainPush, plain]]) {
      const after = box.gate(command, where).err;
      assert.match(after, UNSCANNED);
      assert.doesNotMatch(after, LEGACY);
    }
  });

  test('empty commits, clean merges and octopus merges reach empty, empty and unsupported, and add no refusal at home', () => {
    box.sh('jj new main -m "chore: empty" && jj new');
    const empty = box.sh('jj log --no-graph -r @- -T commit_id').trim();
    const sides = ['p', 'q', 'r'].map((name) => box.commit(`feat: side ${name}`, { [`${name}.txt`]: `${name}\n` }));
    box.sh(`jj new main ${sides[0]} -m "merge: clean" && jj new`);
    const clean = box.sh('jj log --no-graph -r @- -T commit_id').trim();
    box.sh(`jj new ${sides.join(' ')} -m "merge: octopus" && jj new`);
    const octopus = box.sh('jj log --no-graph -r @- -T commit_id').trim();
    editRun(box, 'dark', (run) => { run.history.ids.push(empty, clean, octopus); });
    box.cli(['status', '--run', 'dark']);
    const states = box.run('dark').gitIds;
    assert.deepEqual([states[empty], states[clean], states[octopus]], ['empty', 'empty', 'unsupported']);
    const home = box.gate(homePush, box.repo).err;
    assert.match(home, UNSCANNED);
    assert.doesNotMatch(home, LEGACY);
    // A clone that lacks the octopus still refuses, and so does a copy of its change made there.
    assert.match(box.gate('jj bookmark set ci/other -r @- && jj git push -b ci/other', other).err, /lacks commit/);
    box.sh('for name in p q r; do echo $name > $name.txt; done && git add -A && git commit -q -m "feat: the octopus copied"', plain);
    assert.match(box.gate(plainPush, plain).err, /lacks commit/);
  });

  test('with the objects gone everywhere the push stays refused until the user waives, and a known patch id still refuses its copy', () => {
    editRun(box, 'dark', (run) => { run.history.ids.push('e'.repeat(40)); });
    assert.match(box.gate(homePush, box.repo).err, /lacks commit eeeeeeeeeeee/);
    assert.equal(box.cli(['live-hole', 'waive', '--run', 'dark', '--by', 'owner', '--reason', 'unrecoverable']).code, 64);
    const waived = box.cli(['live-hole', 'waive', '--run', 'dark', '--by', 'owner', '--reason', 'the user said the old clone is gone for good']);
    assert.equal(waived.code, 0, waived.all);
    assert.ok(box.run('dark').events.some((event) => event.action === 'live hole waived'));
    for (const [command, where] of [[homePush, box.repo], ['jj bookmark set ci/other -r @- && jj git push -b ci/other', other], [plainPush, plain]]) {
      const err = box.gate(command, where).err;
      assert.match(err, UNSCANNED);
      assert.doesNotMatch(err, /lacks commit/);
    }
    // A copy of the fix has new commit ids and the same patch ids.
    box.sh(`jj duplicate ${tip} -d main`, ws);
    const copy = box.sh(`jj log --no-graph -r 'children(main) & description(substring:"docs: dark mode") ~ ${tip}' -T commit_id`, ws).trim();
    assert.match(box.gate(`jj bookmark set ci/copy -r ${copy} && jj git push -b ci/copy`, ws).err, LIVE);
  });

  test('an amended fix with a new commit id and patch id but its old change id is refused in jj', () => {
    const fix = box.run('dark').lanes.a.commits.find((commit) => /dark mode toggle/.test(commit.subject));
    box.sh(`jj new ${fix.id}`, ws);
    box.sh(`jj edit ${fix.id}`, ws);
    box.write('src/theme.mjs', 'export const dark = () => true && true;\n', ws);
    box.sh('jj new', ws);
    const amended = box.sh(`jj log --no-graph -r 'change_id(${box.sh(`jj log --no-graph -r ${fix.id} -T change_id`, ws).trim()})' -T commit_id`, ws).trim();
    assert.notEqual(amended, fix.id);
    assert.match(box.gate(`jj git push --named ci/amended=${amended}`, ws).err, LIVE);
  });

  test('closing the hole is the user\'s, and ends the embargo', () => {
    const closed = box.cli(['live-hole', 'close', '--run', 'dark', '--by', 'owner', '--reason', 'the user fixed it on the server by hand']);
    assert.equal(closed.code, 0, closed.all);
    const err = box.gate(`jj git push --named ci/closed=${tip}`, ws).err;
    assert.doesNotMatch(err, LIVE);
    assert.doesNotMatch(err, /lacks commit/);
  });
});
