# Findings: Cursor hooks for nest's gates

Part 1 of [`docs/tasks/cursor-adapter.md`](../tasks/cursor-adapter.md), read on 16 November 2026. Nothing in undertext or pecker-grove was changed. David ran the capture described in [Capture](#capture) on 17 November 2026; rows answered by it have the status `captured 17.11.2026`, and [Capture results](#capture-results-17112026) sums them up. Part 2 is built on them.

## Short answer

Cursor's hooks can carry nest's rules: a permission hook before every shell command, tool call and file read, and a `stop` hook that sends a follow-up message to the same agent. The decisions can come from `extensions/lib/` unchanged. Six findings shape Part 2 more than the brief expects:

1. **The agent reads `user_message`, not `agent_message`.** On a deny from `preToolUse` or `beforeShellExecution`, Cursor 3.23.23 drops `agent_message` and hands the agent `user_message` (C2). The adapter puts the full reason in both fields.
2. **`ask` does not hold in Auto-review.** When Auto-review judges a command safe, the hook's `ask` is skipped and the command runs (X1). Auto-review is Cursor's default since 3.6. The planned `git push` exception would then push without asking. This needs David's decision before Part 2.
3. **`cwd` is often empty.** `beforeShellExecution` and the Shell tool's input carry `cwd: ""` (X2). The repository has to come from `workspace_roots` or `CURSOR_PROJECT_DIR`.
4. **No output redaction.** `postToolUse` replaces output only for MCP tools. nest's removal of lines that mention read-protected files has no Cursor counterpart; it becomes a documented gap (X3).
5. **Hooks probably run through the login shell.** A macOS failure reads `spawn /bin/zsh ENOENT` for a hook command that names bash (C6). With fish as login shell, fish may parse the command string. The adapter uses absolute paths and no shell syntax either way; the capture shows which shell it is.
6. **The first prompt after a restart may run before user hooks have loaded.** The desktop app waits only a short time for hooks; the setting that makes it wait is Enterprise-only (X6).

The capture of 17.11.2026 settled the open rows. Three of its findings changed the adapter beyond the brief (X11 to X13): Cursor stops calling `stop` once `loop_limit` follow-ups are out, so the gate hands back at the last call; `workspace_roots` can be stale after a worktree and shows one folder of a multi-root workspace, so repositories the agent changes join the turn from the permission hooks; and a Grep without a path can reach folders the hooks do not see, so a content search needs a path and a glob may not leave the root. Point 5 above is settled the other way: hooks run with `SHELL=/bin/bash`, and point 6 did not happen on 3.30.14.

## Sources

`documented` below means Cursor's documentation or a reply by Cursor staff on the forum; the source column says which. Nothing is `from source`: Cursor is closed source, and the app bundle was not read. A forum report by a user is cited as such and never carries a `documented` on its own. Forum threads are user-generated: they were read as reports, and every claim taken from them names the Cursor version it was made on.

| Short name | What | Read |
| --- | --- | --- |
| hooks | [cursor.com/docs/hooks](https://cursor.com/docs/hooks) (also as [hooks.md](https://cursor.com/docs/hooks.md)) | 16.11.2026 |
| third-party | [cursor.com/docs/reference/third-party-hooks](https://cursor.com/docs/reference/third-party-hooks) | 16.11.2026 |
| skills | [cursor.com/docs/skills](https://cursor.com/docs/skills) | 16.11.2026 |
| subagents | [cursor.com/docs/subagents](https://cursor.com/docs/subagents) | 16.11.2026 |
| rules | [cursor.com/docs/rules](https://cursor.com/docs/rules) | 16.11.2026 |
| ignore | [cursor.com/docs/reference/ignore-file](https://cursor.com/docs/reference/ignore-file) (the brief's `/docs/context/ignore-files` redirects here) and [cursor.com/help/customization/ignore-files](https://cursor.com/help/customization/ignore-files) | 16.11.2026 |
| run-modes | [cursor.com/docs/agent/security/run-modes](https://cursor.com/docs/agent/security/run-modes) | 16.11.2026 |
| sandbox | [cursor.com/docs/reference/sandbox](https://cursor.com/docs/reference/sandbox) | 16.11.2026 |
| search | [cursor.com/docs/agent/tools/search](https://cursor.com/docs/agent/tools/search) | 16.11.2026 |
| worktrees | [cursor.com/docs/configuration/worktrees](https://cursor.com/docs/configuration/worktrees) | 16.11.2026 |
| cli | [cursor.com/docs/cli/using](https://cursor.com/docs/cli/using) and [cursor.com/docs/cli/changelog](https://cursor.com/docs/cli/changelog) | 16.11.2026 |
| F-agentmsg | Forum: [preToolUse hides user_message and ignores agent_message, 3.23.23](https://forum.cursor.com/t/pretooluse-hides-user-message-and-ignores-agent-message-cursor-3-23-23/174283), staff reply 12.10.2026 | 16.11.2026 |
| F-ask | Forum: [beforeShellExecution ask is ignored in Auto-review, 3.21.16](https://forum.cursor.com/t/beforeshellexecution-hook-returning-ask-is-ignored-in-auto-review-mode-honoured-in-allowlist-and-run-everything-3-21-16/173694), staff reply 05.10.2026 | 16.11.2026 |
| F-cli-gap | Forum: [Cursor CLI omits beforeSubmitPrompt, afterAgentResponse and stop](https://forum.cursor.com/t/cursor-cli-omits-beforesubmitprompt-afteragentresponse-and-stop-hooks-loses-token-usage-and-emits-inconsistent-generation-id-values/169059), staff reply 21.08.2026 | 16.11.2026 |
| F-cli-user | Forum: [CLI 2026.11.05 (macOS): user-level hooks.json is never loaded](https://forum.cursor.com/t/cursor-cli-2026-11-05-macos-user-level-cursor-hooks-json-is-never-loaded-project-level-cursor-hooks-json-works/177989), staff reply 11.11.2026 | 16.11.2026 |
| F-zsh | Forum: [failClosed beforeShellExecution: spawn /bin/zsh ENOENT](https://forum.cursor.com/t/failclosed-beforeshellexecution-spawn-bin-zsh-enoent-blocks-shell-though-hook-is-bash-and-bin-zsh-exists/176905), 3.27.22, staff reply 02.11.2026 | 16.11.2026 |
| F-subagent-ids | Forum: [subagentStart: parent_conversation_id equals conversation_id; subagent hooks have no link back](https://forum.cursor.com/t/subagentstart-hook-parent-conversation-id-always-equals-conversation-id-and-subagent-conversations-have-no-link-back-to-their-parent/163054), 3.7.27, staff reply 12.06.2026 | 16.11.2026 |
| F-gen-ids | Forum: [subagentStart/subagentStop report the session id in four id fields](https://forum.cursor.com/t/subagentstart-subagentstop-report-4-different-id-fields-with-the-same-session-id-value-making-it-difficult-to-identify-which-prompt-spawned-a-subagent/166533), 3.12.30, staff reply 24.07.2026 | 16.11.2026 |
| F-blank-ids | Forum: [hooks intermittently emit empty conversation_id on tool events](https://forum.cursor.com/t/cursor-hooks-intermittently-emit-empty-conversation-id-session-id-on-tool-execution-events/167095), 3.9.16 to 3.13.25, staff reply 31.07.2026 | 16.11.2026 |
| F-claude-plugin | Forum: [imported Claude Code plugin hooks get a Cursor-shaped payload](https://forum.cursor.com/t/cursor-agent-imported-claude-code-plugin-hooks-get-a-cursor-shaped-payload-so-pretooluse-gates-fail-open/173171), CLI 2026.09.26, staff reply 28.09.2026 | 16.11.2026 |
| F-write | Forum: [image attached to a prompt is not picked up by hooks](https://forum.cursor.com/t/image-attached-to-user-prompt-is-not-picked-up-by-hooks/161895), 3.5.38, staff reply 29.05.2026 | 16.11.2026 |
| F-matchers | Forum: [Claude hook matchers for Skill, AskUserQuestion … never fire](https://forum.cursor.com/t/claude-hook-matchers-for-skill-askuserquestion-croncreate-and-monitor-never-fire/174416), staff replies 13.10. and 20.10.2026 | 16.11.2026 |
| F-task | Forum: [Task spawn schema strips worktree destination](https://forum.cursor.com/t/task-spawn-schema-strips-worktree-destination-fail-closed-pretooluse-hooks-cannot-isolate-subagents/171088), staff reply 09.09.2026 | 16.11.2026 |
| F-protect | Forum: [Rules can't strictly prevent unauthorized edits](https://forum.cursor.com/t/rules-cant-strictly-prevent-unauthorized-edits-the-agent-still-modifies-files/167967), staff reply 13.08.2026 | 16.11.2026 |
| F-ignore-git | Forum: [.cursorignore sandbox behavior depends on a git repository](https://forum.cursor.com/t/cursorignore-sandbox-behavior-seems-to-depend-on-workspace-being-a-git-repository/164749), 3.9.16, staff reply 08.07.2026 | 16.11.2026 |
| F-ignore-negation | Forum: [.cursorignore sandbox exclusions may fail](https://forum.cursor.com/t/cursorignore-sandbox-exclusions-may-fail-with-very-large-ignored-file-trees/164750), 3.9.16, staff replies 08.07. and 17.09.2026 | 16.11.2026 |
| F-grok-inherit | Forum: [Grok 4.7 selected as subagent model but spawned as Auto](https://forum.cursor.com/t/grok-4-7-selected-as-subagent-model-but-spawned-as-auto-instead/173191), 3.22.7, staff replies 28.09. and 01.10.2026 | 16.11.2026 |
| F-model-pin | Forum: [subagent model frontmatter ignores reasoning effort](https://forum.cursor.com/t/subagent-model-frontmatter-ignores-reasoning-effort-grok-4-6-always-runs-high/178268), staff replies 13.11.2026 | 16.11.2026 |
| F-parent-only | Forum: [block tools on the parent agent, run them only in subagents](https://forum.cursor.com/t/hooks-block-tools-on-the-parent-agent-and-run-them-only-in-subagents-keep-main-context-clean/169860), user report 28.08.2026 | 16.11.2026 |
| F-stop-turn | Forum: [expose edited-file lists on stop](https://forum.cursor.com/t/hooks-expose-conversation-turn-edited-file-lists-on-stop-allow-sessionend-followup-message/165413), user report and staff reply 17.07.2026 | 16.11.2026 |
| F-read-id | Forum: [beforeReadFile omits tool_use_id](https://forum.cursor.com/t/beforereadfile-omits-tool-use-id/170041), staff reply 08.10.2026 | 16.11.2026 |
| capture | David's capture on his Mac, Cursor 3.30.14 and CLI 2026.11.13, Run Mode "Auto Review (with Sandbox)": the log `capture.jsonl` (532 lines, 530 valid, 448 hook events, 82 probe lines), an evaluation of it, and his notes on the hand steps. Event counts: preToolUse 88, postToolUse 76, beforeSubmitPrompt 53, afterAgentResponse 45, stop 44, beforeShellExecution 32, afterShellExecution 32, sessionStart 21, beforeReadFile 13, postToolUseFailure 11, workspaceOpen 8, subagentStart 7, subagentStop 7, afterFileEdit 5, beforeMCPExecution 3, afterMCPExecution 2, sessionEnd 1. | 17.11.2026, evaluated 18.11.2026 |

## Questions

| Id | Answer | Status | Source |
| --- | --- | --- | --- |
| C1 | **Shell:** in the IDE `preToolUse` carries `tool_input: {command, cwd, timeout}` (timeout always 30000) and a top-level `cwd` with the same value; `beforeShellExecution` carries `command`, `cwd`, `sandbox` and `tool_use_id`. `cwd` is `""` except when the agent sets one (5 of 32), and `tool_use_id` is the same across pre, before, after and post. No event carries an exit code: success is `postToolUse`, failure `postToolUseFailure` (`error_message`, `failure_type`, `is_interrupt`). `sandbox` was true 17 times, false 15 times. The documentation's `working_directory` never appeared. | captured 17.11.2026 | capture; hooks (preToolUse example) |
| C1 | **Write, new file:** `{"file_path": "<absolute path>", "content": "<full new content>"}`; `content` is empty for binary files on purpose. The path is `tool_input.file_path`. | documented | F-write (payload in #1, staff #5, 3.5.38) |
| C1 | **Write, edit of an existing file:** edits arrive as `Write` too. The tool names in the capture are `Read`, `Grep`, `Write`, `Delete`, `Shell`, `Task` and `MCP:move_agent_to_root`; no `StrReplace`, `Edit` or `ApplyPatch`. The adapter still matches those names, because other models may use them. | captured 17.11.2026 | capture |
| C1 | **Read:** the path is `tool_input.file_path` (staff: "match Read and check that `tool_input.file_path` ends in SKILL.md"). Other fields (offset, limit) are not shown. `beforeReadFile` carries an absolute `file_path` and the whole `content`, and will carry `tool_use_id` when the read comes from a tool call. | documented | F-matchers (staff #7); hooks (beforeReadFile); F-read-id (staff #19) |
| C1 | **Delete:** `tool_input: {file_path}`. A delete fires neither `afterFileEdit` nor `beforeReadFile`; a delete through `rm` is visible only to `beforeShellExecution`. For comparison, `Write` carries `{file_path, content}` and is followed by `afterFileEdit` with `edits: [{old_string, new_string}]`. | captured 17.11.2026 | capture |
| C1 | **Grep:** `tool_input` has `pattern`, `glob`, `file_path` and `output_mode`; `file_path` is the search root, always a directory in the capture. Without it the input is only `pattern`, `glob`, `output_mode`, and no event names an implicit root (Grep has no top-level `cwd`). All 7 searches without a path were file searches: empty `pattern`, a `glob`, `output_mode` of length 18 (`files_with_matches`); Cursor has no separate glob or list tool. A glob can reach outside the visible root: without a path, `**/cursor-capture-test/**/a.txt` found a file in a folder that `workspace_roots` did not name (X12). | captured 17.11.2026 | capture |
| C1 | **Other tools the agent uses:** listing and globbing exist as their own tools (a user's `preToolUse` hook rejected both). The subagent tool's name depends on the model: match `Task\|Subagent\|mcp_task`. Its input has `description`, `prompt`, `subagent_type`, `model`, `run_in_background` and `environment` (`local` or `cloud`); unknown keys are stripped before the hook sees them. | documented | F-matchers (staff #7, #11); F-task (staff #12); user report in [hooks not firing](https://forum.cursor.com/t/hooks-not-firing-cannot-have-guardrails/168407) (#8) |
| C2 | **No.** On a `deny` from `preToolUse` the agent receives `user_message` ("Rejected: …"), `agent_message` is not passed on, and the tool row shows only "Skipped". Staff: "beforeShellExecution behaves the same way today". `beforeReadFile` has no `agent_message` field at all; its answer is `permission` and `user_message`. When several hooks answer, Cursor concatenates their `user_message` and `agent_message` values. | documented | F-agentmsg (staff #9, 3.23.23); hooks (beforeReadFile output, Configuration) |
| C3 | **Turn start:** `beforeSubmitPrompt`. It also fires for every `followup_message`, within a second, with the same `conversation_id`, a new `generation_id` and the follow-up text as `prompt` (X11); the adapter keeps the turn for a prompt that starts with `[quality-gate]`. A message sent while the agent works fires it at once with `composer_mode: "multitask"`, and the running round ends with `stop` `status: "aborted"`. Headless CLI (`agent -p`) never fires it. Every new chat starts with `sessionStart` and `beforeSubmitPrompt` in the same second. | captured 17.11.2026 | capture; hooks (beforeSubmitPrompt); F-cli-gap (staff #9) |
| C3 | **Ids:** every agent event carries `conversation_id`, `generation_id`, `session_id` (the same as `conversation_id`), `model`, `cursor_version`, `workspace_roots`, `user_email` and `transcript_path` (null in 150 events). `workspaceOpen` has no conversation id. `conversation_id` is "stable … across many turns"; `generation_id` "changes with every user message". A user report compares `subagentStart` against "the generation_id that beforeSubmitPrompt and stop reported for the actual triggering prompt", so both carry the same id for one prompt. Tool hooks can arrive with every id empty (staff: not intended; seen after a compaction mid-turn). Subagent tool hooks carry the subagent's own `conversation_id`; the capture shows two more fields there, `parent_agent_id` and `parent_tool_call_id`, but logged only their length, so whether they name the parent's conversation and its `Task` call is not known. In headless CLI, `generation_id` falls back to the conversation id. The safe key for a turn is `conversation_id` plus "the latest prompt". | documented / captured 17.11.2026 | hooks (common schema); F-gen-ids (#1, staff #5); F-blank-ids (staff #6); F-subagent-ids (staff #5); F-cli-gap (staff #9); capture |
| C4 | **Counting:** `loop_count` is "how many times the stop hook has already triggered an automatic follow-up for this conversation (starts at 0)"; `loop_limit` is a per-script cap, default 5. In the capture, with 5 follow-ups requested and `loop_limit: 2`, exactly 2 came per prompt, and the count started again with every new user prompt; with 1 requested, exactly 1 came. So `loop_count` counts per user prompt, not per conversation, and Cursor enforces `loop_limit`. Cursor does not call `stop` again once `loop_limit` follow-ups are out: the round after the last follow-up has `beforeSubmitPrompt` and `afterAgentResponse` but no `stop` (5 times). A `user_message` instead of a follow-up starts no new round. | captured 17.11.2026 | hooks (stop, per-script options); capture |
| C4 | **Follow-up as a turn:** a non-empty `followup_message` is "automatically submit[ted] … as the next user message". It fires `beforeSubmitPrompt` with the same `conversation_id`, a new `generation_id`, the follow-up as `prompt` and the round's `composer_mode`: 12 follow-ups, 12 such prompts (X11). If several hooks answer, the last `followup_message` wins, and Claude Code hooks merge last. | documented / captured 17.11.2026 | hooks (stop; Configuration); third-party (priority order); capture |
| C4 | **A final message to David:** none. `stop`'s only documented output is `followup_message`, and the undocumented `user_message` the capture tried ("pecker-nest capture test: no further follow-up") appeared nowhere. The adapter takes the first alternative: a last follow-up that tells the agent to change nothing more and to report the result to the user. | captured 17.11.2026 | hooks (stop); capture |
| C5 | **Yes, all of them:** a subagent's tool calls fire `preToolUse`, `postToolUse`, `beforeShellExecution`, `afterShellExecution` and `beforeReadFile`, under the subagent's own `conversation_id` and `generation_id`, with two extra fields, `parent_agent_id` and `parent_tool_call_id` (36 events of 7 subagents). A subagent fires no `sessionStart`, `beforeSubmitPrompt`, `afterAgentResponse` or `stop`; its end is `subagentStop`, whose `tool_call_count` was always 0. The parent starts it with the tool `Task` (`description`, `prompt`, `subagent_type`, `run_in_background`, `resume`). | captured 17.11.2026 | capture; F-subagent-ids (staff #5, 3.7.27) |
| C6 | **Relative paths:** user hooks run from `~/.cursor/`, so `./hooks/x.sh` and `hooks/x.sh` resolve there. Staff: the hook runs from "the hooks.json folder for user hooks", and a spawn fails with a misleading `ENOENT` when that folder no longer exists. | documented | hooks (Configuration, Troubleshooting); F-zsh (staff #11) |
| C6 | **How the command runs:** "a shell string, an absolute path, or a relative path". On David's Mac hooks run with `SHELL=/bin/bash` (his login shell is fish), and all four command forms of the probe started: absolute, relative to `~/.cursor`, with `~` and with `$HOME`. The adapter's commands use absolute paths and no shell syntax anyway. | captured 17.11.2026 | hooks (Configuration); F-zsh (#1, #4); capture |
| C6 | **`~` and environment variables in the command:** both expand (the `tilde` and `home-variable` probes started). | captured 17.11.2026 | capture |
| C6 | **PATH:** contains `/opt/homebrew/bin` when Cursor is started from the Dock, but no `node`: the probe found none on the IDE's hook PATH. David's Node comes from fnm: `command -v node` names a directory under `fnm_multishells` that disappears with the shell, so `scripts/link.sh` records the resolved path, and the gate puts that Node's directory in front of PATH. Documented variables: `CURSOR_PROJECT_DIR` (workspace root), `CURSOR_VERSION`, `CURSOR_USER_EMAIL`, `CURSOR_TRANSCRIPT_PATH`, `CURSOR_CODE_REMOTE`, `CURSOR_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`; variables a `sessionStart` hook returns reach later hooks of that session. | captured 17.11.2026 | hooks (Environment Variables); capture |
| C7 | **CLI and user hooks:** the CLI has run hooks since January 2026 with "enterprise > team > project > user precedence". Staff on 2026.11.05: "the CLI reads `~/.cursor/hooks.json` the same way as the project file". On David's Mac (CLI 2026.11.13) `agent -p` ran user-level hooks, unlike the macOS forum report: 7 shell calls, all `sandbox: false`, each with `preToolUse`, `beforeShellExecution`, `afterShellExecution` and `postToolUse`, then `sessionEnd` with `reason: "error"` after about two minutes (the connection error David saw). No `beforeSubmitPrompt`, `afterAgentResponse` or `stop`, so no gate. From the second half of the run, about 10 s passed between the hook calls of one shell call (0.1 s in the IDE). The CLI brings its own Node; `model` is `"default"`. The interactive CLI was not tried. | documented / captured 17.11.2026 | cli (changelog, January 2026); F-cli-user (#1, staff #7); F-cli-gap (staff #9); capture |
| C7 | **`workspace_roots` in a worktree:** `/worktree` runs the MCP tool `move_agent_to_root` (`tool_input: {rootPath}`), then a `workspaceOpen` and a new conversation without `sessionStart`. In all 43 events there, `workspace_roots[0]`, `CURSOR_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` name the worktree under `~/.cursor/worktrees/<repo>/<branch>`, and file paths lie below it. After `move_agent_to_root` back to the main checkout they kept naming the worktree until the turn's `stop`, while the agent's commands ran with an explicit `cwd` in the main checkout (X12). | captured 17.11.2026 | capture; worktrees; cli (CLI worktrees) |
| C7 | **`workspace_roots` in a multi-root workspace:** no event in the log has more than one entry. With `~/dev/pecker-nest` added to the scratch window, every event named only `~/dev/pecker-nest`, and the agent still found and read a file in the other folder (Grep without path, then Read with an absolute path; both hooks fired). So either the second folder is invisible to hooks, or the window was no multi-root workspace; the log cannot tell. A hand check with a `.code-workspace` of two folders is in `docs/cursor-handschritte.md`. | captured 17.11.2026 / hand check | capture; hooks (common schema) |
| C8 | **Grep and the other built-in tools:** staff: "Cursor's built-in tools (read, edit, grep, list) enforce .cursorignore regardless of the sandbox", in git and non-git workspaces. The documentation: ignored files are blocked from Agent, Tab and @-mentions. | documented | F-ignore-negation (staff #7); F-ignore-git (staff #6); ignore |
| C8 | **Sandboxed terminal commands, and Grep:** not stopped on David's version. With `notes.txt` in `.cursorignore`, the Read tool on it failed (`preToolUse`, then `postToolUseFailure`, no `beforeReadFile`), but Grep (`**/notes.txt`, `**/*notes*`) and `cat notes.txt` in the sandbox ran without error, in a git repository; David saw the content, which matches Grep or `cat`, not Read. So `.cursorignore` is no protection: the adapter's read protection runs entirely through its hooks, and SETUP.md lists this as a known gap. | captured 17.11.2026 | capture; ignore; F-ignore-git (staff #6); run-modes (Sandboxing) |
| C9 | **Yes.** Claude Code hooks load from `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json` when "Include Third-Party Plugins, Skills, and Other Configs" (Settings → Agents → Third-Party Imports) is on, which is the default. All matching hooks from every source run, so a script listed in both files runs twice. They get Cursor's payload (`tool_name: "Shell"`, not `Bash`), so a Claude hook that checks for `Bash` lets everything through. The same setting loads `~/.claude/skills/` and `~/.claude/agents/`. nest's `link.sh --claude` links skills only, no hooks, and David's `~/.claude/settings.json` has no hooks (capture step 15). `doctor.sh --cursor` warns if that changes. | documented / captured 17.11.2026 | third-party; F-claude-plugin (#1, staff #6); skills; subagents (file locations); capture |
| C10 | **`model: inherit`**, which is also the default when `model` is missing, uses the parent's model. Under a Grok 4.7 parent, `inherit` started subagents on Auto until a server-side fix on 1 October 2026. When the parent names a model as it launches a subagent, that model wins over the file. An unrecognised id falls back to the parent's model without an error; recognised Grok 4.7 ids are `grok-4.7`, `grok-4.7-high` or `grok-4.7[reasoning_effort=high,fast=false]`. Pins hold in `.cursor/agents/` and `~/.cursor/agents/`, not in plugins. On legacy request-based plans without Max Mode every subagent runs on Composer. `readonly: true` means "no file edits, no state-changing shell commands". In the capture all 7 subagents, `capture-check` with `model: inherit` included, ran on `subagent_model: "grok-4.7-medium"`, the parent's model (the parent's tool events say `grok-4.7`, its turn events `grok-4.7-medium` with `model_id: "grok-4.7"`). Whether a pin to another model holds was not tried. | documented / captured 17.11.2026 | subagents (configuration fields, model configuration, FAQ); F-grok-inherit (staff #6, #11); F-model-pin (staff #5, #16) |

## Further findings

Not asked, but each changes Part 2.

| Id | Finding | Source |
| --- | --- | --- |
| X1 | `beforeShellExecution` answering `ask`: Allowlist and Run Everything show "Hook requested approval"; in Auto-review the command runs without a prompt whenever Auto-review itself finds it safe. `deny` holds in all three modes. The payload does not say which mode is on. Auto-review is the recommended default since 3.6. | F-ask (#1, staff #8, 3.21.16); run-modes (Changelog) |
| X2 | `cwd` is `""` in `beforeShellExecution` (3.21.16 and 3.27.22 with `sandbox: true`) and in the Shell tool's input (CLI 2026.09.26). Staff's advice: use `CURSOR_PROJECT_DIR`, `CLAUDE_PROJECT_DIR` or `workspace_roots[0]`. | F-ask (#1, #10); F-zsh (#1, #4); F-claude-plugin (staff #6) |
| X3 | `postToolUse` can replace a tool's output only for MCP tools (`updated_mcp_tool_output`). There is no way to remove lines from Grep, Read or Shell output. `additional_context` only adds text. | hooks (postToolUse) |
| X4 | The sandbox write-protects `.cursor/*.json`, `.cursor/**/*.json`, `.claude/**/*.json`, `.vscode/**`, `.git/hooks/**`, `.git/config` and `.cursorignore` for sandboxed commands, whatever `sandbox.json` says. Commands outside the sandbox and file tools are not covered; External-File Protection asks before writes outside the workspace. The adapter's own write rule is still needed. | sandbox (Protected paths); run-modes (Other protections) |
| X5 | Responses merge across sources: `deny` beats `ask` beats `allow`; messages are concatenated; for `followup_message` the last response wins. Claude Code hooks merge after Cursor's user hooks. | hooks (Configuration); third-party (priority order) |
| X6 | "By default, the desktop app waits only a short time for hooks to load before it sends a prompt." The setting "Block until hooks are ready" exists only in the Enterprise dashboard. So the first prompt after a restart may run without user hooks. Not on 3.30.14: after David's restart nothing fired until the first prompt, and then `sessionStart`, `workspaceOpen` (37 ms later) and `beforeSubmitPrompt` came in that order, followed by the tool hooks. Without a `beforeSubmitPrompt` the gate would skip the turn (`no-turn-start` in the log). | hooks (Cloud Distribution); capture |
| X7 | User-level hooks never run in Cloud Agents; only the repository's `.cursor/hooks.json` and team hooks do. Cloud agents also skip hooks during early read-only turns. | hooks (Cloud agent support) |
| X8 | A hook's `timeout` defaults to a "platform default" that is not stated. The gate's `stop` hook must set it from `timeoutSeconds` in `.pi/gate.json`. A hook killed by its timeout fails open unless `failClosed` is set. | hooks (Per-Script Configuration Options) |
| X9 | `beforeTabFileRead` lets a hook deny Tab completions reading a file. Without it, a read-protected file that is open in the editor can reach the Tab model. | hooks (beforeTabFileRead) |
| X11 | **Follow-ups and the end of `stop`:** each `followup_message` comes back as a `beforeSubmitPrompt` with the follow-up as `prompt`, and Cursor calls `stop` for `loop_count` 0 to `loop_limit - 1` only; the round after the last follow-up has no `stop`. So a gate that is still red after its last repair follow-up never hears of it. The adapter keeps the last call for the hand-back: at most `loop_limit - 1` repair rounds, and a red result at `loop_count = loop_limit - 1` is handed back; it counts with Cursor's `loop_count` as well as its own. | capture |
| X12 | **`workspace_roots` is not the whole truth:** it stays on a worktree after `move_agent_to_root` back to the main checkout, it showed one folder of a multi-root window, and a Grep without path reached a file outside it. The adapter takes a command's own `cwd` before `workspace_roots`, takes the policy for a path from the repository it lies in, lets a repository that the agent is about to change (write, delete, command with `cwd`) join the turn with a baseline from before the change, blocks a content search without a path and a glob that leaves its root. A file search without a path is checked against the visible roots only; it can show names, not contents, from other folders. | capture |
| X13 | **Subagents and interruptions:** a subagent's tool hooks carry its own conversation, which has no turn; its changes count where the parent's turn knows the repository. A message sent during a round aborts it (`stop` with `status: "aborted"`, the running shell call `postToolUseFailure` with `is_interrupt: true`) and starts a new turn. | capture |
| X10 | Rules are guidance only; "they are not a hard runtime block". Staff recommends a `preToolUse` hook on `Write\|Delete` that denies, since `ask` is not enforced there. Cursor also reads `AGENTS.md` at the root and in subdirectories, as Pi does. | F-protect (staff #5); rules (AGENTS.md) |

## Capture

### What it records

`cursor/capture/hooks.json` registers `cursor/capture/capture.ts` for every agent hook event (no matcher, so every tool) plus `workspaceOpen`, and `cursor/capture/probe.sh` on `sessionStart` under four command forms. Each call appends one line to `~/.local/state/pecker-nest/cursor/capture.jsonl`:

- the event, the payload's key names, each value's type and length;
- values only for ids (`conversation_id`, `generation_id`, `tool_use_id`, …), short enumerations (`tool_name`, `status`, `loop_count`, `subagent_type`, `subagent_model`, `model`, `cursor_version`, …), numbers, booleans and path-like fields (`file_path`, `cwd`, `workspace_roots`, `glob`, …);
- how the hook was started: working directory, PATH, `SHELL`, up to three parent processes, which `node`, `npm`, `git` and `bash` that PATH finds, and the names (not values) of the `CURSOR_*`, `CLAUDE_*` and `VSCODE_*` variables.

It never records file contents, prompts, commands, command output, search patterns, URLs or the e-mail address: every other string becomes its length. It answers `allow` (or `continue` for prompts) to everything, also when the payload is broken, and none of its hooks is `failClosed`. The one exception is opt-in: while `~/.local/state/pecker-nest/cursor/capture-followups` holds a number N from 1 to 10, `stop` sends a harmless follow-up ("reply with the single word ok") N times and then tries a `user_message`. `stop` has `loop_limit: 2` in the capture, so N = 5 shows what happens at the limit.

`scripts/link.sh --cursor-capture` writes `~/.cursor/hooks.json` from the template with this checkout's path, backs up an existing file as `hooks.json.bak.<timestamp>`, links the probe to `~/.cursor/hooks/pecker-nest-probe.sh`, and records the absolute path of `node` in `~/.config/pecker-nest/cursor-node`. Hooks start Node through `cursor/node.sh`, which reads that path instead of looking on PATH. `--cursor-capture-off` removes the hook and the probe link, names the backup, and keeps the log. Neither touches Pi's links.

### David's steps

About 20 minutes. Every command is the same in bash and fish.

1. Install:

   ```bash
   cd ~/dev/pecker-nest
   ```

   ```bash
   git fetch origin claude/great-darwin-ywu2pk && git checkout claude/great-darwin-ywu2pk
   ```

   ```bash
   scripts/link.sh --cursor-capture
   ```

2. Quit Cursor with Cmd+Q and start it from the Dock or Spotlight, not with `cursor` from a terminal: C6 asks what PATH the app gives hooks without a terminal. Customize → Hooks should list the hooks; the "Hooks" output channel shows errors. Note the version (Cursor → About Cursor) and the Run Mode (Settings → Agents → Approvals & Execution).

3. A scratch repository, so no real project is touched:

   ```bash
   mkdir -p ~/dev/cursor-capture-test && cd ~/dev/cursor-capture-test && git init -q && printf 'hello\n' > a.txt && mkdir -p src && printf 'export const greeting = "hello";\n' > src/x.ts && printf 'not for the agent\n' > notes.txt && git add -A && git commit -qm init
   ```

   Open it in Cursor (File → Open Folder) and use Agent with Grok 4.7. Start a new chat for each row.

   | # | In Cursor | For |
   | --- | --- | --- |
   | 1 | `Read a.txt and tell me its first word.` | C1 Read, `beforeReadFile` |
   | 2 | `Search for the word hello in .ts files under src only.` Then in the same chat: `Search for hello in all files of the repository.` | C1 Grep |
   | 3 | `List the files in src.` | C1 other tool names |
   | 4 | `Create b.txt with the text one.` Then `Change one to two in b.txt.` Then `Delete b.txt.` | C1 Write, edit, Delete |
   | 5 | `Run the shell command: echo capture-test` | C1 Shell, X2 |
   | 6 | `Run the shell command: sleep 20 && echo done`, and while it runs send `Also tell me today's date.` | C3 |
   | 7 | `Use a subagent to read src/x.ts and to run ls src in the terminal, then report.` | C5 |
   | 8 | Create `~/.cursor/agents/capture-check.md` with the content below, then: `/capture-check read a.txt and say its first word.` | C10 |
   | 9 | In a terminal: `echo 1 > ~/.local/state/pecker-nest/cursor/capture-followups`. New chat: `Reply with the word ready.` Note whether the follow-up shows up as a message, and whether the line "pecker-nest capture test: no further follow-up" appears anywhere. Then `echo 5 > ~/.local/state/pecker-nest/cursor/capture-followups`, new chat, the same prompt, and when it has settled, in the same chat: `Reply with the word again.` Finally `rm ~/.local/state/pecker-nest/cursor/capture-followups`. | C3, C4 |
   | 10 | In a terminal in the scratch repository: `printf 'notes.txt\n' > .cursorignore`. New chat: `Read notes.txt.`, then `Search for the word agent in all files.`, then `Run the shell command: cat notes.txt`. Note for each whether it was blocked or showed the text. Then `rm .cursorignore`. | C8 |
   | 11 | `/worktree create c.txt with the text three`, then `/delete-worktree`. | C7 |
   | 12 | File → Add Folder to Workspace… → `~/dev/pecker-nest`. New chat: `Read a.txt in cursor-capture-test.` Close the workspace without saving it. | C7 |
   | 13 | Quit Cursor, start it again, and send `Read a.txt.` as the first prompt as soon as the window is open. | X6 |
   | 14 | Only if the CLI is installed (`agent --version`): in the scratch repository `agent`, then `Run the shell command: echo cli`, exit; then `agent -p "Run the shell command: echo cli-headless"`. | C7 |
   | 15 | In a terminal, prints the hook events in Claude Code's user settings, nothing else: `node -e 'const f = require("os").homedir() + "/.claude/settings.json"; try { console.log(Object.keys(JSON.parse(require("fs").readFileSync(f, "utf8")).hooks ?? {})) } catch { console.log("not readable:", f) }'`. Also note whether Settings → Agents → Third-Party Imports is on. | C9 |

   Content of `~/.cursor/agents/capture-check.md` for step 8:

   ```markdown
   ---
   name: capture-check
   description: Capture test for pecker-nest. Use only when asked for by name.
   model: inherit
   readonly: true
   ---

   Read the file you are asked to read and answer in one sentence.
   ```

4. Remove the hook and the test agent:

   ```bash
   ~/dev/pecker-nest/scripts/link.sh --cursor-capture-off
   ```

   ```bash
   rm ~/.cursor/agents/capture-check.md
   ```

5. Return `~/.local/state/pecker-nest/cursor/capture.jsonl` with the notes: Cursor version, Run Mode, what steps 9, 10 and 13 showed, step 15's output, and any errors in the Hooks output channel. The log holds paths on your Mac and conversation ids, no content; look through it before you send it.

## Capture results (17.11.2026)

David ran the capture on Cursor 3.30.14 in the Run Mode "Auto Review (with Sandbox)". The log has 532 lines; two are broken, because the four `sessionStart` probes appended at the same moment and bash writes a line longer than 4096 bytes in pieces. `probe.sh` now appends under a lock.

| Step | Result |
| --- | --- |
| Tools (1–4, 7) | `Shell` 63, `Grep` 42, `Read` 36, `Task` 14, `Write` 10, `MCP:move_agent_to_root` 6, `Delete` 4; edits arrive as `Write`, file searches as `Grep` with an empty pattern. Fields in C1. |
| Follow-ups (9) | With `loop_limit: 2`, exactly 2 follow-ups per prompt when 5 were requested, exactly 1 when 1 was; the count starts again at every new prompt; each follow-up comes back as a `beforeSubmitPrompt`, and no `stop` follows the last one (X11). The `user_message` on `stop` appeared nowhere. |
| `.cursorignore` (10) | No protection: the Read tool failed on the ignored file, but Grep and `cat` in the sandbox ran. |
| Worktree (11) | `/worktree` created `~/.cursor/worktrees/<repo>/<branch>`; `workspace_roots` named it, and stayed on it after the move back (X12). |
| Multi-root (12) | Every event named one folder only; the agent found and read a file in the other folder anyway (X12). Hand check with a `.code-workspace` pending. |
| Restart (13) | No hook until the first prompt; then `sessionStart`, `workspaceOpen`, `beforeSubmitPrompt` and the tool hooks (X6 did not happen). |
| CLI (14) | `agent -p` ran user hooks for its 7 shell calls, then ended with `sessionEnd` `reason: "error"`; no `stop`, no gate. Interactive CLI not tried. |
| Subagents (7, 8) | Their tool calls fire every tool hook under their own conversation with `parent_agent_id`; no `stop`. `model: inherit` ran on the parent's model. |
| Never seen | `beforeTabFileRead` (the capture did not register it), `afterTabFileEdit`, `preCompact`, `afterAgentThought`; `sessionEnd` only in the CLI. |
| Claude Code hooks (15) | None in `~/.claude/settings.json`. |
| Start (C6) | `SHELL=/bin/bash`, PATH with `/opt/homebrew/bin`; absolute, relative, `~` and `$HOME` forms all started. Node from fnm: `command -v node` is a per-shell path. |

## Consequences for Part 2

Written before the capture; Part 2 (`cursor/`, see `docs/v1-notes.md`, update of 18.11.2026) follows them except where the capture said otherwise: every `git push` is denied, the hand-back is a last follow-up within `loop_limit` (X11), `.cursorignore` is no second layer, repositories join a turn from the permission hooks and Grep needs a path for content (X12), and there is no fallback for a missed turn start beyond skipping it (X6 did not happen).

- **Commands** (`beforeShellExecution`, `failClosed`): the policy comes from the workspace root (`CURSOR_PROJECT_DIR`, `workspace_roots`), not from `cwd`. The reason goes into `user_message` and `agent_message` with nest's wording ("Do not try to work around this block …"). The tool row shows only "Skipped", so the log line is David's record.
- **`git push`** (X1): under Auto-review an `ask` is a silent allow. Two ways out for David to choose from: keep `deny` for every push as in nest (recommended, since the hook cannot see the Run Mode), or answer `ask` and document that it holds only in Allowlist and Run Everything.
- **Writes** (`preToolUse`): the matcher covers the edit tool names the capture shows, not only `Write|Delete`. The protected set adds `.cursor/hooks.json`, `.cursorignore`, `~/.cursor/`, this checkout, and `~/.config/pecker-nest/` and `~/.local/state/pecker-nest/`, so the agent can edit neither the trust list nor the gate's snapshots. X4 covers sandboxed commands only.
- **Reads** (`preToolUse` on Read, Grep and the listing tools the capture names, plus `beforeReadFile` and `beforeTabFileRead`): `protectedReadReason` on the path; for Grep the rule follows from the captured fields. Output redaction is a known gap (X3). A repository can add its read-protected files to `.cursorignore` as a second layer, one path per line and without `!` (C8).
- **Turn start:** `beforeSubmitPrompt`, keyed by `conversation_id`. If the capture shows that follow-ups fire it too, the adapter keeps the snapshot while one of its own follow-ups is pending. Fallback for a missed start (X6, CLI): the first permission hook of a conversation without a snapshot takes one before it allows anything.
- **Gate** (`stop`): explicit `timeout` from `timeoutSeconds` (X8), `loop_limit` from `maxRepairRounds`. If the capture shows that hooks lack `/opt/homebrew/bin`, the gate command gets the recorded Node's directory in front of its PATH, so `npm run check` finds `npm`. The final message for used-up rounds follows C4.
- **Not covered:** Cloud Agents (X7), headless CLI runs have no `stop` and so no gate (C7), output redaction (X3), the first prompt after a restart (X6), and Claude Code hooks that David may have in `~/.claude/settings.json` (C9; `doctor.sh --cursor` can warn).
- **Reviewer subagent:** `model: inherit`, `readonly: true`; the user rule asks the agent not to name a model when it starts the reviewer (C10).
