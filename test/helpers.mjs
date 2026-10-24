// Test sandboxes: a temporary repository whose origin looks like a GitHub repository but is a local
// bare repository (git's insteadOf sends fetches and pushes there), its own ledger folders, a jj
// config that does not sign, and the fake gh. Nothing touches the user's real state or GitHub. A
// sandbox is a colocated jj repository (backend 'jj'), a jj repository without git beside it
// ('jj-plain'), or a plain git repository ('git'), and its box API does each step in that backend's
// own commands, so a test written against the API runs on every backend.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'bin', 'pipeline.mjs');
export const SLUG = 'example-owner/demo';

// Every temporary folder a test makes is removed when the test process ends, however it ends: a
// describe's after hook removes its own, and the exit and signal handlers remove the rest, so a
// failing, timed-out or killed run leaves nothing behind.
const temporary = new Set();
const removeAll = () => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
  temporary.clear();
};
process.on('exit', removeAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    removeAll();
    process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[signal]);
  });
}

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.add(dir);
  return dir;
}

export function removeTemp(dir) {
  rmSync(dir, { recursive: true, force: true });
  temporary.delete(dir);
}

export function sandbox({ config = {}, local = null, backend = 'jj' } = {}) {
  if (!['jj', 'jj-plain', 'git'].includes(backend)) throw new Error(`No sandbox backend ${backend}.`);
  const jjLike = backend !== 'git';
  const root = tempDir('pipeline-test-');
  const repo = join(root, 'demo');
  const bare = join(root, 'remote.git');
  const env = {
    ...process.env,
    AGENT_PIPELINE_STATE: join(root, 'state'),
    AGENT_REVIEW_LEDGER: join(root, 'agent-review'),
    JJ_CONFIG: join(root, 'jj.toml'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    PIPELINE_GH: join(ROOT, 'test', 'fake-gh.mjs'),
    FAKE_GH_LOG: join(root, 'gh.log'),
    FAKE_GH_SCRIPT: join(root, 'gh-script.json'),
    PIPELINE_CONFIG: '',
  };
  delete env.PIPELINE_CONFIG;
  // The test runner marks its children with this, and a node --test that inherits it reports to the
  // runner instead of exiting with its own result, which would break mutation checks.
  delete env.NODE_TEST_CONTEXT;
  chmodSync(env.PIPELINE_GH, 0o755);
  writeFileSync(env.JJ_CONFIG, '[user]\nname = "Test"\nemail = "test@example.com"\n[signing]\nbehavior = "drop"\n[ui]\npaginate = "never"\n');
  writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[url "${bare}"]\n\tinsteadOf = https://github.com/${SLUG}.git\n`);
  writeFileSync(env.FAKE_GH_LOG, '');
  const sh = (command, cwd = repo, extra = {}) => {
    const result = spawnSync('sh', ['-c', command], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  mkdirSync(repo);
  sh(`git init -q --bare ${JSON.stringify(bare)}`, root);
  if (backend === 'git') sh(`git init -q && git remote add origin https://github.com/${SLUG}.git`);
  else {
    sh(backend === 'jj' ? 'jj git init --colocate >/dev/null 2>&1' : 'jj git init --no-colocate >/dev/null 2>&1');
    sh(`jj git remote add origin https://github.com/${SLUG}.git`);
  }
  const fullConfig = {
    project: 'demo',
    commits: { acceptedSignatures: ['none', 'good'] },
    checks: { parallel: [{ name: 'unit', run: 'echo "# pass 3"; echo "# fail 0"' }], keepAwake: false },
    mutation: { link: [] },
    ...config,
  };
  writeFileSync(join(repo, 'pipeline.config.json'), `${JSON.stringify(fullConfig, null, 2)}\n`);
  if (local) writeFileSync(join(repo, 'pipeline.local.json'), `${JSON.stringify(local, null, 2)}\n`);
  writeFileSync(join(repo, '.gitignore'), 'pipeline.local.json\n');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  if (jjLike) sh('jj commit -m "chore: scaffold" && jj bookmark set main -r @- && jj git push --bookmark main');
  // A clone records the remote's default branch as origin/HEAD, so the git sandbox does too.
  else sh('git add -A && git commit -q -m "chore: scaffold" && git push -q origin HEAD:refs/heads/main && git remote set-head origin -a >/dev/null');

  const box = {
    root, repo, bare, env, sh, backend,
    // A hook runs under a time limit, so a call that hangs (an alias that expands forever) fails its test.
    cli(args, { cwd = repo, input, extra = {} } = {}) {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 60_000 });
      const err = `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
      return { code: result.status, out: result.stdout, err, all: `${result.stdout}${err}` };
    },
    write(path, text, cwd = repo) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    },
    // The neutral steps, each in the backend's own commands.
    commit(message, files, cwd = repo) {
      for (const [path, text] of Object.entries(files ?? {})) box.write(path, text, cwd);
      if (jjLike) sh('jj commit -m "$MESSAGE"', cwd, { MESSAGE: message });
      else sh('git add -A && git commit -q --allow-empty -m "$MESSAGE"', cwd, { MESSAGE: message });
      return box.head(cwd);
    },
    // The last commit made in a folder: jj's @- (its @ is the empty commit on top), git's HEAD.
    head: (cwd = repo) => sh(jjLike ? 'jj log --no-graph -r @- -T commit_id' : 'git rev-parse HEAD', cwd).trim(),
    parent: (rev, cwd = repo) => sh(jjLike ? `jj log --no-graph -r '${rev}-' -T commit_id` : `git rev-parse ${rev}^`, cwd).trim(),
    // A lane's own folder on the trunk: a jj workspace, or a git worktree on a branch of its own.
    addLane(name, { base = 'main' } = {}) {
      const dir = join(root, name);
      sh(jjLike ? `jj workspace add --name ${name} ../${name} -r ${base}` : `git worktree add -q -b lane/${name} ../${name} ${base}`);
      return dir;
    },
    setBranch(name, rev, cwd = repo) {
      if (jjLike) sh(`jj bookmark set ${name} -r ${rev} --allow-backwards`, cwd);
      else if (sh('git symbolic-ref --short -q HEAD || true', cwd).trim() === name) sh(`git reset -q --keep ${rev}`, cwd);
      else sh(`git branch -f ${name} ${rev}`, cwd);
    },
    // A push the test makes itself, past the gate and any hook.
    pushRaw(branch, cwd = repo) {
      sh(jjLike ? `jj git push --bookmark ${branch} --allow-new 2>/dev/null || jj git push --bookmark ${branch}` : `git push -q --no-verify origin ${branch}:refs/heads/${branch}`, cwd);
    },
    // Drops the last commit, and puts back the files of the one before.
    drop: (cwd = repo) => sh(jjLike ? 'jj abandon @-' : 'git reset -q --hard HEAD~1', cwd),
    restore: (cwd = repo) => sh(jjLike ? 'jj restore' : 'git checkout -q -- . && git clean -fdq', cwd),
    ghScript(rules) { writeFileSync(env.FAKE_GH_SCRIPT, JSON.stringify(rules)); },
    ghCalls() { return readFileSync(env.FAKE_GH_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); },
    statusCalls() { return box.ghCalls().filter((args) => args[0] === 'api' && /\/statuses\//.test(args.join(' '))).map((args) => Object.fromEntries(args.filter((arg, i) => args[i - 1] === '-f').map((field) => field.split(/=(.*)/s).slice(0, 2)))); },
    run(id) { return JSON.parse(readFileSync(join(env.AGENT_PIPELINE_STATE, 'runs', `${id}.json`), 'utf8')); },
    gate(command, cwd = repo, payload = {}) { return box.cli(['gate'], { input: JSON.stringify({ tool_input: { command }, cwd, ...payload }) }); },
    cleanup() { removeTemp(root); },
    exists: (path) => existsSync(path),
  };
  return box;
}

export const WORDS = 'Please add a dark mode toggle to the settings page, and remember the choice per device.';

export const TEST_FILE = "import { test } from 'node:test'; import assert from 'node:assert'; import { dark } from './theme.mjs'; test('dark', () => assert.equal(dark(), true));\n";

export const baseConfig = {
  push: { public: false },
  review: { provider: 'builtin' },
  ci: { workflow: 'CI' },
  deploy: { command: './deploy.sh {name} {tip}', match: 'deploy\\.sh', tipArg: 2, runBy: 'agent', requiredChecks: ['backup', 'health', 'load', 'http'] },
  notify: { command: ['sh', '-c', 'echo "$1" >> "$NOTES"', 'sh', '{message}'] },
  docs: { featureList: 'FEATURES.md', behaviorPaths: ['src/**'] },
};

// A fast run built to the point of a pushed, scanned tip, shared by the tests that start there.
export function builtRun(box, { run = 'dark', lane = 'a', intake = [] } = {}) {
  box.cli(['intake', '--run', run, '--kind', 'fast', '--words', WORDS, ...intake]);
  box.write(`../${run}-spec.md`, `The user's words: ${WORDS}\n`);
  box.cli(['spec', '--run', run, '--file', `../${run}-spec.md`]);
  const ws = box.addLane(`demo-${run}`);
  const added = box.cli(['lane', '--run', run, '--lane', lane, '--workspace', ws, '--owns', 'src/**,FEATURES.md']);
  assert.equal(added.code, 0, added.all);
  const fix = box.commit('feat(ui): dark mode toggle', { 'src/theme.mjs': 'export const dark = () => true;\n', 'src/theme.test.mjs': TEST_FILE }, ws);
  box.commit('docs: dark mode in the feature list', { 'FEATURES.md': '- Dark mode\n' }, ws);
  const commits = box.cli(['commits', '--run', run, '--lane', lane], { cwd: ws });
  assert.equal(commits.code, 0, commits.all);
  const checked = box.cli(['check', '--run', run, '--lane', lane], { cwd: ws });
  assert.equal(checked.code, 0, checked.all);
  assert.equal(box.cli(['mutation', '--run', run, '--lane', lane, '--commit', fix, '--test', 'src/theme.test.mjs'], { cwd: ws }).code, 0);
  box.write(`../${run}-report.md`, '# Report\n');
  box.cli(['report', '--run', run, '--lane', lane, '--file', `../${run}-report.md`]);
  box.cli(['signoff', '--run', run, '--stage', 'build', '--item', 'scope', '--by', 'owner', '--note', 'one commit per item']);
  assert.equal(box.cli(['build', '--run', run]).code, 0);
  return { ws, tip: box.run(run).tip };
}

// The repository's workflows as GitHub lists them: CI is workflow 7, in ci.yml.
export const WORKFLOWS = [{ id: 7, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, { id: 8, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }];
// Every workflow the gate rows dispatch. Release is deploy-prod.yml under a display name that says
// nothing of production, and Twin is a display name two workflows share.
export const ALL_WORKFLOWS = [
  ...WORKFLOWS,
  { id: 9, name: 'Release', path: '.github/workflows/deploy-prod.yml', state: 'active' },
  { id: 10, name: 'Release notes', path: '.github/workflows/release.yml', state: 'active' },
  { id: 12, name: 'Lint', path: '.github/workflows/lint.yml', state: 'active' },
  { id: 13, name: 'cd', path: '.github/workflows/cd.yml', state: 'active' },
  { id: 14, name: 'Twin', path: '.github/workflows/twin-a.yml', state: 'active' },
  { id: 15, name: 'Twin', path: '.github/workflows/twin-b.yml', state: 'active' },
  { id: 16, name: 'Deploy staging', path: '.github/workflows/deploy-staging.yml', state: 'active' },
];
export const workflowsRule = (list = WORKFLOWS) => ({ match: 'actions/workflows?per_page=100', stdout: { total_count: list.length, workflows: list } });

export const ciScript = (tip, { jobs = [{ name: 'e2e (1)', status: 'completed', conclusion: 'success' }], conclusion = 'success' } = {}) => [
  workflowsRule(),
  { match: 'run list', stdout: [{ databaseId: 77, status: 'completed', conclusion, workflowName: 'CI', workflowDatabaseId: 7, headSha: tip, url: `https://github.com/${SLUG}/actions/runs/77`, createdAt: '2026-01-01T00:00:00Z' }] },
  { match: 'run view 77', stdout: { databaseId: 77, status: 'completed', conclusion, url: `https://github.com/${SLUG}/actions/runs/77`, headSha: tip, workflowName: 'CI', workflowDatabaseId: 7, jobs } },
];
