// pipeline doctor: which of the settings that back the gate are missing, on GitHub and on this
// machine. The gate stops the forms an agent would plausibly write, but only GitHub can make "never"
// hold against a script, so docs/integration.md lists what it must enforce. This reads those settings
// with gh api and changes nothing. Each finding is ok, missing, or unverified: a setting the API cannot
// show, which the user has to confirm. It never says everything is present while one is unproven.

import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoContext } from './context.mjs';
import { registeredRepos, RegistryError } from './registry.mjs';
import { fail, ghCommand, globToRegExp, run } from './util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIPELINE_CONTEXTS = ['pipeline/scan', 'pipeline/ci'];

const gh = (path) => {
  const result = run(ghCommand(), ['api', path], { allowFail: true, timeout: 30_000 });
  if (result.status !== 0) return { error: (result.stderr || result.error?.message || '').trim().split('\n')[0] || `exit ${result.status}` };
  try {
    return { value: JSON.parse(result.stdout || 'null') };
  } catch {
    return { error: `gh api ${path} did not answer JSON` };
  }
};

// Whether a ruleset covers a ref, by its include and exclude patterns.
function covers(ruleset, ref, defaultBranch) {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  const matches = (pattern) => pattern === '~ALL' || (pattern === '~DEFAULT_BRANCH' && ref === `refs/heads/${defaultBranch}`) || (pattern.includes('/') && globToRegExp(pattern).test(ref));
  return include.some(matches) && !exclude.some(matches);
}

// Whether a ruleset covers every ref of its kind: all of them included, none excluded. A sample name
// passing proves nothing about the names an agent might push.
function coversEvery(ruleset, kind) {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  return exclude.length === 0 && include.some((pattern) => pattern === '~ALL' || pattern === `refs/${kind}/**` || pattern === '**');
}

// Whether a repository runs the pipeline's git pre-push hook, wherever its hooks path points. Only
// the file install.sh links counts, and git runs it only when it is executable. A hook of another
// kind may call the pipeline or not, which doctor cannot tell from its text.
function prePushHook(repo) {
  const path = run('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: repo, allowFail: true }).stdout?.trim();
  if (!path) return { state: 'missing', why: 'git cannot find its hooks folder there' };
  const file = resolve(repo, path);
  if (!existsSync(file)) return { state: 'missing', why: `${file} does not exist` };
  try {
    accessSync(file, constants.X_OK);
  } catch {
    return { state: 'missing', why: `${file} is not executable, so git skips it` };
  }
  const real = (target) => {
    try {
      return realpathSync(target);
    } catch {
      return null;
    }
  };
  const shipped = real(join(ROOT, 'git-hooks', 'pre-push'));
  if (shipped && real(file) === shipped) return { state: 'ok' };
  return { state: 'unverified', why: `${file} is not the hook install.sh links, so doctor cannot tell whether it runs the pipeline` };
}

export function doctorFindings(ctx, { repos = [] } = {}) {
  const { slug, config } = ctx;
  const trunk = config.trunk;
  const findings = [];
  const add = (ok, what, fix) => findings.push({ state: ok ? 'ok' : 'missing', what, fix });
  const unverified = (what, fix) => findings.push({ state: 'unverified', what, fix });

  // This machine: each registered repository runs the pipeline's pre-push hook for git push.
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  for (const path of [...new Set([ctx.main ?? ctx.repo, ...repos].map(real))]) {
    const hook = prePushHook(path);
    findings.push({ state: hook.state, what: `${path} runs the pipeline's pre-push hook`, fix: `${hook.why}. Run install.sh --project ${path}.` });
  }

  const repo = gh(`repos/${slug}`);
  if (repo.error) return [...findings, { state: 'missing', what: `gh could not read ${slug} (${repo.error})`, fix: 'Run gh auth status, and check the token can read the repository.' }];
  const defaultBranch = repo.value.default_branch ?? trunk;
  const list = gh(`repos/${slug}/rulesets?includes_parents=true&per_page=100`);
  if (list.error) findings.push({ state: 'missing', what: `gh could not read the rulesets (${list.error})`, fix: 'The rulesets API needs a token that can read repository administration.' });
  const reads = (list.value ?? []).map((entry) => ({ entry, read: gh(`repos/${slug}/rulesets/${entry.id}`) }));
  const unread = reads.filter(({ read }) => read.error).map(({ entry }) => entry.name ?? entry.id);
  if (unread.length) findings.push({ state: 'unverified', what: `doctor could read every ruleset (${unread.join(', ')} could not be read)`, fix: 'Use a token that can read every ruleset, then run doctor again.' });
  const rulesets = reads.map(({ read }) => read.value).filter((entry) => entry && entry.enforcement === 'active');
  const branchRules = rulesets.filter((entry) => (entry.target ?? 'branch') === 'branch');
  const rulesOf = (entries) => entries.flatMap((entry) => (entry.rules ?? []).map((rule) => ({ ...rule, ruleset: entry })));
  const onTrunk = rulesOf(branchRules.filter((entry) => covers(entry, `refs/heads/${trunk}`, defaultBranch)));
  const onEveryBranch = rulesOf(branchRules.filter((entry) => coversEvery(entry, 'heads')));
  const onEveryTag = rulesOf(rulesets.filter((entry) => entry.target === 'tag' && coversEvery(entry, 'tags')));
  const has = (rules, type) => rules.some((rule) => rule.type === type);

  add(has(onTrunk, 'pull_request'), `${trunk} requires a pull request`, `Add a branch ruleset on ${trunk} with "Require a pull request before merging".`);
  const checks = onTrunk.filter((rule) => rule.type === 'required_status_checks').flatMap((rule) => rule.parameters?.required_status_checks ?? []);
  const contexts = new Set(checks.map((check) => check.context));
  const wanted = [...PIPELINE_CONTEXTS, contexts.has('agent-review') ? 'agent-review' : 'pipeline/review'];
  const absent = wanted.filter((context) => !contexts.has(context));
  add(!absent.length, `${trunk} requires the pipeline's checks (${wanted.join(', ')})`, `Require ${absent.join(', ')} on ${trunk}, with CI's own checks.`);
  const unpinned = checks.filter((check) => !check.integration_id).map((check) => check.context);
  add(checks.length > 0 && !unpinned.length, `every required check on ${trunk} names the GitHub App that must set it`, `Set the expected source of ${unpinned.join(', ') || 'each required check'} to its GitHub App, so a status an agent sets does not count.`);
  if (checks.length) unverified(`agents cannot reach the credentials of the Apps that set ${[...contexts].join(', ')}`, 'Keep each App\'s private key and installation tokens out of every agent\'s environment.');
  add(has(onEveryBranch, 'non_fast_forward') && has(onTrunk, 'non_fast_forward'), 'no branch can be force pushed (a ruleset covers every branch, with no exclusions)', 'Add a ruleset on all branches (~ALL, nothing excluded) with "Block force pushes".');
  add(has(onEveryBranch, 'deletion') && has(onTrunk, 'deletion'), 'no branch can be deleted by an agent (a ruleset covers every branch, with no exclusions)', 'Add a ruleset on all branches (~ALL, nothing excluded) with "Restrict deletions", bypassed only by the user.');
  add(has(onEveryTag, 'creation') && has(onEveryTag, 'update') && has(onEveryTag, 'deletion'), 'tags can be created, moved or deleted only by the user (a tag ruleset covers every tag, with no exclusions)', 'Add a tag ruleset on ~ALL, nothing excluded, that restricts creations, updates and deletions, bypassed only by the user.');
  unverified('no release starts a production deploy outside a protected environment (write access can publish a release on an existing tag)', 'Run every release-triggered production deploy in the protected production environment.');
  // A ruleset doctor could not read may be one the token bypasses, so "cannot bypass" needs them all.
  const bypass = rulesets.filter((entry) => ['always', 'pull_requests_only'].includes(entry.current_user_can_bypass));
  if (bypass.length || (!list.error && !unread.length)) add(!bypass.length, 'the token in use cannot bypass any ruleset', `This token can bypass ${bypass.map((entry) => entry.name).join(', ')}. Give agents a token without bypass rights.`);
  else unverified('the token in use cannot bypass any ruleset', 'Doctor could not read every ruleset. Use a token that can, then run doctor again.');
  if (typeof repo.value.permissions?.admin === 'boolean') add(!repo.value.permissions.admin, 'the token in use is not a repository admin', 'An admin token can change the rulesets themselves. Give agents a token with write access at most.');
  else unverified('the token in use is not a repository admin', 'GitHub did not say what the token may do here. Check its permissions on the repository.');
  unverified('agents use their own credential, not the user\'s', 'Give agents their own account or token. The API cannot show whose credential a token is.');
  const prod = new RegExp(config.deploy.prodPattern, 'i');
  const environments = (gh(`repos/${slug}/environments?per_page=100`).value?.environments ?? []).filter((entry) => prod.test(entry.name));
  add(environments.length > 0, 'a production environment exists for deploy workflows', 'Run production deploys in an environment whose name matches deploy.prodPattern.');
  for (const entry of environments) {
    const rule = (entry.protection_rules ?? []).find((candidate) => candidate.type === 'required_reviewers' && (candidate.reviewers ?? []).length);
    add(Boolean(rule), `the ${entry.name} environment requires a reviewer`, `Add the user as a required reviewer on ${entry.name}.`);
    add(rule?.prevent_self_review === true, `the ${entry.name} environment prevents self-review`, `Turn on "Prevent self-review" on ${entry.name}, so the account that starts a deploy cannot approve it.`);
  }
  return findings;
}

export function cmdDoctor(opts) {
  const ctx = repoContext(opts.repo, { configPath: opts.config });
  if (!ctx.slug) fail('This repository has no GitHub remote, so there is nothing on GitHub to check.');
  let repos = [];
  try {
    repos = registeredRepos().map((entry) => entry.path).filter((path) => path && existsSync(path));
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
  }
  const findings = doctorFindings(ctx, { repos });
  const missing = findings.filter((finding) => finding.state === 'missing');
  const open = findings.filter((finding) => finding.state === 'unverified');
  const label = { ok: 'ok        ', missing: 'missing   ', unverified: 'unverified' };
  const summary = missing.length ? `${missing.length} missing. See "What GitHub must enforce" in docs/integration.md.`
    : open.length ? `Nothing missing that doctor can read. ${open.length} cannot be read from the API: confirm each by hand.` : 'All present.';
  console.log([`Settings behind the gate, for ${ctx.slug}:`, ...findings.map((finding) => `  ${label[finding.state]} ${finding.what}${finding.state === 'ok' ? '' : `. ${finding.fix}`}`), summary].join('\n'));
  if (missing.length) process.exitCode = 1;
}
