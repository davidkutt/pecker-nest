#!/usr/bin/env bash
# Links the versioned agent files of this repo into Pi's agent directory.
#
#   scripts/link.sh            link into ${PI_CODING_AGENT_DIR:-~/.pi/agent}
#   scripts/link.sh --check    only report what is linked, change nothing
#
# The supervision skills skills/nest-supervise and skills/nest-handoff, per tool, combinable:
#   scripts/link.sh --claude   also into ${CLAUDE_CONFIG_DIR:-~/.claude}/skills
#   scripts/link.sh --cursor   also into ~/.cursor/skills, and installs the Cursor adapter:
#                              ~/.cursor/hooks.json from cursor/hooks.json, ~/.cursor/agents/reviewer.md,
#                              and grill-me, testing-ts and testing-py in ~/.agents/skills
#   scripts/link.sh --pi       also into ${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills
#
#   scripts/link.sh --cursor-capture       only this: install the capture hook of
#                                          docs/research/cursor-hooks.md as ~/.cursor/hooks.json
#   scripts/link.sh --cursor-capture-off   only this: remove it again; the capture log stays
#   scripts/link.sh --check --cursor-capture   report whether the capture hook is installed
#
# Existing regular files are moved aside as <name>.bak.<timestamp>, never deleted. Skill links
# move nothing aside, because a backup in a skills directory loads as a second copy of the skill:
# anything there that is not a link into this checkout is reported as `foreign` and left as it is
# (exit code 1); an older link into this checkout (claude/skills/ before the move) is replaced.
# auth.json, sessions and other runtime state stay where they are.
#
# The adapter and the capture hook write ~/.cursor/hooks.json from cursor/hooks.json or
# cursor/capture/hooks.json with this checkout's path filled in, because user hooks need absolute
# paths and the repository holds no machine-specific path. Both record the resolved absolute path of
# `node` in ~/.config/pecker-nest/cursor-node, because Cursor may start hooks with a PATH that lacks
# Homebrew, and fnm's `command -v node` names a per-shell directory that vanishes with the shell.
# Runs under macOS bash 3.2.
set -euo pipefail

NEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXPECTED_DIR="$HOME/dev/pecker-nest"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CURSOR_DIR="$HOME/.cursor"
CURSOR_HOOKS="$CURSOR_DIR/hooks.json"
CURSOR_PROBE="$CURSOR_DIR/hooks/pecker-nest-probe.sh"
CURSOR_REVIEWER="$CURSOR_DIR/agents/reviewer.md"
AGENTS_SKILLS_DIR="$HOME/.agents/skills"
# Not best-practices: it needs the knowledge base, which Cursor does not have.
CURSOR_ADAPTER_SKILLS="grill-me testing-ts testing-py"
NEST_CONFIG_DIR="$HOME/.config/pecker-nest"
NEST_STATE_DIR="$HOME/.local/state/pecker-nest/cursor"
CHECK_ONLY=0
LINK_CLAUDE=0
LINK_CURSOR=0
LINK_PI=0
SUPERVISION_SKILLS="nest-supervise nest-handoff"
CURSOR_CAPTURE=""
usage() {
  echo "usage: scripts/link.sh [--check] [--claude] [--cursor] [--pi]" >&2
  echo "       scripts/link.sh [--check] --cursor-capture | --cursor-capture-off" >&2
  exit 2
}
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --claude) LINK_CLAUDE=1 ;;
    --cursor) LINK_CURSOR=1 ;;
    --pi) LINK_PI=1 ;;
    --cursor-capture) [[ -z "$CURSOR_CAPTURE" ]] || usage; CURSOR_CAPTURE=on ;;
    --cursor-capture-off) [[ -z "$CURSOR_CAPTURE" ]] || usage; CURSOR_CAPTURE=off ;;
    *) usage ;;
  esac
done
# The capture switches stand alone: they are temporary and leave Pi's links as they are.
if [[ -n "$CURSOR_CAPTURE" ]] && (( LINK_CLAUDE + LINK_CURSOR + LINK_PI )); then usage; fi

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
  local backup
  # The PID keeps two backups in the same second apart.
  backup="$dest.bak.$(date +%Y%m%d%H%M%S).$$"
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

link_skill() {
  local src="$1" dest="$2"
  if [[ -L "$dest" && "$(readlink "$dest")" == "$src" ]]; then
    echo "ok      $dest"
    return
  fi
  if [[ -e "$dest" || -L "$dest" ]] && [[ ! -L "$dest" || "$(readlink "$dest")" != "$NEST_DIR"/* ]]; then
    echo "foreign $dest is not a link into $NEST_DIR; left as it is"
    status=1
    return
  fi
  if (( CHECK_ONLY )); then
    echo "missing $dest -> $src"
    status=1
    return
  fi
  if [[ -L "$dest" ]]; then rm "$dest"; fi
  ln -s "$src" "$dest"
  echo "linked  $dest -> $src"
}

link_skills() {
  local dir="$1" name
  (( CHECK_ONLY )) || mkdir -p "$dir"
  for name in $SUPERVISION_SKILLS; do
    link_skill "$NEST_DIR/skills/$name" "$dir/$name"
  done
}

# ---------------------------------------------------------------- Cursor: Node and hooks.json

# Records the resolved path of the `node` on PATH for cursor/node.sh. fnm's `command -v node` is a
# link inside a per-shell directory (fnm_multishells) that disappears with the shell; Node's own
# process.execPath, resolved, is the installation that stays.
record_node() {
  local found real
  found="$(command -v node || true)"
  if [[ -z "$found" || "$found" != /* ]]; then
    echo "error: node is not on PATH. Install it (brew install node, or fnm) and run this again." >&2
    exit 1
  fi
  real="$("$found" -p 'require("node:fs").realpathSync(process.execPath)' 2>/dev/null || true)"
  if [[ -z "$real" || "$real" != /* || ! -x "$real" ]]; then
    echo "error: could not resolve the path of $found." >&2
    exit 1
  fi
  if [[ "$real" == *fnm_multishells* ]]; then
    echo "error: $found resolves to $real, inside fnm's per-shell directory, which disappears with the shell." >&2
    exit 1
  fi
  if ! "$real" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'; then
    echo "error: $real is $("$real" --version); the hooks need Node 22.18 or newer." >&2
    exit 1
  fi
  mkdir -p "$NEST_CONFIG_DIR" "$NEST_STATE_DIR"
  printf '%s\n' "$real" > "$NEST_CONFIG_DIR/cursor-node"
  echo "node    $real (recorded in $NEST_CONFIG_DIR/cursor-node)"
}

# --check: the recorded Node exists.
check_node() {
  local recorded=""
  [[ -r "$NEST_CONFIG_DIR/cursor-node" ]] && recorded="$(sed -n '1p' "$NEST_CONFIG_DIR/cursor-node")"
  if [[ -n "$recorded" && -x "$recorded" ]]; then
    echo "ok      node $recorded ($NEST_CONFIG_DIR/cursor-node)"
  else
    echo "missing node ($NEST_CONFIG_DIR/cursor-node: ${recorded:-no path})"
    status=1
  fi
}

# The commands in hooks.json are not quoted, so that every shell (and no shell) reads them alike.
check_hook_path() {
  if [[ ! "$NEST_DIR" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "error: $NEST_DIR contains characters a hook command cannot carry unquoted." >&2
    exit 1
  fi
}

# A hooks.json template with this checkout's path, on stdout.
hooks_json() {
  sed "s|@NEST_DIR@|$NEST_DIR|g" "$NEST_DIR/$1"
}

# Writes ~/.cursor/hooks.json from template $1, labelled $2; an earlier file is backed up.
install_hooks() {
  local template="$1" label="$2" generated
  generated="$(mktemp "${TMPDIR:-/tmp}/pecker-nest-hooks.XXXXXX")"
  hooks_json "$template" > "$generated"
  if ! "$(sed -n '1p' "$NEST_CONFIG_DIR/cursor-node")" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8"))' "$generated"; then
    rm -f "$generated"
    echo "error: the generated hooks.json is not valid JSON." >&2
    exit 1
  fi
  mkdir -p "$CURSOR_DIR"
  if [[ -f "$CURSOR_HOOKS" ]] && cmp -s "$generated" "$CURSOR_HOOKS"; then
    rm -f "$generated"
    echo "ok      $CURSOR_HOOKS ($label)"
  else
    if [[ -e "$CURSOR_HOOKS" || -L "$CURSOR_HOOKS" ]]; then
      backup "$CURSOR_HOOKS"
    fi
    mv "$generated" "$CURSOR_HOOKS"
    chmod 644 "$CURSOR_HOOKS"
    echo "wrote   $CURSOR_HOOKS ($label)"
  fi
}

check_hooks() {
  local template="$1" label="$2"
  if [[ -f "$CURSOR_HOOKS" ]] && cmp -s <(hooks_json "$template") "$CURSOR_HOOKS"; then
    echo "ok      $CURSOR_HOOKS ($label)"
  else
    echo "missing $CURSOR_HOOKS ($label)"
    status=1
  fi
}

# ---------------------------------------------------------------- Cursor adapter

cursor_adapter() {
  if (( CHECK_ONLY )); then
    check_node
    check_hooks cursor/hooks.json adapter
  else
    check_hook_path
    record_node
    install_hooks cursor/hooks.json adapter
    mkdir -p "$CURSOR_DIR/agents"
  fi
  link "$NEST_DIR/cursor/agents/reviewer.md" "$CURSOR_REVIEWER"
  (( CHECK_ONLY )) || mkdir -p "$AGENTS_SKILLS_DIR"
  local name
  for name in $CURSOR_ADAPTER_SKILLS; do
    link_skill "$NEST_DIR/skills/$name" "$AGENTS_SKILLS_DIR/$name"
  done
}

# ---------------------------------------------------------------- Cursor capture hook

is_capture_hooks() {
  [[ -f "$1" ]] && grep -q "$NEST_DIR/cursor/capture/" "$1"
}

cursor_capture_on() {
  if (( CHECK_ONLY )); then
    check_hooks cursor/capture/hooks.json "capture hook"
    link "$NEST_DIR/cursor/capture/probe.sh" "$CURSOR_PROBE"
    return
  fi

  check_hook_path
  record_node
  mkdir -p "$CURSOR_DIR/hooks"
  install_hooks cursor/capture/hooks.json "capture hook"
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

# Skills for supervising nest sessions and writing handoffs (field-notes/README.md). Pi's package
# leaves them out (package.json: "!skills/nest-*"), so each tool gets them only through these links.
if (( LINK_CLAUDE )); then link_skills "$CLAUDE_DIR/skills"; fi
if (( LINK_CURSOR )); then link_skills "$CURSOR_DIR/skills"; fi
if (( LINK_PI )); then link_skills "$AGENT_DIR/skills"; fi

# The Cursor adapter (docs/SETUP.md, "Cursor"): hooks, reviewer subagent, skills.
if (( LINK_CURSOR )); then
  cursor_adapter
  if (( ! CHECK_ONLY )); then
    echo
    echo "Cursor adapter installed. Restart Cursor (Cmd+Q), then trust the repositories the gate may run in:"
    echo "  $EXPECTED_DIR/scripts/cursor-trust.sh add <repo>"
    echo "and paste $NEST_DIR/cursor/user-rule.md into Cursor's User Rules."
  fi
fi

exit "$status"
