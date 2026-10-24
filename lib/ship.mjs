// From built commits to a deployed release: the pre-push scan, pushes, CI, code review, rebases,
// the deploy, its notification, and the cleanup after it.

import { existsSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runContext } from './context.mjs';
import { docsRuleGaps } from './after.mjs';
import { latestRun, resolveWorkflow, settle, viewRun, WorkflowError } from './github.mjs';
import { loadRuns, moveTip, passed, requireStages, setStage, updateRun } from './ledger.mjs';
import { fullPlan, remapLanes, resultsOn } from './build.mjs';
import { checkGaps } from './checks.mjs';
import { report } from './plan.mjs';
import { builtinDone, builtinRound, builtinSkip, builtinStart, coverage, agentReviewEntries, builtinEntries, findEntry, provider, ProviderError, reviewCoverage, reviewPassed, reviewState } from './review.mjs';
import { computeGitIds, fullChangeId, hasContent, holeOpen, knownCommits, patchIdsOf, sameChange, upgradedChangeId } from './change.mjs';
import { scanResult } from './scan.mjs';
import { fail, fillTemplate, matchesAny, now, plural, run as runCommand, short } from './util.mjs';
import { firstLine, range, resolveOne, resolveTip, trunkId, trunkRange, vcsAt } from './vcs.mjs';

const runsOf = (identity) => loadRuns().filter((entry) => entry.identity === identity);

// Scan

export function cmdScan(opts) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  requireStages(run, ['build'], 'A pre-push scan');
  const vcs = vcsAt(repo);
  const tip = resolveTip(vcs, opts.tip ?? run.tip);
  // Every fork point leaves the range, so criss-cross history scans the same commits in every backend.
  const bases = vcs.forkPoint(tip, opts.base ? resolveOne(vcs, opts.base, `--base ${opts.base}`) : trunkId(vcs, config));
  const base = bases[0] ?? null;
  const scanned = range(tip, bases);
  const commits = vcs.listCommits(scanned);
  if (!commits.length) fail(`No commits between ${short(base)} and ${short(tip)}.`);
  const result = scanResult(commits, vcs.commitPatches(scanned), config);
  const ack = opts.ack && opts.ack !== true ? opts.ack : null;
  const ok = !result.errors.length && (!result.reviews.length || Boolean(ack));
  const record = { base, bases, tip, commits: commits.map((commit) => commit.id), errors: result.errors, reviews: result.reviews, ack, passed: ok, at: now() };
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
  const vcs = vcsAt(repo);
  const taken = new Set(vcs.remoteBranches().map((entry) => entry.name));
  const stem = bookmark.replace(/-\d+$/, '');
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`) && !vcs.localBranch(`${stem}-${n}`)) return `${stem}-${n}`;
};

// The commits already published are the ancestors of these: the branches of the remote. The gate's
// context lists them as the remote itself reports them (`remoteShas`), never as a local ref says.
export const publishedIds = (vcs, config) => config.remoteShas ?? vcs.remoteBranchIds(config.remote);

// Why publishing `target` would advertise a hole that is live on the deployed server, as a list. Every
// way onto a public remote calls it: a branch push, a trunk push and a merge into trunk. The fix is
// matched by commit id and every patch id against every commit the run ever recorded, and by
// ancestry of every tip it has had, so a rebase, an amend, a duplicate or a merge on top of it does
// not slip it out. In jj a matching change id refuses too: an amended fix keeps it while its ids
// change. That match only ever refuses. An abandoned run still counts: stopping the work does not
// close the hole, and only the user closes it (pipeline live-hole close).
//
// A run recorded before git ids existed holds only jj ids, which a plain clone cannot match. Its
// git ids are computed here from local objects, in memory. A commit this repository lacks, with no
// git id recorded, refuses until the user waives it (pipeline live-hole waive).
export function holeProblems(ctx, target, runs = runsOf(ctx.identity)) {
  const { repo, config } = ctx;
  const holes = config.push.public ? runs.filter(holeOpen) : [];
  if (!holes.length) return [];
  const vcs = vcsAt(repo);
  const leaving = vcs.listCommits(range(target, publishedIds(vcs, config)));
  if (!leaving.length) return [];
  const problems = [];
  for (const entry of holes) {
    const lanes = Object.values(entry.lanes ?? {});
    const tips = [entry.tip, entry.integration?.tip, ...(entry.rebases ?? []).flatMap((rebase) => [rebase.from, rebase.to]), ...lanes.map((lane) => lane.tip)].filter(Boolean);
    const present = [...new Set(tips)].filter((id) => vcs.exists(id));
    const own = present.length ? vcs.listCommits(range(present, trunkId(vcs, config))) : [];
    const states = { ...(entry.gitIds ?? {}), ...Object.fromEntries(computeGitIds(vcs, entry)) };
    const ids = new Set([...knownCommits(entry), ...own.map((commit) => commit.id)]);
    const gitIds = Object.values(states).filter((state) => !['empty', 'unsupported'].includes(state));
    const patchIds = new Set([...(entry.history?.patchIds ?? []), ...lanes.flatMap((lane) => lane.commits.flatMap(patchIdsOf)), ...own.flatMap(patchIdsOf), ...gitIds]);
    const changeIds = new Set(vcs.backend === 'jj' ? [...(entry.history?.changeIds ?? []), ...lanes.flatMap((lane) => lane.commits.map((commit) => upgradedChangeId(commit, vcs))), ...own.map((commit) => commit.changeId)].filter(fullChangeId) : []);
    const matches = leaving.some((commit) => ids.has(commit.id) || patchIdsOf(commit).some((id) => patchIds.has(id)) || changeIds.has(fullChangeId(commit.changeId)));
    if (matches) {
      problems.push(entry.abandoned
        ? `Run ${entry.id} was abandoned, but its commits fix a hole that may still be live on the deployed server. They stay off the public remote.`
        : `Run ${entry.id} fixes a hole that is live on the deployed server. Publishing it would advertise the hole before the fix deploys. Check it on this machine (pipeline check --run ${entry.id} --tip <tip> --workspace <dir>), deploy it from the local commit, then publish.`);
      continue;
    }
    if (entry.liveHoleWaived) continue;
    // Only a commit this repository lacks can stay uncomputed. jj still matches an octopus merge by
    // its own id where it holds the commit. In git no id stands for its change.
    const unmatched = knownCommits(entry).filter((id) => {
      if (states[id] !== undefined && states[id] !== 'unsupported') return false;
      return !vcs.exists(id) || (states[id] === 'unsupported' && vcs.backend !== 'jj');
    });
    if (unmatched.length) problems.push(states[unmatched[0]] === 'unsupported' && vcs.exists(unmatched[0])
      ? `Run ${entry.id} recorded the octopus merge ${short(unmatched[0])}, which git cannot read, so a copy of its change cannot be told apart here. Push from the jj repository at ${entry.repo}, or ask the user to waive it (pipeline live-hole waive --run ${entry.id}).`
      : `Run ${entry.id} was recorded before git ids existed, and this clone lacks commit ${short(unmatched[0])}. Run pipeline status --run ${entry.id} once in ${entry.repo}.`);
  }
  return problems;
}

// Why pushing `target` to `bookmark` must not happen, as a list. Trunk pushes go through the deploy
// gate instead, which the caller runs. `remoteTip` is the branch's commit on the remote when the
// caller knows it (git's pre-push hook), else the remote's own report in the gate's context, else
// jj's view of the remote.
export function pushProblems(ctx, bookmark, target, { remoteTip } = {}) {
  const { repo, config, identity } = ctx;
  const problems = [];
  if (!matchesAny(bookmark, config.push.branches) && !config.push.branches.includes(bookmark)) {
    problems.push(`${bookmark} is not a branch agents push to (push.branches: ${config.push.branches.join(', ')}).`);
    return problems;
  }
  const vcs = vcsAt(repo);
  const remote = remoteTip !== undefined ? remoteTip : ctx.remoteHeads ? ctx.remoteHeads.get(bookmark) ?? null : vcs.remoteBranch(bookmark, config.remote);
  if (remote && remote !== target && !vcs.isAncestor(remote, target)) {
    problems.push(vcs.backend === 'git'
      ? `${bookmark} on ${config.remote} is at ${short(remote)}, which is not an ancestor of ${short(target)}. Moving it would be a force push. Push to a new name instead, such as ${nextName(repo, bookmark)}.`
      : `${bookmark} on ${config.remote} is at ${short(remote)}, which is not an ancestor of ${short(target)}. Moving it would be a force push (jj calls it moving sideways). Push to a new name instead, such as ${nextName(repo, bookmark)}, and forget the old local bookmark (jj bookmark forget ${bookmark}).`);
  }
  const fresh = vcs.commitIds(range(target, publishedIds(vcs, config)));
  const runs = runsOf(identity);
  if (config.push.requireScan) {
    const scanned = new Set(runs.flatMap((entry) => (entry.scans ?? []).filter((scan) => scan.passed).flatMap((scan) => scan.commits)));
    const unscanned = fresh.filter((id) => !scanned.has(id));
    if (unscanned.length) problems.push(`${plural(unscanned.length, 'commit')} would reach ${config.remote} without a passed pre-push scan: ${unscanned.slice(0, 5).map(short).join(', ')}${unscanned.length > 5 ? ', ...' : ''}. Run pipeline scan --run <run> --tip ${short(target)}.`);
  }
  problems.push(...holeProblems(ctx, target, runs));
  return problems;
}

export function cmdPush(opts) {
  const ctx = runContext(opts);
  const { repo, config, run } = ctx;
  // --bookmark is the older name of --branch.
  const bookmark = opts.branch ?? opts.bookmark ?? fail('--branch is required, such as ci/my-change.');
  if (opts['next-name']) {
    console.log(nextName(repo, bookmark));
    return;
  }
  const target = resolveTip(vcsAt(repo), opts.tip ?? run.tip);
  if (bookmark === config.trunk) fail(`${config.trunk} moves only in a deploy. Use pipeline deploy check --run ${run.id}.`);
  const problems = pushProblems(ctx, bookmark, target);
  if (problems.length) {
    console.log([`Push of ${short(target)} to ${bookmark} refused:`, ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    process.exitCode = 1;
    return;
  }
  // git push reads a short id as an object name only when no ref matches it, so git gets the full id.
  const commands = ctx.vcs.backend === 'git' ? [ctx.vcs.commands.pushBranch(config.remote, bookmark, target)] : [`jj bookmark set ${bookmark} -r ${short(target)}`, `jj git push --remote ${config.remote} --bookmark ${bookmark}`];
  console.log([`Push of ${short(target)} to ${bookmark} allowed. Run:`, ...commands.map((command) => `  ${command}`)].join('\n'));
}

// Called after a push: records which runs' tips are now on the remote, and returns the runs to
// mirror: those newly pushed, and those whose tip a bookmark named in the push now carries.
export function recordPushes(ctx, named = []) {
  const touched = [];
  const vcs = vcsAt(ctx.repo);
  const bookmarks = vcs.remoteBranches(ctx.config.remote);
  // A finished or abandoned run has nothing left to record, and skipping it keeps the hook's cost to the open runs.
  for (const entry of runsOf(ctx.identity).filter((candidate) => !candidate.abandoned && !passed(candidate, 'cleanup'))) {
    if (!entry.tip || !vcs.isOnRemote(entry.tip, ctx.config.remote)) continue;
    const carrying = bookmarks.filter((bookmark) => bookmark.target && vcs.isAncestor(entry.tip, bookmark.target));
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

// The workflows whose runs count as CI. A run of any other workflow never stands in for them.
export const ciWorkflows = (config) => [config.ci.workflow].flat().filter(Boolean);

// A run counts only when it ran the designated workflow, by id, in this repository, on the exact commit.
function runProblem(view, { slug, sha, workflow }) {
  if (view.headSha !== sha) return `Run ${view.databaseId} ran on ${short(view.headSha)}, not ${short(sha)}.`;
  if (view.workflowDatabaseId !== workflow.id) return `Run ${view.databaseId} is a run of ${view.workflowName} (workflow ${view.workflowDatabaseId}), not ${workflow.path} (workflow ${workflow.id}).`;
  if (!String(view.url ?? '').toLowerCase().startsWith(`https://github.com/${slug.toLowerCase()}/`)) return `Run ${view.databaseId} is not in ${slug}.`;
  return null;
}

export async function cmdCi(opts) {
  const ctx = runContext(opts);
  const { run, config, repo, slug } = ctx;
  const workflows = ciWorkflows(config);
  if (!workflows.length) fail('Set ci.workflow to the workflow (or a list of workflows) whose runs count as CI. The pipeline never counts a run of another workflow.');
  requireStages(run, ['scan'], 'Recording CI');
  if (run.liveHole && !run.liveHoleClosed) fail(`Run ${run.id} fixes a hole that is live on the server, so its commits stay off the remote and it deploys on local checks in place of CI: pipeline check --run ${run.id} --tip <tip> --workspace <dir>.`);
  if (!slug) fail('The repository has no GitHub remote, so there is no CI to read.');
  const sha = resolveTip(vcsAt(repo), opts.commit ?? run.tip);
  if (!vcsAt(repo).isOnRemote(sha, config.remote)) fail(`${short(sha)} is not on ${config.remote}. Push it to a ${config.push.branches.join(' or ')} branch first.`);
  const resolved = workflows.map((selector) => {
    try {
      return resolveWorkflow(slug, selector);
    } catch (error) {
      if (error instanceof WorkflowError) fail(`ci.workflow: ${error.message}`);
      throw error;
    }
  });
  // --run-id names the run of one designated workflow. The others use their newest run on the
  // commit. Every run read below, the given one included, must pass runProblem.
  let given = null;
  if (opts['run-id']) {
    const view = viewRun(slug, opts['run-id']);
    const workflow = resolved.find((entry) => entry.id === view.workflowDatabaseId);
    if (!workflow) fail(`Run ${opts['run-id']} is a run of ${view.workflowName} (workflow ${view.workflowDatabaseId}), which is not in ci.workflow (${resolved.map((entry) => entry.path).join(', ')}).`);
    given = { workflow, id: view.databaseId };
  }
  const deadline = Date.now() + config.ci.timeoutMin * 60_000;
  let found = [];
  for (;;) {
    found = resolved.map((workflow) => {
      const id = given?.workflow === workflow ? given.id : latestRun(slug, sha, workflow)?.databaseId;
      if (!id) return { workflow, view: null };
      const view = viewRun(slug, id);
      const problem = runProblem(view, { slug, sha, workflow });
      if (problem) fail(problem);
      return { workflow, view, verdict: settle(view, config.ci.okConclusions) };
    });
    const waiting = found.some((entry) => !entry.view || !entry.verdict.settled);
    if (!waiting || !opts.wait || Date.now() > deadline) break;
    await new Promise((done) => setTimeout(done, config.ci.pollSec * 1000));
  }
  const absent = found.filter((entry) => !entry.view);
  if (absent.length) {
    console.log(`No ${absent.map((entry) => entry.workflow.path).join(', ')} run for ${short(sha)} yet.${opts.wait ? ' Gave up waiting.' : ' Rerun with --wait.'}`);
    process.exitCode = 3;
    return;
  }
  const runs = found.map(({ workflow, view, verdict }) => ({ workflow: workflow.path, runId: view.databaseId, url: view.url, conclusion: verdict.conclusion, settled: verdict.settled, ok: verdict.ok, jobs: verdict.jobs, failedJobs: verdict.failedJobs }));
  const settled = runs.every((entry) => entry.settled);
  const ok = settled && runs.every((entry) => entry.ok);
  const state = !settled ? 'running' : ok ? 'passed' : 'failed';
  const failedJobs = runs.flatMap((entry) => entry.failedJobs);
  const summary = runs.map((entry) => `run ${entry.runId} ${entry.settled ? entry.conclusion : 'not settled'}`).join(', ') + `, ${plural(runs.reduce((count, entry) => count + entry.jobs.length, 0), 'job')}${failedJobs.length ? `, failed: ${failedJobs.join(', ')}` : ''}`;
  const first = runs.find((entry) => !entry.ok) ?? runs[0];
  const updated = updateRun(run.id, (current) => {
    current.ci = { ...(current.ci ?? {}), [sha]: { runs, runId: first.runId, url: first.url, conclusion: first.conclusion, settled, ok, jobs: runs.flatMap((entry) => entry.jobs), at: now() } };
    if (sha === current.tip) setStage(current, 'ci', { state, tip: sha, runId: first.runId, url: first.url, summary });
    return current;
  });
  const lines = [`CI for ${short(sha)} (${run.id}): ${state}, ${summary}.`];
  if (!settled) lines.push('  Every job must finish before CI counts. Rerun with --wait.');
  report(ctx, updated, lines, ['ci']);
  if (state !== 'passed') process.exitCode = state === 'running' ? 3 : 1;
}

// Review

export function cmdReview(opts, sub) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  let using;
  try {
    using = provider(config, ctx.vcs.backend);
  } catch (error) {
    if (error instanceof ProviderError) fail(error.message);
    throw error;
  }
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
    const tip = resolveTip(vcsAt(repo), opts.tip ?? run.tip);
    const entry = builtinSkip({ repo, tip, reason: opts.reason, config });
    lines.push(`Recorded the user's skip of review for ${plural(entry.consensus.commits.length, 'commit')} up to ${short(tip)}.`);
  } else if (sub !== 'status') fail('pipeline review takes status, start, round, done or skip.');
  if (!run.tip) {
    console.log(lines.join('\n'));
    return;
  }
  const result = reviewState(repo, run.tip, config);
  const updated = updateRun(run.id, (current) => setStage(current, 'review', { state: result.state, provider: using, tip: run.tip, summary: result.summary }) && current);
  lines.push(`Review of ${config.trunk}..${short(run.tip)} for ${run.id}: ${result.state}, ${result.summary}.`);
  if (sub === 'status') for (const commit of result.covered) lines.push(`  ${short(commit.id)} ${commit.review.padEnd(9)} ${(commit.topic ?? '').padEnd(24)} ${firstLine(commit.description)}`);
  report(ctx, updated, lines, ['review']);
}

// Rebase

export function cmdRebase(opts) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  const vcs = vcsAt(repo);
  const tip = resolveTip(vcs, opts.tip ?? fail('--tip is required: the rebased tip.'));
  const commits = vcs.listCommits(trunkRange(vcs, config, tip));
  const known = Object.values(run.lanes ?? {}).flatMap((lane) => lane.commits).filter(hasContent);
  const entries = [...agentReviewEntries(config), ...builtinEntries()].filter((entry) => entry.identity === run.identity);
  const covered = coverage(commits, entries);
  const carried = covered.filter((commit) => hasContent(commit) && known.some((recorded) => sameChange(recorded, commit)));
  const changed = covered.filter((commit) => hasContent(commit) && !carried.includes(commit));
  const reopened = covered.filter((commit) => !reviewPassed(commit));
  const updated = updateRun(run.id, (current) => {
    current.rebases = [...(current.rebases ?? []), { from: current.tip, to: tip, carried: carried.map((commit) => commit.id), changed: changed.map((commit) => commit.id), reopened: reopened.map((commit) => commit.id), at: now() }];
    // New commit ids mean the scan, CI and review must be read again on them. A build whose diffs
    // all kept their patch-ids carries over, since CI checks the rebased tree. Changed diffs mean the
    // checks did not see this code.
    const build = current.stages.build;
    const lost = remapLanes(current, commits, vcs);
    moveTip(current, tip, `rebased to ${short(tip)}`);
    if (current.integration) current.integration = { ...current.integration, tip, at: now() };
    if (build && !changed.length && !lost.length) current.stages.build = { ...build, tip };
    else if (current.stages.build) setStage(current, 'build', { state: 'stale', summary: lost.length ? `${plural(lost.length, 'lane commit')} not in the rebased range` : `${plural(changed.length, 'commit')} changed in the rebase, check again` });
    return current;
  });
  const topics = Object.entries(run.reviewTopics ?? {}).filter(([, kind]) => kind === 'code').map(([topic]) => topic);
  const lines = [`Rebase of ${run.id} to ${short(tip)}: ${plural(carried.length, 'commit')} keep their patch-id, ${plural(changed.length, 'commit')} changed, ${plural(reopened.length, 'commit')} lack review consensus.`,
    ...changed.map((commit) => `  changed ${short(commit.id)} ${firstLine(commit.description)}`),
    ...reopened.map((commit) => `  review  ${short(commit.id)} ${commit.review} ${firstLine(commit.description)}`),
    reopened.length ? `  The review reopens: run ${provider(config, vcs.backend) === 'agent-review' ? 'agent-review' : 'pipeline review'} round --topic ${topics[0] ?? '<topic>'} so reviewers see the rebased commits.` : '  Review coverage carried over by patch-id.',
    '  Scan and CI run again on the new commits.'];
  const lost = Object.values(updated.lanes ?? {}).flatMap((lane) => lane.commits.filter((commit) => commit.lost).map((commit) => `  lost    lane ${lane.name}: ${short(commit.id)} ${commit.subject}`));
  if (lost.length) lines.push('  Lane commits missing from the rebased range, so the build must be checked again:', ...lost);
  report(ctx, updated, lines);
}

// Deploy

const docsGaps = (ctx, tip) => {
  const vcs = vcsAt(ctx.repo);
  return docsRuleGaps(vcs.listCommits(trunkRange(vcs, ctx.config, tip)), ctx.config);
};

// Why `tip` may not deploy, as a list. Reads the live repository, so a gate never trusts a stale record.
export function deployProblems(ctx, run, tip) {
  const { repo, config } = ctx;
  const problems = [];
  if (!run) return [`No pipeline run records ${short(tip)}. Record the work with pipeline commits first.`];
  if (run.abandoned) return [`Run ${run.id} was abandoned by ${run.abandoned.by} (${run.abandoned.reason}). Work picked up again starts a new run.`];
  const required = ['intake', 'design', 'build', ...(config.decisions.guessMode ? ['decisions'] : []), ...(run.kind === 'docs' ? ['docs'] : [])];
  for (const stage of required) if (!passed(run, stage)) problems.push(`${stage} has not passed (now ${run.stages[stage]?.state ?? 'none'}).`);
  const covered = reviewCoverage(repo, tip, config);
  const unreviewed = covered.filter((commit) => !reviewPassed(commit));
  if (unreviewed.length) problems.push(`Code review consensus (or the user's recorded skip) is missing for ${plural(unreviewed.length, 'commit')}: ${unreviewed.slice(0, 5).map((commit) => `${short(commit.id)} ${commit.review}`).join(', ')}.`);
  if (run.liveHole && !run.liveHoleClosed) {
    // Its commits stay off the public remote until it deploys, so no CI can run: every local check,
    // every e2e file included, stands in for CI on the exact commit.
    const gaps = checkGaps(fullPlan(config), resultsOn(run, tip));
    if (gaps.length) problems.push(`A run fixing a live hole deploys on local checks in place of CI: every check and every e2e file on ${short(tip)}. Missing: ${gaps.slice(0, 3).join('; ')}${gaps.length > 3 ? '; ...' : ''}. Run pipeline check --run ${run.id} --tip ${short(tip)} --workspace <dir>.`);
  } else {
    const ci = run.ci?.[tip];
    if (!ci) problems.push(`No CI result for the exact commit ${short(tip)}. Push it and run pipeline ci --run ${run.id} --wait.`);
    else if (!ci.settled) problems.push(`CI run ${ci.runId} for ${short(tip)} has not settled: a job is still running.`);
    else if (!ci.ok) problems.push(`CI run ${ci.runId} for ${short(tip)} did not pass (${ci.conclusion}).`);
  }
  const vcs = vcsAt(repo);
  const ids = vcs.commitIds(trunkRange(vcs, config, tip));
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
      if (!match) problems.push('--load takes the load check as loaded/total, such as 12/12.');
      else if (match[1] !== match[2]) problems.push(`The load check loaded ${match[1]} of ${match[2]}.`);
    }
    if (check === 'http') {
      const codes = String(value).split(/[\s,]+/).filter(Boolean);
      if (!codes.length || codes.some((code) => !HTTP_OK.test(code))) problems.push(`HTTP checks answered ${value}. Every check must answer 2xx or 3xx.`);
    }
    if (check === 'restarts' && Number(value) !== 0) problems.push(`The deployed build restarted ${value} times.`);
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
  const tip = resolveTip(vcsAt(repo), opts.tip ?? run.tip);
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
    // In plain git the pre-push hook checks the user's own trunk push too, so the user's command
    // carries the marker that lets it past the agent-only rules (docs/integration.md).
    const trunkMove = ctx.vcs.backend === 'git' && !problems.length ? [config.deploy.runBy === 'user' ? `  The user moves ${config.trunk} with: ${ctx.vcs.commands.pushTrunk(config.remote, config.trunk, tip)}` : `  Move ${config.trunk} with: git push ${config.remote} ${tip}:refs/heads/${config.trunk}`] : [];
    const lines = problems.length ? [`Deploy of ${short(tip)} for ${run.id} refused:`, ...problems.map((problem) => `  - ${problem}`)]
      : [`Deploy of ${short(tip)} for ${run.id} allowed.`, config.deploy.runBy === 'user' ? `  The user runs this deploy. Give the user this command:\n    ${command}` : `  Run: ${command}`, ...trunkMove,
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

// A branch counts as merged when its tip is in trunk, or when every commit it adds is the same change
// as a commit trunk gained since the branch forked (a stack rebased before it landed).
function branchMerged(repo, config, target) {
  const vcs = vcsAt(repo);
  const trunk = trunkId(vcs, config);
  if (vcs.isAncestor(target, trunk)) return true;
  const own = vcs.listCommits(range(target, trunk)).filter(hasContent);
  if (!own.length) return true;
  const landed = trunk ? vcs.listCommits(range(trunk, vcs.forkPoint(target, trunk))) : [];
  return own.every((commit) => landed.some((found) => sameChange(found, commit)));
}

// What a run's lanes leave in a git repository: a worktree git still lists (git worktree remove
// takes its folder too, and git worktree prune forgets one whose folder is gone), a folder git no
// longer lists, and the lane's branch. git has no stale workspace step.
function gitLaneLeftovers(vcs, run, problems, commands) {
  const real = (path) => (existsSync(path) ? realpathSync(path) : path);
  const trees = vcs.workspaces();
  for (const lane of Object.values(run.lanes ?? {})) {
    const listed = trees.some((tree) => tree.path && real(tree.path) === lane.workspace);
    const present = existsSync(lane.workspace);
    if (listed) {
      problems.push(`Worktree ${lane.workspace} (lane ${lane.name}) is still in git's list.`);
      commands.push(present ? `git worktree remove ${JSON.stringify(lane.workspace)}` : 'git worktree prune');
    } else if (present) {
      problems.push(`The folder of lane ${lane.name} still exists: ${lane.workspace}.`);
      commands.push(`rm -rf ${JSON.stringify(lane.workspace)}`);
    }
    if (lane.branch && vcs.localBranch(lane.branch)) {
      problems.push(`Branch ${lane.branch} of lane ${lane.name} still exists.`);
      commands.push(`git branch -D ${lane.branch}`);
    }
  }
}

export function cleanupProblems(ctx, run) {
  const { repo, config } = ctx;
  const problems = [];
  const commands = [];
  // Every branch the run pushed, the ones a rewrite left stale included, since each push recorded it.
  const named = new Set(run.pushedBranches ?? []);
  const vcs = vcsAt(repo);
  for (const bookmark of vcs.remoteBranches(config.remote)) {
    if (!bookmark.target || bookmark.name === config.trunk || !matchesAny(bookmark.name, config.push.branches) || !named.has(bookmark.name)) continue;
    if (branchMerged(repo, config, bookmark.target)) {
      problems.push(`${bookmark.name} is merged but still on ${config.remote}.`);
      // Two commands, since the gate checks a push against the repository as it is before the line
      // runs. In git the delete push comes first, and the local branch goes only when there is one.
      if (vcs.backend === 'git') commands.push(`git push ${config.remote} --delete refs/heads/${bookmark.name}`, ...(vcs.localBranch(bookmark.name) ? [`git branch -D ${bookmark.name}`] : []));
      else commands.push(`jj bookmark track ${bookmark.name}@${config.remote} 2>/dev/null; jj bookmark delete ${bookmark.name}`, `jj git push --remote ${config.remote} --bookmark ${bookmark.name}`);
    }
  }
  if (vcs.backend === 'git') gitLaneLeftovers(vcs, run, problems, commands);
  else {
    const names = vcs.workspaces();
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
  }
  const dbs = Object.values(run.lanes ?? {}).flatMap((lane) => lane.dbs ?? []).concat(run.livePlay?.dbs ?? []);
  if (dbs.length && config.cleanup.databaseList) {
    const listed = runCommand('sh', ['-c', config.cleanup.databaseList], { allowFail: true });
    if (listed.status !== 0) problems.push(`cleanup.databaseList failed (exit ${listed.status ?? listed.signal}), so the tool cannot check that ${dbs.join(', ')} were dropped.`);
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

// Closing or waiving a live hole is the user's call, recorded with who decided and why, as an
// abandon is. close: the hole is no longer live (fixed another way, or it never reached the server),
// so the run's embargo ends. waive: commits recorded before git ids existed, which no copy of the
// objects can compute any more, stop refusing, and the embargo stays in force for every commit id,
// patch id and tip the run knows. Every fingerprint the run holds is kept.
export function cmdLiveHole(opts, sub) {
  const ctx = runContext(opts);
  const { run } = ctx;
  if (!['close', 'waive'].includes(sub)) fail('pipeline live-hole takes close or waive.');
  if (!run.liveHole) fail(`Run ${run.id} does not fix a live hole.`);
  const by = opts.by ?? fail('--by is required: who decided.');
  const reason = (opts.reason ?? fail('--reason is required: the user\'s words for the decision.')).trim();
  if (/^unrecoverable\.?$/i.test(reason)) fail('--reason must say what the user decided and why, not only that the objects are unrecoverable.');
  const field = sub === 'close' ? 'liveHoleClosed' : 'liveHoleWaived';
  if (run[field]) fail(`Run ${run.id} was already ${sub === 'close' ? 'closed' : 'waived'} by ${run[field].by} at ${run[field].at}.`);
  const at = now();
  updateRun(run.id, (current) => {
    current[field] = { at, by, reason };
    current.events.push({ at, stage: 'deploy', action: sub === 'close' ? 'live hole closed' : 'live hole waived', detail: `${by}: ${reason}` });
    return current;
  });
  console.log(sub === 'close'
    ? `Run ${run.id}: ${by} closed the live hole (${reason}). Its commits may be published like any other.`
    : `Run ${run.id}: ${by} waived the commits recorded before git ids existed (${reason}). Every commit id, patch id and tip the run knows still stays off the public remote.`);
}

// Stopping a run is the user's call, so it records who decided and why. It releases the run's lanes
// and is never undone: work picked up again starts a new run.
export function cmdAbandon(opts) {
  const ctx = runContext(opts);
  const { run } = ctx;
  if (run.abandoned) fail(`Run ${run.id} was already abandoned by ${run.abandoned.by} at ${run.abandoned.at}.`);
  if (passed(run, 'deploy')) fail(`Run ${run.id} has deployed. Finish it with pipeline cleanup --run ${run.id}.`);
  const reason = opts.reason ?? fail('--reason is required: why the run stops, in the user\'s words.');
  const by = opts.by ?? fail('--by is required: who decided to stop it.');
  const updated = updateRun(run.id, (current) => {
    current.abandoned = { at: now(), by, reason };
    current.lanesReleased = true;
    current.events.push({ at: current.abandoned.at, stage: 'intake', action: 'abandoned', detail: `${by}: ${reason}` });
    return current;
  });
  const { commands } = cleanupProblems(ctx, updated);
  const lines = [`Run ${run.id} abandoned by ${by}: ${reason}. Its lanes no longer own files.`];
  if (run.liveHole) lines.push('  It fixed a live hole, so its commits still stay off the public remote.');
  if (commands.length) lines.push('  To clean up its branches, workspaces and databases:', ...commands.map((command) => `    ${command}`));
  console.log(lines.join('\n'));
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

