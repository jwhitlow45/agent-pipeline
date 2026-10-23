// The gate against every command form the round 1 reviews found, each with the exit code it must
// give: 2 refuses, 0 allows. Rows run in order on one sandbox per block, and a `setup` row changes
// the sandbox for the rows after it.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { baseConfig, builtRun, sandbox, SLUG } from './helpers.mjs';

const FORCE = /force push/;
const NOT_OURS = /is not a branch agents push to/;
const UNSCANNED = /without a passed pre-push scan/;
const EARLIER = /earlier command on this line/;

// Fills %repo%, %ws%, %tip% and the like into a row's command.
const fill = (text, values) => text.replace(/%(\w+)%/g, (whole, key) => values[key] ?? whole);

function runRows(box, values, rows) {
  for (const row of rows) {
    if (row.setup) {
      test(`setup: ${row.name}`, () => row.setup(box, values));
      continue;
    }
    const [where, command, code, pattern, payload] = row;
    const text = fill(command, values);
    test(`${code === 2 ? 'refuses' : 'allows'} ${text.replace(/\n/g, '\\n')}${where === 'root' ? ' (from outside the repository)' : ''}`, () => {
      const result = box.gate(text, values[where], payload);
      assert.equal(result.code, code, result.err || '(allowed)');
      if (pattern) assert.match(result.err, pattern);
    });
  }
}

describe('pushes, wrappers and the same command line (deploy.runBy agent)', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());
  const values = { repo: box.repo, root: box.root };
  const { ws, tip } = builtRun(box);
  box.cli(['scan', '--run', 'dark'], { cwd: ws });
  // Two siblings off main that no scan covered: S1 goes to the remote as ci/side, then ci/side moves
  // to S2 locally, a sideways move.
  const S1 = box.commit('feat: side one', { 'side.txt': '1\n' });
  box.sh('jj new main');
  const S2 = box.commit('feat: side two', { 'side.txt': '2\n' });
  box.sh(`jj bookmark set ci/side -r ${S1} && jj git push -b ci/side && jj bookmark set ci/side -r ${S2} --allow-backwards`);
  box.sh('jj bookmark set release -r main && jj git push -b release && jj bookmark delete release');
  box.sh('jj bookmark set ci/old -r main && jj git push -b ci/old && jj bookmark delete ci/old');
  box.sh(`jj bookmark set feature ci/dark ci/fresh -r ${tip} && jj tag set v1 -r main`);
  box.sh('jj bookmark set ci/wc -r @', ws);
  box.sh(`git init -q --bare ${JSON.stringify(join(box.root, 'fork.git'))} && jj git remote add fork ${JSON.stringify(join(box.root, 'fork.git'))}`);
  box.sh('jj config set --repo aliases.pp \'["git", "push"]\' && git config alias.p push');
  box.ghScript([
    { match: 'pr view 6 ', stdout: { baseRefName: 'main', headRefName: 'ci/dark', headRefOid: 'a'.repeat(40), isDraft: false } },
    { match: 'pr view 7 ', stdout: { baseRefName: 'main', headRefName: 'ci/dark', headRefOid: tip, isDraft: false } },
    { match: 'pr view 8 ', stdout: { baseRefName: 'ci/base', headRefName: 'ci/dark', headRefOid: tip, isDraft: false } },
    { match: 'git/ref/heads/ci/moved', stdout: { object: { type: 'commit', sha: S2 } } },
    { match: 'git/ref/tags/', exit: 1, stderr: 'gh: Not Found (HTTP 404)' },
    { match: `run view 5 -R ${SLUG}`, stdout: { workflowName: 'Deploy' } },
    { match: `run view 9 -R ${SLUG}`, stdout: { workflowName: 'CI' } },
    { match: 'alias list', stdout: '' },
  ]);
  Object.assign(values, { ws, tip, S1, S2, tip12: tip.slice(0, 12) });

  runRows(box, values, [
    ['ws', 'jj bookmark set ci/new -r @- && jj git push -b ci/new', 0],
    // P1-1, PA-01: forms the old reader skipped
    ['ws', 'jj git pu"sh" -b feature', 2, NOT_OURS],
    ['ws', "bash -o pipefail -c 'jj git push -b feature'", 2, NOT_OURS],
    ['ws', "bash -o pipefail -c 'jj git push -b ci/fresh'", 0],
    ['ws', "echo 'jj git push -b ci/fresh' | sh", 2, /sh reading its script from a pipe/],
    ['ws', "sh <<'EOF'\njj git push -b feature\nEOF", 2, NOT_OURS],
    ['ws', "sh <<'EOF'\njj git push -b ci/fresh\nEOF", 0],
    ['ws', "$'jj' git push -b feature", 2, NOT_OURS],
    ['ws', "env -S 'jj git push -b feature'", 2, NOT_OURS],
    ['ws', "env -S 'jj git push -b ci/fresh'", 0],
    ['ws', 'echo ci/fresh | xargs jj git push -b', 2, /xargs adds arguments/],
    ['ws', 'sudo jj git push -b feature', 2, NOT_OURS],
    ['ws', 'J=jj; $J git push -b ci/fresh', 2, /command name built at run time/],
    ['ws', 'B=ci/fresh; jj git push -b "$B"', 2, /built at run time/],
    ['root', 'jj -R %ws% git push -b feature', 2, NOT_OURS],
    ['root', 'jj -R %ws% git push -b ci/fresh', 0],
    ['root', 'env -C %ws% jj git push -b feature', 2, NOT_OURS],
    ['root', 'git -C %repo% push --force origin main', 2, FORCE],
    ['repo', 'git --no-pager push origin %S2%:refs/heads/ci/x', 2, UNSCANNED],
    ['repo', 'git -c core.hooksPath=/dev/null push origin %tip%:refs/heads/ci/x', 2, /core\.hooksPath/],
    ['repo', 'GIT_DIR=/x git push origin %tip%:refs/heads/ci/x', 2, /GIT_DIR/],
    ['repo', 'export GIT_CONFIG_COUNT=1; git push origin %tip%:refs/heads/ci/x', 2, /GIT_CONFIG_COUNT/],
    ['ws', 'jj --config \'aliases.x=["git","push","-b","feature"]\' x', 2, /aliases\.x/],
    ['ws', 'jj --config git.push=fork git push -b ci/fresh', 2, /git\.push/],
    ['ws', 'jj --config-file ../x.toml git push -b ci/fresh', 2, /config-file/],
    ['ws', 'JJ_CONFIG=../x.toml jj git push -b ci/fresh', 2, /JJ_CONFIG/],
    ['ws', 'jj pp -b feature', 2, NOT_OURS],
    ['repo', 'git p origin %tip%:refs/heads/feature', 2, NOT_OURS],
    ['repo', 'git psuh origin main', 2, /autocorrect/],
    ['ws', "node -e \"require('child_process').execSync('jj git push -b feature')\"", 2, /node code/],
    ['ws', 'echo "jj git push is documented here" > notes.txt', 0],
    ['ws', "cat <<'EOF' > notes.md\njj git push -b feature\nEOF", 0],
    ['ws', '[ -f x ] && jj git push -b ci/fresh', 0],
    ['ws', 'jj git push -b ci/fresh 2>&1 | tee push.log', 0],
    ['ws', 'jj git push -b ci/fresh --dry-run', 0],
    // P1-2, PA-02: every ref a jj push touches
    ['ws', 'jj git push -b ci/fresh -bfeature', 2, NOT_OURS],
    ['ws', 'jj git push -b ci/fresh -b=feature', 2, NOT_OURS],
    ['ws', 'jj git push --bookmark ci/fresh --bookmark=feature', 2, NOT_OURS],
    ['ws', "jj git push -b 'exact-i:FEATURE'", 2, /by a pattern/],
    ['ws', "jj git push -b 'substring-i:feat'", 2, /by a pattern/],
    ['ws', "jj git push -b '~ci/none'", 2, /by a pattern/],
    ['ws', "jj git push -b 'exact:feature | exact:x'", 2, /by a pattern/],
    ['ws', "jj git push -b 'ci/*'", 2, /by a pattern/],
    ['ws', 'jj git push -b exact:ci/fresh', 0],
    ['ws', "jj git push --named 'ci/z=description(substring:\"a=b\") | @-'", 0],
    ['ws', 'jj git push --named feature2=@-', 2, NOT_OURS],
    ['ws', 'jj git push -b ci/nothere', 2, /points nowhere/],
    ['ws', 'jj git push -b ci/fresh --revision @-', 2, /feature: feature is not a branch/],
    ['ws', 'jj git push -b ci/fresh -t v1', 2, /pushes tags/],
    ['repo', 'jj git push -r main', 2, /also pushes a tag/],
    ['ws', 'jj git push -c @-', 2, /push-[a-z]+ is not a branch agents push to/],
    ['ws', 'jj git push --all', 2, /also pushes tags/],
    ['ws', 'jj git push --tracked', 2, FORCE],
    ['ws', 'jj git push', 2, /whatever bookmarks jj picks/],
    // P1-3: deletions
    ['repo', 'jj git push --deleted', 2, /deletes release/],
    ['repo', 'jj git push -b release', 2, /deletes release/],
    ['repo', 'jj git push -b ci/old', 0],
    // P1-4, PA-07: the same command line, and snapshots
    ['ws', 'jj describe -r ci/fresh -m "docs: reworded" && jj git push -b ci/fresh', 2, EARLIER],
    ['ws', 'jj b s ci/alias -r %S2% && jj git push -b ci/alias', 2, UNSCANNED],
    ['ws', 'jj b s ci/alias -r @- && jj git push -b ci/alias', 0],
    ['ws', 'jj bookmark set ci/side -r @- -B; jj git push -b ci/side', 2, FORCE],
    ['ws', 'jj commit -m "feat: more" && jj bookmark set ci/fresh -r @- && jj git push -b ci/fresh', 2, EARLIER],
    ['ws', 'jj bookmark rename ci/fresh ci/renamed && jj git push -b ci/renamed', 2, EARLIER],
    ['ws', 'jj bookmark set ci/w -r @ && jj git push -b ci/w', 2, EARLIER],
    ['ws', 'jj git push -b ci/wc', 2, /working-copy commit/],
    ['ws', 'jj new && jj git push -b ci/fresh', 2, EARLIER],
    ['ws', 'jj git fetch && jj git push -b ci/fresh', 2, EARLIER],
    ['ws', 'jj st && jj log -r @ && jj git push -b ci/fresh', 0],
    ['ws', 'for i in 1 2; do jj git push -b ci/fresh; jj describe -r ci/fresh -m x; done', 2, /in a loop/],
    // P1-8, PA-02: git's flags in every spelling
    ['repo', 'git push -o -n --no-verify origin +HEAD:main', 2, /pre-push hook/],
    ['repo', 'git push -o -n origin +HEAD:main', 2, FORCE],
    ['repo', 'git push -uf origin HEAD:refs/heads/ci/x', 2, FORCE],
    ['repo', 'git push -fq origin ci/side', 2, FORCE],
    ['repo', 'git push --forc origin ci/side', 2, /does not read/],
    ['repo', 'git push --force-with-l origin ci/side', 2, FORCE],
    ['repo', 'git push --no-verif origin ci/side', 2, /pre-push hook/],
    ['repo', 'git push --dry-run --no-dry-run --force origin main', 2, FORCE],
    ['repo', 'git push -vf origin ci/side', 2, FORCE],
    ['repo', 'git push origin ci/side', 2, FORCE],
    ['repo', 'git push origin tag v1', 2, /tag/],
    ['repo', 'git push --dry-run origin HEAD:refs/heads/ci/x', 0],
    ['repo', 'git push origin %tip%:refs/heads/ci/x', 0],
    // PA-05, PO-9, P1-7, P2-8: pull requests, statuses and gh api writes
    ['repo', 'gh pr create --title x --body y', 2, /--draft/],
    ['repo', 'gh pr create --draft --title x', 0],
    ['repo', 'gh pr merge 6 --squash', 2, /not in this repository yet/],
    ['repo', 'gh pr merge 99', 2, /could not read pull request 99/],
    ['repo', 'gh pr merge 7', 2, /Merging into main is a deploy step/],
    ['repo', 'gh pr ready 8', 2, /lack review consensus/],
    ['repo', `gh api -X POST repos/${SLUG}/statuses/%tip% -f context=pipeline/review -f state=success`, 2, /set only by the tools/],
    ['repo', 'gh api repos/{owner}/{repo}/statuses/%tip% -f context=agent-review -f state=success', 2, /set only by the tools/],
    ['repo', `gh api -X POST repos/${SLUG}/statuses/%tip% -f context=lint -f state=success`, 0],
    ['repo', `gh api -X PUT repos/${SLUG}/pulls/7/merge`, 2, /gh pr merge 7/],
    ['repo', `gh api -X PATCH repos/${SLUG}/git/refs/heads/main -f sha=%tip%`, 2, /moves a branch/],
    ['repo', `gh api -X POST repos/${SLUG}/merges -f base=main -f head=ci/fresh`, 2, /merges or renames/],
    ['repo', `gh api repos/${SLUG}/pulls/7`, 0],
    ['repo', "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", 2, /GraphQL/],
    ['repo', 'gh run rerun 5', 2, /rerun of a deploy/],
    ['repo', 'gh run rerun 9', 0],
    ['repo', 'gh workflow run deploy.yml --ref ci/moved', 2, /last saw it/],
    ['repo', 'gh workflow run release.yml -fenvironment=production', 2, /production deploy/],
    ['repo', `gh api repos/${SLUG}/actions/workflows/123/dispatches --input request.json`, 2, /gh workflow run 123/],
    // P2-7: other tools that run commands
    ['ws', 'jj git push -b feature', 2, /PowerShell/, { tool_name: 'PowerShell' }],
    ['ws', 'Get-ChildItem', 0, null, { tool_name: 'PowerShell' }],
    ['ws', 'jj git push -b feature', 2, NOT_OURS, { tool_name: 'Monitor' }],
    // P1-5: a local trunk moved ahead without a push changes no range
    { name: 'move main locally to the unreviewed tip', setup: (b, v) => b.sh(`jj bookmark set main -r ${v.tip}`) },
    ['repo', 'jj git push -b main', 2, /Code review consensus/],
    ['repo', './deploy.sh b1 %tip12%', 2, /Code review consensus/],
    // PA-03: trunk moves only forward
    { name: 'push main to the tip', setup: (b) => b.sh('jj git push -b main') },
    ['repo', 'jj bookmark set main -r %S1% --allow-backwards && jj git push -b main', 2, /force push of trunk/],
  ]);

  test('gh run rerun -R another repository never reads the run in this one', () => {
    const before = box.ghCalls().length;
    assert.equal(box.gate('gh run rerun 5 -R other-owner/other').code, 0);
    assert.ok(!box.ghCalls().slice(before).some((args) => args.join(' ').includes(`-R ${SLUG}`)));
  });

  test('a malformed hook payload refuses', () => {
    const result = box.cli(['gate'], { input: '{ nope' });
    assert.equal(result.code, 2);
    assert.match(result.err, /could not read the hook's input/);
  });

  test('the git pre-push hook checks ancestry against the sha the remote really has', () => {
    const hook = (input) => box.cli(['git-pre-push', '--remote', 'origin'], { input });
    const sideways = hook(`refs/heads/ci/side ${values.S2} refs/heads/ci/side ${values.S1}\n`);
    assert.equal(sideways.code, 1);
    assert.match(sideways.err, /force push/);
    const unknown = hook(`refs/heads/ci/side ${values.S2} refs/heads/ci/side ${'f'.repeat(40)}\n`);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /Fetch first/);
    assert.match(hook(`refs/tags/v1 ${values.tip} refs/tags/v1 ${'0'.repeat(40)}\n`).err, /only branches/);
    assert.match(hook(`refs/heads/main ${values.S1} refs/heads/main ${values.tip}\n`).err, /force push/);
  });
});

describe('the user runs deploys and moves trunk (deploy.runBy user)', () => {
  const box = sandbox({ config: { ...baseConfig, deploy: { ...baseConfig.deploy, runBy: 'user' } } });
  after(() => box.cleanup());
  const values = { repo: box.repo, root: box.root };
  box.commit('feat: on top of main', { 'x.txt': 'x\n' });
  box.ghScript([
    { match: 'pr view 7 ', stdout: { baseRefName: 'main', headRefName: 'ci/x', headRefOid: 'a'.repeat(40), isDraft: false } },
    { match: 'alias list', stdout: '' },
  ]);
  // The registry learns the repository from any pipeline command run in it.
  box.cli(['config', '--check']);

  runRows(box, values, [
    ['repo', './deploy.sh b1 main', 2, /The user runs deploys/],
    ['root', 'cd %repo% && ./deploy.sh b1 main', 2, /The user runs deploys/],
    ['root', '%repo%/deploy.sh b1 main', 2, /The user runs deploys/],
    ['repo', 'bash ./deploy.sh b1 main', 2, /through bash/],
    ['repo', 'sh ./deploy.sh x abc', 2, /through sh/],
    ['repo', `gh api -X POST repos/${SLUG}/actions/workflows/4242/dispatches -f ref=main`, 2, /gh workflow run 4242/],
    ['repo', 'echo \'{"environment":"production"}\' | gh workflow run release.yml --json', 2, /--json/],
    ['repo', `gh api -X POST repos/${SLUG}/dispatches -f event_type=deploy`, 2, /repository_dispatch/],
    ['repo', `gh api -X POST repos/${SLUG}/actions/runs/5/rerun`, 2, /gh run rerun/],
    ['repo', `gh api -X POST repos/${SLUG}/actions/runs/5/pending_deployments`, 2, /approves a pending deployment/],
    ['repo', 'jj bookmark set main -r @- && jj git push -b main', 2, /The user runs deploys and moves main/],
    ['repo', 'git push origin HEAD:refs/heads/main', 2, /The user runs deploys and moves main/],
    ['repo', 'gh pr merge 7', 2, /The user runs deploys and moves main/],
    ['repo', "bash <<'EOF'\ngh workflow run deploy-prod.yml --ref main\nEOF", 2, /production deploy/],
    ['repo', 'gh workflow run deploy.yml --ref main', 2, /The user runs deploys/],
    ['repo', 'cat deploy.sh', 0],
    ['repo', 'gh workflow run lint.yml --ref main', 0],
  ]);
});

describe('with agent-review keeping reviews, a merge into trunk is still a deploy step', () => {
  const box = sandbox({ config: { ...baseConfig, review: { provider: 'agent-review' } } });
  after(() => box.cleanup());
  const sha = box.commit('feat: unreviewed', { 'x.txt': 'x\n' });
  box.ghScript([{ match: 'pr view 7 ', stdout: { baseRefName: 'main', headRefName: 'ci/x', headRefOid: sha, isDraft: false } }]);
  runRows(box, { repo: box.repo }, [
    ['repo', 'gh pr merge 7 --squash', 2, /Merging into main is a deploy step/],
    ['repo', 'gh pr create --title x', 0],
  ]);
});

describe('the push remote comes from jj\'s git.push setting', () => {
  const box = sandbox({ config: baseConfig });
  after(() => box.cleanup());
  box.sh(`git init -q --bare ${JSON.stringify(join(box.root, 'fork.git'))} && jj git remote add fork ${JSON.stringify(join(box.root, 'fork.git'))} && jj config set --repo git.push fork`);
  box.commit('feat: x', { 'x.txt': 'x\n' });
  box.sh('jj bookmark set ci/x -r @-');
  runRows(box, { repo: box.repo }, [
    ['repo', 'jj git push -b ci/x', 2, /pushes to fork/],
    ['repo', 'jj git push --remote origin -b ci/x', 2, UNSCANNED],
  ]);
});
