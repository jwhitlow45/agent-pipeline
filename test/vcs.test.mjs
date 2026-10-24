// The version control interface: ranges are values, revisions resolve once, and every operation
// answers the same for the same history.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { range, resolveOne, vcsAt } from '../lib/vcs.mjs';

const ROOT = '0'.repeat(40);

describe('the vcs interface in jj', () => {
  const box = sandbox();
  after(() => box.cleanup());
  // The reads run in this process, so they see the sandbox's jj and git config.
  Object.assign(process.env, box.env);
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
