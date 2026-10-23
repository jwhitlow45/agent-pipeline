// The shell reader on its own: quoting, wrappers, nested shells, folders and what it cannot read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { argvCommands, shellCommands } from '../lib/shell.mjs';
import { parseGitOptions, parseOptions, parseTomlStrings } from '../lib/argv.mjs';
import { HOME } from '../lib/util.mjs';

const dir = mkdtempSync(`${tmpdir()}/pipeline-shell-`);
const argvs = (text, cwd = dir) => shellCommands(text, cwd).map((entry) => entry.argv.join(' '));
const one = (text, cwd = dir) => {
  const entries = shellCommands(text, cwd).filter((entry) => entry.argv.length);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  return entries[0];
};

test('quotes are removed the way the shell removes them, $\'...\' included', () => {
  assert.equal(one('jj git pu"sh" --bookmark ci/x').argv.join(' '), 'jj git push --bookmark ci/x');
  assert.equal(one("$'jj' git push").argv[0], 'jj');
  assert.equal(one("echo $'a\\tb\\x41\\101'").argv[1], 'a\tbAA');
  assert.equal(one('echo "a \\"b\\" \\$c"').argv[1], 'a "b" $c');
  assert.equal(one("echo 'a \"b\"'").argv[1], 'a "b"');
  assert.equal(one('echo a\\ b').argv[1], 'a b');
});

test('a word built from a variable or a substitution is dynamic, and $HOME and ~ expand', () => {
  const entry = one('jj git push -b "$B" -b ci/x');
  assert.deepEqual(entry.dynamic, [false, false, false, false, true, false, false]);
  assert.equal(one('ls ~/x $HOME/y ${HOME}/z').argv.slice(1).join(' '), `${HOME}/x ${HOME}/y ${HOME}/z`);
  assert.equal(one('ls ci/*').dynamic[1], true);
  assert.equal(one('ls {a,b}').dynamic[1], true);
  assert.equal(one('[ -f x ]').dynamic[0], false);
  const named = shellCommands('J=jj; $J git push', dir).at(-1);
  assert.match(named.opaque, /command name built at run time/);
});

test('operators split commands, and redirects are not words', () => {
  assert.deepEqual(argvs('a && b || c; d | e |& f & g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(argvs('echo a>b 2>&1 &>log <in; ls'), ['echo a', 'ls']);
  assert.deepEqual(argvs('echo x # jj git push\nls'), ['echo x', 'ls']);
});

test('command substitutions run before the command that holds them', () => {
  assert.deepEqual(argvs('echo "$(jj git push -b ci/a)" `git push origin x`'), ['jj git push -b ci/a', 'git push origin x', 'echo  ']);
  assert.deepEqual(argvs('diff <(git show a) >(cat)'), ['git show a', 'cat', 'diff  ']);
});

test('wrappers run the command they wrap, with their own options skipped', () => {
  for (const text of ['sudo -u root jj git push', 'env -i A=1 jj git push', 'nohup jj git push', 'time -p jj git push', 'command jj git push', 'exec -a x jj git push', 'nice -n 5 jj git push', 'timeout -k 5 30 jj git push', 'caffeinate -i jj git push', 'env -S "jj git push"', 'watch -n 5 jj git push']) {
    assert.equal(one(text).argv.join(' '), 'jj git push', text);
  }
  assert.equal(one('env -C /usr jj git push').cwd, '/usr');
  assert.equal(one('sudo -D /usr jj git push').cwd, '/usr');
  assert.equal(shellCommands('echo x | xargs jj git push -b', dir)[1].xargs, true);
  assert.deepEqual(argvs('command -v git'), []);
});

test('a shell runs its -c script, a script file, a heredoc or a here-string', () => {
  assert.deepEqual(argvs("bash -o pipefail -c 'jj git push; git push'"), ['jj git push', 'git push']);
  assert.deepEqual(argvs("sh -ec 'cd /usr && pwd'"), ['pwd']);
  assert.equal(one("sh -ec 'cd /usr && pwd'").cwd, '/usr');
  assert.deepEqual(argvs("sh <<'EOF'\njj git push -b main\nEOF\nls"), ['jj git push -b main', 'ls']);
  assert.deepEqual(argvs('bash <<< "jj git push -b main"'), ['jj git push -b main']);
  const script = one('bash -x ./deploy.sh b1 main');
  assert.deepEqual([script.argv.join(' '), script.interpreter], ['./deploy.sh b1 main', 'bash']);
  assert.equal(one('python3 deploy.py b1').interpreter, 'python3');
  assert.equal(one('eval "jj git push"').argv.join(' '), 'jj git push');
});

test('what the reader cannot see is marked opaque, with the text it would run when known', () => {
  const piped = shellCommands("echo 'jj git push -b main' | sh", dir).at(-1);
  assert.match(piped.opaque, /from a pipe/);
  assert.match(one('sh < script.sh').opaque, /from a file/);
  assert.match(one("sh <<EOF\njj git push -b $B\nEOF").opaque, /from a pipe/);
  const code = one("node -e \"require('child_process').execSync('git push')\"");
  assert.match(code.opaque, /node code/);
  assert.match(code.code, /git push/);
  assert.match(one('bash -c "$SCRIPT"').opaque, /script built at run time/);
  assert.match(one('eval "$CMD"').opaque, /eval of a string built at run time/);
  assert.equal(argvs("cat <<'EOF' > notes.md\njj git push\nEOF").join(), 'cat');
});

test('the folder follows cd, pushd and subshells, and is unknown after a cd to a variable', () => {
  const entries = shellCommands('cd /usr && ls; (cd /bin; ls); ls; cd "$X" && ls', '/');
  assert.deepEqual(entries.map((entry) => entry.cwd), ['/usr', '/bin', '/usr', null]);
  assert.equal(one('cd /no/such/folder; ls', '/').cwd, null);
});

test('assignments before a command are its environment, and a bare one is recorded', () => {
  assert.deepEqual(Object.keys(one('GIT_DIR=/x git push').env), ['GIT_DIR']);
  const entries = shellCommands('GIT_DIR=/x; git push', dir);
  assert.deepEqual(entries[0].assignsOnly, ['GIT_DIR']);
});

test('loops mark the commands they repeat', () => {
  const entries = shellCommands('for b in a b; do jj describe; jj git push; done; ls', dir);
  assert.deepEqual(entries.map((entry) => [entry.argv[1] ?? entry.argv[0], entry.loop]), [['describe', true], ['git', true], ['ls', false]]);
  assert.equal(shellCommands('while true; do git push; done', dir)[0].loop, true);
});

test('an argument list from Codex is read as argv, with a shell inside it read as a script', () => {
  assert.deepEqual(argvCommands(['bash', '-lc', 'jj git push -b x && ls'], dir).map((entry) => entry.argv.join(' ')), ['jj git push -b x', 'ls']);
});

test('clap and pflag options: attached values, = forms and clusters', () => {
  const spec = { long: { bookmark: 'value', all: 'flag', remote: 'value' }, short: { b: 'bookmark' } };
  const parsed = parseOptions(['-bmain', '-b=x', '--bookmark', 'y', '--bookmark=z', '--remote', 'o', '--all'].map((text) => ({ text, dynamic: false })), spec);
  assert.deepEqual(parsed.values('bookmark').map((option) => option.value), ['main', 'x', 'y', 'z']);
  assert.equal(parsed.has('all'), true);
  assert.deepEqual(parseOptions([{ text: '--bogus' }], spec).unknown, ['--bogus']);
});

test('git options: unique prefixes, --no- forms and short clusters, with option values skipped', () => {
  const spec = { long: { force: 'flag', 'force-with-lease': 'flag', 'dry-run': 'flag', verify: 'flag', 'push-option': 'value' }, short: { f: 'force', n: 'dry-run', o: 'push-option', u: 'force' }, negatable: ['dry-run', 'verify', 'force'] };
  const read = (texts) => parseGitOptions(texts.map((text) => ({ text, dynamic: false })), spec);
  assert.deepEqual(read(['--force-with-l']).options.map((option) => option.name), ['force-with-lease']);
  assert.deepEqual(read(['--no-verif']).options.map((option) => [option.name, option.negated]), [['verify', true]]);
  assert.deepEqual(read(['-o', '-n']).options.map((option) => [option.name, option.value]), [['push-option', '-n']]);
  assert.deepEqual(read(['-nf']).options.map((option) => option.name), ['dry-run', 'force']);
  assert.deepEqual(read(['--forc']).unknown, ['--forc (ambiguous)']);
  assert.deepEqual(read(['--dry-run', '--no-dry-run']).options.map((option) => option.negated), [false, true]);
});

test('TOML string arrays, as jj config prints aliases', () => {
  assert.deepEqual(parseTomlStrings('["git", "push", \'-b\', "a\\"b"]'), ['git', 'push', '-b', 'a"b']);
  assert.equal(parseTomlStrings('log'), null);
});
