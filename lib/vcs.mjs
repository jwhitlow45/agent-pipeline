// jj and git reads. Every read passes --ignore-working-copy, so it never snapshots, which fails while
// a signing key is locked and would race a builder editing files in the same workspace.

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

export function commitIds(repo, revset) {
  const result = run('jj', [...JJ_FLAGS, 'log', '--no-graph', '-r', revset, '-T', 'commit_id ++ "\\n"'], { cwd: repo, allowFail: true });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
}

export function resolveTip(repo, rev) {
  const ids = commitIds(repo, rev ?? 'coalesce(@ ~ empty(), @-)');
  if (ids.length !== 1) fail(`--tip ${rev ?? '(default)'} must resolve to exactly one commit, found ${ids.length}.`);
  return ids[0];
}

// The remote trunk, where every range starts. The local trunk bookmark is never used: an agent can
// move it without pushing, which would empty the ranges the gate checks. A repository whose trunk was
// never pushed falls back to the root commit, so its ranges hold every commit.
export const trunkRev = (config) => `coalesce(remote_bookmarks(exact:${JSON.stringify(config.trunk)}, exact:${JSON.stringify(config.remote)}), root())`;

export const isAncestor = (repo, ancestor, descendant) => commitIds(repo, `${ancestor} & ::${descendant}`).length === 1;

// Commits a GitHub status can be set on: those reachable from a bookmark on the remote.
export const isOnRemote = (repo, id, remote = 'origin') => commitIds(repo, `${id} & ::remote_bookmarks(remote=exact:${JSON.stringify(remote)})`).length === 1;

export const remoteBookmarkTarget = (repo, name, remote = 'origin') => commitIds(repo, `remote_bookmarks(exact:${JSON.stringify(name)}, exact:${JSON.stringify(remote)})`)[0] ?? null;

export const localBookmarkTarget = (repo, name) => commitIds(repo, `bookmarks(exact:${JSON.stringify(name)})`)[0] ?? null;

// Separators that never occur in a commit message or a path.
const FIELD = '\x1f';
const RECORD = '\x1e';
const FILE = '\x1c';
const PART = '\x1d';

const COMMIT_TEMPLATE = [
  'commit_id', 'change_id.short(8)', 'if(signature, signature.status(), "none")', 'if(empty, "1", "0")', 'parents.len()', 'description',
  `diff.files().map(|f| f.source().path() ++ "${PART}" ++ f.path() ++ "${PART}" ++ f.status()).join("${FILE}")`,
].join(` ++ "${FIELD}" ++ `) + ` ++ "${RECORD}"`;

// Commits oldest first, with what the stages check: patch-id, signature, message and files. A commit
// whose diff is empty (an empty commit, or a merge without a conflict resolution) has no patch-id.
export function listCommits(repo, revset) {
  const raw = jj(repo, ['log', '--no-graph', '--reversed', '-r', revset, '-T', COMMIT_TEMPLATE]);
  const commits = raw.split(RECORD).filter((record) => record.trim()).map((record) => {
    const [id, changeId, signature, empty, parents, description, files] = record.replace(/^\n/, '').split(FIELD);
    return {
      id, changeId, signature, empty: empty === '1', parents: Number(parents), description: description.replace(/\n+$/, ''),
      files: (files ?? '').split(FILE).filter(Boolean).map((file) => {
        const [source, path, status] = file.split(PART);
        return { source, path, status };
      }),
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

export const diffRange = (repo, from, to) => jj(repo, ['diff', '--git', '--from', from, '--to', to]);

export const gitDir = (repo) => jj(repo, ['git', 'root']).trim();

export function githubRepo(repo, remote = 'origin') {
  const remotes = run('jj', ['--ignore-working-copy', 'git', 'remote', 'list'], { cwd: repo, allowFail: true }).stdout ?? '';
  const line = remotes.split('\n').find((entry) => entry.startsWith(`${remote} `));
  return line?.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?$/)?.[1] ?? null;
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

export function remoteBookmarks(repo, remote = 'origin') {
  const out = jj(repo, ['bookmark', 'list', '--all-remotes', '-T', `if(remote == ${JSON.stringify(remote)}, name ++ "${FIELD}" ++ if(normal_target, normal_target.commit_id(), "") ++ "\\n", "")`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, target] = line.split(FIELD);
    return { name, target: target || null };
  });
}

export const describeCommit = (commit) => `${short(commit.id)} ${firstLine(commit.description)}`;
