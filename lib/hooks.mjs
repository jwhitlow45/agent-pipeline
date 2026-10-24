// Hook entry points. Claude Code and Codex run `gate` before each tool call and `mirror-hook` after
// it, with the tool call as JSON on stdin. `exec` does both around one command, for an agent without
// hooks. `git-pre-push` runs the push checks from a git pre-push hook, in any worktree.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { actionContext, mirrorContext } from './context.mjs';
import { checkPush, gateMessage, lineCommands, payloadCommand } from './gate.mjs';
import { mirrorRun } from './mirror.mjs';
import { RegistryError } from './registry.mjs';
import { repositoryOf, TrustError } from './remote.mjs';
import { deployProblems, holeProblems, recordPushes, runForCommit } from './ship.mjs';
import { run, setDeadline } from './util.mjs';
import { gitEnv } from './vcs-git.mjs';

const readPayload = () => JSON.parse(readFileSync(0, 'utf8') || '{}');

// The hook harnesses wait 90 seconds. The gate answers within 60, so a slow remote or GitHub refuses
// instead of timing out, which would let the command run. Tests may shorten it, never lengthen it.
export const GATE_DEADLINE_MS = Math.min(60_000, Number(process.env.PIPELINE_GATE_DEADLINE_MS) || 60_000);

// A hook harness runs the command unless the hook exits 2, so every failure here refuses.
export function cmdGate() {
  setDeadline(GATE_DEADLINE_MS);
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

// The folder a jj or git command acts in: its -R or -C, else where it runs.
function commandDir(argv, cwd) {
  const at = argv.findIndex((word, i) => i > 0 && ['-R', '--repository', '-C'].includes(word));
  const value = at === -1 ? null : argv[at + 1];
  if (!value) return cwd;
  return isAbsolute(value) ? value : cwd === null ? null : resolve(cwd, value);
}

// After a push, records which runs' tips reached the remote and mirrors their stages.
export function afterCommand(payload) {
  const command = payloadCommand(payload);
  if (!command || !/push/.test(command.text.replace(/["'\\]/g, ''))) return [];
  const repos = new Map();
  for (const cmd of lineCommands(command.text, payload.cwd ?? process.cwd())) {
    const argv = cmd.words.map((word) => word.value);
    if (!['jj', 'git'].includes(basename(argv[0] ?? '')) || !argv.includes('push')) continue;
    const dir = commandDir(argv, cmd.cwd);
    const ctx = dir === null ? null : mirrorContext(dir);
    if (!ctx) continue;
    const found = repos.get(ctx.identity) ?? { ctx, named: [] };
    found.named.push(...namedBranches(argv));
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
  setDeadline(GATE_DEADLINE_MS);
  const message = gateMessage(payload);
  setDeadline(null);
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

// Whether git says one commit is an ancestor of another, read in the repository git runs the hook
// in, with git's variables cleared: 0 yes, 1 no, anything else unknown.
const ancestryOf = (repo, ancestor, descendant) => run('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repo, allowFail: true, env: gitEnv({}) }).status;

// git calls the pre-push hook with the remote's name and URL as arguments, and lines of
// "<local ref> <local sha> <remote ref> <remote sha>" on stdin. The URL must reach the repository
// the gate reads, and each remote sha must be what the remote itself reported to the gate, so the
// checks run against the remote as it is.
//
// In plain git the hook runs for the user's own pushes too. PIPELINE_USER_PUSH=1, which the gate
// never lets an agent set, marks one: the agent-only rules (push.branches, the one remote, the scan
// and the user-runs refusal) are skipped, and every push passes but one to trunk, which must still
// be a fast-forward whose commit passes the embargo and the deploy check.
export function cmdGitPrePush(opts) {
  const problems = [];
  const userPush = process.env.PIPELINE_USER_PUSH === '1';
  let ctx;
  try {
    ctx = actionContext(process.cwd());
  } catch (error) {
    if (!(error instanceof TrustError || error instanceof RegistryError)) throw error;
    problems.push(error.message);
  }
  if (ctx) {
    const remote = opts.remote ?? ctx.config.remote;
    const trunkRef = `refs/heads/${ctx.config.trunk}`;
    const lines = readFileSync(0, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' '));
    const checked = userPush ? lines.filter(([, , remoteRef]) => remote === ctx.config.remote && remoteRef === trunkRef) : lines;
    if (!userPush && remote !== ctx.config.remote) problems.push(`agents push only to ${ctx.config.remote}, by name, not ${remote}.`);
    // The user's push is checked only where it moves trunk, an agent's always.
    if ((!userPush || checked.length) && opts.url && repositoryOf(opts.url) !== repositoryOf(ctx.destination.push)) problems.push(`git is pushing to ${opts.url}, not to ${ctx.destination.push}, which the gate checks.`);
    for (const [, localSha, remoteRef, remoteSha] of checked) {
      if (!remoteRef?.startsWith('refs/heads/')) {
        problems.push(`${remoteRef}: agents push only branches.`);
        continue;
      }
      const branch = remoteRef.slice('refs/heads/'.length);
      const remoteTip = !remoteSha || ZERO.test(remoteSha) ? null : remoteSha;
      if (remoteTip !== (ctx.remoteHeads.get(branch) ?? null)) {
        problems.push(`${branch}: git says ${remote} has ${remoteTip?.slice(0, 12) ?? 'nothing'}, but the remote reported ${ctx.remoteHeads.get(branch)?.slice(0, 12) ?? 'nothing'} to the gate. Fetch first, then push again.`);
        continue;
      }
      if (userPush && ZERO.test(localSha)) {
        problems.push(`${branch}: it deletes ${branch}, the trunk. Trunk only moves forward, to a commit a deploy check passes.`);
        continue;
      }
      if (remoteTip && !ZERO.test(localSha)) {
        const ancestry = ancestryOf(ctx.repo, remoteTip, localSha);
        if (ancestry === 1) {
          problems.push(`${branch}: ${remoteTip.slice(0, 12)} on ${remote} is not an ancestor of ${localSha.slice(0, 12)}. That is a force push: push to a new branch name instead.`);
          continue;
        }
        if (ancestry !== 0) {
          problems.push(`${branch}: the hook cannot tell whether ${remoteTip.slice(0, 12)} on ${remote} is an ancestor of the push, since this repository does not have it. Fetch first.`);
          continue;
        }
      }
      if (userPush) {
        problems.push(...[...holeProblems(ctx, localSha), ...deployProblems(ctx, runForCommit(ctx.identity, localSha), localSha).map((problem) => `Moving ${branch} is a deploy step: ${problem}`)].map((problem) => `${branch}: ${problem}`));
        continue;
      }
      const push = { bookmark: branch, target: ZERO.test(localSha) ? null : localSha };
      // Ancestry against the real remote sha was checked above, so the push checks skip their own.
      problems.push(...checkPush(ctx, push, { remoteTip: null }).map((problem) => `${branch}: ${problem}`));
    }
  }
  if (problems.length) {
    process.stderr.write([`Pipeline pre-push check refused this ${userPush ? 'push of yours' : 'push'}:`, ...problems.map((problem) => `  - ${problem}`)].join('\n') + '\n');
    process.exitCode = 1;
  }
}
