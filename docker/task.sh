#!/usr/bin/env bash
# In-container runner used by docker/pi-run.sh: install dependencies, run Pi headless, run the
# gate once more as an independent check.
#
#   task.sh "<task>"
#
# stdout carries only Pi's JSONL event stream. Setup and gate output go to stderr between
# `=== setup`/`=== gate` marker lines, which pi-run.sh stores as <id>.stderr.log.
# Exit code: Pi's exit code if it failed, 3 if setup failed, 2 if the gate is red, else 0.
set -uo pipefail

task="$1"
cd /workspace

# Dependencies live in the container (UV_PROJECT_ENVIRONMENT, masked node_modules), so the
# host's .venv and node_modules are neither used nor modified.
setup="${PI_RUN_SETUP-}"
if [[ -z "${PI_RUN_SETUP+set}" ]]; then
  if [[ -f pnpm-lock.yaml ]]; then setup="pnpm install --frozen-lockfile"
  elif [[ -f uv.lock ]]; then setup="uv sync --frozen"
  fi
fi
if [[ -n "$setup" ]]; then
  echo "=== setup: $setup" >&2
  bash -c "$setup" >&2
  setup_status=$?
  echo "=== setup exit: $setup_status" >&2
  [[ $setup_status -eq 0 ]] || exit 3
fi

pi --mode json --approve --session-dir /sessions "$task"
pi_status=$?

gate_status=0
if [[ -f .pi/gate.json ]]; then
  command="$(node -e 'console.log(require("/workspace/.pi/gate.json").command)')"
  echo "=== gate: $command" >&2
  bash -c "$command" >&2
  gate_status=$?
  echo "=== gate exit: $gate_status" >&2
fi

if [[ $pi_status -ne 0 ]]; then exit "$pi_status"; fi
if [[ $gate_status -ne 0 ]]; then exit 2; fi
exit 0
