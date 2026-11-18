#!/bin/sh
# Starts a Node script of pecker-nest's Cursor hooks with the Node that scripts/link.sh recorded.
#
#   cursor/node.sh <script below cursor/> [args...]
#
# Cursor starts hooks from a GUI app whose PATH may lack the Node you use in a terminal (Homebrew's
# /opt/homebrew/bin, or a Node from fnm, whose `command -v node` points into a per-shell directory
# that disappears with the shell). So this does not look Node up on PATH: scripts/link.sh writes the
# resolved absolute path of `node` to ~/.config/pecker-nest/cursor-node.
#
# When that file, that Node or the script is missing, this says so on stderr. For the three
# permission hooks of the adapter (failClosed in cursor/hooks.json) it also answers deny with the
# same text, so Cursor shows why every command is blocked; anything else exits 1, which lets the
# action through for a hook without failClosed (the capture hook, beforeSubmitPrompt, stop).
#
# POSIX sh on purpose: Cursor may run the hook command through the user's login shell (zsh or fish),
# and this file must not depend on which one.
set -u

if [ "$#" -lt 1 ]; then
  echo "usage: cursor/node.sh <script below cursor/> [args...]" >&2
  exit 2
fi

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
name=$1
script="$here/$name"
shift
config="${HOME}/.config/pecker-nest/cursor-node"
relink="Run ~/dev/pecker-nest/scripts/link.sh --cursor again (--cursor-capture for the capture hook)."

# JSON string content: backslashes and quotes escaped, control characters dropped.
esc() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

fail() {
  echo "pecker-nest: $1" >&2
  message="Blocked by pecker-nest: the hook cannot start Node, so nothing can run until the user fixes it: $1 Do not try to work around this block. Tell the user what you wanted to do and why; they can do it themselves."
  case "$name" in
    hooks/before-shell-execution.ts | hooks/pre-tool-use.ts)
      printf '{"permission":"deny","user_message":"%s","agent_message":"%s"}\n' "$(esc "$message")" "$(esc "$message")"
      exit 0
      ;;
    hooks/before-read-file.ts)
      printf '{"permission":"deny","user_message":"%s"}\n' "$(esc "$message")"
      exit 0
      ;;
  esac
  exit 1
}

if [ ! -r "$config" ]; then
  fail "$config is missing, so the hook cannot find Node. $relink"
fi
node=$(sed -n '1p' "$config")
if [ -z "$node" ] || [ ! -x "$node" ]; then
  fail "the Node recorded in $config (${node:-empty}) is gone, maybe after a Node update. $relink"
fi
if [ ! -f "$script" ]; then
  fail "hook script $script not found."
fi

exec "$node" "$script" "$@"
