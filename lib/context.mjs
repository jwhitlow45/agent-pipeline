// Resolves where a command runs: the jj workspace, its config, and the run it acts on.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG_FILE, DEFAULTS, loadConfig } from './config.mjs';
import { loadRun } from './ledger.mjs';
import { register, registeredRepos, RegistryError, storeOf } from './registry.mjs';
import { checkLocalView, committedAt, configHazard, lsRemote, pushDestination, TrustError } from './remote.mjs';
import { fail } from './util.mjs';
import { bookmarkTable, gitDir, githubRepo, jjRoot, repoIdentity } from './vcs.mjs';

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

// Where the trusted config comes from: the remote, the trunk branch on it, that branch's commit, and
// pipeline.config.json as committed there. The remote and trunk start from the registry (what the
// committed config named last time), else origin and the remote's default branch, and are followed
// once to what the committed config itself names. `view` holds the remote's branches: read from the
// remote itself (`live`, for the gate), else jj's last fetch of it (for the CLI, which publishes
// nothing itself). Throws TrustError when a registered repository's policy cannot be found, so its
// gate fails closed.
function trustedConfig(repo, { live, entry }) {
  let remote = entry?.remote ?? 'origin';
  let trunk = entry?.trunk ?? null;
  const seen = [];
  for (let pass = 0; pass < 2; pass++) {
    const view = live ? liveView(repo, remote) : localView(repo, remote);
    const name = trunk ?? view.head ?? 'main';
    const sha = view.heads.get(name) ?? null;
    const committed = sha ? committedAt(repo, sha, CONFIG_FILE) : null;
    seen.push(`${remote}/${name}`);
    const named = { remote: committed?.remote ?? DEFAULTS.remote, trunk: committed?.trunk ?? DEFAULTS.trunk };
    if (!committed || (named.remote === remote && named.trunk === name)) return { remote, trunk: name, sha, committed, view };
    remote = named.remote;
    trunk = named.trunk;
  }
  throw new TrustError(`${CONFIG_FILE} on ${seen[0]} names ${seen[1]} as the remote and trunk, but the copy there names another. Make the committed remote and trunk keys agree.`);
}

function liveView(repo, remote) {
  const destination = pushDestination(repo, remote);
  return { ...lsRemote(repo, destination.fetch), destination };
}

function localView(repo, remote) {
  const heads = new Map([...bookmarkTable(repo, remote).remote].filter(([, entry]) => entry.target).map(([name, entry]) => [name, entry.target]));
  return { heads, tags: new Map(), head: null, destination: null };
}

function registryEntry(repo, identity) {
  const entries = registeredRepos();
  const store = storeOf(repo);
  return entries.find((entry) => entry.identity === identity) ?? entries.find((entry) => store && entry.store === store) ?? null;
}

export function repoContext(dir, { configPath, required = true } = {}) {
  const repo = jjRoot(resolve(dir ?? process.cwd()));
  if (!repo) {
    if (required) fail(`Not in a jj repository: ${resolve(dir ?? process.cwd())}. Pass --repo.`);
    return null;
  }
  const main = mainWorkspace(repo);
  const identity = repoIdentity(repo);
  let entry = null;
  try {
    entry = registryEntry(repo, identity);
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
  }
  const hazard = configHazard(repo, { readsOnly: true });
  if (hazard) fail(hazard);
  let found;
  try {
    found = trustedConfig(repo, { live: false, entry });
  } catch (error) {
    if (error instanceof TrustError) fail(error.message);
    throw error;
  }
  const config = loadConfig(repo, { path: configPath, required, localDirs: main && main !== repo ? [main] : [], committed: found.committed });
  if (!config) return null;
  config.trunkSha = found.trunk === config.trunk && found.remote === config.remote ? found.sha : null;
  const ctx = { repo, config, identity, slug: githubRepo(repo, config.remote), main: main ?? repo };
  if (config.committed) register(ctx);
  return ctx;
}

// The context the post-push mirror records in: a repository whose trunk has a committed config, read
// from jj's view of the remote. Elsewhere, or when the repository cannot be read, it records nothing.
export function mirrorContext(dir) {
  try {
    const ctx = repoContext(dir, { required: false });
    return ctx?.config.committed ? ctx : null;
  } catch {
    return null;
  }
}

// The context a push, a deploy or a merge is checked in, or null for a repository without the
// pipeline. Everything the checks trust comes from the remote: its branches, read with one git
// ls-remote at the address a push really reaches, and the config committed at its trunk. jj's and
// git's record of the remote must agree with it, and no alias may change the gate's reads. A
// repository registered here, or holding a config file, whose policy cannot be read is refused,
// never left ungated.
export function actionContext(dir) {
  const repo = jjRoot(resolve(dir));
  if (!repo) return null;
  const main = mainWorkspace(repo) ?? repo;
  const identity = repoIdentity(repo);
  const entry = registryEntry(repo, identity);
  const expected = Boolean(entry) || existsSync(join(repo, CONFIG_FILE));
  let found;
  try {
    found = trustedConfig(repo, { live: true, entry });
  } catch (error) {
    if (error instanceof TrustError && !expected) return null;
    throw error;
  }
  if (!found.committed) {
    if (entry) throw new TrustError(`This repository is registered with the pipeline, but ${CONFIG_FILE} is not committed on ${found.remote}/${found.trunk}${found.sha ? ` (${found.sha.slice(0, 12)})` : ', which does not exist'}. The gate refuses until the policy is back on trunk.`);
    return null;
  }
  const hazard = configHazard(repo);
  if (hazard) throw new TrustError(hazard);
  checkLocalView(repo, found.remote, found.view);
  const config = loadConfig(repo, { required: false, localDirs: main !== repo ? [main] : [], committed: found.committed });
  config.trunkSha = found.sha;
  config.remoteShas = [...new Set(found.view.heads.values())];
  const ctx = { repo, config, identity, slug: githubRepo(repo, config.remote), main, remoteHeads: found.view.heads, remoteTags: found.view.tags, destination: found.view.destination };
  register(ctx);
  return ctx;
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
