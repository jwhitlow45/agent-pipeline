// git reads every backend shares: settings, the repository a folder is in, and files as committed.

import { existsSync } from 'node:fs';
import { run } from './util.mjs';

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
  const env = { GIT_DIR: directory, GIT_NO_REPLACE_OBJECTS: '1' };
  const git = (args) => run('git', args, { cwd, allowFail: true, env });
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
