// Test sandboxes: a temporary jj repository whose origin looks like a GitHub repository but is a
// local bare repository (git's pushInsteadOf sends pushes there), its own ledger folders, a jj config that
// does not sign, and the fake gh. Nothing touches the user's real state or GitHub.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'bin', 'pipeline.mjs');
export const SLUG = 'example-owner/demo';

export function sandbox({ config = {}, local = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
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
  writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[url "${bare}"]\n\tpushInsteadOf = https://github.com/${SLUG}.git\n`);
  writeFileSync(env.FAKE_GH_LOG, '');
  const sh = (command, cwd = repo, extra = {}) => {
    const result = spawnSync('sh', ['-c', command], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  mkdirSync(repo);
  sh(`git init -q --bare ${JSON.stringify(bare)}`, root);
  sh('jj git init --colocate -q 2>/dev/null || jj git init --colocate');
  sh(`jj git remote add origin https://github.com/${SLUG}.git`);
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
  sh('jj commit -m "chore: scaffold" && jj bookmark set main -r @- && jj git push --bookmark main');

  const box = {
    root, repo, bare, env, sh,
    cli(args, { cwd = repo, input, extra = {} } = {}) {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, input, encoding: 'utf8' });
      return { code: result.status, out: result.stdout, err: result.stderr, all: `${result.stdout}${result.stderr}` };
    },
    write(path, text, cwd = repo) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    },
    commit(message, files, cwd = repo) {
      for (const [path, text] of Object.entries(files ?? {})) box.write(path, text, cwd);
      sh('jj commit -m "$MESSAGE"', cwd, { MESSAGE: message });
      return sh('jj log --no-graph -r @- -T commit_id', cwd).trim();
    },
    ghScript(rules) { writeFileSync(env.FAKE_GH_SCRIPT, JSON.stringify(rules)); },
    ghCalls() { return readFileSync(env.FAKE_GH_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); },
    statusCalls() { return box.ghCalls().filter((args) => args[0] === 'api' && /\/statuses\//.test(args.join(' '))).map((args) => Object.fromEntries(args.filter((arg, i) => args[i - 1] === '-f').map((field) => field.split(/=(.*)/s).slice(0, 2)))); },
    run(id) { return JSON.parse(readFileSync(join(env.AGENT_PIPELINE_STATE, 'runs', `${id}.json`), 'utf8')); },
    gate(command, cwd = repo, payload = {}) { return box.cli(['gate'], { input: JSON.stringify({ tool_input: { command }, cwd, ...payload }) }); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
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
  deploy: { command: './deploy.sh {name} {tip}', match: 'deploy\\.sh', tipArg: 2, runBy: 'agent' },
  notify: { command: ['sh', '-c', 'echo "$1" >> "$NOTES"', 'sh', '{message}'] },
  docs: { featureList: 'FEATURES.md', behaviorPaths: ['src/**'] },
};

// A fast run built to the point of a pushed, scanned tip, shared by the tests that start there.
export function builtRun(box, { run = 'dark', lane = 'a', intake = [] } = {}) {
  box.cli(['intake', '--run', run, '--kind', 'fast', '--words', WORDS, ...intake]);
  box.write(`../${run}-spec.md`, `The user's words: ${WORDS}\n`);
  box.cli(['spec', '--run', run, '--file', `../${run}-spec.md`]);
  const ws = join(box.root, `demo-${run}`);
  box.sh(`jj workspace add --name demo-${run} ../demo-${run} -r main`);
  assert.equal(box.cli(['lane', '--run', run, '--lane', lane, '--workspace', ws, '--owns', 'src/**,FEATURES.md']).code, 0);
  box.commit('feat(ui): dark mode toggle', { 'src/theme.mjs': 'export const dark = () => true;\n', 'src/theme.test.mjs': TEST_FILE }, ws);
  box.commit('docs: dark mode in the feature list', { 'FEATURES.md': '- Dark mode\n' }, ws);
  assert.equal(box.cli(['commits', '--run', run, '--lane', lane], { cwd: ws }).code, 0);
  assert.equal(box.cli(['check', '--run', run, '--lane', lane], { cwd: ws }).code, 0);
  const fix = box.sh('jj log --no-graph -r @-- -T commit_id', ws).trim();
  assert.equal(box.cli(['mutation', '--run', run, '--lane', lane, '--commit', fix, '--test', 'src/theme.test.mjs'], { cwd: ws }).code, 0);
  box.write(`../${run}-report.md`, '# Report\n');
  box.cli(['report', '--run', run, '--lane', lane, '--file', `../${run}-report.md`]);
  box.cli(['signoff', '--run', run, '--stage', 'build', '--item', 'scope', '--by', 'owner', '--note', 'one commit per item']);
  assert.equal(box.cli(['build', '--run', run]).code, 0);
  return { ws, tip: box.run(run).tip };
}

export const ciScript = (tip, { jobs = [{ name: 'e2e (1)', status: 'completed', conclusion: 'success' }], conclusion = 'success' } = {}) => [
  { match: 'run list', stdout: [{ databaseId: 77, status: 'completed', conclusion, workflowName: 'CI', headSha: tip, url: `https://github.com/${SLUG}/actions/runs/77`, createdAt: '2026-01-01T00:00:00Z' }] },
  { match: 'run view 77', stdout: { databaseId: 77, status: 'completed', conclusion, url: `https://github.com/${SLUG}/actions/runs/77`, headSha: tip, workflowName: 'CI', jobs } },
];
