import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardOf, lockStep, withLock } from '../lib/lock.mjs';

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

// The model checker: three writers run lockStep over an in-memory file system, in every order, and
// any of them may die at any step. Each state is checked: at most one live writer holds the lock,
// the lock a live holder took is still its own, and a live breaker's guard is still its own. From
// every state reached, the live writers can still all finish.
function explore(initialFs, deadOwners, maxCrashes) {
  const LOCK = 'state.json.lock';
  const writers = ['p1', 'p2', 'p3'];
  const start = { fs: initialFs, crashed: [], procs: writers.map((pid) => ({ phase: 'try', me: { token: pid, pid } })) };
  const key = (state) => JSON.stringify([Object.entries(state.fs).sort(), state.crashed, state.procs]);
  const live = (state, pid) => !state.crashed.includes(pid);
  const check = (state) => {
    const holders = state.procs.filter((proc) => proc.phase === 'held' && live(state, proc.me.pid));
    assert.ok(holders.length <= 1, `two live holders: ${key(state)}`);
    for (const proc of holders) assert.equal(state.fs[LOCK]?.token, proc.me.token, `a live holder lost its lock: ${key(state)}`);
    for (const proc of state.procs.filter((entry) => ['verify', 'aside', 'drop'].includes(entry.phase) && live(state, entry.me.pid))) {
      assert.equal(state.fs[guardOf(proc.target, proc.seen)]?.token, proc.me.token, `a live breaker lost its guard: ${key(state)}`);
    }
  };
  const successors = (state) => {
    const next = [];
    state.procs.forEach((proc, i) => {
      if (proc.phase === 'done' || !live(state, proc.me.pid)) return;
      const fs = { ...state.fs };
      const io = {
        create: (path, me) => (path in fs ? false : ((fs[path] = me), true)),
        read: (path) => fs[path] ?? null,
        rename: (from, to) => (from in fs && !(to in fs) ? ((fs[to] = fs[from]), delete fs[from], true) : false),
        remove: (path) => { delete fs[path]; },
        alive: (owner) => !deadOwners.includes(owner.pid) && !state.crashed.includes(owner.pid),
      };
      const stepped = lockStep(proc, io, LOCK);
      delete stepped.wait;
      next.push({ fs, crashed: state.crashed, procs: state.procs.map((other, k) => (k === i ? stepped : other)) });
      if (state.crashed.length < maxCrashes) next.push({ ...state, crashed: [...state.crashed, proc.me.pid].sort() });
    });
    return next;
  };
  const seen = new Map();
  const edges = new Map();
  const stack = [start];
  seen.set(key(start), start);
  while (stack.length) {
    const state = stack.pop();
    check(state);
    const out = [];
    for (const next of successors(state)) {
      const k = key(next);
      out.push(k);
      if (!seen.has(k)) {
        seen.set(k, next);
        stack.push(next);
      }
    }
    edges.set(key(state), out);
  }
  // Every reached state can still reach one where every live writer is done.
  const finished = (state) => state.procs.every((proc) => proc.phase === 'done' || state.crashed.includes(proc.me.pid));
  const good = new Set([...seen].filter(([, state]) => finished(state)).map(([k]) => k));
  for (let grew = true; grew;) {
    grew = false;
    for (const [k, out] of edges) if (!good.has(k) && out.some((next) => good.has(next))) { good.add(k); grew = true; }
  }
  const stuck = [...seen.keys()].filter((k) => !good.has(k));
  assert.equal(stuck.length, 0, `a state from which the live writers cannot finish: ${stuck[0]}`);
  return seen.size;
}

test('every interleaving of three writers keeps one live holder, with any of them dying at any step', () => {
  const LOCK = 'state.json.lock';
  const states = [
    explore({}, [], 2),
    // A lock left by a writer that died.
    explore({ [LOCK]: { token: 'd0', pid: 'd0' } }, ['d0'], 1),
    // And a breaker that died holding its guard.
    explore({ [LOCK]: { token: 'd0', pid: 'd0' }, [guardOf(LOCK, 'd0')]: { token: 'd1', pid: 'd1' } }, ['d0', 'd1'], 1),
  ];
  for (const count of states) assert.ok(count > 1000, `only ${count} states explored`);
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

test('rounds added to one builtin review at once each keep their own number', async () => {
  const state = fresh();
  const env = { ...process.env, AGENT_PIPELINE_STATE: state };
  const setup = `
    import { DEFAULTS } from ${JSON.stringify(join(LIB, 'config.mjs'))};
    import { builtinRound, builtinStart } from ${JSON.stringify(join(LIB, 'review.mjs'))};
    const config = { ...structuredClone(DEFAULTS), review: { ...DEFAULTS.review, agentReviewLedger: ${JSON.stringify(join(state, 'none'))} } };
    const folder = ${JSON.stringify(join(state, 'design-review'))};
    if (process.argv[1] === 'start') builtinStart({ topic: 'darkdesign', repo: null, folder, words: 'w', config });
    else for (let i = 0; i < 3; i += 1) builtinRound({ topic: 'darkdesign', config });
  `;
  const run = (arg) => new Promise((done, failed) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', setup, arg], { env, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? done() : failed(new Error(`${arg} exited ${code}`))));
  });
  await run('start');
  await Promise.all(Array.from({ length: 6 }, () => run('round')));
  const { rounds } = JSON.parse(readFileSync(join(state, 'reviews', 'darkdesign.json'), 'utf8'));
  assert.deepEqual(rounds.map((round) => round.n), Array.from({ length: 19 }, (_, i) => i + 1));
});
