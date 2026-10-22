import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../lib/config.mjs';
import { addedLines, scanCommits, scanDiff, scanResult } from '../lib/scan.mjs';

const config = (scan = {}) => ({ ...DEFAULTS, scan: { ...DEFAULTS.scan, private: ['secret-host.example'], ...scan } });
const commit = (fields) => ({ id: 'a'.repeat(40), description: 'fix(ui): a thing', signature: 'good', files: [], ...fields });
const diff = (file, lines) => [`diff --git a/${file} b/${file}`, 'index 000..111 100644', `--- a/${file}`, `+++ b/${file}`, `@@ -1,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
const kinds = (findings) => findings.map((finding) => `${finding.level}:${finding.kind}`);
// Built in pieces, so this file never holds a literal the repository's own scan would refuse.
const EM = '\u2014';
const HOME_PATH = ['', 'Users', 'someone', 'notes.txt'].join('/');

test('added lines carry their file and line in the new version', () => {
  const text = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -3,2 +3,3 @@', ' same', '-gone', '+new one', ' same', '+new two'].join('\n');
  assert.deepEqual(addedLines(text), [{ file: 'x.js', line: 4, text: 'new one' }, { file: 'x.js', line: 6, text: 'new two' }]);
});

test('an unsigned commit, an AI trailer and an em dash in a message are errors', () => {
  const findings = scanCommits([
    commit({ signature: 'none' }),
    commit({ description: 'feat: x\n\nCo-authored-by: Bot <bot@example.com>' }),
    commit({ description: `fix: a ${EM} b` }),
  ], config());
  assert.deepEqual(kinds(findings), ['error:unsigned', 'error:trailer', 'error:em-dash-message']);
});

test('a commit that adds an env file is an error, an example env file is not', () => {
  const findings = scanCommits([commit({ files: [{ path: '.env', status: 'added' }, { path: 'app/.env.example', status: 'added' }, { path: '.env.local', status: 'removed' }] })], config());
  assert.deepEqual(kinds(findings), ['error:env-file']);
});

test('a private string, a home folder path and a secret are errors', () => {
  const findings = scanDiff(diff('a.md', ['see https://secret-host.example/x', `log at ${HOME_PATH}`, `token ghp_${'a'.repeat(36)}`]), config());
  assert.ok(kinds(findings).includes('error:private'));
  assert.ok(kinds(findings).includes('error:private-path'));
  assert.ok(kinds(findings).includes('error:secret'));
});

test('URLs, HTML sinks and credentials in a URL need a look, not a block', () => {
  const findings = scanDiff(diff('a.js', ['fetch("https://api.unknown.dev/v1")', 'el.innerHTML = html', 'const db = "postgres://user:pw@localhost/db"']), config());
  assert.deepEqual(kinds(findings).sort(), ['review:html-sink', 'review:maybe-secret', 'review:url']);
});

test('allowed URL hosts and their subdomains pass', () => {
  assert.deepEqual(scanDiff(diff('a.md', ['https://example.com/a', 'http://docs.example.com/b', 'http://localhost:3000/']), config()), []);
});

test('an em dash in added content follows scan.emDashInContent', () => {
  const text = diff('a.md', [`one ${EM} two`]);
  assert.deepEqual(kinds(scanDiff(text, config())), ['error:em-dash']);
  assert.deepEqual(kinds(scanDiff(text, config({ emDashInContent: 'review' }))), ['review:em-dash']);
  assert.deepEqual(scanDiff(text, config({ emDashInContent: 'off' })), []);
});

test('a workflow change that adds secrets, write permissions or a deploy needs a look', () => {
  const findings = scanDiff(diff('.github/workflows/ci.yml', ['on: pull_request_target', '  contents: write', '  run: echo ok']), config());
  assert.deepEqual(kinds(findings), ['review:workflow', 'review:workflow']);
});

test('excluded files are not scanned', () => {
  assert.deepEqual(scanDiff(diff('pnpm-lock.yaml', ['https://secret-host.example/x']), config()), []);
  assert.deepEqual(scanDiff(diff('img/shot.webp', ['https://secret-host.example/x']), config()), []);
});

test('scanResult splits errors from findings to look at', () => {
  const result = scanResult([commit({ signature: 'bad' })], diff('a.js', ['el.innerHTML = x']), config());
  assert.equal(result.errors.length, 1);
  assert.equal(result.reviews.length, 1);
});
