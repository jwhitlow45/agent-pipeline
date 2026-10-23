// Resolves where a command runs: the jj workspace, its config, and the run it acts on.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONFIG_FILE, loadConfig } from './config.mjs';
import { loadRun } from './ledger.mjs';
import { register } from './registry.mjs';
import { fail, run } from './util.mjs';
import { gitDir, githubRepo, jjRoot, repoIdentity } from './vcs.mjs';

// The main workspace of a colocated repository holds .git, so its folder is where the gitignored
// local config lives for every workspace of it.
function mainWorkspace(root) {
  try {
    const dir = gitDir(root);
    return dir.endsWith('/.git') ? dirname(dir) : null;
  } catch {
    return null;
  }
}

// The config as committed on jj's trunk() (the remote main, master or trunk branch), or null when
// trunk has none. The working copy's own trunk and remote keys are not used to find it, since an
// agent could point them at a branch it pushed itself.
export function committedConfig(repo) {
  const result = run('jj', ['--ignore-working-copy', '--no-pager', 'file', 'show', '-r', 'trunk()', `root-file:${JSON.stringify(CONFIG_FILE)}`], { cwd: repo, allowFail: true });
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      fail(`${CONFIG_FILE} on trunk() is not valid JSON: ${error.message}`);
    }
  }
  if (/No such path/.test(result.stderr ?? '')) return null;
  throw new Error(`Could not read ${CONFIG_FILE} on trunk() in ${repo}: ${(result.stderr || result.error?.message || '').trim()}`);
}

export function repoContext(dir, { configPath, required = true } = {}) {
  const repo = jjRoot(resolve(dir ?? process.cwd()));
  if (!repo) {
    if (required) fail(`Not in a jj repository: ${resolve(dir ?? process.cwd())}. Pass --repo.`);
    return null;
  }
  const main = mainWorkspace(repo);
  const config = loadConfig(repo, { path: configPath, required, localDirs: main && main !== repo ? [main] : [], committed: committedConfig(repo) });
  if (!config) return null;
  const ctx = { repo, config, identity: repoIdentity(repo), slug: githubRepo(repo, config.remote), main: main ?? repo };
  if (config.committed) register(ctx);
  return ctx;
}

// The context the gate acts in: a repository whose trunk has a committed config. Elsewhere the gate
// stays inert, as it does in a repository without the pipeline.
export function gateContext(dir) {
  const ctx = repoContext(dir, { required: false });
  return ctx?.config.committed ? ctx : null;
}

// A run's commands work in the directory given, else the current one when it is the same
// repository, else the folder the run was started in.
export function runContext(opts, { dir } = {}) {
  const run = loadRun(opts.run ?? fail('--run is required.'));
  const candidates = [dir, opts.repo, process.cwd(), run.repo].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const ctx = repoContext(candidate, { configPath: opts.config, required: false });
    if (ctx && ctx.identity === run.identity) return { ...ctx, run };
    if (candidate === dir || candidate === opts.repo) fail(`${candidate} is not a workspace of run ${run.id}'s repository (${run.identity}).`);
  }
  fail(`Could not find a workspace of run ${run.id}'s repository with a pipeline config. Pass --repo.`);
}
