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
- a PreToolUse hook that runs `pipeline gate` before every tool that runs a command or edits a file: Bash, Monitor, PowerShell, Edit, Write, MultiEdit and NotebookEdit
- a PostToolUse hook that runs `pipeline mirror-hook` after Bash, Monitor and PowerShell
- `bin/pipeline` on the Bash tool's PATH while the plugin is enabled.

Both hooks set `"onFailure": "block"`, which needs Claude Code 2.1.295 or later. Without it, a hook that times out lets the tool call run. The gate also keeps to a deadline of 60 seconds, under the hook's 90, and every process it starts gets only the time left: a slow remote or a slow GitHub refuses with "ran out of time" instead of timing out.

Both hooks act only in repositories whose remote trunk has a committed `pipeline.config.json`. The gate reads each command line without running anything:

- **Which lines it gates.** A line that runs or names jj, git, gh or agent-review in any case (`GIT` runs git on macOS), sends curl or wget to GitHub, or runs a deploy script. A word that only appears as text for `echo`, `printf`, `grep` or `man` does not count, unless that output feeds a program or goes into a file on a line that also runs a shell, an interpreter or a script.
- **The plain form.** A gated line that holds an action (a push, a deploy, a merge, a dispatch, an API write or a review start) or a bookmark set before one passes only as simple commands joined by `&&`, with every word written out. A `cd <folder>` may come first, on its own. A pipe may lead only into `head`, `tail`, `grep`, `wc`, `sort`, `cut`, `tr`, `cat`, `tee <file>`, `jq`, `column`, `uniq` or `nl`. Every read and every sink runs only with options from its exact list, spelled out in full: the list leaves out the options that write a file or run a program (`sort -o`, `git diff --output`, `git grep -O`, `jj diff --tool`), and git and getopt programs take a unique prefix of an option, so a prefix is refused too. The wrappers it reads are `timeout <duration>` and `caffeinate` with only `-d`, `-i`, `-m`, `-s` and `-u`.
- **Any form without an action.** A gated line with no action and no bookmark set passes whatever joins its commands: `;`, `||`, `&`, a loop, a subshell, a `cd` anywhere, or a pipe into any program but jj, git, gh, agent-review, pipeline, curl, wget, a shell, an interpreter or a script, which would read input the gate cannot see. A loop or a group may not take its input from a redirection, for the same reason. Each command is still read as it is on a plain line, so a word built at run time, an unknown option or a program the gate cannot find sends the line back to the plain form, which refuses it. The one exception is the folder that git `-C` or jj `-R` takes, which may be one quoted variable: `for d in a b; do git -C "$d" status; done`.
- **One action, placed last.** A push, a deploy, a merge, a dispatch, an API write or a review start comes last on its line. Before it only reads, the leading `cd` and `jj bookmark set|create|move NAME -r <commit id>` may run. A bookmark set stands alone between `&&`, never in a pipe, so its failure stops the push, and its revision is read in the workspace it runs in. Run anything else on its own first.
- **Exact commands.** jj, git and gh are read with their own grammar, flag by flag: an unknown option, an alias, `-c`, `--config`, a shell, an interpreter, any other wrapper or a word built at run time is refused there, and so are `;`, `||` and a subshell on a line that holds an action. The refusal names the plain form to run.
- **On every line.** A command whose name is built at run time (`$CMD`, `eval "$X"`, `sh -c "$X"`) is refused, and so is a write the line names into a `.git` or `.jj` folder, git's, jj's, gh's, ssh's, curl's or wget's config, a shell startup file, Claude Code's shell snapshots, the hook files, Claude Code's or Codex's settings, or the pipeline's ledger, by a redirection, `tee`, `cp`, `mv`, `ln`, a tool's own output option or another program, or by Edit and Write. A reader may name those files only with options from its list.

The gate does not read PowerShell: a PowerShell command that names jj, git, gh, agent-review or a deploy is refused, with the advice to run it through Bash. So is one that names a registered deploy script under any name, and, while deploy scripts are registered, one that runs a command PowerShell builds (`& $script`, `Invoke-Expression`, `Start-Process`).

Without the plugin, add the same hooks to `~/.claude/settings.json` (or a project's `.claude/settings.json`) by hand:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash|Monitor|PowerShell|Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "~/.local/bin/pipeline gate", "timeout": 90, "onFailure": "block" }] }],
    "PostToolUse": [{ "matcher": "Bash|Monitor|PowerShell", "hooks": [{ "type": "command", "command": "~/.local/bin/pipeline mirror-hook", "timeout": 90, "onFailure": "block" }] }]
  }
}
```

Quote the path in `command` when it holds a space or a quote.

The gate blocks with exit code 2 and its reason on stderr. Any failure while it checks a command blocks too, with exit code 2 and the cause: letting a push or deploy through unchecked is worse than a retry.

## 3. Codex

- **Instructions:** copy [codex/AGENTS-section.md](../codex/AGENTS-section.md) into `~/.codex/AGENTS.md` or the project's `AGENTS.md`.
- **Skill:** `install.sh --codex` links `skills/agent-pipeline` into `~/.codex/skills/`.
- **Hooks:** Codex reads Claude-style hooks from `~/.codex/hooks.json` or a project's `.codex/hooks.json`. [codex/hooks.json](../codex/hooks.json) is the template, with `PIPELINE_BIN` standing for the CLI's path (`install.sh --codex` fills it in, shell-quoted). Codex asks you to trust a new hook the first time it runs. Codex names its shell tool `Bash` in hook input, and the matcher also names the older shell tool names. Codex's managed hooks do not block a call when the hook itself fails or times out, so the gate's own 60-second deadline is what keeps a slow check from letting a command through. A crash of the hook process still lets it run there.
- **A persistent shell:** a Codex shell session keeps variables, functions and aliases between calls. The gate reads each call on its own and never sees them, so a function defined in one call can run a push in the next. See [what the gate does not reach](#what-it-does-not-reach).
- **Without hooks:** run every push, deploy and review command through the gate: `pipeline exec -- jj git push --bookmark ci/x`. `exec` runs the gate, then the command, then the mirror.

## 4. Any other agent, or a person

- `pipeline exec -- <command>` gives the gate and the mirror without hooks.
- `git-hooks/pre-push` runs the push checks for `git push` in a colocated repository: `ln -s ~/src/agent-pipeline/git-hooks/pre-push .git/hooks/pre-push`. git hands it the URL it pushes to and each branch's commit on the remote. It refuses a URL that is not the repository the gate reads, and a remote commit that differs from what the remote itself reported to the gate. jj does not run git hooks, so a `jj git push` is checked only by the agent hooks or by `exec`.

## 5. Set up a project

```sh
cd ~/src/my-app
pipeline init
pipeline config --check
```

Then fill in `pipeline.config.json` ([config.md](config.md)), commit it, and get it onto the remote trunk. The gate reads its own keys (push, CI, review trust and deploy) only from the copy committed on the remote trunk, so a repository stays ungated until that copy exists, and `pipeline config --check` says so. Put private values and paths in `pipeline.local.json`, which `init` adds to `.gitignore`: the live domain and the deploy host the scan keeps out, any other string that must never reach a public branch. A lane's workspace finds the local file in the main workspace, so it needs no copy.

Declare every deploy workflow. `deploy.deployWorkflows` is a regex over a workflow's file path and display name, and defaults to `deploy`. A workflow that deploys under another name (`cd.yml`, `release.yml`) is a deploy to the gate only when its file names an `environment:`, so give it a matching name or an environment. A workflow whose path, name, environment or inputs match `deploy.prodPattern` is a production deploy, which agents never run. The gate reads the workflow file GitHub will run: as committed on the `--ref` branch (or the default branch without one), or at a rerun's own commit, and as committed on trunk, with every local workflow it calls (`uses: ./.github/workflows/x.yml`). It reads `environment:` as a name or as a mapping with `name:`, keys in any order. It refuses an environment it cannot read: one named by an expression (`${{ inputs.target }}`), an anchor or alias, or another YAML form, and a call to a workflow in another repository. Name each environment plainly, so the gate can tell where a workflow deploys. Under `deploy.runBy: "user"`, agents may dispatch or rerun only the workflows listed in `deploy.allowedWorkflows`, by file path, and the list is empty by default.

Set the statuses from a GitHub App whose private key and installation tokens agents never hold. GitHub can require a check only from an App (its expected source), not from a user or bot account (see [What GitHub must enforce](#8-what-github-must-enforce)), so a status an agent sets with its own token counts for nothing.

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

Reviews recorded on one machine reach another through GitHub: set `review.trustGithubStatus` to `true`, and a success status from `agent-review` or `pipeline/review` on the tip counts as consensus for the range up to it. It is a range attestation from a trusted writer: only the newest status of each context counts, and only when one of `review.trustedStatusWriters` set it (by default the repository's owner). The gate refuses an agent's `gh api` write of these statuses.

## 7. What the gate is for

The gate is a guardrail for cooperative agents. An agent that means well can still run a gated command by mistake: a deploy, a push, a pull request leaving draft or a merge, before the review and checks it needs. The gate reads each command before it runs, refuses that one, and names the step to run first.

It is not a security boundary. It does not try to stop an agent that is working to get around it, and it is not a sandbox: a script, a build tool or an interpreter can still run what it likes, and the gate sees none of it. What holds against that is enforced outside the agent's machine: branch protection, required status checks, deploy keys and environment protection rules. A repository that needs a hard boundary must set them. [Section 8](#8-what-github-must-enforce) lists the exact settings, and `pipeline doctor` checks most of them.

### What it checks an action against

A read the gate needs either answers, proves the thing absent, or refuses: a workflow file it cannot parse the way GitHub would, a protection rule it cannot read, a remote it cannot list, or a git clone jj does not know. It checks each action against the remote itself: one `git ls-remote` of the address a push really reaches, after `pushurl`, `insteadOf` and `pushInsteadOf`, and the config committed at the trunk commit the remote reports. jj's and git's record of the remote must agree with it, or the gate says to fetch first. It refuses to act while a jj alias redefines a function, keyword or id the gate's reads use.

The gate's own reads (jj, git and gh, to read config and the remote) run in the hook's environment, not in the agent's shell. A variable, function or alias that the agent's shell gets from a startup file is invisible to them. The gate refuses writes to the startup files, Claude Code's shell snapshots, and the config files git, jj, gh, ssh, curl and wget read, wherever the environment points them (`JJ_CONFIG` as a list of files and folders, `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME`, `CURL_HOME`, `WGETRC`), so what it reads and what the agent's command runs start from the same files. It reads those locations from the environment rather than asking each tool, which would start jj and git on every command. A variable the agent sets in a persistent shell is outside that.

### How it reads a line

The gate reads a command line by three rules. A line it cannot parse at all is refused.

- **Nested scripts are read exactly.** The gate reads text a shell runs as code when it can read it byte for byte: a single-quoted `-c` script, a double-quoted one with no `$`, backtick or `\`, a heredoc with a quoted delimiter or a body with none of those, `watch`'s command, `eval`'s words, and `trap` and `alias` strings written the same way. A shell's options come from a fixed table for each shell, so `bash -o pipefail` takes its value, and an option outside the table refuses. A heredoc counts only as the shell's one input. A script handed over another way is refused: text piped into a shell, a here-string, a second input, another file descriptor, or a script built at run time. find's `-exec`, `-execdir`, `-ok` and `-okdir` are read as runners, every action of them, and a `{}` inside the program or a script refuses. Command substitutions (`$( )`, backticks, `<( )`) are read as commands too. A shell whose grammar is not sh's (fish, csh) runs no script the gate reads.
- **One resolver names each program.** A command word, at any depth, is looked up the way the shell looks it up: a builtin is the shell's own, a path is that file, and a bare word is the first executable file on PATH, with relative entries read from the command's folder. A function counts in the shell that defined it, except after `command` or `builtin`, which skip functions, and it is never trusted as a builtin read. The file's real path is its identity for every check, gating, the curl and wget checks and deploy scripts, so a link named `fetcher` to curl is curl. A runner's environment carries into what it runs (`env PATH=…`, `env -i`, assignments after `env --`, `command -p`), and `sudo` and `doas` use a search path the gate cannot read. The shell expands env's own words before env clears or sets anything, so there the gate fills in `$HOME`, `$PATH` and `$PWD` from what the shell holds, where each stays one word: `env -i HOME=$HOME PATH=/usr/bin:/bin ls` runs ls from `/bin`. After PATH is set to a value built at run time, a bare word refuses, and a full path still runs. A word that cannot be found refuses under a runner, in a nested script and on a gated line. As a bare word at the top of an ungated line it may be a function or alias from the user's shell (`source ~/.nvm/nvm.sh && nvm use 24`), and passes as it did. `npx`, `bunx`, `pnpx`, `uvx` and `xcrun` find their command by their own lookup, so the gate reads that command by its name only.
- **Shell state is tracked.** `cd`, `pushd` and `popd`, also through `command` and `builtin`, set the folder later words resolve from, and assignments, `export` and the like set PATH and HOME. A subshell, a pipe stage and a background job do not change their parent. A change that may not have happened (after `||`, in a branch or a loop, in a function body, or by a cd to a folder that does not exist yet) leaves the folder or PATH unknown, and a relative program or write after an unknown folder refuses. Other ways to set PATH (`read`, `printf -v`, a loop variable, zsh's `path` array) leave it unknown. A chain of more than eight runners, or scripts nested more than four deep, refuses.

curl and wget may not read options, URLs or a file name from anywhere the gate cannot see first (`curl -K` and `-J`, `wget --config`, `-e`, `-i` and `--content-disposition`), and wget's options count under any prefix it accepts. While deploy scripts are registered, a PowerShell line may not run a program through the call operator, dot-sourcing or a quoted path.

Paths are compared as the disk stores them: links are followed, and on a volume that ignores case (the macOS default) `.GIT/config` is `.git/config` and `GIT` is git.

### What it does not reach

The gate reads only the line it is given, as text. These are outside it:

- script files and files a shell sources, which can run anything and change the folder, PATH and the shell's functions
- code an interpreter or another program reads and runs on its own
- values the shell reads as code only at run time
- shell features that change how later words are found, which the gate follows only in part
- the shell around the line: the gate takes the PATH, HOME and CDPATH the hook runs with as the agent's shell's own, and does not see a login shell's startup files or what a persistent shell kept from an earlier call
- a deploy that a workflow starts on its own trigger, such as a push, a comment or a label, which the gate never sees as a deploy

The settings in section 8 are what holds there.

## 8. What GitHub must enforce

These settings are the boundary the gate relies on. Without them a repository has only the guardrail. Set these on every repository with the pipeline:

- **A ruleset on trunk** (target `~DEFAULT_BRANCH`): require a pull request before merging, block force pushes, and restrict deletions. Require the status checks `pipeline/scan`, `pipeline/ci` and `pipeline/review` (or `agent-review`), with CI's own checks. Pin every required check to the GitHub App that sets it (the check's expected source), and keep that App's private key and installation tokens out of every agent's environment. A required check that names no App counts a status from anyone with write access.
- **A ruleset on every branch** (target `~ALL`, nothing excluded): block force pushes and restrict deletions, with only the user on the bypass list. A ruleset that names some branches, or excludes any, leaves the others open.
- **A tag ruleset** (target `~ALL`, nothing excluded): restrict creations, updates and deletions to the user.
- **Releases:** tag rules do not stop a release. Anyone with write access can publish one against a tag that already exists, so publishing a release is its own permission boundary. Any workflow a release starts that deploys to production runs in the protected production environment below.
- **The production environment:** every production deploy workflow runs in an environment whose name matches `deploy.prodPattern`, with the user as a required reviewer and "Prevent self-review" on.
- **Deploy keys:** a deploy key on an agent's machine is read-only, and every key or credential that reaches production stays off that machine, so the production environment's rules decide each production deploy.
- **Agent tokens:** write access at most, never admin, on no ruleset's bypass list, without the Administration, Environments or Secrets permissions, and a credential of their own, not the user's.
- **This machine:** every repository with the pipeline runs its git pre-push hook (`install.sh --project <repo>` links it), the backstop for a `git push` the gate did not see.

`pipeline doctor` reads these settings with `gh api` and the hooks on this machine, and changes nothing. Each line is ok, missing, or unverified: a setting the API cannot show, such as whose credential a token is or who can reach an App's key. It says nothing is missing only when every setting it can read is there, and it lists the unverified ones for the user to confirm. It does not read deploy keys, so the user checks those.

Each stage is a commit status, so these checks can require them. Each status describes only its own commit: when a run's tip moves, its stages show as `pending` on the new tip until they pass there. Anyone with write access to commit statuses can set any status, which is why each required check names its App. The gate also refuses an agent's `gh api` status write for the `pipeline/*` and `agent-review` contexts, for the CI workflow's name and its jobs, and for any check trunk's rules require.

Two filters stay separate. GitHub's expected source decides which statuses GitHub counts toward a merge. The pipeline's own `review.trustedStatusWriters` decides which statuses the pipeline itself counts when it reads a review result. Setting one does not set the other.

## 9. Where state lives

- Runs: `~/.local/state/agent-pipeline/runs/<run>.json` (or `$AGENT_PIPELINE_STATE`).
- Check logs: `~/.local/state/agent-pipeline/logs/<run>/<lane>/<tip>/`.
- The builtin review ledger: `~/.local/state/agent-pipeline/reviews/`.
- The follow-up backlog: `~/.local/state/agent-pipeline/followups/`, one file per repository.
- The repositories with a committed config: `~/.local/state/agent-pipeline/repos.json`, which pipeline commands keep current. Each entry holds the repository's jj store, its remote and trunk, its deploy pattern, and every deploy script its `deploy.command` has named, by real path and content hash. The gate binds a deploy script run from any folder to its own repository by these, and refuses a script two repositories share. A registered repository whose committed config disappears from trunk is refused, never left ungated. When the file cannot be read, a deploy script could have any name, so the gate refuses every line that runs a program other than a plain read or one the system ships in `/bin`, `/usr/bin` and the like, and says so. Repair it in a terminal outside the agent, since the gate refuses an agent's write there: delete it, and the next pipeline command in each project writes it again.
- Each state file is written under a lock beside it (`<file>.lock`), which a process that died leaves behind for the next one to clear.
- The decision log: wherever `decisions.file` says, outside the repository when the repository is public.

The ledger is per machine, like agent-review's. GitHub statuses are the shared record.
