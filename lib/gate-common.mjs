// What the gate's parts share: the refusal, the messages that recur, and the paths that hold a
// repository's controls.

import { homedir } from 'node:os';
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clonesOf, registeredRepos } from './registry.mjs';
import { stateDir } from './util.mjs';
import { GitError, RevisionError } from './vcs-git.mjs';
import { commitIds, RevsetError } from './vcs-jj.mjs';

export class Refusal extends Error {}
export const refuse = (reason) => { throw new Refusal(reason); };

export const NEVER_PROD = 'Agents never run a production deploy. Give the user the command instead.';
export const userRuns = (config, what) => `The user runs deploys and moves ${config.trunk} in this project (deploy.runBy is "user"). Give the user the command instead${what ? `: ${what}` : ''}.`;
export const SPELL_OUT = 'Spell the command out with its built-in name';
// How a refusal with a context says to push a branch or fetch, in the backend's own commands.
export const pushAdvice = (ctx) => (ctx.vcs?.backend === 'git' ? ctx.vcs.commands.pushBranch(ctx.config.remote, '<branch>', '<full id>') : 'jj git push -b <name>');
export const fetchAdvice = (ctx) => (ctx.vcs?.backend === 'git' ? ctx.vcs.commands.fetch(ctx.config.remote) : 'jj git fetch');

const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
export const plainName = (text) => {
  const name = String(text).replace(/^exact:/, '');
  return BRANCH_NAME.test(name) && !name.startsWith('-') ? name : null;
};

export const resolveRevset = (repo, revset) => readOrRefuse(revset, () => commitIds(repo, revset));

// A read of what an agent named, where a name the version control cannot read refuses.
export function readOrRefuse(what, read) {
  try {
    return read();
  } catch (error) {
    if (error instanceof RevsetError || error instanceof RevisionError || error instanceof GitError) refuse(`The gate cannot resolve ${what}: ${error.message}`);
    throw error;
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

// A path as the file system stores it: links followed, and each part that exists spelled as it is
// on disk, found from the deepest part that exists. Parts that do not exist yet are kept as written.
// A dangling link is followed too, since a write through it creates its target. Null past 40 links,
// more than macOS (32) or Linux (40) follows, or in a loop: where a write lands is then unknown.
export function canonicalPath(full, depth = 0) {
  const rest = [];
  for (let head = full; ;) {
    try {
      return join(realpathSync.native(head), ...rest);
    } catch {
      try {
        if (lstatSync(head).isSymbolicLink()) return depth < 40 ? canonicalPath(join(resolve(dirname(head), readlinkSync(head)), ...rest), depth + 1) : null;
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
  const path = canonicalPath(full)?.normalize('NFC');
  if (path === undefined) return null;
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

// The locations whose files steer git, jj, gh, ssh, gpg or the gate, each with what it is. A location
// protects itself and, when it is a folder, everything under it. They are taken from the same
// environment the tools read (JJ_CONFIG as a path list of files or folders, GH_CONFIG_DIR,
// GIT_CONFIG_GLOBAL and the rest), not by asking each tool, which would start jj and git on every
// command and edit. The environment is the hook's own: see "What the gate is not" in
// docs/integration.md.
function controlLocations() {
  const home = homedir();
  const env = process.env;
  const configs = "is in git's or jj's config folder";
  const gh = "is in gh's config folder, which can set the program gh runs";
  const hooks = 'defines the hooks that run the gate';
  const agent = 'holds agent settings that can turn the gate off';
  const locations = [
    [join(home, '.config', 'git'), configs], [join(home, '.config', 'jj'), configs],
    // Older jj versions read this folder on macOS.
    [join(home, 'Library', 'Application Support', 'jj'), configs],
    [join(home, '.config', 'gh'), gh],
    [join(home, '.ssh'), 'is in the ssh folder, which can change where git connects'],
    [env.GNUPGHOME || join(home, '.gnupg'), "is in gpg's folder, which can set the program signing runs"],
    [join(ROOT, 'git-hooks'), hooks], [join(ROOT, 'hooks', 'hooks.json'), hooks], [join(ROOT, 'codex', 'hooks.json'), hooks],
    [join(env.CODEX_HOME || join(home, '.codex'), 'hooks.json'), hooks], [join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), agent],
    [resolve(stateDir()), "is in the pipeline's own ledger"],
  ];
  for (const path of (env.JJ_CONFIG ?? '').split(delimiter).filter(Boolean)) locations.push([path, 'is a config file or folder jj reads (JJ_CONFIG)']);
  if (env.GH_CONFIG_DIR) locations.push([env.GH_CONFIG_DIR, gh]);
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG']) if (env[name]) locations.push([env[name], `is a config file git reads (${name})`]);
  if (env.WGETRC) locations.push([env.WGETRC, 'is a config file wget reads (WGETRC)']);
  if (env.CURL_HOME) locations.push([join(env.CURL_HOME, '.curlrc'), 'is a config file curl reads (CURL_HOME)']);
  if (env.XDG_CONFIG_HOME) for (const tool of ['git', 'jj']) locations.push([join(env.XDG_CONFIG_HOME, tool), configs]);
  if (env.XDG_CONFIG_HOME) locations.push([join(env.XDG_CONFIG_HOME, 'gh'), gh], [join(env.XDG_CONFIG_HOME, 'wget'), 'is a config file curl or wget reads']);
  if (env.CLAUDE_CONFIG_DIR) locations.push([env.CLAUDE_CONFIG_DIR, agent]);
  // Every git folder of every registered clone, so a separate git folder or a bare repository not
  // named .git is protected too. A registry that cannot be read adds none here: the gate refuses
  // the lines it would gate until the user repairs it.
  try {
    for (const entry of registeredRepos()) for (const clone of clonesOf(entry)) for (const dir of [clone.store, ...(clone.gitDirs ?? [])].filter(Boolean)) locations.push([dir, "is in a registered repository's git folder"]);
  } catch {
    // An unreadable registry protects nothing more.
  }
  return locations;
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
  const target = comparable(full);
  if (target === null) return 'is reached through more links than the gate follows, or a loop of them, so the gate cannot tell where a write lands';
  // As written, and as the disk stores it, case-folded where the disk ignores case.
  const forms = [...new Set([full.normalize('NFC'), target])];
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
  protectedPaths ??= controlLocations().map(([location, why]) => [comparable(resolve(expand(location))) ?? resolve(expand(location)), why]);
  for (const [location, why] of protectedPaths) if (inside(target, location)) return why;
  return null;
}

// Worked out once per process: the environment that names them does not change during a check.
let protectedPaths = null;
