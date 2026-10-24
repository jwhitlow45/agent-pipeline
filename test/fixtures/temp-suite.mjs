// A suite that makes sandboxes and then fails, times out or is killed, for the test that checks
// every run leaves the temporary folder as it found it. It runs only from that test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, tempDir } from '../helpers.mjs';

const mode = process.env.TEMP_SUITE_MODE;

test('a sandbox and a failure', () => {
  sandbox();
  // A git sandbox with a lane worktree beside it, which must go too.
  sandbox({ backend: 'git' }).addLane('demo-lane');
  tempDir('pipeline-extra-');
  if (mode === 'kill') process.kill(process.pid, 'SIGTERM');
  if (mode === 'hang') return new Promise(() => {});
  assert.fail('fails on purpose');
});
