// GitHub reads and writes, all through the gh CLI. Each stage is mirrored as a commit status with its
// own context (pipeline/build, pipeline/ci and so on), so branch protection and pull requests can see
// exactly which stages a commit passed.

import { ghCommand, run, short } from './util.mjs';

export const CONTEXT_PREFIX = 'pipeline/';

const gh = (args, options = {}) => run(ghCommand(), args, { allowFail: true, timeout: 30_000, ...options });
const firstErrorLine = (result) => (result.stderr || result.error?.message || '').trim().split('\n')[0];

// A ledger state to a GitHub status state. A stage with nothing recorded gets no status.
export function githubState(state) {
  if (['passed', 'skipped'].includes(state)) return 'success';
  if (state === 'failed') return 'failure';
  if (['none', undefined, null].includes(state)) return null;
  return 'pending';
}

export function setStatus(slug, sha, { context, state, description, targetUrl }) {
  const args = ['api', '-X', 'POST', `repos/${slug}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description.slice(0, 140)}`];
  if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
  const result = gh(args);
  return result.status === 0
    ? { ok: true, line: `GitHub ${context} on ${short(sha)}: ${state}, ${description.slice(0, 140)}` }
    : { ok: false, line: `GitHub ${context} on ${short(sha)} not set: ${firstErrorLine(result)}` };
}

// The statuses GitHub holds for a commit, latest first per context.
export function commitStatuses(slug, sha) {
  const result = gh(['api', `repos/${slug}/commits/${sha}/status`]);
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout).statuses ?? [];
}

// The newest run of the workflow for a commit, or null when none has started.
export function latestRun(slug, sha, workflow) {
  const result = gh(['run', 'list', '-R', slug, '--commit', sha, '--json', 'databaseId,status,conclusion,workflowName,headSha,url,createdAt,event', '-L', '50']);
  if (result.status !== 0) throw new Error(`gh run list failed: ${firstErrorLine(result)}`);
  const runs = JSON.parse(result.stdout || '[]').filter((entry) => entry.headSha === sha && (!workflow || entry.workflowName === workflow || String(entry.workflowName).toLowerCase() === workflow.replace(/\.ya?ml$/, '').toLowerCase()));
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function viewRun(slug, id) {
  const result = gh(['run', 'view', String(id), '-R', slug, '--json', 'databaseId,status,conclusion,jobs,url,headSha,workflowName']);
  if (result.status !== 0) throw new Error(`gh run view ${id} failed: ${firstErrorLine(result)}`);
  return JSON.parse(result.stdout);
}

// GitHub can call a run completed while a job still runs (a rerun job, or a job queued behind a
// matrix), so a run is settled only when the run and every job say completed.
export function settle(view, okConclusions) {
  const jobs = (view.jobs ?? []).map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion || null }));
  const settled = view.status === 'completed' && jobs.every((job) => job.status === 'completed');
  const failedJobs = jobs.filter((job) => job.status === 'completed' && !okConclusions.includes(job.conclusion));
  const ok = settled && okConclusions.includes(view.conclusion) && !failedJobs.length;
  return { settled, ok, jobs, failedJobs: failedJobs.map((job) => job.name), conclusion: view.conclusion || null };
}

export function workflowName(slug, runId) {
  const result = gh(['run', 'view', String(runId), '-R', slug, '--json', 'workflowName']);
  return result.status === 0 ? JSON.parse(result.stdout).workflowName : null;
}

export function pullRequestHead(slug, pr, cwd) {
  const result = gh(['pr', 'view', String(pr), ...(slug ? ['-R', slug] : []), '--json', 'headRefOid', '-q', '.headRefOid'], { cwd });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
