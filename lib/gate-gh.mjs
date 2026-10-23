// The gate's reading of gh, curl and wget. gh is read the way gh reads itself: the persistent
// --repo option may come before the command, booleans take pflag values (--draft=false is false),
// and only built-in commands run, never an alias or an extension. Each command is a read, a write
// the gate lets through (comments, labels, drafts), a checked action (merges, ready pull requests,
// dispatches, reruns, API writes), or refused.

import { parseOptions } from './argv.mjs';
import { NEVER_PROD, refuse, resolveRevset, userRuns } from './gate-common.mjs';
import { pullRequest, resolveWorkflow, runWorkflow, WorkflowError } from './github.mjs';
import { registeredRepos } from './registry.mjs';
import { provider, reviewCoverage, reviewPassed } from './review.mjs';
import { deployProblems, holeProblems, runForCommit } from './ship.mjs';
import { run, short } from './util.mjs';
import { gitDir } from './vcs.mjs';

const asWords = (list) => list.map((word) => ({ text: word.value, dynamic: !word.literal }));

const READS = new Set(['pr view', 'pr list', 'pr status', 'pr checks', 'pr diff', 'issue view', 'issue list', 'issue status', 'run view', 'run list', 'run watch', 'workflow list', 'workflow view', 'repo view', 'repo list', 'release list', 'release view', 'search', 'status', 'auth status', 'help', 'version', 'label list', 'cache list', 'gist view', 'gist list', 'org list', 'ruleset list', 'ruleset view', 'ruleset check', 'secret list', 'variable list', 'variable get', 'project list', 'project view', 'codespace list', 'attestation verify', 'completion', 'ssh-key list', 'gpg-key list', 'config get', 'config list', 'alias list', 'extension list', 'browse']);
// Writes the gate lets through: they change discussion and drafts, never code, branches or deploys.
const WRITES = new Set(['pr edit', 'pr comment', 'pr close', 'pr reopen', 'pr checkout', 'issue create', 'issue edit', 'issue comment', 'issue close', 'issue reopen', 'run cancel', 'run download', 'release download', 'repo clone']);
const CHECKED = new Set(['pr create', 'pr ready', 'pr merge', 'workflow run', 'run rerun', 'api']);
const GROUPS = new Set(['pr', 'issue', 'run', 'workflow', 'repo', 'release', 'auth', 'label', 'cache', 'gist', 'org', 'ruleset', 'secret', 'variable', 'project', 'codespace', 'attestation', 'ssh-key', 'gpg-key', 'config', 'alias', 'extension']);

const SPECS = {
  'workflow run': { long: { ref: 'value', 'raw-field': 'value', field: 'value', json: 'flag', repo: 'value', help: 'flag' }, short: { r: 'ref', f: 'raw-field', F: 'field', R: 'repo', h: 'help' } },
  'run rerun': { long: { failed: 'flag', job: 'value', debug: 'flag', repo: 'value', help: 'flag' }, short: { j: 'job', d: 'debug', R: 'repo', h: 'help' } },
  api: { long: { method: 'value', field: 'value', 'raw-field': 'value', header: 'value', input: 'value', hostname: 'value', paginate: 'flag', slurp: 'flag', include: 'flag', silent: 'flag', template: 'value', jq: 'value', verbose: 'flag', cache: 'value', preview: 'value', help: 'flag' }, short: { X: 'method', F: 'field', f: 'raw-field', H: 'header', i: 'include', t: 'template', q: 'jq', p: 'preview', h: 'help' } },
  'pr create': { long: { base: 'value', head: 'value', draft: 'flag', title: 'value', body: 'value', 'body-file': 'value', fill: 'flag', 'fill-first': 'flag', 'fill-verbose': 'flag', web: 'flag', label: 'value', assignee: 'value', reviewer: 'value', milestone: 'value', project: 'value', 'no-maintainer-edit': 'flag', 'dry-run': 'flag', recover: 'value', template: 'value', editor: 'flag', repo: 'value', help: 'flag' }, short: { B: 'base', H: 'head', d: 'draft', t: 'title', b: 'body', F: 'body-file', f: 'fill', w: 'web', l: 'label', a: 'assignee', r: 'reviewer', m: 'milestone', p: 'project', T: 'template', e: 'editor', R: 'repo', h: 'help' } },
  'pr ready': { long: { undo: 'flag', repo: 'value', help: 'flag' }, short: { R: 'repo', h: 'help' } },
  'pr merge': { long: { admin: 'flag', auto: 'flag', body: 'value', 'body-file': 'value', 'delete-branch': 'flag', 'disable-auto': 'flag', 'match-head-commit': 'value', merge: 'flag', rebase: 'flag', squash: 'flag', subject: 'value', 'author-email': 'value', repo: 'value', help: 'flag' }, short: { b: 'body', F: 'body-file', d: 'delete-branch', m: 'merge', r: 'rebase', s: 'squash', t: 'subject', A: 'author-email', R: 'repo', h: 'help' } },
};

// owner/name from a URL in any spelling (https, ssh, scp-like), or from owner/name itself.
const slugOf = (value) => {
  const text = String(value).trim();
  const github = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text);
  if (github) return `${github[1]}/${github[2]}`.toLowerCase();
  const parts = text.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '').split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/').toLowerCase() : null;
};

// The repository gh would act on without --repo: GH_REPO, else the remote `gh repo set-default`
// chose, else the only GitHub remote. More than one, and the gate cannot tell, so it refuses.
function defaultSlug(dir) {
  if (process.env.GH_REPO) return slugOf(process.env.GH_REPO);
  let gitDirectory;
  try {
    gitDirectory = gitDir(dir);
  } catch {
    return null;
  }
  const config = run('git', ['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$'], { cwd: dir, allowFail: true, env: { GIT_DIR: gitDirectory } }).stdout ?? '';
  const remotes = new Map();
  for (const line of config.split('\n').filter(Boolean)) {
    const [, name, key, value] = /^remote\.(.+)\.(url|gh-resolved) (.*)$/.exec(line) ?? [];
    if (!name) continue;
    const entry = remotes.get(name) ?? {};
    entry[key] = value;
    remotes.set(name, entry);
  }
  // gh marks the chosen remote with gh-resolved: "base", or the owner/name it resolved to.
  const resolved = [...remotes.values()].find((entry) => entry['gh-resolved']);
  if (resolved) return resolved['gh-resolved'] === 'base' ? slugOf(resolved.url ?? '') : slugOf(resolved['gh-resolved']);
  const github = [...new Set([...remotes.values()].map((entry) => (/github\.com[:/]/.test(entry.url ?? '') ? slugOf(entry.url) : null)).filter(Boolean))];
  if (github.length > 1) refuse(`This repository has more than one GitHub remote, so the gate cannot tell which one gh acts on. Pass -R owner/repo.`);
  return github[0] ?? null;
}

// The pipeline context of the repository a gh command acts on, or null when that repository has
// no pipeline. A repository other than the folder's is gated when it is registered on this machine.
function ghContext(line, cmd, named) {
  const slug = named ? slugOf(named) : defaultSlug(cmd.cwd);
  if (!slug) return null;
  const here = line.context(cmd.cwd);
  if (here?.slug?.toLowerCase() === slug) return here;
  const registered = registeredRepos().find((repo) => repo.slug?.toLowerCase() === slug);
  if (!registered) return null;
  const ctx = line.context(registered.path);
  return ctx?.slug?.toLowerCase() === slug ? ctx : null;
}

export function classifyGh(cmd, line) {
  const words = cmd.words.slice(1).map((word) => word.value);
  let repo = null;
  let i = 0;
  // gh's persistent options may come before the command.
  for (; i < words.length && words[i].startsWith('-'); i++) {
    const text = words[i];
    if (text === '-R' || text === '--repo') repo = words[++i] ?? refuse('--repo needs a value.');
    else if (/^(-R=?|--repo=)./.test(text)) repo = text.replace(/^(-R=?|--repo=)/, '');
    else if (['-h', '--help', '--version'].includes(text)) return { cls: 'read' };
    else refuse(`gh ${text} before the command is an option the gate does not read. Put it after the command, or leave it out.`);
  }
  const top = words[i];
  if (!top) return { cls: 'read' };
  const second = words[i + 1];
  const pair = GROUPS.has(top) ? `${top} ${second ?? ''}`.trim() : top;
  const rest = cmd.words.slice(i + (GROUPS.has(top) ? 3 : 2));
  if (rest.some((word) => ['--help', '-h'].includes(word.value)) || (GROUPS.has(top) && !second)) return { cls: 'read' };
  if (top === 'api') {
    const parsed = parseOptions(asWords(rest), SPECS.api);
    if (!parsed.unknown.length && apiIsRead(parsed)) return { cls: 'read' };
    return { cls: 'action', kind: 'gh api', check: () => ghApi(line, cmd, parsed) };
  }
  if (CHECKED.has(pair)) {
    const parsed = parseOptions(asWords(rest), SPECS[pair]);
    if (parsed.unknown.length) refuse(`gh ${pair} has an option the gate does not read (${parsed.unknown.join(', ')}).`);
    const target = parsed.last('repo')?.value ?? repo;
    const check = { 'pr create': ghPrCreate, 'pr ready': ghPrReady, 'pr merge': ghPrMerge, 'workflow run': ghWorkflowRun, 'run rerun': ghRunRerun }[pair];
    return { cls: 'action', kind: `gh ${pair}`, check: () => check(line, cmd, parsed, target) };
  }
  if (READS.has(pair) || READS.has(top)) return { cls: 'read' };
  if (WRITES.has(pair)) return { cls: 'local' };
  if (!GROUPS.has(top) && !['search', 'status', 'help', 'version', 'completion', 'browse'].includes(top)) refuse(`gh ${top} is not a gh built-in command: it may be an alias or an extension, which the gate does not follow. Run the built-in command it stands for.`);
  refuse(`The gate does not run gh ${pair}: it can publish, change settings or credentials, or approve work in ways the gate does not check. Give the user the command instead.`);
}

// gh api

const normalEndpoint = (text) => String(text ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '').split('?')[0];
const methodOf = (parsed) => {
  const fields = [...parsed.values('field'), ...parsed.values('raw-field')];
  return String(parsed.last('method')?.value ?? (fields.length || parsed.has('input') ? 'POST' : 'GET')).toUpperCase();
};
const fromFile = (parsed) => parsed.values('field').some((option) => /^[^=]*=@/.test(String(option.value))) || parsed.has('input');
const queriesOf = (parsed) => [...parsed.values('field'), ...parsed.values('raw-field')].map((option) => String(option.value)).filter((value) => value.startsWith('query=')).map((value) => value.slice('query='.length));
// A read: help, a GET, or a GraphQL query with no mutation in it.
function apiIsRead(parsed) {
  if (parsed.has('help')) return true;
  if (normalEndpoint(parsed.positionals[0]?.text) === 'graphql') return !fromFile(parsed) && queriesOf(parsed).every((query) => !mutationFields(query).length);
  return ['GET', 'HEAD'].includes(methodOf(parsed));
}

// Writes through the REST API that change discussion and drafts only.
const API_WRITES = [
  [/^issues$/, ['POST']], [/^issues\/\d+$/, ['PATCH']], [/^issues\/\d+\/comments$/, ['POST']], [/^issues\/comments\/\d+$/, ['PATCH', 'DELETE']],
  [/^issues\/\d+\/labels(\/[^/]+)?$/, ['POST', 'PUT', 'DELETE']], [/^pulls$/, ['POST']], [/^pulls\/\d+$/, ['PATCH']], [/^pulls\/\d+\/comments$/, ['POST']],
  [/^pulls\/comments\/\d+$/, ['PATCH', 'DELETE']], [/^pulls\/\d+\/requested_reviewers$/, ['POST', 'DELETE']], [/^statuses\/[0-9a-f]{7,40}$/, ['POST']], [/^actions\/runs\/\d+\/cancel$/, ['POST']],
];

function ghApi(line, cmd, parsed) {
  if (parsed.unknown.length) refuse(`gh api has an option the gate does not read (${parsed.unknown.join(', ')}).`);
  if (parsed.has('help')) return [];
  const fields = [...parsed.values('field'), ...parsed.values('raw-field')].map((option) => String(option.value));
  const fileFields = fromFile(parsed);
  const method = methodOf(parsed);
  const endpoint = normalEndpoint(parsed.positionals[0]?.text);
  const field = (key) => fields.filter((value) => value.startsWith(`${key}=`)).map((value) => value.slice(key.length + 1));
  if (endpoint === 'graphql') {
    if (fileFields) refuse('Its GraphQL query or input is read from a file, which the gate cannot see. Pass the query with -f query=\'...\'.');
    // A mutation names its target by node id, not by repository, so the allow-list of the folder's
    // repository applies, and elsewhere none is allowed.
    const names = queriesOf(parsed).flatMap(mutationFields);
    if (!names.length) return [];
    const allowed = new Set(ghContext(line, cmd, null)?.config.github.allowedMutations ?? []);
    const denied = names.find((name) => !allowed.has(name));
    if (denied) refuse(`It sends the GraphQL mutation ${denied}, which is not on github.allowedMutations. Use the gh command for the step (gh pr merge, gh pr ready), or give the user the command.`);
    return [];
  }
  if (['GET', 'HEAD'].includes(method)) return [];
  if (parsed.has('hostname')) refuse('It writes to another GitHub host (--hostname), which the gate does not check.');
  if (/^repositories\/\d+(\/|$)/.test(endpoint)) refuse('It writes to a repository named by its numeric id, which the gate does not resolve. Name it as repos/<owner>/<repo>.');
  const match = /^repos\/([^/]+)\/([^/]+)\/?(.*)$/.exec(endpoint);
  if (!match) refuse(`gh api ${method} ${endpoint || '(no endpoint)'} is not a write the gate lets through. Use the gh command for the step, or give the user the command.`);
  const here = defaultSlug(cmd.cwd);
  const fill = (part, i) => (part === '{owner}' || part === '{repo}' ? here?.split('/')[i] ?? refuse('Its {owner}/{repo} placeholders need a repository the gate can find. Run it from the workspace, or write the repository out.') : part);
  const slug = `${fill(match[1], 0)}/${fill(match[2], 1)}`;
  const ctx = ghContext(line, cmd, slug);
  if (!ctx) return [];
  const rest = match[3];
  const prod = new RegExp(ctx.config.deploy.prodPattern, 'i');
  const dispatch = /^actions\/workflows\/([^/]+)\/dispatches$/.exec(rest);
  if (dispatch) {
    if (prod.test(decodeURIComponent(dispatch[1])) || fields.some((value) => prod.test(value.split('=').slice(1).join('=')))) refuse(NEVER_PROD);
    refuse(`Dispatch it with gh workflow run ${decodeURIComponent(dispatch[1])} --ref <branch>, so the gate can check the workflow and the commit.`);
  }
  if (rest === 'dispatches') refuse('A repository_dispatch event can start a deploy the gate cannot check.');
  if (/^actions\/(runs|jobs)\/\d+\/(rerun|rerun-failed-jobs)$/.test(rest) || /^actions\/runs\/\d+\/jobs\/\d+\/rerun$/.test(rest)) refuse('Rerun it with gh run rerun <id>, so the gate can check the workflow.');
  if (/^actions\/runs\/\d+\/(pending_deployments|deployment_protection_rule)$/.test(rest)) refuse('It approves a pending deployment. The user approves deployments.');
  if (/^deployments(\/|$)|^environments(\/|$)/.test(rest)) refuse('It records or starts a deployment, or changes an environment, which the gate does not check.');
  if (/^pulls\/\d+\/merge$/.test(rest)) refuse(`Merge it with gh pr merge ${rest.split('/')[1]}, so the gate can check it.`);
  if (/^pulls\/\d+\/reviews/.test(rest)) refuse('It reviews a pull request. Reviews come from the review routine, not from an agent\'s gh call.');
  if (['merges', 'merge-upstream'].includes(rest) || /^branches\/[^/]+\/rename$/.test(rest)) refuse('It merges or renames branches on GitHub, which the gate does not check. Push with jj git push instead.');
  if (/^git\/refs(\/|$)/.test(rest)) refuse(fields.some((value) => /^ref=refs\/tags\//.test(value)) || /^git\/refs\/tags\//.test(rest) ? 'It creates or moves a tag on GitHub. Agents push only branches.' : 'It moves a branch on GitHub without the gate. Push with jj git push -b <name>.');
  // A tag object alone (git/tags) creates no ref, and falls to the general refusal below.
  if (/^releases(\/|$)/.test(rest)) refuse('It creates or changes a release on GitHub, which the user does.');
  if (/^contents\//.test(rest)) refuse('It commits on GitHub without the scan or review. Commit locally and push.');
  const allowed = API_WRITES.find(([pattern, methods]) => pattern.test(rest) && methods.includes(method));
  if (!allowed) refuse(`gh api ${method} repos/${slug}/${rest} is not a write the gate lets through. Use the gh command for the step, or give the user the command.`);
  if (/^statuses\//.test(rest)) {
    const context = field('context').at(-1);
    if (fileFields || context === undefined || /^pipeline\//.test(context) || context === 'agent-review') refuse('The pipeline/* and agent-review statuses are set only by the tools that check them, never from a file. Record the stage with its pipeline command instead.');
  }
  if (fileFields) refuse('A field is read from a file, which the gate cannot see. Write each field out with -f key=value.');
  if (rest === 'pulls' && provider(ctx.config) === 'builtin' && field('draft').at(-1) !== 'true') refuse('It opens a pull request ready for review. Create it with gh pr create --draft.');
  return [];
}

// The fields a GraphQL document's mutation operations select at the top: mutation names. Strings
// and comments are dropped first, so neither can hide or fake one.
export function mutationFields(query) {
  const text = String(query).replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/#[^\n]*/g, '');
  const names = [];
  const operation = /\bmutation\b/g;
  let found;
  while ((found = operation.exec(text))) {
    let k = text.indexOf('{', found.index);
    if (k === -1) break;
    let depth = 0;
    for (; k < text.length; k++) {
      const ch = text[k];
      if (ch === '{') depth++;
      else if (ch === '}') { if (--depth === 0) break; }
      else if (ch === '(') {
        let parens = 1;
        while (parens && ++k < text.length) parens += text[k] === '(' ? 1 : text[k] === ')' ? -1 : 0;
      } else if (depth === 1 && /[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_]/.test(text[k - 1] ?? '')) {
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(k))[0];
        const after = text.slice(k + name.length).trimStart();
        // An alias (alias: field) names the field after the colon.
        if (after.startsWith(':')) { k += name.length; continue; }
        if (!['on', 'fragment'].includes(name)) names.push(name);
        k += name.length - 1;
      }
    }
    operation.lastIndex = k;
  }
  return names.length || !/\bmutation\b/.test(text) ? names : ['(an unreadable mutation)'];
}

// Pull requests

function reviewProblems(ctx, head) {
  const missing = reviewCoverage(ctx.repo, head, ctx.config).filter((commit) => !reviewPassed(commit));
  return missing.length ? [`${missing.length} commit(s) lack review consensus: ${missing.slice(0, 5).map((commit) => short(commit.id)).join(', ')}.`] : [];
}

function localCommit(ctx, sha) {
  if (!resolveRevset(ctx.repo, `present(${sha})`).length) refuse(`${short(sha)} is not in this repository yet. Run jj git fetch, then check again.`);
  return sha;
}

// A pull request named by number: a URL or a branch can name one in another repository.
function prNumber(parsed) {
  const pr = parsed.positionals[0]?.text ?? refuse('Name the pull request, so the gate can check its commits.');
  if (!/^\d+$/.test(pr)) refuse(`Name the pull request by its number, not ${pr}, and the repository with -R when it is not this one.`);
  return pr;
}

function ghPrCreate(line, cmd, parsed, target) {
  const ctx = ghContext(line, cmd, target);
  if (!ctx || parsed.has('help') || provider(ctx.config) !== 'builtin' || parsed.has('draft') || parsed.has('dry-run')) return [];
  const head = parsed.last('head')?.value;
  if (!head || head.includes(':')) refuse('It opens a pull request ready for review. Create it with --draft, or pass --head <branch> of this repository so the gate can check its commits.');
  const sha = ctx.remoteHeads.get(head);
  if (!sha) refuse(`${head} is not a branch on ${ctx.config.remote}. Push it first.`);
  return reviewProblems(ctx, localCommit(ctx, sha));
}

function ghPrReady(line, cmd, parsed, target) {
  const ctx = ghContext(line, cmd, target);
  if (!ctx || parsed.has('help') || parsed.has('undo') || provider(ctx.config) !== 'builtin') return [];
  const pr = prNumber(parsed);
  return reviewProblems(ctx, localCommit(ctx, pullRequest(ctx.slug, pr).head));
}

function ghPrMerge(line, cmd, parsed, target) {
  const ctx = ghContext(line, cmd, target);
  if (!ctx || parsed.has('help') || (parsed.has('disable-auto') && !parsed.has('auto'))) return [];
  const { config } = ctx;
  if (parsed.has('admin')) refuse('--admin merges past the branch rules. The user does that.');
  const pr = prNumber(parsed);
  const info = pullRequest(ctx.slug, pr);
  if (info.base === config.trunk && config.deploy.runBy === 'user') refuse(userRuns(config, `gh pr merge ${pr}`));
  const head = localCommit(ctx, info.head);
  if (info.base === config.trunk) {
    return [...holeProblems(ctx, head), ...deployProblems(ctx, runForCommit(ctx.identity, head), head).map((problem) => `Merging into ${config.trunk} is a deploy step: ${problem}`)];
  }
  return [...holeProblems(ctx, head), ...(provider(config) === 'builtin' ? reviewProblems(ctx, head) : [])];
}

// Workflows

// The workflow file as committed at the remote trunk, so a branch cannot rename what it does.
function workflowText(ctx, path) {
  if (!ctx.config.trunkSha) return '';
  const result = run('git', ['show', `${ctx.config.trunkSha}:${path}`], { cwd: ctx.repo, allowFail: true, env: { GIT_DIR: gitDir(ctx.repo), GIT_NO_REPLACE_OBJECTS: '1' } });
  return result.status === 0 ? result.stdout : '';
}

// Whether a workflow deploys to production: its path, its name, an environment it names, or an
// input value matches deploy.prodPattern.
function workflowClass(ctx, workflow, inputs = []) {
  const { config } = ctx;
  const prod = new RegExp(config.deploy.prodPattern, 'i');
  const text = workflowText(ctx, workflow.path);
  const environments = [...text.matchAll(/^\s*environment:[ \t]*(?:\n\s+name:[ \t]*)?["']?([^"'\n#]*?)["']?[ \t]*(?:#.*)?$/gm)].map((found) => found[1].trim());
  // An environment named by an expression can take any input's default.
  const defaults = environments.some((name) => name.includes('${{') || !name) ? [...text.matchAll(/^\s*default:\s*["']?([^"'\n#]+)/gm)].map((found) => found[1]) : [];
  const isProd = [workflow.path, workflow.name, ...environments, ...defaults, ...inputs].some((value) => prod.test(String(value)));
  const isDeploy = isProd || environments.length > 0 || new RegExp(config.deploy.deployWorkflows, 'i').test(`${workflow.path} ${workflow.name}`);
  return { isProd, isDeploy };
}

function resolved(ctx, selector) {
  try {
    return resolveWorkflow(ctx.slug, selector);
  } catch (error) {
    if (error instanceof WorkflowError) refuse(error.message);
    throw error;
  }
}

function ghWorkflowRun(line, cmd, parsed, target) {
  const ctx = ghContext(line, cmd, target);
  if (!ctx || parsed.has('help')) return [];
  const { config } = ctx;
  const selector = parsed.positionals[0]?.text ?? refuse('Name the workflow, so the gate can tell what it runs.');
  if (parsed.has('json')) refuse('--json reads the inputs from stdin, which the gate cannot see. Pass each input with -f key=value.');
  if (parsed.values('field').some((option) => /^[^=]*=@/.test(String(option.value)))) refuse('An input is read from a file the gate cannot see. Pass each input with -f key=value.');
  const inputs = [...parsed.values('raw-field'), ...parsed.values('field')].map((option) => String(option.value).split('=').slice(1).join('='));
  const workflow = resolved(ctx, selector);
  const { isProd, isDeploy } = workflowClass(ctx, workflow, inputs);
  if (isProd) refuse(NEVER_PROD);
  if (config.deploy.runBy === 'user' && !config.deploy.allowedWorkflows.includes(workflow.path)) refuse(`${workflow.path} is not on deploy.allowedWorkflows, and the user runs deploys here (deploy.runBy is "user"). Give the user the command instead.`);
  // A deploy workflow the user listed in deploy.allowedWorkflows is checked as any deploy is.
  if (!isDeploy) return [];
  const ref = parsed.last('ref')?.value;
  if (!ref) refuse('Pass --ref with the branch to deploy, so the gate can check the commit GitHub runs.');
  const branch = ref.replace(/^refs\/heads\//, '');
  // GitHub runs the ref as the remote has it, which the context read from the remote itself.
  const sha = ctx.remoteHeads.get(branch);
  if (!sha) refuse(`${ref} is not a branch on ${config.remote}. Push it first, and pass the branch name.`);
  if (ctx.remoteTags?.has(branch)) refuse(`${ref} names both a branch and a tag on ${config.remote}, so the gate cannot tell which GitHub runs.`);
  return [...holeProblems(ctx, sha), ...deployProblems(ctx, runForCommit(ctx.identity, sha), sha)];
}

function ghRunRerun(line, cmd, parsed, target) {
  const ctx = ghContext(line, cmd, target);
  if (!ctx || parsed.has('help')) return [];
  const id = parsed.positionals[0]?.text;
  if (!id || !/^\d+$/.test(id)) refuse('Name the run ID, so the gate can tell what the rerun runs.');
  const workflow = runWorkflow(ctx.slug, id);
  const { isProd, isDeploy } = workflowClass(ctx, workflow);
  if (isProd) refuse(NEVER_PROD);
  if (ctx.config.deploy.runBy === 'user' && !ctx.config.deploy.allowedWorkflows.includes(workflow.path)) refuse(`${workflow.path} is not on deploy.allowedWorkflows, and the user runs deploys here (deploy.runBy is "user"). Give the user the command instead.`);
  if (isDeploy) refuse('A rerun of a deploy repeats inputs the gate cannot see. Dispatch the deploy again with gh workflow run --ref.');
  return [];
}

// curl and wget aimed at GitHub may read, never write or carry a token.
const CURL_WRITES = /^(-X|--request|-d|--data.*|--json|-F|--form.*|-T|--upload-file|-u|--user|--oauth2-bearer|-n|--netrc.*|-K|--config|-b|--cookie|-E|--cert)(=|$)|^-[a-zA-Z]*[XdFTuKnbE]/;
const WGET_WRITES = /^(--method|--post-data|--post-file|--body-data|--body-file|--user|--password|--http-user|--http-password|-e|--execute|--config|--load-cookies)(=|$)/;
export function classifyHttp(cmd) {
  const name = cmd.words[0].value.split('/').pop();
  const words = cmd.words.slice(1).map((word) => word.value);
  const header = (i) => /^(-H|--header)$/.test(words[i - 1] ?? '') || /^(-H|--header=)/.test(words[i]);
  for (let i = 0; i < words.length; i++) {
    const text = words[i];
    if ((name === 'curl' && CURL_WRITES.test(text)) || (name === 'wget' && WGET_WRITES.test(text))) refuse(`${name} ${text.split('=')[0]} writes to GitHub or sends credentials, which the gate does not check. Use gh for the step.`);
    if (header(i) && /authorization|token|bearer/i.test(text)) refuse(`${name} sends a credential to GitHub, which the gate does not check. Use gh for the step.`);
  }
  return { cls: 'read' };
}

