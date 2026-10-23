// Hook entry points. Claude Code and Codex run `gate` before each shell command and `mirror-hook`
// after it, with the tool call as JSON on stdin. `exec` does both around one command, for an agent
// without hooks. `git-pre-push` runs the push checks from a git pre-push hook.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gateContext } from './context.mjs';
import { checkPush, gateMessage } from './gate.mjs';
import { mirrorRun } from './mirror.mjs';
import { argvCommands, payloadCommand, shellCommands } from './shell.mjs';
import { recordPushes } from './ship.mjs';
import { run } from './util.mjs';

const readPayload = () => JSON.parse(readFileSync(0, 'utf8') || '{}');

// A hook harness runs the command unless the hook exits 2, so every failure here refuses.
export function cmdGate() {
  let message;
  try {
    message = gateMessage(readPayload());
  } catch (error) {
    message = `Pipeline gate could not read the hook's input (${error.message}). Nothing ran.`;
  }
  if (message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

// The branches a push names: jj's --bookmark and --named values, or the destinations of git's refspecs.
function namedBranches(argv) {
  const name = basename(argv[0]);
  if (name === 'jj') {
    return argv.flatMap((word, i) => {
      if (['-b', '--bookmark'].includes(argv[i - 1])) return [word.replace(/^exact:/, '')];
      if (argv[i - 1] === '--named') return [word.split('=')[0]];
      const attached = /^(?:--bookmark=|-b=?)(.+)$/.exec(word) ?? /^--named=([^=]+)=/.exec(word);
      return attached ? [attached[1].replace(/^exact:/, '')] : [];
    });
  }
  const at = argv.indexOf('push');
  return argv.slice(at + 1).filter((word) => !word.startsWith('-')).slice(1).map((spec) => spec.split(':').at(-1).replace(/^\+?refs\/heads\//, ''));
}

// After a push, records which runs' tips reached the remote and mirrors their stages.
export function afterCommand(payload) {
  const command = payloadCommand(payload);
  if (!command || !/push/.test(command.text.replace(/["'\\]/g, ''))) return [];
  const startDir = payload.cwd ?? process.cwd();
  const entries = command.argv ? argvCommands(command.argv, startDir) : shellCommands(command.text, startDir);
  const repos = new Map();
  for (const entry of entries) {
    const name = basename(entry.argv[0] ?? '');
    if (!['jj', 'git'].includes(name) || !entry.argv.includes('push') || entry.cwd === null) continue;
    const ctx = gateContext(entry.cwd);
    if (!ctx) continue;
    const found = repos.get(ctx.identity) ?? { ctx, named: [] };
    found.named.push(...namedBranches(entry.argv));
    repos.set(ctx.identity, found);
  }
  return [...repos.values()].flatMap(({ ctx, named }) => recordPushes(ctx, named).flatMap((entry) => mirrorRun(ctx, entry)));
}

export function cmdMirrorHook() {
  const failures = afterCommand(readPayload()).filter((result) => !result.ok);
  if (failures.length) {
    const context = ['agent-pipeline could not set stage statuses on GitHub:', ...failures.map((failure) => `  ${failure.line}`), 'Retry with: pipeline mirror --run <run>'].join('\n');
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } })}\n`);
  }
}

// pipeline exec -- <command...>: the gate, the command, then the mirror, for agents without hooks.
export function cmdExec(argv) {
  const at = argv.indexOf('--');
  const command = at === -1 ? argv : argv.slice(at + 1);
  if (!command.length) {
    process.stderr.write('Usage: pipeline exec -- <command> [args...]\n');
    process.exitCode = 64;
    return;
  }
  const payload = { tool_input: { command }, cwd: process.cwd() };
  const message = gateMessage(payload);
  if (message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  for (const failure of afterCommand(payload).filter((entry) => !entry.ok)) process.stderr.write(`${failure.line}\n`);
  process.exitCode = result.status ?? 1;
}

const ZERO = /^0+$/;

// git calls the pre-push hook with the remote's name and URL as arguments, and lines of
// "<local ref> <local sha> <remote ref> <remote sha>" on stdin. The remote sha is what the remote
// really holds, so ancestry is checked against it, not against what jj last fetched.
export function cmdGitPrePush(opts) {
  const ctx = gateContext(process.cwd());
  if (!ctx) return;
  const remote = opts.remote ?? ctx.config.remote;
  const problems = [];
  if (remote !== ctx.config.remote) problems.push(`agents push only to ${ctx.config.remote}, by name, not ${remote}.`);
  for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(' ');
    if (!remoteRef?.startsWith('refs/heads/')) {
      problems.push(`${remoteRef}: agents push only branches.`);
      continue;
    }
    const branch = remoteRef.slice('refs/heads/'.length);
    const remoteTip = !remoteSha || ZERO.test(remoteSha) ? null : remoteSha;
    if (remoteTip && !ZERO.test(localSha)) {
      const ancestry = run('git', ['merge-base', '--is-ancestor', remoteTip, localSha], { allowFail: true });
      if (ancestry.status === 1) {
        problems.push(`${branch}: ${remoteTip.slice(0, 12)} on ${remote} is not an ancestor of ${localSha.slice(0, 12)}. That is a force push: push to a new branch name instead.`);
        continue;
      }
      if (ancestry.status !== 0) {
        problems.push(`${branch}: the hook cannot tell whether ${remoteTip.slice(0, 12)} on ${remote} is an ancestor of the push, since this repository does not have it. Fetch first.`);
        continue;
      }
    }
    const push = { bookmark: branch, target: ZERO.test(localSha) ? null : localSha };
    // Ancestry against the real remote sha was checked above, so the push checks skip their own.
    problems.push(...checkPush(ctx, push, { remoteTip: null }).map((problem) => `${branch}: ${problem}`));
  }
  if (problems.length) {
    process.stderr.write(['Pipeline pre-push check refused this push:', ...problems.map((problem) => `  - ${problem}`)].join('\n') + '\n');
    process.exitCode = 1;
  }
}
