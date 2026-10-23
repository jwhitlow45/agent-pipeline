// A lock for a read-modify-write of a state file, shared by every process on this machine.

import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail } from './util.mjs';

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

// mkdir is atomic, so it serves as the lock. A lock older than a minute belongs to a process that died.
export function withLock(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - statSync(lock, { throwIfNoEntry: false })?.mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) fail(`${path} is locked by another process (${lock}).`);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
