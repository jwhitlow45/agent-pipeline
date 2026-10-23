// Runs a lane's checks in the set order and records exact results:
//   1. the parallel phase (typecheck, unit tests, build), side by side, each with its own log
//   2. integration tests, one after another, since they share a database
//   3. e2e files one at a time, since they share ports, the database and the machine's memory
// Every log is kept, and counts are read from each log, so a report quotes the numbers, not a summary.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fillTemplate, runLogged, stateDir } from './util.mjs';

export const PHASES = ['parallel', 'integration', 'e2e'];

export function readCounts(text, patterns) {
  const counts = {};
  for (const [name, source] of Object.entries(patterns)) {
    const matches = [...text.matchAll(new RegExp(source, 'gm'))];
    if (matches.length) counts[name] = Number(matches.at(-1)[1]);
  }
  return counts;
}

export const checkPassed = (result) => result.exit === 0 && !(result.counts?.fail > 0);

// The checks a run needs, in order. `e2eFiles` is the touched list, or every configured file.
export function plan(config, e2eFiles) {
  const steps = [
    ...config.checks.parallel.map((check) => ({ phase: 'parallel', name: check.name, command: check.run })),
    ...config.checks.integration.map((check) => ({ phase: 'integration', name: check.name, command: check.run })),
  ];
  if (config.checks.e2e.command) {
    const files = [...new Set([...(e2eFiles ?? config.checks.e2e.files), ...config.checks.e2e.always])];
    for (const file of files) steps.push({ phase: 'e2e', name: `e2e:${file}`, file, command: fillTemplate(config.checks.e2e.command, { file }) });
  }
  return steps;
}

export const logDir = (runId, lane, tip) => join(stateDir(), 'logs', runId, lane, tip.slice(0, 12));

// Keeps the Mac awake for as long as this process runs, where caffeinate exists.
function keepAwake(config) {
  if (!config.checks.keepAwake || process.platform !== 'darwin') return () => {};
  const child = spawn('caffeinate', ['-ims', '-w', String(process.pid)], { stdio: 'ignore' });
  child.on('error', () => {});
  return () => { try { child.kill(); } catch {} };
}

async function runStep(step, { cwd, env, dir, config }) {
  const log = join(dir, `${step.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`);
  const fd = openSync(log, 'w');
  let result;
  let prepare = null;
  try {
    // A file whose preparation failed (a database that did not reset) would test the wrong state, so it fails without running.
    if (step.phase === 'e2e' && config.checks.e2e.beforeEach) {
      prepare = await runLogged(fillTemplate(config.checks.e2e.beforeEach, { file: step.file }), { cwd, env, log: fd, timeoutSec: config.checks.e2e.beforeEachTimeoutSec });
      if (prepare.exit !== 0) writeSync(fd, `\npipeline: checks.e2e.beforeEach exited ${prepare.exit}${prepare.signal ? ` (${prepare.signal}, over ${config.checks.e2e.beforeEachTimeoutSec}s)` : ''}, so ${step.name} did not run.\n`);
    }
    result = prepare?.exit ? prepare : await runLogged(step.command, { cwd, env, log: fd, timeoutSec: step.phase === 'e2e' ? config.checks.e2e.timeoutSec : undefined });
  } finally {
    closeSync(fd);
  }
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return { phase: step.phase, name: step.name, command: step.command, exit: result.exit, ...(prepare?.exit ? { prepareExit: prepare.exit } : {}), counts: readCounts(text, config.checks.resultPatterns), durationMs: result.durationMs + (prepare && !prepare.exit ? prepare.durationMs : 0), log, at: new Date().toISOString() };
}

// Runs every step and calls onResult as each finishes. Stops after a failed phase when
// checks.stopOnFailure is on, but finishes the phase it is in, so every failure of that phase shows.
export async function runChecks(steps, { cwd, env, dir, config, onResult }) {
  mkdirSync(dir, { recursive: true });
  const release = keepAwake(config);
  const results = [];
  try {
    for (const phase of PHASES) {
      const inPhase = steps.filter((step) => step.phase === phase);
      if (!inPhase.length) continue;
      const done = phase === 'parallel'
        ? await Promise.all(inPhase.map((step) => runStep(step, { cwd, env, dir, config }).then((result) => { onResult?.(result); return result; })))
        : [];
      if (phase !== 'parallel') {
        for (const step of inPhase) {
          const result = await runStep(step, { cwd, env, dir, config });
          onResult?.(result);
          done.push(result);
        }
      }
      results.push(...done);
      if (config.checks.stopOnFailure && !done.every(checkPassed)) break;
    }
  } finally {
    release();
  }
  return results;
}

// Whether the recorded results show every planned step passing on the tip, in order. Returns the
// reasons it does not.
export function checkGaps(steps, results) {
  const gaps = [];
  const latest = new Map();
  for (const result of results) latest.set(result.name, result);
  let phaseFailed = null;
  for (const step of steps) {
    const result = latest.get(step.name);
    if (!result) gaps.push(`${step.name} has not run on this tip`);
    else if (!checkPassed(result)) gaps.push(`${step.name} failed (exit ${result.exit}${result.counts?.fail ? `, ${result.counts.fail} failed` : ''}): ${result.log}`);
    if (result && phaseFailed && PHASES.indexOf(step.phase) > PHASES.indexOf(phaseFailed)) gaps.push(`${step.name} ran after ${phaseFailed} failed`);
    if (result && !checkPassed(result)) phaseFailed ??= step.phase;
  }
  // A later phase that ran before an earlier one finished may have run against a broken build.
  for (const step of steps.filter((entry) => entry.phase !== 'parallel')) {
    const result = latest.get(step.name);
    const earlier = steps.filter((entry) => PHASES.indexOf(entry.phase) < PHASES.indexOf(step.phase)).map((entry) => latest.get(entry.name)).filter(Boolean);
    if (result && earlier.some((entry) => entry.at > result.at)) gaps.push(`${step.name} ran before an earlier phase finished`);
  }
  return [...new Set(gaps)];
}
