// git reads that depend only on the commit: the same bytes under every config and attribute source,
// refusals for what git cannot read in full, the clean check, the mutation tree, the capability
// checks, the runner's environment and the hook in every worktree.

import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHistory } from './fixtures/history.mjs';
import { sandbox } from './helpers.mjs';
import { configHazard } from '../lib/remote.mjs';
import { scanResult } from '../lib/scan.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { range, vcsAt } from '../lib/vcs.mjs';
import { detect } from '../lib/vcs-detect.mjs';
import { agreedRoot, binaryGuard, checkTree, exportTree, git, gitEnv, GitError, gitVcs, hookOf, removalPatch, trackingProblem, where } from '../lib/vcs-git.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = `AKIA${'ABCDEFGHIJKLMNOP'}`;

describe('git reads give the same bytes under every config and attribute source', () => {
  const box = sandbox();
  after(() => box.cleanup());
  Object.assign(process.env, box.env);
  before(() => Object.assign(process.env, box.env));
  const ids = buildHistory(box);
  // Attributes the reads must not follow: a -diff file holding a token, a text file called binary,
  // and a merge whose remerge diff needs rename detection.
  ids.attributes = box.commit('chore: attributes', { '.gitattributes': 'lock.json -diff\n*.dat binary\n', 'lock.json': '{}\n', 'data.dat': 'plain text\n' });
  ids.token = box.commit('chore: lock file', { 'lock.json': `{ "key": "${TOKEN}" }\n`, 'data.dat': 'more plain text\n' });
  ids.renameBase = box.commit('chore: files to rename', { 'r1.txt': 'one\ntwo\nthree\nfour\n', 'r2.txt': 'five\nsix\nseven\neight\n' });
  box.sh('mv r1.txt q1.txt && mv r2.txt q2.txt');
  ids.renamed = box.commit('refactor: rename both');
  box.sh(`jj new ${ids.renameBase}`);
  ids.edited = box.commit('feat: edit both', { 'r1.txt': 'one\ntwo\nthree\nFOUR\n', 'r2.txt': 'five\nsix\nseven\nEIGHT\n' });
  // jj merges without rename detection, so the merge resolves by hand what git's remerge merges
  // cleanly while it detects renames, which the pins keep on.
  box.sh(`jj new ${ids.renamed} ${ids.edited} && rm -f r1.txt r2.txt`);
  ids.renameMerge = box.commit('merge: renames and edits', { 'q1.txt': 'one\ntwo\nthree\nFOUR\n', 'q2.txt': 'five\nsix\nseven\nEIGHT\n' });
  box.sh(`jj bookmark set main -r ${ids.renameMerge} && jj git push --bookmark main`);
  const tips = [ids.renameMerge, ids.x2, ids.y2, ids.orphan];
  const clone = (name) => {
    const dir = join(box.root, name);
    box.sh(`git clone -q ${JSON.stringify(box.bare)} ${JSON.stringify(dir)}`, box.root);
    return dir;
  };
  const plain = clone('plain');
  const second = clone('second');
  const read = (dir) => {
    const vcs = gitVcs(dir);
    return { records: vcs.listCommits(range(tips)), patches: [...vcs.commitPatches(range(tips))].sort(), files: vcs.filesAt(ids.renameMerge) };
  };
  const want = read(plain);
  const marker = join(box.root, 'ran');
  const program = `touch ${JSON.stringify(marker)}; exit 1`;
  const configs = [
    ['diff.suppressBlankEmpty', 'true'], ['diff.indentHeuristic', 'false'], ['merge.conflictStyle', 'zdiff3'], ['merge.conflictStyle', 'diff3'],
    ['core.bigFileThreshold', '1'], ['log.showSignature', 'true'], ['diff.external', program], ['diff.noprefix', 'true'], ['diff.algorithm', 'histogram'],
    ['core.quotePath', 'true'], ['diff.renameLimit', '1'], ['merge.renameLimit', '1'], ['merge.default', 'mine'], ['core.attributesFile', join(box.root, 'attributes')],
  ];
  writeFileSync(join(box.root, 'attributes'), '* -diff\n* binary\n');

  test('the plain clone reads text through -diff and binary attributes, and the token is found', () => {
    const patches = new Map(want.patches);
    assert.match(patches.get(ids.token), new RegExp(`^\\+\\{ "key": "${TOKEN}" \\}$`, 'm'));
    assert.match(patches.get(ids.token), /^\+more plain text$/m);
    const commits = want.records.filter((commit) => commit.id === ids.token);
    const result = scanResult(commits, new Map([[ids.token, patches.get(ids.token)]]), { ...DEFAULTS, commits: { ...DEFAULTS.commits, acceptedSignatures: ['none'] } });
    assert.ok(result.errors.some((finding) => finding.text === 'AWS key' && finding.where.endsWith('lock.json:1')), JSON.stringify(result.errors));
    assert.match(patches.get(ids.renameMerge), /^$|^diff/);
  });

  for (const [key, value] of configs) {
    test(`${key}=${value.length > 30 ? 'a program' : value} changes nothing`, () => {
      box.sh(`git config ${key} "$VALUE"`, second, { VALUE: value });
      if (key === 'merge.default') box.sh(`git config merge.mine.driver "$VALUE"`, second, { VALUE: program });
      try {
        assert.deepEqual(read(second), want);
        assert.equal(existsSync(marker), false, 'a configured program ran');
      } finally {
        box.sh(`git config --unset-all ${key}`, second);
        if (key === 'merge.default') box.sh('git config --remove-section merge.mine', second);
      }
    });
  }

  test('an uncommitted .gitattributes changes nothing', () => {
    writeFileSync(join(second, '.gitattributes'), '* -diff\n* binary\n');
    try {
      assert.deepEqual(read(second), want);
    } finally {
      box.sh('git checkout -- .gitattributes', second);
    }
  });

  test('a non-empty info/attributes is refused, and a merge.text driver in any scope before any read runs it', () => {
    const info = join(second, '.git', 'info', 'attributes');
    mkdirSync(dirname(info), { recursive: true });
    writeFileSync(info, '* -diff\n');
    try {
      assert.match(configHazard(second, { readsOnly: true }), /info\/attributes/);
    } finally {
      rmSync(info);
    }
    const global = readFileSync(box.env.GIT_CONFIG_GLOBAL, 'utf8');
    writeFileSync(box.env.GIT_CONFIG_GLOBAL, `${global}[merge "text"]\n\tdriver = ${program}\n`);
    try {
      assert.match(configHazard(second, { readsOnly: true }), /merge\.text\.driver/);
      assert.equal(existsSync(marker), false);
    } finally {
      writeFileSync(box.env.GIT_CONFIG_GLOBAL, global);
    }
    assert.equal(configHazard(second, { readsOnly: true }), null);
  });

  test('in jj too, since its git ids come from the same read', () => {
    const info = join(box.repo, '.git', 'info', 'attributes');
    mkdirSync(dirname(info), { recursive: true });
    writeFileSync(info, '* -diff\n');
    try {
      assert.match(configHazard(box.repo, { readsOnly: true }), /info\/attributes/);
    } finally {
      rmSync(info);
    }
    assert.equal(configHazard(box.repo, { readsOnly: true }), null);
  });

  test('an octopus merge is refused, since git cannot diff it in full', () => {
    const dir = clone('octopus');
    box.sh(`git checkout -q -b a ${ids.base} && echo a > oa.txt && git add oa.txt && git commit -q -m a && git checkout -q -b b ${ids.base} && echo b > ob.txt && git add ob.txt && git commit -q -m b && git checkout -q -b c ${ids.base} && git merge -q --no-ff --no-commit a b && echo token > added.txt && git add added.txt && git commit -q -m octopus`, dir);
    const tip = box.sh('git rev-parse HEAD', dir).trim();
    assert.throws(() => gitVcs(dir).listCommits(range(tip, ids.base)), /octopus merge .* in full/);
    assert.throws(() => gitVcs(dir).commitPatches(range(tip, ids.base)), /octopus merge/);
  });

  test('the binary guard throws when a file marked binary holds text', () => {
    const vcs = gitVcs(plain);
    const [before, afterBlob] = box.sh(`git rev-parse ${ids.modify}^:a.txt ${ids.modify}:a.txt`, plain).trim().split('\n');
    const fake = `diff --git a/a.txt b/a.txt\nindex ${before}..${afterBlob} 100644\nBinary files a/a.txt and b/a.txt differ\n`;
    assert.throws(() => binaryGuard(vcs.at, new Map([[ids.modify, fake]])), GitError);
    const [binBefore, binAfter] = box.sh(`git rev-parse ${ids.binary}^:img.bin ${ids.binary}:img.bin`, plain).trim().split('\n');
    binaryGuard(vcs.at, new Map([[ids.binary, `diff --git a/img.bin b/img.bin\nindex ${binBefore}..${binAfter} 100644\nBinary files a/img.bin and b/img.bin differ\n`]]));
  });
});

describe('the clean check and the mutation tree in git', () => {
  const box = sandbox();
  after(() => box.cleanup());
  Object.assign(process.env, box.env);
  before(() => Object.assign(process.env, box.env));
  const dir = join(box.root, 'clean');
  box.sh(`git clone -q ${JSON.stringify(box.bare)} ${JSON.stringify(dir)}`, box.root);
  const sub = join(box.root, 'sub-origin');
  box.sh(`git init -q ${JSON.stringify(sub)} && cd ${JSON.stringify(sub)} && echo s > s.txt && git add s.txt && git commit -q -m s`, box.root);
  box.sh(`git -c protocol.file.allow=always submodule add -q ${JSON.stringify(sub)} sub && git commit -q -m "chore: a submodule"`, dir);
  const vcs = gitVcs(dir);

  test('the removal patch of a root commit, and a clear failure when a merge leaves a path as its first parent has it', () => {
    const at = where(dir, detect(dir).gitDir);
    const root = box.sh('git rev-list --max-parents=0 HEAD', dir).trim();
    assert.match(removalPatch(at, root, ['README.md']), /^\+# demo$/m);
    box.sh('git checkout -q -b side HEAD~1 && echo side > side.txt && git add side.txt && git commit -q -m side && git checkout -q - && git merge -q --no-ff -m "merge: side" side', dir);
    const merge = box.sh('git rev-parse HEAD', dir).trim();
    assert.throws(() => removalPatch(at, merge, ['README.md']), /git gives no change to README\.md in \S+ against its first parent, so there is no fix to remove/);
    assert.match(removalPatch(at, merge, ['side.txt']), /^\+side$/m);
    box.sh('git reset -q --hard HEAD~1 && git branch -q -D side', dir);
  });

  test('a clean worktree is on HEAD, and an untracked file is uncommitted work', () => {
    const head = box.sh('git rev-parse HEAD', dir).trim();
    assert.deepEqual(vcs.workingCopy(), { at: head, dirty: false, sitsOn: [head] });
    writeFileSync(join(dir, 'untracked.txt'), 'x\n');
    try {
      assert.equal(vcs.workingCopy().dirty, true);
    } finally {
      rmSync(join(dir, 'untracked.txt'));
    }
  });

  test('assume-unchanged and skip-worktree make the worktree unfit for checks', () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      box.sh(`git update-index ${flag} README.md`, dir);
      try {
        assert.throws(() => vcs.workingCopy(), /git status cannot see edits to README\.md/);
      } finally {
        box.sh(`git update-index ${flag.replace('--', '--no-')} README.md`, dir);
      }
    }
  });

  test('a submodule with new commits is a change, whatever its ignore setting says', () => {
    box.sh('git config -f .gitmodules submodule.sub.ignore all && git config submodule.sub.ignore all && git add .gitmodules && git commit -q -m "chore: ignore the submodule"', dir);
    box.sh('echo t > t.txt && git add t.txt && git commit -q -m t', join(dir, 'sub'));
    try {
      assert.equal(vcs.workingCopy().dirty, true);
    } finally {
      box.sh('git checkout -q HEAD~1', join(dir, 'sub'));
    }
    assert.equal(vcs.workingCopy().dirty, false);
  });

  test('a clean filter and eol rules read clean after a touch', () => {
    box.sh(`git config filter.upper.clean "tr a-z A-Z" && git config filter.upper.smudge cat && printf '*.up filter=upper\\n*.crlf text eol=crlf\\n' > .gitattributes && printf 'abc\\n' > f.up && printf 'one\\ntwo\\n' > w.crlf && git add .gitattributes f.up w.crlf && git commit -q -m "chore: filters" && rm f.up w.crlf && git checkout -- f.up w.crlf && touch f.up w.crlf`, dir);
    assert.equal(vcs.workingCopy().dirty, false);
  });

  test('the mutation tree holds the commit\'s exact bytes and modes, export-ignore files and links included', () => {
    box.sh(`printf 'secret.txt export-ignore\\n*.txt text eol=crlf\\nid.txt ident\\n*.up filter=upper\\n' > .gitattributes && printf 'kept\\n' > secret.txt && printf 'a\\nb\\n' > lines.txt && printf '$Id$\\n' > id.txt && printf 'low\\n' > g.up && printf 'echo hi\\n' > run.sh && chmod +x run.sh && ln -s lines.txt link.txt && git add -A && git commit -q -m "chore: every attribute"`, dir);
    box.sh('git config core.autocrlf true', dir);
    const id = box.sh('git rev-parse HEAD', dir).trim();
    const base = join(box.root, 'mutation');
    const tree = exportTree(vcs.at, id, join(base, 'tree'), join(base, 'index'));
    assert.equal(readFileSync(join(tree, 'secret.txt'), 'utf8'), 'kept\n');
    assert.equal(readFileSync(join(tree, 'lines.txt'), 'utf8'), 'a\nb\n');
    assert.equal(readFileSync(join(tree, 'id.txt'), 'utf8'), '$Id$\n');
    assert.equal(readFileSync(join(tree, 'g.up'), 'utf8'), 'LOW\n');
    assert.ok(spawnSync('test', ['-x', join(tree, 'run.sh')]).status === 0);
    // A tree altered on purpose fails the check.
    writeFileSync(join(tree, 'lines.txt'), 'a\r\nb\r\n');
    assert.throws(() => checkTree(vcs.at, id, tree), /did not come out as the commit holds it .*lines\.txt/);
    writeFileSync(join(tree, 'lines.txt'), 'a\nb\n');
    chmodSync(join(tree, 'run.sh'), 0o644);
    assert.throws(() => checkTree(vcs.at, id, tree), /run\.sh has the wrong executable bit/);
    chmodSync(join(tree, 'run.sh'), 0o755);
    rmSync(join(tree, 'link.txt'));
    symlinkSync('secret.txt', join(tree, 'link.txt'));
    assert.throws(() => checkTree(vcs.at, id, tree), /link\.txt is not the link/);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('what a git repository must be, and the runner\'s environment', () => {
  const box = sandbox();
  after(() => box.cleanup());
  Object.assign(process.env, box.env);
  before(() => Object.assign(process.env, box.env));
  box.sh(`git -C ${JSON.stringify(box.bare)} config uploadpack.allowFilter true`);
  const clone = (name, flags = '') => {
    const dir = join(box.root, name);
    box.sh(`git clone -q ${flags} file://${box.bare} ${JSON.stringify(dir)}`, box.root);
    return dir;
  };
  const full = clone('full');
  const node = (script, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...env }, encoding: 'utf8' });

  test('a full sha1 clone passes, and the folder\'s root agrees with git\'s from any subfolder', () => {
    assert.equal(configHazard(full, { readsOnly: true }), null);
    mkdirSync(join(full, 'deep', 'er'), { recursive: true });
    assert.equal(agreedRoot(join(full, 'deep', 'er')), detect(full).root);
  });

  test('the runner clears GIT_DIR, GIT_INDEX_FILE and GIT_CONFIG, and keeps transport settings', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_DIR: '/nowhere', GIT_INDEX_FILE: '/nowhere/index', GIT_CONFIG: '/nowhere/config', GIT_SSL_CAINFO: '/ca.pem', GIT_PROXY_COMMAND: '/bin/false' });
    try {
      const env = { ...process.env, ...gitEnv(where(full, detect(full).gitDir, full)) };
      assert.equal(env.GIT_DIR, detect(full).gitDir);
      assert.equal(env.GIT_INDEX_FILE, undefined);
      assert.equal(env.GIT_CONFIG, undefined);
      assert.equal(env.GIT_SSL_CAINFO, '/ca.pem');
      assert.equal(env.GIT_PROXY_COMMAND, '/bin/false');
      assert.equal(gitVcs(full).revisions('HEAD')[0], box.sh('git rev-parse HEAD', full).trim());
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  test('GIT_SSL_CAINFO and GIT_PROXY_COMMAND reach the runner\'s ls-remote, and GIT_CONFIG does not', () => {
    const seen = join(box.root, 'proxy-saw');
    const proxy = join(box.root, 'proxy.sh');
    writeFileSync(proxy, `#!/bin/sh\necho "cainfo=$GIT_SSL_CAINFO config=$GIT_CONFIG" > ${JSON.stringify(seen)}\nexit 1\n`);
    chmodSync(proxy, 0o755);
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_SSL_CAINFO: '/ca.pem', GIT_PROXY_COMMAND: proxy, GIT_CONFIG: join(box.root, 'other-config') });
    try {
      assert.throws(() => git(where(full, detect(full).gitDir), ['ls-remote', 'git://example.invalid/x']), GitError);
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
    assert.equal(readFileSync(seen, 'utf8').trim(), 'cainfo=/ca.pem config=');
  });

  test('a risky local key is found while GIT_CONFIG is set, in git and in jj', () => {
    box.sh('git config core.sshCommand "ssh -i key"', full);
    box.sh('git config core.sshCommand "ssh -i key"');
    writeFileSync(join(box.root, 'empty-config'), '');
    const saved = process.env.GIT_CONFIG;
    process.env.GIT_CONFIG = join(box.root, 'empty-config');
    try {
      assert.match(configHazard(full), /core\.sshcommand/);
      assert.match(configHazard(box.repo), /core\.sshcommand/);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG; else process.env.GIT_CONFIG = saved;
      box.sh('git config --unset core.sshCommand', full);
      box.sh('git config --unset core.sshCommand');
    }
  });

  test('a git older than 2.41 is refused', () => {
    const shim = join(box.root, 'shim');
    mkdirSync(shim);
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(shim, 'git'), `#!/bin/sh\nif [ "$1" = version ]; then echo "git version 2.39.5"; exit 0; fi\nexec ${real} "$@"\n`);
    chmodSync(join(shim, 'git'), 0o755);
    const result = node(`import { gitCapable, where } from ${JSON.stringify(join(PLUGIN, 'lib', 'vcs-git.mjs'))}; console.log(gitCapable(where(${JSON.stringify(full)}, ${JSON.stringify(detect(full).gitDir)})));`, { PATH: `${shim}:${process.env.PATH}` });
    assert.match(result.stdout, /git 2\.39 is older than 2\.41, which the pipeline needs in a git repository/);
  });

  test('a sha256 repository, a partial clone, a shallow clone and a single-branch clone are refused', () => {
    const sha256 = join(box.root, 'sha256');
    box.sh(`git init -q --object-format=sha256 ${JSON.stringify(sha256)} && cd ${JSON.stringify(sha256)} && echo x > x && git add x && git commit -q -m x`, box.root);
    assert.match(configHazard(sha256, { readsOnly: true }), /sha256 object ids/);
    assert.match(configHazard(clone('partial', '--filter=blob:none'), { readsOnly: true }), /partial clone/);
    assert.match(configHazard(clone('shallow', '--depth=1'), { readsOnly: true }), /shallow clone.*git fetch --unshallow origin/);
    const single = clone('single', '--single-branch --branch main');
    box.sh('git config --replace-all remote.origin.fetch +refs/heads/main:refs/remotes/origin/main', single);
    assert.match(trackingProblem(where(single, detect(single).gitDir), 'origin'), /git remote set-branches origin '\*' and git fetch --prune origin/);
    assert.match(configHazard(single, { remote: 'origin' }), /set-branches/);
    assert.equal(trackingProblem(where(full, detect(full).gitDir), 'origin'), null);
  });

  test('the hook in every worktree: ok, missing and unverified, husky included', () => {
    const hooks = join(full, '.git', 'hooks');
    rmSync(join(hooks, 'pre-push'), { force: true });
    assert.equal(hookOf(full).state, 'missing');
    symlinkSync(join(PLUGIN, 'git-hooks', 'pre-push'), join(hooks, 'pre-push'));
    assert.equal(hookOf(full).state, 'ok');
    // A linked worktree with a relative hooks path reads its own folder.
    const linked = join(box.root, 'linked');
    box.sh(`git worktree add -q ${JSON.stringify(linked)} -b lane/x`, full);
    box.sh('git config core.hooksPath .husky/_', full);
    assert.equal(hookOf(linked).state, 'missing');
    mkdirSync(join(linked, '.husky', '_'), { recursive: true });
    writeFileSync(join(linked, '.husky', '_', 'pre-push'), '#!/bin/sh\n. "$(dirname "$0")/h"\n');
    assert.equal(hookOf(linked).state, 'missing');
    chmodSync(join(linked, '.husky', '_', 'pre-push'), 0o755);
    assert.equal(hookOf(linked).state, 'unverified');
    box.sh('git config --unset core.hooksPath', full);
    assert.equal(hookOf(linked).state, 'ok');
  });
});

// The CLI reads the remote through git's tracking refs, so a remote it reads that tracks only some
// branches gets the same refusal the gate gives, never a report that the gate is off.
describe('the CLI and a remote that tracks only some branches', () => {
  const box = sandbox({ backend: 'git' });
  after(() => box.cleanup());
  const SET_BRANCHES = (remote) => new RegExp(`git fetches only some branches of ${remote} here.*git remote set-branches ${remote} '\\*'`);

  test('a bare clone\'s worktree without a fetch refspec', () => {
    const bare = join(box.root, 'bare.git');
    const tree = join(box.root, 'tree');
    box.sh(`git clone -q --bare https://github.com/example-owner/demo.git ${JSON.stringify(bare)} && git -C ${JSON.stringify(bare)} worktree add -q ${JSON.stringify(tree)} -b t main`, box.root);
    const result = box.cli(['config', '--check'], { cwd: tree });
    assert.notEqual(result.code, 0, result.all);
    assert.match(result.all, SET_BRANCHES('origin'));
    assert.doesNotMatch(result.all, /the gate is off/);
  });

  test('the remote the committed config names, not the one read first', () => {
    const redirected = sandbox({ config: { remote: 'upstream' }, backend: 'git' });
    try {
      redirected.sh(`git remote add -t main upstream https://github.com/example-owner/demo.git && git fetch -q upstream`);
      const result = redirected.cli(['config', '--check']);
      assert.notEqual(result.code, 0, result.all);
      assert.match(result.all, SET_BRANCHES('upstream'));
    } finally {
      redirected.cleanup();
    }
  });
});
