# The delivery process

This is how a coordinating agent takes a user's request to a shipped, played and documented change, with other agents doing the design, the build, the review and the play. It was worked out over a long run of feature work on one project, the web app in [profiles/raccoon-vtt](../profiles/raccoon-vtt/), and it is written here for an agent or engineer who has never seen that project.

Nothing in the process assumes a kind of software: a web app, an API service, a CLI, a library and a mobile app all go through the same stages. A step that applies only to some software, such as a UI and UX section, a database, user docs or screenshots, says so, and its config stays off until a project turns it on.

The process has two halves. The judgment half is people and agents deciding things: what to build, whether a design is right, whether a finding blocks. The mechanical half is everything a tool can check: that a brief quotes the user, that checks ran in order and passed, that a branch was scanned before it was pushed, that CI finished on the exact commit being deployed. The `pipeline` CLI in this repository records the mechanical half in a ledger, mirrors each stage to GitHub as a commit status, and refuses a step whose earlier stages have not passed. [stages.md](stages.md) lists what each stage checks. [diagrams.md](diagrams.md) draws the flow.

## Roles

- **The user** owns the product. The user's words start every piece of work, and the user's say is final on product behavior, on skipping a review and on production deploys.
- **The coordinator** is the agent the user talks to. It plans, writes briefs, launches the other agents, verifies what they report, decides the questions the user has delegated, integrates their commits and deploys. It is the implementation owner in every review and the last party to consensus.
- **Designers** write design notes.
- **Builders** each own one lane: a set of files, one jj workspace, one brief.
- **Reviewers** are independent and read-only. At least one is a Claude model and at least one a Codex model, so no single model's blind spots decide.
- **Live play agents** exercise a running copy of the deployed build the way its real users or clients would, and fix what breaks ([live play](#13-live-play)).

## Rules that hold everywhere

- **The user's words are kept verbatim.** The coordinator records them once, and every later brief and review request quotes them. A paraphrase loses the details reviewers need to check the work against.
- **Guess mode, when the user turns it on.** The coordinator never stops to ask a product question. It picks the answer the user would most likely give (in practice the recommended option and whatever was decided before), and logs the choice, the reason and the rejected options in a decision log. The user can overrule any of them later. Things outside product choices still go to the user: risky or irreversible actions, production deploys, anything that speaks for the user.
- **Parallel by default, with clear ownership.** Independent work starts as soon as its inputs exist: the next design while the current build runs, live play beside the next build, typecheck, unit tests and build side by side. Parallel builders never touch the same file.
- **Short reports, full detail in files.** Every agent writes its full report to a file and sends the coordinator about ten lines: change IDs, check results, blockers, questions and the file's path. The coordinator's context is the most expensive one, so it opens the file only to make a decision.
- **Checks are exact.** A report quotes the commands and their pass and fail counts, never "tests pass". Every log is read in full.
- **Commits are one line, conventional, signed, with no AI or co-author trailers and no em dashes.** One commit per item or per coherent step.
- **Never force push.** That includes branches only the coordinator uses. A rewritten stack goes to a new branch name.
- **The machine stays awake** during long work, and the coordinator notifies the user at every deploy and at every stop that waits on the user.
- **Production deploys are the user's** wherever the user has said so. Agents give the user the command.

## What the tool enforces, and what it cannot

The gate is a guardrail for cooperative agents. It stops an agent that makes an honest mistake from running a push, a deploy, a merge or a dispatch whose earlier stages have not passed, and names the stage to run first. It checks each action against the remote itself and the config committed on the remote's trunk, never against local refs or settings an agent could change.

It is not a security boundary, and not a sandbox. It does not try to stop an agent that is working to get around it: a script, a build tool or a shell function a persistent shell kept from an earlier call runs unseen. So every "never" in this process (never force push, never move trunk without a deploy check, never run a production deploy) rests on enforcement outside the agent's machine: branch protection on every branch and tag, required status checks from an identity agents cannot use, deploy keys that keep production credentials off the agent's machine, environment protection rules with the user as a required reviewer on production, and agent tokens without the rights to bypass them. A repository that needs a hard boundary must set these. [integration.md](integration.md#7-what-the-gate-is-for) lists the exact settings, and `pipeline doctor` checks most of them.

## The flow

### 1. Intake

The coordinator records the request word for word (`pipeline intake`). It notes whether the change has a UI, whether it fixes a hole that is live in the deployed build (which changes the push rules), and which kind of run it is:

- **feature**: anything that touches stored data, permissions, a protocol or public API, or more than a few files. It gets a design note and a design review.
- **fast**: a small tweak, wording, or a change to a few files with no data, permission, protocol or API change. A builder works from a short written spec, and a small review batch of two reviewers checks it.
- **hotfix**: fixes from live play or a production bug. Like fast, but its spec cites the bug IDs.
- **followups**: a batch of backlog items that are already decided.
- **docs**: a docs pass, which reads and reworks the user docs as a whole, with new screenshots where the software has a UI.

### 2. Design

A designer writes a design note of about 400 lines: the rules, an edge-case matrix, the tests and a build plan, in commits a builder can follow. A change with UI has a UI and UX section. Measured numbers and worked examples go in an appendix that later review rounds do not reread. Long notes were where most later-round findings came from: contradictions between sections and numbers left stale by a fix.

When two or more designs share a component, one short shared contract is written and agreed first, and the designs cite it.

The note goes through a design review with no commits (the routine's `--no-commits` mode) until every reviewer agrees. The note's last section lists the choices the designer made that the user's words do not settle, each to be checked. Once round 1's dispositions leave a section untouched, the build of that section may start while later rounds run.

### 3. Decisions

Every product question the user did not settle gets an ID and an entry in the decision log: chosen, why, rejected. Briefs cite decisions by ID ("**UI-3, decided:** ..."), and `pipeline brief` refuses a brief that cites an ID the log does not hold. Agents send their own product questions to the coordinator, who decides and logs them, so builders never wait on the user.

### 4. Build

The coordinator splits the work into lanes. Each lane gets:

- **its own jj workspace**, named `<repo>-<task>` beside the main one, started from the newest stacked tip rather than from main
- **a set of files it owns**, which no other open lane owns
- **a brief** that points at the shared preamble (the rules every agent follows), quotes the user's words, names the design sections or items, the base commit, the ports and databases it may use, the checks to run, and what to report.

The builder commits one signed conventional commit per item. Feature list and user docs changes go in the lane's own last commit, never mixed into code commits, since those files conflicted at almost every stacking. New e2e step labels carry a lane prefix, and a new setting goes on its own lines at the end of its group, for the same reason.

Checks run in a set order and the exact results are recorded:

1. the independent checks, such as typecheck, unit tests and build, side by side, each with its own log
2. integration tests, after them, since they often share state such as a database
3. end-to-end (e2e) files, which drive the software from outside the way its users or clients do, one at a time: the files the change touches plus a small set every lane runs. The full e2e set runs once on the stacked tip, by the integration step or by CI.

When an e2e file fails, diagnosis starts at once, while the rest of the run goes on. The rerun waits for the run to finish, so every failure is seen.

Every new test is mutation-checked: with its fix removed, it must fail. Code that juggles retries, cancels, timeouts and late answers also gets one randomized test that runs many event sequences and checks the invariants that must always hold. Builders fix a whole class of bug, not only the reported instance.

The builder ends with its report file and a short message.

### 5. Integration

When several lanes build one feature, the coordinator stacks them, resolves the mechanical conflicts itself (feature list and user docs conflicts are the common ones), records the stacked tip (`pipeline integrate`, which checks that it holds every lane commit), and checks it. Batches stay small: two or three features, about 25 commits. A batch goes to review as soon as its lanes land, and the next batch builds on top while it is reviewed.

### 6. Pre-push scan

Pushing a branch to a public repository publishes it at once, and a deleted branch stays in caches and forks. So every range is scanned before it leaves the machine (`pipeline scan`):

- errors that always block: an unsigned commit, an AI trailer, an em dash in a message, a private string (the live domain, the deploy host), a home folder path, a secret, an added `.env` file
- findings someone must look at and acknowledge with a reason: URLs to hosts not on the allow list, HTML sinks (`innerHTML` and the like), credentials in a URL, workflow changes that add secrets, write permissions or a deploy.

A fix for a hole that is live in the deployed build is never pushed to a public branch before it deploys, since the branch would advertise the hole. That holds for a copy or a rebase of the fix too. Every check, every e2e file included, runs on this machine on the exact commit to deploy (`pipeline check --tip`), and stands in for CI.

### 7. Push

Agents push only to `ci/*` branches, and only commits a passed scan covered. They never force push. jj moves a bookmark "sideways" without a flag when the commits under it were rewritten, and that is a force push too. So before every push the remote branch's commit must be an ancestor of the new tip. When it is not, the stack goes to a new name (`ci/x-2`), and the old local bookmark is forgotten. The old branch is deleted once its work is in main.

### 8. CI

CI runs every check, with the e2e files in shards when the set is long. Only a run of the project's designated CI workflow, on the exact commit, in the project's own repository counts, and only once every job has finished: GitHub can report a run as completed while a job is still running. The run ID and result are recorded per commit (`pipeline ci --wait`), and a later deploy needs a green run on that exact commit.

### 9. Code review

Code review runs the review routine (agent-review): two to four independent reviewers, at least one Claude and one Codex, each in a fresh session.

- **Round 1 is the exhaustive one.** The request quotes the user's words, numbers every choice the user did not spell out, gives the exact verification results, and asks for every finding at every severity at once, with the class of each bug and where else it occurs.
- **Confer.** Each reviewer reads the others' replies and agrees or disagrees with each finding, with evidence.
- **Dispositions.** The coordinator verifies every finding against the code before accepting it, then gives each one a disposition: adopted with its fix, declined with the reason, or a question for the user. Product questions go to the user or, in guess mode, to the decision log.
- **Fixes** are new commits on top, never folded into pushed commits.
- **Next round.** Reviewers agree or disagree with each disposition in one line and check the fixes for regressions. A reviewer who agreed and has no open finding may sit out a round unless the fix touches its area. The reviewer who raised a finding always checks its fix.
- **P3 findings never block.** They go to the follow-up backlog.
- **Consensus** is every remaining reviewer saying so on the same tip, and the coordinator agreeing with every item.

A reviewer is added when the review shows a pattern: one reviewer keeps finding P1 and P2 findings in one area while the others agree, so a specialist for that area joins.

The pipeline reads the review ledger by patch-id. On a machine without agent-review, `pipeline review` keeps a small ledger of its own in the same format.

### 10. Rebase onto main

Before deploy, the batch is rebased onto main. A commit whose patch-id (its diff and the lines around it) is unchanged keeps its review coverage. A commit whose diff changed needs review again, as a short round on the change. The scan and CI run again on the new commit IDs.

### 11. Deploy

A deploy needs code review consensus (or the user's recorded skip) on every commit it ships, a settled green CI run on the exact commit (for a live-hole fix, every local check on it), a passed scan, and the docs rules met. Moving trunk is part of the deploy: where the user runs deploys, agents never move trunk, by push or by merge. A deploy is whatever puts the change in front of its users: a server deploy, a package release, an app store build.

The project's own checks then show that the deployed build works, and their results are recorded (`pipeline deploy record`, which checks `deploy.requiredChecks`). A health check is the default. A service with stored data also takes a backup first, runs a load check (every stored record loads), requests a few pages or endpoints over HTTP, and checks that it has not restarted. A library or CLI release might install the published build and run it once. A notification names what shipped. A failed or rolled-back deploy gets a notification too.

### 12. Cleanup

After each deploy: merged `ci/*` branches are deleted (a branch whose commits all landed under new IDs after a rebase counts as merged), lane workspaces are forgotten and their folders removed, `jj workspace update-stale` runs in the main workspace, scratch databases (where the project uses them) are dropped, and the review folder is archived.

Work the user drops is abandoned instead (`pipeline abandon`), with who decided and why. Its lanes give up their files, and it never deploys.

### 13. Live play

Live play exercises an actual running version of the deployed commit the way its real users or clients would, beyond what the automated tests cover, and fixes what breaks. The tests check what someone thought to write down. Live play looks for what nobody did.

What that looks like depends on the software:

- **A web app:** several users at once, in separate sessions, on different devices and screen sizes.
- **An API service:** real clients calling the running service, with real request sequences, bad input and retries.
- **A CLI:** real commands on real inputs, messy files and pipes included.
- **A library:** a small consumer app built against the released build.
- **A mobile app:** a device or an emulator.

Live play agents go past the happy path wherever the software allows it: they interrupt flows, restart mid-action, lose the network and come back, undo and redo, and run two clients at once. Checks that fit only some software apply only there:

- if the software has access boundaries (users, roles, tenants, hidden data), check that no client receives what it may not see
- if it keeps state, check that the state survives a restart
- if several clients share state, check that they agree.

After each deploy, live play runs against an isolated instance of the deployed commit, with its own ports, data and credentials, never production. The live play brief says what to exercise and how (see [templates/briefs.md](../templates/briefs.md)).

Each bug gets a stable ID with a severity (`LP3-UI-1`, P0 to P3). A fix makes the software do what its docs already say, in its own small commit with a test that fails without it. Anything that would change documented behavior is "needs owner": it goes to the coordinator with a recommendation and is decided and logged. The fixes form a hotfix run and go through review and deploy like any change.

Live play runs beside the next design or build, never blocking it.

### 14. Follow-ups

P3 findings and decided needs-owner items land in a backlog. A follow-up batch takes them in lanes planned so that no file is in two lanes. Every item is already decided, so the batch works from a brief instead of a design note.

### 15. Docs

Docs change with the behavior they describe: the feature list (what the software does today), the user docs, and any reference that must track a source file, such as a keyboard shortcut sheet, a CLI's option reference or an API reference (`docs.shortcutSources` and `docs.shortcutDocs`). Each of these is optional and named in the config. When a run of features has shipped, one dedicated docs pass reads the user docs as a whole and adds and reworks sections. Where the software has a UI, it also retakes screenshots from fixture data, never real user data.

## The fast lanes

- **Small requests**: a short spec instead of a design note, one builder, a review by two reviewers in a small batch. Anything touching data, permissions or more than a few files gets the full process.
- **Hotfixes**: live play fixes and production bugs. The fix commits are reviewed lightly (two reviewers at medium effort, expecting one round) rather than skipped, and deploy as their own batch.

## What stays a judgment call

The tool cannot judge these, so each has a recorded sign-off (`pipeline signoff`) or a recorded decision instead:

- whether a design is right: the design review's consensus
- whether a finding blocks, and whether a fix is adequate: the code review's consensus
- whether every product choice in guess mode was logged: the `decisions/complete` sign-off
- whether the build did what its brief said, one commit per item, whole bug classes fixed: the `build/scope` sign-off
- whether a live play fix only fixes, without changing behavior: the `live-play/bug-fix-only` sign-off
- whether the docs pass reads well as a whole: the `docs/read-through` sign-off, or the project's own item in `signoffs.docs`
- whether a scan finding (a URL, an HTML sink) is safe: the scan's acknowledgment
- whether a change belongs in the fast lane, beyond the file count and forbidden paths the tool checks
- product questions themselves: the decision log.
