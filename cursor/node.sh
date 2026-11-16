#!/bin/sh
# Starts a Node script of pecker-nest's Cursor hooks with the Node that scripts/link.sh recorded.
#
#   cursor/node.sh <script below cursor/> [args...]
#
# Cursor starts hooks from a GUI app whose PATH may lack Homebrew's /opt/homebrew/bin, so this does
# not look Node up on PATH. scripts/link.sh writes the absolute path of the `node` it found to
# ~/.config/pecker-nest/cursor-node. When that file, that Node or the script is missing, this says
# so on stderr and exits 1: Cursor then lets the action through for a hook without failClosed and
# blocks it for a hook with failClosed.
#
# POSIX sh on purpose: Cursor may run the hook command through the user's login shell (zsh or fish),
# and this file must not depend on which one.
set -u

if [ "$#" -lt 1 ]; then
  echo "usage: cursor/node.sh <script below cursor/> [args...]" >&2
  exit 2
fi

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
script="$here/$1"
shift
config="${HOME}/.config/pecker-nest/cursor-node"

if [ ! -r "$config" ]; then
  echo "pecker-nest: $config is missing, so the hook cannot find Node. Run ~/dev/pecker-nest/scripts/link.sh --cursor-capture again." >&2
  exit 1
fi
node=$(sed -n '1p' "$config")
if [ -z "$node" ] || [ ! -x "$node" ]; then
  echo "pecker-nest: the Node recorded in $config (${node:-empty}) is gone, maybe after a Node update. Run ~/dev/pecker-nest/scripts/link.sh --cursor-capture again." >&2
  exit 1
fi
if [ ! -f "$script" ]; then
  echo "pecker-nest: hook script $script not found." >&2
  exit 1
fi

exec "$node" "$script" "$@"
