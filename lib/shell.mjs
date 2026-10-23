// The shell reader behind the gate. It turns a command line into the simple commands it runs, each
// with its words after quote removal, the folder it runs in, and anything the reader could not
// resolve. It never guesses: a word built from a variable or a substitution is marked dynamic, and a
// shell reading its script from a pipe or a file is marked opaque, so the gate can refuse what it
// cannot read instead of letting it through.
//
// It follows POSIX sh, plus the bash and zsh forms agents write: $'...' quoting, here-strings,
// process substitution, |& and &>.

import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { HOME } from './util.mjs';

// Lexing

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL_PARAMS = '@*#?-$!0123456789';

const ANSI_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// Where the parenthesized text that starts after an opening ( at `start` ends, skipping quotes.
function closingParen(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') i++;
    else if (char === "'") i = text.indexOf("'", i + 1) === -1 ? text.length : text.indexOf("'", i + 1);
    else if (char === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i;
  }
  return text.length;
}

function closingBacktick(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') return i;
  }
  return text.length;
}

function decodeAnsi(text, start) {
  let out = '';
  let i = start;
  for (; i < text.length && text[i] !== "'"; i++) {
    if (text[i] !== '\\') { out += text[i]; continue; }
    const next = text[++i];
    if (next in ANSI_ESCAPES) out += ANSI_ESCAPES[next];
    else if (/[0-7]/.test(next)) {
      const digits = /^[0-7]{1,3}/.exec(text.slice(i))[0];
      out += String.fromCharCode(parseInt(digits, 8));
      i += digits.length - 1;
    } else if (next === 'x' || next === 'u' || next === 'U') {
      const digits = new RegExp(`^[0-9a-fA-F]{1,${next === 'x' ? 2 : next === 'u' ? 4 : 8}}`).exec(text.slice(i + 1))?.[0] ?? '';
      out += digits ? String.fromCodePoint(parseInt(digits, 16)) : `\\${next}`;
      i += digits.length;
    } else if (next === 'c') out += String.fromCharCode((text[++i] ?? '@').charCodeAt(0) & 31);
    else out += `\\${next ?? ''}`;
  }
  return { value: out, end: i };
}

// A word being built. `dynamic` is set by any expansion the shell does at run time, `glob` by an
// unquoted pattern or brace the shell may expand into other words. `subs` are the command
// substitutions inside it, which run before the command that holds them.
const newWord = () => ({ text: '', dynamic: false, glob: false, quotedAt: Infinity, subs: [] });

// A parameter expansion at text[i] === '$'. Returns where it ends and whether it was $HOME.
function parameter(text, i, word) {
  const next = text[i + 1];
  if (next === '{') {
    const end = text.indexOf('}', i + 2);
    const stop = end === -1 ? text.length : end;
    if (text.slice(i + 2, stop) === 'HOME') word.text += HOME;
    else word.dynamic = true;
    return stop + 1;
  }
  const name = NAME.exec(text.slice(i + 1))?.[0];
  if (name) {
    if (name === 'HOME') word.text += HOME;
    else word.dynamic = true;
    return i + 1 + name.length;
  }
  if (next !== undefined && SPECIAL_PARAMS.includes(next)) {
    word.dynamic = true;
    return i + 2;
  }
  word.text += '$';
  return i + 1;
}

// Reads a $( or backtick substitution, or $(( arithmetic, starting at text[i]. Returns the end.
function substitution(text, i, word) {
  word.dynamic = true;
  if (text[i] === '`') {
    const end = closingBacktick(text, i + 1);
    word.subs.push(text.slice(i + 1, end).replace(/\\([`\\$])/g, '$1'));
    return end + 1;
  }
  const end = closingParen(text, i + 2);
  if (text[i + 2] !== '(') word.subs.push(text.slice(i + 2, end));
  return end + 1;
}

function doubleQuoted(text, i, word) {
  word.quotedAt = Math.min(word.quotedAt, word.text.length);
  let j = i + 1;
  while (j < text.length && text[j] !== '"') {
    const char = text[j];
    if (char === '\\' && j + 1 < text.length) {
      if ('$`"\\\n'.includes(text[j + 1])) {
        if (text[j + 1] !== '\n') word.text += text[j + 1];
      } else word.text += `\\${text[j + 1]}`;
      j += 2;
    } else if (char === '`' || (char === '$' && text[j + 1] === '(')) j = substitution(text, j, word);
    else if (char === '$') j = parameter(text, j, word);
    else {
      word.text += char;
      j++;
    }
  }
  return j + 1;
}

const OPERATORS = ['&&', '||', '|&', ';;', ';&', '|', ';', '&', '(', ')'];
const REDIRECTS = ['<<<', '<<-', '<<', '&>>', '&>', '>>', '>&', '<&', '<>', '>|', '<', '>'];

// Tokens: { type: 'word', ...word }, { type: 'op', op }, { type: 'redir', op, target, heredoc }.
export function lex(text) {
  const tokens = [];
  const heredocs = [];
  let word = null;
  const endWord = () => {
    if (word) tokens.push({ type: 'word', ...word });
    word = null;
  };
  const current = () => (word ??= newWord());
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (word === null && char === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (char === '\n') {
      endWord();
      tokens.push({ type: 'op', op: '\n' });
      i++;
      // Heredoc bodies start on the line after their operator.
      for (const doc of heredocs.splice(0)) {
        const body = [];
        while (i < text.length) {
          const end = text.indexOf('\n', i);
          const line = text.slice(i, end === -1 ? undefined : end);
          i = end === -1 ? text.length : end + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
          body.push(doc.stripTabs ? line.replace(/^\t+/, '') : line);
        }
        doc.body = body.join('\n');
      }
      continue;
    }
    if (char === ' ' || char === '\t') {
      endWord();
      i++;
      continue;
    }
    if (char === '\\') {
      if (text[i + 1] === '\n') i += 2;
      else {
        const w = current();
        w.quotedAt = Math.min(w.quotedAt, w.text.length);
        w.text += text[i + 1] ?? '';
        i += 2;
      }
      continue;
    }
    if (char === "'") {
      const w = current();
      w.quotedAt = Math.min(w.quotedAt, w.text.length);
      const end = text.indexOf("'", i + 1);
      w.text += text.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '"') {
      i = doubleQuoted(text, i, current());
      continue;
    }
    if (char === '$' && text[i + 1] === "'") {
      const w = current();
      w.quotedAt = Math.min(w.quotedAt, w.text.length);
      const { value, end } = decodeAnsi(text, i + 2);
      w.text += value;
      i = end + 1;
      continue;
    }
    if (char === '$' && text[i + 1] === '"') {
      i = doubleQuoted(text, i + 1, current());
      continue;
    }
    if (char === '`' || (char === '$' && text[i + 1] === '(')) {
      const w = current();
      w.quotedAt = Math.min(w.quotedAt, w.text.length);
      i = substitution(text, i, w);
      continue;
    }
    if (char === '$') {
      const w = current();
      const before = w.text.length;
      i = parameter(text, i, w);
      if (w.dynamic) w.quotedAt = Math.min(w.quotedAt, before);
      continue;
    }
    // Process substitution: <(cmd) or >(cmd) runs cmd and passes a file name.
    if ((char === '<' || char === '>') && text[i + 1] === '(' && word === null) {
      const w = current();
      w.dynamic = true;
      const end = closingParen(text, i + 2);
      w.subs.push(text.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    const redirect = REDIRECTS.find((op) => text.startsWith(op, i));
    if (redirect) {
      // Digits right before the operator name the file descriptor, as in 2>&1.
      const fd = word !== null && /^\d+$/.test(word.text) && word.quotedAt === Infinity && !word.dynamic ? word.text : null;
      if (fd === null) endWord();
      word = null;
      i += redirect.length;
      if (redirect === '<<' || redirect === '<<-') {
        const match = /^[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s'"<>;&|()]+))/.exec(text.slice(i));
        if (match) {
          const doc = { delimiter: match[1] ?? match[2] ?? match[3], quoted: match[1] !== undefined || match[2] !== undefined || match[0].includes('\\'), stripTabs: redirect === '<<-', body: '' };
          heredocs.push(doc);
          tokens.push({ type: 'redir', op: redirect, fd, heredoc: doc });
          i += match[0].length;
          continue;
        }
      }
      tokens.push({ type: 'redir', op: redirect, fd, target: null });
      continue;
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (op) {
      endWord();
      tokens.push({ type: 'op', op });
      i += op.length;
      continue;
    }
    const w = current();
    if (char === '*' || char === '?' || (char === '[' && /^\[[^\s\]]+\]/.test(text.slice(i)))) w.glob = true;
    if (char === '{' && /^\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(text.slice(i))) w.glob = true;
    if (char === '~' && w.text === '' && w.quotedAt === Infinity && (text[i + 1] === undefined || /[/\s;&|)]/.test(text[i + 1]))) w.text += HOME;
    else if (char === '~' && w.text === '' && w.quotedAt === Infinity && NAME.test(text.slice(i + 1))) {
      w.dynamic = true;
      w.text += char;
    } else w.text += char;
    i++;
  }
  endWord();
  // A redirect's target is the word after it.
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t].type === 'redir' && !tokens[t].heredoc && tokens[t + 1]?.type === 'word') {
      tokens[t].target = tokens.splice(t + 1, 1)[0];
    }
  }
  return tokens;
}

// Segmenting

const LEADING_KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac']);
const HEADERS = new Set(['for', 'select', 'case', 'function']);

const isAssignment = (word) => {
  const name = NAME.exec(word.text)?.[0];
  return Boolean(name) && word.text[name.length] === '=' && word.quotedAt > name.length;
};

// Splits tokens into simple commands, with '(' and ')' items around subshells. Each command knows
// its pipeline (commands joined by |), whether it sits in a loop body, and its redirects.
export function segments(text) {
  const items = [];
  let words = [];
  let redirs = [];
  let pipeline = 0;
  let loopDepth = 0;
  const flush = () => {
    if (!words.length && !redirs.length) return;
    let start = 0;
    let header = null;
    while (start < words.length && words[start].quotedAt === Infinity && !words[start].dynamic) {
      const text = words[start].text;
      if (HEADERS.has(text)) { header = start; break; }
      if (!LEADING_KEYWORDS.has(text)) break;
      if (text === 'while' || text === 'until') loopDepth++;
      if (text === 'done') loopDepth = Math.max(0, loopDepth - 1);
      start++;
    }
    if (header !== null) {
      if (['for', 'select'].includes(words[header].text)) loopDepth++;
      // A for loop's word list can hold substitutions, which run.
      for (const word of words) for (const sub of word.subs) items.push('(', ...segments(sub), ')');
    } else {
      const command = { words: words.slice(start), redirs, pipeline, loop: loopDepth > 0 };
      for (const word of words) for (const sub of word.subs) items.push('(', ...segments(sub), ')');
      for (const redir of redirs) for (const sub of redir.target?.subs ?? []) items.push('(', ...segments(sub), ')');
      for (const redir of redirs) if (redir.heredoc && !redir.heredoc.quoted) for (const sub of heredocSubstitutions(redir.heredoc.body)) items.push('(', ...segments(sub), ')');
      if (command.words.length || command.redirs.length) items.push(command);
    }
    words = [];
    redirs = [];
  };
  for (const token of lex(text)) {
    if (token.type === 'word') words.push(token);
    else if (token.type === 'redir') redirs.push(token);
    else {
      flush();
      if (token.op === '(' || token.op === ')') items.push(token.op);
      if (!['|', '|&'].includes(token.op)) pipeline++;
    }
  }
  flush();
  return items;
}

function heredocSubstitutions(body) {
  const word = newWord();
  for (let i = 0; i < body.length;) {
    if (body[i] === '\\') i += 2;
    else if (body[i] === '`' || (body[i] === '$' && body[i + 1] === '(')) i = substitution(body, i, word);
    else i++;
  }
  return word.subs;
}

// Resolving: wrappers, nested shells, folders

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);
const INTERPRETERS = {
  node: { code: ['-e', '--eval', '-p', '--print'], values: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--input-type', '--title'] },
  bun: { code: ['-e', '--eval', '-p', '--print'], values: [] },
  python: { code: ['-c'], values: ['-W', '-X', '-Q'], module: '-m' },
  python3: { code: ['-c'], values: ['-W', '-X', '-Q'], module: '-m' },
  perl: { code: ['-e', '-E'], values: ['-I', '-M', '-m'] },
  ruby: { code: ['-e'], values: ['-I', '-r', '-C'] },
  php: { code: ['-r'], values: ['-d', '-c'] },
  osascript: { code: ['-e'], values: ['-l'] },
};

// Wrappers run their remaining words as another command. Each lists the options that take a value.
// env, sudo, xargs and the shells have their own handling below.
const WRAPPERS = {
  nohup: [], command: ['-p'], exec: ['-a'], nice: ['-n', '--adjustment'], time: ['-o', '-f', '--output', '--format'],
  timeout: ['-k', '-s', '--kill-after', '--signal'], gtimeout: ['-k', '-s', '--kill-after', '--signal'],
  caffeinate: ['-t', '-w'], stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'], ionice: ['-c', '-n', '-p', '-t'],
  chronic: [], unbuffer: [], doas: ['-u', '-C'], builtin: [],
};

const wordOf = (text) => ({ text, dynamic: false, glob: false, quotedAt: 0, subs: [] });

function changeDirectory(cwd, words) {
  const name = words[0].text;
  const args = words.slice(1).filter((word) => !/^-[A-Za-z]+$/.test(word.text));
  if (name === 'popd' || args[0]?.text === '-') return null;
  if (!args.length) return name === 'cd' ? HOME : null;
  if (args[0].dynamic || args[0].glob) return null;
  const resolved = isAbsolute(args[0].text) ? args[0].text : cwd === null ? null : resolve(cwd, args[0].text);
  // A folder that does not exist yet may be made earlier on the line (mkdir x && cd x), so where
  // the next command runs is unknown.
  return resolved !== null && existsSync(resolved) ? resolved : null;
}

const dirIn = (cwd, word) => (word.dynamic || word.glob ? null : isAbsolute(word.text) ? word.text : cwd === null ? null : resolve(cwd, word.text));

// Takes options off the front of `words`, as getopt does. `valued` lists the options that take a
// value, short (`-u`) or long (`--unset`). Returns the options with their values.
function takeOptions(words, valued) {
  const options = [];
  while (words.length && words[0].text.startsWith('-') && words[0].text !== '-') {
    const [word] = words.splice(0, 1);
    const text = word.text;
    if (text === '--') break;
    if (text.startsWith('--')) {
      const [name, ...rest] = text.split('=');
      const next = !rest.length && valued.includes(name) ? words.splice(0, 1)[0] : null;
      options.push({ name, value: rest.length ? rest.join('=') : next?.text, dynamic: word.dynamic || Boolean(next?.dynamic) });
      continue;
    }
    for (let k = 1; k < text.length; k++) {
      const name = `-${text[k]}`;
      if (!valued.includes(name)) {
        options.push({ name, value: undefined, dynamic: false });
        continue;
      }
      const attached = text.slice(k + 1);
      const next = attached ? null : words.splice(0, 1)[0];
      options.push({ name, value: attached || next?.text, dynamic: word.dynamic || Boolean(next?.dynamic) });
      break;
    }
  }
  return options;
}

// Splits a string into words the way env -S and simple shells do, for strings that are not scripts.
function splitWords(text) {
  return segments(text).filter((item) => typeof item === 'object').flatMap((command) => command.words);
}

function makeEntry(words, state, extra = {}) {
  return {
    argv: words.map((word) => word.text),
    dynamic: words.map((word) => word.dynamic || word.glob),
    cwd: state.cwd,
    env: { ...state.env },
    pipeline: state.pipeline,
    loop: state.loop,
    stdin: state.stdin,
    interpreter: null,
    xargs: false,
    opaque: null,
    code: null,
    ...extra,
  };
}

// Resolves one simple command into the entries it runs. Returns the folder later commands run in.
function resolveCommand(command, state, out, depth) {
  if (depth > 8) {
    out.push(makeEntry([], state, { opaque: 'commands nested too deeply to read' }));
    return state.cwd;
  }
  let words = command.words.slice();
  const env = { ...state.env };
  while (words.length && isAssignment(words[0])) {
    const [word] = words.splice(0, 1);
    const name = NAME.exec(word.text)[0];
    env[name] = { value: word.text.slice(name.length + 1), dynamic: word.dynamic };
  }
  const here = { ...state, env };
  if (!words.length) {
    // A bare assignment changes a shell variable, which an exported one carries to later commands.
    if (Object.keys(env).length > Object.keys(state.env).length) out.push(makeEntry([], here, { assignsOnly: Object.keys(env).filter((name) => !(name in state.env)) }));
    return state.cwd;
  }
  return resolveWords(words, here, out, depth);
}

function resolveWords(words, state, out, depth) {
  words = words.slice();
  const first = words[0];
  if (first.dynamic || first.glob) {
    out.push(makeEntry(words, state, { opaque: `a command name built at run time (${first.text || '$...'})` }));
    return state.cwd;
  }
  const name = basename(first.text);
  if (['cd', 'pushd', 'popd'].includes(name)) return changeDirectory(state.cwd, words);
  if (SHELLS.has(name)) return resolveShell(words, state, out, depth);
  if (name === 'eval') {
    const args = words.slice(1);
    if (args.some((word) => word.dynamic)) {
      out.push(makeEntry(words, state, { opaque: 'eval of a string built at run time', code: args.map((word) => word.text).join(' ') }));
      return state.cwd;
    }
    return walk(segments(args.map((word) => word.text).join(' ')), state, out, depth + 1);
  }
  if (name === 'source' || name === '.') {
    if (words.length < 2) return state.cwd;
    out.push(makeEntry(words.slice(1), state, { interpreter: name }));
    return state.cwd;
  }
  if (name === 'env') {
    words.splice(0, 1);
    const options = takeOptions(words, ['-u', '-C', '-S', '-P', '-L', '-U', '-a', '--unset', '--chdir', '--split-string', '--argv0']);
    let cwd = state.cwd;
    for (const option of options) {
      if (['-C', '--chdir'].includes(option.name)) cwd = option.dynamic || option.value === undefined ? null : dirIn(cwd, wordOf(option.value));
    }
    const split = options.filter((option) => ['-S', '--split-string'].includes(option.name));
    if (split.some((option) => option.dynamic)) {
      out.push(makeEntry(words, state, { opaque: 'env -S with a string built at run time' }));
      return state.cwd;
    }
    words = [...split.flatMap((option) => splitWords(option.value ?? '')), ...words];
    const env = { ...state.env };
    while (words.length && isAssignment(words[0])) {
      const [word] = words.splice(0, 1);
      const key = NAME.exec(word.text)[0];
      env[key] = { value: word.text.slice(key.length + 1), dynamic: word.dynamic };
    }
    if (words.length) resolveWords(words, { ...state, cwd, env }, out, depth + 1);
    return state.cwd;
  }
  if (name === 'sudo') {
    words.splice(0, 1);
    const options = takeOptions(words, ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user']);
    if (options.some((option) => ['-e', '-l', '-v', '-k', '-K', '-V', '--edit', '--list', '--validate', '--version'].includes(option.name)) && !words.length) return state.cwd;
    let cwd = state.cwd;
    for (const option of options) if (['-D', '--chdir'].includes(option.name)) cwd = option.dynamic || option.value === undefined ? null : dirIn(cwd, wordOf(option.value));
    if (words.length) resolveWords(words, { ...state, cwd }, out, depth + 1);
    return state.cwd;
  }
  if (name === 'xargs') {
    words.splice(0, 1);
    takeOptions(words, ['-E', '-I', '-J', '-L', '-n', '-P', '-R', '-S', '-s', '-a', '-d', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--arg-file', '--delimiter', '--process-slot-var']);
    const inner = [];
    resolveWords(words.length ? words : [wordOf('echo')], state, inner, depth + 1);
    // xargs adds words it reads from stdin, so what it runs is never fully known here.
    out.push(...inner.map((entry) => ({ ...entry, xargs: true })));
    return state.cwd;
  }
  if (name === 'watch') {
    words.splice(0, 1);
    const options = takeOptions(words, ['-n', '-d', '-q', '--interval', '--differences', '--equexit', '--chgexit']);
    if (options.some((option) => ['-x', '--exec'].includes(option.name))) {
      if (words.length) resolveWords(words, state, out, depth + 1);
    } else walk(segments(words.map((word) => word.text).join(' ')), state, out, depth + 1);
    return state.cwd;
  }
  if (name === 'command' && words.slice(1).some((word) => ['-v', '-V'].includes(word.text))) return state.cwd;
  if (Object.hasOwn(WRAPPERS, name)) {
    words.splice(0, 1);
    takeOptions(words, WRAPPERS[name]);
    if (name.endsWith('timeout') && words.length) words.splice(0, 1);
    if (words.length) resolveWords(words, state, out, depth + 1);
    return state.cwd;
  }
  if (Object.hasOwn(INTERPRETERS, name) || /^python3\.\d+$/.test(name) || /^node\d*$/.test(name)) {
    const spec = INTERPRETERS[name] ?? INTERPRETERS[name.startsWith('python') ? 'python' : 'node'];
    const rest = words.slice(1);
    for (let k = 0; k < rest.length; k++) {
      const text = rest[k].text;
      if (spec.code.includes(text) || spec.code.some((flag) => flag.length === 2 && text.startsWith(flag) && text.length > 2 && !text.startsWith('--'))) {
        const code = spec.code.includes(text) ? rest[k + 1]?.text ?? '' : text.slice(2);
        out.push(makeEntry(words, state, { opaque: `${name} code given on the command line`, code }));
        return state.cwd;
      }
      if (spec.module && text === spec.module) {
        out.push(makeEntry(rest.slice(k + 1), state, { interpreter: `${name} -m` }));
        return state.cwd;
      }
      if (spec.values.includes(text)) { k++; continue; }
      if (text.startsWith('-')) continue;
      out.push(makeEntry(rest.slice(k), state, { interpreter: name }));
      return state.cwd;
    }
    out.push(makeEntry(words, state, { opaque: `${name} reading its program from stdin`, code: state.stdin?.text ?? null }));
    return state.cwd;
  }
  out.push(makeEntry(words, state));
  return state.cwd;
}

// sh -c 'script', sh script.sh args, or sh reading stdin (a heredoc, a here-string, a pipe, a file).
function resolveShell(words, state, out, depth) {
  const name = basename(words[0].text);
  const rest = words.slice(1);
  let command = false;
  let readsStdin = false;
  let k = 0;
  for (; k < rest.length; k++) {
    const text = rest[k].text;
    if (text === '--' || text === '-') { k++; break; }
    if (!/^[-+]/.test(text)) break;
    if (['--rcfile', '--init-file'].includes(text)) { k++; continue; }
    if (text.startsWith('--')) continue;
    // A cluster such as -ec or -o pipefail: o and O take the next word as their value.
    for (const flag of text.slice(1)) {
      if (flag === 'c') command = true;
      else if (flag === 's') readsStdin = true;
      else if (flag === 'o' || flag === 'O') k++;
    }
  }
  if (command) {
    const script = rest[k];
    if (!script) return state.cwd;
    if (script.dynamic) {
      out.push(makeEntry(words, state, { opaque: `${name} -c with a script built at run time`, code: script.text }));
      return state.cwd;
    }
    walk(segments(script.text), { ...state }, out, depth + 1);
    return state.cwd;
  }
  if (!readsStdin && rest[k]) {
    out.push(makeEntry(rest.slice(k), state, { interpreter: name }));
    return state.cwd;
  }
  const stdin = state.stdin;
  if (stdin?.kind === 'script') walk(segments(stdin.text), { ...state, stdin: null }, out, depth + 1);
  else out.push(makeEntry(words, state, { opaque: `${name} reading its script from ${stdin?.kind === 'pipe' ? 'a pipe' : stdin?.kind === 'file' ? 'a file' : 'stdin'}`, code: stdin?.text ?? null }));
  return state.cwd;
}

// What a command's stdin is: a heredoc or here-string (text the reader can see), a file, or a pipe.
function stdinOf(command, previousInPipeline) {
  for (const redir of command.redirs.slice().reverse()) {
    if (redir.fd !== null && redir.fd !== '0') continue;
    if (redir.heredoc) return redir.heredoc.quoted || !/[$`]/.test(redir.heredoc.body) ? { kind: 'script', text: redir.heredoc.body } : { kind: 'pipe', text: redir.heredoc.body };
    if (redir.op === '<<<') return redir.target && !redir.target.dynamic ? { kind: 'script', text: redir.target.text } : { kind: 'pipe', text: redir.target?.text ?? null };
    if (redir.op === '<' || redir.op === '<>') return { kind: 'file', text: null };
  }
  return previousInPipeline ? { kind: 'pipe', text: null } : null;
}

function walk(items, state, out, depth) {
  const saved = [];
  const walkId = state.counter.next++;
  let cwd = state.cwd;
  let previous = null;
  for (const item of items) {
    if (item === '(') saved.push(cwd);
    else if (item === ')') cwd = saved.length ? saved.pop() : cwd;
    else {
      const inPipe = previous !== null && previous.pipeline === item.pipeline;
      cwd = resolveCommand(item, { ...state, cwd, pipeline: `${walkId}:${item.pipeline}`, loop: state.loop || item.loop, stdin: stdinOf(item, inPipe) }, out, depth);
      previous = item;
    }
  }
  return cwd;
}

// Every simple command a command line runs, in order, as entries:
//   argv, dynamic   the words after quote removal, and which of them the shell builds at run time
//   cwd             the folder it runs in, or null when that cannot be known
//   env             variables assigned for it or earlier on the line
//   interpreter     set when a shell or interpreter runs the script named by argv[0]
//   xargs           set when xargs adds words read from stdin
//   opaque, code    why the reader cannot see what it runs, and the text it would run when known
//   pipeline, loop  which pipeline it is in, and whether it repeats in a loop body
export function shellCommands(text, startDir) {
  const out = [];
  walk(segments(text), { cwd: startDir, env: {}, loop: false, stdin: null, counter: { next: 0 } }, out, 0);
  return out;
}

// Commands given as an argument list, as Codex may send them: no shell reads them.
export function argvCommands(argv, startDir) {
  const out = [];
  resolveWords(argv.map((text) => wordOf(String(text))), { cwd: startDir, env: {}, pipeline: 'argv', loop: false, stdin: null, counter: { next: 0 } }, out, 0);
  return out;
}

// The command text a hook payload holds. Codex may hand it over as an argument list.
export function payloadCommand(payload) {
  const raw = payload.tool_input?.command;
  if (Array.isArray(raw)) return { argv: raw.map(String), text: raw.map(String).join(' ') };
  return typeof raw === 'string' ? { argv: null, text: raw } : null;
}
