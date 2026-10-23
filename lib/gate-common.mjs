// What the gate's parts share: the refusal, the messages that recur, and the paths that hold a
// repository's controls.

import { homedir } from 'node:os';
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

// The files that steer git, jj or this gate: anything inside a .git or .jj folder, git's and jj's
// own config files, the hook definitions and agent settings that run or turn off the gate, and the
// pipeline's own ledger. A write there can change what a later command does without that command
// saying so.
export function controlPath(path, cwd) {
  if (!path) return null;
  const full = resolve(cwd ?? '/', expand(String(path)));
  const parts = full.split(sep);
  if (parts.some((part) => part === '.git' || part === '.jj')) return `${path} is inside a .git or .jj folder`;
  const name = basename(full);
  if (['.gitconfig', '.jjconfig.toml', '.gitmodules'].includes(name)) return `${path} is a git or jj config file`;
  if (/\/\.config\/(git|jj)\//.test(full)) return `${path} is in git's or jj's config folder`;
  const hooks = [join(ROOT, 'hooks', 'hooks.json'), join(ROOT, 'git-hooks', 'pre-push'), join(ROOT, 'codex', 'hooks.json'), join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'hooks.json')];
  if (hooks.includes(full)) return `${path} defines the hooks that run the gate`;
  // Claude Code's and Codex's settings can turn hooks off (disableAllHooks) or drop the plugin.
  const agentFolder = parts.findIndex((part) => part === '.claude' || part === '.codex');
  if (agentFolder !== -1 && (/^(settings(\.local)?\.json|config\.toml|hooks\.json)$/.test(name) || parts[agentFolder + 1] === 'plugins')) return `${path} holds agent settings that can turn the gate off`;
  const state = resolve(stateDir());
  if (full === state || full.startsWith(`${state}${sep}`)) return `${path} is in the pipeline's own ledger`;
  return null;
}

