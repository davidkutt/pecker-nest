/**
 * End-to-end checks: a real Pi loads this package and talks to a scripted mock of the
 * OpenRouter API. No API key, no token cost. Covers the default model and OpenRouter routing
 * preferences, the safety gate, the quality gate's repair loop, /plan, project trust, the
 * router's phases, the safety gate inside a subagent, and the review chain's model assignment.
 *
 *   npm run e2e                 # uses `pi` from PATH
 *   PI_BIN=/path/to/pi npm run e2e
 *   E2E_VERBOSE=1 npm run e2e router   # one scenario, with Pi's stderr
 *   E2E_USE_LINK=1 npm run e2e         # use scripts/link.sh, needs this repo at ~/dev/pecker-nest
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
const DS_PRO = "deepseek/deepseek-v4-pro-0813";
const DS_FLASH = "deepseek/deepseek-v4-flash-0731";
const ROUTING = { zdr: true, data_collection: "deny", require_parameters: true };
const PI_ENV = { OPENROUTER_API_KEY: "sk-or-mock", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" };
const root = mkdtempSync(join(tmpdir(), "nest-e2e-"));

// ---------------------------------------------------------------- scripted model

const tool = (name: string, input: Record<string, unknown>): Reply => ({ tools: [{ name, input }] });
const say = (text: string): Reply => ({ text });

function agentRole(request: MockRequest): string | undefined {
	return /You are `(scout|planner|worker|reviewer)`/.exec(request.system)?.[1];
}

function respond(request: MockRequest): Reply {
	const step = request.stepInScenario;
	const role = agentRole(request);
	if (role) return respondAsSubagent(role, request);

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
		case "router-more":
			return say("still building");
		case "router-plan":
			return step === 0 ? tool("write", { path: "PLAN.md", content: "# Next\n" }) : say("planned again");
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
	assert.deepEqual(assigned, [`${DS_FLASH}:low`, `${GLM}:max`, `${GLM}:high`, `${DS_PRO}:high`]);
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
		"default session runs GLM 5.3 at high with OpenRouter routing and session affinity (tests 1, 12)",
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
				assert.equal(request.model, GLM);
				assert.equal(request.effort, "high");
				assert.deepEqual(request.routing, ROUTING, "models.json routing reaches OpenRouter as the provider field");
			}
			assert.ok(requests[0].sessionId, "x-session-id is sent for sticky provider routing");
			assert.equal(requests[1].sessionId, requests[0].sessionId, "one session id per session");
			const scoped = JSON.parse(/SCOPED (.*)/.exec(run.stderr)?.[1] ?? "[]");
			assert.deepEqual(
				scoped,
				["router/phased", `openrouter/${GLM}`, `openrouter/${DS_PRO}`, `openrouter/${DS_FLASH}`],
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
		"router plans on GLM max, builds on GLM high after the first code edit, and /plan returns to max (test 9)",
		async () => {
			const repo = makeRepo("router", {}, false);
			const run = await runPi(repo, [
				"-p",
				"--model",
				"router/phased",
				"[scenario:router] add a",
				"[scenario:router-more] and more",
				"/plan next step [scenario:router-plan]",
			]);
			assert.equal(run.code, 0, run.stderr);
			const efforts = (scenario: string) => requestsFor(scenario).map((request) => request.effort);
			assert.ok(mock.requests.filter((request) => request.scenario?.startsWith("router")).every((request) => request.model === GLM));
			assert.deepEqual(efforts("router"), ["max", "max", "high"]);
			assert.deepEqual(efforts("router-more"), ["high"]);
			assert.deepEqual(efforts("router-plan"), ["max", "max"], "writing PLAN.md stays in the plan phase");
			const sessions = new Set(mock.requests.filter((request) => request.scenario?.startsWith("router")).map((request) => request.sessionId));
			assert.equal(sessions.size, 1, "the effort switch keeps the session id, so OpenRouter stays on the same provider");
		},
	],
	[
		"a worker subagent runs on GLM 5.3 at high with the safety gate loaded",
		async () => {
			const repo = makeRepo("subagent", { "build/out.js": "1\n" }, false);
			const run = await runPi(repo, ["-p", "[scenario:subagent] delegate the cleanup to the worker subagent"]);
			assert.equal(run.code, 0, run.stderr);
			const child = requestsFor("child");
			assert.ok(child.length >= 2, `worker made ${child.length} requests; stderr: ${run.stderr}`);
			assert.ok(child.every((request) => request.model === GLM && request.effort === "high"));
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
if (failed === 0) rmSync(root, { recursive: true, force: true });
else console.log(`kept ${root} for inspection`);
console.log(failed ? `${failed} scenario(s) failed` : "all scenarios passed");
process.exit(failed ? 1 : 0);
