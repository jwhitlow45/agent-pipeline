// jj and git reads. Every read passes --ignore-working-copy, so it never snapshots, which fails while
// a signing key is locked and would race a builder editing files in the same workspace.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, run, short } from './util.mjs';

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

// Exactly one commit for a revision someone typed, or a usage error that says what went wrong.
export function resolveOne(repo, rev, what = rev) {
  let ids;
  try {
    ids = commitIds(repo, rev);
  } catch (error) {
    if (error instanceof RevsetError) fail(`${what} is not a revision here: ${error.message}`);
    throw error;
  }
  if (ids.length !== 1) fail(`${what} must resolve to exactly one commit, found ${ids.length}.`);
  return ids[0];
}

export const resolveTip = (repo, rev) => resolveOne(repo, rev ?? 'coalesce(@ ~ empty(), @-)', `--tip ${rev ?? '(default)'}`);

// The remote trunk, where every range starts. The local trunk bookmark is never used: an agent can
// move it without pushing, which would empty the ranges the gate checks. The context sets
// `trunkSha`: for the gate, the commit the remote itself reports, so a forged remote-tracking ref
// cannot move it either. A repository whose trunk was never pushed starts at the root commit, so its
// ranges hold every commit.
export const trunkRev = (config) => (config.trunkSha !== undefined ? config.trunkSha ?? 'root()' : `coalesce(remote_bookmarks(exact:${JSON.stringify(config.trunk)}, exact:${JSON.stringify(config.remote)}), root())`);

export const isAncestor = (repo, ancestor, descendant) => commitIds(repo, `${ancestor} & ::${descendant}`).length === 1;

// Commits a GitHub status can be set on: those reachable from a bookmark on the remote.
export const isOnRemote = (repo, id, remote = 'origin') => commitIds(repo, `${id} & ::remote_bookmarks(remote=exact:${JSON.stringify(remote)})`).length === 1;

export const remoteBookmarkTarget = (repo, name, remote = 'origin') => commitIds(repo, `remote_bookmarks(exact:${JSON.stringify(name)}, exact:${JSON.stringify(remote)})`)[0] ?? null;

export const localBookmarkTarget = (repo, name) => commitIds(repo, `bookmarks(exact:${JSON.stringify(name)})`)[0] ?? null;

const json = (expression) => `stringify(${expression}).escape_json()`;
// One JSON object per commit, one per line: jj escapes every string, so no byte in a message or a
// path can end a field or a record early.
const COMMIT_TEMPLATE = `"{" ++ ${[
  ['id', json('commit_id')], ['changeId', json('change_id.short(8)')], ['signature', json('if(signature, signature.status(), "none")')],
  ['empty', 'if(empty, "true", "false")'], ['parents', 'parents.len()'], ['description', json('description')],
  ['files', `"[" ++ diff.files().map(|f| "[" ++ ${json('f.source().path()')} ++ "," ++ ${json('f.path()')} ++ "," ++ ${json('f.status()')} ++ "]").join(",") ++ "]"`],
].map(([key, value]) => `"\\"${key}\\":" ++ ${value}`).join(' ++ "," ++ ')} ++ "}\\n"`;

// Commits oldest first, with what the stages check: patch-id, signature, message and files. A commit
// whose diff is empty (an empty commit, or a merge without a conflict resolution) has no patch-id.
export function listCommits(repo, revset) {
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

export const firstLine = (description) => description.split('\n')[0] || '(no description)';

// Every path a commit touches, both sides of a rename included.
export const touchedPaths = (commit) => [...new Set(commit.files.flatMap((file) => [file.source, file.path]))];

function patchIds(repo, revset) {
  const patches = jj(repo, ['log', '--no-graph', '-r', revset, '-T', '"commit " ++ commit_id ++ "\\n"', '-p', '--git']);
  // --verbatim keeps whitespace in the hash, since indentation can change behavior. Line numbers are still ignored.
  return new Map(run('git', ['patch-id', '--verbatim'], { input: patches }).stdout.split('\n').filter(Boolean).map((line) => line.split(' ').reverse()));
}

// Each commit's own diff, by commit id. jj shows a merge's diff against its auto-merged parents,
// which is its conflict resolution. Each diff starts after a header line with a marker made for this
// read, which no file or message can hold, so no content ends a diff early.
export function commitPatches(repo, revset) {
  const marker = `pipeline-commit-${randomUUID()}`;
  const out = jj(repo, ['log', '--no-graph', '-r', revset, '-T', `"${marker} " ++ commit_id ++ "\\n"`, '-p', '--git']);
  const patches = new Map();
  const header = new RegExp(`^${marker} ([0-9a-f]{40})$`, 'gm');
  const starts = [...out.matchAll(header)];
  starts.forEach((match, i) => patches.set(match[1], out.slice(match.index + match[0].length + 1, starts[i + 1]?.index ?? out.length)));
  return patches;
}

export const gitDir = (repo) => jj(repo, ['git', 'root']).trim();

// A git setting, or '' when it is unset (git config exits 1). Any other failure throws, so a
// setting git cannot read is never taken for one that is not set.
export function gitSetting(dir, args, { gitDir: directory } = {}) {
  const read = run('git', ['config', ...args], { cwd: dir, allowFail: true, env: directory ? { GIT_DIR: directory } : undefined });
  if (read.status === 1 && !read.error) return '';
  if (read.status !== 0 || read.error) throw new Error(`git could not read ${args.at(-1)}: ${(read.stderr || read.error?.message || '').trim().split('\n')[0]}`);
  return read.stdout.trim();
}

// A file as committed at a commit: its text, or null only when that commit's tree proves it has no
// entry at that path. A missing commit, an entry that is not a plain file (a link, a submodule) or
// contents that cannot be read throw FileReadError: the file is then unknown, not absent.
export class FileReadError extends Error {}
export function committedFile(repo, sha, path) {
  const env = { GIT_DIR: gitDir(repo), GIT_NO_REPLACE_OBJECTS: '1' };
  const git = (args) => run('git', args, { cwd: repo, allowFail: true, env });
  const firstLine = (result) => (result.stderr || result.error?.message || '').trim().split('\n')[0];
  if (git(['cat-file', '-e', `${sha}^{commit}`]).status !== 0) throw new FileReadError('this repository does not have that commit');
  const tree = git(['ls-tree', '-z', '--full-tree', sha, '--', path]);
  if (tree.status !== 0) throw new FileReadError(`git ls-tree failed (${firstLine(tree)})`);
  const entry = tree.stdout.split('\0').filter(Boolean).find((line) => line.split('\t')[1] === path);
  if (!entry) return null;
  const [mode, type, object] = entry.split('\t')[0].split(' ');
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new FileReadError(`it is a ${type} (mode ${mode}), not a plain file`);
  const blob = git(['cat-file', 'blob', object]);
  if (blob.status !== 0) throw new FileReadError(`its contents cannot be read (${firstLine(blob)})`);
  return blob.stdout;
}

// The git repository a folder is in, read with git itself: its git directory and its working tree
// (null for a bare one). Null only when git finds no repository there.
export function gitRepository(dir) {
  if (!dir || !existsSync(dir)) return null;
  const found = run('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, allowFail: true });
  if (found.status !== 0) {
    if (/not a git repository/i.test(found.stderr ?? '')) return null;
    throw new Error(`git could not tell whether ${dir} is a repository: ${(found.stderr || found.error?.message || '').trim().split('\n')[0]}`);
  }
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true });
  return { gitDir: found.stdout.trim(), top: top.status === 0 ? top.stdout.trim() : null };
}

// The GitHub repository a remote is configured as, read from its URL as written, before any
// insteadOf rewrite: jj lists remotes after the rewrite.
export function githubRepo(repo, remote = 'origin') {
  let dir;
  try {
    dir = gitDir(repo);
  } catch {
    return null;
  }
  // A remote that is not set has no URL. One git cannot read would file the repository under another identity.
  const url = gitSetting(repo, ['--get', `remote.${remote}.url`], { gitDir: dir });
  return url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?\/?$/)?.[1] ?? null;
}

// Runs belong to one repository: its GitHub repository, else its jj store, which every workspace of it shares.
export function repoIdentity(repo) {
  const slug = githubRepo(repo);
  if (slug) return `github:${slug.toLowerCase()}`;
  const pointer = join(repo, '.jj', 'repo');
  const store = statSync(pointer).isFile() ? resolve(join(repo, '.jj'), readFileSync(pointer, 'utf8').trim()) : pointer;
  return `store:${realpathSync(store)}`;
}

export function workspaces(repo) {
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

export function remoteBookmarks(repo, remote = 'origin') {
  const out = jj(repo, ['bookmark', 'list', '--all-remotes', '-T', `if(remote == ${JSON.stringify(remote)}, "[" ++ ${json('name')} ++ "," ++ ${json('if(normal_target, normal_target.commit_id(), "")')} ++ "]\\n", "")`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, target] = JSON.parse(line);
    return { name, target: target || null };
  });
}

export const describeCommit = (commit) => `${short(commit.id)} ${firstLine(commit.description)}`;
