import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { breakLock, withLock } from '../lib/lock.mjs';

const LIB = new URL('../lib/', import.meta.url).pathname;
const fresh = () => mkdtempSync(join(tmpdir(), 'pipeline-lock-'));
const hold = (lock, owner) => {
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ host: hostname(), at: new Date().toISOString(), ...owner }));
};
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('a lock whose owner died is broken and taken', () => {
  const path = join(fresh(), 'state.json');
  hold(`${path}.lock`, { token: 'dead', pid: deadPid() });
  assert.equal(withLock(path, () => 'ran', { waitMs: 2000 }), 'ran');
  assert.equal(existsSync(`${path}.lock`), false);
});

test('a lock a live process holds is waited on, then refused', () => {
  const path = join(fresh(), 'state.json');
  hold(`${path}.lock`, { token: 'live', pid: process.pid });
  assert.throws(() => withLock(path, () => 'ran', { waitMs: 200 }), /is locked by another process/);
  assert.equal(JSON.parse(readFileSync(join(`${path}.lock`, 'owner.json'), 'utf8')).token, 'live');
});

test('a waiter that read a stale owner puts back a lock taken since, so two waiters never both take it', () => {
  const lock = join(fresh(), 'state.json.lock');
  hold(lock, { token: 'new', pid: process.pid });
  breakLock(lock, { token: 'old' });
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, 'new');
  breakLock(lock, { token: 'new' });
  assert.equal(existsSync(lock), false);
});

test('a holder whose lock was broken and taken by another leaves the new lock in place', () => {
  const path = join(fresh(), 'state.json');
  withLock(path, () => {
    breakLock(`${path}.lock`, JSON.parse(readFileSync(join(`${path}.lock`, 'owner.json'), 'utf8')));
    hold(`${path}.lock`, { token: 'other', pid: process.pid });
  });
  assert.equal(JSON.parse(readFileSync(join(`${path}.lock`, 'owner.json'), 'utf8')).token, 'other');
});

test('agents adding to one backlog at once keep every item', async () => {
  const state = fresh();
  const script = `
    import { addItem, updateBacklog } from ${JSON.stringify(join(LIB, 'followups.mjs'))};
    const config = { followups: { blockingNeedsDecision: false } };
    for (let i = 0; i < 5; i += 1) updateBacklog('repo', (backlog) => addItem(backlog, { id: process.argv[1] + '-' + i, severity: 'P3', text: 'x' }, config, () => true));
  `;
  const workers = Array.from({ length: 6 }, (_, n) => new Promise((done, failed) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, `w${n}`], { env: { ...process.env, AGENT_PIPELINE_STATE: state }, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? done() : failed(new Error(`worker ${n} exited ${code}`))));
  }));
  await Promise.all(workers);
  const [file] = spawnSync('ls', [join(state, 'followups')], { encoding: 'utf8' }).stdout.trim().split('\n');
  const { items } = JSON.parse(readFileSync(join(state, 'followups', file), 'utf8'));
  assert.equal(items.length, 30);
});
