/**
 * The Cursor capture hook of docs/research/cursor-hooks.md: what a log line holds and what it never
 * holds, that every event is let through, and the install path through scripts/link.sh. HOME is a
 * scratch directory with ~/dev/pecker-nest pointing at this checkout; Cursor itself is not needed.
 * Payloads follow the shapes in cursor.com/docs/hooks (read 16.11.2026) with invented paths, plus
 * marker strings that must never reach the log.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { allowAnswer, capture, followupRounds, PERMISSION_HOOKS, type Shape, shapeOf, stopTestAnswer } from "../cursor/capture/capture.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_SH = join(NEST, "cursor/node.sh");
const PROBE = join(NEST, "cursor/capture/probe.sh");
const TEMPLATE = join(NEST, "cursor/capture/hooks.json");
const LINK = join(NEST, "scripts/link.sh");
const NODE_DIR = dirname(process.execPath);

/** Every hook name in cursor.com/docs/hooks, read 16.11.2026. */
const DOCUMENTED_HOOKS = new Set([
	"sessionStart",
	"sessionEnd",
	"preToolUse",
	"postToolUse",
	"postToolUseFailure",
	"subagentStart",
	"subagentStop",
	"beforeShellExecution",
	"afterShellExecution",
	"beforeMCPExecution",
	"afterMCPExecution",
	"beforeReadFile",
	"afterFileEdit",
	"beforeSubmitPrompt",
	"preCompact",
	"stop",
	"afterAgentResponse",
	"afterAgentThought",
	"beforeTabFileRead",
	"afterTabFileEdit",
	"workspaceOpen",
]);

const SECRETS = ["SECRET-CONTENT", "SECRET-PROMPT", "SECRET-COMMAND", "SECRET-OUTPUT", "SECRET-PATTERN", "SECRET-ANSWER", "SECRET-URL", "someone@example.com"];

const COMMON = {
	conversation_id: "conv-1",
	generation_id: "gen-1",
	model: "grok-4.7-high",
	cursor_version: "3.28.7",
	workspace_roots: ["/Users/someone/dev/demo"],
	user_email: "someone@example.com",
	transcript_path: "/Users/someone/.cursor/projects/demo/agent-transcripts/conv-1.txt",
};

const PAYLOADS: Record<string, Record<string, unknown>> = {
	preToolUse: {
		...COMMON,
		hook_event_name: "preToolUse",
		tool_name: "Write",
		tool_input: { file_path: "/Users/someone/dev/demo/b.txt", content: "SECRET-CONTENT" },
		tool_use_id: "tool-1",
		cwd: "",
	},
	beforeSubmitPrompt: { ...COMMON, hook_event_name: "beforeSubmitPrompt", prompt: "SECRET-PROMPT", attachments: [{ type: "file", file_path: "/Users/someone/dev/demo/a.txt" }] },
	beforeShellExecution: { ...COMMON, hook_event_name: "beforeShellExecution", command: "echo SECRET-COMMAND", cwd: "", sandbox: true },
	afterShellExecution: { ...COMMON, hook_event_name: "afterShellExecution", command: "echo SECRET-COMMAND", output: "SECRET-OUTPUT\n", duration: 12, sandbox: true },
	beforeReadFile: { ...COMMON, hook_event_name: "beforeReadFile", file_path: "/Users/someone/dev/demo/a.txt", content: "SECRET-CONTENT", attachments: [] },
	beforeMCPExecution: { ...COMMON, hook_event_name: "beforeMCPExecution", tool_name: "search", tool_input: '{"q":"SECRET-PATTERN"}', mcp_server_name: "kb", url: "https://mcp.example.com/SECRET-URL" },
	afterAgentResponse: { ...COMMON, hook_event_name: "afterAgentResponse", text: "SECRET-ANSWER" },
	subagentStart: { ...COMMON, hook_event_name: "subagentStart", subagent_id: "sub-1", subagent_type: "generalPurpose", task: "SECRET-PROMPT", subagent_model: "grok-4.7-high", is_parallel_worker: false },
	stop: { ...COMMON, hook_event_name: "stop", status: "completed", loop_count: 0 },
	grep: {
		...COMMON,
		hook_event_name: "preToolUse",
		tool_name: "Grep",
		tool_input: { pattern: "SECRET-PATTERN", path: "/Users/someone/dev/demo/src", glob: "*.ts", outputMode: "content" },
	},
};

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "nest-cursor-capture-"));
	dirs.push(dir);
	return dir;
}

/** A scratch HOME with ~/dev/pecker-nest pointing at this checkout, as link.sh requires. */
function scratchHome(): string {
	const home = scratch();
	mkdirSync(join(home, "dev"));
	symlinkSync(NEST, join(home, "dev", "pecker-nest"));
	return home;
}

function logLines(home: string): Record<string, unknown>[] {
	const file = join(home, ".local/state/pecker-nest/cursor/capture.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertNoSecrets(text: string) {
	for (const secret of SECRETS) assert.ok(!text.includes(secret), `the log must not contain ${secret}`);
}

function keys(shape: Shape | undefined): Record<string, Shape> {
	assert.equal(shape?.type, "object");
	return (shape as { keys: Record<string, Shape> }).keys;
}

describe("capture: what a log line holds", () => {
	it("keeps paths, ids and enumerations and reduces every other string to its length", () => {
		const { record } = capture("preToolUse", JSON.stringify(PAYLOADS.preToolUse));
		assert.equal(record.event, "preToolUse");
		const payload = keys(record.payload);
		assert.deepEqual(payload.conversation_id, { type: "string", length: 6, value: "conv-1" });
		assert.deepEqual(payload.tool_name, { type: "string", length: 5, value: "Write" });
		assert.deepEqual(payload.workspace_roots, { type: "array", length: 1, value: ["/Users/someone/dev/demo"] });
		assert.deepEqual(payload.user_email, { type: "string", length: 19 });
		const input = keys(payload.tool_input);
		assert.deepEqual(input.file_path, { type: "string", length: 29, value: "/Users/someone/dev/demo/b.txt" });
		assert.deepEqual(input.content, { type: "string", length: 14 });
		assert.deepEqual(payload.cwd, { type: "string", length: 0, value: "" });
	});

	it("never logs file contents, prompts, commands, output, URLs, answers or the e-mail address", () => {
		for (const [name, payload] of Object.entries(PAYLOADS)) {
			const hook = String(payload.hook_event_name);
			const { record } = capture(hook, JSON.stringify(payload));
			assertNoSecrets(JSON.stringify(record));
			assert.ok(record.payload, `${name} has a shape`);
		}
	});

	it("shows where a search looks without the search pattern", () => {
		const input = keys(keys(capture("preToolUse", JSON.stringify(PAYLOADS.grep)).record.payload).tool_input);
		assert.deepEqual(input.pattern, { type: "string", length: 14 });
		assert.equal((input.path as { value?: string }).value, "/Users/someone/dev/demo/src");
		assert.equal((input.glob as { value?: string }).value, "*.ts");
		assert.deepEqual(input.outputMode, { type: "string", length: 7 });
	});

	it("keeps paths inside arrays of objects and in camelCase fields", () => {
		const attachments = keys(capture("beforeSubmitPrompt", JSON.stringify(PAYLOADS.beforeSubmitPrompt)).record.payload).attachments as { items?: Shape[] };
		const first = keys(attachments.items?.[0]);
		assert.equal((first.file_path as { value?: string }).value, "/Users/someone/dev/demo/a.txt");
		assert.equal((first.type as { value?: string }).value, "file");
		assert.equal((keys(shapeOf({ filePath: "/a/b" })).filePath as { value?: string }).value, "/a/b");
		assert.equal((keys(shapeOf({ targetDirectory: "/a" })).targetDirectory as { value?: string }).value, "/a");
	});

	it("drops a multi-line value even in a path field", () => {
		assert.deepEqual(shapeOf("line one\nSECRET-CONTENT", "file_path"), { type: "string", length: 23 });
	});

	it("records a payload that is not JSON, or not an object, and still lets the action through", () => {
		const broken = capture("beforeShellExecution", "{not json");
		assert.equal(broken.record.parseError, "not valid JSON");
		assert.deepEqual(broken.answer, { permission: "allow" });
		const list = capture("preToolUse", "[1,2]");
		assert.match(list.record.parseError ?? "", /array/);
		assert.deepEqual(list.answer, { permission: "allow" });
		const empty = capture("stop", "");
		assert.equal(empty.record.bytes, 0);
		assert.deepEqual(empty.answer, {});
	});

	it("strips a byte order mark before parsing", () => {
		assert.equal(capture("stop", `﻿${JSON.stringify(PAYLOADS.stop)}`).record.parseError, undefined);
	});
});

describe("capture: answers", () => {
	it("allows every permission hook, continues every prompt and answers nothing elsewhere", () => {
		for (const hook of PERMISSION_HOOKS) assert.deepEqual(allowAnswer(hook), { permission: "allow" });
		assert.deepEqual(allowAnswer("beforeSubmitPrompt"), { continue: true });
		for (const hook of ["stop", "sessionStart", "afterFileEdit", "workspaceOpen", "unknown"]) assert.deepEqual(allowAnswer(hook), {});
		for (const [name, payload] of Object.entries(PAYLOADS)) {
			const hook = String(payload.hook_event_name);
			assert.deepEqual(capture(hook, JSON.stringify(payload)).answer, allowAnswer(hook), name);
		}
	});

	it("sends follow-ups on stop only while the test switch says so", () => {
		assert.equal(followupRounds(undefined), undefined);
		for (const text of ["", "0", "11", "x", "1.5"]) assert.equal(followupRounds(text), undefined, text);
		assert.equal(followupRounds("2\n"), 2);

		const at = (loop_count: number, status = "completed") => stopTestAnswer({ status, loop_count }, 2);
		assert.equal(at(0).round, 1);
		assert.match(String(at(0).answer.followup_message), /follow-up 1 of 2/);
		assert.equal(at(1).round, 2);
		assert.equal(at(2).answer.followup_message, undefined);
		assert.match(String(at(2).answer.user_message), /no further follow-up \(loop_count 2\)/);
		assert.deepEqual(at(0, "aborted").answer, {});

		const off = capture("stop", JSON.stringify(PAYLOADS.stop));
		assert.deepEqual(off.answer, {});
		const on = capture("stop", JSON.stringify(PAYLOADS.stop), { followups: "1" });
		assert.equal(on.record.answered, "followup");
		assert.equal(on.record.followup, 1);
		assert.deepEqual(capture("preToolUse", JSON.stringify(PAYLOADS.preToolUse), { followups: "1" }).answer, { permission: "allow" });
	});
});

describe("capture as a process", () => {
	function recordNode(home: string, node = process.execPath) {
		mkdirSync(join(home, ".config/pecker-nest"), { recursive: true });
		writeFileSync(join(home, ".config/pecker-nest/cursor-node"), `${node}\n`);
	}

	function hook(home: string, event: string, input: string) {
		// PATH without Node, as a GUI app might pass it: node.sh must not need it.
		return spawnSync(NODE_SH, ["capture/capture.ts", event], { input, encoding: "utf-8", cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" } });
	}

	it("runs through cursor/node.sh without Node on PATH, allows and appends one line", () => {
		const home = scratch();
		recordNode(home);
		const run = hook(home, "preToolUse", JSON.stringify(PAYLOADS.preToolUse));
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(JSON.parse(run.stdout), { permission: "allow" });
		const lines = logLines(home);
		assert.equal(lines.length, 1);
		assert.equal(lines[0].hook, "preToolUse");
		const env = lines[0].env as { PATH: string; onPath: Record<string, string | null>; node: string };
		assert.equal(env.PATH, "/usr/bin:/bin");
		assert.equal(env.onPath.node, existsSync("/usr/bin/node") ? "/usr/bin/node" : null);
		assertNoSecrets(readFileSync(join(home, ".local/state/pecker-nest/cursor/capture.jsonl"), "utf-8"));
	});

	it("allows a malformed payload and logs that it was one", () => {
		const home = scratch();
		recordNode(home);
		for (const event of ["beforeShellExecution", "beforeReadFile", "beforeSubmitPrompt"]) {
			const run = hook(home, event, "{SECRET-CONTENT");
			assert.equal(run.status, 0, run.stderr);
			assert.deepEqual(JSON.parse(run.stdout), allowAnswer(event));
		}
		const lines = logLines(home);
		assert.equal(lines.length, 3);
		assert.ok(lines.every((line) => line.parseError === "not valid JSON"));
		assertNoSecrets(JSON.stringify(lines));
	});

	it("answers the follow-up test from the switch file", () => {
		const home = scratch();
		recordNode(home);
		mkdirSync(join(home, ".local/state/pecker-nest/cursor"), { recursive: true });
		writeFileSync(join(home, ".local/state/pecker-nest/cursor/capture-followups"), "1\n");
		const run = hook(home, "stop", JSON.stringify(PAYLOADS.stop));
		assert.match(JSON.parse(run.stdout).followup_message, /follow-up 1 of 1/);
	});

	it("fails with a clear message when the recorded Node is missing or gone", () => {
		const home = scratch();
		const missing = hook(home, "preToolUse", JSON.stringify(PAYLOADS.preToolUse));
		assert.equal(missing.status, 1);
		assert.equal(missing.stdout, "");
		assert.match(missing.stderr, /cursor-node is missing.*link\.sh --cursor again \(--cursor-capture for the capture hook\)/);

		recordNode(home, join(home, "no-such-node"));
		const gone = hook(home, "preToolUse", JSON.stringify(PAYLOADS.preToolUse));
		assert.equal(gone.status, 1);
		assert.equal(gone.stdout, "");
		assert.match(gone.stderr, /no-such-node\) is gone/);
		assert.equal(logLines(home).length, 0);
	});

	it("probe.sh prints {} and logs how it was started, without the payload", () => {
		const home = scratch();
		const run = spawnSync(PROBE, ["sessionStart", "absolute"], { input: JSON.stringify(PAYLOADS.beforeSubmitPrompt), encoding: "utf-8", cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" } });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), "{}");
		const [line] = logLines(home);
		assert.equal(line.probe, "absolute");
		assert.equal(line.hook, "sessionStart");
		assert.equal(line.cwd, home);
		assert.equal(line.SHELL, "/bin/zsh");
		assert.equal(line.PATH, "/usr/bin:/bin");
		assert.equal(line.bytes, Buffer.byteLength(JSON.stringify(PAYLOADS.beforeSubmitPrompt)));
		assertNoSecrets(JSON.stringify(line));
	});

	it("probe.sh keeps every line whole when the four probes start at the same moment", async () => {
		const home = scratch();
		const forms = ["absolute", "relative", "tilde", "home-variable"];
		const runs = [...forms, ...forms, ...forms].map(
			(form) =>
				new Promise<number | null>((done) => {
					// bash (macOS's /bin/sh) writes a line longer than 4096 bytes in pieces: the case of 17.11.2026.
					const child = spawn("bash", [PROBE, "sessionStart", form], { cwd: home, env: { HOME: home, PATH: `/usr/bin:/bin:${"/x".repeat(4000)}`, SHELL: "/bin/zsh" } });
					child.stdin.end(JSON.stringify(PAYLOADS.beforeSubmitPrompt));
					child.on("close", done);
				}),
		);
		assert.deepEqual(await Promise.all(runs), runs.map(() => 0));
		const lines = logLines(home);
		assert.equal(lines.length, 12, "every probe wrote exactly one line that parses");
		assert.deepEqual([...new Set(lines.map((line) => line.probe))].sort(), [...forms].sort());
		assert.ok(!existsSync(join(home, ".local/state/pecker-nest/cursor/capture.lock")), "the lock is gone");
	});
});

describe("cursor/capture/hooks.json", () => {
	const template = JSON.parse(readFileSync(TEMPLATE, "utf-8")) as { version: number; hooks: Record<string, Record<string, unknown>[]> };

	it("registers documented hooks only, and never fails closed", () => {
		assert.equal(template.version, 1);
		for (const [event, entries] of Object.entries(template.hooks)) {
			assert.ok(DOCUMENTED_HOOKS.has(event), `${event} is a documented hook`);
			for (const entry of entries) {
				assert.equal(entry.failClosed, undefined, `${event} must not fail closed`);
				assert.equal(entry.matcher, undefined, `${event} sees every tool`);
				assert.equal(typeof entry.timeout, "number");
			}
		}
		for (const event of ["preToolUse", "beforeShellExecution", "beforeReadFile", "beforeSubmitPrompt", "stop", "subagentStart", "sessionStart"]) {
			assert.ok(template.hooks[event], `${event} is captured`);
		}
		assert.equal(template.hooks.stop[0].loop_limit, 2);
	});

	it("passes each capture command its own event and keeps the probes on sessionStart", () => {
		for (const [event, entries] of Object.entries(template.hooks)) {
			const capturing = entries.filter((entry) => String(entry.command).includes("capture/capture.ts"));
			assert.equal(capturing.length, 1, `${event} has one capture command`);
			assert.equal(capturing[0].command, `@NEST_DIR@/cursor/node.sh capture/capture.ts ${event}`);
		}
		const probes = template.hooks.sessionStart.map((entry) => String(entry.command)).filter((command) => command.includes("probe.sh"));
		assert.deepEqual(probes, [
			"@NEST_DIR@/cursor/capture/probe.sh sessionStart absolute",
			"./hooks/pecker-nest-probe.sh sessionStart relative",
			"~/.cursor/hooks/pecker-nest-probe.sh sessionStart tilde",
			"$HOME/.cursor/hooks/pecker-nest-probe.sh sessionStart home-variable",
		]);
	});
});

describe("scripts/link.sh --cursor-capture", () => {
	const env = (home: string, extra: Record<string, string> = {}) => ({ HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: join(home, "pi-agent"), ...extra });
	const link = (home: string, ...args: string[]) => spawnSync(LINK, args, { encoding: "utf-8", env: env(home) });

	it("backs up an existing hooks.json, writes the capture hook and records Node", () => {
		const home = scratchHome();
		mkdirSync(join(home, ".cursor"));
		writeFileSync(join(home, ".cursor/hooks.json"), '{"version":1,"hooks":{}}\n');
		const run = link(home, "--cursor-capture");
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /backup  .*hooks\.json -> .*hooks\.json\.bak\.\d{14}/);

		const backups = readdirSync(join(home, ".cursor")).filter((name) => name.startsWith("hooks.json.bak."));
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(join(home, ".cursor", backups[0]), "utf-8"), '{"version":1,"hooks":{}}\n');

		const written = readFileSync(join(home, ".cursor/hooks.json"), "utf-8");
		assert.equal(written, readFileSync(TEMPLATE, "utf-8").replaceAll("@NEST_DIR@", NEST));
		assert.equal(readFileSync(join(home, ".config/pecker-nest/cursor-node"), "utf-8"), `${join(NODE_DIR, "node")}\n`);
		assert.equal(readlinkSync(join(home, ".cursor/hooks/pecker-nest-probe.sh")), PROBE);
		assert.ok(!existsSync(join(home, "pi-agent")), "the capture switch leaves Pi's links alone");
	});

	it("installs commands that every form of start can run, with a PATH that has no Node", () => {
		const home = scratchHome();
		assert.equal(link(home, "--cursor-capture").status, 0);
		const installed = JSON.parse(readFileSync(join(home, ".cursor/hooks.json"), "utf-8")) as { hooks: Record<string, { command: string }[]> };
		let commands = 0;
		for (const [event, entries] of Object.entries(installed.hooks)) {
			for (const { command } of entries) {
				const payload = Object.values(PAYLOADS).find((candidate) => candidate.hook_event_name === event) ?? { ...COMMON, hook_event_name: event };
				// User hooks run from ~/.cursor; sh and bash both read the command string.
				for (const shell of ["sh", "bash"]) {
					const run = spawnSync(shell, ["-c", command], { input: JSON.stringify(payload), encoding: "utf-8", cwd: join(home, ".cursor"), env: { HOME: home, PATH: "/usr/bin:/bin" } });
					assert.equal(run.status, 0, `${shell}: ${command}: ${run.stderr}`);
					assert.deepEqual(JSON.parse(run.stdout), command.includes("probe.sh") ? {} : allowAnswer(event), command);
					commands++;
				}
			}
		}
		const lines = logLines(home);
		assert.equal(lines.length, commands);
		assert.deepEqual(new Set(lines.filter((line) => line.probe).map((line) => line.probe)), new Set(["absolute", "relative", "tilde", "home-variable"]));
		assertNoSecrets(readFileSync(join(home, ".local/state/pecker-nest/cursor/capture.jsonl"), "utf-8"));
	});

	it("is idempotent and --check reports it", () => {
		const home = scratchHome();
		assert.equal(link(home, "--check", "--cursor-capture").status, 1);
		assert.equal(link(home, "--cursor-capture").status, 0);
		const again = link(home, "--cursor-capture");
		assert.equal(again.status, 0);
		assert.match(again.stdout, /ok      .*hooks\.json \(capture hook\)/);
		assert.doesNotMatch(again.stdout, /backup/);
		const check = link(home, "--check", "--cursor-capture");
		assert.equal(check.status, 0, check.stdout);
	});

	it("--cursor-capture-off removes the hook and the probe link, names the backup and keeps the log", () => {
		const home = scratchHome();
		mkdirSync(join(home, ".cursor"));
		writeFileSync(join(home, ".cursor/hooks.json"), '{"version":1,"hooks":{}}\n');
		assert.equal(link(home, "--cursor-capture").status, 0);
		mkdirSync(join(home, ".local/state/pecker-nest/cursor"), { recursive: true });
		writeFileSync(join(home, ".local/state/pecker-nest/cursor/capture.jsonl"), "{}\n");

		const off = link(home, "--cursor-capture-off");
		assert.equal(off.status, 0, off.stderr);
		assert.ok(!existsSync(join(home, ".cursor/hooks.json")));
		assert.throws(() => lstatSync(join(home, ".cursor/hooks/pecker-nest-probe.sh")));
		assert.match(off.stdout, /earlier hooks\.json is .*hooks\.json\.bak\.\d{14}/);
		assert.ok(existsSync(join(home, ".local/state/pecker-nest/cursor/capture.jsonl")));
		assert.equal(link(home, "--check", "--cursor-capture-off").status, 0);
	});

	it("leaves a hooks.json that is not the capture hook alone", () => {
		const home = scratchHome();
		mkdirSync(join(home, ".cursor"));
		writeFileSync(join(home, ".cursor/hooks.json"), '{"version":1,"hooks":{"stop":[{"command":"./mine.sh"}]}}\n');
		const off = link(home, "--cursor-capture-off");
		assert.equal(off.status, 1);
		assert.match(off.stderr, /not the capture hook/);
		assert.match(readFileSync(join(home, ".cursor/hooks.json"), "utf-8"), /mine\.sh/);
	});

	it("refuses to mix the capture switches with other links", () => {
		const home = scratchHome();
		assert.equal(link(home, "--cursor-capture", "--claude").status, 2);
		assert.equal(link(home, "--cursor-capture", "--cursor-capture-off").status, 2);
	});

	it("needs Node on PATH to record it", () => {
		const home = scratchHome();
		const run = spawnSync(LINK, ["--cursor-capture"], { encoding: "utf-8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
		if (existsSync("/usr/bin/node")) return;
		assert.equal(run.status, 1);
		assert.match(run.stderr, /node is not on PATH/);
		assert.ok(!existsSync(join(home, ".cursor/hooks.json")));
	});
});
