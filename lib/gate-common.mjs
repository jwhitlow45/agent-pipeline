// What the gate's parts share: the refusal, the messages that recur, and the paths that hold a
// repository's controls.

import { homedir } from 'node:os';
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './util.mjs';
import { commitIds, RevsetError } from './vcs.mjs';

export class Refusal extends Error {}
export const refuse = (reason) => { throw new Refusal(reason); };

export const NEVER_PROD = 'Agents never run a production deploy. Give the user the command instead.';
export const userRuns = (config, what) => `The user runs deploys and moves ${config.trunk} in this project (deploy.runBy is "user"). Give the user the command instead${what ? `: ${what}` : ''}.`;
export const SPELL_OUT = 'Spell the command out with its built-in name';

const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
export const plainName = (text) => {
  const name = String(text).replace(/^exact:/, '');
  return BRANCH_NAME.test(name) && !name.startsWith('-') ? name : null;
};

export function resolveRevset(repo, revset) {
  try {
    return commitIds(repo, revset);
  } catch (error) {
    if (error instanceof RevsetError) refuse(`The gate cannot resolve ${revset}: ${error.message}`);
    throw error;
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

// A path as the file system stores it: links followed, and each part that exists spelled as it is
// on disk, found from the deepest part that exists. Parts that do not exist yet are kept as written.
// A dangling link is followed too, since a write through it creates its target.
export function canonicalPath(full, depth = 0) {
  const rest = [];
  for (let head = full; ;) {
    try {
      return join(realpathSync.native(head), ...rest);
    } catch {
      try {
        if (depth < 20 && lstatSync(head).isSymbolicLink()) return canonicalPath(join(resolve(dirname(head), readlinkSync(head)), ...rest), depth + 1);
      } catch {
        // Not there at all: try its parent.
      }
      const parent = dirname(head);
      if (parent === head) return full;
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

// Whether the volume a path is on ignores case (APFS and HFS+ do by default), found once per volume
// by looking up a part of the path in swapped case. When it cannot tell, it folds, which can only
// protect more.
const insensitiveByDevice = new Map();
function ignoresCase(full) {
  let existing = full;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  let device;
  try {
    device = statSync(existing).dev;
  } catch {
    return true;
  }
  if (insensitiveByDevice.has(device)) return insensitiveByDevice.get(device);
  let answer = true;
  for (let part = existing; dirname(part) !== part; part = dirname(part)) {
    const name = basename(part);
    if (!/[a-z]/i.test(name)) continue;
    try {
      const here = statSync(part);
      if (here.dev !== device) break;
      const swapped = statSync(join(dirname(part), [...name].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('')), { throwIfNoEntry: false });
      answer = Boolean(swapped) && swapped.dev === here.dev && swapped.ino === here.ino;
    } catch {
      answer = true;
    }
    break;
  }
  insensitiveByDevice.set(device, answer);
  return answer;
}

// The form two paths are compared in: canonical, then case-folded on a volume that ignores case.
const comparable = (full) => {
  const path = canonicalPath(full).normalize('NFC');
  return ignoresCase(path) ? path.toLowerCase() : path;
};

// Files that steer git, jj, curl or the shell wherever they sit, by name.
const CONTROL_NAMES = new Map([
  ...['.gitconfig', 'gitconfig', '.jjconfig.toml', '.gitmodules'].map((name) => [name, 'is a git or jj config file']),
  ...['.curlrc', '.wgetrc'].map((name) => [name, 'is a config file curl or wget reads']),
  ...['.zshenv', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile'].map((name) => [name, 'is a shell startup file, which runs before later commands']),
  // A hooks path (core.hooksPath) can hold the pre-push hook outside .git.
  ['pre-push', 'is named like the git hook that runs the gate'],
]);

// The folders whose files steer git, jj, gh or the gate, each with what it is.
function controlFolders() {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME;
  const folders = [
    [join(home, '.config', 'git'), "is in git's or jj's config folder"],
    [join(home, '.config', 'jj'), "is in git's or jj's config folder"],
    // Older jj versions read this folder on macOS.
    [join(home, 'Library', 'Application Support', 'jj'), "is in git's or jj's config folder"],
    [join(home, '.config', 'gh'), "is in gh's config folder, which can set the program gh runs"],
    [join(home, '.ssh'), 'is in the ssh folder, which can change where git connects'],
    [join(ROOT, 'git-hooks'), 'defines the hooks that run the gate'],
    [resolve(stateDir()), "is in the pipeline's own ledger"],
  ];
  if (xdg) folders.push([join(xdg, 'git'), "is in git's or jj's config folder"], [join(xdg, 'jj'), "is in git's or jj's config folder"], [join(xdg, 'gh'), "is in gh's config folder, which can set the program gh runs"]);
  if (process.env.CLAUDE_CONFIG_DIR) folders.push([process.env.CLAUDE_CONFIG_DIR, 'holds agent settings that can turn the gate off']);
  return folders;
}

// The single files that steer them, wherever their names point.
function controlFiles() {
  const files = [
    [join(ROOT, 'hooks', 'hooks.json'), 'defines the hooks that run the gate'],
    [join(ROOT, 'codex', 'hooks.json'), 'defines the hooks that run the gate'],
    [join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'hooks.json'), 'defines the hooks that run the gate'],
  ];
  for (const name of ['JJ_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'WGETRC']) if (process.env[name]) files.push([process.env[name], 'is a config file git, jj or wget reads']);
  if (process.env.CURL_HOME) files.push([join(process.env.CURL_HOME, '.curlrc'), 'is a config file curl reads']);
  return files;
}

const inside = (path, folder) => path === folder || path.startsWith(`${folder}${sep}`);

// The files that steer git, jj or this gate: anything inside a .git or .jj folder, git's, jj's, gh's
// and curl's config, shell startup files, the hook definitions and agent settings that run or turn
// off the gate, and the pipeline's own ledger. A write there can change what a later command does
// without that command saying so. Each path is compared as written and as the file system stores
// it, so a link, a `..` or another case cannot name a protected file another way.
export function controlPath(path, cwd) {
  if (!path) return null;
  const reason = controlReason(resolve(cwd ?? '/', expand(String(path))));
  return reason ? `${path} ${reason}` : null;
}

function controlReason(full) {
  const forms = [...new Set([full.normalize('NFC'), comparable(full)])].flatMap((form) => (ignoresCase(form) ? [form, form.toLowerCase()] : [form]));
  for (const form of forms) {
    const parts = form.split(sep);
    if (parts.some((part) => part === '.git' || part === '.jj')) return 'is inside a .git or .jj folder';
    const name = parts.at(-1);
    if (CONTROL_NAMES.has(name)) return CONTROL_NAMES.get(name);
    // Claude Code's and Codex's settings can turn hooks off (disableAllHooks) or drop the plugin, and
    // Claude Code sources its shell snapshots before each command.
    const agentFolder = parts.findIndex((part) => part === '.claude' || part === '.codex');
    if (agentFolder !== -1 && (/^(settings(\.local)?\.json|config\.toml|hooks\.json)$/.test(name) || ['plugins', 'shell-snapshots'].includes(parts[agentFolder + 1]))) return 'holds agent settings that can turn the gate off';
  }
  const target = comparable(full);
  protectedPaths ??= {
    files: controlFiles().map(([file, why]) => [comparable(resolve(expand(file))), why]),
    folders: controlFolders().map(([folder, why]) => [comparable(resolve(expand(folder))), why]),
  };
  for (const [file, why] of protectedPaths.files) if (target === file) return why;
  for (const [folder, why] of protectedPaths.folders) if (inside(target, folder)) return why;
  return null;
}

// Worked out once per process: the environment that names them does not change during a check.
let protectedPaths = null;
