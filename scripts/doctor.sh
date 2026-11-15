#!/usr/bin/env bash
# Tells you whether this machine is ready for nest: tools, links, credentials, models.
#
#   scripts/doctor.sh                 check the machine for interactive sessions
#   scripts/doctor.sh --docker        also check what headless runs need (docker/pi-run.sh): the
#                                     Docker daemon, the image, and the container key as a must
#   scripts/doctor.sh --repo <path>   also check a repository nest is about to work in
#
# Every check prints one line that starts with PASS, WARN or FAIL; a WARN or FAIL line ends with
# the fix. A SKIP line names checks that were left out and how to include them; it counts as
# neither. Exit code 1 when any check failed, else 0. The script only reads: it changes nothing,
# prints no secret and makes no request that costs tokens. One exception to "changes nothing": the
# knowledge-base check connects through Pi, and Pi may refresh its own token for it.
#
# Runs under macOS bash 3.2 and is fine to call from fish.
set -uo pipefail

usage() {
  echo "usage: scripts/doctor.sh [--docker] [--repo <path>]" >&2
  exit 2
}

target_repo=""
check_docker=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker)
      check_docker=1
      shift
      ;;
    --repo)
      [[ $# -ge 2 ]] || usage
      target_repo="$2"
      shift 2
      ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done

nest_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
expected_dir="$HOME/dev/pecker-nest"
image="${PI_IMAGE:-pecker-nest-pi}"
keychain_service="${PI_RUN_KEYCHAIN_SERVICE:-pecker-nest-container-key}"
keychain_user="${USER:-$(id -un)}"

fails=0
warns=0
pass() { echo "PASS  $1"; }
warn() {
  echo "WARN  $1"
  warns=$((warns + 1))
}
fail() {
  echo "FAIL  $1"
  fails=$((fails + 1))
}
skip() { echo "SKIP  $1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# version_cmp A B prints -1, 0 or 1. Compares major.minor.patch; a leading "v" and suffixes such
# as "-beta.1" are ignored.
version_cmp() {
  local a="${1#v}" b="${2#v}" old_ifs="$IFS" i x y
  IFS=.
  # shellcheck disable=SC2206 # split on dots on purpose
  local left=($a) right=($b)
  IFS="$old_ifs"
  for i in 0 1 2; do
    x="${left[$i]:-0}"
    y="${right[$i]:-0}"
    x="${x%%[!0-9]*}"
    y="${y%%[!0-9]*}"
    x="${x:-0}"
    y="${y:-0}"
    if ((10#$x < 10#$y)); then
      echo -1
      return
    fi
    if ((10#$x > 10#$y)); then
      echo 1
      return
    fi
  done
  echo 0
}

# ------------------------------------------------------------------ repository

if [[ "$(cd "$expected_dir" 2>/dev/null && pwd -P)" == "$nest_dir" ]]; then
  pass "repo: pecker-nest is at $expected_dir"
else
  fail "repo: pecker-nest is at $nest_dir, but agent/settings.json loads it from $expected_dir. Fix: move it there, or ln -s \"$nest_dir\" \"$expected_dir\""
fi

agent_changes="$(git -C "$nest_dir" status --short agent/ 2>/dev/null)"
if [[ -z "$agent_changes" ]]; then
  pass "repo: agent/ has no uncommitted changes"
else
  changed="$(echo "$agent_changes" | awk '{ print $NF }' | tr '\n' ' ')"
  warn "repo: uncommitted changes in ${changed% } (Pi writes model switches into the linked settings.json). Fix: git -C $nest_dir checkout agent/settings.json, or commit them if they are the new default"
fi

# ------------------------------------------------------------------ tools

wanted_pi="$(sed -n 's/.*"@earendil-works\/pi-coding-agent": *"\([0-9][^"]*\)".*/\1/p' "$nest_dir/package.json" | tail -1)"
if ! have pi; then
  fail "pi: not found on PATH. Fix: install Pi ${wanted_pi:-} (npm install -g @earendil-works/pi-coding-agent@${wanted_pi:-latest})"
else
  pi_version="$(pi --version 2>/dev/null | tail -1)"
  if [[ -z "$wanted_pi" ]]; then
    warn "pi: version $pi_version, but package.json names no @earendil-works/pi-coding-agent version to compare with. Fix: check devDependencies in $nest_dir/package.json"
  else
    case "$(version_cmp "$pi_version" "$wanted_pi")" in
      0) pass "pi: version $pi_version, as in package.json" ;;
      -1) fail "pi: version $pi_version is older than $wanted_pi in package.json. Fix: pi update" ;;
      *) warn "pi: version $pi_version is newer than $wanted_pi, which the tests ran against. Fix: cd $nest_dir && npm ci && npm run e2e, then raise the version in package.json" ;;
    esac
  fi
fi

if ! have node; then
  fail "node: not found on PATH. Fix: brew install node (22.18 or newer)"
else
  node_version="$(node --version 2>/dev/null)"
  if [[ "$(version_cmp "$node_version" 22.18.0)" == -1 ]]; then
    fail "node: version ${node_version#v} is older than 22.18. Fix: brew upgrade node"
  else
    pass "node: version ${node_version#v} (22.18 or newer)"
  fi
fi

if ! have pnpm; then
  fail "pnpm: not found on PATH. Fix: npm install -g pnpm@10"
else
  pnpm_version="$(pnpm --version 2>/dev/null)"
  case "$pnpm_version" in
    10.*) pass "pnpm: version $pnpm_version (10.x)" ;;
    *) fail "pnpm: version ${pnpm_version:-unknown} is not 10.x. Fix: npm install -g pnpm@10" ;;
  esac
fi

if have uv; then
  pass "uv: $(uv --version 2>/dev/null | head -1)"
else
  fail "uv: not found on PATH. Fix: brew install uv"
fi

# Headless runs in Docker are deferred, so the daemon and the image are checked only on request.
docker_ok=0
if [[ "$check_docker" != 1 ]]; then
  skip "docker: daemon and image not checked; only headless runs (docker/pi-run.sh) need them. Include them: $nest_dir/scripts/doctor.sh --docker"
elif ! have docker; then
  fail "docker: not found on PATH. Fix: install Docker Desktop and start it"
elif docker info >/dev/null 2>&1; then
  docker_ok=1
  pass "docker: the daemon is reachable"
else
  fail "docker: the daemon is not reachable. Fix: start Docker Desktop"
fi

# ------------------------------------------------------------------ links

if link_report="$("$nest_dir/scripts/link.sh" --check --claude 2>&1)"; then
  pass "links: agent files and Claude Code skills are linked (scripts/link.sh --check --claude)"
else
  missing="$(echo "$link_report" | grep -c '^missing')"
  if [[ "$missing" -gt 0 ]]; then
    fail "links: $missing link(s) missing or pointing elsewhere. Fix: $nest_dir/scripts/link.sh --claude"
  else
    fail "links: scripts/link.sh --check --claude failed ($(echo "$link_report" | head -1)). Fix: $nest_dir/scripts/link.sh --claude"
  fi
fi

# ------------------------------------------------------------------ credentials

if have pi; then
  # Without the variable, so that an exported key does not hide a missing login.
  if env -u OPENROUTER_API_KEY pi auth check --provider openrouter >/dev/null 2>&1; then
    pass "credential: Pi is logged in to OpenRouter (pi auth check --provider openrouter)"
  elif [[ -n "${OPENROUTER_API_KEY:-}" ]] && pi auth check --provider openrouter >/dev/null 2>&1; then
    warn "credential: Pi reaches OpenRouter only through the exported OPENROUTER_API_KEY. Fix: start pi, run /login openrouter, then remove the export"
  else
    fail "credential: Pi has no OpenRouter credential. Fix: start pi and run /login openrouter"
  fi
else
  fail "credential: not checked, pi is missing. Fix: install Pi, then start pi and run /login openrouter"
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  pass "credential: OPENROUTER_API_KEY is not exported"
else
  warn "credential: OPENROUTER_API_KEY is exported; Pi uses the login and pi-run.sh ignores the variable, so it only risks spending the key without a limit elsewhere. Fix: remove the export from your shell config (bash/zsh: unset OPENROUTER_API_KEY; fish: set -e OPENROUTER_API_KEY)"
fi

# The same item serves docker/pi-run.sh and the live probe (scripts/probe-openrouter.ts). Without
# --docker only the probe needs it, and the probe also takes PROBE_OPENROUTER_API_KEY: a warning.
if have security; then
  # Existence only: without -w the password is neither read nor printed.
  if security find-generic-password -a "$keychain_user" -s "$keychain_service" >/dev/null 2>&1; then
    pass "credential: Keychain item $keychain_service exists (the key for the live probe and for docker/pi-run.sh)"
  elif [[ "$check_docker" == 1 ]]; then
    fail "credential: Keychain item $keychain_service is missing, so docker/pi-run.sh has no container key. Fix: security add-generic-password -U -a \"$keychain_user\" -s $keychain_service -w"
  else
    warn "credential: Keychain item $keychain_service is missing; the live probe (scripts/probe-openrouter.ts) reads it, and so will docker/pi-run.sh. Fix: security add-generic-password -U -a \"$keychain_user\" -s $keychain_service -w"
  fi
elif [[ "$check_docker" == 1 ]]; then
  warn "credential: no Keychain on this system (no security tool), so the container key is not stored. Fix: set PI_RUN_OPENROUTER_API_KEY for each docker/pi-run.sh call"
else
  warn "credential: no Keychain on this system (no security tool), so the key for the live probe is not stored. Fix: set PROBE_OPENROUTER_API_KEY for each scripts/probe-openrouter.ts call"
fi

# ------------------------------------------------------------------ knowledge base

# Never a FAIL: the knowledge base (grove) runs only while David has started it, and sessions work
# without it. `pi mcp list` connects with Pi's stored sign-in, so the answer is the one a session gets.
grove_dir="${GROVE_DIR:-$HOME/dev/pecker-grove}"
if ! have pi || ! have node; then
  warn "knowledge base: not checked, pi or node is missing. Fix: install them, then run this again"
else
  kb="$(pi mcp list --json 2>/dev/null | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      try {
        const kb = JSON.parse(text).servers.find((server) => server.name === "kb");
        console.log(kb ? [kb.enabled === false ? "disabled" : kb.state, (kb.tools || []).length, kb.transport].join("|") : "missing");
      } catch {
        console.log("unreadable");
      }
    });' 2>/dev/null)"
  kb_state="${kb%%|*}"
  kb_rest="${kb#*|}"
  kb_tools="${kb_rest%%|*}"
  kb_url="${kb_rest#*|}"
  case "$kb_state" in
    connected) pass "knowledge base: kb answers at $kb_url and Pi is signed in ($kb_tools tools)" ;;
    needs-auth) warn "knowledge base: kb answers at $kb_url, but Pi is not signed in; sessions work without it. Fix: pi mcp login kb" ;;
    disabled) warn "knowledge base: kb is switched off in Pi's mcp.json; sessions work without it. Fix: in pi, /mcp, select kb, Enable" ;;
    missing) warn "knowledge base: Pi's mcp.json has no kb server; sessions work without it. Fix: $nest_dir/scripts/link.sh" ;;
    failed | connecting | disconnected | closed) warn "knowledge base: kb does not answer at $kb_url (grove is not running); sessions work without it. Fix: cd $grove_dir && pnpm stack:up && pnpm dev, then /mcp reconnect kb in a Pi session that is already open" ;;
    *) warn "knowledge base: pi mcp list --json gave no readable answer. Fix: run pi mcp list and read its error" ;;
  esac
fi

# ------------------------------------------------------------------ models

logic="$nest_dir/extensions/lib/router-logic.ts"
model_id() { sed -n "s/^export const $1 = \"\\([^\"]*\\)\";.*/\\1/p" "$logic" | head -1; }
if have pi; then
  model_list="$(pi --list-models 2>/dev/null)"
  for name in FLASH GLM KIMI; do
    id="$(model_id "$name")"
    if [[ -z "$id" ]]; then
      fail "model: no $name model ID found in extensions/lib/router-logic.ts. Fix: check the constants at the top of $logic"
    elif echo "$model_list" | awk -v id="$id" '$1 == "openrouter" && $2 == id { found = 1 } END { exit found ? 0 : 1 }'; then
      pass "model: openrouter/$id is in pi --list-models"
    elif [[ "$name" == KIMI ]]; then
      warn "model: openrouter/$id is not in pi --list-models; /strong kimi falls back to GLM 5.3. Fix: pi update --models; if it stays missing, your OpenRouter privacy settings leave it no provider (node scripts/probe-openrouter.ts shows which)"
    else
      fail "model: openrouter/$id is not in pi --list-models. Fix: pi update --models; if it stays missing, your OpenRouter privacy settings leave it no provider (node scripts/probe-openrouter.ts shows which)"
    fi
  done
else
  fail "model: not checked, pi is missing. Fix: install Pi, then run this again"
fi

# ------------------------------------------------------------------ image

head_commit="$(git -C "$nest_dir" rev-parse HEAD 2>/dev/null)"
if [[ "$check_docker" != 1 ]]; then
  : # Left out together with the daemon check above; the SKIP line there covers both.
elif [[ "$docker_ok" != 1 ]]; then
  fail "image: not checked, Docker is not reachable. Fix: start Docker Desktop, then $nest_dir/scripts/build-image.sh"
elif ! labels="$(docker image inspect --format '{{ index .Config.Labels "nest.commit" }}|{{ index .Config.Labels "nest.dirty" }}' "$image" 2>/dev/null)"; then
  fail "image: $image does not exist. Fix: $nest_dir/scripts/build-image.sh"
else
  image_commit="${labels%%|*}"
  image_dirty="${labels#*|}"
  if [[ -z "$image_commit" || "$image_commit" == "<no value>" ]]; then
    fail "image: $image has no nest.commit label, so its age is unknown. Fix: $nest_dir/scripts/build-image.sh"
  elif [[ "$image_commit" != "$head_commit" ]]; then
    fail "image: $image was built from ${image_commit:0:7}, the repo is at ${head_commit:0:7}. Fix: $nest_dir/scripts/build-image.sh"
  elif [[ "$image_dirty" != 0 ]]; then
    fail "image: $image was built with uncommitted changes in the repo (nest.dirty=$image_dirty). Fix: commit or undo them, then $nest_dir/scripts/build-image.sh"
  else
    pass "image: $image was built from HEAD (${head_commit:0:7})"
  fi
fi

# ------------------------------------------------------------------ target repository

json_ok() {
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" >/dev/null 2>&1
}
check_json() {
  local label="$1" file="$2" fix="$3"
  if [[ ! -f "$file" ]]; then
    fail "target: $label is missing. Fix: $fix"
  elif ! have node; then
    fail "target: $label exists, but node is missing to check that it is valid JSON. Fix: install node, then run this again"
  elif json_ok "$file"; then
    pass "target: $label exists and is valid JSON"
  else
    fail "target: $label is not valid JSON. Fix: correct $file (the safety gate blocks every write and command while it is broken)"
  fi
}

if [[ -n "$target_repo" ]]; then
  if [[ ! -d "$target_repo" ]]; then
    fail "target: $target_repo is not a directory. Fix: pass the repository nest will work in to --repo"
  else
    target="$(cd "$target_repo" && pwd -P)"
    check_json ".pi/protect.json" "$target/.pi/protect.json" "create $target/.pi/protect.json (example: $nest_dir/templates/undertext/protect.json)"
    check_json ".pi/gate.json" "$target/.pi/gate.json" "cp $nest_dir/templates/gate.ts.json $target/.pi/gate.json (or gate.py.json) and set its command"
    if [[ ! -f "$target/AGENTS.md" ]]; then
      fail "target: AGENTS.md is missing. Fix: cp $nest_dir/templates/AGENTS.ts.md $target/AGENTS.md (or AGENTS.py.md) and fill it in"
    else
      todos="$(grep -c 'TODO' "$target/AGENTS.md")"
      if [[ "$todos" -gt 0 ]]; then
        fail "target: AGENTS.md still has $todos line(s) with TODO. Fix: fill in the open sections of $target/AGENTS.md"
      else
        pass "target: AGENTS.md exists and has no TODO left"
      fi
    fi
  fi
fi

echo "doctor: $fails failed, $warns warning(s)"
[[ "$fails" -eq 0 ]]
