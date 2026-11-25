#!/usr/bin/env bash
# Shows which state of David's notes the knowledge base (pecker-grove) should be indexing: per notes
# folder grove syncs from, the checkout's branch and commit, the remote's default branch and its
# commit, uncommitted notes and open pull requests. What grove has indexed is grove's MCP tool
# `index_status`; /kb-status puts both side by side.
#
#   scripts/kb-sources.sh           one line per label, for people
#   scripts/kb-sources.sh --json    the same as JSON (doctor.sh and /kb-status read it)
#
# The folders come from ${GROVE_DIR:-~/dev/pecker-grove}/.env. Of that file only the lines NOTES_DIR=
# and NOTES_SOURCES= are read: it is never sourced, and no other key is printed or kept, because the
# file holds secrets. Labels are grove's: without NOTES_SOURCES the label `notes` for NOTES_DIR, else
# one label per `label=folder` pair (comma-separated), the folder inside NOTES_DIR.
#
# It changes nothing in a checkout: no fetch, pull, switch or commit; `git status` runs without
# optional locks, so it does not even refresh the index. The remote is read with
# `git ls-remote --symref origin HEAD` and pull requests with `gh pr list`, each stopped after
# KB_SOURCES_TIMEOUT seconds (default 10). An origin URL is never printed, only owner/repo from it,
# since it can carry a token. Exit code 0 except for a usage error (2): it reports and never fails.
#
# Runs under macOS bash 3.2 and is fine to call from fish.
set -uo pipefail

usage() {
  echo "usage: scripts/kb-sources.sh [--json]" >&2
  exit 2
}

json=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      json=1
      shift
      ;;
    *) usage ;;
  esac
done

grove_dir="${GROVE_DIR:-$HOME/dev/pecker-grove}"
grove_dir="${grove_dir%/}"
env_file="$grove_dir/.env"
timeout="${KB_SOURCES_TIMEOUT:-10}"
[[ "$timeout" =~ ^[0-9]+$ && "$timeout" -gt 0 ]] || timeout=10

# Read-only git: no index refresh, no prompt, and nothing from the caller's environment that points
# git at another repository.
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY

have() { command -v "$1" >/dev/null 2>&1; }

# limited <command...>: runs the command with stdin from /dev/null and stops it after $timeout
# seconds; status 124 when it ran out of time. macOS has no timeout(1).
limited() {
  local ticks=0 pid
  "$@" </dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$ticks" -ge $((timeout * 10)) ]]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid"
}

# env_value KEY: the value of KEY= in grove's .env (last one wins), quotes and a trailing comment
# stripped. grep hands over only the lines of that key.
env_value() {
  local line value
  [[ -r "$env_file" ]] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$env_file" 2>/dev/null | tail -1)"
  [[ -n "$line" ]] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*)
      value="${value#\"}"
      value="${value%%\"*}"
      ;;
    \'*)
      value="${value#\'}"
      value="${value%%\'*}"
      ;;
    *)
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

# A path from grove's .env: ~/ is the home directory, a relative path lies in grove's directory.
resolve_path() {
  local path="$1"
  case "$path" in
    "~") path="$HOME" ;;
    "~/"*) path="$HOME/${path#\~/}" ;;
    /*) ;;
    *) path="$grove_dir/$path" ;;
  esac
  while [[ "$path" == */ && "$path" != / ]]; do path="${path%/}"; done
  printf '%s' "$path"
}

# json_str VALUE: VALUE as a JSON string; control characters become spaces or are dropped.
json_str() {
  case "$1" in
    *[\"\\]* | *[[:cntrl:]]*)
      printf '"%s"' "$(printf '%s' "$1" | tr '\t\n\r' '   ' | tr -d '\000-\037' | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
      ;;
    *) printf '"%s"' "$1" ;;
  esac
}
json_or_null() { if [[ -n "$1" ]]; then json_str "$1"; else printf 'null'; fi; }
# json_list ITEM...: a JSON array of strings.
json_list() {
  local first=1 item
  printf '['
  for item in "$@"; do
    [[ "$first" == 1 ]] || printf ','
    first=0
    json_str "$item"
  done
  printf ']'
}

# "a, b, c" for up to five items, then "and N more".
short_list() {
  local count=$# shown="" item i=0
  for item in "$@"; do
    i=$((i + 1))
    [[ "$i" -le 5 ]] || break
    shown="${shown:+$shown, }$item"
  done
  [[ "$count" -gt 5 ]] && shown="$shown and $((count - 5)) more"
  printf '%s' "$shown"
}
plural() { if [[ "$1" -eq 1 ]]; then printf '%s %s' "$1" "$2"; else printf '%s %ss' "$1" "$2"; fi; }

# owner/repo from a GitHub remote URL (host/owner/repo for another host); nothing for anything else.
# The user and password part of an https URL are dropped, never printed.
github_repo() {
  local url="$1" host path
  case "$url" in
    https://* | http://* | ssh://*)
      url="${url#*://}"
      host="${url%%/*}"
      path="${url#*/}"
      host="${host##*@}"
      host="${host%%:*}"
      ;;
    *@*:*)
      url="${url#*@}"
      host="${url%%:*}"
      path="${url#*:}"
      ;;
    *) return 1 ;;
  esac
  path="${path%/}"
  path="${path%.git}"
  [[ -n "$host" && "$path" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  if [[ "$host" == github.com ]]; then printf '%s' "$path"; else printf '%s/%s' "$host" "$path"; fi
}

# ------------------------------------------------------------------ the sources from grove's .env

top_problem=""
top_fix=""
notes_dir=""
labels=()
dirs=()

if [[ ! -f "$env_file" ]]; then
  top_problem="not checked, there is no $env_file"
  top_fix="if grove lives elsewhere, name it in GROVE_DIR; else create grove's .env with NOTES_DIR (grove's docs/setup/startup.md)"
elif [[ ! -r "$env_file" ]]; then
  top_problem="not checked, $env_file is not readable"
  top_fix="chmod u+r $env_file"
else
  raw_dir="$(env_value NOTES_DIR)"
  raw_sources="$(env_value NOTES_SOURCES)"
  if [[ -z "$raw_dir" ]]; then
    top_problem="not checked, $env_file sets no NOTES_DIR"
    top_fix="set NOTES_DIR in $env_file to the folder grove syncs notes from"
  else
    notes_dir="$(resolve_path "$raw_dir")"
    if [[ -z "$raw_sources" ]]; then
      labels=(notes)
      dirs=("$notes_dir")
    else
      old_ifs="$IFS"
      IFS=,
      # shellcheck disable=SC2206 # split on commas on purpose
      pairs=($raw_sources)
      IFS="$old_ifs"
      for pair in ${pairs[@]+"${pairs[@]}"}; do
        pair="${pair#"${pair%%[![:space:]]*}"}"
        pair="${pair%"${pair##*[![:space:]]}"}"
        [[ -n "$pair" ]] || continue
        if [[ "$pair" == *=* ]]; then
          label="${pair%%=*}"
          folder="${pair#*=}"
        else
          label="${pair##*/}"
          folder="$pair"
        fi
        case "$folder" in
          /* | "~" | "~/"*) dir="$(resolve_path "$folder")" ;;
          *) dir="$(resolve_path "$notes_dir/$folder")" ;;
        esac
        labels+=("$label")
        dirs+=("$dir")
      done
      if [[ "${#labels[@]}" -eq 0 ]]; then
        top_problem="not checked, NOTES_SOURCES in $env_file names no label=folder pair"
        top_fix="correct NOTES_SOURCES in $env_file, or leave it empty for the single label notes"
      fi
    fi
  fi
fi

# ------------------------------------------------------------------ one source

# check_source LABEL DIR sets the s_* variables below.
check_source() {
  local label="$1" dir="$2" out line url status number branch title numbers="" note_count pr_count
  s_checked=0 s_branch="" s_commit="" s_head="" s_default="" s_default_from=""
  s_remote_checked=0 s_remote_commit="" s_remote_reason="" s_relation="" s_repo=""
  s_prs_checked=0 s_prs_reason="" s_status=warn
  s_notes=() s_pr_numbers=() s_pr_titles=() s_pr_branches=() s_problems=() s_fixes=()

  if [[ ! -d "$dir" ]]; then
    s_problems=("not checked, the folder does not exist")
    s_fixes=("clone the notes repository there, or correct NOTES_DIR or NOTES_SOURCES in $env_file")
    return
  fi
  if [[ ! -e "$dir/.git" ]]; then
    s_problems=("not checked, the folder is not a git checkout")
    s_fixes=("make it a clone of the notes repository, or correct NOTES_DIR or NOTES_SOURCES in $env_file")
    return
  fi
  s_checked=1

  s_branch="$(git -C "$dir" symbolic-ref --short -q HEAD 2>/dev/null)"
  s_head="$(git -C "$dir" rev-parse -q --verify HEAD 2>/dev/null)"
  s_commit="$(git -C "$dir" rev-parse -q --short HEAD 2>/dev/null)"

  # Notes in the working tree but in no commit: grove indexes them anyway.
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    line="${line:3}"
    s_notes+=("${line##* -> }")
  done < <(git -C "$dir" -c core.quotePath=false status --porcelain --untracked-files=all -- '*.md' 2>/dev/null)

  url="$(git -C "$dir" config --get remote.origin.url 2>/dev/null)"
  if [[ -z "$url" ]]; then
    s_remote_reason="no origin remote"
  else
    out="$(limited git -C "$dir" ls-remote --symref origin HEAD 2>/dev/null)"
    status=$?
    if [[ "$status" -eq 124 ]]; then
      s_remote_reason="no answer within ${timeout}s"
    elif [[ "$status" -ne 0 ]]; then
      s_remote_reason="unreachable (offline, or no access)"
    else
      while IFS= read -r line; do
        case "$line" in
          "ref: refs/heads/"*) line="${line#ref: refs/heads/}" && s_default="${line%%[[:space:]]*}" ;;
          *[[:space:]]HEAD) s_remote_commit="${line%%[[:space:]]*}" ;;
        esac
      done <<<"$out"
      if [[ -n "$s_remote_commit" ]]; then
        s_remote_checked=1
        [[ -n "$s_default" ]] && s_default_from=remote
      else
        s_remote_reason="the remote has no default branch"
      fi
    fi
  fi
  # Offline, the clone still knows the remote's default branch from when it was cloned.
  if [[ -z "$s_default" ]]; then
    s_default="$(git -C "$dir" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null)"
    s_default="${s_default#origin/}"
    [[ -n "$s_default" ]] && s_default_from=clone
  fi

  if [[ "$s_remote_checked" == 1 && -n "$s_head" ]]; then
    if [[ "$s_head" == "$s_remote_commit" ]]; then
      s_relation=same
    elif ! git -C "$dir" cat-file -e "$s_remote_commit^{commit}" 2>/dev/null; then
      s_relation=unfetched
    elif git -C "$dir" merge-base --is-ancestor "$s_head" "$s_remote_commit" 2>/dev/null; then
      s_relation=behind
    elif git -C "$dir" merge-base --is-ancestor "$s_remote_commit" "$s_head" 2>/dev/null; then
      s_relation=ahead
    else
      s_relation=diverged
    fi
  fi

  if [[ -n "$url" ]]; then
    s_repo="$(github_repo "$url")"
  fi
  if [[ -z "$url" ]]; then
    s_prs_reason="no origin remote"
  elif [[ -z "$s_repo" ]]; then
    s_prs_reason="origin is not a GitHub repository"
  elif ! have gh; then
    s_prs_reason="gh is not installed"
  elif ! have node; then
    s_prs_reason="node is missing to read gh's answer"
  else
    out="$(limited gh pr list --repo "$s_repo" --state open --json number,title,headRefName 2>/dev/null)"
    status=$?
    if [[ "$status" -eq 124 ]]; then
      s_prs_reason="gh gave no answer within ${timeout}s"
    elif [[ "$status" -ne 0 ]]; then
      s_prs_reason="gh pr list failed (not signed in, offline, or no access)"
    elif out="$(printf '%s' "$out" | node -e '
        let text = "";
        process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
          const prs = JSON.parse(text);
          if (!Array.isArray(prs)) throw new Error("not a list");
          const clean = (value) => String(value ?? "").replace(/[\t\n\r]/g, " ");
          for (const pr of prs) console.log([Number(pr.number), clean(pr.headRefName), clean(pr.title)].join("\t"));
        });' 2>/dev/null)"; then
      s_prs_checked=1
      while IFS=$'\t' read -r number branch title; do
        [[ "$number" =~ ^[0-9]+$ ]] || continue
        s_pr_numbers+=("$number")
        s_pr_branches+=("$branch")
        s_pr_titles+=("$title")
      done <<<"$out"
    else
      s_prs_reason="gh gave an answer that is not a list of pull requests"
    fi
  fi

  # Problems and their fixes, in the order to do them; every problem has a fix.
  note_count="${#s_notes[@]}"
  pr_count="${#s_pr_numbers[@]}"
  local tagged=()
  for number in ${s_pr_numbers[@]+"${s_pr_numbers[@]}"}; do tagged+=("#$number"); done
  [[ "$pr_count" -gt 0 ]] && numbers="$(short_list "${tagged[@]}")"
  if [[ "$note_count" -gt 0 ]]; then
    s_problems+=("$(plural "$note_count" "uncommitted note") ($(short_list "${s_notes[@]}")), indexed but in no commit")
    s_fixes+=("commit or remove $(short_list "${s_notes[@]}")")
  fi
  if [[ -z "$s_head" ]]; then
    s_problems+=("no commit yet")
    s_fixes+=("commit the notes and push them")
  fi
  if [[ -n "$s_default" && "$s_branch" != "$s_default" ]]; then
    if [[ -z "$s_branch" ]]; then
      s_problems+=("detached HEAD, not on $s_default")
    else
      s_problems+=("on $s_branch, not on $s_default")
    fi
    s_fixes+=("git -C $dir switch $s_default")
  fi
  if [[ "$pr_count" -gt 0 ]]; then
    s_problems+=("$(plural "$pr_count" "open pull request") ($numbers), not on $s_default yet")
  fi
  case "$s_relation" in
    behind) s_problems+=("behind origin/$s_default") ;;
    unfetched) s_problems+=("origin/$s_default has commits this checkout has not fetched") ;;
    ahead) s_problems+=("ahead of origin/$s_default: local commits not on the remote") ;;
    diverged) s_problems+=("diverged from origin/$s_default") ;;
  esac
  if [[ "$pr_count" -gt 0 ]]; then
    s_fixes+=("merge $numbers, then git -C $dir pull --ff-only")
  elif [[ "$s_relation" == behind || "$s_relation" == unfetched ]]; then
    s_fixes+=("git -C $dir pull --ff-only")
  fi
  case "$s_relation" in
    ahead) s_fixes+=("push the local commits or open a pull request for them") ;;
    diverged) s_fixes+=("bring the local commits and origin/$s_default together by hand") ;;
  esac
  if [[ "$s_remote_checked" != 1 ]]; then
    s_problems+=("remote not checked, $s_remote_reason")
    if [[ "$s_remote_reason" == "no origin remote" ]]; then
      s_fixes+=("git -C $dir remote add origin <url of the notes repository>")
    else
      s_fixes+=("run this again when online")
    fi
  fi
  if [[ "$s_prs_checked" != 1 && "$s_prs_reason" != "no origin remote" ]]; then
    s_problems+=("pull requests not checked, $s_prs_reason")
    case "$s_prs_reason" in
      "gh is not installed") s_fixes+=("brew install gh, then gh auth login") ;;
      gh\ pr\ list\ failed*) s_fixes+=("gh auth status shows why; gh auth login if signed out") ;;
      "origin is not a GitHub repository") s_fixes+=("nothing, if the notes live outside GitHub") ;;
      "node is missing"*) s_fixes+=("brew install node") ;;
      *"no answer"*) s_fixes+=("run this again when online") ;;
      *) s_fixes+=("gh pr list --repo $s_repo shows the answer") ;;
    esac
  fi
  [[ "${#s_problems[@]}" -eq 0 ]] && s_status=ok
}

# ------------------------------------------------------------------ output

if [[ "$json" == 1 ]]; then
  printf '{"version":1,"groveDir":%s,"envFile":%s,"env":%s,"notesDir":%s,' \
    "$(json_str "$grove_dir")" "$(json_str "$env_file")" "$(json_str "$([[ -f "$env_file" ]] && echo found || echo missing)")" "$(json_or_null "$notes_dir")"
  if [[ -n "$top_problem" ]]; then
    printf '"status":"warn","problems":%s,"fixes":%s,"sources":[]}\n' "$(json_list "$top_problem")" "$(json_list "$top_fix")"
    exit 0
  fi
  printf '"status":"ok","problems":[],"fixes":[],"sources":['
  for i in "${!labels[@]}"; do
    check_source "${labels[$i]}" "${dirs[$i]}"
    [[ "$i" -eq 0 ]] || printf ','
    printf '{"label":%s,"dir":%s,"checked":%s,' "$(json_str "${labels[$i]}")" "$(json_str "${dirs[$i]}")" "$([[ "$s_checked" == 1 ]] && echo true || echo false)"
    printf '"branch":%s,"commit":%s,"head":%s,' "$(json_or_null "$s_branch")" "$(json_or_null "$s_commit")" "$(json_or_null "$s_head")"
    printf '"defaultBranch":%s,"defaultBranchFrom":%s,' "$(json_or_null "$s_default")" "$(json_or_null "$s_default_from")"
    printf '"remote":{"checked":%s,"commit":%s,"reason":%s},' "$([[ "$s_remote_checked" == 1 ]] && echo true || echo false)" "$(json_or_null "$s_remote_commit")" "$(json_or_null "$s_remote_reason")"
    printf '"relation":%s,' "$(json_or_null "$s_relation")"
    printf '"uncommitted":%s,' "$(json_list ${s_notes[@]+"${s_notes[@]}"})"
    printf '"repo":%s,"pullRequests":{"checked":%s,"open":[' "$(json_or_null "$s_repo")" "$([[ "$s_prs_checked" == 1 ]] && echo true || echo false)"
    for j in ${s_pr_numbers[@]+"${!s_pr_numbers[@]}"}; do
      [[ "$j" -eq 0 ]] || printf ','
      printf '{"number":%s,"title":%s,"branch":%s}' "${s_pr_numbers[$j]}" "$(json_str "${s_pr_titles[$j]}")" "$(json_str "${s_pr_branches[$j]}")"
    done
    printf '],"reason":%s},' "$(json_or_null "$s_prs_reason")"
    printf '"status":%s,"problems":%s,"fixes":%s}' "$(json_str "$s_status")" "$(json_list ${s_problems[@]+"${s_problems[@]}"})" "$(json_list ${s_fixes[@]+"${s_fixes[@]}"})"
  done
  printf ']}\n'
  exit 0
fi

if [[ -n "$top_problem" ]]; then
  echo "warn  sources: $top_problem. Fix: $top_fix"
  exit 0
fi
for i in "${!labels[@]}"; do
  check_source "${labels[$i]}" "${dirs[$i]}"
  label="${labels[$i]}"
  dir="${dirs[$i]}"
  if [[ "$s_status" == ok ]]; then
    echo "ok    $label: $dir on ${s_branch:-detached HEAD} at $s_commit, as on the remote; no uncommitted notes, no open pull requests"
  else
    problems="$(printf '%s; ' "${s_problems[@]}")"
    line="warn  $label: $dir"
    [[ "$s_checked" == 1 ]] && line="$line (${s_branch:-detached HEAD} at ${s_commit:-no commit})"
    line="$line: ${problems%; }"
    if [[ "${#s_fixes[@]}" -gt 0 ]]; then
      fixes="$(printf '%s; ' "${s_fixes[@]}")"
      line="$line. Fix: ${fixes%; }"
    fi
    echo "$line"
  fi
done
exit 0
