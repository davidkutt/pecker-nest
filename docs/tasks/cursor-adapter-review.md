# Task: follow-up to the review of the Cursor adapter (pecker-nest #13)

Written by the planning chat on 18 November 2026 in German against `main` at `c523da9` (merge of #13); committed here in English, as AGENTS.md asks for `docs/tasks/`. Branch `fix/cursor-adapter-review`. Everything goes into one pull request.

## Rules

- Commit only as `davidkutt <52502283+davidkutt@users.noreply.github.com>` (`git config user.name davidkutt`, `git config user.email 52502283+davidkutt@users.noreply.github.com`).
- You may push and open the pull request. Never merge, approve, close or comment.
- Print no secrets and no `.env` values.
- Before the pull request, `npm ci`, `npm run check` and `npm run e2e` must be green. Attach the summaries of their output to the pull request description.
- Shell scripts must run under macOS bash 3.2. No GNU-only flags.
- In docs, the bash command always comes first, then the fish command.
- If a topic depends on David's decision, do not build it; enter it in `docs/v1-notes.md`.

## 1. Upper and lower case on macOS (blocker)

APFS does not distinguish upper and lower case by default. The harness and path rules compare case-sensitively. For `canonicalPath` this is down to `realpathSync` from JS: it does not correct the spelling.

So these paths get through:

- `~/.CURSOR/hooks.json`
- `<repo>/.Cursor/hooks.json`, as a project hook outside the sandbox
- `~/DEV/PECKER-NEST/...`
- `.PI/gate.json` and `.ENV`

On Linux, `writeVerdict("/…/repo/.Cursor/hooks.json")` shows ALLOW today.

To change:

- `extensions/lib/canonical-path.ts`: use `realpathSync.native` and fall back to `realpathSync` on an error. On macOS this corrects the spelling of the existing parts of the path.
- `extensions/lib/safety-rules.ts`: new optional field `PathPolicy.caseInsensitive`, which Cursor sets to `process.platform === "darwin"`. When it is set, these places compare without regard to case:
  - `harnessReason`: the directory prefixes, the exceptions and the `harnessFiles` globs (regex with flag `i`)
  - `builtInPathReason`: `.pi`, `.git`, `.env*` and the secret names
  - the write and read globs from `.pi/protect.json`
- Pi gets the field on macOS as well (`extensions/safety-gate.ts`).
- The same applies to `cursor/lib/policy.ts` and `harnessScriptReason`.
- Tests in `test/harness.test.ts` and `test/cursor-adapter.test.ts`, with `caseInsensitive: true` injected so that they also run under Linux: `.Cursor/hooks.json`, `~/.CURSOR/hooks.json`, `.PI/gate.json`, `.ENV` and `<NESTDIR in upper case>/x` are denied.
- New hand step 16 in `docs/cursor-handschritte.md`: `Create .Cursor/hooks.json with {}` → denied.

## 2. Shell with combined flags (should-fix)

In `extensions/lib/safety-rules.ts:385`, `args.indexOf("-c")` does not recognise `sh -lc 'git push'`, nor `bash -lc …` and `zsh -ic …`.

To change:

- Look for the first argument that matches `/^-[A-Za-z]*c[A-Za-z]*$/` and check the rest as a command.
- Tests: `sh -lc 'git push'`, `bash -xc "git push"` and `zsh -ic 'rm -rf src'` are denied.

## 3. GitHub writes and git aliases (should-fix)

David's rule: agents never merge, approve, close or comment.

These commands get through today:

- `gh pr merge`, `gh pr review --approve` and `gh api -X POST …/comments`
- `git -c alias.p=push p`, `git send-pack` and `git subtree push`

To change in `extensions/lib/safety-rules.ts`:

- New function `ghReason`, for `program === "gh"`. Deny:
  - `gh pr merge|review|close|comment|reopen|ready|edit`
  - `gh issue close|comment|delete|edit|reopen|transfer|lock`
  - `gh repo delete|archive|rename|edit`
  - `gh release create|delete|edit`
  - `gh workflow run|enable|disable`, `gh run cancel|rerun|delete`
  - `gh secret` and `gh variable` with `set|delete`
  - `gh api` when `-X`/`--method` is given with anything other than `GET`, or when `-f`/`-F`/`--field`/`--raw-field`/`--input` occurs (that makes gh use POST)
- Still allowed: `gh pr create`, `gh pr view|list|diff|checks`, `gh issue view|list` and `gh api` as GET.
- Reason text: "gh … is blocked; the user merges, approves, closes and comments". Add to `ruleOf` in `cursor/lib/log.ts` (`gh-write`) and to the test that pins the mapping.
- `gitReason`:
  - `-c alias.<x>=<…push…>` is denied. It is enough that a `-c alias.` value that sets `push` or `!` is denied.
  - `send-pack` is denied.
  - `subtree` is denied when `push` follows.
- `cursor/user-rule.md`, section Safety: add "Never merge, approve, close or comment on pull requests or issues; the user does that." Adjust `test/cursor-user-rule.test.ts` if needed.
- Tests for all these cases, allowed and denied.

## 4. Gate command with full rights (should-fix)

`cursor/lib/gate.ts:224-228` starts the check command with David's full environment and outside Cursor's sandbox. The agent can change tests and `package.json` scripts in a trusted repository. Code there that calls `git push` or `gh api -X POST` then runs at `stop` with David's credentials. That gets around the push block completely.

To change in `runCheckCommand`: extend the environment of the check command so that pushes and GitHub writes fail without disturbing normal tests:

- `GIT_TERMINAL_PROMPT=0`
- `GIT_ASKPASS=/usr/bin/false` and `SSH_ASKPASS=/usr/bin/false`
- `GIT_SSH_COMMAND=false`
- remove `SSH_AUTH_SOCK`
- `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=credential.helper`, `GIT_CONFIG_VALUE_0=` (an empty value resets osxkeychain)
- `GH_TOKEN=pecker-nest-gate-no-token`, and remove `GITHUB_TOKEN`
- Take over a `GIT_CONFIG_COUNT` the user already has and append after it.

Further:

- Test: `runCheckCommand` passes these variables to an `env` script.
- Record in `docs/SETUP.md` ("Was abgedeckt ist") and in `docs/v1-notes.md`: the gate runs repository code without a sandbox. The environment is only a tripwire, not a sandbox. Real isolation, for example `sandbox-exec`, is open.

## 5. `~/.agents/skills` belongs to the harness (should-fix)

`link.sh --cursor` installs skills into `~/.agents/skills`, and Cursor loads them into every session. Today the agent may create new skills there. For `~/.claude` this is blocked for exactly that reason (see the comment in `harness.ts`).

To change:

- `extensions/lib/harness.ts` → `cursorHarnessDirs`: add `canonical(join(home, ".agents"))`.
- Check whether Pi reads `~/.agents/skills`. If so, it belongs in `harnessDirs` too.
- Adjust `docs/SETUP.md` (table, line ~266) and `docs/v1-notes.md`.
- Test: a write to `~/.agents/skills/x/SKILL.md` is denied.

## 6. Small things, while touching them anyway

- `scripts/link.sh:82`: split `local backup; backup=…` (SC2155). Append `.$$` to the timestamp so that two backups in the same second do not overwrite each other.
- The e2e scenario "/plan writes only PLAN.md …" (test 2) fails without a global git identity. Set `GIT_AUTHOR_NAME`/`EMAIL` and `GIT_COMMITTER_NAME`/`EMAIL` in the scenario.

## Not in this pull request

Whether pecker-nest itself belongs to the harness in Cursor is David's decision (see v1-notes). Change nothing about it. Only as a note in v1-notes: a Cursor `/worktree` of pecker-nest lies under `~/.cursor/worktrees/` and is writable already today. The hooks keep running from `~/dev/pecker-nest`. That way nest can be developed further in Cursor after 06.12. without opening the harness.

## At the end

Push the branch and open the pull request against `main`. Title: "fix: Cursor adapter review findings (case, gh, gate env, ~/.agents)". The description holds:

- findings 1–5 with file:line
- the test output
- hand step 16 as open for David
