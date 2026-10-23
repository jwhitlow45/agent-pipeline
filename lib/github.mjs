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

// Every status GitHub holds for a commit, newest first, each with the login that set it.
export function commitStatusList(slug, sha) {
  const result = gh(['api', `repos/${slug}/commits/${sha}/statuses?per_page=100`]);
  if (result.status !== 0) throw new Error(`gh could not read the statuses of ${short(sha)} in ${slug}: ${firstErrorLine(result)}`);
  return JSON.parse(result.stdout);
}

// The workflows GitHub knows for the repository, each with its id, display name and file path.
export function workflowList(slug) {
  const result = gh(['api', `repos/${slug}/actions/workflows?per_page=100`]);
  if (result.status !== 0) throw new Error(`gh could not list the workflows of ${slug}: ${firstErrorLine(result)}`);
  return JSON.parse(result.stdout).workflows ?? [];
}

// The one workflow a selector names, the way gh reads one: a number is an id, a .yml or .yaml name
// is a file, anything else a display name. A display name two workflows share, or none has, throws,
// so a workflow added under a familiar name never stands in for the real one.
export function resolveWorkflow(slug, selector) {
  const text = String(selector);
  const list = workflowList(slug);
  const found = /^\d+$/.test(text) ? list.filter((entry) => String(entry.id) === text)
    : /\.ya?ml$/i.test(text) ? list.filter((entry) => entry.path === text || entry.path.split('/').pop() === text.split('/').pop())
      : list.filter((entry) => String(entry.name).toLowerCase() === text.toLowerCase());
  if (found.length !== 1) throw new WorkflowError(found.length ? `${text} names ${found.length} workflows in ${slug} (${found.map((entry) => entry.path).join(', ')}). Name it by its file.` : `No workflow in ${slug} is named ${text}.`);
  const [entry] = found;
  return { id: entry.id, name: entry.name, path: entry.path };
}

export class WorkflowError extends Error {}

// The newest run of the workflow for a commit, or null when none has started. Runs are matched by
// the workflow's id, never by its display name.
export function latestRun(slug, sha, workflow) {
  const result = gh(['run', 'list', '-R', slug, '--commit', sha, '--workflow', String(workflow.id), '--json', 'databaseId,status,conclusion,workflowName,workflowDatabaseId,headSha,url,createdAt,event', '-L', '50']);
  if (result.status !== 0) throw new Error(`gh run list failed: ${firstErrorLine(result)}`);
  const runs = JSON.parse(result.stdout || '[]').filter((entry) => entry.headSha === sha && entry.workflowDatabaseId === workflow.id);
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function viewRun(slug, id) {
  const result = gh(['run', 'view', String(id), '-R', slug, '--json', 'databaseId,status,conclusion,jobs,url,headSha,workflowName,workflowDatabaseId']);
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

// Reads for the gate. Each throws when gh fails, so the gate blocks rather than guessing.

// The workflow a run belongs to, by id and file, from GitHub's record of the run.
export function runWorkflow(slug, runId) {
  const result = gh(['api', `repos/${slug}/actions/runs/${runId}`]);
  if (result.status !== 0) throw new Error(`gh could not read run ${runId} in ${slug}: ${firstErrorLine(result)}`);
  const view = JSON.parse(result.stdout);
  return { id: view.workflow_id, name: view.name, path: view.path?.replace(/@.*$/, '') ?? '' };
}

export function pullRequest(slug, pr) {
  const result = gh(['pr', 'view', String(pr), '-R', slug, '--json', 'baseRefName,headRefName,headRefOid,isDraft']);
  if (result.status !== 0) throw new Error(`gh could not read pull request ${pr} in ${slug}: ${firstErrorLine(result)}`);
  const view = JSON.parse(result.stdout);
  return { base: view.baseRefName, headRef: view.headRefName, head: view.headRefOid, draft: Boolean(view.isDraft) };
}
