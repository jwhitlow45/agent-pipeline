#!/usr/bin/env node
// agent-pipeline: a stage ledger, gate and GitHub status mirror for an agent delivery process
// (docs/process.md). Each run (a feature, a batch, a hotfix) records which stages passed on which
// commits. Each stage is mirrored as a `pipeline/<stage>` commit status. Hooks run the gate before
// every shell command, so a step whose earlier stages have not passed is refused.

import { parseArgs } from 'node:util';
import { cmdDocs, cmdFollowup, cmdLivePlay } from '../lib/after.mjs';
import { cmdBuild, cmdCheck, cmdCommits, cmdIntegrate, cmdLane, cmdMutation, cmdReport } from '../lib/build.mjs';
import { cmdDoctor } from '../lib/doctor.mjs';
import { cmdExec, cmdGate, cmdGitPrePush, cmdMirrorHook } from '../lib/hooks.mjs';
import { cmdBrief, cmdDecide, cmdDecisions, cmdDesign, cmdIntake, cmdSignoff, cmdSpec } from '../lib/plan.mjs';
import { cmdAbandon, cmdCi, cmdCleanup, cmdDeploy, cmdLiveHole, cmdNotify, cmdPush, cmdRebase, cmdReview, cmdScan } from '../lib/ship.mjs';
import { cmdConfig, cmdInit, cmdMirror, cmdStatus } from '../lib/status.mjs';
import { stateDir, UsageError } from '../lib/util.mjs';

const HELP = `pipeline: stage ledger, gate and GitHub status mirror for the agent delivery process

Setup
  init [--repo DIR]                                   Write pipeline.config.json from the example
  config [--check]                                    Show the merged config and its warnings

Plan
  intake    --run R (--words "..." | --words-file F) [--kind feature|fast|hotfix|followups|docs] [--ui] [--live-hole] [--by WHO] [--from RUN]
  brief     --run R --file F [--kind build|design|review|live-play|followups|fix] [--lane L] [--decisions ID,...]
  design    --run R --note F [--ui|--no-ui] [--review-topic T | --review-skip "user's words"] [--allow-long REASON] [--re-review]
  spec      --run R --file F                          A fast, hotfix, follow-up or docs run's short spec
  decide    --id ID --chose TEXT --why TEXT --rejected TEXT [--title T] [--run R] [--by WHO]
  decisions --run R                                   Check every decision the run's briefs name is logged
  signoff   --run R --stage S --item I --by WHO --note TEXT [--extra]

Build
  lane      --run R --lane L --workspace DIR --owns GLOBS --brief F [--name NAME] [--base REV] [--db NAMES] [--env K=V,...]
  commits   --run R --lane L [--tip REV] [--outside "path: reason"]...
  check     --run R --lane L [--e2e FILES|all] [--only NAMES] [--dry-run]
  check     --run R --lane L --record NAME --exit CODE --log F
  check     --run R --tip REV --workspace DIR         Every check, every e2e file included, on that exact commit
  mutation  --run R --lane L --commit REV --test FILE [--cmd CMD] | --manual HOW --exit CODE [--log F]
  report    --run R --lane L --file F
  integrate --run R --tip REV                         The stacked tip of several lanes: checks it holds every lane commit
  build     --run R [--review-topic T]

Ship
  scan      --run R [--base REV] [--tip REV] [--ack "why each finding is fine"]
  push      --run R --branch B [--tip REV] [--next-name]  The check and commands for a push (--bookmark is the same)
  ci        --run R [--commit REV] [--wait] [--run-id ID]
  review    status|start|round|done|skip --run R [--topic T] [--tip REV] [--no-commits --dir DIR] [--reviewers "..."] [--reason "user's words"]
  rebase    --run R --tip REV
  deploy    check  --run R [--tip REV] [--name N] [--prev SHA]
  deploy    record --run R --name N --shipped TEXT [--health H] [--backup B] [--load N/M] [--http "200 200"] [--restarts 0] [--failed [WHY]] [--by agent|user] [--ungated WHY] [--no-notify]
            each check in deploy.requiredChecks is required (health by default)
  notify    --run R --event deploy|waiting|done|failed|note --message TEXT
  cleanup   --run R
  abandon   --run R --reason TEXT --by WHO            Stop a run for good: frees its lanes, never deploys
  live-hole close|waive --run R --by WHO --reason TEXT The user's: end a live hole's embargo, or waive commits no clone can read

After
  live-play start|bug|import|resolve|status|done --run R [--prefix LPn] [--deployed REV] [--workspace DIR] [--db NAMES] [--brief F]
            [--id ID --severity Pn --area A --summary TEXT --status fixed|needs-owner|known|not-a-bug --commit REV --recommend TEXT]
            [--report F] [--decision ID | --followup ID]
  followup  add|list|plan|close --run R [--id ID --severity Pn --source S --text T --files F,... --decision ID] [--open] [--ids ...] [--lanes N] [--apply] [--commit REV]
  docs      --run R [--tip REV] | --due

Report
  status [--run R] [--json] [--all]
  mirror --run R                                      Set the run's pipeline/<stage> statuses on GitHub

Hooks
  gate                                                PreToolUse hook: refuses a step whose earlier stages have not passed
  mirror-hook                                         PostToolUse hook: records pushes and mirrors statuses
  exec -- <command...>                                The gate, the command, then the mirror, for agents without hooks
  git-pre-push [--remote NAME] [--url URL]            The push checks, from a git pre-push hook
  doctor                                              Reports which GitHub settings that back the gate are missing

Ledger: ${stateDir()}`;

const STRINGS = ['run', 'words', 'words-file', 'kind', 'by', 'from', 'file', 'lane', 'decisions', 'note', 'review-topic', 'review-skip', 'allow-long', 'id', 'chose', 'why', 'rejected', 'title',
  'stage', 'item', 'workspace', 'name', 'owns', 'brief', 'base', 'db', 'env', 'tip', 'e2e', 'only', 'record', 'exit', 'log', 'commit', 'test', 'cmd', 'manual', 'ack', 'branch', 'bookmark', 'run-id',
  'topic', 'dir', 'reviewers', 'reason', 'prev', 'shipped', 'backup', 'health', 'load', 'http', 'restarts', 'logs', 'ungated', 'event', 'message', 'prefix', 'deployed', 'severity', 'area',
  'summary', 'status', 'recommend', 'report', 'decision', 'followup', 'source', 'text', 'files', 'ids', 'lanes', 'repo', 'config', 'remote', 'failed', 'url'];
const BOOLEANS = ['ui', 'no-ui', 'live-hole', 're-review', 'extra', 'dry-run', 'next-name', 'wait', 'no-commits', 'no-notify', 'json', 'all', 'check', 'open', 'apply', 'due', 'help'];
const OPTIONS = {
  ...Object.fromEntries(STRINGS.map((name) => [name, { type: 'string' }])),
  ...Object.fromEntries(BOOLEANS.map((name) => [name, { type: 'boolean' }])),
  outside: { type: 'string', multiple: true },
};
OPTIONS.help.short = 'h';

const COMMANDS = {
  init: cmdInit, config: cmdConfig, intake: cmdIntake, brief: cmdBrief, design: cmdDesign, spec: cmdSpec, decide: cmdDecide, decisions: cmdDecisions, signoff: cmdSignoff,
  lane: cmdLane, commits: cmdCommits, integrate: cmdIntegrate, check: cmdCheck, mutation: cmdMutation, report: cmdReport, build: cmdBuild,
  scan: cmdScan, push: cmdPush, ci: cmdCi, rebase: cmdRebase, notify: cmdNotify, cleanup: cmdCleanup, abandon: cmdAbandon, docs: cmdDocs,
  status: cmdStatus, mirror: cmdMirror, gate: cmdGate, 'mirror-hook': cmdMirrorHook, 'git-pre-push': cmdGitPrePush, doctor: cmdDoctor,
};
const SUBCOMMANDS = { review: cmdReview, deploy: cmdDeploy, 'live-play': cmdLivePlay, followup: cmdFollowup, 'live-hole': cmdLiveHole };

try {
  const argv = process.argv.slice(2);
  if (argv[0] === 'exec') cmdExec(argv.slice(1));
  else {
    // --failed takes an optional reason, so a bare --failed is given an empty value before parsing.
    const args = argv.map((arg, i) => (arg === '--failed' && (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? '--failed=deploy failed' : arg));
    const { values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
    const [name, sub] = positionals;
    if (!name || values.help || (!COMMANDS[name] && !SUBCOMMANDS[name])) console.log(HELP);
    else if (SUBCOMMANDS[name]) await SUBCOMMANDS[name](values, sub ?? 'status');
    else await COMMANDS[name](values);
  }
} catch (error) {
  process.stderr.write(`pipeline: ${error.message}\n`);
  // A hook harness runs the command unless the gate exits 2, so a gate that fails refuses.
  const gating = ['gate', 'exec'].includes(process.argv[2]);
  process.exitCode = gating ? 2 : error instanceof UsageError ? 64 : 1;
}
