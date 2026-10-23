// pipeline doctor: which of the GitHub settings that back the gate are missing. The gate stops the
// forms an agent would plausibly write, but only GitHub can make "never" hold against a script, so
// docs/integration.md lists what it must enforce. This reads those settings with gh api and
// changes nothing.

import { repoContext } from './context.mjs';
import { fail, ghCommand, globToRegExp, run } from './util.mjs';

const gh = (path) => {
  const result = run(ghCommand(), ['api', path], { allowFail: true, timeout: 30_000 });
  if (result.status !== 0) return { error: (result.stderr || result.error?.message || '').trim().split('\n')[0] || `exit ${result.status}` };
  try {
    return { value: JSON.parse(result.stdout || 'null') };
  } catch {
    return { error: `gh api ${path} did not answer JSON` };
  }
};

// Whether a ruleset's ref conditions cover a ref.
function covers(ruleset, ref, defaultBranch) {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  const matches = (pattern) => pattern === '~ALL' || (pattern === '~DEFAULT_BRANCH' && ref === `refs/heads/${defaultBranch}`) || (pattern.includes('/') && globToRegExp(pattern).test(ref));
  return include.some(matches) && !exclude.some(matches);
}

export function doctorFindings(ctx) {
  const { slug, config } = ctx;
  const trunk = config.trunk;
  const findings = [];
  const add = (ok, what, fix) => findings.push({ ok, what, fix });
  const repo = gh(`repos/${slug}`);
  if (repo.error) return [{ ok: false, what: `gh could not read ${slug} (${repo.error})`, fix: 'Run gh auth status, and check the token can read the repository.' }];
  const defaultBranch = repo.value.default_branch ?? trunk;
  const list = gh(`repos/${slug}/rulesets?includes_parents=true&per_page=100`);
  const rulesets = (list.value ?? []).map((entry) => gh(`repos/${slug}/rulesets/${entry.id}`).value).filter((entry) => entry && entry.enforcement === 'active');
  const branchRules = rulesets.filter((entry) => (entry.target ?? 'branch') === 'branch');
  const rulesFor = (ref) => branchRules.filter((entry) => covers(entry, ref, defaultBranch)).flatMap((entry) => (entry.rules ?? []).map((rule) => ({ ...rule, ruleset: entry })));
  const onTrunk = rulesFor(`refs/heads/${trunk}`);
  const has = (rules, type) => rules.some((rule) => rule.type === type);
  add(has(onTrunk, 'pull_request'), `${trunk} requires a pull request`, `Add a branch ruleset on ${trunk} with "Require a pull request before merging".`);
  const checks = onTrunk.filter((rule) => rule.type === 'required_status_checks').flatMap((rule) => rule.parameters?.required_status_checks ?? []);
  add(checks.length > 0, `${trunk} requires status checks`, `Require the pipeline/* and CI checks on ${trunk}.`);
  add(checks.length > 0 && checks.every((check) => check.integration_id), `every required check on ${trunk} must come from one app (an identity agents cannot use)`, 'Pick the expected source app for each required check, so a status an agent sets does not count.');
  const anyBranch = rulesFor('refs/heads/any-branch-name');
  add(has(anyBranch, 'non_fast_forward') && has(onTrunk, 'non_fast_forward'), 'no branch can be force pushed', 'Add a ruleset on all branches (~ALL) with "Block force pushes".');
  add(has(anyBranch, 'deletion') && has(onTrunk, 'deletion'), 'no branch can be deleted by an agent', 'Add a ruleset on all branches (~ALL) with "Restrict deletions", bypassed only by the user.');
  const tagRules = rulesets.filter((entry) => entry.target === 'tag' && covers(entry, 'refs/tags/v1', defaultBranch)).flatMap((entry) => entry.rules ?? []);
  add(has(tagRules, 'creation') && has(tagRules, 'update') && has(tagRules, 'deletion'), 'tags (and so releases) can be created, moved or deleted only by the user', 'Add a tag ruleset on ~ALL that restricts creations, updates and deletions, bypassed only by the user.');
  const bypass = rulesets.filter((entry) => ['always', 'pull_requests_only'].includes(entry.current_user_can_bypass));
  add(!bypass.length, 'the token in use cannot bypass any ruleset', `This token can bypass ${bypass.map((entry) => entry.name).join(', ')}. Give agents a token without bypass rights.`);
  add(!repo.value.permissions?.admin, 'the token in use is not a repository admin', 'An admin token can change the rulesets themselves. Give agents a token with write access at most.');
  const prod = new RegExp(config.deploy.prodPattern, 'i');
  const environments = (gh(`repos/${slug}/environments?per_page=100`).value?.environments ?? []).filter((entry) => prod.test(entry.name));
  add(environments.length > 0, 'a production environment exists for deploy workflows', 'Run production deploys in an environment whose name matches deploy.prodPattern.');
  for (const entry of environments) {
    const reviewers = (entry.protection_rules ?? []).some((rule) => rule.type === 'required_reviewers' && (rule.reviewers ?? []).length);
    add(reviewers, `the ${entry.name} environment requires a reviewer`, `Add the user as a required reviewer on ${entry.name}, with self-review prevented for agent accounts.`);
  }
  if (list.error) findings.unshift({ ok: false, what: `gh could not read the rulesets (${list.error})`, fix: 'The rulesets API needs a token that can read repository administration.' });
  return findings;
}

export function cmdDoctor(opts) {
  const ctx = repoContext(opts.repo, { configPath: opts.config });
  if (!ctx.slug) fail('This repository has no GitHub remote, so there is nothing on GitHub to check.');
  const findings = doctorFindings(ctx);
  const missing = findings.filter((finding) => !finding.ok);
  console.log([`GitHub settings behind the gate, for ${ctx.slug}:`, ...findings.map((finding) => `  ${finding.ok ? 'ok     ' : 'missing'} ${finding.what}${finding.ok ? '' : `. ${finding.fix}`}`),
    missing.length ? `${missing.length} missing. See "What GitHub must enforce" in docs/integration.md.` : 'All present.'].join('\n'));
  if (missing.length) process.exitCode = 1;
}
