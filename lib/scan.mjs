// The pre-push scan. Pushing a branch to a public repository publishes it at once, and a deleted branch
// stays in caches and forks, so the scan runs on every range before it leaves the machine.
//
// Each commit is scanned on its own diff (a merge on its conflict resolution), its message and the
// paths it touches. A string one commit adds and the next removes is still published in the first, so
// the net diff of a range is never enough. A finding never repeats a private string or a secret.
//
// Findings have two levels. An error always blocks: an unsigned commit, an AI trailer, a private
// string, a secret. A review finding (a URL, an HTML sink, a workflow change) needs a person or agent
// to look and acknowledge it with a reason, which the ledger keeps.

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

// Private strings, private paths and secrets in any text: a diff line, a message, a path. Each
// finding names what matched, never the value itself.
function sensitive(text, config) {
  const found = [];
  const lower = text.toLowerCase();
  if (privateStrings(config).some((value) => lower.includes(value.toLowerCase()))) found.push(['error', 'private', 'a string from scan.private']);
  config.scan.privateRegex.forEach((source, i) => { if (new RegExp(source, 'i').test(text)) found.push(['error', 'private', `a match of scan.privateRegex #${i + 1}`]); });
  if (PRIVATE_PATHS.test(text)) found.push(['error', 'private-path', 'a path inside a home folder or a temp folder']);
  if (config.scan.secrets) {
    for (const [name, pattern] of SECRETS) if (pattern.test(text)) found.push(['error', 'secret', name]);
    for (const [name, pattern] of MAYBE_SECRETS) if (pattern.test(text)) found.push(['review', 'maybe-secret', name]);
  }
  return found;
}

const REDACTED = '(not shown: the line also holds a private string or a secret)';

export function scanCommits(commits, config) {
  const findings = [];
  const add = (level, kind, commit, text, part = '') => findings.push({ level, kind, where: `${short(commit.id)}${part}`, text });
  const trailers = config.commits.forbiddenTrailers.map((pattern) => new RegExp(pattern, 'im'));
  for (const commit of commits) {
    if (!config.commits.acceptedSignatures.includes(commit.signature)) add('error', 'unsigned', commit, `signature: ${commit.signature}`);
    const trailer = trailers.find((pattern) => pattern.test(commit.description));
    if (trailer) add('error', 'trailer', commit, `message matches ${trailer.source}`);
    if (commit.description.includes(EM_DASH)) add('error', 'em-dash-message', commit, 'em dash in the message');
    for (const [level, kind, text] of sensitive(commit.description, config)) add(level, kind, commit, `${text}, in the message`, ' message');
    for (const path of new Set(commit.files.flatMap((file) => [file.source, file.path]).filter(Boolean))) {
      for (const [level, kind, text] of sensitive(path, config)) add(level, kind, commit, `${text}, in a file name`, ' path');
    }
    for (const file of commit.files) {
      if (file.status !== 'removed' && ENV_FILE.test(file.path)) add('error', 'env-file', commit, `adds ${sensitive(file.path, config).length ? 'an env file' : file.path}`);
    }
  }
  return findings;
}

// `prefix` names the commit the diff belongs to.
export function scanDiff(diff, config, prefix = '') {
  const findings = [];
  const workflowFiles = config.scan.workflowPaths;
  for (const { file, line, text } of addedLines(diff)) {
    if (matchesAny(file, config.scan.exclude)) continue;
    const secretOnLine = sensitive(text, config);
    const where = `${prefix ? `${prefix} ` : ''}${sensitive(file, config).length ? '(a file whose name is private)' : file}:${line}`;
    const add = (level, kind, detail) => findings.push({ level, kind, where, text: secretOnLine.length ? detail ?? REDACTED : detail ?? text.trim().slice(0, 160) });
    for (const [level, kind, detail] of secretOnLine) add(level, kind, detail);
    if (config.scan.htmlSinks && HTML_SINKS.test(text)) add('review', 'html-sink', secretOnLine.length ? REDACTED : undefined);
    if (config.scan.urls) {
      for (const [url] of text.matchAll(URL)) {
        let host = null;
        try { host = new globalThis.URL(url).hostname; } catch {}
        if (!host || !hostAllowed(host, config.scan.allowedUrlHosts)) add('review', 'url', secretOnLine.length ? REDACTED : url);
      }
    }
    if (config.scan.emDashInContent !== 'off' && text.includes(EM_DASH)) add(config.scan.emDashInContent === 'error' ? 'error' : 'review', 'em-dash', secretOnLine.length ? REDACTED : undefined);
    if (matchesAny(file, workflowFiles) && WORKFLOW_RISKS.test(text)) add('review', 'workflow', secretOnLine.length ? REDACTED : undefined);
  }
  return findings;
}

// `patches` maps each commit id to that commit's own diff.
export function scanResult(commits, patches, config) {
  const missing = commits.filter((commit) => !patches.has(commit.id));
  if (missing.length) throw new Error(`no diff was read for ${missing.map((commit) => short(commit.id)).join(', ')}`);
  const findings = [...scanCommits(commits, config), ...commits.flatMap((commit) => scanDiff(patches.get(commit.id), config, short(commit.id)))];
  return {
    findings,
    errors: findings.filter((finding) => finding.level === 'error'),
    reviews: findings.filter((finding) => finding.level === 'review'),
  };
}
