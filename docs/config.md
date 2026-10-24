# Config

A project declares its pipeline in `pipeline.config.json` at the repository root, committed. `pipeline.local.json` beside it is gitignored and holds what must never be committed: private values and paths. Both merge over the defaults below, and the local file wins for every key except the gate's own. `pipeline config` prints the merged result, and `pipeline config --check` its warnings.

The gate's own keys come only from `pipeline.config.json` as committed at the trunk commit the remote itself reports, never from a local ref or jj's `trunk()`: `trunk`, `remote`, `push.*`, `ci.workflow`, `review.provider`, `review.trustGithubStatus`, `review.trustedStatusWriters`, `deploy.runBy`, `deploy.match`, `deploy.tipArg`, `deploy.prodPattern`, `deploy.deployWorkflows`, `deploy.allowedWorkflows` and `github.allowedMutations`. An agent can edit its working copy, but not the remote trunk without passing the gate, so a working-copy edit never loosens the gate. `pipeline.local.json` may not set them at all. A change to one takes effect once it reaches trunk, and `config --check` names each key whose working-copy value differs. A repository whose trunk has no committed config is not gated, unless this machine has registered it with the pipeline: then the gate refuses until the config is back on trunk.

An unknown key is refused, so a typo never turns a check off. A value of the wrong type is refused too. A value in angle brackets, such as `<private-domain>`, is a placeholder: it is never scanned for, and `config --check` reports it.

[pipeline.config.example.json](../pipeline.config.example.json) is a starting point, and [profiles/raccoon-vtt](../profiles/raccoon-vtt/) a full example for one web app. The defaults assume no kind of software: settings that fit only some (e2e files, user docs, screenshots, scratch databases, post-deploy checks beyond health) stay empty until a project sets them.

## Top level

| Key | Default | Meaning |
|---|---|---|
| `project` | `null` | A name, for messages. |
| `trunk` | `"main"` | The branch deploys move, by name on the remote. Ranges run from the commit the remote reports for it. |
| `remote` | `"origin"` | The only remote agents push to. |

## `intake`, `brief`, `design`, `decisions`

| Key | Default | Meaning |
|---|---|---|
| `intake.quoteIn` | build, design, review, live-play, followups | Brief kinds that must quote the user's words. |
| `brief.preamble` | `null` | The shared preamble's file name. Briefs of `brief.requirePreambleIn` kinds must name it. |
| `brief.requirePreambleIn` | build, live-play, followups | |
| `design.targetLines` | `400` | A warning above it. |
| `design.maxLines` | `520` | Refused above it, before the first Appendix heading, unless `--allow-long`. |
| `design.uiHeading` | `^#{2,4} .*\b(UI\|UX)\b` | The heading a UI change's note needs. |
| `design.requiredSections` | Tests, Build plan | Headings every note needs. |
| `decisions.file` | `null` | The decision log. Keep it outside a public repository. |
| `decisions.guessMode` | `false` | When on, the deploy gate needs the decisions stage and its `complete` sign-off. |
| `decisions.idPattern` | `\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b` | What a decision ID looks like. |
| `decisions.ignoreIds` | UTF-8, SHA-256, ISO-8601, UTF-16 | Tokens that match the pattern but are not IDs. |

## `commits`

| Key | Default | Meaning |
|---|---|---|
| `commits.conventional` | `true` | `type(scope): description`, lowercase after the colon. |
| `commits.types` | feat, fix, chore, docs, refactor, test, perf, build, ci | |
| `commits.oneLine` | `true` | No body. |
| `commits.acceptedSignatures` | `["good"]` | Signature states that count as signed, in jj's words: `good`, `unknown`, `bad`, `expired`, `revoked` and `none`. Add `"unknown"` for keys the machine cannot verify. In git, `%G?` reads as: `G` and `U` good, `E` unknown, `B` bad, `X` and `Y` expired, `R` revoked, and `N` none only for a commit with no signature at all. An SSH signature git cannot check (no `gpg.ssh.allowedSignersFile`) reads unknown, as jj reports one: set that file to verify SSH signatures. |
| `commits.forbidEmDash` | `true` | |
| `commits.forbiddenTrailers` | co-authored-by, generated-by, signed-off-by, "generated with", the Anthropic noreply address | Case-insensitive patterns, one per line of the message. |

## `fastLane`

| Key | Default | Meaning |
|---|---|---|
| `fastLane.maxFiles` | `8` | Files a fast run may change in all. |
| `fastLane.forbiddenPaths` | `[]` | Globs a fast run may not touch, such as the schema, the protocol and permissions. |
| `fastLane.specMaxLines` | `150` | The longest spec. |

## `checks`, `tests`, `mutation`, `report`

| Key | Default | Meaning |
|---|---|---|
| `checks.parallel` | `[]` | `{ "name", "run" }` checks run side by side: typecheck, unit tests, build. |
| `checks.integration` | `[]` | Run one after another, after the parallel phase. |
| `checks.e2e.command` | `null` | The command for one e2e file, with `{file}`. An e2e file drives the software from outside: a browser for a web app, a client for an API, the shell for a CLI. |
| `checks.e2e.files` | `[]` | Every e2e file. `--e2e all` runs them all. |
| `checks.e2e.always` | `[]` | Files every lane runs, whatever it touched. |
| `checks.e2e.beforeEach` | `null` | A command before each file, such as clearing rate limits. When it fails or runs out of time, that file fails without running. |
| `checks.e2e.beforeEachTimeoutSec` | `300` | Per run of `beforeEach`. |
| `checks.e2e.timeoutSec` | `1800` | Per file. |
| `checks.env` | `{}` | Environment for every check. A lane's `--env` adds to it (ports, database URLs). |
| `checks.stopOnFailure` | `true` | A failed phase stops later phases. |
| `checks.keepAwake` | `true` | On macOS, caffeinate while checks run. |
| `checks.resultPatterns` | node test's `pass N` and `fail N` | Regexes whose last match gives each count. |
| `tests.pattern` | test folders and `.test`, `.spec`, `.itest`, `.e2e` files | What counts as a test file. |
| `mutation.required` | `true` | A commit changing code and a test together needs a mutation check. |
| `mutation.command` | `node --test {file}` | |
| `mutation.link` | `["node_modules"]` | Folders linked from the workspace into the temporary tree. |
| `mutation.timeoutSec` | `600` | |
| `report.sections` | `[]` | Headings a lane's report needs. |

## `scan`, `push`

| Key | Default | Meaning |
|---|---|---|
| `scan.private` | `[]` | Strings that must never be added: the live domain, the deploy host. Set them in `pipeline.local.json`. |
| `scan.privateRegex` | `[]` | The same, as patterns. |
| `scan.secrets` | `true` | Keys, tokens, webhooks, credentials in URLs. |
| `scan.htmlSinks` | `true` | For web code. It finds nothing in code without HTML. |
| `scan.urls` | `true` | |
| `scan.allowedUrlHosts` | example.com, example.org, localhost, 127.0.0.1 | Hosts (and their subdomains) URLs may name without a look. |
| `scan.emDashInContent` | `"error"` | `"error"`, `"review"` or `"off"`. |
| `scan.exclude` | images, fonts, lockfiles | Globs not scanned. |
| `scan.workflowPaths` | `.github/workflows/**` | Where a secret, write permission or deploy needs a look. |
| `push.branches` | `["ci/*"]` | The only branches agents push to. |
| `push.requireScan` | `true` | Every commit new to the remote must be in a passed scan. |
| `push.public` | `true` | The remote is public: a run marked `--live-hole` stays off it until it deploys, and deploys on local checks in place of CI. |

## `ci`, `review`

| Key | Default | Meaning |
|---|---|---|
| `ci.workflow` | `null` | The workflow name or file name whose runs count as CI, or a list of them, each needing a green run. Required: with none, `pipeline ci` counts no run. |
| `ci.pollSec` | `30` | |
| `ci.timeoutMin` | `120` | |
| `ci.okConclusions` | success, skipped, neutral | |
| `review.provider` | `"auto"` | `"agent-review"`, `"builtin"` or `"auto"` (agent-review when its ledger or command exists). |
| `review.agentReviewLedger` | `~/.local/state/agent-review` | Read, never written. `$AGENT_REVIEW_LEDGER` overrides it. |
| `review.minReviewers` | `2` | Replies the builtin `done` needs. |
| `review.trustGithubStatus` | `false` | Count a success `agent-review` or `pipeline/review` status on the tip as consensus, when it is the newest status of its context and a trusted writer set it. |
| `review.trustedStatusWriters` | `[]` | GitHub logins whose review statuses count. Empty means the repository's owner. |

## `deploy`, `notify`

| Key | Default | Meaning |
|---|---|---|
| `deploy.command` | `null` | The deploy command, with `{name}`, `{tip}` and `{prev}`. Its script (the first word, or the first after an interpreter) is how the gate knows the deploy wherever it runs, by real path and content. It may live in `pipeline.local.json`. |
| `deploy.match` | `null` | A regex that finds the deploy command in a shell command run inside this repository's folders, for the gate. It must match from the command's first word. |
| `deploy.tipArg` | `null` | Which positional argument of the deploy command is the revision it deploys, counted from 1. |
| `deploy.runBy` | `"user"` | `"user"`: agents never run the deploy or move trunk, and are given the command for the user. `"agent"`: agents may, after the gate. |
| `deploy.requiredChecks` | health | What `deploy record` must be given, from `health`, `backup`, `load`, `http` and `restarts`. A service with stored data usually needs all five. |
| `deploy.healthyValues` | healthy, ok | |
| `deploy.deployWorkflows` | `"deploy"` | A regex over a workflow's file path and display name for the workflows that deploy. A workflow whose file names an `environment:` deploys too. Name every deploy workflow so one of these holds. |
| `deploy.allowedWorkflows` | `[]` | Under `runBy: "user"`, the workflows agents may still dispatch or rerun, by file path (`.github/workflows/lint.yml`). Every other workflow is the user's. A deploy workflow on the list is checked as any deploy is, and a production one is still refused. |
| `deploy.prodPattern` | prod or production as a word | Workflows and environments agents never run, matched against a workflow's path, name, the `environment:` values its file names on trunk, and its inputs. |
| `notify.command` | `null` | An argument list with `{message}`, such as `["agent-notify", "{message}"]`, or a shell string that gets the message as `$1`. |

## `github`

| Key | Default | Meaning |
|---|---|---|
| `github.allowedMutations` | `[]` | GraphQL mutations agents may send with `gh api graphql`, by name. Every other mutation is refused. |

## `docs`, `livePlay`, `followups`, `cleanup`, `signoffs`

The `livePlay` keys only bound its fixes and bug IDs. What live play exercises, and on which isolated instance, is set per run in the live play brief, since it depends on the kind of software ([process.md](process.md#13-live-play)).

| Key | Default | Meaning |
|---|---|---|
| `docs.featureList` | `null` | The user-facing feature list. A `feat` commit changing `docs.behaviorPaths` needs it updated in the same range. |
| `docs.guide` | `null` | The main user docs file, such as a user guide, a README or a reference. A docs run must change it. |
| `docs.shortcutSources` | `[]` | Source files that docs must track, such as a keyboard shortcut registry, a CLI's option table or an API schema. |
| `docs.shortcutDocs` | `[]` | Files that must change in the same range as any of `docs.shortcutSources`. |
| `docs.behaviorPaths` | `[]` | Globs of code whose change is user-visible. |
| `docs.screenshots` | `[]` | Globs a docs run must add or change, for software with a UI. |
| `docs.separateCommit` | `true` | Feature list and user docs changes never share a commit with code. |
| `livePlay.maxFilesPerFix` | `8` | The most files one live play fix may touch. A bigger fix is a design change. |
| `livePlay.idPattern` | `^{prefix}-[A-Z0-9]+-\d+$` | What a live play bug ID looks like. `{prefix}` is the `--prefix` live play started with, such as `LP3`. |
| `followups.blockingNeedsDecision` | `true` | A P0 to P2 item needs a logged decision to be deferred. |
| `cleanup.databaseList` | `null` | For a project with scratch databases: a shell command printing their names, one per line. |
| `cleanup.databaseDrop` | `null` | The drop command, with `{db}`. |
| `cleanup.archiveDir` | `null` | Where review folders are archived. |
| `signoffs` | decisions: complete, build: scope, live-play: bug-fix-only, docs: read-through | Judgment calls each stage needs recorded. A project may add its own stages and items, or replace one, such as the docs item with a check of its own docs' voice. |
