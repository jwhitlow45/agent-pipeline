// Resolves where a command runs: the jj workspace, its config, and the run it acts on.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { loadRun } from './ledger.mjs';
import { fail } from './util.mjs';
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

export function repoContext(dir, { configPath, required = true } = {}) {
  const repo = jjRoot(resolve(dir ?? process.cwd()));
  if (!repo) {
    if (required) fail(`Not in a jj repository: ${resolve(dir ?? process.cwd())}. Pass --repo.`);
    return null;
  }
  const main = mainWorkspace(repo);
  const config = loadConfig(repo, { path: configPath, required, localDirs: main && main !== repo ? [main] : [] });
  if (!config) return null;
  return { repo, config, identity: repoIdentity(repo), slug: githubRepo(repo, config.remote), main: main ?? repo };
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
