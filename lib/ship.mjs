// From built commits to a deployed release: the pre-push scan, pushes, CI, code review, rebases,
// the deploy, its notification, and the cleanup after it.

import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runContext } from './context.mjs';
import { docsRuleGaps } from './after.mjs';
import { latestRun, settle, viewRun } from './github.mjs';
import { loadRuns, passed, requireStages, setStage, updateRun } from './ledger.mjs';
import { report } from './plan.mjs';
import { builtinDone, builtinRound, builtinSkip, builtinStart, coverage, agentReviewEntries, builtinEntries, findEntry, provider, reviewCoverage, reviewPassed } from './review.mjs';
import { scanResult } from './scan.mjs';
import { fail, fillTemplate, matchesAny, now, plural, run as runCommand, short } from './util.mjs';
import { commitIds, diffRange, firstLine, isAncestor, isOnRemote, listCommits, remoteBookmarks, remoteBookmarkTarget, resolveTip, workspaces } from './vcs.mjs';

const runsOf = (identity) => loadRuns().filter((entry) => entry.identity === identity);

// Scan

export function cmdScan(opts) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  requireStages(run, ['build'], 'A pre-push scan');
  const tip = resolveTip(repo, opts.tip ?? run.tip);
  const base = commitIds(repo, `fork_point(${opts.base ?? config.trunk} | ${tip})`)[0];
  const commits = listCommits(repo, `${base}..${tip}`);
  if (!commits.length) fail(`No commits between ${short(base)} and ${short(tip)}.`);
  const result = scanResult(commits, diffRange(repo, base, tip), config);
  const ack = opts.ack && opts.ack !== true ? opts.ack : null;
  const ok = !result.errors.length && (!result.reviews.length || Boolean(ack));
  const record = { base, tip, commits: commits.map((commit) => commit.id), errors: result.errors, reviews: result.reviews, ack, passed: ok, at: now() };
  const summary = ok ? `${plural(commits.length, 'commit')} clean${result.reviews.length ? `, ${plural(result.reviews.length, 'finding')} acknowledged` : ''}` : `${plural(result.errors.length, 'error')}, ${plural(result.reviews.length, 'finding')} to look at`;
  const updated = updateRun(run.id, (current) => {
    current.scans = [...(current.scans ?? []), record];
    setStage(current, 'scan', { state: ok ? 'passed' : 'failed', tip, summary });
    return current;
  });
  const lines = [`Scan of ${short(base)}..${short(tip)} for ${run.id}: ${ok ? 'passed' : 'refused'}, ${summary}.`];
  for (const finding of result.errors) lines.push(`  error ${finding.kind} ${finding.where}: ${finding.text}`);
  for (const finding of result.reviews) lines.push(`  look  ${finding.kind} ${finding.where}: ${finding.text}`);
  if (!ok && !result.errors.length) lines.push(`  Look at each finding. When none is a risk, rerun with --ack "<why each is fine>".`);
  report(ctx, updated, lines, ['scan']);
  if (!ok) process.exitCode = 1;
}

// Push

export const nextName = (repo, bookmark) => {
  const taken = new Set(remoteBookmarks(repo).map((entry) => entry.name));
  const stem = bookmark.replace(/-\d+$/, '');
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`) && !commitIds(repo, `bookmarks(exact:${JSON.stringify(`${stem}-${n}`)})`).length) return `${stem}-${n}`;
};

// Why pushing `target` to `bookmark` must not happen, as a list. Trunk pushes go through the deploy
// gate instead, which the caller runs.
export function pushProblems(ctx, bookmark, target) {
  const { repo, config, identity } = ctx;
  const problems = [];
  if (!matchesAny(bookmark, config.push.branches) && !config.push.branches.includes(bookmark)) {
    problems.push(`${bookmark} is not a branch agents push to (push.branches: ${config.push.branches.join(', ')}).`);
    return problems;
  }
  const remote = remoteBookmarkTarget(repo, bookmark, config.remote);
  if (remote && remote !== target && !isAncestor(repo, remote, target)) {
    problems.push(`${bookmark} on ${config.remote} is at ${short(remote)}, which is not an ancestor of ${short(target)}. Moving it would be a force push (jj calls it moving sideways). Push to a new name instead, such as ${nextName(repo, bookmark)}, and forget the old local bookmark (jj bookmark forget ${bookmark}).`);
  }
  const fresh = commitIds(repo, `::${target} ~ ::remote_bookmarks(remote=exact:${JSON.stringify(config.remote)})`);
  const runs = runsOf(identity);
  if (config.push.requireScan) {
    const scanned = new Set(runs.flatMap((entry) => (entry.scans ?? []).filter((scan) => scan.passed).flatMap((scan) => scan.commits)));
    const unscanned = fresh.filter((id) => !scanned.has(id));
    if (unscanned.length) problems.push(`${plural(unscanned.length, 'commit')} would reach ${config.remote} without a passed pre-push scan: ${unscanned.slice(0, 5).map(short).join(', ')}${unscanned.length > 5 ? ', ...' : ''}. Run pipeline scan --run <run> --tip ${short(target)}.`);
  }
  if (config.push.public) {
    const freshSet = new Set(fresh);
    for (const entry of runs.filter((candidate) => candidate.liveHole && !passed(candidate, 'deploy'))) {
      const ids = Object.values(entry.lanes ?? {}).flatMap((lane) => lane.commits.map((commit) => commit.id));
      if (ids.some((id) => freshSet.has(id))) problems.push(`Run ${entry.id} fixes a hole that is live on the deployed server. A public branch would advertise it before the fix deploys. Check it on this machine, deploy it, then push.`);
    }
  }
  return problems;
}

export function cmdPush(opts) {
  const ctx = runContext(opts);
  const { repo, config, run } = ctx;
  const bookmark = opts.bookmark ?? fail('--bookmark is required, such as ci/my-change.');
  if (opts['next-name']) {
    console.log(nextName(repo, bookmark));
    return;
  }
  const target = resolveTip(repo, opts.tip ?? run.tip);
  if (bookmark === config.trunk) fail(`${config.trunk} moves only in a deploy. Use pipeline deploy check --run ${run.id}.`);
  const problems = pushProblems(ctx, bookmark, target);
  if (problems.length) {
    console.log([`Push of ${short(target)} to ${bookmark} refused:`, ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log([`Push of ${short(target)} to ${bookmark} allowed. Run:`, `  jj bookmark set ${bookmark} -r ${short(target)}`, `  jj git push --remote ${config.remote} --bookmark ${bookmark}`].join('\n'));
}

// Called after a push: records which runs' tips are now on the remote, and returns the runs to
// mirror: those newly pushed, and those whose tip a bookmark named in the push now carries.
export function recordPushes(ctx, named = []) {
  const touched = [];
  const bookmarks = remoteBookmarks(ctx.repo, ctx.config.remote);
  for (const entry of runsOf(ctx.identity)) {
    if (!entry.tip || !isOnRemote(ctx.repo, entry.tip, ctx.config.remote)) continue;
    const carrying = bookmarks.filter((bookmark) => bookmark.target && isAncestor(ctx.repo, entry.tip, bookmark.target));
    const branches = carrying.map((bookmark) => bookmark.name);
    const recorded = entry.stages.push?.tip === entry.tip && entry.stages.push?.state === 'passed';
    if (recorded && !branches.some((name) => named.includes(name))) continue;
    touched.push(recorded ? entry : updateRun(entry.id, (current) => {
      setStage(current, 'push', { state: 'passed', tip: entry.tip, branches, summary: `${short(entry.tip)} on ${branches.join(', ') || ctx.config.remote}` });
      current.pushedBranches = [...new Set([...(current.pushedBranches ?? []), ...branches.filter((name) => name !== ctx.config.trunk)])];
      return current;
    }));
  }
  return touched;
}

// CI

export async function cmdCi(opts) {
  const ctx = runContext(opts);
  const { run, config, repo, slug } = ctx;
  requireStages(run, ['scan'], 'Recording CI');
  if (!slug) fail('The repository has no GitHub remote, so there is no CI to read.');
  const sha = resolveTip(repo, opts.commit ?? run.tip);
  if (!isOnRemote(repo, sha, config.remote)) fail(`${short(sha)} is not on ${config.remote}. Push it to a ${config.push.branches.join(' or ')} branch first.`);
  const deadline = Date.now() + config.ci.timeoutMin * 60_000;
  let view = null;
  let verdict = null;
  for (;;) {
    const id = opts['run-id'] ?? latestRun(slug, sha, config.ci.workflow)?.databaseId;
    if (id) {
      view = viewRun(slug, id);
      verdict = settle(view, config.ci.okConclusions);
      if (verdict.settled || !opts.wait) break;
    } else if (!opts.wait) break;
    if (Date.now() > deadline) break;
    await new Promise((done) => setTimeout(done, config.ci.pollSec * 1000));
  }
  if (!view) {
    console.log(`No ${config.ci.workflow ?? 'CI'} run for ${short(sha)} yet.${opts.wait ? ' Gave up waiting.' : ' Rerun with --wait.'}`);
    process.exitCode = 3;
    return;
  }
  const state = !verdict.settled ? 'running' : verdict.ok ? 'passed' : 'failed';
  const summary = `run ${view.databaseId} ${verdict.settled ? verdict.conclusion : 'not settled'}, ${plural(verdict.jobs.length, 'job')}${verdict.failedJobs.length ? `, failed: ${verdict.failedJobs.join(', ')}` : ''}`;
  const updated = updateRun(run.id, (current) => {
    current.ci = { ...(current.ci ?? {}), [sha]: { runId: view.databaseId, url: view.url, conclusion: verdict.conclusion, settled: verdict.settled, ok: verdict.ok, jobs: verdict.jobs, at: now() } };
    if (sha === current.tip) setStage(current, 'ci', { state, tip: sha, runId: view.databaseId, url: view.url, summary });
    return current;
  });
  const lines = [`CI for ${short(sha)} (${run.id}): ${state}, ${summary}.`];
  if (!verdict.settled) lines.push('  Every job must finish before CI counts. Rerun with --wait.');
  report(ctx, updated, lines, ['ci']);
  if (state !== 'passed') process.exitCode = state === 'running' ? 3 : 1;
}

// Review

function reviewStage(ctx, tip) {
  const covered = reviewCoverage(ctx.repo, tip, ctx.config);
  const ok = covered.every(reviewPassed);
  const started = covered.some((commit) => ['started', 'consensus', 'skipped'].includes(commit.review));
  const counts = ['consensus', 'skipped', 'started', 'none'].map((state) => [state, covered.filter((commit) => commit.review === state).length]).filter(([, count]) => count);
  return { covered, ok, state: ok ? 'passed' : started ? 'in-review' : 'none', summary: `${counts.map(([state, count]) => `${count} ${state}`).join(', ') || 'no commits'} (${[...new Set(covered.map((commit) => commit.topic).filter(Boolean))].join(', ') || 'no review'})` };
}

export function cmdReview(opts, sub) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  const using = provider(config);
  if (['start', 'round', 'done', 'skip'].includes(sub) && using === 'agent-review') {
    fail(`agent-review keeps reviews on this machine. Run agent-review ${sub} (see its routine). The pipeline reads its ledger: pipeline review status --run ${run.id}.`);
  }
  let lines = [];
  if (sub === 'start') {
    const topic = opts.topic ?? fail('--topic is required.');
    if (opts['no-commits']) {
      if (!['noted', 'passed'].includes(run.stages.design?.state)) fail(`A design review starts once the note passes its checks (pipeline design --run ${run.id} --note <file>).`);
      const folder = resolve(opts.dir ?? fail('--dir is required with --no-commits.'));
      const { dir } = builtinStart({ topic, repo: null, folder, words: run.intake.words, config });
      updateRun(run.id, (current) => { current.reviewTopics = { ...(current.reviewTopics ?? {}), [topic]: 'design' }; current.stages.design.reviewTopic = topic; });
      lines.push(`Design review ${topic} started: ${dir}. Fill every TODO(owner) in request.md, then send it to the reviewers.`);
    } else {
      requireStages(run, ['build'], 'A code review');
      const folder = resolve(opts.dir ?? join(repo, '.pipeline', `review-${topic}`));
      const { round, dir } = builtinStart({ topic, repo, folder, tip: opts.tip ?? run.tip, words: run.intake.words, config });
      updateRun(run.id, (current) => { current.reviewTopics = { ...(current.reviewTopics ?? {}), [topic]: 'code' }; });
      lines.push(`Review ${topic} started on ${short(round.tip)}, ${plural(round.commits.length, 'commit')}: ${dir}. Fill every TODO(owner) in request.md, then send it to the reviewers.`);
    }
  } else if (sub === 'round') {
    const { round, dir } = builtinRound({ topic: opts.topic ?? fail('--topic is required.'), tip: opts.tip, config });
    lines.push(`Round ${round.n} of ${opts.topic}: ${dir}.`);
  } else if (sub === 'done') {
    const entry = builtinDone({ topic: opts.topic ?? fail('--topic is required.'), reviewers: opts.reviewers, config });
    lines.push(`Recorded consensus for ${entry.topic} after ${plural(entry.consensus.rounds, 'round')}.`);
  } else if (sub === 'skip') {
    const tip = resolveTip(repo, opts.tip ?? run.tip);
    const entry = builtinSkip({ repo, tip, reason: opts.reason, config });
    lines.push(`Recorded the user's skip of review for ${plural(entry.consensus.commits.length, 'commit')} up to ${short(tip)}.`);
  } else if (sub !== 'status') fail('pipeline review takes status, start, round, done or skip.');
  if (!run.tip) {
    console.log(lines.join('\n'));
    return;
  }
  const result = reviewStage(ctx, run.tip);
  const updated = updateRun(run.id, (current) => setStage(current, 'review', { state: result.state, provider: using, tip: run.tip, summary: result.summary }) && current);
  lines.push(`Review of ${config.trunk}..${short(run.tip)} for ${run.id}: ${result.state}, ${result.summary}.`);
  if (sub === 'status') for (const commit of result.covered) lines.push(`  ${short(commit.id)} ${commit.review.padEnd(9)} ${(commit.topic ?? '').padEnd(24)} ${firstLine(commit.description)}`);
  report(ctx, updated, lines, ['review']);
}

// Rebase

export function cmdRebase(opts) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  const tip = resolveTip(repo, opts.tip ?? fail('--tip is required: the rebased tip.'));
  const commits = listCommits(repo, `${config.trunk}..${tip}`);
  const known = new Map(Object.values(run.lanes ?? {}).flatMap((lane) => lane.commits).filter((commit) => commit.patchId).map((commit) => [commit.patchId, commit]));
  const entries = [...agentReviewEntries(config), ...builtinEntries()].filter((entry) => entry.identity === run.identity);
  const covered = coverage(commits, entries);
  const carried = covered.filter((commit) => commit.patchId && known.has(commit.patchId));
  const changed = covered.filter((commit) => commit.patchId && !known.has(commit.patchId));
  const reopened = covered.filter((commit) => !reviewPassed(commit));
  const updated = updateRun(run.id, (current) => {
    current.rebases = [...(current.rebases ?? []), { from: current.tip, to: tip, carried: carried.map((commit) => commit.id), changed: changed.map((commit) => commit.id), reopened: reopened.map((commit) => commit.id), at: now() }];
    current.tip = tip;
    // New commit ids mean the scan and CI must run again on them. Changed diffs mean the checks did not see this code.
    for (const stage of ['scan', 'push', 'ci']) if (current.stages[stage]) setStage(current, stage, { state: 'stale', summary: `rebased to ${short(tip)}, run again` });
    if (changed.length && current.stages.build) setStage(current, 'build', { state: 'stale', summary: `${plural(changed.length, 'commit')} changed in the rebase, check again` });
    return current;
  });
  const topics = Object.entries(run.reviewTopics ?? {}).filter(([, kind]) => kind === 'code').map(([topic]) => topic);
  const lines = [`Rebase of ${run.id} to ${short(tip)}: ${plural(carried.length, 'commit')} keep their patch-id, ${plural(changed.length, 'commit')} changed, ${plural(reopened.length, 'commit')} lack review consensus.`,
    ...changed.map((commit) => `  changed ${short(commit.id)} ${firstLine(commit.description)}`),
    ...reopened.map((commit) => `  review  ${short(commit.id)} ${commit.review} ${firstLine(commit.description)}`),
    reopened.length ? `  The review reopens: run ${provider(config) === 'agent-review' ? 'agent-review' : 'pipeline review'} round --topic ${topics[0] ?? '<topic>'} so reviewers see the rebased commits.` : '  Review coverage carried over by patch-id.',
    '  Scan and CI run again on the new commits.'];
  report(ctx, updated, lines);
}

// Deploy

const docsGaps = (ctx, tip) => docsRuleGaps(listCommits(ctx.repo, `${ctx.config.trunk}..${tip}`), ctx.config);

// Why `tip` may not deploy, as a list. Reads the live repository, so a gate never trusts a stale record.
export function deployProblems(ctx, run, tip) {
  const { repo, config } = ctx;
  const problems = [];
  if (!run) return [`No pipeline run records ${short(tip)}. Record the work with pipeline commits first.`];
  const required = ['intake', 'design', 'build', ...(config.decisions.guessMode ? ['decisions'] : []), ...(run.kind === 'docs' ? ['docs'] : [])];
  for (const stage of required) if (!passed(run, stage)) problems.push(`${stage} has not passed (now ${run.stages[stage]?.state ?? 'none'}).`);
  const covered = reviewCoverage(repo, tip, config);
  const unreviewed = covered.filter((commit) => !reviewPassed(commit));
  if (unreviewed.length) problems.push(`Code review consensus (or the user's recorded skip) is missing for ${plural(unreviewed.length, 'commit')}: ${unreviewed.slice(0, 5).map((commit) => `${short(commit.id)} ${commit.review}`).join(', ')}.`);
  const ci = run.ci?.[tip];
  if (!ci) problems.push(`No CI result for the exact commit ${short(tip)}. Push it and run pipeline ci --run ${run.id} --wait.`);
  else if (!ci.settled) problems.push(`CI run ${ci.runId} for ${short(tip)} has not settled: a job is still running.`);
  else if (!ci.ok) problems.push(`CI run ${ci.runId} for ${short(tip)} did not pass (${ci.conclusion}).`);
  const ids = commitIds(repo, `${config.trunk}..${tip}`);
  const scanned = new Set(loadRuns().filter((entry) => entry.identity === run.identity).flatMap((entry) => (entry.scans ?? []).filter((scan) => scan.passed).flatMap((scan) => scan.commits)));
  const unscanned = ids.filter((id) => !scanned.has(id));
  if (unscanned.length) problems.push(`${plural(unscanned.length, 'commit')} lack a passed pre-push scan.`);
  problems.push(...docsGaps(ctx, tip));
  if (!config.deploy.command) problems.push('deploy.command is not set in pipeline.config.json.');
  return problems;
}

export const runForCommit = (identity, sha) => loadRuns().find((entry) => entry.identity === identity && (entry.tip === sha || entry.stages.deploy?.tip === sha)) ?? null;

export function deployCommand(config, values) {
  return config.deploy.command ? fillTemplate(config.deploy.command, values) : null;
}

const HTTP_OK = /^[23]\d\d$/;

export function deployCheckProblems(values, config) {
  const problems = [];
  for (const check of config.deploy.requiredChecks) {
    const value = values[check];
    if (value === undefined || value === true || value === '') { problems.push(`--${check} is required (deploy.requiredChecks).`); continue; }
    if (check === 'health' && !config.deploy.healthyValues.includes(String(value).toLowerCase())) problems.push(`Health is ${value}, not ${config.deploy.healthyValues.join(' or ')}.`);
    if (check === 'load') {
      const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(value));
      if (!match) problems.push('--load takes the app\'s load check as loaded/total, such as 12/12.');
      else if (match[1] !== match[2]) problems.push(`The load check loaded ${match[1]} of ${match[2]}.`);
    }
    if (check === 'http') {
      const codes = String(value).split(/[\s,]+/).filter(Boolean);
      if (!codes.length || codes.some((code) => !HTTP_OK.test(code))) problems.push(`HTTP checks answered ${value}. Every check must answer 2xx or 3xx.`);
    }
    if (check === 'restarts' && Number(value) !== 0) problems.push(`The app restarted ${value} times.`);
  }
  return problems;
}

export function notify(config, message) {
  if (!config.notify.command) return { sent: false, reason: 'notify.command is not set' };
  const argv = (Array.isArray(config.notify.command) ? config.notify.command : ['sh', '-c', config.notify.command, 'sh', '{message}']).map((part) => fillTemplate(part, { message }));
  const result = runCommand(argv[0], argv.slice(1), { allowFail: true, timeout: 30_000 });
  return result.status === 0 ? { sent: true } : { sent: false, reason: (result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n')[0] };
}

export function cmdDeploy(opts, sub) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  const tip = resolveTip(repo, opts.tip ?? run.tip);
  if (sub === 'check') {
    const problems = deployProblems(ctx, run, tip);
    const command = deployCommand(config, { name: opts.name ?? run.id, tip: short(tip), prev: opts.prev ?? '<previous deployed commit>' });
    const docs = docsGaps(ctx, tip);
    const updated = updateRun(run.id, (current) => {
      // The docs rules are checked on the range being deployed. A docs run's own pass is pipeline docs.
      if (run.kind !== 'docs') setStage(current, 'docs', { state: docs.length ? 'failed' : 'passed', tip, summary: docs.length ? `${plural(docs.length, 'gap')}` : 'docs updated with the behavior they describe' });
      setStage(current, 'deploy', { state: problems.length ? 'blocked' : 'ready', tip, summary: problems.length ? `${plural(problems.length, 'gap')} before deploy` : `ready to deploy ${short(tip)}` });
      return current;
    });
    const lines = problems.length ? [`Deploy of ${short(tip)} for ${run.id} refused:`, ...problems.map((problem) => `  - ${problem}`)]
      : [`Deploy of ${short(tip)} for ${run.id} allowed.`, config.deploy.runBy === 'user' ? `  The user runs this deploy. Give the user this command:\n    ${command}` : `  Run: ${command}`,
        `  Then record it: pipeline deploy record --run ${run.id} --name ${opts.name ?? run.id} --shipped "<what shipped>" ${config.deploy.requiredChecks.map((check) => `--${check} <value>`).join(' ')}`];
    report(ctx, updated, lines, ['deploy', 'docs']);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (sub !== 'record') fail('pipeline deploy takes check or record.');
  const shipped = opts.shipped ?? fail('--shipped is required: what the deploy contains, in one line, for the notification.');
  const gaps = deployProblems(ctx, run, tip);
  if (gaps.length && !opts.ungated) fail([`This deploy would not have passed the gate:`, ...gaps.map((gap) => `  - ${gap}`), 'Pass --ungated "<why>" to record it anyway.'].join('\n'));
  const failedDeploy = Boolean(opts.failed);
  const values = Object.fromEntries(config.deploy.requiredChecks.map((check) => [check, opts[check]]));
  const problems = failedDeploy ? [] : deployCheckProblems(values, config);
  const state = failedDeploy || problems.length ? 'failed' : 'passed';
  const message = state === 'passed' ? `Deployed ${opts.name ?? run.id}: ${shipped}` : `Deploy of ${opts.name ?? run.id} failed${opts.failed && opts.failed !== true ? `: ${opts.failed}` : problems.length ? `: ${problems[0]}` : ''}`;
  const notified = opts['no-notify'] ? { sent: false, reason: 'skipped with --no-notify' } : notify(config, message);
  const summary = state === 'passed' ? `${opts.name ?? run.id} at ${short(tip)}: ${config.deploy.requiredChecks.filter((check) => check !== 'backup').map((check) => `${check} ${values[check]}`).join(', ')}` : `failed: ${(problems[0] ?? opts.failed ?? '').toString().replace(/\.$/, '').slice(0, 100)}`;
  const updated = updateRun(run.id, (current) => {
    current.deploys = [...(current.deploys ?? []), { name: opts.name ?? run.id, tip, values, shipped, by: opts.by ?? config.deploy.runBy, failed: failedDeploy, problems, ungated: opts.ungated ?? null, notified, at: now() }];
    current.notifications = [...(current.notifications ?? []), { event: 'deploy', message, ...notified, at: now() }];
    setStage(current, 'deploy', { state, tip, name: opts.name ?? run.id, summary, notified: notified.sent });
    return current;
  });
  const lines = [`Deploy of ${short(tip)} for ${run.id}: ${state}. ${summary}.`, ...problems.map((problem) => `  - ${problem}`),
    notified.sent ? `  Notified: ${message}` : `  Not notified (${notified.reason}). Tell the user: ${message}`];
  report(ctx, updated, lines, ['deploy']);
  if (state !== 'passed') process.exitCode = 1;
}

export function cmdNotify(opts) {
  const ctx = runContext(opts);
  const message = opts.message ?? fail('--message is required.');
  const event = opts.event ?? 'note';
  if (!['deploy', 'waiting', 'done', 'failed', 'note'].includes(event)) fail('--event takes deploy, waiting, done, failed or note.');
  if (event === 'waiting' && !/^Need input:/.test(message)) fail('A notification that waits on the user starts with "Need input:" and holds the question.');
  const result = notify(ctx.config, message);
  updateRun(ctx.run.id, (current) => { current.notifications = [...(current.notifications ?? []), { event, message, ...result, at: now() }]; });
  console.log(result.sent ? `Notified: ${message}` : `Not notified (${result.reason}).`);
  if (!result.sent) process.exitCode = 1;
}

// Cleanup

// A branch counts as merged when its tip is in trunk, or when every commit it adds has the patch-id
// of a commit trunk gained since the branch forked (a stack rebased before it landed).
function branchMerged(repo, config, target) {
  if (isAncestor(repo, target, config.trunk)) return true;
  const own = listCommits(repo, `${config.trunk}..${target}`).filter((commit) => commit.patchId);
  if (!own.length) return true;
  const landed = new Set(listCommits(repo, `fork_point(${target} | ${config.trunk})..${config.trunk}`).map((commit) => commit.patchId).filter(Boolean));
  return own.every((commit) => landed.has(commit.patchId));
}

export function cleanupProblems(ctx, run) {
  const { repo, config } = ctx;
  const problems = [];
  const commands = [];
  // Every branch the run pushed, the ones a rewrite left stale included, since each push recorded it.
  const named = new Set(run.pushedBranches ?? []);
  for (const bookmark of remoteBookmarks(repo, config.remote)) {
    if (!bookmark.target || bookmark.name === config.trunk || !matchesAny(bookmark.name, config.push.branches) || !named.has(bookmark.name)) continue;
    if (branchMerged(repo, config, bookmark.target)) {
      problems.push(`${bookmark.name} is merged but still on ${config.remote}.`);
      commands.push(`jj bookmark track ${bookmark.name}@${config.remote} 2>/dev/null; jj bookmark delete ${bookmark.name} && jj git push --remote ${config.remote} --deleted`);
    }
  }
  const names = workspaces(repo);
  for (const lane of Object.values(run.lanes ?? {})) {
    if (names.includes(lane.workspaceName)) {
      problems.push(`Workspace ${lane.workspaceName} (lane ${lane.name}) is still in jj's list.`);
      commands.push(`jj workspace forget ${lane.workspaceName}`);
    }
    if (existsSync(lane.workspace)) {
      problems.push(`The folder of lane ${lane.name} still exists: ${lane.workspace}.`);
      commands.push(`rm -rf ${JSON.stringify(lane.workspace)}`);
    }
  }
  // Another workspace's operation (a fetch that drops a merged branch) can leave the main workspace stale.
  const status = runCommand('jj', ['--no-pager', 'st'], { cwd: ctx.main, allowFail: true });
  if (/stale/i.test(status.stderr ?? '')) {
    problems.push('The main workspace is stale.');
    commands.push(`cd ${JSON.stringify(ctx.main)} && jj workspace update-stale`);
  }
  const dbs = Object.values(run.lanes ?? {}).flatMap((lane) => lane.dbs ?? []).concat(run.livePlay?.dbs ?? []);
  if (dbs.length && config.cleanup.databaseList) {
    const listed = runCommand('sh', ['-c', config.cleanup.databaseList], { allowFail: true });
    const existing = new Set((listed.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean));
    for (const db of dbs.filter((name) => existing.has(name))) {
      problems.push(`Scratch database ${db} still exists.`);
      if (config.cleanup.databaseDrop) commands.push(fillTemplate(config.cleanup.databaseDrop, { db }));
    }
  } else if (dbs.length) problems.push(`cleanup.databaseList is not set, so the tool cannot check that ${dbs.join(', ')} were dropped.`);
  for (const topic of Object.keys(run.reviewTopics ?? {})) {
    const entry = findEntry(config, topic);
    if (entry?.folder && existsSync(entry.folder)) {
      problems.push(`Review folder of ${topic} is still in place: ${entry.folder}.`);
      if (config.cleanup.archiveDir) commands.push(`mkdir -p ${JSON.stringify(config.cleanup.archiveDir)} && mv ${JSON.stringify(entry.folder)} ${JSON.stringify(join(config.cleanup.archiveDir, basename(entry.folder)))}`);
    }
  }
  return { problems, commands };
}

export function cmdCleanup(opts) {
  const ctx = runContext(opts);
  const { run } = ctx;
  requireStages(run, ['deploy'], 'Cleanup');
  const deployNote = (run.notifications ?? []).some((note) => note.event === 'deploy' && note.sent);
  const { problems, commands } = cleanupProblems(ctx, run);
  if (ctx.config.notify.command && !deployNote) problems.push(`The deploy notification was not sent. Run pipeline notify --run ${run.id} --event deploy --message "Deployed: ..."`);
  const state = problems.length ? 'in-progress' : 'passed';
  const updated = updateRun(run.id, (current) => {
    setStage(current, 'cleanup', { state, summary: problems.length ? `${plural(problems.length, 'item')} left` : 'branches, workspaces, databases and review folders cleaned up' });
    if (!problems.length) current.lanesReleased = true;
    return current;
  });
  const lines = [`Cleanup for ${run.id}: ${state}.`, ...problems.map((problem) => `  - ${problem}`), ...(commands.length ? ['  Commands:', ...commands.map((command) => `    ${command}`)] : [])];
  report(ctx, updated, lines, ['cleanup']);
  if (problems.length) process.exitCode = 1;
}

