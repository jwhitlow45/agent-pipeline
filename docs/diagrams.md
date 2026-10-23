# Diagrams

Each diagram below is an image rendered from an [Excalidraw](https://excalidraw.com) drawing in [diagrams](diagrams/). To edit one, open its `.excalidraw` file in excalidraw.com or in the VS Code Excalidraw extension, and save it in place. Then run `node scripts/render-diagrams.mjs` to render the light and dark images again. Add a drawing's name, such as `flow`, to render only that one. The script needs network access for `npm` and Google Chrome or Playwright's Chromium. `npm test` fails when an image is out of date.

[process.md](process.md) explains each step in prose, and [stages.md](stages.md) lists what the tool checks at each one.

## 1. From request to shipped and documented

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/flow-dark.png">
  <img src="images/flow.png" alt="Flowchart of a run: intake, design or short spec, decision log, parallel lanes, checks, scan, push, CI, code review, deploy check, deploy, live play and docs, with the loops back to lanes." width="1399">
</picture>

Source: [diagrams/flow.excalidraw](diagrams/flow.excalidraw).

## 2. A stage's states

Every stage moves through the same states in the ledger. The GitHub status follows: `success` for passed or skipped, `failure` for failed, `pending` for anything in between.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/stage-states-dark.png">
  <img src="images/stage-states.png" alt="State diagram of a stage: none, in progress, passed, failed and stale, with a refused check going to failed and moved commits making a passed stage stale." width="1360">
</picture>

Source: [diagrams/stage-states.excalidraw](diagrams/stage-states.excalidraw).

### Design

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/design-dark.png">
  <img src="images/design.png" alt="State diagram of the design stage: noted, in-review, passed and failed, with a note edited after consensus going back to failed." width="1058">
</picture>

Source: [diagrams/design.excalidraw](diagrams/design.excalidraw).

### Build lane

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/build-lane-dark.png">
  <img src="images/build-lane.png" alt="State diagram of a build lane: added, committed, checked, mutated, reported and passed, with broken rules and new commits stepping back." width="1358">
</picture>

Source: [diagrams/build-lane.excalidraw](diagrams/build-lane.excalidraw).

### CI

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/ci-dark.png">
  <img src="images/ci.png" alt="State diagram of the CI stage: running, which stays running while a job still runs, then passed or failed, and passed turns stale on a rebase." width="1008">
</picture>

Source: [diagrams/ci.excalidraw](diagrams/ci.excalidraw).

### Deploy

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/deploy-dark.png">
  <img src="images/deploy.png" alt="State diagram of the deploy stage: blocked, ready, then passed or failed, with a fixed failure going back to ready." width="843">
</picture>

Source: [diagrams/deploy.excalidraw](diagrams/deploy.excalidraw).

## 3. The review round loop

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/review-loop-dark.png">
  <img src="images/review-loop.png" alt="Flowchart of the review round loop: reviewers review alone and confer, the owner verifies each finding and records a disposition, fixes land as new commits, and rounds repeat until every reviewer says consensus on the same tip." width="1299">
</picture>

Source: [diagrams/review-loop.excalidraw](diagrams/review-loop.excalidraw).

## 4. Parallel lanes and their ownership

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/lanes-dark.png">
  <img src="images/lanes.png" alt="Diagram of the coordinator splitting work by files into lanes A, B and C, each in its own workspace, then stacking them and running the full e2e once." width="1308">
</picture>

Source: [diagrams/lanes.excalidraw](diagrams/lanes.excalidraw).

`pipeline lane` refuses a lane whose globs match a file another open lane owns. `pipeline commits` refuses a commit that touches another open lane's file, a new file included, unless the coordinator acknowledges it with `--outside`.

## 5. The hotfix fast lane

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/hotfix-dark.png">
  <img src="images/hotfix.png" alt="Flowchart of the hotfix fast lane: small fix commits with tests, touched e2e files, a scan, then local checks or CI depending on whether the hole is live, a light review and its own deploy." width="808">
</picture>

Source: [diagrams/hotfix.excalidraw](diagrams/hotfix.excalidraw).

## 6. The live play loop

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/live-play-dark.png">
  <img src="images/live-play.png" alt="Flowchart of the live play loop: exercise an isolated instance of the deployed commit the way its real users or clients would, check access boundaries where there are any, fix bugs or ask the owner, then report, decide and ship the fixes as a hotfix run." width="1178">
</picture>

Source: [diagrams/live-play.excalidraw](diagrams/live-play.excalidraw).

## 7. What the gate does with a push

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/gate-dark.png">
  <img src="images/gate.png" alt="Decision tree for a push: the gate checks the push form, the remote and config, then each ref, and either refuses with a reason or allows it." width="1378">
</picture>

Source: [diagrams/gate.excalidraw](diagrams/gate.excalidraw).

## 8. A deploy, step by step

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/deploy-steps-dark.png">
  <img src="images/deploy-steps.png" alt="Sequence diagram of a deploy between the coordinator, pipeline, GitHub, the deploy target and the user, with the deploy check, who runs the deploy, the post-deploy checks, the deploy record, the notification and cleanup." width="1288">
</picture>

Source: [diagrams/deploy-steps.excalidraw](diagrams/deploy-steps.excalidraw).
