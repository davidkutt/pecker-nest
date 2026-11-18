# AGENTS.md

Rules for every agent working on pecker-nest (Pi, Cursor, Claude Code and others). `CLAUDE.md` only points
here. What the repository is and where things live: [README.md](README.md); setup and acceptance tests:
[docs/SETUP.md](docs/SETUP.md) and [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Workflow

- **Pull requests only.** Every change, docs included, goes through a pull request from a new short-lived
  branch. Never push to `main`. Agents never merge, approve, close or comment on pull requests; David
  merges.
- **Commit identity:** `davidkutt <52502283+davidkutt@users.noreply.github.com>`, set per repository with
  `git config user.name davidkutt` and `git config user.email 52502283+davidkutt@users.noreply.github.com`
  (the same in bash and fish). Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- **No destructive git steps without David's direct confirmation:** no force push, `reset --hard`,
  `clean -f`, rebase of pushed commits, history rewrite or branch deletion.
- **Secrets:** never print, paste or commit a secret, token, key or value from `.env`, also not in logs,
  pull request descriptions or chat. The OpenRouter login lives in Pi's own store and the container key in
  the macOS Keychain (`pecker-nest-container-key`); never read them out.
- **This repository is public.** Nothing confidential from David's employer. David stays pseudonymous: call
  him David or `davidkutt`, never by his full name, private email address or other personal details. Field
  notes describe private repositories, so they stay local (`field-notes/` is git-ignored except README and
  TEMPLATE); nothing from them, and no other detail of a private repository, goes into a commit.
- **Commands for David** (README, `docs/`, task briefs, pull request descriptions, chat): David works on
  macOS with fish. Give the bash command first, then the fish form, in blocks labelled `bash` and `fish`
  (fish: `set -x VAR value` instead of `export`, `(cmd)` instead of `$(cmd)`, `; and` / `; or`, no
  heredocs). A command that is the same in both shells is shown once and says so, as in `docs/SETUP.md`.
- **Pull request description:** what changed, the checks you ran with their results, what you did not test,
  and what stays open.

## Checks before a pull request

Both must pass; neither spends tokens. `npm run e2e` starts the installed Pi against a scripted OpenRouter
mock and needs the internet once per run to install pi-subagents into a temporary agent directory.

```bash
npm ci && npm run check && npm run e2e      # check = typecheck + unit tests
PI_BIN=node_modules/.bin/pi npm run e2e     # when pi is not on PATH
```

```fish
npm ci; and npm run check; and npm run e2e  # check = typecheck + unit tests
env PI_BIN=node_modules/.bin/pi npm run e2e # when pi is not on PATH
```

A change to `docker/` or the image also needs `scripts/build-image.sh && npm run e2e:docker` (Docker
required; if it is not available, say so in the pull request).

## Repository rules

- **nest is never built with nest.** Changes to this repository are made in Claude Code or Cursor. In Pi,
  the safety gate counts this checkout, Pi's agent directory, Claude Code's config directory and
  `~/.agents` as the harness and refuses writes to them.
- **One rule set.** Safety, protection, gate and weakened-test decisions live once, as pure functions in
  `extensions/lib/` with unit tests in `test/`. Pi's extensions and the Cursor adapter only translate
  payloads and results. Never weaken the safety gate, the harness protection or the weakened-test check
  to make something pass; a change to `extensions/lib/` keeps nest's behaviour and tests unless the task
  says otherwise.
- **Logs and reports hold counts and paths only:** never file contents, prompts, command output or keys
  (session report, provider log, hooks, Cursor capture, `doctor.sh`).
- **No money spent.** Tests run against the mock. `scripts/probe-openrouter.ts` and anything else that sends
  real requests to OpenRouter are David's to run.
- **Models and routing are David's decisions** (RUNBOOK, "Entschieden"): zero data retention only
  (`zdr`, `data_collection: deny` in `agent/models.json`), no `order` or `sort` entries in
  `openRouterRouting`, and no change to models, thinking levels or router thresholds unless the task asks
  for it.
- **No new third-party code** (npm dependency, Pi package, plugin, skill or MCP server) without David.
  `extensions/vendor/` stays an unchanged copy of Pi's examples. Pinned versions (pi-subagents in
  `agent/settings.json`, Pi in `package.json`) change only with `npm run e2e` green.
- **No machine-specific path in the repository.** The checkout lives at `~/dev/pecker-nest`; paths under
  the home directory are built at link time (`scripts/link.sh`). Shell scripts run under macOS bash 3.2.
- **Docs:** `README.md` is English and keeps its layout tree in sync. `docs/SETUP.md`, `docs/RUNBOOK.md`
  and `docs/v1-notes.md` are German, in the existing voice; `docs/tasks/` and `docs/research/` are English.
  Findings and deviations go into `docs/v1-notes.md` as a dated "Update" section with "Getestet" and
  "Nicht getestet"; decisions into the "Entschieden" table of `docs/RUNBOOK.md`. A task brief from the
  planning chat is committed as `docs/tasks/<name>.md` in the first commit of its pull request.
