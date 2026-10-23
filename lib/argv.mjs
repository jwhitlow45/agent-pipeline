// Option parsers for the commands the gate reads, each the way its program parses: clap for jj,
// pflag for gh, and git's parse-options, which also takes a unique prefix of a long option and a
// --no- form. A spec maps each long name to 'value' or 'flag', and each short letter to its long name.
// Words are { text, dynamic }, so a value built at run time stays marked.

const longName = (spec, text) => (Object.hasOwn(spec.long, text) ? text : spec.aliases?.[text] ?? null);

// clap (jj) and pflag (gh) agree on everything the gate needs: --name=value, --name value, -x value,
// -xvalue, -x=value, and clusters of short flags. Neither takes abbreviations.
export function parseOptions(words, spec) {
  const options = [];
  const positionals = [];
  const unknown = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const text = word.text;
    if (text === '--') {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (text.startsWith('--') && text.length > 2) {
      const eq = text.indexOf('=');
      const name = longName(spec, eq === -1 ? text.slice(2) : text.slice(2, eq));
      if (!name) { unknown.push(text); continue; }
      if (spec.long[name] === 'value') {
        const next = eq === -1 ? words[++i] : null;
        options.push({ name, value: eq === -1 ? next?.text : text.slice(eq + 1), dynamic: Boolean(word.dynamic || next?.dynamic), missing: eq === -1 && !next });
      } else options.push({ name, value: eq === -1 ? true : text.slice(eq + 1), dynamic: Boolean(word.dynamic) });
      continue;
    }
    if (text.startsWith('-') && text.length > 1) {
      for (let k = 1; k < text.length; k++) {
        const name = spec.short?.[text[k]];
        if (!name) { unknown.push(`-${text[k]}`); break; }
        if (spec.long[name] !== 'value') {
          options.push({ name, value: true, dynamic: Boolean(word.dynamic) });
          continue;
        }
        const attached = text.slice(k + 1).replace(/^=/, '');
        const next = attached ? null : words[++i];
        options.push({ name, value: attached || next?.text, dynamic: Boolean(word.dynamic || next?.dynamic), missing: !attached && !next });
        break;
      }
      continue;
    }
    positionals.push(word);
  }
  const values = (name) => options.filter((option) => option.name === name);
  return { options, positionals, unknown, has: (name) => values(name).length > 0, values, last: (name) => values(name).at(-1) };
}

// git's parse-options. `negatable` lists the long names that also take a --no- form. Options with an
// optional value (`optional`) take it only after =. Returns options in order, with `negated` set for
// a --no- form, so a later --no-dry-run undoes an earlier --dry-run.
export function parseGitOptions(words, spec) {
  const options = [];
  const positionals = [];
  const unknown = [];
  const names = Object.keys(spec.long);
  const candidates = [...names.map((name) => ({ text: name, name, negated: false })), ...(spec.negatable ?? []).map((name) => ({ text: `no-${name}`, name, negated: true }))];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const text = word.text;
    if (text === '--') {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (text.startsWith('--') && text.length > 2) {
      const eq = text.indexOf('=');
      const typed = eq === -1 ? text.slice(2) : text.slice(2, eq);
      const exact = candidates.find((candidate) => candidate.text === typed);
      const prefixed = exact ? [exact] : candidates.filter((candidate) => candidate.text.startsWith(typed));
      if (prefixed.length !== 1) { unknown.push(prefixed.length ? `${text} (ambiguous)` : text); continue; }
      const { name, negated } = prefixed[0];
      const kind = spec.long[name];
      if (kind === 'value' && !negated) {
        const next = eq === -1 ? words[++i] : null;
        options.push({ name, negated, value: eq === -1 ? next?.text : text.slice(eq + 1), dynamic: Boolean(word.dynamic || next?.dynamic) });
      } else options.push({ name, negated, value: eq === -1 ? true : text.slice(eq + 1), dynamic: Boolean(word.dynamic) });
      continue;
    }
    if (text.startsWith('-') && text.length > 1) {
      for (let k = 1; k < text.length; k++) {
        const name = spec.short?.[text[k]];
        if (!name) { unknown.push(`-${text[k]}`); break; }
        if (spec.long[name] !== 'value') {
          options.push({ name, negated: false, value: true, dynamic: Boolean(word.dynamic) });
          continue;
        }
        const attached = text.slice(k + 1);
        const next = attached ? null : words[++i];
        options.push({ name, negated: false, value: attached || next?.text, dynamic: Boolean(word.dynamic || next?.dynamic) });
        break;
      }
      continue;
    }
    positionals.push(word);
  }
  return { options, positionals, unknown };
}

// TOML arrays of strings, as `jj config get aliases.x` prints them.
export function parseTomlStrings(text) {
  const out = [];
  const body = text.trim();
  if (!body.startsWith('[') || !body.endsWith(']')) return null;
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(,|$)/y;
  const inner = body.slice(1, -1).trim().replace(/,\s*$/, '');
  pattern.lastIndex = 0;
  while (pattern.lastIndex < inner.length) {
    const match = pattern.exec(inner);
    if (!match) return null;
    out.push(match[1] !== undefined ? JSON.parse(`"${match[1]}"`) : match[2]);
    if (!match[3]) break;
  }
  return out;
}
