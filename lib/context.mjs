// Resolves where a command runs: the workspace, its config, and the run it acts on.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, DEFAULTS, loadConfig } from './config.mjs';
import { computeGitIds, holeOpen } from './change.mjs';
import { loadRun, loadRuns, updateRun } from './ledger.mjs';
import { holdsStore, register, registeredRepos, RegistryError, storeOf } from './registry.mjs';
import { checkLocalView, committedAt, configHazard, lsRemote, NoRemoteError, pushDestination, TrustError } from './remote.mjs';
import { fail } from './util.mjs';
import { gitRepository, gitSetting, root as workspaceRoot, vcsAt } from './vcs.mjs';
import { detect } from './vcs-detect.mjs';
import { bookmarkTable } from './vcs-jj.mjs';

// Where the gitignored local config lives for every workspace of the repository: in jj the folder
// that holds .jj/repo as a folder, colocated with git or not, in git the main worktree, or a bare
// repository's own folder.
const configFolder = (vcs) => vcs.configDir();

// Where the trusted config comes from: the remote, the trunk branch on it, that branch's commit, and
// pipeline.config.json as committed there. The remote and trunk start from the registry (what the
// committed config named last time), else origin and the remote's default branch, and are followed
// once to what the committed config itself names. `view` holds the remote's branches: read from the
// remote itself (`live`, for the gate), else the last fetch of it (for the CLI, which publishes
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
  const vcs = vcsAt(repo);
  const branches = vcs.backend === 'jj' ? [...bookmarkTable(repo, remote).remote].map(([name, entry]) => [name, entry.target]) : vcs.remoteBranches(remote).map((entry) => [entry.name, entry.target]);
  const heads = new Map(branches.filter(([, target]) => target));
  return { heads, tags: new Map(), head: null, destination: null };
}

function registryEntry(repo, identity) {
  const entries = registeredRepos();
  const store = storeOf(repo);
  return entries.find((entry) => entry.identity === identity) ?? entries.find((entry) => holdsStore(entry, store)) ?? null;
}

export function repoContext(dir, { configPath, required = true } = {}) {
  const repo = workspaceRoot(resolve(dir ?? process.cwd()));
  if (!repo) {
    const refused = detect(resolve(dir ?? process.cwd())).refused;
    if (refused && required) fail(refused);
    if (required) fail(`Not in a jj or git repository: ${resolve(dir ?? process.cwd())}. Pass --repo.`);
    return null;
  }
  const vcs = vcsAt(repo);
  const local = configFolder(vcs);
  // A usable worktree: in a bare layout each worktree is its own clone's, not the bare folder.
  const main = vcs.main() ?? repo;
  const identity = vcs.identity();
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
  const config = loadConfig(repo, { path: configPath, required, localDirs: local && local !== repo ? [local] : [], committed: found.committed });
  if (!config) return null;
  config.trunkSha = found.trunk === config.trunk && found.remote === config.remote ? found.sha : null;
  const ctx = { repo, vcs, config, identity, slug: vcs.slug(config.remote), main };
  if (config.committed) register(ctx);
  backfillGitIds(ctx);
  return ctx;
}

// Live-hole runs recorded before git ids existed get them from the objects this repository holds,
// saved under each run's lock, so a clone that lacks the commits can still match them. A read that
// fails leaves them for a later command, and the gate refuses meanwhile.
function backfillGitIds(ctx) {
  let runs;
  try {
    runs = loadRuns().filter((run) => run.identity === ctx.identity && holeOpen(run));
  } catch {
    return;
  }
  for (const run of runs) {
    try {
      if (!computeGitIds(ctx.vcs, run).size) continue;
      updateRun(run.id, (current) => {
        current.gitIds = { ...(current.gitIds ?? {}), ...Object.fromEntries(computeGitIds(ctx.vcs, current)) };
        return current;
      });
    } catch {
      // Left uncomputed.
    }
  }
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

// A folder no backend reads (a bare repository, or one outside every worktree) may still belong to a
// clone of a pipeline repository. The gate's checks read the remote and the policy through a jj
// workspace or a git worktree, so a push or a merge from such a folder is refused rather than let
// through unchecked.
function plainGitCheck(dir) {
  const found = gitRepository(dir);
  if (!found) return;
  const urls = gitSetting(dir, ['--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
  const slugs = urls.split('\n').map((line) => /github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?\/?$/i.exec(line)?.[1]?.toLowerCase()).filter(Boolean);
  const registered = registeredRepos().some((entry) => entry.slug && slugs.includes(entry.slug.toLowerCase()));
  const holdsConfig = Boolean(found.top) && existsSync(join(found.top, CONFIG_FILE));
  if (registered || holdsConfig) throw new TrustError(`${dir} is in a git repository with the pipeline but in no worktree of it, and the gate checks pushes, merges and deploys only from a jj workspace or a git worktree. Work in a worktree of the repository.`);
}

// The context a push, a deploy or a merge is checked in, or null for a repository without the
// pipeline. Everything the checks trust comes from the remote: its branches, read with one git
// ls-remote at the address a push really reaches, and the config committed at its trunk. jj's and
// git's record of the remote must agree with it, and no alias may change the gate's reads. A
// repository registered here, or holding a config file, whose policy cannot be read is refused,
// never left ungated.
export function actionContext(dir) {
  const repo = workspaceRoot(resolve(dir));
  // A layout no backend reads (a git worktree of a colocated jj repository) is refused. Elsewhere,
  // a bare repository or a folder in none gets the clone check.
  if (!repo) {
    const found = detect(resolve(dir));
    if (found.refused) throw new TrustError(found.refused);
    plainGitCheck(resolve(dir));
    return null;
  }
  const vcs = vcsAt(repo);
  const local = configFolder(vcs) ?? repo;
  const main = vcs.main() ?? repo;
  const identity = vcs.identity();
  const entry = registryEntry(repo, identity);
  const expected = Boolean(entry) || existsSync(join(repo, CONFIG_FILE));
  let found;
  try {
    found = trustedConfig(repo, { live: true, entry });
  } catch (error) {
    // Without the pipeline expected here, only a missing remote proves there is none. A remote that
    // cannot be read, a push that goes elsewhere, a trunk not fetched or a config that does not
    // parse leaves it unknown, so the gate refuses.
    if (error instanceof NoRemoteError && !expected) return null;
    throw error;
  }
  if (!found.committed) {
    if (entry) throw new TrustError(`This repository is registered with the pipeline, but ${CONFIG_FILE} is not committed on ${found.remote}/${found.trunk}${found.sha ? ` (${found.sha.slice(0, 12)})` : ', which does not exist'}. The gate refuses until the policy is back on trunk.`);
    return null;
  }
  const hazard = configHazard(repo, { remote: found.remote });
  if (hazard) throw new TrustError(hazard);
  checkLocalView(repo, found.remote, found.view);
  const config = loadConfig(repo, { required: false, localDirs: local !== repo ? [local] : [], committed: found.committed });
  config.trunkSha = found.sha;
  config.remoteShas = [...new Set(found.view.heads.values())];
  const ctx = { repo, vcs, config, identity, slug: vcs.slug(config.remote), main, remoteHeads: found.view.heads, remoteTags: found.view.tags, remoteHead: found.view.head, destination: found.view.destination };
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
