# Using the pipeline on another machine

The pipeline is one CLI (`bin/pipeline`, Node with no dependencies) plus hooks that call it. It needs Node 22 or later, [jj](https://github.com/jj-vcs/jj), git and the GitHub CLI (`gh`, logged in). Projects use jj workspaces, so a project is a jj repository, colocated with git when the git pre-push hook is wanted.

Nothing here changes a machine until you run it. The repository is private, so the machine needs GitHub access to it: `gh auth login`, then `gh auth setup-git` for HTTPS, or an SSH key in ssh-agent.

## 1. Get the CLI

```sh
git clone git@github.com:jwhitlow45/agent-pipeline.git ~/src/agent-pipeline
~/src/agent-pipeline/install.sh
pipeline --help
```

`install.sh` links `bin/pipeline` into `~/.local/bin` (or `$PIPELINE_BIN_DIR`). Its options, each safe to rerun:

- `--claude`: adds this checkout as a Claude Code marketplace and installs the plugin, when the `claude` CLI is on PATH
- `--codex`: links the skill into `~/.codex/skills/` and writes `~/.codex/hooks.json`, or prints the entries to merge when that file exists
- `--project DIR`: writes `DIR/pipeline.config.json` from the example, adds `pipeline.local.json` to its `.gitignore`, and links the git pre-push hook
- `--dry-run`: prints what it would do.

It never overwrites a file it did not create.

## 2. Claude Code

The repository is its own plugin marketplace. In a Claude Code session:

```
/plugin marketplace add jwhitlow45/agent-pipeline
/plugin install agent-pipeline@agent-pipeline
```

Or from a shell: `claude plugin marketplace add jwhitlow45/agent-pipeline`, then `claude plugin install agent-pipeline@agent-pipeline`. Check a local checkout with `claude plugin validate .`.

The plugin brings:

- the `agent-pipeline` skill, which teaches the process and the commands
- a PreToolUse hook on Bash that runs `pipeline gate`, and a PostToolUse hook that runs `pipeline mirror-hook`
- `bin/pipeline` on the Bash tool's PATH while the plugin is enabled.

Both hooks act only in repositories with a `pipeline.config.json`, and they return at once for commands that are not pushes, gh calls, review commands or the project's deploy command.

Without the plugin, add the same hooks to `~/.claude/settings.json` (or a project's `.claude/settings.json`) by hand:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.local/bin/pipeline gate", "timeout": 90 }] }],
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.local/bin/pipeline mirror-hook", "timeout": 90 }] }]
  }
}
```

The gate blocks with exit code 2 and its reason on stderr. A crash exits 1, which lets the command run, since a broken gate must not block every command.

## 3. Codex

- **Instructions:** copy [codex/AGENTS-section.md](../codex/AGENTS-section.md) into `~/.codex/AGENTS.md` or the project's `AGENTS.md`.
- **Skill:** `install.sh --codex` links `skills/agent-pipeline` into `~/.codex/skills/`.
- **Hooks:** Codex reads Claude-style hooks from `~/.codex/hooks.json` or a project's `.codex/hooks.json`. [codex/hooks.json](../codex/hooks.json) is the template, with `PIPELINE_BIN` standing for the CLI's path (`install.sh --codex` fills it in). Codex asks you to trust a new hook the first time it runs. The matcher names Codex's shell tool. If your Codex version names it differently, adjust the matcher.
- **Without hooks:** run every push, deploy and review command through the gate: `pipeline exec -- jj git push --bookmark ci/x`. `exec` runs the gate, then the command, then the mirror.

## 4. Any other agent, or a person

- `pipeline exec -- <command>` gives the gate and the mirror without hooks.
- `git-hooks/pre-push` runs the push checks for `git push` in a colocated repository: `ln -s ~/src/agent-pipeline/git-hooks/pre-push .git/hooks/pre-push`. jj does not run git hooks, so a `jj git push` is checked only by the agent hooks or by `exec`.

## 5. Set up a project

```sh
cd ~/src/my-app
pipeline init
pipeline config --check
```

Then fill in `pipeline.config.json` ([config.md](config.md)) and commit it. Put private values in `pipeline.local.json`, which `init` adds to `.gitignore`: the live domain and the deploy host the scan keeps out, any other string that must never reach a public branch. A lane's workspace finds the local file in the main workspace, so it needs no copy.

The [raccoon-vtt profile](../profiles/raccoon-vtt/) is a worked example from a real project.

## 6. Code review without agent-review

The pipeline reads agent-review's ledger (`~/.local/state/agent-review/`, or `review.agentReviewLedger`) when it is there. On a machine without it, `review.provider` `auto` picks the builtin ledger, and the review stage runs the same routine by hand:

1. `pipeline review start --run R --topic T` writes `.pipeline/review-T/round-1/request.md` with the user's words filled in. Fill the other parts: the choices to check, the verification and its exact results.
2. Give the request to two or more independent reviewers, at least one from a different model family, each in a fresh session, read-only. Save each reply as `round-1/replies/<name>.md`.
3. Confer: give each reviewer the others' replies, and save the answers in `round-1/confer/`.
4. Verify each finding against the code, give each a disposition, fix adopted ones as new commits, rerun the checks.
5. `pipeline review round --run R --topic T` for the next round, until every reviewer says consensus on the same tip.
6. `pipeline review done --run R --topic T --reviewers "<model effort, ...>"` records consensus and sets `pipeline/review`. It needs at least `review.minReviewers` replies saved.
7. When the user says to skip review: `pipeline review skip --run R --reason "<the user's words>"`.

For a design review, `pipeline review start --run R --topic T --no-commits --dir <folder>`.

Reviews recorded on one machine reach another through GitHub: set `review.trustGithubStatus` to `true`, and a success status from `agent-review` or `pipeline/review` on the tip counts as consensus.

## 7. Branch protection

Each stage is a commit status, so GitHub branch protection can require them. Requiring `pipeline/scan`, `pipeline/ci` and `pipeline/review` (or `agent-review`) on pull requests into main makes GitHub enforce what the gate enforces locally. Statuses are set through `gh api`, so the account the agents use needs write access to commit statuses.

## 8. Where state lives

- Runs: `~/.local/state/agent-pipeline/runs/<run>.json` (or `$AGENT_PIPELINE_STATE`).
- Check logs: `~/.local/state/agent-pipeline/logs/<run>/<lane>/<tip>/`.
- The builtin review ledger: `~/.local/state/agent-pipeline/reviews/`.
- The follow-up backlog: `~/.local/state/agent-pipeline/followups/`, one file per repository.
- The decision log: wherever `decisions.file` says, outside the repository when the repository is public.

The ledger is per machine, like agent-review's. GitHub statuses are the shared record.
