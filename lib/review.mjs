// The code review stage. Where agent-review is installed, the pipeline reads its ledger and never
// writes it. Where it is not, the pipeline keeps a small review ledger of its own in the same format,
// so one coverage rule reads both: a commit passes review when a review reached consensus on its
// change (the same commit id or patch id, lib/change.mjs), or the user skipped review for it.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changeRecord, hasContent, sameChange } from './change.mjs';
import { commitStatusList } from './github.mjs';
import { withLock, writeJson } from './lock.mjs';
import { resolveTip, trunkId, trunkRange, vcsAt } from './vcs.mjs';
import { fail, now, run, stateDir } from './util.mjs';

export const TOPIC = /^[a-z][a-z0-9-]{0,39}$/;

const builtinDir = () => join(stateDir(), 'reviews');

// An entry that cannot be read covers nothing. A strict read throws on it instead, for the gate's
// checks, which must not take a missing entry for a review that never started.
function readEntries(dir, { strict = false } = {}) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => {
    try {
      return { ...JSON.parse(readFileSync(join(dir, file), 'utf8')), source: dir === builtinDir() ? 'builtin' : 'agent-review' };
    } catch (error) {
      if (strict) throw new Error(`the review ledger entry ${join(dir, file)} cannot be read (${error.message})`);
      return null;
    }
  }).filter(Boolean);
}

export const agentReviewEntries = (config, options) => readEntries(config.review.agentReviewLedger, options);
export const builtinEntries = (options) => readEntries(builtinDir(), options);

export function agentReviewInstalled(config) {
  if (existsSync(config.review.agentReviewLedger)) return true;
  return run('sh', ['-c', 'command -v agent-review'], { allowFail: true }).status === 0;
}

// The review provider is the wrong one for this repository: agent-review reads only jj repositories.
export class ProviderError extends Error {}

// Which review ledger a new review goes to, the one rule every caller uses. Reads always use both.
// In a plain git repository auto means builtin, and naming agent-review is refused, since it reads
// jj only: the gate would otherwise skip the builtin pull request checks.
export function provider(config, backend = 'jj') {
  if (backend === 'git') {
    if (config.review.provider === 'agent-review') throw new ProviderError('review.provider is "agent-review", which reads jj repositories only, and this is a plain git repository. Set review.provider to "builtin" or "auto" in pipeline.config.json.');
    return 'builtin';
  }
  if (config.review.provider !== 'auto') return config.review.provider;
  return agentReviewInstalled(config) ? 'agent-review' : 'builtin';
}

export const findEntry = (config, topic, options) => [...agentReviewEntries(config, options), ...builtinEntries(options)].find((entry) => entry.topic === topic) ?? null;

const covers = (commits, commit) => (commits ?? []).some((recorded) => hasContent(recorded) && sameChange(recorded, commit));

// Each commit's best coverage, as agent-review computes it: consensus or skipped, else started, else
// none. A recorded commit covers a commit only when they are the same change.
export function coverage(commits, entries) {
  return commits.map((commit) => {
    if (!hasContent(commit)) return { ...commit, review: 'empty' };
    const agreed = entries.find((entry) => covers(entry.consensus?.commits, commit));
    if (agreed) return { ...commit, review: agreed.status === 'skipped' ? 'skipped' : 'consensus', topic: agreed.topic, source: agreed.source };
    const started = entries.find((entry) => (entry.rounds ?? []).some((round) => covers(round.commits, commit)));
    return started ? { ...commit, review: 'started', topic: started.topic, source: started.source } : { ...commit, review: 'none' };
  });
}

export const reviewPassed = (commit) => ['consensus', 'skipped', 'empty'].includes(commit.review);

// The status a writer we trust set last for a review context on the tip, if it is a success. Both
// tools set success only when every commit from trunk to that commit passed review, so it attests
// the whole range. Only its writer can be trusted, so a status set by anyone else never counts.
function trustedReviewStatus(slug, tip, config) {
  const writers = (config.review.trustedStatusWriters.length ? config.review.trustedStatusWriters : [slug.split('/')[0]]).map((login) => login.toLowerCase());
  const newest = new Map();
  for (const status of commitStatusList(slug, tip)) if (!newest.has(status.context)) newest.set(status.context, status);
  return ['agent-review', 'pipeline/review'].map((context) => newest.get(context)).find((status) => status?.state === 'success' && writers.includes(String(status.creator?.login ?? '').toLowerCase())) ?? null;
}

// Coverage of trunk..tip from every ledger on this machine. When review.trustGithubStatus is on, a
// success status from agent-review or pipeline/review on the tip, set by a trusted writer, also
// counts, which covers a review recorded on another machine.
export function reviewCoverage(repo, tip, config) {
  const vcs = vcsAt(repo);
  const identity = vcs.identity();
  const entries = [...agentReviewEntries(config), ...builtinEntries()].filter((entry) => entry.identity === identity || !entry.repo);
  const covered = coverage(vcs.listCommits(trunkRange(vcs, config, tip)), entries);
  if (covered.every(reviewPassed) || !config.review.trustGithubStatus) return covered;
  const slug = vcs.slug(config.remote);
  const success = slug ? trustedReviewStatus(slug, tip, config) : null;
  return success ? covered.map((commit) => (reviewPassed(commit) ? commit : { ...commit, review: 'consensus', topic: `github ${success.context} by ${success.creator.login}`, source: 'github' })) : covered;
}

// The review stage for a tip: passed when every commit in the range has consensus or a skip.
export function reviewState(repo, tip, config) {
  const covered = reviewCoverage(repo, tip, config);
  const ok = covered.every(reviewPassed);
  const started = covered.some((commit) => ['started', 'consensus', 'skipped'].includes(commit.review));
  const counts = ['consensus', 'skipped', 'started', 'none'].map((state) => [state, covered.filter((commit) => commit.review === state).length]).filter(([, count]) => count);
  return { covered, ok, state: ok ? 'passed' : started ? 'in-review' : 'none', summary: `${counts.map(([state, count]) => `${count} ${state}`).join(', ') || 'no commits'} (${[...new Set(covered.map((commit) => commit.topic).filter(Boolean))].join(', ') || 'no review'})` };
}

// The builtin ledger, for machines without agent-review.

const entryPath = (topic) => join(builtinDir(), `${topic}.json`);

function saveEntry(entry) {
  entry.updatedAt = now();
  writeJson(entryPath(entry.topic), entry);
}

const checkTopic = (topic) => TOPIC.test(topic ?? '') || fail('--topic must be 1-40 lowercase letters, digits, or hyphens, starting with a letter.');

// Rereads a builtin review under its lock, applies the change, and saves it, so two rounds or a round and a done never overwrite each other.
function updateBuiltin(topic, change) {
  checkTopic(topic);
  return withLock(entryPath(topic), () => {
    if (!existsSync(entryPath(topic))) fail(`No builtin review named ${topic}. Start it with pipeline review start.`);
    const entry = JSON.parse(readFileSync(entryPath(topic), 'utf8'));
    const result = change(entry);
    saveEntry(entry);
    return result;
  });
}

function requestSkeleton(entry, round, words) {
  const header = `kind: review_request\ntopic: ${entry.topic}\nround: ${round.n}\ndate: ${round.at.slice(0, 10)}`;
  const rules = '## Rules\n- Read-only: do not edit files, commit, push, or send notifications. Report back only.\n- Other reviewers review this same request independently. After each round you read their replies and confer with them.';
  const where = round.tip
    ? `## Where things are\n- Workspace: \`${entry.repo}\`\n- Base: \`${round.base}\`\n- Tip: \`${round.tip}\`\n\n${round.commits.map((commit, i) => `${i + 1}. \`${commit.id.slice(0, 12)}\` ${commit.description.split('\n')[0]}`).join('\n')}`
    : '## Where things are\nTODO(owner): the documents under review, with full paths.';
  if (round.n > 1) {
    return [header, rules, where,
      `## Dispositions\nTODO(owner): each finding from round ${round.n - 1}: adopted (with the fix and its commit), declined (with the reason), or a question for the user.`,
      '## Verification\nTODO(owner): the checks rerun on the new tip and their exact results.',
      '## What to do\nAgree or disagree with each disposition in one line. Report new findings in the changes since the last round, each with a stable ID, severity (P0 to P3), file:line and a fix. Say `consensus` if nothing should block.'].join('\n\n') + '\n';
  }
  return [header, rules, where,
    `## The user's words\n${words ? words : 'TODO(owner): quote the request behind this change, verbatim.'}`,
    '## Choices the user did not spell out\nTODO(owner): number each choice the user\'s words do not settle. Write "None." if there are none.',
    '## Verification\nTODO(owner): the checks you ran and their exact results. Reviewers do not rerun them.',
    '## What to check\n- Correctness across every branch, input and edge case.\n- Simplicity and minimality.\n- The repository\'s conventions.\n- Stale comments and docs.\n- Test coverage.',
    '## Output\nFindings, each with a stable ID, severity (P0 to P3), file:line, and a fix. Then questions for the user. Say `consensus` explicitly if nothing should block.'].join('\n\n') + '\n';
}

function addRound(entry, tipRev, words, config) {
  const previous = entry.rounds.at(-1);
  const round = { n: (previous?.n ?? 0) + 1, at: now() };
  if (entry.repo) {
    const vcs = vcsAt(entry.repo);
    round.tip = resolveTip(vcs, tipRev);
    // Criss-cross history forks at more than one commit, and the range leaves out every one.
    round.bases = vcs.forkPoint(round.tip, trunkId(vcs, config));
    round.base = round.bases[0];
    round.commits = vcs.listCommits(trunkRange(vcs, config, round.tip)).map((commit) => changeRecord(commit, { description: commit.description }));
    if (!round.commits.length) fail(`No commits between ${config.trunk} and ${round.tip.slice(0, 12)}. Commit the work first.`);
  }
  const dir = join(entry.folder, `round-${round.n}`);
  mkdirSync(join(dir, 'replies'), { recursive: true });
  mkdirSync(join(dir, 'confer'), { recursive: true });
  if (entry.repo) writeFileSync(join(entry.folder, '.gitignore'), '*\n');
  const request = join(dir, 'request.md');
  if (!existsSync(request)) writeFileSync(request, requestSkeleton(entry, round, words));
  entry.rounds.push(round);
  return { round, dir };
}

export function builtinStart({ topic, repo, folder, tip, words, config }) {
  checkTopic(topic);
  return withLock(entryPath(topic), () => {
    if (existsSync(entryPath(topic)) || findEntry(config, topic)) fail(`A review named ${topic} already exists. Use pipeline review round, or a new topic.`);
    const entry = { topic, repo: repo ?? null, identity: repo ? vcsAt(repo).identity() : null, folder, status: 'pending', startedAt: now(), rounds: [], consensus: null };
    const result = addRound(entry, tip, words, config);
    saveEntry(entry);
    return { entry, ...result };
  });
}

export function builtinRound({ topic, tip, config }) {
  return updateBuiltin(topic, (entry) => {
    if (entry.status === 'skipped') fail(`${topic} records a skip, not a review.`);
    // A change after consensus reopens the review. Its consensus still covers the commits it agreed on until done runs again.
    entry.status = 'pending';
    return { entry, ...addRound(entry, tip, null, config) };
  });
}

export function builtinDone({ topic, reviewers, config }) {
  return updateBuiltin(topic, (entry) => doneEntry(entry, { topic, reviewers, config }));
}

function doneEntry(entry, { topic, reviewers, config }) {
  if (!reviewers) fail('--reviewers is required, for example "model-a high, model-b high".');
  if (entry.status !== 'pending') fail(`Review ${topic} is already ${entry.status}.`);
  const round = entry.rounds.at(-1);
  const repliesDir = join(entry.folder, `round-${round.n}`, 'replies');
  const replies = existsSync(repliesDir) ? readdirSync(repliesDir).filter((file) => file.endsWith('.md')) : [];
  if (replies.length < config.review.minReviewers) fail(`Round ${round.n} has ${replies.length} saved repl${replies.length === 1 ? 'y' : 'ies'} in ${repliesDir}. Consensus needs every reviewer's reply there, at least ${config.review.minReviewers}.`);
  // Whether each reply agrees is the owner's call, as in agent-review: a reply that says "not
  // consensus" contains the word too, so the text is not parsed.
  if (entry.repo && round.tip && !vcsAt(entry.repo).isVisible(round.tip)) fail(`Tip ${round.tip.slice(0, 12)} was rewritten after round ${round.n} started. Run pipeline review round first.`);
  entry.status = 'consensus';
  entry.consensus = { tip: round.tip ?? null, commits: round.commits ?? [], reviewers, rounds: entry.rounds.length, at: now() };
  return entry;
}

export function builtinSkip({ repo, tip, reason, config }) {
  if (!reason) fail('--reason is required: the user\'s words for skipping review.');
  const vcs = vcsAt(repo);
  const commits = vcs.listCommits(trunkRange(vcs, config, tip)).map((commit) => changeRecord(commit, { description: commit.description }));
  const at = now();
  const stem = `skip-${at.slice(0, 19).replace(/[^0-9]/g, '')}-${tip.slice(0, 8)}`;
  // Two skips of one tip in the same second each keep their own entry and reason.
  for (let n = 1; ; n += 1) {
    const topic = n === 1 ? stem : `${stem}-${n}`;
    const entry = withLock(entryPath(topic), () => {
      if (existsSync(entryPath(topic))) return null;
      const made = { topic, repo, identity: vcs.identity(), folder: null, status: 'skipped', reason, startedAt: at, rounds: [], consensus: { tip, commits, reviewers: null, rounds: 0, at } };
      saveEntry(made);
      return made;
    });
    if (entry) return entry;
  }
}
