# Task: Cursor adapter for nest's gates (pecker-nest)

Written by the planning chat on 16 November 2026 against `main` at `82b8aca`. Claude Code does this task; nest is never built with nest. Commit this brief as `docs/tasks/cursor-adapter.md` in the first commit of your pull request.

Read first: `extensions/lib/safety-rules.ts`, `protect-config.ts`, `gate-config.ts`, `tamper-check.ts`, `extensions/safety-gate.ts`, `extensions/quality-gate.ts`, `scripts/link.sh`, `agent/APPEND_SYSTEM.md`, `agent/agents/reviewer.md`, and Cursor's documentation for hooks, rules, skills, subagents and ignore files.

## Goal

David also works in Cursor (Grok 4.7) on undertext and pecker-grove while that quota lasts. Cursor should enforce the same safety rules and the same quality gate as nest, from the same per-repository files (`.pi/protect.json`, `.pi/gate.json`), by calling the logic that already exists in `extensions/lib/`. No second rule set.

## What we know

| Fact | Source |
| --- | --- |
| Hooks are configured in `~/.cursor/hooks.json` (user) or `<repo>/.cursor/hooks.json` (project), top-level `version: 1`. A hook gets JSON on stdin and answers with JSON on stdout. | cursor.com/docs/hooks, read 16.11.2026 |
| `beforeShellExecution` receives `command`, `cwd`, `sandbox` and may answer `permission: allow / deny / ask` with `user_message` and `agent_message`. | same |
| `preToolUse` receives `tool_name`, `tool_input`, `cwd` and may answer `allow` or `deny`; `ask` is not enforced there. Matchers: `Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, `MCP:<tool>`. | same |
| `beforeReadFile` receives `file_path` and `content` and may answer `allow` or `deny`. | same |
| `stop` receives `status` (`completed`, `aborted`, `error`) and `loop_count` and may answer `followup_message`, which is submitted to the same agent. `loop_limit` defaults to 5. | same |
| Every hook also gets `conversation_id`, `generation_id`, `workspace_roots`, `hook_event_name`, `cursor_version`, `transcript_path`. | same |
| A hook that fails (exit code other than 0 or 2) lets the action proceed unless `failClosed: true`. Exit code 2 blocks. For permission hooks, invalid JSON on exit 0 blocks. | same |
| User-level hooks do not run in Cloud Agents. | same |
| `.cursorignore` blocks the agent's file tools, but terminal commands and MCP tools are outside it; forum reports say the sandbox and the Grep tool behave inconsistently. | cursor.com/docs/context/ignore-files and forum threads, read 16.11.2026 |
| Cursor loads skills from `.agents/skills/`, `.cursor/skills/`, `~/.agents/skills/`, `~/.cursor/skills/` and also from `.claude/skills/` and `~/.claude/skills/`. | cursor.com/docs/skills |
| Custom subagents are Markdown files in `.cursor/agents/` or `~/.cursor/agents/` with frontmatter (`name`, `description`, `model`, `readonly`). A forum report says a subagent pinned to Grok 4.7 ran on another model. | cursor.com/docs/subagents, forum |
| nest's decision logic is pure and exported: `bashCommandReason`, `protectedPathReason`, `protectedReadReason`, `loadProtectConfig`, `loadGateConfig`, `isDocsOnly`, `outputExcerpt`, `snapshotTree`, `tamperFindings`, `formatFindings`. | this repository |

Nobody but David can run Cursor. You verify with unit tests on recorded payloads; he does the live checks.

## Part 1: findings and capture (first pull request)

Deliver `docs/research/cursor-hooks.md`. One row per question: answer, status (`documented`, `from source`, `not found`, `needs capture`) and the source (URL with the date you read it). Never answer from memory about Cursor.

| Id | Question |
| --- | --- |
| C1 | What is the exact shape of `tool_input` for `Write`, `Delete`, `Read`, `Grep` and `Shell` in `preToolUse`? Which field carries the path, and for `Grep` the search root and include patterns? |
| C2 | Does `agent_message` reach the model on a `deny` for `preToolUse`, `beforeShellExecution` and `beforeReadFile`? |
| C3 | Which event marks the start of a turn reliably (`beforeSubmitPrompt`?), and which id is stable across a turn and its `stop`? |
| C4 | `stop`: how do `loop_count` and `loop_limit` interact, does `followup_message` count as a new turn for C3, and is there any way to show David a final message when rounds are used up? |
| C5 | Do hooks fire for tool calls made inside subagents? |
| C6 | How does a user-level `hooks.json` resolve relative command paths, does it expand `~` or environment variables, and with which `PATH` does Cursor on macOS start a hook? David installs Node with Homebrew and uses fish; a GUI app may not see `/opt/homebrew/bin`. |
| C7 | Does the Cursor CLI run user-level hooks? What does `workspace_roots` hold in a multi-root workspace and in a worktree started by Cursor? |
| C8 | Does `.cursorignore` currently stop the `Grep` tool and sandboxed terminal commands? |
| C9 | Does Cursor load Claude Code hooks from `~/.claude/settings.json` by default, so that a hook could run twice? |
| C10 | Which model id and frontmatter make a custom subagent stay on the parent's model? |

Questions the documentation cannot answer get status `needs capture`. For those, ship a capture hook in the same pull request:

- `cursor/capture/hooks.json` and one script that appends a line per hook call to `~/.local/state/pecker-nest/cursor/capture.jsonl`: event name, the key names of the payload, value types and lengths, and for path-like fields only the path. Never file contents, prompts or command output.
- `scripts/link.sh --cursor-capture` installs it as `~/.cursor/hooks.json` (existing file backed up like the other links) and `--cursor-capture-off` removes it.
- The capture hook always answers `allow`.

**Stop after Part 1.** David runs the capture for a few minutes and returns the log. Build Part 2 from the findings and the log.

## Part 2: the adapter (second pull request)

### Layout

```
cursor/hooks.json            user-level hook config, installed by link.sh --cursor
cursor/hooks/                thin entry scripts, one per event
cursor/lib/                  pure mapping: Cursor payload -> decision, unit-tested
cursor/agents/reviewer.md    read-only reviewer subagent
cursor/user-rule.md          text David pastes into Cursor's User Rules
```

All decisions come from `extensions/lib/`. The adapter only translates payloads and results. If you need to change a file in `extensions/lib/`, keep nest's behaviour and tests unchanged.

### Hooks

1. **Commands** (`beforeShellExecution`, `failClosed: true`): `bashCommandReason(command, policy)` with the policy from the workspace's `.pi/protect.json`. A reason means `deny`, with the reason as `agent_message` and `user_message`. One exception that uses Cursor's `ask`: a plain `git push` of the current non-default branch to `origin`, without force flags, answers `ask` so David confirms it in the IDE. Everything else nest blocks stays `deny`.
2. **Writes and deletes** (`preToolUse`, matcher `Write|Delete`, `failClosed: true`): `protectedPathReason`. In addition to nest's protected paths, block `.cursor/hooks.json`, `.cursorignore`, `~/.cursor/` and the adapter's own files, so the agent cannot switch the gate off.
3. **Reads** (`preToolUse` with matcher `Read|Grep`, plus `beforeReadFile`, `failClosed: true`): `protectedReadReason`. For `Grep`, deny when the search can reach a read-protected path and say which path to exclude; settle the exact rule from C1 and C8. nest removes matching lines from tool output; if Cursor offers no way to do that, say so in the docs as a known gap.
4. **Turn start** (the event from C3): record `snapshotTree(cwd)` for the conversation in the state directory.
5. **Quality gate** (`stop`): only when `status` is `completed`, the repository is trusted (below), `.pi/gate.json` exists and the turn changed more than docs (`isDocsOnly`). Run the tamper check against the turn's snapshot, then the gate command with its timeout. Findings or a red check return a `followup_message` built like nest's repair message (`formatFindings`, `outputExcerpt`), at most `maxRepairRounds` times. Set `loop_limit` to match. Green, or rounds used up, returns nothing.
6. **Invalid `.pi/protect.json`** blocks all writes and commands, as in nest.

### Trust

The gate runs a command from a file in the repository with David's rights. It must not run for a repository David has merely opened. Keep a list of trusted repository roots in `~/.config/pecker-nest/cursor-trusted` (one absolute path per line), managed by `scripts/cursor-trust.sh add|remove|list`. Safety hooks apply everywhere; the gate only in listed repositories. A repository with a `gate.json` that is not listed gets one line in the log, no run.

### Starting Node

Hook commands go through a small `sh` wrapper that starts Node by the absolute path recorded when `link.sh --cursor` ran, and fails with a clear message when that path no longer exists. With `failClosed: true`, a broken wrapper blocks every command, so `scripts/doctor.sh` must check it.

### Log

Each decision appends one line to `~/.local/state/pecker-nest/cursor/log.jsonl`: time, event, repository, decision, rule name, gate result, repair round, count of tamper findings. Counts and paths only, never content. This is what later makes Cursor sessions comparable with nest's session report; the report itself is out of scope.

### Carry-overs without code

- `cursor/agents/reviewer.md`: nest's reviewer instructions, `readonly: true`, model per C10, without Pi-specific tool names.
- `cursor/user-rule.md`: the rules of `agent/APPEND_SYSTEM.md` that do not depend on Pi (drop `todo`, `questionnaire`, the knowledge-base section and the wording about nest's gate; say instead that hooks may block an action or send a failed check back), plus one line asking for short answers without preamble. Add a unit test that fails when a rule is added to `APPEND_SYSTEM.md` without a decision for this file.
- Skills: `link.sh --cursor` links `skills/grill-me`, `skills/testing-ts` and `skills/testing-py` into `~/.agents/skills/`. Not `best-practices`: it needs the knowledge base, which Cursor does not have.

### `scripts/link.sh --cursor`

Installs `~/.cursor/hooks.json`, `~/.cursor/agents/reviewer.md` and the three skills, backing up what exists like the other links; `--check` covers them. Bash 3.2, as before. `scripts/doctor.sh` gets a `--cursor` switch: links in place, the Node path in the wrapper exists, the trust list is readable, and one `WARN` when `nest-supervise` and `nest-handoff` are visible to Cursor through `~/.claude/skills/` (they are, by Cursor's compatibility loading; the line only tells David why they show up).

### Tests

- Unit tests in `test/` feed recorded payloads (from the capture log, with invented paths) into `cursor/lib/` and assert the decision for each rule family: blocked command, protected write, protected read, `.pi/` write, push that asks, push that is denied, invalid `protect.json`, untrusted repository, docs-only turn, red gate, tamper finding, rounds used up.
- A test that runs each entry script as a process with a payload on stdin and checks stdout and exit code, including a malformed payload (must block for the three `failClosed` hooks).
- `npm run check` and `npm run e2e` pass. Nothing in this task changes Pi's behaviour.

### Docs

German, in the existing voice, bash first and fish second where they differ: a section "Cursor" in `docs/SETUP.md` (install, trust a repository, paste the user rule, what is and is not covered), the known gaps, and an "Update" section in `docs/v1-notes.md` with "Getestet" and "Nicht getestet".

## Rules

- Change nothing in undertext or pecker-grove. They get their own tasks.
- No secret, token or machine-specific path in the repository. Paths under the home directory are built at link time.
- Hooks never print file contents, prompts or command output to the log.
- Do not install Cursor plugins or third-party skills, and do not add MCP servers here.
- Never merge. One pull request per part.

## David's part

1. After Part 1: install the capture hook, do the listed actions in Cursor, return the log, remove the capture hook.
2. After Part 2: review and merge, `scripts/link.sh --cursor`, trust undertext and pecker-grove, paste the user rule, then the hand checks in `cursor-handschritte.md`.

## Acceptance checks

- [ ] Every question id has a row with answer, status and source; open ones are marked `needs capture`.
- [ ] The capture hook logs no content and always allows.
- [ ] All decisions call `extensions/lib/`; no rule is duplicated in `cursor/`.
- [ ] The three permission hooks are `failClosed` and block on a malformed payload.
- [ ] The gate never runs in a repository that is not on the trust list.
- [ ] The agent cannot edit `.pi/`, `.cursor/hooks.json`, `.cursorignore` or the adapter through `Write`, `Delete` or a shell command.
- [ ] `npm run check` and `npm run e2e` pass.
- [ ] The docs name what Cursor cannot enforce (Cloud Agents, output redaction, anything C1 to C10 left open).

## Out of scope

The router, session report, provider log, checkpoints, compaction and Docker stay nest-only. No report over the Cursor log yet. No knowledge base in Cursor.
