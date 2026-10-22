// A shell command splitter for the gate, adapted from agent-review's. Approximate by design: it only
// needs to find the commands the gate checks (pushes, deploys, gh and review commands) and the
// directory each runs in. Command substitutions inside double quotes and unquoted heredocs run as
// subshells just before the command that holds them.

import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { HOME } from './util.mjs';

// Where a $( substitution that starts at `start` ends, skipping quoted text inside it.
function substitutionEnd(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') i++;
    else if (char === "'" || char === '"') {
      const end = text.indexOf(char, i + 1);
      i = end === -1 ? text.length : end;
    } else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i;
  }
  return text.length;
}

// The $( and backtick command substitutions in text that the shell expands, such as a double-quoted string.
function substitutions(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && text[i + 1] === '(') {
      const end = substitutionEnd(text, i + 2);
      found.push(text.slice(i + 2, end));
      i = end;
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      found.push(text.slice(i + 1, end === -1 ? undefined : end));
      i = end === -1 ? text.length : end;
    }
  }
  return found;
}

// Splits a shell command into simple commands (arrays of words), with '(' and ')' items marking subshells.
export function shellSegments(command) {
  const items = [];
  const heredocs = [];
  const pending = [];
  let backtickOpen = false;
  let tokens = [];
  let token = null;
  const subshell = (script) => items.push('(', ...shellSegments(script), ')');
  const endToken = () => { if (token !== null) tokens.push(token); token = null; };
  const endSegment = () => {
    endToken();
    pending.splice(0).forEach(subshell);
    if (tokens.length) items.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length;) {
    const char = command[i];
    const heredoc = char === '<' ? /^<<(-?)[ \t]*(['"]?)([^\s'"<>;&|()]+)\2/.exec(command.slice(i)) : null;
    if (heredoc) {
      // A heredoc body is data, so it is skipped at the end of the line rather than read as commands.
      endToken();
      heredocs.push({ delimiter: heredoc[3], stripTabs: heredoc[1] === '-', expands: heredoc[2] === '' });
      i += heredoc[0].length;
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1);
      token = (token ?? '') + command.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? command.length : end + 1;
    } else if (char === '"') {
      let j = i + 1;
      let value = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          value += command[j + 1];
          j += 2;
        } else if ((command[j] === '$' && command[j + 1] === '(') || command[j] === '`') {
          const end = command[j] === '`' ? command.indexOf('`', j + 1) : substitutionEnd(command, j + 2);
          const stop = end === -1 ? command.length : end;
          pending.push(command.slice(j + (command[j] === '`' ? 1 : 2), stop));
          value += command.slice(j, stop + 1);
          j = stop + 1;
        } else value += command[j++];
      }
      token = (token ?? '') + value;
      i = j + 1;
    } else if (char === '\\') {
      if (command[i + 1] !== '\n') token = (token ?? '') + (command[i + 1] ?? '');
      i += 2;
    } else if (char === '#' && token === null) {
      while (i < command.length && command[i] !== '\n') i++;
    } else if (char === '\n') {
      endSegment();
      i++;
      for (const { delimiter, stripTabs, expands } of heredocs.splice(0)) {
        const body = [];
        while (i < command.length) {
          const end = command.indexOf('\n', i);
          const line = command.slice(i, end === -1 ? undefined : end);
          i = end === -1 ? command.length : end + 1;
          if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
          body.push(line);
        }
        if (expands) substitutions(body.join('\n')).forEach(subshell);
      }
    } else if (char === '(' || char === ')' || char === '`') {
      endSegment();
      items.push(char === '`' ? (backtickOpen = !backtickOpen) ? '(' : ')' : char);
      i++;
    } else if (';&|'.includes(char)) {
      endSegment();
      i++;
    } else if (/\s/.test(char)) {
      endToken();
      i++;
    } else {
      token = (token ?? '') + char;
      i++;
    }
  }
  endSegment();
  return items;
}

// Commands that run their remaining arguments as another command, with their options that take a value.
const WRAPPERS = {
  caffeinate: ['-t', '-w'], timeout: ['-k', '-s', '--kill-after', '--signal'], gtimeout: ['-k', '-s', '--kill-after', '--signal'],
  nohup: [], env: ['-u', '-P', '-S', '-L', '-U'], command: [], exec: ['-a'], time: [], nice: ['-n'],
};
const SHELL_KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

// Drops redirections, leading variable assignments, shell keywords and wrappers, leaving the command that runs.
export function commandWords(tokens) {
  let words = [];
  for (let i = 0; i < tokens.length; i++) {
    if (/^(\d*|&)(>>?|<)$/.test(tokens[i])) i++;
    else if (!/^(\d*|&)(>>?|<)/.test(tokens[i])) words.push(tokens[i]);
  }
  for (;;) {
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || SHELL_KEYWORDS.has(words[0]))) words = words.slice(1);
    const name = basename(words[0] ?? '');
    if (!Object.hasOwn(WRAPPERS, name)) return words;
    const valueFlags = WRAPPERS[name];
    words = words.slice(1);
    while (words.length && words[0].startsWith('-') && words[0] !== '-') {
      const [flag] = words.splice(0, 1);
      if (flag === '--') break;
      if (valueFlags.includes(flag) && !flag.includes('=')) words.splice(0, 1);
      else if (/^-[^-]/.test(flag)) {
        const valueAt = [...flag.slice(1)].findIndex((char) => valueFlags.includes(`-${char}`));
        if (valueAt === flag.length - 2) words.splice(0, 1);
      }
    }
    if (name.endsWith('timeout') && words.length) words = words.slice(1);
  }
}

function changeDirectory(cwd, words) {
  const [name, ...args] = words;
  const target = args.find((arg) => !/^-./.test(arg));
  if (name === 'popd' || target === '-') return null;
  if (target === undefined) return name === 'cd' ? HOME : null;
  if (/[$`*?]/.test(target) || /^~[^/]/.test(target)) return null;
  const path = target.replace(/^~(?=$|\/)/, HOME);
  const resolved = isAbsolute(path) ? path : cwd === null ? null : resolve(cwd, path);
  // A cd that fails leaves the shell where it was, and a command after ; or || still runs there.
  return resolved !== null && existsSync(resolved) ? resolved : null;
}

// The script a shell runs with -c, or null when it runs a file or reads stdin.
function shellScript(words) {
  for (let i = 1; i < words.length; i++) {
    if (!words[i].startsWith('-')) return null;
    if (/^-[a-z]*c[a-z]*$/i.test(words[i])) return words.slice(i + 1).find((word) => !word.startsWith('-')) ?? null;
  }
  return null;
}

// Calls visit(words, cwd) for every simple command, where cwd is null when it cannot be known (cd to a
// variable or a missing directory, cd -, popd).
export function walkCommand(items, startDir, visit) {
  const saved = [];
  let cwd = startDir;
  for (const item of items) {
    if (item === '(') saved.push(cwd);
    else if (item === ')') cwd = saved.length ? saved.pop() : cwd;
    else {
      const words = commandWords(item);
      const name = basename(words[0] ?? '');
      if (['cd', 'pushd', 'popd'].includes(name)) cwd = changeDirectory(cwd, words);
      else if (SHELLS.has(name)) {
        const script = shellScript(words);
        if (script !== null) walkCommand(shellSegments(script), cwd, visit);
      } else if (name === 'eval') cwd = walkCommand(shellSegments(words.slice(1).join(' ')), cwd, visit);
      else visit(words, cwd);
    }
  }
  return cwd;
}

// Codex may hand the command over as an argument list rather than a string.
export function payloadCommand(payload) {
  const raw = payload.tool_input?.command;
  if (Array.isArray(raw)) return { items: [raw.map(String)], text: raw.join(' ') };
  return typeof raw === 'string' ? { items: null, text: raw } : null;
}
