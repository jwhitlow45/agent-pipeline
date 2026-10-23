// Small helpers every module shares: process runs, errors, paths, hashing and globs.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const HOME = homedir();

// A usage error is the caller's mistake, such as a missing flag or a gate that refuses. It exits 64,
// so a hook harness can tell it from a crash.
export class UsageError extends Error {}
export const fail = (message) => { throw new UsageError(message); };

export const now = () => new Date().toISOString();
export const short = (id) => id?.slice(0, 12);
export const expandHome = (path) => (typeof path === 'string' ? path.replace(/^~(?=$|\/)/, HOME) : path);

// Tests point these at temporary folders, so they never read or write the user's real state.
export const stateDir = () => expandHome(process.env.AGENT_PIPELINE_STATE ?? join(HOME, '.local/state/agent-pipeline'));
export const ghCommand = () => process.env.PIPELINE_GH ?? 'gh';

// One deadline for a whole hook call. A hook harness that times out lets the command run (Claude
// Code, unless onFailure is block, and Codex always), so the gate must answer before then: every
// process it starts gets only the time left, and running out refuses.
let deadline = null;
export class DeadlineError extends Error {}
export const setDeadline = (ms) => { deadline = ms === null ? null : Date.now() + ms; };
// The time left before the deadline, in milliseconds, or Infinity when none is set.
export const timeLeft = () => (deadline === null ? Infinity : deadline - Date.now());

export function run(cmd, args, { cwd, input, env, allowFail = false, timeout = 120_000 } = {}) {
  const left = timeLeft();
  if (left <= 0) throw new DeadlineError(`It ran out of time before ${cmd} ${args[0] ?? ''} could run.`);
  const limit = Math.min(timeout, left);
  const result = spawnSync(cmd, args, { cwd, input, env: env ? { ...process.env, ...env } : process.env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, timeout: limit });
  if (result.error?.code === 'ETIMEDOUT' && limit < timeout) throw new DeadlineError(`It ran out of time while ${cmd} ${args[0] ?? ''} ran.`);
  if (!allowFail && (result.status !== 0 || result.error)) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result;
}

// Runs a shell command line with its output in a log file, for checks that run side by side.
export function runLogged(command, { cwd, env, log, timeoutSec }) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log, log], detached: true });
    const timer = timeoutSec ? setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, timeoutSec * 1000) : null;
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      done({ exit: code ?? (signal ? 128 : 1), signal, durationMs: Date.now() - started });
    });
    child.on('error', () => done({ exit: 127, signal: null, durationMs: Date.now() - started }));
  });
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A chat message and a brief wrap and indent the same words differently, so quotes compare with
// whitespace collapsed. Nothing else is normalized: a quote must keep the user's spelling.
export const normalizeWords = (text) => String(text).replace(/\s+/g, ' ').trim();

// Glob to RegExp: `**` crosses folders, `*` and `?` stay inside one. A glob without a slash matches
// a file name anywhere, as in .gitignore.
export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(path, glob) {
  const target = glob.includes('/') ? path : basename(path);
  return globToRegExp(glob).test(target);
}

export const matchesAny = (path, globs) => (globs ?? []).some((glob) => matchesGlob(path, glob));

export const splitList = (value) => (value === undefined || value === true ? [] : String(value).split(',').map((item) => item.trim()).filter(Boolean));

// Fills {name} placeholders. A placeholder with no value stays as it is, so a missing value shows.
export const fillTemplate = (text, values) => String(text).replace(/\{([a-z][a-zA-Z0-9]*)\}/g, (whole, key) => (values[key] === undefined ? whole : String(values[key])));

export const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
