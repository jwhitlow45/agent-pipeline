// The version control interface: ranges are values, revisions resolve once, and every operation
// answers the same for the same history.

import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildHistory } from './fixtures/history.mjs';
import { sandbox } from './helpers.mjs';
import { sameChange } from '../lib/change.mjs';
import { range, resolveOne, RevisionError, vcsAt } from '../lib/vcs.mjs';
import { gitIdStatesIn, where } from '../lib/vcs-git.mjs';

const ROOT = '0'.repeat(40);

describe('the vcs interface in jj', () => {
  const box = sandbox();
  after(() => box.cleanup());
  // The reads run in this process, so they see the sandbox's jj and git config.
  Object.assign(process.env, box.env);
  before(() => Object.assign(process.env, box.env));
  const head = (cwd = box.repo) => box.sh('jj log --no-graph -r @- -T commit_id', cwd).trim();
  const merge = (parents, message) => {
    box.sh(`jj new ${parents.join(' ')} -m "$MESSAGE" && jj new`, box.repo, { MESSAGE: message });
    return head();
  };
  const scaffold = head();
  const base = box.commit('feat: base', { 'a.txt': 'a\n' });
  const x1 = box.commit('feat: x one', { 'x.txt': 'x\n' });
  box.sh(`jj new ${base}`);
  const y1 = box.commit('feat: y one', { 'y.txt': 'y\n' });
  // Criss-cross: each side merges the other, so the two merges share two best common ancestors.
  const x2 = merge([x1, y1], 'merge: x two');
  const y2 = merge([y1, x1], 'merge: y two');
  const vcs = vcsAt(box.repo);

  test('a range with nothing to leave out still leaves out jj\'s root, which has no git object', () => {
    const ids = vcs.commitIds(range(base));
    assert.deepEqual(ids, [base, scaffold]);
    assert.ok(!ids.includes(ROOT));
    assert.deepEqual(vcs.listCommits(range(base)).map((commit) => commit.id), [scaffold, base]);
  });

  test('criss-cross history forks at every common ancestor, and a range leaves out each of them', () => {
    assert.deepEqual(new Set(vcs.forkPoint(x2, y2)), new Set([x1, y1]));
    assert.deepEqual(vcs.commitIds(range(x2, vcs.forkPoint(x2, y2))), [x2]);
    assert.deepEqual(new Set(vcs.commitIds(range([x2, y2], [base]))), new Set([x2, y2, x1, y1]));
  });

  test('ancestry, existence and resolving a typed revision', () => {
    assert.equal(vcs.isAncestor(base, x2), true);
    assert.equal(vcs.isAncestor(x2, base), false);
    assert.equal(vcs.isAncestor(base, null), false);
    assert.equal(vcs.exists(x1), true);
    assert.equal(vcs.exists('f'.repeat(40)), false);
    assert.equal(resolveOne(vcs, x1.slice(0, 12)), x1);
    assert.throws(() => resolveOne(vcs, `${x1} | ${y1}`, '--tip both'), /--tip both must resolve to exactly one commit, found 2/);
    assert.throws(() => resolveOne(vcs, 'no-such-name', '--tip x'), /--tip x is not a revision here/);
  });

  test('a trunk never pushed forks at jj\'s root', () => {
    assert.deepEqual(vcs.forkPoint(x1, null), [ROOT]);
  });
});

describe('one history read by jj colocated, jj not colocated and plain git', () => {
  const box = sandbox();
  after(() => box.cleanup());
  Object.assign(process.env, box.env);
  before(() => Object.assign(process.env, box.env));
  const ids = buildHistory(box);
  const plainGit = join(box.root, 'plain-git');
  const plainJj = join(box.root, 'plain-jj');
  box.sh(`git clone -q ${JSON.stringify(box.bare)} ${JSON.stringify(plainGit)}`, box.root);
  box.sh(`jj git clone --no-colocate ${JSON.stringify(box.bare)} ${JSON.stringify(plainJj)} 2>/dev/null`, box.root);
  const backends = { jj: vcsAt(box.repo), 'jj-plain': vcsAt(plainJj), git: vcsAt(plainGit) };
  const tips = [ids.conflictMerge, ids.x2, ids.y2, ids.orphan];
  // A record as every backend must give it. Order is only for display, and the patch id is each
  // backend's own kind.
  const shape = (commit) => ({ id: commit.id, signature: commit.signature, empty: commit.empty, parents: commit.parents, description: commit.description, files: [...commit.files].sort((a, b) => a.path.localeCompare(b.path)) });
  const byId = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  const records = Object.fromEntries(Object.entries(backends).map(([name, vcs]) => [name, vcs.listCommits(range(tips))]));
  // The normalized git ids, read the way the jj backend reads them: an empty diff or an octopus
  // merge has none.
  const gitIds = (name) => new Map([...gitIdStatesIn(where(backends[name].dir, backends[name].gitDir()), records[name].map((commit) => commit.id))].filter(([, state]) => !['empty', 'unsupported'].includes(state)));

  test('the backends are the ones the folders call for', () => {
    assert.deepEqual(Object.values(backends).map((vcs) => vcs.backend), ['jj', 'jj', 'git']);
  });

  test('every record agrees but the change id and the kind of patch id', () => {
    const want = byId(records.jj).map(shape);
    assert.equal(want.length, 21);
    for (const name of ['jj-plain', 'git']) assert.deepEqual(byId(records[name]).map(shape), want, name);
    assert.ok(records.jj.every((commit) => /^[k-z]{32}$/.test(commit.changeId)));
    assert.ok(records.git.every((commit) => commit.changeId === null));
  });

  test('the normalized git id is the same in every backend, and is the git backend\'s own', () => {
    const want = gitIds('jj');
    for (const name of ['jj-plain', 'git']) assert.deepEqual(gitIds(name), want, name);
    for (const commit of records.git) assert.equal(commit.patchId, want.get(commit.id) ?? null, commit.description);
  });

  test('jj\'s own patch id is read as before', () => {
    const list = records.jj.filter((commit) => !commit.empty).map((commit) => commit.id);
    const patches = box.sh(`jj log --no-graph -r '${list.join(' | ')}' -T '"commit " ++ commit_id ++ "\\n"' -p --git`);
    const before = new Map(spawnSync('git', ['patch-id', '--verbatim'], { input: patches, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((line) => line.split(' ').reverse()));
    for (const commit of records.jj) assert.equal(commit.patchId, before.get(commit.id) ?? null, commit.description);
  });

  test('the two kinds of id differ for reordered functions and a conflicted merge, and agree for plain edits', () => {
    const git = gitIds('jj');
    const jjId = (id) => records.jj.find((commit) => commit.id === id).patchId;
    for (const id of [ids.reorder, ids.conflictMerge]) assert.notEqual(jjId(id), git.get(id));
    for (const id of [ids.modify, ids.addDelete, ids.renameEdit, ids.mode, ids.noNewline, ids.cFile, ids.pureRename, ids.binary, ids.base]) assert.equal(jjId(id), git.get(id));
  });

  test('ranges, fork points, ancestry, presence and files agree', () => {
    const want = new Set(backends.jj.commitIds(range(tips)));
    assert.ok(!want.has(ROOT));
    for (const [name, vcs] of Object.entries(backends)) {
      assert.deepEqual(new Set(vcs.commitIds(range(tips))), want, name);
      assert.deepEqual(new Set(vcs.forkPoint(ids.x2, ids.y2)), new Set([ids.x1, ids.y1]), name);
      assert.deepEqual(vcs.commitIds(range(ids.x2, vcs.forkPoint(ids.x2, ids.y2))), [ids.x2], name);
      assert.equal(vcs.isAncestor(ids.base, ids.x2), true, name);
      assert.equal(vcs.isAncestor(ids.orphan, ids.x2), false, name);
      assert.equal(vcs.exists(ids.orphan), true, name);
      assert.equal(vcs.exists('f'.repeat(40)), false, name);
      assert.deepEqual(vcs.filesAt(ids.conflictMerge).sort(), backends.jj.filesAt(ids.conflictMerge).sort(), name);
      assert.equal(vcs.isOnRemote(ids.x1, 'origin'), true, name);
      // A clone's origin/HEAD sorts before every branch, and names no branch of its own.
      assert.equal(vcs.isOnRemote(ids.base, 'origin'), true, name);
      assert.deepEqual(vcs.remoteBranches('origin').map((entry) => `${entry.name} ${entry.target}`).sort(), [`main ${ids.conflictMerge}`, `orphan ${ids.orphan}`, `x2 ${ids.x2}`, `y2 ${ids.y2}`], name);
      assert.equal(resolveOne(vcs, ids.x1.slice(0, 12)), ids.x1, name);
    }
  });

  test('git resolves exactly one commit, and nothing else passes for one', () => {
    const git = backends.git;
    assert.deepEqual(git.revisions('HEAD'), [ids.conflictMerge]);
    // rev-parse --verify exits 0 for ^HEAD and prints ^<id>.
    assert.throws(() => git.revisions('^HEAD'), RevisionError);
    assert.throws(() => git.revisions('no-such-branch'), RevisionError);
    const tree = box.sh('git rev-parse HEAD^{tree}', plainGit).trim();
    assert.equal(git.exists(tree), false);
    assert.throws(() => resolveOne(git, tree, '--tip tree'), /--tip tree is not a revision here/);
  });

  test('git gives every commit\'s pinned diff for the scan, and none for an empty one', () => {
    const patches = backends.git.commitPatches(range(tips));
    assert.equal(patches.get(ids.empty), '');
    assert.equal(patches.get(ids.x2), '');
    assert.match(patches.get(ids.conflictMerge), /^\+both$/m);
    assert.match(patches.get(ids.nonAscii), /^\+\+\+ b\/naïve résumé\.txt\t?$/m);
  });
});

// A remerge diff labels its conflict markers with each side's short id and subject, which a rebase
// changes, so those labels are left out of the id. A commit that adds such a line holds it as
// content, so the id keeps it.
describe('conflict marker labels in the normalized git id', () => {
  const box = sandbox();
  after(() => box.cleanup());
  Object.assign(process.env, box.env);
  before(() => Object.assign(process.env, box.env));
  const base = box.commit('feat: base', { 'c.txt': 'shared\n' });
  const on = (parents, message, files) => {
    box.sh(`jj new ${parents.join(' ')}`);
    return box.commit(message, files);
  };
  const before1 = on([base], 'docs: a marker line', { 'm.txt': '<<<<<<< before\nx\n' });
  const after1 = on([base], 'docs: a marker line', { 'm.txt': '<<<<<<< after\nx\n' });
  const merge = (onto) => {
    const left = on([onto], 'feat: left side', { 'c.txt': 'left\n' });
    const right = on([onto], 'feat: right side', { 'c.txt': 'right\n' });
    return on([left, right], 'merge: resolve left and right', { 'c.txt': 'both\n' });
  };
  const first = merge(base);
  const moved = merge(on([base], 'feat: base two', { 'd.txt': 'd\n' }));
  const tips = { before1, after1, first, moved };
  for (const [name, id] of Object.entries(tips)) box.sh(`jj bookmark set t-${name.toLowerCase()} -r ${id}`);
  box.sh('jj git push --all --allow-new 2>/dev/null || jj git push --all');
  const clone = join(box.root, 'clone');
  box.sh(`git clone -q ${JSON.stringify(box.bare)} ${JSON.stringify(clone)}`, box.root);
  const records = { jj: vcsAt(box.repo).readCommits(Object.values(tips)), git: vcsAt(clone).readCommits(Object.values(tips)) };
  const record = (backend, id) => records[backend].find((commit) => commit.id === id);

  for (const backend of ['jj', 'git']) {
    test(`two commits that add different marker lines are different changes (${backend})`, () => {
      assert.notEqual(record(backend, before1).gitId, record(backend, after1).gitId);
      assert.equal(sameChange(record(backend, before1), record(backend, after1)), false);
    });

    test(`a conflicted merge made again on moved parents keeps its id (${backend})`, () => {
      assert.ok(record(backend, first).gitId);
      assert.equal(record(backend, moved).gitId, record(backend, first).gitId);
      assert.equal(sameChange(record(backend, first), record(backend, moved)), true);
    });
  }
});

// Each read splits commits by a marker made for that read alone, so a file whose text looks like a
// marker is only text.
describe('git reads split commits only at their own marker', () => {
  const box = sandbox({ backend: 'git' });
  after(() => box.cleanup());
  Object.assign(process.env, box.env);
  before(() => Object.assign(process.env, box.env));
  const main = box.head();
  const other = box.commit('feat: other', { 'o.txt': 'other\n' });
  const shaped = box.commit('docs: a line shaped like a marker', { 'm.txt': `pipeline-commit-00000000-0000-4000-8000-000000000000 ${other}\nafter the marker\n`, [`pipeline-commit-00000000-0000-4000-8000-000000000000 ${other}`]: 'a path\n' });
  const vcs = vcsAt(box.repo);
  const tips = range(shaped, main);

  test('the diff after a marker-shaped line is the commit\'s, and the other commit keeps its own', () => {
    const patches = vcs.commitPatches(tips);
    assert.match(patches.get(shaped), /^\+after the marker$/m);
    assert.match(patches.get(other), /^\+other$/m);
    assert.doesNotMatch(patches.get(other), /after the marker/);
  });

  test('both commits keep their files and their ids', () => {
    const records = vcs.listCommits(tips);
    const byId = new Map(records.map((commit) => [commit.id, commit]));
    assert.deepEqual(byId.get(other).files.map((file) => file.path), ['o.txt']);
    assert.deepEqual(byId.get(shaped).files.map((file) => file.path).sort(), ['m.txt', `pipeline-commit-00000000-0000-4000-8000-000000000000 ${other}`].sort());
    assert.ok(byId.get(other).patchId);
    assert.ok(byId.get(shaped).patchId);
    assert.notEqual(byId.get(other).patchId, byId.get(shaped).patchId);
  });
});
