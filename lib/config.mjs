// The per-project config. `pipeline.config.json` at the repository root is committed and holds what
// every machine shares. `pipeline.local.json` beside it is gitignored and holds what must never be
// committed, such as the private domain the scan keeps out. Defaults fill the rest.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expandHome, fail } from './util.mjs';

export const CONFIG_FILE = 'pipeline.config.json';
export const LOCAL_FILE = 'pipeline.local.json';

export const DEFAULTS = {
  project: null,
  trunk: 'main',
  remote: 'origin',
  intake: {
    // Briefs of these kinds must quote the user's words verbatim. A fix brief points at the review instead.
    quoteIn: ['build', 'design', 'review', 'live-play', 'followups'],
  },
  commits: {
    conventional: true,
    types: ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'perf', 'build', 'ci'],
    oneLine: true,
    acceptedSignatures: ['good'],
    forbidEmDash: true,
    forbiddenTrailers: ['^co-authored-by:', '^generated-by:', '^signed-off-by:', 'generated with', 'noreply@anthropic\\.com'],
  },
  brief: {
    // A build or live play brief names the shared preamble, so every agent gets the same rules.
    preamble: null,
    requirePreambleIn: ['build', 'live-play', 'followups'],
  },
  design: {
    targetLines: 400,
    maxLines: 520,
    uiHeading: '^#{2,4} .*\\b(UI|UX)\\b',
    requiredSections: ['Tests', 'Build plan'],
  },
  decisions: {
    file: null,
    guessMode: false,
    idPattern: '\\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\\b',
    ignoreIds: ['UTF-8', 'SHA-256', 'ISO-8601', 'UTF-16'],
  },
  fastLane: {
    maxFiles: 8,
    forbiddenPaths: [],
    specMaxLines: 150,
  },
  checks: {
    parallel: [],
    integration: [],
    e2e: { command: null, files: [], always: [], beforeEach: null, timeoutSec: 1800 },
    env: {},
    stopOnFailure: true,
    keepAwake: true,
    resultPatterns: { pass: '^\\S* ?(?:# )?pass (\\d+)', fail: '^\\S* ?(?:# )?fail (\\d+)' },
  },
  tests: {
    pattern: '(^|/)(test|tests|e2e)/|\\.(test|spec|itest|e2e)\\.[cm]?[jt]sx?$',
  },
  mutation: {
    required: true,
    command: 'node --test {file}',
    link: ['node_modules'],
    timeoutSec: 600,
  },
  report: {
    sections: [],
  },
  scan: {
    private: [],
    privateRegex: [],
    secrets: true,
    htmlSinks: true,
    urls: true,
    allowedUrlHosts: ['example.com', 'example.org', 'localhost', '127.0.0.1'],
    emDashInContent: 'error',
    exclude: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.ico', '*.woff', '*.woff2', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'],
    workflowPaths: ['.github/workflows/**'],
  },
  push: {
    branches: ['ci/*'],
    requireScan: true,
    public: true,
  },
  ci: {
    workflow: null,
    pollSec: 30,
    timeoutMin: 120,
    okConclusions: ['success', 'skipped', 'neutral'],
  },
  review: {
    provider: 'auto',
    agentReviewLedger: '~/.local/state/agent-review',
    minReviewers: 2,
    trustGithubStatus: false,
  },
  deploy: {
    command: null,
    match: null,
    tipArg: null,
    runBy: 'user',
    requiredChecks: ['backup', 'health', 'load', 'http'],
    healthyValues: ['healthy', 'ok'],
    deployWorkflows: 'deploy',
    prodPattern: '(^|[^a-z0-9])prod(uction)?([^a-z0-9]|$)',
  },
  notify: {
    command: null,
  },
  docs: {
    featureList: null,
    guide: null,
    shortcutSources: [],
    shortcutDocs: [],
    behaviorPaths: [],
    screenshots: [],
    separateCommit: true,
  },
  livePlay: {
    maxFilesPerFix: 8,
    idPattern: '^{prefix}-[A-Z0-9]+-\\d+$',
  },
  followups: {
    blockingNeedsDecision: true,
  },
  cleanup: {
    databaseList: null,
    databaseDrop: null,
    archiveDir: null,
  },
  signoffs: {
    decisions: ['complete'],
    build: ['scope'],
    'live-play': ['bug-fix-only'],
    docs: ['guide-voice'],
  },
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Maps whose keys the project names itself.
const FREE_FORM = new Set(['checks.env', 'signoffs']);

// Unknown keys are refused, so a typo never silently turns a check off.
function merge(base, override, path) {
  if (!isObject(override)) fail(`${path || 'config'} must be an object.`);
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith('$') || key.startsWith('//')) continue;
    const where = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(base, key)) fail(`Unknown config key ${where}.`);
    const current = base[key];
    if (FREE_FORM.has(where)) {
      if (!isObject(value)) fail(`${where} must be an object.`);
      out[key] = { ...current, ...value };
    } else if (isObject(current) && !Object.keys(current).length) out[key] = value;
    else if (isObject(current)) out[key] = merge(current, value, where);
    else if (Array.isArray(current) && !Array.isArray(value)) fail(`${where} must be a list.`);
    else if (current !== null && typeof current !== 'object' && value !== null && typeof value !== typeof current) fail(`${where} must be a ${typeof current}.`);
    else out[key] = value;
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

// A value still in angle brackets, such as <private-domain>, is a placeholder nobody filled. It is
// left out of the scan and reported, since scanning for the placeholder itself proves nothing.
const PLACEHOLDER = /^<[^<>]+>$/;

export function warnings(config) {
  const found = [];
  for (const value of config.scan.private) if (PLACEHOLDER.test(value)) found.push(`scan.private has the placeholder ${value}. Put the real value in ${LOCAL_FILE}, which is never committed.`);
  if (config.push.public && !config.scan.private.some((value) => !PLACEHOLDER.test(value))) found.push(`scan.private is empty, so the pre-push scan checks no private strings. Set them in ${LOCAL_FILE}.`);
  if (!config.checks.parallel.length && !config.checks.integration.length && !config.checks.e2e.command) found.push('No checks are configured (checks.parallel, checks.integration, checks.e2e).');
  if (config.decisions.guessMode && !config.decisions.file) found.push('decisions.guessMode is on but decisions.file is not set.');
  if (!['agent', 'user'].includes(config.deploy.runBy)) found.push('deploy.runBy must be "agent" or "user".');
  return found;
}

// Loads the config for a repository root. Returns null when the repository has no pipeline config,
// which leaves the gate inert there. `localDirs` are other places to look for pipeline.local.json:
// a lane's jj workspace has its own checkout of the committed file, but the gitignored local file
// lives only in the main workspace.
export function loadConfig(root, { path, required = false, localDirs = [] } = {}) {
  const file = path ?? process.env.PIPELINE_CONFIG ?? (root ? join(root, CONFIG_FILE) : null);
  if (!file || !existsSync(file)) {
    if (required) fail(`No ${CONFIG_FILE} in ${root ?? 'this directory'}. Run pipeline init, or pass --config.`);
    return null;
  }
  let config = merge(DEFAULTS, readJson(file), '');
  const local = [dirname(file), ...localDirs].map((dir) => join(dir, LOCAL_FILE)).find((candidate) => existsSync(candidate));
  if (local) config = merge(config, readJson(local), '');
  config.decisions.file = expandHome(config.decisions.file);
  config.review.agentReviewLedger = expandHome(process.env.AGENT_REVIEW_LEDGER ?? config.review.agentReviewLedger);
  config.cleanup.archiveDir = expandHome(config.cleanup.archiveDir);
  config.file = file;
  config.localFile = local ?? null;
  return config;
}

export const privateStrings = (config) => config.scan.private.filter((value) => value && !PLACEHOLDER.test(value));
