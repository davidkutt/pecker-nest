/**
 * The Cursor adapter (cursor/): payloads in the shapes of the capture of 17.11.2026 (Cursor 3.30.14,
 * docs/research/cursor-hooks.md) with invented paths in scratch directories, through cursor/lib/
 * into extensions/lib/ and back. One test per rule family, the gate with a stand-in for the check
 * command, the entry scripts as processes, hooks.json, link.sh --cursor and cursor-trust.sh.
 * Cursor itself is not needed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { handBackMessage, repairMessage } from "../extensions/lib/gate-message.ts";
import { bashCommandReason, protectedPathReason } from "../extensions/lib/safety-rules.ts";
import { type AdapterContext, STOP_LOOP_LIMIT, STOP_RESERVE_SECONDS, STOP_TIMEOUT_SECONDS } from "../cursor/lib/context.ts";
import {
	type CheckRun,
	checkEnvironment,
	GATE_GH_TOKEN,
	joinTurn,
	MIXED_INSTRUCTION,
	readTurn,
	REPORT_INSTRUCTION,
	roundsFor,
	runCheckCommand,
	startTurn,
	stopTurn,
	timeoutFor,
	turnFile,
} from "../cursor/lib/gate.ts";
import { ruleOf } from "../cursor/lib/log.ts";
import { patchPaths, workspaceRoots, writePaths } from "../cursor/lib/payload.ts";
import { beforeReadFile, beforeShellExecution, PRE_TOOL_USE_MATCHER, preToolUse } from "../cursor/lib/permission.ts";
import { handle } from "../cursor/lib/run.ts";
import { isTrusted, worktreeMain } from "../cursor/lib/trust.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_SH = join(NEST, "cursor/node.sh");
const LINK = join(NEST, "scripts/link.sh");
const TRUST = join(NEST, "scripts/cursor-trust.sh");
const TEMPLATE = join(NEST, "cursor/hooks.json");
const NODE_DIR = dirname(process.execPath);

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = "nest-cursor-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
}

function write(root: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const git = (cwd: string, ...args: string[]) => {
	const run = spawnSync("git", ["-c", "user.name=tester", "-c", "user.email=tester@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8" });
	assert.equal(run.status, 0, run.stderr);
	return run.stdout;
};

/** A git repository with the given files, committed. */
function repo(files: Record<string, string> = {}): string {
	const root = scratch("nest-cursor-repo-");
	git(root, "init", "-q");
	write(root, { "README.md": "# demo\n", ...files });
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	return root;
}

/** A context with a scratch HOME. */
function context(home = scratch("nest-cursor-home-")): AdapterContext {
	return { home, nestDir: NEST, env: {}, now: () => new Date("2026-11-18T08:00:00Z") };
}

function trust(home: string, ...roots: string[]) {
	write(home, { ".config/pecker-nest/cursor-trusted": roots.map((root) => `${root}\n`).join("") });
}

/** The fields every captured payload carries (C3, common schema), with invented values. */
function common(roots: string[], event: string) {
	return { conversation_id: "conv-1", generation_id: "gen-1", hook_event_name: event, cursor_version: "3.30.14", model: "grok-4.7-high", workspace_roots: roots, transcript_path: "/Users/someone/.cursor/projects/demo/agent-transcripts/conv-1.txt" };
}

const shell = (root: string, command: string) => ({ ...common([root], "beforeShellExecution"), command, cwd: "", sandbox: true });
const tool = (root: string, tool_name: string, tool_input: Record<string, unknown>) => ({ ...common([root], "preToolUse"), tool_name, tool_input, tool_use_id: "tool-1", cwd: "" });

const UNDERTEXT_LIKE = {
	".pi/protect.json": JSON.stringify({ read: ["evals/samples/*holdout*.jsonl"], write: ["docs/milestones/**"], commands: [{ pattern: "--split[ =]+holdout\\b", reason: "the held-out eval runs once, by David" }] }),
	"evals/samples/train.jsonl": "{}\n",
	"evals/samples/harness-holdout.jsonl": "{}\n",
	"src/x.ts": 'export const greeting = "hello";\n',
};

function denied(answer: Record<string, unknown>, pattern: RegExp) {
	assert.equal(answer.permission, "deny", JSON.stringify(answer));
	assert.match(String(answer.user_message), pattern);
	assert.match(String(answer.user_message), /^Blocked by pecker-nest: .*Do not try to work around this block\./);
}

describe("cursor adapter: commands", () => {
	it("denies what nest blocks and puts the whole reason into both messages (C2)", () => {
		const root = repo(UNDERTEXT_LIKE);
		const ctx = context();
		const { answer, entries } = beforeShellExecution(shell(root, "rm -rf build"), ctx);
		denied(answer, /recursive forced delete/);
		assert.equal(answer.agent_message, answer.user_message);
		assert.deepEqual(entries, [{ event: "beforeShellExecution", decision: "deny", rule: "rm-recursive", repo: root }]);
		assert.deepEqual(beforeShellExecution(shell(root, "npm test"), ctx).answer, { permission: "allow" });
	});

	it("denies every git push, also a plain push of a feature branch to origin: no ask (X1)", () => {
		const root = repo();
		for (const command of ["git push", "git push origin feat/x", "git push -u origin HEAD", "git push --force origin main"]) {
			const { answer, entries } = beforeShellExecution(shell(root, command), context());
			denied(answer, /git push is blocked; the user pushes/);
			assert.equal(entries[0].rule, "git-push", command);
			assert.notEqual(answer.permission, "ask");
		}
	});

	it("denies GitHub writes and pushes in disguise: the user merges, approves, closes, comments and pushes", () => {
		const root = repo();
		const cases: [string, string, RegExp][] = [
			["gh pr merge 3 --squash", "gh-write", /gh pr merge is blocked; the user merges, approves, closes and comments/],
			["gh pr review 3 --approve", "gh-write", /gh pr review is blocked/],
			["gh api -X POST repos/o/r/issues/3/comments -f body=done", "gh-write", /gh api with -X POST is blocked/],
			["git -c alias.p=push p", "git-push", /defines an alias that pushes/],
			["git send-pack origin main", "git-push", /git send-pack pushes/],
			["git subtree push --prefix dist origin gh-pages", "git-push", /git subtree push is blocked/],
			["sh -lc 'git push'", "git-push", /git push is blocked/],
		];
		for (const [command, rule, reason] of cases) {
			const { answer, entries } = beforeShellExecution(shell(root, command), context());
			denied(answer, reason);
			assert.equal(entries[0].rule, rule, command);
		}
		for (const command of ["gh pr create --title x --body y", "gh pr view 3", "gh pr checks 3", "gh api repos/o/r/pulls"]) {
			assert.deepEqual(beforeShellExecution(shell(root, command), context()).answer, { permission: "allow" }, command);
		}
	});

	it("applies the repository's command rules and read protection to shell commands", () => {
		const root = repo(UNDERTEXT_LIKE);
		denied(beforeShellExecution(shell(root, "uv run evals --split holdout"), context()).answer, /held-out eval runs once/);
		denied(beforeShellExecution(shell(root, "cat evals/samples/harness-holdout.jsonl"), context()).answer, /would read evals\/samples\/harness-holdout\.jsonl/);
		denied(beforeShellExecution(shell(root, "echo x > docs/milestones/m1.md"), context()).answer, /protected by \.pi\/protect\.json \(write/);
	});

	it("checks the Shell tool of preToolUse the same way, also inside subagents", () => {
		const root = repo();
		const { answer, entries } = preToolUse(tool(root, "Shell", { command: "git reset --hard", cwd: "", timeout: 30000 }), context());
		denied(answer, /git reset --hard/);
		assert.equal(entries[0].tool, "Shell");
	});

	it("checks a command against every root of a multi-root workspace", () => {
		const plain = repo();
		const strict = repo(UNDERTEXT_LIKE);
		const payload = { ...shell(plain, "uv run evals --split holdout"), workspace_roots: [plain, strict] };
		const { answer, entries } = beforeShellExecution(payload, context());
		denied(answer, /held-out eval/);
		assert.equal(entries[0].repo, strict);
	});

	it("blocks the scripts that would switch the gate off or trust a repository", () => {
		const root = repo();
		const ctx = context();
		for (const command of [`${NEST}/scripts/link.sh --cursor-capture`, "~/dev/pecker-nest/scripts/cursor-trust.sh add .", "bash scripts/cursor-trust.sh add /tmp/x"]) {
			const { answer, entries } = beforeShellExecution(shell(root, command), ctx);
			denied(answer, /installs or configures the agent harness/);
			assert.equal(entries[0].rule, "harness-script", command);
		}
	});

	it("blocks shell writes to Cursor's own configuration", () => {
		const root = repo();
		const ctx = context();
		for (const command of ["echo '' > .cursorignore", "rm .cursor/hooks.json", `cp x ${ctx.home}/.cursor/hooks.json`, "echo '{}' > .claude/settings.json"]) {
			const { answer, entries } = beforeShellExecution(shell(root, command), ctx);
			denied(answer, /agent harness/);
			assert.equal(entries[0].rule, "harness", command);
		}
	});

	it("takes the repository from workspace_roots and CURSOR_PROJECT_DIR when cwd is empty (X2)", () => {
		const root = repo(UNDERTEXT_LIKE);
		assert.deepEqual(workspaceRoots({ cwd: "", workspace_roots: [root] }, {}), [root]);
		assert.deepEqual(workspaceRoots({ cwd: "" }, { CURSOR_PROJECT_DIR: root }), [root]);
		const ctx = { ...context(), env: { CURSOR_PROJECT_DIR: root } };
		denied(beforeShellExecution({ command: "cat evals/samples/harness-holdout.jsonl", cwd: "" }, ctx).answer, /harness-holdout/);
	});
});

describe("cursor adapter: writes and deletes", () => {
	it("denies writes the repository protects, to .pi/, to secrets, and allows the rest", () => {
		const root = repo(UNDERTEXT_LIKE);
		const ctx = context();
		const cases: [string, string | undefined][] = [
			["docs/milestones/m1.md", "protect-write"],
			[".pi/gate.json", "pi-dir"],
			[".pi/protect.json", "pi-dir"],
			[".env", "env-file"],
			["evals/samples/harness-holdout.jsonl", "protect-read"],
			["src/x.ts", undefined],
		];
		for (const [path, rule] of cases) {
			const { answer, entries } = preToolUse(tool(root, "Write", { file_path: join(root, path), content: "SECRET-CONTENT" }), ctx);
			if (rule) denied(answer, /./);
			else assert.deepEqual(answer, { permission: "allow" }, path);
			assert.equal(entries[0].rule, rule ?? "allowed", path);
			assert.ok(!JSON.stringify(entries).includes("SECRET-CONTENT"), "the log holds no content");
		}
		denied(preToolUse(tool(root, "Delete", { file_path: join(root, ".pi/protect.json") }), ctx).answer, /\.pi\//);
	});

	it("denies writes to Cursor's hooks, ignore file, the adapter, the trust list and the gate's state", () => {
		const root = repo();
		const ctx = context();
		const targets = [
			join(root, ".cursor/hooks.json"),
			join(root, ".cursor/hooks/x.sh"),
			join(root, ".cursorignore"),
			join(root, ".claude/settings.local.json"),
			join(ctx.home, ".cursor/hooks.json"),
			join(ctx.home, ".cursor/agents/reviewer.md"),
			join(NEST, "cursor/lib/permission.ts"),
			join(ctx.home, ".config/pecker-nest/cursor-trusted"),
			join(ctx.home, ".local/state/pecker-nest/cursor/turns/conv-1.json"),
			join(ctx.home, ".claude/skills/x/SKILL.md"),
		];
		for (const target of targets) {
			const { answer, entries } = preToolUse(tool(root, "Write", { file_path: target, content: "x" }), ctx);
			denied(answer, /agent harness.*change (the harness|it) outside Cursor/);
			assert.equal(entries[0].rule, "harness", target);
		}
	});

	it("ignores case as APFS does on macOS: every spelling of a protected path is denied", () => {
		const root = repo(UNDERTEXT_LIKE);
		const ctx = { ...context(), caseInsensitive: true };
		const cases: [string, string][] = [
			[join(root, ".Cursor/hooks.json"), "harness"],
			[join(ctx.home, ".CURSOR/hooks.json"), "harness"],
			[join(root, ".PI/gate.json"), "pi-dir"],
			[join(root, ".ENV"), "env-file"],
			[join(NEST.toUpperCase(), "x"), "harness"],
			[join(root, "DOCS/Milestones/m1.md"), "protect-write"],
		];
		for (const [target, rule] of cases) {
			const { answer, entries } = preToolUse(tool(root, "Write", { file_path: target, content: "{}" }), ctx);
			denied(answer, /./);
			assert.equal(entries[0].rule, rule, target);
		}
		denied(preToolUse(tool(root, "Read", { file_path: join(root, "EVALS/samples/Harness-HOLDOUT.jsonl") }), ctx).answer, /protected by \.pi\/protect\.json \(read: /);
		for (const command of ["GIT push", "echo '{}' > .Cursor/hooks.json", "cat Evals/Samples/HARNESS-holdout.jsonl", `${NEST.toUpperCase()}/scripts/link.sh --cursor-capture`]) {
			denied(beforeShellExecution(shell(root, command), ctx).answer, /./);
		}
		const sensitive = { ...ctx, caseInsensitive: false };
		assert.deepEqual(preToolUse(tool(root, "Write", { file_path: join(root, ".Cursor/hooks.json"), content: "{}" }), sensitive).answer, { permission: "allow" }, "a case-sensitive file system keeps .Cursor apart from .cursor");
	});

	it("lets the agent work in a Cursor worktree under ~/.cursor/worktrees, but not on its hook files", () => {
		const ctx = context();
		const worktree = join(ctx.home, ".cursor/worktrees/demo/feat-x");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), "gitdir: /Users/someone/dev/demo/.git/worktrees/feat-x\n");
		assert.deepEqual(preToolUse(tool("/Users/someone/dev/demo", "Write", { file_path: join(worktree, "src/c.ts"), content: "x" }), ctx).answer, { permission: "allow" });
		denied(preToolUse(tool("/Users/someone/dev/demo", "Write", { file_path: join(worktree, ".cursor/hooks.json"), content: "x" }), ctx).answer, /configures the agent harness/);
		denied(preToolUse(tool("/Users/someone/dev/demo", "Write", { file_path: join(worktree, ".pi/gate.json"), content: "x" }), ctx).answer, /\.pi\//);
	});

	it("finds the paths of other edit tools, apply-patch bodies included, and blocks a write it cannot place", () => {
		assert.deepEqual(patchPaths("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: .pi/gate.json\n+{}\n*** End Patch\n"), ["src/a.ts", ".pi/gate.json"]);
		assert.deepEqual(writePaths({ path: "a.ts", paths: ["b.ts"] }).sort(), ["a.ts", "b.ts"]);
		const root = repo();
		denied(preToolUse(tool(root, "ApplyPatch", { input: "*** Begin Patch\n*** Update File: .pi/gate.json\n*** End Patch\n" }), context()).answer, /\.pi\//);
		const blind = preToolUse(tool(root, "Write", { content: "x" }), context());
		denied(blind.answer, /names no file/);
		assert.equal(blind.entries[0].rule, "malformed");
	});

	it("blocks every write and command while .pi/protect.json is invalid, as nest does, and still allows reads", () => {
		const root = repo({ ".pi/protect.json": '{"read": [' });
		const ctx = context();
		const write = preToolUse(tool(root, "Write", { file_path: join(root, "src/x.ts"), content: "x" }), ctx);
		denied(write.answer, /fix \.pi\/protect\.json first/);
		assert.equal(write.entries[0].rule, "protect-invalid");
		denied(beforeShellExecution(shell(root, "ls"), ctx).answer, /fix \.pi\/protect\.json first/);
		assert.deepEqual(preToolUse(tool(root, "Read", { file_path: join(root, "README.md") }), ctx).answer, { permission: "allow" });
	});

	it("lets tools it does not check through", () => {
		const root = repo();
		const { answer, entries } = preToolUse(tool(root, "MCP:move_agent_to_root", {}), context());
		assert.deepEqual(answer, { permission: "allow" });
		assert.equal(entries[0].rule, "not-checked");
	});
});

describe("cursor adapter: reads", () => {
	it("denies Read and beforeReadFile of a read-protected file; beforeReadFile has no agent_message", () => {
		const root = repo(UNDERTEXT_LIKE);
		const file = join(root, "evals/samples/harness-holdout.jsonl");
		denied(preToolUse(tool(root, "Read", { file_path: file }), context()).answer, /protected by \.pi\/protect\.json \(read: evals\/samples\/\*holdout\*\.jsonl\)/);
		const read = beforeReadFile({ ...common([root], "beforeReadFile"), file_path: file, content: "SECRET-CONTENT" }, context());
		denied(read.answer, /harness-holdout/);
		assert.equal(read.answer.agent_message, undefined);
		assert.deepEqual(read.entries, [{ event: "beforeReadFile", decision: "deny", rule: "protect-read", repo: root, path: file }]);
		assert.deepEqual(beforeReadFile({ ...common([root], "beforeReadFile"), file_path: join(root, "src/x.ts"), content: "x" }, context()).answer, { permission: "allow" });
	});

	it("denies a content Grep that can reach a read-protected file and names it; a narrower search passes (C1, X3)", () => {
		const root = repo(UNDERTEXT_LIKE);
		const ctx = context();
		const grep = (input: Record<string, unknown>) => preToolUse(tool(root, "Grep", { pattern: "SECRET-PATTERN", output_mode: "content", file_path: root, ...input }), ctx);
		denied(grep({}).answer, new RegExp(`search under ${root} can reach evals/samples/harness-holdout\\.jsonl.*narrower path or use a glob`));
		denied(grep({ file_path: join(root, "evals") }).answer, /can reach evals\/samples\/harness-holdout\.jsonl/);
		denied(grep({ file_path: join(root, "evals/samples/harness-holdout.jsonl") }).answer, /protected by \.pi\/protect\.json \(read:/);
		denied(grep({ glob: "*.jsonl" }).answer, /for \*\.jsonl can reach/);
		denied(grep({ glob: "*.{ts,jsonl}" }).answer, /can reach/);
		denied(grep({ file_path: dirname(root) }).answer, /can reach/);
		for (const input of [{ file_path: join(root, "src") }, { glob: "*.ts" }, { glob: "src/**/*.ts" }, { file_path: join(root, "evals"), glob: "train*" }]) {
			assert.deepEqual(grep(input).answer, { permission: "allow" }, JSON.stringify(input));
		}
		const entry = grep({}).entries[0];
		assert.equal(entry.rule, "search-reach");
		assert.ok(!JSON.stringify(entry).includes("SECRET-PATTERN"));
	});

	it("blocks a content Grep without a path, whose reach the hook cannot see, and a glob that leaves the root (X12)", () => {
		const root = repo(UNDERTEXT_LIKE);
		const ctx = context();
		const grep = (input: Record<string, unknown>) => preToolUse(tool(root, "Grep", { output_mode: "content", ...input }), ctx);
		const blind = grep({ pattern: "hello", glob: "**/*.ts" });
		denied(blind.answer, /content search without a path can cover folders the hook cannot see; give the folder to search as file_path/);
		assert.equal(blind.entries[0].rule, "search-without-path");
		for (const glob of ["../other/**", "/Users/someone/dev/other/**", "~/dev/other/**", "src/../../other/*"]) {
			const out = grep({ pattern: "hello", file_path: root, glob });
			denied(out.answer, /reaches outside the search root/);
			assert.equal(out.entries[0].rule, "search-outside-root", glob);
		}
	});

	it("checks a Grep without a path, a file search in the capture, against the roots it can see (C1)", () => {
		const root = repo(UNDERTEXT_LIKE);
		const ctx = context();
		const find = (glob: string) => preToolUse(tool(root, "Grep", { pattern: "", glob, output_mode: "files_with_matches" }), ctx);
		for (const glob of ["**/*.ts", "**/a.txt", "**/cursor-capture-test/**/a.txt"]) assert.deepEqual(find(glob).answer, { permission: "allow" }, glob);
		denied(find("**/*holdout*").answer, /search under the repository root for \*\*\/\*holdout\* can reach evals\/samples\/harness-holdout\.jsonl/);
		denied(find("**/*.jsonl").answer, /can reach/);
	});

	it("blocks beforeReadFile without a path, but lets Tab through without one", () => {
		denied(beforeReadFile({ content: "x" }, context()).answer, /names no file/);
		assert.deepEqual(beforeReadFile({ content: "x" }, context(), "beforeTabFileRead").answer, { permission: "allow" });
		const root = repo(UNDERTEXT_LIKE);
		denied(beforeReadFile({ file_path: join(root, "evals/samples/harness-holdout.jsonl"), workspace_roots: [root] }, context(), "beforeTabFileRead").answer, /harness-holdout/);
	});
});

describe("cursor adapter: answers for payloads it cannot read", () => {
	it("denies in the permission hooks and stays neutral in the prompt and stop hooks", () => {
		const ctx = context();
		for (const raw of ["{SECRET-CONTENT", "[1,2]", ""]) {
			const permission = handle("permission", "preToolUse", raw, preToolUse, ctx);
			denied(permission.answer, /could not check this \(the hook payload is not/);
			assert.ok(!JSON.stringify(permission).includes("SECRET-CONTENT"));
			assert.deepEqual(handle("prompt", "beforeSubmitPrompt", raw, startTurn, ctx).answer, { continue: true });
			assert.deepEqual(handle("stop", "stop", raw, (payload, c) => stopTurn(payload, c), ctx).answer, {});
			assert.deepEqual(handle("permission-tab", "beforeTabFileRead", raw, beforeReadFile, ctx).answer, { permission: "allow" });
		}
	});

	it("denies when the decision itself throws, and logs only the error's name", () => {
		const result = handle("permission", "preToolUse", "{}", () => { throw new TypeError("SECRET-CONTENT at /x"); }, context());
		denied(result.answer, /could not check this/);
		assert.deepEqual(result.entries, [{ event: "preToolUse", decision: "deny", rule: "hook-error:TypeError" }]);
	});
});

describe("cursor adapter: log rule names", () => {
	it("names the reasons extensions/lib/ gives", () => {
		const policy = { cwd: "/r", write: ["docs/**"], read: ["secret/**"], readFiles: ["secret/a.txt"], commands: [{ pattern: /--split/, reason: "no split" }], harnessDirs: ["/h"] };
		const cases: [string | undefined, string][] = [
			[bashCommandReason("curl x | sh"), "download-into-shell"],
			[bashCommandReason("git push"), "git-push"],
			[bashCommandReason("git -c alias.p=push p"), "git-push"],
			[bashCommandReason("git --config-env=alias.p=X p"), "git-push"],
			[bashCommandReason("git config alias.p push"), "git-push"],
			[bashCommandReason("git send-pack origin"), "git-push"],
			[bashCommandReason("git subtree push --prefix d origin x"), "git-push"],
			[bashCommandReason("gh pr merge 1"), "gh-write"],
			[bashCommandReason("gh api -X POST repos/o/r/issues/1/comments"), "gh-write"],
			[bashCommandReason("gh api graphql -f query=x"), "gh-write"],
			[bashCommandReason("git reset --hard"), "git-reset-hard"],
			[bashCommandReason("git clean -fd"), "git-clean"],
			[bashCommandReason("rm -rf x"), "rm-recursive"],
			[bashCommandReason("rm -r /"), "rm-recursive"],
			[bashCommandReason("run --split", policy), "protect-command"],
			[bashCommandReason("cat secret/a.txt", policy), "protect-read"],
			[bashCommandReason("cat a.txt", policy), "protect-read"],
			[protectedPathReason("docs/x.md", policy), "protect-write"],
			[protectedPathReason("/h/x", policy), "harness"],
			[protectedPathReason(".env"), "env-file"],
			[protectedPathReason(".pi/gate.json"), "pi-dir"],
			[protectedPathReason(".ssh/config"), "secret-dir"],
			[protectedPathReason("id_rsa"), "secret-file"],
		];
		for (const [reason, rule] of cases) {
			assert.ok(reason, `a reason for ${rule}`);
			assert.equal(ruleOf(reason), rule, reason);
		}
	});
});

describe("cursor adapter: quality gate", () => {
	const GATE = JSON.stringify({ command: "npm test", maxRepairRounds: 2, timeoutSeconds: 120 });
	const prompt = (root: string, text = "SECRET-PROMPT") => ({ ...common([root], "beforeSubmitPrompt"), prompt: text, attachments: [] });
	const stop = (root: string, loop_count = 0, status = "completed") => ({ ...common([root], "stop"), status, loop_count });

	function runner(results: Partial<CheckRun>[]) {
		const calls: { command: string; cwd: string; timeout: number }[] = [];
		const run = (command: string, cwd: string, timeout: number): CheckRun => {
			calls.push({ command, cwd, timeout });
			return { ok: false, code: 1, timedOut: false, output: "1 failing", seconds: 1, ...(results[calls.length - 1] ?? results.at(-1)) };
		};
		return { run, calls };
	}

	it("never runs in a repository that is not trusted: one log line, no run", () => {
		const root = repo({ ".pi/gate.json": GATE, "src/x.ts": "1\n" });
		const ctx = context();
		const start = startTurn(prompt(root), ctx);
		assert.deepEqual(start.answer, { continue: true });
		assert.deepEqual(start.entries, [{ event: "beforeSubmitPrompt", decision: "skip", rule: "untrusted", repo: root }]);
		write(root, { "src/x.ts": "2\n" });
		const { run, calls } = runner([{ ok: true, code: 0 }]);
		const result = stopTurn(stop(root), ctx, run);
		assert.deepEqual(result.answer, {});
		assert.equal(calls.length, 0);
		assert.equal(result.entries[0].rule, "no-gate-repo");
		assert.deepEqual(readTurn(turnFile(ctx.home, "conv-1"))?.repos, []);
		assert.deepEqual(stopTurn({ ...stop(root), conversation_id: "never-started" }, ctx, run).entries[0].rule, "no-turn-start");
	});

	it("does not run for a turn that changed only docs, or nothing", () => {
		const root = repo({ ".pi/gate.json": GATE });
		const ctx = context();
		trust(ctx.home, root);
		startTurn(prompt(root), ctx);
		const { run, calls } = runner([{ ok: false }]);
		assert.equal(stopTurn(stop(root), ctx, run).entries[0].rule, "no-change");
		write(root, { "docs/plan.md": "# plan\n", "PLAN.md": "x\n" });
		const docs = stopTurn(stop(root), ctx, run);
		assert.deepEqual(docs.answer, {});
		assert.equal(docs.entries[0].rule, "docs-only");
		assert.equal(calls.length, 0);
	});

	it("sends a red check back with nest's repair message, then hands back with an instruction to report when rounds are used up", () => {
		const root = repo({ ".pi/gate.json": GATE, "src/x.ts": "1\n" });
		const ctx = context();
		trust(ctx.home, root);
		startTurn(prompt(root), ctx);
		const { run, calls } = runner([{ ok: false, code: 1, output: "1 failing" }]);
		const config = { command: "npm test", maxRepairRounds: 2, timeoutSeconds: 120 };
		const failed = { ok: false, code: 1, timedOut: false, output: "1 failing" };

		write(root, { "src/x.ts": "2\n" });
		const first = stopTurn(stop(root, 0), ctx, run);
		assert.equal(first.answer.followup_message, repairMessage(config, failed, [], 1));
		assert.match(String(first.answer.followup_message), /^\[quality-gate\] `npm test` failed with exit code 1\. Repair round 1 of 2\./);
		assert.deepEqual(calls[0], { command: "npm test", cwd: root, timeout: 120 });
		assert.deepEqual(first.entries, [{ event: "stop", decision: "repair", repo: root, gate: "red", round: 1, findings: 0, code: 1, seconds: 1 }]);

		// The follow-up may arrive as a prompt (C3); it keeps the turn.
		assert.equal(startTurn(prompt(root, String(first.answer.followup_message)), ctx).entries[0].rule, "gate-followup");
		write(root, { "src/x.ts": "3\n" });
		assert.match(String(stopTurn(stop(root, 1), ctx, run).answer.followup_message), /Repair round 2 of 2\./);

		write(root, { "src/x.ts": "4\n" });
		const last = stopTurn(stop(root, 2), ctx, run);
		assert.equal(last.answer.followup_message, `${handBackMessage(config, failed, [], "still red after 2 repair round(s)")}\n\n${REPORT_INSTRUCTION}`);
		assert.equal(last.entries[0].decision, "final");
		assert.equal(last.entries[0].rule, "rounds-used");

		write(root, { "src/x.ts": "5\n" });
		assert.deepEqual(stopTurn(stop(root, 3), ctx, run).answer, {}, "nothing after the hand-back");
		assert.equal(calls.length, 3);
	});

	it("hands back at once when a repair round changed nothing", () => {
		const root = repo({ ".pi/gate.json": GATE, "src/x.ts": "1\n" });
		const ctx = context();
		trust(ctx.home, root);
		startTurn(prompt(root), ctx);
		const { run, calls } = runner([{ ok: false }]);
		write(root, { "src/x.ts": "2\n" });
		stopTurn(stop(root, 0), ctx, run);
		const unchanged = stopTurn(stop(root, 1), ctx, run);
		assert.match(String(unchanged.answer.followup_message), /still red and the last repair round changed nothing; stopped\. Handing back to the user\./);
		assert.match(String(unchanged.answer.followup_message), new RegExp(REPORT_INSTRUCTION.slice(0, 40)));
		assert.equal(unchanged.entries[0].rule, "unchanged");
		assert.equal(calls.length, 1);
	});

	it("reports a weakened test as a repair round even when the check is green", () => {
		const root = repo({ ".pi/gate.json": GATE, "test/a.test.ts": 'it("works", () => {});\nit("also works", () => {});\n' });
		const ctx = context();
		trust(ctx.home, root);
		startTurn(prompt(root), ctx);
		write(root, { "test/a.test.ts": 'it.skip("works", () => {});\nit("also works", () => {});\n' });
		const { run } = runner([{ ok: true, code: 0, output: "" }]);
		const result = stopTurn(stop(root), ctx, run);
		const message = String(result.answer.followup_message);
		assert.match(message, /^\[quality-gate\] `npm test` passed, but the weakened-test check has \d finding/);
		assert.match(message, /test\/a\.test\.ts:1: skip or focus marker added/);
		assert.ok((result.entries[0].findings ?? 0) >= 1);
	});

	it("stays silent when green, after an aborted turn, and for a subagent's conversation", () => {
		const root = repo({ ".pi/gate.json": GATE, "src/x.ts": "1\n" });
		const ctx = context();
		trust(ctx.home, root);
		startTurn(prompt(root), ctx);
		write(root, { "src/x.ts": "2\n" });
		const { run } = runner([{ ok: true, code: 0 }]);
		assert.deepEqual(stopTurn(stop(root, 0, "aborted"), ctx, run).answer, {});
		assert.deepEqual(stopTurn({ ...stop(root), conversation_id: "subagent-1" }, ctx, run).answer, {});
		const green = stopTurn(stop(root), ctx, run);
		assert.deepEqual(green.answer, {});
		assert.equal(green.entries[0].decision, "green");
	});

	it("hands back an environment problem (exit 127) at once", () => {
		const root = repo({ ".pi/gate.json": GATE, "src/x.ts": "1\n" });
		const ctx = context();
		trust(ctx.home, root);
		startTurn(prompt(root), ctx);
		write(root, { "src/x.ts": "2\n" });
		const result = stopTurn(stop(root), ctx, runner([{ ok: false, code: 127, output: "npm: command not found" }]).run);
		assert.match(String(result.answer.followup_message), /the check command was not found \(exit 127\); fix the environment\. Handing back/);
		assert.equal(result.entries[0].rule, "environment");
	});

	it("gates every trusted root of a multi-root workspace", () => {
		const a = repo({ ".pi/gate.json": GATE, "src/x.ts": "1\n" });
		const b = repo({ ".pi/gate.json": JSON.stringify({ command: "pnpm check", maxRepairRounds: 0 }), "src/y.ts": "1\n" });
		const ctx = context();
		trust(ctx.home, a, b);
		startTurn({ ...prompt(a), workspace_roots: [a, b] }, ctx);
		write(a, { "src/x.ts": "2\n" });
		write(b, { "src/y.ts": "2\n" });
		const result = stopTurn({ ...stop(a), workspace_roots: [a, b] }, ctx, runner([{ ok: false }]).run);
		const message = String(result.answer.followup_message);
		assert.match(message, /`npm test` failed with exit code 1\. Repair round 1 of 2\./);
		assert.match(message, /`pnpm check` failed with exit code 1; still red after 0 repair round\(s\)\. Handing back/);
		assert.ok(message.endsWith(MIXED_INSTRUCTION));
	});

	it("trusts a worktree of a trusted checkout", () => {
		const main = repo({ ".pi/gate.json": GATE });
		const worktree = join(scratch("nest-cursor-wt-"), "feat-x");
		git(main, "worktree", "add", "-q", "-b", "feat-x", worktree);
		const canonicalWorktree = realpathSync(worktree);
		assert.equal(worktreeMain(canonicalWorktree), main);
		assert.ok(isTrusted(canonicalWorktree, [main]));
		assert.ok(!isTrusted(canonicalWorktree, ["/elsewhere"]));
		assert.equal(worktreeMain(main), undefined);
	});

	it("hands back at the last stop Cursor will call, because none follows the last follow-up (X11)", () => {
		const root = repo({ ".pi/gate.json": JSON.stringify({ command: "npm test", maxRepairRounds: 9 }), "src/x.ts": "1\n" });
		const ctx = context();
		trust(ctx.home, root);
		startTurn(prompt(root), ctx);
		const { run } = runner([{ ok: false }]);
		let answers: string[] = [];
		for (let loop = 0; loop < STOP_LOOP_LIMIT; loop++) {
			write(root, { "src/x.ts": `${loop + 2}\n` });
			answers.push(String(stopTurn(stop(root, loop), ctx, run).answer.followup_message ?? ""));
		}
		assert.deepEqual(
			answers.map((answer) => /Repair round (\d) of (\d)/.exec(answer)?.slice(1).join("/") ?? (answer.includes("Handing back") ? "hand-back" : answer)),
			["1/4", "2/4", "3/4", "4/4", "hand-back"],
		);

		// Follow-ups of another stop hook count too: Cursor's loop_count wins over the gate's own count.
		startTurn(prompt(root), ctx);
		write(root, { "src/x.ts": "late\n" });
		answers = [String(stopTurn(stop(root, STOP_LOOP_LIMIT - 1), ctx, run).answer.followup_message)];
		assert.match(answers[0], /still red after 4 repair round\(s\)\. Handing back/);
	});

	it("fits a repository's rounds and timeout into the stop hook's loop_limit and timeout", () => {
		const config = { command: "x", maxRepairRounds: 9, timeoutSeconds: 0, tamperCheck: true, tamperPatterns: [] };
		assert.equal(roundsFor(config), STOP_LOOP_LIMIT - 1);
		assert.equal(roundsFor({ ...config, maxRepairRounds: 2 }), 2);
		assert.equal(timeoutFor(config), STOP_TIMEOUT_SECONDS - STOP_RESERVE_SECONDS);
		assert.equal(timeoutFor({ ...config, timeoutSeconds: 600 }), 600);
	});

	it("runs the check with bash in the repository, the recorded Node first on PATH, and kills it at the timeout", () => {
		const root = scratch();
		const bin = scratch("nest-cursor-node-");
		write(bin, { npm: "#!/bin/sh\necho npm-from-node-dir\n" });
		chmodSync(join(bin, "npm"), 0o755);
		const ok = runCheckCommand("npm && pwd", root, 10, { PATH: "/usr/bin:/bin" }, bin);
		assert.equal(ok.ok, true);
		assert.match(ok.output, new RegExp(`npm-from-node-dir\\n${root}`));
		const red = runCheckCommand("echo out; echo err >&2; exit 3", root, 10, { PATH: "/usr/bin:/bin" }, bin);
		assert.deepEqual([red.ok, red.code, red.output], [false, 3, "out\n\nerr\n"]);
		const slow = runCheckCommand("sleep 5", root, 1, { PATH: "/usr/bin:/bin" }, bin);
		assert.equal(slow.timedOut, true);
		assert.equal(slow.ok, false);
	});

	it("runs the check in an environment where pushes and GitHub writes fail, and keeps the user's own git config entries", () => {
		const root = scratch();
		write(root, { "env.sh": "#!/bin/sh\nenv\nprintf 'helper=[%s]\\n' \"$(git config --get-all credential.helper)\"\nprintf 'name=%s\\n' \"$(git config user.name)\"\n" });
		const env = { PATH: "/usr/bin:/bin", HOME: root, SSH_AUTH_SOCK: "/tmp/agent.sock", GITHUB_TOKEN: "not-a-real-token", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "tester" };
		const run = runCheckCommand("sh env.sh", root, 10, env, NODE_DIR);
		assert.equal(run.ok, true, run.output);
		const seen = new Map(run.output.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
		const expected: Record<string, string> = {
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "/usr/bin/false",
			SSH_ASKPASS: "/usr/bin/false",
			GIT_SSH_COMMAND: "false",
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "user.name",
			GIT_CONFIG_VALUE_0: "tester",
			GIT_CONFIG_KEY_1: "credential.helper",
			GIT_CONFIG_VALUE_1: "",
			GH_TOKEN: GATE_GH_TOKEN,
			helper: "[]",
			name: "tester",
		};
		for (const [name, value] of Object.entries(expected)) assert.equal(seen.get(name), value, name);
		assert.ok(!seen.has("SSH_AUTH_SOCK"), "no SSH agent");
		assert.ok(!seen.has("GITHUB_TOKEN"), "no GitHub token");
		assert.equal(seen.get("PATH"), `${NODE_DIR}:/usr/bin:/bin`);
		const fresh = checkEnvironment({ PATH: "/bin" }, NODE_DIR);
		assert.deepEqual([fresh.GIT_CONFIG_COUNT, fresh.GIT_CONFIG_KEY_0, fresh.GIT_CONFIG_VALUE_0], ["1", "credential.helper", ""]);
	});

	it("logs no prompt, command output or follow-up text", () => {
		const root = repo({ ".pi/gate.json": GATE, "src/x.ts": "1\n" });
		const ctx = context();
		trust(ctx.home, root);
		const entries = [...startTurn(prompt(root), ctx).entries];
		write(root, { "src/x.ts": "2\n" });
		entries.push(...stopTurn(stop(root), ctx, runner([{ ok: false, output: "SECRET-OUTPUT" }]).run).entries);
		const text = JSON.stringify(entries);
		for (const secret of ["SECRET-PROMPT", "SECRET-OUTPUT", "quality-gate", "npm test"]) assert.ok(!text.includes(secret), secret);
	});
});

describe("cursor adapter: repositories that join a turn (X12)", () => {
	const GATE = JSON.stringify({ command: "npm test", maxRepairRounds: 2 });
	const prompt = (roots: string[]) => ({ ...common(roots, "beforeSubmitPrompt"), prompt: "x" });
	const passing = (): CheckRun => ({ ok: false, code: 1, timedOut: false, output: "red", seconds: 0 });

	it("gates the main checkout when workspace_roots still names the worktree and commands run with its cwd", () => {
		const main = repo({ ".pi/gate.json": GATE, "src/x.ts": "1\n" });
		const stale = scratch("nest-cursor-stale-");
		const ctx = context();
		trust(ctx.home, main);
		startTurn(prompt([stale]), ctx);
		const command = { ...tool(stale, "Shell", { command: "npm test", cwd: main, timeout: 30000 }), cwd: main };
		const allowed = joinTurn(preToolUse(command, ctx), command, ctx);
		assert.deepEqual(allowed.answer, { permission: "allow" });
		assert.deepEqual(allowed.entries.at(-1), { event: "preToolUse", decision: "join", repo: main });
		write(main, { "src/x.ts": "2\n" });
		const result = stopTurn({ ...common([stale], "stop"), status: "completed", loop_count: 0 }, ctx, passing);
		assert.match(String(result.answer.followup_message), /Repair round 1 of 2/);
		assert.equal(result.entries[0].repo, main);
	});

	it("gates a repository the hooks cannot see as a root once the agent writes into it, with the baseline from before the write", () => {
		const visible = repo();
		const hidden = repo({ ".pi/gate.json": GATE, "src/y.ts": "1\n", "src/dirty.ts": "before the turn\n" });
		write(hidden, { "src/dirty.ts": "changed before the turn\n" });
		const ctx = context();
		trust(ctx.home, hidden);
		startTurn(prompt([visible]), ctx);
		const payload = tool(visible, "Write", { file_path: join(hidden, "src/y.ts"), content: "2\n" });
		assert.equal(joinTurn(preToolUse(payload, ctx), payload, ctx).entries.at(-1)?.decision, "join");
		assert.equal(joinTurn(preToolUse(payload, ctx), payload, ctx).entries.length, 1, "joins once");
		const { run, calls } = { calls: [] as string[], run: (command: string, cwd: string): CheckRun => (calls.push(cwd), passing()) };
		assert.deepEqual(stopTurn({ ...common([visible], "stop"), status: "completed", loop_count: 0 }, ctx, run).answer, {}, "nothing changed since the join");
		write(hidden, { "src/y.ts": "2\n" });
		assert.match(String(stopTurn({ ...common([visible], "stop"), status: "completed", loop_count: 0 }, ctx, run).answer.followup_message), /Repair round 1/);
		assert.deepEqual(calls, [hidden]);
	});

	it("joins nothing for a denied action, an untrusted or ungated repository, or a conversation without a turn", () => {
		const visible = repo();
		const untrusted = repo({ ".pi/gate.json": GATE });
		const plain = repo();
		const ctx = context();
		startTurn(prompt([visible]), ctx);
		const write1 = tool(visible, "Write", { file_path: join(untrusted, "a.ts"), content: "x" });
		assert.deepEqual(joinTurn(preToolUse(write1, ctx), write1, ctx).entries.at(-1), { event: "preToolUse", decision: "skip", rule: "untrusted", repo: untrusted });
		assert.equal(joinTurn(preToolUse(write1, ctx), write1, ctx).entries.length, 1, "looked at once");
		const write2 = tool(visible, "Write", { file_path: join(plain, "a.ts"), content: "x" });
		assert.equal(joinTurn(preToolUse(write2, ctx), write2, ctx).entries.length, 1, "an ungated repository joins silently as passed");
		const denied1 = tool(visible, "Write", { file_path: join(untrusted, ".pi/gate.json"), content: "x" });
		assert.equal(joinTurn(preToolUse(denied1, ctx), denied1, ctx).answer.permission, "deny");
		const subagent = { ...tool(visible, "Write", { file_path: join(untrusted, "b.ts"), content: "x" }), conversation_id: "subagent-1", parent_agent_id: "conv-1" };
		assert.equal(joinTurn(preToolUse(subagent, ctx), subagent, ctx).entries.length, 1);
		const state = readTurn(turnFile(ctx.home, "conv-1"));
		assert.deepEqual(state?.repos, []);
		assert.deepEqual(state?.passed?.sort(), [plain, untrusted, visible].sort());
	});

	it("takes a command's own cwd before workspace_roots", () => {
		const main = repo(UNDERTEXT_LIKE);
		const stale = repo();
		assert.deepEqual(workspaceRoots({ cwd: main, workspace_roots: [stale] }, {}), [main, stale]);
		denied(beforeShellExecution({ ...shell(stale, "cat evals/samples/harness-holdout.jsonl"), cwd: main }, context()).answer, /harness-holdout/);
	});
});

describe("cursor adapter: entry scripts as processes", () => {
	/** A scratch HOME with the recorded Node, and a PATH without Node, as a GUI app may give. */
	function home(node: string | null = process.execPath) {
		const dir = scratch("nest-cursor-proc-");
		if (node) write(dir, { ".config/pecker-nest/cursor-node": `${node}\n` });
		return dir;
	}
	const hook = (dir: string, script: string, input: string) =>
		spawnSync(NODE_SH, [script], { input, encoding: "utf-8", cwd: join(dir), env: { HOME: dir, PATH: "/usr/bin:/bin" } });

	const SCRIPTS: [string, string, Record<string, unknown>][] = [
		["hooks/before-shell-execution.ts", "permission", { command: "git push", cwd: "" }],
		["hooks/pre-tool-use.ts", "permission", { tool_name: "Write", tool_input: { file_path: "/Users/someone/dev/demo/.pi/gate.json", content: "x" } }],
		["hooks/before-read-file.ts", "permission", { file_path: "/Users/someone/.ssh/id_rsa", content: "x" }],
		["hooks/before-tab-file-read.ts", "tab", { file_path: "/Users/someone/dev/demo/a.txt", content: "x" }],
		["hooks/before-submit-prompt.ts", "prompt", { prompt: "x" }],
		["hooks/stop.ts", "stop", { status: "completed", loop_count: 0 }],
	];

	it("each script answers on stdout with exit code 0 and appends to the log", () => {
		const dir = home();
		for (const [script, kind, payload] of SCRIPTS) {
			const run = hook(dir, script, JSON.stringify({ ...common(["/Users/someone/dev/demo"], "x"), ...payload }));
			assert.equal(run.status, 0, `${script}: ${run.stderr}`);
			const answer = JSON.parse(run.stdout);
			if (kind === "permission" && script !== "hooks/before-read-file.ts") denied(answer, /./);
			if (script === "hooks/before-read-file.ts") assert.equal(answer.permission, "allow", "~/.ssh is a write rule, not a read rule");
			if (kind === "tab") assert.deepEqual(answer, { permission: "allow" });
			if (kind === "prompt") assert.deepEqual(answer, { continue: true });
			if (kind === "stop") assert.deepEqual(answer, {});
		}
		const log = readFileSync(join(dir, ".local/state/pecker-nest/cursor/log.jsonl"), "utf-8").trim().split("\n");
		assert.equal(log.length, SCRIPTS.length);
		for (const line of log) assert.ok(JSON.parse(line).time);
	});

	it("blocks a malformed payload in the three failClosed hooks and passes it in the others", () => {
		const dir = home();
		for (const [script, kind] of SCRIPTS) {
			const run = hook(dir, script, "{SECRET-CONTENT");
			assert.equal(run.status, 0, run.stderr);
			const answer = JSON.parse(run.stdout);
			if (kind === "permission") denied(answer, /not valid JSON/);
			else assert.notEqual(answer.permission, "deny", script);
		}
		assert.ok(!readFileSync(join(dir, ".local/state/pecker-nest/cursor/log.jsonl"), "utf-8").includes("SECRET-CONTENT"));
	});

	it("answers deny with the fix when the recorded Node is gone, for the permission hooks only", () => {
		for (const dir of [home(null), home("/nonexistent/node")]) {
			for (const [script, kind] of SCRIPTS) {
				const run = hook(dir, script, "{}");
				assert.match(run.stderr, /pecker-nest: .*link\.sh --cursor again/);
				if (kind === "permission") {
					assert.equal(run.status, 0);
					denied(JSON.parse(run.stdout), /cannot start Node.*link\.sh --cursor again/);
					if (script === "hooks/before-read-file.ts") assert.equal(JSON.parse(run.stdout).agent_message, undefined);
				} else {
					assert.equal(run.status, 1, script);
					assert.equal(run.stdout, "");
				}
			}
		}
	});
});

describe("cursor/hooks.json", () => {
	const template = JSON.parse(readFileSync(TEMPLATE, "utf-8")) as { version: number; hooks: Record<string, Record<string, unknown>[]> };

	it("makes the three permission hooks fail closed and nothing else", () => {
		assert.equal(template.version, 1);
		const closed = Object.entries(template.hooks).filter(([, entries]) => entries.some((entry) => entry.failClosed === true)).map(([event]) => event);
		assert.deepEqual(closed.sort(), ["beforeReadFile", "beforeShellExecution", "preToolUse"]);
		assert.deepEqual(Object.keys(template.hooks).sort(), ["beforeReadFile", "beforeShellExecution", "beforeSubmitPrompt", "beforeTabFileRead", "preToolUse", "stop"]);
	});

	it("matches the tools cursor/lib checks and agrees with the stop hook's constants", () => {
		assert.equal(template.hooks.preToolUse[0].matcher, PRE_TOOL_USE_MATCHER);
		assert.equal(template.hooks.stop[0].loop_limit, STOP_LOOP_LIMIT);
		assert.equal(template.hooks.stop[0].timeout, STOP_TIMEOUT_SECONDS);
	});

	it("starts every hook through node.sh with a script that exists", () => {
		for (const entries of Object.values(template.hooks)) {
			for (const { command } of entries) {
				const match = /^@NEST_DIR@\/cursor\/node\.sh (hooks\/[a-z-]+\.ts)$/.exec(String(command));
				assert.ok(match, String(command));
				assert.ok(existsSync(join(NEST, "cursor", match[1])), match[1]);
			}
		}
	});
});

describe("scripts/link.sh --cursor", () => {
	function scratchHome(): string {
		const dir = scratch("nest-cursor-link-");
		mkdirSync(join(dir, "dev"));
		symlinkSync(NEST, join(dir, "dev", "pecker-nest"));
		return dir;
	}
	const link = (dir: string, args: string[], path = `${NODE_DIR}:/usr/bin:/bin`) => spawnSync(LINK, args, { encoding: "utf-8", env: { HOME: dir, PATH: path, PI_CODING_AGENT_DIR: join(dir, "pi-agent") } });

	it("installs hooks, reviewer and the three skills, backs up an earlier hooks.json, and --check agrees", () => {
		const dir = scratchHome();
		write(dir, { ".cursor/hooks.json": '{"version":1,"hooks":{}}\n' });
		assert.equal(link(dir, ["--check", "--cursor"]).status, 1);
		const run = link(dir, ["--cursor"]);
		assert.equal(run.status, 0, run.stdout + run.stderr);
		assert.equal(readFileSync(join(dir, ".cursor/hooks.json"), "utf-8"), readFileSync(TEMPLATE, "utf-8").replaceAll("@NEST_DIR@", NEST));
		assert.equal(readdirSync(join(dir, ".cursor")).filter((name) => name.startsWith("hooks.json.bak.")).length, 1);
		assert.equal(readlinkSync(join(dir, ".cursor/agents/reviewer.md")), join(NEST, "cursor/agents/reviewer.md"));
		assert.deepEqual(readdirSync(join(dir, ".agents/skills")).sort(), ["grill-me", "testing-py", "testing-ts"]);
		for (const name of ["grill-me", "testing-ts", "testing-py"]) assert.equal(readlinkSync(join(dir, ".agents/skills", name)), join(NEST, "skills", name));
		assert.ok(!existsSync(join(dir, ".agents/skills/best-practices")), "best-practices needs the knowledge base");
		assert.ok(existsSync(join(dir, ".cursor/skills/nest-supervise")), "--cursor still links the supervision skills");
		assert.match(run.stdout, /cursor-trust\.sh add <repo>/);
		const again = link(dir, ["--cursor"]);
		assert.equal(again.status, 0);
		assert.doesNotMatch(again.stdout, /^(linked|backup|wrote)/m);
		const check = link(dir, ["--check", "--cursor"]);
		assert.equal(check.status, 0, check.stdout);
		assert.match(check.stdout, /^ok {6}.*hooks\.json \(adapter\)$/m);
	});

	it("records the resolved Node, not fnm's per-shell link", () => {
		const dir = scratchHome();
		const multishell = join(dir, ".local/state/fnm_multishells/4242_1700000000000/bin");
		mkdirSync(multishell, { recursive: true });
		symlinkSync(process.execPath, join(multishell, "node"));
		const run = link(dir, ["--cursor"], `${multishell}:/usr/bin:/bin`);
		assert.equal(run.status, 0, run.stderr);
		const recorded = readFileSync(join(dir, ".config/pecker-nest/cursor-node"), "utf-8").trim();
		assert.equal(recorded, realpathSync(process.execPath));
		assert.doesNotMatch(recorded, /fnm_multishells/);
	});

	it("leaves foreign skills in ~/.agents/skills alone and reports them", () => {
		const dir = scratchHome();
		write(dir, { ".agents/skills/testing-ts/SKILL.md": "mine\n" });
		const run = link(dir, ["--cursor"]);
		assert.equal(run.status, 1);
		assert.match(run.stdout, /^foreign .*\.agents\/skills\/testing-ts/m);
		assert.equal(readFileSync(join(dir, ".agents/skills/testing-ts/SKILL.md"), "utf-8"), "mine\n");
	});

	it("does not let --cursor-capture-off remove the adapter", () => {
		const dir = scratchHome();
		assert.equal(link(dir, ["--cursor"]).status, 0);
		const off = link(dir, ["--cursor-capture-off"]);
		assert.equal(off.status, 1);
		assert.match(off.stderr, /not the capture hook/);
		assert.ok(existsSync(join(dir, ".cursor/hooks.json")));
	});
});

describe("scripts/cursor-trust.sh", () => {
	const trustCmd = (dir: string, ...args: string[]) => spawnSync(TRUST, args, { encoding: "utf-8", cwd: dir, env: { HOME: dir, PATH: "/usr/bin:/bin" } });

	it("adds canonical paths once, lists and removes them", () => {
		const dir = scratch("nest-cursor-trust-");
		const root = repo({ ".pi/gate.json": "{}" });
		const other = repo();
		symlinkSync(root, join(dir, "link-to-root"));
		assert.match(trustCmd(dir, "list").stdout, /No repository is trusted/);
		assert.match(trustCmd(dir, "add", join(dir, "link-to-root")).stdout, new RegExp(`^trusted ${root}$`, "m"));
		assert.match(trustCmd(dir, "add", root).stdout, /already trusted/);
		const added = trustCmd(other, "add");
		assert.match(added.stdout, /has no \.pi\/gate\.json yet/);
		assert.equal(readFileSync(join(dir, ".config/pecker-nest/cursor-trusted"), "utf-8"), `${root}\n`);
		assert.equal(readFileSync(join(other, ".config/pecker-nest/cursor-trusted"), "utf-8"), `${other}\n`, "HOME is the cwd in this test");
		assert.equal(trustCmd(dir, "list").stdout, `${root}\n`);
		assert.equal(trustCmd(dir, "remove", root).status, 0);
		assert.equal(readFileSync(join(dir, ".config/pecker-nest/cursor-trusted"), "utf-8"), "");
		assert.equal(trustCmd(dir, "remove", root).status, 1);
	});

	it("refuses what is not a directory and unknown arguments", () => {
		const dir = scratch("nest-cursor-trust-");
		assert.equal(trustCmd(dir, "add", join(dir, "missing")).status, 1);
		assert.equal(trustCmd(dir).status, 2);
		assert.equal(trustCmd(dir, "nope").status, 2);
		assert.equal(trustCmd(dir, "add", "a", "b").status, 2);
	});

	it("is what the gate reads", () => {
		const dir = scratch("nest-cursor-trust-");
		const root = repo();
		trustCmd(dir, "add", root);
		assert.ok(isTrusted(root, readFileSync(join(dir, ".config/pecker-nest/cursor-trusted"), "utf-8").trim().split("\n")));
	});
});
