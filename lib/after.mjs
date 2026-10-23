// After a deploy: live play of the deployed build, the follow-up backlog, and the docs.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runContext } from './context.mjs';
import { missingDecisions } from './decisions.mjs';
import { addItem, loadBacklog, planLanes, renderBacklog, saveBacklog } from './followups.mjs';
import { loadRuns, passed, requireStages, setStage, updateRun } from './ledger.mjs';
import { checkBrief, missingSignoffs, report } from './plan.mjs';
import { fail, fillTemplate, matchesAny, now, plural, short, splitList } from './util.mjs';
import { firstLine, listCommits, resolveOne, resolveTip, touchedPaths, trunkRev } from './vcs.mjs';

const SEVERITY = /^P[0-3]$/;
const STATUSES = ['fixed', 'needs-owner', 'known', 'not-a-bug'];

// Docs rules that can be checked on a range of commits.
export function docsRuleGaps(commits, config) {
  const gaps = [];
  const { featureList, shortcutSources, shortcutDocs, behaviorPaths } = config.docs;
  const testPattern = new RegExp(config.tests.pattern);
  const touched = new Set(commits.flatMap(touchedPaths));
  const changesBehavior = (commit) => touchedPaths(commit).some((path) => matchesAny(path, behaviorPaths) && !testPattern.test(path));
  const features = commits.filter((commit) => /^feat(\(|!|:)/.test(firstLine(commit.description)) && changesBehavior(commit));
  if (featureList && features.length && !touched.has(featureList)) gaps.push(`${plural(features.length, 'feat commit')} change behavior but ${featureList} is not updated in this range (${features.slice(0, 3).map((commit) => short(commit.id)).join(', ')}).`);
  if (shortcutSources.length && commits.some((commit) => touchedPaths(commit).some((path) => shortcutSources.includes(path)))) {
    const missing = shortcutDocs.filter((doc) => !touched.has(doc));
    if (missing.length) gaps.push(`The shortcut registry changed but ${missing.join(', ')} did not. Keys and key-plus-pointer combinations update the sheet and the feature list together.`);
  }
  return gaps;
}

// Live play

const bugIdPattern = (config, prefix) => new RegExp(fillTemplate(config.livePlay.idPattern, { prefix: prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }));

const resolveCommit = (repo, rev) => listCommits(repo, resolveOne(repo, rev))[0];

function bugFrom(fields, repo, config, prefix) {
  const { id, severity, area, summary, status } = fields;
  if (!bugIdPattern(config, prefix).test(id ?? '')) fail(`Bug ID ${id} does not match ${fillTemplate(config.livePlay.idPattern, { prefix })}.`);
  if (!SEVERITY.test(severity ?? '')) fail(`${id}: severity must be P0, P1, P2 or P3.`);
  if (!STATUSES.includes(status)) fail(`${id}: status must be one of ${STATUSES.join(', ')}.`);
  const bug = { id, severity, area: area ?? null, summary: summary ?? '', status, recommend: fields.recommend ?? null, at: now() };
  if (status === 'fixed') {
    const commit = resolveCommit(repo, fields.commit ?? fail(`${id} is fixed: pass the fix's commit or change id.`));
    bug.commit = { id: commit.id, changeId: commit.changeId, patchId: commit.patchId, subject: firstLine(commit.description), files: touchedPaths(commit) };
  }
  if (status === 'needs-owner' && !bug.recommend) fail(`${id} needs the owner: pass --recommend with your recommended answer.`);
  return bug;
}

// Reads the bug table from a live play report: rows whose first cell is a bug ID, with the columns
// ID, severity, area, summary and status. A status cell reads "fixed <commit>" or "needs owner: <recommendation>".
export function parseBugTable(text, config, prefix) {
  const pattern = bugIdPattern(config, prefix);
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim().replace(/^\*\*|\*\*$/g, ''));
    if (!pattern.test(cells[0] ?? '')) continue;
    const [id, severity, area, summary, statusCell = ''] = cells;
    const status = /^fixed\b/i.test(statusCell) ? 'fixed' : /needs[ -]owner/i.test(statusCell) ? 'needs-owner' : /not a bug/i.test(statusCell) ? 'not-a-bug' : 'known';
    rows.push({ id, severity, area, summary, status, commit: /^fixed\W+([a-z0-9]{8,40})/i.exec(statusCell)?.[1] ?? null, recommend: status === 'needs-owner' ? statusCell.replace(/^.*needs[ -]owner[:,]?\s*/i, '') || null : null });
  }
  return rows;
}

// Patch-ids of commits now in trunk since the deployed commit, which tell whether a fix has shipped.
const landedPatchIds = (repo, config, since) => new Set(listCommits(repo, `${since}..${trunkRev(config)}`).map((commit) => commit.patchId).filter(Boolean));

export function livePlayGaps(ctx, run) {
  const { repo, config } = ctx;
  const live = run.livePlay;
  if (!live) return ['live play has not started (pipeline live-play start)'];
  const gaps = [];
  const landed = landedPatchIds(repo, config, live.deployed);
  const backlog = loadBacklog(run.identity);
  for (const bug of live.bugs) {
    if (bug.status === 'fixed') {
      if (!/^fix(\(|!|:)/.test(bug.commit.subject)) gaps.push(`${bug.id}: its commit is not a fix commit ("${bug.commit.subject}")`);
      if (bug.commit.files.length > config.livePlay.maxFilesPerFix) gaps.push(`${bug.id}: its fix touches ${bug.commit.files.length} files, over livePlay.maxFilesPerFix (${config.livePlay.maxFilesPerFix}). A live play fix is small, or it is a design change`);
      if (!landed.has(bug.commit.patchId)) gaps.push(`${bug.id}: its fix ${short(bug.commit.id)} has not shipped. Fixes go through review and a deploy like any change`);
    } else if (bug.status === 'needs-owner') {
      const decided = bug.decision && !missingDecisions([bug.decision], config).length;
      const queued = bug.followup && backlog.items.some((item) => item.id === bug.followup);
      if (!decided && !queued) gaps.push(`${bug.id}: needs the owner. Log the decision (pipeline decide) and resolve it with --decision, or queue it with --followup`);
    }
  }
  gaps.push(...missingSignoffs(run, 'live-play', config).map((item) => `sign-off missing: ${item}`));
  return gaps;
}

export function cmdLivePlay(opts, sub) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  const save = (change, lines) => {
    const updated = updateRun(run.id, change);
    const gaps = livePlayGaps(ctx, updated);
    const bugs = updated.livePlay?.bugs ?? [];
    const counts = ['P0', 'P1', 'P2', 'P3'].map((severity) => [severity, bugs.filter((bug) => bug.severity === severity).length]).filter(([, count]) => count).map(([severity, count]) => `${count} ${severity}`).join(', ');
    const summary = `${updated.livePlay?.prefix ?? 'live play'}: ${plural(bugs.length, 'bug')}${counts ? ` (${counts})` : ''}, ${bugs.filter((bug) => bug.status === 'fixed').length} fixed${gaps.length ? `, ${plural(gaps.length, 'item')} open` : ''}`;
    const final = updateRun(run.id, (current) => setStage(current, 'live-play', { state: gaps.length ? 'in-progress' : 'passed', summary }) && current);
    report(ctx, final, [...lines, `Live play for ${run.id}: ${gaps.length ? 'in progress' : 'passed'}. ${summary}.`, ...gaps.map((gap) => `  - ${gap}`)], ['live-play']);
    if (gaps.length && sub === 'done') process.exitCode = 1;
  };
  if (sub === 'start') {
    requireStages(run, ['deploy'], 'Live play');
    const prefix = opts.prefix ?? fail('--prefix is required, such as LP14.');
    const deployed = resolveTip(repo, opts.deployed ?? run.stages.deploy.tip);
    if (deployed !== run.stages.deploy.tip && !(run.deploys ?? []).some((deploy) => deploy.tip === deployed && !deploy.failed)) fail(`${short(deployed)} is not a commit this run deployed. Live play runs on the deployed build.`);
    let brief = null;
    if (opts.brief) {
      const path = resolve(opts.brief);
      const text = existsSync(path) ? readFileSync(path, 'utf8') : fail(`${path} does not exist.`);
      const check = checkBrief(text, { run, kind: 'live-play', config });
      if (check.problems.length) fail([`The live play brief is refused:`, ...check.problems.map((problem) => `  - ${problem}`)].join('\n'));
      brief = path;
    }
    return save((current) => {
      current.livePlay = { prefix, deployed, workspace: opts.workspace ? resolve(opts.workspace) : null, dbs: splitList(opts.db), brief, bugs: current.livePlay?.bugs ?? [], startedAt: now() };
      return current;
    }, [`Live play ${prefix} of ${run.id} on ${short(deployed)}.`]);
  }
  if (!run.livePlay) fail(`Live play has not started for ${run.id}. Run pipeline live-play start.`);
  const prefix = run.livePlay.prefix;
  const where = run.livePlay.workspace && existsSync(run.livePlay.workspace) ? run.livePlay.workspace : repo;
  if (sub === 'bug') {
    const bug = bugFrom(opts, where, config, prefix);
    return save((current) => { current.livePlay.bugs = [...current.livePlay.bugs.filter((entry) => entry.id !== bug.id), bug]; return current; }, [`Recorded ${bug.id} (${bug.severity}, ${bug.status}).`]);
  }
  if (sub === 'import') {
    const path = resolve(opts.report ?? fail('--report is required: the live play report with its bug table.'));
    const rows = parseBugTable(readFileSync(path, 'utf8'), config, prefix);
    if (!rows.length) fail(`No bug rows starting with ${prefix}- in ${path}.`);
    const bugs = rows.map((row) => bugFrom(row, where, config, prefix));
    return save((current) => {
      const ids = new Set(bugs.map((bug) => bug.id));
      current.livePlay.bugs = [...current.livePlay.bugs.filter((bug) => !ids.has(bug.id)), ...bugs];
      current.livePlay.report = path;
      return current;
    }, [`Imported ${plural(bugs.length, 'bug')} from ${path}.`]);
  }
  if (sub === 'resolve') {
    const id = opts.id ?? fail('--id is required.');
    if (!opts.decision && !opts.followup) fail('Pass --decision <logged decision ID> or --followup <backlog item ID>.');
    if (opts.decision && missingDecisions([opts.decision], config).length) fail(`${opts.decision} is not in the decision log.`);
    return save((current) => {
      const bug = current.livePlay.bugs.find((entry) => entry.id === id) ?? fail(`No bug ${id} in this live play.`);
      Object.assign(bug, { decision: opts.decision ?? bug.decision ?? null, followup: opts.followup ?? bug.followup ?? null });
      return current;
    }, [`Resolved ${id}.`]);
  }
  if (sub === 'done' || sub === 'status') return save((current) => current, []);
  fail('pipeline live-play takes start, bug, import, resolve, status or done.');
}

// Follow-ups

export function cmdFollowup(opts, sub) {
  const ctx = runContext(opts);
  const { run, config } = ctx;
  const backlog = loadBacklog(run.identity);
  if (sub === 'add') {
    const item = addItem(backlog, { id: opts.id, severity: opts.severity, source: opts.source, text: opts.text, files: splitList(opts.files), decision: opts.decision }, config, (id) => !missingDecisions([id], config).length);
    saveBacklog(backlog);
    console.log(`Added ${item.id} (${item.severity}) to the backlog.`);
  } else if (sub === 'list') {
    console.log(renderBacklog(backlog, { open: Boolean(opts.open) }));
  } else if (sub === 'plan') {
    const ids = splitList(opts.ids);
    const items = backlog.items.filter((item) => item.status === 'open' && (!ids.length || ids.includes(item.id)));
    const unknown = ids.filter((id) => !backlog.items.some((item) => item.id === id));
    if (unknown.length) fail(`Not in the backlog: ${unknown.join(', ')}.`);
    if (!items.length) fail('No open items to plan.');
    const noFiles = items.filter((item) => !item.files.length);
    const lanes = planLanes(items, Number(opts.lanes ?? 2));
    const lines = [`Plan for ${plural(items.length, 'item')} in ${plural(lanes.length, 'lane')}, no file in two lanes:`];
    for (const lane of lanes) {
      lines.push(`  lane ${lane.lane}: ${lane.items.map((item) => item.id).join(', ')}`, `    owns ${lane.files.join(', ') || '(no files named)'}`,
        `    pipeline lane --run ${run.id} --lane ${lane.lane} --workspace <repo>-${run.id}${lane.lane} --owns "${lane.files.join(',')}" --brief <brief>`);
    }
    if (noFiles.length) lines.push(`  Items without --files could land in any lane: ${noFiles.map((item) => item.id).join(', ')}. Name their files for a safe split.`);
    if (opts.apply) {
      for (const lane of lanes) for (const item of lane.items) Object.assign(backlog.items.find((entry) => entry.id === item.id), { status: 'planned', run: run.id, lane: lane.lane });
      saveBacklog(backlog);
      lines.push(`  Marked as planned in run ${run.id}.`);
    }
    console.log(lines.join('\n'));
  } else if (sub === 'close') {
    const item = backlog.items.find((entry) => entry.id === opts.id) ?? fail(`No item ${opts.id} in the backlog.`);
    const commit = resolveOne(ctx.repo, opts.commit ?? fail('--commit is required: the commit that fixed it.'), `--commit ${opts.commit}`);
    Object.assign(item, { status: 'done', commit, closedAt: now() });
    saveBacklog(backlog);
    console.log(`Closed ${item.id} with ${short(commit)}.`);
  } else fail('pipeline followup takes add, list, plan or close.');
}

// Docs

export function cmdDocs(opts) {
  const ctx = runContext(opts);
  const { run, config, repo } = ctx;
  if (opts.due) {
    const runs = loadRuns().filter((entry) => entry.identity === run.identity);
    const lastPass = runs.filter((entry) => entry.kind === 'docs' && passed(entry, 'deploy')).map((entry) => entry.stages.deploy.at).sort().at(-1) ?? '';
    const due = runs.filter((entry) => entry.kind === 'feature' && passed(entry, 'deploy') && entry.stages.deploy.at > lastPass);
    console.log(due.length ? `A guide pass is due for ${plural(due.length, 'feature run')} deployed since the last one: ${due.map((entry) => entry.id).join(', ')}.` : 'No feature run has deployed since the last guide pass.');
    return;
  }
  requireStages(run, ['build'], 'The docs check');
  const tip = resolveTip(repo, opts.tip ?? run.tip);
  const commits = listCommits(repo, `${trunkRev(config)}..${tip}`);
  const gaps = docsRuleGaps(commits, config);
  if (run.kind === 'docs') {
    const touched = new Set(commits.flatMap(touchedPaths));
    if (config.docs.guide && !touched.has(config.docs.guide)) gaps.push(`A docs pass updates the guide (${config.docs.guide}).`);
    if (config.docs.screenshots.length && ![...touched].some((path) => matchesAny(path, config.docs.screenshots))) gaps.push(`A docs pass takes new screenshots (${config.docs.screenshots.join(', ')}).`);
    gaps.push(...missingSignoffs(run, 'docs', config).map((item) => `sign-off missing: ${item} (pipeline signoff --run ${run.id} --stage docs --item ${item})`));
  }
  const state = gaps.length ? 'failed' : 'passed';
  const updated = updateRun(run.id, (current) => setStage(current, 'docs', { state, tip, summary: gaps.length ? `${plural(gaps.length, 'gap')}` : run.kind === 'docs' ? 'guide pass with new screenshots' : 'docs updated with the behavior they describe' }) && current);
  report(ctx, updated, [`Docs for ${run.id} at ${short(tip)}: ${state}.`, ...gaps.map((gap) => `  - ${gap}`)], ['docs']);
  if (gaps.length) process.exitCode = 1;
}
