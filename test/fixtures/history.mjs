// One history for the backend tests: the patch-id experiment's commits (a binary file, edits, adds
// and deletes, renames with and without edits, a mode change, no final newline, a C file, reordered
// functions), an empty commit, a second git root, a non-ASCII path, a conflicted merge and a
// criss-cross pair of merges. Built in a colocated jj sandbox and pushed, so a plain git clone and a
// plain jj clone of the remote hold the same commits.

import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function buildHistory(box) {
  const at = (path) => join(box.repo, path);
  const head = () => box.sh('jj log --no-graph -r @- -T commit_id').trim();
  const step = (message, change) => {
    change();
    box.sh('jj commit -m "$MESSAGE"', box.repo, { MESSAGE: message });
    return head();
  };
  const ids = {};
  // Three functions moved around: jj's diff and git's Myers diff split this change differently.
  const fn = (name, n) => `function ${name}(value) {\n  const result = value + ${n};\n  if (result > 10) {\n    return result;\n  }\n  return 0;\n}\n`;
  const funcs = fn('first', 1) + fn('second', 2) + fn('third', 3);
  ids.base = step('feat: base with a binary file', () => {
    writeFileSync(at('img.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00, 0x0a, 0x41]));
    for (const [name, text] of Object.entries({ 'a.txt': 'one\ntwo\nthree\n', 'del.txt': 'gone soon\n', 'old.txt': 'alpha\nbeta\ngamma\ndelta\n', 'pure.txt': 'same\n', 'funcs.js': funcs, 'mode.sh': 'echo hi\n', 'c.txt': 'shared\n' })) writeFileSync(at(name), text);
  });
  ids.modify = step('feat: modify a line', () => writeFileSync(at('a.txt'), 'one\nTWO\nthree\n'));
  ids.addDelete = step('feat: add one file and delete another', () => { writeFileSync(at('new.txt'), 'new\n'); rmSync(at('del.txt')); });
  ids.renameEdit = step('refactor: rename with edits', () => { renameSync(at('old.txt'), at('renamed.txt')); writeFileSync(at('renamed.txt'), 'alpha\nbeta\ngamma\nDELTA\n'); });
  ids.mode = step('chore: make the script executable', () => chmodSync(at('mode.sh'), 0o755));
  ids.noNewline = step('feat: a file without a final newline', () => writeFileSync(at('nofinal.txt'), 'no newline'));
  ids.cFile = step('feat: add a C file', () => writeFileSync(at('x.c'), 'int main(void) { return 0; }\n'));
  ids.pureRename = step('refactor: pure rename', () => renameSync(at('pure.txt'), at('pure2.txt')));
  ids.binary = step('feat: change the binary file', () => writeFileSync(at('img.bin'), Buffer.from([0x89, 0x50, 0x00, 0x09, 0x02, 0x00, 0x0a, 0x42, 0x43])));
  ids.reorder = step('refactor: reorder functions', () => writeFileSync(at('funcs.js'), fn('third', 3) + fn('first', 1) + fn('second', 2)));
  ids.empty = step('chore: an empty commit', () => {});
  ids.nonAscii = step('docs: a path that is not ascii', () => writeFileSync(at('naïve résumé.txt'), 'café\n'));
  // A conflicted merge, resolved in the merge itself.
  const fork = ids.nonAscii;
  ids.left = step('feat: left side', () => writeFileSync(at('c.txt'), 'left\n'));
  box.sh(`jj new ${fork}`);
  ids.right = step('feat: right side', () => writeFileSync(at('c.txt'), 'right\n'));
  box.sh(`jj new ${ids.left} ${ids.right}`);
  ids.conflictMerge = step('merge: resolve left and right', () => writeFileSync(at('c.txt'), 'both\n'));
  // Criss-cross: two merges that each take the other side first.
  box.sh(`jj new ${ids.conflictMerge}`);
  ids.x1 = step('feat: x one', () => writeFileSync(at('x.txt'), 'x\n'));
  box.sh(`jj new ${ids.conflictMerge}`);
  ids.y1 = step('feat: y one', () => writeFileSync(at('y.txt'), 'y\n'));
  box.sh(`jj new ${ids.x1} ${ids.y1}`);
  ids.x2 = step('merge: x two', () => {});
  box.sh(`jj new ${ids.y1} ${ids.x1}`);
  ids.y2 = step('merge: y two', () => {});
  // A second git root, with no parent but jj's root.
  box.sh('jj new "root()"');
  ids.orphan = step('feat: a second root', () => writeFileSync(at('orphan.txt'), 'alone\n'));
  box.sh(`jj new ${ids.conflictMerge}`);
  for (const [name, id] of [['main', ids.conflictMerge], ['x2', ids.x2], ['y2', ids.y2], ['orphan', ids.orphan]]) box.sh(`jj bookmark set ${name} -r ${id} --allow-backwards`);
  box.sh('jj git push --bookmark main --bookmark x2 --bookmark y2 --bookmark orphan --allow-new 2>/dev/null || jj git push --bookmark main --bookmark x2 --bookmark y2 --bookmark orphan');
  return ids;
}
