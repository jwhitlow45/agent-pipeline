// What a lane's folder must be in each backend, the checks' clean check, and the tree a mutation
// check runs in.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forEachBackend } from './backends.mjs';
import { baseConfig, sandbox, SLUG, TEST_FILE, WORDS } from './helpers.mjs';

const started = (box, run) => {
  box.cli(['intake', '--run', run, '--kind', 'fast', '--words', WORDS]);
  box.write(`../${run}-spec.md`, `The user's words: ${WORDS}\n`);
  box.cli(['spec', '--run', run, '--file', `../${run}-spec.md`]);
};
const addLane = (box, run, ws, owns = 'src/**') => box.cli(['lane', '--run', run, '--lane', 'a', '--workspace', ws, '--owns', owns]);

forEachBackend('a lane\'s folder', (backend) => {
  const box = sandbox({ config: baseConfig, backend });
  after(() => box.cleanup());

  test('is the root of a workspace of the run\'s own repository, not a subfolder or a separate clone', () => {
    started(box, 'one');
    const ws = box.addLane('demo-one');
    box.write('sub/x.txt', 'x\n', ws);
    assert.match(addLane(box, 'one', join(ws, 'sub')).err, /is not the root of a (jj workspace|git worktree)/);
    // A separate clone of the same GitHub repository: its commits never reach this one.
    const clone = join(box.root, 'clone');
    const how = backend === 'git' ? `git clone -q https://github.com/${SLUG}.git ${clone}` : `jj git clone ${backend === 'jj' ? '--colocate' : '--no-colocate'} https://github.com/${SLUG}.git ${clone} >/dev/null 2>&1`;
    box.sh(how, box.root);
    assert.match(addLane(box, 'one', clone).err, /is a separate clone of this repository, whose commits never reach the run's repository/);
    const added = addLane(box, 'one', ws);
    assert.equal(added.code, 0, added.all);
  });
});

describe('a lane in git', () => {
  const box = sandbox({ config: baseConfig, backend: 'git' });
  after(() => box.cleanup());

  test('is on a branch of its own: not detached, not trunk and not a branch agents push', () => {
    started(box, 'one');
    const detached = join(box.root, 'detached');
    box.sh(`git worktree add -q --detach ${detached} main`);
    assert.match(addLane(box, 'one', detached).err, /has a detached HEAD\. A lane builds on a branch of its own: git switch -c lane\/one-a in it/);
    assert.match(addLane(box, 'one', box.repo).err, /is on main, the trunk/);
    const pushed = join(box.root, 'pushed');
    box.sh(`git worktree add -q -b ci/wip ${pushed} main`);
    assert.match(addLane(box, 'one', pushed).err, /is on ci\/wip, a branch agents push \(push\.branches\)/);
  });

  test('runs the pipeline\'s pre-push hook, and is warned about a hook the pipeline cannot verify', () => {
    // A relative hooks path gives each worktree its own hooks folder, as husky's does.
    box.sh('git config core.hooksPath .husky/_');
    const ws = box.addLane('hooked');
    assert.match(addLane(box, 'one', ws).err, /This worktree runs hooks from \S*hooked\/\.husky\/_, which lacks the pipeline's pre-push hook \(\S+ does not exist\)/);
    const hook = join(ws, '.husky', '_', 'pre-push');
    mkdirSync(join(ws, '.husky', '_'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    chmodSync(hook, 0o644);
    assert.match(addLane(box, 'one', ws).err, /is not executable, so git skips it/);
    chmodSync(hook, 0o755);
    const added = addLane(box, 'one', ws);
    assert.equal(added.code, 0, added.all);
    assert.match(added.out, /warning: \S+ is not the hook install\.sh links, so it cannot be told whether it runs the pipeline\. Check by hand/);
    box.sh('git config --unset core.hooksPath');
  });

  test('records its branch, and its checks refuse a file git status cannot see', () => {
    const ws = box.addLane('demo-two');
    const added = addLane(box, 'one', ws);
    assert.equal(added.code, 0, added.all);
    assert.match(added.out, /on lane\/demo-two/);
    assert.equal(box.run('one').lanes.a.branch, 'lane/demo-two');
    box.commit('feat(ui): a', { 'src/a.mjs': 'a\n' }, ws);
    assert.equal(box.cli(['commits', '--run', 'one', '--lane', 'a'], { cwd: ws }).code, 0);
    box.sh('git update-index --assume-unchanged src/a.mjs', ws);
    const checked = box.cli(['check', '--run', 'one', '--lane', 'a'], { cwd: ws });
    assert.notEqual(checked.code, 0);
    assert.match(checked.err, /git status cannot see edits to src\/a\.mjs\. Run git update-index --no-assume-unchanged src\/a\.mjs/);
    box.sh('git update-index --no-assume-unchanged src/a.mjs', ws);
    assert.equal(box.cli(['check', '--run', 'one', '--lane', 'a'], { cwd: ws }).code, 0);
  });
});

forEachBackend('the mutation tree', (backend) => {
  const box = sandbox({ config: baseConfig, backend });
  after(() => box.cleanup());

  test('holds the commit\'s export-ignore files and removes the fix whatever diff config says', () => {
    started(box, 'one');
    const ws = box.addLane('demo-one');
    assert.equal(addLane(box, 'one', ws, 'src/**,.gitattributes').code, 0);
    // git archive leaves an export-ignore file out, and porcelain git diff reads diff.noprefix.
    appendFileSync(box.env.GIT_CONFIG_GLOBAL, '[diff]\n\tnoprefix = true\n');
    const fix = box.commit('feat(ui): dark mode toggle', { '.gitattributes': 'src/theme.mjs export-ignore\n', 'src/theme.mjs': 'export const dark = () => true;\n', 'src/theme.test.mjs': TEST_FILE }, ws);
    const commits = box.cli(['commits', '--run', 'one', '--lane', 'a'], { cwd: ws });
    assert.equal(commits.code, 0, commits.all);
    const result = box.cli(['mutation', '--run', 'one', '--lane', 'a', '--commit', fix, '--test', 'src/theme.test.mjs'], { cwd: ws });
    assert.equal(result.code, 0, result.all);
    assert.match(result.out, /passes with the fix, fails without it/);
    // A fix with no export rule: only the removal patch depends on diff config here.
    const second = box.commit('feat(ui): contrast toggle', { 'src/contrast.mjs': 'export const dark = () => true;\n', 'src/contrast.test.mjs': TEST_FILE.replace('./theme.mjs', './contrast.mjs') }, ws);
    assert.equal(box.cli(['commits', '--run', 'one', '--lane', 'a'], { cwd: ws }).code, 0);
    const removed = box.cli(['mutation', '--run', 'one', '--lane', 'a', '--commit', second, '--test', 'src/contrast.test.mjs'], { cwd: ws });
    assert.equal(removed.code, 0, removed.all);
  });

  // A merge's own change is its diff against its first parent here: the remerge diff the records
  // use has no form git apply takes.
  test('removes the fix a merge carries', () => {
    started(box, 'two');
    const ws = box.addLane('demo-two');
    assert.equal(addLane(box, 'two', ws, 'lib/**').code, 0);
    const base = box.head(ws);
    const left = box.commit('feat: a left side file', { 'lib/left.mjs': 'export const left = 1;\n' }, ws);
    if (backend === 'git') {
      box.sh(`git checkout -q -b lane/side ${base}`, ws);
      box.commit('feat: a right side file', { 'lib/right.mjs': 'export const right = 1;\n' }, ws);
      box.sh('git checkout -q lane/demo-two && git merge -q --no-ff --no-commit lane/side', ws);
    } else {
      box.sh(`jj new ${base}`, ws);
      const right = box.commit('feat: a right side file', { 'lib/right.mjs': 'export const right = 1;\n' }, ws);
      box.sh(`jj new ${left} ${right}`, ws);
    }
    const merge = box.commit('feat(ui): dark mode toggle in the merge', { 'lib/theme.mjs': 'export const dark = () => true;\n', 'lib/theme.test.mjs': TEST_FILE }, ws);
    const parents = backend === 'git' ? box.sh(`git rev-list --parents -n1 ${merge}`, ws).trim().split(' ').length - 1 : Number(box.sh(`jj log --no-graph -r ${merge} -T 'parents.len()'`, ws));
    assert.equal(parents, 2);
    const commits = box.cli(['commits', '--run', 'two', '--lane', 'a'], { cwd: ws });
    assert.equal(commits.code, 0, commits.all);
    const result = box.cli(['mutation', '--run', 'two', '--lane', 'a', '--commit', merge, '--test', 'lib/theme.test.mjs'], { cwd: ws });
    assert.equal(result.code, 0, result.all);
    assert.match(result.out, /passes with the fix, fails without it/);
  });
});
