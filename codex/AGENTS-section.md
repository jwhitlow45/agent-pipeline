## Delivery pipeline

Copy this section into `~/.codex/AGENTS.md` (every project) or a project's `AGENTS.md`. It applies in repositories with a `pipeline.config.json`.

Work goes through the stages of the agent pipeline: intake, design (or a short spec), decisions, build lanes, pre-push scan, push to `ci/*`, CI, code review, rebase, deploy, cleanup, live play, follow-ups and docs. The `pipeline` CLI records each stage in a ledger and sets a `pipeline/<stage>` commit status on GitHub. Read the `agent-pipeline` skill, or `docs/process.md` and `docs/stages.md` in the agent-pipeline repository, before starting a stage.

- Record the user's words first, verbatim: `pipeline intake --run <run> --words-file <file>`. Quote them in every brief and review request, and check each brief with `pipeline brief --run <run> --file <brief>` before sending it.
- When the user has turned guess mode on, never stop to ask a product question. Log the choice, the reason and the rejected options with `pipeline decide`, and cite the decision's ID.
- Builders work in their own jj workspace, on the files their lane owns. Record and check their work with `pipeline commits`, `pipeline check`, `pipeline mutation` and `pipeline report`, then `pipeline build`.
- Run `pipeline scan` before any push. Push only to `ci/*` branches, never forced. Wait for CI with `pipeline ci --wait`.
- Deploy only after `pipeline deploy check` allows it. When the user runs deploys, give the user the command. Never run a production deploy workflow. Record the deploy with `pipeline deploy record`, which notifies the user.
- After each deploy, run `pipeline cleanup`, then start live play with `pipeline live-play start`.

The gate runs before each shell command when the Codex hooks from `codex/hooks.json` are installed. Without hooks, run every push, deploy and review command through the gate:

```sh
pipeline exec -- jj git push --bookmark ci/<run>
```

When the gate refuses, do the missing stage and run the command again. Never reword a command to get past the gate. When the gate is wrong, or it refuses for missing review or a production deploy, tell the user.
