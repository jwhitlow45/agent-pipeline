// install.sh in a scratch home: it never replaces what it did not make, and the hooks it writes run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;

// A copy of the checkout in a folder whose name has a space and a quote, as a user's path might.
function scratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-install-')));
  const root = join(base, "agent pipeline's copy");
  for (const part of ['install.sh', 'bin', 'lib', 'codex', 'git-hooks', 'skills', 'pipeline.config.example.json', 'package.json']) cpSync(join(REPO, part), join(root, part), { recursive: true });
  const home = join(base, 'home');
  mkdirSync(home);
  const install = (args, extra = {}) => spawnSync('sh', [join(root, 'install.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PIPELINE_BIN_DIR: join(home, 'bin'), CODEX_HOME: join(home, 'codex'), AGENT_PIPELINE_STATE: join(base, 'state'), ...extra },
  });
  return { base, root, home, install };
}

test('a link to nothing where a file would go is kept, and a fresh install links and writes', () => {
  const box = scratch();
  mkdirSync(join(box.home, 'bin'));
  mkdirSync(join(box.home, 'codex'));
  symlinkSync(join(box.base, 'gone'), join(box.home, 'bin', 'pipeline'));
  symlinkSync(join(box.base, 'gone.json'), join(box.home, 'codex', 'hooks.json'));
  const kept = box.install(['--codex']);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /skip: .*bin\/pipeline exists/);
  assert.match(kept.stdout, /skip: .*hooks.json exists/);
  assert.equal(readlinkSync(join(box.home, 'bin', 'pipeline')), join(box.base, 'gone'));
  assert.equal(existsSync(join(box.base, 'gone.json')), false);

  const fresh = scratch();
  const done = fresh.install(['--codex']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readlinkSync(join(fresh.home, 'bin', 'pipeline')), join(fresh.root, 'bin', 'pipeline'));
  assert.match(fresh.install([]).stdout, /ok: .* already links to this checkout/);
  // The hook command runs as written, through the shell, from the quoted path.
  const hooks = JSON.parse(readFileSync(join(fresh.home, 'codex', 'hooks.json'), 'utf8'));
  const command = hooks.hooks.PreToolUse[0].hooks[0].command;
  const ran = spawnSync('sh', ['-c', command], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: fresh.base }), encoding: 'utf8', env: { ...process.env, AGENT_PIPELINE_STATE: join(fresh.base, 'state') } });
  assert.equal(ran.status, 0, ran.stderr);
});

test('another pipeline first on PATH is reported, and so is a hooks folder git does not use', () => {
  const box = scratch();
  const other = join(box.base, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'pipeline'), '#!/bin/sh\n');
  chmodSync(join(other, 'pipeline'), 0o755);
  const project = join(box.base, 'project');
  mkdirSync(project);
  spawnSync('jj', ['git', 'init', '--colocate'], { cwd: project });
  spawnSync('git', ['config', 'core.hooksPath', 'hooks-not-there'], { cwd: project });
  const result = box.install(['--project', project], { PATH: `${other}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`warning: ${other}/pipeline comes first on PATH`));
  assert.match(result.stdout, /warning: no pre-push hook was linked, because .*hooks-not-there does not exist \(core.hooksPath is hooks-not-there\)/);
  assert.match(result.stdout, /jj git push does not run git hooks/);
  assert.equal(existsSync(join(project, 'pipeline.config.json')), true);

  spawnSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: project });
  const linked = box.install(['--project', project]);
  assert.match(linked.stdout, /skip: .*pipeline.config.json exists/);
  assert.equal(readlinkSync(join(project, '.git', 'hooks', 'pre-push')), join(box.root, 'git-hooks', 'pre-push'));
});
