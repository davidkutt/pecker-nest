#!/usr/bin/env bash
# Runs one headless Pi task in the pecker-nest container against a repository.
#
#   docker/pi-run.sh [-C <repo>] "<task>"
#
# Only the repository (default: the current directory) is mounted, at /workspace. Inside one
# container, docker/task.sh installs dependencies (pnpm-lock.yaml → pnpm install, uv.lock →
# uv sync, or PI_RUN_SETUP), refreshes the OpenRouter model list for the key, runs Pi with
# --mode json --approve, and then runs the gate command from .pi/gate.json once more as an
# independent check.
#
# Environment:
# The container runs Pi with --approve, so it only gets the container's own OpenRouter key (the
# one with a credit limit). The key is looked up in this order and reaches the container as
# OPENROUTER_API_KEY, through the environment only:
#   1. PI_RUN_OPENROUTER_API_KEY
#   2. the macOS Keychain item (wherever the `security` tool exists):
#        security find-generic-password -a "$USER" -s pecker-nest-container-key -w
#      Store it once with (asks for the key, so it stays out of the shell history):
#        security add-generic-password -U -a "$USER" -s pecker-nest-container-key -w
#   3. OPENROUTER_API_KEY, only with PI_RUN_ALLOW_INTERACTIVE_KEY=1
# Without a key the script exits 64. It never uses the interactive key on its own.
#
# Environment:
#   PI_RUN_OPENROUTER_API_KEY     the container key, see above
#   PI_RUN_KEYCHAIN_SERVICE       Keychain service name (default: pecker-nest-container-key)
#   PI_RUN_ALLOW_INTERACTIVE_KEY  1 lets the run spend OPENROUTER_API_KEY (no credit limit)
#   PI_IMAGE           image name (default: pecker-nest-pi)
#   PI_RUN_LOG_DIR     where logs go (default: <pecker-nest>/runs)
#   PI_RUN_SETUP       setup command instead of the lockfile default; empty skips setup
#   PI_RUN_PASS_ENV    space-separated extra variable names to forward, e.g. "KB_TOKEN"
#   PI_RUN_DOCKER_ARGS extra `docker run` arguments, word-split, e.g. "--network host"
#
# Logs per run: <id>.jsonl (Pi event stream) and <id>.stderr.log (Pi diagnostics plus the setup,
# model refresh and gate output between `=== setup` / `=== models` / `=== gate` marker lines).
# Exit code: Pi's exit code if it failed, 3 if setup failed, 2 if the gate is red, else 0.
set -euo pipefail

usage() {
  echo "usage: $0 [-C <repo>] \"<task>\"" >&2
  exit 64
}

repo="$PWD"
if [[ "${1:-}" == "-C" ]]; then
  [[ $# -ge 2 ]] || usage
  repo="$2"
  shift 2
fi
repo="$(cd "$repo" && pwd -P)"
task="$*"
[[ -n "$task" ]] || usage

# The container key. Never printed, never logged, never on a command line.
keychain_service="${PI_RUN_KEYCHAIN_SERVICE:-pecker-nest-container-key}"
keychain_user="${USER:-$(id -un)}"
key="${PI_RUN_OPENROUTER_API_KEY:-}"
if [[ -z "$key" ]] && command -v security >/dev/null 2>&1; then
  key="$(security find-generic-password -a "$keychain_user" -s "$keychain_service" -w 2>/dev/null || true)"
fi
if [[ -z "$key" && "${PI_RUN_ALLOW_INTERACTIVE_KEY:-}" == 1 && -n "${OPENROUTER_API_KEY:-}" ]]; then
  key="$OPENROUTER_API_KEY"
  echo "warning: PI_RUN_ALLOW_INTERACTIVE_KEY=1: this run spends OPENROUTER_API_KEY, which has no credit limit" >&2
fi
if [[ -z "$key" ]]; then
  {
    echo "error: no container key. Store the OpenRouter key with the credit limit in the macOS Keychain:"
    echo "         security add-generic-password -U -a \"$keychain_user\" -s $keychain_service -w"
    echo "       (it asks for the key, so the key stays out of your shell history), or set"
    echo "       PI_RUN_OPENROUTER_API_KEY for this run."
    if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
      echo "       OPENROUTER_API_KEY is set but not used: the container runs with --approve and that"
      echo "       key has no credit limit. PI_RUN_ALLOW_INTERACTIVE_KEY=1 overrides this."
    fi
  } >&2
  exit 64
fi

image="${PI_IMAGE:-pecker-nest-pi}"
nest_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
log_dir="${PI_RUN_LOG_DIR:-$nest_dir/runs}"
run_id="$(date +%Y%m%d-%H%M%S)-$(basename "$repo")"
mkdir -p "$log_dir"

env_args=(-e OPENROUTER_API_KEY)
[[ -n "${PI_RUN_SETUP+set}" ]] && env_args+=(-e PI_RUN_SETUP)
for name in ${PI_RUN_PASS_ENV:-}; do env_args+=(-e "$name"); done
mounts=(-v "$repo:/workspace" -v pecker-nest-sessions:/sessions)
# An anonymous volume masks the host's node_modules (built for another OS) inside the container.
[[ -f "$repo/package.json" ]] && mounts+=(-v /workspace/node_modules)

# On Linux, run as the host user so files written to /workspace keep the host's ownership and a
# repository owned by another uid stays writable. Docker Desktop on macOS maps ownership itself.
user_args=()
[[ "$(uname -s)" == Linux ]] && user_args=(--user "$(id -u):$(id -g)")

echo "run $run_id: $repo"
set +e
# The key reaches docker through its environment, not its command line.
# shellcheck disable=SC2086 # PI_RUN_DOCKER_ARGS is split into words on purpose.
OPENROUTER_API_KEY="$key" docker run --rm ${user_args[@]+"${user_args[@]}"} "${mounts[@]}" "${env_args[@]}" --add-host=host.docker.internal:host-gateway ${PI_RUN_DOCKER_ARGS:-} \
  --entrypoint /home/node/dev/pecker-nest/docker/task.sh "$image" "$task" \
  >"$log_dir/$run_id.jsonl" 2>"$log_dir/$run_id.stderr.log"
status=$?
set -e

case "$status" in
  0) echo "result: ok" ;;
  2) echo "result: gate red after the run" ;;
  3) echo "result: setup failed" ;;
  *) echo "result: pi failed (exit $status)" ;;
esac
grep -E '^=== (setup|models|gate) exit' "$log_dir/$run_id.stderr.log" | sed 's/^=== /        /' || true
echo "logs:   $log_dir/$run_id.jsonl, $run_id.stderr.log"
echo "changed files:"
git -C "$repo" status --short 2>/dev/null | sed 's/^/  /' || echo "  (not a git repository)"
exit "$status"
