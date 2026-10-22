// Hook entry points. Claude Code and Codex run `gate` before each shell command and `mirror-hook`
// after it, with the tool call as JSON on stdin. `exec` does both around one command, for an agent
// without hooks. `git-pre-push` runs the push checks from a git pre-push hook.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { repoContext } from './context.mjs';
import { gateMessage } from './gate.mjs';
import { mirrorRun } from './mirror.mjs';
import { payloadCommand, shellSegments, walkCommand } from './shell.mjs';
import { deployProblems, pushProblems, recordPushes, runForCommit } from './ship.mjs';
import { matchesAny } from './util.mjs';
import { remoteBookmarkTarget } from './vcs.mjs';

const readPayload = () => JSON.parse(readFileSync(0, 'utf8') || '{}');

export function cmdGate() {
  const message = gateMessage(readPayload());
  if (message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

// After a push, records which runs' tips reached the remote and mirrors their stages.
export function afterCommand(payload) {
  const command = payloadCommand(payload);
  if (!command || !/\bpush\b/.test(command.text)) return [];
  const repos = new Map();
  walkCommand(command.items ?? shellSegments(command.text), payload.cwd ?? process.cwd(), (words, cwd) => {
    const name = basename(words[0] ?? '');
    const pushed = (name === 'jj' && words.includes('push')) || (name === 'git' && words[1] === 'push');
    if (!pushed || cwd === null) return;
    const ctx = repoContext(cwd, { required: false });
    if (!ctx) return;
    // The branches the push names: jj's --bookmark values, or the destinations of git's refspecs.
    const named = name === 'jj'
      ? words.flatMap((word, i) => (['-b', '--bookmark'].includes(words[i - 1]) ? [word] : word.startsWith('--bookmark=') ? [word.slice(11)] : []))
      : words.slice(2).filter((word) => !word.startsWith('-')).slice(1).map((spec) => spec.split(':').at(-1).replace(/^\+?refs\/heads\//, ''));
    const entry = repos.get(ctx.identity) ?? { ctx, named: [] };
    entry.named.push(...named);
    repos.set(ctx.identity, entry);
  });
  return [...repos.values()].flatMap(({ ctx, named }) => recordPushes(ctx, named).flatMap((run) => mirrorRun(ctx, run)));
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

// git calls the pre-push hook with lines of "<local ref> <local sha> <remote ref> <remote sha>" on stdin.
export function cmdGitPrePush(opts) {
  const ctx = repoContext(process.cwd(), { required: false });
  if (!ctx) return;
  const remote = opts.remote ?? ctx.config.remote;
  if (remote !== ctx.config.remote) {
    process.stderr.write(`Pipeline: agents push only to ${ctx.config.remote}, not ${remote}.\n`);
    process.exitCode = 1;
    return;
  }
  const zero = /^0+$/;
  const problems = [];
  for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
    const [, localSha, remoteRef] = line.split(' ');
    const branch = remoteRef.replace(/^refs\/heads\//, '');
    if (zero.test(localSha)) {
      if (branch === ctx.config.trunk || (!matchesAny(branch, ctx.config.push.branches) && remoteBookmarkTarget(ctx.repo, branch, remote))) problems.push(`${branch}: it deletes a branch agents do not own.`);
      continue;
    }
    const found = branch === ctx.config.trunk
      ? deployProblems(ctx, runForCommit(ctx.identity, localSha), localSha).map((problem) => `moving ${branch} is a deploy step: ${problem}`)
      : pushProblems(ctx, branch, localSha);
    problems.push(...found.map((problem) => `${branch}: ${problem}`));
  }
  if (problems.length) {
    process.stderr.write(['Pipeline pre-push check refused this push:', ...problems.map((problem) => `  - ${problem}`)].join('\n') + '\n');
    process.exitCode = 1;
  }
}
