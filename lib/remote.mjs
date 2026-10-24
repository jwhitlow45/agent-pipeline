// What the gate trusts before a push, a deploy or a merge: the remote's own refs, read with one git
// ls-remote, and the config committed at the remote's trunk. Local refs, the working copy and jj or
// git config an agent could have written are checked against those, never taken on their word.

import { run as runCommand } from './util.mjs';
import { vcsAt } from './vcs.mjs';
import { gitCapable, gitEnv, pinnedReadHazard, trackingProblem } from './vcs-git.mjs';
import { bookmarkTable } from './vcs-jj.mjs';

// git reads for the gate run through the git runner's environment, against the repository's own git
// folder, which a jj lane workspace does not hold, and never follow replace refs, which would let a
// local ref swap one object for another under the same id.
const gitDirs = new Map();
const gitDirOf = (repo) => {
  if (!gitDirs.has(repo)) gitDirs.set(repo, vcsAt(repo).gitDir());
  return gitDirs.get(repo);
};
const run = (cmd, args, options = {}) => runCommand(cmd, args, cmd === 'git' ? { ...options, env: gitEnv({ gitDir: gitDirOf(options.cwd) }, { extra: options.env }) } : options);

// A reason the gate cannot trust what it would read. The gate turns it into a refusal.
export class TrustError extends Error {}
// The one trust failure that proves a repository has no pipeline to read: it has no such remote.
export class NoRemoteError extends TrustError {}
const distrust = (message) => { throw new TrustError(message); };

// jj revset functions and template keywords the gate's own reads use. An alias with one of these
// names, or a symbol shaped like a commit or change id, would change what the gate reads without
// changing the command it checks, so the gate refuses to act while one is set, in any scope.
const GATE_REVSET_FUNCTIONS = new Set(['all', 'ancestors', 'bookmarks', 'children', 'coalesce', 'descendants', 'empty', 'fork_point', 'heads', 'none', 'parents', 'present', 'remote_bookmarks', 'remote_tags', 'root', 'roots', 'tags', 'tracked_remote_bookmarks', 'visible_heads', 'working_copies']);
const GATE_TEMPLATE_NAMES = new Set(['change_id', 'commit_id', 'conflict', 'description', 'diff', 'empty', 'if', 'json', 'name', 'normal_target', 'parents', 'present', 'remote', 'self', 'signature', 'stringify', 'tracked', 'concat', 'separate', 'coalesce', 'label']);
const ID_SHAPED = /^([0-9a-f]+|[k-z]+)$/;

// jj settings that change which program jj runs or what a push does, read from the repository's own
// config, where an agent's edits land. The user's own config is theirs.
const RISKY_JJ_REPO_KEYS = /^(git\.executable-path|git\.sign-on-push|signing\.backends\..*\.program|merge-tools\.|fix\.tools\.|ui\.pager|ui\.diff-formatter|ui\.diff\.tool|ui\.diff-editor|ui\.merge-editor|ui\.editor|ui\.default-command|templates\.git_push_bookmark)/;
// jj's short command names are aliases in its default config, so a user alias can change them. The
// gate's own reads never use them, and the gate checks each one an agent types (gate-vcs.mjs).
// jj op is a built-in name of jj operation, which no alias can override (jj warns and ignores it).
export const JJ_SHORT_COMMANDS = { b: 'bookmark', ci: 'commit', desc: 'describe', st: 'status' };

// git settings in the repository's own files that run a program, rewrite where a push goes (a push
// refspec can send ci/x to trunk, forced), or pull in another config file.
// Hooks paths (husky sets one) and aliases (the gate follows none) are left alone.
const RISKY_GIT_LOCAL_KEYS = /^(core\.sshcommand|core\.fsmonitor|core\.pager|core\.askpass|core\.alternaterefscommand|core\.gitproxy|pager\.|diff\.external|diff\..*\.(command|textconv)|filter\.|merge\..*\.driver|credential\.|include\.|includeif\.|url\.|remote\..*\.(receivepack|uploadpack|vcs|proxy|mirror)|remote\..*\.push$|gpg\.|uploadpack\.|protocol\.)/;

// Every config name jj sees, with its scope. The template names `self` outright: an alias can shadow
// a bare keyword such as `source`, while an alias of `self` only makes the read fail, which refuses.
export function jjConfigNames(repo) {
  const result = run('jj', ['--ignore-working-copy', '--no-pager', 'config', 'list', '--include-overridden', '-T', 'self.source() ++ "\\t" ++ self.name() ++ "\\n"'], { cwd: repo, allowFail: true });
  if (result.status !== 0) throw new Error(`jj config list failed: ${(result.stderr || result.error?.message || '').trim().split('\n').pop()}`);
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const [source, ...rest] = line.split('\t');
    return { source, name: rest.join('\t') };
  });
}

export function gitLocalConfig(repo) {
  const result = run('git', ['config', '--list', '--show-scope', '-z'], { cwd: repo, allowFail: true });
  if (result.status !== 0) throw new Error(`git config --list failed: ${(result.stderr || '').trim()}`);
  const parts = result.stdout.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [key, ...value] = parts[i + 1].split('\n');
    entries.push({ scope: parts[i], key: key.toLowerCase(), value: value.join('\n') });
  }
  return entries;
}

const aliasName = (name) => name.replace(/^(revset|template)-aliases\./, '').replace(/^"(.*)"$/, '$1').replace(/\(.*$/, '');

// Why the gate cannot trust jj and git reads in this repository, or null. `readsOnly` checks only
// what changes a read (jj's aliases, git's capability and the settings the pinned reads cannot
// turn off), for the CLI, which reads but publishes nothing itself. `remote`, when known, is the
// remote whose branches a git repository must track in full.
export function configHazard(repo, { readsOnly = false, remote = null } = {}) {
  const vcs = vcsAt(repo);
  if (vcs.backend === 'git') {
    const problem = gitCapable(vcs.at) ?? pinnedReadHazard(vcs.at, vcs.commonDir());
    if (problem) return problem;
    if (readsOnly) return null;
    return gitLocalHazard(repo) ?? (remote ? trackingProblem(vcs.at, remote) : null);
  }
  for (const { source, name } of jjConfigNames(repo)) {
    if (source === 'default') continue;
    if (readsOnly && !/^(revset-aliases|template-aliases)\./.test(name)) continue;
    if (name.startsWith('revset-aliases.')) {
      // A function alias, name(...), can shadow a function. A symbol alias can shadow an id.
      const alias = aliasName(name);
      const isFunction = /\(/.test(name);
      if (isFunction ? GATE_REVSET_FUNCTIONS.has(alias) : ID_SHAPED.test(alias)) return `jj's ${source} config sets ${name}, which redefines a name the gate's own reads use. Remove it (jj config unset --${source} '${name.slice('revset-aliases.'.length)}') or rename it.`;
    }
    if (name.startsWith('template-aliases.') && GATE_TEMPLATE_NAMES.has(aliasName(name))) return `jj's ${source} config sets ${name}, which redefines a template keyword the gate's own reads use. Remove or rename it.`;
    if (['repo', 'workspace'].includes(source) && RISKY_JJ_REPO_KEYS.test(name)) return `jj's ${source} config sets ${name}, which can change what jj runs or where it pushes. Remove it from the repository's config.`;
  }
  // jj's normalized git ids come from the pinned git read too, which these settings change.
  const gitDir = vcs.gitDir();
  const pinned = pinnedReadHazard({ cwd: repo, gitDir }, gitDir);
  if (pinned) return pinned;
  if (readsOnly) return null;
  return gitLocalHazard(repo);
}

function gitLocalHazard(repo) {
  for (const { scope, key } of gitLocalConfig(repo)) {
    if (['local', 'worktree', 'command'].includes(scope) && RISKY_GIT_LOCAL_KEYS.test(key)) return `git's ${scope} config sets ${key}, which can run a program or change where a push goes. Remove it from the repository's config.`;
  }
  return null;
}

// The repository a URL names: owner/name for GitHub in any spelling (https, ssh, scp-like), else
// the URL itself. A fetch over https and a push over ssh reach the same repository.
export function repositoryOf(url) {
  const text = String(url).trim();
  const github = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text);
  return github ? `github:${github[1]}/${github[2]}`.toLowerCase() : text.replace(/\/+$/, '').replace(/\.git$/, '');
}

// Where a push to `remote` really goes, after every rewrite git applies (pushurl, insteadOf,
// pushInsteadOf). The gate reads the remote's refs from the fetch address, so a push address that
// reaches another repository is refused: the evidence is always about the repository the push reaches.
export function pushDestination(repo, remote) {
  const get = (args) => run('git', ['remote', 'get-url', ...args, remote], { cwd: repo, allowFail: true });
  const fetchUrl = get([]);
  if (fetchUrl.status !== 0) {
    if (/No such remote/i.test(fetchUrl.stderr ?? '')) throw new NoRemoteError(`git has no remote named ${remote} here.`);
    distrust(`git could not read the remote ${remote} here: ${(fetchUrl.stderr || fetchUrl.error?.message || '').trim().split('\n')[0]}`);
  }
  const pushUrls = get(['--push', '--all']).stdout.split('\n').filter(Boolean);
  const fetchDest = fetchUrl.stdout.trim();
  if (pushUrls.length !== 1 || repositoryOf(pushUrls[0]) !== repositoryOf(fetchDest)) distrust(`A push to ${remote} would go to ${pushUrls.join(', ') || 'nowhere'}, not to ${fetchDest}, which the gate reads. Remove the pushurl or pushInsteadOf setting that sends it elsewhere.`);
  return { fetch: fetchDest, push: pushUrls[0] };
}

// The remote's branches and tags, and its default branch, read from the remote itself.
export function lsRemote(repo, destination) {
  const result = run('git', ['ls-remote', '--symref', '--', destination, 'HEAD', 'refs/heads/*', 'refs/tags/*'], { cwd: repo, allowFail: true, timeout: 30_000 });
  if (result.status !== 0) distrust(`The gate could not read the remote's branches (${(result.stderr || result.error?.message || '').trim().split('\n').pop()}). It checks pushes and deploys against the remote itself, so it refuses while the remote cannot be read.`);
  const heads = new Map();
  const tags = new Map();
  let head = null;
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (symref) { head = symref[1]; continue; }
    const [sha, ref] = line.split('\t');
    if (ref?.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha);
    else if (ref?.startsWith('refs/tags/') && !ref.endsWith('^{}')) tags.set(ref.slice('refs/tags/'.length), sha);
  }
  return { heads, tags, head };
}

// Refuses when jj's or git's record of the remote differs from the remote itself, so a forged or
// stale remote-tracking ref never stands in for what is published.
export function checkLocalView(repo, remote, { heads }) {
  const jjRepo = vcsAt(repo).backend === 'jj';
  const fetch = jjRepo ? 'jj git fetch' : `git fetch --prune ${remote}`;
  const fetchFirst = (what) => distrust(`${what}, which differs from what ${remote} holds. Run ${jjRepo ? `jj git fetch (or git fetch ${remote})` : fetch} first, then try again.`);
  if (jjRepo) {
    const jjView = bookmarkTable(repo, remote).remote;
    for (const [name, sha] of heads) if (jjView.get(name)?.target !== sha) fetchFirst(`jj last saw ${name}@${remote} at ${jjView.get(name)?.target?.slice(0, 12) ?? 'nothing'}`);
    for (const [name, entry] of jjView) if (!heads.has(name)) fetchFirst(`jj still has ${name}@${remote} at ${entry.target?.slice(0, 12) ?? 'a conflict'}`);
  }
  const read = run('git', ['for-each-ref', '--format=%(refname:strip=3) %(objectname)', `refs/remotes/${remote}/`], { cwd: repo, allowFail: true });
  if (read.status !== 0) distrust(`git could not list its refs for ${remote} (${(read.stderr || read.error?.message || '').trim().split('\n')[0]}), so the gate cannot compare them with the remote.`);
  const tracking = new Map();
  for (const line of read.stdout.split('\n').filter(Boolean)) {
    const [name, sha] = line.split(' ');
    if (name === 'HEAD') continue;
    tracking.set(name, sha);
    if (heads.get(name) !== sha) fetchFirst(`git's refs/remotes/${remote}/${name} is at ${sha.slice(0, 12)}`);
  }
  // Without jj's view, git's tracking refs are the only record, so each branch the remote reports
  // must have one at the same commit.
  if (!jjRepo) for (const [name, sha] of heads) if (tracking.get(name) !== sha) fetchFirst(`git has no refs/remotes/${remote}/${name} at ${sha.slice(0, 12)}`);
  const missing = [...heads.values()].filter((sha) => run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, allowFail: true }).status !== 0);
  if (missing.length) distrust(`This repository does not have ${missing[0].slice(0, 12)}, which ${remote} holds. Run ${fetch} first, then try again.`);
}

// pipeline.config.json as committed at the remote's trunk commit, or null when that commit has none.
export function committedAt(repo, sha, file) {
  if (run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, allowFail: true }).status !== 0) distrust(`This repository does not have ${sha.slice(0, 12)}, the remote's trunk. Run ${vcsAt(repo).backend === 'jj' ? 'jj git fetch' : 'git fetch --prune origin'} first, then try again.`);
  const result = run('git', ['show', `${sha}:${file}`], { cwd: repo, allowFail: true });
  if (result.status !== 0) {
    if (new RegExp(`path '${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' (does not exist|exists on disk, but not) in`).test(result.stderr ?? '')) return null;
    throw new Error(`git show ${sha.slice(0, 12)}:${file} failed: ${(result.stderr || '').trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return distrust(`${file} at the remote's trunk (${sha.slice(0, 12)}) is not valid JSON: ${error.message}`);
  }
}
