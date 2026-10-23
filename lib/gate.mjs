// The PreToolUse gate. It reads the command an agent is about to run and refuses it when an
// earlier stage has not passed. It only reads: statuses are set after the command, by mirror-hook.
//
// It is an allow-list. A line is gated when it runs or names jj, git, gh or agent-review, sends
// curl or wget to GitHub, or runs a repository's deploy script. A gated line passes only in plain
// form: simple commands joined by &&, every word written out, a leading cd at most, pipes only into
// read-only sinks, and at most one action (a push, a deploy, a merge, a dispatch, an API write, a
// review start), placed last, with only reads and bookmark sets before it. Each command is read
// with its program's own grammar, and anything the gate cannot place exactly is refused with the
// form to run instead. On every line, a command built at run time and a write into the files that
// steer git, jj or the gate are refused.
//
// What it checks an action against comes from the remote itself (see actionContext). It is not a
// sandbox: a script or a build tool can still run what it likes. docs/integration.md says what
// GitHub must enforce behind it.

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { CONFIG_FILE } from './config.mjs';
import { actionContext, repoContext } from './context.mjs';
import { controlPath, Refusal, refuse, resolveRevset, userRuns } from './gate-common.mjs';
import { classifyGh, classifyHttp } from './gate-gh.mjs';
import { checkPush, classifyGit, classifyJj } from './gate-vcs.mjs';
import { loadRuns, passed } from './ledger.mjs';
import { readLine } from './line.mjs';
import { clusterValues, optionProblem, READ_OPTIONS, someOptions } from './options.mjs';
import { deployScriptEntries, INTERPRETERS, registeredRepos, RegistryError, storeOf } from './registry.mjs';
import { TrustError } from './remote.mjs';
import { agentReviewEntries, findEntry } from './review.mjs';
import { deployProblems, runForCommit } from './ship.mjs';
import { DeadlineError, expandHome, HOME, normalizeWords, short } from './util.mjs';
import { inWorkingCopies, jjRoot } from './vcs.mjs';

export { checkPush };

const PROCESS_DOC = 'docs/process.md in the agent-pipeline repository';
const TOOLS = new Set(['jj', 'git', 'gh', 'agent-review']);
// Case is folded: on a volume that ignores case (macOS by default), GIT runs git.
const TOOL_WORD = /(^|[^A-Za-z0-9_])(jj|git|gh|agent-review)([^A-Za-z0-9_]|$)|gitconfig/i;
const stripped = (text) => String(text).replace(/["'`\\^]/g, '');
const mentionsTool = (text) => TOOL_WORD.test(text) || TOOL_WORD.test(stripped(text));
const mentionsGithub = (text) => /github/i.test(stripped(text));

// Commands whose arguments are only data: a mention of a tool there runs nothing.
const DATA = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'man']);
// Commands that change nothing the gate reads, allowed anywhere on a gated line when every option
// is on their exact list (options.mjs), which leaves out the ones that write a file or run a program.
const READ_ONLY = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'sort', 'cut', 'tr', 'uniq', 'column', 'jq', 'echo', 'printf', 'true', 'false', 'test', '[', 'date', 'which', 'file', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink', 'diff', 'cmp', 'comm', 'sleep', 'nl', 'od', 'xxd', 'shasum', 'sha256sum', 'md5', 'md5sum', 'tree', 'whoami', 'uname', 'man', 'tee']);
const readOptionProblem = (name, words) => optionProblem(READ_OPTIONS[name], words.slice(1).map((word) => word.value));
// What a pipe may lead into on a gated line.
const SINKS = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'sort', 'cut', 'tr', 'cat', 'tee', 'jq', 'column', 'uniq', 'nl']);
// Commands that only read the files they name, so naming a control file is fine.
const CONTROL_READERS = new Set([...READ_ONLY, 'less', 'more', 'bat', 'rg', 'strings', 'hexdump'].filter((name) => name !== 'tee'));
// Programs that run another command. A word built at run time in the place of that command means
// the gate cannot see what runs.
const RUNNERS = new Set(['env', 'sudo', 'doas', 'nohup', 'nice', 'ionice', 'xargs', 'timeout', 'gtimeout', 'exec', 'command', 'builtin', 'caffeinate', 'stdbuf', 'unbuffer', 'script', 'watch', 'flock', 'parallel', 'setsid', 'chroot', 'npx', 'bunx', 'pnpx', 'uvx', 'chronic', 'time']);
// How each runner reads its own words before the command it runs. Short options in flags take no
// value, those in values take one (attached or the next word), and those in optional take the rest of
// their word if any. Long options are matched exactly, so a prefix is unknown. lead counts the words
// before the command (timeout's duration, flock's lock file). refuse holds options that run a string,
// change the folder, the search path or the root, and query those that run no command. An option on
// no list is unknown: the gate cannot tell which word is the command, so it refuses. joined marks a
// runner that hands its words to sh as one line, indirect one that adds arguments from stdin or a
// file, and package one that runs a package's program, which PATH does not find.
const RUNNER_SPECS = {
  env: { flags: 'iv0', values: 'u', refuse: 'SCP', long: ['--ignore-environment', '--null', '--debug'], longValues: ['--unset'], refuseLong: ['--split-string', '--chdir'], assigns: true },
  sudo: { flags: 'AbEHknPS', values: 'CgprTtUu', refuse: 'DRiseh', query: 'lKVv', long: ['--askpass', '--background', '--preserve-env', '--set-home', '--non-interactive', '--preserve-groups', '--stdin', '--reset-timestamp'], longValues: ['--close-from', '--group', '--prompt', '--role', '--command-timeout', '--type', '--other-user', '--user'], longOptional: ['--preserve-env'], refuseLong: ['--chdir', '--chroot', '--login', '--shell', '--edit', '--host'], queryLong: ['--list', '--validate', '--version', '--help', '--remove-timestamp'] },
  doas: { flags: 'nL', values: 'u', refuse: 'sC' },
  nohup: {},
  nice: { values: 'n', numeric: true, longValues: ['--adjustment'] },
  ionice: { flags: 't', values: 'cn', query: 'p' },
  xargs: { flags: '0oprtx', values: 'aEdILnPsJRS', optional: 'eil', indirect: true, long: ['--null', '--no-run-if-empty', '--open-tty', '--interactive', '--verbose', '--exit'], longValues: ['--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'], longOptional: ['--replace', '--eof', '--max-lines'] },
  timeout: { flags: 'v', values: 'sk', lead: 1, long: ['--foreground', '--preserve-status', '--verbose'], longValues: ['--signal', '--kill-after'] },
  gtimeout: { flags: 'v', values: 'sk', lead: 1, long: ['--foreground', '--preserve-status', '--verbose'], longValues: ['--signal', '--kill-after'] },
  exec: { flags: 'cl', values: 'a' },
  command: { flags: 'p', query: 'vV' },
  builtin: {},
  caffeinate: { flags: 'dimsu', values: 'tw' },
  stdbuf: { values: 'ioe', longValues: ['--input', '--output', '--error'] },
  unbuffer: { flags: 'p' },
  script: { flags: 'adeFkqr', values: 't', refuse: 'c', lead: 1, refuseLong: ['--command'] },
  watch: { flags: 'bcdegptx', values: 'nq', long: ['--beep', '--color', '--differences', '--errexit', '--chgexit', '--precise', '--no-title', '--exec'], longValues: ['--interval', '--equexit'], joined: true },
  flock: { flags: 'sxeunoF', values: 'wE', refuse: 'c', lead: 1, long: ['--shared', '--exclusive', '--unlock', '--nonblock', '--close', '--no-fork', '--verbose'], longValues: ['--timeout', '--conflict-exit-code'], refuseLong: ['--command'] },
  parallel: { refuseAll: 'runs commands it builds from its arguments' },
  setsid: { flags: 'cfw', long: ['--ctty', '--fork', '--wait'] },
  chroot: { refuseAll: 'runs its command inside another root, where its programs are other files' },
  npx: { package: true, flags: 'yq', values: 'p', refuse: 'c', long: ['--yes', '--no', '--quiet', '--ignore-existing'], longValues: ['--package'], refuseLong: ['--call', '--shell'] },
  pnpx: { package: true, flags: 'yq', values: 'p', refuse: 'c', long: ['--yes', '--no', '--quiet'], longValues: ['--package'], refuseLong: ['--call', '--shell'] },
  bunx: { package: true, values: 'p', long: ['--bun', '--silent'], longValues: ['--package'] },
  uvx: { package: true, flags: 'qn', long: ['--quiet', '--isolated', '--offline', '--no-cache'], longValues: ['--from', '--with', '--python'] },
  chronic: { flags: 'ev' },
  time: { flags: 'ahlpv', values: 'fo' },
};
// The search path a shell uses when PATH is cleared (env -i) or set to the default (command -p).
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
// Builtins command, builtin and time can run, which PATH does not hold.
const SHELL_BUILTINS = new Set(['cd', 'echo', 'printf', 'test', '[', 'true', 'false', 'pwd', 'read', 'type', 'export', 'unset', 'set', 'shift', 'alias', 'unalias', 'hash', 'kill', 'wait', 'jobs', 'fg', 'bg', 'umask', 'ulimit', 'getopts', 'local', 'return', 'exit', 'declare', 'typeset', 'readonly', 'let', 'shopt', 'history', 'dirs', 'pushd', 'popd', 'times', 'whence', 'where', 'which', ':']);
const EVALUATORS = new Set(['eval', 'source', '.', 'trap']);
const SHELLS = /^(sh|bash|zsh|dash|ksh|fish|busybox|su|runuser)$/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A command name for the lists that refuse or gate (runners, shells, tools): case-folded, since another
// case runs the same program on macOS. The lists that allow (reads, sinks, data) match it exactly.
const foldedName = (value) => basename(String(value)).toLowerCase();

const label = (cmd) => cmd.words.map((word) => word.raw).join(' ').slice(0, 100);
const expandWord = (word) => (word.tilde ? word.value.replace(/^~(?=$|\/)/, HOME) : word.value);

// The command text a hook payload holds. Codex may hand it over as an argument list: a shell with -c
// and one script is read as that script, and any other list as one command with literal words.
export function payloadCommand(payload) {
  const raw = payload.tool_input?.command;
  if (Array.isArray(raw)) {
    const argv = raw.map(String);
    if (argv.length === 3 && /^(sh|bash|zsh|dash|ksh)$/.test(foldedName(argv[0])) && /^-[li]*c$/.test(argv[1])) return { text: argv[2], argv };
    return { text: argv.map((word) => (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`)).join(' '), argv };
  }
  return typeof raw === 'string' ? { text: raw, argv: null } : null;
}

// The files a program word may run: a path as written, or the first executable file on PATH, the
// way the shell searches it. An empty or relative PATH entry is read from the command's folder. A
// line may set PATH, so there can be one search path per value it may hold, and the word counts as
// each file it finds. A candidate the gate cannot stat, or a search it cannot place, refuses. The
// native realpath spells a file as the disk stores it, so /usr/bin/GIT comes back as /usr/bin/git.
function programFiles(word, cwd, paths = [process.env.PATH ?? '']) {
  if (word.includes('/')) {
    try {
      return [realpathSync.native(resolve(cwd ?? '/', expandHome(word)))];
    } catch {
      return [];
    }
  }
  const files = new Set();
  for (const path of paths) {
    for (const entry of path.split(delimiter)) {
      const dir = entry === '' ? '.' : expandHome(entry);
      if (!isAbsolute(dir) && !cwd) refuse(`PATH holds ${entry ? `the relative entry ${entry}` : 'an empty entry'}, which the shell reads from the command's folder, and the gate cannot tell which folder that is. Run it from a literal folder.`);
      const candidate = resolve(cwd ?? '/', dir, word);
      let stat;
      try {
        stat = statSync(candidate);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(error.code)) continue;
        refuse(`${candidate} is on PATH and the gate cannot read it (${error.code}), so it cannot tell which program ${word} runs.`);
      }
      if (!stat.isFile()) continue;
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
      files.add(realpathSync.native(candidate));
      break;
    }
  }
  return [...files];
}

const programFile = (word, cwd, paths) => programFiles(word, cwd, paths)[0] ?? null;

// The tool a command word runs: by its name, or by the real file it names (a link to git is git).
function toolOf(word, cwd, paths) {
  const name = foldedName(word);
  if (TOOLS.has(name) || ['pipeline', 'curl', 'wget'].includes(name)) return name;
  return programFiles(word, cwd, paths).map((file) => foldedName(file)).find((real) => TOOLS.has(real) || ['curl', 'wget'].includes(real)) ?? null;
}

// A runner's own words, read by its spec: the index of the command it runs, the options it was
// given, the variables env sets, and a problem when an option is unknown or one the gate refuses.
function runnerWords(words, spec) {
  const used = new Set();
  const unset = [];
  const assigns = [];
  let i = 1;
  const done = (extra) => ({ index: i, used, unset, assigns, ...extra });
  while (i < words.length) {
    const value = words[i].value;
    if (value === '--') { i++; break; }
    if (spec.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) { assigns.push(words[i]); i++; continue; }
    if (spec.assigns && value === '-') { used.add('-i'); i++; continue; }
    if (value.startsWith('--')) {
      const option = value.split('=')[0];
      const attached = value.includes('=');
      if ((spec.refuseLong ?? []).includes(option)) return done({ problem: option });
      if ((spec.queryLong ?? []).includes(option)) return done({ query: true });
      if ((spec.longOptional ?? []).includes(option) || ((spec.long ?? []).includes(option) && !attached)) { used.add(option); i++; continue; }
      if ((spec.longValues ?? []).includes(option)) {
        if (option === '--unset') unset.push(attached ? value.slice(option.length + 1) : words[i + 1]?.value);
        used.add(option);
        i += attached ? 1 : 2;
        continue;
      }
      return done({ problem: `${option}, an option the gate does not read` });
    }
    if (value.startsWith('-') && value.length > 1) {
      if (spec.numeric && /^-\d+$/.test(value)) { i++; continue; }
      let next = 1;
      for (let k = 1; k < value.length; k++) {
        const letter = value[k];
        if ((spec.refuse ?? '').includes(letter)) return done({ problem: `-${letter}` });
        if ((spec.query ?? '').includes(letter)) return done({ query: true });
        used.add(`-${letter}`);
        if ((spec.flags ?? '').includes(letter)) continue;
        if ((spec.optional ?? '').includes(letter)) break;
        if ((spec.values ?? '').includes(letter)) {
          const attachedValue = value.slice(k + 1);
          if (letter === 'u') unset.push(attachedValue || words[i + 1]?.value);
          if (!attachedValue) next = 2;
          break;
        }
        return done({ problem: `-${letter}, an option the gate does not read` });
      }
      i += next;
      continue;
    }
    break;
  }
  i += spec.lead ?? 0;
  return done({});
}

// The index of the word a runner runs as its command, past its options and their values.
function commandIndex(words) {
  const spec = RUNNER_SPECS[foldedName(words[0].value)] ?? {};
  return spec.refuseAll ? words.length : runnerWords(words, spec).index;
}

// A PATH value as the shell sets it, for each search path the line may already hold: $PATH, $HOME
// and $PWD are filled in, and anything else built at run time leaves it unknown (null).
function pathValues(word, paths, cwd) {
  const text = word.value.replace(/^[A-Za-z_][A-Za-z0-9_]*\+?=/, '');
  // PATH+=x appends to each search path the line may hold.
  if (/^[A-Za-z_][A-Za-z0-9_]*\+=/.test(word.value)) return word.literal && !text.includes('$') ? paths.map((path) => `${path}${text}`) : pathValues({ ...word, literal: false, value: `PATH=$PATH${text}` }, paths, cwd);
  if (word.literal) return [text];
  if (/[`\\]|\$\(/.test(text)) return null;
  const out = [];
  for (const path of paths) {
    const filled = text.replace(/\$\{PATH\}|\$PATH\b/g, path).replace(/\$\{HOME\}|\$HOME\b/g, HOME).replace(/\$\{PWD\}|\$PWD\b/g, cwd ?? '$PWD');
    if (filled.includes('$')) return null;
    out.push(filled.split(delimiter).map((entry) => entry.replace(/^~(?=$|\/)/, HOME)).join(delimiter));
  }
  return out;
}

// What a command runs once every runner around it is taken off: its words, the runners, and the
// search paths it is found with. A runner the gate cannot read refuses, as does one whose command
// it cannot find, since the gate cannot tell what that runs.
function unwrapAll(cmd) {
  let words = cmd.words;
  let paths = cmd.paths ?? [process.env.PATH ?? ''];
  let pathUnknown = Boolean(cmd.pathUnknown);
  const runners = [];
  let indirect = false;
  let packaged = false;
  while (words.length && words[0].literal && RUNNERS.has(foldedName(words[0].value)) && runners.length < 8) {
    const name = foldedName(words[0].value);
    const spec = RUNNER_SPECS[name] ?? {};
    if (spec.refuseAll) refuse(`\`${label(cmd)}\` uses ${name}, which ${spec.refuseAll}, so the gate cannot tell what runs. Run the command on its own.`);
    const parsed = runnerWords(words, spec);
    if (parsed.problem) refuse(`\`${label(cmd)}\` gives ${name} ${parsed.problem}, so the gate cannot tell which command ${name} runs. Run the command without ${name}, or without that option.`);
    runners.push(name);
    if (parsed.query) return { words: [], runners, paths, pathUnknown, indirect, packaged };
    if (name === 'env') {
      if (parsed.used.has('-i') || parsed.used.has('--ignore-environment') || parsed.unset.includes('PATH')) paths = [DEFAULT_PATH];
      for (const assign of parsed.assigns.filter((word) => /^PATH=/.test(word.value))) {
        const next = pathValues(assign, paths, cmd.cwd);
        if (next) paths = next;
        else pathUnknown = true;
      }
    }
    if (name === 'command' && parsed.used.has('-p')) paths = [DEFAULT_PATH];
    if (spec.indirect) indirect = true;
    if (spec.package) packaged = true;
    const rest = words.slice(parsed.index);
    // watch hands its words to sh as one line. Words with nothing the shell reads again stay as they are.
    if (spec.joined && !parsed.used.has('-x') && !parsed.used.has('--exec') && rest.some((word) => !/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(word.value))) refuse(`\`${label(cmd)}\` hands its command to sh as one line, and a word in it holds a character sh reads again, so the gate cannot tell what runs. Run the command on its own.`);
    words = rest;
  }
  return { words, runners, paths, pathUnknown, indirect, packaged };
}

// The word that makes a command run something built at run time, or null.
function dynamicCommand(words) {
  if (!words.length) return null;
  const first = words[0];
  if (!first.literal) return first.raw;
  const name = foldedName(first.value);
  if (EVALUATORS.has(name)) return words.slice(1).find((word) => !word.literal)?.raw ?? null;
  if (SHELLS.test(name)) {
    const flag = words.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word.value));
    const script = flag === -1 ? words.slice(1).find((word) => !word.value.startsWith('-')) : words[flag + 1];
    return script && !script.literal ? script.raw : null;
  }
  if (name === 'find') {
    const at = words.findIndex((word) => /^-(exec|execdir|ok|okdir)$/.test(word.value));
    return at !== -1 && words[at + 1] && !words[at + 1].literal ? words[at + 1].raw : null;
  }
  if (!RUNNERS.has(name)) return null;
  const index = commandIndex(words);
  const before = words.slice(1, index + 1).find((word) => !word.literal);
  if (before) return before.raw;
  return index < words.length ? dynamicCommand(words.slice(index)) : null;
}

// The wrappers a gated command may sit behind: timeout with a duration, and caffeinate with only
// its keep-awake flags. Returns the words of the command itself.
function peel(words) {
  let rest = words;
  for (;;) {
    const name = basename(rest[0]?.value ?? '');
    if (['timeout', 'gtimeout'].includes(name) && /^\d+(\.\d+)?[smhd]?$/.test(rest[1]?.value ?? '')) rest = rest.slice(2);
    else if (name === 'caffeinate') {
      let i = 1;
      while (i < rest.length && /^-[dimsu]+$/.test(rest[i].value)) i++;
      if (i < rest.length && rest[i].value.startsWith('-')) return rest;
      rest = rest.slice(i);
    } else return rest;
    if (!rest.length) return rest;
  }
}

// The repositories on this machine, or the reason they cannot be read.
function registry() {
  try {
    return { entries: registeredRepos(), error: null };
  } catch (error) {
    if (error instanceof RegistryError) return { entries: [], error: error.message };
    throw error;
  }
}

// Whether a command runs a registered deploy script: the script as its program, or after an
// interpreter. It is bound to the one repository whose script it is, by real path or content.
// Within that repository's own folders, a command matching its deploy.match counts too.
function deployOf(words, cwd, reg, paths) {
  const head = words[0];
  if (!head?.literal) return null;
  const interpreter = INTERPRETERS.test(foldedName(head.value)) ? foldedName(head.value) : null;
  const scriptIndex = interpreter ? words.findIndex((word, i) => i > 0 && !word.value.startsWith('-')) : 0;
  if (scriptIndex === -1) return null;
  const script = words[scriptIndex];
  if (!script.literal) return null;
  let files = [];
  if (scriptIndex === 0) files = programFiles(script.value, cwd, paths);
  else {
    try { files = [realpathSync(resolve(cwd ?? '/', expandHome(script.value)))]; } catch { files = []; }
  }
  const owners = files.flatMap((file) => deployScriptEntries(file, reg.entries));
  const identities = [...new Set(owners.map((entry) => entry.identity))];
  if (identities.length > 1) return { ambiguous: identities, interpreter };
  if (identities.length === 1) return { entry: owners[0], interpreter, argsFrom: scriptIndex + 1 };
  if (/\s/.test(script.value)) return null;
  const local = localEntry(cwd, reg);
  // A pattern that cannot be read is refused in describe, for every command but plain reads.
  const regex = local ? patternOf(local).pattern : null;
  if (!regex) return null;
  const values = words.map((word) => word.value);
  const joined = values.join(' ');
  const match = regex.exec(joined);
  const start = scriptIndex ? values.slice(0, scriptIndex).join(' ').length + 1 : 0;
  if (!match || match.index < start || match.index >= start + script.value.length) return null;
  const end = match.index + match[0].length;
  let offset = 0;
  let last = values.length - 1;
  for (let k = 0; k < values.length; k++) {
    offset += values[k].length + 1;
    if (end <= offset) { last = k; break; }
  }
  return { entry: local, interpreter, argsFrom: last + 1, byPattern: true };
}

// Whether two folders share one jj store. A store that cannot be read is never the same as another.
function sameStore(a, b) {
  const store = storeOf(a);
  return store !== null && store === storeOf(b);
}

// The jj workspace folder a folder is in, found without running jj.
function workspaceRoot(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, '.jj'))) return current;
    if (current === dirname(current)) return null;
  }
}

// The repository a folder belongs to: its registry entry, by jj store, found without running jj.
// A repository not registered yet is read from its working copy's config, which can only add a
// deploy pattern to gate on: the action is then checked against the committed config.
function localEntry(cwd, reg) {
  if (!cwd) return null;
  reg.stores ??= new Map();
  if (!reg.stores.has(cwd)) {
    const root = workspaceRoot(cwd);
    const store = root ? storeOf(root) : null;
    let entry = store ? reg.entries.find((candidate) => candidate.store === store) ?? null : null;
    if (!entry && root && existsSync(join(root, CONFIG_FILE))) {
      try {
        const match = JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')).deploy?.match;
        if (typeof match === 'string') entry = { path: root, identity: null, deployMatch: match };
      } catch (error) {
        entry = { path: root, identity: null, unreadable: `${join(root, CONFIG_FILE)} cannot be read (${error.message})` };
      }
    }
    reg.stores.set(cwd, entry);
  }
  return reg.stores.get(cwd);
}

// The deploy pattern of a folder's repository, or why it is unknown.
const patternOf = (entry) => {
  if (entry.unreadable) return { why: entry.unreadable };
  try {
    return { pattern: entry.deployMatch ? new RegExp(entry.deployMatch) : null };
  } catch (error) {
    return { why: `the deploy.match of ${entry.path} is not a valid regular expression (${error.message})` };
  }
};

// A command that only reads or prints, which no deploy script can stand in for.
const plainRead = (info) => !runsCode(info) && (Object.hasOwn(READ_OPTIONS, info.name) || DATA.has(info.name) || SINKS.has(info.name));

// A program the system ships in its own folders, which macOS keeps read-only, so it is not a deploy
// script. Anything else PATH finds could be one.
const SYSTEM_FOLDERS = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/usr/libexec/'];
const systemProgram = (info) => {
  const head = info.words[0];
  if (!head?.literal || runsCode(info)) return false;
  const files = programFiles(head.value, info.cmd.cwd, info.paths);
  return files.length > 0 && files.every((file) => SYSTEM_FOLDERS.some((folder) => file.startsWith(folder)));
};

// Whether a word names a registered deploy script, by real path or content.
// A bare word is looked up through PATH as well, unless the command only prints its words: a wrapper
// (command, nice, env, xargs) runs a bare name the way the shell would.
function scriptFile(word, cwd, reg, { viaPath = false, paths } = {}) {
  if (!reg.entries.length || word.value.startsWith('-')) return false;
  const value = expandWord(word);
  const here = value.includes('/') || existsSync(resolve(cwd ?? '/', value));
  const files = here ? [resolve(cwd ?? '/', value)] : viaPath ? programFiles(value, cwd, paths) : [];
  return files.some((file) => {
    try {
      return deployScriptEntries(realpathSync(file), reg.entries).length > 0;
    } catch {
      return false;
    }
  });
}

// What a command is, decided without running anything.
// A command the gate classifies without finding its program: a plain read, data or a shell builtin.
const knownName = (name) => Object.hasOwn(READ_OPTIONS, name) || DATA.has(name) || SINKS.has(name) || SHELL_BUILTINS.has(name) || READ_ONLY.has(name);

function describe(cmd, reg) {
  const words = peel(cmd.words);
  const head = words[0];
  // Every runner is taken off to find what runs. Only the wrappers peel allows may stand before a
  // gated command, so the rest are refused there.
  const unwrapped = unwrapAll(cmd);
  const info = { cmd, words, name: head ? basename(head.value) : '', tool: null, deploy: null, data: false, inner: unwrapped.words, runners: unwrapped.runners, indirect: unwrapped.indirect, paths: unwrapped.paths };
  if (!head) return info;
  const innerHead = unwrapped.words[0];
  const innerName = innerHead ? basename(innerHead.value) : '';
  if (innerHead?.literal && !innerName.includes('/') && unwrapped.pathUnknown && !knownName(innerName)) refuse(`\`${label(cmd)}\` runs ${innerName} after PATH is set to a value built at run time, so the gate cannot tell which program that is. Write the program's full path, or set PATH to a literal value.`);
  const resolvable = !unwrapped.pathUnknown || innerName.includes('/');
  if (unwrapped.runners.length && innerHead?.literal && !unwrapped.packaged && resolvable) {
    const builtin = SHELL_BUILTINS.has(innerName) && ['command', 'builtin', 'time'].includes(unwrapped.runners.at(-1));
    if (!builtin && !programFiles(innerHead.value, cmd.cwd, unwrapped.paths).length) refuse(`\`${label(cmd)}\` runs ${innerHead.value} through ${unwrapped.runners.at(-1)}, and the gate cannot find ${innerHead.value}, so it cannot tell what runs. Write its full path.`);
  }
  info.tool = head.literal && resolvable ? toolOf(head.value, cmd.cwd, unwrapped.paths) : null;
  info.innerTool = innerHead?.literal && resolvable ? toolOf(innerHead.value, cmd.cwd, unwrapped.paths) : null;
  info.data = DATA.has(info.name) && words.every((word) => word.literal) && !readOptionProblem(info.name, words);
  info.deploy = resolvable ? deployOf(words, cmd.cwd, reg, unwrapped.paths) : null;
  // A deploy script named anywhere in a command, run through a wrapper or passed to another program.
  info.scriptMention = !info.deploy && words.some((word, i) => i > 0 && word.literal && scriptFile(word, cmd.cwd, reg, { viaPath: !info.data && resolvable, paths: unwrapped.paths }));
  // A deploy pattern counts only in its own repository's folders.
  const known = patternOf(localEntry(cmd.cwd, reg) ?? {});
  // jj, git and gh go through their own checks, which read the config themselves and refuse.
  if (known.why && !plainRead(info) && !TOOLS.has(info.tool)) refuse(`${known.why[0].toUpperCase()}${known.why.slice(1)}, so the gate cannot tell whether this runs the deploy command. Fix the file first.`);
  info.pattern = known.pattern ?? null;
  info.patternMention = Boolean(info.pattern) && !info.data && info.pattern.test(stripped(commandText(cmd)));
  return info;
}

// The text of a command a mention counts in: its words, assignments, redirections and heredocs.
const commandText = (cmd) => [...cmd.assigns, ...cmd.words, ...cmd.redirs.map((redir) => redir.target)].map((word) => word.raw).join(' ') + cmd.redirs.map((redir) => (redir.body ? `\n${redir.body}` : '')).join('');

const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
// A command that runs code from a file: a shell, an interpreter, source or `.`, or a program run by
// its path, such as ./x.sh.
const runsCode = (info) => {
  const head = info.words[0]?.value ?? '';
  const name = foldedName(head);
  return SHELLS.test(name) || INTERPRETERS.test(name) || EVALUATORS.has(name) || head.includes('/');
};

// Why the line is gated, or null.
function gatedBy(infos, reg, text) {
  // A data command's words are data only while its output goes nowhere that runs it: not into a
  // pipe stage that is not a sink, and not into a file on a line that also runs a shell or an
  // interpreter, which could run that file.
  const lineRunsCode = infos.some(runsCode);
  infos.forEach((info, i) => {
    const downstream = infos.slice(i + 1).filter((other) => other.cmd.segment === info.cmd.segment && other.cmd.stage > info.cmd.stage);
    const intoFile = lineRunsCode && info.cmd.redirs.some((redir) => OUTPUT_REDIRECTS.has(redir.op) && !/^\d$/.test(redir.target.value));
    if (info.data && (intoFile || downstream.some((other) => !SINKS.has(other.name)))) {
      info.data = false;
      info.writesScript = intoFile;
      info.patternMention = Boolean(info.pattern) && info.pattern.test(stripped(commandText(info.cmd)));
    }
  });
  for (const info of infos) {
    if (info.deploy) return 'the deploy command';
    if (TOOLS.has(info.tool)) return info.tool;
    if (['curl', 'wget'].includes(info.tool) && mentionsGithub(commandText(info.cmd))) return `${info.tool} to GitHub`;
    // A gated program behind a runner: classify refuses every runner but the wrappers peel allows.
    // A request whose URLs come from stdin or a file (xargs) may reach GitHub unseen.
    if (TOOLS.has(info.innerTool) || (['curl', 'wget'].includes(info.innerTool) && (mentionsGithub(commandText(info.cmd)) || info.indirect))) return `${info.innerTool} through ${info.runners.join(' ')}`;
    if (!info.data && mentionsTool(commandText(info.cmd))) return 'a jj, git, gh or agent-review mention';
    if (info.patternMention) return 'the deploy command pattern';
    if (info.scriptMention) return 'the deploy script';
    if (info.cmd.words.some((word) => word.literal && word.value.includes('/') && TOOLS.has(foldedName(programFile(word.value, info.cmd.cwd) ?? '')))) return 'a path to jj, git or gh';
  }
  // With the registry unreadable the deploy scripts are unknown, and one can have any name, so every
  // line that runs a program other than plain reads and the system's own is gated.
  if (reg.error && (/deploy/i.test(text) || !infos.every((info) => plainRead(info) || systemProgram(info)))) return 'a command that may run a deploy script, while the registry cannot be read';
  return null;
}

// The paths a word may name: itself, its value after =, and, for a short option cluster such as
// -so.git/config, every attached tail, since the gate does not know which letter takes the value.
function pathCandidates(value) {
  const out = [value];
  if (value.includes('=')) out.push(value.slice(value.indexOf('=') + 1));
  if (/^-[^-]/.test(value)) for (let k = 2; k < value.length; k++) out.push(value.slice(k));
  return out.filter((candidate) => candidate && !(candidate.startsWith('-') && !candidate.includes('/')));
}

// curl writes a file through %output{path} in a -w format, which no word names as a path. curl and
// wget also read options, URLs, a format or a file name from somewhere the gate cannot see before
// they run: curl's -K file, -w @file and --expand-* options (variables from files and the
// environment), and wget's --config, -e commands and -i or --input-metalink URL lists, stdin
// included. These hold on any line, GitHub or not, for the command under every runner. wget takes
// any prefix of a long option, curl only the full name.
function httpOptionFiles(cmd) {
  const { words, runners } = unwrapAll(cmd);
  const name = foldedName(words[0]?.value ?? '');
  const texts = words.slice(1).map((word) => word.value);
  const via = runners.length ? ` through ${runners.join(' ')}` : '';
  if (name === 'curl') {
    for (const text of texts) {
      for (const found of text.matchAll(/%output\{(?:>>)?([^}]*)\}/gi)) {
        const reason = controlPath(found[1], cmd.cwd);
        if (reason) refuse(`\`${label(cmd)}\` writes ${reason} through curl's %output{}, which steers git, jj or the gate. The user changes those files.`);
      }
    }
    const format = clusterValues(texts, 'w', '--write-out').find((value) => value.startsWith('@'));
    if (format) refuse(`\`${label(cmd)}\` reads curl's -w format from ${format === '@-' ? 'stdin' : 'a file'}${via}, which the gate cannot see. Write the format out.`);
    if (clusterValues(texts, 'K', '--config').length) refuse(`\`${label(cmd)}\` reads curl's options from a file (-K)${via}, which the gate cannot see. Write the options out.`);
    if (clusterValues(texts, null, '--remote-header-name').length || texts.some((text) => /^-[A-Za-z0-9]*J/.test(text) && !text.startsWith('--'))) refuse(`\`${label(cmd)}\` writes a file the server names (-J), which the gate cannot see before it runs. Name the file with -o.`);
    const expand = texts.find((text) => /^--expand-/.test(text));
    if (expand) refuse(`\`${label(cmd)}\` fills curl's ${expand.split('=')[0]} from variables, which can come from files or the environment the gate cannot see. Write the value out.`);
  }
  if (name === 'wget') {
    const prefixes = { prefixes: true };
    if (clusterValues(texts, null, '--config', prefixes).length) refuse(`\`${label(cmd)}\` reads wget's options from a file (--config)${via}, which the gate cannot see. Write the options out.`);
    if (clusterValues(texts, 'e', '--execute', prefixes).length) refuse(`\`${label(cmd)}\` runs wgetrc commands (-e)${via}, which the gate does not read. Pass the matching option instead.`);
    if (['--content-disposition', '--trust-server-names'].some((option) => clusterValues(texts, null, option, prefixes).length)) refuse(`\`${label(cmd)}\` writes a file the server names, which the gate cannot see before it runs. Name the file with -O.`);
    if (clusterValues(texts, 'i', '--input-file', prefixes).length || clusterValues(texts, null, '--input-metalink', prefixes).length) refuse(`\`${label(cmd)}\` reads the URLs wget fetches from a file or stdin (-i)${via}, which the gate cannot see. Name each URL.`);
  }
}

// What echo or printf prints when every word is literal and nothing in it is read again, or null.
function printed(cmd) {
  const words = cmd.words;
  if (!words.length || !words.every((word) => word.literal)) return null;
  const name = foldedName(words[0].value);
  if (name === 'echo') {
    const rest = words.slice(1).map((word) => word.value);
    if (rest.some((value) => /^-[neE]+$/.test(value) && value !== '-n') || rest.some((value) => value.includes('\\'))) return null;
    return rest.filter((value, i) => !(i === 0 && value === '-n')).join(' ');
  }
  if (name === 'printf' && words.length === 2 && !words[1].value.includes('%')) return words[1].value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return null;
}

// The command lines a command hands to a shell as text, which the shell reads again: sh -c's
// script, a heredoc or here-string fed to a shell, eval's words, and what echo or printf pipes into
// a shell. A script in a file, or piped from any other program, is code the gate does not read.
function shellScripts(cmd, cmds) {
  const { words } = unwrapAll(cmd);
  if (!words.length || !words[0].literal) return [];
  const name = foldedName(words[0].value);
  if (name === 'eval') return words.length > 1 && words.slice(1).every((word) => word.literal) ? [words.slice(1).map((word) => word.value).join(' ')] : [];
  if (!SHELLS.test(name)) return [];
  const flag = words.findIndex((word, i) => i > 0 && (/^-[A-Za-z]*c[A-Za-z]*$/.test(word.value) || /^--command(=|$)/.test(word.value)));
  if (flag !== -1) {
    if (words[flag].value.startsWith('--command=')) return [words[flag].value.slice('--command='.length)];
    const script = words[flag + 1];
    return script?.literal ? [script.value] : [];
  }
  const options = words.slice(1).filter((word, i, all) => all.slice(0, i + 1).every((each) => each.value.startsWith('-')));
  const fromStdin = options.some((word) => /^-[A-Za-z]*s/.test(word.value)) || words.length === options.length + 1;
  if (!fromStdin) return [];
  const doc = cmd.redirs.find((redir) => redir.op === '<<' || redir.op === '<<-');
  if (doc) return [doc.body ?? ''];
  const here = cmd.redirs.find((redir) => redir.op === '<<<');
  if (here) return here.target.literal ? [here.target.value] : [];
  const upstream = cmds.find((other) => other.segment === cmd.segment && other.stage === cmd.stage - 1);
  if (!upstream || !['echo', 'printf'].includes(foldedName(upstream.words[0]?.value ?? ''))) return [];
  const text = printed(upstream);
  if (text === null) refuse(`\`${label(upstream)}\` pipes a script into ${name} that the gate cannot work out (an escape, a format or a word built at run time). Run the commands directly.`);
  return [text];
}

// The commands of a script a command hands to a shell, placed in the folder it runs in. A script the
// gate cannot read refuses, since the shell may run the part before the mistake.
function scriptCommands(script, cmd, depth) {
  if (depth >= 4) refuse(`\`${label(cmd)}\` nests shells more than four deep, which the gate does not read. Run the commands directly.`);
  const read = readLine(String(script).replace(/\s+$/, ''));
  if (read.error) refuse(`\`${label(cmd)}\` hands a shell a script the gate cannot read (${read.error}), so it cannot tell what it runs or writes. Run the commands directly.`);
  return placeCommands(read.items, cmd.cwd, cmd.paths, cmd.pathUnknown);
}

// Checks every line has to pass, gated or not, and every script it hands a shell.
function everyLine(cmds, depth = 0) {
  for (const cmd of cmds) {
    for (const script of shellScripts(cmd, cmds)) everyLine(scriptCommands(script, cmd, depth), depth + 1);
    const found = dynamicCommand(cmd.words);
    if (found) refuse(`\`${label(cmd)}\` runs a command built at run time (${found}). Write the command out, so the gate can see what runs.`);
    for (const redir of cmd.redirs) {
      if (!OUTPUT_REDIRECTS.has(redir.op) || !redir.target.literal || /^\d$/.test(redir.target.value)) continue;
      const reason = controlPath(expandWord(redir.target), cmd.cwd);
      if (reason) refuse(`It writes ${reason}, which can change what later commands do or turn the gate off. The user changes those files.`);
    }
    httpOptionFiles(cmd);
    const name = basename(cmd.words[0]?.value ?? '');
    // A reader may name a control file, but only with options on its list: sort -o writes one.
    // A tool's arguments are checked by its own reading, on the gated line it makes.
    if (!cmd.words.length || TOOLS.has(name) || ((CONTROL_READERS.has(name) || DATA.has(name)) && !readOptionProblem(name, cmd.words))) continue;
    for (const word of cmd.words.slice(1)) {
      if (!word.literal) continue;
      for (const value of pathCandidates(word.value)) {
        const reason = controlPath(expandWord({ ...word, value }), cmd.cwd);
        if (reason) refuse(`\`${label(cmd)}\` names ${reason}, which steers git, jj or the gate. The user changes those files.`);
      }
    }
  }
}

// Sets each command's folder from the cd commands before it, as far as they can be read.
function placeCommands(items, start, startPaths = [process.env.PATH ?? ''], startUnknown = false) {
  let cwd = start;
  // The search paths a command may be found with. A PATH set for the rest of the line adds one,
  // since a subshell or a pipe stage may not keep it, and one the gate cannot fill in is unknown.
  let paths = startPaths;
  let pathUnknown = startUnknown;
  const cmds = [];
  for (const item of items) {
    if (!item.words) continue;
    const cmd = { ...item, cwd, paths, pathUnknown };
    cmds.push(cmd);
    const head = basename(cmd.words[0]?.value ?? '');
    const own = (cmd.assigns ?? []).filter((word) => /^PATH\+?=/.test(word.value));
    const exported = ['export', 'declare', 'typeset', 'readonly', 'local'].includes(head) ? cmd.words.slice(1).filter((word) => /^PATH\+?=/.test(word.value)) : [];
    for (const word of own) {
      const next = pathValues(word, paths, cwd);
      if (cmd.words.length) {
        if (next) cmd.paths = next;
        else cmd.pathUnknown = true;
      } else if (next) paths = [...new Set([...paths, ...next])];
      else pathUnknown = true;
    }
    for (const word of exported) {
      const next = pathValues(word, paths, cwd);
      if (next) paths = [...new Set([...paths, ...next])];
      else pathUnknown = true;
    }
    if (head === 'unset' && cmd.words.some((word) => word.value === 'PATH')) pathUnknown = true;
    if (basename(cmd.words[0]?.value ?? '') === 'cd') {
      const target = cmd.words[1];
      if (cmd.words.length === 1) cwd = HOME;
      else if (!target.literal || target.value === '-' || cmd.words.length > 2) cwd = null;
      else if (cwd === null && !isAbsolute(expandWord(target))) cwd = null;
      else cwd = resolve(cwd ?? '/', expandWord(target));
    }
  }
  return cmds;
}

// The simple commands of a line, each with the folder it runs in, for the post-push mirror.
export function lineCommands(text, start) {
  const read = readLine(text);
  return read.error ? [] : placeCommands(read.items, start);
}

// The line, as the action checks see it: the repositories they act in, read once each, and the
// bookmarks set earlier on the line.
class Line {
  constructor(reg, start) {
    this.registry = reg;
    this.start = start;
    this.contexts = new Map();
    this.pins = [];
  }

  context(dir) {
    if (dir === null || dir === undefined) refuse('The gate cannot tell which folder it runs in. Run it from the workspace, with a literal path.');
    if (!this.contexts.has(dir)) {
      try {
        this.contexts.set(dir, actionContext(dir));
      } catch (error) {
        if (error instanceof TrustError || error instanceof RegistryError) refuse(error.message);
        throw error;
      }
    }
    return this.contexts.get(dir);
  }

  // The bookmarks set earlier on the line in this repository, each resolved to its one commit.
  pinsFor(ctx) {
    const out = new Map();
    for (const pin of this.pins) {
      // Bookmarks belong to the repository, so a pin from another workspace of it counts too. Its
      // revision is read where it runs: @- in a lane workspace is that lane's commit.
      const root = jjRoot(pin.dir);
      if (!root || !sameStore(root, ctx.repo)) refuse(`\`${pin.label}\` sets a bookmark in another repository than the push. Run it on its own first.`);
      const ids = resolveRevset(root, pin.rev);
      if (ids.length !== 1) refuse(`${pin.rev} must name exactly one commit, found ${ids.length}.`);
      for (const name of pin.names) out.set(name, { target: ids[0], conflict: false });
    }
    return out;
  }
}

// One command on a gated line, sorted into cd, read, pin, local, other or action.
function classify(info, line) {
  const { cmd, words, name } = info;
  if (!words.length) refuse(`\`${label(cmd)}\` runs nothing the gate can read.`);
  if (info.deploy?.ambiguous) refuse(`This script is the deploy script of more than one repository (${info.deploy.ambiguous.join(', ')}), so the gate cannot tell whose rules apply. Give each repository its own script.`);
  if (info.deploy) return { cls: 'action', kind: 'the deploy', check: () => deployCheck(line, info) };
  if (info.innerTool && info.innerTool !== info.tool && (TOOLS.has(info.innerTool) || ['curl', 'wget'].includes(info.innerTool))) {
    refuse(`\`${label(cmd)}\` runs ${info.innerTool} through ${info.runners.join(' ')}, which the gate does not read${info.indirect ? `, with arguments from ${info.runners.includes('xargs') ? 'stdin or a file' : 'elsewhere'}` : ''}. Run ${info.innerTool} directly, written out in full.`);
  }
  const inner = { ...cmd, words };
  switch (info.tool) {
    case 'jj': return classifyJj(inner, line);
    case 'git': return classifyGit(inner, line);
    case 'gh': return classifyGh(inner, line);
    case 'agent-review': return classifyReview(inner);
    case 'curl': case 'wget': return mentionsGithub(commandText(cmd)) ? classifyHttp(inner) : { cls: 'other' };
    case 'pipeline': return classifyPipeline(inner, line);
    default: break;
  }
  if (name === 'cd') return { cls: 'cd' };
  if (info.writesScript && mentionsTool(commandText(cmd))) refuse(`\`${label(cmd)}\` writes a command that names jj, git, gh or agent-review into a file, on a line that also runs a shell or an interpreter. Run the tool directly, written out in full.`);
  if (READ_ONLY.has(name)) {
    const problem = readOptionProblem(name, words);
    if (problem) refuse(`\`${label(cmd)}\` has an option the gate does not read (${problem}). On a line that holds a gated command, ${name} runs only with options from its list${someOptions(READ_OPTIONS[name])}, spelled out in full. Run it without that option, or on its own line.`);
    return { cls: 'read' };
  }
  if (!info.data && mentionsTool(commandText(cmd))) refuse(`\`${label(cmd)}\` runs or passes jj, git, gh or agent-review through ${name}, which the gate does not read. Run the tool directly, written out in full.`);
  if (info.patternMention || info.scriptMention) refuse(`\`${label(cmd)}\` names the deploy ${info.scriptMention ? 'script' : 'command (deploy.match)'} through ${name}, which the gate does not read. Run the deploy as deploy.command does.`);
  return { cls: 'other' };
}

// pipeline exec -- <command>: the command it runs is what counts.
function classifyPipeline(cmd, line) {
  const values = cmd.words.map((word) => word.value);
  if (values[1] !== 'exec') return { cls: 'local' };
  const at = values.indexOf('--');
  const words = cmd.words.slice(at === -1 ? 2 : at + 1);
  if (!words.length) return { cls: 'read' };
  return classify(describe({ ...cmd, words }, line.registry), line);
}

// agent-review: a review start, and the ask that sends round 1, wait on their stage.
function classifyReview(cmd) {
  const [sub, ...args] = cmd.words.slice(1).map((word) => word.value);
  if (!['start', 'ask'].includes(sub)) return { cls: 'local' };
  return { cls: 'action', kind: `agent-review ${sub}`, check: () => checkReview(cmd.cwd, sub, args) };
}

const REVIEW_VALUES = ['--topic', '--tip', '--dir', '--repo', '--to', '--phase', '--file', '--from', '--model', '--effort', '--provider'];
function reviewFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    if (REVIEW_VALUES.includes(args[i])) i++;
  }
  return undefined;
}

// The pipeline of the folder a review command runs in. A folder without one is not checked, and one
// whose pipeline cannot be read is refused: an agent could break the config to skip the checks.
function reviewContext(cwd) {
  let ctx;
  try {
    ctx = repoContext(cwd, { required: false });
  } catch (error) {
    refuse(`The gate cannot read the pipeline here (${error.message}), so it cannot check this review command. Fix that first.`);
  }
  return ctx?.config.committed ? ctx : null;
}

function checkReview(cwd, sub, args) {
  const ctx = reviewContext(cwd);
  if (!ctx) return [];
  const topic = reviewFlag(args, '--topic');
  if (!topic) return [];
  const runEntry = loadRuns().find((candidate) => candidate.identity === ctx.identity && candidate.reviewTopics?.[topic]);
  if (!runEntry) return [];
  const kind = runEntry.reviewTopics[topic];
  if (sub === 'start') {
    if (kind === 'design' && !['noted', 'passed'].includes(runEntry.stages.design?.state)) refuse(`The design note of run ${runEntry.id} has not passed its checks. Run pipeline design first.`);
    if (kind === 'code' && !passed(runEntry, 'build')) refuse(`Run ${runEntry.id}'s build has not passed. Run pipeline build --run ${runEntry.id}.`);
    return [];
  }
  const phase = reviewFlag(args, '--phase') ?? 'review';
  const found = agentReviewEntries(ctx.config, { strict: true }).find((candidate) => candidate.topic === topic) ?? findEntry(ctx.config, topic, { strict: true });
  if (phase !== 'review' || !found || found.rounds.length !== 1) return [];
  const to = reviewFlag(args, '--to');
  const own = to ? join(found.folder, 'round-1', `request-${to}.md`) : null;
  const file = reviewFlag(args, '--file') ?? (own && existsSync(own) ? own : join(found.folder, 'round-1', 'request.md'));
  if (!existsSync(file)) return [];
  if (!normalizeWords(readFileSync(file, 'utf8')).includes(normalizeWords(runEntry.intake.words))) refuse(`${file} does not quote the user's words for run ${runEntry.id} verbatim. Paste them into "The user's words".`);
  return [];
}

// The deploy script, checked in the repository it belongs to.
function deployCheck(line, info) {
  const { entry, interpreter, argsFrom } = info.deploy;
  const ctx = line.context(entry.path);
  // A repository not registered and with no committed config has no pipeline yet.
  if (!ctx && !entry.identity) return [];
  if (!ctx || (entry.identity && ctx.identity !== entry.identity)) refuse(`This is the deploy script of ${entry.slug ?? entry.identity}, whose workspace at ${entry.path} no longer holds that repository. Run pipeline status there, so the registry learns where it is.`);
  const { config } = ctx;
  const configured = (config.deploy.command ?? '').trim().split(/\s+/)[0];
  if (interpreter && basename(configured) !== interpreter) refuse(`It runs the deploy script through ${interpreter}. Run it as deploy.command does: ${config.deploy.command ?? '(deploy.command is not set)'}.`);
  if (config.deploy.runBy === 'user') refuse(userRuns(config));
  if (!config.deploy.tipArg) refuse('The gate cannot tell which commit this deploys. Set deploy.tipArg.');
  const args = info.words.slice(argsFrom).filter((word) => !word.value.startsWith('-'));
  const rev = args[config.deploy.tipArg - 1]?.value;
  if (!rev) refuse(`Argument ${config.deploy.tipArg} must be the revision it deploys.`);
  const pinned = line.pinsFor(ctx).get(rev);
  // The script runs in its command's folder, so the revision is read there: @ in a lane workspace
  // is that lane's commit. A folder outside the repository has no @ of its own.
  const here = info.cmd.cwd ? jjRoot(info.cmd.cwd) : null;
  const inStore = here && sameStore(here, ctx.repo);
  if (!pinned && !inStore && /@/.test(rev)) refuse(`${rev} names a working copy, and this runs outside the repository's workspaces, so the gate cannot tell which one. Pass a commit id.`);
  const ids = pinned ? [pinned.target] : resolveRevset(inStore ? here : ctx.repo, rev);
  if (ids.length !== 1) refuse(`${rev} must name exactly one commit, found ${ids.length}.`);
  if (inWorkingCopies(ctx.repo, ids).length) refuse(`${short(ids[0])} is a working-copy commit or sits on one, so what it holds can change before the deploy reads it. Commit the work and deploy the commit.`);
  return deployProblems(ctx, runForCommit(ctx.identity, ids[0]), ids[0]);
}

// A cd on a gated line comes first, on its own, to a folder that exists, so every later command's
// folder is known. It is checked before any later command is read.
function checkCd(cmd, cmds, line, why) {
  const target = cmd.words[1];
  if (cmd !== cmds[0] || cmds.some((other) => other !== cmd && other.segment === 0)) refuse(`On a line that holds ${why}, a cd may only come first, on its own: cd <folder> && <command>.`);
  if (cmd.words.length !== 2 || cmd.redirs.length) refuse('Write the cd as cd <folder>, with the folder written out.');
  const dir = resolve(line.start ?? '/', expandWord(target));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) refuse(`${target.value} is not a folder here, so the gate cannot tell where the rest runs.`);
}

// The options whose value is text, never a path: a commit message or a pull request body.
const TEXT_OPTIONS = new Set(['-m', '--message', '-b', '--body', '-t', '--title', '--subject', '-c', '--comment', '--notes']);
// Commands that only record the files they name, never write them: committing .gitmodules is fine.
const RECORDS_ONLY = { git: ['add', 'commit'], jj: ['commit', 'ci', 'describe', 'desc', 'file track', 'file untrack'] };

// A tool command that changes something may not name a control file as an argument: gh release
// download -O .git/config, git archive -o .git/config, jj workspace add .git/hooks.
function toolWrites(cmd, info) {
  const words = info.words.slice(1);
  const subcommand = words.filter((word) => !word.value.startsWith('-')).map((word) => word.value);
  if ((RECORDS_ONLY[info.tool] ?? []).some((name) => name === subcommand[0] || name === subcommand.slice(0, 2).join(' '))) return;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.literal) continue;
    if (TEXT_OPTIONS.has(word.value)) { i++; continue; }
    if (/^(--message|--body|--title|--subject|--comment|--notes)=/.test(word.value) || /^-m./.test(word.value)) continue;
    for (const value of pathCandidates(word.value)) {
      const reason = controlPath(expandWord({ ...word, value }), cmd.cwd);
      if (reason) refuse(`\`${label(cmd)}\` names ${reason}, which steers git, jj or the gate. The user changes those files.`);
    }
  }
}

const SEPARATOR_NAMES = { ';': 'a ;', '\n': 'a second line', '||': 'a ||', '&': 'a background &', '(': 'a subshell', ')': 'a subshell', ';;': 'a case' };

// The plain form a gated line must have, and its one action checked.
function gatedLine(items, cmds, infos, line, why) {
  const bad = items.find((item) => item.op && !['&&', '|', '|&'].includes(item.op));
  if (bad) refuse(`It holds ${why}, joined to other commands by ${SEPARATOR_NAMES[bad.op] ?? bad.op}. The gate reads such a line only as commands joined by &&: run it that way, or run each command on its own.`);
  const sorted = infos.map((info) => {
    const { cmd } = info;
    const reserved = cmd.words.find((word) => word.reserved);
    if (reserved) refuse(`\`${label(cmd)}\` uses shell syntax (${reserved.value}) on a line that holds ${why}. Run the commands one at a time.`);
    if (cmd.assigns.length) refuse(`\`${label(cmd)}\` sets ${cmd.assigns.map((word) => word.value.split('=')[0]).join(', ')} for the command, which can change what it reads or runs. Run it without the variable.`);
    const dynamic = cmd.words.find((word) => !word.literal);
    if (dynamic) refuse(`\`${label(cmd)}\` has a word built at run time (${dynamic.raw}) on a line that holds ${why}. Write every word out.`);
    if (cmd.stage > 0 && !(SINKS.has(info.name) && cmd.words === info.words && !info.tool)) refuse(`It pipes into \`${label(cmd)}\`. On a line that holds ${why}, a pipe may lead only into ${[...SINKS].join(', ')}.`);
    if (cmd.stage > 0 && info.name === 'uniq' && cmd.words.filter((word) => !word.value.startsWith('-')).length > 2) refuse(`\`${label(cmd)}\` writes a file. Redirect its output instead.`);
    const sinkProblem = cmd.stage > 0 ? readOptionProblem(info.name, cmd.words) : null;
    if (sinkProblem) refuse(`It pipes into \`${label(cmd)}\`, with an option the gate does not read (${sinkProblem}). After a pipe, ${info.name} runs only with options from its list${someOptions(READ_OPTIONS[info.name])}, spelled out in full.`);
    if (info.name === 'cd' && cmd.words === info.words) checkCd(cmd, cmds, line, why);
    const result = cmd.stage > 0 ? { cls: 'read' } : classify(info, line);
    const exact = ['action', 'pin', 'cd'].includes(result.cls) || Boolean(info.tool);
    const loose = cmd.words.find((word) => word.glob || word.brace);
    if (exact && loose) refuse(`\`${label(cmd)}\` has a pattern the shell expands (${loose.raw}). Quote it, or write each name out.`);
    for (const redir of cmd.redirs) {
      if (!redir.target.literal) refuse(`\`${label(cmd)}\` redirects to a target built at run time (${redir.target.raw}). Write it out.`);
      if (redir.body !== undefined && !redir.bodyLiteral) refuse(`\`${label(cmd)}\` has a heredoc the shell expands. Quote its delimiter (<<'EOF'), or run it on its own.`);
      if (['<', '<<', '<<-', '<<<', '<>'].includes(redir.op) && (exact || result.cls === 'local')) refuse(`\`${label(cmd)}\` reads its input from a redirection, which the gate cannot see. Pass every value as an argument.`);
    }
    if (result.cls === 'pin') {
      // A bookmark set whose failure a pipe hides would leave the push acting on the old target, so it
      // is a whole && segment of its own.
      if (cmds.some((other) => other !== cmd && other.segment === cmd.segment)) refuse(`\`${label(cmd)}\` is piped. A bookmark set before a push must stand alone between &&, so its failure stops the push: jj bookmark set <name> -r <id> && jj git push -b <name>.`);
      line.pins.push({ dir: result.dir ?? cmd.cwd, names: result.names, rev: result.rev, label: label(cmd) });
    }
    if (info.tool && result.cls !== 'read') toolWrites(cmd, info);
    return { info, cmd, ...result };
  });
  const actions = sorted.filter((entry) => entry.cls === 'action');
  if (actions.length > 1) refuse(`It holds more than one push, deploy, merge, dispatch or API write (${actions.map((entry) => `\`${label(entry.cmd)}\``).join(', ')}). Run each on its own line.`);
  if (!actions.length) return { problems: [] };
  const [action] = actions;
  const last = Math.max(...cmds.map((cmd) => cmd.segment));
  if (action.cmd.segment !== last || action.cmd.stage !== 0) refuse(`\`${label(action.cmd)}\` must come last on its line, after only reads, a leading cd and bookmark sets.`);
  const before = sorted.find((entry) => entry.cmd.segment < action.cmd.segment && !['cd', 'read', 'pin'].includes(entry.cls));
  if (before) refuse(`\`${label(before.cmd)}\` runs before \`${label(action.cmd)}\` and can change what it acts on, and the gate checks the repository as it is now. Run it on its own first.`);
  const pin = sorted.find((entry) => entry.cls === 'pin');
  if (pin && !['jj push', 'the deploy'].includes(action.kind)) refuse(`\`${label(pin.cmd)}\` sets a bookmark before \`${label(action.cmd)}\`, which reads the remote, not the bookmark. Run it on its own first.`);
  return { label: label(action.cmd), problems: action.check() ?? [] };
}

function blockMessage(text, problems) {
  return [`Pipeline gate blocked \`${String(text).slice(0, 100)}\`.`, ...problems.map((problem) => `  - ${problem}`), `Process: ${PROCESS_DOC}`].join('\n');
}

// Edit, Write, MultiEdit and NotebookEdit may not touch the files that steer git, jj or the gate.
function editGate(payload) {
  const input = payload.tool_input ?? {};
  for (const path of [input.file_path, input.notebook_path, input.path].filter(Boolean)) {
    const reason = controlPath(path, payload.cwd);
    if (reason) return blockMessage(`${payload.tool_name} ${path}`, [`It edits ${reason}, which can change what later commands do or turn the gate off. The user changes those files.`]);
  }
  return null;
}

// Why a PowerShell line may run a deploy script, or null. Each word that names a file is checked
// against the registered deploy scripts, by real path and content, and against the folder's deploy
// pattern. While deploy scripts are registered, a form that runs something the gate cannot name
// (the call operator on a value, Invoke-Expression, Start-Process, a script block) is refused.
function powerShellDeploy(text, start) {
  const reg = registry();
  if (reg.error) return `${reg.error} The gate cannot tell whether this PowerShell line runs a deploy script.`;
  const words = text.split(/[\s;|&(){},]+/).map((word) => word.replace(/^["'`]+|["'`]+$/g, '').replace(/\\/g, '/')).filter(Boolean);
  for (const word of words) {
    // A bare word runs what PATH finds for it, as PowerShell would after its own commands.
    const file = word.startsWith('-') ? null : programFile(word, start);
    const viaPath = file ? deployScriptEntries(file, reg.entries).length > 0 : false;
    if (viaPath || scriptFile({ value: word, literal: true, tilde: word.startsWith('~') }, start, reg)) return `It runs or names ${word}, a registered deploy script, through PowerShell, which the gate does not read. Run the deploy through the Bash tool, as deploy.command does.`;
  }
  const local = localEntry(start, reg);
  const known = local ? patternOf(local) : {};
  if (known.why) return `${known.why[0].toUpperCase()}${known.why.slice(1)}, so the gate cannot tell whether this PowerShell line runs the deploy command. Fix the file first.`;
  if (known.pattern?.test(text.replace(/["'`]/g, ''))) return 'It matches the deploy command (deploy.match), and the gate does not read PowerShell. Run the deploy through the Bash tool.';
  const scripts = reg.entries.some((entry) => (entry.deployScripts ?? []).length);
  // The gate does not parse PowerShell's quoting. While deploy scripts are registered, a line that
  // runs a program by the call operator or dot-sourcing, starts a statement with a quoted path, or
  // holds a quoted string or an escape the whitespace split cannot keep whole, is refused.
  if (scripts) {
    const statement = /(?:^|[;|\n({}]|&&|\|\|)\s*/.source;
    if (new RegExp(`(?:^|[\\s;|({}])&(?!&)`).test(text)) return "It uses PowerShell's call operator (&), and while deploy scripts are registered the gate does not resolve what that runs. Run it through the Bash tool.";
    if (new RegExp(`${statement}\\.\\s`).test(text)) return 'It dot-sources a script, and while deploy scripts are registered the gate does not resolve what that runs. Run it through the Bash tool.';
    if (new RegExp(`${statement}["']`).test(text)) return 'It starts a statement with a quoted path, and while deploy scripts are registered the gate does not resolve what that runs. Run it through the Bash tool.';
    if (/`|"[^"]*\s[^"]*"|'[^']*\s[^']*'/.test(text)) return 'It holds a quoted string with a space, or an escape, which the gate cannot split into words for certain while deploy scripts are registered. Run it through the Bash tool.';
  }
  if (scripts && /(^|[\s;|(])&\s*[$({]|\binvoke-(expression|command|item)\b|\biex\b|\bstart-process\b|\bsaps\b|\bstart-job\b|\[scriptblock\]|\bpowershell(\.exe)?\b|\bpwsh\b|\bcmd(\.exe)?\s+\/c\b/i.test(text)) return 'It runs a command PowerShell builds or starts on its own, so the gate cannot tell whether it is a registered deploy script. Run it through the Bash tool, written out in full.';
  return null;
}

// A script handed to a shell runs as its own line, which the gate does not check as a gated line: one
// that would be gated is refused, so the command runs directly where the gate reads it.
function shellScriptsGated(cmds, reg, depth) {
  for (const cmd of cmds) {
    for (const script of shellScripts(cmd, cmds)) {
      const inner = scriptCommands(script, cmd, depth);
      const why = gatedBy(inner.map((each) => describe(each, reg)), reg, script);
      const shell = foldedName(unwrapAll(cmd).words[0]?.value ?? 'sh');
      if (why) refuse(`\`${label(cmd)}\` runs ${why} through ${shell}, which the gate does not read. Run it directly, written out in full.`);
      shellScriptsGated(inner, reg, depth + 1);
    }
  }
}

function gate(payload) {
  if (EDIT_TOOLS.has(payload.tool_name)) return editGate(payload);
  const command = payloadCommand(payload);
  if (!command) return null;
  const { text } = command;
  const start = payload.cwd ?? process.cwd();
  const named = () => mentionsTool(text) || /deploy/i.test(text);
  // PowerShell has its own quoting and expansion, so the gate does not try to read it.
  if (payload.tool_name === 'PowerShell') {
    if (named()) return blockMessage(text, ['It names jj, git, gh, agent-review or a deploy, and the gate does not read PowerShell. Run it through the Bash tool.']);
    const why = powerShellDeploy(text, start);
    return why ? blockMessage(text, [why]) : null;
  }
  const read = readLine(text);
  // A shell may run the part before the mistake, so a line the gate cannot read is refused whatever
  // it names: its writes and the scripts it runs are unknown.
  if (read.error) return blockMessage(text, [`The gate cannot read this line (${read.error}), so it cannot tell what it runs or writes. Write it as plain commands joined by &&.`]);
  const items = [...read.items];
  while (items.length && items.at(-1).op === '\n') items.pop();
  const cmds = placeCommands(items, start);
  try {
    everyLine(cmds);
    const reg = registry();
    shellScriptsGated(cmds, reg, 0);
    const infos = cmds.map((cmd) => describe(cmd, reg));
    const why = gatedBy(infos, reg, text);
    if (!why) return null;
    if (reg.error) refuse(reg.error);
    const result = gatedLine(items, cmds, infos, new Line(reg, start), why);
    return result.problems.length ? blockMessage(result.label, result.problems) : null;
  } catch (error) {
    if (error instanceof Refusal) return blockMessage(text, [error.message]);
    throw error;
  }
}

// The gate's answer: null to allow, or the reason to refuse. A failure inside it refuses too, since
// letting a push or deploy through unchecked is worse than asking the agent to retry.
export function gateMessage(payload) {
  try {
    return gate(payload);
  } catch (error) {
    const why = error instanceof DeadlineError ? `The gate ran out of time (${error.message}), so it refuses rather than let the command run unchecked.` : `The gate could not check it: ${error.message}`;
    return blockMessage(payloadCommand(payload)?.text ?? payload.tool_name ?? 'this command', [why, 'Nothing ran. Fix the cause, or run the command on its own, written out in full.']);
  }
}
