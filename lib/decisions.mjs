// The decision log. In guess mode the agent never stops to ask the user a product question: it picks
// the user's likely answer and logs the choice, the reason and the options it rejected, so the user
// can overrule any of them later. Briefs then name decisions by ID, and the gate checks each one exists.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail, now } from './util.mjs';

const EM_DASH = '\u2014';

export function idPattern(config) {
  return new RegExp(config.decisions.idPattern, 'g');
}

export function idsIn(text, config) {
  const ignore = new Set(config.decisions.ignoreIds);
  return [...new Set([...String(text).matchAll(idPattern(config))].map((match) => match[0]).filter((id) => !ignore.has(id)))];
}

// The IDs a brief names as decided: every ID on a line that says "decided", plus a "Decisions:" line.
export function decidedIdsInBrief(text, config) {
  const lines = String(text).split('\n').filter((line) => /\bdecided\b|^\s*[-*]?\s*\**decisions\**\s*:/i.test(line));
  return idsIn(lines.join('\n'), config);
}

const HEADING = /^\s*#{1,6}\s+(.*)$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

// The part of a log line that names the entry it starts: a whole heading, or a list item's leading
// IDs, or else its label before the first colon, such as "2026-10-22 (coordinator, RS-O-3)". An ID
// only mentioned in an entry's text ("Rejected: the RS-O-2 rule") is not a logged decision.
function entryLead(line, config) {
  const heading = HEADING.exec(line);
  if (heading) return heading[1];
  const item = ITEM.exec(line);
  if (!item) return '';
  const text = item[1].replace(/^(\*\*|__)/, '');
  const id = config.decisions.idPattern;
  const leading = new RegExp(`^(?:${id})(?:\\s*(?:[,/=&+]|and|or)\\s*(?:${id}))*`).exec(text);
  if (leading) return leading[0];
  return /^(.{1,160}?):(?=\s|\*|$)/.exec(text)?.[1] ?? '';
}

export function loggedIds(config) {
  const file = config.decisions.file;
  if (!file || !existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8').split('\n').flatMap((line) => idsIn(entryLead(line, config), config)));
}

export function missingDecisions(ids, config) {
  const logged = loggedIds(config);
  return ids.filter((id) => !logged.has(id));
}

export function appendDecision({ id, title, chose, why, rejected, run, by }, config) {
  if (!config.decisions.file) fail('decisions.file is not set in pipeline.config.json (or pipeline.local.json).');
  if (!id || !idsIn(id, config).includes(id)) fail(`--id ${id ?? ''} does not match decisions.idPattern (${config.decisions.idPattern}).`);
  for (const [flag, value] of [['--chose', chose], ['--why', why], ['--rejected', rejected]]) {
    if (!value || value === true) fail(`${flag} is required: a decision records what was chosen, why, and what was rejected.`);
    if (String(value).includes(EM_DASH)) fail(`${flag} has an em dash. Use a colon, a comma or a new sentence.`);
  }
  if (loggedIds(config).has(id)) fail(`${id} is already in ${config.decisions.file}. Use a new ID for a new decision.`);
  mkdirSync(dirname(config.decisions.file), { recursive: true });
  const heading = `## ${now().slice(0, 10)}: ${id}${title ? `, ${title}` : ''}${run ? ` (run ${run})` : ''}`;
  const entry = ['', heading, `- Chosen: ${chose}`, `- Why: ${why}`, `- Rejected: ${rejected}`, ...(by ? [`- By: ${by}`] : []), ''].join('\n');
  appendFileSync(config.decisions.file, entry);
  return heading;
}
