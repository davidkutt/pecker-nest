#!/bin/sh
# Capture probe for question C6 of docs/research/cursor-hooks.md: how Cursor starts a hook command.
#
#   probe.sh <event> <form>
#
# cursor/capture/hooks.json registers this on sessionStart (fire-and-forget) under several command
# forms: an absolute path, a path relative to ~/.cursor, one with ~ and one with $HOME. A form that
# never shows up in the log did not start. Each run appends one line with the form, the working
# directory, how the script was named ($0), PATH, SHELL, the parent process and which node, npm and
# git that PATH finds, to ~/.local/state/pecker-nest/cursor/capture.jsonl, and prints {}.
#
# The payload is read only to count its bytes. No Node, no jq: this must work when nothing else does.

event=${1:-unknown}
form=${2:-unknown}
bytes=$(wc -c | tr -d ' ')
dir="${HOME}/.local/state/pecker-nest/cursor"

# JSON string content: backslashes and quotes escaped, control characters dropped.
esc() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

parent=$(ps -o comm= -p "$PPID" 2>/dev/null)
grandparent_pid=$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')
grandparent=""
if [ -n "$grandparent_pid" ]; then
  grandparent=$(ps -o comm= -p "$grandparent_pid" 2>/dev/null)
fi

line=$(printf '{"time":"%s","hook":"%s","probe":"%s","bytes":%s,"cwd":"%s","dollar0":"%s","PATH":"%s","SHELL":"%s","parent":"%s","grandparent":"%s","onPath":{"node":"%s","npm":"%s","git":"%s","bash":"%s"}}' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(esc "$event")" "$(esc "$form")" "${bytes:-0}" \
  "$(esc "$PWD")" "$(esc "$0")" "$(esc "${PATH:-}")" "$(esc "${SHELL:-}")" \
  "$(esc "$parent")" "$(esc "$grandparent")" \
  "$(esc "$(command -v node 2>/dev/null)")" "$(esc "$(command -v npm 2>/dev/null)")" \
  "$(esc "$(command -v git 2>/dev/null)")" "$(esc "$(command -v bash 2>/dev/null)")")

mkdir -p "$dir" 2>/dev/null && printf '%s\n' "$line" >>"$dir/capture.jsonl"
printf '{}\n'
exit 0
