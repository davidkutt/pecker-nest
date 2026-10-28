#!/usr/bin/env bash
# Runs one headless Pi task in the pecker-nest container against a repository.
#
#   docker/pi-run.sh [-C <repo>] "<task>"
#
# Only the repository (default: the current directory) is mounted, at /workspace. Inside one
# container, docker/task.sh installs dependencies (pnpm-lock.yaml → pnpm install, uv.lock →
# uv sync, or PI_RUN_SETUP), runs Pi with --mode json --approve, and then runs the gate command
# from .pi/gate.json once more as an independent check.
#
# Environment:
#   ANTHROPIC_API_KEY  required, forwarded into the container
#   PI_IMAGE           image name (default: pecker-nest-pi)
#   PI_RUN_LOG_DIR     where logs go (default: <pecker-nest>/runs)
#   PI_RUN_SETUP       setup command instead of the lockfile default; empty skips setup
#   PI_RUN_PASS_ENV    space-separated extra variable names to forward, e.g. "KB_TOKEN"
#   PI_RUN_DOCKER_ARGS extra `docker run` arguments, word-split, e.g. "--network host"
#
# Logs per run: <id>.jsonl (Pi event stream) and <id>.stderr.log (Pi diagnostics plus the setup
# and gate output between `=== setup` / `=== gate` marker lines).
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
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"

image="${PI_IMAGE:-pecker-nest-pi}"
nest_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
log_dir="${PI_RUN_LOG_DIR:-$nest_dir/runs}"
run_id="$(date +%Y%m%d-%H%M%S)-$(basename "$repo")"
mkdir -p "$log_dir"

env_args=(-e ANTHROPIC_API_KEY)
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
# shellcheck disable=SC2086 # PI_RUN_DOCKER_ARGS is split into words on purpose.
docker run --rm ${user_args[@]+"${user_args[@]}"} "${mounts[@]}" "${env_args[@]}" --add-host=host.docker.internal:host-gateway ${PI_RUN_DOCKER_ARGS:-} \
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
grep -E '^=== (setup|gate) exit' "$log_dir/$run_id.stderr.log" | sed 's/^=== /        /' || true
echo "logs:   $log_dir/$run_id.jsonl, $run_id.stderr.log"
echo "changed files:"
git -C "$repo" status --short 2>/dev/null | sed 's/^/  /' || echo "  (not a git repository)"
exit "$status"
