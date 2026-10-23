# Profile: raccoon-vtt

raccoon-vtt is the project this process was worked out on: a self-hosted virtual tabletop for one gaming group, made for phones first, with a Node 24 server, a React 19 client, realtime play over WebSockets, Postgres, and a Docker deploy to one server. Its repository is public, which shaped the push and scan rules. One coordinating agent ran it for the owner, with designers, builders, reviewers and live play agents under it.

This folder is that project's setup, scrubbed of private values:

- [pipeline.config.json](pipeline.config.json): its checks, e2e files, scan, docs and deploy settings
- [pipeline.local.example.json](pipeline.local.example.json): the shape of its gitignored local file, with placeholders where the private values go
- [deploy.example.sh](deploy.example.sh): its deploy script, with the host, folders and domain replaced by placeholders.

## How the process ran there

- **Scale.** Five planned waves of features, each designed, reviewed, built, reviewed, deployed and played, then a long run of smaller feature batches, hotfixes and follow-up batches, often three or four lanes at once, about one deploy every few hours on busy days.
- **Reviews.** The default pair for substantial work was a Claude model and a Codex model at the highest effort, with a third reviewer as a specialist when one area carried most of the risk (stored data and replay, hidden state, security, product rules). Light reviews (two reviewers at medium effort) covered hotfixes. Design reviews ran up to eight rounds, code reviews up to thirteen, most two to five.
- **Guess mode.** For most of the run the owner turned guessing on: the coordinator decided product questions and logged each with the rejected options, and the owner took the recommended option in about 40 of 43 cases when asked. The exceptions were taste calls on look and feel.
- **Topics.** Review topics were named for the run and the stage: `<run>design` for the design review, `<run>build` for the code review. Live play runs were numbered `LP1` to `LP14`, with bug IDs such as `LP14-RS-1` (play run, area, number).
- **Lanes.** Each lane got a jj workspace named `openvtt-<task>` beside the main one, its own e2e port range at least 20 apart (some e2e files use the base port plus 10, 19 and 22), and its own databases (`<project>_<task>` and `<project>_<task>_e2e`), dropped at the end.

## What live play and docs meant there

The process defines live play for any software. For this one web app it meant:

- **Who played.** A lead user (the DM) and two or three players, on phones and desktops, in separate browser sessions.
- **How.** The way a gaming group plays, not only the happy path: interrupt flows, reload mid-action, go offline and back, undo and redo, use two devices at once.
- **Access boundaries.** Each agent recorded what each client received and checked that nothing private (hidden tokens, the DM's notes, secret rolls) reached a player who may not see it.
- **Where.** A local server on the deployed commit with its own ports and database, never the live site.

Its docs were a feature list (`FEATURES.md`), a DM guide written in a natural guide voice with screenshots from fixture data, and a keyboard shortcut sheet: keys and key-plus-pointer combinations, kept in step with `client/state/shortcuts.ts` through `docs.shortcutSources`. A guide pass signed off `docs/guide-voice` in place of the default `docs/read-through`. Its deploys recorded a backup, health, restarts, a load check over every stored record, and a few HTTP requests.

## Rules this project added, and why

Each rule came from something that went wrong once.

- **Short reports.** Two to four thousand word reports filled the coordinator's context. Reports moved to files, with about ten lines in the message.
- **Design notes of about 400 lines.** Wave five's four notes ran about 2,700 lines, and most later-round findings came from their length: contradictions between sections and numbers left stale by a fix.
- **A shared contract first.** Two designs that each wrote their own version of a shared component cost two extra review rounds.
- **Touched e2e files only, in lanes.** Four builders each running all of the roughly 50 e2e files at once slowed the machine and caused timing flakes. The full set runs once on the stacked tip, and later in CI.
- **Feature list and guide changes in their own last commit.** The same docs files conflicted at almost every stacking.
- **P3 findings go to the backlog.** One build ran six rounds of small-screen edge cases, each fix opening the next. Round 1 became the exhaustive one, with an explicit matrix, and P3s stopped holding reviews open.
- **Never force push, ci branches included.** Once a fixer squashed into an already pushed commit, and the next `jj git push` moved the branch sideways without a warning. Pushes now check ancestry first, and a rewritten stack goes to a new branch name.
- **Delete merged branches.** The public repository was collecting a stale `ci/*` branch per CI run.
- **Diagnose e2e failures at once.** Waiting for a 50-minute run to end before looking at a failure from minute five wasted most of an hour each time.
- **Randomized tests for state machines.** Three review rounds in a row each found a regression of the same shape in retry and cancel code.
- **Bundle the commit itself.** After moving main from another workspace, git's `refs/heads/main` lagged, and a deploy bundle shipped the old main. The deploy script now bundles the exact local commit under a ref of its own, checks the server runs that commit, and publishes main only after the checks pass.
- **Linux CI only.** macOS runners were far slower, so an e2e file goes on a macOS list only when it fails on Linux from font metrics alone.

## A caution about stacked reviews

Review coverage is by patch-id over trunk to the tip. A stack built on another stack that is still in review includes the lower stack's commits in its range, so recording consensus on the upper review covers the lower commits too. On this project a traps review's consensus covered 84 attach commits whose own review was still running. Nothing deployed early, because attach waited for its own consensus, but the ledger said otherwise. Record consensus on a stacked review only after the stack below it has its own, or say in the request which commits are only there as the base.

## Set it up

```sh
cd <the raccoon-vtt checkout>
cp <agent-pipeline>/profiles/raccoon-vtt/pipeline.config.json .
cp <agent-pipeline>/profiles/raccoon-vtt/pipeline.local.example.json pipeline.local.json
# fill in pipeline.local.json, then:
pipeline config --check
```

The project's own words for live play, which every live play brief quoted: "this should not change core functionality but just fix bugs in existing functionality".
