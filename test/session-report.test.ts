import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	addEntries,
	buildReport,
	childSessions,
	emptyStats,
	encodeCwd,
	type Entry,
	parseSince,
	renderMarkdown,
	sessionFiles,
	totalCost,
} from "../scripts/session-report.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const user = (text: string): Entry => ({ type: "message", timestamp: "2026-11-08T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } });
function assistant(model: string, tools: { name: string; args: unknown }[] = [], extra: Partial<NonNullable<Entry["message"]>> = {}): Entry {
	return {
		type: "message",
		timestamp: "2026-11-08T09:10:00.000Z",
		message: {
			role: "assistant",
			model,
			thinkingLevel: "high",
			stopReason: tools.length ? "toolUse" : "stop",
			usage: { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.01 } },
			content: tools.map((tool) => ({ type: "toolCall", id: `c${n++}`, name: tool.name, arguments: tool.args })),
			...extra,
		},
	};
}
const result = (toolName: string, isError = false, text = "ok"): Entry => ({ type: "message", message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] } });
const state = (tier: string, why: string): Entry => ({ type: "custom", customType: "pi.virtual-model-state", data: { provider: "router", modelId: "escalate", state: { tier, why } } });
const FLASH = "deepseek/deepseek-v4.1-flash";
const GLM = "z-ai/glm-5.3";

const session: Entry[] = [
	{ type: "session", cwd: "/work/undertext", timestamp: "2026-11-08T09:00:00.000Z" },
	{ type: "custom", customType: "nest-checkpoint", data: { ref: "r", commit: "c" } },
	user("add rule D1"),
	state("flash", "default"),
	assistant(FLASH, [{ name: "edit", args: { path: "a.ts" } }]),
	result("edit", true, "Could not find the exact text"),
	assistant(FLASH, [{ name: "bash", args: { command: "pnpm test" } }]),
	result("bash", true, "1 failed"),
	assistant(FLASH, [{ name: "bash", args: { command: "pnpm test" } }]),
	result("bash", true, "1 failed"),
	assistant(FLASH, [{ name: "bash", args: { command: "pnpm test" } }]),
	result("bash", true, "1 failed"),
	state("glm", "loop"),
	assistant(GLM, [{ name: "write", args: { path: ".pi/gate.json" } }]),
	result("write", true, "Blocked by safety-gate: .pi/gate.json is inside .pi/, the harness configuration. Do not try to work around this block."),
	assistant(GLM),
	{ type: "custom", customType: "quality-gate", data: { ok: false, rounds: 1 } },
	{ type: "custom_message", customType: "quality-gate", content: "[quality-gate] `pnpm test` failed with exit code 1. Repair round 1 of 2." },
	assistant(GLM, [], { stopReason: "error", errorMessage: "No endpoints found matching your data policy" }),
	{ type: "custom", customType: "quality-gate", data: { ok: true, rounds: 1 } },
	{ type: "compaction", timestamp: "2026-11-08T09:20:00.000Z" },
	{ type: "usage", usage: { cost: { total: 0.005 } } } as Entry,
	user("/plan next milestone"),
	state("glm", "plan"),
	assistant(GLM),
];

describe("addEntries", () => {
	const stats = addEntries(emptyStats(), session);
	it("counts prompts and /plan prompts", () => {
		assert.equal(stats.prompts, 2);
		assert.equal(stats.planPrompts, 1);
	});
	it("sums usage per model", () => {
		assert.equal(stats.models[FLASH].requests, 4);
		assert.equal(stats.models[GLM].requests, 4);
		assert.equal(stats.models[GLM].errors, 1);
		assert.equal(stats.models[FLASH].cacheRead, 36_000);
		assert.ok(Math.abs(totalCost(stats) - 0.085) < 1e-9);
		assert.match(stats.requestErrors[0], /No endpoints found/);
	});
	it("counts switches to GLM by reason, once per switch", () => {
		assert.deepEqual(stats.escalations, { loop: 1 });
	});
	it("counts tools, failed edits, loops and safety blocks apart", () => {
		assert.deepEqual(stats.tools.bash, { calls: 3, failed: 3, blocked: 0 });
		assert.deepEqual(stats.tools.write, { calls: 1, failed: 0, blocked: 1 });
		assert.deepEqual(stats.edits, { calls: 2, failed: 1 });
		assert.equal(stats.loops, 1);
		assert.deepEqual(stats.safetyBlocks, { ".pi/gate.json is inside .pi/, the harness configuration": 1 });
	});
	it("counts gate runs, repairs, compactions and checkpoints", () => {
		assert.deepEqual(stats.gate, { runs: 2, green: 1, red: 1, repairs: 1, handedBack: 0 });
		assert.equal(stats.compactions, 1);
		assert.equal(stats.checkpoints, 1);
	});
	it("does not count subagent prompts or checkpoints as yours", () => {
		const withChild = addEntries(addEntries(emptyStats(), session), session, "worker");
		assert.equal(withChild.prompts, 2);
		assert.equal(withChild.checkpoints, 1);
		assert.equal(withChild.agents.worker.requests, 8);
	});
});

describe("session files", () => {
	it("encode the working directory like Pi", () => {
		assert.equal(encodeCwd("/tmp/nest-e2e-x/router-gate"), "--tmp-nest-e2e-x-router-gate--");
		assert.equal(encodeCwd("C:\\work\\repo"), "--C--work-repo--");
	});
	it("find the latest session and its subagent runs", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "nest-report-"));
		dirs.push(agentDir);
		const dir = join(agentDir, "sessions", encodeCwd("/work/undertext"));
		mkdirSync(join(dir, "subagent-artifacts"), { recursive: true });
		const file = join(dir, "2026-11-08T09-00-00-000Z_s1.jsonl");
		writeFileSync(file, `${session.map((entry) => JSON.stringify(entry)).join("\n")}\nnot json\n`);
		const runId = "24b35071-d136-4350-aebb-bfc59954bc73";
		mkdirSync(join(dir, "2026-11-08T09-00-00-000Z_s1", runId, "run-0"), { recursive: true });
		writeFileSync(join(dir, "2026-11-08T09-00-00-000Z_s1", runId, "run-0", "session.jsonl"), JSON.stringify(assistant(GLM)));
		writeFileSync(join(dir, "subagent-artifacts", `${runId}_planner_meta.json`), "{}");

		assert.deepEqual(sessionFiles("/work/undertext", { PI_CODING_AGENT_DIR: agentDir }), [file]);
		assert.deepEqual(childSessions(file).map((child) => child.agent), ["planner"]);
		const report = buildReport([file]);
		assert.equal(report.sessions[0].cwd, "/work/undertext");
		assert.equal(report.sessions[0].subagentRuns, 1);
		assert.equal(report.stats.agents.planner.requests, 1);
		const markdown = renderMarkdown(report);
		assert.match(markdown, /Switches to GLM 5\.3: loop 1\./);
		assert.match(markdown, /Failed edits: 1 of 2 \(50%\)/);
		assert.match(markdown, /By agent: main 8 req/);
		assert.doesNotMatch(markdown, /add rule D1/, "prompts never appear in the report");
	});
});

describe("parseSince", () => {
	it("reads relative times and dates", () => {
		assert.equal(parseSince("8h", 10 * 3_600_000), 2 * 3_600_000);
		assert.equal(parseSince("2026-11-08"), Date.parse("2026-11-08"));
		assert.throws(() => parseSince("yesterday"), /--since/);
	});
});
