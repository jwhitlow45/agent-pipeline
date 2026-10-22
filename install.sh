#!/bin/sh
# Installs agent-pipeline on this machine. With no options it only puts `pipeline` on PATH.
#
#   ./install.sh                      link bin/pipeline into ~/.local/bin (or $PIPELINE_BIN_DIR)
#   ./install.sh --claude             also add this repository as a Claude Code marketplace and install the plugin
#   ./install.sh --codex              also link the skill into ~/.codex/skills and set up Codex hooks
#   ./install.sh --project DIR        also write DIR/pipeline.config.json and link the git pre-push hook
#   ./install.sh --dry-run ...        print what it would do, change nothing
#
# It never overwrites a file it did not create: where one exists, it prints what to merge by hand.

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

# The CLI needs node 22 or later, jj, git and gh.
missing=
for tool in node jj git gh; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
[ -z "$missing" ] || say "warning: not on PATH:$missing. The pipeline needs node 22+, jj, git and gh."
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || say "warning: node $major is older than 22."
fi

act mkdir -p "$BIN_DIR"
if [ -e "$BIN_DIR/pipeline" ] && [ "$(readlink "$BIN_DIR/pipeline" 2>/dev/null)" != "$ROOT/bin/pipeline" ]; then
  say "skip: $BIN_DIR/pipeline exists and is not this checkout's. Remove it to link this one."
else
  act ln -sf "$ROOT/bin/pipeline" "$BIN_DIR/pipeline"
fi
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "note: add $BIN_DIR to PATH." ;; esac

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
  if [ -e "$CODEX_HOME/skills/agent-pipeline" ]; then
    say "skip: $CODEX_HOME/skills/agent-pipeline exists."
  else
    act ln -s "$ROOT/skills/agent-pipeline" "$CODEX_HOME/skills/agent-pipeline"
  fi
  hooks=$(sed "s#PIPELINE_BIN#$ROOT/bin/pipeline#g" "$ROOT/codex/hooks.json")
  if [ -e "$CODEX_HOME/hooks.json" ]; then
    say "skip: $CODEX_HOME/hooks.json exists. Merge these entries into it by hand:"
    say "$hooks"
  else
    say "+ write $CODEX_HOME/hooks.json"
    [ "$DRY" = 1 ] || printf '%s\n' "$hooks" > "$CODEX_HOME/hooks.json"
  fi
  say "Codex asks you to trust a new hook the first time it runs. Then add the section in"
  say "  $ROOT/codex/AGENTS-section.md"
  say "to $CODEX_HOME/AGENTS.md or the project's AGENTS.md."
fi

if [ -n "$PROJECT" ]; then
  if [ -e "$PROJECT/pipeline.config.json" ]; then
    say "skip: $PROJECT/pipeline.config.json exists."
  else
    act "$ROOT/bin/pipeline" init --repo "$PROJECT"
  fi
  if [ -d "$PROJECT/.git/hooks" ]; then
    if [ -e "$PROJECT/.git/hooks/pre-push" ]; then
      say "skip: $PROJECT/.git/hooks/pre-push exists. Call git-hooks/pre-push from it by hand."
    else
      act ln -s "$ROOT/git-hooks/pre-push" "$PROJECT/.git/hooks/pre-push"
    fi
  fi
fi

say "Done. Run: pipeline --help"
