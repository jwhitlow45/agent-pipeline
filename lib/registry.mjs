// The repositories on this machine that have a committed pipeline config. Each entry keeps what the
// gate needs before it has read anything else: the jj store every workspace of the repository
// shares, the remote and trunk its committed config names, its deploy command pattern, and the
// deploy script deploy.command runs, by real path and content hash. A deploy script can live
// anywhere and be run from any folder, so a script is matched to its own repository by what it is,
// never by its name or by which entry comes first.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { withLock, writeJson } from './lock.mjs';
import { expandHome, stateDir } from './util.mjs';

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

// The real path of the jj store a folder belongs to, found from the folder up without running jj:
// the main workspace holds .jj/repo as a folder, and each other workspace a file pointing at it.
export function storeOf(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    const pointer = join(current, '.jj', 'repo');
    if (existsSync(pointer)) {
      try {
        const store = statSync(pointer).isFile() ? resolve(join(current, '.jj'), readFileSync(pointer, 'utf8').trim()) : pointer;
        return realpathSync(store);
      } catch {
        return null;
      }
    }
    if (current === dirname(current)) return null;
  }
}

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

// Every deploy script the repository has named stays on its entry, so pointing deploy.command (in
// the gitignored local file) somewhere else never frees the old script from the gate.
const entryOf = (ctx, found) => {
  const script = scriptOf(ctx.config.deploy.command, ctx.main);
  const known = (found?.deployScripts ?? []).filter((old) => !script || old.path !== script.path || old.sha256 !== script.sha256);
  return {
    identity: ctx.identity, slug: ctx.slug ?? null, path: ctx.main, store: storeOf(ctx.repo),
    remote: ctx.config.remote, trunk: ctx.config.trunk, deployMatch: ctx.config.deploy.match ?? null,
    deployScripts: [...known, ...(script ? [script] : [])].slice(-20),
  };
};

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
  if (found && JSON.stringify({ ...found, at: null }) === JSON.stringify({ ...entry, at: null })) return;
  const path = registryPath();
  withLock(path, () => {
    const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { repos: {} };
    const before = all.repos?.[entry.identity];
    const merged = before ? entryOf(ctx, before) : entry;
    all.repos = { ...(all.repos ?? {}), [entry.identity]: { ...merged, at: new Date().toISOString() } };
    writeJson(path, all);
  });
}
