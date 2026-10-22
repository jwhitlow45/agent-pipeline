// The pre-push scan. Pushing a branch to a public repository publishes it at once, and a deleted branch
// stays in caches and forks, so the scan runs on every range before it leaves the machine.
//
// Findings have two levels. An error always blocks: an unsigned commit, an AI trailer, a private
// string, a secret. A review finding (a URL, an HTML sink, a workflow change) needs a person or agent
// to look and acknowledge it with a reason, which the ledger keeps.

import { firstLine } from './vcs.mjs';
import { matchesAny, short } from './util.mjs';
import { privateStrings } from './config.mjs';

const EM_DASH = '\u2014';

const SECRETS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Slack webhook', /hooks\.slack\.com\/services\//],
];

// These are often test fixtures, so they need a look rather than a block.
const MAYBE_SECRETS = [
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]+@/i],
  ['password literal', /password\s*[:=]\s*['"][^'"\s]{6,}['"]/i],
];

const PRIVATE_PATHS = /(?:^|[\s"'`(=:])(\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|\/private\/tmp\/|\/private\/var\/folders\/|[A-Za-z]:\\Users\\)/;

const HTML_SINKS = /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(|(?:^|[^a-zA-Z0-9_.])eval\(|new Function\(/;

const WORKFLOW_RISKS = /pull_request_target|\$\{\{\s*secrets\.|:\s*write\b|\bdeploy\b/i;

const URL = /\bhttps?:\/\/[^\s"'`<>()[\]{}]+/g;

const ENV_FILE = /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$/;

// Added lines of a git diff, each with its file and line number in the new version.
export function addedLines(diff) {
  const lines = [];
  let file = null;
  let line = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) file = /^diff --git a\/.+ b\/(.+)$/.exec(text)?.[1] ?? null;
    else if (text.startsWith('+++ ')) file = text === '+++ /dev/null' ? null : text.replace(/^\+\+\+ b\//, '');
    else if (text.startsWith('@@')) line = Number(/\+(\d+)/.exec(text)?.[1] ?? 1) - 1;
    else if (text.startsWith('+') && file) lines.push({ file, line: ++line, text: text.slice(1) });
    else if (!text.startsWith('-') && !text.startsWith('\\')) line++;
  }
  return lines;
}

const hostAllowed = (host, allowed) => allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));

export function scanCommits(commits, config) {
  const findings = [];
  const add = (level, kind, commit, text) => findings.push({ level, kind, where: `${short(commit.id)} ${firstLine(commit.description)}`, text });
  const trailers = config.commits.forbiddenTrailers.map((pattern) => new RegExp(pattern, 'im'));
  for (const commit of commits) {
    if (!config.commits.acceptedSignatures.includes(commit.signature)) add('error', 'unsigned', commit, `signature: ${commit.signature}`);
    const trailer = trailers.find((pattern) => pattern.test(commit.description));
    if (trailer) add('error', 'trailer', commit, `message matches ${trailer.source}`);
    if (commit.description.includes(EM_DASH)) add('error', 'em-dash-message', commit, 'em dash in the message');
    for (const file of commit.files) {
      if (file.status !== 'removed' && ENV_FILE.test(file.path)) add('error', 'env-file', commit, `adds ${file.path}`);
    }
  }
  return findings;
}

export function scanDiff(diff, config) {
  const findings = [];
  const privates = privateStrings(config).map((value) => value.toLowerCase());
  const privateRegex = config.scan.privateRegex.map((pattern) => new RegExp(pattern, 'i'));
  const workflowFiles = config.scan.workflowPaths;
  for (const { file, line, text } of addedLines(diff)) {
    if (matchesAny(file, config.scan.exclude)) continue;
    const where = `${file}:${line}`;
    const add = (level, kind, detail) => findings.push({ level, kind, where, text: detail ?? text.trim().slice(0, 160) });
    const lower = text.toLowerCase();
    if (privates.some((value) => lower.includes(value))) add('error', 'private', 'a private string from scan.private');
    for (const pattern of privateRegex) if (pattern.test(text)) add('error', 'private', `matches ${pattern.source}`);
    if (PRIVATE_PATHS.test(text)) add('error', 'private-path');
    if (config.scan.secrets) {
      for (const [name, pattern] of SECRETS) if (pattern.test(text)) add('error', 'secret', name);
      for (const [name, pattern] of MAYBE_SECRETS) if (pattern.test(text)) add('review', 'maybe-secret', `${name}: ${text.trim().slice(0, 120)}`);
    }
    if (config.scan.htmlSinks && HTML_SINKS.test(text)) add('review', 'html-sink');
    if (config.scan.urls) {
      for (const [url] of text.matchAll(URL)) {
        let host = null;
        try { host = new globalThis.URL(url).hostname; } catch {}
        if (!host || !hostAllowed(host, config.scan.allowedUrlHosts)) add('review', 'url', url);
      }
    }
    if (config.scan.emDashInContent !== 'off' && text.includes(EM_DASH)) add(config.scan.emDashInContent === 'error' ? 'error' : 'review', 'em-dash');
    if (matchesAny(file, workflowFiles) && WORKFLOW_RISKS.test(text)) add('review', 'workflow');
  }
  return findings;
}

export function scanResult(commits, diff, config) {
  const findings = [...scanCommits(commits, config), ...scanDiff(diff, config)];
  return {
    findings,
    errors: findings.filter((finding) => finding.level === 'error'),
    reviews: findings.filter((finding) => finding.level === 'review'),
  };
}
