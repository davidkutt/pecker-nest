/**
 * The parts of extensions/lib/ the Cursor adapter added: what counts as the harness
 * (lib/harness.ts), harness files and exceptions in PathPolicy, the search rule for tools without
 * output redaction, and the gate messages both Pi and Cursor send. Pi's behaviour stays as it was:
 * without the new policy fields nothing changes.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { describeRed, handBackMessage, handBackReason, repairMessage, unchangedFindingsMessage } from "../extensions/lib/gate-message.ts";
import { CURSOR_HARNESS_FILES, cursorHarnessDirs, cursorHarnessExceptions, harnessDirs, harnessScriptReason } from "../extensions/lib/harness.ts";
import { type PathPolicy, protectedPathReason, searchReadReason } from "../extensions/lib/safety-rules.ts";

const same = (path: string) => path;

describe("harnessDirs", () => {
	it("is nest's three directories, as safety-gate.ts had them", () => {
		assert.deepEqual(harnessDirs({ nestDir: "/n", home: "/h", env: {}, canonical: same }), ["/n", "/h/.pi/agent", "/h/.claude"]);
		assert.deepEqual(harnessDirs({ nestDir: "/n", home: "/h", env: { PI_CODING_AGENT_DIR: "/pi", CLAUDE_CONFIG_DIR: "/cc" }, canonical: same }), ["/n", "/pi", "/cc"]);
	});

	it("adds Cursor's user directory and the adapter's config and state for Cursor, minus the worktrees", () => {
		assert.deepEqual(cursorHarnessDirs({ nestDir: "/n", home: "/h", env: {}, canonical: same }), [
			"/n",
			"/h/.pi/agent",
			"/h/.claude",
			"/h/.cursor",
			"/h/.config/pecker-nest",
			"/h/.local/state/pecker-nest",
		]);
		assert.deepEqual(cursorHarnessExceptions({ home: "/h", canonical: same }), ["/h/.cursor/worktrees"]);
	});
});

describe("PathPolicy harness files, exceptions and agent name", () => {
	const pi: PathPolicy = { cwd: "/r", write: [], read: [], harnessDirs: ["/h/.cursor"] };
	const cursor: PathPolicy = { ...pi, harnessFiles: CURSOR_HARNESS_FILES, harnessExceptions: ["/h/.cursor/worktrees"], agent: "Cursor" };

	it("leaves Pi's policy as it was", () => {
		assert.equal(protectedPathReason("/r/.cursorignore", pi), undefined);
		assert.equal(protectedPathReason("/h/.cursor/worktrees/r/b/x.ts", pi), "/h/.cursor/worktrees/r/b/x.ts is part of the agent harness (/h/.cursor); change the harness outside pi");
	});

	it("protects Cursor's configuration files wherever they are", () => {
		for (const path of ["/r/.cursorignore", "/r/.cursor/hooks.json", "/r/sub/.cursor/hooks/run.sh", "/r/.claude/settings.json", "/r/.claude/settings.local.json", ".cursorignore"]) {
			assert.match(protectedPathReason(path, cursor) ?? "", /configures the agent harness \(\*\*\/.*\); change it outside Cursor$/, path);
		}
		for (const path of ["/r/.cursor/rules/x.mdc", "/r/cursorignore.md", "/r/.claude/skills/x/SKILL.md"]) assert.equal(protectedPathReason(path, cursor), undefined, path);
	});

	it("carves the worktrees out of the harness, but not their configuration files", () => {
		assert.equal(protectedPathReason("/h/.cursor/worktrees/r/b/src/x.ts", cursor), undefined);
		assert.match(protectedPathReason("/h/.cursor/worktrees/r/b/.cursor/hooks.json", cursor) ?? "", /configures the agent harness/);
		assert.match(protectedPathReason("/h/.cursor/hooks.json", cursor) ?? "", /part of the agent harness \(\/h\/\.cursor\); change the harness outside Cursor/);
		assert.match(protectedPathReason("/h/.cursor/worktrees-not/x", cursor) ?? "", /part of the agent harness/);
	});
});

describe("harnessScriptReason", () => {
	const options = { nestDir: "/h/dev/pecker-nest", cwd: "/r", home: "/h", canonical: same };

	it("blocks link.sh of this checkout and cursor-trust.sh anywhere", () => {
		for (const command of [
			"/h/dev/pecker-nest/scripts/link.sh --cursor-capture",
			"~/dev/pecker-nest/scripts/link.sh",
			"bash $HOME/dev/pecker-nest/scripts/link.sh --cursor",
			"cd /x && ../h/dev/pecker-nest/scripts/cursor-trust.sh add .",
			"scripts/cursor-trust.sh add /r",
		]) {
			assert.match(harnessScriptReason(command, options) ?? "", /installs or configures the agent harness; the user runs it$/, command);
		}
	});

	it("lets other scripts named link.sh through", () => {
		assert.equal(harnessScriptReason("./scripts/link.sh", options), undefined);
		assert.equal(harnessScriptReason("npm run link", options), undefined);
		assert.equal(harnessScriptReason("scripts/link.sh", { ...options, cwd: "/h/dev/pecker-nest" }) !== undefined, true, "relative to the checkout it is the harness script");
	});
});

describe("searchReadReason", () => {
	const policy: PathPolicy = {
		cwd: "/r",
		write: [],
		read: ["evals/samples/*holdout*.jsonl", "secret/**"],
		readFiles: ["evals/samples/harness-holdout.jsonl", "secret/key.txt"],
		harnessDirs: [],
	};

	it("blocks a search that covers a read-protected file and names it", () => {
		const cases: [string | undefined, string | undefined, string][] = [
			[undefined, undefined, "evals/samples/harness-holdout.jsonl"],
			["/r", undefined, "evals/samples/harness-holdout.jsonl"],
			["/r/evals", undefined, "evals/samples/harness-holdout.jsonl"],
			["evals/samples", "*.jsonl", "evals/samples/harness-holdout.jsonl"],
			["/r", "**/*holdout*", "evals/samples/harness-holdout.jsonl"],
			["/r", "evals/samples/*.jsonl", "evals/samples/harness-holdout.jsonl"],
			["/r/evals", "samples/*.jsonl", "evals/samples/harness-holdout.jsonl"],
			["/r", "*.{ts,jsonl}", "evals/samples/harness-holdout.jsonl"],
			["/r", "!*.ts", "evals/samples/harness-holdout.jsonl"],
			["/", undefined, "evals/samples/harness-holdout.jsonl"],
			["/r/secret", undefined, "secret/key.txt"],
		];
		for (const [root, glob, hit] of cases) {
			const reason = searchReadReason(root, glob, policy) ?? "";
			assert.ok(reason.includes(hit), `${root} ${glob}: ${reason}`);
		}
		assert.match(searchReadReason(undefined, undefined, policy) ?? "", /^a search under the repository root can reach .*; search a narrower path or use a glob that leaves it out$/);
	});

	it("blocks a glob that points out of the search root, whatever is protected", () => {
		for (const glob of ["../other/**", "a/../../b/*", "/etc/**", "~/dev/x/**", "$HOME/x/*"]) {
			assert.equal(searchReadReason("/r/src", glob, { ...policy, read: [], readFiles: [] }), `the glob ${glob} reaches outside the search root; search that folder by its path instead`, glob);
		}
		assert.equal(searchReadReason("/r/src", "a..b/*.ts", policy), undefined, "two dots inside a name are no step up");
	});

	it("blocks a search rooted at a protected path with the read rule's own reason", () => {
		assert.equal(searchReadReason("/r/secret/key.txt", undefined, policy), "secret/key.txt is protected by .pi/protect.json (read: secret/**)");
	});

	it("lets a search through that cannot reach one", () => {
		const cases: [string | undefined, string | undefined][] = [
			["/r/src", undefined],
			["/r", "*.ts"],
			["/r/evals", "train*"],
			["/r", "src/**"],
			["/elsewhere", undefined],
		];
		for (const [root, glob] of cases) assert.equal(searchReadReason(root, glob, policy), undefined, `${root} ${glob}`);
		assert.equal(searchReadReason("/r", undefined, { ...policy, readFiles: [] }), undefined, "nothing protected exists yet");
		assert.equal(searchReadReason("/r", undefined, { ...policy, read: [], readFiles: [] }), undefined);
	});

	it("expands ~ like the other rules", () => {
		assert.ok(searchReadReason("~", undefined, { ...policy, cwd: join(homedir(), "r") }));
	});
});

describe("gate messages", () => {
	const config = { command: "npm test", timeoutSeconds: 60, maxRepairRounds: 2 };
	const red = { ok: false, code: 1, timedOut: false, output: "1 failing" };
	const finding = { kind: "skip" as const, path: "a.test.ts", line: 3, detail: "skip or focus marker added: .skip" };

	it("start with the line the router and the session report read", () => {
		assert.match(repairMessage(config, red, [], 1), /^\[quality-gate\] `npm test` failed with exit code 1\. Repair round 1 of 2\.\nFix the cause/);
		assert.match(repairMessage(config, { ...red, ok: true, code: 0 }, [finding], 2), /^\[quality-gate\] `npm test` passed, but the weakened-test check has 1 finding\. Repair round 2 of 2\.\nThe changes since/);
		assert.match(handBackMessage(config, red, [finding], handBackReason(red, 2)), /^\[quality-gate\] `npm test` failed with exit code 1, and the weakened-test check has 1 finding; still red after 2 repair round\(s\)\. Handing back to the user\.\n\n- a\.test\.ts:3: /);
		assert.match(handBackMessage(config, { ...red, code: 127 }, [], handBackReason({ ...red, code: 127 }, 0)), /the check command was not found \(exit 127\); fix the environment\. Handing back/);
		assert.equal(unchangedFindingsMessage([finding]), "[quality-gate] 1 finding of the weakened-test check remains after the last round, which changed nothing. Handing back to the user.\n\n- a.test.ts:3: skip or focus marker added: .skip");
		assert.equal(describeRed(config, { ...red, timedOut: true }, []), "`npm test` timed out after 60s");
	});

	it("carry the check's output only when it failed", () => {
		assert.match(repairMessage(config, red, [], 1), /\n\n```\n1 failing\n```$/);
		assert.doesNotMatch(repairMessage(config, { ...red, ok: true, code: 0, output: "all good" }, [finding], 1), /all good/);
		assert.match(repairMessage(config, { ...red, output: "" }, [], 1), /\(no output\)/);
	});
});
