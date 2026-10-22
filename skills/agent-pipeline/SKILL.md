---
name: agent-pipeline
description: The delivery process for agent teams, from the user's request to shipped, played and documented work, run through the `pipeline` CLI and its gate. Use when coordinating design, build, review, CI, deploy, live play, follow-ups or docs in a repository with a pipeline.config.json, or when the pipeline gate blocks a command.
---

# The agent pipeline

You coordinate work through stages. Each stage records what it checked in a ledger (`pipeline status --run R` shows it) and sets a `pipeline/<stage>` commit status on GitHub. A hook runs `pipeline gate` before every shell command and refuses a step whose earlier stages have not passed. The full process is in this plugin's `docs/process.md`, the checks in `docs/stages.md`, the diagrams in `docs/diagrams.md`.

`pipeline` is on the Bash tool's PATH while this plugin is enabled. Elsewhere, install.sh links it into `~/.local/bin`.

## When the gate blocks

Read the reason, do the missing stage, then run the command again. Never reword a command to get past the gate. When the gate is wrong, tell the user. When it blocks for missing review or a production deploy, the user decides: ask, or give the user the command.

## The order

1. **Intake.** Record the user's words verbatim: `pipeline intake --run R --words-file F --kind feature|fast|hotfix|followups|docs [--ui] [--live-hole]`. Every brief and review request quotes them. Check each brief before sending it: `pipeline brief --run R --file F --kind build|design|review|live-play|followups|fix`.
2. **Design.** A feature gets a design note of about 400 lines (rules, edge-case matrix, tests, build plan, a UI and UX section when it has UI, measurements in an appendix): `pipeline design --run R --note F --review-topic T`. Run the design review with no commits to consensus, then rerun `pipeline design`. Any other kind of run works from a short spec: `pipeline spec --run R --file F`.
3. **Decisions.** In guess mode, never ask the user a product question. Pick the user's likely answer and log it: `pipeline decide --id ID --chose ... --why ... --rejected ... --run R`. Briefs cite IDs ("**ID, decided:** ..."), and `pipeline brief` refuses one that is not logged. Close with `pipeline signoff --run R --stage decisions --item complete ...` and `pipeline decisions --run R`.
4. **Build.** One builder per lane, each in its own jj workspace beside the repository (`jj workspace add --name <repo>-<task> ../<repo>-<task> -r <newest stacked tip>`), owning files no other open lane owns: `pipeline lane --run R --lane L --workspace DIR --owns GLOBS --brief F`. The brief points at the shared preamble. Builders commit one signed conventional commit per item, never push, and keep feature list and guide changes in their own last commit. Then, in the lane's workspace:
   - `pipeline commits --run R --lane L` checks every commit
   - `pipeline check --run R --lane L --e2e <touched files>` runs typecheck, unit and build side by side, then integration, then e2e one file at a time, and records exact results
   - `pipeline mutation --run R --lane L --commit REV --test FILE` for each commit that adds a test with its fix
   - `pipeline report --run R --lane L --file F` for the full report. The builder's message to you is about ten lines.
   - `pipeline signoff --run R --stage build --item scope ...` once you checked one commit per item and whole bug classes fixed, then `pipeline build --run R --review-topic T`.
5. **Scan.** `pipeline scan --run R`. Errors block. Look at each finding to review and acknowledge it with `--ack "<why each is fine>"` only when it is safe. Never push a fix for a hole live on the server before it deploys.
6. **Push.** Only to `ci/*`, never forced: `jj bookmark set ci/R -r <tip> && jj git push --bookmark ci/R`. If the gate says the move is sideways, push to the name it offers and `jj bookmark forget` the old one.
7. **CI.** `pipeline ci --run R --wait`. It counts only when every job has finished.
8. **Code review.** Use the review routine (agent-review) when installed: at least one Claude and one Codex reviewer, round 1 exhaustive, confer, dispositions verified against the code, fixes as new commits, P3s to the backlog, rounds to consensus. Without agent-review, `pipeline review start|round|done|skip` keeps the ledger. `pipeline review status --run R` shows coverage.
9. **Rebase.** After rebasing onto main: `pipeline rebase --run R --tip REV`. Coverage carries over by patch-id. A changed diff reopens the review. Scan and CI run again.
10. **Deploy.** `pipeline deploy check --run R`. When the user runs deploys, give the user the command. Never run a production deploy workflow. After the deploy: `pipeline deploy record --run R --name N --shipped "<what shipped>" --backup B --health H --load N/M --http "200 200"`, which also sends the notification.
11. **Cleanup.** `pipeline cleanup --run R` lists the merged branches to delete, workspaces to forget and remove, `jj workspace update-stale`, databases to drop and review folders to archive. Run the commands, then rerun it.
12. **Live play.** After each deploy, beside the next design or build: `pipeline live-play start --run R --prefix LPn`. Agents play the deployed build on their own server, ports and database, fix bugs as small `fix` commits with IDs `LPn-AREA-k` and severities, and report "needs owner" for anything that changes documented behavior. `pipeline live-play import --run R --report F`, decide each needs-owner item, ship the fixes as a hotfix run, sign off `live-play/bug-fix-only`, then `pipeline live-play done --run R`.
13. **Follow-ups.** `pipeline followup add` for each P3. Plan lanes with no shared file: `pipeline followup plan --run R --lanes N`.
14. **Docs.** The feature list, guide and shortcut sheet change with the behavior, in the lane's own docs commit. `pipeline docs --run R --due` says when a guide pass with new screenshots is due.

## Always

- Run independent checks in parallel. Read every log in full, never through `tail` alone.
- Agents' reports go to files. Messages to you stay short.
- Notify the user at every deploy and at every stop that waits on the user: `pipeline notify --run R --event waiting --message "Need input: ..."`.
- Keep the machine awake during long work.
- No em dashes and no prose semicolons in docs, comments, UI text or commit messages.
