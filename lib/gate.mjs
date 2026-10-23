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

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { CONFIG_FILE } from './config.mjs';
import { actionContext, mirrorContext } from './context.mjs';
import { controlPath, Refusal, refuse, resolveRevset, userRuns } from './gate-common.mjs';
import { classifyGh, classifyHttp } from './gate-gh.mjs';
import { checkPush, classifyGit, classifyJj } from './gate-vcs.mjs';
import { loadRuns, passed } from './ledger.mjs';
import { readLine } from './line.mjs';
import { optionProblem, READ_OPTIONS, someOptions } from './options.mjs';
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

// A program word to the file it runs: a path as written, or the first match on PATH. The native
// realpath spells the file as the disk stores it, so /usr/bin/GIT comes back as /usr/bin/git.
function programFile(word, cwd) {
  try {
    if (word.includes('/')) return realpathSync.native(resolve(cwd ?? '/', expandHome(word)));
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(dir, word);
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync.native(candidate);
    }
  } catch {
    return null;
  }
  return null;
}

// The tool a command word runs: by its name, or by the real file it names (a link to git is git).
function toolOf(word, cwd) {
  const name = foldedName(word);
  if (TOOLS.has(name) || ['pipeline', 'curl', 'wget'].includes(name)) return name;
  const file = programFile(word, cwd);
  const real = file ? foldedName(file) : null;
  return real && (TOOLS.has(real) || ['curl', 'wget'].includes(real)) ? real : null;
}

// The index of the word a runner runs as its command, past its options and their values.
function commandIndex(words) {
  const name = foldedName(words[0].value);
  let i = 1;
  if (name === 'env') while (i < words.length && (words[i].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value))) i++;
  else if (['timeout', 'gtimeout'].includes(name)) {
    while (i < words.length && words[i].value.startsWith('-')) i += /^(-s|--signal|-k|--kill-after)$/.test(words[i].value) ? 2 : 1;
    i++;
  } else if (['flock', 'chroot'].includes(name)) {
    while (i < words.length && words[i].value.startsWith('-')) i++;
    i++;
  } else while (i < words.length && words[i].value.startsWith('-')) i++;
  return i;
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
function deployOf(words, cwd, reg) {
  const head = words[0];
  if (!head?.literal) return null;
  const interpreter = INTERPRETERS.test(foldedName(head.value)) ? foldedName(head.value) : null;
  const scriptIndex = interpreter ? words.findIndex((word, i) => i > 0 && !word.value.startsWith('-')) : 0;
  if (scriptIndex === -1) return null;
  const script = words[scriptIndex];
  if (!script.literal) return null;
  let file = null;
  if (scriptIndex === 0) file = programFile(script.value, cwd);
  else {
    try { file = realpathSync(resolve(cwd ?? '/', expandHome(script.value))); } catch { file = null; }
  }
  const owners = file ? deployScriptEntries(file, reg.entries) : [];
  const identities = [...new Set(owners.map((entry) => entry.identity))];
  if (identities.length > 1) return { ambiguous: identities, interpreter };
  if (identities.length === 1) return { entry: owners[0], interpreter, argsFrom: scriptIndex + 1 };
  if (/\s/.test(script.value)) return null;
  const local = localEntry(cwd, reg);
  const regex = local ? patternOf(local) : null;
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
      } catch {
        entry = null;
      }
    }
    reg.stores.set(cwd, entry);
  }
  return reg.stores.get(cwd);
}

const patternOf = (entry) => {
  try {
    return entry.deployMatch ? new RegExp(entry.deployMatch) : null;
  } catch {
    return null;
  }
};

// Whether a word names a registered deploy script, by real path or content.
function scriptFile(word, cwd, reg) {
  if (!reg.entries.length || word.value.startsWith('-')) return false;
  const value = expandWord(word);
  if (!value.includes('/') && !existsSync(resolve(cwd ?? '/', value))) return false;
  try {
    return deployScriptEntries(realpathSync(resolve(cwd ?? '/', value)), reg.entries).length > 0;
  } catch {
    return false;
  }
}

// What a command is, decided without running anything.
function describe(cmd, reg) {
  const words = peel(cmd.words);
  const head = words[0];
  const info = { cmd, words, name: head ? basename(head.value) : '', tool: null, deploy: null, data: false };
  if (!head) return info;
  info.tool = head.literal ? toolOf(head.value, cmd.cwd) : null;
  info.data = DATA.has(info.name) && words.every((word) => word.literal) && !readOptionProblem(info.name, words);
  info.deploy = deployOf(words, cmd.cwd, reg);
  // A deploy script named anywhere in a command, run through a wrapper or passed to another program.
  info.scriptMention = !info.deploy && words.some((word, i) => i > 0 && word.literal && scriptFile(word, cmd.cwd, reg));
  // A deploy pattern counts only in its own repository's folders.
  info.pattern = patternOf(localEntry(cmd.cwd, reg) ?? {});
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
    if (!info.data && mentionsTool(commandText(info.cmd))) return 'a jj, git, gh or agent-review mention';
    if (info.patternMention) return 'the deploy command pattern';
    if (info.scriptMention) return 'the deploy script';
    if (info.cmd.words.some((word) => word.literal && word.value.includes('/') && TOOLS.has(foldedName(programFile(word.value, info.cmd.cwd) ?? '')))) return 'a path to jj, git or gh';
  }
  // With the registry unreadable the deploy scripts are unknown, so anything named like one is gated.
  if (reg.error && /deploy/i.test(text)) return 'a deploy-like command, while the registry cannot be read';
  return null;
}

// Checks every line has to pass, gated or not.
function everyLine(cmds) {
  for (const cmd of cmds) {
    const found = dynamicCommand(cmd.words);
    if (found) refuse(`\`${label(cmd)}\` runs a command built at run time (${found}). Write the command out, so the gate can see what runs.`);
    for (const redir of cmd.redirs) {
      if (!OUTPUT_REDIRECTS.has(redir.op) || !redir.target.literal || /^\d$/.test(redir.target.value)) continue;
      const reason = controlPath(expandWord(redir.target), cmd.cwd);
      if (reason) refuse(`It writes ${reason}, which can change what later commands do or turn the gate off. The user changes those files.`);
    }
    const name = basename(cmd.words[0]?.value ?? '');
    // A reader may name a control file, but only with options on its list: sort -o writes one.
    // A tool's arguments are checked by its own reading, on the gated line it makes.
    if (!cmd.words.length || TOOLS.has(name) || ((CONTROL_READERS.has(name) || DATA.has(name)) && !readOptionProblem(name, cmd.words))) continue;
    for (const word of cmd.words.slice(1)) {
      if (!word.literal) continue;
      const values = [word.value];
      if (word.value.includes('=')) values.push(word.value.slice(word.value.indexOf('=') + 1));
      for (const value of values) {
        if (!value || (value.startsWith('-') && !value.includes('/'))) continue;
        const reason = controlPath(expandWord({ ...word, value }), cmd.cwd);
        if (reason) refuse(`\`${label(cmd)}\` names ${reason}, which steers git, jj or the gate. The user changes those files.`);
      }
    }
  }
}

// Sets each command's folder from the cd commands before it, as far as they can be read.
function placeCommands(items, start) {
  let cwd = start;
  const cmds = [];
  for (const item of items) {
    if (!item.words) continue;
    const cmd = { ...item, cwd };
    cmds.push(cmd);
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
      if (!root || storeOf(root) !== storeOf(ctx.repo)) refuse(`\`${pin.label}\` sets a bookmark in another repository than the push. Run it on its own first.`);
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

function checkReview(cwd, sub, args) {
  const ctx = mirrorContext(cwd);
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
  const found = agentReviewEntries(ctx.config).find((candidate) => candidate.topic === topic) ?? findEntry(ctx.config, topic);
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
  const sameStore = here && storeOf(here) === storeOf(ctx.repo);
  if (!pinned && !sameStore && /@/.test(rev)) refuse(`${rev} names a working copy, and this runs outside the repository's workspaces, so the gate cannot tell which one. Pass a commit id.`);
  const ids = pinned ? [pinned.target] : resolveRevset(sameStore ? here : ctx.repo, rev);
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
    const values = [word.value];
    if (word.value.includes('=')) values.push(word.value.slice(word.value.indexOf('=') + 1));
    if (/^-[A-Za-z]./.test(word.value)) values.push(word.value.slice(2));
    for (const value of values) {
      if (!value || (value.startsWith('-') && !value.includes('/'))) continue;
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
    if (scriptFile({ value: word, literal: true, tilde: word.startsWith('~') }, start, reg)) return `It runs or names ${word}, a registered deploy script, through PowerShell, which the gate does not read. Run the deploy through the Bash tool, as deploy.command does.`;
  }
  const local = localEntry(start, reg);
  const pattern = local ? patternOf(local) : null;
  if (pattern?.test(text.replace(/["'`]/g, ''))) return 'It matches the deploy command (deploy.match), and the gate does not read PowerShell. Run the deploy through the Bash tool.';
  const scripts = reg.entries.some((entry) => (entry.deployScripts ?? []).length);
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
  if (read.error) return named() ? blockMessage(text, [`The gate cannot read this line (${read.error}), and it names jj, git, gh, agent-review or a deploy. Write it as plain commands joined by &&.`]) : null;
  const items = [...read.items];
  while (items.length && items.at(-1).op === '\n') items.pop();
  const cmds = placeCommands(items, start);
  try {
    everyLine(cmds);
    const reg = registry();
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
