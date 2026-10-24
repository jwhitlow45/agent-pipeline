// Which version control a folder uses, found from the folder up without running any program, so the
// gate can call it before it trusts anything. The nearest folder that holds .jj or .git wins, and in
// one folder .jj wins over .git: a colocated repository is a jj repository. Inside a jj workspace,
// jj's own discovery wins: a git checkout nested there belongs to the workspace, as jj and the gate
// have always read it, so a push from it is refused as another repository's.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};
const isDir = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// A folder git itself would take for a repository's git folder: a HEAD, objects and refs.
export const isGitFolder = (dir) => isFile(join(dir, 'HEAD')) && isDir(join(dir, 'objects')) && isDir(join(dir, 'refs'));

// Whether a git folder's own config says it is bare. Read as text: the [core] section's bare key.
function isBare(gitFolder) {
  const text = read(join(gitFolder, 'config')) ?? '';
  let section = '';
  for (const line of text.split('\n')) {
    const header = /^\s*\[\s*([^\]\s"]+)/.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    const key = /^\s*bare\s*=\s*(\S+)/i.exec(line);
    if (section === 'core' && key) return ['true', 'yes', 'on', '1'].includes(key[1].toLowerCase());
  }
  return false;
}

// The nearest jj workspace at or above a folder, as jj's own discovery finds it.
function jjAbove(dir) {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.jj'))) return current;
    if (current === dirname(current)) return null;
  }
}

const NONE = { backend: null, root: null, store: null, gitDir: null, commonDir: null, configDir: null, main: null, layout: null, bare: null, refused: null, ofJj: null, nested: null };

function jjLayout(root) {
  const pointer = join(root, '.jj', 'repo');
  let store = null;
  let layout = 'jj';
  if (isFile(pointer)) {
    layout = 'jj-workspace';
    const target = read(pointer)?.trim();
    store = target ? real(resolve(join(root, '.jj'), target)) : null;
  } else store = real(pointer);
  // The folder that holds .jj/repo as a folder is where every workspace's local config lives.
  const configDir = layout === 'jj' ? root : store && basename(store) === 'repo' && basename(dirname(store)) === '.jj' ? dirname(dirname(store)) : null;
  return { ...NONE, backend: 'jj', root, store, configDir, main: configDir, layout };
}

function gitLayout(root, marker) {
  if (isDir(marker)) {
    const gitDir = real(marker);
    return { ...NONE, backend: 'git', root, store: gitDir, gitDir, commonDir: gitDir, configDir: root, main: root, layout: 'git', bare: false };
  }
  const pointed = /^gitdir:\s*(.+?)\s*$/m.exec(read(marker) ?? '')?.[1];
  const own = pointed ? real(resolve(root, pointed)) : null;
  if (!own) return { ...NONE, layout: 'git', refused: `${marker} does not point at a git folder that exists, so neither git nor the gate can read this worktree.`, root };
  const commonPointer = read(join(own, 'commondir'))?.trim();
  if (!commonPointer) {
    // A separate git folder (git init --separate-git-dir) or a submodule: its folder is its own.
    return { ...NONE, backend: 'git', root, store: own, gitDir: own, commonDir: own, configDir: root, main: root, layout: 'git-separate', bare: false };
  }
  const common = real(resolve(own, commonPointer));
  if (!common) return { ...NONE, layout: 'git-worktree', refused: `${own} names a common git folder that does not exist (${commonPointer}).`, root };
  if (basename(common) === '.git' && existsSync(join(dirname(common), '.jj'))) {
    return { ...NONE, layout: 'git-worktree', root, store: common, ofJj: dirname(common), refused: `${root} is a git worktree of the jj repository at ${dirname(common)}, which the pipeline does not support. Make a jj workspace instead: jj workspace add <folder>.` };
  }
  const bare = isBare(common);
  // A worktree of a bare repository reads the local config from the bare folder, and is its own
  // usable worktree. Any other linked worktree reads it from the main worktree, which git lists first.
  const configDir = bare ? common : basename(common) === '.git' ? dirname(common) : null;
  return { ...NONE, backend: 'git', root, store: common, gitDir: own, commonDir: common, configDir, main: bare ? root : configDir, layout: 'git-worktree', bare };
}

export function detect(dir) {
  if (!dir) return NONE;
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, '.jj'))) return jjLayout(current);
    const marker = join(current, '.git');
    if (existsSync(marker)) {
      const found = gitLayout(current, marker);
      // A git worktree of a colocated jj repository stays refused wherever it sits (D3).
      const above = found.ofJj ? null : jjAbove(dirname(current));
      return above ? { ...jjLayout(above), nested: current } : found;
    }
    if (isGitFolder(current)) {
      // A git folder of its own: a bare repository, or the .git of a worktree, which git reads with no
      // worktree at all. Inside a jj workspace (a colocated .git, or jj's own store), jj still finds
      // the workspace above, as it does today.
      const above = jjAbove(dirname(current));
      return above ? jjLayout(above) : { ...NONE, bare: current };
    }
    if (current === dirname(current)) return NONE;
  }
}
