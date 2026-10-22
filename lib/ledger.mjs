// The run ledger: one JSON file per run (a feature, a batch, a hotfix, a follow-up batch) under
// ~/.local/state/agent-pipeline/runs/. Each stage records the facts it checked and on which commits.
// Parallel lanes write the same run, so every write takes a lock and rereads the file first.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, now, stateDir } from './util.mjs';

export const RUN_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const KINDS = ['feature', 'fast', 'hotfix', 'followups', 'docs'];

export const STAGES = ['intake', 'design', 'decisions', 'build', 'scan', 'push', 'ci', 'review', 'deploy', 'cleanup', 'live-play', 'followups', 'docs'];

const runsDir = () => join(stateDir(), 'runs');
const runPath = (id) => join(runsDir(), `${id}.json`);

export function checkRunId(id) {
  if (!RUN_ID.test(id ?? '')) fail('--run must be 1-40 lowercase letters, digits, or hyphens, starting with a letter.');
  return id;
}

export const runExists = (id) => existsSync(runPath(checkRunId(id)));

export function loadRun(id) {
  checkRunId(id);
  if (!existsSync(runPath(id))) fail(`No run named ${id}. Start it with pipeline intake --run ${id}.`);
  return JSON.parse(readFileSync(runPath(id), 'utf8'));
}

export function loadRuns() {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir()).filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(runsDir(), file), 'utf8')))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const runsFor = (identity) => loadRuns().filter((run) => run.identity === identity);

function save(run) {
  mkdirSync(runsDir(), { recursive: true });
  run.updatedAt = now();
  const temp = `${runPath(run.id)}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(temp, runPath(run.id));
}

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

// mkdir is atomic, so it serves as the lock. A lock older than a minute belongs to a process that died.
function withLock(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(runsDir(), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - statSync(lock, { throwIfNoEntry: false })?.mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) fail(`The run ledger is locked by another process (${lock}).`);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function createRun(run) {
  checkRunId(run.id);
  return withLock(runPath(run.id), () => {
    if (existsSync(runPath(run.id))) fail(`Run ${run.id} already exists. Pick a new name, such as ${run.id}-2.`);
    const created = { createdAt: now(), stages: {}, lanes: {}, events: [], ...run };
    created.events.push({ at: created.createdAt, stage: 'intake', action: 'created' });
    save(created);
    return created;
  });
}

// Rereads the run under the lock, applies the change, and saves it. Returns what the change returned.
export function updateRun(id, change) {
  checkRunId(id);
  return withLock(runPath(id), () => {
    const run = loadRun(id);
    const result = change(run);
    save(run);
    return result;
  });
}

export function setStage(run, stage, fields) {
  run.stages[stage] = { ...(run.stages[stage] ?? {}), ...fields, at: now() };
  run.events.push({ at: now(), stage, action: fields.state ?? 'updated', detail: fields.summary ?? null });
  return run.stages[stage];
}

export const stageState = (run, stage) => run.stages[stage]?.state ?? 'none';
export const passed = (run, stage) => ['passed', 'skipped'].includes(stageState(run, stage));

// Gates name every earlier stage that has not passed, so the refusal says what to do next.
export function requireStages(run, stages, action) {
  const missing = stages.filter((stage) => !passed(run, stage));
  if (missing.length) fail(`${action} needs ${missing.map((stage) => `${stage} (now ${stageState(run, stage)})`).join(', ')} to pass first in run ${run.id}.`);
}
