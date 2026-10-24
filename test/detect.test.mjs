// Finding the backend from the folder: every layout of the design's table, from its root and from a
// subfolder, and random nestings checked against what jj and git themselves find.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.mjs';
import { clonesOf, holdsStore, register, registeredRepos } from '../lib/registry.mjs';
import { detect } from '../lib/vcs-detect.mjs';
import { agreedRoot, gitVcs } from '../lib/vcs-git.mjs';

const root = realpathSync(tempDir('pipeline-detect-'));
writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
writeFileSync(join(root, 'jj.toml'), '[user]\nname = "Test"\nemail = "test@example.com"\n[signing]\nbehavior = "drop"\n');
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', JJ_CONFIG: join(root, 'jj.toml') };
for (const name of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)$/.test(name)) delete env[name];
const sh = (command, cwd = root) => {
  const result = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const commit = (dir) => sh('echo x > f.txt && git add f.txt && git commit -q -m one', dir);
const folder = (...parts) => {
  const dir = join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('detect, row by row of the layout table', () => {
  const colocated = folder('colocated');
  sh('jj git init --colocate >/dev/null 2>&1', colocated);
  const plain = folder('plain');
  sh('jj git init --no-colocate >/dev/null 2>&1', plain);
  sh(`jj workspace add ${JSON.stringify(join(root, 'second'))}`, colocated);
  const main = folder('main');
  sh('git init -q && echo x > f.txt && git add f.txt && git commit -q -m one', main);
  sh(`git worktree add -q ${JSON.stringify(join(root, 'linked'))}`, main);
  sh(`git init -q --separate-git-dir ${JSON.stringify(join(root, 'separate.git'))} separate`);
  commit(join(root, 'separate'));
  sh('git init -q --bare bare.git');
  sh(`git -C bare.git worktree add -q ${JSON.stringify(join(root, 'bare-wt'))} 2>/dev/null || git -C bare.git worktree add -q --orphan -b main ${JSON.stringify(join(root, 'bare-wt'))}`);
  commit(join(root, 'bare-wt'));
  sh('git init -q super && git -C super submodule add -q ../main sub');
  sh(`git -C colocated worktree add -q ${JSON.stringify(join(root, 'jj-wt'))} 2>/dev/null || (cd colocated && jj commit -m one && git worktree add -q ${JSON.stringify(join(root, 'jj-wt'))})`);
  const empty = folder('nothing');

  const rows = [
    ['jj, colocated', 'colocated', { backend: 'jj', layout: 'jj', root: 'colocated', store: 'colocated/.jj/repo', configDir: 'colocated', main: 'colocated' }],
    ['jj, not colocated', 'plain', { backend: 'jj', layout: 'jj', root: 'plain', store: 'plain/.jj/repo', configDir: 'plain' }],
    ['jj, a second workspace', 'second', { backend: 'jj', layout: 'jj-workspace', root: 'second', store: 'colocated/.jj/repo', configDir: 'colocated' }],
    ['git, main worktree', 'main', { backend: 'git', layout: 'git', root: 'main', store: 'main/.git', gitDir: 'main/.git', configDir: 'main', main: 'main' }],
    ['git, linked worktree', 'linked', { backend: 'git', layout: 'git-worktree', root: 'linked', store: 'main/.git', gitDir: 'main/.git/worktrees/linked', configDir: 'main', main: 'main', bare: false }],
    ['git, separate git folder', 'separate', { backend: 'git', layout: 'git-separate', root: 'separate', store: 'separate.git', configDir: 'separate' }],
    ['worktree of a bare repository', 'bare-wt', { backend: 'git', layout: 'git-worktree', root: 'bare-wt', store: 'bare.git', configDir: 'bare.git', main: 'bare-wt', bare: true }],
    ['submodule', 'super/sub', { backend: 'git', layout: 'git-separate', root: 'super/sub', store: 'super/.git/modules/sub', configDir: 'super/sub' }],
    ['git worktree of a colocated jj repository', 'jj-wt', { backend: null, root: 'jj-wt', refused: /git worktree of the jj repository/ }],
    ['a bare repository itself', 'bare.git', { backend: null, bare: 'bare.git' }],
    ['no marker', 'nothing', { backend: null, root: null }],
  ];
  for (const [name, where, want] of rows) {
    for (const sub of ['', 'deeper/still']) {
      test(`${name}${sub ? ', from a subfolder' : ''}`, () => {
        const dir = !sub ? join(root, where) : where === 'bare.git' ? join(root, where, 'refs', 'heads') : folder(where, sub);
        const found = detect(dir);
        for (const [key, value] of Object.entries(want)) {
          if (value instanceof RegExp) assert.match(found[key] ?? '', value, key);
          else assert.equal(found[key], typeof value === 'string' && key !== 'backend' && key !== 'layout' ? join(root, value) : value, key);
        }
      });
    }
  }
  test('the empty folder holds nothing', () => assert.equal(detect(empty).backend, null));

  // detect, git's own root and the runner agree for every git layout, from the root and from a
  // subfolder, even with a GIT_DIR left in the environment, as git exports to hooks.
  for (const where of ['main', 'linked', 'separate', 'bare-wt', 'super/sub']) {
    test(`detect, git and the runner agree in ${where}`, () => {
      for (const dir of [join(root, where), folder(where, 'deeper/still')]) {
        const want = sh('git rev-parse HEAD', dir);
        assert.equal(agreedRoot(dir), detect(dir).root);
        const saved = process.env.GIT_DIR;
        process.env.GIT_DIR = join(root, 'main', '.git');
        try {
          Object.assign(process.env, { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
          assert.deepEqual(gitVcs(dir).revisions('HEAD'), [want]);
        } finally {
          if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
        }
      }
    });
  }
});

describe('detect, random nestings', () => {
  // A small seeded generator, so a failing nesting can be built again from its seed.
  const seed = Number(process.env.DETECT_SEED ?? Date.now() % 100000);
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const kinds = ['folder', 'folder', 'jj', 'jj-plain', 'git', 'git'];
  const make = (dir, kind) => {
    mkdirSync(dir, { recursive: true });
    if (kind === 'jj') sh('jj git init --colocate >/dev/null 2>&1', dir);
    if (kind === 'jj-plain') sh('jj git init --no-colocate >/dev/null 2>&1', dir);
    if (kind === 'git') sh('git init -q', dir);
  };
  // What detect must find: the nearest marker, except that inside a jj workspace jj's discovery wins.
  const expected = (chain) => {
    const nearest = chain.findLastIndex((entry) => entry.kind !== 'folder');
    if (nearest === -1) return null;
    const jj = chain.findLastIndex((entry) => entry.kind.startsWith('jj'));
    return chain[chain[nearest].kind === 'git' && jj !== -1 ? jj : nearest];
  };
  for (let trial = 0; trial < 6; trial++) {
    test(`nesting ${trial + 1} (seed ${seed})`, () => {
      const chain = [];
      let dir = folder(`nest-${seed}-${trial}`);
      for (let depth = 0; depth < 4; depth++) {
        dir = join(dir, `n${depth}`);
        const kind = pick(kinds);
        make(dir, kind);
        chain.push({ dir, kind });
      }
      for (let i = 0; i < chain.length; i++) {
        const here = chain.slice(0, i + 1);
        const want = expected(here);
        const found = detect(chain[i].dir);
        const shape = here.map((entry) => entry.kind).join(' > ');
        assert.equal(found.root, want?.dir ?? null, shape);
        assert.equal(found.backend, want ? (want.kind === 'git' ? 'git' : 'jj') : null, shape);
        // The tool detect chose finds the same root from the same folder.
        if (found.backend === 'jj') assert.equal(sh('jj --ignore-working-copy workspace root', chain[i].dir), found.root, shape);
        if (found.backend === 'git') assert.equal(sh('git rev-parse --show-toplevel', chain[i].dir), found.root, shape);
      }
    });
  }
});

describe('registry entries keep every clone', () => {
  process.env.AGENT_PIPELINE_STATE = folder('state');
  const jjClone = folder('clone-jj');
  sh('jj git init --colocate >/dev/null 2>&1', jjClone);
  const gitClone = folder('clone-git');
  sh('git init -q', gitClone);
  const ctxOf = (repo, gitDir) => ({ identity: 'github:example-owner/demo', slug: 'example-owner/demo', repo, main: repo, vcs: { gitDir: () => gitDir }, config: { remote: 'origin', trunk: 'main', deploy: { command: null, match: null } } });

  test('a jj clone and then a git clone of one repository are both kept, with their git folders', () => {
    register(ctxOf(jjClone, join(jjClone, '.git')));
    register(ctxOf(gitClone, join(gitClone, '.git')));
    const [entry] = registeredRepos();
    assert.deepEqual(clonesOf(entry).map((clone) => [clone.path, clone.backend]), [[jjClone, 'jj'], [gitClone, 'git']]);
    assert.ok(holdsStore(entry, detect(jjClone).store));
    assert.ok(holdsStore(entry, detect(gitClone).store));
    // A colocated clone's git folder belongs to the entry too.
    assert.ok(holdsStore(entry, join(jjClone, '.git')));
    // Registering the first one again changes nothing, so it writes nothing.
    const before = JSON.stringify(registeredRepos());
    register(ctxOf(jjClone, join(jjClone, '.git')));
    assert.equal(JSON.stringify(registeredRepos()), before);
  });
});
