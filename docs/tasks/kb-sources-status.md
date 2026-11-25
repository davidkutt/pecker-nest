# Task: show the state of the knowledge base's sources (doctor line, `index_status`, `/kb-status`)

Written by the cross-project planning chat on 25 November 2026. Claude Code does this task; nest is never
built with nest. Part 1 needs nothing from grove. Part 2 uses the MCP tool `index_status` from pecker-grove's
task `docs/tasks/sources-status.md` (davidkutt/pecker-grove#82): this pull request stays a draft until
that one is merged.

Read first: `AGENTS.md`, `docs/RUNBOOK.md` (M3, tests 6 and 7), `docs/research/grove-kb-auth.md` (P5),
`scripts/doctor.sh` (section "knowledge base"), `test/doctor.test.ts` (the `STUB_*` pattern),
`agent/mcp.json`, `agent/APPEND_SYSTEM.md` ("Knowledge base first"), `skills/best-practices/SKILL.md`,
`prompts/review.md` (prompt format), and in pecker-grove `docs/tasks/sources-status.md` (contract) and
`apps/api/src/documents/sources.service.ts` (how labels and folders come from `NOTES_DIR` and
`NOTES_SOURCES`).

## Problem

David never knows which state of his notes repositories nest sees through `kb`: an unmerged pull request, a checkout on a feature branch or behind `origin`, uncommitted notes, a
note grove skipped, a failed ingest. Grove will report what it has indexed (commit, pull, skipped, failed).
The other half has to come from the host, where git, `gh` and the network are available: what *should* be
indexed.

## Part 1: the host side (`scripts/kb-sources.sh` and a doctor line)

1. **`scripts/kb-sources.sh`** (bash, like `doctor.sh`):
   - Finds the folders grove syncs from `${GROVE_DIR:-$HOME/dev/pecker-grove}/.env`. It reads **only** the
     lines `NOTES_DIR=` and `NOTES_SOURCES=` (strip quotes) and never sources the file, prints or keeps any
     other key: the file holds secrets. Labels as grove makes them: `NOTES_SOURCES` empty → label `notes`
     for `NOTES_DIR`; else each `label=folder` pair, folder inside `NOTES_DIR`.
   - Per folder that has a `.git`:
     - branch (`git symbolic-ref --short -q HEAD`) and short commit;
     - uncommitted or untracked notes: `git status --porcelain -- '*.md'`. Grove indexes the working tree,
       so these are in the index but in no commit;
     - the remote's default branch and its commit with `git ls-remote --symref origin HEAD`. That is
       read-only: no fetch, nothing written into the checkout. Time limit 10 seconds; offline → "remote
       not checked";
     - open pull requests: owner and repository from the `origin` URL, then
       `gh pr list --repo <owner/repo> --state open --json number,title,headRefName`; `gh` missing or not
       signed in → "pull requests not checked".
   - Output: one line per label for people, `--json` for the prompt in part 2. Exit code 0 except for a
     usage error: it reports and never fails.
2. **`doctor.sh`:** after the "knowledge base" line, one line `kb sources:` per label, built from
   `kb-sources.sh --json`.
   - `PASS` when the checkout is on the default branch, at the remote's commit, clean, with no open pull
     requests.
   - Otherwise `WARN` with the fix: `git -C <dir> switch <default>`, `git -C <dir> pull --ff-only` (Mode B
     never pulls by itself, see grove's `startup.md` §4), commit or remove the listed notes, or the numbers
     of the open pull requests to merge.
   - `WARN … not checked` when there is no `.env`, no `NOTES_DIR` or no checkout.
   - **Never `FAIL`**, the same rule as the knowledge base line. Works while grove is down.
3. **Tests** (`test/doctor.test.ts`, stub `git` and `gh` like the existing stubs):
   - clean → `PASS`; not on the default branch; behind or diverged from the remote; uncommitted note;
     open pull requests; offline; `gh` missing;
   - no `.env`, `.env` without `NOTES_DIR`, `NOTES_SOURCES` with two labels;
   - **canary:** a `.env` with `OPENROUTER_API_KEY=canary-…` and other keys; the canary appears in no output
     of `kb-sources.sh` (human and `--json`) or `doctor.sh`;
   - `kb-sources.sh --json` has a stable shape (one test pins it; part 2's prompt relies on it).

## Part 2: the grove side in sessions (after grove's pull request is merged)

4. **`agent/mcp.json`:** `toolExposure` gains `"index_status": "direct"`. It has no parameters and helps
   exactly when a search comes back empty.
5. **`agent/APPEND_SYSTEM.md`**, "Knowledge base first": one new bullet. Before saying that the knowledge
   base has nothing on a topic, call `mcp__kb__index_status`. If the folder is behind, excluded, or has
   skipped or failed notes, say that instead.
6. **`skills/best-practices/SKILL.md`:** a table row for `mcp__kb__index_status` (declared directly).
   Step 2 ("Stop after two empty searches …") checks `index_status` before it concludes "nothing on it".
7. **`prompts/kb-status.md`** (`/kb-status`, format as in `prompts/review.md`), read-only:
   - run `~/dev/pecker-nest/scripts/kb-sources.sh --json` and call `mcp__kb__index_status`;
   - per label, one compact block with: commit grove read · checkout HEAD · remote default branch;
     grove's pull state; synced at; skipped notes with reasons; failed documents; in progress; open pull
     requests; grove's `excluded` paths for the label, so David can check them against his own list;
   - then the fixes in order: merge pull requests → pull → *Sync notes and URLs* in grove (or wait for the
     interval, shown by `intervalMinutes`) → fix skipped notes;
   - never merge, pull, sync or edit anything itself. With grove down: the host side only, and say so.
8. **Subagents stay without `kb` tools.** P5 still holds: a subagent with an `mcp:kb/…` tool does not
   start while grove is down.
9. **Tests:** a unit test on the real `agent/mcp.json`: `index_status` is `direct`, `ingest_url` stays
   hidden, and `containerMcpConfig` still disables `kb`. Every e2e scenario passes with `kb` registered
   and no server running.

## Docs (with the part they belong to)

- `docs/RUNBOOK.md` M3 (German, like the rest): a short section "Stand der Knowledge Base prüfen":
  `scripts/doctor.sh` for the host side, `/kb-status` in a session for both sides. Commands bash first,
  then fish; where identical, once with that note. Tests 6 and 7 keep their meaning.
- `docs/v1-notes.md`: an entry "Update 25.11.2026" with what changed and why; the system prompt gains
  `index_status`, so field notes before and after differ in configuration.
- `docs/SETUP.md`, troubleshooting: one row for `kb sources:` warnings.

## Rules

- The branch `feat/kb-sources-status` and its draft pull request already exist, with this brief as the first
  commit. Build both parts there. It stays a draft until davidkutt/pecker-grove#82 is merged, and its
  description says so. If David wants part 1 sooner, he says so; then part 1 moves to its own pull request.
- No secret in the repository, in output or in tests (the canary test guards `.env`).
- `kb-sources.sh` and `/kb-status` change nothing in a notes checkout: no fetch, pull, switch or commit.
- Change nothing in pecker-grove or the notes repositories.
- This repository is public: no name, path, label or content of a private notes repository in code,
  tests or docs. Fixtures use made-up labels and paths.
- `npm run check` and `npm run e2e` pass before the pull request is opened. No paid calls.

## Acceptance checks

- [ ] `doctor.sh` shows one `kb sources:` line per label and never fails because of it.
- [ ] Not on the default branch, behind the remote, uncommitted notes and open pull requests each give a `WARN` with the fix (tests).
- [ ] No value from grove's `.env` other than `NOTES_DIR` and `NOTES_SOURCES` appears in any output (canary test).
- [ ] `kb-sources.sh` reads the remote with `ls-remote` only; nothing is written to a checkout.
- [ ] `index_status` is `direct` in `agent/mcp.json`; the container still disables `kb` (unit test).
- [ ] "Knowledge base first" and `best-practices` check `index_status` before "nothing on it".
- [ ] `/kb-status` puts grove's state next to the host's per label and changes nothing.
- [ ] Runbook M3, `v1-notes.md` and `SETUP.md` updated; tests 6 and 7 unchanged in meaning.

## Out of scope

- Any change in grove or the notes repositories; pulling or syncing automatically.
- `kb` tools for subagents; auto-retrieval; the knowledge base in container runs.

## David's part

1. Review; merge only after davidkutt/pecker-grove#82 is merged and its hand check passed. Say so if part 1
   should go in earlier.
2. Merge between two nest sessions, not while a field note is open: part 2 changes the configuration under
   test.
3. Check on the Mac: `~/dev/pecker-nest/scripts/doctor.sh` shows the `kb sources:` lines (same in bash and
   fish); with grove running, `/kb-status` in Pi shows both sides.

## Pull request

Title `feat(kb): show the state of the knowledge base's sources`, on the existing branch and draft pull
request. Replace its description: what each part does, what was tested without grove, what blocks part 2,
and the merge conditions from "David's part". Never merge it yourself.
