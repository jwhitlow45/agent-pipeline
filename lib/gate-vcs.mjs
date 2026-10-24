// The gate's reading of jj and git commands. Each command is sorted into a class: `read` changes
// nothing, `local` changes only this machine, `pin` sets a bookmark to a literal commit just before
// a push, and `action` publishes or deploys and is checked in full. A command the gate cannot place
// exactly is refused, with the form to run instead.

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseGitOptions, parseOptions } from './argv.mjs';
import { plainName, refuse, resolveRevset, SPELL_OUT, userRuns } from './gate-common.mjs';
import { GIT_READ_OPTIONS, JJ_READ_OPTIONS, optionProblem, someOptions } from './options.mjs';
import { JJ_SHORT_COMMANDS } from './remote.mjs';
import { deployProblems, holeProblems, pushProblems, runForCommit } from './ship.mjs';
import { expandHome, matchesAny, run, short } from './util.mjs';
import { gitSetting } from './vcs.mjs';
import { detect } from './vcs-detect.mjs';
import { gitEnv } from './vcs-git.mjs';
import { bookmarkTable, inWorkingCopies, jj, jjConfigValue, remoteNames, tagTable } from './vcs-jj.mjs';

const asWords = (list) => list.map((word) => ({ text: word.value, dynamic: !word.literal }));

const FULL_ID = /^[0-9a-f]{40}$/;
const plainGit = (dir) => dir !== null && dir !== undefined && detect(dir).backend === 'git';

// The marker that lets the user's own push past the pre-push hook (docs/integration.md). Set in the
// gate's own environment, it came from the user's shell before the agent started, so no push runs.
function userPushMarker() {
  if (process.env.PIPELINE_USER_PUSH !== undefined) refuse('PIPELINE_USER_PUSH is set in the environment the agent runs in, which would let its pushes past the pre-push hook. The user unsets it and starts the agent again.');
}

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
const JJ_PIN = {
  set: { long: { revision: 'value', 'allow-backwards': 'flag' }, short: { r: 'revision', B: 'allow-backwards' }, aliases: { to: 'revision' } },
  create: { long: { revision: 'value' }, short: { r: 'revision' }, aliases: { to: 'revision' } },
  move: { long: { to: 'value', 'allow-backwards': 'flag' }, short: { t: 'to', B: 'allow-backwards' } },
};
const JJ_BOOKMARK_SHORT = { a: 'advance', c: 'create', d: 'delete', f: 'forget', l: 'list', m: 'move', r: 'rename', s: 'set', t: 'track' };
const JJ_COMMANDS = new Set(['abandon', 'absorb', 'arrange', 'bisect', 'bookmark', 'commit', 'config', 'debug', 'describe', 'diff', 'diffedit', 'duplicate', 'edit', 'evolog', 'evolution-log', 'file', 'fix', 'gerrit', 'git', 'help', 'interdiff', 'log', 'metaedit', 'new', 'next', 'operation', 'parallelize', 'prev', 'rebase', 'redo', 'resolve', 'restore', 'revert', 'root', 'run', 'show', 'sign', 'simplify-parents', 'sparse', 'split', 'squash', 'status', 'tag', 'undo', 'unsign', 'util', 'version', 'workspace']);
const JJ_READ = new Set(['log', 'show', 'diff', 'status', 'evolog', 'evolution-log', 'interdiff', 'help', 'version', 'root', 'bookmark list', 'tag list', 'workspace list', 'workspace root', 'operation log', 'operation show', 'operation diff', 'config get', 'config list', 'config path', 'file list', 'file show', 'file annotate', 'file search', 'git remote list', 'git root', 'sparse list', 'util completion', 'util config-schema', 'util markdown-help']);
const JJ_LOCAL = new Set(['abandon', 'absorb', 'arrange', 'bookmark advance', 'bookmark create', 'bookmark delete', 'bookmark forget', 'bookmark move', 'bookmark rename', 'bookmark set', 'bookmark track', 'bookmark untrack', 'commit', 'describe', 'diffedit', 'duplicate', 'edit', 'file chmod', 'file track', 'file untrack', 'fix', 'git fetch', 'git import', 'git export', 'git init', 'git clone', 'metaedit', 'new', 'next', 'prev', 'parallelize', 'rebase', 'resolve', 'restore', 'revert', 'sign', 'unsign', 'simplify-parents', 'sparse set', 'sparse reset', 'sparse edit', 'split', 'squash', 'tag set', 'tag delete', 'undo', 'redo', 'operation restore', 'operation revert', 'operation abandon', 'operation undo', 'workspace add', 'workspace forget', 'workspace rename', 'workspace update-stale', 'config set', 'config unset']);
// Settings an agent may change with jj config set. Every other key steers which program jj runs,
// what it reads or where it pushes, so it is the user's to edit.
const JJ_CONFIG_SET_KEYS = /^(user\.(name|email)|ui\.color|ui\.paginate|ui\.graph\.style|snapshot\.max-new-file-size)$/;

function splitJjGlobals(words) {
  const globals = [];
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    const { text } = words[i];
    // After --, every word is a positional, a global option's name included.
    if (text === '--') {
      rest.push(...words.slice(i));
      break;
    }
    // --version and -V before the subcommand print jj's version and run nothing.
    if ((text === '--version' || text === '-V') && !rest.length) {
      globals.push({ name: 'version', value: true });
      continue;
    }
    const long = /^--([a-z-]+)(=(.*))?$/s.exec(text);
    const name = long ? (Object.hasOwn(JJ_GLOBAL.long, long[1]) ? long[1] : JJ_GLOBAL.aliases[long[1]]) : null;
    if (name) {
      if (JJ_GLOBAL.long[name] === 'value' && long[2] === undefined) globals.push({ name, value: words[++i]?.text });
      else globals.push({ name, value: long[2] === undefined ? true : long[3] });
    } else if (/^-R/.test(text)) {
      const attached = text.slice(2).replace(/^=/, '');
      globals.push({ name: 'repository', value: attached || words[++i]?.text });
    } else if (text === '-h') globals.push({ name: 'help', value: true });
    else rest.push(words[i]);
  }
  return { globals, rest };
}

const literalDir = (cwd, value) => {
  if (value === undefined) return null;
  const path = expandHome(value);
  return isAbsolute(path) ? path : cwd === null ? null : resolve(cwd, path);
};

export function classifyJj(cmd, line) {
  const { globals, rest } = splitJjGlobals(asWords(cmd.words.slice(1)));
  for (const option of globals) {
    if (['config', 'config-file', 'config-toml'].includes(option.name)) refuse(`It changes jj's settings with --${option.name} for this command, which the gate does not read. Run it without that option.`);
  }
  const repoOption = globals.filter((option) => option.name === 'repository').at(-1);
  const dir = repoOption ? literalDir(cmd.cwd, repoOption.value) : cmd.cwd;
  if (globals.some((option) => option.name === 'version' || option.name === 'help')) return { cls: 'read', dir };
  if (!rest.length) refuse(`A bare jj runs ui.default-command, which the gate does not read. ${SPELL_OUT}, such as jj log.`);
  let name = rest[0].text === 'op' ? 'operation' : rest[0].text;
  if (Object.hasOwn(JJ_SHORT_COMMANDS, name)) {
    // jj's short names are aliases in its default config, which any config scope can redefine.
    const full = JJ_SHORT_COMMANDS[name];
    const value = dir === null ? null : jjConfigValue(dir, `aliases.${name}`);
    if (value === null || value.replace(/\s+/g, '') !== `["${full}"]`) refuse(`jj ${name} is redefined in jj's config (aliases.${name}), so the gate cannot tell what it runs. Run jj ${full} instead.`);
    name = full;
  } else if (!JJ_COMMANDS.has(name)) refuse(`jj ${name} is not a jj built-in command: it may be an alias, which the gate does not follow. ${SPELL_OUT}.`);
  const path = [name, ...rest.slice(1).map((word) => word.text)];
  if (path[0] === 'bookmark' && Object.hasOwn(JJ_BOOKMARK_SHORT, path[1])) path[1] = JJ_BOOKMARK_SHORT[path[1]];
  // clap never takes --help as an option's value (jj describe -m --help is an error), so it asks for
  // help anywhere before a --.
  const options = path.includes('--') ? path.slice(0, path.indexOf('--')) : path;
  const help = globals.some((option) => option.name === 'help') || options.includes('--help') || options.includes('-h');
  const two = path.slice(0, 2).join(' ');
  const three = path.slice(0, 3).join(' ');
  if (help) return { cls: 'read', dir };
  const read = [three, two, path[0]].find((key) => JJ_READ.has(key));
  if (read) {
    const problem = optionProblem(JJ_READ_OPTIONS[read], path.slice(read.split(' ').length));
    if (problem) refuse(`jj ${read} ${problem} is not an option the gate reads. Run jj ${read} only with options from its list${someOptions(JJ_READ_OPTIONS[read])}, spelled out in full.`);
    return { cls: 'read', dir };
  }
  const viewOnly = globals.some((option) => ['ignore-working-copy', 'at-operation'].includes(option.name));
  if (two === 'git push') {
    if (plainGit(dir)) refuse('This is a plain git repository. Push with git push origin <full id>:refs/heads/<branch>.');
    if (viewOnly) refuse('It pushes from a view jj did not snapshot (--ignore-working-copy or --at-op), which the gate does not read. Push without it.');
    userPushMarker();
    return { cls: 'action', dir, kind: 'jj push', check: () => jjPush(line, dir, rest.slice(2)) };
  }
  if (['bookmark set', 'bookmark create', 'bookmark move'].includes(two)) {
    const pin = jjPin(path[1], rest.slice(2), viewOnly);
    if (pin && plainGit(dir)) refuse(`jj bookmark ${path[1]} sets a jj bookmark, and this is a plain git repository, where nothing reads one. Push the commit by its full id: git push origin <full id>:refs/heads/<branch>.`);
    if (pin) return { cls: 'pin', dir, ...pin };
  }
  if (['config set', 'config unset'].includes(two)) {
    const key = rest.slice(2).map((word) => word.text).find((text) => !text.startsWith('-'));
    if (!key || !JJ_CONFIG_SET_KEYS.test(key)) refuse(`jj config ${path[1]} of ${key ?? 'that key'} can change which program jj runs, what the gate reads or where a push goes. The user edits jj's config by hand.`);
    return { cls: 'local', dir };
  }
  if (two === 'git remote' && path[2] !== 'list') refuse('It changes where a remote points, which the user does by hand.');
  if (JJ_LOCAL.has(three) || JJ_LOCAL.has(two) || JJ_LOCAL.has(path[0])) return { cls: 'local', dir };
  refuse(`The gate does not run jj ${two.trim()}: it can run other commands or publish in ways the gate does not check. Run the plain jj command for the step instead.`);
}

// `jj bookmark set|create|move NAME... -r <id>` before a push: the push is checked at that commit.
const PIN_REVISION = /^([0-9a-f]{8,40}|[k-z]{8,32}|@-*)$/;
function jjPin(action, words, viewOnly) {
  const parsed = parseOptions(words, JJ_PIN[action]);
  const names = parsed.positionals.map((word) => plainName(word.text));
  const rev = parsed.last(action === 'move' ? 'to' : 'revision')?.value;
  if (viewOnly || parsed.unknown.length || !names.length || names.includes(null) || !rev || !PIN_REVISION.test(rev)) return null;
  return { names, rev };
}

// The bookmarks and targets a jj push moves, each checked as a push.
function jjPush(line, dir, words) {
  const ctx = line.context(dir);
  if (!ctx) return [];
  const { repo, config } = ctx;
  const parsed = parseOptions(words, JJ_PUSH);
  if (parsed.unknown.length) refuse(`It has an option the gate does not know (${parsed.unknown.join(', ')}).`);
  if (parsed.has('help')) return [];
  if (parsed.has('tag')) refuse('It pushes tags. Agents push only branches (push.branches).');
  if (parsed.options.some((option) => option.missing)) refuse('An option is missing its value.');
  if (parsed.has('dry-run')) return [];
  const remote = parsed.last('remote')?.value ?? jjConfigValue(repo, 'git.push') ?? (() => {
    const names = remoteNames(repo);
    return names.length === 1 ? names[0] : 'origin';
  })();
  if (remote !== config.remote) refuse(`It pushes to ${remote}. Agents push only to ${config.remote}.`);
  const table = bookmarkTable(repo, remote);
  const tags = tagTable(repo, remote);
  const pending = line.pinsFor(ctx);
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
    if ([...tags.local.values()].some((target) => ids.has(target))) refuse(`-r ${value} also pushes a tag. Agents push only branches.`);
    names.push(...[...new Set([...table.local.keys(), ...pending.keys()])].filter((name) => ids.has(local(name)?.target)));
  }
  if (parsed.has('change')) {
    const template = jjConfigValue(repo, 'templates.git_push_bookmark') ?? '"push-" ++ change_id.short()';
    for (const { value } of parsed.values('change')) {
      for (const row of jj(repo, ['log', '--no-graph', '-r', value, '-T', `"[" ++ stringify(${template}).escape_json() ++ "," ++ stringify(commit_id).escape_json() ++ "]\\n"`]).split('\n').filter(Boolean)) {
        const [bookmark, target] = JSON.parse(row);
        pushes.push({ bookmark, target });
      }
    }
  }
  const tagMoves = (tracked) => [...tags.local].some(([name, target]) => tags.remote.get(name)?.target !== target && (!tracked || tags.remote.get(name)?.tracked));
  if (parsed.has('all')) {
    if (tagMoves(false)) refuse('--all also pushes tags. Agents push only branches: name each bookmark with -b.');
    names.push(...new Set([...table.local.keys(), ...pending.keys()]));
  }
  if (parsed.has('tracked')) {
    // jj pushes tracked tags with --tracked too.
    if (tagMoves(true) || [...tags.remote].some(([name, entry]) => entry.tracked && !tags.local.has(name))) refuse('--tracked also pushes tracked tags. Agents push only branches: name each bookmark with -b.');
    names.push(...[...new Set([...table.local.keys(), ...pending.keys()])].filter((name) => table.remote.get(name)?.tracked));
  }
  if (parsed.has('deleted')) {
    if ([...tags.remote].some(([name, entry]) => entry.tracked && !tags.local.has(name))) refuse('--deleted also deletes tags. Agents push only branches.');
    for (const [name, entry] of table.remote) if (entry.tracked && !local(name)) pushes.push({ bookmark: name, target: null });
  }
  if (!['bookmark', 'named', 'revision', 'change', 'all', 'tracked', 'deleted'].some((name) => parsed.has(name))) refuse('It pushes whatever bookmarks jj picks. Name each bookmark with -b <name>.');
  for (const name of new Set(names)) {
    const found = local(name);
    if (found?.conflict) refuse(`${name} is conflicted here. Resolve it (jj bookmark set ${name} -r <rev>) before pushing.`);
    if (found?.target) pushes.push({ bookmark: name, target: found.target });
    else if (!found && table.remote.get(name)?.tracked) pushes.push({ bookmark: name, target: null });
    else refuse(`${name} points nowhere here, and it is not a tracked bookmark deleted locally, so the gate cannot tell what the push does.`);
  }
  // jj snapshots edits on disk into a working-copy commit before it pushes, so a target that is one,
  // or sits on one, is refused before any push is dropped as already done.
  const open = inWorkingCopies(repo, pushes.map((push) => push.target).filter(Boolean));
  if (open.length) refuse(`${short(open[0])} is a working-copy commit or sits on one, so jj would snapshot edits on disk into it before pushing. Commit the work (jj commit), then push the commit below @.`);
  // A bookmark already where the remote has it is not pushed, so --all and --tracked name only what moves.
  const moving = pushes.filter((push) => (push.target === null ? table.remote.has(push.bookmark) : table.remote.get(push.bookmark)?.target !== push.target));
  return moving.flatMap((push) => checkPush(ctx, push).map((problem) => `${push.bookmark}: ${problem}`));
}

// One ref a push moves. `remoteTip` is the branch's commit on the remote: the pre-push hook passes
// what git reports, and otherwise it comes from the remote's own refs, which the context read.
export function checkPush(ctx, push, { remoteTip } = {}) {
  const { config, repo } = ctx;
  const trunk = config.trunk;
  if (push.target === null) {
    if (push.bookmark === trunk) return [`It deletes ${trunk}. Agents never delete trunk.`];
    if (!matchesAny(push.bookmark, config.push.branches)) return [`It deletes ${push.bookmark}, which is not a branch agents push to (push.branches: ${config.push.branches.join(', ')}).`];
    return [];
  }
  const remote = remoteTip !== undefined ? remoteTip : ctx.remoteHeads?.get(push.bookmark) ?? null;
  if (push.bookmark === trunk) {
    if (config.deploy.runBy === 'user') return [userRuns(config, ctx.vcs?.backend === 'git' ? ctx.vcs.commands.pushTrunk(config.remote, trunk, push.target) : `jj git push --remote ${config.remote} --bookmark ${trunk}`)];
    if (remote && remote !== push.target && !ctx.vcs.isAncestor(remote, push.target)) return [`${trunk} on ${config.remote} is at ${short(remote)}, which is not an ancestor of ${short(push.target)}. Moving it would be a force push of trunk.`];
    return [...holeProblems(ctx, push.target), ...deployProblems(ctx, runForCommit(ctx.identity, push.target), push.target).map((problem) => `Moving ${trunk} is a deploy step: ${problem}`)];
  }
  return pushProblems(ctx, push.bookmark, push.target, { remoteTip: remote });
}

// git

const GIT_BUILTINS = new Set(['add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bugreport', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree', 'config', 'count-objects', 'credential', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'filter-branch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'lfs', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'mergetool', 'mktree', 'mv', 'name-rev', 'notes', 'patch-id', 'prune', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'request-pull', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'send-email', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree']);
const GIT_READ = new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'rev-list', 'ls-files', 'ls-remote', 'ls-tree', 'cat-file', 'describe', 'merge-base', 'show-ref', 'for-each-ref', 'blame', 'annotate', 'grep', 'help', 'version', 'shortlog', 'whatchanged', 'diff-tree', 'diff-index', 'diff-files', 'name-rev', 'patch-id', 'verify-commit', 'verify-tag', 'check-ignore', 'check-attr', 'count-objects', 'var', 'cherry', 'range-diff', 'show-branch', 'fsck']);
const GIT_LOCAL = new Set(['add', 'am', 'apply', 'archive', 'bisect', 'branch', 'bundle', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree', 'fetch', 'format-patch', 'gc', 'hash-object', 'init', 'maintenance', 'merge', 'mktree', 'mv', 'notes', 'prune', 'pull', 'read-tree', 'rebase', 'reflog', 'repack', 'reset', 'restore', 'revert', 'rm', 'sparse-checkout', 'stash', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'worktree', 'write-tree']);
// Options that make a git command run a program or write a file, refused on any git command, in full
// or as any prefix git would take for one. A short -O anywhere in a cluster counts too.
const GIT_PROGRAM_OPTIONS = ['output', 'ext-diff', 'open-files-in-pager', 'upload-pack', 'exec', 'remote', 'receive-pack', 'template', 'config', 'separate-git-dir', 'paginate'];
const runsProgram = (text) => {
  const long = /^--([^=]+)/.exec(text);
  if (long) return GIT_PROGRAM_OPTIONS.some((name) => name.startsWith(long[1]));
  return /^-[A-Za-z]*O/.test(text);
};
const GIT_GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects', '--no-lazy-fetch']);
// Settings an agent may write with git config. Every other key can run a program, rewrite a
// remote or pull in another file.
const GIT_CONFIG_SET_KEYS = /^(user\.(name|email|signingkey)|commit\.gpgsign|tag\.gpgsign|init\.defaultbranch|core\.autocrlf|pull\.rebase|fetch\.prune|color\..*|advice\..*)$/i;
const GIT_PUSH = {
  long: { all: 'flag', branches: 'flag', mirror: 'flag', delete: 'flag', tags: 'flag', 'dry-run': 'flag', porcelain: 'flag', force: 'flag', 'force-with-lease': 'optional', 'force-if-includes': 'flag', 'recurse-submodules': 'value', thin: 'flag', 'receive-pack': 'value', exec: 'value', 'set-upstream': 'flag', progress: 'flag', prune: 'flag', verify: 'flag', 'follow-tags': 'flag', signed: 'optional', atomic: 'flag', 'push-option': 'value', ipv4: 'flag', ipv6: 'flag', repo: 'value', quiet: 'flag', verbose: 'flag', help: 'flag' },
  short: { d: 'delete', n: 'dry-run', f: 'force', u: 'set-upstream', o: 'push-option', q: 'quiet', v: 'verbose', 4: 'ipv4', 6: 'ipv6', h: 'help' },
  negatable: ['dry-run', 'force', 'force-with-lease', 'force-if-includes', 'recurse-submodules', 'thin', 'set-upstream', 'progress', 'prune', 'verify', 'follow-tags', 'signed', 'atomic', 'push-option', 'ipv4', 'ipv6', 'quiet', 'verbose', 'porcelain', 'delete', 'all', 'branches', 'mirror', 'tags'],
};

function gitReadForm(sub, texts) {
  const positional = texts.filter((text) => !text.startsWith('-'));
  if (sub === 'branch') return !texts.some((text) => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track)/.test(text)) && (!positional.length || texts.some((text) => /^(-l|--list|-a|--all|-r|--remotes|--contains|--merged|--no-merged|--points-at|--show-current)$/.test(text)));
  if (sub === 'remote') return !positional.length || (['show', 'get-url'].includes(positional[0]));
  if (sub === 'config') return texts.some((text) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|get|list)$/.test(text));
  if (sub === 'tag') return !positional.length || texts.some((text) => /^(-l|--list|-v|--verify)$/.test(text));
  if (['stash', 'worktree', 'notes', 'reflog'].includes(sub)) return !positional.length || ['list', 'show'].includes(positional[0]);
  if (sub === 'submodule') return ['status', 'summary'].includes(positional[0] ?? 'status');
  return false;
}

export function classifyGit(cmd, line) {
  const words = cmd.words.slice(1).map((word) => word.value);
  let dir = cmd.cwd;
  let i = 0;
  for (; i < words.length && words[i].startsWith('-'); i++) {
    const text = words[i];
    if (text === '-C') {
      dir = literalDir(dir, words[++i]);
      if (!dir) refuse('-C needs a folder.');
    } else if (['-h', '--help', '--version', '-v'].includes(text)) return { cls: 'read', dir };
    else if (!GIT_GLOBAL_FLAGS.has(text)) refuse(`It sets ${text.split('=')[0]} for git, which can change its config, repository or programs. Run it without that option.`);
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  if (!sub) return { cls: 'read', dir };
  if (!GIT_BUILTINS.has(sub)) refuse(`git ${sub} is not a git built-in command: it may be an alias, which the gate does not follow. ${SPELL_OUT}.`);
  const risky = args.find((text) => runsProgram(text) || (sub === 'ls-remote' && /^-[A-Za-z]*u/.test(text)));
  if (risky && sub !== 'push') refuse(`git ${sub} ${risky.split('=')[0]} runs another program or writes a file the gate does not check. Run it without that option.`);
  // Only a leading --help asks for help: later, it can be an option's value (git commit -m --help
  // commits), and the push's own parse reads it there.
  if (['--help', '-h'].includes(args[0])) return { cls: 'read', dir };
  if (sub === 'push') {
    userPushMarker();
    return { cls: 'action', dir, kind: 'git push', check: () => gitPush(line, dir, cmd.words.slice(i + 2)) };
  }
  if (GIT_READ.has(sub) || gitReadForm(sub, args)) {
    const problem = optionProblem(GIT_READ_OPTIONS[sub], args);
    if (problem) refuse(`git ${sub} ${problem} is not an option the gate reads: git takes a unique prefix of any option, so only options spelled out in full from its list pass${someOptions(GIT_READ_OPTIONS[sub])}. Run it without that option.`);
    return { cls: 'read', dir };
  }
  if (sub === 'config') {
    const key = args.find((text) => !text.startsWith('-'));
    if (!key || !GIT_CONFIG_SET_KEYS.test(key)) refuse(`git config of ${key ?? 'that key'} can run a program, rewrite a remote or include another file. The user edits git's config by hand.`);
    return { cls: 'local', dir };
  }
  if (sub === 'remote') refuse('It changes where a remote points, which the user does by hand.');
  if (sub === 'rebase' && args.some((text) => /^-[A-Za-z]*x/.test(text) || /^--(e|ex|exe|exec)(=|$)/.test(text))) refuse('git rebase --exec runs commands the gate does not see. Rebase without it, and run each command on its own.');
  if (sub === 'bisect' && args[0] === 'run') refuse('git bisect run runs commands the gate does not see. Run each step on its own.');
  if (sub === 'update-ref' && args.some((text) => /^refs\/(remotes|replace)\//.test(text))) refuse('It writes a remote-tracking or replace ref, which would change what this repository says the remote holds. Run jj git fetch instead.');
  // In plain git, a ref named HEAD, or one outside refs/ (a root ref), changes what git push and a
  // revision read before any branch, so the gate's names would no longer be git's. jj reads
  // neither. The worktree's own HEAD is no such ref (reset and switch write it too), and a delete
  // only puts git's reading back.
  const named = args.filter((text, i) => !text.startsWith('-') && args[i - 1] !== '-m');
  const deletes = args.includes('-d') || args.includes('--delete');
  if (plainGit(dir) && !deletes && (sub === 'update-ref' || (sub === 'symbolic-ref' && named.length > 1))) {
    if (args.includes('--stdin')) refuse(`git ${sub} --stdin writes refs the gate cannot see. Name each ref on the command line.`);
    const ref = named[0];
    if (ref && ref !== 'HEAD' && (!ref.startsWith('refs/') || ref.split('/').at(-1) === 'HEAD')) refuse(`git ${sub} of ${ref} writes ${ref.startsWith('refs/') ? 'a ref named HEAD' : 'a ref outside refs/'}, which git reads before the branch of that name. Write branches under refs/heads/ with another name.`);
  }
  if (sub === 'fetch' || sub === 'pull') fetchRefspecs(args);
  if (sub === 'clone' && args.some((text) => /^-[A-Za-z]*[uc]/.test(text) || runsProgram(text))) refuse('It clones with a program or settings the gate does not check. Clone without them.');
  if (GIT_LOCAL.has(sub)) return { cls: 'local', dir };
  refuse(`The gate does not run git ${sub}: it can run other programs or publish in ways the gate does not check.`);
}

// A fetch may write only its own remote's tracking refs, so it never forges another remote's.
function fetchRefspecs(args) {
  const positional = args.filter((text) => !text.startsWith('-'));
  const [remote, ...specs] = positional;
  for (const spec of specs) {
    const dst = spec.replace(/^\+/, '').split(':')[1];
    if (dst === undefined) continue;
    const full = dst.startsWith('refs/') ? dst : `refs/heads/${dst}`;
    if (/^refs\/(remotes|replace|tags)\//.test(full) && !(remote && full.startsWith(`refs/remotes/${remote}/`))) refuse(`The refspec ${spec} writes ${full}, which belongs to another remote or to tags. Fetch with jj git fetch, or name only branches of ${remote}.`);
  }
}

function gitPush(line, dir, wordTokens) {
  const ctx = line.context(dir);
  if (!ctx) return [];
  const { config, repo } = ctx;
  const parsed = parseGitOptions(asWords(wordTokens), GIT_PUSH);
  if (parsed.unknown.length) refuse(`It has an option the gate does not read (${parsed.unknown.join(', ')}). Spell each option out in full.`);
  const on = (name) => parsed.options.some((option) => option.name === name && !option.negated);
  // Force and no-verify first, in any spelling, so no later option (a dry run) can hide them.
  if (['force', 'force-with-lease', 'force-if-includes', 'mirror'].some(on)) refuse('It is a force push. Never force push: push to a new branch name instead.');
  if (parsed.options.some((option) => option.name === 'verify' && option.negated)) refuse('It skips the pre-push hook (--no-verify).');
  if (['all', 'branches', 'tags', 'prune', 'follow-tags'].some(on)) refuse('It pushes more than the named branches. Name each branch.');
  if (['receive-pack', 'exec'].some(on)) refuse('It runs another program on the remote. Push without --receive-pack or --exec.');
  const recurse = parsed.options.filter((option) => option.name === 'recurse-submodules' && !option.negated).at(-1);
  if (recurse && !['check', 'no'].includes(recurse.value)) refuse('It can push submodules too. Push them on their own.');
  if (on('help')) return [];
  const dryRun = parsed.options.filter((option) => option.name === 'dry-run').at(-1);
  if (dryRun && !dryRun.negated) return [];
  const repoOption = parsed.options.filter((option) => option.name === 'repo').at(-1)?.value;
  const positionals = parsed.positionals.map((word) => word.text);
  const remote = positionals[0] ?? repoOption;
  const refspecs = positionals.slice(1);
  if (remote === undefined) refuse('It pushes wherever git picks. Name the remote and the branch: git push origin <src>:refs/heads/<branch>.');
  if (remote !== config.remote) refuse(`It pushes to ${remote}. Agents push only to ${config.remote}, by name.`);
  if (!refspecs.length) refuse('It pushes whatever git picks. Name the branch.');
  if (refspecs[0] === 'tag') refuse('It pushes a tag. Agents push only branches.');
  const followTags = gitSetting(dir, ['--bool', '--get', 'push.followTags']);
  if (followTags === 'true') refuse('git is set to push tags with every push (push.followTags). Agents push only branches: push with jj git push -b <name>.');
  const deleting = on('delete');
  // A refspec with no destination goes where git maps it: remote.<name>.push, or push.default
  // upstream with the branch's merge setting. Either can send ci/x to trunk, forced.
  if (refspecs.some((spec) => !spec.includes(':'))) {
    const mapped = gitSetting(dir, ['--get-all', `remote.${remote}.push`]);
    if (mapped) refuse(`git maps pushes to ${remote} through remote.${remote}.push (${mapped.split('\n')[0]}), so the gate cannot tell where the push goes. Write src:refs/heads/<branch>.`);
    const pushDefault = gitSetting(dir, ['--get', 'push.default']);
    if (['upstream', 'tracking'].includes(pushDefault)) refuse(`git pushes a branch to its upstream here (push.default is ${pushDefault}), so the gate cannot tell where the push goes. Write src:refs/heads/<branch>.`);
  }
  const git = ctx.vcs.backend === 'git';
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
    // In plain git every destination is written in full, deletions included: git maps a short one
    // through the remote's refs or the source's namespace, so a short name can update a tag.
    if (git && (at !== -1 || deleting) && !dst.startsWith('refs/heads/')) refuse(`${dst} is not written in full, and git push maps a short destination through the remote's refs or the source's own kind. Write refs/heads/${dst} in full.`);
    // git matches a short destination against the remote's refs, tags included, so a remote tag of
    // that name is what it updates or deletes.
    if (!dst.startsWith('refs/')) {
      if (/^(heads|tags|remotes)\//.test(dst)) refuse(`${dst} would be matched against the remote's refs. Write refs/heads/<branch> in full.`);
      if (ctx.remoteTags?.has(dst)) refuse(`${dst} names a tag on ${config.remote}, which git would ${deleting || src === '' ? 'delete' : 'update'}. Agents push only branches: write refs/heads/${dst} in full.`);
    }
    // A source with no destination names the ref git pushes: it must be a local branch, not a tag.
    if (!git && !deleting && src !== '' && at === -1) {
      const branch = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${src}`], { cwd: dir, allowFail: true }).status === 0;
      const tag = run('git', ['show-ref', '--verify', '--quiet', `refs/tags/${src}`], { cwd: dir, allowFail: true }).status === 0;
      if (!branch || tag) refuse(`${src} is ${tag ? 'a tag here' : 'not a local branch'}, so git would not push it as a branch. Write <commit>:refs/heads/<branch>.`);
    }
    return { src, bookmark, bare: at === -1 };
  });
  // git finds its repository from the folder, which can be another repository inside this one. The
  // common folders are compared, so a linked worktree of this repository pushes as its own.
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, allowFail: true });
  if (common.status !== 0) refuse(`The gate cannot tell which repository git pushes from here (${(common.stderr || '').trim().split('\n')[0] || 'git rev-parse failed'}). Push from the workspace with jj git push -b <name>.`);
  if (realpathSync(common.stdout.trim()) !== realpathSync(ctx.vcs.commonDir())) refuse(`git would push from ${common.stdout.trim()}, which is not this repository's. Push from the main workspace.`);
  const refs = git ? localRefs(dir) : null;
  const pushes = specs.map(({ src, bookmark, bare }) => {
    if (deleting || src === '') return { bookmark, target: null };
    if (git) return { bookmark, target: pushSource(dir, refs, src, { bare }) };
    const target = run('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${src}^{commit}`], { cwd: dir, allowFail: true, env: { GIT_NO_REPLACE_OBJECTS: '1' } });
    if (target.status !== 0) refuse(`The gate cannot tell which commit ${src} is. Push a bookmark with jj git push -b <name>.`);
    return { bookmark, target: target.stdout.trim() };
  });
  return pushes.flatMap((push) => checkPush(ctx, push).map((problem) => `${push.bookmark}: ${problem}`));
}

// git push's own reading of a source, applied by the gate, since git push resolves it differently
// from git rev-parse: it matches local refs first by these rules (refs.c), counting a match outside
// refs/heads/ and refs/tags/ that was not written from the top as weak (remote.c), and only when no
// ref matches reads the source as an object name.
const PUSH_RULES = [(name) => name, (name) => `refs/${name}`, (name) => `refs/tags/${name}`, (name) => `refs/heads/${name}`, (name) => `refs/remotes/${name}`, (name) => `refs/remotes/${name}/HEAD`];

function localRefs(dir) {
  const read = run('git', ['for-each-ref', '--format=%(refname)%00%(objectname)'], { cwd: dir, allowFail: true, env: gitEnv({}) });
  if (read.status !== 0) refuse(`git could not list the refs here (${(read.stderr || '').trim().split('\n')[0]}), so the gate cannot tell what the push sends.`);
  return read.stdout.split('\n').filter(Boolean).map((line) => line.split('\0'));
}

function sourceMatches(refs, src) {
  const strong = [];
  const weak = [];
  for (const [name, id] of refs) {
    if (!PUSH_RULES.some((rule) => rule(src) === name)) continue;
    const isWeak = name.length !== src.length && src.length !== name.length - 5 && !name.startsWith('refs/heads/') && !name.startsWith('refs/tags/');
    (isWeak ? weak : strong).push({ name, id });
  }
  return strong.length ? strong : weak;
}

// The command that deletes a local ref, in the form a person would type.
const deleteRef = (name) => (name.startsWith('refs/heads/') ? `git branch -D ${name.slice('refs/heads/'.length)}` : name.startsWith('refs/tags/') ? `git tag -d ${name.slice('refs/tags/'.length)}` : `git update-ref -d ${name}`);

// The commit a push source sends, as git push reads it, or a refusal. `bare` is a refspec with no
// destination, which git pushes to the source's own full name, so it must be one local branch.
function pushSource(dir, refs, src, { bare }) {
  const matches = sourceMatches(refs, src);
  if (src === 'HEAD') {
    if (matches.length) refuse(`A ref named HEAD exists (${matches[0].name}), so git push would not push this worktree's HEAD. Delete it with ${deleteRef(matches[0].name)}, or push the full id.`);
    const head = run('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: dir, allowFail: true, env: gitEnv({}) });
    if (head.status !== 0 || !FULL_ID.test(head.stdout.trim())) refuse('This worktree has no HEAD commit to push.');
    return head.stdout.trim();
  }
  if (FULL_ID.test(src) && matches.length) refuse(`A ref is named after the full id ${src.slice(0, 12)} (${matches[0].name}), so git push would send that ref, not the commit. Delete the ref, or push from another worktree.`);
  if (matches.length > 1) refuse(`${src} matches more than one ref here (${matches.map((match) => match.name).join(', ')}), so git push refuses it or the gate cannot tell which it sends. Push the full commit id: <id>:refs/heads/<branch>.`);
  if (matches.length === 1) {
    if (!matches[0].name.startsWith('refs/heads/')) refuse(`${src} is ${matches[0].name} here, not a branch, so git push would send that. Agents push only branches: push a local branch or the full commit id.`);
    if (bare && ![src, `refs/heads/${src}`].includes(matches[0].name)) refuse(`${src} is ${matches[0].name} here, so git would push it to that name. Write ${src}:refs/heads/<branch>.`);
    return matches[0].id;
  }
  if (bare) refuse(`${src} is not a local branch, so git would not push it as a branch. Write <commit>:refs/heads/<branch>.`);
  if (!FULL_ID.test(src)) refuse(`${src} names no ref here, and git push reads it as an object name, which the gate takes only as a full commit id. Push <full id>:refs/heads/<branch>.`);
  const kind = run('git', ['cat-file', '-t', src], { cwd: dir, allowFail: true, env: gitEnv({}) });
  if (kind.status !== 0 || kind.stdout.trim() !== 'commit') refuse(`${src.slice(0, 12)} is not a commit here. Fetch it, or push a commit this repository holds.`);
  return src;
}
