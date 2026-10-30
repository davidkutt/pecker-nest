#!/usr/bin/env bash
# Links the versioned agent files of this repo into Pi's agent directory.
#
#   scripts/link.sh            link into ${PI_CODING_AGENT_DIR:-~/.pi/agent}
#   scripts/link.sh --check    only report what is linked, change nothing
#
# Existing regular files are moved aside as <name>.bak.<timestamp>, never deleted.
# auth.json, sessions and other runtime state stay where they are.
set -euo pipefail

NEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXPECTED_DIR="$HOME/dev/pecker-nest"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# agent/settings.json loads the package from ~/dev/pecker-nest. A clone elsewhere would
# link settings that point at a missing package.
if [[ "$(cd "$EXPECTED_DIR" 2>/dev/null && pwd -P)" != "$NEST_DIR" ]]; then
  echo "error: this repo must live at $EXPECTED_DIR (it is at $NEST_DIR)." >&2
  echo "       Move it there, or symlink it: ln -s \"$NEST_DIR\" \"$EXPECTED_DIR\"" >&2
  exit 1
fi

status=0
link() {
  local src="$1" dest="$2"
  if [[ -L "$dest" && "$(readlink "$dest")" == "$src" ]]; then
    echo "ok      $dest"
    return
  fi
  if (( CHECK_ONLY )); then
    echo "missing $dest -> $src"
    status=1
    return
  fi
  if [[ -e "$dest" || -L "$dest" ]]; then
    local backup="$dest.bak.$(date +%Y%m%d%H%M%S)"
    mv "$dest" "$backup"
    echo "backup  $dest -> $backup"
  fi
  ln -s "$src" "$dest"
  echo "linked  $dest -> $src"
}

(( CHECK_ONLY )) || mkdir -p "$AGENT_DIR/prompts"

for name in settings.json models.json APPEND_SYSTEM.md mcp.json; do
  link "$NEST_DIR/agent/$name" "$AGENT_DIR/$name"
done

# pi-subagents' /prompt-workflow only scans the agent and project prompt directories,
# so the review-chain step templates are linked one by one.
for file in "$NEST_DIR"/agent/prompts/*.md; do
  link "$file" "$AGENT_DIR/prompts/$(basename "$file")"
done

exit "$status"
