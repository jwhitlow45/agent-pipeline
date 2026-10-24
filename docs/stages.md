# Stages: what the tool checks

Each run (a feature, a batch, a hotfix, a follow-up batch, a docs pass) is one JSON file in the ledger, `~/.local/state/agent-pipeline/runs/<run>.json`. Each stage records the facts it checked, on which commits, and its state. Each stage with a state is mirrored to GitHub as a commit status with the context `pipeline/<stage>`:

- stages about the change (intake, design, decisions, build, scan, ci, review, docs) go on the run's tip
- stages about the release (deploy, cleanup, live-play) go on the deployed commit.

Only commits GitHub has can carry a status, so a status appears once the commit is pushed. `pipeline mirror --run R` sets them again, and the PostToolUse hook sets them after every push.

A status describes only the evidence recorded for that exact commit. When the run's tip moves (new commits, an integration, a rebase), a stage recorded on the old tip shows as `pending` on the new one until it runs again, and a status on a tip never vouches for the commits under it.

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

The stage is `noted` when the note passes, and `passed` when the design review `T` has reached consensus in agent-review's ledger or the builtin one (or the user's skip is recorded with `--review-skip "<the user's words>"`). The pass binds the note's hash to the consensus it rests on (its round count and time). A note edited after that is refused. `--re-review` passes the edited note only once the review has reached a consensus newer than the bound one. A lane checks that its workspace holds the same note the reviewers agreed on.

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

An ID counts as logged only where an entry starts with it: in a heading, as the first word of a list item, or in a list item's label before its first colon, such as `- 2026-10-22 (coordinator, UI-3): ...`. An ID the text of an entry only mentions ("Rejected: the UI-2 rule") is not logged.

`pipeline brief` collects the IDs a brief names as decided (every ID on a line that says "decided", plus a `Decisions:` line) and refuses the brief when one is not in the log. `pipeline decisions --run R` checks every ID the run's briefs named.

**Judgment:** in guess mode, whether every product choice the user did not settle was logged. Sign-off `decisions/complete`. With `decisions.guessMode` on, the deploy gate needs this stage passed.

## build

### Lanes

`pipeline lane --run R --lane L --workspace DIR --owns GLOBS --brief F [--base REV] [--db NAMES] [--env K=V,...]`

- Needs intake and design passed.
- The workspace must be the root of a jj workspace or a git worktree of the run's own repository, and no other open lane may use it. A separate clone of the same GitHub repository is refused, since its commits never reach the run's repository.
- In git the worktree must be on a branch of its own (`git worktree add -b lane/<run>-<lane> <folder> <base id>`): not a detached HEAD, not trunk and not a `push.branches` match. The lane records that branch.
- In git the worktree must run the pipeline's pre-push hook, wherever its hooks path points. A missing hook, or one git skips because it is not executable, refuses the lane. A hook the pipeline cannot verify (any other file, husky's chain included) passes with a warning to check it by hand.
- `--owns` must not match a tracked file another open lane owns, in this run or any other open run of the repository. The check and the record are one step under a lock, so two lanes added at once cannot both claim a file.
- The brief must quote the user's words, point at the shared preamble (`brief.preamble`), and name only logged decisions.
- `--base` defaults to the remote trunk.

A lane stops owning its files when its run's cleanup passes or the run is abandoned.

### Commits

`pipeline commits --run R --lane L [--tip REV] [--outside "path: reason"]...` records the lane's commits from its base to its tip and checks each one:

- a conventional subject (`commits.types`), lowercase after the colon, one line, no em dash, no forbidden trailer
- a signature jj or git reports as good (`commits.acceptedSignatures`, and [config.md](config.md) for how git's signature codes read)
- every touched file inside the lane's globs, unless `--outside` gives the reason
- no file another open lane owns, a new file included
- feature list and user docs changes in their own commit, never with code (`docs.separateCommit`)
- for a fast run: at most `fastLane.maxFiles` files, and none under `fastLane.forbiddenPaths`.

### Checks

`pipeline check --run R --lane L [--e2e FILES|all]` runs the configured checks in order on the lane's tip and records each result (exit code, pass and fail counts read from the log, duration, the log's path):

1. `checks.parallel`, side by side
2. `checks.integration`, one after another
3. `checks.e2e.command` for each chosen file and each `checks.e2e.always` file, one at a time, with `checks.e2e.beforeEach` before each. A file whose `beforeEach` fails or runs past `checks.e2e.beforeEachTimeoutSec` fails without running.

It refuses a workspace with uncommitted changes, or one not on the lane's recorded tip. In git an untracked file or a changed submodule counts as uncommitted, whatever `.gitmodules` says, and a file flagged assume-unchanged or skip-worktree refuses, since git status cannot see edits to it. With `checks.stopOnFailure`, a failed phase stops the later ones, but the phase it is in finishes, so every failure there shows. On macOS it keeps the machine awake while it runs.

`pipeline check --record NAME --exit CODE --log F` records a check run elsewhere, and refuses it until the earlier phases passed on the same tip.

`pipeline check --run R --tip REV --workspace DIR` runs every check, every e2e file included, in a jj workspace whose working copy sits on that exact commit or a git worktree whose HEAD is it (`git worktree add --detach <folder> <id>`), and records the results for the commit. A run fixing a live hole deploys on these in place of CI.

### Mutation checks

`pipeline mutation --run R --lane L --commit REV --test FILE` writes the commit's exact files to a temporary folder (from a temporary index, with no filter, eol, ident or export rule applied, then checked file by file against the commit), links `mutation.link` (such as `node_modules`), runs the test and expects a pass, then removes the commit's code changes (everything but tests and docs) and expects a failure. A test that still passes is refused: it does not test the fix. `--manual "<how>" --exit CODE` records a check done by hand, where the fix and its test are in different commits.

### Integration

`pipeline integrate --run R --tip REV` records the stacked tip of several lanes as the run's tip. It refuses a tip that lacks any lane commit, matched by patch-id, and lists the commits no lane made (conflict resolutions), which the scan, CI and review cover. In git the coordinator stacks the lanes on a branch of their own: `git switch -c int/<run> <lane a tip>`, then `git cherry-pick <base>..lane/<run>-b` (or a merge), then `pipeline integrate --run R --tip HEAD`.

### Report and stage

`pipeline report --run R --lane L --file F` records the report file (and checks `report.sections` if set). `pipeline build --run R [--review-topic T]` passes the stage when every lane has commits that follow the rules, checks green in order on its tip with the always-run e2e files included, a mutation check for every commit that changes code and a test together (by commit ID or patch-id), a report, and the `build/scope` sign-off. With more than one lane, the run's tip must also be an integrated tip that holds every lane commit.

The gate refuses `agent-review start --topic T` for a registered code topic until the build passes.

**Judgment:** one commit per item, whole bug classes fixed, the brief followed. Sign-off `build/scope`.

## scan

`pipeline scan --run R [--base REV] [--tip REV] [--ack "<why each finding is fine>"]` scans each commit from the fork point with the remote trunk to the tip on its own: the lines its diff adds, its message and the paths it touches. A string one commit adds and the next removes still refuses, since the first commit would publish it. A finding names the commit and where, and never prints a private string or a secret.

Errors, which always refuse:

- a signature not in `commits.acceptedSignatures`
- a message matching `commits.forbiddenTrailers`, or holding an em dash
- an added `.env` file (`.env.example` and the like are fine)
- a string from `scan.private` (keep these in `pipeline.local.json`, never in the committed config), or a match of `scan.privateRegex`
- a path inside someone's home folder or the system's temp folders, on macOS, Linux or Windows
- a private key, a GitHub, Slack, AWS or API token, a Slack webhook
- an em dash in added content, when `scan.emDashInContent` is `error`.

In git the scan reads each commit as git's plumbing shows it under fixed settings, so no config, attribute or clone changes what it sees: a `-diff` file is scanned, as jj shows it. A merge of more than two parents is refused in git, since git cannot diff it in full: rebuild it as two-parent merges. A real binary file (a NUL byte in its first 8000 bytes) shows as "Binary files differ" in both backends, and the scan does not read its content.

Findings to look at, which pass only with `--ack`:

- a URL to a host not in `scan.allowedUrlHosts`
- an HTML sink: `dangerouslySetInnerHTML`, `innerHTML =`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function(`
- credentials in a URL, a password literal
- a change under `scan.workflowPaths` that mentions `pull_request_target`, a secret, a write permission or a deploy.

Files matching `scan.exclude` (images, lockfiles) are skipped. Each scan records the commit IDs it covered.

**Judgment:** whether each acknowledged finding is safe, and whether a new endpoint or permission change would expose a hole before review. The acknowledgment text is the record.

## push

The gate checks every `jj git push` and `git push` in plain form (see [integration.md](integration.md)), and resolves every ref the push would move. `pipeline push --run R --branch B` (`--bookmark` is the same) runs the same check and prints the commands: a bookmark set and a `jj git push` in jj, `git push origin <full id>:refs/heads/<branch>` in git.

What a push is checked against comes from the remote itself: one `git ls-remote` of the address the push really reaches, after `pushurl`, `insteadOf` and `pushInsteadOf`. A push address that reaches another repository than the fetch address is refused. jj's and git's record of the remote's branches must match the remote, or the gate says to fetch first. Every range starts at the trunk commit the remote reports, and a commit counts as published only when a branch the remote reports reaches it. The config the gate uses is the one committed at that trunk commit. While a jj alias in any config scope redefines a revset function, a template keyword or a symbol shaped like a commit or change id that the gate's reads use, or the repository's own jj or git config sets a program, a URL rewrite or a signing program, the gate refuses to act.

- jj: each bookmark given by exact name (`-b`, `--named NAME=REV`), each bookmark on the commits of `-r`, the name `-c` would create, and each bookmark `--all`, `--tracked` or `--deleted` would move. A pattern, a tag, an option the gate does not know, `--at-op`, `--ignore-working-copy`, `--config` in any form, or a push that names no bookmark is refused. `--tracked` and `--all` are refused when a tag would move with them. A commit that is a working copy, or sits under one, is refused before anything else, since jj would snapshot edits on disk into it. A bookmark already where the remote has it is then not counted. Only jj's built-in commands run: a short name (`st`, `b`) that config redefines is refused.
- git: the remote and each refspec, written out. Force in any spelling (`-f`, `--force-with-lease`, `+ref`, `--mirror`), `--no-verify`, `--all`, `--branches`, `--tags`, `--prune`, `--follow-tags`, `push.followTags`, `--receive-pack`, `--exec`, a submodule push, a pattern, a ref outside `refs/heads/`, `-c` and `--git-dir` are refused. Every option is spelled out in full, since git would take a prefix. A short destination that names a tag on the remote (`git push origin :v1`, `--delete origin v1`) or starts with `heads/`, `tags/` or `remotes/` is refused, and so is a source with no destination that is not a local branch. A refspec with no destination is refused while `remote.<name>.push` is set in any scope, or `push.default` is `upstream`, since git would map it elsewhere, and a repository whose own config sets `remote.<name>.push` refuses every action. A push from a folder where git finds no repository (a jj-only lane workspace) is refused. Only git's built-in commands run, never an alias. `git update-ref` of a remote-tracking or replace ref, and a fetch refspec that writes another remote's refs, are refused.
- git in a plain git repository, where the gate reads names the way `git push` does, which differs from `git rev-parse`:
  - Every destination is written in full, `refs/heads/<branch>`, deletions included (`--delete refs/heads/ci/x`), since git maps a short one through the remote's refs or the source's own kind.
  - A source is matched against local refs first, by git's own rules. Two matches, a match outside `refs/heads/` (a tag, a tracking ref) and a full id that a ref is named after are refused. Only when no ref matches is it an object name, and then it must be a full 40-digit commit id.
  - `HEAD` is the worktree's HEAD only while no ref named `HEAD` exists where git push looks (`refs/heads/HEAD`, `refs/tags/HEAD` and the like). An agent cannot make one: `git update-ref` or `git symbolic-ref` of a ref named `HEAD`, of a ref outside `refs/` other than the worktree's own `HEAD`, or with `--stdin` is refused. A delete (`-d`, `--delete`) is allowed, since it only puts git's reading back, and so is a write of the worktree's own `HEAD`, which `git reset` and `git switch` make too.
  - A push from a worktree of another repository is refused, by comparing git's common folders, so a linked worktree pushes as its own repository.
  - `jj git push` is refused there, and so is a jj bookmark set on a line that acts on the git repository: nothing in plain git reads a bookmark.
- Only `remote`, never another remote.
- Only `push.branches` (`ci/*` by default).
- Never a force push: a push that would move a remote branch to a commit its old commit is not an ancestor of is refused, and the refusal names the next free branch name (`pipeline push --next-name`).
- Every commit new to the remote must be in a passed scan.
- With `push.public`, no commit of a run marked `--live-hole` before its deploy passes, matched by commit id, by patch-id and by ancestry of every tip the run has had. An abandoned run still counts.
- A deletion is allowed for `push.branches` only, never for trunk.
- Trunk moves only as a deploy step. Under `deploy.runBy: "user"` an agent never moves it. Under `"agent"` the push must fast-forward trunk and pass the deploy check on the commit.

In jj, a bookmark set just before the push (`jj bookmark set ci/x -r <commit id> && jj git push --bookmark ci/x`) is checked at the commit it sets. Only `&&` joins them, so when the set fails the push does not run. Anything else before a push on the same line (a commit, a describe, a fetch) is refused: run it on its own first.

After a push, the PostToolUse hook records the run's tip as pushed, with the branches that carry it, and mirrors the run's statuses. It skips runs whose cleanup passed and abandoned runs.

The git pre-push hook runs the same check for a plain `git push`, from any worktree, scripts included. The URL git pushes to must reach the repository the gate reads, and the remote commit git reports for each branch must be the one the remote reported to the gate. In plain git it runs for the user's own pushes too: the user's push carries `PIPELINE_USER_PUSH=1`, which skips the rules for agents, and a push to trunk is still a deploy step (see deploy and [integration.md](integration.md#10-jj-and-plain-git)).

## ci

`pipeline ci --run R [--commit REV] [--wait] [--run-id ID]` reads, for each workflow in `ci.workflow`, its newest run on the exact commit in this repository. A run of another workflow, on another commit or in another repository never counts, `--run-id` included. A run counts only when it and every job say completed, and passes only when the run's conclusion and every job's are in `ci.okConclusions`. CI passes when every designated workflow passes. It records the runs, URLs, conclusions and jobs per commit. `pipeline/ci` links to the run. Without `--wait`, an unsettled run exits 3.

It needs `ci.workflow` set, the scan passed and the commit on the remote. A run fixing a live hole is refused: it deploys on local checks instead (see deploy).

## review

`pipeline review status --run R` computes coverage of trunk to the tip by patch-id, the way agent-review does: a commit passes when a review reached consensus on its patch-id, or the user's skip covers it. A commit with an empty diff needs no review.

- **In a plain git repository** `auto` means the builtin provider, and `agent-review` is refused, since agent-review reads jj repositories only. The gate refuses a line its checks would skip under a provider it cannot use.
- **With agent-review** (`review.provider` `auto` finds it), the pipeline only reads its ledger. agent-review sets its own `agent-review` status, so the pipeline sets no `pipeline/review` status.
- **Without it**, `pipeline review start|round|done|skip` keeps a builtin ledger in the same format, writes the review folder with round 1's request (the user's words filled in), and sets `pipeline/review`. `done` needs at least `review.minReviewers` replies saved in the round's `replies/` folder. `skip` needs the user's words.
- **Across machines**, `review.trustGithubStatus` also counts a success status from `agent-review` or `pipeline/review` on the tip, as consensus for the whole range up to it: a range attestation from a trusted writer. Only the newest status of each context counts, and only when a trusted writer set it (`review.trustedStatusWriters`, by default the repository's owner). The gate refuses an agent's `gh api` write of a `pipeline/*` or `agent-review` status, a status field read from a file included.

With the builtin provider, the gate also refuses a pull request created ready (`gh pr create` without `--draft`, `--draft=false` included, or a `gh api` write that is not a draft), `gh pr ready` and `gh pr merge` until every commit the pull request carries has consensus. Under either provider, a merge into trunk (`gh pr merge`, `--auto` included) is a deploy step and is held to the live-hole embargo, `--admin` is refused, and a pull request is named by its number. gh is read the way gh reads itself: `--repo` may come before the command, and only built-in commands run, never an alias or an extension. `gh pr close --delete-branch` and `gh pr merge --delete-branch` delete the pull request's branch on the remote, so they are held to the rules of a branch deletion: never trunk, only a branch agents push to, and never in a fork. A `--help` counts as help only where gh's own parse reads it as one: in `gh pr merge 1 --body --help` it is the body. A `gh api` write runs only when it is on the gate's short list (issues, comments, labels, draft pull requests, reviewer requests, run cancels, and statuses outside `pipeline/*`, `agent-review`, the CI workflow's own name and jobs, and the checks trunk's rules require). Everything else is refused: merges, ref and tag writes, releases, deployments and their approvals, dispatches, contents, any write to `repositories/<id>`, and every GraphQL mutation not on `github.allowedMutations`, which is empty by default. `gh release`, `gh secret`, `gh pr review` and other writes the gate does not check are refused, and so is curl or wget sending a write or a credential to GitHub. curl and wget reach GitHub only with read options from an exact list, so a header read from a file (`-H @file`), curl's `--variable` and `--expand-*`, and any option abbreviation are refused.

**Judgment:** every finding's disposition and the consensus itself.

## rebase

`pipeline rebase --run R --tip REV`, after rebasing onto main: lists the commits that keep their patch-id, those whose diff changed, and those that now lack review consensus. It moves the run's tip, so every stage recorded on the old tip (scan, push, CI, review, docs) goes `stale`. Lane commits are matched to the new ids by patch-id, and in jj by change id first. A commit whose diff changed carries none of its evidence. git has no change ids, so in git a lane commit whose diff changed is marked lost, the lane keeps its old tip, and the build needs `pipeline commits` again. In git the rebase is `git fetch --prune origin && git rebase --onto origin/main <old base> <branch>`, then `pipeline rebase --tip <id>`. The build carries over when every diff kept its patch-id and every lane commit is in the new range, and goes `stale` otherwise. It names the review round to run when coverage was lost.

## deploy

`pipeline deploy check --run R [--tip REV]` passes when:

- the run is not abandoned
- intake, design and build passed (decisions too in guess mode, docs too for a docs run)
- every commit from the remote trunk to the tip has code review consensus or the user's recorded skip
- a settled, green run of every `ci.workflow` exists for the exact tip. A run fixing a live hole needs instead every check, every e2e file included, recorded on the exact tip with `pipeline check --tip`.
- every commit is in a passed scan
- the docs rules hold for the range (see docs).

It prints `deploy.command` filled in. The gate knows the deploy script by its real path and its content, as `deploy.command` named it, so a link or a copy of the script is the same script, run from any folder, and a wrapper or another program it is passed to is refused. Pointing `deploy.command` elsewhere does not free a script it named before. `deploy.match` applies only inside the repository's own folders. A script two repositories name is refused, whichever is registered first. With `deploy.runBy: "user"` it says to give the user the command, and the gate refuses the deploy script, every workflow not on `deploy.allowedWorkflows`, and every move of trunk (a push, `gh pr merge` into trunk) for agents. With `"agent"`, the gate runs the deploy check on the commit the script deploys (`deploy.tipArg`) or a deploy workflow's `--ref` names on the remote, and refuses a commit that is a working copy. In git a deploy script run outside every worktree has no HEAD of its own, so its revision must be a full commit id or a full ref name (`refs/heads/main`, `refs/tags/v1`, `refs/remotes/origin/main`) that is not symbolic, with only `~n` and `^n` after it: a short name can mean a root ref the gate cannot see. When two registered clones could be the one it acts on, only a full commit id passes.

In plain git, `pipeline deploy check` also prints how trunk moves: `git push origin <full id>:refs/heads/main` for an agent under `"agent"`, and `PIPELINE_USER_PUSH=1 git push origin <full id>:refs/heads/main` for the user under `"user"`, which the pre-push hook lets through only for a fast-forward to a commit this check passes. A workflow is resolved to one file and id, the way gh resolves its argument (an id, a file, or a display name only one workflow has). It is a production deploy when its path, its name, an `environment:` its file names on trunk, or an input matches `deploy.prodPattern`, and that is always refused. A rerun of a deploy workflow is refused too, since its inputs are not visible to the gate.

A run fixing a live hole deploys from the local commit, and its commits reach the public remote only after the deploy passes: [the example deploy script](../profiles/raccoon-vtt/deploy.example.sh) asks `pipeline deploy check` first, deploys the exact local commit, checks the server, and only then pushes main.

`pipeline deploy record --run R --name N --shipped "<what shipped>" --health H [--backup B --load N/M --http "200 200" --restarts 0]` checks each of `deploy.requiredChecks` (`health` by default) and ignores the rest: health in `deploy.healthyValues`, a backup name, a load check with every record loaded, every HTTP answer 2xx or 3xx, and zero restarts. It refuses to record a deploy the gate would have refused, unless `--ungated "<why>"`. It sends the notification ("Deployed N: what shipped", or "Deploy of N failed: why") through `notify.command`. `--failed [why]` records a failed deploy, notification included.

**Judgment:** the go-ahead for production, where the user runs deploys. The user runs the command, and the agent records the results with `--by user`.

## cleanup

`pipeline cleanup --run R` needs the deploy passed and lists what is left, with the commands to fix each:

- every branch the run pushed that is merged but still on the remote (merged means its tip is in trunk, or every commit it adds has the patch-id of a commit trunk gained since it forked)
- lane workspaces still in jj's list, or lane worktrees still in git's list (`git worktree remove`, or `git worktree prune` when the folder is gone), their folders, and in git each lane's branch (`git branch -D lane/<run>-<lane>`)
- in jj, a stale main workspace (`jj workspace update-stale`)
- scratch databases still listed by `cleanup.databaseList`
- review folders not archived (moved to `cleanup.archiveDir`)
- the deploy notification, when `notify.command` is set.

It passes when nothing is left, and releases the run's lanes, so their files can be owned by new lanes.

## abandon

`pipeline abandon --run R --reason "<the user's words>" --by WHO` stops a run for good. It records who decided and why, releases the run's lanes, and prints the cleanup commands for its branches, workspaces and databases. The run never deploys, and `pipeline status` lists it only with `--all`. A run fixing a live hole keeps its commits off the public remote, since stopping the work does not close the hole. Work picked up again starts a new run.

## live-hole

A run marked `--live-hole` stays off a public remote until its deploy passes. Two decisions end or loosen that, and both are the user's. They record who decided and why in the run's events, and keep every commit id, patch id and tip the run knows. The gate refuses both from agents: give the user the command.

- `pipeline live-hole close --run R --by WHO --reason "<the user's words>"`: the hole is no longer live (fixed another way, or it never reached the server), so the run's embargo ends.
- `pipeline live-hole waive --run R --by WHO --reason "<the user's words>"`: commits recorded before git ids existed that no clone can read any more stop refusing. The embargo stays in force for everything else the run knows. A reason that only says "unrecoverable" is refused.

A run recorded before git ids existed holds only jj's ids. Any pipeline command in its own repository adds the git ids from the objects it holds, so a plain git clone can match them. Until then, a clone that lacks one of its commits refuses every push, merge into trunk and trunk move: run `pipeline status --run R` once in the repository that recorded it.

## live-play

Live play exercises a running copy of the deployed commit the way its real users or clients would, on an isolated instance, never production ([process.md](process.md#13-live-play) says what that means for each kind of software). The tool records its bugs and checks how each one ended. What to exercise and how is the live play brief's job, not the tool's.

`pipeline live-play start --run R --prefix LP3 [--workspace DIR] [--db NAMES] [--brief F]` needs a passed deploy and starts on the deployed commit. `--workspace` is the isolated instance's checkout and `--db` its scratch databases, if any. Bugs are added one at a time (`live-play bug --id --severity --area --summary --status fixed|needs-owner|known|not-a-bug [--commit] [--recommend]`) or from the report's table (`live-play import --report F`, with rows `| ID | Sev | Area | Bug | Status |` and a status cell of `fixed <commit>` or `needs owner: <recommendation>`).

`pipeline live-play done --run R` passes when:

- every ID matches `livePlay.idPattern` (`LP3-AREA-1`) and has a severity P0 to P3
- every fixed bug's commit is a `fix` commit, touches at most `livePlay.maxFilesPerFix` files, and has shipped: its patch-id is in trunk, which means it went through review and a deploy
- every needs-owner bug is resolved with a logged decision (`live-play resolve --id X --decision ID`) or a backlog item (`--followup ID`)
- the `live-play/bug-fix-only` sign-off is in.

**Judgment:** that each fix only fixes and changes no documented behavior. Sign-off `live-play/bug-fix-only`.

## followups

`pipeline followup add --run R --id ID --severity P3 --source S --text T --files F,...` adds to the repository's backlog. Each change to the backlog is one step under a lock, so agents adding items at once keep every item. A P0 to P2 item needs `--decision ID` naming a logged decision that defers it, since those findings block review. `followup plan --lanes N [--ids ...] [--apply]` groups items that share a file and deals the groups into lanes, so no file is in two lanes, and prints the `pipeline lane` commands. `followup close --id ID --commit REV` closes an item. `followup list [--open]` prints the backlog as a table.

## docs

`pipeline docs --run R [--tip REV]` checks the range from trunk to the tip:

- a `feat` commit that changes `docs.behaviorPaths` needs `docs.featureList` updated in the same range
- a change to `docs.shortcutSources` (a key map, a CLI's option table, an API schema) needs every file in `docs.shortcutDocs` updated in the same range
- feature list and user docs changes stay out of code commits (checked per commit, at `pipeline commits`).

Each rule is off until its keys are set. The deploy check runs the same rules and records this stage. For a docs run (a docs pass), it also needs `docs.guide` changed when it is set, new files matching `docs.screenshots` when they are set, and the `docs/read-through` sign-off. `pipeline docs --run R --due` lists the feature runs deployed since the last docs pass.

**Judgment:** whether the user docs read well as a whole. Sign-off `docs/read-through`, or the project's own item in `signoffs.docs`.

## notifications

`pipeline deploy record` notifies at every deploy, failed ones included. `pipeline notify --run R --event waiting --message "Need input: ..."` sends a notification for a stop that waits on the user, and refuses one that does not start with `Need input:` and hold the question. Every notification is recorded in the run, and cleanup checks the deploy's.

## sign-offs

`pipeline signoff --run R --stage S --item I --by WHO --note "<what was checked>"` records a judgment call. The configured items (`signoffs`) are required by their stage:

- `decisions/complete`, in guess mode
- `build/scope`
- `live-play/bug-fix-only`
- `docs/read-through`, for docs runs.

A project adds its own in `signoffs`, and `--extra` records one that is not configured.
