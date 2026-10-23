# Brief templates

Each brief is a file the coordinator writes and checks with `pipeline brief` before an agent gets it. Fill the angle-bracket parts.

## Build lane

```markdown
# Task: <feature>, lane <L> (stage 2: build)

Read <preamble path> first and follow it. Then read the design note in full: <note path>. It reached consensus over <n> design review rounds. Build exactly what it says, commit by commit as its build plan lists them.

The owner's words (<date>): "<the user's words, verbatim>"

## Base
<the newest stacked tip, change ID and commit>. Build on it, not on main.

## Decided, not in the note
- **<ID>, decided:** <what to build>.

## Rules
- <data, protocol and version rules from the note>
- Feature list and user docs changes only in the last commit.
- A change to <docs.shortcutSources files> updates <docs.shortcutDocs files> in the same lane. Delete this line when the project has none.
- Grep each commit for local paths before committing.

## Checks
typecheck, unit and build in parallel (read every log in full), then integration, then e2e one file at a time: <touched files>, <always-run files>. Use <port> only. Stop every browser, server or client an e2e file started before the next one.

## Workspace
<workspace path>, an empty working copy on <base>. Databases <names>, dropped at the end. Never push, move bookmarks or send notifications. Asking the owner is off: decide by the note, and report anything it does not settle with your choice.

## Report
<scratch>/reports/<task>.md, and about 10 lines to the coordinator: change IDs, check results in one line, the randomized test's invariants, anything the note did not settle and what you chose.
```

## Review round fixes

```markdown
# <topic> review round <n>: fixes

Reviewers' replies: <round folder>/replies/ and confer/. Owner decisions: <decision log>, "<topic> review round <n>". Add new signed conventional commits on top of <tip>, one per item or class. Never fold into pushed commits.

1. **<FINDING-ID> (<severity>):** <what to change, file:line, the test that proves it>.
2. **<FINDING-ID>, decided:** <the decided behavior>.

Rules as in <the lane's brief>. Mutation-check each new test. Checks: typecheck, unit and build in parallel, then integration, then e2e one file at a time: <files>. Report in about 10 lines: change ID per item, checks, anything you chose.
```

## Live play

```markdown
# Live play <n> (after <batch>): brief

Read <preamble> and <live play brief> first, in order.

The owner's words for live play: "<the owner's words, verbatim>"

- Live play exercises a running copy of the deployed commit the way its real users or clients would, beyond the automated tests, and fixes what breaks.
- The source of truth is <feature list>, <user docs> and <design notes>.
- The deployed commit is <commit>. The isolated instance: workspace <path> on it, with <ports, data and credentials of its own>. Never production.
- Known follow-ups are in <backlog>. Do not report them again.
- Fixes stay bug fixes: no new behavior, no data shape, protocol or version change. A fix that changes documented behavior is "needs owner", with your recommendation.
- Bug IDs: <prefix>-<AREA>-<k>, severity P0 to P3.

## Areas
### <area> (prefix <prefix>-<AREA>)
<what to exercise and how (users in separate sessions and devices, real clients, real commands, a consumer app, a device or emulator), and what to check above all>

## Checks that apply to this software
<keep the ones that fit, delete the rest>
- Access boundaries: record what each client receives, and check that none receives what it may not see.
- Stored state: check that it survives a restart.
- Shared state: check that every client sees the same result.

## Checks before you report
typecheck, unit and build in parallel, then integration, then e2e one file at a time for each file your fixes touch, plus <files>.

## Report
A table of every bug (ID, severity, area, one line, status: fixed with commit, or needs owner with your recommendation), what you exercised and how, what worked, and the checks with counts.
```

## Follow-up lane

```markdown
# Task: follow-up batch <n>, lane <L> (<area>)

Read <preamble> first. Every item is decided: build it as written. Item texts are in the backlog (`pipeline followup list`), the owner-side decisions in <decision log> (search the ID).

The owner's words: "<the words behind this batch, verbatim>"

## Base
<commit>. One commit per item or per class.

## Items
1. **<ID>:** <change>.
2. **<ID>, decided:** <change>.

## Rules
- Bug fixes and decided changes only.
- Lane <other> runs beside you. Stay out of <the other lane's files>.

## Checks
<as in the build brief>
```
