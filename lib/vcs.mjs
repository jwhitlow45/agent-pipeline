// The version control a folder uses, behind one interface. Callers never build revsets: a range is
// a value, { tips, not }, meaning every ancestor of the tips that is no ancestor of anything in
// `not`, and a revision someone typed is resolved once and is a commit id from then on.

import { fail, short } from './util.mjs';
import { detect } from './vcs-detect.mjs';
import { COMMANDS, gitVcs, RevisionError } from './vcs-git.mjs';
import { jjRoot, jjVcs, RevsetError } from './vcs-jj.mjs';

export { RevsetError } from './vcs-jj.mjs';
export { COMMANDS, committedFileIn, FileReadError, GitError, gitRepository, gitSetting, hookOf, RevisionError } from './vcs-git.mjs';

// One backend per folder and process, chosen from the folder: a check reads the same repository many times.
const opened = new Map();
export function vcsAt(dir) {
  if (!opened.has(dir)) opened.set(dir, detect(dir).backend === 'git' ? gitVcs(dir) : jjVcs(dir));
  return opened.get(dir);
}

// The command text for the backend a folder uses, for messages built before a context exists.
export const commandsFor = (dir) => COMMANDS[detect(dir).backend ?? 'jj'];

// The root of the workspace a folder is in, or null outside every repository.
export const root = (dir) => jjRoot(dir);

export const range = (tips, not = []) => ({ tips: [tips].flat().filter(Boolean), not: [not].flat().filter(Boolean) });

// The remote trunk, where every range starts. The local trunk branch is never used: an agent can
// move it without pushing, which would empty the ranges the gate checks. The context sets
// `trunkSha`: for the gate, the commit the remote itself reports, so a forged remote-tracking ref
// cannot move it either. Null for a repository whose trunk was never pushed, whose ranges then hold
// every commit.
export const trunkId = (vcs, config) => (config.trunkSha !== undefined ? config.trunkSha ?? null : vcs.remoteBranch(config.trunk, config.remote));

// The commits from the remote trunk to a tip.
export const trunkRange = (vcs, config, tip) => range(tip, trunkId(vcs, config));

// Exactly one commit for a revision someone typed, or a usage error that says what went wrong.
export function resolveOne(vcs, rev, what = rev) {
  let ids;
  try {
    ids = vcs.revisions(rev);
  } catch (error) {
    if (error instanceof RevsetError || error instanceof RevisionError) fail(`${what} is not a revision here: ${error.message}`);
    throw error;
  }
  if (ids.length !== 1) fail(`${what} must resolve to exactly one commit, found ${ids.length}.`);
  return ids[0];
}

export const resolveTip = (vcs, rev) => resolveOne(vcs, rev ?? vcs.defaultTip, `--tip ${rev ?? '(default)'}`);

export const firstLine = (description) => description.split('\n')[0] || '(no description)';

// Every path a commit touches, both sides of a rename included.
export const touchedPaths = (commit) => [...new Set(commit.files.flatMap((file) => [file.source, file.path]))];

export const describeCommit = (commit) => `${short(commit.id)} ${firstLine(commit.description)}`;
