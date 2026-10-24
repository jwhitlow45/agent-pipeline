// The git backend, and the git reads every backend shares. Every git read the pipeline makes goes
// through one runner with an environment it controls, and every read that gives diff text, ids or
// file lists is pinned, so it gives the same bytes for the same commit in every clone and under
// every config, and never shows less than the commit holds.

import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './util.mjs';
import { detect } from './vcs-detect.mjs';

// The runner

// The user's transport settings, which the user's own push uses too: without them a required CA or
// proxy disappears and every ls-remote fails. A later git variable is added here by name, never by
// prefix. Every other GIT_ variable is cleared, since it can change what a read sees.
export const KEPT_GIT_VARIABLES = [
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND',
  'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_SSL_CERT', 'GIT_SSL_CERT_TYPE', 'GIT_SSL_CERT_PASSWORD_PROTECTED', 'GIT_SSL_KEY', 'GIT_SSL_KEY_TYPE', 'GIT_SSL_NO_VERIFY', 'GIT_SSL_VERSION', 'GIT_SSL_CIPHER_LIST',
  'GIT_PROXY_SSL_CERT', 'GIT_PROXY_SSL_KEY', 'GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED', 'GIT_PROXY_SSL_CAINFO',
  'GIT_HTTP_PROXY_AUTHMETHOD', 'GIT_HTTP_USER_AGENT', 'GIT_HTTP_LOW_SPEED_LIMIT', 'GIT_HTTP_LOW_SPEED_TIME', 'GIT_HTTP_MAX_REQUESTS', 'GIT_HTTP_MAX_RETRIES', 'GIT_HTTP_MAX_RETRY_TIME', 'GIT_HTTP_RETRY_AFTER',
  'GIT_HTTP_KEEPALIVE_IDLE', 'GIT_HTTP_KEEPALIVE_INTERVAL', 'GIT_HTTP_KEEPALIVE_COUNT', 'GIT_CURL_FTP_NO_EPSV',
];

// The empty tree, which git knows without storing it. As the attribute source it overrides every
// .gitattributes in the worktree, so no attribute turns a file's diff off or filters it.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Settings that change the bytes of a diff, a merge's remerge diff or a patch id, pinned. A later -c
// overrides the same key from any config file. --remerge-diff runs its own merge, which reads merge
// options from config and ignores the diff flags, so the merge settings are pinned too.
const PINS = [
  'diff.suppressBlankEmpty=false', 'diff.indentHeuristic=true', 'core.bigFileThreshold=64g', 'core.quotePath=false', 'merge.conflictStyle=merge',
  'merge.renames=true', 'merge.directoryRenames=conflict', 'merge.renormalize=false', 'log.showSignature=false', 'color.ui=false',
  'core.attributesFile=/dev/null', 'diff.algorithm=myers', 'diff.renameLimit=1000', 'merge.renameLimit=1000', 'merge.default=text',
].flatMap((pin) => ['-c', pin]);
const DIFF_FLAGS = ['-r', '--root', '-M', '-l1000', '--remerge-diff', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-algorithm=myers', '-U3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--submodule=short', '--ignore-submodules=none'];

// What a read is: the folder it runs in, the git folder, and the worktree, when it has one.
export const where = (cwd, gitDir, workTree = null) => ({ cwd, gitDir, workTree });

export function gitEnv(at, { pinned = false, extra = {} } = {}) {
  const env = {};
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_') && !KEPT_GIT_VARIABLES.includes(name)) env[name] = undefined;
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  if (at.gitDir) env.GIT_DIR = at.gitDir;
  if (at.workTree) env.GIT_WORK_TREE = at.workTree;
  if (pinned) Object.assign(env, { GIT_ATTR_SOURCE: EMPTY_TREE, GIT_ATTR_NOSYSTEM: '1' });
  return { ...env, ...extra };
}

const detail = (result) => String(result.stderr ?? '').trim().split('\n')[0] || result.error?.message || `exit ${result.status}`;

// One git read. `codes` lists the exit codes that are answers; any other result throws, so an empty
// answer always means empty.
export function git(at, args, { pinned = false, input, codes = [0], buffer = false, extra, timeout } = {}) {
  const result = run('git', [...(pinned ? PINS : []), ...args], { cwd: at.cwd, input, env: gitEnv(at, { pinned, extra }), allowFail: true, encoding: buffer ? 'buffer' : 'utf8', timeout });
  if (result.error || !codes.includes(result.status)) throw new GitError(`git ${args.filter((arg) => !arg.startsWith('--format')).slice(0, 3).join(' ')} failed: ${detail(result)}`);
  return result;
}

// A revision git cannot resolve to one commit. The gate turns it into a refusal.
export class RevisionError extends Error {}
// A read git cannot make in full, or a repository git cannot read the way the pipeline needs.
export class GitError extends Error {}

// Reads every backend shares

// A git setting, or '' when it is unset (git config exits 1). Any other failure throws, so a
// setting git cannot read is never taken for one that is not set.
export function gitSetting(dir, args, { gitDir: directory } = {}) {
  const read = run('git', ['config', ...args], { cwd: dir, allowFail: true, env: directory ? { GIT_DIR: directory } : undefined });
  if (read.status === 1 && !read.error) return '';
  if (read.status !== 0 || read.error) throw new Error(`git could not read ${args.at(-1)}: ${(read.stderr || read.error?.message || '').trim().split('\n')[0]}`);
  return read.stdout.trim();
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

// The GitHub repository a remote's URL names, as owner/name, or null.
export const githubSlugOf = (url) => String(url ?? '').match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?\/?$/)?.[1] ?? null;

// A file as committed at a commit: its text, or null only when that commit's tree proves it has no
// entry at that path. A missing commit, an entry that is not a plain file (a link, a submodule) or
// contents that cannot be read throw FileReadError: the file is then unknown, not absent.
export class FileReadError extends Error {}
export function committedFileIn(directory, cwd, sha, path) {
  const env = gitEnv({ gitDir: directory });
  const read = (args) => run('git', args, { cwd, allowFail: true, env });
  const firstLine = (result) => (result.stderr || result.error?.message || '').trim().split('\n')[0];
  if (read(['cat-file', '-e', `${sha}^{commit}`]).status !== 0) throw new FileReadError('this repository does not have that commit');
  const tree = read(['ls-tree', '-z', '--full-tree', sha, '--', path]);
  if (tree.status !== 0) throw new FileReadError(`git ls-tree failed (${firstLine(tree)})`);
  const entry = tree.stdout.split('\0').filter(Boolean).find((line) => line.split('\t')[1] === path);
  if (!entry) return null;
  const [mode, type, object] = entry.split('\t')[0].split(' ');
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new FileReadError(`it is a ${type} (mode ${mode}), not a plain file`);
  const blob = read(['cat-file', 'blob', object]);
  if (blob.status !== 0) throw new FileReadError(`its contents cannot be read (${firstLine(blob)})`);
  return blob.stdout;
}

// Objects by id from one cat-file --batch read: { type, body } with the body as bytes, or null when
// the object is missing. The sizes git prints split the output, so no byte in an object ends one early.
export function readObjects(at, ids) {
  const objects = new Map();
  if (!ids.length) return objects;
  const out = git(at, ['cat-file', '--batch'], { input: `${ids.join('\n')}\n`, buffer: true }).stdout;
  let offset = 0;
  for (const id of ids) {
    const end = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, end).toString('utf8').split(' ');
    if (header[1] === 'missing' || header.length !== 3) {
      if (header[1] !== 'missing') throw new GitError(`git cat-file could not read ${id}: ${header.join(' ')}`);
      objects.set(id, null);
      offset = end + 1;
      continue;
    }
    const size = Number(header[2]);
    objects.set(id, { type: header[1], body: out.subarray(end + 1, end + 1 + size) });
    offset = end + 1 + size + 1;
  }
  return objects;
}

// A commit object's parents, whether it carries a signature, and its message, read from its raw
// bytes, so no encoding or format setting changes it.
function parseCommit(body) {
  const split = body.indexOf('\n\n');
  const header = body.subarray(0, split === -1 ? body.length : split).toString('utf8').split('\n');
  return {
    parents: header.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)),
    signed: header.some((line) => /^gpgsig(-sha256)? /.test(line)),
    description: split === -1 ? '' : body.subarray(split + 2).toString('utf8').replace(/\n+$/, ''),
  };
}

// Commits are split by a header with a marker made for this read, which no path or diff line can
// hold. With -z the header follows a NUL, not a newline, so it is matched anywhere.
function byMarker(out, ids) {
  const marker = /pipeline-commit-[0-9a-f-]{36} ([0-9a-f]{40})(\0?\n|\0|$)/g;
  const starts = [...out.matchAll(marker)];
  const parts = new Map(ids.map((id) => [id, '']));
  starts.forEach((match, i) => parts.set(match[1], out.slice(match.index + match[0].length, starts[i + 1]?.index ?? out.length).replace(/^\n/, '')));
  return parts;
}

const markerFormat = () => `--format=pipeline-commit-${randomUUID()} %H`;

// git's --remerge-diff skips a commit with more than two parents and prints no diff, so such a
// commit would read as empty. A range that holds one is refused.
function refuseOctopus(commits) {
  const octopus = [...commits].find(([, commit]) => commit.parents.length > 2);
  if (octopus) throw new GitError(`git cannot diff the octopus merge ${octopus[0].slice(0, 12)} in full. Rebuild it as two-parent merges.`);
}

// Each commit's own diff, pinned: a merge's diff is its remerge diff, which is its conflict resolution.
function pinnedPatchText(at, ids, { binary = false } = {}) {
  if (!ids.length) return new Map();
  const out = git(at, ['diff-tree', '--stdin', '-p', ...(binary ? ['--binary'] : []), ...DIFF_FLAGS, '--always', markerFormat()], { pinned: true, input: `${ids.join('\n')}\n` }).stdout;
  return byMarker(out, ids);
}

// After the pins, git calls a file binary only for a NUL byte in its first 8000 bytes. A file the
// diff marks binary whose sides both lack one means a pin stopped working, so the read throws rather
// than hide text from the scan.
export function binaryGuard(at, patches) {
  const blobs = new Map();
  for (const [commit, text] of patches) {
    for (const block of text.split(/^(?=diff --git )/m)) {
      if (!/^Binary files .* differ$/m.test(block)) continue;
      const index = /^index ([0-9a-f]{40})\.\.([0-9a-f]{40})/m.exec(block);
      if (!index) throw new GitError(`git marked a file binary in ${commit.slice(0, 12)} without naming its contents.`);
      blobs.set(`${commit} ${block.split('\n')[0]}`, [index[1], index[2]].filter((id) => !/^0+$/.test(id)));
    }
  }
  if (!blobs.size) return;
  const objects = readObjects(at, [...new Set([...blobs.values()].flat())]);
  const holdsNul = (id) => objects.get(id)?.body.subarray(0, 8000).includes(0) ?? false;
  for (const [file, ids] of blobs) if (!ids.some(holdsNul)) throw new GitError(`git marked a text file binary (${file}), so a pinned setting did not hold. The pipeline refuses to read past it.`);
}

// The patch git hashes: index ids cut to 10 digits, the similarity, dissimilarity and remerge lines
// dropped, and conflict marker labels removed, so the id depends only on the change.
const normalizedPatch = (text) => text.split('\n')
  .filter((line) => !/^(similarity index|dissimilarity index|remerge) /.test(line))
  .map((line) => line.replace(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/, (whole, a, b) => `index ${a.slice(0, 10)}..${b.slice(0, 10)}`).replace(/^([-+ ])(<{7}|>{7}) .*$/, '$1$2'))
  .join('\n');

// git patch-id --verbatim, by commit id. --verbatim is the stable algorithm whatever patchid.* says,
// and keeps whitespace, since indentation can change behavior.
export function patchIdsOf(at, patches) {
  const input = [...patches].filter(([, text]) => text).map(([id, text]) => `commit ${id}\n${text}${text.endsWith('\n') ? '' : '\n'}`).join('');
  if (!input) return new Map();
  return new Map(git(at, ['patch-id', '--verbatim'], { input }).stdout.split('\n').filter(Boolean).map((line) => line.split(' ').reverse()));
}

// The normalized git patch id of each commit, as the git backend records it. `octopus` says what an
// octopus merge gives: a refusal (the git backend), or no id (the jj backend, which keeps its own).
export function gitPatchIds(at, ids, { octopus = 'refuse' } = {}) {
  const commits = new Map([...readObjects(at, ids)].map(([id, object]) => [id, parseCommit(object?.body ?? Buffer.alloc(0))]));
  if (octopus === 'refuse') refuseOctopus(commits);
  const readable = ids.filter((id) => commits.get(id).parents.length <= 2);
  const patches = pinnedPatchText(at, readable);
  binaryGuard(at, patches);
  return patchIdsOf(at, new Map([...patches].map(([id, text]) => [id, normalizedPatch(text)])));
}

// The git id state of each commit present here: its normalized git id, 'empty' when its pinned diff
// is empty, or 'unsupported' for an octopus merge, which the git read refuses. A commit this
// repository lacks has no state.
export function gitIdStatesIn(at, ids) {
  const objects = readObjects(at, ids);
  const present = ids.filter((id) => objects.get(id)?.type === 'commit');
  const commits = new Map(present.map((id) => [id, parseCommit(objects.get(id).body)]));
  const readable = present.filter((id) => commits.get(id).parents.length <= 2);
  const patches = pinnedPatchText(at, readable);
  binaryGuard(at, patches);
  const patchIds = patchIdsOf(at, new Map([...patches].map(([id, text]) => [id, normalizedPatch(text)])));
  return new Map(present.map((id) => [id, commits.get(id).parents.length > 2 ? 'unsupported' : patchIds.get(id) ?? 'empty']));
}

// Whether this git can make the pinned reads: --attr-source came in 2.41.
export const pinsHold = () => {
  const found = gitVersion();
  return found.major > FLOOR.major || (found.major === FLOOR.major && found.minor >= FLOOR.minor);
};

const FILE_STATUS = { A: 'added', D: 'removed', M: 'modified', T: 'modified', R: 'renamed', C: 'copied' };

// Each commit's files from the pinned name-status read: both paths of a rename or a copy.
function pinnedFiles(at, ids) {
  if (!ids.length) return new Map();
  const out = git(at, ['diff-tree', '--stdin', '-z', '--name-status', '-r', '--root', '-M', '-l1000', '--remerge-diff', '--no-relative', '--ignore-submodules=none', '--always', markerFormat()], { pinned: true, input: `${ids.join('\n')}\n` }).stdout;
  const files = new Map();
  for (const [id, text] of byMarker(out, ids)) {
    const parts = text.split('\0').map((part) => part.replace(/^\n/, ''));
    const list = [];
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      if (!code) continue;
      const status = FILE_STATUS[code[0]];
      if (!status) throw new GitError(`git listed ${id.slice(0, 12)}'s file with a status the pipeline does not read (${code}).`);
      if (status === 'renamed' || status === 'copied') {
        list.push({ source: parts[i + 1], path: parts[i + 2], status });
        i += 2;
      } else {
        list.push({ source: parts[i + 1], path: parts[i + 1], status });
        i += 1;
      }
    }
    files.set(id, list);
  }
  return files;
}

// Signature states in jj's words. A commit with a signature git reports as N (an SSH signature with
// no allowed signers file) reads unknown, as jj reports one it cannot check.
const SIGNATURE = { G: 'good', U: 'good', E: 'unknown', B: 'bad', X: 'expired', Y: 'expired', R: 'revoked' };
function signatures(at, commits) {
  const signed = [...commits].filter(([, commit]) => commit.signed).map(([id]) => id);
  const states = new Map([...commits.keys()].map((id) => [id, 'none']));
  if (!signed.length) return states;
  const out = git(at, ['log', '--no-walk', '--stdin', '--no-show-signature', '--format=%H %G?'], { pinned: true, input: `${signed.join('\n')}\n` }).stdout;
  for (const line of out.split('\n').filter(Boolean)) {
    const [id, code] = line.split(' ');
    states.set(id, SIGNATURE[code] ?? 'unknown');
  }
  return states;
}

// The commit records every backend gives, oldest first, for commits git can read: the git backend's
// listCommits, and the normalized git ids the jj backend adds to its own.
function gitRecords(at, ids) {
  const commits = new Map([...readObjects(at, ids)].map(([id, object]) => {
    if (!object || object.type !== 'commit') throw new GitError(`${id.slice(0, 12)} is not a commit here.`);
    return [id, parseCommit(object.body)];
  }));
  refuseOctopus(commits);
  const patches = pinnedPatchText(at, ids);
  binaryGuard(at, patches);
  const patchIds = patchIdsOf(at, new Map([...patches].map(([id, text]) => [id, normalizedPatch(text)])));
  const files = pinnedFiles(at, ids);
  const signed = signatures(at, commits);
  return ids.map((id) => {
    const commit = commits.get(id);
    const patchId = patchIds.get(id) ?? null;
    return { id, changeId: null, signature: signed.get(id), empty: !patches.get(id), parents: commit.parents.length, description: commit.description, files: files.get(id), patchId, patchIds: patchId ? [patchId] : [], gitId: patchId };
  });
}

// Each commit's own diff, by commit id, for the scan.
function gitPatches(at, ids) {
  const commits = new Map([...readObjects(at, ids)].map(([id, object]) => [id, parseCommit(object?.body ?? Buffer.alloc(0))]));
  refuseOctopus(commits);
  const patches = pinnedPatchText(at, ids);
  binaryGuard(at, patches);
  return patches;
}

// Capability

let version = null;
// git's version, once per process: --attr-source and GIT_ATTR_SOURCE, the newest feature the reads
// need, came in 2.41.
export function gitVersion() {
  if (version) return version;
  const out = git({ cwd: undefined }, ['version']).stdout.trim();
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  if (!match) throw new GitError(`git version printed ${out}, which the pipeline cannot read.`);
  version = { text: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`, major: Number(match[1]), minor: Number(match[2]) };
  return version;
}

const FLOOR = { major: 2, minor: 41 };
const checked = new Map();
// What a git repository must be for the reads: git 2.41 or later, sha1 ids, every commit present
// (not shallow, not a partial clone). Once per process and repository, before any other read.
export function gitCapable(at) {
  const key = at.gitDir ?? at.cwd;
  if (checked.has(key)) return checked.get(key);
  const problem = capabilityProblem(at);
  checked.set(key, problem);
  return problem;
}

function capabilityProblem(at) {
  const found = gitVersion();
  if (!pinsHold()) return `git ${found.major}.${found.minor} is older than 2.41, which the pipeline needs in a git repository.`;
  const format = git(at, ['rev-parse', '--show-object-format']).stdout.trim();
  if (format !== 'sha1') return `This repository uses ${format} object ids, and the pipeline reads only sha1 repositories for now.`;
  const promisor = git(at, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$'], { codes: [0, 1] }).stdout.trim();
  if (promisor) return `This is a partial clone (${promisor.split('\n')[0]}), which lacks objects the reads need. Clone it in full.`;
  if (git(at, ['rev-parse', '--is-shallow-repository']).stdout.trim() !== 'false') return 'This is a shallow clone, so ranges and ancestry stop at its graft line. Run git fetch --unshallow origin first.';
  return null;
}

// Whether the remote's fetch refspecs map every branch to its tracking refs. A single-branch clone
// never records pushed ci/* branches, so the pipeline would miss them.
export function trackingProblem(at, remote) {
  const specs = git(at, ['config', '--get-all', `remote.${remote}.fetch`], { codes: [0, 1] }).stdout.split('\n').filter(Boolean);
  if (specs.some((spec) => spec.replace(/^\+/, '') === `refs/heads/*:refs/remotes/${remote}/*`)) return null;
  return `git fetches only some branches of ${remote} here (remote.${remote}.fetch is ${specs.join(', ') || 'not set'}). Run git remote set-branches ${remote} '*' and git fetch --prune ${remote}.`;
}

// Settings and files that change what the pinned reads give, in every scope: a configured driver for
// the built-in merge drivers runs during --remerge-diff, and info/attributes is read even under the
// empty attribute source.
export function pinnedReadHazard(at, commonDir) {
  const drivers = git(at, ['config', '--get-regexp', '^merge\\.(text|binary|union)\\.'], { codes: [0, 1] }).stdout.trim();
  if (drivers) return `git's config sets ${drivers.split('\n')[0].split(' ')[0]}, which would run during the pipeline's diff of a merge. Remove it from every config scope.`;
  const attributes = join(commonDir, 'info', 'attributes');
  if (existsSync(attributes) && readFileSync(attributes, 'utf8').trim()) return `${attributes} sets attributes git applies to every read. Move the lines in .git/info/attributes to .gitattributes, or delete the file.`;
  return null;
}

// The hook in every worktree

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const realOr = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// Whether a worktree runs the pipeline's pre-push hook, wherever its hooks path points: a relative or
// worktree-scoped core.hooksPath gives each worktree its own. ok is the file install.sh links,
// missing is no file or one git skips, and unverified is any other file, whose text cannot prove it
// runs the pipeline.
export function hookOf(worktree) {
  const found = detect(worktree);
  const at = where(worktree, found.gitDir ?? undefined, found.gitDir ? found.root : null);
  const read = git(at, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push'], { codes: [0, 128] });
  const path = read.status === 0 ? read.stdout.trim() : '';
  if (!path) return { state: 'missing', path: null, why: 'git cannot find its hooks folder there' };
  if (!existsSync(path)) return { state: 'missing', path, why: `${path} does not exist` };
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return { state: 'missing', path, why: `${path} is not executable, so git skips it` };
  }
  const shipped = realOr(join(PLUGIN, 'git-hooks', 'pre-push'));
  if (shipped && realOr(path) === shipped) return { state: 'ok', path };
  return { state: 'unverified', path, why: `${path} is not the hook install.sh links, so it cannot be told whether it runs the pipeline` };
}

// Command text

// The commands messages print, per backend, so every refusal names the command for the backend in use.
export const COMMANDS = {
  jj: {
    pushBranch: (remote, name, id) => `jj bookmark set ${name} -r ${id} && jj git push --remote ${remote} --bookmark ${name}`,
    pushTrunk: (remote, trunk, id) => `jj bookmark set ${trunk} -r ${id} && jj git push --remote ${remote} --bookmark ${trunk}`,
    deleteBranch: (remote, name) => [`jj bookmark track ${name}@${remote} 2>/dev/null; jj bookmark delete ${name}`, `jj git push --remote ${remote} --bookmark ${name}`],
    fetch: (remote) => `jj git fetch --remote ${remote}`,
    addLane: (dir, base, name) => `jj workspace add --name ${name} ${dir} -r ${base}`,
    removeLane: (name, dir) => [`jj workspace forget ${name}`, `rm -rf ${JSON.stringify(dir)}`],
    updateStale: (dir) => `cd ${JSON.stringify(dir)} && jj workspace update-stale`,
  },
  git: {
    pushBranch: (remote, name, id) => `git push ${remote} ${id}:refs/heads/${name}`,
    pushTrunk: (remote, trunk, id) => `PIPELINE_USER_PUSH=1 git push ${remote} ${id}:refs/heads/${trunk}`,
    deleteBranch: (remote, name) => [`git push ${remote} --delete refs/heads/${name}`, `git branch -D ${name} 2>/dev/null || true`],
    fetch: (remote) => `git fetch --prune ${remote}`,
    addLane: (dir, base, name) => `git worktree add -b ${name} ${dir} ${base}`,
    removeLane: (branch, dir) => (existsSync(dir) ? [`git worktree remove ${JSON.stringify(dir)}`, `git branch -D ${branch}`] : ['git worktree prune', `git branch -D ${branch}`]),
    updateStale: () => null,
  },
};

// The working copy

// What the files on disk are, for the checks: HEAD, and whether git status sees any change, untracked
// files and submodules included. Status runs with the worktree's own attributes, since it compares
// files on disk through the filters and eol rules that made the index. An entry git status cannot
// see (assume-unchanged or skip-worktree) makes the worktree unfit for checks.
function gitWorkingCopy(at) {
  const head = git(at, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { codes: [0, 1] }).stdout.trim() || null;
  const flagged = git(at, ['ls-files', '-v', '-z']).stdout.split('\0').filter(Boolean).find((entry) => /^[a-zS]/.test(entry));
  if (flagged) {
    const path = flagged.slice(2);
    throw new GitError(`git status cannot see edits to ${path}. Run git update-index --no-assume-unchanged ${path} (or --no-skip-worktree).`);
  }
  const status = git(at, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).stdout;
  const dirty = status.length > 0;
  return { at: dirty ? null : head, dirty, sitsOn: head ? [head] : [] };
}

// The mutation tree: the commit's exact bytes and modes, from a temporary index, with no filter,
// ident, eol or export rule applied, then checked file by file against the commit.
export function exportTree(at, id, tree, index) {
  mkdirSync(tree, { recursive: true });
  const extra = { GIT_INDEX_FILE: index };
  git(at, ['read-tree', id], { extra });
  git({ ...at, workTree: tree }, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=true', 'checkout-index', '-a', '-f'], { pinned: true, extra });
  return checkTree(at, id, tree);
}

// Whether a tree on disk holds a commit's exact bytes, links and executable bits. A mismatch throws,
// so a check never tests other bytes than the commit's.
export function checkTree(at, id, tree) {
  const entries = git(at, ['ls-tree', '-r', '-z', '--full-tree', id]).stdout.split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type, object] = meta.split(' ');
    return { mode, type, object, path };
  });
  const regular = entries.filter((entry) => entry.mode === '100644' || entry.mode === '100755');
  const hashes = regular.length ? git(at, ['hash-object', '--no-filters', '--stdin-paths'], { input: `${regular.map((entry) => join(tree, entry.path)).join('\n')}\n` }).stdout.split('\n').filter(Boolean) : [];
  const links = entries.filter((entry) => entry.mode === '120000');
  const targets = readObjects(at, links.map((entry) => entry.object));
  const wrong = [
    ...regular.filter((entry, i) => hashes[i] !== entry.object).map((entry) => `${entry.path} differs from its blob`),
    ...regular.filter((entry) => ((statSync(join(tree, entry.path)).mode & 0o111) !== 0) !== (entry.mode === '100755')).map((entry) => `${entry.path} has the wrong executable bit`),
    ...links.filter((entry) => !lstatSync(join(tree, entry.path), { throwIfNoEntry: false })?.isSymbolicLink() || readlinkSync(join(tree, entry.path)) !== targets.get(entry.object)?.body.toString('utf8')).map((entry) => `${entry.path} is not the link the commit holds`),
  ];
  if (wrong.length) throw new GitError(`The tree of ${id.slice(0, 12)} did not come out as the commit holds it (${wrong.slice(0, 3).join('; ')}), so the mutation check would test other bytes.`);
  return tree;
}

// The patch that removes a commit's changes to some paths, pinned, for git apply -R.
export function removalPatch(at, id, paths) {
  return git(at, ['diff-tree', '-p', '--binary', ...DIFF_FLAGS.filter((flag) => flag !== '--remerge-diff'), id, '--', ...paths], { pinned: true }).stdout;
}

// The backend

const isFullId = (text) => /^[0-9a-f]{40}$/.test(text);
const listInput = ({ tips, not }) => `${[...tips, ...(not.length ? ['--not', ...not] : [])].join('\n')}\n`;

// The operations of section 3 of the design, bound to one worktree (or, for a repository's git
// folder with no worktree, to that folder).
export function gitVcs(dir) {
  const found = detect(dir);
  if (found.backend !== 'git') throw new GitError(`${dir} is not a git worktree.`);
  const at = where(found.root, found.gitDir, found.root);
  let ready = false;
  const read = (args, options) => {
    if (!ready) {
      const problem = gitCapable(at);
      if (problem) throw new GitError(problem);
      ready = true;
    }
    return git(at, args, options);
  };
  const ids = (range, order = []) => (range.tips.length ? read(['rev-list', '--topo-order', ...order, '--stdin'], { input: listInput(range) }).stdout.split('\n').filter(Boolean) : []);
  const refs = (patterns) => read(['for-each-ref', '--format=%(refname)%00%(objectname)', ...patterns]).stdout.split('\n').filter(Boolean).map((line) => line.split('\0'));
  const vcs = {
    backend: 'git',
    dir: found.root,
    at,
    store: found.store,
    defaultTip: 'HEAD',
    // Exactly one line of 40 hex digits: ^HEAD^{commit} exits 0 and prints ^<id>.
    revisions: (rev) => {
      const out = read(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { codes: [0, 1, 128] });
      const lines = out.stdout.split('\n').filter(Boolean);
      if (out.status !== 0 || lines.length !== 1 || !isFullId(lines[0])) throw new RevisionError(`git could not read ${rev} as one commit`);
      return lines;
    },
    exists: (id) => {
      const line = read(['cat-file', '--batch-check'], { input: `${id}\n` }).stdout.trim();
      if (line === `${id} missing`) return false;
      const [oid, type] = line.split(' ');
      if (oid !== id || !type) throw new GitError(`git cat-file could not tell whether ${id} exists: ${line}`);
      return type === 'commit';
    },
    isAncestor: (ancestor, descendant) => Boolean(ancestor && descendant) && read(['merge-base', '--is-ancestor', ancestor, descendant], { codes: [0, 1] }).status === 0,
    forkPoint: (a, b) => (b ? read(['merge-base', '--all', a, b], { codes: [0, 1] }).stdout.split('\n').filter(Boolean) : []),
    commitIds: (range) => ids(range),
    listCommits: (range) => gitRecords(at, ids(range, ['--reverse'])),
    readCommits: (list) => gitRecords(at, list),
    commitPatches: (range) => gitPatches(at, ids(range)),
    filesAt: (id) => read(['ls-tree', '-r', '-z', '--name-only', '--full-tree', id]).stdout.split('\0').filter(Boolean),
    workingCopy: () => gitWorkingCopy(at),
    // A git commit never takes in edits on disk.
    inWorkingCopies: () => [],
    isVisible: (id) => read(['for-each-ref', '--contains', id, '--count=1', 'refs/heads/', 'refs/remotes/', 'refs/tags/']).stdout.trim() !== '' || vcs.workspaces().some((tree) => tree.head && vcs.isAncestor(id, tree.head)),
    localBranch: (name) => refs([`refs/heads/${name}`]).find(([ref]) => ref === `refs/heads/${name}`)?.[1] ?? null,
    remoteBranch: (name, remote = 'origin') => refs([`refs/remotes/${remote}/${name}`]).find(([ref]) => ref === `refs/remotes/${remote}/${name}`)?.[1] ?? null,
    remoteBranches: (remote = 'origin') => refs([`refs/remotes/${remote}/`]).map(([ref, target]) => ({ name: ref.slice(`refs/remotes/${remote}/`.length), target })).filter((entry) => entry.name !== 'HEAD'),
    remoteBranchIds: (remote = 'origin') => [...new Set(vcs.remoteBranches(remote).map((entry) => entry.target))],
    isOnRemote: (id, remote = 'origin') => read(['for-each-ref', '--contains', id, '--count=1', '--format=%(refname)', `refs/remotes/${remote}/`]).stdout.split('\n').some((ref) => ref && ref !== `refs/remotes/${remote}/HEAD`),
    remoteNames: () => read(['remote']).stdout.split('\n').filter(Boolean),
    // Every worktree, by path, with its HEAD and branch. A bare repository's own entry has neither.
    workspaces: () => {
      const out = read(['worktree', 'list', '--porcelain', '-z']).stdout;
      return out.split('\0\0').filter(Boolean).map((record) => {
        const fields = Object.fromEntries(record.split('\0').filter(Boolean).map((field) => {
          const space = field.indexOf(' ');
          return space === -1 ? [field, true] : [field.slice(0, space), field.slice(space + 1)];
        }));
        return { path: fields.worktree, head: fields.HEAD ?? null, branch: typeof fields.branch === 'string' ? fields.branch.replace(/^refs\/heads\//, '') : null, bare: fields.bare === true };
      });
    },
    gitDir: () => found.gitDir,
    commonDir: () => found.commonDir,
    // The local config's folder: what detect found, else git's first worktree that is not bare.
    configDir: () => found.configDir ?? vcs.workspaces().find((tree) => !tree.bare)?.path ?? found.root,
    main: () => found.main ?? vcs.configDir(),
    slug: (remote = 'origin') => githubSlugOf(read(['config', '--get', `remote.${remote}.url`], { codes: [0, 1] }).stdout.trim()),
    identity: () => {
      const slug = vcs.slug();
      return slug ? `github:${slug.toLowerCase()}` : `store:${found.store}`;
    },
    committedFile: (sha, path) => committedFileIn(found.gitDir, found.root, sha, path),
    gitIdStates: (list) => gitIdStatesIn(at, list),
    // git has no change ids.
    changeIdOf: () => null,
    hook: () => hookOf(found.root),
    commands: COMMANDS.git,
  };
  return vcs;
}

// git's own root for a folder, found by discovery with the cleared environment and no GIT_DIR, or
// null outside every git repository.
export function gitRoot(dir) {
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env: gitEnv({}), allowFail: true });
  if (result.status === 0) return result.stdout.trim();
  if (/not a git repository|must be run in a work tree/i.test(result.stderr ?? '')) return null;
  throw new GitError(`git could not find the worktree of ${dir}: ${detail(result)}`);
}

// Whether detect and git agree on a worktree's root. When they do not, the folder is refused.
export function agreedRoot(dir) {
  const found = detect(dir);
  if (found.backend !== 'git') return null;
  const own = gitRoot(dir);
  if (own === null || realOr(own) !== realOr(found.root)) throw new GitError(`git finds ${own ?? 'no worktree'} from ${dir}, but its .git marker is in ${found.root}, so the pipeline cannot tell which repository this is.`);
  return found.root;
}
