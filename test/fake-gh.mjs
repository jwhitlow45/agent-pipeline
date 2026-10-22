#!/usr/bin/env node
// A stand-in for the gh CLI. It logs every call and answers from a script of rules, so tests check
// status mirroring and CI reads without reaching GitHub. A rule with `times` is used that many times,
// which lets a test answer "in progress" before "completed".

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`);
const scriptFile = process.env.FAKE_GH_SCRIPT;
const script = scriptFile && existsSync(scriptFile) ? JSON.parse(readFileSync(scriptFile, 'utf8')) : [];
const joined = args.join(' ');
const index = script.findIndex((rule) => joined.includes(rule.match) && (rule.times === undefined || rule.times > 0));
if (index === -1) {
  // Setting a status succeeds unless a rule says otherwise.
  if (args[0] === 'api' && /\/statuses\//.test(joined)) {
    process.stdout.write('{}');
    process.exit(0);
  }
  process.stderr.write(`fake gh: no rule for ${joined}\n`);
  process.exit(1);
}
const rule = script[index];
if (rule.times !== undefined) {
  rule.times--;
  writeFileSync(scriptFile, JSON.stringify(script));
}
if (rule.stderr) process.stderr.write(rule.stderr);
process.stdout.write(typeof rule.stdout === 'string' ? rule.stdout : JSON.stringify(rule.stdout ?? {}));
process.exit(rule.exit ?? 0);
