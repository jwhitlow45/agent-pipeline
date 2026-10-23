// The exact options the gate lets a read through with. A read that writes a file or runs a program
// does so through an option (sort -o, git diff --output, git grep -O, jj diff --tool), and git and
// getopt programs also take a unique prefix of a long option, so only the options listed here, spelled
// in full, pass. Anything else is refused, and the agent runs the plain form.
//
// A spec lists short letters that take no value (`flags`), take one (`values`), or take one only
// when attached (`attached`, as git's -uno), and long options that take no value (`long`), one
// (`longValues`, with its count when more than one), or one only after = (`longOptional`). `numeric`
// allows -5 for a count, and `any` marks a command whose every word is data.

export const spec = ({ flags = '', values = '', attached = '', long = [], longValues = [], longOptional = [], numeric = false, any = false, maxPositionals = Infinity, noPlus = false }) => ({
  flags: new Set(flags), values: new Set(values), attached: new Set(attached),
  long: new Set(long), longValues: new Map(longValues.map((entry) => (Array.isArray(entry) ? entry : [entry, 1]))), longOptional: new Set(longOptional),
  numeric, any, maxPositionals, noPlus,
});

// Reads a command's arguments by a spec, the one place clusters (-sSLo out) and attached forms
// (--opt=value, -ovalue) are taken apart. Returns the first word the spec does not allow (`problem`),
// every option with its value or values (`pairs`, short options named as -x and long ones as
// --name), and the positionals. Every check of an option's value reads `pairs`, never the raw words.
export function parseWords(options, words) {
  const pairs = [];
  const positionals = [];
  const done = (problem) => ({ problem, pairs, positionals });
  if (!options) return done(words.find((word) => word.startsWith('-') && word !== '-') ?? null);
  if (options.any) return done(null);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--') {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = eq === -1 ? word : word.slice(0, eq);
      if (eq !== -1) {
        if (!options.longValues.has(name) && !options.longOptional.has(name)) return done(word);
        pairs.push({ option: name, values: [word.slice(eq + 1)] });
        continue;
      }
      if (options.long.has(name) || options.longOptional.has(name)) {
        pairs.push({ option: name, values: [] });
        continue;
      }
      if (!options.longValues.has(name)) return done(word);
      const count = options.longValues.get(name);
      if (i + count >= words.length) return done(word);
      pairs.push({ option: name, values: words.slice(i + 1, i + 1 + count) });
      i += count;
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      if (options.numeric && /^-\d+$/.test(word)) {
        pairs.push({ option: '-n', values: [word.slice(1)] });
        continue;
      }
      for (let k = 1; k < word.length; k++) {
        const letter = word[k];
        if (options.flags.has(letter)) {
          pairs.push({ option: `-${letter}`, values: [] });
          continue;
        }
        if (options.attached.has(letter)) {
          pairs.push({ option: `-${letter}`, values: [word.slice(k + 1)] });
          break;
        }
        if (!options.values.has(letter)) return done(word);
        if (k === word.length - 1) {
          if (i + 1 >= words.length) return done(word);
          pairs.push({ option: `-${letter}`, values: [words[++i]] });
        } else pairs.push({ option: `-${letter}`, values: [word.slice(k + 1).replace(/^=/, '')] });
        break;
      }
      continue;
    }
    if (options.noPlus && word.startsWith('+')) return done(word);
    positionals.push(word);
  }
  return done(positionals.length > options.maxPositionals ? positionals[options.maxPositionals] : null);
}

// Every value one option takes in words a full spec does not cover, such as curl's on a line the
// gate does not gate: --long value, --long=value, -x value, and -x at the end of a cluster or with
// its value attached (-sSw@f). Any letter before x is taken for a flag, so a cluster that hides the
// option counts it, which can only refuse more.
export function clusterValues(words, short, long, { prefixes = false } = {}) {
  const values = [];
  // getopt_long takes any unique prefix of a long option (wget --confi is --config). A prefix that
  // other options share is one the program refuses itself, so counting it too only refuses more.
  const names = (word) => {
    const name = word.split('=')[0];
    return Boolean(long) && (name === long || (prefixes && name.length > 2 && long.startsWith(name)));
  };
  words.forEach((word, i) => {
    if (word === '--' || !word.startsWith('-')) return;
    if (word.startsWith('--')) {
      if (names(word)) values.push(word.includes('=') ? word.slice(word.indexOf('=') + 1) : (words[i + 1] ?? ''));
      return;
    }
    if (short && new RegExp(`^-[A-Za-z0-9]*${short}`).test(word)) {
      const rest = word.slice(word.indexOf(short, 1) + 1);
      values.push(rest || (words[i + 1] ?? ''));
    }
  });
  return values;
}

// The first word a spec does not allow, or null.
export const optionProblem = (options, words) => parseWords(options, words).problem;

// Shell commands the gate reads as reads: the core of their BSD and GNU options, without the ones
// that write a file (sort -o, tree -o, xxd's second file), run a program (man -P, rg --pre, less's
// + commands, bat --pager) or decompress through one (rg -z).
const GREP = spec({
  flags: 'rRnivlLcwxEFGoHhsqIaUzZTbPy', values: 'ABCemfdD',
  long: ['--recursive', '--dereference-recursive', '--line-number', '--ignore-case', '--no-ignore-case', '--invert-match', '--files-with-matches', '--files-without-match', '--count', '--word-regexp', '--line-regexp', '--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--only-matching', '--with-filename', '--no-filename', '--no-messages', '--quiet', '--silent', '--text', '--null', '--null-data', '--line-buffered', '--byte-offset', '--initial-tab', '--version', '--help'],
  longValues: ['--include', '--exclude', '--exclude-dir', '--exclude-from', '--max-count', '--after-context', '--before-context', '--regexp', '--file', '--label', '--devices', '--directories', '--binary-files'],
  longOptional: ['--color', '--colour', '--context'],
});
export const READ_OPTIONS = {
  ls: spec({ flags: 'aAlhRtrSdF1GpcuikmnosTUL@', long: ['--all', '--almost-all', '--human-readable', '--recursive', '--classify', '--directory', '--reverse', '--size', '--group-directories-first', '--full-time', '--inode', '--dereference'], longValues: ['--sort', '--time', '--ignore', '--hide'], longOptional: ['--color', '--colour', '--time-style', '--indicator-style'] }),
  pwd: spec({ flags: 'LP' }),
  cat: spec({ flags: 'benstuvAET', long: ['--number', '--number-nonblank', '--show-all', '--show-ends', '--show-tabs', '--squeeze-blank'] }),
  head: spec({ flags: 'qv', values: 'nc', numeric: true, longValues: ['--lines', '--bytes'], long: ['--quiet', '--silent', '--verbose'] }),
  tail: spec({ flags: 'fFqrv', values: 'nc', numeric: true, longValues: ['--lines', '--bytes', '--pid', '--sleep-interval'], long: ['--quiet', '--silent', '--verbose', '--retry'], longOptional: ['--follow'] }),
  grep: GREP, egrep: GREP, fgrep: GREP,
  wc: spec({ flags: 'lwcmL', long: ['--lines', '--words', '--bytes', '--chars', '--max-line-length'] }),
  sort: spec({ flags: 'nrufbhVsgMdiRcCmz', values: 'ktS', long: ['--numeric-sort', '--reverse', '--unique', '--ignore-case', '--ignore-leading-blanks', '--human-numeric-sort', '--version-sort', '--stable', '--general-numeric-sort', '--month-sort', '--dictionary-order', '--random-sort', '--merge', '--zero-terminated', '--ignore-nonprinting'], longValues: ['--key', '--field-separator', '--buffer-size'], longOptional: ['--check'] }),
  cut: spec({ flags: 'snw', values: 'dfcb', long: ['--complement', '--only-delimited'], longValues: ['--delimiter', '--fields', '--characters', '--bytes', '--output-delimiter'] }),
  tr: spec({ flags: 'cdsCu', long: ['--complement', '--delete', '--squeeze-repeats', '--truncate-set1'] }),
  uniq: spec({ flags: 'cdDuiz', values: 'fsw', long: ['--count', '--repeated', '--unique', '--ignore-case', '--zero-terminated'], longValues: ['--skip-fields', '--skip-chars', '--check-chars'], longOptional: ['--all-repeated', '--group'], maxPositionals: 1 }),
  column: spec({ flags: 'txne', values: 'scoN', long: ['--table', '--fillrows', '--json'], longValues: ['--separator', '--output-separator', '--table-columns', '--output-width'] }),
  jq: spec({ flags: 'rjacnesSCMRe', values: 'fL', long: ['--raw-output', '--join-output', '--ascii-output', '--compact-output', '--null-input', '--exit-status', '--slurp', '--sort-keys', '--color-output', '--monochrome-output', '--raw-input', '--tab', '--seq', '--stream', '--raw-output0', '--args', '--jsonargs'], longValues: ['--indent', ['--arg', 2], ['--argjson', 2], ['--slurpfile', 2], ['--rawfile', 2], '--from-file'] }),
  echo: spec({ any: true }), printf: spec({ any: true }), true: spec({ any: true }), false: spec({ any: true }), test: spec({ any: true }), '[': spec({ any: true }), sleep: spec({ any: true }),
  date: spec({ flags: 'ujRn', values: 'rvfdz', long: ['--utc', '--universal', '--rfc-email', '--debug'], longValues: ['--date', '--reference', '--rfc-3339'], longOptional: ['--iso-8601'] }),
  which: spec({ flags: 'as' }),
  // Lookups that only print where a name is found. hash with -p, -d or -r changes that, so it is
  // not on its list.
  type: spec({ flags: 'afpPtswSm' }),
  whence: spec({ flags: 'vcwfpamsS' }),
  where: spec({ flags: 'pmsSw' }),
  hash: spec({ flags: 'ltLm' }),
  file: spec({ flags: 'bLhiIkNnprsz0', values: 'mfeFP', long: ['--mime-type', '--mime', '--mime-encoding', '--brief', '--dereference', '--no-dereference'] }),
  stat: spec({ flags: 'LnqrsxlF', values: 'fct', long: ['--dereference', '--terse', '--file-system'], longValues: ['--format', '--printf'] }),
  du: spec({ flags: 'ahcskmxgHLP0Al', values: 'dBt', long: ['--summarize', '--human-readable', '--all', '--total', '--apparent-size', '--one-file-system', '--bytes', '--si', '--dereference'], longValues: ['--max-depth', '--exclude', '--threshold', '--block-size'] }),
  df: spec({ flags: 'ahkHilmPTg', values: 't', long: ['--human-readable', '--si', '--all', '--local', '--inodes', '--portability', '--print-type'], longValues: ['--type', '--exclude-type'], longOptional: ['--output'] }),
  basename: spec({ flags: 'az', values: 's', long: ['--multiple', '--zero'], longValues: ['--suffix'] }),
  dirname: spec({ flags: 'z', long: ['--zero'] }),
  realpath: spec({ flags: 'qsezLPm', long: ['--quiet', '--strip', '--no-symlinks', '--canonicalize-existing', '--canonicalize-missing', '--zero', '--logical', '--physical'], longValues: ['--relative-to', '--relative-base'] }),
  readlink: spec({ flags: 'fenmqsvz', long: ['--canonicalize', '--canonicalize-existing', '--canonicalize-missing', '--no-newline', '--quiet', '--silent', '--verbose', '--zero'] }),
  diff: spec({ flags: 'uNrqwbBiyacEtTpsZ', values: 'UCLxXIFSDW', long: ['--recursive', '--new-file', '--unidirectional-new-file', '--brief', '--report-identical-files', '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines', '--ignore-case', '--side-by-side', '--text', '--strip-trailing-cr', '--no-dereference', '--normal', '--minimal', '--speed-large-files', '--suppress-common-lines', '--expand-tabs', '--initial-tab', '--show-c-function', '--ignore-tab-expansion', '--ignore-trailing-space'], longValues: ['--label', '--exclude', '--exclude-from', '--width', '--show-function-line', '--ignore-matching-lines', '--from-file', '--to-file'], longOptional: ['--unified', '--context', '--color'] }),
  cmp: spec({ flags: 'lsbz', values: 'in', long: ['--verbose', '--quiet', '--silent', '--print-bytes'], longValues: ['--bytes', '--ignore-initial'] }),
  comm: spec({ flags: '123iuz', long: ['--check-order', '--nocheck-order', '--total', '--zero-terminated'], longValues: ['--output-delimiter'] }),
  nl: spec({ flags: 'p', values: 'bdfhilnsvw', longValues: ['--body-numbering', '--number-format', '--number-separator', '--number-width', '--starting-line-number', '--line-increment'] }),
  od: spec({ flags: 'bcdfhilosvxDOX', values: 'AjNtS', longValues: ['--address-radix', '--skip-bytes', '--read-bytes', '--format', '--strings', '--width'], long: ['--output-duplicates'] }),
  xxd: spec({ flags: 'aEipruCR', values: 'cglsno', maxPositionals: 1 }),
  hexdump: spec({ flags: 'bcCdovx', values: 'nsef' }),
  shasum: spec({ flags: 'bctp0U', values: 'a', long: ['--binary', '--check', '--text', '--status', '--quiet', '--warn', '--strict', '--tag', '--portable', '--UNIVERSAL'], longValues: ['--algorithm'] }),
  sha256sum: spec({ flags: 'bctwz', long: ['--binary', '--check', '--text', '--tag', '--quiet', '--status', '--strict', '--warn', '--zero'] }),
  md5sum: spec({ flags: 'bctwz', long: ['--binary', '--check', '--text', '--tag', '--quiet', '--status', '--strict', '--warn', '--zero'] }),
  md5: spec({ flags: 'pqrtx', values: 's' }),
  tree: spec({ flags: 'adflixACDFJNQSXghnpqrstuv', values: 'LIPHT', long: ['--gitignore', '--noreport', '--dirsfirst', '--du', '--prune', '--matchdirs', '--ignore-case', '--info'], longValues: ['--charset', '--filelimit', '--timefmt', '--sort'] }),
  uname: spec({ flags: 'amnoprsvi' }),
  whoami: spec({}),
  man: spec({ flags: 'kfaw', values: 'SsM' }),
  tee: spec({ flags: 'aip', long: ['--append', '--ignore-interrupts'] }),
  less: spec({ flags: 'NRSFXiIMmJngrsqeE', values: 'xbhyjz', noPlus: true, long: ['--RAW-CONTROL-CHARS', '--chop-long-lines', '--quit-if-one-screen', '--no-init', '--ignore-case', '--LINE-NUMBERS'] }),
  more: spec({ flags: 'dlfpcsu', values: 'n', noPlus: true }),
  bat: spec({ flags: 'pnAPu', values: 'lHrm', long: ['--plain', '--number', '--show-all', '--diff', '--list-languages', '--list-themes'], longValues: ['--language', '--highlight-line', '--line-range', '--map-syntax', '--style', '--theme', '--paging', '--color', '--decorations', '--tabs', '--wrap', '--terminal-width', '--file-name'] }),
  rg: spec({ flags: 'iInlvwxcoFsSLHNqa0uU.', values: 'egtTmABCMjfr', long: ['--hidden', '--no-ignore', '--files', '--files-with-matches', '--files-without-match', '--count', '--count-matches', '--json', '--fixed-strings', '--smart-case', '--ignore-case', '--case-sensitive', '--word-regexp', '--line-regexp', '--line-number', '--no-line-number', '--no-heading', '--heading', '--follow', '--multiline', '--vimgrep', '--only-matching', '--invert-match', '--with-filename', '--no-filename', '--null', '--no-messages', '--quiet', '--text', '--pcre2', '--trim', '--stats', '--type-list', '--no-config'], longValues: ['--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--after-context', '--before-context', '--color', '--colors', '--sort', '--sortr', '--replace', '--max-columns', '--max-depth', '--max-filesize', '--threads', '--regexp', '--file', '--encoding'] }),
  strings: spec({ flags: 'afo', values: 'nt', longValues: ['--bytes', '--radix', '--encoding'], long: ['--all'] }),
};

// git's reads. Revision, diff and format options are shared by the log and diff families. Left
// out on purpose: --output, --ext-diff, --textconv, -O / --open-files-in-pager, --exec, -c and
// --config, and anything git would read as a prefix of one.
const REVISION_DIFF = {
  flags: 'pusRwbzaMCBDWqmct1234',
  values: 'nSGUlL',
  long: ['--oneline', '--graph', '--decorate', '--no-decorate', '--all', '--branches', '--tags', '--remotes', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary', '--patch', '--no-patch', '--raw', '--reverse', '--no-merges', '--merges', '--first-parent', '--follow', '--abbrev-commit', '--no-abbrev-commit', '--left-right', '--left-only', '--right-only', '--cherry-pick', '--cherry-mark', '--cherry', '--boundary', '--topo-order', '--date-order', '--author-date-order', '--full-history', '--simplify-by-decoration', '--ancestry-path', '--source', '--use-mailmap', '--mailmap', '--no-mailmap', '--no-color', '--color-words', '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines', '--ignore-space-at-eol', '--ignore-cr-at-eol', '--minimal', '--patience', '--histogram', '--no-renames', '--check', '--full-index', '--binary', '--no-relative', '--text', '--exit-code', '--quiet', '--no-ext-diff', '--no-textconv', '--show-signature', '--parents', '--children', '--count', '--no-notes', '--root', '--cc', '--combined-all-paths', '--remerge-diff', '--no-walk', '--do-walk', '--objects', '--compact-summary', '--pickaxe-regex', '--pickaxe-all', '--function-context', '--log-size', '--dense', '--sparse', '--not', '--regexp-ignore-case', '--basic-regexp', '--extended-regexp', '--fixed-strings', '--perl-regexp', '--all-match', '--invert-grep', '--walk-reflogs', '--merge', '--show-pulls', '--clear-decorations', '--no-standard-notes', '--no-expand-tabs', '--full-diff', '--no-prefix', '--default-prefix', '--cached', '--staged', '--merge-base', '--no-index', '--ours', '--theirs', '--base', '--reflog', '--single-worktree', '--no-abbrev', '--no-stat', '--irreversible-delete', '--relative', '--shortstat', '--stdin', '--timestamp', '--header', '--no-diff-merges', '--first-parent', '--no-ext-diff', '--numbered', '--email', '--committer', '--no-dual-color', '--quiet'],
  longValues: ['--max-count', '--skip', '--since', '--after', '--until', '--before', '--author', '--committer', '--grep', '--format', '--date', '--diff-filter', '--diff-merges', '--diff-algorithm', '--encoding', '--inter-hunk-context', '--ws-error-highlight', '--since-as-filter', '--min-parents', '--max-parents', '--exclude', '--glob', '--decorate-refs', '--decorate-refs-exclude', '--output-indicator-new', '--output-indicator-old', '--output-indicator-context', '--src-prefix', '--dst-prefix', '--line-prefix', '--anchored', '--rotate-to', '--skip-to', '--ignore-matching-lines', '--stat-width', '--stat-count', '--stat-name-width', '--stat-graph-width', '--unified', '--word-diff-regex', '--color-moved-ws', '--creation-factor', '--group', '--abbrev'],
  longOptional: ['--pretty', '--abbrev', '--color', '--decorate', '--word-diff', '--stat', '--relative', '--submodule', '--dirstat', '--find-renames', '--find-copies', '--break-rewrites', '--notes', '--show-notes', '--color-moved', '--ignore-submodules', '--expand-tabs', '--show-linear-break', '--summary'],
  numeric: true,
};
const gitSpec = (extra = {}) => spec({
  ...REVISION_DIFF, ...extra,
  flags: `${REVISION_DIFF.flags}${extra.flags ?? ''}`, values: `${REVISION_DIFF.values}${extra.values ?? ''}`,
  long: [...REVISION_DIFF.long, ...(extra.long ?? [])], longValues: [...REVISION_DIFF.longValues, ...(extra.longValues ?? [])], longOptional: [...REVISION_DIFF.longOptional, ...(extra.longOptional ?? [])],
});
const LOG = gitSpec();
const GIT_STATUS = spec({ flags: 'sbvz', attached: 'u', long: ['--short', '--branch', '--long', '--verbose', '--no-column', '--ahead-behind', '--no-ahead-behind', '--renames', '--no-renames', '--show-stash', '--null', '--no-renames'], longOptional: ['--porcelain', '--untracked-files', '--ignored', '--ignore-submodules', '--column', '--find-renames'] });
const GIT_GREP = spec({ flags: 'nivlLcwEFGPhHoqIrapWz', values: 'efABCm', long: ['--cached', '--untracked', '--no-index', '--no-exclude-standard', '--exclude-standard', '--recurse-submodules', '--and', '--or', '--not', '--all-match', '--show-function', '--function-context', '--break', '--heading', '--no-color', '--null', '--count', '--name-only', '--files-with-matches', '--files-without-match', '--line-number', '--column', '--ignore-case', '--word-regexp', '--extended-regexp', '--basic-regexp', '--fixed-strings', '--perl-regexp', '--invert-match', '--full-name', '--text', '--only-matching', '--quiet', '--no-textconv'], longValues: ['--max-depth', '--threads', '--max-count', '--after-context', '--before-context', '--context'], longOptional: ['--color'], numeric: true });
const GIT_REV_PARSE = spec({ flags: 'q', long: ['--abbrev-ref', '--verify', '--quiet', '--show-toplevel', '--git-dir', '--absolute-git-dir', '--git-common-dir', '--show-prefix', '--show-cdup', '--is-inside-work-tree', '--is-inside-git-dir', '--is-bare-repository', '--is-shallow-repository', '--symbolic', '--symbolic-full-name', '--all', '--branches', '--tags', '--remotes', '--sq', '--sq-quote', '--show-object-format', '--show-ref-format', '--local-env-vars', '--end-of-options', '--revs-only', '--no-revs', '--flags', '--no-flags', '--not', '--show-superproject-working-tree'], longValues: ['--default', '--git-path', '--since', '--after', '--until', '--before', '--resolve-git-dir', '--prefix', '--exclude'], longOptional: ['--short', '--abbrev-ref', '--disambiguate'] });
const REF_FILTERS = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
export const GIT_READ_OPTIONS = {
  log: LOG, show: LOG, whatchanged: LOG, shortlog: LOG, 'rev-list': LOG, diff: LOG, 'diff-tree': LOG, 'diff-index': LOG, 'diff-files': LOG, 'range-diff': LOG, cherry: LOG, reflog: LOG,
  status: GIT_STATUS,
  grep: GIT_GREP,
  'rev-parse': GIT_REV_PARSE,
  'ls-files': spec({ flags: 'cdmoiskutvfzx', values: 'xX', long: ['--cached', '--deleted', '--modified', '--others', '--ignored', '--stage', '--unmerged', '--killed', '--exclude-standard', '--full-name', '--error-unmatch', '--directory', '--no-empty-directory', '--eol', '--deduplicate', '--recurse-submodules', '--sparse', '--resolve-undo', '--debug'], longValues: ['--exclude', '--exclude-from', '--exclude-per-directory', '--format', '--with-tree'], longOptional: ['--abbrev'] }),
  'ls-tree': spec({ flags: 'rtdlz', long: ['--long', '--name-only', '--name-status', '--object-only', '--full-name', '--full-tree'], longValues: ['--format'], longOptional: ['--abbrev'] }),
  'ls-remote': spec({ flags: 'htq', long: ['--heads', '--branches', '--tags', '--refs', '--quiet', '--exit-code', '--get-url', '--symref'], longValues: ['--sort'] }),
  'cat-file': spec({ flags: 'tsep', long: ['--use-mailmap', '--allow-unknown-type', '--batch-check', '--batch', '--batch-command', '--batch-all-objects', '--buffer', '--unordered', '--follow-symlinks', '-Z'] }),
  describe: spec({ long: ['--tags', '--all', '--long', '--always', '--exact-match', '--contains', '--first-parent', '--debug'], longValues: ['--match', '--exclude', '--candidates'], longOptional: ['--abbrev', '--dirty', '--broken'] }),
  'merge-base': spec({ flags: 'a', long: ['--is-ancestor', '--all', '--octopus', '--independent', '--fork-point'] }),
  'show-ref': spec({ flags: 'dsq', long: ['--heads', '--branches', '--tags', '--head', '--dereference', '--verify', '--quiet', '--exists'], longOptional: ['--hash', '--abbrev', '--exclude-existing'] }),
  'for-each-ref': spec({ long: ['--shell', '--perl', '--python', '--tcl', '--ignore-case', '--omit-empty', '--include-root-refs', '--stdin'], longValues: ['--format', '--sort', '--count', '--points-at', '--exclude', '--start-after'], longOptional: REF_FILTERS }),
  blame: spec({ flags: 'ltsewpbcfnMC', values: 'LS', long: ['--porcelain', '--line-porcelain', '--incremental', '--root', '--show-stats', '--show-name', '--show-number', '--show-email', '--reverse', '--first-parent', '--color-lines', '--color-by-age', '--progress', '--no-progress', '--score-debug', '--minimal'], longValues: ['--date', '--since', '--ignore-rev', '--ignore-revs-file', '--contents', '--encoding'], longOptional: ['--abbrev'] }),
  help: spec({ flags: 'agcmwi', long: ['--all', '--guides', '--config', '--man', '--web', '--info', '--verbose', '--no-external-commands', '--no-aliases', '--user-interfaces', '--developer-interfaces'] }),
  version: spec({ long: ['--build-options'] }),
  'name-rev': spec({ long: ['--tags', '--all', '--name-only', '--no-undefined', '--always', '--annotate-stdin', '--stdin'], longValues: ['--refs', '--exclude'] }),
  'patch-id': spec({ long: ['--stable', '--unstable', '--verbatim'] }),
  'verify-commit': spec({ flags: 'v', long: ['--verbose', '--raw'] }),
  'verify-tag': spec({ flags: 'v', long: ['--verbose', '--raw'], longValues: ['--format'] }),
  'check-ignore': spec({ flags: 'qvnz', long: ['--quiet', '--verbose', '--stdin', '--non-matching', '--no-index'] }),
  'check-attr': spec({ flags: 'az', long: ['--all', '--cached', '--stdin'], longValues: ['--source'] }),
  'count-objects': spec({ flags: 'vH', long: ['--verbose', '--human-readable'] }),
  var: spec({ flags: 'l' }),
  'show-branch': spec({ flags: 'ar', long: ['--all', '--remotes', '--topo-order', '--date-order', '--current', '--no-color', '--sha1-name', '--list', '--independent', '--merge-base', '--no-name', '--sparse'], longOptional: ['--color', '--more', '--reflog'] }),
  fsck: spec({ long: ['--full', '--strict', '--unreachable', '--dangling', '--no-dangling', '--root', '--tags', '--cache', '--no-reflogs', '--connectivity-only', '--name-objects', '--progress', '--no-progress', '--verbose', '--no-full'] }),
  branch: spec({ flags: 'larvi', long: ['--list', '--all', '--remotes', '--verbose', '--show-current', '--no-column', '--no-color', '--ignore-case', '--omit-empty', '--no-abbrev'], longValues: ['--sort', '--format', ...REF_FILTERS], longOptional: ['--color', '--abbrev', '--column'] }),
  tag: spec({ flags: 'liv', attached: 'n', long: ['--list', '--ignore-case', '--omit-empty', '--no-column', '--verify'], longValues: ['--sort', '--format', ...REF_FILTERS], longOptional: ['--color', '--column'] }),
  remote: spec({ flags: 'vn', long: ['--verbose', '--push', '--all'] }),
  config: spec({ flags: 'lfz', values: 'f', long: ['--get', '--get-all', '--get-regexp', '--list', '--global', '--system', '--local', '--worktree', '--show-origin', '--show-scope', '--name-only', '--null', '--bool', '--int', '--bool-or-int', '--path', '--expiry-date', '--includes', '--no-includes', '--fixed-value', '--all', '--regexp', '--get-urlmatch'], longValues: ['--file', '--blob', '--type', '--default', '--value', '--url'] }),
  stash: LOG,
  worktree: spec({ flags: 'vz', long: ['--porcelain', '--verbose'], longValues: ['--expire'] }),
  notes: LOG,
  submodule: spec({ flags: 'nq', long: ['--cached', '--recursive', '--files', '--quiet'], longValues: ['--summary-limit'] }),
};

// jj's reads. clap takes no abbreviations, so an exact list is what jj itself accepts. Left out on
// purpose: --tool, which runs a program for the diff.
const JJ_DIFF_FORMAT = { flags: 'swb', long: ['--summary', '--stat', '--types', '--name-only', '--git', '--color-words', '--ignore-all-space', '--ignore-space-change'], longValues: ['--context'] };
const jjSpec = ({ flags = '', values = '', long = [], longValues = [] } = {}, diff = true) => spec({
  flags: `${flags}${diff ? JJ_DIFF_FORMAT.flags : ''}`, values,
  long: [...long, ...(diff ? JJ_DIFF_FORMAT.long : [])], longValues: [...longValues, ...(diff ? JJ_DIFF_FORMAT.longValues : [])],
});
const JJ_LOG = jjSpec({ flags: 'pG', values: 'rnT', long: ['--reversed', '--no-graph', '--patch', '--count'], longValues: ['--revisions', '--limit', '--template'] });
export const JJ_READ_OPTIONS = {
  log: JJ_LOG,
  evolog: JJ_LOG, 'evolution-log': JJ_LOG,
  show: jjSpec({ values: 'rT', long: ['--no-patch'], longValues: ['--revision', '--template'] }),
  diff: jjSpec({ values: 'rftT', longValues: ['--revisions', '--from', '--to', '--template'] }),
  interdiff: jjSpec({ values: 'ft', longValues: ['--from', '--to'] }),
  status: jjSpec({}, false),
  help: jjSpec({ values: 'k', longValues: ['--keyword'] }, false),
  version: jjSpec({}, false),
  root: jjSpec({}, false),
  'bookmark list': jjSpec({ flags: 'atcq', values: 'rT', long: ['--all-remotes', '--all', '--tracked', '--conflicted'], longValues: ['--remote', '--revisions', '--template', '--sort'] }, false),
  'tag list': jjSpec({ values: 'rT', longValues: ['--revisions', '--template', '--sort'] }, false),
  'workspace list': jjSpec({ values: 'T', longValues: ['--template'] }, false),
  'workspace root': jjSpec({ longValues: ['--name'] }, false),
  'operation log': jjSpec({ flags: 'pd', values: 'nT', long: ['--reversed', '--no-graph', '--op-diff', '--patch'], longValues: ['--limit', '--template'] }),
  'operation show': jjSpec({ flags: 'p', values: 'T', long: ['--patch', '--no-op-diff', '--no-graph'], longValues: ['--template'] }),
  'operation diff': jjSpec({ flags: 'p', values: 'ft', long: ['--patch', '--no-graph'], longValues: ['--from', '--to', '--operation', '--op'] }),
  'config get': jjSpec({}, false),
  'config list': jjSpec({ values: 'T', long: ['--user', '--repo', '--workspace', '--include-defaults', '--include-overridden'], longValues: ['--template'] }, false),
  'config path': jjSpec({ long: ['--user', '--repo', '--workspace'] }, false),
  'file list': jjSpec({ values: 'rT', longValues: ['--revision', '--template'] }, false),
  'file show': jjSpec({ values: 'rT', longValues: ['--revision', '--template'] }, false),
  'file annotate': jjSpec({ values: 'rT', longValues: ['--revision', '--template'] }, false),
  'file search': jjSpec({ values: 'rp', longValues: ['--revision', '--pattern'] }, false),
  'git remote list': jjSpec({}, false),
  'git root': jjSpec({}, false),
  'sparse list': jjSpec({}, false),
  'util completion': jjSpec({ long: ['--bash', '--fish', '--zsh'] }, false),
  'util config-schema': jjSpec({}, false),
  'util markdown-help': jjSpec({}, false),
};

// A few allowed options of a spec, to name the plain form in a refusal.
export function someOptions(options) {
  if (!options) return '';
  const names = [...options.long, ...options.longValues.keys(), ...[...options.flags].map((letter) => `-${letter}`)].slice(0, 8);
  return names.length ? ` (such as ${names.join(', ')})` : '';
}
