// The one rule for "the same change". Every approval (review consensus, mutation evidence, carried
// checks, the merged status), every match of a live-hole fix and every projection a ledger stores
// goes through these, so the jj and git backends decide alike.
//
// A commit carries every patch id its backend can compute: in jj its jj id and the normalized git
// id, in git the git id. Two records are the same change when they share a commit id or a patch id.
// A jj change id only ever locates a commit after a rebase or an amend, or refuses: an amend keeps
// its change id and can change its tree, so it never stands for approval.

const firstLine = (text) => String(text ?? '').split('\n')[0] || '(no description)';

// Every patch id a record carries. A record written before patchIds existed reads as its one patchId.
export const patchIdsOf = (record) => [...new Set([...(record?.patchIds ?? []), record?.patchId].filter(Boolean))];

// The projection every ledger site stores, plus the fields that site needs.
export const changeRecord = (commit, extra = {}) => ({
  id: commit.id, changeId: commit.changeId ?? null, patchId: commit.patchId ?? null, patchIds: patchIdsOf(commit),
  ...(commit.gitId === undefined ? {} : { gitId: commit.gitId }), subject: commit.subject ?? firstLine(commit.description), ...extra,
});

// What a record's content is known by: its commit id and each patch id.
export const contentKeys = (record) => [...(record?.id ? [`id:${record.id}`] : []), ...patchIdsOf(record).map((id) => `patch:${id}`)];

export function sameChange(a, b) {
  const keys = new Set(contentKeys(a));
  return contentKeys(b).some((key) => keys.has(key));
}

// Whether a commit has content a patch id stands for. An empty commit or a clean merge has none.
export const hasContent = (record) => patchIdsOf(record).length > 0;

// A jj change id in full. A short one from an older record is never matched: a prefix is not identity.
export const fullChangeId = (id) => (/^[k-z]{32}$/.test(id ?? '') ? id : null);

// Where a recorded commit went after a rebase or an amend: in jj its change id first, then the same
// change, in git the same change only. It only locates: a successor whose content differs gets no
// evidence, which each caller checks with sameChange.
export function findSuccessor(record, commits) {
  const changeId = fullChangeId(record.changeId);
  return (changeId ? commits.find((commit) => commit.changeId === changeId) : null) ?? commits.find((commit) => sameChange(record, commit)) ?? null;
}

// A record's change id in full: as recorded, or read again from its commit when an older record kept
// only 8 characters and the commit is still present. Null when it cannot be recovered.
export function upgradedChangeId(record, vcs) {
  if (fullChangeId(record.changeId)) return record.changeId;
  if (!record.changeId || !record.id || vcs?.backend !== 'jj') return null;
  const found = vcs.changeIdOf(record.id);
  return found && found.startsWith(record.changeId) ? found : null;
}

// The live-hole embargo

// A run whose fix may be live on the deployed server: a live hole, not deployed, and not closed by
// the user. An abandoned run still counts: stopping the work does not close the hole.
export const holeOpen = (run) => Boolean(run.liveHole) && !run.liveHoleClosed && !['passed', 'skipped'].includes(run.stages?.deploy?.state);

// Every commit a run knows: its tips over time, its history and its lanes' commits.
export function knownCommits(run) {
  const lanes = Object.values(run.lanes ?? {});
  return [...new Set([run.tip, run.integration?.tip, ...(run.rebases ?? []).flatMap((rebase) => [rebase.from, rebase.to]), ...lanes.map((lane) => lane.tip), ...(run.history?.ids ?? []), ...lanes.flatMap((lane) => lane.commits.map((commit) => commit.id))].filter(Boolean))];
}

// The git id state of each commit a live-hole run knows: a patch id, 'empty' (no content to match),
// 'unsupported' (a jj octopus merge, which the git read refuses), or missing, which is uncomputed: a
// record from before git ids existed, not read yet.
export const gitIdState = (run, id) => run.gitIds?.[id];

// The states a backend can compute from local objects for the commits a run lacks one for.
export function computeGitIds(vcs, run) {
  const missing = knownCommits(run).filter((id) => gitIdState(run, id) === undefined);
  return missing.length ? vcs.gitIdStates(missing) : new Map();
}

// The git id states a list of commit records carries, for a live-hole run's ledger.
export const recordedGitIds = (commits) => Object.fromEntries(commits.filter((commit) => commit.id && commit.gitId !== undefined).map((commit) => [commit.id, commit.gitId ?? 'empty']));
