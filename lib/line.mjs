// Reads one shell command line into simple commands, for the gate. It does not run or expand
// anything. Each word records whether the shell would change it before running: a word with an
// expansion ($, a backtick, a glob, a brace list, `=cmd` in zsh) is not literal, and the gate never
// guesses what it becomes. Constructs the gate does not allow on a gated line (`;`, `||`, `&`,
// subshells, loops, functions) are kept as separators, so the gate can name them in a refusal.

export class LineError extends Error {}

const OPERATORS = ['&&', '||', ';;&', ';;', ';&', ';|', '|&', ';', '&', '|', '(', ')', '\n'];
const REDIRECTS = ['&>>', '<<<', '<<-', '>>', '<<', '<>', '>|', '<&', '>&', '&>', '<', '>'];
export const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'time', 'coproc', '{', '}', '!', '[[', ']]', 'repeat', 'foreach', 'end']);
// Reserved words a command follows, as in `if curl ...` or `{ cd /tmp; }`: the word after them is a
// command again. They are kept apart from the command's words, as its leads.
export const LEADS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '{', '!', '}', 'fi', 'done', 'esac']);
// Reserved words whose next words are not a command: a loop variable and its list, the word a case
// tests, a test expression or a function name. They are kept as the command's header.
export const HEADERS = new Set(['for', 'select', 'foreach', 'case', '[[', 'function', 'coproc', 'repeat']);
const CASE_ENDS = new Set([';;', ';&', ';;&', ';|']);

// Finds the end of $( ), ${ } or a backtick span starting at i, so a word that holds one is read to
// its true end. Quotes inside are honored.
function skipNested(text, i, open, close) {
  let depth = 1;
  let k = i;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === "'" && open !== '`') {
      const end = text.indexOf("'", k + 1);
      if (end === -1) throw new LineError('a quote is not closed');
      k = end + 1;
      continue;
    }
    if (ch === '"' && open !== '`') { k = skipDouble(text, k + 1); continue; }
    if (open === '`') {
      if (ch === '`') return k + 1;
      k++;
      continue;
    }
    if (ch === '$' && text[k + 1] === '(') { k = skipNested(text, k + 2, '(', ')'); continue; }
    if (ch === '$' && text[k + 1] === '{') { k = skipNested(text, k + 2, '{', '}'); continue; }
    if (ch === '`') { k = skipNested(text, k + 1, '`', '`'); continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return k + 1;
    k++;
  }
  throw new LineError(`a ${open === '`' ? 'backtick' : `$${open}`} is not closed`);
}

// The index just past the closing double quote of a string that starts at i.
function skipDouble(text, i) {
  let k = i;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '"') return k + 1;
    if (ch === '$' && text[k + 1] === '(') { k = skipNested(text, k + 2, '(', ')'); continue; }
    if (ch === '$' && text[k + 1] === '{') { k = skipNested(text, k + 2, '{', '}'); continue; }
    if (ch === '`') { k = skipNested(text, k + 1, '`', '`'); continue; }
    k++;
  }
  throw new LineError('a quote is not closed');
}

const isSpace = (ch) => ch === ' ' || ch === '\t';
const startsOperator = (text, i) => OPERATORS.some((op) => text.startsWith(op, i));
const startsRedirect = (text, i) => REDIRECTS.find((op) => text.startsWith(op, i));

// One word starting at i. Returns { word, end }.
function readWord(text, i) {
  let value = '';
  let k = i;
  const word = { value: '', raw: '', literal: true, quoted: false, glob: false, brace: false, tilde: false };
  const dynamic = () => { word.literal = false; };
  if (text[k] === '=' ) dynamic();
  if (text[k] === '~') word.tilde = true;
  if ((text[k] === '<' || text[k] === '>') && text[k + 1] === '(') {
    const end = skipNested(text, k + 2, '(', ')');
    return { word: { ...word, literal: false, value: text.slice(i, end), raw: text.slice(i, end) }, end };
  }
  while (k < text.length) {
    const ch = text[k];
    if (isSpace(ch) || startsOperator(text, k) || ((ch === '<' || ch === '>') && !(text[k + 1] === '(' && k === i))) break;
    if (ch === '\\') {
      if (text[k + 1] === '\n') { k += 2; continue; }
      value += text[k + 1] ?? '';
      k += 2;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", k + 1);
      if (end === -1) throw new LineError('a quote is not closed');
      value += text.slice(k + 1, end);
      word.quoted = true;
      k = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = skipDouble(text, k + 1);
      const inner = text.slice(k + 1, end - 1);
      if (/[$`]/.test(inner.replace(/\\[$`"\\\n]/g, ''))) dynamic();
      value += inner.replace(/\\([$`"\\])/g, '$1').replace(/\\\n/g, '');
      word.quoted = true;
      k = end;
      continue;
    }
    if (ch === '$') {
      dynamic();
      if (text[k + 1] === '(') { const end = skipNested(text, k + 2, '(', ')'); value += text.slice(k, end); k = end; continue; }
      if (text[k + 1] === '{') { const end = skipNested(text, k + 2, '{', '}'); value += text.slice(k, end); k = end; continue; }
      if (text[k + 1] === "'") {
        let end = k + 2;
        while (end < text.length && text[end] !== "'") end += text[end] === '\\' ? 2 : 1;
        if (end >= text.length) throw new LineError('a quote is not closed');
        value += text.slice(k, end + 1);
        k = end + 1;
        continue;
      }
      value += ch;
      k++;
      continue;
    }
    if (ch === '`') {
      dynamic();
      const end = skipNested(text, k + 1, '`', '`');
      value += text.slice(k, end);
      k = end;
      continue;
    }
    if (ch === '*' || ch === '?' || ch === '[') word.glob = true;
    if (ch === '{' && /^\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(text.slice(k))) word.brace = true;
    value += ch;
    k++;
  }
  return { word: { ...word, value, raw: text.slice(i, k) }, end: k };
}

// Tokens of a line: words, operators and redirections, with each heredoc's body.
export function lex(text) {
  const tokens = [];
  const heredocs = [];
  let i = 0;
  let atCommandStart = true;
  let functionName = false;
  while (i < text.length) {
    const ch = text[i];
    if (isSpace(ch)) { i++; continue; }
    if (ch === '#' && (i === 0 || isSpace(text[i - 1]) || startsOperator(text, i - 1))) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '\n' && heredocs.length) {
      // Heredoc bodies start on the line after the operator, in order. A body the input ends inside
      // runs to the end, as bash, zsh and sh read it, so the rest is data and not commands.
      i++;
      for (const doc of heredocs.splice(0)) {
        const lines = [];
        for (;;) {
          if (i > text.length) break;
          const end = text.indexOf('\n', i);
          const line = text.slice(i, end === -1 ? text.length : end);
          i = end === -1 ? text.length + 1 : end + 1;
          const stripped = doc.strip ? line.replace(/^\t+/, '') : line;
          if (stripped === doc.delimiter) break;
          lines.push(stripped);
        }
        doc.token.body = lines.join('\n');
        doc.token.bodyLiteral = doc.quoted || !/[$`\\]/.test(doc.token.body);
      }
      tokens.push({ t: 'op', value: '\n' });
      atCommandStart = true;
      continue;
    }
    const fd = /^\d+(?=[<>])/.exec(text.slice(i))?.[0] ?? '';
    const redirect = startsRedirect(text, i + fd.length);
    if (redirect && !(text[i + fd.length + redirect.length] === '(' && (redirect === '<' || redirect === '>'))) {
      i += fd.length + redirect.length;
      while (isSpace(text[i])) i++;
      if (i >= text.length || startsOperator(text, i)) throw new LineError(`${redirect} has no target`);
      const { word, end } = readWord(text, i);
      i = end;
      const token = { t: 'redir', op: redirect, fd, target: word };
      if (redirect === '<<' || redirect === '<<-') {
        heredocs.push({ token, delimiter: word.value, quoted: word.quoted || word.raw.includes('\\'), strip: redirect === '<<-' });
      }
      tokens.push(token);
      continue;
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (op) {
      // A ( right after a word is zsh's glob flags (*(e:'cmd':) runs cmd) or bash's extglob, both
      // read by the shell as code or patterns the gate does not follow. f() defines a function.
      const previous = tokens.at(-1);
      if (op === '(' && previous?.t === 'word' && !isSpace(text[i - 1] ?? ' ') && !/^\(\s*\)/.test(text.slice(i))) throw new LineError(`a ( right after ${previous.raw}, which zsh reads as glob flags`);
      tokens.push({ t: 'op', value: op });
      i += op.length;
      atCommandStart = true;
      functionName = false;
      continue;
    }
    const { word, end } = readWord(text, i);
    i = end;
    // An assignment is one whatever its value: NAME=$x still sets NAME and is not the command.
    if (atCommandStart && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.raw)) {
      // NAME=(a b) sets an array, in bash and zsh: its words are values, not a command.
      if (/=$/.test(word.raw) && text[i] === '(') {
        const close = skipNested(text, i + 1, '(', ')');
        const raw = word.raw + text.slice(i, close);
        tokens.push({ t: 'word', ...word, raw, value: raw, literal: false, array: true, assign: true });
        i = close;
        continue;
      }
      tokens.push({ t: 'word', ...word, assign: true });
      continue;
    }
    if (atCommandStart && !word.quoted && RESERVED.has(word.value)) {
      tokens.push({ t: 'word', ...word, reserved: true });
      atCommandStart = LEADS.has(word.value) && !['}', 'fi', 'done', 'esac'].includes(word.value);
      functionName = word.value === 'function';
      continue;
    }
    // zsh's anonymous function: function { ... } runs at once.
    if (functionName && word.value === '{' && !word.quoted) {
      tokens.push({ t: 'word', ...word, reserved: true });
      functionName = false;
      continue;
    }
    tokens.push({ t: 'word', ...word });
    // After function NAME, the body's { starts a command.
    atCommandStart = functionName;
    functionName = false;
  }
  for (const doc of heredocs) {
    doc.token.body = '';
    doc.token.bodyLiteral = true;
  }
  return tokens;
}

// Simple commands in order. Each has its words, assignments and redirections, the operator that
// ended it, and its place: `segment` counts the && separated parts, `stage` its place in a pipe.
export function commands(tokens) {
  const out = [];
  let current = null;
  let segment = 0;
  let stage = 0;
  // One entry per open case: whether its next words are patterns, up to the ) that ends them.
  const cases = [];
  const flush = (ender) => {
    if (current) out.push({ ...current, ender });
    current = null;
  };
  const start = () => (current ??= { leads: [], words: [], assigns: [], redirs: [], header: [], segment, stage });
  const inHeader = () => current && HEADERS.has(current.leads.at(-1)?.value);
  for (const token of tokens) {
    const patterns = cases.at(-1) === 'patterns';
    if (token.t === 'op') {
      // A pipe continues past the end of its line, and past blank and comment lines after it, so
      // the command after them is the pipe's next stage.
      if (token.value === '\n' && !current && ['|', '|&'].includes(out.at(-1)?.op)) continue;
      // A case's patterns are words, and the | and ( ) around them are part of the case.
      if (patterns && ['|', '('].includes(token.value)) continue;
      if (patterns && token.value === ')') {
        flush(null);
        cases[cases.length - 1] = 'body';
        stage = 0;
        continue;
      }
      if (cases.at(-1) === 'body' && CASE_ENDS.has(token.value)) cases[cases.length - 1] = 'patterns';
      flush(token.value);
      if (token.value === '|' || token.value === '|&') stage++;
      else { stage = 0; segment++; }
      out.push({ op: token.value });
      continue;
    }
    if (token.reserved && token.value === 'esac' && cases.length) {
      flush(null);
      cases.pop();
      start().leads.push(token);
      continue;
    }
    if (patterns && token.t === 'word') {
      start().header.push(token);
      current.pattern = true;
      continue;
    }
    // A reserved word after function NAME starts the body as a command of its own.
    if (token.reserved && current && (current.words.length || current.header.length)) flush(null);
    start();
    if (token.t === 'redir') current.redirs.push(token);
    else if (token.reserved && (LEADS.has(token.value) || HEADERS.has(token.value)) && !current.words.length && !current.header.length) {
      current.leads.push(token);
      if (token.value === 'case') cases.push('word');
    } else if (token.assign && !current.words.length && !inHeader()) current.assigns.push(token);
    else if (inHeader()) {
      // function takes one name. The rest is the body.
      if (current.leads.at(-1).value === 'function' && current.header.length) {
        flush(null);
        start().words.push(token);
        continue;
      }
      current.header.push(token);
      if (current.leads.at(-1).value === 'case' && cases.at(-1) === 'word' && token.value === 'in' && current.header.length === 2) {
        flush(null);
        cases[cases.length - 1] = 'patterns';
      }
    } else current.words.push(token);
  }
  flush(null);
  return out;
}

// The command lists a word runs as the shell expands it: $( ), backticks, <( ) and >( ), and those
// inside ${ } and $(( )). Each body is source text the shell parses, so the gate reads it the same
// way. In a heredoc body (heredoc true) quotes are plain characters.
export function substitutions(raw, { heredoc = false } = {}) {
  const out = [];
  const scan = (text, from, to, double) => {
    let k = from;
    while (k < to) {
      const ch = text[k];
      if (ch === '\\') { k += 2; continue; }
      if (!heredoc && !double && ch === "'") {
        const end = text.indexOf("'", k + 1);
        k = end === -1 ? to : end + 1;
        continue;
      }
      if (!heredoc && ch === '"') { double = !double; k++; continue; }
      if (ch === '$' && text[k + 1] === "'" && !double && !heredoc) {
        let end = k + 2;
        while (end < to && text[end] !== "'") end += text[end] === '\\' ? 2 : 1;
        k = end + 1;
        continue;
      }
      if (ch === '$' && text[k + 1] === '(' && text[k + 2] === '(') {
        const end = skipNested(text, k + 2, '(', ')');
        const body = text.slice(k + 3, end - 2);
        // $(( )) is arithmetic when it reads as one. Otherwise bash runs it as a subshell.
        if (/^[\w\s+\-*\/%<>=!&|^~?:,.()$#{}[\]]*$/.test(body) && text[end - 2] === ')') scan(text, k + 3, end - 2, true);
        else out.push({ body: text.slice(k + 2, end - 1), kind: '$(' });
        k = end;
        continue;
      }
      if (ch === '$' && text[k + 1] === '(') {
        const end = skipNested(text, k + 2, '(', ')');
        out.push({ body: text.slice(k + 2, end - 1), kind: '$(' });
        k = end;
        continue;
      }
      if (ch === '$' && text[k + 1] === '{') {
        const end = skipNested(text, k + 2, '{', '}');
        scan(text, k + 2, end - 1, true);
        k = end;
        continue;
      }
      if (ch === '`') {
        const end = skipNested(text, k + 1, '`', '`');
        out.push({ body: text.slice(k + 1, end - 1), kind: '`' });
        k = end;
        continue;
      }
      if ((ch === '<' || ch === '>') && text[k + 1] === '(' && k === from && !double && !heredoc) {
        const end = skipNested(text, k + 2, '(', ')');
        out.push({ body: text.slice(k + 2, end - 1), kind: `${ch}(` });
        k = end;
        continue;
      }
      k++;
    }
  };
  scan(String(raw), 0, String(raw).length, false);
  return out;
}

// The line read for the gate, or `{ error }` when it cannot be read at all.
export function readLine(text) {
  try {
    const tokens = lex(String(text).replace(/\s+$/, ''));
    return { tokens, items: commands(tokens) };
  } catch (error) {
    if (error instanceof LineError) return { error: error.message };
    throw error;
  }
}
