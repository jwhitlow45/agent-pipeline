// Reports and setup: status of one run or every open run, mirroring to GitHub, init and config.

import { appendFileSync, constants, copyFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, LOCAL_FILE, warnings } from './config.mjs';
import { repoContext, runContext } from './context.mjs';
import { loadRuns, stageState } from './ledger.mjs';
import { mirrorLines, mirrorRun } from './mirror.mjs';
import { fail, plural, short } from './util.mjs';
import { root as workspaceRoot } from './vcs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The order stages pass in. A run's next step is its first stage that has not passed.
export const FLOW = ['intake', 'design', 'decisions', 'build', 'scan', 'push', 'ci', 'review', 'docs', 'deploy', 'cleanup', 'live-play'];

const NEXT = {
  intake: (run) => `pipeline intake --run ${run.id} --words-file <file>`,
  design: (run) => (run.kind === 'feature' ? `pipeline design --run ${run.id} --note <design note> --review-topic <topic>` : `pipeline spec --run ${run.id} --file <spec>`),
  decisions: (run) => `pipeline decisions --run ${run.id}`,
  build: (run) => (Object.keys(run.lanes ?? {}).length ? `pipeline build --run ${run.id}` : `pipeline lane --run ${run.id} --lane a --workspace <dir> --owns <globs> --brief <brief>`),
  scan: (run) => `pipeline scan --run ${run.id}`,
  push: (run) => `pipeline push --run ${run.id} --branch ci/${run.id}`,
  ci: (run) => `pipeline ci --run ${run.id} --wait`,
  review: (run) => `pipeline review status --run ${run.id}`,
  docs: (run) => `pipeline docs --run ${run.id}`,
  deploy: (run) => `pipeline deploy check --run ${run.id}`,
  cleanup: (run) => `pipeline cleanup --run ${run.id}`,
  'live-play': (run) => `pipeline live-play start --run ${run.id} --prefix <LPn>`,
};

const done = (state) => ['passed', 'skipped'].includes(state);

export function cmdStatus(opts) {
  if (opts.run) {
    const { run } = runContext(opts);
    if (opts.json) return console.log(JSON.stringify(run, null, 2));
    const lines = [`Run ${run.id} (${run.kind}), tip ${short(run.tip) ?? 'none'}, ${run.github ?? run.identity}`];
    for (const stage of FLOW) {
      const record = run.stages[stage];
      lines.push(`  ${stage.padEnd(10)} ${stageState(run, stage).padEnd(11)} ${record?.summary ?? ''}`);
    }
    for (const lane of Object.values(run.lanes ?? {})) lines.push(`  lane ${lane.name}: ${lane.workspace}, ${plural(lane.commits.length, 'commit')}, tip ${short(lane.tip) ?? 'none'}`);
    const next = FLOW.find((stage) => !done(stageState(run, stage)) && !(stage === 'decisions' && !run.stages.decisions));
    if (run.abandoned) lines.push(`Abandoned by ${run.abandoned.by} at ${run.abandoned.at}: ${run.abandoned.reason}`);
    else if (next) lines.push(`Next: ${NEXT[next](run)}`);
    return console.log(lines.join('\n'));
  }
  const ctx = repoContext(opts.repo, { configPath: opts.config, required: false });
  const runs = loadRuns().filter((run) => !ctx || run.identity === ctx.identity).filter((run) => opts.all || (!done(stageState(run, 'live-play')) && !run.abandoned));
  if (!runs.length) return console.log('No open runs.');
  for (const run of runs) {
    const next = FLOW.find((stage) => !done(stageState(run, stage)) && !(stage === 'decisions' && !run.stages.decisions));
    console.log(`${run.id.padEnd(24)} ${run.kind.padEnd(9)} ${FLOW.map((stage) => (done(stageState(run, stage)) ? '+' : stageState(run, stage) === 'failed' ? 'x' : stageState(run, stage) === 'none' ? '.' : '~')).join('')}  ${run.abandoned ? 'abandoned' : `next: ${next ?? 'done'}`}`);
  }
  console.log(`Stages: ${FLOW.join(', ')}. + passed, ~ in progress, x failed, . not started.`);
}

export function cmdMirror(opts) {
  const ctx = runContext(opts);
  const results = mirrorRun(ctx, ctx.run);
  console.log(results.length ? mirrorLines(results).join('\n') : 'Nothing to mirror: the run\'s commits are not on GitHub yet, or no stage has a state.');
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

export function cmdInit(opts) {
  const root = workspaceRoot(opts.repo ?? process.cwd()) ?? fail('Not in a jj or git repository.');
  const target = join(root, CONFIG_FILE);
  if (lstatSync(target, { throwIfNoEntry: false })) fail(`${target} already exists.`);
  copyFileSync(join(ROOT, 'pipeline.config.example.json'), target, constants.COPYFILE_EXCL);
  const ignore = join(root, '.gitignore');
  const ignored = existsSync(ignore) && readFileSync(ignore, 'utf8').split('\n').some((line) => line.trim() === LOCAL_FILE);
  if (!ignored) appendFileSync(ignore, `${existsSync(ignore) && !readFileSync(ignore, 'utf8').endsWith('\n') ? '\n' : ''}${LOCAL_FILE}\n.pipeline/\n`);
  console.log([`Wrote ${target}. Fill in the check commands, e2e files, docs files, deploy and notify commands.`,
    `Private values (the domain the scan keeps out, the deploy host) go in ${join(root, LOCAL_FILE)}, which .gitignore now lists.`].join('\n'));
}

export function cmdConfig(opts) {
  const ctx = repoContext(opts.repo, { configPath: opts.config });
  const found = warnings(ctx.config);
  if (!opts.check) console.log(JSON.stringify(ctx.config, null, 2));
  console.log(found.length ? ['Warnings:', ...found.map((warning) => `  - ${warning}`)].join('\n') : `Config ok: ${ctx.config.file}${ctx.config.localFile ? ` with ${ctx.config.localFile}` : ''}.`);
}
