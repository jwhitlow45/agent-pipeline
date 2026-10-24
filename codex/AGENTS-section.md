## Delivery pipeline

Copy this section into `~/.codex/AGENTS.md` (every project) or a project's `AGENTS.md`. It applies in repositories with a `pipeline.config.json`, jj or plain git.

Work goes through the stages of the agent pipeline: intake, design (or a short spec), decisions, build lanes, pre-push scan, push to `ci/*`, CI, code review, rebase, deploy, cleanup, live play, follow-ups and docs. The `pipeline` CLI records each stage in a ledger and sets a `pipeline/<stage>` commit status on GitHub. Read the `agent-pipeline` skill, or `docs/process.md` and `docs/stages.md` in the agent-pipeline repository, before starting a stage.

- Record the user's words first, verbatim: `pipeline intake --run <run> --words-file <file>`. Quote them in every brief and review request, and check each brief with `pipeline brief --run <run> --file <brief>` before sending it.
- When the user has turned guess mode on, never stop to ask a product question. Log the choice, the reason and the rejected options with `pipeline decide`, and cite the decision's ID.
- Builders work in their own jj workspace, or in git their own worktree on a lane branch, on the files their lane owns. Record and check their work with `pipeline commits`, `pipeline check`, `pipeline mutation` and `pipeline report`, then `pipeline build`.
- Run `pipeline scan` before any push. Push only to `ci/*` branches, never forced. In git, push the full commit id to a branch written in full: `git push origin <full id>:refs/heads/ci/<run>`. Never set `PIPELINE_USER_PUSH`, which marks the user's own push. Wait for CI with `pipeline ci --wait`.
- Deploy only after `pipeline deploy check` allows it. When the user runs deploys, give the user the command. Never run a production deploy workflow. Record the deploy with `pipeline deploy record`, which notifies the user.
- After each deploy, run `pipeline cleanup`, then start live play with `pipeline live-play start`: agents exercise a running copy of the deployed commit, on an isolated instance and never production, the way its real users or clients would, and fix what breaks.

The gate runs before each shell command when the Codex hooks from `codex/hooks.json` are installed. Without hooks, run every push, deploy and review command through the gate:

```sh
pipeline exec -- jj git push --bookmark ci/<run>
pipeline exec -- git push origin <full id>:refs/heads/ci/<run>
```

When the gate refuses, do the missing stage and run the command again. Never reword a command to get past the gate. When the gate is wrong, or it refuses for missing review or a production deploy, tell the user.

Write every line that holds a push, deploy, merge, dispatch, API write or review start in plain form: commands joined by `&&`, every word written out, a `cd <folder>` only first, and at most one such action per line, placed last. No shell (`bash -c`), interpreter, `env`, `xargs`, alias or variable on such a line. A line of reads, such as `git status; git log -3`, may use any join, with every word still written out. Codex does not block a call when a hook fails, and a shell session keeps functions and aliases between calls that the gate never sees, so define none that run jj, git or gh.
