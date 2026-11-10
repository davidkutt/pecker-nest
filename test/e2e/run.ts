/**
 * End-to-end checks: a real Pi loads this package and talks to a scripted mock of the
 * OpenRouter API. No API key, no token cost. Covers the default model and OpenRouter routing
 * preferences, the safety gate, the quality gate's repair loop, /plan, project trust, the
 * escalation router, the safety gate inside a subagent, and the review chain's model assignment.
 *
 *   npm run e2e                 # uses `pi` from PATH
 *   PI_BIN=/path/to/pi npm run e2e
 *   E2E_VERBOSE=1 npm run e2e router   # one scenario, with Pi's stderr
 *   E2E_USE_LINK=1 npm run e2e         # use scripts/link.sh, needs this repo at ~/dev/pecker-nest
 *   E2E_KEEP=1 npm run e2e             # keep the temporary repos and sessions
 *
 * Needs network once per run to install pi-subagents into a temporary agent directory.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MockOpenRouter, type MockRequest, type Reply } from "./mock-openrouter.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PI = process.env.PI_BIN ?? "pi";
const GLM = "z-ai/glm-5.3";
const KIMI = "moonshotai/kimi-k3.1-pro";
const FLASH = "deepseek/deepseek-v4.1-flash-1017";
const ROUTING = { zdr: true, data_collection: "deny", require_parameters: true };
const PI_ENV = { OPENROUTER_API_KEY: "sk-or-mock", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" };
const root = mkdtempSync(join(tmpdir(), "nest-e2e-"));

// ---------------------------------------------------------------- scripted model

const tool = (name: string, input: Record<string, unknown>): Reply => ({ tools: [{ name, input }] });
const say = (text: string): Reply => ({ text });

function agentRole(request: MockRequest): string | undefined {
	return /You are `(scout|planner|worker|reviewer)`/.exec(request.system)?.[1];
}

/** What OpenRouter answers when ZDR plus require_parameters leave a model without a provider. */
const NO_ENDPOINTS = {
	status: 404,
	message: "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy",
};
let rateLimitedOnce = false;

/** Scenarios in which OpenRouter refuses a strong model at request time. */
function refusal(request: MockRequest): Reply | undefined {
	switch (request.scenario) {
		case "fail-404":
		case "fail-404-loop":
			return request.model === KIMI ? { error: NO_ENDPOINTS } : undefined;
		case "fail-both":
			return request.model === FLASH ? undefined : { error: NO_ENDPOINTS };
		case "fail-400":
			return request.model === KIMI ? { error: { status: 400, message: "Provider returned error" } } : undefined;
		case "fail-429":
			if (request.model !== GLM || rateLimitedOnce) return undefined;
			rateLimitedOnce = true;
			return { error: { status: 429, message: "Rate limit exceeded" } };
		default:
			return undefined;
	}
}

function respond(request: MockRequest): Reply {
	const step = request.stepInScenario;
	const role = agentRole(request);
	if (role) return respondAsSubagent(role, request);
	const refused = refusal(request);
	if (refused) return refused;

	switch (request.scenario) {
		case "defaults":
			return step === 0 ? tool("bash", { command: "true" }) : say("done");
		case "safety":
			return [tool("bash", { command: "rm -rf build && git push" }), tool("write", { path: ".env", content: "HACKED=1\n" }), say("done")][step] ?? say("done");
		case "gate-repair":
			if (step === 0) return tool("write", { path: "value.txt", content: "bad\n" });
			if (request.lastUserText.includes("Repair round 1 of 2") && step === 2) return tool("write", { path: "value.txt", content: "ok\n" });
			return say(step === 1 ? "done" : "fixed");
		case "gate-exhaust":
			// Every turn without a tool result writes a new wrong value, then claims success.
			return step % 2 === 0 ? tool("write", { path: "value.txt", content: `bad ${step}\n` }) : say("done");
		case "gate-stuck":
			return step === 0 ? tool("write", { path: "value.txt", content: "bad\n" }) : say("I cannot fix this");
		case "plan":
			return [tool("write", { path: "src/app.ts", content: "export {}\n" }), tool("write", { path: "PLAN.md", content: "# Plan\n" }), say("planned")][step] ?? say("planned");
		case "untrusted":
			return step === 0 ? tool("write", { path: "value.txt", content: "bad\n" }) : say("done");
		case "router":
			return [tool("bash", { command: "ls" }), tool("write", { path: "src/a.ts", content: "export const a = 1;\n" }), say("built")][step] ?? say("built");
		case "router-plan":
			return step === 0 ? tool("write", { path: "PLAN.md", content: "# Next\n" }) : say("planned");
		case "router-back":
			return say("back to building");
		case "router-loop":
			// The same failing command three times, then whatever the next model says.
			return step < 3 ? tool("bash", { command: "npm run missing-script" }) : say("stopped looping");
		case "router-hard":
		case "router-soft":
			return say(`answered ${request.scenario}`);
		case "strong-plan":
			return step === 0 ? tool("write", { path: "PLAN.md", content: "# Kimi plan\n" }) : say("planned on kimi");
		case "strong-loop":
			// The same failing command three times, then whatever the escalated model says.
			return step < 3 ? tool("bash", { command: "npm run missing-script" }) : say("stopped looping");
		case "kimi-replay":
			// Flash thinks and calls a tool three times; the escalated model then gets that history.
			return step < 3 ? { ...tool("bash", { command: "npm run missing-script" }), reasoning: `flash thought ${step}` } : say("took over");
		case "fail-404":
		case "fail-400":
		case "fail-429":
			return step === 0 ? tool("write", { path: "PLAN.md", content: "# Fallback plan\n" }) : say("planned on the fallback");
		case "fail-404-loop":
		case "fail-both":
			return step < 3 ? tool("bash", { command: "npm run missing-script" }) : say("stopped looping");
		case "strong-back":
			return say("back on glm");
		case "strong-missing":
			return say("answered strong-missing");
		case "reviewer-kimi":
			return delegate(request, tool("subagent", { agent: "reviewer", task: "[scenario:reviewer-kimi] Review the diff.", async: false }));
		case "protect":
			return [
				tool("bash", { command: "cat evals/holdout.jsonl" }),
				tool("bash", { command: "grep -rn TOPSECRET ." }),
				tool("write", { path: "evals/test.jsonl", content: "{}\n" }),
				tool("write", { path: ".pi/gate.json", content: '{"command":"true"}' }),
				tool("bash", { command: "node eval.js --split test" }),
				say("done"),
			][step] ?? say("done");
		case "grill":
			return say("❓ **Q1** - **Scope**: …");
		case "subagent":
			return delegate(request, tool("subagent", { agent: "worker", task: "[scenario:child] Delete the build directory.", async: false }));
		case "chain-model":
			return delegate(request, {
				text: ["```js workflow", ...CHAIN_SCRIPT, "```"].join("\n"),
				tools: [{ name: "subagent", input: { workflow: true, async: false } }],
			});
		default:
			return say(`no script for scenario ${request.scenario}`);
	}
}

const CHAIN_SCRIPT = [
	'const scout = await runs.run("scout", { agent: "scout", task: "[scenario:chain-model] scout the task" });',
	'const plan = await runs.run("plan", { agent: "planner", task: "[scenario:chain-model] plan\\n" + scout.output });',
	'const build = await runs.run("build", { agent: "worker", task: "[scenario:chain-model] build\\n" + plan.output });',
	'return runs.run("review", { agent: "reviewer", task: "[scenario:chain-model] review\\n" + build.output });',
];

/** Parent side of a delegation: enable the subagent tool if needed, delegate once, then finish. */
function delegate(request: MockRequest, delegation: Reply): Reply {
	const called = (name: string) =>
		request.messages.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.function?.name === name));
	if (called("subagent")) return say("delegated");
	if (request.toolNames.includes("subagent")) return delegation;
	if (request.toolNames.includes("subagents_enable")) return tool("subagents_enable", {});
	return say("no subagent tool available");
}

function respondAsSubagent(role: string, request: MockRequest): Reply {
	const step = request.stepInScenario;
	if (request.scenario === "child" && role === "worker") {
		return step === 0 ? tool("bash", { command: "rm -rf build" }) : say("Implemented nothing: rm -rf was blocked.");
	}
	return say(`${role} report for ${request.scenario}`);
}

// ---------------------------------------------------------------- harness

function sh(cwd: string, command: string) {
	const result = spawnSync("bash", ["-c", command], { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
	return result.stdout;
}

function makeAgentDir(port: number): string {
	const dir = join(root, "agent");
	mkdirSync(join(dir, "prompts"), { recursive: true });
	if (process.env.E2E_USE_LINK) {
		// Exactly the host setup: scripts/link.sh and the ~/dev/pecker-nest paths in settings.json.
		const link = spawnSync(join(NEST, "scripts/link.sh"), { encoding: "utf-8", env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
		if (link.status !== 0) throw new Error(`scripts/link.sh failed: ${link.stderr}`);
		rmSync(join(dir, "models.json"));
	}
	writeFileSync(join(dir, "models.json"), JSON.stringify(mockModelsJson(port)));
	if (process.env.E2E_USE_LINK) return dir;
	// The same files scripts/link.sh links, with ~/dev/pecker-nest pointed at this checkout.
	const settings = readFileSync(join(NEST, "agent/settings.json"), "utf-8").replaceAll("~/dev/pecker-nest", NEST);
	writeFileSync(join(dir, "settings.json"), settings);
	symlinkSync(join(NEST, "agent/APPEND_SYSTEM.md"), join(dir, "APPEND_SYSTEM.md"));
	writeFileSync(join(dir, "mcp.json"), readFileSync(join(NEST, "agent/mcp.json")));
	for (const file of readdirSync(join(NEST, "agent/prompts"))) symlinkSync(join(NEST, "agent/prompts", file), join(dir, "prompts", file));
	return dir;
}

/** The repository's models.json with OpenRouter pointed at the mock. */
function mockModelsJson(port: number, host = "127.0.0.1") {
	const models = JSON.parse(readFileSync(join(NEST, "agent/models.json"), "utf-8"));
	models.providers.openrouter.baseUrl = `http://${host}:${port}/api/v1`;
	return models;
}

/**
 * Entries from Pi's bundled OpenRouter catalog (grouped by API), so a test can write a
 * models-store.json that holds only these models, as a key without ZDR access to the others would.
 */
function catalogModels(ids: readonly string[]): unknown[] {
	const catalog = JSON.parse(readFileSync(join(NEST, "node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json"), "utf-8")) as Record<
		string,
		Record<string, unknown>
	>;
	return ids.map((id) => {
		const entry = Object.values(catalog)
			.map((byApi) => byApi[`chat:${id}`])
			.find((candidate) => candidate !== undefined);
		if (!entry) throw new Error(`${id} is not in Pi's bundled OpenRouter catalog`);
		return entry;
	});
}

function makeRepo(name: string, files: Record<string, string>, gate = true): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	if (gate) {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi/gate.json"), JSON.stringify({ command: "node check.js", maxRepairRounds: 2 }));
		writeFileSync(join(dir, ".pi/settings.json"), "{}\n");
		writeFileSync(join(dir, "check.js"), `const v = require("fs").readFileSync("value.txt", "utf8").trim(); if (v !== "ok") { console.error("value.txt is " + JSON.stringify(v) + ", expected ok"); process.exit(1); }\n`);
		if (!files["value.txt"]) writeFileSync(join(dir, "value.txt"), "ok\n");
	}
	sh(dir, "git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
	return dir;
}

let agentDir = "";
function runPi(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(PI, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...PI_ENV },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => (stdout += data));
		child.stderr.on("data", (data) => (stderr += data));
		const timer = setTimeout(() => child.kill("SIGKILL"), Number(process.env.E2E_TIMEOUT_MS ?? 180_000));
		child.on("close", (code) => {
			clearTimeout(timer);
			if (process.env.E2E_VERBOSE) process.stderr.write(`--- pi ${args.join(" ")}\n${stderr}`);
			done({ code, stdout, stderr });
		});
	});
}

/** Starts Pi in RPC mode, sends one prompt, and stops it once `done()` holds (or after 3 minutes). */
function runPiRpc(cwd: string, message: string, done: () => boolean): Promise<void> {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(PI, ["--mode", "rpc"], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...PI_ENV },
		});
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", (data) => (stderr += data));
		child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message })}\n`);
		const started = Date.now();
		const poll = setInterval(() => {
			const finished = done();
			if (!finished && Date.now() - started < 180_000) return;
			clearInterval(poll);
			// Let the last response finish streaming before stopping Pi.
			setTimeout(() => child.kill("SIGTERM"), 1000);
			child.on("close", () => {
				if (process.env.E2E_VERBOSE) process.stderr.write(`--- pi rpc ${message}\n${stderr}`);
				finished ? resolveRun() : rejectRun(new Error(`RPC run did not finish; stderr: ${stderr}`));
			});
		}, 200);
	});
}

function assertChain(scenario: string) {
	const byRole = new Map<string, MockRequest>();
	for (const request of requestsFor(scenario)) {
		const role = agentRole(request);
		if (role && !byRole.has(role)) byRole.set(role, request);
	}
	assert.deepEqual([...byRole.keys()], ["scout", "planner", "worker", "reviewer"]);
	const assigned = [...byRole.values()].map((request) => `${request.model}:${request.effort}`);
	assert.deepEqual(assigned, [`${FLASH}:low`, `${GLM}:max`, `${FLASH}:high`, `${GLM}:max`]);
	for (const request of byRole.values()) assert.deepEqual(request.routing, ROUTING, "subagents use the same provider routing");
	const reviewerTools = byRole.get("reviewer")!.toolNames;
	for (const writer of ["edit", "write", "bash"]) assert.ok(!reviewerTools.includes(writer), `reviewer has ${writer}`);
	assert.match(byRole.get("reviewer")!.firstUserText, new RegExp(`worker report for ${scenario}`));
}

const mock = new MockOpenRouter(respond);
function requestsFor(scenario: string) {
	return mock.requests.filter((request) => request.scenario === scenario);
}

// ---------------------------------------------------------------- scenarios

const scenarios: [string, () => Promise<void>][] = [
	[
		"default session runs router/escalate on DeepSeek V4.1 Flash at high with OpenRouter routing and session affinity (tests 1, 12)",
		async () => {
			const repo = makeRepo("defaults", {}, false);
			const probe = join(root, "probe-scope.ts");
			writeFileSync(
				probe,
				`export default function (pi) { pi.on("session_start", (_e, ctx) => process.stderr.write("SCOPED " + JSON.stringify(ctx.scopedModels.map((s) => s.model.provider + "/" + s.model.id)) + "\\n")); }\n`,
			);
			const run = await runPi(repo, ["-p", "-e", probe, "[scenario:defaults] run a command"]);
			assert.equal(run.code, 0, run.stderr);
			const requests = requestsFor("defaults");
			assert.equal(requests.length, 2);
			for (const request of requests) {
				assert.equal(request.model, FLASH);
				assert.equal(request.effort, "high");
				assert.deepEqual(request.routing, ROUTING, "models.json routing reaches OpenRouter as the provider field");
			}
			assert.ok(requests[0].sessionId, "x-session-id is sent for sticky provider routing");
			for (const name of ["todo", "questionnaire"]) assert.ok(requests[0].toolNames.includes(name), `the vendored ${name} tool is loaded`);
			assert.match(requests[0].system, /testing-ts/, "package skills are listed");
			assert.doesNotMatch(requests[0].system, /grill-me/, "grill-me is manual only");
			assert.match(requests[0].system, /# Working principles/, "APPEND_SYSTEM.md is part of the system prompt");
			// No instruction about tools that do not exist: the knowledge-base rule comes back with the server (RUNBOOK M3).
			const kbServers = Object.keys(JSON.parse(readFileSync(join(NEST, "agent/mcp.json"), "utf-8")).mcpServers ?? {});
			if (kbServers.length === 0) assert.doesNotMatch(requests[0].system, /mcp__kb__/, "the system prompt names knowledge-base tools although no MCP server is registered");
			assert.equal(requests[1].sessionId, requests[0].sessionId, "one session id per session");
			const scoped = JSON.parse(/SCOPED (.*)/.exec(run.stderr)?.[1] ?? "[]");
			assert.deepEqual(
				scoped,
				["router/escalate", `openrouter/${FLASH}`, `openrouter/${GLM}`, `openrouter/${KIMI}`],
				"enabledModels resolves the IDs with slashes, so Ctrl+P cycles exactly these",
			);
		},
	],
	[
		"safety gate blocks rm -rf, git push and writing .env (test 3, 4)",
		async () => {
			const repo = makeRepo("safety", { "build/out.js": "1\n", ".env": "SECRET=1\n" }, false);
			const run = await runPi(repo, ["-p", "[scenario:safety] clean up"]);
			assert.equal(run.code, 0, run.stderr);
			const [, afterBash, afterWrite] = requestsFor("safety");
			assert.match(afterBash.lastUserText, /Blocked by safety-gate: recursive forced delete/);
			assert.match(afterWrite.lastUserText, /Blocked by safety-gate: \.env is an environment file/);
			assert.ok(existsSync(join(repo, "build/out.js")));
			assert.equal(readFileSync(join(repo, ".env"), "utf-8"), "SECRET=1\n");
		},
	],
	[
		"quality gate sends a red check back and passes after one repair (test 5)",
		async () => {
			const repo = makeRepo("gate-repair", {});
			const run = await runPi(repo, ["-p", "--approve", "[scenario:gate-repair] make value ok"]);
			assert.equal(run.code, 0, run.stderr);
			assert.equal(readFileSync(join(repo, "value.txt"), "utf-8"), "ok\n");
			const repairs = requestsFor("gate-repair").filter((request) => request.lastUserText.includes("[quality-gate]"));
			assert.equal(repairs.length, 1);
			assert.match(repairs[0].lastUserText, /value\.txt is "bad", expected ok/);
			assert.match(run.stderr, /Gate green after 1 repair round/);
		},
	],
	[
		"quality gate stops after two repair rounds",
		async () => {
			const repo = makeRepo("gate-exhaust", {});
			const run = await runPi(repo, ["-p", "--approve", "[scenario:gate-exhaust] make value ok"]);
			assert.equal(run.code, 0, run.stderr);
			const texts = requestsFor("gate-exhaust").map((request) => request.lastUserText);
			assert.ok(texts.some((text) => text.includes("Repair round 1 of 2")));
			assert.ok(texts.some((text) => text.includes("Repair round 2 of 2")));
			assert.ok(!texts.some((text) => text.includes("Repair round 3")));
			assert.match(run.stderr, /still red after 2 repair round/);
		},
	],
	[
		"quality gate stops early when a repair round changes nothing",
		async () => {
			const repo = makeRepo("gate-stuck", {});
			const run = await runPi(repo, ["-p", "--approve", "[scenario:gate-stuck] make value ok"]);
			assert.equal(run.code, 0, run.stderr);
			const repairs = requestsFor("gate-stuck").filter((request) => request.lastUserText.includes("Repair round"));
			assert.equal(repairs.length, 1);
			assert.match(run.stderr, /changed nothing; stopped/);
		},
	],
	[
		"/plan writes only PLAN.md and does not start the gate (test 2)",
		async () => {
			const repo = makeRepo("plan", {});
			sh(repo, "echo bad > value.txt && git commit -qam red");
			const run = await runPi(repo, ["-p", "--approve", "/plan add a greeting [scenario:plan]"]);
			assert.equal(run.code, 0, run.stderr);
			const [first, afterApp] = requestsFor("plan");
			assert.match(first.lastUserText, /The only file you may create or change is `PLAN.md`/);
			assert.match(afterApp.lastUserText, /\/plan only writes PLAN\.md/);
			assert.equal(sh(repo, "git status --porcelain").trim(), "?? PLAN.md");
			assert.ok(!mock.requests.some((request) => request.scenario === "plan" && request.lastUserText.includes("[quality-gate]")));
		},
	],
	[
		"quality gate does not run in an untrusted project",
		async () => {
			const repo = makeRepo("untrusted", {});
			const run = await runPi(repo, ["-p", "--no-approve", "[scenario:untrusted] edit"]);
			assert.equal(run.code, 0, run.stderr);
			assert.match(run.stderr, /gate\.json ignored: this project is not trusted/);
			assert.ok(!requestsFor("untrusted").some((request) => request.lastUserText.includes("[quality-gate]")));
		},
	],
	[
		"router builds on Flash, plans on GLM max, and returns to Flash on the next prompt (test 9)",
		async () => {
			const repo = makeRepo("router", {}, false);
			const run = await runPi(repo, ["-p", "[scenario:router] add a", "/plan next step [scenario:router-plan]", "[scenario:router-back] go on"]);
			assert.equal(run.code, 0, run.stderr);
			const routed = (scenario: string) => requestsFor(scenario).map((request) => `${request.model}:${request.effort}`);
			assert.deepEqual(routed("router"), [`${FLASH}:high`, `${FLASH}:high`, `${FLASH}:high`], "a code edit does not change the tier");
			assert.deepEqual(routed("router-plan"), [`${GLM}:max`, `${GLM}:max`], "/plan runs on GLM at max, including its tool calls");
			assert.deepEqual(routed("router-back"), [`${FLASH}:high`]);
			assert.match(run.stderr, /\[router\] GLM 5\.3 at max \(plan\)/);
			assert.match(run.stderr, /\[router\] back on DeepSeek V4\.1 Flash/);
			const sessions = new Set(mock.requests.filter((request) => request.scenario?.startsWith("router")).map((request) => request.sessionId));
			assert.equal(sessions.size, 1, "switching models keeps the session id");
		},
	],
	[
		"router calls in GLM when the quality gate is still red at repair round 2",
		async () => {
			const repo = makeRepo("router-gate", {});
			const run = await runPi(repo, ["-p", "--approve", "[scenario:gate-exhaust] make value ok"]);
			assert.equal(run.code, 0, run.stderr);
			const requests = requestsFor("gate-exhaust").filter((request) => request.sessionId === requestsFor("gate-exhaust").at(-1)?.sessionId);
			const round2 = requests.findIndex((request) => request.lastUserText.includes("Repair round 2 of 2"));
			assert.ok(round2 > 0, "the gate reached repair round 2");
			assert.ok(requests.slice(0, round2).every((request) => request.model === FLASH), "Flash until round 2");
			assert.ok(requests.slice(round2).every((request) => request.model === GLM && request.effort === "max"), "GLM max from round 2");
			assert.match(run.stderr, /\[router\] GLM 5\.3 at max \(gate: quality gate still red at repair round 2\)/);
			// The session report reads the same session back.
			const report = spawnSync(process.execPath, [join(NEST, "scripts/session-report.ts"), "--cwd", repo, "--json"], {
				encoding: "utf-8",
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			});
			assert.equal(report.status, 0, report.stderr);
			const { stats } = JSON.parse(report.stdout);
			assert.deepEqual(stats.escalations, { gate: 1 });
			assert.equal(stats.gate.repairs, 2);
			assert.equal(stats.gate.handedBack, 1);
			assert.ok(stats.models[FLASH].requests > 0 && stats.models[GLM].requests > 0);
			assert.equal(stats.checkpoints, 1);
		},
	],
	[
		"router calls in GLM after the same tool call three times in a row",
		async () => {
			const repo = makeRepo("router-loop", {}, false);
			const run = await runPi(repo, ["-p", "[scenario:router-loop] run the script"]);
			assert.equal(run.code, 0, run.stderr);
			const routed = requestsFor("router-loop").map((request) => `${request.model}:${request.effort}`);
			assert.deepEqual(routed, [`${FLASH}:high`, `${FLASH}:high`, `${FLASH}:high`, `${GLM}:max`]);
			assert.match(run.stderr, /\[router\] GLM 5\.3 at max \(loop: the same bash call 3 times in a row\)/);
		},
	],
	[
		"/hard keeps GLM on across prompts until /flash",
		async () => {
			const repo = makeRepo("router-hard", {}, false);
			const run = await runPi(repo, ["-p", "/hard", "[scenario:router-hard] one", "[scenario:router-hard] two", "/flash", "[scenario:router-soft] three"]);
			assert.equal(run.code, 0, run.stderr);
			const routed = (scenario: string) => requestsFor(scenario).map((request) => `${request.model}:${request.effort}`);
			assert.deepEqual(routed("router-hard"), [`${GLM}:max`, `${GLM}:max`]);
			assert.deepEqual(routed("router-soft"), [`${FLASH}:high`]);
			assert.match(run.stderr, /\[router\] GLM 5\.3 at max \(hard\)/);
		},
	],
	[
		"/strong kimi runs /plan and escalations on Kimi K3.1 Pro, /strong glm goes back (08.11. comparison)",
		async () => {
			const repo = makeRepo("strong", {}, false);
			const run = await runPi(repo, [
				"-p",
				"/strong",
				"/strong nope",
				"/strong kimi",
				"/plan the next step [scenario:strong-plan]",
				"[scenario:strong-loop] run the script",
				"/strong glm",
				"[scenario:strong-back] go on",
			]);
			// /strong without an argument reports, a bad argument is refused; neither sends a prompt.
			assert.equal(run.code, 0, run.stderr);
			const routed = (scenario: string) => requestsFor(scenario).map((request) => `${request.model}:${request.effort}`);
			assert.deepEqual(routed("strong-plan"), [`${KIMI}:max`, `${KIMI}:max`], "/plan runs on Kimi at max, including its tool calls");
			assert.deepEqual(routed("strong-loop"), [`${FLASH}:high`, `${FLASH}:high`, `${FLASH}:high`, `${KIMI}:max`], "a loop escalates to Kimi, not GLM");
			assert.deepEqual(routed("strong-back"), [`${FLASH}:high`], "/strong glm alone does not escalate");
			assert.match(run.stderr, /\[router\] Kimi K3\.1 Pro at max \(plan\)/);
			assert.match(run.stderr, /\[router\] Kimi K3\.1 Pro at max \(loop: the same bash call 3 times in a row\)/);
			assert.ok(!requestsFor("strong-plan").some((request) => request.model === GLM), "GLM is not called while kimi is selected");
			assert.ok(!requestsFor("strong-loop").some((request) => request.model === GLM));
			for (const request of requestsFor("strong-plan")) assert.deepEqual(request.routing, ROUTING, "Kimi gets the same provider routing");
			const sessions = new Set(mock.requests.filter((request) => request.scenario?.startsWith("strong-")).map((request) => request.sessionId));
			assert.equal(sessions.size, 1, "switching the strong model keeps the session id");
			// The session report attributes the switches to Kimi.
			const report = spawnSync(process.execPath, [join(NEST, "scripts/session-report.ts"), "--cwd", repo, "--json"], {
				encoding: "utf-8",
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			});
			assert.equal(report.status, 0, report.stderr);
			const { stats } = JSON.parse(report.stdout);
			assert.deepEqual(stats.escalations, { plan: 1, loop: 1 });
			assert.deepEqual(stats.escalationsByModel, { kimi: 2 });
			assert.ok(stats.models[KIMI].requests > 0, "Kimi appears in the model table");
		},
	],
	[
		"Kimi K3.1 Pro accepts a tool loop that Flash started: every replayed assistant message carries reasoning_content",
		async () => {
			const repo = makeRepo("kimi-replay", {}, false);
			const run = await runPi(repo, ["-p", "/strong kimi", "[scenario:kimi-replay] run the script"]);
			assert.equal(run.code, 0, run.stderr);
			const requests = requestsFor("kimi-replay");
			assert.deepEqual(requests.map((request) => request.model), [FLASH, FLASH, FLASH, KIMI], "Flash loops, Kimi takes over mid-run");
			const assistants = (request: MockRequest) => request.messages.filter((message) => message.role === "assistant");
			// Flash gets its own thinking back; Pi drops it when another model takes over.
			assert.ok(JSON.stringify(assistants(requests[2])).includes("flash thought 0"), "Flash replays its own reasoning");
			const kimi = requests[3];
			const replayed = assistants(kimi);
			assert.equal(replayed.length, 3, "Kimi gets Flash's three tool-call turns");
			assert.ok(replayed.every((message) => message.tool_calls?.length), "each replayed turn is a tool call");
			assert.ok(!JSON.stringify(replayed).includes("flash thought"), "Flash's thinking is not passed on to Kimi");
			// Moonshot rejects a tool-call message without reasoning_content (HTTP 400). The
			// modelOverrides entry in agent/models.json makes Pi send the field, empty.
			for (const message of replayed) assert.ok("reasoning_content" in message, "a replayed assistant message has no reasoning_content field");
			assert.deepEqual(kimi.routing, ROUTING, "the override's compat merges with the provider-level routing");
		},
	],
	[
		"a missing Kimi falls back to GLM 5.3 with one notice, and never throws",
		async () => {
			const repo = makeRepo("strong-missing", {}, false);
			// What ZDR leaving Kimi without a provider looks like: the catalog Pi refreshed for
			// this key (models-store.json, written by `pi update --models`) has Flash and GLM only.
			const store = join(agentDir, "models-store.json");
			writeFileSync(store, JSON.stringify({ openrouter: { models: catalogModels([FLASH, GLM]), checkedAt: Date.now() } }));
			try {
				const run = await runPi(repo, ["-p", "/strong kimi", "/plan the next step [scenario:strong-missing]"]);
				assert.equal(run.code, 0, run.stderr);
				const routed = requestsFor("strong-missing").map((request) => `${request.model}:${request.effort}`);
				assert.deepEqual(routed, [`${GLM}:max`], "the plan runs on GLM instead of Kimi");
				assert.match(run.stderr, /\[router\] openrouter\/moonshotai\/kimi-k3\.1-pro is not available; using GLM 5\.3 instead/);
				assert.match(run.stderr, /\[router\] GLM 5\.3 at max \(plan\)/);
				assert.doesNotMatch(run.stderr, /router\/escalate: n(either|one)/, "the router does not throw");
			} finally {
				rmSync(store, { force: true });
			}
		},
	],
	[
		"a strong model without an endpoint (404) is ruled out: the run continues on GLM 5.3 with one notice, and later escalations skip it",
		async () => {
			const repo = makeRepo("fail-404", {}, false);
			const run = await runPi(repo, ["-p", "/strong kimi", "/plan the next step [scenario:fail-404]", "[scenario:fail-404-loop] run the script"]);
			assert.equal(run.code, 0, `the run continues instead of ending with the error: ${run.stderr}`);
			const routed = (scenario: string) => requestsFor(scenario).map((request) => `${request.model}:${request.effort}`);
			assert.deepEqual(routed("fail-404"), [`${KIMI}:max`, `${GLM}:max`, `${GLM}:max`], "the plan continues on GLM at max");
			const [refused, retried] = requestsFor("fail-404");
			assert.equal(retried.messages.length, refused.messages.length, "GLM gets the conversation without the failed attempt");
			assert.deepEqual(retried.routing, ROUTING);
			assert.match(retried.lastUserText, /The only file you may create or change is `PLAN.md`/, "the continuation is still the /plan prompt");
			assert.equal(sh(repo, "git status --porcelain").trim(), "?? PLAN.md", "the fallback wrote the plan");
			assert.deepEqual(routed("fail-404-loop"), [`${FLASH}:high`, `${FLASH}:high`, `${FLASH}:high`, `${GLM}:max`], "a later escalation skips Kimi");
			const notices = run.stderr.split("\n").filter((line) => /\[router\] .*(failed|not available)/.test(line));
			assert.equal(notices.length, 1, `exactly one notice, got:\n${notices.join("\n")}`);
			assert.match(notices[0], /Kimi K3\.1 Pro failed, no endpoint under the routing rules \(404: No endpoints found matching your data policy.*\); using GLM 5\.3 instead/);
		},
	],
	[
		"when both strong models have no endpoint, the run continues on Flash",
		async () => {
			const repo = makeRepo("fail-both", {}, false);
			const run = await runPi(repo, ["-p", "/strong kimi", "[scenario:fail-both] run the script"]);
			assert.equal(run.code, 0, run.stderr);
			const routed = requestsFor("fail-both").map((request) => `${request.model}:${request.effort}`);
			assert.deepEqual(
				routed,
				[`${FLASH}:high`, `${FLASH}:high`, `${FLASH}:high`, `${KIMI}:max`, `${GLM}:max`, `${FLASH}:high`],
				"the escalation tries Kimi, then GLM, then goes on with Flash",
			);
			const notices = run.stderr.split("\n").filter((line) => /\[router\] .*(failed|not available)/.test(line));
			assert.equal(notices.length, 2, `one notice per model, got:\n${notices.join("\n")}`);
			assert.match(notices[0], /Kimi K3\.1 Pro failed, .*; using GLM 5\.3 instead/);
			assert.match(notices[1], /GLM 5\.3 failed, .*; using DeepSeek V4\.1 Flash instead/);
		},
	],
	[
		"a rejected request (HTTP 400) switches models in Pi's retry; a rate limit retries the same model",
		async () => {
			const repo = makeRepo("fail-400", {}, false);
			const run = await runPi(repo, ["-p", "/strong kimi", "/plan the next step [scenario:fail-400]", "/plan one more step [scenario:fail-429]"]);
			assert.equal(run.code, 0, run.stderr);
			const models = (scenario: string) => requestsFor(scenario).map((request) => request.model);
			// Pi retries "Provider returned error" itself; the router answers the retry with GLM.
			assert.deepEqual(models("fail-400"), [KIMI, GLM, GLM], "one failed request on Kimi, then GLM");
			// GLM answers 429 once: Pi retries, and the router keeps the model.
			assert.deepEqual(models("fail-429"), [GLM, GLM, GLM], "a rate limit does not rule the model out");
			const notices = run.stderr.split("\n").filter((line) => /\[router\] .*(failed|not available)/.test(line));
			assert.equal(notices.length, 1, `exactly one notice, got:\n${notices.join("\n")}`);
			assert.match(notices[0], /Kimi K3\.1 Pro failed, the request was rejected \(400: Provider returned error\); using GLM 5\.3 instead/);
		},
	],
	[
		"a per-run override reviews the diff on Kimi while the reviewer role stays on GLM",
		async () => {
			const repo = makeRepo("reviewer-kimi", { "src/a.ts": "export const a = 1;\n" }, false);
			// /run needs a live session, like /prompt-workflow, so this runs over RPC like the TUI.
			await runPiRpc(repo, `/run reviewer[model=openrouter/${KIMI}:max] [scenario:reviewer-kimi] review the diff`, () =>
				requestsFor("reviewer-kimi").some((request) => agentRole(request) === "reviewer"),
			);
			const reviewer = requestsFor("reviewer-kimi").filter((request) => agentRole(request) === "reviewer");
			assert.ok(reviewer.length >= 1, "the reviewer ran");
			assert.ok(
				reviewer.every((request) => request.model === KIMI && request.effort === "max"),
				`the per-run override puts the reviewer on Kimi at max, got ${reviewer.map((r) => `${r.model}:${r.effort}`).join(", ")}`,
			);
			for (const request of reviewer) assert.deepEqual(request.routing, ROUTING);
			const reviewerTools = reviewer[0].toolNames;
			for (const writer of ["edit", "write", "bash"]) assert.ok(!reviewerTools.includes(writer), `reviewer has ${writer}`);
			// The role itself is unchanged: without the override the reviewer runs on GLM (assertChain).
			assert.match(readFileSync(join(NEST, "agent/agents/reviewer.md"), "utf-8"), new RegExp(`^model: openrouter/${GLM}$`, "m"), "the reviewer role stays on GLM");
		},
	],
	[
		"safety gate applies .pi/protect.json: read- and write-protected files, commands, output filter, .pi/ itself",
		async () => {
			const repo = makeRepo("protect", {
				"evals/holdout.jsonl": '{"id":"h-1","content":"TOPSECRET payload"}\n',
				"evals/test.jsonl": '{"id":"t-1"}\n',
				"evals/dev.jsonl": '{"id":"d-1","content":"TOPSECRET in dev is fine"}\n',
				"eval.js": "console.log('eval ran')\n",
				".pi/protect.json": JSON.stringify({
					write: ["evals/test*.jsonl"],
					read: ["evals/holdout*.jsonl"],
					commands: [{ pattern: "--split[ =]+test\\b", reason: "the test split runs once, by the user" }],
				}),
			}, false);
			const run = await runPi(repo, ["-p", "[scenario:protect] look around"]);
			assert.equal(run.code, 0, run.stderr);
			const [, afterCat, afterGrep, afterWrite, afterPi, afterEval] = requestsFor("protect");
			assert.match(afterCat.lastUserText, /Blocked by safety-gate: the command would read evals\/holdout\.jsonl is protected/);
			assert.match(afterGrep.lastUserText, /TOPSECRET in dev is fine/);
			assert.doesNotMatch(afterGrep.lastUserText, /TOPSECRET payload/);
			assert.match(afterGrep.lastUserText, /removed 1 line\(s\) that mention files protected/);
			assert.match(afterWrite.lastUserText, /Blocked by safety-gate: evals\/test\.jsonl is protected by \.pi\/protect\.json \(write/);
			assert.match(afterPi.lastUserText, /Blocked by safety-gate: \.pi\/gate\.json is inside \.pi\//);
			assert.match(afterEval.lastUserText, /Blocked by safety-gate: the test split runs once, by the user/);
			assert.equal(readFileSync(join(repo, "evals/test.jsonl"), "utf-8"), '{"id":"t-1"}\n');
			assert.ok(!existsSync(join(repo, ".pi/gate.json")));
		},
	],
	[
		"/skill:grill-me starts the interview skill on request",
		async () => {
			const repo = makeRepo("grill", {}, false);
			const run = await runPi(repo, ["-p", "/skill:grill-me a cache for scan results [scenario:grill]"]);
			assert.equal(run.code, 0, run.stderr);
			const [first] = requestsFor("grill");
			assert.match(first.lastUserText, /design tree/);
			assert.match(first.lastUserText, /a cache for scan results/);
		},
	],
	[
		"a worker subagent runs on DeepSeek V4.1 Flash at high with the safety gate loaded",
		async () => {
			const repo = makeRepo("subagent", { "build/out.js": "1\n" }, false);
			const run = await runPi(repo, ["-p", "[scenario:subagent] delegate the cleanup to the worker subagent"]);
			assert.equal(run.code, 0, run.stderr);
			const child = requestsFor("child");
			assert.ok(child.length >= 2, `worker made ${child.length} requests; stderr: ${run.stderr}`);
			assert.ok(child.every((request) => request.model === FLASH && request.effort === "high"));
			assert.match(child[1].lastUserText, /Blocked by safety-gate/);
			assert.ok(existsSync(join(repo, "build/out.js")));
		},
	],
	[
		"/prompt-workflow review-chain runs scout, planner, worker, reviewer on their models (test 8)",
		async () => {
			const repo = makeRepo("chain", {}, false);
			// Slash commands of pi-subagents need a live session, so this runs over RPC like the TUI.
			await runPiRpc(repo, "/prompt-workflow review-chain [scenario:chain] add a greeting", () =>
				requestsFor("chain").some((request) => agentRole(request) === "reviewer"),
			);
			assertChain("chain");
		},
	],
	[
		"/review-chain lets the model run the same chain headless",
		async () => {
			const repo = makeRepo("chain-model", {}, false);
			const run = await runPi(repo, ["-p", "/review-chain [scenario:chain-model] add a greeting"]);
			assert.equal(run.code, 0, run.stderr);
			assertChain("chain-model");
		},
	],
];

// ---------------------------------------------------------------- main

const port = await mock.start();
agentDir = makeAgentDir(port);
const subagentsPackage = JSON.parse(readFileSync(join(NEST, "agent/settings.json"), "utf-8")).packages.find((p: string) => p.startsWith("npm:pi-subagents@"));
const install = spawnSync(PI, ["install", subagentsPackage], {
	encoding: "utf-8",
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1" },
});
if (install.status !== 0) throw new Error(`pi install failed: ${install.stderr}`);

const only = process.argv[2];
let failed = 0;
for (const [name, scenario] of scenarios) {
	if (only && !name.includes(only)) continue;
	try {
		await scenario();
		console.log(`PASS  ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split("\n").join("\n      ") : String(error)}`);
	}
}
await mock.stop();
if (failed === 0 && !process.env.E2E_KEEP) rmSync(root, { recursive: true, force: true });
else console.log(`kept ${root} for inspection`);
console.log(failed ? `${failed} scenario(s) failed` : "all scenarios passed");
process.exit(failed ? 1 : 0);
