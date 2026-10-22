// Test sandboxes: a temporary jj repository whose origin looks like a GitHub repository but is a
// local bare repository (git's pushInsteadOf sends pushes there), its own ledger folders, a jj config that
// does not sign, and the fake gh. Nothing touches the user's real state or GitHub.

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
    gate(command, cwd = repo) { return box.cli(['gate'], { input: JSON.stringify({ tool_input: { command }, cwd }) }); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
    exists: (path) => existsSync(path),
  };
  return box;
}

export const WORDS = 'Please add a dark mode toggle to the settings page, and remember the choice per device.';
