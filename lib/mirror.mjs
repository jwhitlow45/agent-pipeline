// Mirrors a run's stages to GitHub commit statuses. Stages about the change (intake through review)
// go on the run's tip. Stages about a release (deploy, cleanup, live play) go on the deployed commit.
// Only commits GitHub has can carry a status, so a commit not yet pushed is skipped.
//
// A stage whose evidence covers a commit (build, scan, ci, review, docs) shows its state only on the
// commit it was recorded on. On any other tip it is pending, so a success never moves to a commit
// nobody checked.

import { CONTEXT_PREFIX, githubState, setStatus } from './github.mjs';
import { TIP_STAGES } from './ledger.mjs';
import { reviewState } from './review.mjs';
import { short } from './util.mjs';
import { isOnRemote } from './vcs.mjs';

const CHANGE_STAGES = ['intake', 'design', 'decisions', 'build', 'scan', 'ci', 'review', 'docs'];
const RELEASE_STAGES = ['deploy', 'cleanup', 'live-play'];

// agent-review sets its own `agent-review` status, so the pipeline mirrors review only when it keeps the review itself.
const mirrored = (run, stage) => stage !== 'review' || run.stages.review?.provider === 'builtin';

function stageFor(ctx, run, stage, sha) {
  const record = run.stages[stage];
  if (!record) return null;
  // Review coverage is read again, since a rebase or a new round can change it after it was recorded.
  if (stage === 'review') {
    const now = reviewState(ctx.repo, sha, ctx.config);
    return { state: now.state, summary: now.summary };
  }
  if (TIP_STAGES.includes(stage) && record.tip !== sha) return { state: 'pending', summary: `recorded on ${short(record.tip) ?? 'no commit'}, not this commit; run it again` };
  return record;
}

export function mirrorRun(ctx, run, { stages } = {}) {
  if (!ctx.slug) return [];
  const results = [];
  const targets = [
    { sha: run.tip, list: CHANGE_STAGES },
    { sha: run.stages.deploy?.tip ?? null, list: RELEASE_STAGES },
  ];
  for (const { sha, list } of targets) {
    if (!sha || !isOnRemote(ctx.repo, sha, ctx.config.remote)) continue;
    for (const stage of list) {
      if (stages && !stages.includes(stage)) continue;
      if (!mirrored(run, stage)) continue;
      const record = stageFor(ctx, run, stage, sha);
      const state = githubState(record?.state);
      if (!state) continue;
      results.push(setStatus(ctx.slug, sha, {
        context: `${CONTEXT_PREFIX}${stage}`,
        state,
        description: `${run.id}: ${record.summary ?? record.state}`,
        targetUrl: record.url ?? null,
      }));
    }
  }
  return results;
}

export const mirrorLines = (results) => results.map((result) => `  ${result.line}`);
