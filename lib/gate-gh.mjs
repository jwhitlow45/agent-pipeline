// The gate's reading of gh, curl and wget. gh is read the way gh reads itself: the persistent
// --repo option may come before the command, booleans take pflag values (--draft=false is false),
// and only built-in commands run, never an alias or an extension. Each command is a read, a write
// the gate lets through (comments, labels, drafts), a checked action (merges, ready pull requests,
// dispatches, reruns, API writes), or refused.

import { parseOptions } from './argv.mjs';
import { NEVER_PROD, readOrRefuse, refuse, userRuns } from './gate-common.mjs';
import { checkPush } from './gate-vcs.mjs';
import { pullRequest, requiredChecks, resolveWorkflow, runWorkflow, WorkflowError } from './github.mjs';
import { parseWords, someOptions, spec } from './options.mjs';
import { cloneFolders, clonesOf, registeredRepos } from './registry.mjs';
import { provider, ProviderError, reviewCoverage, reviewPassed } from './review.mjs';
import { deployProblems, holeProblems, runForCommit } from './ship.mjs';
import { short } from './util.mjs';
import { FileReadError, gitRepository, gitSetting, root as workspaceRoot, vcsAt } from './vcs.mjs';
import { readWorkflow } from './workflow-file.mjs';

const asWords = (list) => list.map((word) => ({ text: word.value, dynamic: !word.literal }));

const READS = new Set(['pr view', 'pr list', 'pr status', 'pr checks', 'pr diff', 'issue view', 'issue list', 'issue status', 'run view', 'run list', 'run watch', 'workflow list', 'workflow view', 'repo view', 'repo list', 'release list', 'release view', 'search', 'status', 'auth status', 'help', 'version', 'label list', 'cache list', 'gist view', 'gist list', 'org list', 'ruleset list', 'ruleset view', 'ruleset check', 'secret list', 'variable list', 'variable get', 'project list', 'project view', 'codespace list', 'attestation verify', 'completion', 'ssh-key list', 'gpg-key list', 'config get', 'config list', 'alias list', 'extension list', 'browse']);
// Writes the gate lets through: they change discussion and drafts, never code, branches or deploys.
const WRITES = new Set(['pr edit', 'pr comment', 'pr reopen', 'pr checkout', 'issue create', 'issue edit', 'issue comment', 'issue close', 'issue reopen', 'run cancel', 'run download', 'release download', 'repo clone']);
const CHECKED = new Set(['pr create', 'pr ready', 'pr merge', 'workflow run', 'run rerun', 'api']);
const GROUPS = new Set(['pr', 'issue', 'run', 'workflow', 'repo', 'release', 'auth', 'label', 'cache', 'gist', 'org', 'ruleset', 'secret', 'variable', 'project', 'codespace', 'attestation', 'ssh-key', 'gpg-key', 'config', 'alias', 'extension']);

const SPECS = {
  'workflow run': { long: { ref: 'value', 'raw-field': 'value', field: 'value', json: 'flag', repo: 'value', help: 'flag' }, short: { r: 'ref', f: 'raw-field', F: 'field', R: 'repo', h: 'help' } },
  'run rerun': { long: { failed: 'flag', job: 'value', debug: 'flag', repo: 'value', help: 'flag' }, short: { j: 'job', d: 'debug', R: 'repo', h: 'help' } },
  api: { long: { method: 'value', field: 'value', 'raw-field': 'value', header: 'value', input: 'value', hostname: 'value', paginate: 'flag', slurp: 'flag', include: 'flag', silent: 'flag', template: 'value', jq: 'value', verbose: 'flag', cache: 'value', preview: 'value', help: 'flag' }, short: { X: 'method', F: 'field', f: 'raw-field', H: 'header', i: 'include', t: 'template', q: 'jq', p: 'preview', h: 'help' } },
  'pr create': { long: { base: 'value', head: 'value', draft: 'flag', title: 'value', body: 'value', 'body-file': 'value', fill: 'flag', 'fill-first': 'flag', 'fill-verbose': 'flag', web: 'flag', label: 'value', assignee: 'value', reviewer: 'value', milestone: 'value', project: 'value', 'no-maintainer-edit': 'flag', 'dry-run': 'flag', recover: 'value', template: 'value', editor: 'flag', repo: 'value', help: 'flag' }, short: { B: 'base', H: 'head', d: 'draft', t: 'title', b: 'body', F: 'body-file', f: 'fill', w: 'web', l: 'label', a: 'assignee', r: 'reviewer', m: 'milestone', p: 'project', T: 'template', e: 'editor', R: 'repo', h: 'help' } },
  'pr ready': { long: { undo: 'flag', repo: 'value', help: 'flag' }, short: { R: 'repo', h: 'help' } },
  'pr close': { long: { comment: 'value', 'delete-branch': 'flag', repo: 'value', help: 'flag' }, short: { c: 'comment', d: 'delete-branch', R: 'repo', h: 'help' } },
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
  // gh reads the git repository the folder is in: jj names it for a workspace, and git itself for a
  // repository jj does not know. Only a folder with no repository at all has no default.
  const gitDirectory = workspaceRoot(dir) ? vcsAt(dir).gitDir() : gitRepository(dir)?.gitDir;
  if (!gitDirectory) return null;
  const config = gitSetting(dir, ['--get-regexp', '^remote\\..*\\.(url|gh-resolved)$'], { gitDir: gitDirectory });
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
// no pipeline. A repository other than the folder's is gated when it is registered on this machine,
// and read in a clone that still holds it. With none left, the gate cannot read its policy, so it
// refuses rather than let the command through unchecked.
function ghContext(line, cmd, named) {
  const slug = named ? slugOf(named) : defaultSlug(cmd.cwd);
  if (!slug) return null;
  const here = line.context(cmd.cwd);
  if (here?.slug?.toLowerCase() === slug) return here;
  const registered = registeredRepos().find((repo) => repo.slug?.toLowerCase() === slug);
  if (!registered) return null;
  const folder = clonesOf(registered).flatMap(cloneFolders)[0];
  if (!folder) refuse(`${slug} is registered with the pipeline, but no clone of it on this machine still holds it, so the gate cannot read its policy. Run the command in a clone of ${slug}, then run pipeline status there.`);
  const ctx = line.context(folder);
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
  // Help is help only where gh would read it so: first, or as a flag the command's own parse finds.
  // In gh pr merge 1 --body --help, --help is the body.
  if ((GROUPS.has(top) && !second) || ['--help', '-h'].includes(rest[0]?.value)) return { cls: 'read' };
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
  if (pair === 'pr close') {
    const parsed = parseOptions(asWords(rest), SPECS[pair]);
    if (parsed.unknown.length) refuse(`gh pr close has an option the gate does not read (${parsed.unknown.join(', ')}).`);
    if (parsed.has('help') || !parsed.has('delete-branch')) return { cls: 'local' };
    const target = parsed.last('repo')?.value ?? repo;
    return { cls: 'action', kind: 'gh pr close', check: () => ghBranchDeletion(line, cmd, parsed, target) };
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
    const reserved = reservedContext(ctx, context);
    if (reserved) refuse(`${context} is ${reserved}, which only that check may set. An agent never sets a status a merge or deploy waits on.`);
  }
  if (fileFields) refuse('A field is read from a file, which the gate cannot see. Write each field out with -f key=value.');
  // A draft opens no review, so a provider the gate cannot use does not refuse one, as in gh pr create.
  if (rest === 'pulls' && field('draft').at(-1) !== 'true' && reviewProvider(ctx) === 'builtin') refuse('It opens a pull request ready for review. Create it with gh pr create --draft.');
  return [];
}

// Why a status context is not an agent's to set, or null: the CI workflow's own name (or a job of
// it, "CI / test"), or a check the trunk's rules require.
function reservedContext(ctx, context) {
  const wanted = String(context).toLowerCase();
  const ci = ctx.config.ci?.workflow;
  if (ci) {
    let workflow;
    try {
      workflow = resolveWorkflow(ctx.slug, ci);
    } catch (error) {
      if (error instanceof WorkflowError) refuse(`The gate cannot tell which workflow is CI (${error.message}), so it cannot tell which status contexts are the CI workflow's.`);
      throw error;
    }
    const names = [String(ci), workflow.name, workflow.path?.split('/').pop()?.replace(/\.ya?ml$/i, '')].filter(Boolean).map((name) => name.toLowerCase());
    if (names.some((name) => wanted === name || wanted.startsWith(`${name} /`))) return `the CI workflow's (${ci})`;
  }
  if (requiredChecks(ctx.slug, ctx.config.trunk).has(wanted)) return `a check ${ctx.config.trunk}'s rules require`;
  return null;
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

// The review provider of the context's repository. A plain git repository whose committed config
// names agent-review refuses the line, so it never skips the builtin pull request checks.
function reviewProvider(ctx) {
  try {
    return provider(ctx.config, ctx.vcs.backend);
  } catch (error) {
    if (error instanceof ProviderError) refuse(error.message);
    throw error;
  }
}

function reviewProblems(ctx, head) {
  const missing = reviewCoverage(ctx.repo, head, ctx.config).filter((commit) => !reviewPassed(commit));
  return missing.length ? [`${missing.length} commit(s) lack review consensus: ${missing.slice(0, 5).map((commit) => short(commit.id)).join(', ')}.`] : [];
}

function localCommit(ctx, sha) {
  if (!readOrRefuse(sha, () => ctx.vcs.exists(sha))) refuse(`${short(sha)} is not in this repository yet. Run jj git fetch, then check again.`);
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
  // A draft opens no review, so a provider the gate cannot use does not refuse one.
  if (!ctx || parsed.has('help') || parsed.has('draft') || parsed.has('dry-run') || reviewProvider(ctx) !== 'builtin') return [];
  const head = parsed.last('head')?.value;
  if (!head || head.includes(':')) refuse('It opens a pull request ready for review. Create it with --draft, or pass --head <branch> of this repository so the gate can check its commits.');
  const sha = ctx.remoteHeads.get(head);
  if (!sha) refuse(`${head} is not a branch on ${ctx.config.remote}. Push it first.`);
  return reviewProblems(ctx, localCommit(ctx, sha));
}

function ghPrReady(line, cmd, parsed, target) {
  const ctx = ghContext(line, cmd, target);
  if (!ctx || parsed.has('help') || parsed.has('undo') || reviewProvider(ctx) !== 'builtin') return [];
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
  const deletion = parsed.has('delete-branch') ? deletionProblems(ctx, info) : [];
  if (info.base === config.trunk) {
    return [...deletion, ...holeProblems(ctx, head), ...deployProblems(ctx, runForCommit(ctx.identity, head), head).map((problem) => `Merging into ${config.trunk} is a deploy step: ${problem}`)];
  }
  return [...deletion, ...holeProblems(ctx, head), ...(reviewProvider(ctx) === 'builtin' ? reviewProblems(ctx, head) : [])];
}

// --delete-branch deletes the pull request's head branch on the remote, as a push would.
function deletionProblems(ctx, info) {
  if (info.crossRepository) refuse(`--delete-branch would delete ${info.headRef} in another repository, the fork the pull request comes from. Leave the branch, or delete it there.`);
  return checkPush(ctx, { bookmark: info.headRef, target: null }).map((problem) => `${info.headRef}: ${problem}`);
}

function ghBranchDeletion(line, cmd, parsed, target) {
  const ctx = ghContext(line, cmd, target);
  if (!ctx) return [];
  return deletionProblems(ctx, pullRequest(ctx.slug, prNumber(parsed)));
}

// Workflows

// A workflow file as committed at a commit, or '' only when that commit's tree proves it has none.
// The gate reads the file GitHub will run, so any other failure is unknown, which refuses.
function workflowAt(ctx, sha, path) {
  try {
    return ctx.vcs.committedFile(sha, path) ?? '';
  } catch (error) {
    if (error instanceof FileReadError) refuse(`The gate cannot read ${path} at ${short(sha)}, the commit GitHub runs it from: ${error.message}. Fetch from the remote, then try again.`);
    throw error;
  }
}

// Whether a workflow deploys, and to production. The policy (prodPattern, deployWorkflows) comes from
// the trusted trunk. The workflow is read as committed at the commit GitHub runs (`sha`: the --ref,
// or a rerun's original commit) and at trunk, with every local workflow it calls, so a branch cannot
// turn a harmless workflow into a deploy. Its path, its names, an environment it names, or an input
// value matching prodPattern makes it production. An environment the gate cannot read is refused.
function workflowClass(ctx, workflow, { inputs = [], sha }) {
  const { config } = ctx;
  const prod = new RegExp(config.deploy.prodPattern, 'i');
  const names = [workflow.path, workflow.name];
  const environments = [];
  const seen = new Set();
  const read = (path, at, depth) => {
    if (seen.has(`${at}:${path}`)) return;
    seen.add(`${at}:${path}`);
    const found = readWorkflow(workflowAt(ctx, at, path));
    if (found.unreadable) refuse(`The gate cannot read ${path} at ${short(at)}: ${found.unreadable}. Name each job's environment as a plain name (environment: staging, or name: staging under it), so the gate can tell where it deploys.`);
    // Every file visited counts by its path too: a callee named deploy-prod.yml is production.
    names.push(path);
    if (found.name) names.push(found.name);
    environments.push(...found.environments);
    for (const uses of found.calls) {
      const local = /^\.\/(\.github\/workflows\/[^@\s]+\.ya?ml)$/.exec(uses);
      if (!local || depth >= 4) refuse(`${path} calls ${uses}, a workflow ${local ? 'nested too deep' : 'in another repository or at another ref'}, which the gate cannot read.`);
      read(local[1], at, depth + 1);
    }
  };
  for (const at of new Set([config.trunkSha, sha].filter(Boolean))) read(workflow.path, at, 0);
  const isProd = [...names, ...environments, ...inputs].some((value) => prod.test(String(value)));
  const isDeploy = isProd || environments.length > 0 || new RegExp(config.deploy.deployWorkflows, 'i').test(names.join(' '));
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
  const prod = new RegExp(config.deploy.prodPattern, 'i');
  if ([workflow.path, workflow.name, ...inputs].some((value) => prod.test(String(value)))) refuse(NEVER_PROD);
  // GitHub runs the workflow file of the ref, as the remote has it, or of the default branch. The
  // context read both from the remote itself.
  const ref = parsed.last('ref')?.value;
  if (ref && /^refs\/tags\//.test(ref)) refuse(`${ref} is a tag. Pass the branch to run, so the gate can read the workflow GitHub runs.`);
  const branch = ref ? ref.replace(/^refs\/heads\//, '') : ctx.remoteHead ?? config.trunk;
  const sha = ctx.remoteHeads.get(branch);
  if (!sha) refuse(`${ref ?? branch} is not a branch on ${config.remote}. Push it first, and pass the branch name.`);
  if (ctx.remoteTags?.has(branch)) refuse(`${ref ?? branch} names both a branch and a tag on ${config.remote}, so the gate cannot tell which GitHub runs.`);
  const { isProd, isDeploy } = workflowClass(ctx, workflow, { inputs, sha });
  if (isProd) refuse(NEVER_PROD);
  if (config.deploy.runBy === 'user' && !config.deploy.allowedWorkflows.includes(workflow.path)) refuse(`${workflow.path} is not on deploy.allowedWorkflows, and the user runs deploys here (deploy.runBy is "user"). Give the user the command instead.`);
  // A deploy workflow the user listed in deploy.allowedWorkflows is checked as any deploy is.
  if (!isDeploy) return [];
  if (!ref) refuse('Pass --ref with the branch to deploy, so the gate can check the commit GitHub runs.');
  return [...holeProblems(ctx, sha), ...deployProblems(ctx, runForCommit(ctx.identity, sha), sha)];
}

function ghRunRerun(line, cmd, parsed, target) {
  const ctx = ghContext(line, cmd, target);
  if (!ctx || parsed.has('help')) return [];
  const id = parsed.positionals[0]?.text;
  if (!id || !/^\d+$/.test(id)) refuse('Name the run ID, so the gate can tell what the rerun runs.');
  const workflow = runWorkflow(ctx.slug, id);
  // A rerun runs the workflow file of the run's own commit.
  if (!workflow.headSha || !/^[0-9a-f]{40}$/.test(workflow.headSha)) refuse(`GitHub did not say which commit run ${id} ran, so the gate cannot read the workflow a rerun would run.`);
  const { isProd, isDeploy } = workflowClass(ctx, workflow, { sha: workflow.headSha });
  if (isProd) refuse(NEVER_PROD);
  if (ctx.config.deploy.runBy === 'user' && !ctx.config.deploy.allowedWorkflows.includes(workflow.path)) refuse(`${workflow.path} is not on deploy.allowedWorkflows, and the user runs deploys here (deploy.runBy is "user"). Give the user the command instead.`);
  if (isDeploy) refuse('A rerun of a deploy repeats inputs the gate cannot see. Dispatch the deploy again with gh workflow run --ref.');
  return [];
}

// curl and wget aimed at GitHub may read, never write or carry a token. Their options are an exact
// list too: curl 8 reads headers from a file (-H @file) and expands variables into a request
// (--variable, --expand-*), and wget, like any getopt program, takes a unique prefix of a long option.
const CURL_WRITES = /^(-X|--request|-d|--data.*|--json|-F|--form.*|-T|--upload-file|-u|--user|--oauth2-bearer|-n|--netrc.*|-K|--config|-b|--cookie|-E|--cert)(=|$)|^-[a-zA-Z]*[XdFTuKnbE]/;
const WGET_WRITES = /^(--method|--post-data|--post-file|--body-data|--body-file|--user|--password|--http-user|--http-password|-e|--execute|--config|--load-cookies)(=|$)/;
const HTTP_READS = {
  curl: spec({
    flags: 'sSLfiIvkG#46NqgOZ', values: 'oHAwmrDeCYy',
    long: ['--silent', '--show-error', '--location', '--fail', '--fail-with-body', '--include', '--head', '--verbose', '--insecure', '--get', '--compressed', '--progress-bar', '--remote-name', '--remote-name-all', '--create-dirs', '--no-progress-meter', '--globoff', '--http1.1', '--http2', '--ipv4', '--ipv6', '--raw', '--no-buffer', '--location-trusted', '--disable'],
    longValues: ['--output', '--header', '--user-agent', '--write-out', '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '--range', '--dump-header', '--referer', '--url', '--proto', '--proto-redir', '--max-filesize', '--limit-rate', '--output-dir', '--continue-at', '--max-redirs'],
  }),
  wget: spec({
    flags: 'qvSckNrlp', values: 'OoPUTtnwQa',
    long: ['--quiet', '--verbose', '--no-verbose', '--server-response', '--spider', '--continue', '--timestamping', '--no-check-certificate', '--show-progress', '--no-clobber', '--no-directories', '--force-directories'],
    longValues: ['--output-document', '--output-file', '--append-output', '--directory-prefix', '--user-agent', '--timeout', '--tries', '--header', '--wait', '--max-redirect', '--quota'],
  }),
};

export function classifyHttp(cmd) {
  const name = cmd.words[0].value.split('/').pop().toLowerCase();
  const words = cmd.words.slice(1).map((word) => word.value);
  for (const text of words) {
    if ((name === 'curl' && CURL_WRITES.test(text)) || (name === 'wget' && WGET_WRITES.test(text))) refuse(`${name} ${text.split('=')[0]} writes to GitHub or sends credentials, which the gate does not check. Use gh for the step.`);
  }
  // One parse takes the clusters apart (-sH, -sSLo), and every check below reads its pairs. Output
  // paths, -w formats and -K files are checked on every line, GitHub or not, before this runs.
  const parsed = parseWords(HTTP_READS[name], words);
  if (parsed.problem) refuse(`${name} ${parsed.problem} is not an option the gate reads on a request to GitHub. Use gh for the step, or run ${name} only with read options from its list${someOptions(HTTP_READS[name])}, spelled out in full.`);
  for (const { option, values } of parsed.pairs) {
    const value = values[0] ?? '';
    if (['-H', '--header'].includes(option)) {
      if (value.startsWith('@')) refuse(`${name} reads a header from a file the gate cannot see. Write each header out, or use gh for the step.`);
      if (/authorization|token|bearer|cookie/i.test(value)) refuse(`${name} sends a credential to GitHub, which the gate does not check. Use gh for the step.`);
    }
  }
  return { cls: 'read' };
}
