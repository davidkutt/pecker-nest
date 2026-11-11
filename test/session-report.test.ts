import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { chunkProvider, providerFromError } from "../extensions/lib/provider-log.ts";
import {
	addEntries,
	buildReport,
	childSessions,
	emptyStats,
	encodeCwd,
	type Entry,
	fallbackLine,
	outcomeLine,
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
const gate = (ok: boolean): Entry => ({ type: "custom", customType: "quality-gate", data: { ok } });
const repair = (round: number): Entry => ({ type: "custom_message", customType: "quality-gate", content: `[quality-gate] \`pnpm check\` failed with exit code 1. Repair round ${round} of 2.` });
/** An assistant turn with a response ID, the tool results it got, and the provider-log entry that follows the turn. */
function served(model: string, responseId: string, provider: string | undefined, tools: { name: string; failed?: boolean }[] = [], extra: Partial<NonNullable<Entry["message"]>> = {}): Entry[] {
	const turn = assistant(model, tools.map((tool) => ({ name: tool.name, args: { path: "a.ts", n: n++ } })), { responseId, ...extra });
	const calls = turn.message?.content as { id: string; name: string }[];
	const results = calls.map((call, index): Entry => ({
		type: "message",
		message: { role: "toolResult", toolName: call.name, toolCallId: call.id, isError: Boolean(tools[index].failed), content: [{ type: "text", text: tools[index].failed ? "failed" : "ok" }] },
	}));
	const record: Entry[] = provider ? [{ type: "custom", customType: "nest-provider", data: { responseId, provider, model } }] : [];
	return [turn, ...results, ...record];
}
const state = (tier: string, why: string, strong?: string): Entry => ({
	type: "custom",
	customType: "pi.virtual-model-state",
	data: { provider: "router", modelId: "escalate", state: { tier, why, ...(strong ? { strong } : {}) } },
});
const FLASH = "deepseek/deepseek-v4.1-flash-1017";
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
	it("counts switches by reason and by strong model, once per switch", () => {
		// The fixture uses the pre-/strong tier name `glm`, which still reads as a switch to GLM.
		assert.deepEqual(stats.escalations, { loop: 1 });
		assert.deepEqual(stats.escalationsByModel, { glm: 1 });
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

describe("addEntries counts the strong model", () => {
	const KIMI = "moonshotai/kimi-k3.1-pro";
	it("counts a switch to Kimi under its own name", () => {
		const stats = addEntries(emptyStats(), [
			user("/plan M1 step 2"),
			state("strong", "plan", "kimi"),
			assistant(KIMI),
			user("build it"),
			state("flash", "default", "kimi"),
			assistant(FLASH),
			state("strong", "gate", "kimi"),
			assistant(KIMI),
		]);
		assert.deepEqual(stats.escalations, { plan: 1, gate: 1 });
		assert.deepEqual(stats.escalationsByModel, { kimi: 2 });
		assert.equal(stats.models[KIMI].requests, 2);
	});
	it("keeps the two strong models apart in one session", () => {
		const stats = addEntries(emptyStats(), [
			user("/plan on glm"),
			state("strong", "plan"),
			assistant(GLM),
			user("/strong kimi then /plan"),
			state("flash", "default", "kimi"),
			assistant(FLASH),
			state("strong", "plan", "kimi"),
			assistant(KIMI),
		]);
		assert.deepEqual(stats.escalations, { plan: 2 });
		assert.deepEqual(stats.escalationsByModel, { glm: 1, kimi: 1 });
	});
	it("reads a session written before /strong existed as GLM", () => {
		const stats = addEntries(emptyStats(), [user("fix it"), state("glm", "stuck"), assistant(GLM)]);
		assert.deepEqual(stats.escalations, { stuck: 1 });
		assert.deepEqual(stats.escalationsByModel, { glm: 1 });
	});
	it("names both models in the report", () => {
		const report = buildReport([]);
		report.stats.escalations = { plan: 1, loop: 2 };
		report.stats.escalationsByModel = { glm: 1, kimi: 2 };
		const markdown = renderMarkdown(report);
		assert.match(markdown, /Switches to the strong model: plan 1, loop 2\./);
		assert.match(markdown, /By strong model: GLM 5\.3 1, Kimi K3\.1 Pro 2\./);
	});
	it("says so when nothing escalated", () => {
		assert.match(renderMarkdown(buildReport([])), /No switch to the strong model/);
	});
});

describe("addEntries reports what became of each switch", () => {
	const KIMI = "moonshotai/kimi-k3.1-pro";
	const outcomes = (entries: Entry[]) => addEntries(emptyStats(), entries).escalationOutcomes;

	it("counts a switch as green when the gate's last run before the next prompt was green", () => {
		const stats = addEntries(emptyStats(), [
			user("build step 3"),
			state("flash", "default"),
			assistant(FLASH),
			gate(false),
			repair(1),
			assistant(FLASH),
			gate(false),
			repair(2),
			state("strong", "gate"),
			assistant(GLM),
			assistant(GLM),
			gate(false),
			assistant(GLM),
			gate(true),
			user("next"),
			state("flash", "default"),
			assistant(FLASH),
		]);
		assert.deepEqual(stats.escalationOutcomes, [{ why: "gate", strong: "glm", switches: 1, green: 1, handedBack: 0, noGate: 0, requests: 3, cost: 0.03 }]);
		assert.equal(outcomeLine(stats.escalationOutcomes[0]), "gate, GLM 5.3: 1 switch, 1 green; 3 strong-model requests, $0.03");
	});
	it("counts a switch as handed back when the gate stayed red", () => {
		const handedBack = outcomes([user("fix"), state("flash", "default"), assistant(FLASH), state("strong", "loop"), assistant(GLM), gate(false), repair(1), assistant(GLM), gate(false)]);
		assert.deepEqual(handedBack, [{ why: "loop", strong: "glm", switches: 1, green: 0, handedBack: 1, noGate: 0, requests: 2, cost: 0.02 }]);
	});
	it("counts a gate switch as handed back when the gate never ran again (the repair changed nothing)", () => {
		const [outcome] = outcomes([user("fix"), assistant(FLASH), gate(false), repair(1), assistant(FLASH), gate(false), repair(2), state("strong", "gate"), assistant(GLM)]);
		assert.equal(outcome.handedBack, 1);
		assert.equal(outcome.noGate, 0);
	});
	it("says so when no gate ran: a /plan, or a loop in a repository without a gate", () => {
		const noGate = outcomes([user("/plan M2"), state("strong", "plan"), assistant(GLM), assistant(GLM), user("go"), state("flash", "default"), assistant(FLASH), state("strong", "loop"), assistant(GLM)]);
		assert.deepEqual(
			noGate.map((outcome) => [outcome.why, outcome.switches, outcome.noGate, outcome.requests]),
			[["plan", 1, 1, 2], ["loop", 1, 1, 1]],
		);
		assert.match(outcomeLine(noGate[0]), /^plan, GLM 5\.3: 1 switch, 1 without a gate run; 2 strong-model requests/);
	});
	it("keeps reasons and strong models apart and sums several switches", () => {
		const stats = addEntries(emptyStats(), [
			user("a"), assistant(FLASH), gate(false), repair(1), assistant(FLASH), gate(false), repair(2), state("strong", "gate"), assistant(GLM), gate(true),
			user("b"), state("flash", "default"), assistant(FLASH), gate(false), repair(1), assistant(FLASH), gate(false), repair(2), state("strong", "gate"), assistant(GLM), gate(false),
			user("c"), state("flash", "default", "kimi"), assistant(FLASH), gate(false), repair(1), assistant(FLASH), gate(false), repair(2), state("strong", "gate", "kimi"), assistant(KIMI), assistant(KIMI), gate(true),
		]);
		assert.deepEqual(
			stats.escalationOutcomes.map(outcomeLine),
			["gate, GLM 5.3: 2 switches, 1 green, 1 handed back; 2 strong-model requests, $0.02", "gate, Kimi K3.1 Pro: 1 switch, 1 green; 2 strong-model requests, $0.02"],
		);
		assert.deepEqual(stats.escalations, { gate: 3 }, "the counts by reason are unchanged");
	});
	it("does not count Flash requests of a switch whose strong model could not take over", () => {
		// The state says strong, but the conversation has images and GLM reads none: Flash keeps serving.
		const [outcome] = outcomes([user("fix"), state("strong", "hard"), assistant(FLASH), assistant(FLASH)]);
		assert.equal(outcome.requests, 0);
		assert.equal(outcome.cost, 0);
	});
	it("keeps /hard as one switch across prompts, ended by the first of them", () => {
		// The router stores no new state while the tier stays strong, so later /hard prompts are not switches.
		const hard = outcomes([user("one"), state("strong", "hard"), assistant(GLM), gate(true), user("two"), assistant(GLM), gate(false)]);
		assert.deepEqual(hard.map((outcome) => [outcome.switches, outcome.green, outcome.requests]), [[1, 1, 1]]);
	});
	it("prints the outcome lines under Router", () => {
		const report = buildReport([]);
		addEntries(report.stats, [user("a"), assistant(FLASH), gate(false), repair(2), state("strong", "gate"), assistant(GLM), gate(true)]);
		const markdown = renderMarkdown(report);
		assert.match(markdown, /Outcome of the switches/);
		assert.match(markdown, /^- gate, GLM 5\.3: 1 switch, 1 green; 1 strong-model request, \$0\.01$/m);
	});
});

describe("addEntries counts request-time fallbacks", () => {
	const fallback = (ruledOut: string, kind: string, tookOver: string): Entry => ({ type: "custom", customType: "nest-router-fallback", data: { ruledOut, kind, tookOver, error: "404: No endpoints found" } });
	const stats = addEntries(emptyStats(), [
		user("/plan"),
		state("strong", "plan", "kimi"),
		assistant("moonshotai/kimi-k3.1-pro", [], { stopReason: "error", errorMessage: "404: No endpoints found" }),
		fallback("kimi", "routing", "glm"),
		assistant(GLM),
		user("again"),
		fallback("kimi", "routing", "glm"),
		fallback("glm", "request", "flash"),
	]);
	it("per ruled-out model, reason and the model that took over", () => {
		assert.deepEqual(stats.fallbacks, [
			{ ruledOut: "kimi", kind: "routing", tookOver: "glm", count: 2 },
			{ ruledOut: "glm", kind: "request", tookOver: "flash", count: 1 },
		]);
	});
	it("on their own lines in the report", () => {
		assert.equal(fallbackLine(stats.fallbacks[0]), "Kimi K3.1 Pro ruled out (no endpoint under the routing rules), GLM 5.3 took over: 2×");
		assert.equal(fallbackLine(stats.fallbacks[1]), "GLM 5.3 ruled out (request rejected), DeepSeek V4.1 Flash took over: 1×");
		const report = buildReport([]);
		report.stats.fallbacks = stats.fallbacks;
		assert.match(renderMarkdown(report), /Fallbacks at request time:\n\n- Kimi K3\.1 Pro ruled out/);
		assert.match(renderMarkdown(buildReport([])), /Fallbacks at request time: none\./);
	});
});

describe("addEntries attributes requests to the upstream provider", () => {
	const entries: Entry[] = [
		user("build"),
		...served(FLASH, "gen-1", "DeepInfra", [{ name: "edit", failed: true }, { name: "bash" }]),
		...served(FLASH, "gen-2", "DeepInfra", [{ name: "bash", failed: true }]),
		...served(FLASH, "gen-3", "Novita", [{ name: "write" }]),
		// A response the provider log has no entry for, and a request that failed before any stream.
		...served(FLASH, "gen-4", undefined, [{ name: "edit", failed: true }]),
		...served(GLM, "gen-5", undefined, [], { stopReason: "error", errorMessage: '400: {"error":{"message":"Provider returned error","code":400,"metadata":{"provider_name":"Z.AI"}}}' }),
		...served(GLM, "gen-6", undefined, [], { stopReason: "error", errorMessage: "404: No endpoints found" }),
		...served(GLM, "gen-7", "Z.AI"),
	];
	const stats = addEntries(emptyStats(), entries);
	it("counts requests, errors, failed tool calls and failed edits per model and provider", () => {
		assert.deepEqual(stats.providers[FLASH], {
			DeepInfra: { requests: 2, errors: 0, failedTools: 2, failedEdits: 1 },
			Novita: { requests: 1, errors: 0, failedTools: 0, failedEdits: 0 },
			"–": { requests: 1, errors: 0, failedTools: 1, failedEdits: 1 },
		});
	});
	it("reads the provider of a failed request from OpenRouter's error body, else leaves it open", () => {
		assert.deepEqual(stats.providers[GLM], {
			"Z.AI": { requests: 2, errors: 1, failedTools: 0, failedEdits: 0 },
			"–": { requests: 1, errors: 1, failedTools: 0, failedEdits: 0 },
		});
	});
	it("does not count a safety-gate block as a provider's failed tool call", () => {
		const turn = assistant(FLASH, [{ name: "write", args: { path: ".env" } }], { responseId: "gen-9" });
		const id = (turn.message?.content as { id: string }[])[0].id;
		const blocked: Entry = { type: "message", message: { role: "toolResult", toolName: "write", toolCallId: id, isError: true, content: [{ type: "text", text: "Blocked by safety-gate: .env is an environment file." }] } };
		const only = addEntries(emptyStats(), [turn, blocked, { type: "custom", customType: "nest-provider", data: { responseId: "gen-9", provider: "DeepInfra" } }]);
		assert.deepEqual(only.providers[FLASH], { DeepInfra: { requests: 1, errors: 0, failedTools: 0, failedEdits: 0 } });
	});
	it("prints a table per model and provider, with – for what is not recorded", () => {
		const report = buildReport([]);
		report.stats = stats;
		const markdown = renderMarkdown(report);
		assert.match(markdown, /\| Model \| Provider \| Requests \| Errors \| Failed tool calls \| Failed edits \|/);
		assert.match(markdown, new RegExp(`\\| ${FLASH} \\| DeepInfra \\| 2 \\| 0 \\| 2 \\| 1 \\|`));
		assert.match(markdown, new RegExp(`\\| ${FLASH} \\| – \\| 1 \\| 0 \\| 1 \\| 1 \\|`));
	});
	it("says so when no provider was recorded", () => {
		const report = buildReport([]);
		addEntries(report.stats, session);
		assert.match(renderMarkdown(report), /No upstream provider recorded/);
		assert.deepEqual(Object.keys(report.stats.providers[FLASH]), ["–"]);
	});
	it("carries the new fields in --json", () => {
		const json = JSON.parse(JSON.stringify(buildReport([])));
		for (const key of ["escalationOutcomes", "fallbacks", "providers", "tamper"]) assert.ok(key in json.stats, `${key} is missing`);
	});
});

describe("addEntries counts the findings of the weakened-test check", () => {
	const finding = (kind: string, path: string, line: number, detail = `${kind} found`) => ({ kind, path, line, detail });
	const gateWith = (ok: boolean, tamper: unknown[]): Entry => ({ type: "custom", customType: "quality-gate", data: { ok, checkOk: true, tamper } });
	const stats = addEntries(emptyStats(), [
		user("step 1"),
		assistant(FLASH),
		gateWith(false, [finding("skip", "a.test.ts", 5), finding("suppression", "a.ts", 2)]),
		repair(1),
		assistant(FLASH),
		// The suppression is gone; the skip marker moved two lines down and is the same finding.
		gateWith(false, [finding("skip", "a.test.ts", 7)]),
		user("step 2"),
		assistant(FLASH),
		gateWith(false, [finding("config", "tsconfig.json", 3)]),
		repair(1),
		assistant(FLASH),
		gateWith(true, []),
		user("step 3"),
		assistant(FLASH),
		gate(true),
	]);
	it("once per prompt, by kind, and those left when the run ended", () => {
		assert.deepEqual(stats.tamper, { runs: 3, findings: 3, byKind: { skip: 1, suppression: 1, config: 1 }, remaining: 1 });
		assert.deepEqual(stats.gate, { runs: 5, green: 2, red: 3, repairs: 2, handedBack: 0 });
	});
	it("in one line under Gates", () => {
		const report = buildReport([]);
		report.stats = stats;
		assert.match(renderMarkdown(report), /Weakened-test check: 3 finding\(s\) in 3 gate run\(s\) \(skip 1, suppression 1, config 1\); 1 still there when the run ended\./);
		assert.match(renderMarkdown(buildReport([])), /Weakened-test check: no findings\./);
	});
});

describe("provider log", () => {
	it("reads response ID and provider from a stream chunk", () => {
		assert.deepEqual(chunkProvider({ id: "gen-1", provider: "DeepInfra", choices: [] }), { responseId: "gen-1", provider: "DeepInfra" });
		assert.deepEqual(chunkProvider({ id: "gen-1" }), { responseId: "gen-1" });
		assert.deepEqual(chunkProvider({ id: "gen-1", provider: "" }), { responseId: "gen-1" });
		assert.deepEqual(chunkProvider({ id: 7, provider: { name: "x" } }), {});
		for (const junk of [undefined, null, "text", 3, []]) assert.deepEqual(chunkProvider(junk), {});
	});
	it("reads the provider from an error body, if it names one", () => {
		assert.equal(providerFromError('400: {"error":{"message":"Provider returned error","metadata":{"provider_name":"Moonshot AI"}}}'), "Moonshot AI");
		assert.equal(providerFromError("404: No endpoints found"), undefined);
		assert.equal(providerFromError(undefined), undefined);
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
		assert.match(markdown, /Switches to the strong model: loop 1\./);
		assert.match(markdown, /By strong model: GLM 5\.3 1\./);
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
