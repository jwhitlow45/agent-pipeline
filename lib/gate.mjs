// The PreToolUse gate. It reads the shell command an agent is about to run and refuses it when an
// earlier stage has not passed. It only reads: statuses are set after the command, by mirror-hook.
//
// It acts only in repositories with a pipeline.config.json, so installing the hook globally is safe.
// What it gates:
//   - pushes (jj git push, git push): only to push.branches, never a force push or a sideways move,
//     and only commits a passed pre-push scan covered. A push to trunk is a deploy step.
//   - the project's deploy command and deploy workflows: the deploy gate on the exact commit, and
//     never when deploy.runBy is "user". A prod workflow is always refused.
//   - review starts (agent-review start, and the ask that sends round 1): the stage before must
//     have passed, and round 1's request must quote the user's words.
//   - pull requests leaving draft or merging, when the pipeline keeps reviews itself.
//
// A command the gate cannot parse is refused, since the agent can rewrite it more simply.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CONFIG_FILE } from './config.mjs';
import { repoContext } from './context.mjs';
import { pullRequestHead, workflowName } from './github.mjs';
import { loadRuns, passed } from './ledger.mjs';
import { agentReviewEntries, findEntry, provider, reviewCoverage, reviewPassed } from './review.mjs';
import { payloadCommand, shellSegments, walkCommand } from './shell.mjs';
import { deployProblems, pushProblems, runForCommit } from './ship.mjs';
import { matchesAny, normalizeWords, short } from './util.mjs';
import { commitIds, localBookmarkTarget, remoteBookmarkTarget } from './vcs.mjs';

const PROCESS_DOC = 'docs/process.md in the agent-pipeline repository';
const NEVER_PROD = 'Agents never run a production deploy. Give the user the command instead.';

// Values that follow these flags, per command, so they are not read as positional arguments.
const JJ_PUSH_VALUES = new Set(['-b', '--bookmark', '-c', '--change', '-r', '--revisions', '--remote', '--named', '-R', '--repository', '--config', '--at-op', '--at-operation']);
const GIT_PUSH_VALUES = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function flagValues(args, flags, valueFlags) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (flags.includes(name)) values.push(eq !== -1 && arg.startsWith('--') ? arg.slice(eq + 1) : args[i + 1]);
    if (valueFlags.has(arg)) i++;
  }
  return values.filter((value) => value !== undefined);
}

function positionals(args, valueFlags) {
  const found = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { found.push(...args.slice(i + 1)); break; }
    if (valueFlags.has(args[i])) i++;
    else if (!args[i].startsWith('-')) found.push(args[i]);
  }
  return found;
}

// The pushes a jj git push makes, as { bookmark, target } with target null for a deletion. `pending`
// holds bookmarks an earlier part of the same command sets, which do not exist yet when the gate runs.
function jjPushes(args, repo, config, pending) {
  const has = (...flags) => args.some((arg) => flags.includes(arg));
  if (has('--dry-run', '-h', '--help')) return { pushes: [] };
  if (has('--all', '--tracked')) return { refused: 'It can push every bookmark. Name each bookmark with --bookmark.' };
  if (flagValues(args, ['-c', '--change', '-r', '--revisions'], JJ_PUSH_VALUES).length) return { refused: 'It pushes bookmarks the gate cannot name. Set a bookmark (jj bookmark set ci/<name> -r <rev>) and push it with --bookmark.' };
  const remote = flagValues(args, ['--remote'], JJ_PUSH_VALUES).at(-1) ?? config.remote;
  if (remote !== config.remote) return { refused: `It pushes to ${remote}. Agents push only to ${config.remote}.` };
  const pushes = [];
  for (const name of flagValues(args, ['-b', '--bookmark'], JJ_PUSH_VALUES)) {
    if (/^(glob|regex|substring):|[*?]/.test(name)) return { refused: `It names bookmarks by pattern (${name}). Name each bookmark exactly.` };
    const bookmark = name.replace(/^exact:/, '');
    pushes.push({ bookmark, target: pending.has(bookmark) ? pending.get(bookmark) : localBookmarkTarget(repo, bookmark) });
  }
  for (const named of flagValues(args, ['--named'], JJ_PUSH_VALUES)) {
    const [bookmark, rev] = named.split('=');
    pushes.push({ bookmark, target: commitIds(repo, rev ?? '')[0] ?? null });
  }
  if (!pushes.length && !has('--deleted')) return { refused: 'It pushes whatever bookmarks jj picks. Name each bookmark with --bookmark.' };
  return { pushes };
}

function gitPushes(args, repo, config) {
  const has = (...flags) => args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (has('-n', '--dry-run', '-h', '--help')) return { pushes: [] };
  if (has('-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror')) return { refused: 'It is a force push. Never force push: push to a new branch name instead.' };
  if (has('--all', '--branches', '--tags', '--prune')) return { refused: 'It pushes more than named branches. Name each branch.' };
  if (has('--no-verify')) return { refused: 'It skips the pre-push hook.' };
  const [remote = config.remote, ...refspecs] = positionals(args, GIT_PUSH_VALUES);
  if (remote !== config.remote) return { refused: `It pushes to ${remote}. Agents push only to ${config.remote}.` };
  if (!refspecs.length) return { refused: 'It pushes whatever git picks. Name the branch.' };
  const deleting = has('-d', '--delete');
  const pushes = [];
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return { refused: `${spec} is a force push. Never force push.` };
    const [src, dst = src] = spec.split(':');
    const bookmark = dst.replace(/^refs\/heads\//, '');
    if (deleting || src === '') pushes.push({ bookmark, target: null });
    else {
      const target = commitIds(repo, src)[0] ?? localBookmarkTarget(repo, src);
      if (!target) return { refused: `The gate cannot tell which commit ${src} is. Push a bookmark with jj git push --bookmark.` };
      pushes.push({ bookmark, target });
    }
  }
  return { pushes };
}

function checkPush(ctx, push) {
  const { config, repo } = ctx;
  if (push.target === null) {
    // A deletion: cleanup removes merged branches. Trunk and branches agents do not own stay.
    if (push.bookmark === config.trunk || !matchesAny(push.bookmark, config.push.branches)) {
      return remoteBookmarkTarget(repo, push.bookmark, config.remote) ? [`It deletes ${push.bookmark}, which agents do not own.`] : [];
    }
    return [];
  }
  if (push.bookmark === config.trunk) {
    const run = runForCommit(ctx.identity, push.target);
    return deployProblems(ctx, run, push.target).map((problem) => `Moving ${config.trunk} is a deploy step: ${problem}`);
  }
  return pushProblems(ctx, push.bookmark, push.target);
}

const DEPLOY_REF_FLAGS = new Set(['-r', '--ref', '-f', '--raw-field', '-F', '--field', '-R', '--repo']);

function workflowAction(words, ctx) {
  const at = words.findIndex((word) => basename(word) === 'gh');
  const args = words.slice(at + 1).filter((_, i, all) => !(all[i - 1] === '-R' || all[i - 1] === '--repo') && all[i] !== '-R' && all[i] !== '--repo');
  const prod = new RegExp(ctx.config.deploy.prodPattern, 'i');
  const deployPattern = new RegExp(ctx.config.deploy.deployWorkflows, 'i');
  if (args[0] === 'workflow' && args[1] === 'run') {
    const rest = args.slice(2);
    const workflow = positionals(rest, DEPLOY_REF_FLAGS)[0] ?? '';
    const fields = flagValues(rest, ['-f', '--raw-field', '-F', '--field'], DEPLOY_REF_FLAGS);
    if (!workflow || /^\d+$/.test(workflow)) return { label: 'gh workflow run', refused: 'Name the workflow by its file name, so the gate can tell what it runs.' };
    if (prod.test(workflow) || fields.some((field) => /^(inputs\[)?environment\]?=/i.test(field) && prod.test(field.split('=')[1]))) return { label: `gh workflow run ${workflow}`, refused: NEVER_PROD };
    if (!deployPattern.test(workflow)) return null;
    if (ctx.config.deploy.runBy === 'user') return { label: `gh workflow run ${workflow}`, refused: 'The user runs deploys in this project (deploy.runBy). Give the user the command.' };
    const ref = flagValues(rest, ['-r', '--ref'], DEPLOY_REF_FLAGS).at(-1);
    const target = ref ? commitIds(ctx.repo, `bookmarks(exact:${JSON.stringify(ref)}) | remote_bookmarks(exact:${JSON.stringify(ref)}, exact:${JSON.stringify(ctx.config.remote)})`)[0] : null;
    if (!target) return { label: `gh workflow run ${workflow}`, refused: 'Pass --ref with a bookmark the gate can find, so it can check the commit it deploys.' };
    return { label: `gh workflow run ${workflow} --ref ${ref}`, deploy: target };
  }
  if (args[0] === 'run' && args[1] === 'rerun') {
    const id = positionals(args.slice(2), new Set(['-j', '--job']))[0];
    if (!id || !ctx.slug) return { label: 'gh run rerun', refused: 'Name the run ID, so the gate can tell what the rerun runs.' };
    const name = workflowName(ctx.slug, id);
    if (name === null) return { label: `gh run rerun ${id}`, refused: `Could not read run ${id}.` };
    if (prod.test(name)) return { label: `gh run rerun ${id}`, refused: NEVER_PROD };
    if (deployPattern.test(name)) return { label: `gh run rerun ${id}`, refused: 'A rerun of a deploy repeats inputs the gate cannot see. Dispatch the deploy again with gh workflow run.' };
    return null;
  }
  if (args[0] === 'api' && args.some((arg) => /actions\/workflows\/[^/]+\/dispatches/.test(arg))) {
    const endpoint = args.find((arg) => /actions\/workflows\/[^/]+\/dispatches/.test(arg));
    const workflow = decodeURIComponent(/workflows\/([^/]+)\/dispatches/.exec(endpoint)[1]);
    if (prod.test(workflow) || args.some((arg) => /environment\]?=.*prod/i.test(arg))) return { label: `gh api ${endpoint}`, refused: NEVER_PROD };
    if (deployPattern.test(workflow)) return { label: `gh api ${endpoint}`, refused: 'Dispatch deploys with gh workflow run --ref, so the gate can check the commit.' };
    return null;
  }
  if (args[0] === 'pr' && ['ready', 'merge'].includes(args[1]) && provider(ctx.config) === 'builtin') {
    if (args.includes('--undo') || args.includes('--disable-auto')) return null;
    const pr = positionals(args.slice(2), new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '--match-head-commit', '-A', '--author-email']))[0];
    const head = pr ? pullRequestHead(ctx.slug, pr, ctx.repo) : null;
    if (!head) return { label: `gh pr ${args[1]}`, refused: 'Name the pull request, so the gate can check its commits.' };
    return { label: `gh pr ${args[1]} ${pr}`, review: head };
  }
  return null;
}

function reviewAction(words, ctx) {
  const name = basename(words[0]);
  if (name !== 'agent-review') return null;
  const sub = words[1];
  if (!['start', 'ask'].includes(sub)) return null;
  const topic = flagValues(words.slice(2), ['--topic'], new Set(['--topic', '--tip', '--dir', '--repo', '--to', '--phase', '--file', '--from', '--model', '--effort', '--provider']))[0];
  if (!topic) return null;
  const run = loadRuns().find((entry) => entry.identity === ctx.identity && entry.reviewTopics?.[topic]);
  if (!run) return null;
  const kind = run.reviewTopics[topic];
  if (sub === 'start') {
    if (kind === 'design' && !['noted', 'passed'].includes(run.stages.design?.state)) return { label: `agent-review start --topic ${topic}`, refused: `The design note of run ${run.id} has not passed its checks. Run pipeline design first.` };
    if (kind === 'code' && !passed(run, 'build')) return { label: `agent-review start --topic ${topic}`, refused: `Run ${run.id}'s build has not passed. Run pipeline build --run ${run.id}.` };
    return null;
  }
  const phase = flagValues(words.slice(2), ['--phase'], new Set())[0] ?? 'review';
  const entry = agentReviewEntries(ctx.config).find((candidate) => candidate.topic === topic) ?? findEntry(ctx.config, topic);
  if (phase !== 'review' || !entry || entry.rounds.length !== 1) return null;
  const to = flagValues(words.slice(2), ['--to'], new Set())[0];
  const fileFlag = flagValues(words.slice(2), ['--file'], new Set())[0];
  const own = to ? join(entry.folder, 'round-1', `request-${to}.md`) : null;
  const file = fileFlag ?? (own && existsSync(own) ? own : join(entry.folder, 'round-1', 'request.md'));
  if (!existsSync(file)) return null;
  if (!normalizeWords(readFileSync(file, 'utf8')).includes(normalizeWords(run.intake.words))) {
    return { label: `agent-review ask --topic ${topic}`, refused: `${file} does not quote the user's words for run ${run.id} verbatim. Paste them into "The user's words".` };
  }
  return null;
}

function deployCommandAction(words, ctx) {
  const { config } = ctx;
  if (!config.deploy.match || !new RegExp(config.deploy.match).test(words.join(' '))) return null;
  const label = words.join(' ').slice(0, 80);
  if (config.deploy.runBy === 'user') return { label, refused: 'The user runs deploys in this project (deploy.runBy). Give the user the command.' };
  const at = words.findIndex((word) => new RegExp(config.deploy.match).test(word));
  const args = positionals(words.slice(at + 1), new Set());
  const rev = config.deploy.tipArg ? args[config.deploy.tipArg - 1] : null;
  const target = rev ? commitIds(ctx.repo, rev)[0] : null;
  if (!target) return { label, refused: `The gate cannot tell which commit this deploys. ${config.deploy.tipArg ? `Argument ${config.deploy.tipArg} must be a revision.` : 'Set deploy.tipArg.'}` };
  return { label, deploy: target };
}

const isPush = (words) => (basename(words[0] ?? '') === 'jj' && words.includes('git') && words[words.indexOf('git') + 1] === 'push') || (basename(words[0] ?? '') === 'git' && words[1] === 'push');

const BOOKMARK_VALUES = new Set(['-r', '--revision', '--to', '-B', '--allow-backwards', '-R', '--repository']);

// `jj bookmark set|create|move NAME... -r REV` earlier in the same command, so a push after it is
// checked against the commit it will push.
function noteBookmarkSet(words, cwd, pending) {
  if (basename(words[0] ?? '') !== 'jj' || words[1] !== 'bookmark' || !['set', 'create', 'move', 's', 'c', 'm'].includes(words[2]) || cwd === null) return;
  const args = words.slice(3);
  const rev = flagValues(args, ['-r', '--revision', '--to'], BOOKMARK_VALUES).at(-1) ?? '@';
  const names = positionals(args, new Set(['-r', '--revision', '--to', '-R', '--repository']));
  const target = commitIds(cwd, rev)[0] ?? null;
  for (const name of names) pending.set(name, target);
}

// The checks one simple command needs, or null.
function actionFor(words, cwd, pending) {
  if (!words.length) return null;
  if (cwd === null) {
    const gated = isPush(words) || basename(words[0]) === 'agent-review' || (words.some((word) => basename(word) === 'gh') && /\b(workflow run|run rerun|pr (ready|merge)|dispatches)\b/.test(words.join(' ')));
    return gated ? { unknownDir: true, label: words.join(' ').slice(0, 80) } : null;
  }
  const ctx = repoContext(cwd, { required: false });
  if (!ctx) return null;
  const name = basename(words[0]);
  if (name === 'jj' && words.includes('git') && words[words.indexOf('git') + 1] === 'push') {
    const result = jjPushes(words.slice(words.indexOf('push') + 1), ctx.repo, ctx.config, pending);
    return { ctx, label: words.join(' ').slice(0, 80), ...result };
  }
  if (name === 'git' && words[1] === 'push') return { ctx, label: words.join(' ').slice(0, 80), ...gitPushes(words.slice(2), ctx.repo, ctx.config) };
  if (words.some((word) => basename(word) === 'gh')) {
    const action = workflowAction(words, ctx);
    if (action) return { ctx, ...action };
  }
  const review = reviewAction(words, ctx);
  if (review) return { ctx, ...review };
  const deploy = deployCommandAction(words, ctx);
  return deploy ? { ctx, ...deploy } : null;
}

function problemsFor(action) {
  if (action.unknownDir) return ['Could not tell which directory it runs in (a cd to a variable or a missing directory). Run it from the workspace, with a literal path.'];
  if (action.refused) return [action.refused];
  if (action.pushes) return action.pushes.flatMap((push) => checkPush(action.ctx, push).map((problem) => `${push.bookmark}: ${problem}`));
  if (action.deploy) return deployProblems(action.ctx, runForCommit(action.ctx.identity, action.deploy), action.deploy);
  if (action.review) {
    const missing = reviewCoverage(action.ctx.repo, action.review, action.ctx.config).filter((commit) => !reviewPassed(commit));
    return missing.length ? [`${missing.length} commit(s) lack review consensus: ${missing.slice(0, 5).map((commit) => short(commit.id)).join(', ')}.`] : [];
  }
  return [];
}

// Quick test before any parsing, so the hook costs almost nothing on most commands. A project's own
// deploy command can have any name, so its pattern is read from the nearest config file.
const MAYBE_GATED = /\b(push|gh|agent-review)\b/;

function nearestConfig(dir) {
  for (let current = dir; current && current !== dirname(current); current = dirname(current)) {
    const file = join(current, CONFIG_FILE);
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    }
  }
  return null;
}

function mayBeGated(text, cwd) {
  if (MAYBE_GATED.test(text)) return true;
  const match = nearestConfig(cwd)?.deploy?.match;
  return Boolean(match) && new RegExp(match).test(text);
}

export function gateMessage(payload) {
  const command = payloadCommand(payload);
  if (!command || !mayBeGated(command.text, payload.cwd ?? process.cwd())) return null;
  const actions = [];
  const pending = new Map();
  try {
    walkCommand(command.items ?? shellSegments(command.text), payload.cwd ?? process.cwd(), (words, cwd) => {
      noteBookmarkSet(words, cwd, pending);
      const action = actionFor(words, cwd, pending);
      if (action) actions.push(action);
    });
  } catch (error) {
    return `Pipeline gate could not parse this command (${error.message}). Rewrite it more simply, such as one command per line.`;
  }
  for (const action of actions) {
    const problems = problemsFor(action);
    if (problems.length) return [`Pipeline gate blocked \`${action.label}\`.`, ...problems.map((problem) => `  - ${problem}`), `Process: ${PROCESS_DOC}`].join('\n');
  }
  return null;
}
