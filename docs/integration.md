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
- `--project DIR`: writes `DIR/pipeline.config.json` from the example, adds `pipeline.local.json` to its `.gitignore`, and links the git pre-push hook into the folder git runs hooks from (`core.hooksPath` when it is set). It says so when that folder does not exist, or the project has no git repository.
- `--dry-run`: prints what it would do.

It never overwrites a file or link it did not create, a link to nothing included, and it creates new files and links exclusively.

The CLI is called `pipeline`, a name other tools use too. `install.sh` keeps another `pipeline` in place and warns when one comes first on PATH. Claude Code puts a plugin's `bin/` after the user's PATH, so there too another `pipeline` wins when an agent types the name. The hooks call this checkout by its full path, so the gate is unaffected. Then call `bin/pipeline` by its full path, or put this one first on PATH.

## 2. Claude Code

The repository is its own plugin marketplace. In a Claude Code session:

```
/plugin marketplace add jwhitlow45/agent-pipeline
/plugin install agent-pipeline@agent-pipeline
```

Or from a shell: `claude plugin marketplace add jwhitlow45/agent-pipeline`, then `claude plugin install agent-pipeline@agent-pipeline`. Check a local checkout with `claude plugin validate .`.

The plugin brings:

- the `agent-pipeline` skill, which teaches the process and the commands
- a PreToolUse hook that runs `pipeline gate`, and a PostToolUse hook that runs `pipeline mirror-hook`, on every tool that runs a command: Bash, Monitor and PowerShell
- `bin/pipeline` on the Bash tool's PATH while the plugin is enabled.

Both hooks act only in repositories whose remote trunk has a committed `pipeline.config.json`, and they return at once for commands that are not pushes, gh calls, review commands or a deploy command. The gate does not read PowerShell: a PowerShell command that mentions a push, gh or a deploy command is refused, with the advice to run it through Bash.

Without the plugin, add the same hooks to `~/.claude/settings.json` (or a project's `.claude/settings.json`) by hand:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash|Monitor|PowerShell", "hooks": [{ "type": "command", "command": "~/.local/bin/pipeline gate", "timeout": 90 }] }],
    "PostToolUse": [{ "matcher": "Bash|Monitor|PowerShell", "hooks": [{ "type": "command", "command": "~/.local/bin/pipeline mirror-hook", "timeout": 90 }] }]
  }
}
```

Quote the path in `command` when it holds a space or a quote.

The gate blocks with exit code 2 and its reason on stderr. Any failure while it checks a command blocks too, with exit code 2 and the cause: letting a push or deploy through unchecked is worse than a retry. A command the gate cannot resolve to an exact action (a variable command name, xargs, a shell reading a pipe) is refused when it holds a push, a gh call or a deploy command, and the reason names the plain form to run instead.

## 3. Codex

- **Instructions:** copy [codex/AGENTS-section.md](../codex/AGENTS-section.md) into `~/.codex/AGENTS.md` or the project's `AGENTS.md`.
- **Skill:** `install.sh --codex` links `skills/agent-pipeline` into `~/.codex/skills/`.
- **Hooks:** Codex reads Claude-style hooks from `~/.codex/hooks.json` or a project's `.codex/hooks.json`. [codex/hooks.json](../codex/hooks.json) is the template, with `PIPELINE_BIN` standing for the CLI's path (`install.sh --codex` fills it in, shell-quoted). Codex asks you to trust a new hook the first time it runs. Codex names its shell tool `Bash` in hook input, and the matcher also names the older shell tool names.
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

Then fill in `pipeline.config.json` ([config.md](config.md)), commit it, and get it onto the remote trunk. The gate reads its own keys (push, CI, review trust and deploy) only from the copy committed on the remote trunk, so a repository stays ungated until that copy exists, and `pipeline config --check` says so. Put private values and paths in `pipeline.local.json`, which `init` adds to `.gitignore`: the live domain and the deploy host the scan keeps out, any other string that must never reach a public branch. A lane's workspace finds the local file in the main workspace, so it needs no copy.

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

Reviews recorded on one machine reach another through GitHub: set `review.trustGithubStatus` to `true`, and a success status from `agent-review` or `pipeline/review` on the tip counts as consensus for the range up to it. Only the newest status of each context counts, and only when one of `review.trustedStatusWriters` set it (by default the repository's owner). The gate refuses an agent's `gh api` write of these statuses.

## 7. Branch protection

Each stage is a commit status, so GitHub branch protection can require them. Requiring `pipeline/scan`, `pipeline/ci` and `pipeline/review` (or `agent-review`) on pull requests into main makes GitHub enforce what the gate enforces locally. Each status describes only its own commit: when a run's tip moves, its stages show as `pending` on the new tip until they pass there.

Statuses are set through `gh api`, so the account the agents use needs write access to commit statuses. Anyone with that access can set any status. The gate refuses agents' writes of these contexts, but it cannot stop a person or another tool, so keep write access to the accounts you trust.

## 8. Where state lives

- Runs: `~/.local/state/agent-pipeline/runs/<run>.json` (or `$AGENT_PIPELINE_STATE`).
- Check logs: `~/.local/state/agent-pipeline/logs/<run>/<lane>/<tip>/`.
- The builtin review ledger: `~/.local/state/agent-pipeline/reviews/`.
- The follow-up backlog: `~/.local/state/agent-pipeline/followups/`, one file per repository.
- The repositories with a committed config: `~/.local/state/agent-pipeline/repos.json`, which pipeline commands keep current. The gate reads it to find a deploy command run from any folder.
- Each state file is written under a lock beside it (`<file>.lock`), which a process that died leaves behind for the next one to clear.
- The decision log: wherever `decisions.file` says, outside the repository when the repository is public.

The ledger is per machine, like agent-review's. GitHub statuses are the shared record.
