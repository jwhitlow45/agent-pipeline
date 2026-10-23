// A strict reader for the few keys of a GitHub Actions workflow file the gate needs: the workflow's
// name, each job's `environment` (a string, or a mapping with `name`, keys in any order), and each
// job's `uses` (a reusable workflow it calls). The repository has no dependencies, so this reads
// block-style YAML by its indentation and says it cannot read anything else, rather than guess. A
// form it cannot read, or an environment named by an expression, comes back as `unreadable`, and so
// does anything it cannot prove the shape of: a byte-order mark, an indented root, a key that
// repeats, or a document with no top-level jobs. Only an empty text (a file proven absent) reads as
// no jobs at all.

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#:&*!|>%@`{[\]},?-][^#:]*?|[?-][^\s#:][^#:]*?)\s*:(?:\s+(.*))?$/;

// A line without its comment: a # at the start or after a space, outside quotes.
function withoutComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && !(quote === '"' && text[i - 1] === '\\')) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

const unquote = (text) => {
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return JSON.parse(text);
  if (/^'(?:[^']|'')*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
  return text;
};

// A scalar value the gate can be sure of, or null: plain or quoted, with no anchor, alias, tag,
// block indicator, flow collection or expression.
function scalar(text) {
  const value = text.trim();
  if (!value || /^[&*!|>[{%@`]/.test(value)) return null;
  if (/^["']/.test(value) && !/^"(?:[^"\\]|\\.)*"$|^'(?:[^']|'')*'$/.test(value)) return null;
  const read = unquote(value);
  return read.includes('${{') ? null : read;
}

// { name: production, url: https://x } on one line.
function flowMapping(text) {
  const value = text.trim();
  if (!/^\{.*\}$/.test(value)) return null;
  const body = value.slice(1, -1);
  const parts = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  if (quote || depth) return null;
  parts.push(body.slice(start));
  const map = new Map();
  for (const part of parts.map((entry) => entry.trim()).filter(Boolean)) {
    const found = /^("[^"]*"|'[^']*'|[^:]+?)\s*:\s+(.*)$/.exec(part);
    if (!found || map.has(unquote(found[1].trim()))) return null;
    map.set(unquote(found[1].trim()), found[2]);
  }
  return map;
}

const isItem = (line) => line.body === '-' || line.body.startsWith('- ');

export function readWorkflow(text) {
  const result = { name: null, environments: [], calls: [], unreadable: null };
  const fail = (why, line) => { result.unreadable = `${why}${line === undefined ? '' : ` (line ${line + 1})`}`; return result; };
  if (String(text).startsWith('\uFEFF')) return fail('it starts with a byte-order mark');
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((raw, index) => {
    const indent = /^ */.exec(raw)[0].length;
    return { index, raw, indent, body: withoutComment(raw.slice(indent)) };
  }).filter((line) => line.body !== '');
  if (lines.some((line) => /^\t/.test(line.raw.slice(line.indent)))) return fail('it indents with a tab');
  if (lines.filter((line) => line.indent === 0 && line.body === '---').length > 1 || lines.some((line) => line.indent === 0 && /^(---|\.\.\.)\s*\S/.test(line.body))) return fail('it holds more than one YAML document');
  const content = lines.filter((line) => !(line.indent === 0 && ['---', '...'].includes(line.body)));
  if (!content.length) return result;
  // A root mapping YAML allows at any indent would hide every key from a reader that looks at 0.
  if (content[0].indent !== 0) return fail('its top level is indented', content[0].index);
  const top = content.filter((line) => line.indent === 0);
  const topKeys = new Set();
  for (const line of top) {
    const key = KEY.exec(line.body);
    if (!key) return fail('a top-level line is not a key', line.index);
    const name = unquote(key[1]);
    if (name === '<<') return fail('it merges a mapping in at the top', line.index);
    if (topKeys.has(name)) return fail(`the top-level key ${name} repeats`, line.index);
    topKeys.add(name);
    if (name === 'name' && key[2]) result.name = scalar(key[2]);
  }
  const jobsAt = lines.findIndex((line) => line.indent === 0 && unquote(KEY.exec(line.body)?.[1] ?? '') === 'jobs');
  if (jobsAt === -1) return fail('it has no top-level jobs');
  const jobsKey = KEY.exec(lines[jobsAt].body);
  if (jobsKey[2]) return fail('its jobs are not a block mapping', lines[jobsAt].index);
  const end = lines.findIndex((line, i) => i > jobsAt && line.indent === 0);
  const region = lines.slice(jobsAt + 1, end === -1 ? undefined : end);
  if (!region.length) return fail('its jobs are empty', lines[jobsAt].index);
  const jobIds = new Set();
  const jobIndent = region[0].indent;
  for (let i = 0; i < region.length; i++) {
    const line = region[i];
    if (line.indent < jobIndent) return fail('a job is indented less than the others', line.index);
    if (line.indent > jobIndent) continue;
    const job = KEY.exec(line.body);
    if (!job || unquote(job[1]) === '<<') return fail('a job is not a plain key', line.index);
    if (jobIds.has(unquote(job[1]))) return fail(`job ${unquote(job[1])} repeats`, line.index);
    jobIds.add(unquote(job[1]));
    if (job[2]) return fail(`job ${unquote(job[1])} is not a block mapping`, line.index);
    const body = [];
    for (let k = i + 1; k < region.length && region[k].indent > jobIndent; k++) body.push(region[k]);
    if (!body.length) continue;
    const keyIndent = body[0].indent;
    const jobKeys = new Set();
    for (let k = 0; k < body.length; k++) {
      const entry = body[k];
      if (entry.indent < keyIndent) return fail(`job ${unquote(job[1])} has a key indented less than its others`, entry.index);
      // YAML lets a key's list start at the key's own indent (steps:\n- uses: ...).
      if (entry.indent > keyIndent || isItem(entry)) continue;
      const found = KEY.exec(entry.body);
      if (!found) return fail(`a line of job ${unquote(job[1])} is not a key`, entry.index);
      const key = unquote(found[1]);
      if (key === '<<') return fail(`job ${unquote(job[1])} merges a mapping in`, entry.index);
      if (jobKeys.has(key)) return fail(`job ${unquote(job[1])} sets ${key} twice`, entry.index);
      jobKeys.add(key);
      if (key === 'uses') {
        const uses = scalar(found[2] ?? '');
        if (uses === null) return fail(`job ${unquote(job[1])} calls a workflow the gate cannot read`, entry.index);
        result.calls.push(uses);
      }
      if (key !== 'environment') continue;
      const nested = [];
      for (let m = k + 1; m < body.length && body[m].indent > keyIndent; m++) nested.push(body[m]);
      const inline = found[2] ?? '';
      if (inline) {
        if (nested.length) return fail('an environment continues on the next line', entry.index);
        const map = /^\{/.test(inline.trim()) ? flowMapping(inline) : null;
        const name = map ? (map.has('name') ? scalar(map.get('name')) : null) : scalar(inline);
        if (name === null) return fail('an environment is an expression or a form the gate cannot read', entry.index);
        result.environments.push(name);
        continue;
      }
      if (!nested.length) return fail('an environment is empty', entry.index);
      const fieldIndent = nested[0].indent;
      const fields = new Set();
      let name;
      for (const field of nested) {
        if (field.indent < fieldIndent) return fail('an environment field is indented less than the others', field.index);
        if (field.indent > fieldIndent || isItem(field)) continue;
        const pair = KEY.exec(field.body);
        if (!pair) return fail('an environment is not a mapping', field.index);
        if (unquote(pair[1]) === '<<') return fail('an environment merges a mapping in', field.index);
        if (fields.has(unquote(pair[1]))) return fail(`an environment sets ${unquote(pair[1])} twice`, field.index);
        fields.add(unquote(pair[1]));
        if (unquote(pair[1]) === 'name') {
          name = scalar(pair[2] ?? '');
          if (name === null) return fail('an environment name is an expression or a form the gate cannot read', field.index);
        }
      }
      if (name === undefined) return fail('an environment mapping has no name', entry.index);
      result.environments.push(name);
    }
  }
  return result;
}
