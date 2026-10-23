// A lock for a read-modify-write of a state file, shared by every process on this machine.
//
// mkdir is atomic, so the lock is a folder, and an owner file in it names the process that holds it
// with a token of its own. A lock is broken only when its owner died, and only by moving it aside
// first: one waiter's rename succeeds and every other's fails, so two waiters never both break the
// same lock and both take it.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fail } from './util.mjs';

const LOCK_WAIT_MS = 15_000;
// A holder still alive after this long is taken to be hung. Every section the lock guards takes milliseconds.
const LOCK_HUNG_MS = 10 * 60_000;
// The owner writes its file just after making the folder. A folder with no owner file this old was left by a process that died in between.
const LOCK_ORPHAN_MS = 60_000;

const ownerOf = (lock) => {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
};

function alive(owner) {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function stale(lock, owner) {
  const made = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
  if (made === undefined) return false;
  if (!owner) return Date.now() - made > LOCK_ORPHAN_MS;
  return !alive(owner) || Date.now() - Date.parse(owner.at) > LOCK_HUNG_MS;
}

// Breaks the lock `seen` described. When the lock was taken again since it was read, the waiter has
// moved a live lock aside, so it puts it back.
export function breakLock(lock, seen) {
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  if ((ownerOf(aside)?.token ?? null) === (seen?.token ?? null)) rmSync(aside, { recursive: true, force: true });
  else {
    try {
      renameSync(aside, lock);
    } catch {
      rmSync(aside, { recursive: true, force: true });
    }
  }
}

// Writes a JSON state file in one step. The temp name is unique, so two writers never share one.
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

export function withLock(path, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = ownerOf(lock);
      if (stale(lock, owner)) breakLock(lock, owner);
      else if (Date.now() > deadline) fail(`${path} is locked by another process (${lock}).`);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return fn();
  } finally {
    // A lock broken as stale while this process held it now belongs to someone else, so it stays.
    if (ownerOf(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  }
}
