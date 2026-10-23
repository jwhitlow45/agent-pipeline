// The follow-up backlog. A P3 finding never holds a review open for another round: it is recorded
// here, and later batched into lanes. Items name the files they touch, so the planner can give each
// lane files no other lane touches, and parallel builders never edit the same file.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeJson } from './lock.mjs';
import { fail, now, sha256, stateDir } from './util.mjs';

const SEVERITY = /^P[0-3]$/;

const backlogPath = (identity) => join(stateDir(), 'followups', `${sha256(identity).slice(0, 16)}.json`);

export function loadBacklog(identity) {
  const path = backlogPath(identity);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { identity, items: [] };
}

// Rereads the backlog under its lock, applies the change, and saves it, so two agents adding items at once both keep theirs.
export function updateBacklog(identity, change) {
  const path = backlogPath(identity);
  return withLock(path, () => {
    const backlog = loadBacklog(identity);
    const result = change(backlog);
    writeJson(path, backlog);
    return result;
  });
}

export function addItem(backlog, { id, severity, source, text, files, decision }, config, decisionLogged) {
  if (!id) fail('--id is required.');
  if (backlog.items.some((item) => item.id === id)) fail(`${id} is already in the backlog.`);
  if (!SEVERITY.test(severity ?? '')) fail('--severity must be P0, P1, P2 or P3.');
  if (!text) fail('--text is required: what to change, in a sentence or two.');
  // P0 to P2 block a review. Deferring one is a decision the log must hold, not a quiet move to the backlog.
  if (severity !== 'P3' && config.followups.blockingNeedsDecision) {
    if (!decision) fail(`${id} is ${severity}, which blocks review. Defer it only with --decision <ID> naming the logged decision that defers it.`);
    if (!decisionLogged(decision)) fail(`Decision ${decision} is not in the decision log.`);
  }
  const item = { id, severity, source: source ?? null, text, files: files ?? [], decision: decision ?? null, status: 'open', addedAt: now() };
  backlog.items.push(item);
  return item;
}

// Groups items that share a file (they must go to one lane), then deals the groups to `lanes` lanes,
// largest first, each to the lane with the fewest items. Items without files each form their own group.
export function planLanes(items, lanes) {
  if (!(lanes >= 1)) fail('--lanes must be at least 1.');
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  items.forEach((item, i) => {
    for (const file of item.files) {
      if (owner.has(file)) parent[find(i)] = find(owner.get(file));
      else owner.set(file, i);
    }
  });
  const groups = new Map();
  items.forEach((item, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), item]));
  const plan = Array.from({ length: lanes }, (_, i) => ({ lane: String.fromCharCode(97 + i), items: [], files: [] }));
  for (const group of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const target = plan.reduce((best, lane) => (lane.items.length < best.items.length ? lane : best));
    target.items.push(...group);
    target.files.push(...new Set(group.flatMap((item) => item.files)));
  }
  return plan.filter((lane) => lane.items.length);
}

export function renderBacklog(backlog, { open = false } = {}) {
  const items = backlog.items.filter((item) => !open || item.status !== 'done');
  if (!items.length) return 'The backlog is empty.';
  return ['| ID | Sev | Status | Source | Files | Text |', '|---|---|---|---|---|---|',
    ...items.map((item) => `| ${item.id} | ${item.severity} | ${item.status}${item.commit ? ` ${item.commit.slice(0, 8)}` : ''} | ${item.source ?? ''} | ${item.files.join(', ')} | ${item.text.replaceAll('|', '\\|')} |`)].join('\n');
}
