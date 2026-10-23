// A lock for a read-modify-write of a state file, shared by every process on this machine.
//
// The lock is a folder holding an owner file with a token of its own. It is created in one step: the
// folder is made with its owner file under a private name, then renamed into place, which fails when
// a lock is already there. So a lock never exists without its owner.
//
// Only two things ever remove a lock: its owner releasing it, and a waiter breaking a lock whose owner
// died. A breaker first takes a guard named for the dead owner's token, then checks again that the
// lock still holds that token, and only then moves it aside. Guards are locks too, so a breaker that
// dies holding one is broken the same way. A live owner's lock is never removed, so two processes
// never hold one lock at once. test/lock.test.mjs checks this over every interleaving of three writers.
//
// The steps are one function, `lockStep`, that does at most one file operation per call, so the model
// checker runs the same code as the real lock.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { DeadlineError, fail, timeLeft } from './util.mjs';

const LOCK_WAIT_MS = 15_000;

export const guardOf = (path, token) => `${path}.break-${token}`;

// One step of taking, holding and releasing a lock. `state` is plain data ({ phase, me, target, seen,
// aside, n }), and `io` does the file operations: create, read, rename, remove and alive. Returns the
// next state. `wait: true` means a live process holds what this one needs.
export function lockStep(state, io, lock) {
  const s = { ...state, wait: false };
  const aside = () => `${s.target ?? lock}.aside-${s.me.token}-${(s.n = (s.n ?? 0) + 1)}`;
  switch (s.phase) {
    case 'try':
      return { ...s, phase: io.create(lock, s.me) ? 'held' : 'read' };
    case 'read': {
      const owner = io.read(lock);
      if (!owner) return { ...s, phase: 'try' };
      if (io.alive(owner)) return { ...s, phase: 'try', wait: true };
      return { ...s, phase: 'guard', target: lock, seen: owner.token };
    }
    case 'guard':
      return { ...s, phase: io.create(guardOf(s.target, s.seen), s.me) ? 'verify' : 'readGuard' };
    case 'readGuard': {
      const guard = guardOf(s.target, s.seen);
      const owner = io.read(guard);
      if (!owner) return { ...s, phase: 'try', target: null, seen: null };
      if (io.alive(owner)) return { ...s, phase: 'try', target: null, seen: null, wait: true };
      // The guard's owner died while breaking: break the guard the same way, then start over.
      return { ...s, phase: 'guard', target: guard, seen: owner.token };
    }
    case 'verify':
      return { ...s, phase: io.read(s.target)?.token === s.seen ? 'aside' : 'unguard' };
    case 'aside': {
      const to = aside();
      io.rename(s.target, to);
      return { ...s, phase: 'drop', aside: to };
    }
    case 'drop':
      io.remove(s.aside);
      return { ...s, phase: 'unguard', aside: null };
    case 'unguard': {
      const guard = guardOf(s.target, s.seen);
      const to = aside();
      // This process made the guard and is alive, so nobody else removes it in between.
      if (io.read(guard)?.token === s.me.token) io.rename(guard, to);
      return { ...s, phase: 'unguardDrop', aside: to };
    }
    case 'unguardDrop':
      io.remove(s.aside);
      return { ...s, phase: 'try', target: null, seen: null, aside: null };
    case 'held':
      return { ...s, phase: 'release' };
    case 'release': {
      const to = aside();
      if (io.read(lock)?.token === s.me.token) io.rename(lock, to);
      return { ...s, phase: 'releaseDrop', aside: to };
    }
    case 'releaseDrop':
      io.remove(s.aside);
      return { ...s, phase: 'done', aside: null };
    // Giving up before the lock is held (out of time): undo what this process made and nothing else.
    // The aside it moved a dead lock to, or its own guard moved aside, is removed, and a guard it
    // still holds is moved aside and removed, as a release does.
    case 'abort':
      if (s.aside) io.remove(s.aside);
      return { ...s, phase: 'abortGuard', aside: null };
    case 'abortGuard': {
      const to = aside();
      const guard = s.target && s.seen ? guardOf(s.target, s.seen) : null;
      if (guard && io.read(guard)?.token === s.me.token) io.rename(guard, to);
      return { ...s, phase: 'abortDrop', aside: to };
    }
    case 'abortDrop':
      io.remove(s.aside);
      return { ...s, phase: 'aborted', aside: null, target: null, seen: null };
    default:
      return s;
  }
}

function ownerFile(path) {
  let text;
  try {
    text = readFileSync(join(path, 'owner.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    // A folder with no owner file was left by an older version that made the folder first. Its inode
    // and modification time name it, so a breaker can tell it from a lock taken since.
    const made = statSync(path, { throwIfNoEntry: false });
    return made ? { token: `orphan-${made.ino}-${Math.round(made.mtimeMs)}`, pid: 0, host: hostname() } : null;
  }
  // A lock is renamed into place with its owner file already written, so an owner that does not
  // parse was damaged by hand or by the disk. Reading it as no owner would spin without waiting.
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    owner = null;
  }
  if (!owner || typeof owner.token !== 'string') fail(`${path} holds an owner file that is not a lock owner, so no process can tell who holds it. If no pipeline command is running, remove ${path} by hand.`);
  return owner;
}

// The file system the lock steps act on. Tests pass a wrapped one to stop a breaker mid-break.
export const realIo = {
  create(path, me) {
    const staging = `${path}.new-${me.token}-${randomUUID()}`;
    mkdirSync(staging);
    writeFileSync(join(staging, 'owner.json'), JSON.stringify(me));
    try {
      renameSync(staging, path);
      return true;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(error.code)) return false;
      throw error;
    }
  },
  read: ownerFile,
  rename(from, to) {
    try {
      renameSync(from, to);
      return true;
    } catch {
      return false;
    }
  },
  remove(path) {
    if (path) rmSync(path, { recursive: true, force: true });
  },
  alive(owner) {
    if (owner.host !== hostname()) return true;
    if (!owner.pid) return false;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  },
};

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Writes a JSON state file in one step. The temp name is unique, so two writers never share one.
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

const ownerPid = (lock) => {
  try {
    return realIo.read(lock)?.pid ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

export function withLock(path, fn, { waitMs = LOCK_WAIT_MS, io = realIo } = {}) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const me = { token: randomUUID(), pid: process.pid, host: hostname(), at: new Date().toISOString() };
  const deadline = Date.now() + waitMs;
  let state = { phase: 'try', me };
  // Time is checked on every step, waiting or not, and a hook's own deadline bounds the wait too.
  // Running out mid-break first undoes what this process made, so no guard or aside is left behind.
  const abandon = () => {
    state = { ...state, phase: 'abort' };
    while (state.phase !== 'aborted') state = lockStep(state, io, lock);
  };
  while (state.phase !== 'held') {
    if (timeLeft() <= 0) {
      abandon();
      throw new DeadlineError(`It ran out of time waiting for ${lock}.`);
    }
    if (Date.now() > deadline) {
      abandon();
      fail(`${path} is locked by another process (${lock}, pid ${ownerPid(lock)}).`);
    }
    state = lockStep(state, io, lock);
    if (state.wait) pause(Math.max(1, Math.min(25 + Math.floor(Math.random() * 50), timeLeft())));
  }
  try {
    return fn();
  } finally {
    while (state.phase !== 'done') state = lockStep(state, io, lock);
  }
}
