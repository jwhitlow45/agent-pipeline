// The repositories on this machine that have a committed pipeline config, with the deploy command
// pattern each one's trunk sets. A deploy script can live anywhere and be run from any folder (the
// worked example's script sits outside its repository and changes into it itself), so the gate
// matches every command against every registered pattern, not only the one of the folder it runs in.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock } from './lock.mjs';
import { stateDir } from './util.mjs';

const registryPath = () => join(stateDir(), 'repos.json');

export function registeredRepos() {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    return Object.values(JSON.parse(readFileSync(path, 'utf8')).repos ?? {});
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error.message}). Delete it: the next pipeline command in each project writes it again.`);
  }
}

const entryOf = (ctx) => ({ identity: ctx.identity, slug: ctx.slug ?? null, path: ctx.main, deployMatch: ctx.config.deploy.match ?? null });

// Records the repository when its entry changed. Most commands find it unchanged and write nothing.
export function register(ctx) {
  const entry = entryOf(ctx);
  const same = (found) => found && found.path === entry.path && found.slug === entry.slug && found.deployMatch === entry.deployMatch;
  if (same(registeredRepos().find((found) => found.identity === entry.identity))) return;
  const path = registryPath();
  mkdirSync(stateDir(), { recursive: true });
  withLock(path, () => {
    const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { repos: {} };
    current.repos = { ...(current.repos ?? {}), [entry.identity]: { ...entry, at: new Date().toISOString() } };
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`);
    renameSync(temp, path);
  });
}
