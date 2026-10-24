// The real git pre-push hook in plain git, from the main worktree and a linked one, the user's own
// push with PIPELINE_USER_PUSH=1, and the hooks doctor reads in every worktree.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseConfig, builtRun, ciScript, sandbox } from './helpers.mjs';

const HOOK = join(import.meta.dirname, '..', 'git-hooks', 'pre-push');
const UNSCANNED = /without a passed pre-push scan/;
const REFUSED = /Pipeline pre-push check refused this/;

// What the remote holds for a branch, read from the bare repository itself.
const onRemote = (box, branch) => box.sh(`git --git-dir=${JSON.stringify(box.bare)} rev-parse --verify --quiet refs/heads/${branch} || true`, box.root).trim() || null;
// A push as a person or a script runs it, through the hook. It throws with git's output when refused.
const push = (box, command, cwd = box.repo, extra = {}) => box.sh(`${command} 2>&1`, cwd, extra);

describe('the pre-push hook in plain git, from every worktree', () => {
  const box = sandbox({ config: baseConfig, backend: 'git' });
  after(() => box.cleanup());
  let ws;
  let tip;

  test('refuses an unscanned push from the main worktree and from a lane worktree', () => {
    ({ ws, tip } = builtRun(box));
    for (const cwd of [ws, box.repo]) assert.throws(() => push(box, `git push origin ${tip}:refs/heads/ci/dark`, cwd), UNSCANNED);
    assert.equal(onRemote(box, 'ci/dark'), null);
  });

  test('allows a scanned push from either', () => {
    assert.equal(box.cli(['scan', '--run', 'dark'], { cwd: ws }).code, 0);
    push(box, 'git push -q origin HEAD:refs/heads/ci/dark', ws);
    assert.equal(onRemote(box, 'ci/dark'), tip);
    push(box, `git push -q origin ${tip}:refs/heads/ci/dark-copy`);
    assert.equal(onRemote(box, 'ci/dark-copy'), tip);
  });

  test('refuses a forced push and an agent\'s push to trunk', () => {
    box.sh('git switch -q -c side main');
    const side = box.commit('feat: a side commit', { 'side.txt': 'x\n' });
    box.sh('git switch -q main');
    assert.throws(() => push(box, `git push --force origin ${side}:refs/heads/ci/dark`), /That is a force push/);
    assert.equal(onRemote(box, 'ci/dark'), tip);
    assert.throws(() => push(box, `git push origin ${tip}:refs/heads/main`, ws), /main: Moving main is a deploy step/);
  });

  // git exports GIT_DIR to a hook in some layouts, and a caller can set GIT_INDEX_FILE. The hook's
  // reads clear both and find the repository from the folder git runs it in.
  test('reads the pushing worktree\'s own repository with git\'s variables set', () => {
    const gitDir = box.sh('git rev-parse --absolute-git-dir', ws).trim();
    const extra = { GIT_DIR: gitDir, GIT_INDEX_FILE: join(box.root, 'no-such-index') };
    push(box, `git push -q origin ${tip}:refs/heads/ci/dark-env`, ws, extra);
    assert.equal(onRemote(box, 'ci/dark-env'), tip);
    const later = box.commit('feat: unscanned', { 'src/later.mjs': 'x\n' }, ws);
    assert.throws(() => push(box, `git push origin ${later}:refs/heads/ci/later`, ws, extra), UNSCANNED);
    box.drop(ws);
  });

  test('doctor reads the hook every worktree runs, and names the marker set where agents run', () => {
    // A relative hooks path, as husky sets, gives each worktree its own hooks folder.
    box.sh('git config core.hooksPath .husky/_');
    mkdirSync(join(box.repo, '.husky', '_'), { recursive: true });
    symlinkSync(HOOK, join(box.repo, '.husky', '_', 'pre-push'));
    const husky = box.addLane('husky');
    mkdirSync(join(husky, '.husky', '_'), { recursive: true });
    writeFileSync(join(husky, '.husky', '_', 'pre-push'), '#!/bin/sh\n. "$(dirname "$0")/h"\n');
    chmodSync(join(husky, '.husky', '_', 'pre-push'), 0o755);
    try {
      const out = box.cli(['doctor']).out;
      assert.match(out, /ok +\S+\/demo runs the pipeline's pre-push hook/);
      assert.match(out, /missing +\S+\/demo-dark runs the pipeline's pre-push hook\. \S+demo-dark\/\.husky\/_\/pre-push does not exist/);
      assert.match(out, /unverified \S+\/husky runs the pipeline's pre-push hook\. \S+husky\/\.husky\/_\/pre-push is not the hook install\.sh links/);
      assert.doesNotMatch(out, /PIPELINE_USER_PUSH/);
      assert.match(box.cli(['doctor'], { extra: { PIPELINE_USER_PUSH: '1' } }).out, /missing +PIPELINE_USER_PUSH is not set where agents run/);
    } finally {
      box.sh('git config --unset core.hooksPath');
    }
  });
});

describe('the user\'s own push in plain git (deploy.runBy user)', () => {
  const box = sandbox({ config: { ...baseConfig, deploy: { ...baseConfig.deploy, runBy: 'user' } }, backend: 'git' });
  after(() => box.cleanup());
  const USER = { PIPELINE_USER_PUSH: '1' };
  let tip;
  let main;

  test('moves trunk only to a commit a deploy check passes, as the deploy check prints it', () => {
    let ws;
    ({ ws, tip } = builtRun(box));
    main = box.sh('git rev-parse main').trim();
    assert.equal(box.cli(['scan', '--run', 'dark'], { cwd: ws }).code, 0);
    push(box, `git push -q origin ${tip}:refs/heads/ci/dark`, ws);
    // An agent's trunk push is the user's, and the user's own fails while the deploy check does.
    assert.throws(() => push(box, `git push origin ${tip}:refs/heads/main`), /The user runs deploys and moves main/);
    assert.throws(() => push(box, `git push origin ${tip}:refs/heads/main`, box.repo, USER), /refused this push of yours:\n[\s\S]*- main: Moving main is a deploy step: No CI result/);
    assert.equal(onRemote(box, 'main'), main);
    box.ghScript(ciScript(tip));
    assert.equal(box.cli(['ci', '--run', 'dark']).code, 0);
    assert.equal(box.cli(['review', 'skip', '--run', 'dark', '--reason', 'the user said to skip review for this test']).code, 0);
    const check = box.cli(['deploy', 'check', '--run', 'dark']);
    assert.equal(check.code, 0, check.all);
    const printed = `PIPELINE_USER_PUSH=1 git push origin ${tip}:refs/heads/main`;
    assert.match(check.out, new RegExp(`The user moves main with: ${printed}`));
    // Through the gate the line is refused, since it sets the marker, which only the user sets.
    assert.match(box.gate(printed).err, /It sets PIPELINE_USER_PUSH/);
    push(box, printed.replace('git push', 'git push -q'));
    assert.equal(onRemote(box, 'main'), tip);
  });

  test('refuses a trunk move that is not a fast-forward, and passes the user\'s other pushes', () => {
    box.sh(`git switch -q -c side ${main}`);
    const side = box.commit('feat: off the old trunk', { 'side.txt': 'x\n' });
    box.sh('git switch -q main');
    // git refuses a non-fast-forward itself, and the hook refuses it even when forced.
    assert.throws(() => push(box, `git push origin ${side}:refs/heads/main`, box.repo, USER), /non-fast-forward/);
    assert.throws(() => push(box, `git push --force origin ${side}:refs/heads/main`, box.repo, USER), /is not an ancestor of .*That is a force push/);
    assert.equal(onRemote(box, 'main'), tip);
    // A branch outside push.branches and an unscanned commit: agent rules the marker skips.
    push(box, `git push -q origin ${side}:refs/heads/feature`, box.repo, USER);
    assert.equal(onRemote(box, 'feature'), side);
    assert.throws(() => push(box, `git push origin ${side}:refs/heads/feature-2`), REFUSED);
  });

  test('the marker counts only as PIPELINE_USER_PUSH=1', () => {
    assert.throws(() => push(box, `git push origin ${tip}:refs/heads/feature-3`, box.repo, { PIPELINE_USER_PUSH: 'yes' }), /feature-3 is not a branch agents push to/);
    assert.equal(onRemote(box, 'feature-3'), null);
    assert.match(box.cli(['gate'], { input: JSON.stringify({ tool_input: { command: `git push origin ${tip}:refs/heads/ci/x` }, cwd: box.repo }), extra: USER }).err, /PIPELINE_USER_PUSH is set in the environment the agent runs in/);
  });
});
