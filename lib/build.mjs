// The build stage: lanes, their commits, their checks, mutation checks and reports.
//
// Each lane is one builder in its own jj workspace, owning a set of files no other open lane owns.
// The stage passes when every lane's commits follow the commit rules, its checks passed in order on
// its tip, each new test was shown to fail without its fix, and its report is in.

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { checkGaps, logDir, plan, readCounts, runChecks, checkPassed } from './checks.mjs';
import { runContext } from './context.mjs';
import { loadRuns, requireStages, setStage, updateRun } from './ledger.mjs';
import { checkBrief, missingSignoffs, report } from './plan.mjs';
import { fail, fillTemplate, matchesAny, now, plural, run as runCommand, sha256, short, splitList } from './util.mjs';
import { commitIds, firstLine, gitDir, jj, jjRoot, listCommits, repoIdentity, resolveTip, touchedPaths, trunkRev } from './vcs.mjs';

const LANE = /^[a-z0-9][a-z0-9-]{0,19}$/;
const EM_DASH = '\u2014';

const openRuns = (identity) => loadRuns().filter((entry) => entry.identity === identity && !entry.lanesReleased);

function laneOf(run, name) {
  const lane = run.lanes?.[name ?? fail('--lane is required.')];
  if (!lane) fail(`Run ${run.id} has no lane ${name}. Add it with pipeline lane.`);
  return lane;
}

function parseEnv(value) {
  return Object.fromEntries(splitList(value).map((pair) => {
    const at = pair.indexOf('=');
    if (at < 1) fail(`--env takes NAME=value pairs, comma separated. Got ${pair}.`);
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
}

// Files tracked at the base that two lanes' globs both match. A new file no lane names yet is caught
// later, when a lane's commits touch a file outside its own globs.
function ownershipOverlap(repo, base, mine, theirs) {
  const files = jj(repo, ['file', 'list', '-r', base]).split('\n').filter(Boolean);
  const shared = mine.filter((glob) => theirs.includes(glob));
  return [...new Set([...shared, ...files.filter((file) => matchesAny(file, mine) && matchesAny(file, theirs))])];
}

export function cmdLane(opts) {
  const ctx = runContext(opts);
  const { run, config } = ctx;
  requireStages(run, ['intake', 'design'], 'A build lane');
  const name = opts.lane ?? fail('--lane is required.');
  if (!LANE.test(name)) fail('--lane must be 1-20 lowercase letters, digits or hyphens.');
  const given = resolve(opts.workspace ?? fail('--workspace is required: the lane\'s own jj workspace.'));
  const workspace = existsSync(given) ? realpathSync(given) : given;
  const root = jjRoot(workspace);
  if (!root || root !== workspace) fail(`${workspace} is not the root of a jj workspace. Create it with jj workspace add.`);
  if (repoIdentity(root) !== run.identity) fail(`${workspace} is a workspace of another repository.`);
  const owns = splitList(opts.owns);
  if (!owns.length) fail('--owns is required: the globs of the files this lane owns, comma separated.');
  const base = resolveTip(root, opts.base ?? trunkRev(config));
  const problems = [];
  // The design the reviewers agreed on must be the one the lane builds.
  const design = run.stages.design;
  const notePath = design?.mode === 'note' && design.note ? join(workspace, design.note.startsWith(ctx.repo) ? design.note.slice(ctx.repo.length + 1) : basename(design.note)) : null;
  if (notePath && existsSync(notePath) && sha256(readFileSync(notePath, 'utf8')) !== design.sha256) problems.push(`The design note in this workspace (${notePath}) differs from the one the design review agreed on.`);
  for (const other of openRuns(run.identity)) {
    for (const [otherName, lane] of Object.entries(other.lanes ?? {})) {
      if (other.id === run.id && otherName === name) continue;
      if (lane.workspace === workspace) problems.push(`Lane ${other.id}/${otherName} already builds in ${workspace}. Each lane gets its own workspace.`);
      const overlap = ownershipOverlap(root, base, owns, lane.owns);
      if (overlap.length) problems.push(`Lane ${other.id}/${otherName} already owns ${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? ` and ${overlap.length - 5} more` : ''}.`);
    }
  }
  let brief = null;
  if (opts.brief) {
    const path = resolve(opts.brief);
    if (!existsSync(path)) fail(`${path} does not exist.`);
    const text = readFileSync(path, 'utf8');
    const check = checkBrief(text, { run, kind: run.kind === 'followups' ? 'followups' : 'build', config, extraDecisions: splitList(opts.decisions) });
    problems.push(...check.problems.map((problem) => `Brief: ${problem}`));
    brief = { file: path, sha256: sha256(text), decisionIds: check.decisionIds };
  } else if (config.brief.preamble) problems.push('--brief is required: the lane\'s brief, which points at the shared preamble.');
  if (problems.length) fail([`Lane ${name} refused:`, ...problems.map((problem) => `  - ${problem}`)].join('\n'));
  const updated = updateRun(run.id, (current) => {
    current.lanes[name] = { name, workspace, workspaceName: opts.name ?? basename(workspace), owns, dbs: splitList(opts.db), env: parseEnv(opts.env), base, brief, addedAt: now(), commits: [], checks: [], mutations: [], report: null, ...(current.lanes[name] ? { checks: current.lanes[name].checks, mutations: current.lanes[name].mutations } : {}) };
    if (brief) current.briefs = [...(current.briefs ?? []).filter((entry) => entry.file !== brief.file), { ...brief, kind: 'build', lane: name, ok: true, at: now() }];
    setStage(current, 'build', { state: 'in-progress', summary: `${plural(Object.keys(current.lanes).length, 'lane')} building` });
    return current;
  });
  report(ctx, updated, [`Lane ${name} of ${run.id}: ${workspace}, base ${short(base)}, owns ${owns.join(', ')}.`], ['build']);
}

const CONVENTIONAL = (types) => new RegExp(`^(${types.join('|')})(\\([a-z0-9][a-z0-9 ,&/._-]*\\))?!?: \\S`);

// What is wrong with one commit under the commit rules and the lane's ownership.
export function commitProblems(commit, { config, lane, kind, outside }) {
  const problems = [];
  const subject = firstLine(commit.description);
  if (config.commits.conventional) {
    if (!CONVENTIONAL(config.commits.types).test(subject)) problems.push(`not a conventional commit (${config.commits.types.join(', ')}): "${subject}"`);
    else if (/^[^:]*: [A-Z]/.test(subject)) problems.push('starts with a capital letter after the colon');
  }
  if (config.commits.oneLine && commit.description.trim().includes('\n')) problems.push('has a body. Commits are one line');
  if (config.commits.forbidEmDash && commit.description.includes(EM_DASH)) problems.push('has an em dash in its message');
  const trailer = config.commits.forbiddenTrailers.find((pattern) => new RegExp(pattern, 'im').test(commit.description));
  if (trailer) problems.push(`has a forbidden trailer (${trailer})`);
  if (!config.commits.acceptedSignatures.includes(commit.signature)) problems.push(`is not signed (signature: ${commit.signature})`);
  const paths = touchedPaths(commit);
  if (lane) {
    const foreign = paths.filter((path) => !matchesAny(path, lane.owns) && !outside[path]);
    if (foreign.length) problems.push(`touches files outside the lane's ownership: ${foreign.join(', ')}. Pass --outside "<path>: <reason>" for each one that must change.`);
  }
  const docsFiles = [config.docs.featureList, config.docs.guide, ...config.docs.shortcutDocs].filter(Boolean);
  if (config.docs.separateCommit && paths.some((path) => docsFiles.includes(path)) && paths.some((path) => matchesAny(path, config.docs.behaviorPaths) && !new RegExp(config.tests.pattern).test(path))) {
    problems.push('mixes feature list or guide changes with code. Put them in the lane\'s own last docs commit');
  }
  if (kind === 'fast' && paths.some((path) => matchesAny(path, config.fastLane.forbiddenPaths))) problems.push(`touches a path the fast lane may not (${config.fastLane.forbiddenPaths.join(', ')}). Use a feature run`);
  return problems;
}

export function cmdCommits(opts) {
  const pre = runContext(opts);
  const lane = laneOf(pre.run, opts.lane);
  const ctx = runContext(opts, { dir: lane.workspace });
  const { run, config } = ctx;
  const tip = resolveTip(lane.workspace, opts.tip);
  const commits = listCommits(lane.workspace, `${lane.base}..${tip}`);
  if (!commits.length) fail(`No commits between the lane's base ${short(lane.base)} and ${short(tip)}.`);
  const outside = Object.fromEntries((Array.isArray(opts.outside) ? opts.outside : opts.outside ? [opts.outside] : []).map((entry) => {
    const at = entry.indexOf(':');
    if (at < 1) fail('--outside takes "<path>: <reason>".');
    return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
  }));
  const findings = commits.filter((commit) => !commit.empty).flatMap((commit) => commitProblems(commit, { config, lane, kind: run.kind, outside: { ...lane.outside, ...outside } }).map((problem) => `${short(commit.id)} ${problem}`));
  // A new file matches no tracked file when lanes are added, so two lanes' globs can both claim it.
  // Any file another open lane owns is a conflict between parallel builders.
  const acknowledged = { ...lane.outside, ...outside };
  for (const other of openRuns(run.identity)) {
    for (const [name, entry] of Object.entries(other.lanes ?? {})) {
      if (other.id === run.id && name === lane.name) continue;
      const shared = [...new Set(commits.flatMap(touchedPaths))].filter((path) => matchesAny(path, entry.owns) && !acknowledged[path]);
      if (shared.length) findings.push(`touches files lane ${other.id}/${name} owns: ${shared.join(', ')}. Parallel lanes never edit the same file.`);
    }
  }
  if (run.kind === 'fast') {
    const files = new Set(commits.flatMap(touchedPaths));
    if (files.size > config.fastLane.maxFiles) findings.push(`The fast lane changes ${files.size} files, over fastLane.maxFiles (${config.fastLane.maxFiles}). Use a feature run with a design note.`);
  }
  const updated = updateRun(run.id, (current) => {
    const entry = current.lanes[lane.name];
    entry.tip = tip;
    entry.outside = { ...entry.outside, ...outside };
    entry.commits = commits.map(({ id, changeId, patchId, description, signature, empty, files }) => ({ id, changeId, patchId, subject: firstLine(description), signature, empty, files: files.map((file) => file.path) }));
    entry.commitFindings = findings;
    current.tip = tip;
    setStage(current, 'build', { state: 'in-progress', summary: `lane ${lane.name} at ${short(tip)}, ${plural(commits.length, 'commit')}` });
    return current;
  });
  const lines = [`Lane ${lane.name} of ${run.id}: ${plural(commits.length, 'commit')} up to ${short(tip)}, ${findings.length ? `${plural(findings.length, 'problem')}` : 'all follow the commit rules'}.`,
    ...commits.map((commit) => `  ${short(commit.id)} ${commit.changeId} ${commit.signature.padEnd(7)} ${firstLine(commit.description)}`), ...findings.map((finding) => `  - ${finding}`)];
  report(ctx, updated, lines, ['build']);
  if (findings.length) process.exitCode = 1;
}

// The working copy must hold nothing uncommitted, or the results would describe code no commit has.
function workspaceOn(workspace, tip) {
  const result = runCommand('jj', ['--no-pager', '--color', 'never', 'log', '--no-graph', '-r', '@', '-T', 'commit_id ++ " " ++ if(empty, "empty", "changed") ++ " " ++ parents.map(|c| c.commit_id()).join(",")'], { cwd: workspace, allowFail: true });
  if (result.status !== 0) fail(`jj could not read ${workspace}: ${result.stderr.trim()}`);
  const [at, state, parents] = result.stdout.trim().split(' ');
  if (at === tip) return;
  if (state !== 'empty') fail(`${workspace} has uncommitted changes. Commit them and rerun pipeline commits, so the checks run on commits.`);
  if (!parents.split(',').includes(tip)) fail(`${workspace} is not on the lane's recorded tip ${short(tip)}. Run pipeline commits first.`);
}

const stepsFor = (lane, config) => plan(config, lane.e2eFiles ?? []).filter((step) => !lane.checkPlan || lane.checkPlan.includes(step.name));

export async function cmdCheck(opts) {
  const pre = runContext(opts);
  const lane = laneOf(pre.run, opts.lane);
  const ctx = runContext(opts, { dir: lane.workspace });
  const { run, config } = ctx;
  if (!lane.tip) fail(`Lane ${lane.name} has no commits recorded. Run pipeline commits first.`);
  const e2eFiles = opts.e2e === 'all' ? config.checks.e2e.files : opts.e2e !== undefined ? splitList(opts.e2e) : lane.e2eFiles ?? [];
  const unknown = e2eFiles.filter((file) => config.checks.e2e.files.length && !config.checks.e2e.files.includes(file));
  if (unknown.length) fail(`Not in checks.e2e.files: ${unknown.join(', ')}.`);
  const full = plan(config, e2eFiles);
  const only = splitList(opts.only);
  if (opts.record) return recordCheck(ctx, lane, full, opts);
  const steps = only.length ? full.filter((step) => only.includes(step.name)) : full;
  if (!steps.length) fail('No checks to run. Configure checks.parallel, checks.integration and checks.e2e.');
  if (opts['dry-run']) {
    console.log(steps.map((step) => `${step.phase.padEnd(11)} ${step.name}: ${step.command}`).join('\n'));
    return;
  }
  workspaceOn(lane.workspace, lane.tip);
  if (!only.length) updateRun(run.id, (current) => { Object.assign(current.lanes[lane.name], { e2eFiles, checkPlan: full.map((step) => step.name) }); });
  const dir = logDir(run.id, lane.name, lane.tip);
  console.log(`Checks for lane ${lane.name} on ${short(lane.tip)}, logs in ${dir}:`);
  const results = await runChecks(steps, {
    cwd: lane.workspace, env: { ...config.checks.env, ...lane.env }, dir, config,
    onResult: (result) => {
      updateRun(run.id, (current) => { current.lanes[lane.name].checks.push({ ...result, tip: lane.tip }); });
      const counts = Object.entries(result.counts).map(([name, count]) => `${name} ${count}`).join(', ');
      console.log(`  ${checkPassed(result) ? 'ok  ' : 'FAIL'} ${result.name}: exit ${result.exit}${counts ? `, ${counts}` : ''}, ${Math.round(result.durationMs / 1000)} s`);
    },
  });
  const latest = updateRun(run.id, (current) => current);
  const gaps = checkGaps(stepsFor(latest.lanes[lane.name], config), latest.lanes[lane.name].checks.filter((result) => result.tip === lane.tip));
  console.log(gaps.length ? [`Lane ${lane.name} checks not green:`, ...gaps.map((gap) => `  - ${gap}`)].join('\n') : `Lane ${lane.name} checks all passed on ${short(lane.tip)}.`);
  if (!results.every(checkPassed) || gaps.length) process.exitCode = 1;
}

// A check run outside the tool (by a builder's own script) is recorded with its exit code and log.
function recordCheck(ctx, lane, full, opts) {
  const step = full.find((entry) => entry.name === opts.record);
  if (!step) fail(`${opts.record} is not a configured check. Configured: ${full.map((entry) => entry.name).join(', ')}.`);
  if (opts.exit === undefined) fail('--exit is required with --record.');
  const log = resolve(opts.log ?? fail('--log is required with --record: the check\'s full output.'));
  if (!existsSync(log)) fail(`${log} does not exist.`);
  const earlier = full.filter((entry) => ['parallel', 'integration', 'e2e'].indexOf(entry.phase) < ['parallel', 'integration', 'e2e'].indexOf(step.phase));
  const results = lane.checks.filter((result) => result.tip === lane.tip);
  const notGreen = earlier.filter((entry) => !results.some((result) => result.name === entry.name && checkPassed(result)));
  if (notGreen.length) fail(`Checks run in order. Record ${notGreen.map((entry) => entry.name).join(', ')} as passing on ${short(lane.tip)} before ${step.name}.`);
  const result = { phase: step.phase, name: step.name, command: step.command, exit: Number(opts.exit), counts: readCounts(readFileSync(log, 'utf8'), ctx.config.checks.resultPatterns), durationMs: null, log, at: now(), tip: lane.tip, recorded: true };
  updateRun(ctx.run.id, (current) => {
    current.lanes[lane.name].checks.push(result);
    current.lanes[lane.name].checkPlan ??= full.map((entry) => entry.name);
  });
  console.log(`Recorded ${step.name} on ${short(lane.tip)}: exit ${result.exit}${Object.keys(result.counts).length ? `, ${Object.entries(result.counts).map(([name, count]) => `${name} ${count}`).join(', ')}` : ''}.`);
  if (!checkPassed(result)) process.exitCode = 1;
}

const isTest = (path, config) => new RegExp(config.tests.pattern).test(path);
const isDocs = (path) => /\.(md|mdx|txt|rst)$/i.test(path);

// Commits that change code and a test together, so removing the code part should fail the test.
export const needsMutation = (commit, config) => commit.files.some((path) => isTest(path, config)) && commit.files.some((path) => !isTest(path, config) && !isDocs(path));

export function cmdMutation(opts) {
  const pre = runContext(opts);
  const lane = laneOf(pre.run, opts.lane);
  const ctx = runContext(opts, { dir: lane.workspace });
  const { run, config } = ctx;
  const id = commitIds(lane.workspace, opts.commit ?? fail('--commit is required: the commit holding the fix and its test.'))[0];
  const commit = lane.commits.find((entry) => entry.id === id);
  if (!commit) fail(`${opts.commit} is not one of lane ${lane.name}'s recorded commits. Run pipeline commits first.`);
  const test = opts.test ?? fail('--test is required: the test file to run.');
  let record;
  if (opts.manual) {
    if (opts.exit === undefined || Number(opts.exit) === 0) fail('--manual needs --exit with the failing exit code of the test run without the fix.');
    record = { commit: id, patchId: commit.patchId, test, manual: opts.manual, exit: Number(opts.exit), log: opts.log ? resolve(opts.log) : null, at: now() };
  } else {
    const code = commit.files.filter((path) => !isTest(path, config) && !isDocs(path));
    if (!code.length) fail(`${short(id)} changes no code outside tests and docs, so there is no fix to remove. Use --manual with how you broke the code.`);
    const command = fillTemplate(opts.cmd ?? config.mutation.command, { file: test });
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-mutation-'));
    try {
      const git = gitDir(lane.workspace);
      runCommand('sh', ['-c', 'git --git-dir="$1" archive "$2" | tar -x -C "$3"', 'sh', git, id, dir]);
      for (const name of config.mutation.link) if (existsSync(join(lane.workspace, name)) && !existsSync(join(dir, name))) symlinkSync(join(lane.workspace, name), join(dir, name));
      const opts2 = { cwd: dir, allowFail: true, timeout: config.mutation.timeoutSec * 1000, env: { ...config.checks.env, ...lane.env } };
      const withFix = runCommand('sh', ['-c', command], opts2);
      if (withFix.status !== 0) fail(`${test} fails with its fix in place, in a fresh tree of ${short(id)} (exit ${withFix.status}). The tree may lack something the test needs (mutation.link), or the test is broken:\n${(withFix.stdout + withFix.stderr).trim().split('\n').slice(-15).join('\n')}`);
      const patch = runCommand('git', ['--git-dir', git, 'diff', '--binary', `${id}^`, id, '--', ...code]).stdout;
      runCommand('git', ['apply', '-R', '--whitespace=nowarn'], { cwd: dir, input: patch });
      const without = runCommand('sh', ['-c', command], opts2);
      if (without.status === 0) fail(`${test} still passes with the fix in ${code.join(', ')} removed. It does not test the fix.`);
      record = { commit: id, patchId: commit.patchId, test, command, removed: code, passedWithFix: true, failedWithoutFix: true, exit: without.status, at: now() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  updateRun(run.id, (current) => { current.lanes[lane.name].mutations.push(record); });
  console.log(`Mutation check for ${short(id)} (${test}): ${record.manual ? `manual, ${record.manual}` : `passes with the fix, fails without it (exit ${record.exit})`}.`);
}

export function cmdReport(opts) {
  const pre = runContext(opts);
  const lane = laneOf(pre.run, opts.lane);
  const path = resolve(opts.file ?? fail('--file is required: the lane\'s full report.'));
  if (!existsSync(path)) fail(`${path} does not exist.`);
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) fail(`${path} is empty.`);
  const missing = pre.config.report.sections.filter((section) => !new RegExp(`^#{1,4}\\s+.*\\b${section}\\b`, 'im').test(text));
  if (missing.length) fail(`The report has no ${missing.map((section) => `"${section}"`).join(', ')} section.`);
  updateRun(pre.run.id, (current) => { current.lanes[lane.name].report = { file: path, sha256: sha256(text), lines: text.split('\n').length, at: now() }; });
  console.log(`Report for lane ${lane.name}: ${path} (${text.split('\n').length} lines).`);
}

// Why a lane has not passed, or an empty list.
export function laneGaps(lane, config) {
  const gaps = [];
  if (!lane.tip || !lane.commits.length) return ['no commits recorded (pipeline commits)'];
  for (const finding of lane.commitFindings ?? []) gaps.push(`commit rule: ${finding}`);
  const steps = stepsFor(lane, config);
  if (!lane.checkPlan) gaps.push('checks have not run (pipeline check)');
  else gaps.push(...checkGaps(steps, lane.checks.filter((result) => result.tip === lane.tip)));
  const missingAlways = config.checks.e2e.command ? config.checks.e2e.always.filter((file) => !(lane.checkPlan ?? []).includes(`e2e:${file}`)) : [];
  if (missingAlways.length) gaps.push(`e2e files every lane runs were left out: ${missingAlways.join(', ')}`);
  if (config.mutation.required) {
    for (const commit of lane.commits.filter((entry) => needsMutation(entry, config))) {
      if (!lane.mutations.some((record) => record.commit === commit.id || (record.patchId && record.patchId === commit.patchId))) gaps.push(`${short(commit.id)} adds a test with its fix but has no mutation check (pipeline mutation)`);
    }
  }
  if (!lane.report) gaps.push('no report recorded (pipeline report)');
  return gaps;
}

export function cmdBuild(opts) {
  const ctx = runContext(opts);
  const { run, config } = ctx;
  requireStages(run, ['intake', 'design'], 'The build stage');
  const lanes = Object.values(run.lanes ?? {});
  if (!lanes.length) fail(`Run ${run.id} has no lanes. Add one with pipeline lane.`);
  const gaps = lanes.flatMap((lane) => laneGaps(lane, config).map((gap) => `lane ${lane.name}: ${gap}`));
  const signoffs = missingSignoffs(run, 'build', config);
  const state = gaps.length || signoffs.length ? 'in-progress' : 'passed';
  const summary = state === 'passed' ? `${plural(lanes.length, 'lane')} built and checked, tip ${short(run.tip)}` : `${plural(gaps.length + signoffs.length, 'gap')} left`;
  const topic = opts['review-topic'];
  const updated = updateRun(run.id, (current) => {
    setStage(current, 'build', { state, summary, gaps, signoffsMissing: signoffs });
    if (topic) current.reviewTopics = { ...(current.reviewTopics ?? {}), [topic]: 'code' };
    return current;
  });
  const lines = [`Build for ${run.id}: ${state}. ${summary}.`, ...gaps.map((gap) => `  - ${gap}`),
    ...signoffs.map((item) => `  - sign-off missing: pipeline signoff --run ${run.id} --stage build --item ${item} --by <you> --note "<what you checked>"`)];
  report(ctx, updated, lines, ['build']);
  if (state !== 'passed') process.exitCode = 1;
}
