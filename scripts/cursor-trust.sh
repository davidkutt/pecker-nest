#!/usr/bin/env bash
# The repositories in which the Cursor adapter's quality gate may run.
#
#   scripts/cursor-trust.sh add [path]      trust a repository (default: the current directory)
#   scripts/cursor-trust.sh remove [path]   stop trusting it
#   scripts/cursor-trust.sh list            show the trusted repositories
#
# The list is ~/.config/pecker-nest/cursor-trusted, one absolute path per line (cursor/lib/trust.ts
# reads it). The gate runs the command in a repository's .pi/gate.json with your rights, so it runs
# only in repositories on this list; the safety hooks apply everywhere. A worktree that Cursor
# creates from a trusted checkout is trusted with it. The agent cannot run this script or write the
# list (lib/harness.ts). Runs under macOS bash 3.2; the commands are the same in bash and fish.
set -euo pipefail

file="$HOME/.config/pecker-nest/cursor-trusted"

usage() {
  echo "usage: scripts/cursor-trust.sh add [path] | remove [path] | list" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
action="$1"
shift
[[ $# -le 1 ]] || usage

canonical() { (cd "$1" 2>/dev/null && pwd -P); }

# The listed paths, without blank lines and comments.
entries() {
  [[ -r "$file" ]] || return 0
  grep -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' "$file" || true
}

# Replaces the list with stdin, atomically.
write_entries() {
  mkdir -p "$(dirname "$file")"
  local temporary
  temporary="$(mktemp "$file.XXXXXX")"
  cat >"$temporary"
  chmod 644 "$temporary"
  mv "$temporary" "$file"
}

case "$action" in
  add)
    target="${1:-.}"
    if [[ ! -d "$target" ]]; then
      echo "error: $target is not a directory." >&2
      exit 1
    fi
    root="$(canonical "$target")"
    if entries | grep -Fx -- "$root" >/dev/null; then
      echo "ok      $root is already trusted"
      exit 0
    fi
    { entries; printf '%s\n' "$root"; } | write_entries
    echo "trusted $root"
    top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ -z "$top" ]]; then
      echo "note    $root is not a git repository; the gate needs git to see what a turn changed."
    elif [[ "$(canonical "$top")" != "$root" ]]; then
      echo "note    $root is inside the repository $top; the gate runs for the folder you open in Cursor."
    fi
    if [[ ! -f "$root/.pi/gate.json" ]]; then
      echo "note    $root has no .pi/gate.json yet; the gate starts once it has one."
    fi
    ;;
  remove)
    target="${1:-.}"
    root="$(canonical "$target" || true)"
    [[ -n "$root" ]] || root="$target"
    if ! entries | grep -Fx -- "$root" >/dev/null; then
      echo "error: $root is not on the list ($file)." >&2
      exit 1
    fi
    { entries | grep -Fxv -- "$root" || true; } | write_entries
    echo "removed $root"
    ;;
  list)
    count=0
    while IFS= read -r line; do
      count=$((count + 1))
      note=""
      if [[ ! -d "$line" ]]; then
        note=" (missing)"
      elif [[ ! -f "$line/.pi/gate.json" ]]; then
        note=" (no .pi/gate.json)"
      fi
      echo "$line$note"
    done < <(entries)
    if [[ "$count" -eq 0 ]]; then
      echo "No repository is trusted; the gate runs nowhere. Add one: scripts/cursor-trust.sh add <path>"
    fi
    ;;
  *) usage ;;
esac
