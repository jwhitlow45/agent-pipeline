// The stages before any code: intake, briefs, design (or a short spec), decisions and sign-offs.

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { repoContext, runContext } from './context.mjs';
import { appendDecision, decidedIdsInBrief, missingDecisions } from './decisions.mjs';
import { createRun, KINDS, loadRun, passed, requireStages, setStage, updateRun } from './ledger.mjs';
import { mirrorLines, mirrorRun } from './mirror.mjs';
import { findEntry } from './review.mjs';
import { fail, normalizeWords, now, plural, sha256, splitList } from './util.mjs';

const EM_DASH = '\u2014';

const readText = (file, what) => {
  const path = resolve(file ?? fail(`--file is required: the ${what}.`));
  if (!existsSync(path)) fail(`${path} does not exist.`);
  return { path, text: readFileSync(path, 'utf8') };
};

export function missingSignoffs(run, stage, config) {
  // A docs pass is a judgment of the user docs as a whole, so only a docs run needs its sign-off.
  if (stage === 'docs' && run.kind !== 'docs') return [];
  return (config.signoffs[stage] ?? []).filter((item) => !run.signoffs?.[stage]?.[item]);
}

export function report(ctx, run, lines, stages) {
  const mirrored = mirrorRun(ctx, run, { stages });
  console.log([...lines, ...mirrorLines(mirrored)].join('\n'));
  if (mirrored.some((result) => !result.ok)) process.exitCode = 1;
}

export function cmdIntake(opts) {
  const ctx = repoContext(opts.repo, { configPath: opts.config });
  const words = opts['words-file'] ? readText(opts['words-file'], 'user\'s words').text : opts.words;
  if (!words || words === true || !normalizeWords(words)) fail('Pass the user\'s words verbatim with --words "..." or --words-file F.');
  const kind = opts.kind ?? 'feature';
  if (!KINDS.includes(kind)) fail(`--kind must be one of ${KINDS.join(', ')}.`);
  const run = createRun({
    id: opts.run,
    kind,
    identity: ctx.identity,
    repo: ctx.main,
    github: ctx.slug,
    ui: Boolean(opts.ui),
    liveHole: Boolean(opts['live-hole']),
    from: opts.from ?? null,
    intake: { words, sha256: sha256(normalizeWords(words)), by: opts.by ?? null, at: now() },
    stages: {},
  });
  updateRun(run.id, (entry) => setStage(entry, 'intake', { state: 'passed', summary: `user's words recorded (${plural(normalizeWords(words).split(' ').length, 'word')})` }));
  const next = kind === 'feature' ? 'Write the design note, then run pipeline design.' : 'Write the short spec, then run pipeline spec.';
  console.log([`Run ${run.id} (${kind}) recorded the user's words. Every brief and review request quotes them.`, `  ${next}`].join('\n'));
}

// Checks a brief or a review request before it goes to an agent.
export function checkBrief(text, { run, kind, config, extraDecisions = [] }) {
  const problems = [];
  const warnings = [];
  if (config.intake.quoteIn.includes(kind) && !normalizeWords(text).includes(normalizeWords(run.intake.words))) {
    problems.push('It does not quote the user\'s words verbatim. Paste them exactly as pipeline intake recorded them (whitespace may differ).');
  }
  const preamble = config.brief.preamble;
  if (preamble && config.brief.requirePreambleIn.includes(kind) && !text.includes(basename(preamble))) {
    problems.push(`It does not point at the shared preamble (${basename(preamble)}).`);
  }
  const decisionIds = [...new Set([...decidedIdsInBrief(text, config), ...extraDecisions])];
  const missing = config.decisions.file ? missingDecisions(decisionIds, config) : decisionIds;
  if (missing.length) problems.push(`These decisions are named but not in the decision log${config.decisions.file ? '' : ' (decisions.file is not set)'}: ${missing.join(', ')}.`);
  if (text.includes(EM_DASH)) warnings.push('It has an em dash. Use a colon, a comma or a new sentence.');
  return { problems, warnings, decisionIds };
}

export function cmdBrief(opts) {
  const { path, text } = readText(opts.file, 'brief or review request');
  const ctx = runContext(opts);
  const kind = opts.kind ?? 'build';
  const result = checkBrief(text, { run: ctx.run, kind, config: ctx.config, extraDecisions: splitList(opts.decisions) });
  updateRun(ctx.run.id, (run) => {
    run.briefs = [...(run.briefs ?? []).filter((brief) => brief.file !== path), { file: path, sha256: sha256(text), kind, lane: opts.lane ?? null, decisionIds: result.decisionIds, ok: !result.problems.length, at: now() }];
  });
  const lines = [`Brief ${path} (${kind}): ${result.problems.length ? 'refused' : 'ok'}${result.decisionIds.length ? `, names ${plural(result.decisionIds.length, 'decision')}` : ''}.`,
    ...result.problems.map((problem) => `  - ${problem}`), ...result.warnings.map((warning) => `  warning: ${warning}`)];
  console.log(lines.join('\n'));
  if (result.problems.length) process.exitCode = 1;
  return result;
}

// Line count of the part reviewers read: everything before the first Appendix heading. Measured numbers
// and worked examples go in the appendix, which later rounds do not reread.
export function noteLines(text) {
  const lines = text.split('\n');
  const appendix = lines.findIndex((line) => /^#{1,3}\s+appendix\b/i.test(line));
  const body = appendix === -1 ? lines : lines.slice(0, appendix);
  while (body.length && !body.at(-1).trim()) body.pop();
  return body.length;
}

export function checkNote(text, { ui, config, allowLong }) {
  const problems = [];
  const warnings = [];
  const lines = noteLines(text);
  if (lines > config.design.maxLines && !allowLong) problems.push(`It has ${lines} lines before the appendix, over design.maxLines (${config.design.maxLines}). Move measurements and worked examples to an appendix, split the design, or pass --allow-long with the reason.`);
  else if (lines > config.design.targetLines) warnings.push(`It has ${lines} lines, over the ${config.design.targetLines}-line target.`);
  const headings = text.split('\n').filter((line) => /^#{1,4}\s/.test(line));
  if (ui && !headings.some((line) => new RegExp(config.design.uiHeading, 'i').test(line))) problems.push('The change has UI, but the note has no UI and UX section (a heading matching design.uiHeading).');
  for (const section of config.design.requiredSections) {
    if (!headings.some((line) => new RegExp(`\\b${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line))) problems.push(`It has no "${section}" section.`);
  }
  if (text.includes(EM_DASH)) problems.push('It has an em dash. Use a colon, a comma or a new sentence.');
  return { lines, problems, warnings };
}

export function cmdDesign(opts) {
  const ctx = runContext(opts);
  const { run, config } = ctx;
  requireStages(run, ['intake'], 'A design');
  if (run.kind !== 'feature') fail(`Run ${run.id} is a ${run.kind} run, which works from a short spec. Use pipeline spec.`);
  const { path, text } = readText(opts.note ?? fail('--note is required: the design note.'), 'design note');
  const ui = opts['no-ui'] ? false : opts.ui ? true : run.ui;
  const check = checkNote(text, { ui, config, allowLong: opts['allow-long'] });
  const topic = opts['review-topic'] ?? run.stages.design?.reviewTopic ?? null;
  const entry = topic ? findEntry(config, topic) : null;
  const skip = opts['review-skip'];
  let review = 'not started';
  if (skip) review = 'skipped';
  else if (entry?.status === 'consensus') review = `consensus after ${plural(entry.consensus.rounds, 'round')} (${entry.consensus.reviewers})`;
  else if (entry) review = `in review, round ${entry.rounds.length}`;
  // The note the reviewers agreed on is bound to the consensus that agreed on it, and the binding
  // survives a refused attempt. A changed note passes only with --re-review and a newer consensus.
  const consensus = skip ? { kind: 'skip', words: skip, at: new Date().toISOString() } : entry?.status === 'consensus' ? { kind: 'review', topic, rounds: entry.consensus?.rounds ?? entry.rounds.length, at: entry.consensus?.at ?? null } : null;
  const hash = sha256(text);
  const bound = run.stages.design?.reviewed ?? null;
  let reviewed = bound;
  const designTopic0 = run.stages.design?.reviewTopic ?? null;
  if (consensus && !bound) reviewed = { sha256: hash, ...consensus };
  else if (consensus?.kind === 'review' && bound.kind === 'skip' && bound.sha256 === hash && (!designTopic0 || consensus.topic === designTopic0)) {
    // A real review of the very note that was skipped binds it, so a later edit needs a newer
    // consensus than this one, or a fresh skip.
    reviewed = { sha256: hash, ...consensus };
  } else if (consensus && bound.sha256 !== hash) {
    // Only a later consensus of the same design review counts, or the user's skip. Another topic's
    // consensus says nothing about this note, however recent it is. A note bound to a skip has no
    // review to match, so a consensus of the run's own design review (the topic an accepted attempt
    // named for it) takes over from the skip.
    const sameReview = consensus.kind === 'review' && bound.kind !== 'skip' && consensus.topic === bound.topic;
    const fromSkip = bound.kind === 'skip' && consensus.kind === 'review' && Boolean(consensus.topic) && consensus.topic === designTopic0;
    // A move from a skip to a review needs a consensus recorded after the skip. One with no time is
    // unknown, so it does not count.
    const afterSkip = fromSkip && Boolean(consensus.at && bound.at && consensus.at > bound.at);
    const later = consensus.at && bound.at ? consensus.at > bound.at : consensus.rounds > (bound.rounds ?? 0);
    const newer = consensus.kind === 'skip' || afterSkip || (sameReview && later);
    if (!opts['re-review']) check.problems.push(`The note changed after its design review reached consensus${bound.rounds ? ` (round ${bound.rounds})` : ''}. Run another review round on the change, then rerun with --re-review.`);
    else if (consensus.kind === 'review' && !sameReview && !fromSkip) check.problems.push(`--re-review needs a newer consensus of this run's design review${bound.topic ? `, ${bound.topic}` : ''}, not of ${consensus.topic}.`);
    else if (fromSkip && !afterSkip) check.problems.push(`--re-review needs a consensus of ${consensus.topic} recorded after the skip, and this one ${consensus.at ? 'came before it' : 'has no time recorded'}. Record a new round's consensus first, or skip again.`);
    else if (!newer) check.problems.push(`--re-review needs a consensus newer than the one the note was bound to${bound.rounds ? ` (round ${bound.rounds} of ${bound.topic})` : ''}. Record the new round's consensus first.`);
    else reviewed = { sha256: hash, ...consensus };
  }
  const state = check.problems.length ? 'failed' : reviewed?.sha256 === hash ? 'passed' : 'noted';
  const summary = check.problems.length ? `design note refused: ${check.problems[0]}`.slice(0, 120) : `${basename(path)}, ${check.lines} lines, ${ui ? 'with' : 'no'} UI, review ${review}`;
  const updated = updateRun(run.id, (current) => {
    // A refused attempt with another topic leaves the design review the note is bound to in place:
    // a note bound to a skip takes only the review an accepted attempt named. Its topic is still
    // registered, so the gate holds that review until the note passes.
    const designTopic = reviewed?.kind === 'review' ? reviewed.topic : check.problems.length ? current.stages.design?.reviewTopic ?? null : topic;
    setStage(current, 'design', { state, mode: 'note', note: path, sha256: reviewed?.sha256 ?? hash, reviewed, lines: check.lines, ui, reviewTopic: designTopic, review, skipWords: skip ?? null, allowLong: opts['allow-long'] ?? null, summary });
    current.ui = ui;
    for (const name of new Set([designTopic, topic].filter(Boolean))) current.reviewTopics = { ...(current.reviewTopics ?? {}), [name]: 'design' };
    return current;
  });
  const lines = [`Design for ${run.id}: ${state}. ${summary}.`, ...check.problems.map((problem) => `  - ${problem}`), ...check.warnings.map((warning) => `  warning: ${warning}`)];
  if (state === 'noted') lines.push(`  Next: a design review with no commits (agent-review start --topic ${topic ?? '<topic>'} --no-commits --dir <folder>), then rerun with --review-topic ${topic ?? '<topic>'}.`);
  report(ctx, updated, lines, ['design']);
  if (state === 'failed') process.exitCode = 1;
}

export function cmdSpec(opts) {
  const ctx = runContext(opts);
  const { run, config } = ctx;
  requireStages(run, ['intake'], 'A spec');
  if (run.kind === 'feature') fail(`Run ${run.id} is a feature run, which needs a reviewed design note. Use pipeline design, or start a fast run for a small change.`);
  const { path, text } = readText(opts.file, 'short written spec');
  const lines = text.split('\n').length;
  const problems = [];
  if (!text.trim()) problems.push('The spec is empty.');
  if (lines > config.fastLane.specMaxLines) problems.push(`The spec has ${lines} lines, over fastLane.specMaxLines (${config.fastLane.specMaxLines}). A change that needs that much is a feature run with a design note.`);
  const brief = checkBrief(text, { run, kind: run.kind === 'followups' ? 'followups' : 'build', config: { ...config, brief: { ...config.brief, requirePreambleIn: [] } } });
  problems.push(...brief.problems);
  const state = problems.length ? 'failed' : 'passed';
  const updated = updateRun(run.id, (current) => {
    setStage(current, 'design', { state, mode: 'spec', note: path, sha256: sha256(text), lines, summary: `${run.kind} spec ${basename(path)}, ${lines} lines` });
    current.briefs = [...(current.briefs ?? []).filter((entry) => entry.file !== path), { file: path, sha256: sha256(text), kind: 'spec', decisionIds: brief.decisionIds, ok: !problems.length, at: now() }];
    return current;
  });
  report(ctx, updated, [`Spec for ${run.id}: ${state}.`, ...problems.map((problem) => `  - ${problem}`)], ['design']);
  if (problems.length) process.exitCode = 1;
}

export function cmdDecide(opts) {
  const ctx = opts.run ? runContext(opts) : repoContext(opts.repo, { configPath: opts.config });
  const heading = appendDecision({ id: opts.id, title: opts.title, chose: opts.chose, why: opts.why, rejected: opts.rejected, run: opts.run, by: opts.by }, ctx.config);
  if (opts.run) updateRun(opts.run, (run) => { run.decisionIds = [...new Set([...(run.decisionIds ?? []), opts.id])]; });
  console.log(`Logged ${heading.replace(/^## /, '')} in ${ctx.config.decisions.file}.`);
}

export function cmdDecisions(opts) {
  const ctx = runContext(opts);
  const { run, config } = ctx;
  const ids = [...new Set([...(run.decisionIds ?? []), ...(run.briefs ?? []).flatMap((brief) => brief.decisionIds ?? [])])];
  const missing = config.decisions.file ? missingDecisions(ids, config) : ids;
  const signoffs = config.decisions.guessMode ? missingSignoffs(run, 'decisions', config) : [];
  const state = missing.length ? 'failed' : signoffs.length ? 'pending' : 'passed';
  const summary = missing.length ? `${plural(missing.length, 'decision')} not logged: ${missing.join(', ')}` : `${plural(ids.length, 'decision')} named, all logged${signoffs.length ? `, sign-off ${signoffs.join(', ')} missing` : ''}`;
  const updated = updateRun(run.id, (current) => setStage(current, 'decisions', { state, ids, missing, summary }) && current);
  const lines = [`Decisions for ${run.id}: ${state}. ${summary}.`];
  if (signoffs.length) lines.push(`  Guess mode is on: once every product choice the user did not settle is logged, run pipeline signoff --run ${run.id} --stage decisions --item complete --by <you> --note "<what you checked>".`);
  report(ctx, updated, lines, ['decisions']);
  if (state === 'failed') process.exitCode = 1;
}

export function cmdSignoff(opts) {
  const ctx = runContext(opts);
  const { run, config } = ctx;
  const stage = opts.stage ?? fail('--stage is required.');
  const item = opts.item ?? fail('--item is required.');
  if (!(config.signoffs[stage] ?? []).includes(item) && !opts.extra) fail(`${stage} has no sign-off named ${item}. Configured: ${(config.signoffs[stage] ?? []).join(', ') || 'none'}. Pass --extra to record it anyway.`);
  if (!opts.by || opts.by === true) fail('--by is required: who signs off.');
  if (!opts.note || opts.note === true) fail('--note is required: what was checked, in a sentence.');
  updateRun(run.id, (current) => {
    current.signoffs = { ...(current.signoffs ?? {}), [stage]: { ...(current.signoffs?.[stage] ?? {}), [item]: { by: opts.by, note: opts.note, at: now() } } };
    current.events.push({ at: now(), stage, action: 'signoff', detail: `${item} by ${opts.by}` });
  });
  console.log(`Signed off ${stage} ${item} for ${run.id} (${opts.by}). Rerun the stage's command to pass it.`);
}

export const isDesigned = (run) => passed(run, 'design');
export { loadRun };
