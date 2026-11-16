#!/usr/bin/env bash
# Links the versioned agent files of this repo into Pi's agent directory.
#
#   scripts/link.sh            link into ${PI_CODING_AGENT_DIR:-~/.pi/agent}
#   scripts/link.sh --check    only report what is linked, change nothing
#   scripts/link.sh --claude   also link the Claude Code skills (nest-supervise, nest-handoff)
#                              into ${CLAUDE_CONFIG_DIR:-~/.claude}/skills
#
#   scripts/link.sh --cursor-capture       only this: install the capture hook of
#                                          docs/research/cursor-hooks.md as ~/.cursor/hooks.json
#   scripts/link.sh --cursor-capture-off   only this: remove it again; the capture log stays
#   scripts/link.sh --check --cursor-capture   report whether the capture hook is installed
#
# Existing regular files are moved aside as <name>.bak.<timestamp>, never deleted.
# auth.json, sessions and other runtime state stay where they are.
#
# The capture hook writes ~/.cursor/hooks.json from cursor/capture/hooks.json with this checkout's
# path filled in, because user hooks need absolute paths and the repository holds no
# machine-specific path. It records the absolute path of `node` in ~/.config/pecker-nest/cursor-node,
# because Cursor may start hooks with a PATH that lacks Homebrew. Runs under macOS bash 3.2.
set -euo pipefail

NEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXPECTED_DIR="$HOME/dev/pecker-nest"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CURSOR_DIR="$HOME/.cursor"
CURSOR_HOOKS="$CURSOR_DIR/hooks.json"
CURSOR_PROBE="$CURSOR_DIR/hooks/pecker-nest-probe.sh"
NEST_CONFIG_DIR="$HOME/.config/pecker-nest"
NEST_STATE_DIR="$HOME/.local/state/pecker-nest/cursor"
CHECK_ONLY=0
LINK_CLAUDE=0
CURSOR_CAPTURE=""
usage() {
  echo "usage: scripts/link.sh [--check] [--claude]" >&2
  echo "       scripts/link.sh [--check] --cursor-capture | --cursor-capture-off" >&2
  exit 2
}
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --claude) LINK_CLAUDE=1 ;;
    --cursor-capture) [[ -z "$CURSOR_CAPTURE" ]] || usage; CURSOR_CAPTURE=on ;;
    --cursor-capture-off) [[ -z "$CURSOR_CAPTURE" ]] || usage; CURSOR_CAPTURE=off ;;
    *) usage ;;
  esac
done
# The capture switches stand alone: they are temporary and leave Pi's links as they are.
if [[ -n "$CURSOR_CAPTURE" ]] && (( LINK_CLAUDE )); then usage; fi

# agent/settings.json loads the package from ~/dev/pecker-nest. A clone elsewhere would
# link settings that point at a missing package.
if [[ "$(cd "$EXPECTED_DIR" 2>/dev/null && pwd -P)" != "$NEST_DIR" ]]; then
  echo "error: this repo must live at $EXPECTED_DIR (it is at $NEST_DIR)." >&2
  echo "       Move it there, or symlink it: ln -s \"$NEST_DIR\" \"$EXPECTED_DIR\"" >&2
  exit 1
fi

status=0
backup() {
  local dest="$1"
  local backup="$dest.bak.$(date +%Y%m%d%H%M%S)"
  mv "$dest" "$backup"
  echo "backup  $dest -> $backup"
}

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
    backup "$dest"
  fi
  ln -s "$src" "$dest"
  echo "linked  $dest -> $src"
}

# ---------------------------------------------------------------- Cursor capture hook

# ~/.cursor/hooks.json as the capture hook wants it, on stdout.
capture_hooks_json() {
  sed "s|@NEST_DIR@|$NEST_DIR|g" "$NEST_DIR/cursor/capture/hooks.json"
}

is_capture_hooks() {
  [[ -f "$1" ]] && grep -q "$NEST_DIR/cursor/capture/" "$1"
}

cursor_capture_on() {
  if (( CHECK_ONLY )); then
    if [[ -f "$CURSOR_HOOKS" ]] && cmp -s <(capture_hooks_json) "$CURSOR_HOOKS"; then
      echo "ok      $CURSOR_HOOKS (capture hook)"
    else
      echo "missing $CURSOR_HOOKS (capture hook)"
      status=1
    fi
    link "$NEST_DIR/cursor/capture/probe.sh" "$CURSOR_PROBE"
    return
  fi

  # The commands in hooks.json are not quoted, so that every shell (and no shell) reads them alike.
  if [[ ! "$NEST_DIR" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "error: $NEST_DIR contains characters a hook command cannot carry unquoted." >&2
    exit 1
  fi
  local node_bin
  node_bin="$(command -v node || true)"
  if [[ -z "$node_bin" || "$node_bin" != /* ]]; then
    echo "error: node is not on PATH. Install it (brew install node) and run this again." >&2
    exit 1
  fi
  if ! "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'; then
    echo "error: $node_bin is $("$node_bin" --version); the hooks need Node 22.18 or newer." >&2
    exit 1
  fi

  mkdir -p "$NEST_CONFIG_DIR" "$NEST_STATE_DIR" "$CURSOR_DIR/hooks"
  printf '%s\n' "$node_bin" > "$NEST_CONFIG_DIR/cursor-node"
  echo "node    $node_bin (recorded in $NEST_CONFIG_DIR/cursor-node)"

  local generated
  generated="$(mktemp "${TMPDIR:-/tmp}/pecker-nest-hooks.XXXXXX")"
  capture_hooks_json > "$generated"
  if ! "$node_bin" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8"))' "$generated"; then
    rm -f "$generated"
    echo "error: the generated hooks.json is not valid JSON." >&2
    exit 1
  fi
  if [[ -f "$CURSOR_HOOKS" ]] && cmp -s "$generated" "$CURSOR_HOOKS"; then
    rm -f "$generated"
    echo "ok      $CURSOR_HOOKS (capture hook)"
  else
    if [[ -e "$CURSOR_HOOKS" || -L "$CURSOR_HOOKS" ]]; then
      backup "$CURSOR_HOOKS"
    fi
    mv "$generated" "$CURSOR_HOOKS"
    chmod 644 "$CURSOR_HOOKS"
    echo "wrote   $CURSOR_HOOKS (capture hook)"
  fi
  link "$NEST_DIR/cursor/capture/probe.sh" "$CURSOR_PROBE"
  echo
  echo "The capture log is $NEST_STATE_DIR/capture.jsonl."
  echo "Remove the hook with: $EXPECTED_DIR/scripts/link.sh --cursor-capture-off"
}

cursor_capture_off() {
  if [[ -e "$CURSOR_HOOKS" ]] && ! is_capture_hooks "$CURSOR_HOOKS"; then
    echo "error: $CURSOR_HOOKS is not the capture hook; left as it is." >&2
    exit 1
  fi
  if (( CHECK_ONLY )); then
    if [[ -e "$CURSOR_HOOKS" ]]; then
      echo "present $CURSOR_HOOKS (capture hook)"
      status=1
    else
      echo "ok      $CURSOR_HOOKS (no capture hook)"
    fi
    return
  fi
  if [[ -e "$CURSOR_HOOKS" ]]; then
    rm "$CURSOR_HOOKS"
    echo "removed $CURSOR_HOOKS (capture hook)"
  else
    echo "ok      $CURSOR_HOOKS (no capture hook)"
  fi
  if [[ -L "$CURSOR_PROBE" && "$(readlink "$CURSOR_PROBE")" == "$NEST_DIR/cursor/capture/probe.sh" ]]; then
    rm "$CURSOR_PROBE"
    echo "removed $CURSOR_PROBE"
  fi
  local previous
  previous="$(ls -t "$CURSOR_HOOKS".bak.* 2>/dev/null | head -n 1 || true)"
  if [[ -n "$previous" ]]; then
    echo "Your earlier hooks.json is $previous. To use it again: mv \"$previous\" \"$CURSOR_HOOKS\""
  fi
  echo "The capture log stays at $NEST_STATE_DIR/capture.jsonl."
}

if [[ "$CURSOR_CAPTURE" == on ]]; then
  cursor_capture_on
  exit "$status"
fi
if [[ "$CURSOR_CAPTURE" == off ]]; then
  cursor_capture_off
  exit "$status"
fi

# ---------------------------------------------------------------- Pi

(( CHECK_ONLY )) || mkdir -p "$AGENT_DIR/prompts"

for name in settings.json models.json APPEND_SYSTEM.md mcp.json; do
  link "$NEST_DIR/agent/$name" "$AGENT_DIR/$name"
done

# pi-subagents' /prompt-workflow only scans the agent and project prompt directories,
# so the review-chain step templates are linked one by one.
for file in "$NEST_DIR"/agent/prompts/*.md; do
  link "$file" "$AGENT_DIR/prompts/$(basename "$file")"
done

# Claude Code skills for supervising nest sessions and writing handoffs (field-notes/README.md).
if (( LINK_CLAUDE )); then
  (( CHECK_ONLY )) || mkdir -p "$CLAUDE_DIR/skills"
  for dir in "$NEST_DIR"/claude/skills/*/; do
    dir="${dir%/}"
    link "$dir" "$CLAUDE_DIR/skills/$(basename "$dir")"
  done
fi

exit "$status"
