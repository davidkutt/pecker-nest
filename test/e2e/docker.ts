/**
 * Headless container check (acceptance tests 10 and 11): docker/pi-run.sh runs a task in the
 * pecker-nest image against a scratch repository, with the scripted OpenRouter mock on the host.
 * The model breaks the gate once, repairs it, and tries to read a host path outside the repo.
 *
 *   docker build -t pecker-nest-pi -f docker/Dockerfile.pi .
 *   node test/e2e/docker.ts
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MockOpenRouter, type Reply } from "./mock-openrouter.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_ONLY_PATH = join(NEST, "package.json");
const root = mkdtempSync(join(tmpdir(), "nest-docker-"));

const write = (content: string): Reply => ({ tools: [{ name: "write", input: { path: "value.txt", content } }] });
const mock = new MockOpenRouter((request) => {
	const step = request.stepInScenario;
	if (step === 0) return { tools: [{ name: "bash", input: { command: `cat ${HOST_ONLY_PATH}` } }] };
	if (step === 1) return write("bad\n");
	if (step === 2) return { text: "done" };
	if (request.lastUserText.includes("Repair round 1 of 2") && step === 3) return write("ok\n");
	return { text: "fixed" };
});
const port = await mock.start("0.0.0.0");

const repo = join(root, "repo");
mkdirSync(join(repo, ".pi"), { recursive: true });
writeFileSync(join(repo, ".pi/gate.json"), JSON.stringify({ command: "node check.js" }));
writeFileSync(join(repo, "check.js"), `if (require("fs").readFileSync("value.txt", "utf8").trim() !== "ok") { console.error("value.txt is not ok"); process.exit(1); }\n`);
writeFileSync(join(repo, "value.txt"), "ok\n");
spawnSync("bash", ["-c", "git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init"], { cwd: repo });
// The repository's models.json with OpenRouter pointed at the mock, mounted over the linked file.
const models = join(root, "models.json");
const modelsJson = JSON.parse(readFileSync(join(NEST, "agent/models.json"), "utf-8"));
modelsJson.providers.openrouter.baseUrl = `http://127.0.0.1:${port}/api/v1`;
writeFileSync(models, JSON.stringify(modelsJson));

const logs = join(root, "logs");
// Async on purpose: the mock answers from this process's event loop.
const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
	const child = spawn(join(NEST, "docker/pi-run.sh"), ["-C", repo, "[scenario:docker] make the gate green"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			OPENROUTER_API_KEY: "",
			PI_RUN_OPENROUTER_API_KEY: "sk-or-mock",
			PI_RUN_LOG_DIR: logs,
			PI_RUN_DOCKER_ARGS: `--network host -v ${models}:/home/node/dev/pecker-nest/agent/models.json:ro`,
		},
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data) => (stdout += data));
	child.stderr.on("data", (data) => (stderr += data));
	child.on("close", (status) => done({ status, stdout, stderr }));
});
await mock.stop();
console.log(run.stdout);

try {
	assert.equal(run.status, 0, `pi-run.sh exited ${run.status}: ${run.stderr}`);
	const files = readdirSync(logs);
	const jsonl = files.find((file) => file.endsWith(".jsonl"))!;
	const events = readFileSync(join(logs, jsonl), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(events[0].type, "session", "JSONL log starts with the session header");
	assert.ok(events.some((event) => event.type === "agent_settled"));
	const stderrLog = readFileSync(join(logs, files.find((file) => file.endsWith(".stderr.log"))!), "utf-8");
	// The refresh needs pi.dev and openrouter.ai; it is allowed to fail (Pi keeps its bundled catalog).
	const refresh = /=== models exit: (\d+)/.exec(stderrLog);
	assert.ok(refresh, "the model list refresh ran before Pi");
	if (refresh[1] !== "0") console.log(`note: model refresh exited ${refresh[1]} (no internet in the container?); Pi used its bundled catalog`);
	assert.match(stderrLog, /=== gate exit: 0/);
	assert.ok(mock.requests.length > 0 && mock.requests.every((request) => request.model === "z-ai/glm-5.3"));
	assert.ok(
		mock.requests.every((request) => JSON.stringify(request.routing) === JSON.stringify(modelsJson.providers.openrouter.compat.openRouterRouting)),
		"the container sends the routing preferences from models.json",
	);
	assert.equal(readFileSync(join(repo, "value.txt"), "utf-8"), "ok\n");
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" }).stdout.trim();
	assert.equal(status, "", "the repair restored value.txt, nothing else changed");
	assert.ok(mock.requests.some((request) => request.lastUserText.includes("Repair round 1 of 2")), "gate repaired inside the container");
	const isolation = mock.requests.find((request) => request.stepInScenario === 1)!.lastUserText;
	assert.match(isolation, /No such file or directory/, "host path is not visible in the container");
	assert.ok(existsSync(HOST_ONLY_PATH));
	console.log("PASS  headless run in the container: JSONL log, gate repaired, gate green, host paths invisible (tests 10, 11)");
	rmSync(root, { recursive: true, force: true });
} catch (error) {
	console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}\nkept ${root}\n${run.stderr}`);
	process.exit(1);
}
