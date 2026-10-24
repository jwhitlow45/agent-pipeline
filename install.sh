#!/bin/sh
# Installs agent-pipeline on this machine. With no options it only puts `pipeline` on PATH.
#
#   ./install.sh                      link bin/pipeline into ~/.local/bin (or $PIPELINE_BIN_DIR)
#   ./install.sh --claude             also add this repository as a Claude Code marketplace and install the plugin
#   ./install.sh --codex              also link the skill into ~/.codex/skills and set up Codex hooks
#   ./install.sh --project DIR        also write DIR/pipeline.config.json and link the git pre-push hook
#   ./install.sh --dry-run ...        print what it would do, change nothing
#
# It never overwrites a file or link it did not create: where one exists, a dangling link included,
# it prints what to merge by hand. New files and links are created exclusively.

set -eu

ROOT=$(cd "$(dirname "$0")" && pwd -P)
BIN_DIR=${PIPELINE_BIN_DIR:-$HOME/.local/bin}
CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
DRY=0
CLAUDE=0
CODEX=0
PROJECT=

while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --claude) CLAUDE=1 ;;
    --codex) CODEX=1 ;;
    --project) shift; PROJECT=${1:?--project needs a directory} ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 64 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
act() {
  say "+ $*"
  [ "$DRY" = 1 ] || "$@"
}
# True when the path is there, as a file, a folder or a link, a link to nothing included.
present() { [ -e "$1" ] || [ -L "$1" ]; }
# A path quoted for the shell, so a printed command still runs when the path holds a space or a quote.
quoted() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Prints the Codex hooks with the CLI path shell-quoted, so a path with a space or a quote still
# runs. Given a file, it creates that file exclusively instead, so it never writes through a link.
codex_hooks() {
  node - "$ROOT/codex/hooks.json" "$ROOT/bin/pipeline" "$@" <<'NODE'
const fs = require('node:fs');
const [template, bin, target] = process.argv.slice(2);
const quoted = `'${bin.replaceAll("'", "'\\''")}'`;
const hooks = JSON.parse(fs.readFileSync(template, 'utf8'));
for (const entries of Object.values(hooks.hooks)) for (const entry of entries) for (const hook of entry.hooks) hook.command = hook.command.replace('PIPELINE_BIN', () => quoted);
const text = `${JSON.stringify(hooks, null, 2)}\n`;
if (target) fs.writeFileSync(target, text, { flag: 'wx' });
else process.stdout.write(text);
NODE
}

# The CLI needs node 22 or later, git 2.41 or later and gh, and jj for jj repositories.
missing=
for tool in node git gh; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
[ -z "$missing" ] || say "warning: not on PATH:$missing. The pipeline needs node 22+, git 2.41+ and gh."
command -v jj >/dev/null 2>&1 || say "note: jj is not on PATH. The pipeline needs it only for jj repositories."
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || say "warning: node $major is older than 22."
fi

act mkdir -p "$BIN_DIR"
if [ "$(readlink "$BIN_DIR/pipeline" 2>/dev/null)" = "$ROOT/bin/pipeline" ]; then
  say "ok: $BIN_DIR/pipeline already links to this checkout."
elif present "$BIN_DIR/pipeline"; then
  say "skip: $BIN_DIR/pipeline exists and is not this checkout's. Remove it to link this one."
else
  act ln -s "$ROOT/bin/pipeline" "$BIN_DIR/pipeline"
fi
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "note: add $BIN_DIR to PATH." ;; esac
# Another tool may also be called pipeline. The hooks call this checkout by its full path, but a
# `pipeline` an agent types runs whichever comes first on PATH.
found=$(command -v pipeline 2>/dev/null || true)
if [ -n "$found" ] && [ "$found" != "$BIN_DIR/pipeline" ]; then
  say "warning: $found comes first on PATH, so the pipeline command runs it, not this checkout. Put $BIN_DIR earlier on PATH, or call $ROOT/bin/pipeline by its full path."
fi

if [ "$CLAUDE" = 1 ]; then
  if command -v claude >/dev/null 2>&1; then
    act claude plugin marketplace add "$ROOT"
    act claude plugin install agent-pipeline@agent-pipeline
  else
    say "Claude Code CLI not found. In a Claude Code session, run:"
    say "  /plugin marketplace add jwhitlow45/agent-pipeline"
    say "  /plugin install agent-pipeline@agent-pipeline"
  fi
fi

if [ "$CODEX" = 1 ]; then
  act mkdir -p "$CODEX_HOME/skills"
  if present "$CODEX_HOME/skills/agent-pipeline"; then
    say "skip: $CODEX_HOME/skills/agent-pipeline exists."
  else
    act ln -s "$ROOT/skills/agent-pipeline" "$CODEX_HOME/skills/agent-pipeline"
  fi
  if present "$CODEX_HOME/hooks.json"; then
    say "skip: $CODEX_HOME/hooks.json exists. Merge these entries into it by hand:"
    codex_hooks
  else
    say "+ write $CODEX_HOME/hooks.json"
    [ "$DRY" = 1 ] || codex_hooks "$CODEX_HOME/hooks.json"
  fi
  say "Codex asks you to trust a new hook the first time it runs. Then add the section in"
  say "  $ROOT/codex/AGENTS-section.md"
  say "to $CODEX_HOME/AGENTS.md or the project's AGENTS.md."
fi

if [ -n "$PROJECT" ]; then
  if present "$PROJECT/pipeline.config.json"; then
    say "skip: $PROJECT/pipeline.config.json exists."
  else
    act "$ROOT/bin/pipeline" init --repo "$PROJECT"
  fi
  # git runs hooks from core.hooksPath when it is set, so the hook goes where git will look.
  hooks_dir=$(git -C "$PROJECT" rev-parse --path-format=absolute --git-path hooks 2>/dev/null || true)
  hooks_path=$(git -C "$PROJECT" config --get core.hooksPath 2>/dev/null || true)
  if [ -z "$hooks_dir" ]; then
    say "warning: $PROJECT has no git repository, so no pre-push hook was linked. Only the agents' gate checks pushes there."
  elif [ ! -d "$hooks_dir" ]; then
    say "warning: no pre-push hook was linked, because $hooks_dir does not exist${hooks_path:+ (core.hooksPath is $hooks_path)}. Create it and run install.sh --project again."
  elif present "$hooks_dir/pre-push"; then
    say "skip: $hooks_dir/pre-push exists. Call git-hooks/pre-push from it by hand."
  else
    [ -z "$hooks_path" ] || say "note: core.hooksPath is $hooks_path, so the hook goes in $hooks_dir."
    act ln -s "$ROOT/git-hooks/pre-push" "$hooks_dir/pre-push"
  fi
  # A relative or worktree-scoped core.hooksPath gives a worktree its own hooks folder, and a push
  # there runs no hook unless it is linked there too.
  if [ -n "$hooks_dir" ]; then
    git -C "$PROJECT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while IFS= read -r tree; do
      [ -d "$tree" ] || continue
      dir=$(git -C "$tree" rev-parse --path-format=absolute --git-path hooks 2>/dev/null || true)
      if [ -n "$dir" ] && [ "$dir" != "$hooks_dir" ]; then
        say "note: the worktree $tree runs hooks from $dir, not $hooks_dir. Link the hook there too: ln -s $(quoted "$ROOT/git-hooks/pre-push") $(quoted "$dir/pre-push")"
      fi
    done
  fi
  if [ -d "$PROJECT/.jj" ]; then
    say "note: jj git push does not run git hooks. The gate checks agents' jj pushes, and pipeline exec -- jj git push ... checks one by hand."
  fi
fi

say "Done. Run: pipeline --help"
