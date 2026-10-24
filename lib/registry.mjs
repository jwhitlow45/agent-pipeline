// The repositories on this machine that have a committed pipeline config. Each entry keeps what the
// gate needs before it has read anything else: every clone of the repository on this machine (its
// store, which every jj workspace or git worktree of it shares, and its git folders), the remote
// and trunk its committed config names, its deploy command pattern, and the deploy script
// deploy.command runs, by real path and content hash. A deploy script can live anywhere and be run
// from any folder, so a script is matched to its own repository by what it is, never by its name or
// by which entry comes first.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { withLock, writeJson } from './lock.mjs';
import { expandHome, stateDir } from './util.mjs';
import { detect } from './vcs-detect.mjs';

export const registryPath = () => join(stateDir(), 'repos.json');

// The registry cannot be read. The gate refuses only the lines it would gate, so the user can still
// repair the file, and it says how.
export class RegistryError extends Error {}

export function registeredRepos() {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    return Object.values(JSON.parse(readFileSync(path, 'utf8')).repos ?? {});
  } catch (error) {
    throw new RegistryError(`${path} is not valid JSON (${error.message}). The user deletes it, in a terminal outside the agent: the next pipeline command in each project writes it again.`);
  }
}

// The real path of the store a folder belongs to, found from the folder up without running a
// program: jj's .jj/repo, or git's common folder, which every workspace or worktree shares.
export const storeOf = (dir) => detect(dir).store;

// Every clone of an entry. An entry written before clones were listed has one, at its own path.
export const clonesOf = (entry) => entry.clones ?? (entry.store ? [{ store: entry.store, path: entry.path, worktrees: [], gitDirs: [], backend: 'jj' }] : []);

// Whether a folder's store is one of an entry's clones, or one of their git folders: the common
// folder of a colocated jj repository is its git folder.
export const holdsStore = (entry, store) => Boolean(store) && clonesOf(entry).some((clone) => clone.store === store || (clone.gitDirs ?? []).includes(store));

// The folders of a clone that still hold it: its own folder and its registered worktrees, each one
// that exists and whose store is the clone's. A folder gone, or one that now holds another
// repository, is not the clone.
export const cloneFolders = (clone) => [...new Set([clone.path, ...(clone.worktrees ?? [])])].filter((dir) => {
  if (!dir || !existsSync(dir)) return false;
  const found = detect(dir);
  return found.backend !== null && found.store === clone.store;
});

// Every folder registered for an entry, the legacy path included, that exists. Doctor reads each one,
// so a folder that no longer holds a repository is reported rather than skipped.
export const registeredFolders = (entry) => [...new Set([entry.path, ...clonesOf(entry).flatMap((clone) => [clone.path, ...(clone.worktrees ?? [])])])].filter((dir) => dir && existsSync(dir));

const MAX_SCRIPT = 4 * 1024 * 1024;
const fileHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const INTERPRETERS = /^(sh|bash|zsh|dash|ksh|fish|node|python3?|perl|ruby|bun|deno)$/;

// The script a deploy command runs: its first word, or the first after an interpreter and its
// options (zsh -e deploy.sh), resolved from the main workspace.
export function scriptOf(command, base) {
  const words = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  const first = INTERPRETERS.test(words[0] ?? '') ? words.find((word, i) => i > 0 && !word.startsWith('-')) : words[0];
  if (!first || first.includes('{')) return null;
  const path = expandHome(first);
  const full = isAbsolute(path) ? path : resolve(base, path);
  let real;
  let stat;
  try {
    real = realpathSync(full);
    stat = statSync(real);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  // A script too large or unreadable to hash is still the script, so it is kept by its path.
  let sha256 = null;
  try {
    if (stat.size <= MAX_SCRIPT) sha256 = fileHash(real);
  } catch {
    sha256 = null;
  }
  return { path: real, size: stat.size, sha256 };
}

// The entries whose deploy script a file is, by real path or by content: a copy or a link of the
// script is still the script.
export function deployScriptEntries(file, entries) {
  let real;
  let size;
  try {
    real = realpathSync(file);
    const stat = statSync(real);
    if (!stat.isFile()) return [];
    size = stat.size;
  } catch {
    return [];
  }
  const scripts = (entry) => entry.deployScripts ?? [];
  const byPath = entries.filter((entry) => scripts(entry).some((script) => script.path === real));
  const sameSize = entries.filter((entry) => !byPath.includes(entry) && scripts(entry).some((script) => script.size === size));
  if (!sameSize.length || size > MAX_SCRIPT) return byPath;
  const hash = fileHash(real);
  return [...byPath, ...sameSize.filter((entry) => scripts(entry).some((script) => script.sha256 && script.sha256 === hash))];
}

// The clone a context runs in: its store, its usable folder, and its git folders, which the gate
// protects. In a bare layout `path` is the bare folder, and each worktree that registers is listed.
function cloneOf(ctx) {
  const found = detect(ctx.repo);
  const gitDirs = [found.backend === 'git' ? found.commonDir : null, found.backend === 'git' ? found.gitDir : null, found.backend === 'jj' ? realOrNull(ctx.vcs?.gitDir?.()) : null].filter(Boolean);
  return { store: found.store, path: found.bare ? found.configDir : ctx.main, worktrees: found.bare ? [ctx.repo] : [], gitDirs: [...new Set(gitDirs)], backend: found.backend };
}

const realOrNull = (path) => {
  try {
    return path ? realpathSync(path) : null;
  } catch {
    return null;
  }
};

// Clones are added to and never overwritten, so registering a second clone of a repository keeps
// the first one's protection. A clone whose store is gone is dropped.
function mergeClones(before, clone) {
  const same = (entry) => entry.store === clone.store && entry.path === clone.path;
  const old = before.find(same);
  const merged = old ? { ...old, worktrees: [...new Set([...(old.worktrees ?? []), ...clone.worktrees])].filter((dir) => existsSync(dir)), gitDirs: [...new Set([...(old.gitDirs ?? []), ...clone.gitDirs])], backend: clone.backend } : { ...clone, at: null };
  const kept = before.filter((entry) => same(entry) || (entry.store && existsSync(entry.store)));
  return old ? kept.map((entry) => (same(entry) ? merged : entry)) : [...kept, merged];
}

// Every deploy script the repository has named stays on its entry, so pointing deploy.command (in
// the gitignored local file) somewhere else never frees the old script from the gate.
const entryOf = (ctx, found) => {
  const script = scriptOf(ctx.config.deploy.command, ctx.main);
  const known = (found?.deployScripts ?? []).filter((old) => !script || old.path !== script.path || old.sha256 !== script.sha256);
  const clone = cloneOf(ctx);
  const clones = clone.store ? mergeClones(found ? clonesOf(found) : [], clone) : found ? clonesOf(found) : [];
  // The entry's own path and store are its first clone's, so registering from a second clone does
  // not move them back and forth.
  const first = clones[0] ?? { path: ctx.main, store: clone.store };
  return {
    identity: ctx.identity, slug: ctx.slug ?? null, path: first.path, store: first.store,
    remote: ctx.config.remote, trunk: ctx.config.trunk, deployMatch: ctx.config.deploy.match ?? null,
    deployScripts: [...known, ...(script ? [script] : [])].slice(-20),
    clones,
  };
};

// An entry as it is compared: without the times it was written.
const unstamped = (entry) => JSON.stringify({ ...entry, at: null, clones: (entry.clones ?? []).map((clone) => ({ ...clone, at: null })) });

// Records the repository when its entry changed. Most commands find it unchanged and write nothing.
// An unreadable registry is left for the user to repair.
export function register(ctx) {
  let found;
  try {
    found = registeredRepos().find((candidate) => candidate.identity === ctx.identity);
  } catch (error) {
    if (error instanceof RegistryError) return;
    throw error;
  }
  const entry = entryOf(ctx, found);
  if (found && unstamped(found) === unstamped(entry)) return;
  const path = registryPath();
  withLock(path, () => {
    const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { repos: {} };
    const before = all.repos?.[entry.identity];
    const merged = before ? entryOf(ctx, before) : entry;
    const at = new Date().toISOString();
    all.repos = { ...(all.repos ?? {}), [entry.identity]: { ...merged, clones: merged.clones.map((clone) => ({ ...clone, at: clone.at ?? at })), at } };
    writeJson(path, all);
  });
}
