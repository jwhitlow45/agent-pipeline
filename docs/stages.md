# Stages: what the tool checks

Each run (a feature, a batch, a hotfix, a follow-up batch, a guide pass) is one JSON file in the ledger, `~/.local/state/agent-pipeline/runs/<run>.json`. Each stage records the facts it checked, on which commits, and its state. Each stage with a state is mirrored to GitHub as a commit status with the context `pipeline/<stage>`:

- stages about the change (intake, design, decisions, build, scan, ci, review, docs) go on the run's tip
- stages about the release (deploy, cleanup, live-play) go on the deployed commit.

Only commits GitHub has can carry a status, so a status appears once the commit is pushed. `pipeline mirror --run R` sets them again, and the PostToolUse hook sets them after every push.

Each section below gives the command, what it checks mechanically, what it refuses, and what stays a judgment call with its sign-off. [process.md](process.md) explains why each rule exists.

## intake

`pipeline intake --run R --words-file F [--kind feature|fast|hotfix|followups|docs] [--ui] [--live-hole]`

- Records the user's words verbatim, with their hash. Refuses empty words, and a run name already used.
- `--ui` makes the design check require a UI and UX section. `--live-hole` keeps the run's commits off a public remote until its deploy passes.

Every later request must quote the words. Three places check that:

- `pipeline brief --run R --file F --kind build|design|review|live-play|followups` refuses a brief that does not quote them (whitespace may differ, nothing else). A `fix` brief points at the review instead, so it need not quote them.
- The builtin review writes them into round 1's request.
- The gate refuses `agent-review ask` for round 1 of a run's review when its request does not quote them.

## design

Feature runs: `pipeline design --run R --note F --review-topic T`. Other runs: `pipeline spec --run R --file F`.

Checks on the note:

- at most `design.maxLines` lines (520 by default, against a 400-line target) before the first Appendix heading, unless `--allow-long "<reason>"` records why
- a UI and UX section when the run has UI
- each section in `design.requiredSections` (Tests and Build plan by default)
- no em dash.

The stage is `noted` when the note passes, and `passed` when the design review `T` has reached consensus in agent-review's ledger or the builtin one (or the user's skip is recorded with `--review-skip "<the user's words>"`). A note edited after consensus is refused until another round agrees and `--re-review` is passed. A lane checks that its workspace holds the same note the reviewers agreed on.

A spec must quote the user's words and stay under `fastLane.specMaxLines` lines. A spec is also checked for decision IDs.

The gate refuses `agent-review start --topic T` for a registered design topic until the note passes its checks.

**Judgment:** whether the design is right is the design review's consensus.

## decisions

`pipeline decide --id ID --chose TEXT --why TEXT --rejected TEXT [--title T] [--run R]` appends to the decision log:

```
## 2026-10-22: UI-3, the theme is remembered per device (run dark-mode)
- Chosen: ...
- Why: ...
- Rejected: ...
```

It refuses an entry without all three parts, an em dash, an ID that does not match `decisions.idPattern`, and an ID already logged.

`pipeline brief` collects the IDs a brief names as decided (every ID on a line that says "decided", plus a `Decisions:` line) and refuses the brief when one is not in the log. `pipeline decisions --run R` checks every ID the run's briefs named.

**Judgment:** in guess mode, whether every product choice the user did not settle was logged. Sign-off `decisions/complete`. With `decisions.guessMode` on, the deploy gate needs this stage passed.

## build

### Lanes

`pipeline lane --run R --lane L --workspace DIR --owns GLOBS --brief F [--base REV] [--db NAMES] [--env K=V,...]`

- Needs intake and design passed.
- The workspace must be the root of a jj workspace of the same repository, and no other open lane may use it.
- `--owns` must not match a tracked file another open lane owns, in this run or any other open run of the repository.
- The brief must quote the user's words, point at the shared preamble (`brief.preamble`), and name only logged decisions.

### Commits

`pipeline commits --run R --lane L [--tip REV] [--outside "path: reason"]...` records the lane's commits from its base to its tip and checks each one:

- a conventional subject (`commits.types`), lowercase after the colon, one line, no em dash, no forbidden trailer
- a signature jj reports as good (`commits.acceptedSignatures`)
- every touched file inside the lane's globs, unless `--outside` gives the reason
- no file another open lane owns, a new file included
- feature list and guide changes in their own commit, never with code (`docs.separateCommit`)
- for a fast run: at most `fastLane.maxFiles` files, and none under `fastLane.forbiddenPaths`.

### Checks

`pipeline check --run R --lane L [--e2e FILES|all]` runs the configured checks in order on the lane's tip and records each result (exit code, pass and fail counts read from the log, duration, the log's path):

1. `checks.parallel`, side by side
2. `checks.integration`, one after another
3. `checks.e2e.command` for each chosen file and each `checks.e2e.always` file, one at a time, with `checks.e2e.beforeEach` before each.

It refuses a workspace with uncommitted changes, or one not on the lane's recorded tip. With `checks.stopOnFailure`, a failed phase stops the later ones, but the phase it is in finishes, so every failure there shows. On macOS it keeps the machine awake while it runs.

`pipeline check --record NAME --exit CODE --log F` records a check run elsewhere, and refuses it until the earlier phases passed on the same tip.

### Mutation checks

`pipeline mutation --run R --lane L --commit REV --test FILE` exports the commit's tree to a temporary folder, links `mutation.link` (such as `node_modules`), runs the test and expects a pass, then removes the commit's code changes (everything but tests and docs) and expects a failure. A test that still passes is refused: it does not test the fix. `--manual "<how>" --exit CODE` records a check done by hand, where the fix and its test are in different commits.

### Report and stage

`pipeline report --run R --lane L --file F` records the report file (and checks `report.sections` if set). `pipeline build --run R [--review-topic T]` passes the stage when every lane has commits that follow the rules, checks green in order on its tip with the always-run e2e files included, a mutation check for every commit that changes code and a test together (by commit ID or patch-id), a report, and the `build/scope` sign-off.

The gate refuses `agent-review start --topic T` for a registered code topic until the build passes.

**Judgment:** one commit per item, whole bug classes fixed, the brief followed. Sign-off `build/scope`.

## scan

`pipeline scan --run R [--base REV] [--tip REV] [--ack "<why each finding is fine>"]` scans the commits from the fork point with trunk to the tip, and their added lines.

Errors, which always refuse:

- a signature not in `commits.acceptedSignatures`
- a message matching `commits.forbiddenTrailers`, or holding an em dash
- an added `.env` file (`.env.example` and the like are fine)
- a string from `scan.private` (keep these in `pipeline.local.json`, never in the committed config), or a match of `scan.privateRegex`
- a path inside someone's home folder or the system's temp folders, on macOS, Linux or Windows
- a private key, a GitHub, Slack, AWS or API token, a Slack webhook
- an em dash in added content, when `scan.emDashInContent` is `error`.

Findings to look at, which pass only with `--ack`:

- a URL to a host not in `scan.allowedUrlHosts`
- an HTML sink: `dangerouslySetInnerHTML`, `innerHTML =`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function(`
- credentials in a URL, a password literal
- a change under `scan.workflowPaths` that mentions `pull_request_target`, a secret, a write permission or a deploy.

Files matching `scan.exclude` (images, lockfiles) are skipped. Each scan records the commit IDs it covered.

**Judgment:** whether each acknowledged finding is safe, and whether a new endpoint or permission change would expose a hole before review. The acknowledgment text is the record.

## push

The gate checks every `jj git push` and `git push`. `pipeline push --run R --bookmark B` runs the same check and prints the commands.

- Only named bookmarks: `--all`, `--tracked`, `-c`, `-r`, a pattern, or no bookmark at all are refused.
- Only `remote`, never another remote.
- Only `push.branches` (`ci/*` by default). Trunk moves only as a deploy step, with the deploy gate.
- Never a force push: `git push -f`, `--force-with-lease`, `+ref` and `--mirror` are refused, and so is a jj push that would move a remote branch to a commit its old commit is not an ancestor of. The refusal names the next free branch name (`pipeline push --next-name`).
- Every commit new to the remote must be in a passed scan.
- With `push.public`, no commit of a run marked `--live-hole` before its deploy passes.
- A deletion is allowed for `push.branches` only.

A bookmark set earlier in the same command (`jj bookmark set ci/x -r @- && jj git push --bookmark ci/x`) is checked at the commit it will point to.

After a push, the PostToolUse hook records the run's tip as pushed, with the branches that carry it, and mirrors the run's statuses.

## ci

`pipeline ci --run R [--commit REV] [--wait] [--run-id ID]` reads the newest run of `ci.workflow` for the exact commit. It counts only when the run and every job say completed, and passes only when the run's conclusion and every job's are in `ci.okConclusions`. It records the run ID, URL, conclusion and jobs per commit. `pipeline/ci` links to the run. Without `--wait`, an unsettled run exits 3.

It needs the scan passed and the commit on the remote.

## review

`pipeline review status --run R` computes coverage of trunk to the tip by patch-id, the way agent-review does: a commit passes when a review reached consensus on its patch-id, or the user's skip covers it. A commit with an empty diff needs no review.

- **With agent-review** (`review.provider` `auto` finds it), the pipeline only reads its ledger. agent-review sets its own `agent-review` status, so the pipeline sets no `pipeline/review` status.
- **Without it**, `pipeline review start|round|done|skip` keeps a builtin ledger in the same format, writes the review folder with round 1's request (the user's words filled in), and sets `pipeline/review`. `done` needs at least `review.minReviewers` replies saved in the round's `replies/` folder. `skip` needs the user's words.
- **Across machines**, `review.trustGithubStatus` also counts a success status from `agent-review` or `pipeline/review` on the tip.

With the builtin provider, the gate also refuses `gh pr ready` and `gh pr merge` until every commit the pull request carries has consensus.

**Judgment:** every finding's disposition and the consensus itself.

## rebase

`pipeline rebase --run R --tip REV`, after rebasing onto main: lists the commits that keep their patch-id, those whose diff changed, and those that now lack review consensus. It sets scan, push and CI to `stale`, since the commit IDs changed, and build to `stale` when a diff changed. It names the review round to run when coverage was lost.

## deploy

`pipeline deploy check --run R [--tip REV]` passes when:

- intake, design and build passed (decisions too in guess mode, docs too for a docs run)
- every commit from trunk to the tip has code review consensus or the user's recorded skip
- a settled, green CI run exists for the exact tip
- every commit is in a passed scan
- the docs rules hold for the range (see docs).

It prints `deploy.command` filled in. With `deploy.runBy: "user"` it says to give the user the command, and the gate refuses the deploy command (`deploy.match`) and any deploy workflow for agents. With `"agent"`, the gate runs the deploy check on the commit the command deploys (`deploy.tipArg`). A workflow whose name or `environment` input says prod is always refused.

`pipeline deploy record --run R --name N --shipped "<what shipped>" --backup B --health H --load N/M --http "200 200"` checks each of `deploy.requiredChecks`: a backup name, health in `deploy.healthyValues`, a load check with every record loaded, every HTTP answer 2xx or 3xx, and zero restarts when `restarts` is required. It refuses to record a deploy the gate would have refused, unless `--ungated "<why>"`. It sends the notification ("Deployed N: what shipped", or "Deploy of N failed: why") through `notify.command`. `--failed [why]` records a failed deploy, notification included.

**Judgment:** the go-ahead for production, where the user runs deploys. The user runs the command, and the agent records the results with `--by user`.

## cleanup

`pipeline cleanup --run R` needs the deploy passed and lists what is left, with the commands to fix each:

- every branch the run pushed that is merged but still on the remote (merged means its tip is in trunk, or every commit it adds has the patch-id of a commit trunk gained since it forked)
- lane workspaces still in jj's list, and their folders
- a stale main workspace (`jj workspace update-stale`)
- scratch databases still listed by `cleanup.databaseList`
- review folders not archived (moved to `cleanup.archiveDir`)
- the deploy notification, when `notify.command` is set.

It passes when nothing is left, and releases the run's lanes, so their files can be owned by new lanes.

## live-play

`pipeline live-play start --run R --prefix LP14 [--workspace DIR] [--db NAMES] [--brief F]` needs a passed deploy and starts on the deployed commit. Bugs are added one at a time (`live-play bug --id --severity --area --summary --status fixed|needs-owner|known|not-a-bug [--commit] [--recommend]`) or from the report's table (`live-play import --report F`, with rows `| ID | Sev | Area | Bug | Status |` and a status cell of `fixed <commit>` or `needs owner: <recommendation>`).

`pipeline live-play done --run R` passes when:

- every ID matches `livePlay.idPattern` (`LP14-AREA-1`) and has a severity P0 to P3
- every fixed bug's commit is a `fix` commit, touches at most `livePlay.maxFilesPerFix` files, and has shipped: its patch-id is in trunk, which means it went through review and a deploy
- every needs-owner bug is resolved with a logged decision (`live-play resolve --id X --decision ID`) or a backlog item (`--followup ID`)
- the `live-play/bug-fix-only` sign-off is in.

**Judgment:** that each fix only fixes and changes no documented behavior. Sign-off `live-play/bug-fix-only`.

## followups

`pipeline followup add --run R --id ID --severity P3 --source S --text T --files F,...` adds to the repository's backlog. A P0 to P2 item needs `--decision ID` naming a logged decision that defers it, since those findings block review. `followup plan --lanes N [--ids ...] [--apply]` groups items that share a file and deals the groups into lanes, so no file is in two lanes, and prints the `pipeline lane` commands. `followup close --id ID --commit REV` closes an item. `followup list [--open]` prints the backlog as a table.

## docs

`pipeline docs --run R [--tip REV]` checks the range from trunk to the tip:

- a `feat` commit that changes `docs.behaviorPaths` needs `docs.featureList` updated in the same range
- a change to `docs.shortcutSources` needs every file in `docs.shortcutDocs` updated in the same range
- feature list and guide changes stay out of code commits (checked per commit, at `pipeline commits`).

The deploy check runs the same rules and records this stage. For a docs run (a guide pass), it also needs `docs.guide` changed, new files matching `docs.screenshots`, and the `docs/guide-voice` sign-off. `pipeline docs --run R --due` lists the feature runs deployed since the last guide pass.

**Judgment:** whether the guide reads well as a whole. Sign-off `docs/guide-voice`.

## notifications

`pipeline deploy record` notifies at every deploy, failed ones included. `pipeline notify --run R --event waiting --message "Need input: ..."` sends a notification for a stop that waits on the user, and refuses one that does not start with `Need input:` and hold the question. Every notification is recorded in the run, and cleanup checks the deploy's.

## sign-offs

`pipeline signoff --run R --stage S --item I --by WHO --note "<what was checked>"` records a judgment call. The configured items (`signoffs`) are required by their stage:

- `decisions/complete`, in guess mode
- `build/scope`
- `live-play/bug-fix-only`
- `docs/guide-voice`, for docs runs.

A project adds its own in `signoffs`, and `--extra` records one that is not configured.
