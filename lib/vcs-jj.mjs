// The jj backend. Every read passes --ignore-working-copy, so it never snapshots, which fails while
// a signing key is locked and would race a builder editing files in the same workspace. The one
// exception is workingCopy, which snapshots on purpose: it asks what the files on disk hold.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, run } from './util.mjs';
import { COMMANDS, committedFileIn, githubSlugOf, gitSetting } from './vcs-git.mjs';
import { detect } from './vcs-detect.mjs';

const JJ_FLAGS = ['--ignore-working-copy', '--no-pager', '--color', 'never'];

export const jj = (repo, args, options) => run('jj', [...JJ_FLAGS, ...args], { cwd: repo, ...options }).stdout;

// Null only when the directory is outside every jj repository. Any other jj failure throws, so it is never mistaken for that.
export function jjRoot(dir) {
  if (!dir || !existsSync(dir)) return null;
  const result = run('jj', ['--ignore-working-copy', 'workspace', 'root'], { cwd: dir, allowFail: true });
  if (result.status === 0) return result.stdout.trim();
  if (/There is no jj repo in/.test(result.stderr ?? '')) return null;
  throw new Error(`jj workspace root failed in ${dir}: ${(result.stderr || result.error?.message || '').trim()}`);
}

// A failed query throws: an empty list always means the revset matched nothing, never that jj failed.
export function commitIds(repo, revset) {
  const result = run('jj', [...JJ_FLAGS, 'log', '--no-graph', '-r', revset, '-T', 'commit_id ++ "\\n"'], { cwd: repo, allowFail: true });
  if (result.status !== 0 || result.error) throw new RevsetError(revset, (result.stderr || result.error?.message || '').trim());
  return result.stdout.split('\n').filter(Boolean);
}

export class RevsetError extends Error {
  constructor(revset, detail) {
    super(`jj could not read ${revset}: ${detail.split('\n')[0]}`);
    this.revset = revset;
  }
}

// A range as a revset: every ancestor of the tips that is no ancestor of anything in `not`. With
// `not` empty it still leaves out jj's root commit, which holds nothing and has no git object.
const union = (ids) => ids.join(' | ');
export const revsetOf = ({ tips, not }) => (tips.length ? `::(${union(tips)}) ~ ${not.length ? `::(${union(not)})` : 'root()'}` : 'none()');

const json = (expression) => `stringify(${expression}).escape_json()`;
// One JSON object per commit, one per line: jj escapes every string, so no byte in a message or a
// path can end a field or a record early.
const COMMIT_TEMPLATE = `"{" ++ ${[
  ['id', json('commit_id')], ['changeId', json('change_id.short(8)')], ['signature', json('if(signature, signature.status(), "none")')],
  ['empty', 'if(empty, "true", "false")'], ['parents', 'parents.filter(|c| !c.root()).len()'], ['description', json('description')],
  ['files', `"[" ++ diff.files().map(|f| "[" ++ ${json('f.source().path()')} ++ "," ++ ${json('f.path()')} ++ "," ++ ${json('f.status()')} ++ "]").join(",") ++ "]"`],
].map(([key, value]) => `"\\"${key}\\":" ++ ${value}`).join(' ++ "," ++ ')} ++ "}\\n"`;

// Commits oldest first, with what the stages check: patch-id, signature, message and files. A commit
// whose diff is empty (an empty commit, or a merge without a conflict resolution) has no patch-id.
function listCommits(repo, revset) {
  const raw = jj(repo, ['log', '--no-graph', '--reversed', '-r', revset, '-T', COMMIT_TEMPLATE]);
  const commits = raw.split('\n').filter(Boolean).map((line) => {
    const record = JSON.parse(line);
    return {
      ...record, description: record.description.replace(/\n+$/, ''),
      files: record.files.map(([source, path, status]) => ({ source, path, status })),
    };
  });
  const ids = patchIds(repo, revset);
  return commits.map((commit) => ({ ...commit, patchId: ids.get(commit.id) ?? null }));
}

function patchIds(repo, revset) {
  const patches = jj(repo, ['log', '--no-graph', '-r', revset, '-T', '"commit " ++ commit_id ++ "\\n"', '-p', '--git']);
  // --verbatim keeps whitespace in the hash, since indentation can change behavior. Line numbers are still ignored.
  return new Map(run('git', ['patch-id', '--verbatim'], { input: patches }).stdout.split('\n').filter(Boolean).map((line) => line.split(' ').reverse()));
}

// Each commit's own diff, by commit id. jj shows a merge's diff against its auto-merged parents,
// which is its conflict resolution. Each diff starts after a header line with a marker made for this
// read, which no file or message can hold, so no content ends a diff early.
function commitPatches(repo, revset) {
  const marker = `pipeline-commit-${randomUUID()}`;
  const out = jj(repo, ['log', '--no-graph', '-r', revset, '-T', `"${marker} " ++ commit_id ++ "\\n"`, '-p', '--git']);
  const patches = new Map();
  const header = new RegExp(`^${marker} ([0-9a-f]{40})$`, 'gm');
  const starts = [...out.matchAll(header)];
  starts.forEach((match, i) => patches.set(match[1], out.slice(match.index + match[0].length + 1, starts[i + 1]?.index ?? out.length)));
  return patches;
}

export const gitDir = (repo) => jj(repo, ['git', 'root']).trim();

// The GitHub repository a remote is configured as, read from its URL as written, before any
// insteadOf rewrite: jj lists remotes after the rewrite.
function githubRepo(repo, remote = 'origin') {
  let dir;
  try {
    dir = gitDir(repo);
  } catch {
    return null;
  }
  // A remote that is not set has no URL. One git cannot read would file the repository under another identity.
  return githubSlugOf(gitSetting(repo, ['--get', `remote.${remote}.url`], { gitDir: dir }));
}

// Runs belong to one repository: its GitHub repository, else its jj store, which every workspace of it shares.
function repoIdentity(repo) {
  const slug = githubRepo(repo);
  if (slug) return `github:${slug.toLowerCase()}`;
  const pointer = join(repo, '.jj', 'repo');
  const store = statSync(pointer).isFile() ? resolve(join(repo, '.jj'), readFileSync(pointer, 'utf8').trim()) : pointer;
  return `store:${realpathSync(store)}`;
}

function workspaces(repo) {
  return jj(repo, ['workspace', 'list', '-T', 'name ++ "\\n"']).split('\n').filter(Boolean);
}

// Every bookmark, local and on `remote`, in one read: what a jj push of --all, --tracked or --deleted
// would touch. A local bookmark jj marks deleted has no local entry and a tracked remote one.
export function bookmarkTable(repo, remote) {
  const template = `"[" ++ ${json('name')} ++ "," ++ ${json('if(remote, remote, "")')} ++ "," ++ present ++ "," ++ tracked ++ "," ++ conflict ++ "," ++ ${json('if(normal_target, normal_target.commit_id(), "")')} ++ "]\\n"`;
  const local = new Map();
  const onRemote = new Map();
  for (const line of jj(repo, ['bookmark', 'list', '--all-remotes', '-T', template]).split('\n').filter(Boolean)) {
    const [name, where, present, tracked, conflict, target] = JSON.parse(line);
    if (where === '' && present) local.set(name, { target: target || null, conflict });
    else if (where === remote && present) onRemote.set(name, { target: target || null, tracked });
  }
  return { local, remote: onRemote };
}

// Tags, local and on `remote`, with their targets. Agents push no tags, so the gate only needs to
// know whether a push would carry one.
export function tagTable(repo, remote) {
  const local = new Map();
  const onRemote = new Map();
  const template = `"[" ++ ${json('name')} ++ "," ++ ${json('if(remote, remote, "")')} ++ "," ++ present ++ "," ++ tracked ++ "," ++ ${json('if(normal_target, normal_target.commit_id(), "")')} ++ "]\\n"`;
  for (const line of jj(repo, ['tag', 'list', '--all-remotes', '-T', template]).split('\n').filter(Boolean)) {
    const [name, where, present, tracked, target] = JSON.parse(line);
    if (where === '' && present) local.set(name, target || null);
    else if (where === remote && present) onRemote.set(name, { target: target || null, tracked });
  }
  return { local, remote: onRemote };
}

// A jj config value as jj prints it, or null when it is not set.
export function jjConfigValue(repo, key) {
  const result = run('jj', ['--ignore-working-copy', '--no-pager', 'config', 'get', key], { cwd: repo, allowFail: true });
  if (result.status === 0) return result.stdout.replace(/\n$/, '');
  if (/Value not found/.test(result.stderr ?? '')) return null;
  throw new Error(`jj config get ${key} failed: ${(result.stderr || result.error?.message || '').trim()}`);
}

export function remoteNames(repo) {
  return jj(repo, ['git', 'remote', 'list']).split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
}

// The commits a jj command would rewrite when it snapshots the working copy first: each workspace's
// working-copy commit and everything on top of it. A push or deploy of one of these could carry
// edits the gate never saw.
export const inWorkingCopies = (repo, ids) => (ids.length ? commitIds(repo, `(${ids.join(' | ')}) & working_copies()::`) : []);

function remoteBookmarks(repo, remote = 'origin') {
  const out = jj(repo, ['bookmark', 'list', '--all-remotes', '-T', `if(remote == ${JSON.stringify(remote)}, "[" ++ ${json('name')} ++ "," ++ ${json('if(normal_target, normal_target.commit_id(), "")')} ++ "]\\n", "")`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, target] = JSON.parse(line);
    return { name, target: target || null };
  });
}

// The working copy as a check sees it: the commit that holds the files on disk (jj snapshots them
// into @), whether @ holds edits, and the commits an empty @ sits on.
function workingCopy(workspace) {
  const result = run('jj', ['--no-pager', '--color', 'never', 'log', '--no-graph', '-r', '@', '-T', 'commit_id ++ " " ++ if(empty, "empty", "changed") ++ " " ++ parents.map(|c| c.commit_id()).join(",")'], { cwd: workspace, allowFail: true });
  if (result.status !== 0) fail(`jj could not read ${workspace}: ${result.stderr.trim()}`);
  const [at, state, parents] = result.stdout.trim().split(' ');
  return { at, dirty: state !== 'empty', sitsOn: state === 'empty' ? parents.split(',') : [] };
}

// The operations of section 3 of the design, bound to one folder. Ranges are { tips, not } values
// of commit ids, never revset text, so no caller builds a revset.
export function jjVcs(dir) {
  const ids = (revset) => commitIds(dir, revset);
  const name = (text) => JSON.stringify(text);
  let gitDirectory;
  const found = detect(dir);
  return {
    backend: 'jj',
    dir,
    store: found.store,
    configDir: () => found.configDir,
    main: () => found.main,
    defaultTip: 'coalesce(@ ~ empty(), @-)',
    revisions: (rev) => ids(rev),
    exists: (id) => ids(`present(${id})`).length === 1,
    isAncestor: (ancestor, descendant) => Boolean(ancestor && descendant) && ids(`${ancestor} & ::${descendant}`).length === 1,
    // Every fork point, as jj gives them: criss-cross history has more than one. A missing second
    // commit (a trunk never pushed) forks at jj's root, as a range from no trunk starts there.
    forkPoint: (a, b) => ids(`fork_point(${a} | ${b ?? 'root()'})`),
    commitIds: (range) => ids(revsetOf(range)),
    listCommits: (range) => listCommits(dir, revsetOf(range)),
    readCommits: (list) => (list.length ? listCommits(dir, union(list)) : []),
    commitPatches: (range) => commitPatches(dir, revsetOf(range)),
    filesAt: (id) => jj(dir, ['file', 'list', '-r', id]).split('\n').filter(Boolean),
    workingCopy: () => workingCopy(dir),
    inWorkingCopies: (list) => inWorkingCopies(dir, list),
    isVisible: (id) => ids(`${id} & ::visible_heads()`).length === 1,
    localBranch: (branch) => ids(`bookmarks(exact:${name(branch)})`)[0] ?? null,
    remoteBranch: (branch, remote = 'origin') => ids(`remote_bookmarks(exact:${name(branch)}, exact:${name(remote)})`)[0] ?? null,
    remoteBranches: (remote = 'origin') => remoteBookmarks(dir, remote),
    // Every commit a branch of the remote points at, each side of a conflicted one included.
    remoteBranchIds: (remote = 'origin') => ids(`remote_bookmarks(remote=exact:${name(remote)})`),
    isOnRemote: (id, remote = 'origin') => ids(`${id} & ::remote_bookmarks(remote=exact:${name(remote)})`).length === 1,
    remoteNames: () => remoteNames(dir),
    workspaces: () => workspaces(dir),
    gitDir: () => (gitDirectory ??= gitDir(dir)),
    // jj keeps one git folder for every workspace.
    commonDir: () => (gitDirectory ??= gitDir(dir)),
    slug: (remote = 'origin') => githubRepo(dir, remote),
    identity: () => repoIdentity(dir),
    committedFile: (sha, path) => committedFileIn(gitDir(dir), dir, sha, path),
    commands: COMMANDS.jj,
  };
}
