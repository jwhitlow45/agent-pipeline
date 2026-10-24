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
import { readLine, substitutions } from './line.mjs';
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
const READ_ONLY = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'sort', 'cut', 'tr', 'uniq', 'column', 'jq', 'echo', 'printf', 'true', 'false', 'test', '[', 'date', 'which', 'file', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink', 'diff', 'cmp', 'comm', 'sleep', 'nl', 'od', 'xxd', 'shasum', 'sha256sum', 'md5', 'md5sum', 'tree', 'whoami', 'uname', 'man', 'tee', 'type', 'whence', 'where', 'hash']);
const readOptionProblem = (name, words) => optionProblem(READ_OPTIONS[name], words.slice(1).map((word) => word.value));
// What a pipe may lead into on a gated line.
const SINKS = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'sort', 'cut', 'tr', 'cat', 'tee', 'jq', 'column', 'uniq', 'nl']);
// Commands that only read the files they name, so naming a control file is fine.
const CONTROL_READERS = new Set([...READ_ONLY, 'less', 'more', 'bat', 'rg', 'strings', 'hexdump'].filter((name) => name !== 'tee'));
// Programs that run another command. A word built at run time in the place of that command means
// the gate cannot see what runs.
const RUNNERS = new Set(['env', 'sudo', 'doas', 'nohup', 'nice', 'ionice', 'xargs', 'timeout', 'gtimeout', 'exec', 'command', 'builtin', 'caffeinate', 'stdbuf', 'unbuffer', 'script', 'watch', 'flock', 'parallel', 'setsid', 'chroot', 'npx', 'bunx', 'pnpx', 'uvx', 'chronic', 'time', 'arch', 'sandbox-exec', 'taskpolicy', 'xcrun', 'noglob', 'nocorrect', '-']);
// How each runner reads its own words before the command it runs. Short options in flags take no
// value, those in values take one (attached or the next word), and those in optional take the rest of
// their word if any. Long options are matched exactly, so a prefix is unknown. lead counts the words
// before the command (timeout's duration, flock's lock file). refuse holds options that run a string,
// change the folder, the search path or the root, and query those that run no command. An option on
// no list is unknown: the gate cannot tell which word is the command, so it refuses. joined marks a
// runner that hands its words to sh as one line, indirect one that adds arguments from stdin or a
// file, and package one that runs a program its own lookup finds (a package's, or a developer
// tool's), not PATH: the gate reads that command by its name only. exact and exactValues hold
// options spelled as whole words (arch -x86_64, xcrun -sdk name).
const RUNNER_SPECS = {
  env: { flags: 'iv0', values: 'u', refuse: 'SCP', long: ['--ignore-environment', '--null', '--debug'], longValues: ['--unset'], refuseLong: ['--split-string', '--chdir'], assigns: true },
  sudo: { flags: 'AbEHknPS', values: 'CgprTtUu', refuse: 'DRiseh', query: 'lKVv', long: ['--askpass', '--background', '--preserve-env', '--set-home', '--non-interactive', '--preserve-groups', '--stdin', '--reset-timestamp'], longValues: ['--close-from', '--group', '--prompt', '--role', '--command-timeout', '--type', '--other-user', '--user'], longOptional: ['--preserve-env'], refuseLong: ['--chdir', '--chroot', '--login', '--shell', '--edit', '--host'], queryLong: ['--list', '--validate', '--version', '--help', '--remove-timestamp'] },
  doas: { flags: 'nL', values: 'u', refuse: 'sC' },
  nohup: {},
  nice: { values: 'n', numeric: true, longValues: ['--adjustment'] },
  ionice: { flags: 't', values: 'cn', query: 'p' },
  xargs: { flags: '0oprtx', values: 'aEdILnPsJRS', optional: 'eil', replaceLetters: 'IJi', indirect: true, long: ['--null', '--no-run-if-empty', '--open-tty', '--interactive', '--verbose', '--exit'], longValues: ['--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'], longOptional: ['--replace', '--eof', '--max-lines'] },
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
  arch: { exact: ['-arm64', '-arm64e', '-x86_64', '-x86_64h', '-i386', '-32', '-64', '-c', '-h'], exactValues: ['-arch', '-d', '-e'], assignValue: '-e', unsetValue: '-d' },
  'sandbox-exec': { values: 'fpnD' },
  taskpolicy: { flags: 'baBs', values: 'dgctlSmj', query: 'p' },
  xcrun: { package: true, exact: ['-r', '--run', '-l', '--log', '-n', '--no-cache', '-v', '--verbose'], exactValues: ['-sdk', '--sdk', '-toolchain', '--toolchain'], query: 'fkh', queryLong: ['--find', '--kill-cache', '--show-sdk-path', '--show-sdk-version', '--show-sdk-build-version', '--show-sdk-platform-path', '--show-sdk-platform-version', '--version', '--help'] },
  noglob: {},
  nocorrect: {},
  '-': {},
  time: { flags: 'ahlpv', values: 'fo' },
};
// The search path a shell uses when PATH is cleared (env -i) or set to the default (command -p).
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
// Builtins command, builtin and time can run, which PATH does not hold.
const SHELL_BUILTINS = new Set(['cd', 'echo', 'printf', 'test', '[', 'true', 'false', 'pwd', 'read', 'type', 'export', 'unset', 'set', 'shift', 'alias', 'unalias', 'hash', 'kill', 'wait', 'jobs', 'fg', 'bg', 'umask', 'ulimit', 'getopts', 'local', 'return', 'exit', 'declare', 'typeset', 'readonly', 'let', 'shopt', 'history', 'dirs', 'pushd', 'popd', 'times', 'whence', 'where', 'which', ':']);
const EVALUATORS = new Set(['eval', 'source', '.', 'trap']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A command name for the lists that refuse or gate (runners, shells, tools): case-folded, since another
// case runs the same program on macOS. The lists that allow (reads, sinks, data) match it exactly.
const foldedName = (value) => basename(String(value)).toLowerCase();

const label = (cmd) => [...(cmd.leads ?? []), ...(cmd.header ?? []), ...cmd.words].map((word) => word.raw).join(' ').slice(0, 100);
// A word with a leading ~ filled in from HOME as the line has it, or null when that is unknown or
// the word names another user's home.
const expandWord = (word, env = { home: HOME }) => {
  if (!word.tilde) return word.value;
  if (!/^~(?=$|\/)/.test(word.value) || env.home === null) return null;
  return word.value.replace(/^~/, env.home);
};

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

// The shell's own commands, in bash or zsh. They are not files: PATH is not searched for them, and a
// file of the same name does not run in their place.
const BUILTINS = new Set([...SHELL_BUILTINS, ...EVALUATORS, 'exec', 'command', 'builtin', 'time', 'noglob', 'nocorrect', '-', 'print', 'setopt', 'unsetopt', 'emulate', 'autoload', 'functions', 'rehash', 'enable', 'disable', 'zmodload', 'break', 'continue', 'disown', 'caller', 'compgen', 'complete', 'mapfile', 'readarray', 'bind', 'fc', 'vared', 'integer', 'float', 'zparseopts', 'logout', 'suspend', 'chdir']);
// Runners that run their command in the same shell, so a builtin stays a builtin and a cd or a PATH
// set through them changes the shell. Every other runner is a program that starts a new process.
const SAME_SHELL = new Set(['command', 'builtin', 'time', 'noglob', 'nocorrect', '-']);
// Builtins after which an assignment written before them stays set in a POSIX shell.
const SPECIAL_BUILTINS = new Set(['break', ':', '.', 'continue', 'eval', 'exec', 'exit', 'export', 'readonly', 'return', 'set', 'shift', 'times', 'trap', 'unset']);
const HTTP = new Set(['curl', 'wget']);
const GATED_PROGRAM = (name) => TOOLS.has(name) || name === 'pipeline' || HTTP.has(name);
// The names a resolved file counts as for the lists that inspect or refuse a command.
const KNOWN_PROGRAM = (name) => RUNNERS.has(name) || GATED_PROGRAM(name) || name === 'find' || SHELL_NAMES.has(name) || INTERPRETERS.test(name);

// Where a command word is found, the way the shell finds it: a builtin, a function or alias the
// shell defines (functions, given where its lookup reaches them), the file a path names, or the
// first executable file on PATH. A function is kept apart from a builtin, since only the shell's
// own builtins are trusted as reads. A word the gate cannot place for certain has a reason (why),
// and one the shell would not find is missing.
function resolveProgram(word, env, { builtins = true, functions = null } = {}) {
  const { value } = word;
  if (builtins && !value.includes('/') && BUILTINS.has(value)) return { builtin: true, files: [] };
  if (functions?.has(value) && !value.includes('/')) return { function: true, files: [] };
  const path = expandWord(word, env);
  if (path === null) return { files: [], why: word.value.startsWith('~/') || word.value === '~' ? 'from ~ after the line changes HOME' : `from another user's home (${value.split('/')[0]})` };
  if (path.includes('/')) {
    if (!isAbsolute(path) && env.cwd === null) return { files: [], why: 'by a relative path after a cd the gate cannot follow' };
    try {
      return { files: [realpathSync.native(resolve(env.cwd ?? '/', path))] };
    } catch {
      return { files: [], missing: true };
    }
  }
  if (env.pathUnknown) return { files: [], why: 'after PATH is set to a value built at run time' };
  const files = programFiles(value, env.cwd, env.paths);
  return files.length ? { files } : { files: [], missing: true };
}

// What a command word is: the name the inspecting lists read (the resolved file's, when the gate
// knows that program, so a link named fetcher to curl is curl, or else the written name), and the
// files it may be. A word the gate cannot place refuses. One the shell would not find refuses only
// when strict: under a runner, in a nested script or on a gated line. As a bare top-level word it
// may be a function or alias from the user's own shell. functions is true where the shell's own
// lookup picks the word, which finds the functions defined in that shell.
function identify(word, env, cmd, { strict = false, builtins = true, functions = false } = {}) {
  const written = foldedName(word.value);
  const found = resolveProgram(word, env, { builtins, functions: functions ? cmd.line?.defined : null });
  if (found.why) refuse(`\`${label(cmd)}\` runs ${word.value} ${found.why}, so the gate cannot tell which program that is. Write the program's full path, or set PATH to a literal value.`);
  if (strict && found.missing) refuse(`\`${label(cmd)}\` runs ${word.value}, and the gate cannot find ${word.value}, so it cannot tell what runs. Write its full path.`);
  const known = [...new Set(found.files.map((file) => foldedName(file)).filter(KNOWN_PROGRAM))];
  if (known.length > 1) refuse(`\`${label(cmd)}\` may run ${known.join(' or ')} as ${word.value}, depending on the PATH the line sets, so the gate cannot tell which. Write its full path.`);
  return { name: known[0] ?? written, written, files: found.files, builtin: Boolean(found.builtin), function: Boolean(found.function), missing: Boolean(found.missing) };
}

// The gated program a command word runs, by its identity, or null.
function toolOf(word, env, cmd) {
  if (!word?.literal) return null;
  const { name } = identify(word, env, cmd);
  return GATED_PROGRAM(name) ? name : null;
}

// A runner's own words, read by its spec: the index of the command it runs, the options it was
// given, the variables env sets, the strings xargs fills in, and a problem when an option is unknown
// or one the gate refuses.
function runnerWords(words, spec) {
  const used = new Set();
  const unset = [];
  const assigns = [];
  const replace = [];
  let i = 1;
  const done = (extra) => ({ index: i, used, unset, assigns, replace, ...extra });
  while (i < words.length) {
    const value = words[i].value;
    if (value === '--') {
      i++;
      // env keeps taking assignments after --, before the command.
      while (spec.assigns && i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value)) assigns.push(words[i++]);
      break;
    }
    if (spec.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) { assigns.push(words[i]); i++; continue; }
    if ((spec.exact ?? []).includes(value)) { used.add(value); i++; continue; }
    if ((spec.exactValues ?? []).includes(value)) {
      used.add(value);
      if (value === spec.assignValue && words[i + 1]) assigns.push(words[i + 1]);
      if (value === spec.unsetValue) unset.push(words[i + 1]?.value);
      i += 2;
      continue;
    }
    if (spec.assigns && value === '-') { used.add('-i'); i++; continue; }
    if (value.startsWith('--')) {
      const option = value.split('=')[0];
      const attached = value.includes('=');
      if ((spec.refuseLong ?? []).includes(option)) return done({ problem: option });
      if ((spec.queryLong ?? []).includes(option)) return done({ query: true });
      if ((spec.longOptional ?? []).includes(option) || ((spec.long ?? []).includes(option) && !attached)) {
        if (option === '--replace') replace.push(attached ? value.slice(option.length + 1) : '{}');
        used.add(option);
        i++;
        continue;
      }
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
        if ((spec.optional ?? '').includes(letter)) {
          if ((spec.replaceLetters ?? '').includes(letter)) replace.push(value.slice(k + 1) || '{}');
          break;
        }
        if ((spec.values ?? '').includes(letter)) {
          const attachedValue = value.slice(k + 1);
          if (letter === 'u') unset.push(attachedValue || words[i + 1]?.value);
          if ((spec.replaceLetters ?? '').includes(letter)) replace.push(attachedValue || words[i + 1]?.value);
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

// A word with $HOME, $PATH and $PWD filled in from the state of the shell that expands it, or null
// when anything else in it is built at run time or a value is unknown. Each value must stay the one
// argument it is written as. Outside double quotes the shell splits a value on IFS and matches it
// against files, so there it may hold no space or pattern character, and the shell may not set IFS.
const SHELL_VALUE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/;
function knownWord(word, state, line) {
  if (word.literal) return word;
  const values = { HOME: state.home, PWD: state.cwd, PATH: !state.pathUnknown && state.paths.length === 1 ? state.paths[0] : null };
  const { raw } = word;
  let value = '';
  let double = false;
  for (let k = 0; k < raw.length;) {
    const ch = raw[k];
    if (ch === '"') {
      double = !double;
      k++;
    } else if (ch === "'" && !double) {
      const end = raw.indexOf("'", k + 1);
      value += raw.slice(k + 1, end);
      k = end + 1;
    } else if (ch === '\\') {
      // Inside double quotes a backslash escapes only $, `, ", \ and a newline.
      if (raw[k + 1] !== '\n') value += (double && !'$`"\\'.includes(raw[k + 1]) ? '\\' : '') + (raw[k + 1] ?? '');
      k += 2;
    } else if (ch === '$') {
      const match = SHELL_VALUE.exec(raw.slice(k));
      const name = match?.[1] ?? match?.[2];
      const filled = name && Object.hasOwn(values, name) ? values[name] : null;
      if (filled === null || (!double && (filled === '' || line?.ifs || /[\s*?[\]]/.test(filled)))) return null;
      value += filled;
      k += match[0].length;
    } else if (ch === '`' || (!double && /[*?[{~]/.test(ch))) return null;
    else {
      value += ch;
      k++;
    }
  }
  return { ...word, value, literal: true, tilde: false };
}

// The text of a word the shell passes on byte for byte: single-quoted, double-quoted with no $,
// backtick or backslash, or plain characters the shell does not read again. Null for any other word.
const EXACT = /^(?:'[^']*'|"[^"$`\\]*"|[A-Za-z0-9_@%+=:,./-])+$/;
const exactText = (word) => (word.literal && !word.tilde && EXACT.test(word.raw) ? word.value : null);

// Variables a shell reads as code, or as a place to load code from: prompts it expands (PS4 runs on
// every traced command), startup files, function paths and exported functions.
const CODE_VARIABLES = /^(PS[0-4]|PROMPT[0-9]?|RPROMPT[0-9]?|RPS[12]|SPROMPT|PROMPT_COMMAND|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|FPATH|fpath|BASH_LOADABLES_PATH|BASH_FUNC_.*|[a-z]+_functions)$/;
const PROMPTS = /^(PS[0-4]|PROMPT[0-9]?|RPROMPT[0-9]?|RPS[12]|SPROMPT)$/;

// What an assignment changes in the state the gate tracks: PATH (and zsh's path array), HOME,
// CDPATH and OLDPWD. A variable the shell runs as code is refused, unless it is a prompt with
// nothing in it the shell expands.
function applyAssign(state, word, cmd) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/.exec(word.value);
  if (!match) return;
  const [whole, name, op] = match;
  const value = word.value.slice(whole.length);
  if (CODE_VARIABLES.test(name) && !(PROMPTS.test(name) && word.literal && !word.array && !/[$`\\]/.test(value))) {
    refuse(`\`${label(cmd)}\` sets ${name}, which the shell reads as code or loads code from, so the gate cannot tell what runs. Run the command without it.`);
  }
  if (name === 'PATH' || name === 'path') {
    const usesPath = op === '+=' || /\$\{?PATH\b/.test(value);
    const next = name === 'PATH' && !word.array && !(usesPath && state.pathUnknown) ? pathValues(word, state.paths, state.cwd) : null;
    if (next) {
      state.paths = next;
      state.pathUnknown = false;
    } else state.pathUnknown = true;
  }
  if (name === 'HOME') state.home = word.literal && op === '=' && !word.array ? value : null;
  if (name === 'CDPATH' || name === 'cdpath') state.cdpath = true;
  if (name === 'OLDPWD') state.oldpwd = null;
  if (name === 'EXECIGNORE') state.pathUnknown = true;
}

// The environment a runner gives its command: env and arch can clear it and set PATH or HOME,
// command -p uses the default search path, and sudo and doas use a search path set by their own
// configuration, which the gate cannot read.
function runnerEnv(name, parsed, env, cmd) {
  const next = { ...env };
  if (name === 'env' || name === 'arch') {
    if (parsed.used.has('-i') || parsed.used.has('--ignore-environment') || (name === 'arch' && parsed.used.has('-c'))) Object.assign(next, { paths: [DEFAULT_PATH], pathUnknown: false, home: null });
    if (parsed.unset.includes('PATH')) Object.assign(next, { paths: [DEFAULT_PATH], pathUnknown: false });
    if (parsed.unset.includes('HOME')) next.home = null;
    for (const assign of parsed.assigns) applyAssign(next, assign, cmd);
  }
  if (name === 'command' && parsed.used.has('-p')) Object.assign(next, { paths: [DEFAULT_PATH], pathUnknown: false });
  if (name === 'sudo' || name === 'doas') Object.assign(next, { pathUnknown: true, home: null });
  return next;
}

// What a command runs once every runner around it is taken off: its words, the runners, the
// environment it runs in and its identity. A runner the gate cannot read refuses, as does one whose
// command it cannot find, and a chain longer than the gate reads. watch hands its words to sh as one
// line, so its command comes back as a script.
const RUNNER_LIMIT = 8;
function unwrapAll(cmd) {
  if (cmd.run) return cmd.run;
  let words = cmd.words;
  let env = cmd.env;
  const runners = [];
  const replace = [...(cmd.replace ?? [])];
  let indirect = false;
  let packaged = false;
  let sameShell = true;
  // command and builtin skip the shell's functions when they look up their command.
  let functions = true;
  let id = null;
  let headId = null;
  const finish = (extra) => (cmd.run = { words, runners, env, indirect, packaged, sameShell, replace, id, headId, query: false, script: null, ...extra });
  while (words.length) {
    const head = words[0];
    if (!head.literal) refuse(`\`${label(cmd)}\` runs a command built at run time (${head.raw}). Write the command out, so the gate can see what runs.`);
    const filled = replace.find((text) => head.value.includes(text));
    if (filled) refuse(`\`${label(cmd)}\` runs a program named by ${filled}, which is filled in at run time, so the gate cannot tell what runs. Write the program out.`);
    const written = foldedName(head.value);
    id = packaged ? { name: written, written, files: [], builtin: false, missing: false } : identify(head, env, cmd, { strict: cmd.strict || runners.length > 0, builtins: sameShell, functions: sameShell && functions });
    headId ??= id;
    if (!RUNNERS.has(id.name)) break;
    const { name } = id;
    if (runners.length === RUNNER_LIMIT) refuse(`\`${label(cmd)}\` wraps its command in more than ${RUNNER_LIMIT} runners, which the gate does not read. Run the command directly.`);
    const spec = RUNNER_SPECS[name] ?? {};
    if (spec.refuseAll) refuse(`\`${label(cmd)}\` uses ${name}, which ${spec.refuseAll}, so the gate cannot tell what runs. Run the command on its own.`);
    let parsed = runnerWords(words, spec);
    // The shell expands env's own words before env clears, unsets or sets anything, so a variable the
    // shell's state holds is read as its value there.
    if (spec.assigns && !parsed.problem && !parsed.query) {
      const own = words.slice(1, parsed.index).map((word) => knownWord(word, cmd.shellEnv ?? cmd.env, cmd.line) ?? word);
      if (own.some((word, k) => word !== words[k + 1])) {
        const expanded = [words[0], ...own, ...words.slice(parsed.index)];
        const again = runnerWords(expanded, spec);
        if (again.index === parsed.index && !again.problem && !again.query) [words, parsed] = [expanded, again];
      }
    }
    if (parsed.problem) refuse(`\`${label(cmd)}\` gives ${name} ${parsed.problem}, so the gate cannot tell which command ${name} runs. Run the command without ${name}, or without that option.`);
    const built = words.slice(1, parsed.index).find((word) => !word.literal);
    if (built) refuse(`\`${label(cmd)}\` runs a command built at run time (${built.raw}). Write the command out, so the gate can see what runs.`);
    // Messages name a runner as written: timeout, even where it is a link to gtimeout.
    runners.push(RUNNERS.has(id.written) ? id.written : name);
    if (!(SAME_SHELL.has(name) && id.builtin)) sameShell = false;
    if (name === 'command' || name === 'builtin') functions = false;
    if (parsed.query) {
      words = [];
      return finish({ query: true });
    }
    env = runnerEnv(name, parsed, env, cmd);
    if (spec.indirect) indirect = true;
    if (spec.package) packaged = true;
    replace.push(...parsed.replace.filter(Boolean));
    const rest = words.slice(parsed.index);
    if (spec.joined && !parsed.used.has('-x') && !parsed.used.has('--exec')) {
      const texts = rest.map(exactText);
      if (texts.includes(null)) refuse(`\`${label(cmd)}\` hands its command to sh as one line, and a word in it is not written out exactly, so the gate cannot tell what runs. Put the command in single quotes.`);
      words = [];
      return finish({ script: { text: texts.join(' '), via: name } });
    }
    words = rest;
  }
  return finish({});
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

const hasDeployScripts = (reg) => reg.entries.some((entry) => (entry.deployScripts ?? []).length);

// The files a script argument may name, looked up apart from command words: the file in the
// command's folder and, for bash, a file of that name on PATH, which bash reads when the folder has
// none. Null when the folder is unknown.
function scriptFiles(word, env, { viaPath = false } = {}) {
  const value = expandWord(word, env);
  if (value === null || (!isAbsolute(value) && env.cwd === null)) return null;
  const files = [];
  try {
    files.push(realpathSync(resolve(env.cwd ?? '/', value)));
  } catch {
    // Not in the folder.
  }
  if (viaPath && !value.includes('/') && !env.pathUnknown) {
    for (const path of env.paths) {
      for (const entry of path.split(delimiter)) {
        const dir = entry === '' ? '.' : expandHome(entry);
        try {
          const candidate = resolve(env.cwd ?? '/', dir, value);
          if (statSync(candidate).isFile()) files.push(realpathSync(candidate));
        } catch {
          // Not in this entry.
        }
      }
    }
  }
  return files;
}

// Whether a command runs a registered deploy script: the script as its program, or after an
// interpreter. It is bound to the one repository whose script it is, by real path or content.
// Within that repository's own folders, a command matching its deploy.match counts too.
function deployOf(words, env, reg, cmd) {
  const head = words[0];
  if (!head?.literal) return null;
  const id = identify(head, env, cmd);
  const interpreter = INTERPRETERS.test(id.name) ? id.name : null;
  let scriptIndex = 0;
  if (interpreter && SHELL_SPECS[interpreter]) {
    const read = shellOptions(words, SHELL_SPECS[interpreter]);
    scriptIndex = read.problem || read.command || read.stdin ? -1 : read.operand;
  } else if (interpreter) scriptIndex = words.findIndex((word, i) => i > 0 && !word.value.startsWith('-'));
  if (scriptIndex === -1) return null;
  const script = words[scriptIndex];
  if (!script.literal) return null;
  let files = id.files;
  if (scriptIndex > 0) {
    files = scriptFiles(script, env, { viaPath: ['bash', 'rbash'].includes(interpreter) });
    if (files === null) {
      if (hasDeployScripts(reg)) refuse(`\`${label(cmd)}\` runs the script ${script.value} after a cd the gate cannot follow, so it cannot tell whether that is a deploy script. Write its full path.`);
      files = [];
    }
  }
  const owners = files.flatMap((file) => deployScriptEntries(file, reg.entries));
  const identities = [...new Set(owners.map((entry) => entry.identity))];
  if (identities.length > 1) return { ambiguous: identities, interpreter };
  if (identities.length === 1) return { entry: owners[0], interpreter, argsFrom: scriptIndex + 1 };
  if (/\s/.test(script.value)) return null;
  const local = localEntry(env.cwd, reg);
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

// A builtin, or a program the system ships in its own folders, which macOS keeps read-only, so it is
// not a deploy script and not a file an agent can replace. Anything else PATH finds could be either.
const SYSTEM_FOLDERS = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/usr/libexec/'];
const systemIdentity = (id) => Boolean(id) && (id.builtin || (id.files.length > 0 && id.files.every((file) => SYSTEM_FOLDERS.some((folder) => file.startsWith(folder)))));
const systemProgram = (info) => !runsCode(info) && systemIdentity(info.headId);

// Whether a word names a registered deploy script, by real path or content: the file in the folder
// and, unless the command only prints its words, a file of that name on PATH.
function scriptFile(word, env, reg, { viaPath = false } = {}) {
  if (!reg.entries.length || word.value.startsWith('-')) return false;
  const files = scriptFiles(word, env, { viaPath }) ?? [];
  return files.some((file) => deployScriptEntries(file, reg.entries).length > 0);
}

// What a command is, decided without running anything.
function describe(cmd, reg) {
  if (cmd.info) return cmd.info;
  const words = peel(cmd.words);
  const head = words[0];
  // Every runner is taken off to find what runs. Only the wrappers peel allows may stand before a
  // gated command, so the rest are refused there.
  const run = unwrapAll(cmd);
  const { env } = cmd;
  const info = { cmd, words, name: head ? basename(head.value) : '', tool: null, deploy: null, data: false, inner: run.words, runners: run.runners, indirect: run.indirect, query: run.query, env, headId: null };
  cmd.info = info;
  if (!head) return info;
  info.headId = head.literal ? identify(head, env, cmd, { builtins: words === cmd.words }) : null;
  info.tool = head.literal ? toolOf(head, env, cmd) : null;
  info.innerTool = run.words.length && run.id && GATED_PROGRAM(run.id.name) ? run.id.name : null;
  // A data command's words are data only while it is the shell's own or the system's: a file named
  // echo elsewhere on PATH can do anything with them.
  info.data = DATA.has(info.name) && systemIdentity(info.headId) && words.every((word) => word.literal) && !readOptionProblem(info.name, words);
  info.deploy = deployOf(words, env, reg, cmd);
  // The command a runner runs may be a deploy script by its own lookup: PATH order and the X bit.
  const innerDeploy = run.runners.length && run.words.length && !run.packaged ? deployOf(run.words, run.env, reg, cmd) : null;
  // A deploy script named anywhere in a command, run through a wrapper or passed to another program.
  info.scriptMention = !info.deploy && (Boolean(innerDeploy) || words.some((word, i) => i > 0 && word.literal && scriptFile(word, env, reg, { viaPath: !info.data })));
  // A deploy pattern counts only in its own repository's folders.
  const known = patternOf(localEntry(env.cwd, reg) ?? {});
  // jj, git and gh go through their own checks, which read the config themselves and refuse.
  if (known.why && !plainRead(info) && !TOOLS.has(info.tool)) refuse(`${known.why[0].toUpperCase()}${known.why.slice(1)}, so the gate cannot tell whether this runs the deploy command. Fix the file first.`);
  info.pattern = known.pattern ?? null;
  info.patternMention = Boolean(info.pattern) && !info.data && info.pattern.test(stripped(commandText(cmd)));
  return info;
}

// Every word of a command: its reserved words, header, assignments and words.
const allWords = (cmd) => [...(cmd.leads ?? []), ...(cmd.header ?? []), ...cmd.assigns, ...cmd.words];
// The text of a command a mention counts in: its words, assignments, redirections and heredocs.
const commandText = (cmd) => [...allWords(cmd), ...cmd.redirs.map((redir) => redir.target)].map((word) => word.raw).join(' ') + cmd.redirs.map((redir) => (redir.body ? `\n${redir.body}` : '')).join('');

const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
// A command that runs code from a file: a shell, an interpreter, source or `.`, or a program run by
// its path, such as ./x.sh.
const runsCode = (info) => {
  const head = info.words[0]?.value ?? '';
  const name = info.headId?.name ?? foldedName(head);
  return SHELL_NAMES.has(name) || INTERPRETERS.test(name) || EVALUATORS.has(name) || head.includes('/');
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
    if (HTTP.has(info.tool) && mentionsGithub(commandText(info.cmd))) return `${info.tool} to GitHub`;
    // A gated program behind a runner: classify refuses every runner but the wrappers peel allows.
    // A request whose URLs come from stdin or a file (xargs) may reach GitHub unseen.
    if (TOOLS.has(info.innerTool) || (HTTP.has(info.innerTool) && (mentionsGithub(commandText(info.cmd)) || info.indirect))) return `${info.innerTool} through ${info.runners.join(' ')}`;
    if (!info.data && mentionsTool(commandText(info.cmd))) return 'a jj, git, gh or agent-review mention';
    if (info.patternMention) return 'the deploy command pattern';
    if (info.scriptMention) return 'the deploy script';
    if (info.cmd.words.some((word) => word.literal && word.value.includes('/') && TOOLS.has(foldedName(programFile(word.value, info.cmd.cwd) ?? '')))) return 'a path to jj, git or gh';
  }
  // With the registry unreadable the deploy scripts are unknown, and one can have any name, so every
  // line that runs a program other than plain reads and the system's own is gated.
  if (reg.error && (/deploy/i.test(text) || !infos.every((info) => !info.words.length || plainRead(info) || systemProgram(info)))) return 'a command that may run a deploy script, while the registry cannot be read';
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
// included. These hold on any line, GitHub or not, for the program a command resolves to under
// every runner, so a link named fetcher to curl is curl. wget takes any prefix of a long option, curl
// only the full name.
function httpOptionFiles(cmd, run) {
  const { words, runners, id } = run;
  const name = words.length && id ? id.name : '';
  const texts = words.slice(1).map((word) => word.value);
  const via = runners.length ? ` through ${runners.join(' ')}` : '';
  if (name === 'curl') {
    for (const text of texts) {
      for (const found of text.matchAll(/%output\{(?:>>)?([^}]*)\}/gi)) {
        const reason = controlPath(found[1], cmd.env.cwd);
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

// How each shell reads its own options before its script. Flags take no value, values take the next
// word, and end stops option reading as -- does. Any other option is unknown, so the gate cannot tell
// where the script comes from, and refuses.
const BASH_OPTIONS = { flags: 'abefhkmnptuvxBCEHPTilrD', values: 'oO', long: ['--login', '--noprofile', '--norc', '--posix', '--restricted', '--verbose', '--version', '--help', '--noediting', '--debugger', '--dump-strings', '--dump-po-strings', '--pretty-print', '--debug'], longValues: ['--rcfile', '--init-file'] };
const SHELL_SPECS = {
  sh: BASH_OPTIONS,
  bash: BASH_OPTIONS,
  rbash: BASH_OPTIONS,
  zsh: { flags: 'adefghiklmnprtuvwxyACDEFGHIJKLMNOPQRSTUVWXYZ0123456789', values: 'o', end: 'b', long: ['--login', '--interactive', '--no-rcs', '--no-globalrcs', '--version', '--help'], longValues: ['--emulate'] },
  dash: { flags: 'aCefilmnpuvxEV', values: 'o' },
  ksh: { flags: 'abCefhikmnprtuvxBEGHl', values: 'o' },
  mksh: { flags: 'abCefhikmnprtuvxBEGHl', values: 'oT' },
};
// Shells whose grammar is not sh's, and programs that start a shell as another user or from their
// own copies of programs: the gate reads no script they are handed.
const FOREIGN_SHELLS = new Set(['fish', 'csh', 'tcsh', 'pwsh', 'nu', 'elvish', 'xonsh', 'busybox', 'su', 'runuser']);
const SHELL_NAMES = new Set([...Object.keys(SHELL_SPECS), ...FOREIGN_SHELLS]);

// Where a shell takes its script from, by its options: -c and the first word after the options, a
// file named by that word, or stdin (-s, or no word at all).
function shellOptions(words, spec) {
  let i = 1;
  let command = false;
  let stdin = false;
  while (i < words.length) {
    const word = words[i];
    const { value } = word;
    if (!word.literal) return { problem: `${word.raw}, built at run time,` };
    if (value === '--' || value === '-') { i++; break; }
    if (value.startsWith('--')) {
      if ((spec.long ?? []).includes(value)) { i++; continue; }
      if ((spec.longValues ?? []).includes(value)) { i += 2; continue; }
      return { problem: value };
    }
    if (!/^[-+]./.test(value)) break;
    let take = 0;
    let end = false;
    for (const letter of value.slice(1)) {
      if (letter === 'c' && value[0] === '-') command = true;
      else if (letter === 's' && value[0] === '-') stdin = true;
      else if ((spec.end ?? '').includes(letter)) end = true;
      else if ((spec.values ?? '').includes(letter)) take++;
      else if (!spec.flags.includes(letter)) return { problem: `${value[0]}${letter}` };
    }
    i += 1 + take;
    if (end) break;
  }
  return { command, stdin, operand: i < words.length ? i : -1 };
}

const STDIN_OPS = new Set(['<', '<<', '<<-', '<<<', '<>', '<&']);

// The script a shell reads from stdin, when that is text the gate reads exactly: its own heredoc,
// with a quoted delimiter or nothing the shell expands. A file is a script the gate does not read.
// Anything else (a pipe, a here-string, more than one input, an input set by an earlier exec) is
// text that reaches the shell some other way, and refuses.
function stdinScript(cmd, name) {
  const inputs = cmd.redirs.filter((redir) => STDIN_OPS.has(redir.op) && (redir.fd === '' || redir.fd === '0'));
  if (inputs.length > 1) refuse(`\`${label(cmd)}\` gives ${name} more than one input, and which one it reads as its script depends on the shell. Give it one heredoc with a quoted delimiter.`);
  const [input] = inputs;
  if (!input) {
    if (cmd.stage > 0 || cmd.inside > 0 || cmd.deferred || cmd.inheritsInput) refuse(`\`${label(cmd)}\` reads its script from a pipe, which the gate does not read. Pass the script to ${name} with -c in single quotes, or run the commands directly.`);
    if (cmd.stdinRedirected) refuse(`\`${label(cmd)}\` reads its script from an input an earlier exec set, which the gate does not read. Pass the script to ${name} with -c in single quotes.`);
    return null;
  }
  if (input.op === '<<' || input.op === '<<-') {
    if (!input.bodyLiteral) refuse(`\`${label(cmd)}\` hands ${name} a heredoc the shell expands first, so the gate cannot read the script exactly. Quote its delimiter (<<'EOF').`);
    return input.body ?? '';
  }
  if (input.op === '<<<') refuse(`\`${label(cmd)}\` hands ${name} a script in a here-string, which the gate does not read. Pass it with -c in single quotes, or as a heredoc with a quoted delimiter.`);
  if (input.op === '<&' && input.target.value !== '-') refuse(`\`${label(cmd)}\` reads its script from another file descriptor, which the gate does not read. Pass it to ${name} with -c in single quotes.`);
  return null;
}

// find's -exec, -execdir, -ok and -okdir: each runs a command, up to a ; or a + after {}.
function findActions(words) {
  const actions = [];
  for (let i = 1; i < words.length; i++) {
    const match = /^-(exec|execdir|ok|okdir)$/.exec(words[i].value);
    if (!match) continue;
    let end = i + 1;
    while (end < words.length && !(words[end].value === ';' || (words[end].value === '+' && words[end - 1].value === '{}'))) end++;
    actions.push({ option: match[0], inFolder: match[1].endsWith('dir'), words: words.slice(i + 1, end) });
    i = end;
  }
  return actions;
}

// The text a command hands a shell to read as code: sh -c's script or its heredoc, eval's words,
// watch's command, and trap's and alias's strings, which run later. Only text the gate reads byte for
// byte counts (exactText). Anything else that reaches a shell refuses.
function codeHanded(cmd, run) {
  const out = [];
  if (run.script) out.push({ text: run.script.text, via: run.script.via, env: run.env, newShell: true });
  const { words, id } = run;
  if (!words.length || !id) return out;
  const { name } = id;
  const exact = (word, what) => {
    const text = exactText(word);
    if (text === null) refuse(`\`${label(cmd)}\` hands ${what} text that is not written out exactly (${word.raw}): a $, a backtick, a backslash or a word built at run time in it is read again. Put the text in single quotes, or run the commands directly.`);
    const filled = run.replace.find((each) => text.includes(each));
    if (filled) refuse(`\`${label(cmd)}\` hands ${what} a script holding ${filled}, which is filled in at run time, so the gate cannot read it. Pass the value as an argument instead.`);
    return text;
  };
  if (id.builtin && name === 'eval' && words.length > 1) out.push({ text: words.slice(1).map((word) => exact(word, 'eval')).join(' '), via: 'eval', env: run.env, sameShell: true });
  if (id.builtin && ['source', '.'].includes(name)) {
    const built = words.slice(1).find((word) => !word.literal);
    if (built) refuse(`\`${label(cmd)}\` runs a command built at run time (${built.raw}). Write the command out, so the gate can see what runs.`);
  }
  if (id.builtin && name === 'trap') {
    let i = 1;
    while (i < words.length && /^-[lpP]+$/.test(words[i].value)) i++;
    if (words[i]?.value === '--') i++;
    const rest = words.slice(i);
    const signalOnly = rest.length === 1 && /^((SIG)?[A-Z][A-Z0-9]*|\d+)$/.test(rest[0].value);
    if (rest.length && !signalOnly && rest[0].value !== '-') {
      const text = exact(rest[0], 'trap');
      if (text.trim()) out.push({ text, via: 'trap', deferred: true });
    }
  }
  if (id.builtin && name === 'alias') {
    for (const word of words.slice(1)) {
      const eq = word.value.indexOf('=');
      if (word.value.startsWith('-') || eq <= 0) continue;
      const value = exact(word, 'alias').slice(eq + 1);
      cmd.line.aliases.set(word.value.slice(0, eq), value);
      cmd.line.defined.add(word.value.slice(0, eq));
      out.push({ text: value, via: 'alias', deferred: true });
    }
  }
  if (FOREIGN_SHELLS.has(name)) {
    const asUser = ['su', 'runuser', 'busybox'].includes(name) && words.length > 1;
    const option = words.length > 1 && words[1].value.startsWith('-');
    const input = words.length === 1 && (cmd.stage > 0 || cmd.inside > 0 || cmd.inheritsInput || cmd.redirs.some((redir) => ['<<', '<<-', '<<<'].includes(redir.op)));
    if (asUser || option || input) refuse(`\`${label(cmd)}\` hands ${name} a command or a script, and the gate does not read ${name}'s grammar. Run the commands directly.`);
  }
  const spec = SHELL_SPECS[name];
  if (spec && !id.builtin) {
    const read = shellOptions(words, spec);
    if (read.problem) refuse(`\`${label(cmd)}\` gives ${name} ${read.problem}, an option the gate does not read, so it cannot tell where the script comes from. Run the commands directly.`);
    if (read.command) {
      if (read.operand !== -1) out.push({ text: exact(words[read.operand], name), via: name, env: run.env, newShell: true });
    } else if (read.stdin || read.operand === -1) {
      const text = stdinScript(cmd, name);
      if (text !== null) {
        const filled = run.replace.find((each) => text.includes(each));
        if (filled) refuse(`\`${label(cmd)}\` hands ${name} a script holding ${filled}, which is filled in at run time, so the gate cannot read it.`);
        out.push({ text, via: name, env: run.env, newShell: true });
      }
    }
  }
  return out;
}

const NEST_LIMIT = 4;

// The commands of a script a command hands a shell, placed in the state it runs in. A script the gate
// cannot read refuses, since the shell may run the part before the mistake, and so does nesting
// deeper than the gate reads.
function readNested(text, env, ctx, cmd) {
  if (ctx.depth > NEST_LIMIT) refuse(`\`${label(cmd)}\` nests shells more than four deep, which the gate does not read. Run the commands directly.`);
  const read = readLine(String(text).replace(/\s+$/, ''));
  if (read.error) refuse(`\`${label(cmd)}\` hands a shell a script the gate cannot read (${read.error}), so it cannot tell what it runs or writes. Run the commands directly.`);
  return placeCommands(read.items, env, ctx);
}

// Checks every line has to pass, gated or not, and every command it runs at any depth: the scripts
// it hands a shell, find's actions and its command substitutions. A nested command that would be
// gated is refused, so the command runs directly where the gate reads it.
function everyLine(cmds, reg) {
  for (const cmd of cmds) {
    const run = unwrapAll(cmd);
    const syntax = cmd.leads.find((lead) => ['coproc', 'repeat', 'foreach'].includes(lead.value));
    if (syntax) refuse(`\`${label(cmd)}\` uses ${syntax.value}, shell syntax the gate does not read. Write it as plain commands.`);
    if (cmd.leads.at(-1)?.value === '[[' && cmd.header.findIndex((word) => word.value === ']]') !== cmd.header.length - 1) refuse(`\`${label(cmd)}\` has words after ]], which zsh can run as a command. Put a ; or && after the test.`);
    const name = run.words.length ? run.id?.name : null;
    if (name === 'hash' && run.id.builtin && run.words.slice(1).some((word) => /^-[A-Za-z]*[pd]/.test(word.value) || word.value.includes('='))) refuse(`\`${label(cmd)}\` changes where the shell finds a name (hash -p, -d or name=path), so the gate cannot tell what later commands run. Run the program by its full path instead.`);
    if (name === 'enable' && run.id.builtin && run.words.some((word) => /^-[A-Za-z]*f/.test(word.value))) refuse(`\`${label(cmd)}\` loads a builtin from a file, which the gate does not read. Run the program instead.`);
    for (const redir of cmd.redirs) {
      if (!OUTPUT_REDIRECTS.has(redir.op) || /^\d$/.test(redir.target.value) || redir.target.value === '-') continue;
      const target = redir.target.literal ? expandWord(redir.target, cmd.env) : homeFilled(redir.target.value);
      if (target === null) continue;
      if (!isAbsolute(target) && cmd.env.cwd === null) refuse(`\`${label(cmd)}\` writes ${redir.target.value} after a cd the gate cannot follow, so it cannot tell where the write lands. Write the full path.`);
      const reason = controlPath(target, cmd.env.cwd);
      if (reason) refuse(`It writes ${reason}, which can change what later commands do or turn the gate off. The user changes those files.`);
    }
    httpOptionFiles(cmd, run);
    const head = run.headId;
    const headName = head && !KNOWN_PROGRAM(head.name) ? basename(cmd.words[0].value) : (head?.name ?? '');
    // A reader may name a control file, but only with options on its list: sort -o writes one.
    // A tool's arguments are checked by its own reading, on the gated line it makes.
    const skipArgs = !cmd.words.length || TOOLS.has(headName) || ((CONTROL_READERS.has(headName) || DATA.has(headName)) && !readOptionProblem(headName, cmd.words));
    if (!skipArgs) {
      for (const word of cmd.words.slice(1)) {
        if (!word.literal) continue;
        for (const value of pathCandidates(word.value)) {
          const reason = controlPath(expandWord({ ...word, value }, cmd.env) ?? value, cmd.env.cwd);
          if (reason) refuse(`\`${label(cmd)}\` names ${reason}, which steers git, jj or the gate. The user changes those files.`);
        }
      }
    }
    for (const group of cmd.nested) {
      const why = gatedBy(group.cmds.map((each) => describe(each, reg)), reg, group.text ?? '');
      if (why) refuse(`\`${label(cmd)}\` runs ${why} through ${group.via}, which the gate does not read. Run it directly, written out in full.`);
      everyLine(group.cmds, reg);
    }
  }
}

// A redirection target with $HOME or ${HOME} filled in, or null when anything else in it is built at
// run time.
const homeFilled = (value) => {
  const filled = value.replace(/^"|"$/g, '').replace(/\$\{HOME\}|\$HOME\b/g, HOME);
  return /[$`\\"']/.test(filled) ? null : filled;
};

// The shell's state as a command sees it: the folder (null when unknown), the search paths PATH may
// hold (several when the line may or may not have set it), whether PATH is unknown, HOME, the last
// folder (for cd -), whether CDPATH is set, the folders pushd saved, and whether an exec set stdin.
// line holds the functions and aliases the shell defines, and whether it may set IFS, shared by
// everything that runs in it.
const newLine = () => ({ defined: new Set(), aliases: new Map(), ifs: false });
const startState = (cwd) => ({ cwd, paths: [process.env.PATH ?? ''], pathUnknown: false, home: HOME, oldpwd: null, cdpath: Boolean(process.env.CDPATH), dirs: [], stdinRedirected: false });

// Two states a command may run in, as one: what they agree on, unknown where they differ, and every
// search path either may hold.
function merge(a, b) {
  if (a === b) return a;
  return {
    ...a,
    cwd: a.cwd === b.cwd ? a.cwd : null,
    paths: [...new Set([...a.paths, ...b.paths])],
    pathUnknown: a.pathUnknown || b.pathUnknown,
    home: a.home === b.home ? a.home : null,
    oldpwd: a.oldpwd === b.oldpwd ? a.oldpwd : null,
    cdpath: a.cdpath || b.cdpath,
    dirs: a.dirs && b.dirs && a.dirs.join('\0') === b.dirs.join('\0') ? a.dirs : null,
    stdinRedirected: a.stdinRedirected || b.stdinRedirected,
  };
}

const isFolder = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// Where cd, pushd or popd leaves the shell, or null when the gate cannot tell: a folder built at run
// time, cd - with no known last folder, CDPATH, zsh's cd old new and stack forms, and a .. that a
// link makes land in another folder than it reads.
function cdTarget(name, words, state) {
  let i = 1;
  let physical = false;
  while (i < words.length && /^-[LPeqs@]+$/.test(words[i].value)) {
    if (words[i].value.includes('P')) physical = true;
    i++;
  }
  if (words[i]?.value === '--') i++;
  const args = words.slice(i);
  if (name === 'popd') return args.length || !state.dirs?.length ? { cwd: null, dirs: null } : { cwd: state.dirs[0], dirs: state.dirs.slice(1) };
  if (name === 'pushd' && !args.length) return state.dirs?.length && state.cwd !== null ? { cwd: state.dirs[0], dirs: [state.cwd, ...state.dirs.slice(1)] } : { cwd: null, dirs: null };
  const saved = name === 'pushd' ? (state.dirs && state.cwd !== null ? [state.cwd, ...state.dirs] : null) : state.dirs;
  const to = (cwd) => ({ cwd, dirs: saved });
  if (!args.length) return to(state.home);
  if (args.length > 1) return to(null);
  const [target] = args;
  if (!target.literal || /^[+-]\d+$/.test(target.value)) return to(null);
  if (target.value === '-') return to(state.oldpwd);
  const value = expandWord(target, state);
  if (value === null) return to(null);
  if (!isAbsolute(value) && (state.cwd === null || (state.cdpath && !/^\.\.?(\/|$)/.test(value)))) return to(null);
  const logical = resolve(state.cwd ?? '/', value);
  if (!/(^|\/)\.\.(\/|$)/.test(value)) return to(logical);
  // cd -L reads .. off the path as written, cd -P off the folder a link points to.
  try {
    const real = realpathSync(join(realpathSync(state.cwd ?? '/'), value));
    if (physical) return to(real);
    return to(realpathSync(logical) === real ? logical : null);
  } catch {
    return to(physical ? null : logical);
  }
}

// Builtins that can set a variable, and so PATH, other than by NAME=value.
const SETTERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'vared', 'zparseopts', 'let', 'printf', 'print', 'set', 'typeset', 'declare', 'local', 'integer', 'float', 'export', 'readonly']);
const EXPORTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'integer', 'float']);
const NAMES_PATH = /(^|[^A-Za-z0-9_])(PATH|path|EXECIGNORE)([^A-Za-z0-9_]|$)/;
const NAMES_STATE = /(^|[^A-Za-z0-9_])(PATH|path|EXECIGNORE|HOME|CDPATH|cdpath|OLDPWD)([^A-Za-z0-9_]|$)/;
// ${PATH:=x} and zsh's ${PATH::=x} assign as they expand, and ${(P)name::=x} assigns a name built at
// run time.
const EXPANSION_ASSIGNS = /\$\{(?:\([^)]*\))?(PATH|path|HOME|CDPATH|cdpath|EXECIGNORE|OLDPWD):{0,2}=|\$\{\([^)]*P[^)]*\)[^}]*=/;

// Marks what a word or command may set that the gate does not follow: PATH unknown, HOME unknown,
// CDPATH set.
function unknownState(state, text) {
  if (NAMES_PATH.test(text)) state.pathUnknown = true;
  if (/(^|[^A-Za-z0-9_])HOME([^A-Za-z0-9_]|$)/.test(text)) state.home = null;
  if (/(^|[^A-Za-z0-9_])(CDPATH|cdpath)([^A-Za-z0-9_]|$)/.test(text)) state.cdpath = true;
  if (/(^|[^A-Za-z0-9_])OLDPWD([^A-Za-z0-9_]|$)/.test(text)) state.oldpwd = null;
}

// How a command changes the shell's state, as { next, certain }, or null when it does not. A change
// is certain when it cannot fail: an assignment, or a cd to a folder that exists.
function stateEffects(cmd, run, state) {
  const next = { ...state };
  let changed = false;
  let certain = true;
  for (const word of allWords(cmd).concat(cmd.redirs.map((redir) => redir.target))) {
    if (EXPANSION_ASSIGNS.test(word.raw)) { unknownState(next, word.raw); changed = true; }
  }
  const leadValue = cmd.leads.at(-1)?.value;
  if (['for', 'select', 'foreach'].includes(leadValue) && cmd.header[0] && NAMES_STATE.test(cmd.header[0].value)) { unknownState(next, cmd.header[0].value); changed = true; }
  if (!cmd.words.length) {
    for (const assign of cmd.assigns) { applyAssign(next, assign, cmd); changed = true; }
    return changed ? { next, certain } : null;
  }
  const { words, id } = run;
  const head = cmd.words[0];
  // zsh's path[1]=x sets one element of PATH.
  if (head.literal && /^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\+?=/.test(head.value)) {
    unknownState(next, head.value.split('[')[0]);
    return { next, certain };
  }
  if (run.runners.at(-1) === 'exec' && !words.length && cmd.redirs.some((redir) => STDIN_OPS.has(redir.op) && (redir.fd === '' || redir.fd === '0'))) {
    next.stdinRedirected = true;
    changed = true;
  }
  if (!words.length || !id) return changed ? { next, certain } : null;
  const name = id.name;
  if (run.sameShell && id.builtin) {
    // An assignment before a special builtin stays set in a POSIX shell, though not in zsh.
    if (cmd.assigns.length && SPECIAL_BUILTINS.has(name)) {
      const kept = { ...next };
      for (const assign of cmd.assigns) applyAssign(kept, assign, cmd);
      Object.assign(next, merge(next, kept));
      changed = true;
    }
    if (['cd', 'pushd', 'popd', 'chdir'].includes(name)) {
      // CDPATH or HOME set for the cd itself steers it too.
      const moved = cdTarget(name, words, { ...next, home: run.env.home, cdpath: run.env.cdpath });
      next.oldpwd = next.cwd;
      next.cwd = moved.cwd;
      next.dirs = moved.dirs;
      certain = moved.cwd !== null && isFolder(moved.cwd);
      return { next, certain };
    }
    if (EXPORTERS.has(name) || SETTERS.has(name) || name === 'unset') {
      const args = words.slice(1);
      // declare -n makes a name another variable's alias, and zsh's typeset -T ties two together.
      const nameref = EXPORTERS.has(name) && args.some((word) => /^-[A-Za-z]*[nT]/.test(word.value));
      // printf and print assign only with -v, and zsh's set only with -A.
      const assigning = !['printf', 'print', 'set'].includes(name) || args.some((word) => /^[-+][A-Za-z]*[vA]/.test(word.value));
      for (const word of assigning ? args : []) {
        if (EXPORTERS.has(name) && !nameref) {
          if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.value)) { applyAssign(next, word, cmd); changed = true; }
          continue;
        }
        if (NAMES_STATE.test(word.raw)) { unknownState(next, word.raw); changed = true; }
      }
      return changed ? { next, certain } : null;
    }
  }
  // zsh's auto_cd: a bare folder name that is no command changes to that folder.
  if (!run.runners.length && id.missing && words.length === 1 && head.literal && state.cwd !== null && isFolder(resolve(state.cwd, expandWord(head, state) ?? ''))) {
    next.oldpwd = next.cwd;
    next.cwd = resolve(state.cwd, expandWord(head, state));
    return { next, certain: false };
  }
  return changed ? { next, certain } : null;
}

// For each construct that opens with a reserved word ({, if, a loop, case), the index of the command
// that closes it, so the gate knows before reading it whether it runs in a subshell (a group piped
// or sent to the background) and, for a loop, whether its body changes the folder or PATH.
const OPENERS = { '{': '}', if: 'fi', while: 'done', until: 'done', for: 'done', select: 'done', case: 'esac' };
function pairConstructs(items) {
  const pairs = new Map();
  const open = [];
  items.forEach((item, k) => {
    (item.leads ?? []).forEach((lead, l) => {
      if (Object.hasOwn(OPENERS, lead.value)) open.push({ key: `${k}:${l}`, close: OPENERS[lead.value] });
      else if (Object.values(OPENERS).includes(lead.value)) {
        const at = open.findLastIndex((entry) => entry.close === lead.value);
        if (at !== -1) pairs.set(open.splice(at)[0].key, k);
      }
    });
  });
  return pairs;
}

const STATE_HEADS = new Set(['cd', 'pushd', 'popd', 'chdir', 'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'read', 'eval', 'source', '.', 'hash', 'set', 'printf', 'print', 'mapfile', 'readarray', 'let']);
// Whether the commands from one index to another may change the folder or PATH, as a loop body does
// on every pass after the first.
function rangeChanges(items, from, to) {
  const changes = { cwd: false, path: false };
  for (const item of items.slice(from, to + 1)) {
    if (!item.words) continue;
    const head = item.words.find((word) => !['command', 'builtin', 'noglob', 'time'].includes(word.value))?.value ?? '';
    if (['cd', 'pushd', 'popd', 'chdir'].includes(head) || (item.words.length === 1 && !/^[A-Za-z]/.test(head))) changes.cwd = true;
    if (STATE_HEADS.has(head) || item.assigns.length || (item.header ?? []).some((word) => NAMES_PATH.test(word.value)) || allWords(item).some((word) => EXPANSION_ASSIGNS.test(word.raw))) changes.path = true;
  }
  return changes;
}

// Whether anything after an index may set PATH, which code that runs later (a function body, a trap,
// an alias) would then be found with.
const laterSetsPath = (items, k) => items.slice(k + 1).some((item) => item.words && allWords(item).some((word) => NAMES_PATH.test(word.raw)));

// The state code runs in when it runs later: a function body, a trap or an alias. The folder is
// unknown, and so is PATH if the line may set it after this point.
const deferredState = (state, items, k) => ({ ...state, cwd: null, oldpwd: null, dirs: null, pathUnknown: state.pathUnknown || laterSetsPath(items, k) });

// Places each command of a line in the state the shell runs it in: the folder, PATH and HOME after
// every cd, pushd, popd and assignment before it, with subshells, pipe stages and background jobs
// kept apart from their parent, and a change that may not have happened (after ||, in a branch or a
// loop, or by a cd that may fail) merged into unknown. Each command is read once here: its runners,
// its program, and every command it runs at any depth (its scripts, find's actions and its command
// substitutions), each placed the same way. eval runs in the same shell, so its changes carry on.
function placeCommands(items, start, ctx = {}) {
  const depth = ctx.depth ?? 0;
  const line = ctx.line ?? newLine();
  // A shell that may set IFS splits values on characters the gate does not follow (knownWord).
  if (items.some((item) => item.words && [...allWords(item), ...item.redirs.map((redir) => redir.target)].some((word) => word.raw.includes('IFS')))) line.ifs = true;
  const strict = Boolean(ctx.strict);
  const cmds = [];
  const closers = pairConstructs(items);
  let state = { ...start };
  const frames = [];
  const freshList = () => ({ start: state, changed: false, joined: false, uncertain: false, orLeft: null, orExit: false, afterOr: false });
  let list = freshList();
  let pipeStart = state;
  let functionNext = null;
  const endList = () => {
    if (list.changed && (list.joined || list.uncertain)) state = list.orExit ? list.orLeft : merge(list.start, state);
    list = freshList();
  };
  const change = (next, certain) => {
    state = next;
    list.changed = true;
    if (!certain) list.uncertain = true;
    for (const frame of frames) frame.changed = true;
  };
  const open = (kind, extra) => {
    const frame = { kind, saved: state, list, changed: false, ...extra };
    frames.push(frame);
    if (frame.function) state = deferredState(state, items, frame.at);
    list = freshList();
    return frame;
  };
  const close = (matches) => {
    const at = frames.findLastIndex(matches);
    if (at === -1) return;
    const [frame] = frames.splice(at);
    const { kind } = frame;
    const inner = state;
    list = frame.list;
    if (frame.function) state = frame.changed ? { ...merge(frame.saved, inner), cwd: inner.cwd === frame.saved.cwd ? frame.saved.cwd : null } : frame.saved;
    else if (frame.subshell) state = frame.saved;
    else if (kind === '{' && !frame.lastStage) state = inner;
    else state = merge(frame.saved, inner);
    if (state !== frame.saved) {
      list.changed = true;
      for (const outer of frames) outer.changed = true;
    }
  };
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    if (item.op) {
      const { op } = item;
      if (op === '(') {
        open('(', { subshell: true, function: Boolean(functionNext), at: k });
        functionNext = null;
      } else if (op === ')') close((frame) => frame.kind === '(');
      else if (op === '|' || op === '|&') state = pipeStart;
      else if (op === '&&') Object.assign(list, { joined: true, orExit: false });
      else if (op === '||') {
        Object.assign(list, { joined: true, orLeft: state, orExit: false, afterOr: true });
        state = merge(list.start, state);
      } else if (op === '&') {
        state = list.start;
        list = freshList();
      } else if (op !== '\n' || !functionNext) endList();
      continue;
    }
    const cmd = { ...item, leads: item.leads ?? [], header: item.header ?? [], strict, depth, line, nested: [], inheritsInput: Boolean(ctx.inheritsInput) };
    item.leads?.forEach((lead, l) => {
      const { value } = lead;
      if (Object.hasOwn(OPENERS, value)) {
        const closer = closers.get(`${k}:${l}`);
        const closerItem = closer === undefined ? null : items[closer];
        const subshell = ['|', '|&', '&'].includes(closerItem?.ender);
        open(value, { subshell, lastStage: item.stage > 0, function: value === '{' && Boolean(functionNext), at: k });
        functionNext = null;
        if (['while', 'until', 'for', 'select'].includes(value) && closer !== undefined) {
          const changes = rangeChanges(items, k, closer);
          if (changes.cwd) state = { ...state, cwd: null, oldpwd: null, dirs: null };
          if (changes.path) state = { ...state, pathUnknown: true };
        }
      } else if (['then', 'do', 'else', 'elif'].includes(value)) {
        if (value === 'else' || value === 'elif') {
          const frame = frames.findLast((each) => each.kind === 'if');
          if (frame) state = merge(frame.saved, state);
        }
        list = freshList();
      } else if (Object.values(OPENERS).includes(value)) {
        endList();
        close((frame) => OPENERS[frame.kind] === value);
      }
    });
    if (functionNext && !item.leads?.length) {
      // zsh takes a simple command as a function body: it runs later, not here.
      cmd.deferred = true;
      functionNext = null;
      Object.assign(cmd, { env: deferredState(state, items, k) });
    }
    cmd.deferred ||= frames.some((frame) => frame.function);
    cmd.inside = frames.length;
    if (cmd.stage === 0) pipeStart = state;
    // A function definition: f() { ... } or function f { ... }. Its body runs when it is called.
    const named = cmd.leads.length === 1 && cmd.leads[0].value === 'function' && cmd.header.length === 1;
    const parens = !cmd.leads.length && !cmd.assigns.length && cmd.words.length === 1 && cmd.words[0].literal && item.ender === '(' && items[k + 1]?.op === '(' && items[k + 2]?.op === ')';
    if (named || parens) {
      const name = (named ? cmd.header[0] : cmd.words[0]).value;
      line.defined.add(name);
      Object.assign(cmd, { header: named ? cmd.header : cmd.words, words: [], defines: name, env: state, shellEnv: state, cwd: state.cwd, paths: state.paths, pathUnknown: state.pathUnknown });
      cmd.run = { words: [], runners: [], env: state, replace: [], id: null, headId: null, sameShell: true };
      cmds.push(cmd);
      functionNext = name;
      if (items[k + 1]?.op === '(' && items[k + 2]?.op === ')') k += 2;
      continue;
    }
    const shellEnv = cmd.env ?? state;
    const env = { ...shellEnv };
    if (cmd.words.length) for (const assign of cmd.assigns) applyAssign(env, assign, cmd);
    Object.assign(cmd, { shellEnv, env, cwd: env.cwd, paths: env.paths, pathUnknown: env.pathUnknown, stdinRedirected: state.stdinRedirected });
    cmds.push(cmd);
    // Command substitutions run first, in a subshell, with the shell's state and the command's own.
    const words = [...allWords(cmd), ...cmd.redirs.map((redir) => redir.target)];
    const bodies = words.flatMap((word) => substitutions(word.raw));
    for (const redir of cmd.redirs) if (redir.body !== undefined && !redir.bodyLiteral) bodies.push(...substitutions(redir.body, { heredoc: true }));
    for (const { body, kind } of bodies) {
      if (kind === '`' && body.includes('\\')) refuse(`\`${label(cmd)}\` has a backtick command with a backslash in it, which the shell reads again before it runs. Write it as $( ).`);
      const placed = readNested(body, merge(shellEnv, env), { strict, depth: depth + 1, line, expandAliases: ctx.expandAliases, inheritsInput: ctx.inheritsInput }, cmd);
      cmd.nested.push({ via: 'a command substitution', text: body, cmds: placed.cmds });
    }
    if (cmd.words.length) {
      const run = unwrapAll(cmd);
      // An alias the line defines expands where the shell parses text later: eval, a trap, an alias.
      if (ctx.expandAliases && cmd.words[0].literal && line.aliases.has(cmd.words[0].value)) {
        const text = [line.aliases.get(cmd.words[0].value), ...cmd.words.slice(1).map((word) => word.raw)].join(' ');
        const placed = readNested(text, env, { strict: true, depth: depth + 1, line, expandAliases: true, inheritsInput: ctx.inheritsInput }, cmd);
        cmd.nested.push({ via: 'an alias', text, cmds: placed.cmds });
      }
      // A shell it starts reads the same input it does.
      const inheritsInput = cmd.stage > 0 || cmd.inside > 0 || Boolean(cmd.inheritsInput) || cmd.redirs.some((redir) => STDIN_OPS.has(redir.op));
      for (const group of codeHanded(cmd, run)) {
        const groupEnv = group.deferred ? deferredState(state, items, k) : group.newShell ? { ...group.env, dirs: [], stdinRedirected: false } : group.env;
        const placed = readNested(group.text, groupEnv, { strict: true, depth: depth + 1, line: group.newShell ? undefined : line, expandAliases: !group.newShell, inheritsInput }, cmd);
        cmd.nested.push({ via: group.via, text: group.text, cmds: placed.cmds });
        if (group.sameShell) change(placed.state, true);
      }
      if (run.words.length && run.id?.name === 'find') {
        for (const action of findActions(run.words)) {
          if (!action.words.length) continue;
          // -execdir runs in each found file's folder, which the gate does not know.
          const actionEnv = action.inFolder ? { ...run.env, cwd: null } : run.env;
          const actionItem = { leads: [], header: [], words: action.words, assigns: [], redirs: [], segment: cmd.segment, stage: 0, ender: null, replace: ['{}'] };
          if (depth + 1 > NEST_LIMIT) refuse(`\`${label(cmd)}\` nests shells more than four deep, which the gate does not read. Run the commands directly.`);
          const placed = placeCommands([actionItem], actionEnv, { strict: true, depth: depth + 1, inheritsInput });
          cmd.nested.push({ via: `find ${action.option}`, text: action.words.map((word) => word.raw).join(' '), cmds: placed.cmds });
        }
      }
    }
    const effects = cmd.deferred && !frames.some((frame) => frame.function) ? null : stateEffects(cmd, cmd.run ?? { words: [], runners: [] }, state);
    if (effects) change(effects.next, effects.certain);
    if (list.afterOr) {
      list.afterOr = false;
      list.orExit = ['exit', 'return'].includes(cmd.run?.id?.name) && cmd.run?.runners.length === 0;
    }
    // The last stage of a pipe runs in the shell in zsh and in a subshell in bash.
    if (cmd.stage > 0 && !['|', '|&'].includes(item.ender)) state = merge(pipeStart, state);
  }
  endList();
  return { cmds, state };
}

// The simple commands of a line, each with the folder it runs in, for the post-push mirror. A line
// the gate refuses runs nothing, so it has none.
export function lineCommands(text, start) {
  const read = readLine(text);
  if (read.error) return [];
  try {
    return placeCommands(read.items, startState(start)).cmds;
  } catch (error) {
    if (error instanceof Refusal) return [];
    throw error;
  }
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
  // command -v and the like ask where a program is and run nothing.
  if (info.query) return { cls: 'read' };
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
  return classify(describe({ ...cmd, words, run: undefined, info: undefined }, line.registry), line);
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
  const dir = resolve(line.start ?? '/', expandWord(target) ?? target.value);
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
      const reason = controlPath(expandWord({ ...word, value }, cmd.env) ?? value, cmd.cwd);
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
    const reserved = allWords(cmd).find((word) => word.reserved);
    if (reserved) refuse(`\`${label(cmd)}\` uses shell syntax (${reserved.value}) on a line that holds ${why}. Run the commands one at a time.`);
    // Every program on a gated line is found for certain: a word the gate cannot find may be a
    // function or alias it does not read.
    const head = info.words[0];
    if (head?.literal && !info.deploy && !TOOLS.has(foldedName(head.value)) && foldedName(head.value) !== 'pipeline') identify(head, cmd.env, cmd, { strict: true, builtins: info.words === cmd.words });
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
  // A read before the action runs first, so it must be the read it is named for: the shell's own,
  // or the system's, not a file of that name elsewhere on PATH that could change the repository.
  const borrowed = sorted.find((entry) => entry.cmd.segment < action.cmd.segment && entry.cls === 'read' && !entry.info.tool && !entry.info.query && !systemIdentity(entry.info.headId));
  if (borrowed) refuse(`\`${label(borrowed.cmd)}\` runs ${borrowed.info.headId?.files[0] ?? borrowed.info.name} before \`${label(action.cmd)}\`, and the gate trusts only the shell's own and the system's reads to change nothing first. Run it on its own first.`);
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
    if (viaPath || scriptFile({ value: word, literal: true, tilde: word.startsWith('~') }, startState(start), reg)) return `It runs or names ${word}, a registered deploy script, through PowerShell, which the gate does not read. Run the deploy through the Bash tool, as deploy.command does.`;
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
  try {
    const reg = registry();
    const { cmds } = placeCommands(items, startState(start));
    everyLine(cmds, reg);
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
