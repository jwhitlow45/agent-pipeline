import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.mjs';

process.env.AGENT_PIPELINE_STATE = tempDir('pipeline-ledger-');
const { createRun, loadRun, passed, requireStages, setStage, updateRun } = await import('../lib/ledger.mjs');

test('a run is created once, with its intake event', () => {
  createRun({ id: 'first', kind: 'feature', identity: 'github:o/r', intake: { words: 'w' } });
  assert.throws(() => createRun({ id: 'first', kind: 'feature', identity: 'github:o/r' }), /already exists/);
  const run = loadRun('first');
  assert.equal(run.events[0].action, 'created');
  assert.throws(() => loadRun('missing'), /No run named missing/);
  assert.throws(() => createRun({ id: 'Bad Name' }), /--run must be/);
});

test('a stage records its state, and requireStages names every stage that has not passed', () => {
  createRun({ id: 'second', kind: 'feature', identity: 'github:o/r' });
  updateRun('second', (run) => { setStage(run, 'intake', { state: 'passed', summary: 'ok' }); setStage(run, 'design', { state: 'noted' }); });
  const run = loadRun('second');
  assert.equal(passed(run, 'intake'), true);
  assert.equal(passed(run, 'design'), false);
  assert.throws(() => requireStages(run, ['intake', 'design', 'build'], 'A build lane'), /A build lane needs design \(now noted\), build \(now none\) to pass first in run second/);
  assert.equal(run.events.at(-1).stage, 'design');
});

test('parallel writers never lose an update: each write takes the lock and rereads the run', async () => {
  createRun({ id: 'shared', kind: 'feature', identity: 'github:o/r', lanes: {} });
  const writer = (lane) => new Promise((done, fail) => {
    const script = `const { updateRun } = await import(${JSON.stringify(new URL('../lib/ledger.mjs', import.meta.url).href)});
      for (let i = 0; i < 15; i++) updateRun('shared', (run) => { run.lanes[${JSON.stringify(lane)}] = [...(run.lanes[${JSON.stringify(lane)}] ?? []), i]; });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(err))));
  });
  await Promise.all(['a', 'b', 'c', 'd'].map(writer));
  const run = JSON.parse(readFileSync(join(process.env.AGENT_PIPELINE_STATE, 'runs', 'shared.json'), 'utf8'));
  for (const lane of ['a', 'b', 'c', 'd']) assert.equal(run.lanes[lane].length, 15, `lane ${lane} lost writes`);
});
