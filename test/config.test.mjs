import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, privateStrings, warnings } from '../lib/config.mjs';

const dir = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-config-'));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  return root;
};

test('a repository without a config gets null, so the gate stays inert there', () => {
  assert.equal(loadConfig(dir({})), null);
});

test('a required config that is missing is refused', () => {
  assert.throws(() => loadConfig(dir({}), { required: true }), /No pipeline.config.json/);
});

test('the config merges over the defaults, nested keys included', () => {
  const config = loadConfig(dir({ 'pipeline.config.json': { trunk: 'trunk', push: { branches: ['ci/*', 'test/*'] }, checks: { e2e: { files: ['a'] } } } }));
  assert.equal(config.trunk, 'trunk');
  assert.deepEqual(config.push.branches, ['ci/*', 'test/*']);
  assert.equal(config.push.requireScan, DEFAULTS.push.requireScan);
  assert.deepEqual(config.checks.e2e.files, ['a']);
  assert.equal(config.checks.e2e.timeoutSec, DEFAULTS.checks.e2e.timeoutSec);
});

test('an unknown key is refused, so a typo never turns a check off', () => {
  assert.throws(() => loadConfig(dir({ 'pipeline.config.json': { push: { requireScna: false } } })), /Unknown config key push.requireScna/);
});

test('a value of the wrong type is refused', () => {
  assert.throws(() => loadConfig(dir({ 'pipeline.config.json': { push: { branches: 'ci/*' } } })), /push.branches must be a list/);
  assert.throws(() => loadConfig(dir({ 'pipeline.config.json': { design: { maxLines: '500' } } })), /design.maxLines must be a number/);
});

test('invalid JSON is refused with the file named', () => {
  assert.throws(() => loadConfig(dir({ 'pipeline.config.json': '{ nope' })), /pipeline.config.json is not valid JSON/);
});

test('pipeline.local.json overrides the committed file', () => {
  const config = loadConfig(dir({ 'pipeline.config.json': { scan: { private: ['<private-domain>'] } }, 'pipeline.local.json': { scan: { private: ['secret.example'] } } }));
  assert.deepEqual(config.scan.private, ['secret.example']);
  assert.match(config.localFile, /pipeline.local.json$/);
});

test('the local file is also found in another folder, such as the main workspace', () => {
  const main = dir({ 'pipeline.local.json': { scan: { private: ['secret.example'] } } });
  const lane = dir({ 'pipeline.config.json': {} });
  assert.deepEqual(loadConfig(lane, { localDirs: [main] }).scan.private, ['secret.example']);
});

test('an unfilled placeholder is never scanned for and is reported', () => {
  const config = loadConfig(dir({ 'pipeline.config.json': { scan: { private: ['<private-domain>'] } } }));
  assert.deepEqual(privateStrings(config), []);
  assert.ok(warnings(config).some((warning) => /placeholder <private-domain>/.test(warning)));
});

test('sign-offs and check env are maps the project names itself', () => {
  const config = loadConfig(dir({ 'pipeline.config.json': { signoffs: { deploy: ['go-ahead'], build: [] }, checks: { env: { PORT: '6000' } } } }));
  assert.deepEqual(config.signoffs.deploy, ['go-ahead']);
  assert.deepEqual(config.signoffs.build, []);
  assert.deepEqual(config.signoffs['live-play'], DEFAULTS.signoffs['live-play']);
  assert.equal(config.checks.env.PORT, '6000');
});

test('the example config loads with only the placeholder warnings', () => {
  const config = loadConfig(dir({}), { path: join(import.meta.dirname, '..', 'pipeline.config.example.json') });
  assert.equal(config.deploy.runBy, 'user');
  assert.ok(warnings(config).every((warning) => /scan.private/.test(warning)));
});

test('the gate keys come from the committed copy on trunk, and the working copy keeps every other key', () => {
  const root = dir({ 'pipeline.config.json': { push: { branches: ['*'] }, deploy: { runBy: 'agent', match: 'x' }, checks: { parallel: [{ name: 'unit', run: 'u' }] } } });
  const config = loadConfig(root, { committed: { deploy: { runBy: 'user' } } });
  assert.deepEqual(config.push.branches, DEFAULTS.push.branches);
  assert.equal(config.deploy.runBy, 'user');
  assert.equal(config.deploy.match, null);
  assert.equal(config.checks.parallel[0].name, 'unit');
  assert.deepEqual(config.drift, ['push', 'deploy.runBy', 'deploy.match']);
  assert.ok(warnings(config).some((warning) => /push in this working copy differs/.test(warning)));
});

test('without a committed copy on trunk the gate keys stay at their defaults, and the gate is off', () => {
  const config = loadConfig(dir({ 'pipeline.config.json': { deploy: { runBy: 'agent' } } }), { committed: null });
  assert.equal(config.deploy.runBy, 'user');
  assert.equal(config.committed, false);
  assert.ok(warnings(config).some((warning) => /not committed on origin\/main/.test(warning)));
});

test('the gitignored local file may not set a gate key', () => {
  assert.throws(() => loadConfig(dir({ 'pipeline.config.json': {}, 'pipeline.local.json': { push: { public: false } } }), { committed: {} }), /sets push, which the gate reads only from pipeline.config.json committed/);
  assert.throws(() => loadConfig(dir({ 'pipeline.config.json': {}, 'pipeline.local.json': { review: { trustGithubStatus: true } } }), { committed: {} }), /sets review.trustGithubStatus/);
  assert.equal(loadConfig(dir({ 'pipeline.config.json': {}, 'pipeline.local.json': { deploy: { command: '~/deploy.sh {tip}' } } }), { committed: {} }).deploy.command, '~/deploy.sh {tip}');
});
