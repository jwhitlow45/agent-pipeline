// The PreToolUse gate. It reads the shell command an agent is about to run and refuses it when an
// earlier stage has not passed. It only reads: statuses are set after the command, by mirror-hook.
//
// It acts in repositories whose trunk has a committed pipeline.config.json, so installing the hook
// globally is safe. What it gates:
//   - pushes (jj git push, git push): every ref they touch, resolved, only to push.branches, never
//     forced or moved sideways, only commits a passed pre-push scan covered. Trunk moves are deploy
//     steps, and under deploy.runBy "user" an agent never moves trunk.
//   - the project's deploy command (deploy.match, in any folder), deploy workflows, reruns, and the
//     gh api writes that dispatch, approve, merge or move branches. A prod workflow is always refused.
//   - pull requests merging into trunk, and, when the pipeline keeps reviews itself, pull requests
//     created ready, marked ready or merged without consensus.
//   - review starts (agent-review start, and the ask that sends round 1).
//
// It resolves each command to an exact action or refuses it. A form it cannot read (a variable
// command name, xargs, a shell reading a pipe, PowerShell) is refused when the text holds a push, a
// gh call or the deploy command, and the refusal names the plain form to run instead. Once an action
// is identified, any error refuses it.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseGitOptions, parseOptions, parseTomlStrings } from './argv.mjs';
import { CONFIG_FILE } from './config.mjs';
import { gateContext } from './context.mjs';
import { pullRequest, remoteRef, workflowName } from './github.mjs';
import { loadRuns, passed } from './ledger.mjs';
import { registeredRepos } from './registry.mjs';
import { agentReviewEntries, findEntry, provider, reviewCoverage, reviewPassed } from './review.mjs';
import { argvCommands, payloadCommand, shellCommands } from './shell.mjs';
import { deployProblems, holeProblems, pushProblems, runForCommit } from './ship.mjs';
import { ghCommand, matchesAny, normalizeWords, run, short } from './util.mjs';
import { bookmarkTable, commitIds, gitDir, inWorkingCopies, isAncestor, jj, jjConfigValue, remoteBookmarkTarget, remoteNames, RevsetError, tagTable } from './vcs.mjs';

const PROCESS_DOC = 'docs/process.md in the agent-pipeline repository';
const NEVER_PROD = 'Agents never run a production deploy. Give the user the command instead.';
const UNKNOWN_DIR = 'Could not tell which directory it runs in (a cd, -C or -R to a variable or to a missing folder). Run it from the workspace, with a literal path.';
const XARGS = 'xargs adds arguments the gate cannot see. Run the plain command with every argument written out.';
const userRuns = (config, what) => `The user runs deploys and moves ${config.trunk} in this project (deploy.runBy is "user"). Give the user the command instead${what ? `: ${what}` : ''}.`;

class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };

const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
const plainName = (text) => {
  const name = text.replace(/^exact:/, '');
  return BRANCH_NAME.test(name) && !name.startsWith('-') ? name : null;
};

// jj

const JJ_GLOBAL = {
  long: { repository: 'value', 'ignore-working-copy': 'flag', 'no-integrate-operation': 'flag', 'ignore-immutable': 'flag', 'at-operation': 'value', debug: 'flag', color: 'value', quiet: 'flag', 'no-pager': 'flag', config: 'value', 'config-file': 'value', 'config-toml': 'value', help: 'flag' },
  short: { R: 'repository', h: 'help' },
  aliases: { 'at-op': 'at-operation' },
};
const JJ_PUSH = {
  long: { remote: 'value', bookmark: 'value', tag: 'value', all: 'flag', tracked: 'flag', deleted: 'flag', 'allow-empty-description': 'flag', 'allow-private': 'flag', 'allow-conflicts': 'flag', revision: 'value', change: 'value', named: 'value', 'dry-run': 'flag', option: 'value', help: 'flag' },
  short: { b: 'bookmark', t: 'tag', r: 'revision', c: 'change', o: 'option', h: 'help' },
};
const JJ_BOOKMARK = {
  set: { long: { revision: 'value', 'allow-backwards': 'flag', help: 'flag' }, short: { r: 'revision', B: 'allow-backwards', h: 'help' }, aliases: { to: 'revision' } },
  create: { long: { revision: 'value', help: 'flag' }, short: { r: 'revision', h: 'help' }, aliases: { to: 'revision' } },
  move: { long: { from: 'value', to: 'value', 'allow-backwards': 'flag', help: 'flag' }, short: { f: 'from', t: 'to', B: 'allow-backwards', h: 'help' } },
};
const JJ_COMMANDS = new Set(['abandon', 'absorb', 'arrange', 'bisect', 'bookmark', 'commit', 'config', 'debug', 'describe', 'diff', 'diffedit', 'duplicate', 'edit', 'evolog', 'evolution-log', 'file', 'fix', 'gerrit', 'git', 'help', 'interdiff', 'log', 'metaedit', 'new', 'next', 'operation', 'parallelize', 'prev', 'rebase', 'redo', 'resolve', 'restore', 'revert', 'root', 'run', 'show', 'sign', 'simplify-parents', 'sparse', 'split', 'squash', 'status', 'tag', 'undo', 'unsign', 'util', 'version', 'workspace']);
const JJ_BUILTIN_ALIASES = { b: 'bookmark', ci: 'commit', desc: 'describe', op: 'operation', st: 'status' };
const JJ_BOOKMARK_ALIASES = { a: 'advance', c: 'create', d: 'delete', f: 'forget', l: 'list', m: 'move', r: 'rename', s: 'set', t: 'track' };
const JJ_READ_ONLY = new Set(['log', 'show', 'diff', 'status', 'evolog', 'evolution-log', 'interdiff', 'help', 'version', 'root', 'bookmark list', 'tag list', 'workspace list', 'workspace root', 'operation log', 'operation show', 'operation diff', 'config get', 'config list', 'config path', 'file list', 'file show', 'file annotate', 'file search', 'git remote list', 'git root', 'util completion', 'util config-schema', 'util markdown-help']);
// Settings that change which command runs, where a push goes, or what it pushes.
const RISKY_JJ_CONFIG = /^(aliases\.|ui\.default-command|git\.|remotes\.|revset-aliases\.|templates\.git_push_bookmark)/;

// Takes jj's global options out of the words: clap accepts them before or after the subcommand.
function splitJjGlobals(words) {
  const globals = [];
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    const { text, dynamic } = words[i];
    const long = /^--([a-z-]+)(=(.*))?$/s.exec(text);
    const name = long ? (Object.hasOwn(JJ_GLOBAL.long, long[1]) ? long[1] : JJ_GLOBAL.aliases[long[1]]) : null;
    if (name) {
      if (JJ_GLOBAL.long[name] === 'value' && long[2] === undefined) {
        const next = words[++i];
        globals.push({ name, value: next?.text, dynamic: Boolean(dynamic || next?.dynamic) });
      } else globals.push({ name, value: long[2] === undefined ? true : long[3], dynamic });
    } else if (/^-R/.test(text)) {
      const attached = text.slice(2).replace(/^=/, '');
      const next = attached ? null : words[++i];
      globals.push({ name: 'repository', value: attached || next?.text, dynamic: Boolean(dynamic || next?.dynamic) });
    } else if (text === '-h') globals.push({ name: 'help', value: true, dynamic });
    else rest.push(words[i]);
  }
  return { globals, rest };
}

function checkJjGlobals(globals, entry) {
  for (const option of globals) {
    if (option.name === 'config') {
      const key = String(option.value ?? '').split('=')[0].trim().replace(/^"|"$/g, '');
      if (option.dynamic || RISKY_JJ_CONFIG.test(key)) refuse(`It sets ${option.dynamic ? 'a jj setting built at run time' : key} with --config, which can change what jj runs or where it pushes. Run it without --config.`);
    }
    if (['config-file', 'config-toml'].includes(option.name)) refuse(`It loads jj settings with --${option.name}, which the gate cannot read. Run it without that option.`);
  }
}

// git

const GIT_BUILTINS = new Set(['add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bugreport', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'mergetool', 'mv', 'name-rev', 'notes', 'patch-id', 'prune', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree', 'lfs', 'credential', 'send-email', 'request-pull']);
const GIT_READ_ONLY = new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'rev-list', 'ls-files', 'ls-remote', 'ls-tree', 'cat-file', 'describe', 'merge-base', 'show-ref', 'for-each-ref', 'blame', 'annotate', 'grep', 'help', 'version', 'shortlog', 'whatchanged', 'diff-tree', 'diff-index', 'diff-files', 'name-rev', 'patch-id', 'verify-commit', 'verify-tag', 'check-ignore', 'check-attr', 'count-objects', 'var', 'cherry', 'range-diff', 'show-branch', 'bugreport']);
const RISKY_GIT_CONFIG = /^(alias\.|core\.hookspath|core\.sshcommand|remote\.|url\.|push\.|include\.|includeif\.|credential\.)/i;
const GIT_PUSH = {
  long: { all: 'flag', branches: 'flag', mirror: 'flag', delete: 'flag', tags: 'flag', 'dry-run': 'flag', porcelain: 'flag', force: 'flag', 'force-with-lease': 'flag', 'force-if-includes': 'flag', 'recurse-submodules': 'value', thin: 'flag', 'receive-pack': 'value', exec: 'value', 'set-upstream': 'flag', progress: 'flag', prune: 'flag', verify: 'flag', 'follow-tags': 'flag', signed: 'flag', atomic: 'flag', 'push-option': 'value', ipv4: 'flag', ipv6: 'flag', repo: 'value', quiet: 'flag', verbose: 'flag', help: 'flag' },
  short: { d: 'delete', n: 'dry-run', f: 'force', u: 'set-upstream', o: 'push-option', q: 'quiet', v: 'verbose', 4: 'ipv4', 6: 'ipv6', h: 'help' },
  negatable: ['dry-run', 'force', 'force-with-lease', 'force-if-includes', 'recurse-submodules', 'thin', 'set-upstream', 'progress', 'prune', 'verify', 'follow-tags', 'signed', 'atomic', 'push-option', 'ipv4', 'ipv6', 'quiet', 'verbose', 'porcelain', 'delete', 'all', 'branches', 'mirror', 'tags'],
};

function splitGitGlobals(words, cwd) {
  const globals = { configs: [], repoOptions: [], help: false };
  let dir = cwd;
  let i = 0;
  for (; i < words.length; i++) {
    const { text, dynamic } = words[i];
    if (!text.startsWith('-')) break;
    if (text === '-C') {
      const next = words[++i];
      dir = !next || next.dynamic || (dir === null && !isAbsolute(next.text)) ? null : resolve(dir ?? '/', next.text);
    } else if (text === '-c') globals.configs.push(words[++i] ?? { text: '', dynamic: true });
    else if (text.startsWith('--config-env')) globals.configs.push({ text: text.split('=')[1] ?? '', dynamic: true });
    else if (/^--(git-dir|work-tree|namespace|super-prefix|exec-path)(=|$)/.test(text)) {
      globals.repoOptions.push(text.split('=')[0]);
      if (!text.includes('=') && text !== '--exec-path') i++;
    } else if (['-h', '--help', '-v', '--version', '--html-path', '--man-path', '--info-path'].includes(text) || text.startsWith('--list-cmds')) globals.help = true;
    if (dynamic && text !== '-C') globals.configs.push({ text, dynamic: true });
  }
  return { globals, dir, sub: words[i] ?? null, args: words.slice(i + 1) };
}

function gitReadOnly(sub, args) {
  if (GIT_READ_ONLY.has(sub)) return true;
  const texts = args.map((word) => word.text);
  const positional = texts.filter((text) => !text.startsWith('-'));
  if (sub === 'branch') return !texts.some((text) => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track)/.test(text)) && (!positional.length || texts.some((text) => /^(-l|--list|-a|--all|-r|--remotes|--contains|--merged|--no-merged|--points-at)$/.test(text)));
  if (sub === 'remote') return !positional.length || ['show', 'get-url'].includes(positional[0]);
  if (sub === 'config') return texts.some((text) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|get|list)$/.test(text));
  if (sub === 'tag') return !positional.length || texts.some((text) => /^(-l|--list|-v|--verify)$/.test(text));
  if (['stash', 'worktree', 'notes', 'reflog'].includes(sub)) return !positional.length || ['list', 'show'].includes(positional[0]);
  return false;
}

const levenshtein = (a, b) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
};

function gitConfigValue(dir, key) {
  const result = run('git', ['config', '--get', key], { cwd: dir, allowFail: true });
  if (result.status === 0) return result.stdout.replace(/\n$/, '');
  if (result.status === 1) return null;
  throw new Error(`git config --get ${key} failed: ${(result.stderr || result.error?.message || '').trim()}`);
}

// gh

const GH_COMMANDS = new Set(['agent-task', 'alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'codespace', 'completion', 'config', 'copilot', 'extension', 'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'preview', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'version', 'workflow']);
const GH = {
  'workflow run': { long: { ref: 'value', 'raw-field': 'value', field: 'value', json: 'flag', repo: 'value', help: 'flag' }, short: { r: 'ref', f: 'raw-field', F: 'field', R: 'repo', h: 'help' } },
  'run rerun': { long: { failed: 'flag', job: 'value', debug: 'flag', repo: 'value', help: 'flag' }, short: { j: 'job', d: 'debug', R: 'repo', h: 'help' } },
  api: { long: { method: 'value', field: 'value', 'raw-field': 'value', header: 'value', input: 'value', hostname: 'value', paginate: 'flag', slurp: 'flag', include: 'flag', silent: 'flag', template: 'value', jq: 'value', verbose: 'flag', cache: 'value', preview: 'value', help: 'flag' }, short: { X: 'method', F: 'field', f: 'raw-field', H: 'header', i: 'include', t: 'template', q: 'jq', p: 'preview', h: 'help' } },
  'pr create': { long: { base: 'value', head: 'value', draft: 'flag', title: 'value', body: 'value', 'body-file': 'value', fill: 'flag', 'fill-first': 'flag', 'fill-verbose': 'flag', web: 'flag', label: 'value', assignee: 'value', reviewer: 'value', milestone: 'value', project: 'value', 'no-maintainer-edit': 'flag', 'dry-run': 'flag', recover: 'value', template: 'value', editor: 'flag', repo: 'value', help: 'flag' }, short: { B: 'base', H: 'head', d: 'draft', t: 'title', b: 'body', F: 'body-file', f: 'fill', w: 'web', l: 'label', a: 'assignee', r: 'reviewer', m: 'milestone', p: 'project', T: 'template', e: 'editor', R: 'repo', h: 'help' } },
  'pr ready': { long: { undo: 'flag', repo: 'value', help: 'flag' }, short: { R: 'repo', h: 'help' } },
  'pr merge': { long: { admin: 'flag', auto: 'flag', body: 'value', 'body-file': 'value', 'delete-branch': 'flag', 'disable-auto': 'flag', 'match-head-commit': 'value', merge: 'flag', rebase: 'flag', squash: 'flag', subject: 'value', 'author-email': 'value', repo: 'value', help: 'flag' }, short: { b: 'body', F: 'body-file', d: 'delete-branch', m: 'merge', r: 'rebase', s: 'squash', t: 'subject', A: 'author-email', R: 'repo', h: 'help' } },
};
const PR_MERGE_MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge|updateRefs?|createRef|deleteRef|createCommitOnBranch|mergeBranch|createDeployment|createDeploymentStatus|approveDeployments|markPullRequestReadyForReview)\b/;

function ghAlias(name) {
  const result = run(ghCommand(), ['alias', 'list'], { allowFail: true, timeout: 30_000 });
  if (result.status !== 0) return null;
  const line = result.stdout.split('\n').find((entry) => entry.startsWith(`${name}:`));
  return line ? line.slice(name.length + 1).trim().replace(/^'(.*)'$/, '$1') : null;
}

const slugOf = (value) => {
  const parts = String(value).replace(/^https?:\/\//, '').replace(/\.git$/, '').split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/').toLowerCase() : null;
};

// Deploy commands

const nearestConfig = (dir) => {
  for (let current = dir; current && current !== dirname(current); current = dirname(current)) {
    const file = join(current, CONFIG_FILE);
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    }
  }
  return null;
};

const compile = (source) => {
  try { return source ? new RegExp(source) : null; } catch { return null; }
};

// Every deploy command pattern that could apply: each registered repository's, from its trunk, and
// the nearest working-copy config's, for a repository the gate has not seen yet.
function deployPatterns(startDir) {
  const patterns = registeredRepos().map((repo) => ({ regex: compile(repo.deployMatch), path: repo.path, identity: repo.identity })).filter((pattern) => pattern.regex);
  const local = compile(nearestConfig(startDir)?.deploy?.match);
  if (local) patterns.push({ regex: local, path: startDir, identity: null });
  return patterns;
}

// Where in argv a deploy pattern matches: it must start in the command's own name, so a command
// that only mentions the script (cat deploy.sh) is not a deploy. Returns the index of the word the
// match ends in, or -1.
function deployMatchEnd(argv, regex) {
  const joined = argv.join(' ');
  const match = regex.exec(joined);
  if (!match || match.index >= argv[0].length) return -1;
  const end = match.index + match[0].length;
  let offset = 0;
  for (let k = 0; k < argv.length; k++) {
    offset += argv[k].length + 1;
    if (end <= offset) return k;
  }
  return argv.length - 1;
}

// Mentions, for forms the gate cannot read. Quotes and escapes are dropped first, since quoting can
// split a name (pu"sh").
const MENTIONS = [[/\b(jj|git)\b[\s\S]*\bpush\b/, 'a push'], [/\bgh\b[\s\S]*\b(workflow|run|api|pr)\b/, 'a gh command'], [/\bagent-review\b/, 'a review command']];

export function mention(text, patterns = []) {
  const plain = String(text ?? '').replace(/["'`\\^]/g, '');
  for (const [pattern, form] of MENTIONS) if (pattern.test(plain)) return form;
  return patterns.some((pattern) => pattern.regex.test(plain)) ? 'the deploy command' : null;
}

// The walk over one command line

class Line {
  constructor(entries, patterns, startDir) {
    this.entries = entries;
    this.patterns = patterns;
    this.startDir = startDir;
    this.contexts = new Map();
    this.pending = new Map();
    this.tainted = new Map();
    this.anywhere = null;
    // A loop runs its body again after a push in it, so any jj or git command there counts as earlier.
    this.inLoop = entries.filter((entry) => entry.loop && ['jj', 'git'].includes(basename(entry.argv[0] ?? '')));
  }

  context(dir) {
    if (dir === null) return null;
    if (!this.contexts.has(dir)) this.contexts.set(dir, gateContext(dir));
    return this.contexts.get(dir);
  }

  pendingFor(ctx) {
    if (!this.pending.has(ctx.identity)) this.pending.set(ctx.identity, new Map());
    return this.pending.get(ctx.identity);
  }

  // A jj or git command that can change the repository, so a later push or deploy on the same line
  // would act on a state the gate never saw.
  taint(ctx, label) {
    if (!ctx) this.anywhere ??= label;
    else if (!this.tainted.has(ctx.identity)) this.tainted.set(ctx.identity, label);
  }

  sameLine(ctx, entry) {
    const earlier = this.tainted.get(ctx.identity) ?? this.anywhere;
    if (earlier) refuse(`An earlier command on this line (\`${earlier}\`) can change what this acts on, and the gate checks the repository as it is now. Run that command on its own first.`);
    if (entry.loop && this.inLoop.some((other) => other !== entry)) refuse('It repeats in a loop with another jj or git command, which can change what the next round acts on. Run each push or deploy on its own.');
    const env = Object.keys(entry.env).filter((key) => /^(GIT_|JJ_)/.test(key));
    if (env.length) refuse(`It sets ${env.join(', ')}, which can change the repository, its config or its hooks. Run it without that variable.`);
    if (this.envTaint) refuse(`An earlier command on this line sets ${this.envTaint}, which can change the repository, its config or its hooks. Run it on its own first.`);
  }
}

const words = (entry, from = 1) => entry.argv.slice(from).map((text, i) => ({ text, dynamic: entry.dynamic[i + from] }));
const labelOf = (argv) => argv.join(' ').slice(0, 100);

function refuseDynamic(list) {
  const found = list.find((word) => word.dynamic);
  if (found) refuse(`An argument is built at run time (${found.text || '$...'}). Write it out, so the gate checks what actually runs.`);
}

function checkJj(line, entry, wordsIn, depth = 0) {
  const label = labelOf(entry.argv);
  const { globals, rest } = splitJjGlobals(wordsIn);
  const repoOption = globals.filter((option) => option.name === 'repository').at(-1);
  const dir = repoOption ? (repoOption.dynamic || repoOption.value === undefined ? null : isAbsolute(repoOption.value) ? repoOption.value : entry.cwd === null ? null : resolve(entry.cwd, repoOption.value)) : entry.cwd;
  const head = rest[0]?.text;
  const mayPush = !head || !JJ_COMMANDS.has(head) || (head === 'git' && rest[1]?.text === 'push') || head === 'util';
  if (dir === null) {
    if (mayPush) refuse(UNKNOWN_DIR);
    line.taint(null, label);
    return;
  }
  const ctx = line.context(dir);
  if (!ctx) return;
  checkJjGlobals(globals, entry);
  // Aliases, jj's own and the user's, and the default command, until a built-in command remains.
  let sub = rest;
  for (let expansions = 0; ; expansions++) {
    if (expansions > 5) refuse('Its jj aliases expand more than five times. Run the command they stand for.');
    const name = sub[0];
    if (name?.dynamic) refuse('Its jj subcommand is built at run time. Write it out.');
    if (!name) {
      const configured = jjConfigValue(ctx.repo, 'ui.default-command');
      sub = (configured === null ? ['log'] : parseTomlStrings(configured) ?? [configured]).map((text) => ({ text, dynamic: false }));
      continue;
    }
    if (JJ_BUILTIN_ALIASES[name.text]) {
      sub = [{ text: JJ_BUILTIN_ALIASES[name.text], dynamic: false }, ...sub.slice(1)];
      continue;
    }
    if (JJ_COMMANDS.has(name.text)) break;
    // An alias comes from jj's config, which a JJ_ variable can point elsewhere than the gate reads.
    const envKeys = Object.keys(entry.env).filter((key) => /^JJ_/.test(key));
    if (envKeys.length) refuse(`It sets ${envKeys.join(', ')}, so the gate cannot read the jj alias ${name.text} as jj will. Run it without that variable.`);
    const alias = jjConfigValue(ctx.repo, `aliases.${name.text}`);
    if (alias === null) return;
    const expanded = parseTomlStrings(alias) ?? refuse(`The gate cannot read the jj alias ${name.text} (${alias}). Run the command it stands for.`);
    const split = splitJjGlobals(expanded.map((text) => ({ text, dynamic: false })));
    checkJjGlobals(split.globals, entry);
    globals.push(...split.globals);
    sub = [...split.rest, ...sub.slice(1)];
  }
  const path = sub.map((word) => word.text);
  if (path[0] === 'bookmark' && JJ_BOOKMARK_ALIASES[path[1]]) path[1] = JJ_BOOKMARK_ALIASES[path[1]];
  if (path[0] === 'util' && path[1] === 'exec') {
    const argv = sub.slice(path[2] === '--' ? 3 : 2);
    if (!argv.length) return;
    return checkEntry(line, { ...entry, argv: argv.map((word) => word.text), dynamic: argv.map((word) => word.dynamic) }, depth + 1);
  }
  if (globals.some((option) => option.name === 'help') || path.includes('--help') || path.includes('-h')) return;
  const ignoreWc = globals.some((option) => ['ignore-working-copy', 'at-operation'].includes(option.name));
  if (path[0] === 'git' && path[1] === 'push') return checkJjPush(line, entry, ctx, globals, sub.slice(2), ignoreWc);
  if (path[0] === 'bookmark' && ['set', 'create', 'move'].includes(path[1])) return noteBookmark(line, entry, ctx, globals, path[1], sub.slice(2), ignoreWc);
  if (JJ_READ_ONLY.has(path.slice(0, 3).join(' ')) || JJ_READ_ONLY.has(path.slice(0, 2).join(' ')) || JJ_READ_ONLY.has(path[0])) return;
  line.taint(ctx, label);
}

// `jj bookmark set|create|move NAME... -r REV` earlier on the line, so a push after it is checked
// against the commit it will point to. Anything the gate cannot pin down counts as a change.
function noteBookmark(line, entry, ctx, globals, action, args, ignoreWc) {
  const label = labelOf(entry.argv);
  const parsed = parseOptions(args, JJ_BOOKMARK[action]);
  const names = parsed.positionals.map((word) => (word.dynamic ? null : plainName(word.text)));
  const rev = (parsed.last('revision') ?? parsed.last('to'))?.value ?? '@';
  const unpinned = entry.xargs || globals.some((option) => option.name === 'at-operation') || parsed.unknown.length || parsed.options.some((option) => option.dynamic) || parsed.has('from') || !names.length || names.includes(null) || line.tainted.has(ctx.identity);
  if (unpinned) return line.taint(ctx, label);
  let ids;
  try {
    ids = commitIds(ctx.repo, rev);
  } catch (error) {
    if (error instanceof RevsetError) return line.taint(ctx, label);
    throw error;
  }
  if (ids.length !== 1 || (!ignoreWc && inWorkingCopies(ctx.repo, ids).length)) return line.taint(ctx, label);
  for (const name of names) line.pendingFor(ctx).set(name, { target: ids[0], conflict: false });
}

function checkJjPush(line, entry, ctx, globals, args, ignoreWc) {
  const { repo, config } = ctx;
  if (entry.xargs) refuse(XARGS);
  line.sameLine(ctx, entry);
  if (globals.some((option) => option.name === 'at-operation')) refuse('It pushes from an earlier operation, which the gate does not read. Push without --at-op.');
  const parsed = parseOptions(args, JJ_PUSH);
  if (parsed.unknown.length) refuse(`It has an option the gate does not know (${parsed.unknown.join(', ')}).`);
  refuseDynamic([...parsed.options.map((option) => ({ text: String(option.value), dynamic: option.dynamic })), ...parsed.positionals]);
  if (parsed.has('help')) return;
  if (parsed.has('tag')) refuse('It pushes tags. Agents push only branches (push.branches).');
  if (parsed.options.some((option) => option.missing)) refuse('An option is missing its value.');
  if (parsed.has('dry-run')) return;
  const remote = parsed.last('remote')?.value ?? jjConfigValue(repo, 'git.push') ?? (() => {
    const names = remoteNames(repo);
    return names.length === 1 ? names[0] : 'origin';
  })();
  if (remote !== config.remote) refuse(`It pushes to ${remote}. Agents push only to ${config.remote}.`);
  const table = bookmarkTable(repo, remote);
  const tags = tagTable(repo, remote);
  const pending = line.pendingFor(ctx);
  const local = (name) => (pending.has(name) ? pending.get(name) : table.local.get(name) ?? null);
  const pushes = [];
  const names = [];
  for (const { value } of parsed.values('bookmark')) names.push(plainName(value) ?? refuse(`It names bookmarks by a pattern (${value}). Name each bookmark exactly, as -b <name>.`));
  for (const { value } of parsed.values('named')) {
    const at = value.indexOf('=');
    const name = at > 0 ? plainName(value.slice(0, at)) : null;
    if (!name) refuse(`--named takes NAME=REVISION with a plain name, not ${value}.`);
    const ids = resolveRevset(repo, value.slice(at + 1));
    if (ids.length !== 1) refuse(`--named ${value} must name exactly one commit, found ${ids.length}.`);
    pushes.push({ bookmark: name, target: ids[0] });
  }
  for (const { value } of parsed.values('revision')) {
    const ids = new Set(resolveRevset(repo, value));
    const named = [...new Set([...table.local.keys(), ...pending.keys()])].filter((name) => ids.has(local(name)?.target));
    if ([...tags.local.values()].some((target) => ids.has(target))) refuse(`-r ${value} also pushes a tag. Agents push only branches.`);
    names.push(...named);
  }
  if (parsed.has('change')) {
    const template = jjConfigValue(repo, 'templates.git_push_bookmark') ?? '"push-" ++ change_id.short()';
    for (const { value } of parsed.values('change')) {
      for (const row of jj(repo, ['log', '--no-graph', '-r', value, '-T', `${template} ++ "\x1f" ++ commit_id ++ "\\n"`]).split('\n').filter(Boolean)) {
        const [name, target] = row.split('\x1f');
        if (!/^[0-9a-f]{40}$/.test(target ?? '')) throw new Error(`could not read the bookmark name -c ${value} would create`);
        pushes.push({ bookmark: name, target });
      }
    }
  }
  const tagChanged = (name, target) => tags.remote.get(name)?.target !== target;
  if (parsed.has('all')) {
    if ([...tags.local].some(([name, target]) => tagChanged(name, target))) refuse('--all also pushes tags. Agents push only branches: name each bookmark with -b.');
    names.push(...new Set([...table.local.keys(), ...pending.keys()]));
  }
  if (parsed.has('tracked')) names.push(...[...new Set([...table.local.keys(), ...pending.keys()])].filter((name) => table.remote.get(name)?.tracked));
  if (parsed.has('deleted')) {
    if ([...tags.remote].some(([name, entry]) => entry.tracked && !tags.local.has(name))) refuse('--deleted also deletes tags. Agents push only branches.');
    for (const [name, entry] of table.remote) if (entry.tracked && !local(name)) pushes.push({ bookmark: name, target: null });
  }
  const selected = ['bookmark', 'named', 'revision', 'change', 'all', 'tracked', 'deleted'].some((name) => parsed.has(name));
  if (!selected) refuse('It pushes whatever bookmarks jj picks. Name each bookmark with -b <name>.');
  for (const name of new Set(names)) {
    const found = local(name);
    if (found?.conflict) refuse(`${name} is conflicted here. Resolve it (jj bookmark set ${name} -r <rev>) before pushing.`);
    // When the bookmark command earlier on the line fails (a backward move without -B, a create of a
    // name that exists), a push after `;` sends the bookmark where it is now, so that is checked too.
    const now = table.local.get(name);
    if (pending.has(name) && now?.target && now.target !== found?.target) pushes.push({ bookmark: name, target: now.target });
    if (found?.target) pushes.push({ bookmark: name, target: found.target });
    else if (!found && table.remote.get(name)?.tracked) pushes.push({ bookmark: name, target: null });
    else refuse(`${name} points nowhere here, and it is not a tracked bookmark deleted locally, so the gate cannot tell what the push does.`);
  }
  // A bookmark already where the remote has it is not pushed, so --all and --tracked name only what moves.
  const moving = pushes.filter((push) => (push.target === null ? table.remote.has(push.bookmark) : table.remote.get(push.bookmark)?.target !== push.target));
  pushes.splice(0, pushes.length, ...moving);
  const targets = pushes.map((push) => push.target).filter(Boolean);
  if (!ignoreWc) {
    const open = inWorkingCopies(repo, targets);
    if (open.length) refuse(`${short(open[0])} is a working-copy commit or sits on one, so jj would snapshot edits on disk into it before pushing. Commit the work (jj commit), then push the commit below @.`);
  }
  return pushes.flatMap((push) => checkPush(ctx, push).map((problem) => `${push.bookmark}: ${problem}`));
}

function resolveRevset(repo, revset) {
  try {
    return commitIds(repo, revset);
  } catch (error) {
    if (error instanceof RevsetError) refuse(`The gate cannot resolve ${revset}: ${error.message}`);
    throw error;
  }
}

// One ref a push moves. `remoteTip` is the remote's real commit when the caller knows it (git's
// pre-push hook), else jj's view of the remote, which jj's own push checks match.
export function checkPush(ctx, push, { remoteTip } = {}) {
  const { config, repo } = ctx;
  const trunk = config.trunk;
  if (push.target === null) {
    if (push.bookmark === trunk) return [`It deletes ${trunk}. Agents never delete trunk.`];
    if (!matchesAny(push.bookmark, config.push.branches)) return [`It deletes ${push.bookmark}, which is not a branch agents push to (push.branches: ${config.push.branches.join(', ')}).`];
    return [];
  }
  if (push.bookmark === trunk) {
    if (config.deploy.runBy === 'user') return [userRuns(config, `jj git push --remote ${config.remote} --bookmark ${trunk}`)];
    const remote = remoteTip !== undefined ? remoteTip : remoteBookmarkTarget(repo, trunk, config.remote);
    if (remote && remote !== push.target && !isAncestor(repo, remote, push.target)) return [`${trunk} on ${config.remote} is at ${short(remote)}, which is not an ancestor of ${short(push.target)}. Moving it would be a force push of trunk.`];
    return [...holeProblems(ctx, push.target), ...deployProblems(ctx, runForCommit(ctx.identity, push.target), push.target).map((problem) => `Moving ${trunk} is a deploy step: ${problem}`)];
  }
  return pushProblems(ctx, push.bookmark, push.target, { remoteTip });
}

function checkGit(line, entry, wordsIn) {
  const label = labelOf(entry.argv);
  const { globals, dir, sub, args } = splitGitGlobals(wordsIn, entry.cwd);
  if (globals.help || !sub) return;
  const mayPush = sub.dynamic || sub.text === 'push' || !GIT_BUILTINS.has(sub.text);
  if (dir === null) {
    if (mayPush) refuse(UNKNOWN_DIR);
    line.taint(null, label);
    return;
  }
  const ctx = line.context(dir);
  if (!ctx) return;
  for (const config of globals.configs) {
    const key = config.text.split('=')[0];
    if (config.dynamic || RISKY_GIT_CONFIG.test(key)) refuse(`It sets ${config.dynamic ? 'a git setting built at run time' : key} with -c, which can change git's aliases, remotes or hooks. Run it without -c.`);
  }
  if (sub.dynamic) refuse('Its git subcommand is built at run time. Write it out.');
  let name = sub.text;
  let rest = args;
  if (!GIT_BUILTINS.has(name)) {
    const alias = gitConfigValue(dir, `alias.${name}`);
    if (alias === null) {
      if (levenshtein(name, 'push') <= 2) refuse(`git may autocorrect ${name} to push (help.autocorrect). Spell the command out.`);
      return;
    }
    if (alias.startsWith('!')) {
      if (mention(alias, line.patterns)) refuse(`It runs the git alias ${name}, a shell command the gate does not follow. Run the commands it stands for.`);
      return line.taint(ctx, label);
    }
    const expanded = alias.split(/\s+/).filter(Boolean).map((text) => ({ text, dynamic: false }));
    const again = splitGitGlobals([...expanded, ...args], dir);
    for (const config of again.globals.configs) if (RISKY_GIT_CONFIG.test(config.text.split('=')[0])) refuse(`The git alias ${name} sets ${config.text.split('=')[0]}. Run the command it stands for.`);
    if (!again.sub) return;
    name = again.sub.text;
    rest = again.args;
  }
  if (name === 'push') return checkGitPush(line, entry, ctx, dir, globals, rest);
  if (!gitReadOnly(name, rest)) line.taint(ctx, label);
}

function checkGitPush(line, entry, ctx, dir, globals, args) {
  const { config, repo } = ctx;
  if (entry.xargs) refuse(XARGS);
  line.sameLine(ctx, entry);
  if (globals.repoOptions.length) refuse(`It points git at another repository or program (${globals.repoOptions.join(', ')}). Push from the workspace without it.`);
  const parsed = parseGitOptions(args, GIT_PUSH);
  if (parsed.unknown.length) refuse(`It has an option the gate does not read (${parsed.unknown.join(', ')}). Spell each option out in full.`);
  refuseDynamic([...parsed.options.map((option) => ({ text: String(option.value), dynamic: option.dynamic })), ...parsed.positionals]);
  const on = (name) => parsed.options.some((option) => option.name === name && !option.negated);
  // Force and no-verify first, in any spelling, so no later option (a dry run) can hide them.
  if (['force', 'force-with-lease', 'force-if-includes', 'mirror'].some(on)) refuse('It is a force push. Never force push: push to a new branch name instead.');
  if (parsed.options.some((option) => option.name === 'verify' && option.negated)) refuse('It skips the pre-push hook (--no-verify).');
  if (['all', 'branches', 'tags', 'prune', 'follow-tags'].some(on)) refuse('It pushes more than the named branches. Name each branch.');
  if (['receive-pack', 'exec'].some(on)) refuse('It runs another program on the remote. Push without --receive-pack or --exec.');
  const recurse = parsed.options.filter((option) => option.name === 'recurse-submodules' && !option.negated).at(-1);
  if (recurse && !['check', 'no'].includes(recurse.value)) refuse('It can push submodules too. Push them on their own.');
  if (on('help')) return;
  const dryRun = parsed.options.filter((option) => option.name === 'dry-run').at(-1);
  if (dryRun && !dryRun.negated) return;
  const repoOption = parsed.options.filter((option) => option.name === 'repo').at(-1)?.value;
  const positionals = parsed.positionals.map((word) => word.text);
  const remote = positionals[0] ?? repoOption;
  const refspecs = positionals.slice(1);
  if (remote === undefined) refuse('It pushes wherever git picks. Name the remote and the branch: git push origin <src>:refs/heads/<branch>.');
  if (remote !== config.remote) refuse(`It pushes to ${remote}. Agents push only to ${config.remote}, by name.`);
  if (!refspecs.length) refuse('It pushes whatever git picks. Name the branch.');
  if (refspecs[0] === 'tag') refuse('It pushes a tag. Agents push only branches.');
  const deleting = on('delete');
  const specs = refspecs.map((spec) => {
    if (spec.startsWith('+')) refuse(`${spec} is a force push. Never force push.`);
    if (/^\^|[*]/.test(spec)) refuse(`${spec} is a pattern or a negative refspec. Name each branch.`);
    const at = spec.indexOf(':');
    const src = at === -1 ? spec : spec.slice(0, at);
    const dst = at === -1 ? spec : spec.slice(at + 1);
    if (dst.startsWith('refs/') && !dst.startsWith('refs/heads/')) refuse(`${dst} is not a branch. Agents push only branches.`);
    const bookmark = dst.replace(/^refs\/heads\//, '');
    if (!plainName(bookmark)) refuse(`The gate cannot tell which branch ${spec} pushes to. Write src:refs/heads/<branch>.`);
    if (!deleting && src !== '' && at === -1 && (src === 'HEAD' || src === '@' || /^[0-9a-f]{7,40}$/.test(src))) refuse(`${src} has no branch name of its own. Write ${src}:refs/heads/<branch>.`);
    return { src, bookmark };
  });
  // git finds its repository from the folder. Where it finds none the push fails by itself.
  const gitAbs = run('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, allowFail: true });
  if (gitAbs.status !== 0) return;
  if (realpathSync(gitAbs.stdout.trim()) !== realpathSync(gitDir(repo))) refuse(`git would push from ${gitAbs.stdout.trim()}, which is not this repository's. Push from the main workspace.`);
  const pushes = [];
  for (const { src, bookmark } of specs) {
    if (deleting || src === '') {
      pushes.push({ bookmark, target: null });
      continue;
    }
    const target = run('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${src}^{commit}`], { cwd: dir, allowFail: true });
    if (target.status !== 0) refuse(`The gate cannot tell which commit ${src} is. Push a bookmark with jj git push -b <name>.`);
    pushes.push({ bookmark, target: target.stdout.trim() });
  }
  return pushes.flatMap((push) => checkPush(ctx, push).map((problem) => `${push.bookmark}: ${problem}`));
}

// gh

function ghRepo(line, entry, parsed, endpointSlug) {
  const option = parsed?.last('repo');
  if (option?.dynamic) refuse('Its --repo is built at run time. Write it out.');
  const fromEnv = entry.env.GH_REPO;
  if (fromEnv?.dynamic) refuse('GH_REPO is built at run time. Write it out.');
  const cwdCtx = line.context(entry.cwd);
  const named = endpointSlug ?? (option ? slugOf(option.value) : fromEnv ? slugOf(fromEnv.value) : null);
  if (!named) {
    if (entry.cwd === null) refuse('The gate cannot tell which repository it acts on. Run it from the workspace, or pass -R owner/repo.');
    return cwdCtx;
  }
  if (cwdCtx?.slug?.toLowerCase() === named) return cwdCtx;
  // Another repository: gated when it is a configured one on this machine, and never read in place of it.
  const registered = registeredRepos().find((repo) => repo.slug?.toLowerCase() === named);
  if (!registered) return null;
  const ctx = line.context(registered.path);
  return ctx?.slug?.toLowerCase() === named ? ctx : null;
}

function checkGh(line, entry, wordsIn, depth) {
  let list = wordsIn;
  const top = list[0];
  if (!top) return;
  if (top.dynamic) refuse('Its gh command is built at run time. Write it out.');
  if (!GH_COMMANDS.has(top.text)) {
    const alias = ghAlias(top.text);
    if (alias === null) return;
    if (alias.startsWith('!')) {
      if (mention(alias, line.patterns)) refuse(`It runs the gh alias ${top.text}, a shell command the gate does not follow. Run the commands it stands for.`);
      return;
    }
    if (depth > 3) refuse('Its gh aliases expand too many times.');
    list = [...alias.split(/\s+/).filter(Boolean).map((text) => ({ text, dynamic: false })), ...list.slice(1)];
    return checkGh(line, entry, list, depth + 1);
  }
  const sub = `${top.text} ${list[1]?.text ?? ''}`;
  if (sub === 'workflow run') return ghWorkflowRun(line, entry, parseOptions(list.slice(2), GH[sub]));
  if (sub === 'run rerun') return ghRunRerun(line, entry, parseOptions(list.slice(2), GH[sub]));
  if (top.text === 'api') return ghApi(line, entry, parseOptions(list.slice(1), GH.api));
  if (['pr create', 'pr ready', 'pr merge'].includes(sub)) return ghPr(line, entry, list[1].text, parseOptions(list.slice(2), GH[sub]));
  if (['pr checkout', 'repo sync'].includes(sub)) line.taint(line.context(entry.cwd), labelOf(entry.argv));
}

function ghWorkflowRun(line, entry, parsed) {
  if (entry.xargs) refuse(XARGS);
  const ctx = ghRepo(line, entry, parsed);
  if (!ctx) return;
  refuseDynamic([...parsed.options.map((option) => ({ text: String(option.value), dynamic: option.dynamic })), ...parsed.positionals]);
  if (parsed.has('help')) return;
  const { config } = ctx;
  const prod = new RegExp(config.deploy.prodPattern, 'i');
  const workflow = parsed.positionals[0]?.text;
  if (!workflow || /^\d+$/.test(workflow)) refuse('Name the workflow by its file name, so the gate can tell what it runs.');
  if (parsed.has('json')) refuse('--json reads the inputs from stdin, which the gate cannot see. Pass each input with -f key=value.');
  const fields = [...parsed.values('raw-field'), ...parsed.values('field')].map((option) => String(option.value));
  if (parsed.values('field').some((option) => String(option.value).split('=').slice(1).join('=').startsWith('@'))) refuse('An input is read from a file the gate cannot see. Pass each input with -f key=value.');
  if (prod.test(workflow) || fields.some((field) => prod.test(field.split('=').slice(1).join('=')))) refuse(NEVER_PROD);
  if (!new RegExp(config.deploy.deployWorkflows, 'i').test(workflow)) return;
  if (config.deploy.runBy === 'user') refuse(userRuns(config));
  line.sameLine(ctx, entry);
  const ref = parsed.last('ref')?.value;
  if (!ref) refuse('Pass --ref with the branch to deploy, so the gate can check the commit GitHub runs.');
  // GitHub runs the ref as GitHub has it, so that is the commit the gate checks.
  const branch = remoteRef(ctx.slug, 'heads', ref);
  if (!branch || typeof branch !== 'string') refuse(`${ref} is not a branch on ${ctx.slug}. Push it first, and pass the branch name.`);
  if (remoteRef(ctx.slug, 'tags', ref)) refuse(`${ref} names both a branch and a tag on ${ctx.slug}, so the gate cannot tell which GitHub runs.`);
  const seen = remoteBookmarkTarget(ctx.repo, ref, config.remote);
  if (seen !== branch) refuse(`${ref} on GitHub is at ${short(branch)}, but this repository last saw it at ${short(seen) ?? 'nothing'}. Run jj git fetch, then check again.`);
  return deployProblems(ctx, runForCommit(ctx.identity, branch), branch);
}

function ghRunRerun(line, entry, parsed) {
  const ctx = ghRepo(line, entry, parsed);
  if (!ctx) return;
  refuseDynamic([...parsed.options.map((option) => ({ text: String(option.value), dynamic: option.dynamic })), ...parsed.positionals]);
  if (parsed.has('help')) return;
  const id = parsed.positionals[0]?.text;
  if (!id || !/^\d+$/.test(id)) refuse('Name the run ID, so the gate can tell what the rerun runs.');
  const name = workflowName(ctx.slug, id);
  if (new RegExp(ctx.config.deploy.prodPattern, 'i').test(name)) refuse(NEVER_PROD);
  if (new RegExp(ctx.config.deploy.deployWorkflows, 'i').test(name)) refuse('A rerun of a deploy repeats inputs the gate cannot see. Dispatch the deploy again with gh workflow run --ref.');
}

function ghApi(line, entry, parsed) {
  refuseDynamic(parsed.positionals.slice(0, 1));
  if (parsed.has('help')) return;
  const methodOption = parsed.last('method');
  if (methodOption?.dynamic) refuse('Its method is built at run time. Write it out.');
  const fields = [...parsed.values('field'), ...parsed.values('raw-field')];
  const method = (methodOption?.value ?? (fields.length || parsed.has('input') ? 'POST' : 'GET')).toUpperCase();
  if (['GET', 'HEAD'].includes(method)) return;
  const endpoint = (parsed.positionals[0]?.text ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '').split('?')[0];
  const field = (key) => fields.filter((option) => String(option.value).startsWith(`${key}=`)).map((option) => ({ value: String(option.value).slice(key.length + 1), dynamic: option.dynamic })).at(-1);
  if (endpoint === 'graphql') {
    const query = field('query');
    if (!query || query.dynamic || query.value.startsWith('@')) {
      if (parsed.has('input') || query) refuse('Its GraphQL query is read from a file or built at run time. Pass the query with -f query=... so the gate can read it.');
      return;
    }
    if (PR_MERGE_MUTATIONS.test(query.value)) refuse('It merges, moves a branch, commits or deploys through GraphQL, which the gate does not check. Use gh pr merge, jj git push or gh workflow run.');
    return;
  }
  const match = /^repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(endpoint);
  if (!match) return;
  const cwdCtx = line.context(entry.cwd);
  const fill = (part) => (part === '{owner}' ? cwdCtx?.slug?.split('/')[0] : part === '{repo}' ? cwdCtx?.slug?.split('/')[1] : part);
  const owner = fill(match[1]);
  const name = fill(match[2]);
  if (!owner || !name) refuse('Its {owner}/{repo} placeholders need a repository the gate can find. Run it from the workspace.');
  const ctx = ghRepo(line, entry, null, `${owner}/${name}`.toLowerCase());
  if (!ctx) return;
  const rest = match[3];
  const prod = new RegExp(ctx.config.deploy.prodPattern, 'i');
  const dispatch = /^actions\/workflows\/([^/]+)\/dispatches$/.exec(rest);
  if (dispatch) {
    if (prod.test(decodeURIComponent(dispatch[1])) || fields.some((option) => prod.test(String(option.value).split('=').slice(1).join('=')))) refuse(NEVER_PROD);
    refuse(`Dispatch it with gh workflow run ${decodeURIComponent(dispatch[1])} --ref <branch>, so the gate can check the workflow and the commit.`);
  }
  if (rest === 'dispatches') refuse('A repository_dispatch event can start a deploy the gate cannot check.');
  if (/^actions\/(runs|jobs)\/\d+\/(rerun|rerun-failed-jobs)$/.test(rest) || /^actions\/runs\/\d+\/jobs\/\d+\/rerun$/.test(rest)) refuse('Rerun it with gh run rerun <id>, so the gate can check the workflow.');
  if (/^actions\/runs\/\d+\/pending_deployments$/.test(rest)) refuse('It approves a pending deployment. The user approves deployments.');
  if (/^deployments(\/|$)/.test(rest)) refuse('It records or starts a deployment, which the gate does not check.');
  if (/^statuses\/[^/]+$/.test(rest)) {
    const context = field('context');
    if (parsed.has('input') || !context || context.dynamic || /^pipeline\//.test(context.value) || context.value === 'agent-review') refuse('The pipeline/* and agent-review statuses are set only by the tools that check them. Record the stage with its pipeline command instead.');
    return;
  }
  if (/^pulls\/\d+\/merge$/.test(rest)) refuse(`Merge it with gh pr merge ${rest.split('/')[1]}, so the gate can check it.`);
  if (['merges', 'merge-upstream'].includes(rest) || /^branches\/[^/]+\/rename$/.test(rest)) refuse('It merges or renames branches on GitHub, which the gate does not check. Push with jj git push instead.');
  if (/^git\/refs(\/|$)/.test(rest)) refuse('It moves a branch on GitHub without the gate. Push with jj git push -b <name>.');
  if (/^contents\//.test(rest)) refuse('It commits on GitHub without the scan or review. Commit locally and push.');
  if (rest === 'pulls' && provider(ctx.config) === 'builtin' && field('draft')?.value !== 'true') refuse('It opens a pull request ready for review. Create it with gh pr create --draft.');
}

function ghPr(line, entry, action, parsed) {
  if (entry.xargs) refuse(XARGS);
  const ctx = ghRepo(line, entry, parsed);
  if (!ctx) return;
  refuseDynamic([...parsed.options.map((option) => ({ text: String(option.value), dynamic: option.dynamic })), ...parsed.positionals]);
  if (parsed.has('help')) return;
  const { config } = ctx;
  const builtin = provider(config) === 'builtin';
  const reviewProblems = (head) => {
    const missing = reviewCoverage(ctx.repo, head, config).filter((commit) => !reviewPassed(commit));
    return missing.length ? [`${missing.length} commit(s) lack review consensus: ${missing.slice(0, 5).map((commit) => short(commit.id)).join(', ')}.`] : [];
  };
  const localCommit = (sha) => {
    if (!resolveRevset(ctx.repo, `present(${sha})`).length) refuse(`${short(sha)} is not in this repository yet. Run jj git fetch, then check again.`);
    return sha;
  };
  if (action === 'create') {
    if (!builtin || parsed.has('draft') || parsed.has('dry-run')) return;
    const head = parsed.last('head')?.value;
    if (!head || head.includes(':')) refuse('It opens a pull request ready for review. Create it with --draft, or pass --head <branch> of this repository so the gate can check its commits.');
    const sha = remoteRef(ctx.slug, 'heads', head);
    if (!sha || typeof sha !== 'string') refuse(`${head} is not a branch on ${ctx.slug}. Push it first.`);
    return reviewProblems(localCommit(sha));
  }
  if (parsed.has('undo') || parsed.has('disable-auto')) return;
  const pr = parsed.positionals[0]?.text;
  if (!pr) refuse('Name the pull request, so the gate can check its commits.');
  const info = pullRequest(ctx.slug, pr);
  if (action === 'merge' && info.base === config.trunk) {
    if (config.deploy.runBy === 'user') refuse(userRuns(config, `gh pr merge ${pr}`));
    line.sameLine(ctx, entry);
    const head = localCommit(info.head);
    return [...holeProblems(ctx, head), ...deployProblems(ctx, runForCommit(ctx.identity, head), head).map((problem) => `Merging into ${config.trunk} is a deploy step: ${problem}`)];
  }
  if (!builtin) return;
  return reviewProblems(localCommit(info.head));
}

// agent-review

const REVIEW_VALUES = ['--topic', '--tip', '--dir', '--repo', '--to', '--phase', '--file', '--from', '--model', '--effort', '--provider'];
function reviewFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    if (REVIEW_VALUES.includes(args[i])) i++;
  }
  return undefined;
}

function checkReview(line, entry) {
  const ctx = line.context(entry.cwd);
  if (!ctx) return;
  const [sub, ...args] = entry.argv.slice(1);
  if (!['start', 'ask'].includes(sub)) return;
  const topic = reviewFlag(args, '--topic');
  if (!topic) return;
  const runEntry = loadRuns().find((candidate) => candidate.identity === ctx.identity && candidate.reviewTopics?.[topic]);
  if (!runEntry) return;
  const kind = runEntry.reviewTopics[topic];
  if (sub === 'start') {
    if (kind === 'design' && !['noted', 'passed'].includes(runEntry.stages.design?.state)) refuse(`The design note of run ${runEntry.id} has not passed its checks. Run pipeline design first.`);
    if (kind === 'code' && !passed(runEntry, 'build')) refuse(`Run ${runEntry.id}'s build has not passed. Run pipeline build --run ${runEntry.id}.`);
    return;
  }
  const phase = reviewFlag(args, '--phase') ?? 'review';
  const found = agentReviewEntries(ctx.config).find((candidate) => candidate.topic === topic) ?? findEntry(ctx.config, topic);
  if (phase !== 'review' || !found || found.rounds.length !== 1) return;
  const to = reviewFlag(args, '--to');
  const own = to ? join(found.folder, 'round-1', `request-${to}.md`) : null;
  const file = reviewFlag(args, '--file') ?? (own && existsSync(own) ? own : join(found.folder, 'round-1', 'request.md'));
  if (!existsSync(file)) return;
  if (!normalizeWords(readFileSync(file, 'utf8')).includes(normalizeWords(runEntry.intake.words))) refuse(`${file} does not quote the user's words for run ${runEntry.id} verbatim. Paste them into "The user's words".`);
}

// The deploy command

function checkDeploy(line, entry) {
  for (const pattern of line.patterns) {
    if (deployMatchEnd(entry.argv, pattern.regex) === -1) continue;
    const ctx = pattern.identity === null ? line.context(entry.cwd ?? pattern.path) : line.context(pattern.path);
    if (!ctx || (pattern.identity !== null && ctx.identity !== pattern.identity)) continue;
    const regex = compile(ctx.config.deploy.match);
    const end = regex ? deployMatchEnd(entry.argv, regex) : -1;
    if (end === -1) continue;
    return deployCommand(line, entry, ctx, end);
  }
}

function deployCommand(line, entry, ctx, end) {
  const { config } = ctx;
  if (entry.xargs) refuse(XARGS);
  const configured = (config.deploy.command ?? '').trim().split(/\s+/)[0];
  if (entry.interpreter && basename(configured) !== entry.interpreter.split(' ')[0]) refuse(`It runs the deploy script through ${entry.interpreter}. Run it as deploy.command does: ${config.deploy.command ?? '(deploy.command is not set)'}.`);
  if (config.deploy.runBy === 'user') refuse(userRuns(config));
  line.sameLine(ctx, entry);
  if (!config.deploy.tipArg) refuse('The gate cannot tell which commit this deploys. Set deploy.tipArg.');
  const args = words(entry, end + 1).filter((word) => !word.text.startsWith('-'));
  const rev = args[config.deploy.tipArg - 1];
  if (!rev) refuse(`Argument ${config.deploy.tipArg} must be the revision it deploys.`);
  refuseDynamic([rev]);
  const pending = line.pendingFor(ctx).get(rev.text);
  const ids = pending ? [pending.target] : resolveRevset(ctx.repo, rev.text);
  if (ids.length !== 1) refuse(`${rev.text} must name exactly one commit, found ${ids.length}.`);
  if (inWorkingCopies(ctx.repo, ids).length) refuse(`${short(ids[0])} is a working-copy commit or sits on one, so what it holds can change before the deploy reads it. Commit the work and deploy the commit.`);
  return deployProblems(ctx, runForCommit(ctx.identity, ids[0]), ids[0]);
}

// Entries

function checkEntry(line, entry, depth = 0) {
  if (entry.assignsOnly || ['export', 'declare', 'typeset', 'readonly', 'local'].includes(entry.argv[0])) {
    const names = entry.assignsOnly ?? entry.argv.slice(1).map((arg) => arg.split('=')[0]);
    const risky = names.filter((name) => /^(GIT_|JJ_)/.test(name));
    if (risky.length) line.envTaint ??= risky.join(', ');
    return;
  }
  if (entry.opaque || !entry.argv.length) return;
  const name = basename(entry.argv[0]);
  if (name === 'jj') return checkJj(line, entry, words(entry), depth);
  if (name === 'git') return checkGit(line, entry, words(entry));
  if (name === 'gh') return checkGh(line, entry, words(entry), 0);
  if (name === 'agent-review') return checkReview(line, entry);
  return checkDeploy(line, entry);
}

// Whether an entry is one the gate must look at closely, decided without running anything.
function candidate(entry, patterns) {
  if (entry.opaque || !entry.argv.length) return false;
  const name = basename(entry.argv[0]);
  if (name === 'agent-review') return true;
  if (name === 'gh') return !GH_COMMANDS.has(entry.argv[1]) || ['workflow', 'run', 'api', 'pr', 'repo'].includes(entry.argv[1]);
  if (name === 'git') {
    const sub = entry.argv.slice(1).find((arg, i, all) => !arg.startsWith('-') && !['-C', '-c'].includes(all[i - 1]));
    return !sub || sub === 'push' || !GIT_BUILTINS.has(sub);
  }
  if (name === 'jj') {
    const { rest } = splitJjGlobals(words(entry));
    const head = rest[0]?.text;
    return !head || !JJ_COMMANDS.has(head) || (head === 'git' && rest[1]?.text === 'push') || head === 'util' || entry.dynamic.some(Boolean);
  }
  return patterns.some((pattern) => deployMatchEnd(entry.argv, pattern.regex) !== -1);
}

function blockMessage(label, problems) {
  return [`Pipeline gate blocked \`${label}\`.`, ...problems.map((problem) => `  - ${problem}`), `Process: ${PROCESS_DOC}`].join('\n');
}

function gate(payload, note) {
  const command = payloadCommand(payload);
  if (!command) return null;
  const startDir = payload.cwd ?? process.cwd();
  const patterns = deployPatterns(startDir);
  // PowerShell has its own quoting and expansion, so the gate does not try to read it.
  if (payload.tool_name === 'PowerShell') {
    const form = mention(command.text, patterns);
    return form ? blockMessage(command.text.slice(0, 100), [`It holds ${form}, and the gate does not read PowerShell. Run it through the Bash tool.`]) : null;
  }
  const entries = command.argv ? argvCommands(command.argv, startDir) : shellCommands(command.text, startDir);
  const opaque = entries.filter((entry) => entry.opaque);
  const openForm = () => {
    const unread = opaque.find((entry) => mention(entry.code ?? command.text, patterns)) ?? (opaque.length && mention(command.text, patterns) ? opaque[0] : null);
    return unread ? blockMessage(labelOf(unread.argv.length ? unread.argv : [command.text]), [`It holds ${mention(unread.code ?? command.text, patterns)}, but the gate cannot read ${unread.opaque}. Run the push, gh or deploy command on its own, written out in full.`]) : null;
  };
  if (!entries.some((entry) => candidate(entry, patterns))) return openForm();
  const line = new Line(entries, patterns, startDir);
  for (const entry of entries) {
    const label = labelOf(entry.argv.length ? entry.argv : [command.text]);
    note(label);
    try {
      const problems = checkEntry(line, entry) ?? [];
      if (problems.length) return blockMessage(label, problems);
    } catch (error) {
      if (error instanceof Refusal) return blockMessage(label, [error.message]);
      throw error;
    }
  }
  return openForm();
}

// The gate's answer: null to allow, or the reason to refuse. A failure inside it refuses too, since
// letting a push or deploy through unchecked is worse than asking the agent to retry.
export function gateMessage(payload) {
  let label = null;
  try {
    return gate(payload, (value) => { label = value; });
  } catch (error) {
    return blockMessage(label ?? 'this command', [`The gate could not check it: ${error.message}`, 'Nothing ran. Fix the cause, or run the command on its own, written out in full.']);
  }
}
