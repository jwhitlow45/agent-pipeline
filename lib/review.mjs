// The code review stage. Where agent-review is installed, the pipeline reads its ledger and never
// writes it. Where it is not, the pipeline keeps a small review ledger of its own in the same format,
// so one coverage rule reads both: a commit passes review when a review reached consensus on its
// patch-id, or the user skipped review for it.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitStatusList } from './github.mjs';
import { commitIds, listCommits, repoIdentity, resolveTip, githubRepo, trunkRev } from './vcs.mjs';
import { fail, now, run, stateDir } from './util.mjs';

export const TOPIC = /^[a-z][a-z0-9-]{0,39}$/;

const builtinDir = () => join(stateDir(), 'reviews');

function readEntries(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => {
    try {
      return { ...JSON.parse(readFileSync(join(dir, file), 'utf8')), source: dir === builtinDir() ? 'builtin' : 'agent-review' };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export const agentReviewEntries = (config) => readEntries(config.review.agentReviewLedger);
export const builtinEntries = () => readEntries(builtinDir());

export function agentReviewInstalled(config) {
  if (existsSync(config.review.agentReviewLedger)) return true;
  return run('sh', ['-c', 'command -v agent-review'], { allowFail: true }).status === 0;
}

// Which review ledger a new review goes to. Reads always use both.
export function provider(config) {
  if (config.review.provider !== 'auto') return config.review.provider;
  return agentReviewInstalled(config) ? 'agent-review' : 'builtin';
}

export const findEntry = (config, topic) => [...agentReviewEntries(config), ...builtinEntries()].find((entry) => entry.topic === topic) ?? null;

const patchIdsOf = (commits) => (commits ?? []).map((commit) => commit.patchId).filter(Boolean);

// Each commit's best coverage, as agent-review computes it: consensus or skipped, else started, else none.
export function coverage(commits, entries) {
  return commits.map((commit) => {
    if (!commit.patchId) return { ...commit, review: 'empty' };
    const agreed = entries.find((entry) => patchIdsOf(entry.consensus?.commits).includes(commit.patchId));
    if (agreed) return { ...commit, review: agreed.status === 'skipped' ? 'skipped' : 'consensus', topic: agreed.topic, source: agreed.source };
    const started = entries.find((entry) => (entry.rounds ?? []).some((round) => patchIdsOf(round.commits).includes(commit.patchId)));
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
  const identity = repoIdentity(repo);
  const entries = [...agentReviewEntries(config), ...builtinEntries()].filter((entry) => entry.identity === identity || !entry.repo);
  const covered = coverage(listCommits(repo, `${trunkRev(config)}..${tip}`), entries);
  if (covered.every(reviewPassed) || !config.review.trustGithubStatus) return covered;
  const slug = githubRepo(repo, config.remote);
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
  mkdirSync(builtinDir(), { recursive: true });
  entry.updatedAt = now();
  const temp = `${entryPath(entry.topic)}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(temp, entryPath(entry.topic));
}

function loadBuiltin(topic) {
  if (!TOPIC.test(topic ?? '')) fail('--topic must be 1-40 lowercase letters, digits, or hyphens, starting with a letter.');
  if (!existsSync(entryPath(topic))) fail(`No builtin review named ${topic}. Start it with pipeline review start.`);
  return JSON.parse(readFileSync(entryPath(topic), 'utf8'));
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
    round.tip = resolveTip(entry.repo, tipRev);
    round.base = commitIds(entry.repo, `fork_point(${round.tip} | ${trunkRev(config)})`)[0];
    round.commits = listCommits(entry.repo, `${trunkRev(config)}..${round.tip}`).map(({ id, changeId, patchId, description }) => ({ id, changeId, patchId, description }));
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
  if (!TOPIC.test(topic ?? '')) fail('--topic must be 1-40 lowercase letters, digits, or hyphens, starting with a letter.');
  if (existsSync(entryPath(topic)) || findEntry(config, topic)) fail(`A review named ${topic} already exists. Use pipeline review round, or a new topic.`);
  const entry = { topic, repo: repo ?? null, identity: repo ? repoIdentity(repo) : null, folder, status: 'pending', startedAt: now(), rounds: [], consensus: null };
  const result = addRound(entry, tip, words, config);
  saveEntry(entry);
  return { entry, ...result };
}

export function builtinRound({ topic, tip, config }) {
  const entry = loadBuiltin(topic);
  if (entry.status === 'skipped') fail(`${topic} records a skip, not a review.`);
  // A change after consensus reopens the review. Its consensus still covers the commits it agreed on until done runs again.
  entry.status = 'pending';
  const result = addRound(entry, tip, null, config);
  saveEntry(entry);
  return { entry, ...result };
}

export function builtinDone({ topic, reviewers, config }) {
  const entry = loadBuiltin(topic);
  if (!reviewers) fail('--reviewers is required, for example "model-a high, model-b high".');
  if (entry.status !== 'pending') fail(`Review ${topic} is already ${entry.status}.`);
  const round = entry.rounds.at(-1);
  const repliesDir = join(entry.folder, `round-${round.n}`, 'replies');
  const replies = existsSync(repliesDir) ? readdirSync(repliesDir).filter((file) => file.endsWith('.md')) : [];
  if (replies.length < config.review.minReviewers) fail(`Round ${round.n} has ${replies.length} saved repl${replies.length === 1 ? 'y' : 'ies'} in ${repliesDir}. Consensus needs every reviewer's reply there, at least ${config.review.minReviewers}.`);
  // Whether each reply agrees is the owner's call, as in agent-review: a reply that says "not
  // consensus" contains the word too, so the text is not parsed.
  if (entry.repo && round.tip && commitIds(entry.repo, `${round.tip} & ::visible_heads()`).length !== 1) fail(`Tip ${round.tip.slice(0, 12)} was rewritten after round ${round.n} started. Run pipeline review round first.`);
  entry.status = 'consensus';
  entry.consensus = { tip: round.tip ?? null, commits: round.commits ?? [], reviewers, rounds: entry.rounds.length, at: now() };
  saveEntry(entry);
  return entry;
}

export function builtinSkip({ repo, tip, reason, config }) {
  if (!reason) fail('--reason is required: the user\'s words for skipping review.');
  const commits = listCommits(repo, `${trunkRev(config)}..${tip}`).map(({ id, changeId, patchId, description }) => ({ id, changeId, patchId, description }));
  const at = now();
  const topic = `skip-${at.slice(0, 19).replace(/[^0-9]/g, '')}-${tip.slice(0, 8)}`;
  const entry = { topic, repo, identity: repoIdentity(repo), folder: null, status: 'skipped', reason, startedAt: at, rounds: [], consensus: { tip, commits, reviewers: null, rounds: 0, at } };
  saveEntry(entry);
  return entry;
}
